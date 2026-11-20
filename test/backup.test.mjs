import test from 'node:test';
import assert from 'node:assert/strict';
import { openMemoryDb } from '../src/db.mjs';
import { handle } from '../src/handlers.mjs';
import { _resetFailures } from '../src/rates.mjs';
import { todayStr, toHome } from '../public/js/money.mjs';
import { compareExpenses } from '../public/js/order.mjs';

// Las pruebas no dependen del entorno: Netlify define APP_PASSCODE y TURSO_* al construir.
delete process.env.APP_PASSCODE;
delete process.env.ADMIN_PASSCODE;
delete process.env.TURSO_DATABASE_URL;
delete process.env.TURSO_AUTH_TOKEN;

const addDays = (d, n) => {
  const t = new Date(`${d}T12:00:00Z`);
  t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
};

// Fuente simulada (BRL a COP) por día: table = { '2026-11-14': 587 }; la clave 'latest' es la tasa de hoy.
const withSource = async (table, fn) => {
  const real = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = String(url);
    const version = u.match(/currency-api@([^/]+)\/v1/)?.[1] ?? u.match(/\/\/([^.]+)\.currency-api/)?.[1];
    const rate = table[version];
    if (!version || rate == null) return { ok: false, status: 404, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => ({ date: version === 'latest' ? todayStr() : version, brl: { cop: rate } }) };
  };
  try { return await fn(); } finally { globalThis.fetch = real; }
};

const caller = (db) => (method, path, body, query = {}) => handle({ method, path, body, query: new URLSearchParams(query), db });

test('tasa definitiva: el valor provisional de un día cerrado se corrige solo y luego no se vuelve a tocar', async () => {
  _resetFailures();
  const db = await openMemoryDb();
  const call = caller(db);
  await call('POST', '/api/people', { id: 'yo', name: 'Yo' });
  await call('POST', '/api/payment-methods', { id: 'efe', kind: 'cash', name: 'Efectivo', owner_person_id: 'yo' });
  const today = todayStr();
  const yesterday = addDays(today, -1);
  const base = { amount_cents: 10000, description: '', payment_method_id: 'efe', beneficiary_ids: ['yo'] };
  const rateOf = async (id) => {
    const r = (await db.all('SELECT rate, amount_cents FROM expenses WHERE id = ?', [id]))[0];
    return { rate: r.rate, amount_home: toHome(r.amount_cents, r.rate, 0) }; // el monto en pesos se calcula, no se guarda
  };

  // Un gasto de hoy usa la tasa de la fuente; la de hoy nunca queda en la tabla rates (solo se guardan días cerrados).
  await withSource({ latest: 585 }, () => call('POST', '/api/expenses', { ...base, id: 'hoy', date: today }));
  assert.equal((await rateOf('hoy')).rate, 585);
  assert.equal((await db.all('SELECT * FROM rates WHERE date = ?', [today])).length, 0);

  // Ayer quedó guardado con el valor provisional (585) y la tabla rates no tiene ese día.
  await db.run(
    `INSERT INTO expenses (id, date, amount_cents, description, payment_method_id, rate, rate_date, created_at, trip_id)
       VALUES ('ayer', ?, 10000, '', 'efe', 585, ?, ?, 'trip-1')`,
    [yesterday, yesterday, new Date().toISOString()],
  );
  await db.run('INSERT INTO expense_beneficiaries VALUES (?, ?)', ['ayer', 'yo']);

  // Al pedir el estado se cambia por la tasa del día cerrado, que queda guardada en rates.
  await withSource({ [yesterday]: 573.33 }, () => call('GET', '/api/state'));
  assert.deepEqual({ ...(await rateOf('ayer')) }, { rate: 573.33, amount_home: 5733300 });
  assert.equal((await db.all('SELECT rate FROM rates WHERE date = ?', [yesterday]))[0].rate, 573.33);

  // Ya coincide con rates: no sale a internet ni cambia aunque la fuente diga otra cosa.
  const real = globalThis.fetch;
  globalThis.fetch = async () => { throw new TypeError('no debería consultar la fuente'); };
  try { await call('GET', '/api/state'); } finally { globalThis.fetch = real; }
  await withSource({ [yesterday]: 999 }, () => call('GET', '/api/state'));
  assert.equal((await rateOf('ayer')).rate, 573.33);
  // El de hoy sigue intacto: todavía no cierra el día.
  assert.equal((await rateOf('hoy')).rate, 585);

  // Un gasto guardado hoy para un día cerrado ya queda igual a rates y no se vuelve a revisar.
  await withSource({ [yesterday]: 573.33 }, () => call('POST', '/api/expenses', { ...base, id: 'otro', date: yesterday }));
  globalThis.fetch = async () => { throw new TypeError('no debería consultar la fuente'); };
  try { await call('GET', '/api/state'); } finally { globalThis.fetch = real; }
  assert.equal((await rateOf('otro')).rate, 573.33);
});

test('tasa definitiva: sin internet no se cambia una tasa exacta por una más vieja', async () => {
  _resetFailures();
  const db = await openMemoryDb();
  const call = caller(db);
  await call('POST', '/api/people', { id: 'yo', name: 'Yo' });
  await call('POST', '/api/payment-methods', { id: 'efe', kind: 'cash', name: 'Efectivo', owner_person_id: 'yo' });
  const day = addDays(todayStr(), -2);
  await db.run('INSERT INTO rates (pair, date, rate) VALUES (?, ?, ?)', ['BRL-COP', addDays(day, -5), 500]); // una tasa vieja que serviría de respaldo
  await db.run(
    `INSERT INTO expenses (id, date, amount_cents, description, payment_method_id, rate, rate_date, created_at, trip_id)
       VALUES ('x', ?, 10000, '', 'efe', 585, ?, ?, 'trip-1')`,
    [day, day, new Date().toISOString()],
  );
  await db.run('INSERT INTO expense_beneficiaries VALUES (?, ?)', ['x', 'yo']);
  const real = globalThis.fetch;
  globalThis.fetch = async () => { throw new TypeError('sin red'); };
  try { await call('GET', '/api/state'); } finally { globalThis.fetch = real; }
  const x = (await db.all('SELECT rate, rate_date FROM expenses WHERE id = ?', ['x']))[0];
  assert.deepEqual({ ...x }, { rate: 585, rate_date: day });
});

test('deshacer un borrado: el gasto vuelve con su hora de creación y su lugar en el día', async () => {
  _resetFailures();
  const db = await openMemoryDb();
  const call = caller(db);
  await db.run('INSERT INTO rates (pair, date, rate) VALUES (?, ?, ?)', ['BRL-COP', '2026-11-14', 600]);
  await call('POST', '/api/people', { id: 'yo', name: 'Yo' });
  await call('POST', '/api/payment-methods', { id: 'efe', kind: 'cash', name: 'Efectivo', owner_person_id: 'yo' });
  const base = { date: '2026-11-14', amount_cents: 1000, payment_method_id: 'efe', beneficiary_ids: ['yo'] };
  for (const id of ['a', 'b', 'c']) await call('POST', '/api/expenses', { ...base, id, description: id });
  await call('POST', '/api/order', { ids: ['a', 'b', 'c'] });
  const before = { ...(await db.all('SELECT created_at, sort_order FROM expenses WHERE id = ?', ['b']))[0] };

  await call('DELETE', '/api/expenses/b');
  assert.equal((await db.all('SELECT id FROM expenses WHERE id = ?', ['b'])).length, 0);
  assert.equal((await call('POST', '/api/expenses', { ...base, id: 'b', description: 'b', ...before })).status, 201);
  assert.deepEqual({ ...(await db.all('SELECT created_at, sort_order FROM expenses WHERE id = ?', ['b']))[0] }, before);
  const order = (await call('GET', '/api/state')).body.expenses.filter((e) => e.date === '2026-11-14').sort(compareExpenses).map((e) => e.id);
  assert.deepEqual(order, ['a', 'b', 'c']);

  // Valores raros (fecha inválida, futura lejana, orden negativo o decimal) se ignoran en vez de fallar.
  await call('POST', '/api/expenses', { ...base, id: 'x', created_at: 'no es fecha', sort_order: -3 });
  await call('POST', '/api/expenses', { ...base, id: 'y', created_at: '2999-01-01T00:00:00.000Z', sort_order: 1.5 });
  for (const id of ['x', 'y']) {
    const r = (await db.all('SELECT created_at, sort_order FROM expenses WHERE id = ?', [id]))[0];
    assert.ok(Date.parse(r.created_at) < Date.now() + 5000, id);
    assert.equal(r.sort_order, null, id);
  }
});

// Base con datos para el respaldo: dos personas, dos viajes, dos medios, tres gastos (uno con medio por definir) y un abono.
async function seedBackupDb() {
  const db = await openMemoryDb();
  const call = caller(db);
  for (const d of ['2026-11-10', '2026-11-11']) await db.run('INSERT INTO rates (pair, date, rate) VALUES (?, ?, ?)', ['BRL-COP', d, 600]);
  await call('POST', '/api/people', { id: 'ana', name: 'Ana' });
  await call('POST', '/api/people', { id: 'leo', name: 'Leo' });
  await call('POST', '/api/payment-methods', { id: 'tar', kind: 'card', name: 'Nu', last4: '1234', card_type: 'credit', network: 'visa', color: '#8a05be', owner_person_id: 'ana' });
  await call('POST', '/api/payment-methods', { id: 'efe', kind: 'cash', name: 'Efectivo', owner_person_id: 'leo' });
  const base = { amount_cents: 2500, payment_method_id: 'tar', beneficiary_ids: ['ana', 'leo'] };
  await call('POST', '/api/expenses', { ...base, id: 'e1', date: '2026-11-10', description: 'Cena', lat: -8.05, lng: -34.9, place: 'Recife' });
  await call('POST', '/api/expenses', { ...base, id: 'e2', date: '2026-11-11', description: 'Taxi', payment_method_id: 'efe', amount_approx: true });
  await call('POST', '/api/expenses', { ...base, id: 'e3', date: '2026-11-11', description: 'Pendiente', payment_method_id: null });
  await call('POST', '/api/payments', { id: 'p1', date: '2026-11-11', amount_cents: 10000, from_person_id: 'leo', to_person_id: 'ana', note: 'Pix' });
  await call('POST', '/api/trips', { id: 'trip-2', name: 'México', dest: 'MXN', home: 'COP', people_ids: ['ana'] });
  return { db, call };
}

test('respaldo: copia cruda de las tablas, con los gastos por definir', async () => {
  const { call } = await seedBackupDb();
  const res = await call('GET', '/api/backup');
  assert.equal(res.status, 200);
  const b = res.body;
  assert.deepEqual([b.app, b.version], ['gastos-viaje', 1]);
  assert.deepEqual([b.people.length, b.trips.length, b.payment_methods.length, b.expenses.length, b.expense_beneficiaries.length, b.payments.length], [2, 2, 2, 3, 6, 1]);
  assert.equal(b.expenses.find((e) => e.id === 'e3').pay_pending, 1); // el relleno interno viaja en el respaldo
});

test('restaurar: en una base vacía recupera todo; con dry solo cuenta y no escribe', async () => {
  const { call: from } = await seedBackupDb();
  const backup = (await from('GET', '/api/backup')).body;
  const db = await openMemoryDb();
  const call = caller(db);
  await db.run('DELETE FROM trip_people');
  await db.run('DELETE FROM trips'); // arranque vacío: sin el "Viaje 1" que crea la migración

  const dry = (await call('POST', '/api/restore', backup, { dry: '1' })).body;
  assert.deepEqual(dry.add, { trips: 2, people: 2, payment_methods: 2, expenses: 3, payments: 1 });
  assert.equal((await db.all('SELECT * FROM expenses')).length, 0);

  assert.equal((await call('POST', '/api/restore', backup)).status, 200);
  const a = (await from('GET', '/api/state')).body;
  const b = (await call('GET', '/api/state')).body;
  const brief = (st) => ({
    trips: st.trips.map((t) => [t.id, t.dest, t.home, [...t.people_ids].sort()]).sort(),
    expenses: st.expenses.map((e) => [e.id, e.amount_cents, e.payment_method_id, e.amount_approx, e.place, [...e.beneficiary_ids].sort()]).sort(),
    methods: st.payment_methods.map((m) => [m.id, m.name, m.last4, m.color]).sort(),
    payments: st.payments.map((x) => [x.id, x.from_person_id, x.to_person_id, x.amount_cents, x.currency, x.note]).sort(),
  });
  assert.deepEqual(brief(b), brief(a));
  assert.equal(b.expenses.find((e) => e.id === 'e3').payment_method_id, null); // sigue "por definir"

  // Repetirlo no duplica ni cambia nada.
  const again = (await call('POST', '/api/restore', backup)).body;
  assert.deepEqual(again.add, { trips: 0, people: 0, payment_methods: 0, expenses: 0, payments: 0 });
  assert.equal((await db.all('SELECT * FROM expenses')).length, 3);
  assert.equal((await db.all('SELECT * FROM payments')).length, 1);
});

test('restaurar: un respaldo anterior, sin la sección de abonos, sigue funcionando', async () => {
  const { call: from } = await seedBackupDb();
  const backup = (await from('GET', '/api/backup')).body;
  delete backup.payments;
  const db = await openMemoryDb();
  const call = caller(db);
  await db.run('DELETE FROM trip_people');
  await db.run('DELETE FROM trips');
  const res = await call('POST', '/api/restore', backup);
  assert.equal(res.status, 200);
  assert.equal(res.body.add.payments, 0);
  assert.equal((await db.all('SELECT * FROM expenses')).length, 3);
  // Una sección de abonos mal formada sí se rechaza.
  assert.equal((await call('POST', '/api/restore', { ...backup, payments: 'no' })).status, 400);
});

test('restaurar: solo agrega lo que falta y nunca pisa lo que ya existe', async () => {
  const { db, call } = await seedBackupDb();
  const backup = (await call('GET', '/api/backup')).body;
  // Después del respaldo: se edita un gasto, se borra otro y se agrega uno nuevo.
  await call('POST', '/api/expenses', { id: 'e1', date: '2026-11-10', amount_cents: 9999, description: 'Editado', payment_method_id: 'tar', beneficiary_ids: ['ana'] });
  await call('DELETE', '/api/expenses/e2');
  await call('POST', '/api/expenses', { id: 'nuevo', date: '2026-11-10', amount_cents: 100, payment_method_id: 'tar', beneficiary_ids: ['ana'] });

  const out = (await call('POST', '/api/restore', backup)).body;
  assert.deepEqual(out.add, { trips: 0, people: 0, payment_methods: 0, expenses: 1, payments: 0 }); // solo e2, el borrado
  assert.deepEqual(out.skip, { people: 2, trips: 2, payment_methods: 2, expenses: 2, payments: 1 });
  const rows = Object.fromEntries((await db.all('SELECT id, description, amount_cents FROM expenses')).map((r) => [r.id, r]));
  assert.equal(rows.e1.description, 'Editado'); // lo editado no se pisa
  assert.equal(rows.e1.amount_cents, 9999);
  assert.ok(rows.e2 && rows.nuevo && rows.e3); // el borrado volvió y lo nuevo sigue
  assert.equal((await db.all('SELECT COUNT(*) AS n FROM expense_beneficiaries WHERE expense_id = ?', ['e2']))[0].n, 2);
});

test('restaurar: un archivo inválido se rechaza sin escribir nada', async () => {
  const { call: from } = await seedBackupDb();
  const good = (await from('GET', '/api/backup')).body;
  const db = await openMemoryDb();
  const call = caller(db);
  const counts = async () => ({ ...(await db.all('SELECT (SELECT COUNT(*) FROM people) AS p, (SELECT COUNT(*) FROM expenses) AS e'))[0] });
  const mutate = (fn) => { const c = structuredClone(good); fn(c); return c; };

  const cases = {
    'no es un respaldo': { hola: 1 },
    'otra versión': mutate((c) => { c.version = 2; }),
    'sin sección': mutate((c) => { delete c.expenses; }),
    'sección que no es lista': mutate((c) => { c.people = {}; }),
    'gasto con monto negativo': mutate((c) => { c.expenses[2].amount_cents = -5; }),
    'gasto con fecha inválida': mutate((c) => { c.expenses[0].date = '2026-13-45'; }),
    'gasto con medio inexistente': mutate((c) => { c.expenses[0].payment_method_id = 'fantasma'; }),
    'gasto sin personas': mutate((c) => { c.expense_beneficiaries = []; }),
    'persona de un gasto inexistente': mutate((c) => { c.expense_beneficiaries[0].person_id = 'fantasma'; }),
    'viaje con monedas iguales': mutate((c) => { const t = c.trips.find((x) => x.id === 'trip-2'); t.home_currency = t.dest_currency; }),
    'color inválido': mutate((c) => { c.payment_methods[0].color = 'rojo'; }),
    'ubicación a medias': mutate((c) => { c.expenses[0].lat = 10; c.expenses[0].lng = null; }),
    'demasiadas filas': mutate((c) => { c.people = Array.from({ length: 20001 }, (_, i) => ({ id: `p${i}`, name: 'x' })); }),
  };
  for (const [name, body] of Object.entries(cases)) {
    assert.equal((await call('POST', '/api/restore', body)).status, 400, name);
    assert.deepEqual(await counts(), { p: 0, e: 0 }, `${name}: no debe escribir nada`);
  }
  assert.equal((await call('POST', '/api/restore', null)).status, 400);
});
