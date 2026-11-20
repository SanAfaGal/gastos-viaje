// Datos del navegador: llamadas a la API, copia local para leer sin internet y cola de gastos
// pendientes de enviar. Todo en localStorage (son pocos datos).
import { setCurrencies, toHome, todayStr } from './money.mjs';
import { currencyByCode, DEFAULT_SETTINGS } from './currencies.mjs';
import { compareExpenses } from './order.mjs';

const K = { state: 'bg_state2', queue: 'bg_queue', pass: 'bg_pass', open: 'bg_open', rates: 'bg_rates2', hist: 'bg_hist', trip: 'bg_trip', space: 'bg_space' };

function read(key, fallback) {
  try {
    const v = localStorage.getItem(key);
    return v ? JSON.parse(v) : fallback;
  } catch {
    return fallback;
  }
}
function write(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* almacenamiento lleno o bloqueado: seguimos sin copia local */
  }
}

export const uuid = () =>
  crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`;

export const listeners = new Set();
const notify = () => listeners.forEach((fn) => fn());

export const getPass = () => localStorage.getItem(K.pass) ?? '';

// Sin código guardado y sin saber que este servidor abre sin pedirlo, se muestra el acceso desde el primer
// instante en vez de dibujar la app vacía y esperar al 401. K.open = '1': el servidor respondió sin código.
function startsLocked() {
  try {
    return !getPass() && localStorage.getItem(K.open) !== '1';
  } catch {
    return true; // sin almacenamiento no hay código guardado
  }
}

function setOpenMark(on) {
  try {
    if (on) localStorage.setItem(K.open, '1');
    else localStorage.removeItem(K.open);
  } catch {
    /* sin almacenamiento: la marca no se guarda */
  }
}

// lockReason: por qué se pide el código cuando no es solo "no lo has puesto" (hoy: el espacio está desactivado).
export const net = { online: true, syncing: false, needsLogin: startsLocked(), lastSync: 0, lockReason: '' };

export function setPass(p) {
  localStorage.setItem(K.pass, p);
  if (p === '') setOpenMark(false);
  net.needsLogin = false;
  net.lockReason = '';
}

const NOT_MODIFIED = Symbol('not-modified');
let stateEtag = null; // versión del estado que ya tenemos: el servidor responde 304 si no cambió

// Con un código guardado que aún no se comprobó en esta carga, solo sale UNA petición; las demás esperan su resultado.
// Cada intento con código cuenta para el límite del servidor (10 por red cada 15 minutos) y una recarga lanza varias
// peticiones a la vez: con el código ya muerto (se regeneró el código o se desactivó el espacio) eso
// bloqueaba a la persona sin que hubiera escrito nada. Si la primera recibe 401, las demás ni salen.
let checkedPass = null; // último código que el servidor aceptó en esta carga
let checking = null; // { pass, done }: la petición que está comprobando el código guardado

async function request(method, path, body, extraHeaders = {}) {
  const pass = getPass();
  if (!pass || pass === checkedPass) return send(method, path, body, extraHeaders);
  if (checking?.pass === pass) {
    await checking.done.catch(() => {});
    if (getPass() !== pass) { // la primera recibió 401 y el código se olvidó: no hace falta preguntar de nuevo
      const err = new Error('Código incorrecto');
      err.status = 401;
      throw err;
    }
    return send(method, path, body, extraHeaders);
  }
  const done = send(method, path, body, extraHeaders);
  checking = { pass, done };
  try {
    const out = await done;
    checkedPass = pass;
    return out;
  } catch (err) {
    // Un error del servidor que no sea de acceso (400, 404, 409...) también significa que el código vale.
    if (err.status && err.status < 500 && ![401, 403, 429].includes(err.status)) checkedPass = pass;
    throw err;
  } finally {
    if (checking?.done === done) checking = null;
  }
}

async function send(method, path, body, extraHeaders = {}) {
  let res;
  const pass = getPass();
  try {
    res = await fetch(path, {
      method,
      headers: { 'content-type': 'application/json', 'x-passcode': pass, ...extraHeaders },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    net.online = false;
    notify();
    const err = new Error('Sin conexión');
    err.offline = true;
    throw err;
  }
  net.online = true;
  if (res.status === 304) return NOT_MODIFIED;
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* sin cuerpo */
  }
  // Si el código cambió mientras tanto, esta respuesta es del espacio anterior: su versión no se guarda.
  if (path === '/api/state' && res.ok && getPass() === pass) stateEtag = res.headers?.get?.('etag') ?? null;
  if (res.status === 401 || res.status === 403) {
    // 401: el código no sirve. 403: es el de un espacio que el administrador desactivó (el servidor dice por qué).
    // Solo si el código no cambió mientras tanto: una respuesta tardía del código anterior no cierra la sesión nueva.
    if (getPass() === pass) {
      net.lockReason = res.status === 403 ? (data?.error ?? '') : '';
      // El servidor ya no acepta este código: se olvida. Así la próxima recarga abre directo en el acceso, sin
      // mandar peticiones con un código muerto que gasten intentos.
      if (pass) {
        try { localStorage.removeItem(K.pass); } catch { /* sin almacenamiento */ }
      }
      setOpenMark(false);
      net.needsLogin = true;
      notify();
    }
  } else if (res.ok && !pass && !getPass()) {
    // Respondió bien sin que mandáramos código: este servidor está abierto. Un 5xx (por ejemplo durante un
    // despliegue) no dice nada de eso.
    setOpenMark(true);
    if (net.needsLogin) {
      net.needsLogin = false;
      notify();
    }
  }
  if (!res.ok) {
    const err = new Error(data?.error ?? `Error ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

// ---------- estado ----------

const emptyState = () => ({ today: todayStr(), trips: [], people: [], payment_methods: [], expenses: [], payments: [] });
let server = read(K.state, emptyState());
let serverJson = JSON.stringify(server); // para saber si lo que llega del servidor cambió algo
// Cola guardada por la primera versión (solo BRL): mismos datos con el nombre de campo nuevo.
let queue = read(K.queue, []).map((o) => {
  if (o.expense?.amount_brl_cents) {
    const { amount_brl_cents: cents, ...rest } = o.expense;
    return { ...o, expense: { ...rest, amount_cents: cents } };
  }
  return o;
});
let rates = read(K.rates, {}); // { "BRL-COP": { "2026-11-14": 586.7 } }

// ---------- viajes ----------
// Todo lo que depende de monedas (formato, tasas, gráfico) sigue al viaje activo. Los gastos en cola y los
// del servidor llevan su propio viaje, así que un gasto guardado en un viaje no cambia de viaje si luego
// se cambia el viaje activo antes de enviarlo.

const DEFAULT_TRIP = { id: 'trip-1', name: 'Viaje 1', dest: DEFAULT_SETTINGS.dest, home: DEFAULT_SETTINGS.home, people_ids: [] };

// Siempre hay al menos un viaje. Una copia local guardada antes de que existieran los viajes solo trae
// `settings`: se lee como el primer viaje.
function tripsList() {
  if (server.trips?.length) return server.trips;
  const s = server.settings ?? DEFAULT_SETTINGS;
  return [{ ...DEFAULT_TRIP, dest: s.dest, home: s.home, people_ids: (server.people ?? []).map((p) => p.id) }];
}

let activeId = null;
try {
  activeId = localStorage.getItem(K.trip);
} catch {
  /* sin almacenamiento: se usa el primer viaje */
}

const tripById = (id) => tripsList().find((t) => t.id === id);
const expenseTrip = (e) => tripById(e.trip_id ?? tripsList()[0].id);

export const activeTrip = () => tripById(activeId) ?? tripsList()[0];
// Par de monedas de las tasas guardadas. `currency` = moneda de un gasto que no es la del destino del viaje.
const pairKey = (trip = activeTrip(), currency = trip.dest) => `${currency ?? trip.dest}-${trip.home}`;
const applySettings = () => setCurrencies(activeTrip().dest, activeTrip().home);
applySettings();

// ---------- espacios ----------
// Cada código abre su propio espacio. Si el celular pasa a otro espacio, su copia local (estado, cola, tasas,
// historial y viaje activo) es del anterior y se descarta: los datos nunca se mezclan en un mismo celular.

function savedSpaceId() {
  try {
    return localStorage.getItem(K.space);
  } catch {
    return null;
  }
}

// La administración (código ADMIN_PASSCODE) no tiene datos: su estado no se guarda en el celular, así que tras una
// recarga solo se sabe que es ella cuando llega el primer estado. Hasta entonces `awaitingManager` dice que el espacio
// guardado es el suyo, para no dibujar ni enviar nada de datos.
const MANAGER_ID = 'manager';
export const isManager = () => server.space?.is_manager === true;
export const awaitingManager = () => !isManager() && savedSpaceId() === MANAGER_ID;
const managerSide = () => isManager() || savedSpaceId() === MANAGER_ID;

const hasLocalData = () =>
  queue.length > 0 || Object.keys(rates).length > 0 ||
  ['trips', 'people', 'payment_methods', 'expenses', 'payments'].some((k) => server[k]?.length > 0);

// El espacio anterior no se conoce (copia de antes de los espacios): esos datos eran de Principal, así que solo
// se conservan al entrar a Principal (`is_principal`); con cualquier otro espacio, o la administración, se descartan.
const changesSpace = (space) => {
  const prev = savedSpaceId();
  return prev ? prev !== space.id : !space.is_principal && hasLocalData();
};

// Gastos sin enviar que se perderían al entrar en `space`.
export function discardCount(space) {
  return space?.id && changesSpace(space) ? queue.length : 0;
}

// Devuelve true si descartó la copia local. Antes de llamarla, avisar con `discardCount` si hay gastos en cola.
export function adoptSpace(space) {
  if (!space?.id) return false; // un servidor viejo no manda espacio: no hay con qué comparar
  const reset = changesSpace(space);
  if (reset) {
    // El módulo lee todo esto al importarse, así que se limpian la memoria y el almacenamiento a la vez.
    server = emptyState();
    serverJson = JSON.stringify(server);
    queue = [];
    rates = {};
    activeId = null;
    stateEtag = null; // el 304 de un estado del espacio anterior no debe tapar el del nuevo
    for (const k of [K.state, K.queue, K.rates, K.hist, K.trip]) {
      try {
        localStorage.removeItem(k);
      } catch {
        /* sin almacenamiento: queda solo la memoria, ya limpia */
      }
    }
  }
  if (savedSpaceId() !== space.id) {
    try {
      localStorage.setItem(K.space, space.id);
    } catch {
      /* sin almacenamiento */
    }
  }
  if (reset) {
    applySettings();
    notify();
  }
  return reset;
}

export function setActiveTrip(id) {
  activeId = id;
  try {
    localStorage.setItem(K.trip, id);
  } catch {
    /* sin almacenamiento */
  }
  applySettings();
  notify();
}

function remember(date, rate, trip = activeTrip(), currency = trip.dest) {
  if (currency === trip.home) return; // en la moneda de casa la tasa siempre es 1: no hay nada que guardar
  const key = pairKey(trip, currency);
  rates[key] ??= {};
  rates[key][date] = rate;
  write(K.rates, rates);
}

function rememberRates(expenses) {
  for (const e of expenses) {
    const trip = expenseTrip(e);
    if (trip && e.rate && e.rate_date && !e.rate_estimated) remember(e.rate_date, e.rate, trip, e.currency);
  }
}

// Tasa conocida en el celular para esa fecha, o la anterior más cercana. `currency`: la del gasto (por defecto la del destino).
export function localRate(date, trip = activeTrip(), currency = trip.dest) {
  if (currency === trip.home) return { rate: 1, estimated: false }; // gasto en la moneda de casa: sin conversión
  const map = rates[pairKey(trip, currency)] ?? {};
  if (map[date]) return { rate: map[date], estimated: false };
  const earlier = Object.keys(map).filter((d) => d <= date).sort().pop();
  return earlier ? { rate: map[earlier], estimated: true } : null;
}

export async function fetchRate(date, currency) {
  const trip = activeTrip();
  const cur = currency ?? trip.dest;
  if (cur === trip.home) return { rate: 1, estimated: false, rate_date: date, source: null, local: false };
  try {
    const extra = cur === trip.dest ? '' : `&currency=${encodeURIComponent(cur)}`;
    const r = await request('GET', `/api/rate?date=${date}&trip=${encodeURIComponent(trip.id)}${extra}`);
    if (r?.rate && !r.estimated) remember(r.rate_date, r.rate, trip, cur);
    return r?.rate ? r : null;
  } catch {
    const l = localRate(date, trip, cur);
    return l ? { rate: l.rate, estimated: true, local: true } : null;
  }
}

// Enlace corto de Google Maps (maps.app.goo.gl/...): el servidor sigue la redirección. Devuelve { url, lat?, lng?, name? }.
export const resolvePlaceLink = (url) => request('GET', `/api/resolve-place?url=${encodeURIComponent(url)}`);

// Historial de tasas para el gráfico: lo pide al servidor y guarda una copia por si no hay internet.
export async function fetchHistory(days = 30) {
  const trip = activeTrip();
  const key = `${pairKey(trip)}|${days}`;
  try {
    const points = await request('GET', `/api/rates/history?days=${days}&trip=${encodeURIComponent(trip.id)}`);
    write(K.hist, { ...read(K.hist, {}), [key]: points });
    return points;
  } catch (err) {
    if (err.status === 401 || err.status === 403) throw err;
    return read(K.hist, {})[key] ?? [];
  }
}

// Solo se avisa a la pantalla (y se guarda la copia local) si lo recibido es distinto de lo que ya había:
// así la sincronización periódica no redibuja ni escribe en localStorage cuando no cambió nada.
export async function refresh() {
  const wasOnline = net.online;
  const pass = getPass();
  try {
    const fresh = await request('GET', '/api/state', undefined, stateEtag ? { 'if-none-match': stateEtag } : {});
    // Se cambió de espacio mientras la petición viajaba: la respuesta es del espacio anterior y se ignora.
    if (getPass() !== pass) return true;
    net.lastSync = Date.now();
    if (fresh === NOT_MODIFIED) {
      if (!wasOnline) notify();
      return true;
    }
    const etag = stateEtag; // adoptSpace lo borra si cambió el espacio, pero este estado ya es del espacio nuevo
    if (adoptSpace(fresh.space)) stateEtag = etag;
    const json = JSON.stringify(fresh);
    if (json !== serverJson) {
      server = fresh;
      serverJson = json;
      applySettings();
      // El estado vacío de la administración solo vive en memoria (para `isManager`): una copia suya no sirve de nada
      // y no debe confundirse con datos de un espacio.
      if (!isManager()) {
        write(K.state, server);
        rememberRates(server.expenses);
      }
      notify();
    } else if (!wasOnline) notify(); // volvió la conexión: la pantalla muestra el estado de red
    return true;
  } catch (err) {
    if (!err.offline) throw err;
    return false;
  }
}

// Estado que ve la pantalla: lo del servidor + lo que está en cola sin enviar, solo del viaje activo.
// `participants` son las personas que van en ese viaje; `counts` cuenta los gastos de cada viaje.
export function getState() {
  const trips = tripsList();
  const trip = activeTrip();
  let all = server.expenses.map((e) => ({ ...e, trip_id: e.trip_id ?? trips[0].id }));
  for (const op of queue) {
    if (op.op === 'order') {
      // Orden manual aún sin enviar: se ve al instante.
      op.ids.forEach((id, i) => {
        const e = all.find((x) => x.id === id);
        if (e) e.sort_order = i;
      });
      continue;
    }
    const prev = all.find((e) => e.id === op.id);
    all = all.filter((e) => e.id !== op.id);
    if (op.op !== 'save') continue;
    const x = op.expense;
    const t = expenseTrip(x);
    if (!t) continue; // el viaje se borró: el servidor lo rechazará al enviar
    const cur = x.currency ?? t.dest;
    const r = localRate(x.date, t, cur);
    all.push({
      ...x,
      currency: cur,
      // Editar un gasto no lo cambia de lugar en su día (si cambia de día, queda al final del nuevo).
      sort_order: prev && prev.date === x.date ? (prev.sort_order ?? null) : null,
      trip_id: t.id,
      pending: true,
      rate: r?.rate ?? null,
      rate_estimated: r?.estimated ? 1 : 0,
      amount_home: r ? toHome(x.amount_cents, r.rate, currencyByCode(t.home).digits) : null,
    });
  }
  const counts = {};
  for (const e of all) counts[e.trip_id] = (counts[e.trip_id] ?? 0) + 1;
  const expenses = all.filter((e) => e.trip_id === trip.id);
  expenses.sort(compareExpenses);
  const going = new Set(trip.people_ids);
  // Abonos del viaje activo, el más reciente primero. Se guardan con internet (como las personas), no pasan por la cola.
  const payments = (server.payments ?? []).filter((x) => (x.trip_id ?? trips[0].id) === trip.id);
  return { ...server, trips, trip, expenses, payments, counts, participants: server.people.filter((p) => going.has(p.id)) };
}

export const pendingCount = () => queue.length;

// ---------- gastos (con cola) ----------

function enqueue(op) {
  queue = queue.filter((o) => o.id !== op.id);
  queue.push(op);
  write(K.queue, queue);
  notify();
}

export function saveExpense(expense) {
  // El gasto queda atado al viaje activo al guardarlo, aunque se envíe más tarde.
  enqueue({ op: 'save', id: expense.id, expense: { ...expense, trip_id: expense.trip_id ?? activeTrip().id, created_at: expense.created_at ?? new Date().toISOString() } });
  return flush();
}

export function deleteExpense(id) {
  enqueue({ op: 'delete', id });
  return flush();
}

// Orden manual de los gastos de un día (ids de arriba a abajo). `key` identifica el día y el viaje: un
// reordenamiento nuevo del mismo día reemplaza al que aún no se envió.
export function saveOrder(ids, key) {
  enqueue({ op: 'order', id: `order:${key}`, ids });
  return flush();
}

export async function flush() {
  // Con el código de la administración no se envía nada: una cola que quedara de otro espacio espera intacta a que se
  // entre con otro código (trySwitchSpace avisa y la descarta si es de otro espacio).
  if (net.syncing || !queue.length || managerSide()) return { sent: 0, errors: [] };
  net.syncing = true;
  notify();
  const errors = [];
  let sent = 0;
  try {
    for (const op of [...queue]) {
      if (!queue.includes(op)) continue; // la cola se descartó mientras tanto (cambio de espacio)
      try {
        if (op.op === 'save') await request('PUT', `/api/expenses/${op.id}`, op.expense);
        else if (op.op === 'order') await request('POST', '/api/order', { ids: op.ids });
        else await request('DELETE', `/api/expenses/${op.id}`);
        queue = queue.filter((o) => o !== op);
        sent += 1;
      } catch (err) {
        // Sin red, sin acceso, límite de intentos o falla del servidor: el gasto no es inválido, se reintenta luego.
        if (err.offline || err.status === 401 || err.status === 403 || err.status === 429 || err.status >= 500) break;
        errors.push(err.message);
        queue = queue.filter((o) => o !== op); // dato inválido: no reintentar para siempre
      }
    }
  } finally {
    net.syncing = false;
    write(K.queue, queue);
  }
  if (sent || errors.length) await refresh();
  notify();
  return { sent, errors };
}

// Sincronización de fondo (cada minuto y al volver a la app): envía la cola, lee el estado y la tasa de hoy.
// Con la sesión cerrada y un código guardado, ese código ya no sirve: cada petición contaría como un intento
// fallido y acabaría bloqueando el acceso de este celular (y sumando al límite global), así que no se pide nada
// hasta que se escriba un código. Sin código guardado sí se pregunta: así se sabe si el servidor está abierto.
// La administración solo lee el estado (para seguir sabiendo quién es): ni cola ni tasas.
export async function syncNow() {
  if (net.needsLogin && getPass()) return;
  await flush();
  await refresh();
  if (!managerSide()) fetchRate(todayStr());
}

// ---------- personas y medios de pago (requieren internet) ----------

async function mutate(method, path, body) {
  const out = await request(method, path, body);
  await refresh();
  return out;
}

export const saveTrip = (t) => mutate(t.id ? 'PUT' : 'POST', t.id ? `/api/trips/${t.id}` : '/api/trips', t);
export const deleteTrip = (id, withExpenses = false) => mutate('DELETE', `/api/trips/${id}${withExpenses ? '?con_gastos=1' : ''}`);
export const savePerson = (p) => mutate(p.id ? 'PUT' : 'POST', p.id ? `/api/people/${p.id}` : '/api/people', p);
export const deletePerson = (id) => mutate('DELETE', `/api/people/${id}`);
export const saveMethod = (m) => mutate(m.id ? 'PUT' : 'POST', m.id ? `/api/payment-methods/${m.id}` : '/api/payment-methods', m);
export const deleteMethod = (id) => mutate('DELETE', `/api/payment-methods/${id}`);
// Abonos entre personas (quién le pagó a quién). Requieren internet: la tasa del día se resuelve en el servidor.
export const savePayment = (p) => mutate(p.id ? 'PUT' : 'POST', p.id ? `/api/payments/${p.id}` : '/api/payments', { ...p, trip_id: p.trip_id ?? activeTrip().id });
export const deletePayment = (id) => mutate('DELETE', `/api/payments/${id}`);
// Botón "Actualizar tasas". Con dry=true solo cuenta qué cambiaría. Al aplicarlo se olvidan las tasas guardadas
// en el celular de este par y se vuelve a leer todo del servidor.
export async function refreshRatesNow(dry) {
  const out = await request('POST', `/api/rates/refresh?trip=${encodeURIComponent(activeTrip().id)}${dry ? '&dry=1' : ''}`);
  if (!dry) {
    for (const k of Object.keys(rates)) if (k.endsWith(`-${activeTrip().home}`)) delete rates[k]; // el viaje puede tener gastos en varias monedas
    write(K.rates, rates);
    await refresh();
  }
  return out;
}
export const ping = () => request('GET', '/api/ping');

// Comprueba un código SIN guardarlo y sin tocar el estado de la sesión actual (ni `needsLogin`, ni la marca de
// servidor abierto, ni el estado de red): un código equivocado o una caída de red no deben cerrar la sesión.
async function probe(code) {
  let res;
  try {
    res = await fetch('/api/ping', { method: 'GET', headers: { 'content-type': 'application/json', 'x-passcode': code } });
  } catch {
    const err = new Error('Sin conexión');
    err.offline = true;
    throw err;
  }
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* sin cuerpo */
  }
  if (!res.ok) {
    const err = new Error(data?.error ?? `Error ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

// Cambia de código (y quizá de espacio) solo cuando el código nuevo ya se comprobó y, si hay gastos sin
// enviar que se perderían, el usuario confirmó. Hasta entonces el código guardado no cambia, así que ninguna
// sincronización de fondo manda la cola al espacio nuevo. `confirmFn(texto)` es síncrona (como `confirm`):
// entre la confirmación y el cambio no corre ningún temporizador.
// Devuelve { switched: true }, { switched: false, cancelled: true } o { switched: false, error }.
export async function trySwitchSpace(code, confirmFn) {
  let info;
  try {
    info = await probe(code);
  } catch (error) {
    return { switched: false, error };
  }
  const n = discardCount(info.space);
  if (n > 0 && !confirmFn(`Hay ${n} gasto(s) sin enviar del espacio anterior. Si entras con este código se descartarán. ¿Continuar?`)) {
    return { switched: false, cancelled: true };
  }
  setPass(code);
  adoptSpace(info.space);
  return { switched: true };
}
// Respaldo: copia fresca de todo lo que hay en el servidor (viajes, personas, medios de pago y gastos).
export const backupData = () => request('GET', '/api/backup');
// Restaurar un respaldo: solo agrega lo que falta. Con dry=true solo cuenta qué entraría.
export async function restoreBackup(data, dry) {
  const out = await request('POST', `/api/restore${dry ? '?dry=1' : ''}`, data);
  if (!dry) await refresh();
  return out;
}
// Espacios (solo con ADMIN_PASSCODE: con otro código, o sin esa variable, el servidor responde 404). No refrescan el
// estado: no cambian lo que ve el administrador. El código en claro solo viene al crear y al regenerar: quien llama no
// debe guardarlo.
export const listSpaces = () => request('GET', '/api/spaces');
export const createSpace = (name) => request('POST', '/api/spaces', { name });
export const regenerateSpace = (id) => request('POST', `/api/spaces/${encodeURIComponent(id)}/regenerate`);
export const renameSpace = (id, name) => request('PUT', `/api/spaces/${encodeURIComponent(id)}`, { name });
export const setSpaceActive = (id, active) => request('PUT', `/api/spaces/${encodeURIComponent(id)}`, { active });
