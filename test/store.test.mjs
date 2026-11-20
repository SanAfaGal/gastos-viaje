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
let forzar = null; // (método, ruta) => estado: el servidor responde ese error sin procesar la petición
let enviados = []; // gastos que el servidor guardó (PUT aceptados)
globalThis.fetch = async (url, opts = {}) => {
  if (!online) throw new TypeError('network down');
  calls += 1;
  const u = new URL(url, 'http://x');
  const status = forzar?.(opts.method ?? 'GET', u.pathname);
  if (status) return { ok: false, status, json: async () => (status === 429 ? { error: 'Demasiados intentos. Espera 15 minutos.' } : null) };
  if (opts.method === 'PUT' && u.pathname.startsWith('/api/expenses/')) enviados.push(u.pathname);
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
  assert.equal(rows[0].rate, 600); // el monto en pesos ya no se guarda: sale de la tasa (10 BRL * 600 = 6.000 COP)
  assert.equal((await handle({ method: 'GET', path: '/api/state', db })).body.expenses[0].amount_home, 600000);
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

test('orden manual sin internet: se ve al instante, un reordenamiento nuevo reemplaza al anterior y se envía al volver', async () => {
  store.setActiveTrip('trip-1');
  const base = { date: '2026-11-14', description: '', payment_method_id: 'cash', beneficiary_ids: ['yo'], amount_cents: 1000 };
  for (const id of ['o1', 'o2', 'o3']) await store.saveExpense({ ...base, id, created_at: `2026-11-14T10:0${id.slice(1)}:00Z` });
  const day = () => store.getState().expenses.filter((e) => ['o1', 'o2', 'o3'].includes(e.id)).map((e) => e.id);
  assert.deepEqual(day(), ['o1', 'o2', 'o3']); // cronológico

  online = false;
  const pend = store.pendingCount();
  await store.saveOrder(['o3', 'o1', 'o2'], 'trip-1:2026-11-14');
  assert.deepEqual(day(), ['o3', 'o1', 'o2']);
  await store.saveOrder(['o2', 'o3', 'o1'], 'trip-1:2026-11-14'); // reemplaza al anterior
  assert.equal(store.pendingCount(), pend + 1);
  assert.deepEqual(day(), ['o2', 'o3', 'o1']);

  // Editar un gasto sin enviar no lo saca de su lugar.
  await store.saveExpense({ ...base, id: 'o3', description: 'editado', created_at: '2026-11-14T10:03:00Z' });
  assert.deepEqual(day(), ['o2', 'o3', 'o1']);

  online = true;
  await store.flush();
  assert.equal(store.pendingCount(), 0);
  const rows = await db.all("SELECT id, sort_order FROM expenses WHERE id IN ('o1','o2','o3') ORDER BY sort_order");
  assert.deepEqual(rows.map((r) => r.id), ['o2', 'o3', 'o1']);
  assert.deepEqual(day(), ['o2', 'o3', 'o1']); // igual con lo que ya está en el servidor
});

test('refresh solo avisa a la pantalla cuando lo recibido cambió algo', async () => {
  await store.refresh(); // deja la copia local al día
  let avisos = 0;
  const oyente = () => { avisos += 1; };
  store.listeners.add(oyente);
  try {
    await store.refresh();
    assert.equal(avisos, 0, 'el mismo estado no redibuja');

    await store.savePerson({ id: 'otra', name: 'Otra persona' }); // mutate() llama a refresh() con datos nuevos
    assert.ok(avisos > 0, 'un cambio sí avisa');

    const antes = avisos;
    online = false;
    await store.refresh();
    online = true;
    await store.refresh(); // vuelve la conexión sin cambios de datos: avisa una vez para mostrar el estado de red
    assert.equal(avisos, antes + 2, 'caer y volver la conexión avisa dos veces (red caída, red recuperada)');
  } finally {
    store.listeners.delete(oyente);
  }
});

// Error del servidor (5xx, página de error de Netlify) o límite de intentos (429): el gasto no es inválido, solo no
// se pudo guardar ahora. Se queda en la cola y se envía una sola vez cuando el servidor vuelve.
for (const status of [500, 502, 429]) {
  test(`un ${status} al enviar la cola no descarta el gasto: se envía una sola vez después`, async () => {
    store.setActiveTrip('trip-1');
    const id = `srv-${status}`;
    online = false;
    await store.saveExpense({ id, date: '2026-11-14', amount_cents: 700, description: '', payment_method_id: 'cash', beneficiary_ids: ['yo'] });
    online = true;
    const pend = store.pendingCount();
    enviados = [];
    forzar = (method, ruta) => (method === 'PUT' && ruta === `/api/expenses/${id}` ? status : 0);
    const r = await store.flush();
    assert.equal(r.sent, 0);
    assert.deepEqual(r.errors, []);
    assert.equal(store.pendingCount(), pend, 'el gasto sigue en la cola');
    assert.ok(JSON.parse(localStorage.getItem('bg_queue')).some((o) => o.id === id), 'y en la copia guardada');
    assert.ok(store.getState().expenses.find((e) => e.id === id)?.pending);

    forzar = null;
    await store.flush();
    await store.flush();
    assert.equal(store.pendingCount(), 0);
    assert.deepEqual(enviados, [`/api/expenses/${id}`]);
    assert.equal((await db.all('SELECT id FROM expenses WHERE id = ?', [id])).length, 1);
  });
}

test('un 400 al enviar la cola sí descarta el gasto (dato inválido) y avisa el error', async () => {
  store.setActiveTrip('trip-1');
  online = false;
  await store.saveExpense({ id: 'malo', date: '2026-11-14', amount_cents: 700, description: '', payment_method_id: 'no-existe', beneficiary_ids: ['yo'] });
  online = true;
  const r = await store.flush();
  assert.deepEqual(r.errors, ['El medio de pago no existe']);
  assert.equal(store.pendingCount(), 0);
  assert.equal((await db.all("SELECT id FROM expenses WHERE id = 'malo'")).length, 0);
});
