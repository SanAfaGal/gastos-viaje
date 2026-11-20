// Un código guardado en el celular que pasa a ser el de la administración (ADMIN_PASSCODE igual al código de un espacio
// o al APP_PASSCODE de siempre: "gana el administrador"). Los gastos sin enviar no se pierden: la cola no se descarta
// por un 404 'Ruta no encontrada', el celular no adopta la administración sin que nadie lo eligiera y pide el código otra vez.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openMemoryDb } from '../src/db.mjs';
import { handle } from '../src/handlers.mjs';
import { createSpace, regenerateSpace } from '../src/spaces.mjs';

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
let rutas = []; // "MÉTODO /ruta → estado" de cada petición que salió del celular
globalThis.fetch = async (url, opts = {}) => {
  const u = new URL(url, 'http://x');
  // Nada de este archivo sale a internet (tasas, enlaces de mapas): solo las rutas del propio servidor.
  if (!online || !u.pathname.startsWith('/api/')) throw new TypeError('sin conexión');
  const out = await handle({
    method: opts.method ?? 'GET',
    path: u.pathname,
    query: u.searchParams,
    body: opts.body ? JSON.parse(opts.body) : null,
    passcode: opts.headers?.['x-passcode'],
    db,
  });
  rutas.push(`${opts.method ?? 'GET'} ${u.pathname} → ${out.status}`);
  return { ok: out.status < 400, status: out.status, headers: new Map(), json: async () => out.body };
};

const ADMIN = 'clave-larga-de-la-administracion';
const APP = 'clave-de-siempre-del-dueño';
const AVISO = 'Este código ahora es el de la administración. Escribe el código de tu espacio o el de la administración.';
const gasto = { id: 'x1', date: '2026-11-14', amount_cents: 1000, description: 'Taxi', payment_method_id: 'cash', beneficiary_ids: ['yo'] };

const antes = { ADMIN_PASSCODE: process.env.ADMIN_PASSCODE, APP_PASSCODE: process.env.APP_PASSCODE };
test.afterEach(() => {
  for (const [k, v] of Object.entries(antes)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

let modulos = 0;
const cargar = () => import(`../public/js/store.js?colision=${(modulos += 1)}`);

// Base nueva, almacenamiento vacío y módulo nuevo, con ADMIN_PASSCODE y APP_PASSCODE de partida.
async function arrancar() {
  process.env.ADMIN_PASSCODE = ADMIN;
  process.env.APP_PASSCODE = APP;
  db = await openMemoryDb();
  await db.run('INSERT INTO rates (pair, date, rate) VALUES (?, ?, ?)', ['BRL-COP', '2026-11-14', 600]);
  mem.clear();
  online = true;
  rutas = [];
  return cargar();
}

// Entra con `code`, deja una persona, un medio de pago y un gasto sin enviar (se guardó sin red).
async function espacioConCola(store, code) {
  assert.deepEqual(await store.trySwitchSpace(code, () => assert.fail('no debe preguntar')), { switched: true });
  await store.refresh();
  await store.savePerson({ id: 'yo', name: 'Yo' });
  await store.saveMethod({ id: 'cash', kind: 'cash', name: 'Efectivo', owner_person_id: 'yo' });
  online = false;
  await store.saveExpense(gasto);
  online = true;
  assert.equal(store.pendingCount(), 1);
}

const gastosEnLaBase = async () => (await db.all('SELECT id FROM expenses')).length;

// Lo que debe quedar tras la sincronización que descubre que el código guardado ya es el de la administración.
async function bloqueado(store, copia) {
  assert.equal(store.pendingCount(), 1, 'el gasto sin enviar sigue en el celular');
  assert.equal(mem.get('bg_queue'), copia.queue, 'la cola guardada no cambió');
  assert.equal(mem.get('bg_state2'), copia.state, 'la copia local del espacio no se borró');
  assert.equal(mem.get('bg_space') ?? null, copia.space, 'el espacio guardado no cambió');
  assert.equal(mem.has('bg_pass'), false, 'el código guardado se olvida');
  assert.equal(await gastosEnLaBase(), 0, 'ningún PUT se aceptó');
  assert.equal(store.net.needsLogin, true);
  assert.equal(store.net.lockReason, AVISO);
  assert.equal(store.isManager(), false, 'no se dibuja la pantalla de la administración');
  assert.equal(store.awaitingManager(), false);
}

const copiar = () => ({ queue: mem.get('bg_queue'), state: mem.get('bg_state2'), space: mem.get('bg_space') ?? null });

test('la cola sobrevive cuando ADMIN_PASSCODE pasa a ser el código guardado de un espacio', async () => {
  const store = await arrancar();
  const s = await createSpace(db, { name: 'Viaje a Brasil' });
  await espacioConCola(store, s.code);
  assert.equal(mem.get('bg_space'), s.id);
  const copia = copiar();

  process.env.ADMIN_PASSCODE = s.code; // el operador repite el código del espacio
  rutas = [];
  await store.syncNow();
  await bloqueado(store, copia);
  assert.ok(rutas.includes('PUT /api/expenses/x1 → 404'), 'el gasto salió y volvió con 404');

  // La sincronización del minuto siguiente (ya sin código) tampoco pierde nada ni borra el aviso.
  await store.syncNow().catch(() => {});
  await bloqueado(store, copia);
});

test('la cola sobrevive en un celular de antes de los espacios cuando ADMIN_PASSCODE pasa a ser el APP_PASSCODE', async () => {
  const primera = await arrancar();
  await espacioConCola(primera, APP);
  mem.delete('bg_space'); // copia de antes de los espacios: no sabe de qué espacio es
  const copia = copiar();
  assert.equal(copia.space, null);

  process.env.ADMIN_PASSCODE = APP;
  const store = await cargar(); // el celular vuelve a abrir la app
  await store.syncNow();
  await bloqueado(store, copia);
});

test('un 404 "No encontrado" (gasto de otro espacio) sigue descartando ese gasto de la cola', async () => {
  const store = await arrancar();
  assert.deepEqual(await store.trySwitchSpace(APP, () => assert.fail('no debe preguntar')), { switched: true });
  await store.refresh();
  await store.savePerson({ id: 'yo', name: 'Yo' });
  await store.saveMethod({ id: 'cash', kind: 'cash', name: 'Efectivo', owner_person_id: 'yo' });
  await store.saveExpense(gasto); // x1 queda en Principal
  assert.equal(await gastosEnLaBase(), 1);

  const s = await createSpace(db, { name: 'Otro' });
  assert.deepEqual(await store.trySwitchSpace(s.code, () => assert.fail('no hay cola')), { switched: true });
  await store.refresh();
  online = false;
  await store.saveExpense({ ...gasto, description: 'Mismo id que el de Principal' });
  online = true;
  const out = await store.flush();
  assert.deepEqual(out.errors, ['No encontrado']);
  assert.equal(store.pendingCount(), 0);
  assert.deepEqual(JSON.parse(mem.get('bg_queue')), []);
  assert.equal(store.net.needsLogin, false);
  const fila = await db.all('SELECT description FROM expenses WHERE id = ?', ['x1']);
  assert.equal(fila[0].description, 'Taxi', 'el gasto de Principal no se tocó');
});

test('entrar como administración desde el formulario sigue funcionando', async () => {
  const store = await arrancar();
  assert.deepEqual(await store.trySwitchSpace(ADMIN, () => assert.fail('no hay cola')), { switched: true });
  await store.syncNow();
  assert.equal(store.isManager(), true);
  assert.equal(store.net.needsLogin, false);
  assert.equal(store.net.lockReason, '');
  assert.equal(mem.get('bg_pass'), ADMIN);
  assert.equal(mem.get('bg_space'), 'manager');
  assert.equal(store.getState().space.is_manager, true);

  // Una recarga con la administración guardada también la muestra.
  const recarga = await cargar();
  await recarga.syncNow();
  assert.equal(recarga.isManager(), true);
  assert.equal(recarga.net.needsLogin, false);
});

test('tras el aviso, escribir el código de la administración a propósito pide confirmar la cola y entra', async () => {
  const store = await arrancar();
  const s = await createSpace(db, { name: 'Viaje' });
  await espacioConCola(store, s.code);
  process.env.ADMIN_PASSCODE = s.code;
  await store.syncNow();
  assert.equal(store.net.needsLogin, true);

  const textos = [];
  assert.deepEqual(await store.trySwitchSpace(s.code, (t) => { textos.push(t); return true; }), { switched: true });
  await store.refresh();
  assert.equal(textos.length, 1, 'se preguntó antes de descartar el gasto');
  assert.equal(store.isManager(), true);
  assert.equal(store.pendingCount(), 0);
});

test('tras el aviso, escribir el código nuevo del espacio conserva la cola y la envía una sola vez', async () => {
  const store = await arrancar();
  const s = await createSpace(db, { name: 'Viaje' });
  await espacioConCola(store, s.code);
  process.env.ADMIN_PASSCODE = s.code;
  await store.syncNow();
  assert.equal(store.pendingCount(), 1);

  const { code } = await regenerateSpace(db, s.id); // la administración le da al espacio un código propio
  rutas = [];
  assert.deepEqual(await store.trySwitchSpace(code, () => assert.fail('mismo espacio: no hay nada que descartar')), { switched: true });
  await store.syncNow();
  await store.syncNow();
  assert.equal(store.pendingCount(), 0);
  assert.equal(store.net.needsLogin, false);
  assert.equal(store.isManager(), false);
  assert.deepEqual(rutas.filter((r) => r.startsWith('PUT /api/expenses/')), ['PUT /api/expenses/x1 → 200']);
  assert.equal(await gastosEnLaBase(), 1);
  assert.equal(store.getState().expenses.length, 1);
});
