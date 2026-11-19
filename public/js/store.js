// Datos del navegador: llamadas a la API, copia local para leer sin internet y cola de gastos
// pendientes de enviar. Todo en localStorage (son pocos datos).
import { setCurrencies, toHome, todayStr } from './money.mjs';
import { currencyByCode, DEFAULT_SETTINGS } from './currencies.mjs';
import { compareExpenses } from './order.mjs';

const K = { state: 'bg_state2', queue: 'bg_queue', pass: 'bg_pass', rates: 'bg_rates2', hist: 'bg_hist', trip: 'bg_trip' };

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

export const net = { online: true, syncing: false, needsLogin: false, lastSync: 0 };

const getPass = () => localStorage.getItem(K.pass) ?? '';
export function setPass(p) {
  localStorage.setItem(K.pass, p);
  net.needsLogin = false;
}

const NOT_MODIFIED = Symbol('not-modified');
let stateEtag = null; // versión del estado que ya tenemos: el servidor responde 304 si no cambió

async function request(method, path, body, extraHeaders = {}) {
  let res;
  try {
    res = await fetch(path, {
      method,
      headers: { 'content-type': 'application/json', 'x-passcode': getPass(), ...extraHeaders },
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
  if (path === '/api/state' && res.ok) stateEtag = res.headers?.get?.('etag') ?? null;
  if (res.status === 401) {
    net.needsLogin = true;
    notify();
  }
  if (!res.ok) {
    const err = new Error(data?.error ?? `Error ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

// ---------- estado ----------

let server = read(K.state, { today: todayStr(), trips: [], people: [], payment_methods: [], expenses: [], payments: [] });
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
    if (err.status === 401) throw err;
    return read(K.hist, {})[key] ?? [];
  }
}

// Solo se avisa a la pantalla (y se guarda la copia local) si lo recibido es distinto de lo que ya había:
// así la sincronización periódica no redibuja ni escribe en localStorage cuando no cambió nada.
export async function refresh() {
  const wasOnline = net.online;
  try {
    const fresh = await request('GET', '/api/state', undefined, stateEtag ? { 'if-none-match': stateEtag } : {});
    net.lastSync = Date.now();
    if (fresh === NOT_MODIFIED) {
      if (!wasOnline) notify();
      return true;
    }
    const json = JSON.stringify(fresh);
    if (json !== serverJson) {
      server = fresh;
      serverJson = json;
      applySettings();
      write(K.state, server);
      rememberRates(server.expenses);
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
  if (net.syncing || !queue.length) return { sent: 0, errors: [] };
  net.syncing = true;
  notify();
  const errors = [];
  let sent = 0;
  try {
    for (const op of [...queue]) {
      try {
        if (op.op === 'save') await request('PUT', `/api/expenses/${op.id}`, op.expense);
        else if (op.op === 'order') await request('POST', '/api/order', { ids: op.ids });
        else await request('DELETE', `/api/expenses/${op.id}`);
        queue = queue.filter((o) => o !== op);
        sent += 1;
      } catch (err) {
        if (err.offline || err.status === 401) break;
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
// Respaldo: copia fresca de todo lo que hay en el servidor (viajes, personas, medios de pago y gastos).
export const backupData = () => request('GET', '/api/backup');
// Restaurar un respaldo: solo agrega lo que falta. Con dry=true solo cuenta qué entraría.
export async function restoreBackup(data, dry) {
  const out = await request('POST', `/api/restore${dry ? '?dry=1' : ''}`, data);
  if (!dry) await refresh();
  return out;
}
