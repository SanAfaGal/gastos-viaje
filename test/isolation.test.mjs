// Aislamiento entre espacios: cada código ve y modifica solo lo suyo.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openMemoryDb } from '../src/db.mjs';
import { handle } from '../src/handlers.mjs';
import { hashCode } from '../src/spaces.mjs';
import { assertNotForeign, owns, ownedIds } from '../src/scope.mjs';

const CODE_A = 'AAAA-BBBB-CCCC';
const CODE_B = 'DDDD-EEEE-FFFF';
const CODE_C = 'GGGG-HHHH-JJJJ';

// Ninguna prueba de este archivo debe salir a internet: las tasas se siembran en la base.
globalThis.fetch = async () => {
  throw new TypeError('no debería consultar la fuente');
};

async function crearEspacio(db, id, name, code) {
  await db.run('INSERT INTO spaces (id, name, code_hash, is_admin, active, created_at) VALUES (?, ?, ?, 0, 1, ?)', [
    id, name, hashCode(code), new Date().toISOString(),
  ]);
}

const llamador = (db, passcode) => (method, path, body, query = {}) =>
  handle({ method, path, body, query: new URLSearchParams(query), passcode, ip: '1.1.1.1', db });

// Dos espacios (A y B) con un viaje, una persona y un medio de pago cada uno, más una persona del administrador.
// Sin APP_PASSCODE: sin código se entra al administrador y con el código de un espacio, a ese espacio.
async function twoSpaces() {
  const db = await openMemoryDb();
  await crearEspacio(db, 'space-a', 'Grupo A', CODE_A);
  await crearEspacio(db, 'space-b', 'Grupo B', CODE_B);
  const A = llamador(db, CODE_A);
  const B = llamador(db, CODE_B);
  const Admin = llamador(db, undefined);
  for (const [call, s, dest, home] of [[A, 'a', 'EUR', 'COP'], [B, 'b', 'USD', 'BRL']]) {
    assert.equal((await call('POST', '/api/trips', { id: `t${s}`, name: `Viaje ${s}`, dest, home })).status, 201);
    assert.equal((await call('POST', '/api/people', { id: `p${s}`, name: `Persona ${s}` })).status, 201);
    assert.equal((await call('POST', '/api/payment-methods', { id: `m${s}`, kind: 'cash', name: `Efectivo ${s}`, owner_person_id: `p${s}` })).status, 201);
  }
  assert.equal((await Admin('POST', '/api/people', { id: 'p-admin', name: 'Admin' })).status, 201);
  return { db, A, B, Admin };
}

// Ejecuta `fn` con APP_PASSCODE definido y lo deja como estaba.
async function conPasscode(valor, fn) {
  process.env.APP_PASSCODE = valor;
  try {
    return await fn();
  } finally {
    delete process.env.APP_PASSCODE;
  }
}

const ids = (rows) => rows.map((r) => r.id).sort();

async function filasDe(db, prefijo) {
  return {
    trips: await db.all('SELECT * FROM trips WHERE id LIKE ? ORDER BY id', [`%${prefijo}`]),
    people: await db.all('SELECT * FROM people WHERE id LIKE ? ORDER BY id', [`%${prefijo}`]),
    methods: await db.all('SELECT * FROM payment_methods WHERE id LIKE ? ORDER BY id', [`%${prefijo}`]),
    links: await db.all('SELECT * FROM trip_people ORDER BY trip_id, person_id'),
  };
}

const filasDelEspacio = async (db, sp) => ({
  trips: await db.all('SELECT id FROM trips WHERE space_id = ? ORDER BY id', [sp]),
  people: await db.all('SELECT id FROM people WHERE space_id = ? ORDER BY id', [sp]),
  methods: await db.all('SELECT id FROM payment_methods WHERE space_id = ? ORDER BY id', [sp]),
});

// ---------- scope.mjs ----------

test('scope: owns, assertNotForeign y ownedIds en las cinco tablas', async () => {
  const { db } = await twoSpaces();
  await db.run('INSERT INTO rates (pair, date, rate) VALUES (?, ?, ?)', ['EUR-COP', '2026-11-14', 4500]);
  await db.run('INSERT INTO rates (pair, date, rate) VALUES (?, ?, ?)', ['USD-BRL', '2026-11-14', 5.5]);
  // Un gasto y un abono en el viaje de A (se insertan directo: su aislamiento por ruta es de otra tarea).
  await db.run(
    `INSERT INTO expenses (id, date, amount_cents, description, payment_method_id, created_at, trip_id)
     VALUES ('ea', '2026-11-14', 100, '', 'ma', '2026-11-14T00:00:00Z', 'ta')`,
  );
  await db.run(
    `INSERT INTO payments (id, trip_id, from_person_id, to_person_id, date, amount_cents, created_at)
     VALUES ('ya', 'ta', 'pa', 'pa', '2026-11-14', 100, '2026-11-14T00:00:00Z')`,
  );
  const propios = { people: 'pa', trips: 'ta', payment_methods: 'ma', expenses: 'ea', payments: 'ya' };
  for (const [table, id] of Object.entries(propios)) {
    assert.equal(await owns(db, table, id, 'space-a'), true, table);
    assert.equal(await owns(db, table, id, 'space-b'), false, table);
    assert.equal(await owns(db, table, 'no-existe', 'space-a'), false, table);
    await assertNotForeign(db, table, id, 'space-a'); // propia: no hace nada
    await assertNotForeign(db, table, 'no-existe', 'space-b'); // no existe: no hace nada
    await assert.rejects(assertNotForeign(db, table, id, 'space-b'), (err) => err.status === 404 && err.message === 'No encontrado', table);
    assert.deepEqual(await ownedIds(db, table, [id, 'no-existe', id], 'space-a'), new Set([id]), table);
    assert.deepEqual(await ownedIds(db, table, [id], 'space-b'), new Set(), table);
    assert.deepEqual(await ownedIds(db, table, [], 'space-a'), new Set(), table);
  }
  assert.deepEqual(await ownedIds(db, 'people', ['pa', 'pb', 'p-admin'], 'space-b'), new Set(['pb']));
  await assert.rejects(owns(db, 'spaces', 'space-a', 'space-a'), /Tabla no permitida/);
  await assert.rejects(owns(db, 'people; DROP TABLE people', 'pa', 'space-a'), /Tabla no permitida/);
  await assert.rejects(ownedIds(db, 'constructor', ['pa'], 'space-a'), /Tabla no permitida/);
});

// ---------- rutas ----------

test('estado: cada espacio ve solo lo suyo, incluido el administrador', async () => {
  const { A, B, Admin } = await twoSpaces();
  const sa = (await A('GET', '/api/state')).body;
  const sb = (await B('GET', '/api/state')).body;
  const sadm = (await Admin('GET', '/api/state')).body;

  assert.deepEqual(ids(sa.trips), ['ta']);
  assert.deepEqual(ids(sa.people), ['pa']);
  assert.deepEqual(ids(sa.payment_methods), ['ma']);
  assert.deepEqual(sa.trips[0].people_ids, ['pa']);
  assert.deepEqual(sa.space, { id: 'space-a', name: 'Grupo A', is_admin: false });

  assert.deepEqual(ids(sb.trips), ['tb']);
  assert.deepEqual(ids(sb.people), ['pb']);
  assert.deepEqual(ids(sb.payment_methods), ['mb']);
  assert.deepEqual(sb.space, { id: 'space-b', name: 'Grupo B', is_admin: false });

  assert.deepEqual(ids(sadm.trips), ['trip-1']);
  assert.deepEqual(ids(sadm.people), ['p-admin']);
  assert.deepEqual(sadm.payment_methods, []);
  assert.deepEqual(sadm.trips[0].people_ids, ['p-admin']); // la persona nueva del administrador no entra a viajes ajenos
  assert.deepEqual(sadm.space, { id: 'space-admin', name: 'Principal', is_admin: true });
});

test('un espacio nuevo sin datos recibe su propio primer viaje al pedir sin id', async () => {
  const { db, B, Admin } = await twoSpaces();
  await db.run('INSERT INTO rates (pair, date, rate) VALUES (?, ?, ?)', ['USD-BRL', '2026-11-14', 5.5]);
  await db.run('INSERT INTO rates (pair, date, rate) VALUES (?, ?, ?)', ['EUR-COP', '2026-11-14', 4500]);
  const adminTrip = (await Admin('GET', '/api/state')).body.trips[0];
  await db.run('INSERT INTO rates (pair, date, rate) VALUES (?, ?, ?)', [`${adminTrip.dest}-${adminTrip.home}`, '2026-11-14', 600]);

  // B tiene un solo viaje (USD -> BRL): sin ?trip= se usan sus monedas, no las del primer viaje de la base.
  const r = await B('GET', '/api/rate', undefined, { date: '2026-11-14' });
  assert.equal(r.status, 200);
  assert.equal(r.body.rate, 5.5);
  // Con el id de un viaje ajeno, el viaje no existe.
  assert.equal((await B('GET', '/api/rate', undefined, { date: '2026-11-14', trip: 'ta' })).status, 400);
  assert.equal((await B('GET', '/api/rates/history', undefined, { days: '2', trip: 'ta' })).status, 400);
  assert.equal((await Admin('GET', '/api/rate', undefined, { date: '2026-11-14' })).body.rate, 600);

  // Un espacio sin viajes no hereda el de nadie.
  await crearEspacio(db, 'space-c', 'Grupo C', CODE_C);
  const C = llamador(db, CODE_C);
  const sin = await C('GET', '/api/rate', undefined, { date: '2026-11-14' });
  assert.equal(sin.status, 400);
  assert.equal(sin.body.error, 'El viaje no existe');
  assert.equal((await C('GET', '/api/rates/history', undefined, { days: '2' })).status, 400);
});

test('PUT con el id de otro espacio no modifica ni copia: personas, medios y viajes', async () => {
  const { db, B } = await twoSpaces();
  const antesA = await filasDe(db, 'a');
  const antesB = await filasDelEspacio(db, 'space-b');

  const persona = await B('PUT', '/api/people/pa', { name: 'Robada' });
  const medio = await B('PUT', '/api/payment-methods/ma', { kind: 'cash', name: 'Robado', owner_person_id: 'pb' });
  const viaje = await B('PUT', '/api/trips/ta', { name: 'Robado', dest: 'USD', home: 'BRL', people_ids: ['pb'] });
  const viajeSinLista = await B('PUT', '/api/trips/ta', { name: 'Robado', dest: 'USD', home: 'BRL' });
  // Por POST con el id en el cuerpo pasa lo mismo.
  const porPost = await B('POST', '/api/people', { id: 'pa', name: 'Robada' });
  for (const r of [persona, medio, viaje, viajeSinLista, porPost]) {
    assert.equal(r.status, 404);
    assert.equal(r.body.error, 'No encontrado');
  }

  assert.deepEqual(await filasDe(db, 'a'), antesA);
  assert.deepEqual(await filasDelEspacio(db, 'space-b'), antesB);
});

test('borrar con un id ajeno no borra', async () => {
  const { db, A, B } = await twoSpaces();
  // A tiene dos viajes para que el suyo se pudiera borrar si el filtro fallara.
  assert.equal((await A('POST', '/api/trips', { id: 'ta2', name: 'Otro', dest: 'EUR', home: 'COP' })).status, 201);
  const antes = await filasDe(db, 'a');
  for (const path of ['/api/people/pa', '/api/payment-methods/ma', '/api/trips/ta']) {
    assert.equal((await B('DELETE', path)).status, 200);
  }
  assert.deepEqual(await filasDe(db, 'a'), antes);
  const sa = (await A('GET', '/api/state')).body;
  assert.deepEqual(ids(sa.people), ['pa']);
  assert.deepEqual(ids(sa.payment_methods), ['ma']);
  assert.deepEqual(ids(sa.trips), ['ta', 'ta2']);
});

test('un medio de pago no puede tener como dueño a una persona de otro espacio', async () => {
  const { db, B } = await twoSpaces();
  const r = await B('POST', '/api/payment-methods', { id: 'mb2', kind: 'cash', name: 'Ajeno', owner_person_id: 'pa' });
  assert.equal(r.status, 400);
  assert.equal(r.body.error, 'El dueño no existe');
  // Tampoco al editar uno propio.
  const e = await B('PUT', '/api/payment-methods/mb', { kind: 'cash', name: 'Ajeno', owner_person_id: 'p-admin' });
  assert.equal(e.status, 400);
  assert.deepEqual(await db.all('SELECT owner_person_id FROM payment_methods WHERE id = ?', ['mb']), [{ owner_person_id: 'pb' }]);
  assert.equal((await db.all('SELECT id FROM payment_methods WHERE id = ?', ['mb2'])).length, 0);
});

test('un viaje no puede incluir personas de otro espacio', async () => {
  const { db, B } = await twoSpaces();
  const nuevo = await B('POST', '/api/trips', { id: 'tb2', name: 'Mezcla', dest: 'USD', home: 'BRL', people_ids: ['pb', 'pa'] });
  assert.equal(nuevo.status, 400);
  assert.equal(nuevo.body.error, 'Alguna persona no existe');
  const editado = await B('PUT', '/api/trips/tb', { name: 'Viaje b', dest: 'USD', home: 'BRL', people_ids: ['p-admin'] });
  assert.equal(editado.status, 400);
  assert.equal(editado.body.error, 'Alguna persona no existe');
  assert.deepEqual(await db.all('SELECT person_id FROM trip_people WHERE trip_id = ?', ['tb']), [{ person_id: 'pb' }]);
  assert.equal((await db.all('SELECT id FROM trips WHERE id = ?', ['tb2'])).length, 0);

  // Un viaje nuevo sin lista recibe solo las personas de su espacio.
  assert.equal((await B('POST', '/api/trips', { id: 'tb3', name: 'Solo B', dest: 'USD', home: 'BRL' })).status, 201);
  assert.deepEqual(await db.all('SELECT person_id FROM trip_people WHERE trip_id = ?', ['tb3']), [{ person_id: 'pb' }]);
  assert.deepEqual(await db.all('SELECT space_id FROM trips WHERE id = ?', ['tb3']), [{ space_id: 'space-b' }]);

  // Una persona nueva sin viaje entra solo a los viajes de su espacio; con un viaje ajeno, no se crea.
  assert.equal((await B('POST', '/api/people', { id: 'pb2', name: 'Nueva' })).status, 201);
  assert.deepEqual(ids((await db.all('SELECT trip_id AS id FROM trip_people WHERE person_id = ?', ['pb2']))), ['tb', 'tb3']);
  const ajeno = await B('POST', '/api/people', { id: 'pb3', name: 'Otra', trip_id: 'ta' });
  assert.equal(ajeno.status, 400);
  assert.equal((await db.all('SELECT id FROM people WHERE id = ?', ['pb3'])).length, 0);
});

test('no se puede borrar el único viaje de un espacio aunque otros espacios tengan viajes', async () => {
  const { db, B } = await twoSpaces();
  const r = await B('DELETE', '/api/trips/tb');
  assert.equal(r.status, 400);
  assert.equal(r.body.error, 'No se puede borrar el único viaje');
  assert.equal((await db.all('SELECT id FROM trips WHERE id = ?', ['tb'])).length, 1);
});

test('restaurar deja las personas, viajes y medios nuevos en el espacio de quien restaura', async () => {
  const { db, B, Admin } = await twoSpaces();
  const backup = {
    app: 'gastos-viaje', version: 1,
    people: [{ id: 'p-rest', name: 'Restaurada' }],
    trips: [{ id: 't-rest', name: 'Restaurado', dest_currency: 'USD', home_currency: 'BRL', created_at: '2026-11-01T00:00:00Z' }],
    trip_people: [{ trip_id: 't-rest', person_id: 'p-rest' }],
    payment_methods: [{ id: 'm-rest', kind: 'cash', name: 'Restaurado', owner_person_id: 'p-rest' }],
    expenses: [], expense_beneficiaries: [],
  };
  assert.equal((await B('POST', '/api/restore', backup)).status, 200);
  for (const table of ['people', 'trips', 'payment_methods']) {
    assert.deepEqual(await db.all(`SELECT space_id FROM ${table} WHERE id LIKE '%-rest'`), [{ space_id: 'space-b' }], table);
  }
  const sb = (await B('GET', '/api/state')).body;
  assert.ok(sb.people.some((p) => p.id === 'p-rest'));
  assert.ok(sb.trips.some((t) => t.id === 't-rest'));
  const sadm = (await Admin('GET', '/api/state')).body;
  assert.ok(!sadm.people.some((p) => p.id === 'p-rest'));
});

test('con APP_PASSCODE definido, un espacio no ve lo del administrador', async () => {
  const { db } = await twoSpaces();
  await conPasscode('clave-admin', async () => {
    const A = llamador(db, CODE_A);
    const Admin = llamador(db, 'clave-admin');
    const sa = (await A('GET', '/api/state')).body;
    assert.deepEqual(sa.space, { id: 'space-a', name: 'Grupo A', is_admin: false });
    assert.deepEqual(ids(sa.trips), ['ta']);
    assert.deepEqual(ids(sa.people), ['pa']);
    assert.deepEqual(ids(sa.payment_methods), ['ma']);
    const sadm = (await Admin('GET', '/api/state')).body;
    assert.equal(sadm.space.is_admin, true);
    assert.deepEqual(ids(sadm.trips), ['trip-1']);
    assert.deepEqual(ids(sadm.people), ['p-admin']);
    assert.deepEqual(sadm.payment_methods, []);
    // Sin código, nada.
    assert.equal((await llamador(db, undefined)('GET', '/api/state')).status, 401);
  });
});
