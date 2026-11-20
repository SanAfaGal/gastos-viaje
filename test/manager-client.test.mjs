// La administración en el navegador (store.js y pantallas): no guarda copia de datos, no pide tasas ni envía colas,
// tiene su propia pantalla y los Ajustes de un espacio normal ya no muestran la sección Espacios.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { openMemoryDb } from '../src/db.mjs';
import { handle } from '../src/handlers.mjs';

delete process.env.TURSO_DATABASE_URL;
delete process.env.TURSO_AUTH_TOKEN;

const mem = new Map();
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => mem.set(k, String(v)),
  removeItem: (k) => mem.delete(k),
};

let db;
let online = true;
let rutas = []; // "MÉTODO /ruta" de cada petición que salió del celular
globalThis.fetch = async (url, opts = {}) => {
  const u = new URL(url, 'http://x');
  // Nada de este archivo sale a internet (tasas, enlaces de mapas): solo las rutas del propio servidor.
  if (!online || !u.pathname.startsWith('/api/')) throw new TypeError('sin conexión');
  rutas.push(`${opts.method ?? 'GET'} ${u.pathname}`);
  const out = await handle({
    method: opts.method ?? 'GET',
    path: u.pathname,
    query: u.searchParams,
    body: opts.body ? JSON.parse(opts.body) : null,
    passcode: opts.headers?.['x-passcode'],
    db,
  });
  return { ok: out.status < 400, status: out.status, headers: new Map(), json: async () => out.body };
};

const ADMIN = 'clave-larga-de-la-administracion';
const APP = 'clave-de-siempre-del-dueño'; // siembra el código de Principal en la primera entrada
const DATOS = ['bg_state2', 'bg_queue', 'bg_rates2', 'bg_hist', 'bg_trip'];
const gasto = { id: 'x1', date: '2026-11-14', amount_cents: 1000, description: 'Taxi', payment_method_id: 'cash', beneficiary_ids: ['yo'] };
const mensaje = (n) => `Hay ${n} gasto(s) sin enviar del espacio anterior. Si entras con este código se descartarán. ¿Continuar?`;

// Ejecuta `fn` con ADMIN_PASSCODE y APP_PASSCODE definidos y los deja como estaban.
async function conEntorno(fn) {
  const antes = { ADMIN_PASSCODE: process.env.ADMIN_PASSCODE, APP_PASSCODE: process.env.APP_PASSCODE };
  process.env.ADMIN_PASSCODE = ADMIN;
  process.env.APP_PASSCODE = APP;
  try {
    await fn();
  } finally {
    for (const [k, v] of Object.entries(antes)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

// Base nueva, almacenamiento como lo deja `antes` y módulo nuevo.
async function arrancar(caso, antes = () => {}) {
  db = await openMemoryDb();
  await db.run('INSERT INTO rates (pair, date, rate) VALUES (?, ?, ?)', ['BRL-COP', '2026-11-14', 600]);
  mem.clear();
  online = true;
  rutas = [];
  antes();
  return import(`../public/js/store.js?manager=${caso}`);
}

// Entra a Principal y deja datos (persona, medio de pago, tasa, historial) y un gasto sin enviar.
async function principalConCola(store) {
  assert.deepEqual(await store.trySwitchSpace(APP, () => assert.fail('no debe preguntar')), { switched: true });
  await store.refresh();
  await store.savePerson({ id: 'yo', name: 'Yo' });
  await store.saveMethod({ id: 'cash', kind: 'cash', name: 'Efectivo', owner_person_id: 'yo' });
  await store.fetchRate('2026-11-14');
  await store.fetchHistory(30);
  online = false;
  await store.saveExpense(gasto);
  online = true;
  assert.equal(store.pendingCount(), 1);
  assert.equal(store.isManager(), false);
}

const enviosDeDatos = () => rutas.filter((r) => /\/api\/(rate|expenses|order|rates)/.test(r));

test('syncNow de la administración no pide tasas ni envía cola', () => conEntorno(async () => {
  // Recarga con el código de la administración guardado y una cola que quedó de antes: antes del primer estado
  // ya se sabe que el espacio guardado es la administración.
  const store = await arrancar(1, () => {
    mem.set('bg_pass', ADMIN);
    mem.set('bg_space', 'manager');
    mem.set('bg_queue', JSON.stringify([{ op: 'save', id: 'v1', expense: { ...gasto, id: 'v1' } }]));
  });
  assert.equal(store.isManager(), false, 'antes del primer estado no se sabe');
  await store.syncNow();
  assert.equal(store.isManager(), true);
  assert.deepEqual(enviosDeDatos(), []);
  assert.deepEqual(rutas, ['GET /api/state']);
  assert.equal(store.pendingCount(), 1, 'la cola queda intacta hasta que se cambie de espacio');

  // Ya con el estado de la administración: un gasto que llegue a la cola tampoco sale.
  online = false;
  await store.saveExpense({ ...gasto, id: 'v2' });
  online = true;
  rutas = [];
  await store.syncNow();
  await store.syncNow();
  assert.deepEqual(enviosDeDatos(), []);
  assert.equal(store.pendingCount(), 2);
  assert.equal(await db.all('SELECT id FROM expenses').then((r) => r.length), 0);
}));

test('la administración no guarda copia local de viajes, personas ni gastos', () => conEntorno(async () => {
  const store = await arrancar(2);
  assert.deepEqual(await store.trySwitchSpace(ADMIN, () => assert.fail('no debe preguntar')), { switched: true });
  await store.refresh();
  await store.syncNow();
  assert.equal(store.isManager(), true);
  assert.equal(store.getState().space.is_manager, true);
  for (const k of DATOS) assert.equal(mem.has(k), false, `no se guarda ${k}`);
  assert.equal(store.pendingCount(), 0);
}));

test('entrar como administración desde un celular con datos de Principal pide confirmar si hay cola y la descarta al confirmar', () => conEntorno(async () => {
  const store = await arrancar(3);
  await principalConCola(store);
  assert.ok(mem.has('bg_state2'));

  const textos = [];
  const cancelado = await store.trySwitchSpace(ADMIN, (t) => { textos.push(t); return false; });
  assert.deepEqual(cancelado, { switched: false, cancelled: true });
  assert.deepEqual(textos, [mensaje(1)]);
  assert.equal(mem.get('bg_pass'), APP);
  assert.equal(store.pendingCount(), 1);
  assert.equal(store.isManager(), false);

  rutas = [];
  assert.deepEqual(await store.trySwitchSpace(ADMIN, (t) => { textos.push(t); return true; }), { switched: true });
  await store.refresh();
  await store.flush();
  await store.syncNow();
  assert.deepEqual(textos, [mensaje(1), mensaje(1)]);
  assert.equal(store.isManager(), true);
  assert.equal(store.pendingCount(), 0);
  assert.equal(mem.get('bg_space'), 'manager');
  for (const k of DATOS) {
    if (k === 'bg_queue') assert.deepEqual(JSON.parse(mem.get(k) ?? '[]'), []);
    else assert.equal(mem.has(k), false, `se descartó ${k}`);
  }
  assert.deepEqual(enviosDeDatos(), []);
  assert.equal(await db.all('SELECT id FROM expenses').then((r) => r.length), 0, 'lo descartado no llegó a ningún espacio');
}));

test('volver de la administración al espacio Principal no conserva nada de la administración', () => conEntorno(async () => {
  const store = await arrancar(4);
  assert.deepEqual(await store.trySwitchSpace(ADMIN, () => true), { switched: true });
  await store.refresh();
  assert.equal(store.isManager(), true);

  assert.deepEqual(await store.trySwitchSpace(APP, () => assert.fail('la administración no tiene cola')), { switched: true });
  assert.equal(store.isManager(), false, 'apenas cambia el código deja de ser la administración');
  await store.refresh();
  const s = store.getState();
  assert.equal(store.isManager(), false);
  assert.equal(s.space.id, 'space-admin');
  assert.equal(s.space.is_manager, false);
  assert.equal(s.trip.id, 'trip-1');
  assert.equal(mem.get('bg_space'), 'space-admin');
  const copia = JSON.parse(mem.get('bg_state2'));
  assert.equal(copia.space.id, 'space-admin');
  assert.ok(!mem.get('bg_state2').includes('Administración'));
}));

// ---------- código fuente de las pantallas ----------

const root = path.resolve(import.meta.dirname, '..', 'public');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');

test('router.js muestra viewManage para la administración en cualquier ruta y oculta barra, selector de viaje y ajustes', () => {
  const router = read('js/router.js');
  const body = router.slice(router.indexOf('export function render()'));
  const manager = body.indexOf('store.isManager()');
  assert.ok(manager > 0, 'render pregunta si es la administración');
  // La rama de la administración va antes de mirar la ruta o el viaje activo.
  assert.ok(manager < body.indexOf('currentRoute()'));
  assert.ok(manager < body.indexOf('store.activeTrip()'));
  assert.ok(router.includes("classList.toggle('manager'"));
  assert.match(router, /viewManage\(\)/);
  assert.match(router, /Administración/);
  assert.ok(!/r\.tab === 'ajustes'[^\n]*ensureSpaces/.test(router), 'Ajustes ya no carga la lista de espacios');
  const css = read('css/app.css');
  assert.match(css, /\.manager \.tabbar\s*\{\s*display:\s*none/);
  assert.match(css, /\.manager #trip-btn\s*\{\s*display:\s*none/);
  const spaces = read('js/view-spaces.js');
  assert.match(spaces, /export function viewManage\(\)/);
  assert.match(spaces, /data-action="logout"/);
  assert.match(spaces, /store\.isManager\(\)/);
  assert.match(read('sw.js'), /const CACHE = 'gastos-viaje-v115'/);
});

test('view-settings.js ya no incluye la sección Espacios', () => {
  const settings = read('js/view-settings.js');
  assert.ok(!settings.includes('viewSpaces'));
  assert.ok(!settings.includes('view-spaces.js'));
});
