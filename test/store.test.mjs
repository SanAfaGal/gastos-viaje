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
