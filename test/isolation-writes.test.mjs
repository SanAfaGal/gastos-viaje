// Aislamiento en las escrituras aunque haya una carrera: si entre la comprobación y la escritura aparece una fila de
// otro espacio con el mismo id, la escritura no la toca (gastos, abonos y sus personas) o no escribe nada (restaurar).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openMemoryDb } from '../src/db.mjs';
import { handle } from '../src/handlers.mjs';
import { hashCode } from '../src/spaces.mjs';

const CODE_A = 'AAAA-BBBB-CCCC';
const CODE_B = 'DDDD-EEEE-FFFF';
const DIA = '2026-11-14';

delete process.env.APP_PASSCODE;
delete process.env.ADMIN_PASSCODE;
delete process.env.TURSO_DATABASE_URL;
delete process.env.TURSO_AUTH_TOKEN;

// Ninguna prueba de este archivo debe salir a internet: las tasas se siembran en la base.
globalThis.fetch = async () => {
  throw new TypeError('no debería consultar la fuente');
};

const llamador = (db, passcode) => (method, path, body, query = {}) =>
  handle({ method, path, body, query: new URLSearchParams(query), passcode, ip: '1.1.1.1', db });

// Dos espacios (A y B) con un viaje, una persona y un medio de pago cada uno, y las tasas del día sembradas.
async function twoSpaces() {
  const db = await openMemoryDb();
  for (const [id, name, code] of [['space-a', 'Grupo A', CODE_A], ['space-b', 'Grupo B', CODE_B]]) {
    await db.run('INSERT INTO spaces (id, name, code_hash, is_admin, active, created_at) VALUES (?, ?, ?, 0, 1, ?)', [id, name, hashCode(code), new Date().toISOString()]);
  }
  const A = llamador(db, CODE_A);
  const B = llamador(db, CODE_B);
  for (const [call, s, dest, home] of [[A, 'a', 'EUR', 'COP'], [B, 'b', 'USD', 'BRL']]) {
    assert.equal((await call('POST', '/api/trips', { id: `t${s}`, name: `Viaje ${s}`, dest, home })).status, 201);
    assert.equal((await call('POST', '/api/people', { id: `p${s}`, name: `Persona ${s}` })).status, 201);
    assert.equal((await call('POST', '/api/payment-methods', { id: `m${s}`, kind: 'cash', name: `Efectivo ${s}`, owner_person_id: `p${s}` })).status, 201);
  }
  await db.run('INSERT INTO rates (pair, date, rate) VALUES (?, ?, ?)', ['EUR-COP', DIA, 4500]);
  await db.run('INSERT INTO rates (pair, date, rate) VALUES (?, ?, ?)', ['USD-BRL', DIA, 5.5]);
  return { db, A, B };
}

// La misma base, pero justo antes de la primera escritura cuyo SQL contiene `marca` corre `antes()`: así se simula
// que otro espacio insertó la fila entre la comprobación y la escritura.
function conCarrera(db, marca, antes) {
  let pendiente = true;
  const quizas = async (sql) => {
    if (pendiente && sql.includes(marca)) {
      pendiente = false;
      await antes();
    }
  };
  return {
    all: (sql, args) => db.all(sql, args),
    run: async (sql, args) => { await quizas(sql); return db.run(sql, args); },
    batch: async (stmts) => { await quizas(stmts.map((s) => s.sql).join('\n')); return db.batch(stmts); },
    get disparada() { return !pendiente; },
  };
}

const gastoAjeno = (db) => db.batch([
  { sql: `INSERT INTO expenses (id, date, amount_cents, description, payment_method_id, created_at, trip_id)
          VALUES ('x', ?, 999, 'de B', 'mb', '2026-11-01T00:00:00Z', 'tb')`, args: [DIA] },
  { sql: "INSERT INTO expense_beneficiaries (expense_id, person_id) VALUES ('x', 'pb')" },
]);

test('carrera en un gasto: el upsert no modifica el gasto de otro espacio ni cambia sus personas', async () => {
  const { db } = await twoSpaces();
  const antes = async () => ({
    gasto: await db.all("SELECT * FROM expenses WHERE id = 'x'"),
    personas: await db.all("SELECT * FROM expense_beneficiaries WHERE expense_id = 'x'"),
  });
  const carrera = conCarrera(db, 'INSERT INTO expenses', () => gastoAjeno(db));
  const r = await handle({
    method: 'PUT', path: '/api/expenses/x', passcode: CODE_A, ip: '1.1.1.1', db: carrera,
    body: { date: DIA, amount_cents: 100, description: 'de A', payment_method_id: 'ma', beneficiary_ids: ['pa'], trip_id: 'ta' },
  });
  assert.ok(carrera.disparada, 'la fila ajena apareció justo antes de escribir');
  const despues = await antes();
  assert.equal(despues.gasto.length, 1);
  assert.equal(despues.gasto[0].amount_cents, 999);
  assert.equal(despues.gasto[0].description, 'de B');
  assert.equal(despues.gasto[0].trip_id, 'tb');
  assert.equal(despues.gasto[0].payment_method_id, 'mb');
  assert.deepEqual(despues.personas.map((p) => p.person_id), ['pb']);
  assert.equal(r.status, 404, 'no se confirma un gasto que no se guardó');
  assert.deepEqual(r.body, { error: 'No encontrado' });
});

test('un gasto nuevo sin carrera sigue guardando sus personas', async () => {
  const { A, db } = await twoSpaces();
  const r = await A('PUT', '/api/expenses/nuevo', { date: DIA, amount_cents: 100, description: '', payment_method_id: 'ma', beneficiary_ids: ['pa'], trip_id: 'ta' });
  assert.equal(r.status, 200);
  assert.deepEqual((await db.all("SELECT person_id FROM expense_beneficiaries WHERE expense_id = 'nuevo'")).map((p) => p.person_id), ['pa']);
  // Editarlo cambia sus personas (la condición del espacio se cumple).
  await A('POST', '/api/people', { id: 'pa2', name: 'Otra de A' });
  await A('PUT', '/api/trips/ta', { name: 'Viaje a', dest: 'EUR', home: 'COP', people_ids: ['pa', 'pa2'] });
  assert.equal((await A('PUT', '/api/expenses/nuevo', { date: DIA, amount_cents: 200, description: '', payment_method_id: 'ma', beneficiary_ids: ['pa2'] })).status, 200);
  assert.deepEqual((await db.all("SELECT person_id FROM expense_beneficiaries WHERE expense_id = 'nuevo'")).map((p) => p.person_id), ['pa2']);
  assert.equal((await db.all("SELECT amount_cents FROM expenses WHERE id = 'nuevo'"))[0].amount_cents, 200);
});

test('carrera en un abono: el upsert no modifica el abono de otro espacio', async () => {
  const { db, B } = await twoSpaces();
  await B('POST', '/api/people', { id: 'pb2', name: 'Otra de B' });
  const ajeno = () => db.run(
    `INSERT INTO payments (id, trip_id, from_person_id, to_person_id, date, amount_cents, note, created_at)
     VALUES ('y', 'tb', 'pb', 'pb2', ?, 999, 'de B', '2026-11-01T00:00:00Z')`, [DIA],
  );
  await db.run('INSERT INTO people (id, name, space_id) VALUES (?, ?, ?)', ['pa2', 'Otra de A', 'space-a']);
  await db.run("INSERT INTO trip_people (trip_id, person_id) VALUES ('ta', 'pa2')");
  const carrera = conCarrera(db, 'INSERT INTO payments', ajeno);
  const r = await handle({
    method: 'PUT', path: '/api/payments/y', passcode: CODE_A, ip: '1.1.1.1', db: carrera,
    body: { date: DIA, amount_cents: 100, note: 'de A', from_person_id: 'pa', to_person_id: 'pa2', trip_id: 'ta' },
  });
  assert.ok(carrera.disparada);
  const [fila] = await db.all("SELECT * FROM payments WHERE id = 'y'");
  assert.deepEqual([fila.trip_id, fila.from_person_id, fila.to_person_id, fila.amount_cents, fila.note], ['tb', 'pb', 'pb2', 999, 'de B']);
  assert.equal(r.status, 404);
});

test('abono: las personas deben ser del espacio aunque un vínculo roto las ponga en el viaje', async () => {
  const { db, A } = await twoSpaces();
  await db.run("INSERT INTO trip_people (trip_id, person_id) VALUES ('ta', 'pb')"); // dato corrupto: alguien de B en el viaje de A
  const r = await A('POST', '/api/payments', { date: DIA, amount_cents: 100, from_person_id: 'pa', to_person_id: 'pb', trip_id: 'ta' });
  assert.equal(r.status, 400);
  assert.deepEqual(r.body, { error: 'Alguna persona no va en este viaje' });
  assert.equal((await db.all('SELECT id FROM payments')).length, 0);
});

// Un respaldo con un viaje nuevo (y su persona, medio de pago y gasto) que no existe en ningún espacio al validar.
const respaldo = () => ({
  app: 'gastos-viaje',
  version: 1,
  people: [{ id: 'pnew', name: 'Nueva' }],
  trips: [{ id: 'tnew', name: 'Nuevo', dest_currency: 'EUR', home_currency: 'COP', created_at: '2026-11-01T00:00:00Z' }],
  trip_people: [{ trip_id: 'tnew', person_id: 'pnew' }],
  payment_methods: [{ id: 'mnew', kind: 'cash', name: 'Efectivo', owner_person_id: 'pnew' }],
  expenses: [{ id: 'enew', date: DIA, amount_cents: 100, description: '', payment_method_id: 'mnew', trip_id: 'tnew' }],
  expense_beneficiaries: [{ expense_id: 'enew', person_id: 'pnew' }],
  payments: [{ id: 'ynew', trip_id: 'tnew', from_person_id: 'pnew', to_person_id: 'pnew2', date: DIA, amount_cents: 50 }],
});

test('carrera al restaurar: si otro espacio ocupa un id después de validar, no se escribe nada y no se dice de quién es', async () => {
  const { db } = await twoSpaces();
  const data = respaldo();
  data.people.push({ id: 'pnew2', name: 'Nueva 2' });
  data.trip_people.push({ trip_id: 'tnew', person_id: 'pnew2' });
  const cuenta = async () => Object.fromEntries(await Promise.all(
    ['people', 'trips', 'trip_people', 'payment_methods', 'expenses', 'expense_beneficiaries', 'payments']
      .map(async (t) => [t, (await db.all(`SELECT COUNT(*) AS n FROM ${t}`))[0].n]),
  ));
  const inicial = await cuenta();
  const ajeno = () => db.run(
    "INSERT INTO trips (id, name, dest_currency, home_currency, created_at, space_id) VALUES ('tnew', 'De B', 'USD', 'BRL', '2026-11-01T00:00:00Z', 'space-b')",
  );
  const carrera = conCarrera(db, 'INSERT', ajeno);
  const r = await handle({ method: 'POST', path: '/api/restore', passcode: CODE_A, ip: '1.1.1.1', db: carrera, body: data, query: new URLSearchParams() });
  assert.ok(carrera.disparada);
  assert.equal((await db.all("SELECT id FROM expenses WHERE id = 'enew'")).length, 0, 'el gasto no quedó colgado del viaje de B');
  assert.equal(r.status, 409);
  assert.ok(!/space-b|Grupo B|De B/.test(JSON.stringify(r.body)), 'no dice de quién es el id');
  assert.equal((await db.all("SELECT id FROM people WHERE id = 'pnew'")).length, 0);
  assert.deepEqual(await cuenta(), { ...inicial, trips: inicial.trips + 1 }, 'solo está el viaje que insertó B');
  assert.deepEqual(await db.all("SELECT name, space_id FROM trips WHERE id = 'tnew'"), [{ name: 'De B', space_id: 'space-b' }]);
});

test('restaurar sin carrera sigue escribiendo todo', async () => {
  const { A, db } = await twoSpaces();
  const data = respaldo();
  data.people.push({ id: 'pnew2', name: 'Nueva 2' });
  data.trip_people.push({ trip_id: 'tnew', person_id: 'pnew2' });
  const r = await A('POST', '/api/restore', data);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.add, { trips: 1, people: 2, payment_methods: 1, expenses: 1, payments: 1 });
  assert.equal((await db.all("SELECT space_id FROM trips WHERE id = 'tnew'"))[0].space_id, 'space-a');
  assert.equal((await db.all("SELECT id FROM expenses WHERE id = 'enew'")).length, 1);
  // Restaurar el mismo archivo otra vez: todo existe, nada se agrega y nada falla.
  const otra = await A('POST', '/api/restore', data);
  assert.equal(otra.status, 200);
  assert.deepEqual(otra.body.add, { trips: 0, people: 0, payment_methods: 0, expenses: 0, payments: 0 });
});
