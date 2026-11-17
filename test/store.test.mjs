// Cola sin internet del navegador (store.js) contra la API real en memoria.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openMemoryDb } from '../src/db.mjs';
import { handle } from '../src/handlers.mjs';

// Las pruebas no dependen del entorno: Netlify define APP_PASSCODE y TURSO_* al construir.
delete process.env.APP_PASSCODE;
delete process.env.TURSO_DATABASE_URL;
delete process.env.TURSO_AUTH_TOKEN;

const mem = new Map();
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => mem.set(k, String(v)),
  removeItem: (k) => mem.delete(k),
};

const db = await openMemoryDb();
let online = true;
let calls = 0;
globalThis.fetch = async (url, opts = {}) => {
  if (!online) throw new TypeError('network down');
  calls += 1;
  const u = new URL(url, 'http://x');
  const out = await handle({
    method: opts.method ?? 'GET',
    path: u.pathname,
    query: u.searchParams,
    body: opts.body ? JSON.parse(opts.body) : null,
    passcode: opts.headers?.['x-passcode'],
    db,
  });
  return { ok: out.status < 400, status: out.status, json: async () => out.body };
};

const store = await import('../public/js/store.js');

test('gasto sin internet queda en cola, se ve y se envía una sola vez al volver', async () => {
  await db.run('INSERT INTO rates (pair, date, rate) VALUES (?, ?, ?)', ['BRL-COP', '2026-11-14', 600]);
  await store.savePerson({ id: 'yo', name: 'Yo' });
  await store.saveMethod({ id: 'cash', kind: 'cash', name: 'Efectivo', owner_person_id: 'yo' });
  await store.refresh();

  online = false;
  const exp = { id: 'x1', date: '2026-11-14', amount_cents: 1000, description: 'Taxi', payment_method_id: 'cash', beneficiary_ids: ['yo'] };
  await store.saveExpense(exp);
  assert.equal(store.pendingCount(), 1);
  const seen = store.getState().expenses.find((e) => e.id === 'x1');
  assert.ok(seen.pending);
  assert.equal((await db.all('SELECT * FROM expenses')).length, 0);

  online = true;
  await store.flush();
  await store.flush(); // un segundo envío no debe duplicar
  assert.equal(store.pendingCount(), 0);
  const rows = await db.all('SELECT * FROM expenses');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].amount_home, 600000);
  assert.ok(calls > 0);
});

test('borrar sin internet también espera en cola', async () => {
  online = false;
  await store.deleteExpense('x1');
  assert.equal(store.getState().expenses.find((e) => e.id === 'x1'), undefined);
  online = true;
  await store.flush();
  assert.equal((await db.all('SELECT * FROM expenses')).length, 0);
});

test('cada gasto en cola se queda en el viaje donde se guardó, aunque se cambie de viaje antes de enviarlo', async () => {
  const mx = await store.saveTrip({ id: 'mx', name: 'Mexico', dest: 'MXN', home: 'EUR', people_ids: ['yo'] });
  assert.equal(mx.id, 'mx');
  await db.run('INSERT INTO rates (pair, date, rate) VALUES (?, ?, ?)', ['MXN-EUR', '2026-11-14', 0.05]);
  await store.refresh();
  store.setActiveTrip('mx');
  await store.fetchRate('2026-11-14'); // el celular aprende la tasa de México mientras hay internet

  const base = { date: '2026-11-14', description: '', payment_method_id: 'cash', beneficiary_ids: ['yo'] };
  online = false;
  store.setActiveTrip('trip-1');
  await store.saveExpense({ ...base, id: 'a', amount_cents: 1000 });
  store.setActiveTrip('mx');
  await store.saveExpense({ ...base, id: 'b', amount_cents: 2000 });
  assert.equal(store.pendingCount(), 2);

  // Cada viaje muestra solo lo suyo, convertido con sus propias monedas.
  let st = store.getState();
  assert.equal(st.trip.id, 'mx');
  assert.deepEqual(st.expenses.map((e) => [e.id, e.amount_home]), [['b', 100]]); // 20 MXN * 0.05 = 1 EUR
  assert.deepEqual(st.counts, { 'trip-1': 1, mx: 1 });
  store.setActiveTrip('trip-1');
  st = store.getState();
  assert.deepEqual(st.expenses.map((e) => [e.id, e.amount_home]), [['a', 600000]]); // 10 BRL * 600 = 6.000 COP
  assert.deepEqual(st.participants.map((p) => p.id), ['yo']);

  online = true;
  await store.flush();
  assert.equal(store.pendingCount(), 0);
  const rows = await db.all('SELECT id, trip_id FROM expenses ORDER BY id');
  assert.deepEqual(rows.map((r) => [r.id, r.trip_id]), [['a', 'trip-1'], ['b', 'mx']]);

  // Borrar el viaje activo hace volver al primero.
  store.setActiveTrip('mx');
  await store.deleteTrip('mx', true);
  assert.equal(store.activeTrip().id, 'trip-1');
});

test('ubicación y monto aproximado viajan en la cola y se ven antes de enviar', async () => {
  store.setActiveTrip('trip-1');
  online = false;
  await store.saveExpense({
    id: 'geo', date: '2026-11-14', amount_cents: 1500, description: 'Café', payment_method_id: 'cash',
    beneficiary_ids: ['yo'], lat: 4.60971, lng: -74.08175, place: 'Centro', amount_approx: true,
  });
  const seen = store.getState().expenses.find((e) => e.id === 'geo');
  assert.deepEqual([seen.lat, seen.lng, seen.amount_approx], [4.60971, -74.08175, true]);

  online = true;
  await store.flush();
  assert.equal(store.pendingCount(), 0);
  const [row] = await db.all('SELECT lat, lng, place, amount_approx FROM expenses WHERE id = ?', ['geo']);
  assert.deepEqual({ ...row }, { lat: 4.60971, lng: -74.08175, place: 'Centro', amount_approx: 1 });
});
