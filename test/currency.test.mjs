import test from 'node:test';
import assert from 'node:assert/strict';
import { openMemoryDb } from '../src/db.mjs';
import { handle } from '../src/handlers.mjs';
import { byDay, summary } from '../public/js/stats.mjs';
import { computeSettlement } from '../public/js/settlement.mjs';
import { fmtMoney, parseAmount, setCurrencies } from '../public/js/money.mjs';
import { routeFrom } from '../public/js/places.mjs';

delete process.env.APP_PASSCODE;
delete process.env.TURSO_DATABASE_URL;
delete process.env.TURSO_AUTH_TOKEN;

// Viaje BRL -> COP con dos personas. Las tasas de días cerrados ya están en el caché: la prueba no sale a internet.
async function setup() {
  const db = await openMemoryDb();
  const call = (method, path, body, query = {}) => handle({ method, path, body, query: new URLSearchParams(query), db });
  await call('POST', '/api/people', { id: 'yo', name: 'Yo' });
  await call('POST', '/api/people', { id: 'ana', name: 'Ana' });
  await call('POST', '/api/payment-methods', { id: 'c', kind: 'cash', name: 'Efectivo', owner_person_id: 'yo' });
  for (const [pair, rate] of [['BRL-COP', 800], ['USD-COP', 4000]]) {
    for (const d of ['2026-11-01', '2026-11-10', '2026-11-12']) await db.run('INSERT INTO rates (pair, date, rate) VALUES (?, ?, ?)', [pair, d, rate]);
  }
  const exp = (id, date, cents, extra = {}) => ({ id, date, amount_cents: cents, payment_method_id: 'c', beneficiary_ids: ['yo', 'ana'], ...extra });
  const state = async () => (await call('GET', '/api/state')).body;
  return { db, call, exp, state };
}

test('gasto en la moneda de casa: sin conversión (tasa 1) y suma directo', async () => {
  const { call, exp, state } = await setup();
  const res = await call('POST', '/api/expenses', exp('vuelo', '2026-11-01', 85000000, { currency: 'COP' })); // 850.000 COP
  assert.equal(res.status, 201);
  const e = (await state()).expenses[0];
  assert.equal(e.currency, 'COP');
  assert.equal(e.rate, 1);
  assert.equal(e.rate_source, null);
  assert.equal(e.rate_estimated, 0);
  assert.equal(e.amount_home, 85000000);
});

test('gasto en un tercer país: se convierte con la tasa de su propio par', async () => {
  const { call, exp, state } = await setup();
  await call('POST', '/api/expenses', exp('escala', '2026-11-10', 2500, { currency: 'USD' })); // 25 USD
  const e = (await state()).expenses[0];
  assert.equal(e.currency, 'USD');
  assert.equal(e.rate, 4000);
  assert.equal(e.amount_home, 10000000); // 25 * 4000 = 100.000 COP
});

test('gasto en la moneda del destino: se guarda vacío y se devuelve con su moneda; sin moneda es igual', async () => {
  const { db, call, exp, state } = await setup();
  await call('POST', '/api/expenses', exp('a', '2026-11-10', 1000, { currency: 'BRL' }));
  await call('POST', '/api/expenses', exp('b', '2026-11-10', 1000)); // como lo mandan las colas y celulares anteriores
  const rows = await db.all('SELECT id, currency FROM expenses ORDER BY id');
  assert.deepEqual(rows, [{ id: 'a', currency: null }, { id: 'b', currency: null }]);
  const st = await state();
  assert.deepEqual(st.expenses.map((e) => [e.currency, e.rate, e.amount_home]), [['BRL', 800, 800000], ['BRL', 800, 800000]]);
});

test('moneda inválida se rechaza y editar puede cambiar la moneda', async () => {
  const { call, exp, state } = await setup();
  assert.equal((await call('POST', '/api/expenses', exp('x', '2026-11-10', 1000, { currency: 'ZZZ' }))).status, 400);
  await call('POST', '/api/expenses', exp('x', '2026-11-10', 1000, { currency: 'USD' }));
  assert.equal((await state()).expenses[0].rate, 4000);
  await call('PUT', '/api/expenses/x', exp('x', '2026-11-10', 1000, { currency: 'COP' }));
  const e = (await state()).expenses[0];
  assert.deepEqual([e.currency, e.rate, e.amount_home], ['COP', 1, 1000]);
});

test('GET /api/rate con currency: tasa de esa moneda hacia la de casa', async () => {
  const { call } = await setup();
  const rate = (q) => call('GET', '/api/rate', undefined, q);
  assert.equal((await rate({ date: '2026-11-10', currency: 'USD' })).body.rate, 4000);
  assert.equal((await rate({ date: '2026-11-10', currency: 'COP' })).body.rate, 1);
  assert.equal((await rate({ date: '2026-11-10' })).body.rate, 800);
  assert.equal((await rate({ date: '2026-11-10', currency: 'ZZZ' })).status, 400);
});

test('los gastos en la moneda de casa no ocupan el cupo de revisión de tasas y mantienen tasa 1', async () => {
  const { call, exp, state } = await setup();
  // 10 gastos en casa en días cerrados: no hay fila COP-COP en rates, y no deben revisarse una y otra vez.
  for (let i = 0; i < 10; i += 1) await call('POST', '/api/expenses', exp(`h${i}`, '2026-11-01', 1000 + i, { currency: 'COP' }));
  const st = await state();
  assert.ok(st.expenses.every((e) => e.rate === 1 && e.rate_date === e.date));
});

test('gastos en varias monedas suman en el total y entran en las cuentas', async () => {
  const { call, exp, state } = await setup();
  await call('POST', '/api/expenses', exp('casa', '2026-11-01', 100000, { currency: 'COP' })); // 1.000 COP
  await call('POST', '/api/expenses', exp('brl', '2026-11-10', 1000)); // 10 BRL = 8.000 COP
  await call('POST', '/api/expenses', exp('usd', '2026-11-12', 500, { currency: 'USD' })); // 5 USD = 20.000 COP
  const st = await state();
  const total = st.expenses.reduce((a, e) => a + e.amount_home, 0);
  assert.equal(total, 100000 + 800000 + 2000000);
  const methods = Object.fromEntries(st.payment_methods.map((m) => [m.id, m]));
  const s = computeSettlement(
    st.expenses.map((e) => ({ amount_home: e.amount_home, payer_id: methods[e.payment_method_id].owner_person_id, beneficiary_ids: e.beneficiary_ids })),
    ['yo', 'ana'], 1,
  );
  assert.equal(s.pending, 0);
});

test('respaldo: la moneda del gasto viaja en el archivo y se restaura; una copia vieja sin moneda sigue valiendo', async () => {
  const a = await setup();
  await a.call('POST', '/api/expenses', a.exp('usd', '2026-11-10', 500, { currency: 'USD' }));
  const dump = (await a.call('GET', '/api/backup')).body;
  assert.equal(dump.expenses[0].currency, 'USD');

  const b = await setup();
  const out = await b.call('POST', '/api/restore', JSON.parse(JSON.stringify(dump)));
  assert.equal(out.status, 200);
  assert.equal((await b.state()).expenses.find((e) => e.id === 'usd').currency, 'USD');

  const old = JSON.parse(JSON.stringify(dump));
  old.expenses.forEach((e) => { delete e.currency; e.id = 'viejo'; });
  old.expense_beneficiaries.forEach((l) => { l.expense_id = 'viejo'; });
  const c = await setup();
  assert.equal((await c.call('POST', '/api/restore', old)).status, 200);
  assert.equal((await c.state()).expenses.find((e) => e.id === 'viejo').currency, 'BRL'); // sin moneda = la del destino

  const bad = JSON.parse(JSON.stringify(dump));
  bad.expenses[0].currency = 'ZZZ';
  assert.equal((await (await setup()).call('POST', '/api/restore', bad)).status, 400);
});

test('"Actualizar tasas" revisa cada moneda con su par y deja en paz las de casa', async () => {
  const { call, exp, state } = await setup();
  await call('POST', '/api/expenses', exp('usd', '2026-11-10', 500, { currency: 'USD' }));
  await call('POST', '/api/expenses', exp('casa', '2026-11-10', 100000, { currency: 'COP' }));
  const real = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const base = String(url).match(/currencies\/([a-z]+)\.json/)?.[1];
    const rate = { usd: { cop: 4100 }, brl: { cop: 800 } }[base];
    if (!rate) return { ok: false, status: 404, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => ({ date: '2026-11-10', [base]: rate }) };
  };
  try {
    const dry = (await call('POST', '/api/rates/refresh', undefined, { dry: '1' })).body;
    assert.equal(dry.changed, 1);
    assert.equal(dry.unchanged, 1);
    await call('POST', '/api/rates/refresh');
  } finally { globalThis.fetch = real; }
  const byId = Object.fromEntries((await state()).expenses.map((e) => [e.id, e]));
  assert.equal(byId.usd.rate, 4100);
  assert.equal(byId.casa.rate, 1);
});

test('migración: una base sin la columna de moneda la recibe y sus gastos siguen en la moneda del destino', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { openFileDb } = await import('../src/db.mjs');
  const file = join(mkdtempSync(join(tmpdir(), 'bg-cur-')), 'sin-moneda.db');
  const old = new DatabaseSync(file);
  old.exec(`
    CREATE TABLE people (id TEXT PRIMARY KEY, name TEXT NOT NULL);
    CREATE TABLE trips (id TEXT PRIMARY KEY, name TEXT NOT NULL, dest_currency TEXT NOT NULL, home_currency TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE trip_people (trip_id TEXT NOT NULL, person_id TEXT NOT NULL, PRIMARY KEY (trip_id, person_id));
    CREATE TABLE payment_methods (id TEXT PRIMARY KEY, kind TEXT NOT NULL, name TEXT NOT NULL, last4 TEXT, card_type TEXT, owner_person_id TEXT NOT NULL, color TEXT, network TEXT);
    CREATE TABLE rates (pair TEXT NOT NULL, date TEXT NOT NULL, rate REAL NOT NULL, source TEXT, fetched_at TEXT, PRIMARY KEY (pair, date));
    CREATE TABLE expenses (id TEXT PRIMARY KEY, date TEXT NOT NULL, amount_cents INTEGER NOT NULL, description TEXT NOT NULL DEFAULT '',
      payment_method_id TEXT NOT NULL, rate REAL, rate_date TEXT, rate_source TEXT, created_at TEXT NOT NULL, trip_id TEXT,
      lat REAL, lng REAL, place TEXT, amount_approx INTEGER NOT NULL DEFAULT 0, sort_order INTEGER, pay_pending INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE expense_beneficiaries (expense_id TEXT NOT NULL, person_id TEXT NOT NULL, PRIMARY KEY (expense_id, person_id));
    INSERT INTO people VALUES ('yo','Yo');
    INSERT INTO trips VALUES ('trip-1','Viaje 1','BRL','COP','2026-11-01T00:00:00Z');
    INSERT INTO trip_people VALUES ('trip-1','yo');
    INSERT INTO payment_methods VALUES ('m','cash','Efectivo',NULL,NULL,'yo',NULL,NULL);
    INSERT INTO rates VALUES ('BRL-COP','2026-11-14',800,NULL,NULL);
    INSERT INTO expenses (id, date, amount_cents, payment_method_id, rate, rate_date, created_at, trip_id)
      VALUES ('e','2026-11-14',5000,'m',800,'2026-11-14','2026-11-14T00:00:00Z','trip-1');
    INSERT INTO expense_beneficiaries VALUES ('e','yo');
  `);
  old.close();
  for (let pass = 1; pass <= 2; pass += 1) { // idempotente
    const db = await openFileDb(file);
    assert.ok((await db.all('PRAGMA table_info(expenses)')).some((c) => c.name === 'currency'), `pasada ${pass}`);
    const e = (await handle({ method: 'GET', path: '/api/state', db })).body.expenses[0];
    assert.deepEqual([e.currency, e.rate, e.amount_home], ['BRL', 800, 4000000]);
  }
});

test('promedio y días: un gasto de casa antes de salir o al volver cuenta en el total pero no en el promedio', () => {
  const d = (date, home, currency, cents = home) => ({ date, amount_cents: cents, amount_home: home, currency });
  const list = [
    d('2026-11-01', 1000000, 'COP'), // vuelo comprado en Colombia, una semana antes
    d('2026-11-08', 200000, 'BRL', 250),
    d('2026-11-09', 400000, 'BRL', 500),
    d('2026-11-15', 300000, 'COP'), // al volver
  ];
  const s = summary(list, '2026-11-15', 'BRL');
  assert.equal(s.total, 1900000); // todo suma
  assert.equal(s.span, 8); // del 8 de nov al 15 (hoy), no desde el 1
  assert.equal(s.perDay, Math.round((200000 + 400000 + 300000) / 8)); // lo de antes del viaje no entra
  const days = byDay(list, { today: '2026-11-09', days: 30, dest: 'BRL' });
  assert.deepEqual(days.map((x) => x.date), ['2026-11-08', '2026-11-09']);
  assert.deepEqual(days.map((x) => x.dest), [250, 500]); // en la moneda del destino solo cuentan los gastos de esa moneda

  // Sin `dest` (o sin gastos en la moneda del destino) todo se comporta como antes.
  assert.equal(summary(list, '2026-11-15').span, 15);
  assert.equal(summary(list.filter((e) => e.currency === 'COP'), '2026-11-15', 'BRL').span, 15);
});

test('mapa: el total en la moneda del destino no mezcla monedas', () => {
  const at = (id, currency, cents) => ({ id, date: '2026-11-08', lat: 1, lng: 1, amount_cents: cents, amount_home: cents, currency });
  const { places } = routeFrom([at('a', 'BRL', 100), at('b', 'COP', 9000)], 3, 'BRL');
  assert.equal(places[0].total_dest, 100);
  assert.equal(places[0].total_home, 9100);
});

test('formato en la moneda de cada gasto y montos en pesos con puntos de miles', () => {
  setCurrencies('BRL', 'COP');
  assert.match(fmtMoney('USD', 2500), /25/);
  assert.match(fmtMoney('USD', 2500), /US\$|\$|USD/);
  assert.equal(fmtMoney('COP', 5000000).replace(/\s/g, ' '), new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 0 }).format(50000).replace(/\s/g, ' '));
  assert.equal(parseAmount('50.000'), 5000000);
  assert.equal(parseAmount('1.234.567'), 123456700);
  assert.equal(parseAmount('12.50'), 1250); // un punto con 2 decimales sigue siendo decimal
  assert.equal(parseAmount('1.234,56'), 123456);
});
