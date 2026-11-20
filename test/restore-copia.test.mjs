// Restaurar un respaldo en un espacio distinto del que lo hizo: los ids del archivo ya existen en el otro espacio,
// así que las filas se copian con ids nuevos (derivados del espacio y del id original) y todo queda en el espacio de
// quien restaura. Antes se rechazaba con "El respaldo tiene datos inválidos (people)".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openMemoryDb } from '../src/db.mjs';
import { handle } from '../src/handlers.mjs';
import { hashCode } from '../src/spaces.mjs';

const CODE_A = 'AAAA-BBBB-CCCC';
const CODE_B = 'DDDD-EEEE-FFFF';
const CODE_C = 'GGGG-HHHH-JJJJ';
const DIA = '2026-11-14';

delete process.env.APP_PASSCODE;
delete process.env.ADMIN_PASSCODE;
delete process.env.TURSO_DATABASE_URL;
delete process.env.TURSO_AUTH_TOKEN;

globalThis.fetch = async () => {
  throw new TypeError('no debería consultar la fuente');
};

const llamador = (db, passcode) => (method, path, body, query = {}) =>
  handle({ method, path, body, query: new URLSearchParams(query), passcode, ip: '1.1.1.1', db });

// A tiene un viaje con dos personas, un medio de pago, un gasto compartido y un abono. B y C empiezan con lo suyo.
async function espacios() {
  const db = await openMemoryDb();
  for (const [id, name, code] of [['space-a', 'Grupo A', CODE_A], ['space-b', 'Grupo B', CODE_B], ['space-c', 'Grupo C', CODE_C]]) {
    await db.run('INSERT INTO spaces (id, name, code_hash, is_admin, active, created_at) VALUES (?, ?, ?, 0, 1, ?)', [id, name, hashCode(code), new Date().toISOString()]);
  }
  await db.run('INSERT INTO rates (pair, date, rate) VALUES (?, ?, ?)', ['EUR-COP', DIA, 4500]);
  const [A, B, C] = [CODE_A, CODE_B, CODE_C].map((c) => llamador(db, c));
  const ok = async (p, status = 201) => assert.equal((await p).status, status);
  await ok(A('POST', '/api/trips', { id: 'ta', name: 'Lisboa', dest: 'EUR', home: 'COP', people_ids: [] }));
  await ok(A('POST', '/api/people', { id: 'pa', name: 'Ana', trip_id: 'ta' }));
  await ok(A('POST', '/api/people', { id: 'a2', name: 'Beto', trip_id: 'ta' }));
  await ok(A('POST', '/api/payment-methods', { id: 'ma', kind: 'cash', name: 'Efectivo de Ana', owner_person_id: 'pa' }));
  await ok(A('POST', '/api/expenses', { id: 'ea', date: DIA, amount_cents: 1000, description: 'Cena', payment_method_id: 'ma', beneficiary_ids: ['pa', 'a2'], trip_id: 'ta' }));
  await ok(A('POST', '/api/payments', { id: 'ya', trip_id: 'ta', from_person_id: 'a2', to_person_id: 'pa', date: DIA, amount_cents: 300 }));
  await ok(B('POST', '/api/people', { id: 'pb', name: 'Propia de B' }));
  return { db, A, B, C };
}

const sinHora = ({ exportado, ...resto }) => resto; // `exportado` cambia en cada respaldo
const respaldoDe = async (call) => sinHora((await call('GET', '/api/backup')).body);
const AGREGA = { trips: 1, people: 2, payment_methods: 1, expenses: 1, payments: 1 };
const CERO = { trips: 0, people: 0, payment_methods: 0, expenses: 0, payments: 0 };
const ID_DE_A = ['ta', 'pa', 'a2', 'ma', 'ea', 'ya'];

test('restaurar en otro espacio un respaldo cuyos ids ya existen en el primero copia todo con ids nuevos', async () => {
  const { A, B } = await espacios();
  const deA = (await A('GET', '/api/backup')).body;
  const antesA = await respaldoDe(A);

  const r = await B('POST', '/api/restore', deA);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.add, AGREGA);
  assert.deepEqual(r.body.skip, CERO);

  const estado = (await B('GET', '/api/state')).body;
  assert.deepEqual(estado.people.map((p) => p.name).sort(), ['Ana', 'Beto', 'Propia de B']);
  // Ningún id de A se reutiliza en B.
  const idsDeB = [...estado.trips, ...estado.people, ...estado.payment_methods, ...estado.expenses, ...estado.payments].map((x) => x.id);
  for (const id of ID_DE_A) assert.ok(!idsDeB.includes(id), `B no debe tener el id ${id}`);

  // Las referencias quedan consistentes, todas dentro de B.
  const ana = estado.people.find((p) => p.name === 'Ana');
  const beto = estado.people.find((p) => p.name === 'Beto');
  const viaje = estado.trips.find((t) => t.name === 'Lisboa');
  const medio = estado.payment_methods.find((m) => m.name === 'Efectivo de Ana');
  assert.equal(medio.owner_person_id, ana.id);
  assert.deepEqual([...viaje.people_ids].sort(), [ana.id, beto.id].sort());
  assert.equal(estado.expenses.length, 1);
  assert.equal(estado.expenses[0].trip_id, viaje.id);
  assert.equal(estado.expenses[0].payment_method_id, medio.id);
  assert.deepEqual([...estado.expenses[0].beneficiary_ids].sort(), [ana.id, beto.id].sort());
  assert.deepEqual([estado.payments[0].trip_id, estado.payments[0].from_person_id, estado.payments[0].to_person_id], [viaje.id, beto.id, ana.id]);

  // A no cambió en nada.
  assert.deepEqual(await respaldoDe(A), antesA);
});

test('restaurar el mismo archivo otra vez en ese espacio no duplica nada', async () => {
  const { A, B } = await espacios();
  const deA = (await A('GET', '/api/backup')).body;
  await B('POST', '/api/restore', deA);
  const antes = await respaldoDe(B);
  const otra = await B('POST', '/api/restore', deA);
  assert.equal(otra.status, 200);
  assert.deepEqual(otra.body.add, CERO);
  assert.deepEqual(otra.body.skip, { trips: 1, people: 2, payment_methods: 1, expenses: 1, payments: 1 });
  assert.deepEqual(await respaldoDe(B), antes);
});

test('en seco cuenta lo mismo que luego agrega y no escribe nada', async () => {
  const { A, B } = await espacios();
  const deA = (await A('GET', '/api/backup')).body;
  const antes = await respaldoDe(B);
  const seco = await B('POST', '/api/restore', deA, { dry: '1' });
  assert.deepEqual([seco.status, seco.body.dry, seco.body.add], [200, true, AGREGA]);
  assert.deepEqual(await respaldoDe(B), antes);
  assert.deepEqual((await B('POST', '/api/restore', deA)).body.add, AGREGA);
});

test('un archivo que mezcla filas propias y de otro espacio omite las propias y copia las demás', async () => {
  const { A, B } = await espacios();
  const archivo = (await A('GET', '/api/backup')).body;
  archivo.people.push(...(await B('GET', '/api/backup')).body.people); // la persona 'pb', que ya es de B
  const r = await B('POST', '/api/restore', archivo);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.add, AGREGA);
  assert.deepEqual(r.body.skip, { ...CERO, people: 1 });
});

test('dos espacios que restauran el mismo respaldo no chocan entre sí: cada uno recibe ids distintos', async () => {
  const { A, B, C } = await espacios();
  const deA = (await A('GET', '/api/backup')).body;
  assert.equal((await B('POST', '/api/restore', deA)).status, 200);
  assert.equal((await C('POST', '/api/restore', deA)).status, 200);
  const ids = async (call) => (await call('GET', '/api/state')).body.people.map((p) => p.id).sort();
  const [deB, deC] = [await ids(B), await ids(C)];
  assert.equal(deB.filter((id) => deC.includes(id)).length, 0);
});

test('una referencia a una fila de otro espacio que el archivo no trae sigue siendo inválida', async () => {
  const { A, B } = await espacios();
  const archivo = (await A('GET', '/api/backup')).body;
  archivo.people = archivo.people.filter((p) => p.id !== 'pa'); // el dueño del medio ya no viene en el archivo
  const antes = await respaldoDe(B);
  const r = await B('POST', '/api/restore', archivo);
  assert.equal(r.status, 400);
  assert.match(r.body.error, /datos inválidos/);
  assert.deepEqual(await respaldoDe(B), antes);
});

test('un id repetido dentro del mismo archivo sigue rechazándose', async () => {
  const { A, B } = await espacios();
  const archivo = (await A('GET', '/api/backup')).body;
  archivo.people.push({ ...archivo.people[0] });
  assert.equal((await B('POST', '/api/restore', archivo)).status, 400);
});
