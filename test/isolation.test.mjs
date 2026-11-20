// Aislamiento entre espacios: cada código ve y modifica solo lo suyo.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openMemoryDb } from '../src/db.mjs';
import { handle } from '../src/handlers.mjs';
import { hashCode } from '../src/spaces.mjs';
import { assertNotForeign, owns, ownedIds } from '../src/scope.mjs';
import { _resetFailures } from '../src/rates.mjs';
import { todayStr } from '../public/js/money.mjs';

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

// ---------- gastos, abonos, orden y tasas ----------

const DIA = '2026-11-14';

// Fuente simulada de tasas (como withSource de backup.test.mjs, pero con varios pares): `table` va de versión
// ('latest' o una fecha) a { moneda_origen: { moneda_casa: tasa } }, por ejemplo { [DIA]: { eur: { cop: 4700 } } }.
const withSource = async (table, fn) => {
  const real = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = String(url);
    const version = u.match(/currency-api@([^/]+)\/v1/)?.[1] ?? u.match(/\/\/([^.]+)\.currency-api/)?.[1];
    const dest = u.match(/currencies\/([a-z]+)\.json/)?.[1];
    const rates = table[version]?.[dest];
    if (!version || !rates) return { ok: false, status: 404, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => ({ date: version === 'latest' ? todayStr() : version, [dest]: rates }) };
  };
  try { return await fn(); } finally { globalThis.fetch = real; }
};

// Todas las filas de las tablas de gastos y abonos, de cualquier espacio, para comparar antes y después.
const filasDeGastos = async (db) => ({
  expenses: await db.all('SELECT * FROM expenses ORDER BY id'),
  beneficiaries: await db.all('SELECT * FROM expense_beneficiaries ORDER BY expense_id, person_id'),
  payments: await db.all('SELECT * FROM payments ORDER BY id'),
});

const gasto = (extra) => ({ date: DIA, amount_cents: 10000, description: 'x', beneficiary_ids: ['pa'], payment_method_id: 'ma', ...extra });

// twoSpaces con tasas sembradas (nada sale a internet), una segunda persona en cada espacio, y en cada uno un
// gasto con beneficiario ('ea', 'eb') y un abono ('ya', 'yb').
async function conGastos() {
  const s = await twoSpaces();
  const { db, A, B } = s;
  await db.run('INSERT INTO rates (pair, date, rate) VALUES (?, ?, ?)', ['EUR-COP', DIA, 4500]);
  await db.run('INSERT INTO rates (pair, date, rate) VALUES (?, ?, ?)', ['USD-BRL', DIA, 5.5]);
  for (const [call, x] of [[A, 'a'], [B, 'b']]) {
    assert.equal((await call('POST', '/api/people', { id: `${x}2`, name: `Segunda ${x}` })).status, 201);
    const ok = await call('POST', '/api/expenses', gasto({ id: `e${x}`, trip_id: `t${x}`, payment_method_id: `m${x}`, beneficiary_ids: [`p${x}`] }));
    assert.equal(ok.status, 201);
    const ab = await call('POST', '/api/payments', { id: `y${x}`, trip_id: `t${x}`, from_person_id: `p${x}`, to_person_id: `${x}2`, date: DIA, amount_cents: 500 });
    assert.equal(ab.status, 201);
  }
  return s;
}

test('estado: los gastos, abonos y beneficiarios de A no aparecen en B', async () => {
  const { db, A, B } = await twoSpaces();
  await db.run('INSERT INTO rates (pair, date, rate) VALUES (?, ?, ?)', ['EUR-COP', DIA, 4500]);
  assert.equal((await A('POST', '/api/people', { id: 'a2', name: 'Segunda a' })).status, 201);
  assert.equal((await A('POST', '/api/expenses', gasto({ id: 'ea', trip_id: 'ta' }))).status, 201);
  assert.equal((await A('POST', '/api/payments', { id: 'ya', trip_id: 'ta', from_person_id: 'pa', to_person_id: 'a2', date: DIA, amount_cents: 500 })).status, 201);

  const sb = (await B('GET', '/api/state')).body;
  assert.deepEqual(sb.expenses, []);
  assert.deepEqual(sb.payments, []);
  const sa = (await A('GET', '/api/state')).body;
  assert.deepEqual(ids(sa.expenses), ['ea']);
  assert.deepEqual(sa.expenses[0].beneficiary_ids, ['pa']);
  assert.deepEqual(ids(sa.payments), ['ya']);
});

test('PUT con el id de un gasto o abono de otro espacio da 404 y no lo toca', async () => {
  const { db, B } = await conGastos();
  const antes = await filasDeGastos(db);
  assert.equal(antes.expenses.length, 2);
  assert.equal(antes.payments.length, 2);
  assert.equal(antes.beneficiaries.length, 2);

  // Cuerpos válidos en el espacio de B: lo único ajeno es el id, así que solo el 404 puede frenarlos.
  const cuerpoGasto = gasto({ trip_id: 'tb', payment_method_id: 'mb', beneficiary_ids: ['pb'], description: 'robado', amount_cents: 1 });
  const cuerpoAbono = { trip_id: 'tb', from_person_id: 'pb', to_person_id: 'b2', date: DIA, amount_cents: 1, note: 'robado' };
  const respuestas = [
    await B('PUT', '/api/expenses/ea', cuerpoGasto),
    await B('POST', '/api/expenses', { ...cuerpoGasto, id: 'ea' }),
    await B('PUT', '/api/expenses/ea', { ...cuerpoGasto, trip_id: 'ta' }),
    await B('PUT', '/api/payments/ya', cuerpoAbono),
    await B('POST', '/api/payments', { ...cuerpoAbono, id: 'ya' }),
    await B('PUT', '/api/payments/ya', { ...cuerpoAbono, trip_id: 'ta' }),
  ];
  for (const r of respuestas) {
    assert.equal(r.status, 404);
    assert.equal(r.body.error, 'No encontrado');
  }
  assert.deepEqual(await filasDeGastos(db), antes);
});

test('un gasto con medio de pago, beneficiario o viaje de otro espacio se rechaza', async () => {
  const { db, B } = await conGastos();
  const antes = await filasDeGastos(db);
  const propio = { id: 'eb-nuevo', trip_id: 'tb', payment_method_id: 'mb', beneficiary_ids: ['pb'] };

  const medio = await B('POST', '/api/expenses', gasto({ ...propio, payment_method_id: 'ma' }));
  assert.equal(medio.status, 400);
  assert.equal(medio.body.error, 'El medio de pago no existe');
  const persona = await B('POST', '/api/expenses', gasto({ ...propio, beneficiary_ids: ['pb', 'pa'] }));
  assert.equal(persona.status, 400);
  assert.equal(persona.body.error, 'Alguna persona no existe');
  const personaAdmin = await B('POST', '/api/expenses', gasto({ ...propio, beneficiary_ids: ['p-admin'] }));
  assert.equal(personaAdmin.status, 400);
  assert.equal(personaAdmin.body.error, 'Alguna persona no existe');
  const viaje = await B('POST', '/api/expenses', gasto({ ...propio, trip_id: 'ta' }));
  assert.equal(viaje.status, 400);
  assert.equal(viaje.body.error, 'El viaje no existe');
  // Editar un gasto propio hacia un medio o una persona ajenos tampoco pasa y lo deja como estaba.
  const editarMedio = await B('PUT', '/api/expenses/eb', gasto({ ...propio, payment_method_id: 'ma' }));
  assert.equal(editarMedio.status, 400);
  const editarPersona = await B('PUT', '/api/expenses/eb', gasto({ ...propio, beneficiary_ids: ['pa'] }));
  assert.equal(editarPersona.status, 400);
  assert.deepEqual(await filasDeGastos(db), antes);

  // Control: el mismo gasto con todo propio sí se guarda.
  assert.equal((await B('POST', '/api/expenses', gasto(propio))).status, 201);
});

test('el medio de relleno de "por definir" sale solo de los medios del espacio', async () => {
  const { db, B } = await conGastos();
  await crearEspacio(db, 'space-c', 'Grupo C', CODE_C);
  const C = llamador(db, CODE_C);
  assert.equal((await C('POST', '/api/trips', { id: 'tc', name: 'Viaje c', dest: 'USD', home: 'BRL' })).status, 201);
  assert.equal((await C('POST', '/api/people', { id: 'pc', name: 'Persona c' })).status, 201);
  // Un dato inconsistente (p. ej. venido de una restauración): la persona de A va en el viaje de C. C no tiene
  // medios propios, así que el único medio "de alguien del viaje" es el de A, que no debe usarse de relleno.
  await db.run("INSERT INTO trip_people (trip_id, person_id) VALUES ('tc', 'pa')");
  const antes = await filasDeGastos(db);
  const r = await C('POST', '/api/expenses', gasto({ id: 'ec', trip_id: 'tc', payment_method_id: '', beneficiary_ids: ['pc'] }));
  assert.equal(r.status, 400);
  assert.equal(r.body.error, 'Agrega un medio de pago de alguien del viaje antes de registrar gastos');
  assert.deepEqual(await filasDeGastos(db), antes);

  // Control: B, que sí tiene un medio propio, guarda el gasto por definir con su propio medio de relleno.
  const ok = await B('POST', '/api/expenses', gasto({ id: 'eb-pend', trip_id: 'tb', payment_method_id: '', beneficiary_ids: ['pb'] }));
  assert.equal(ok.status, 201);
  assert.deepEqual(await db.all("SELECT payment_method_id, pay_pending FROM expenses WHERE id = 'eb-pend'"), [{ payment_method_id: 'mb', pay_pending: 1 }]);
});

test('un abono entre personas de otro espacio o en un viaje ajeno se rechaza', async () => {
  const { db, B } = await conGastos();
  const antes = await filasDeGastos(db);
  const base = { trip_id: 'tb', from_person_id: 'pb', to_person_id: 'b2', date: DIA, amount_cents: 700 };

  const deAjena = await B('POST', '/api/payments', { ...base, id: 'yb-x', from_person_id: 'pa' });
  assert.equal(deAjena.status, 400);
  assert.equal(deAjena.body.error, 'Alguna persona no va en este viaje');
  const paraAjena = await B('POST', '/api/payments', { ...base, id: 'yb-x', to_person_id: 'a2' });
  assert.equal(paraAjena.status, 400);
  assert.equal(paraAjena.body.error, 'Alguna persona no va en este viaje');
  const entreAjenas = await B('POST', '/api/payments', { ...base, id: 'yb-x', from_person_id: 'pa', to_person_id: 'a2' });
  assert.equal(entreAjenas.status, 400);
  const viajeAjeno = await B('POST', '/api/payments', { ...base, id: 'yb-x', trip_id: 'ta', from_person_id: 'pa', to_person_id: 'a2' });
  assert.equal(viajeAjeno.status, 400);
  assert.equal(viajeAjeno.body.error, 'El viaje no existe');
  const editar = await B('PUT', '/api/payments/yb', { ...base, from_person_id: 'pa' });
  assert.equal(editar.status, 400);
  assert.deepEqual(await filasDeGastos(db), antes);

  // Control: el mismo abono entre personas propias sí se guarda.
  assert.equal((await B('POST', '/api/payments', { ...base, id: 'yb-x' })).status, 201);
});

test('POST /api/order de B con ids de gastos de A no cambia su orden', async () => {
  const { db, A, B } = await conGastos();
  assert.equal((await A('POST', '/api/expenses', gasto({ id: 'ea2', trip_id: 'ta', description: 'otro' }))).status, 201);
  assert.equal((await A('POST', '/api/order', { ids: ['ea2', 'ea'] })).status, 200);
  const orden = () => db.all('SELECT id, sort_order FROM expenses ORDER BY id');
  const antes = await orden();
  assert.deepEqual(antes, [{ id: 'ea', sort_order: 1 }, { id: 'ea2', sort_order: 0 }, { id: 'eb', sort_order: null }]);

  // Solo ids de A: no cambia nada y la respuesta es la de siempre.
  const ajenos = await B('POST', '/api/order', { ids: ['ea', 'ea2'] });
  assert.deepEqual([ajenos.status, ajenos.body], [200, { ok: true }]);
  assert.deepEqual(await orden(), antes);

  // Mezclados con uno propio y uno inexistente: solo el propio recibe su lugar (el 2.º de la lista).
  const mezcla = await B('POST', '/api/order', { ids: ['ea', 'eb', 'no-existe', 'ea2'] });
  assert.deepEqual([mezcla.status, mezcla.body], [200, { ok: true }]);
  assert.deepEqual(await orden(), [{ id: 'ea', sort_order: 1 }, { id: 'ea2', sort_order: 0 }, { id: 'eb', sort_order: 1 }]);
});

test('DELETE de un gasto y un abono de A hecho por B no los borra', async () => {
  const { db, A, B } = await conGastos();
  const antes = await filasDeGastos(db);
  assert.equal((await B('DELETE', '/api/expenses/ea')).status, 200);
  assert.equal((await B('DELETE', '/api/payments/ya')).status, 200);
  assert.deepEqual(await filasDeGastos(db), antes);
  const sa = (await A('GET', '/api/state')).body;
  assert.deepEqual(ids(sa.expenses), ['ea']);
  assert.deepEqual(sa.expenses[0].beneficiary_ids, ['pa']);
  assert.deepEqual(ids(sa.payments), ['ya']);

  // Control: el dueño sí los borra, y con ellos sus beneficiarios.
  assert.equal((await A('DELETE', '/api/expenses/ea')).status, 200);
  assert.equal((await A('DELETE', '/api/payments/ya')).status, 200);
  const despues = await filasDeGastos(db);
  assert.deepEqual(ids(despues.expenses), ['eb']);
  assert.deepEqual(ids(despues.payments), ['yb']);
  assert.deepEqual(despues.beneficiaries, [{ expense_id: 'eb', person_id: 'pb' }]);
});

test('actualizar tasas en B no cambia los gastos de A', async () => {
  _resetFailures();
  const { db, A, B } = await conGastos();
  const fila = async (id) => (await db.all('SELECT rate, rate_date, rate_source, amount_cents FROM expenses WHERE id = ?', [id]))[0];
  const antesA = await db.all("SELECT * FROM expenses WHERE id = 'ea'");
  assert.equal(antesA[0].rate, 4500);
  assert.equal((await fila('eb')).rate, 5.5);
  // La fuente trae otra tasa para los dos pares: si se mezclaran los espacios, A también cambiaría.
  const fuente = { [DIA]: { eur: { cop: 4700 }, usd: { brl: 6 } } };

  await withSource(fuente, async () => {
    // Un viaje ajeno no existe para B.
    const ajeno = await B('POST', '/api/rates/refresh', undefined, { trip: 'ta' });
    assert.equal(ajeno.status, 400);
    assert.equal(ajeno.body.error, 'El viaje no existe');
    assert.equal((await fila('eb')).rate, 5.5);

    // En seco: cuenta solo el gasto de B y no escribe nada.
    const seco = await B('POST', '/api/rates/refresh', undefined, { dry: '1' });
    assert.equal(seco.status, 200);
    assert.deepEqual([seco.body.dry, seco.body.changed, seco.body.unchanged, seco.body.no_data], [true, 1, 0, 0]);
    assert.equal((await fila('eb')).rate, 5.5);

    // De verdad: cambia el gasto de B (5,5 a 6) y deja idéntico el de A.
    const real = await B('POST', '/api/rates/refresh');
    assert.equal(real.status, 200);
    assert.deepEqual([real.body.dry, real.body.changed, real.body.unchanged, real.body.no_data], [false, 1, 0, 0]);
    assert.equal((await fila('eb')).rate, 6);
    assert.deepEqual(await db.all("SELECT * FROM expenses WHERE id = 'ea'"), antesA);
  });
  assert.equal((await db.all("SELECT rate FROM rates WHERE pair = 'EUR-COP' AND date = ?", [DIA]))[0].rate, 4500);

  // Control: A actualiza lo suyo y deja el de B como estaba.
  await withSource(fuente, async () => {
    assert.equal((await A('POST', '/api/rates/refresh')).body.changed, 1);
  });
  assert.equal((await fila('ea')).rate, 4700);
  assert.equal((await fila('eb')).rate, 6);
});

// ---------- respaldo, restauración y barrido de rutas ----------

const SECCIONES = ['people', 'trips', 'trip_people', 'payment_methods', 'expenses', 'expense_beneficiaries', 'payments'];
const INVALIDO = /^El respaldo tiene datos inválidos/;
const conteo = (people, trips, payment_methods, expenses, payments) => ({ people, trips, payment_methods, expenses, payments });

// Todas las filas de la base, de cualquier espacio (la primera columna de cada tabla es su id o su viaje).
const toda = async (db) => Object.fromEntries(await Promise.all(['spaces', ...SECCIONES]
  .map(async (t) => [t, await db.all(`SELECT * FROM ${t} ORDER BY 1, 2`)])));

// Las filas que pertenecen al espacio `sp` (gastos, abonos y vínculos por su viaje o su persona).
const filasCompletasDe = async (db, sp) => {
  const viajes = 'SELECT id FROM trips WHERE space_id = ?';
  const personas = 'SELECT id FROM people WHERE space_id = ?';
  const gastos = 'SELECT id FROM expenses WHERE trip_id IN (SELECT id FROM trips WHERE space_id = ?)';
  return {
    space: await db.all('SELECT * FROM spaces WHERE id = ?', [sp]),
    trips: await db.all('SELECT * FROM trips WHERE space_id = ? ORDER BY id', [sp]),
    people: await db.all('SELECT * FROM people WHERE space_id = ? ORDER BY id', [sp]),
    payment_methods: await db.all('SELECT * FROM payment_methods WHERE space_id = ? ORDER BY id', [sp]),
    trip_people: await db.all(`SELECT * FROM trip_people WHERE trip_id IN (${viajes}) OR person_id IN (${personas}) ORDER BY 1, 2`, [sp, sp]),
    expenses: await db.all(`SELECT * FROM expenses WHERE trip_id IN (${viajes}) ORDER BY id`, [sp]),
    beneficiaries: await db.all(`SELECT * FROM expense_beneficiaries WHERE expense_id IN (${gastos}) OR person_id IN (${personas}) ORDER BY 1, 2`, [sp, sp]),
    payments: await db.all(`SELECT * FROM payments WHERE trip_id IN (${viajes}) ORDER BY id`, [sp]),
  };
};

// Un respaldo completo con ids que no existen en ningún espacio (con las monedas del viaje de B).
const respaldoNuevo = () => ({
  app: 'gastos-viaje', version: 1,
  people: [{ id: 'n1', name: 'Nueva uno' }, { id: 'n2', name: 'Nueva dos' }],
  trips: [{ id: 'tn', name: 'Viaje nuevo', dest_currency: 'USD', home_currency: 'BRL', created_at: '2026-11-01T00:00:00Z' }],
  trip_people: [{ trip_id: 'tn', person_id: 'n1' }, { trip_id: 'tn', person_id: 'n2' }],
  payment_methods: [{ id: 'mn', kind: 'cash', name: 'Efectivo nuevo', owner_person_id: 'n1' }],
  expenses: [{ id: 'en', date: DIA, amount_cents: 900, description: 'nuevo', payment_method_id: 'mn', trip_id: 'tn', created_at: '2026-11-14T00:00:00Z' }],
  expense_beneficiaries: [{ expense_id: 'en', person_id: 'n1' }, { expense_id: 'en', person_id: 'n2' }],
  payments: [{ id: 'yn', trip_id: 'tn', from_person_id: 'n1', to_person_id: 'n2', date: DIA, amount_cents: 300, created_at: '2026-11-14T00:00:00Z' }],
});

// Una copia de respaldoNuevo() con un cambio aplicado.
const respaldoCon = (cambiar) => { const f = respaldoNuevo(); cambiar(f); return f; };
// Ids de cada sección con id de un respaldo (o del estado), y los que tiene A tras conGastos().
const idsDe = (b) => Object.fromEntries(['people', 'trips', 'payment_methods', 'expenses', 'payments'].map((t) => [t, ids(b[t])]));
const IDS_A = { people: ['a2', 'pa'], trips: ['ta'], payment_methods: ['ma'], expenses: ['ea'], payments: ['ya'] };

test('el respaldo de A no trae nada de B ni la tabla spaces', async () => {
  const { A, B, Admin } = await conGastos();
  const { status, body: b } = await A('GET', '/api/backup');
  assert.equal(status, 200);
  assert.deepEqual(Object.keys(b).sort(), ['app', 'exportado', 'version', ...SECCIONES].sort());
  assert.deepEqual([b.app, b.version], ['gastos-viaje', 1]);
  assert.deepEqual(idsDe(b), IDS_A);
  assert.deepEqual(b.expense_beneficiaries, [{ expense_id: 'ea', person_id: 'pa' }]);
  assert.deepEqual(b.trip_people.map((l) => `${l.trip_id}/${l.person_id}`).sort(), ['ta/a2', 'ta/pa']);
  const texto = JSON.stringify(b);
  for (const prohibido of ['space_id', 'code_hash', 'spaces', 'space-a', 'space-b', 'Grupo', 'Persona b', 'Viaje b', '"tb"', '"pb"', '"mb"', '"eb"', '"yb"', 'p-admin']) {
    assert.ok(!texto.includes(prohibido), prohibido);
  }
  // Las columnas de cada fila son las de siempre (sin space_id).
  assert.deepEqual([b.people[0], b.trips[0]].map((f) => Object.keys(f).sort()), [['id', 'name'], ['created_at', 'dest_currency', 'home_currency', 'id', 'name']]);
  // B y el administrador tampoco ven lo de A.
  assert.deepEqual(idsDe((await B('GET', '/api/backup')).body), { people: ['b2', 'pb'], trips: ['tb'], payment_methods: ['mb'], expenses: ['eb'], payments: ['yb'] });
  assert.deepEqual(idsDe((await Admin('GET', '/api/backup')).body), { people: ['p-admin'], trips: ['trip-1'], payment_methods: [], expenses: [], payments: [] });
});

test('restaurar en B un respaldo de A copia los datos como nuevos de B solo si los ids no existen en otros espacios', async () => {
  const { db, A, B } = await conGastos();
  const deA = (await A('GET', '/api/backup')).body;
  const rechaza = async (file, query, msg) => {
    const r = await B('POST', '/api/restore', file, query);
    assert.equal(r.status, 400, msg);
    assert.match(r.body.error, INVALIDO, msg);
    assert.ok(!/space|Grupo/.test(r.body.error), r.body.error);
    return r.body.error;
  };
  // (a) Los ids de A siguen en A: falla con 400 de datos inválidos, sin nombrar el id ni de quién es, y no escribe nada.
  const antes = await toda(db);
  for (const query of [undefined, { dry: '1' }]) assert.equal(await rechaza(deA, query), 'El respaldo tiene datos inválidos (people)');
  // Un solo id ajeno en una sección basta, aunque el resto sea nuevo.
  for (const [seccion, fila] of [
    ['people', { id: 'pa', name: 'x' }], ['people', { id: 'p-admin', name: 'x' }],
    ['trips', { id: 'ta', name: 'x', dest_currency: 'USD', home_currency: 'BRL' }],
    ['payment_methods', { id: 'ma', kind: 'cash', name: 'x', owner_person_id: 'n1' }],
    ['expenses', { id: 'ea', date: DIA, amount_cents: 1, payment_method_id: 'mn', trip_id: 'tn' }],
    ['payments', { id: 'ya', trip_id: 'tn', from_person_id: 'n1', to_person_id: 'n2', date: DIA, amount_cents: 1 }],
  ]) {
    const file = respaldoCon((f) => f[seccion].push(fila));
    if (seccion === 'expenses') file.expense_beneficiaries.push({ expense_id: 'ea', person_id: 'n1' });
    assert.equal(await rechaza(file, undefined, `${seccion} ${fila.id}`), `El respaldo tiene datos inválidos (${seccion})`);
  }
  // Las referencias a filas de A (dueño, viaje, medio, beneficiario, personas del abono, vínculo) cuentan como inexistentes.
  for (const cambiar of [
    (f) => { f.payment_methods[0].owner_person_id = 'pa'; }, (f) => { f.expenses[0].trip_id = 'ta'; },
    (f) => { f.expenses[0].payment_method_id = 'ma'; }, (f) => { f.expense_beneficiaries.push({ expense_id: 'en', person_id: 'pa' }); },
    (f) => { f.payments[0].trip_id = 'ta'; }, (f) => { f.payments[0].to_person_id = 'a2'; },
    (f) => { f.trip_people.push({ trip_id: 'tn', person_id: 'pa' }); },
  ]) await rechaza(respaldoCon(cambiar), undefined, String(cambiar)); // aquí el mensaje puede repetir el id del archivo
  // Un vínculo con un viaje de A no se agrega (el viaje no es nuevo ni de B).
  const soloVinculo = { app: 'gastos-viaje', version: 1, ...Object.fromEntries(SECCIONES.map((s) => [s, []])), trip_people: [{ trip_id: 'ta', person_id: 'pb' }] };
  assert.equal((await B('POST', '/api/restore', soloVinculo)).status, 200);
  assert.deepEqual(await toda(db), antes);
  // (b) Con ids nuevos entra completo, en el espacio de B, y aparece en su estado y no en el de A.
  const antesA = await filasCompletasDe(db, 'space-a');
  const r = await B('POST', '/api/restore', respaldoNuevo());
  assert.deepEqual([r.status, r.body.add, r.body.skip], [200, conteo(2, 1, 1, 1, 1), conteo(0, 0, 0, 0, 0)]);
  for (const t of ['people', 'trips', 'payment_methods']) {
    assert.deepEqual(await db.all(`SELECT DISTINCT space_id FROM ${t} WHERE id IN ('n1', 'n2', 'tn', 'mn')`), [{ space_id: 'space-b' }], t);
  }
  const sb = (await B('GET', '/api/state')).body;
  assert.deepEqual(idsDe(sb), { people: ['b2', 'n1', 'n2', 'pb'], trips: ['tb', 'tn'], payment_methods: ['mb', 'mn'], expenses: ['eb', 'en'], payments: ['yb', 'yn'] });
  assert.deepEqual(sb.trips.find((t) => t.id === 'tn').people_ids.sort(), ['n1', 'n2']);
  assert.deepEqual(idsDe((await A('GET', '/api/state')).body), IDS_A);
  assert.deepEqual(await filasCompletasDe(db, 'space-a'), antesA);
  // El mismo archivo otra vez en B: todo ya existe en B y se omite sin error. En A esos ids son de B: falla.
  const otra = await B('POST', '/api/restore', respaldoNuevo());
  assert.deepEqual([otra.status, otra.body.skip], [200, conteo(2, 1, 1, 1, 1)]);
  assert.equal((await A('POST', '/api/restore', respaldoNuevo())).status, 400);
  assert.deepEqual(await filasCompletasDe(db, 'space-a'), antesA);
});

test('restaurar con dry=1 no revela ni cuenta filas de otro espacio', async () => {
  const { db, A, B } = await conGastos();
  const antes = await toda(db);
  // Su propio respaldo en seco: omite solo las filas de B.
  const propio = await B('POST', '/api/restore', (await B('GET', '/api/backup')).body, { dry: '1' });
  assert.deepEqual([propio.status, propio.body], [200, { dry: true, add: conteo(0, 0, 0, 0, 0), skip: conteo(2, 1, 1, 1, 1) }]);
  // Ids nuevos en seco: todo entraría y nada se omite, aunque A tenga filas.
  const nuevo = await B('POST', '/api/restore', respaldoNuevo(), { dry: '1' });
  assert.deepEqual([nuevo.status, nuevo.body], [200, { dry: true, add: conteo(2, 1, 1, 1, 1), skip: conteo(0, 0, 0, 0, 0) }]);
  // El respaldo de A en seco no cuenta nada: falla igual que sin dry, con el mensaje de datos inválidos.
  const ajeno = await B('POST', '/api/restore', (await A('GET', '/api/backup')).body, { dry: '1' });
  assert.deepEqual([ajeno.status, Object.keys(ajeno.body)], [400, ['error']]);
  assert.match(ajeno.body.error, INVALIDO);
  assert.deepEqual(await toda(db), antes);
});

test('ninguna ruta devuelve ni modifica datos de otro espacio', async () => {
  _resetFailures();
  const { db, A, B } = await conGastos();
  const deA = (await A('GET', '/api/backup')).body;
  const antesA = await filasCompletasDe(db, 'space-a');
  // Lo que identifica a A: nombres y espacio como texto; los ids como cadena JSON exacta (son cortos).
  const textosA = ['Viaje a', 'Persona a', 'Efectivo a', 'Segunda a', 'Grupo A', 'space-a'];
  const sensibles = [...textosA, ...['ta', 'pa', 'a2', 'ma', 'ea', 'ya'].map((id) => `"${id}"`)];
  const gastoB = gasto({ trip_id: 'tb', payment_method_id: 'mb', beneficiary_ids: ['pb'] });
  const abonoB = { trip_id: 'tb', from_person_id: 'pb', to_person_id: 'b2', date: DIA, amount_cents: 1 };
  // Todas las rutas de handle(), con ids de A desde B: [método, ruta, cuerpo, query].
  const metodo = (extra) => ({ kind: 'cash', name: 'x', owner_person_id: 'pb', ...extra });
  const rutas = [
    ['GET', '/api/ping'], ['GET', '/api/state'], ['POST', '/api/trips', { id: 'ta', name: 'x', dest: 'USD', home: 'BRL' }],
    ['PUT', '/api/trips/ta', { name: 'x', dest: 'USD', home: 'BRL', people_ids: ['pb'] }],
    ['DELETE', '/api/trips/ta'], ['DELETE', '/api/trips/ta', undefined, { con_gastos: '1' }],
    ['POST', '/api/people', { id: 'pa', name: 'x' }], ['POST', '/api/people', { id: 'pb9', name: 'x', trip_id: 'ta' }],
    ['PUT', '/api/people/pa', { name: 'x' }], ['DELETE', '/api/people/pa'], ['POST', '/api/payment-methods', metodo({ id: 'ma' })],
    ['POST', '/api/payment-methods', metodo({ id: 'mb9', owner_person_id: 'pa' })], ['PUT', '/api/payment-methods/ma', metodo()],
    ['DELETE', '/api/payment-methods/ma'], ['POST', '/api/expenses', { ...gastoB, id: 'ea' }],
    ['POST', '/api/expenses', { ...gastoB, id: 'eb9', trip_id: 'ta', payment_method_id: 'ma', beneficiary_ids: ['pa'] }],
    ['PUT', '/api/expenses/ea', gastoB], ['DELETE', '/api/expenses/ea'], ['POST', '/api/payments', { ...abonoB, id: 'ya' }],
    ['POST', '/api/payments', { ...abonoB, id: 'yb9', trip_id: 'ta', from_person_id: 'pa', to_person_id: 'a2' }],
    ['PUT', '/api/payments/ya', abonoB], ['DELETE', '/api/payments/ya'], ['POST', '/api/order', { ids: ['ea', 'eb'] }],
    ['GET', '/api/rates/history', undefined, { days: '2', trip: 'ta' }], ['GET', '/api/rates/history', undefined, { days: '2' }],
    ['POST', '/api/rates/refresh', undefined, { trip: 'ta' }], ['POST', '/api/rates/refresh', undefined, { trip: 'ta', dry: '1' }],
    ['POST', '/api/rates/refresh', undefined, { dry: '1' }], ['GET', '/api/rate', undefined, { date: DIA, trip: 'ta' }],
    ['GET', '/api/rate', undefined, { date: DIA }], ['GET', '/api/resolve-place'], ['GET', '/api/backup'],
    ['POST', '/api/restore', deA], ['POST', '/api/restore', deA, { dry: '1' }], ['GET', '/api/no-existe/ta'],
  ];
  // La fuente de tasas trae otra tasa para EUR-COP: si B tocara los gastos de A, cambiarían.
  await withSource({ [DIA]: { eur: { cop: 4700 } } }, async () => {
    for (const [method, path, body, query] of rutas) {
      const r = await B(method, path, body, query);
      const texto = JSON.stringify(r);
      const ruta = `${method} ${path} ${JSON.stringify(query ?? {})}`;
      assert.ok(r.status < 500, `${ruta}: ${texto}`);
      for (const s of sensibles) assert.ok(!texto.includes(s), `${ruta} revela ${s}: ${texto}`);
      assert.deepEqual(await filasCompletasDe(db, 'space-a'), antesA, ruta);
    }
  });
  // Control positivo: A sigue viendo y respaldando lo suyo, y la misma ruta con sus ids le funciona.
  assert.deepEqual(idsDe((await A('GET', '/api/state')).body), IDS_A);
  const respaldoA = JSON.stringify((await A('GET', '/api/backup')).body);
  for (const t of textosA.slice(0, 4)) assert.ok(respaldoA.includes(t), t);
  const editada = await A('PUT', '/api/people/pa', { name: 'Persona a editada' });
  assert.deepEqual([editada.status, editada.body.id], [200, 'pa']);
});
