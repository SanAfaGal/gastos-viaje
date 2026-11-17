import test from 'node:test';
import assert from 'node:assert/strict';
import { openMemoryDb } from '../src/db.mjs';
import { rateHistory, resolveRate, _resetFailures } from '../src/rates.mjs';
import { handle } from '../src/handlers.mjs';
import { todayStr } from '../public/js/money.mjs';

// Las pruebas no dependen del entorno: Netlify define APP_PASSCODE y TURSO_* al construir.
delete process.env.APP_PASSCODE;
delete process.env.TURSO_DATABASE_URL;
delete process.env.TURSO_AUTH_TOKEN;

const PAIR = { dest: 'BRL', home: 'COP' };
const todayYmd = todayStr; // mismo cálculo de "hoy" que usa el servidor
const fakeFetch = (table) => async (url) => {
  const m = url.match(/@([^/]+)\/v1/) ?? url.match(/\/\/([^.]+)\.currency-api/);
  const key = m[1];
  if (key in table) return { ok: true, status: 200, json: async () => ({ brl: { cop: table[key] } }) };
  return { ok: false, status: 404, json: async () => ({}) };
};

test('tasa: exacta, guarda en caché y usa día anterior si falta', async () => {
  _resetFailures();
  const db = await openMemoryDb();
  const opts = { fetchFn: fakeFetch({ '2026-11-10': 1000, '2026-11-12': 1100 }), today: '2026-11-16' };

  assert.deepEqual(await resolveRate(db, '2026-11-12', PAIR, opts), { rate: 1100, rate_date: '2026-11-12', estimated: false });
  assert.equal((await db.all('SELECT * FROM rates')).length, 1);

  // 13 no existe en la fuente; usa el 12 y queda marcada como estimada
  const r = await resolveRate(db, '2026-11-13', PAIR, opts);
  assert.deepEqual(r, { rate: 1100, rate_date: '2026-11-12', estimated: true });
});

test('tasa: red caída usa la última guardada, o null si no hay', async () => {
  _resetFailures();
  const db = await openMemoryDb();
  const down = { fetchFn: async () => { throw new Error('sin red'); }, today: '2026-11-16' };
  assert.equal(await resolveRate(db, '2026-11-14', PAIR, down), null);
  _resetFailures();
  await db.run('INSERT INTO rates (pair, date, rate) VALUES (?, ?, ?)', ['BRL-COP', '2026-11-10', 990]);
  const r = await resolveRate(db, '2026-11-14', PAIR, down);
  assert.deepEqual(r, { rate: 990, rate_date: '2026-11-10', estimated: true });
});

test('API: personas, medios, gasto compartido, idempotencia y cuentas', async () => {
  const db = await openMemoryDb();
  const call = (method, path, body) => handle({ method, path, body, db });
  await db.run('INSERT INTO rates (pair, date, rate) VALUES (?, ?, ?)', ['BRL-COP', '2026-11-14', 1000]);

  const yo = (await call('POST', '/api/people', { id: 'yo', name: 'Yo' })).body;
  await call('POST', '/api/people', { id: 'ana', name: 'Ana' });
  const card = await call('POST', '/api/payment-methods', {
    id: 'visa', kind: 'card', name: 'Visa de Ana', last4: '1234', card_type: 'credit', owner_person_id: 'ana',
  });
  assert.equal(card.status, 201);
  assert.equal((await call('POST', '/api/payment-methods', { kind: 'card', name: 'x', last4: '12', card_type: 'debit', owner_person_id: 'ana' })).status, 400);
  assert.equal(yo.id, 'yo');

  const exp = { id: 'e1', date: '2026-11-14', amount_cents: 5000, description: 'Cena', payment_method_id: 'visa', beneficiary_ids: ['yo', 'ana'] };
  assert.equal((await call('POST', '/api/expenses', exp)).status, 201);
  assert.equal((await call('POST', '/api/expenses', exp)).status, 201); // reenvío: no duplica

  const state = (await call('GET', '/api/state')).body;
  assert.equal(state.expenses.length, 1);
  assert.equal(state.expenses[0].amount_home, 5000000);
  assert.deepEqual([...state.expenses[0].beneficiary_ids].sort(), ['ana', 'yo']);

  assert.equal((await call('DELETE', '/api/people/ana')).status, 409);
  assert.equal((await call('DELETE', '/api/payment-methods/visa')).status, 409);
  assert.equal((await call('DELETE', '/api/expenses/e1')).status, 200);
  assert.equal((await call('GET', '/api/state')).body.expenses.length, 0);
});

test('API: medios de pago con aspecto de tarjeta (color, red, últimos 4 opcionales, dueño obligatorio)', async () => {
  const db = await openMemoryDb();
  const call = (method, path, body) => handle({ method, path, body, db });
  await call('POST', '/api/people', { id: 'ana', name: 'Ana' });
  const base = { kind: 'card', name: 'Nu', card_type: 'credit', owner_person_id: 'ana' };

  // Sin últimos 4 (hay tarjetas sin número visible), con red y color libre.
  const ok = await call('POST', '/api/payment-methods', { ...base, id: 'nu', network: 'mastercard', color: '#7c3aed' });
  assert.equal(ok.status, 201);
  assert.deepEqual(
    { last4: ok.body.last4, network: ok.body.network, color: ok.body.color },
    { last4: null, network: 'mastercard', color: '#7c3aed' },
  );
  const saved = (await call('GET', '/api/state')).body.payment_methods.find((m) => m.id === 'nu');
  assert.equal(saved.color, '#7c3aed');
  assert.equal(saved.last4, null);

  // Con últimos 4 sigue validando que sean 4 números.
  assert.equal((await call('POST', '/api/payment-methods', { ...base, last4: '12a4' })).status, 400);
  assert.equal((await call('POST', '/api/payment-methods', { ...base, id: 'c', last4: '1234' })).status, 201);

  // Red y color inválidos se rechazan; vacíos quedan en automático.
  assert.equal((await call('POST', '/api/payment-methods', { ...base, network: 'inventada' })).status, 400);
  assert.equal((await call('POST', '/api/payment-methods', { ...base, color: 'rojo' })).status, 400);
  assert.equal((await call('POST', '/api/payment-methods', { ...base, color: '#12345' })).status, 400);
  const auto = await call('POST', '/api/payment-methods', { ...base, id: 'auto', network: '', color: '' });
  assert.deepEqual({ network: auto.body.network, color: auto.body.color }, { network: null, color: null });

  // Efectivo no es tarjeta: ignora la red pero admite color.
  const cash = await call('POST', '/api/payment-methods', { kind: 'cash', name: 'Efectivo', owner_person_id: 'ana', network: 'visa', color: '#0d8a6a' });
  assert.equal(cash.body.network, null);
  assert.equal(cash.body.color, '#0d8a6a');

  // El dueño es obligatorio.
  const noOwner = await call('POST', '/api/payment-methods', { ...base, owner_person_id: '' });
  assert.equal(noOwner.status, 400);
  assert.match(noOwner.body.error, /de quién es/);
});

test('API: tasa manual y código de acceso', async () => {
  const db = await openMemoryDb();
  const call = (method, path, body, passcode) => handle({ method, path, body, db, passcode });
  await call('POST', '/api/people', { id: 'yo', name: 'Yo' });
  await call('POST', '/api/payment-methods', { id: 'cash', kind: 'cash', name: 'Efectivo', owner_person_id: 'yo' });
  await call('POST', '/api/expenses', {
    id: 'e2', date: '2026-11-14', amount_cents: 1000, payment_method_id: 'cash',
    beneficiary_ids: ['yo'], rate_manual: 900,
  });
  const e = (await call('GET', '/api/state')).body.expenses[0];
  assert.equal(e.amount_home, 900000);
  assert.equal(e.rate_manual, 1);

  process.env.APP_PASSCODE = 'secreto';
  try {
    assert.equal((await call('GET', '/api/state')).status, 401);
    assert.equal((await call('GET', '/api/ping', null, 'secreto')).status, 200);
  } finally {
    delete process.env.APP_PASSCODE;
  }
});

test('viajes: una base nueva trae "Viaje 1" (BRL a COP) y las monedas se validan', async () => {
  const db = await openMemoryDb();
  const call = (method, path, body) => handle({ method, path, body, db });
  const st = (await call('GET', '/api/state')).body;
  assert.deepEqual(st.trips, [{ id: 'trip-1', name: 'Viaje 1', dest: 'BRL', home: 'COP', people_ids: [] }]);
  assert.equal(st.settings, undefined);

  const base = { name: 'Mexico', dest: 'MXN', home: 'EUR' };
  assert.equal((await call('POST', '/api/trips', { ...base, dest: 'USD', home: 'USD' })).status, 400); // iguales
  assert.equal((await call('POST', '/api/trips', { ...base, dest: 'XXX' })).status, 400);
  assert.equal((await call('POST', '/api/trips', { ...base, name: '  ' })).status, 400);
  assert.equal((await call('POST', '/api/trips', { ...base, id: 'mx', people_ids: ['nadie'] })).status, 400);
  const ok = await call('POST', '/api/trips', { ...base, id: 'mx' });
  assert.equal(ok.status, 201);
  assert.equal((await call('GET', '/api/state')).body.trips.length, 2);
});

test('viajes: cada viaje tiene sus monedas, personas y gastos; el bloqueo de monedas es por viaje', async () => {
  const db = await openMemoryDb();
  const call = (method, path, body) => handle({ method, path, body, db });
  await call('POST', '/api/people', { id: 'yo', name: 'Yo' }); // sin viaje: entra en todos
  await call('POST', '/api/people', { id: 'ana', name: 'Ana' });
  await call('POST', '/api/payment-methods', { id: 'c', kind: 'cash', name: 'Efectivo', owner_person_id: 'yo' });
  await call('POST', '/api/payment-methods', { id: 'ca', kind: 'cash', name: 'Efectivo Ana', owner_person_id: 'ana' });
  await call('POST', '/api/trips', { id: 'mx', name: 'Mexico', dest: 'MXN', home: 'EUR', people_ids: ['yo'] });

  const exp = { date: '2026-11-14', amount_cents: 10000, payment_method_id: 'c', beneficiary_ids: ['yo'], rate_manual: 0.05 };
  assert.equal((await call('POST', '/api/expenses', { ...exp, id: 'g1', trip_id: 'mx' })).status, 201);
  assert.equal((await call('POST', '/api/expenses', { ...exp, id: 'g2' })).status, 201); // sin viaje: va al primero
  const st = (await call('GET', '/api/state')).body;
  const byId = Object.fromEntries(st.expenses.map((e) => [e.id, e]));
  assert.equal(byId.g1.trip_id, 'mx');
  assert.equal(byId.g1.amount_home, 500); // 100 MXN * 0.05 = 5 EUR (monedas de México)
  assert.equal(byId.g2.trip_id, 'trip-1');
  assert.equal(byId.g2.amount_home, 500); // con tasa manual, en COP: 100 BRL * 0.05 = 5 COP

  // Un gasto que se edita conserva su viaje aunque se mande otro.
  assert.equal((await call('PUT', '/api/expenses/g1', { ...exp, trip_id: 'trip-1' })).status, 200);
  assert.equal((await call('GET', '/api/state')).body.expenses.find((e) => e.id === 'g1').trip_id, 'mx');

  // Monedas: bloqueadas solo en el viaje que ya tiene gastos.
  assert.equal((await call('PUT', '/api/trips/mx', { name: 'Mexico', dest: 'BRL', home: 'EUR' })).status, 409);
  assert.equal((await call('PUT', '/api/trips/mx', { name: 'México 2026', dest: 'MXN', home: 'EUR' })).status, 200); // renombrar: ok
  await call('POST', '/api/trips', { id: 'vacio', name: 'Vacío', dest: 'BRL', home: 'COP' });
  assert.equal((await call('PUT', '/api/trips/vacio', { name: 'Vacío', dest: 'USD', home: 'COP' })).status, 200); // sin gastos: ok

  // Participantes: Ana no va a México, así que no cuenta como beneficiaria ni su medio de pago sirve.
  assert.equal((await call('POST', '/api/expenses', { ...exp, id: 'g3', trip_id: 'mx', beneficiary_ids: ['ana'] })).status, 400);
  assert.equal((await call('POST', '/api/expenses', { ...exp, id: 'g4', trip_id: 'mx', payment_method_id: 'ca' })).status, 400);
  // No se puede quitar a quien tiene gastos en el viaje; a quien no, sí.
  assert.equal((await call('PUT', '/api/trips/mx', { name: 'México 2026', dest: 'MXN', home: 'EUR', people_ids: [] })).status, 409);
  assert.equal((await call('PUT', '/api/trips/trip-1', { name: 'Viaje 1', dest: 'BRL', home: 'COP', people_ids: ['ana'] })).status, 409); // quita a Yo, que tiene g2
  assert.equal((await call('PUT', '/api/trips/trip-1', { name: 'Viaje 1', dest: 'BRL', home: 'COP', people_ids: ['yo'] })).status, 200); // quita a Ana, sin gastos
  await call('PUT', '/api/trips/trip-1', { name: 'Viaje 1', dest: 'BRL', home: 'COP', people_ids: ['yo', 'ana'] });
  assert.equal((await call('PUT', '/api/trips/vacio', { name: 'Vacío', dest: 'USD', home: 'COP', people_ids: ['ana'] })).status, 200);

  // Una persona nueva con viaje entra solo en ese viaje; renombrarla no la mete en otros.
  await call('POST', '/api/people', { id: 'leo', name: 'Leo', trip_id: 'vacio' });
  await call('PUT', '/api/people/leo', { name: 'Leonardo' });
  const trips = Object.fromEntries((await call('GET', '/api/state')).body.trips.map((t) => [t.id, t.people_ids.sort()]));
  assert.deepEqual(trips.vacio, ['ana', 'leo']);
  assert.ok(!trips.mx.includes('leo') && !trips['trip-1'].includes('leo'));
});

test('viajes: borrar con y sin gastos; el último no se borra', async () => {
  const db = await openMemoryDb();
  const call = (method, path, body, query = {}) => handle({ method, path, body, db, query: new URLSearchParams(query) });
  assert.equal((await call('DELETE', '/api/trips/trip-1')).status, 400); // es el único
  await call('POST', '/api/people', { id: 'yo', name: 'Yo' });
  await call('POST', '/api/payment-methods', { id: 'c', kind: 'cash', name: 'Efectivo', owner_person_id: 'yo' });
  await call('POST', '/api/trips', { id: 'mx', name: 'Mexico', dest: 'MXN', home: 'EUR' });
  await call('POST', '/api/expenses', {
    id: 'g1', trip_id: 'mx', date: '2026-11-14', amount_cents: 100, payment_method_id: 'c', beneficiary_ids: ['yo'], rate_manual: 1,
  });
  assert.equal((await call('DELETE', '/api/trips/mx')).status, 409);
  assert.equal((await call('GET', '/api/state')).body.expenses.length, 1);
  assert.equal((await call('DELETE', '/api/trips/mx', null, { con_gastos: '1' })).status, 200);
  const st = (await call('GET', '/api/state')).body;
  assert.equal(st.expenses.length, 0);
  assert.deepEqual(st.trips.map((t) => t.id), ['trip-1']);
  assert.equal((await db.all('SELECT COUNT(*) AS n FROM expense_beneficiaries'))[0].n, 0);
  assert.equal((await call('DELETE', '/api/trips/no-existe')).status, 200); // borrar de nuevo no falla
});

test('viajes: la tasa y el historial usan las monedas del viaje pedido', async () => {
  const db = await openMemoryDb();
  const call = (method, path, query = {}) => handle({ method, path, query: new URLSearchParams(query), db });
  await db.run('INSERT INTO rates (pair, date, rate) VALUES (?, ?, ?)', ['BRL-COP', '2026-11-14', 800]);
  await db.run('INSERT INTO rates (pair, date, rate) VALUES (?, ?, ?)', ['MXN-EUR', '2026-11-14', 0.05]);
  await handle({ method: 'POST', path: '/api/trips', body: { id: 'mx', name: 'Mexico', dest: 'MXN', home: 'EUR' }, db });
  assert.equal((await call('GET', '/api/rate', { date: '2026-11-14' })).body.rate, 800); // sin viaje: el primero
  assert.equal((await call('GET', '/api/rate', { date: '2026-11-14', trip: 'mx' })).body.rate, 0.05);
  assert.equal((await call('GET', '/api/rate', { date: '2026-11-14', trip: 'no' })).status, 400);
  // Historial: hoy ya está guardado en cada par, así que no hace falta pedir nada a internet.
  await db.run('INSERT INTO rates (pair, date, rate) VALUES (?, ?, ?)', ['BRL-COP', todayYmd(), 600]);
  await db.run('INSERT INTO rates (pair, date, rate) VALUES (?, ?, ?)', ['MXN-EUR', todayYmd(), 0.07]);
  const rates = async (trip) => (await call('GET', '/api/rates/history', { days: '2', ...trip })).body.map((p) => p.rate);
  assert.ok((await rates({ trip: 'mx' })).includes(0.07));
  assert.ok(!(await rates({ trip: 'mx' })).includes(600));
  assert.ok((await rates({})).includes(600)); // sin viaje: el primero (BRL a COP)
});

test('migración: base de la primera versión (BRL a COP) se conserva', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { openFileDb } = await import('../src/db.mjs');
  const file = join(mkdtempSync(join(tmpdir(), 'bg-mig-')), 'old.db');
  const old = new DatabaseSync(file);
  old.exec(`
    CREATE TABLE people (id TEXT PRIMARY KEY, name TEXT NOT NULL, is_me INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE payment_methods (id TEXT PRIMARY KEY, kind TEXT NOT NULL, name TEXT NOT NULL, last4 TEXT, card_type TEXT, owner_person_id TEXT NOT NULL);
    CREATE TABLE rates (date TEXT PRIMARY KEY, cop_per_brl REAL NOT NULL);
    CREATE TABLE expenses (id TEXT PRIMARY KEY, date TEXT NOT NULL, amount_brl_cents INTEGER NOT NULL, description TEXT NOT NULL DEFAULT '',
      payment_method_id TEXT NOT NULL, rate_cop_per_brl REAL, rate_date TEXT, rate_estimated INTEGER NOT NULL DEFAULT 0,
      rate_manual INTEGER NOT NULL DEFAULT 0, amount_cop INTEGER, created_at TEXT NOT NULL);
    CREATE TABLE expense_beneficiaries (expense_id TEXT NOT NULL, person_id TEXT NOT NULL, PRIMARY KEY (expense_id, person_id));
    INSERT INTO people VALUES ('yo','Yo',1);
    INSERT INTO payment_methods VALUES ('m','cash','Efectivo',NULL,NULL,'yo');
    INSERT INTO rates VALUES ('2026-11-14', 586.7);
    INSERT INTO expenses VALUES ('e','2026-11-14',5000,'Cena','m',586.7,'2026-11-14',0,0,29335,'2026-11-14T00:00:00Z');
    INSERT INTO expense_beneficiaries VALUES ('e','yo');
  `);
  old.close();

  const db = await openFileDb(file);
  const st = (await handle({ method: 'GET', path: '/api/state', db })).body;
  // Los datos de un solo viaje pasan a "Viaje 1" (BRL a COP) con todos sus gastos y personas.
  assert.deepEqual(st.trips, [{ id: 'trip-1', name: 'Viaje 1', dest: 'BRL', home: 'COP', people_ids: ['yo'] }]);
  assert.equal(st.expenses[0].trip_id, 'trip-1');
  assert.equal(st.expenses[0].amount_cents, 5000);
  assert.equal(st.expenses[0].amount_home, 2933500); // 29.335 pesos en centésimas
  assert.equal(st.expenses[0].rate, 586.7);
  // Las columnas nuevas de los medios de pago se agregan sin perder los datos viejos.
  assert.deepEqual(
    { name: st.payment_methods[0].name, color: st.payment_methods[0].color, network: st.payment_methods[0].network },
    { name: 'Efectivo', color: null, network: null },
  );
});

test('migración a varios viajes: conserva las monedas de ajustes y es idempotente', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { openFileDb } = await import('../src/db.mjs');
  const file = join(mkdtempSync(join(tmpdir(), 'bg-trips-')), 'un-viaje.db');
  const old = new DatabaseSync(file);
  old.exec(`
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE people (id TEXT PRIMARY KEY, name TEXT NOT NULL);
    CREATE TABLE payment_methods (id TEXT PRIMARY KEY, kind TEXT NOT NULL, name TEXT NOT NULL, last4 TEXT, card_type TEXT, owner_person_id TEXT NOT NULL);
    CREATE TABLE rates (pair TEXT NOT NULL, date TEXT NOT NULL, rate REAL NOT NULL, PRIMARY KEY (pair, date));
    CREATE TABLE expenses (id TEXT PRIMARY KEY, date TEXT NOT NULL, amount_cents INTEGER NOT NULL, description TEXT NOT NULL DEFAULT '',
      payment_method_id TEXT NOT NULL, rate REAL, rate_date TEXT, rate_estimated INTEGER NOT NULL DEFAULT 0,
      rate_manual INTEGER NOT NULL DEFAULT 0, amount_home INTEGER, created_at TEXT NOT NULL);
    CREATE TABLE expense_beneficiaries (expense_id TEXT NOT NULL, person_id TEXT NOT NULL, PRIMARY KEY (expense_id, person_id));
    INSERT INTO settings VALUES ('dest_currency','MXN'), ('home_currency','EUR');
    INSERT INTO people VALUES ('yo','Yo'), ('ana','Ana');
    INSERT INTO payment_methods VALUES ('m','cash','Efectivo',NULL,NULL,'yo');
    INSERT INTO expenses VALUES ('e','2026-11-14',5000,'Cena','m',0.05,'2026-11-14',0,0,250,'2026-11-14T00:00:00Z');
    INSERT INTO expense_beneficiaries VALUES ('e','yo'), ('e','ana');
  `);
  old.close();

  for (let pass = 1; pass <= 2; pass += 1) { // abrir otra vez (otro arranque en frío) no duplica nada
    const db = await openFileDb(file);
    const st = (await handle({ method: 'GET', path: '/api/state', db })).body;
    assert.equal(st.trips.length, 1, 'pasada ' + pass);
    assert.deepEqual(
      { id: st.trips[0].id, dest: st.trips[0].dest, home: st.trips[0].home, people: [...st.trips[0].people_ids].sort() },
      { id: 'trip-1', dest: 'MXN', home: 'EUR', people: ['ana', 'yo'] },
    );
    assert.equal(st.expenses[0].trip_id, 'trip-1');
    assert.equal(st.expenses[0].amount_home, 250);
  }
});

test('seguridad: límite de intentos fallidos por IP y topes de monto y tasa', async () => {
  const db = await openMemoryDb();
  process.env.APP_PASSCODE = 'secreto';
  try {
    const call = (passcode, ip = '1.1.1.1', extra = {}) => handle({ method: 'GET', path: '/api/ping', passcode, ip, db, ...extra });
    assert.equal((await call('')).status, 401); // sin código: no cuenta como intento
    for (let i = 0; i < 10; i += 1) assert.equal((await call('mal')).status, 401);
    assert.equal((await call('mal')).status, 429);
    assert.equal((await call('secreto')).status, 429); // bloqueado aunque acierte
    assert.equal((await call('secreto', '2.2.2.2')).status, 200); // otra IP no se afecta
    // IPv6: todas las direcciones de un mismo /64 comparten el límite
    for (let i = 0; i < 10; i += 1) await call('mal', `2001:db8:1:2:${i}::${i + 1}`);
    assert.equal((await call('secreto', '2001:db8:1:2:ffff::1')).status, 429);
    assert.equal((await call('secreto', '2001:db8:1:3::1')).status, 200); // otro /64
    // intentos en paralelo: no se pasa del límite aunque lleguen a la vez
    const par = await Promise.all(Array.from({ length: 30 }, () => call('mal', '9.9.9.9')));
    assert.equal(par.filter((r) => r.status === 401).length, 10);
    assert.equal(par.filter((r) => r.status === 429).length, 20);
  } finally {
    delete process.env.APP_PASSCODE;
  }

  const open = (body) => handle({ method: 'POST', path: '/api/expenses', body, db });
  await handle({ method: 'POST', path: '/api/people', body: { id: 'p', name: 'P' }, db });
  await handle({ method: 'POST', path: '/api/payment-methods', body: { id: 'm', kind: 'cash', name: 'E', owner_person_id: 'p' }, db });
  const base = { date: '2026-11-14', payment_method_id: 'm', beneficiary_ids: ['p'] };
  assert.equal((await open({ ...base, amount_cents: 1e12, rate_manual: 1 })).status, 400);
  assert.equal((await open({ ...base, amount_cents: 100, rate_manual: 1e9 })).status, 400);
  assert.equal((await open({ ...base, amount_cents: 100, rate_manual: 'abc' })).status, 201); // texto no numérico: usa la tasa del día o queda pendiente
});

test('historial de tasas: usa lo guardado, pide lo que falta y salta días sin dato', async () => {
  _resetFailures();
  const db = await openMemoryDb();
  await db.run('INSERT INTO rates (pair, date, rate) VALUES (?, ?, ?)', ['BRL-COP', '2026-11-14', 580]);
  const pedidos = [];
  const fetchFn = async (url) => {
    pedidos.push(url);
    const day = url.match(/@([^/]+)\/v1/)?.[1] ?? url.match(/\/\/([^.]+)\.currency/)[1];
    if (day === '2026-11-12') return { ok: false, status: 404, json: async () => ({}) }; // sin dato ese día
    return { ok: true, status: 200, json: async () => ({ brl: { cop: 590 } }) };
  };
  const h = await rateHistory(db, PAIR, 5, { fetchFn, today: '2026-11-16' });
  assert.deepEqual(h.map((p) => p.date), ['2026-11-13', '2026-11-14', '2026-11-15', '2026-11-16']);
  assert.equal(h.find((p) => p.date === '2026-11-14').rate, 580); // lo guardado no se vuelve a pedir
  assert.ok(!pedidos.some((u) => u.includes('@2026-11-14')));
  assert.ok(pedidos.some((u) => u.includes('@latest'))); // hoy
  const otra = await rateHistory(db, PAIR, 5, { fetchFn: async () => { throw new Error('sin red'); }, today: '2026-11-16' });
  assert.equal(otra.length, 4); // segunda vez sale de la base, sin internet
  assert.equal((await rateHistory(db, { dest: 'USD', home: 'USD' }, 3, { today: '2026-11-16' })).length, 3);
});

test('API: /api/rates/history responde con la moneda del viaje', async () => {
  const db = await openMemoryDb();
  await db.run('INSERT INTO rates (pair, date, rate) VALUES (?, ?, ?)', ['BRL-COP', todayYmd(), 600]);
  const r = await handle({ method: 'GET', path: '/api/rates/history', query: new URLSearchParams('days=2'), db });
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.body) && r.body.some((p) => p.rate === 600));
});
