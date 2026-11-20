// Espacios en el navegador (store.js): al entrar con un código de otro espacio el celular descarta su copia
// local; con el mismo espacio (aunque el código cambie o el espacio esté desactivado) no pierde nada.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { openMemoryDb } from '../src/db.mjs';
import { handle } from '../src/handlers.mjs';
import { hashCode } from '../src/spaces.mjs';

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
let puts = []; // envíos de gastos que el servidor aceptó
let retener = null; // (ruta, código) => promesa | null: la respuesta de esa petición llega cuando la promesa se cumple
let fallar = null; // (ruta, código) => true: el servidor responde 500
let pedidos = 0; // peticiones que salieron del celular
globalThis.fetch = async (url, opts = {}) => {
  pedidos += 1;
  if (!online) throw new TypeError('network down');
  const u = new URL(url, 'http://x');
  const code = opts.headers?.['x-passcode'];
  if (fallar?.(u.pathname, code)) return { ok: false, status: 500, headers: new Map(), json: async () => ({ error: 'Error interno' }) };
  const out = await handle({
    method: opts.method ?? 'GET',
    path: u.pathname,
    query: u.searchParams,
    body: opts.body ? JSON.parse(opts.body) : null,
    passcode: opts.headers?.['x-passcode'],
    db,
  });
  if (opts.method === 'PUT' && u.pathname.startsWith('/api/expenses/') && out.status < 400) puts.push(u.pathname);
  await retener?.(u.pathname, code); // la petición ya llegó al servidor; la respuesta tarda
  // Igual que http.mjs: el estado lleva un ETag y se responde 304 si el navegador ya tiene esa versión.
  const headers = new Map();
  if (u.pathname === '/api/state' && out.status === 200) {
    const etag = `"${createHash('sha1').update(JSON.stringify(out.body)).digest('base64url')}"`;
    headers.set('etag', etag);
    if (opts.headers?.['if-none-match'] === etag) return { ok: true, status: 304, headers, json: async () => null };
  }
  return { ok: out.status < 400, status: out.status, headers, json: async () => out.body };
};

const ADMIN = 'codigo-del-administrador';
const CODE_A = 'AAAA-AAAA-AAAA';
const CODE_B = 'BBBB-BBBB-BBBB';

// Un espacio normal con su viaje inicial, como lo deja el administrador al crearlo.
async function crearEspacio(id, code) {
  await db.run('INSERT INTO spaces (id, name, code_hash, is_admin, active, created_at) VALUES (?, ?, ?, 0, 1, ?)', [id, `Espacio ${id}`, hashCode(code), '2026-11-01T00:00:00Z']);
  await db.run('INSERT INTO trips (id, name, dest_currency, home_currency, created_at, space_id) VALUES (?, ?, ?, ?, ?, ?)', [`trip-${id}`, 'Viaje 1', 'BRL', 'COP', '2026-11-01T00:00:00Z', id]);
}

// Base nueva con los espacios `a` y `b`, módulo nuevo y el almacenamiento como lo deja `antes`.
async function arrancar(caso, antes = () => {}) {
  process.env.APP_PASSCODE = ADMIN;
  db = await openMemoryDb();
  await crearEspacio('a', CODE_A);
  await crearEspacio('b', CODE_B);
  await db.run('INSERT INTO rates (pair, date, rate) VALUES (?, ?, ?)', ['BRL-COP', '2026-11-14', 600]);
  mem.clear();
  online = true;
  puts = [];
  retener = null;
  fallar = null;
  pedidos = 0;
  antes();
  return import(`../public/js/store.js?caso=${caso}`);
}

// Entra con un código de forma directa (guardarlo, comprobarlo, adoptar su espacio y leer el estado), sin pasar por
// trySwitchSpace: sirve para dejar el celular en un espacio antes de cada caso. No es lo que hace events.js.
async function entrar(store, code) {
  store.setPass(code);
  const info = await store.ping();
  const n = store.discardCount(info.space);
  store.adoptSpace(info.space);
  await store.refresh();
  return { info, n };
}

const gasto = { id: 'x1', date: '2026-11-14', amount_cents: 1000, description: 'Taxi', payment_method_id: 'cash', beneficiary_ids: ['yo'] };

// Entra al espacio A, deja datos (persona, medio de pago, tasa, historial, viaje activo) y un gasto sin enviar.
async function prepararA(store) {
  await entrar(store, CODE_A);
  await store.savePerson({ id: 'yo', name: 'Yo' });
  await store.saveMethod({ id: 'cash', kind: 'cash', name: 'Efectivo', owner_person_id: 'yo' });
  await store.refresh();
  store.setActiveTrip('trip-a');
  await store.fetchRate('2026-11-14');
  await store.fetchHistory(30);
  online = false;
  await store.saveExpense(gasto);
  online = true;
  assert.equal(store.pendingCount(), 1);
}

async function conProceso(fn) {
  const antes = process.env.APP_PASSCODE;
  try {
    await fn();
  } finally {
    if (antes === undefined) delete process.env.APP_PASSCODE;
    else process.env.APP_PASSCODE = antes;
  }
}

test('cambiar de espacio borra estado, cola, tasas, historial y viaje activo', () => conProceso(async () => {
  const store = await arrancar(1);
  await prepararA(store);
  for (const k of ['bg_state2', 'bg_queue', 'bg_rates2', 'bg_hist', 'bg_trip']) assert.ok(mem.has(k), `antes de cambiar existe ${k}`);
  assert.equal(mem.get('bg_space'), 'a');
  assert.ok(store.localRate('2026-11-14'));

  store.setPass(CODE_B);
  await store.refresh();

  assert.equal(store.pendingCount(), 0);
  const s = store.getState();
  assert.equal(s.people.length, 0);
  assert.equal(s.payment_methods.length, 0);
  assert.equal(s.expenses.length, 0);
  assert.equal(s.trip.id, 'trip-b');
  assert.equal(store.localRate('2026-11-14'), null);
  assert.equal(mem.get('bg_space'), 'b');
  assert.equal(mem.has('bg_rates2'), false);
  assert.equal(mem.has('bg_hist'), false);
  assert.equal(mem.has('bg_trip'), false);
  assert.deepEqual(JSON.parse(mem.get('bg_queue') ?? '[]'), []);
  assert.ok(!mem.get('bg_state2').includes('Yo'), 'la copia local ya no trae nada del espacio A');
  assert.equal(mem.get('bg_pass'), CODE_B);
  assert.equal(await db.all('SELECT id FROM expenses').then((r) => r.length), 0, 'lo descartado nunca llegó a ningún espacio');
}));

test('volver a entrar en el mismo espacio conserva todo, incluida la cola', () => conProceso(async () => {
  const store = await arrancar(2);
  await prepararA(store);

  const { n } = await entrar(store, CODE_A);
  await store.refresh(); // segunda lectura: el servidor responde 304 y nada se pierde

  assert.equal(n, 0);
  assert.equal(store.pendingCount(), 1);
  const s = store.getState();
  assert.equal(s.people.length, 1);
  assert.ok(s.expenses.find((e) => e.id === 'x1')?.pending);
  assert.ok(store.localRate('2026-11-14'));
  assert.equal(store.activeTrip().id, 'trip-a');
  assert.ok(mem.has('bg_hist'));
}));

test('discardCount: cuenta la cola solo si cambia el espacio', () => conProceso(async () => {
  const store = await arrancar(3);
  await prepararA(store);
  assert.equal(store.discardCount({ id: 'a', name: 'A', is_admin: false }), 0);
  assert.equal(store.discardCount({ id: 'b', name: 'B', is_admin: false }), 1);
  assert.equal(store.discardCount({ id: 'space-admin', name: 'Principal', is_admin: true }), 1);
  assert.equal(store.pendingCount(), 1, 'contar no borra nada');
  assert.equal(mem.get('bg_space'), 'a');
}));

// Copia de antes de los espacios: datos y un gasto en cola, pero ningún `bg_space`.
const copiaAnterior = () => {
  mem.set('bg_state2', JSON.stringify({ today: '2026-11-14', trips: [], people: [{ id: 'fantasma', name: 'Fantasma' }], payment_methods: [], expenses: [], payments: [] }));
  mem.set('bg_queue', JSON.stringify([{ op: 'save', id: 'v1', expense: { ...gasto, id: 'v1' } }]));
  mem.set('bg_rates2', JSON.stringify({ 'BRL-COP': { '2026-11-14': 600 } }));
};

test('copia anterior a los espacios y entrada con un espacio normal: se descarta', () => conProceso(async () => {
  const store = await arrancar(4, copiaAnterior);
  assert.equal(store.pendingCount(), 1);
  const { n } = await entrar(store, CODE_A);
  assert.equal(n, 1);
  assert.equal(store.pendingCount(), 0);
  assert.equal(store.getState().people.length, 0);
  assert.equal(store.localRate('2026-11-14'), null);
  assert.equal(mem.get('bg_space'), 'a');
}));

test('copia anterior a los espacios y entrada como administrador: se conserva', () => conProceso(async () => {
  const store = await arrancar(5, copiaAnterior);
  const info = await (async () => { store.setPass(ADMIN); return store.ping(); })();
  assert.equal(info.space.is_admin, true);
  assert.equal(store.discardCount(info.space), 0);
  assert.equal(store.adoptSpace(info.space), false);
  assert.equal(store.pendingCount(), 1);
  assert.equal(store.getState().people[0].id, 'fantasma');
  assert.ok(store.localRate('2026-11-14'));
  assert.equal(mem.get('bg_space'), info.space.id);
}));

test('primera entrada en un celular nuevo: no hay nada que descartar ni que confirmar', () => conProceso(async () => {
  const store = await arrancar(6);
  const { info, n } = await entrar(store, CODE_B);
  assert.equal(n, 0);
  assert.equal(store.adoptSpace(info.space), false);
  assert.equal(mem.get('bg_space'), 'b');
  assert.equal(store.getState().trip.id, 'trip-b');
}));

test('un estado sin espacio (servidor viejo) no borra nada', () => conProceso(async () => {
  const store = await arrancar(7);
  await prepararA(store);
  assert.equal(store.adoptSpace(undefined), false);
  assert.equal(store.discardCount(undefined), 0);
  assert.equal(store.pendingCount(), 1);
  assert.equal(mem.get('bg_space'), 'a');
}));

test('espacio desactivado con gastos en cola: la cola se conserva y se envía al reactivar', () => conProceso(async () => {
  const store = await arrancar(8);
  await prepararA(store);

  await db.run("UPDATE spaces SET active = 0 WHERE id = 'a'");
  const r = await store.flush();
  assert.equal(r.sent, 0);
  assert.equal(store.pendingCount(), 1, 'con el 401 la cola queda intacta');
  assert.equal(store.net.needsLogin, true);
  assert.equal(JSON.parse(mem.get('bg_queue')).length, 1);
  assert.equal(await db.all('SELECT id FROM expenses').then((x) => x.length), 0);

  await db.run("UPDATE spaces SET active = 1 WHERE id = 'a'");
  const { n } = await entrar(store, CODE_A);
  assert.equal(n, 0);
  assert.equal(store.pendingCount(), 1);
  await store.flush();
  await store.flush();
  assert.equal(store.pendingCount(), 0);
  assert.deepEqual(puts, ['/api/expenses/x1']);
  assert.equal(await db.all('SELECT id FROM expenses').then((x) => x.length), 1);
}));

test('código regenerado: la cola se conserva; entrar con el código nuevo del mismo espacio no la borra', () => conProceso(async () => {
  const store = await arrancar(9);
  await prepararA(store);

  const nuevo = 'CCCC-CCCC-CCCC';
  await db.run("UPDATE spaces SET code_hash = ? WHERE id = 'a'", [hashCode(nuevo)]);
  await store.flush();
  assert.equal(store.pendingCount(), 1, 'con el código viejo el 401 deja la cola intacta');
  assert.equal(store.net.needsLogin, true);

  const { n } = await entrar(store, nuevo);
  assert.equal(n, 0, 'es el mismo espacio: nada que descartar');
  assert.equal(store.pendingCount(), 1);
  await store.flush();
  assert.equal(store.pendingCount(), 0);
  assert.deepEqual(puts, ['/api/expenses/x1']);
  assert.equal(await db.all('SELECT id FROM expenses').then((x) => x.length), 1);
  assert.equal(store.getState().people.length, 1);
}));

// ---------- el código nuevo no se guarda ni se envía la cola antes de confirmar ----------

const mensaje = (n) => `Hay ${n} gasto(s) sin enviar del espacio anterior. Si entras con este código se descartarán. ¿Continuar?`;

// Retiene la respuesta de las peticiones que cumplan `cual` hasta llamar a `soltar()`.
function retenerRespuesta(cual) {
  let soltar;
  const espera = new Promise((r) => { soltar = r; });
  retener = (ruta, code) => (cual(ruta, code) ? espera : null);
  return soltar;
}

const gastosDe = (espacio) => db.all('SELECT e.id FROM expenses e JOIN trips t ON t.id = e.trip_id WHERE t.space_id = ?', [espacio]).then((x) => x.length);

test('trySwitchSpace: con gastos en cola pide confirmar con el texto exacto y, si cancela, no cambia nada', () => conProceso(async () => {
  const store = await arrancar(10);
  await prepararA(store);
  const textos = [];
  const r = await store.trySwitchSpace(CODE_B, (t) => { textos.push(t); return false; });
  assert.deepEqual(textos, [mensaje(1)]);
  assert.deepEqual(r, { switched: false, cancelled: true });
  assert.equal(mem.get('bg_pass'), CODE_A);
  assert.equal(mem.get('bg_space'), 'a');
  assert.equal(store.pendingCount(), 1);
  assert.equal(store.net.needsLogin, false);
}));

test('trySwitchSpace: si acepta, guarda el código y descarta la copia anterior', () => conProceso(async () => {
  const store = await arrancar(11);
  await prepararA(store);
  const r = await store.trySwitchSpace(CODE_B, () => true);
  assert.deepEqual(r, { switched: true });
  assert.equal(mem.get('bg_pass'), CODE_B);
  assert.equal(mem.get('bg_space'), 'b');
  assert.equal(store.pendingCount(), 0);
  await store.refresh();
  assert.equal(store.getState().trip.id, 'trip-b');
  assert.equal(store.getState().people.length, 0);
}));

test('trySwitchSpace: un celular sin cola cambia de espacio sin preguntar', () => conProceso(async () => {
  const store = await arrancar(12);
  await entrar(store, CODE_A);
  let preguntas = 0;
  const r = await store.trySwitchSpace(CODE_B, () => { preguntas += 1; return true; });
  assert.deepEqual(r, { switched: true });
  assert.equal(preguntas, 0);
  assert.equal(mem.get('bg_space'), 'b');
}));

test('mientras el código nuevo se comprueba no se guarda: la cola solo sale con el código anterior y a su espacio', () => conProceso(async () => {
  const store = await arrancar(13);
  await prepararA(store);
  const soltar = retenerRespuesta((ruta, code) => ruta === '/api/ping' && code === CODE_B);
  const textos = [];
  const cambio = store.trySwitchSpace(CODE_B, (t) => { textos.push(t); return true; });

  assert.equal(mem.get('bg_pass'), CODE_A, 'el código nuevo no se guarda mientras se comprueba');
  assert.equal(store.net.needsLogin, false);
  await store.flush(); // sincronización de fondo con el código anterior: va al espacio A
  await store.refresh();
  assert.deepEqual(puts, ['/api/expenses/x1']);
  assert.equal(await gastosDe('b'), 0);
  assert.equal(await gastosDe('a'), 1);

  soltar();
  assert.deepEqual(await cambio, { switched: true });
  assert.deepEqual(textos, [], 'el gasto ya se había enviado a su espacio: nada que descartar');
  assert.equal(mem.get('bg_pass'), CODE_B);
}));

test('mientras el código nuevo se comprueba, sin conexión la cola queda intacta y se descarta solo al confirmar', () => conProceso(async () => {
  const store = await arrancar(14);
  await prepararA(store);
  const soltar = retenerRespuesta((ruta, code) => ruta === '/api/ping' && code === CODE_B);
  const textos = [];
  const cambio = store.trySwitchSpace(CODE_B, (t) => { textos.push(t); return true; });

  online = false; // la red se cae con la comprobación en vuelo
  assert.deepEqual(await store.flush(), { sent: 0, errors: [] });
  assert.equal(await store.refresh(), false);
  online = true;
  assert.deepEqual(puts, []);
  assert.equal(store.pendingCount(), 1);
  assert.equal(mem.get('bg_pass'), CODE_A);
  assert.deepEqual(textos, []);

  soltar();
  assert.deepEqual(await cambio, { switched: true });
  assert.deepEqual(textos, [mensaje(1)]);
  assert.equal(store.pendingCount(), 0);
  assert.equal(mem.get('bg_pass'), CODE_B);
  assert.deepEqual(puts, []);
  assert.equal(await gastosDe('b'), 0);
}));

test('comprobación del código nuevo que falla con 500 o sin conexión: ni código, ni cola, ni needsLogin cambian', () => conProceso(async () => {
  const store = await arrancar(15);
  await prepararA(store);

  fallar = (ruta, code) => ruta === '/api/ping' && code === CODE_B;
  const r500 = await store.trySwitchSpace(CODE_B, () => assert.fail('no debe preguntar'));
  assert.equal(r500.switched, false);
  assert.equal(r500.error.status, 500);
  fallar = null;

  online = false;
  const rOff = await store.trySwitchSpace(CODE_B, () => assert.fail('no debe preguntar'));
  online = true;
  assert.equal(rOff.switched, false);
  assert.equal(rOff.error.offline, true);

  assert.equal(mem.get('bg_pass'), CODE_A);
  assert.equal(mem.get('bg_space'), 'a');
  assert.equal(store.pendingCount(), 1);
  assert.equal(store.net.needsLogin, false);
}));

test('código equivocado (401): el código guardado y la cola no cambian y no se cierra la sesión', () => conProceso(async () => {
  const store = await arrancar(16);
  await prepararA(store);
  const r = await store.trySwitchSpace('ZZZZ-ZZZZ-ZZZZ', () => assert.fail('no debe preguntar'));
  assert.equal(r.switched, false);
  assert.equal(r.error.status, 401);
  assert.equal(mem.get('bg_pass'), CODE_A);
  assert.equal(store.pendingCount(), 1);
  assert.equal(store.net.needsLogin, false, 'quien ya tenía una sesión válida la conserva');
  await store.flush();
  assert.deepEqual(puts, ['/api/expenses/x1']);
}));

test('código equivocado en la pantalla de acceso: sigue en la pantalla de acceso y no se guarda nada', () => conProceso(async () => {
  const store = await arrancar(17);
  assert.equal(store.net.needsLogin, true);
  const r = await store.trySwitchSpace('ZZZZ-ZZZZ-ZZZZ', () => assert.fail('no debe preguntar'));
  assert.equal(r.error.status, 401);
  assert.equal(store.net.needsLogin, true);
  assert.equal(mem.has('bg_pass'), false);
}));

test('un refresh con el código anterior que llega después del cambio no deshace el cambio de espacio', () => conProceso(async () => {
  const store = await arrancar(18);
  await prepararA(store);
  await db.run("INSERT INTO people (id, name, space_id) VALUES ('nuevo', 'Nuevo', 'a')"); // el estado de A cambió: la respuesta traerá datos
  let una = true;
  const soltar = retenerRespuesta((ruta, code) => {
    if (ruta !== '/api/state' || code !== CODE_A || !una) return false;
    una = false;
    return true;
  });
  const viejo = store.refresh(); // sale con el código A

  assert.deepEqual(await store.trySwitchSpace(CODE_B, () => true), { switched: true });
  await store.refresh(); // ya con el código B
  assert.equal(store.getState().trip.id, 'trip-b');

  soltar(); // llega la respuesta del espacio A
  await viejo;
  assert.equal(store.getState().trip.id, 'trip-b', 'justo al llegar la respuesta vieja');
  assert.equal(mem.get('bg_space'), 'b');
  assert.equal(store.net.needsLogin, false);
  await store.refresh();
  const s = store.getState();
  assert.equal(s.trip.id, 'trip-b');
  assert.equal(s.people.length, 0);
  assert.equal(mem.get('bg_space'), 'b');
  assert.ok(!mem.get('bg_state2').includes('Yo'));
  assert.ok(!mem.get('bg_state2').includes('Nuevo'));
}));

// ---------- código muerto: no gasta intentos ni cierra una sesión nueva ----------

test('con la sesión cerrada por un código que ya no sirve, sincronizar no hace ninguna petición', () => conProceso(async () => {
  const store = await arrancar(19);
  await prepararA(store);
  await db.run("UPDATE spaces SET code_hash = ? WHERE id = 'a'", [hashCode('CCCC-CCCC-CCCC')]); // el administrador lo regeneró
  await store.flush();
  assert.equal(store.net.needsLogin, true);
  assert.equal(mem.get('bg_pass'), CODE_A, 'el código viejo sigue guardado');

  pedidos = 0;
  await store.syncNow();
  await store.syncNow();
  assert.equal(pedidos, 0, 'cada petición con el código viejo contaría como un intento fallido');
  assert.equal(store.pendingCount(), 1, 'la cola sigue intacta');
}));

test('sin código guardado (primera visita), sincronizar sí pregunta al servidor si está abierto', () => conProceso(async () => {
  const store = await arrancar(20);
  assert.equal(store.net.needsLogin, true);
  await assert.rejects(store.syncNow(), { status: 401 }); // sin código: no cuenta como intento en el servidor
  assert.ok(pedidos > 0);
  assert.equal(store.net.needsLogin, true, 'este servidor pide código');
}));

test('un 401 tardío del código anterior no cierra la sesión recién abierta con otro código', () => conProceso(async () => {
  const store = await arrancar(21);
  await prepararA(store);
  await db.run("UPDATE spaces SET active = 0 WHERE id = 'a'"); // la respuesta a la petición vieja será 401
  const soltar = retenerRespuesta((ruta, code) => ruta === '/api/ping' && code === CODE_A);
  const viejo = store.ping(); // sale con el código A

  assert.deepEqual(await store.trySwitchSpace(CODE_B, () => true), { switched: true });
  assert.equal(store.net.needsLogin, false);
  let avisos = 0;
  const oyente = () => { avisos += 1; };
  store.listeners.add(oyente);
  try {
    soltar();
    await assert.rejects(viejo, { status: 401 });
  } finally {
    store.listeners.delete(oyente);
  }
  assert.equal(store.net.needsLogin, false, 'el 401 era del código anterior');
  assert.equal(avisos, 0, 'no se redibuja (ni se muestra "Código incorrecto")');
  assert.equal(mem.get('bg_pass'), CODE_B);
  await store.refresh();
  assert.equal(store.getState().trip.id, 'trip-b');
}));
