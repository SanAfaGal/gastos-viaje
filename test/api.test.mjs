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

test('ajustes: elegir país y moneda; se bloquea cuando ya hay gastos', async () => {
  const db = await openMemoryDb();
  const call = (method, path, body) => handle({ method, path, body, db });
  let st = (await call('GET', '/api/state')).body;
  assert.deepEqual(st.settings, { dest: 'BRL', home: 'COP' });

  assert.equal((await call('PUT', '/api/settings', { dest: 'USD', home: 'USD' })).status, 400);
  assert.equal((await call('PUT', '/api/settings', { dest: 'XXX', home: 'COP' })).status, 400);
  assert.equal((await call('PUT', '/api/settings', { dest: 'MXN', home: 'EUR' })).status, 200);
  st = (await call('GET', '/api/state')).body;
  assert.deepEqual(st.settings, { dest: 'MXN', home: 'EUR' });

  await call('POST', '/api/people', { id: 'yo', name: 'Yo' });
  await call('POST', '/api/payment-methods', { id: 'c', kind: 'cash', name: 'Efectivo', owner_person_id: 'yo' });
  await call('POST', '/api/expenses', {
    id: 'g1', date: '2026-11-14', amount_cents: 10000, payment_method_id: 'c', beneficiary_ids: ['yo'], rate_manual: 0.05,
  });
  assert.equal((await call('GET', '/api/state')).body.expenses[0].amount_home, 500); // 100 MXN * 0.05 = 5 EUR
  assert.equal((await call('PUT', '/api/settings', { dest: 'BRL', home: 'COP' })).status, 409);
  assert.equal((await call('PUT', '/api/settings', { dest: 'MXN', home: 'EUR' })).status, 200); // mismas monedas: ok
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
  assert.deepEqual(st.settings, { dest: 'BRL', home: 'COP' });
  assert.equal(st.expenses[0].amount_cents, 5000);
  assert.equal(st.expenses[0].amount_home, 2933500); // 29.335 pesos en centésimas
  assert.equal(st.expenses[0].rate, 586.7);
  // Las columnas nuevas de los medios de pago se agregan sin perder los datos viejos.
  assert.deepEqual(
    { name: st.payment_methods[0].name, color: st.payment_methods[0].color, network: st.payment_methods[0].network },
    { name: 'Efectivo', color: null, network: null },
  );
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
