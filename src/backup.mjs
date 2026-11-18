// Respaldo y restauración de toda la base (viajes, personas, medios de pago y gastos).
//
// El respaldo es una copia cruda de las tablas (no el estado que ve la pantalla), así que conserva también
// los gastos con medio "por definir", las tasas guardadas, el orden manual y la hora de creación.
//
// Restaurar es aditivo: solo agrega lo que falta (por id) y nunca borra ni pisa lo que ya existe. Así se
// puede recuperar algo borrado, o llenar una base vacía, sin perder lo que se hizo después del respaldo.
// Todo se valida antes de escribir y se escribe en una sola transacción: o entra todo, o no entra nada.
import { isValidDate } from '../public/js/money.mjs';
import { currencyByCode } from '../public/js/currencies.mjs';
import { NETWORKS, isHexColor } from '../public/js/cards.mjs';

const BACKUP_APP = 'gastos-viaje';
const BACKUP_VERSION = 1;
const LIMIT = 20000; // filas por tabla: un tope para que un archivo absurdo no atasque el servidor
const MAX_CENTS = 5e9;
const TABLES = ['people', 'trips', 'trip_people', 'payment_methods', 'expenses', 'expense_beneficiaries'];

export async function dumpBackup(db) {
  const rows = await Promise.all([
    db.all('SELECT * FROM people ORDER BY name COLLATE NOCASE'),
    db.all('SELECT * FROM trips ORDER BY rowid'),
    db.all('SELECT * FROM trip_people'),
    db.all('SELECT * FROM payment_methods ORDER BY name COLLATE NOCASE'),
    db.all('SELECT * FROM expenses ORDER BY date, created_at'),
    db.all('SELECT * FROM expense_beneficiaries'),
  ]);
  return {
    app: BACKUP_APP,
    version: BACKUP_VERSION,
    exportado: new Date().toISOString(),
    ...Object.fromEntries(TABLES.map((t, i) => [t, rows[i]])),
  };
}

// `fail(status, mensaje)` lanza el error HTTP (lo inyecta handlers.mjs para no depender de él).
// Con dry=true solo cuenta lo que entraría; sin él, lo escribe.
export async function restoreBackup(db, data, { dry, fail }) {
  if (!data || typeof data !== 'object' || Array.isArray(data) || data.app !== BACKUP_APP) {
    fail(400, 'Este archivo no es un respaldo de la app');
  }
  if (data.version !== BACKUP_VERSION) fail(400, 'La versión de este respaldo no es compatible');
  const file = {};
  for (const t of TABLES) {
    const v = data[t];
    if (!Array.isArray(v)) fail(400, `Al respaldo le falta la sección «${t}»`);
    if (v.length > LIMIT) fail(400, 'El respaldo es demasiado grande');
    if (v.some((r) => !r || typeof r !== 'object' || Array.isArray(r))) fail(400, `La sección «${t}» tiene datos inválidos`);
    file[t] = v;
  }

  const bad = (what, id) => fail(400, `El respaldo tiene datos inválidos (${what}${id ? `: ${String(id).slice(0, 40)}` : ''})`);
  const isId = (v) => typeof v === 'string' && /^[\w.:-]{1,100}$/.test(v);
  const str = (v, max, { required = false } = {}) => {
    if (v == null || v === '') return required ? null : '';
    return typeof v === 'string' && v.length <= max ? v : null;
  };
  const optNum = (v, lo, hi) => (v == null ? null : (typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi ? v : undefined));
  const flag = (v) => (v === 0 || v === 1 || v === false || v === true || v == null ? (v ? 1 : 0) : undefined);

  const existing = async (table) => new Set((await db.all(`SELECT id FROM ${table}`)).map((r) => r.id));
  const have = {
    people: await existing('people'),
    trips: await existing('trips'),
    payment_methods: await existing('payment_methods'),
    expenses: await existing('expenses'),
  };
  const known = (table) => (id) => have[table].has(id) || newIds[table].has(id);
  const newIds = { people: new Set(), trips: new Set(), payment_methods: new Set(), expenses: new Set() };
  const skip = { people: 0, trips: 0, payment_methods: 0, expenses: 0 };
  const stmts = { people: [], trips: [], trip_people: [], payment_methods: [], expenses: [], expense_beneficiaries: [] };

  // Primero se decide qué falta (por id); las referencias se comprueban después contra "lo que ya hay + lo que entra".
  const pick = (table) => {
    const out = [];
    const seen = new Set();
    for (const r of file[table]) {
      if (!isId(r.id)) bad(table);
      if (seen.has(r.id)) bad(`${table} repetido`, r.id);
      seen.add(r.id);
      if (have[table].has(r.id)) skip[table] += 1;
      else { out.push(r); newIds[table].add(r.id); }
    }
    return out;
  };
  const people = pick('people');
  const trips = pick('trips');
  const methods = pick('payment_methods');
  const expenses = pick('expenses');

  for (const p of people) {
    const name = str(p.name, 80, { required: true });
    if (!name?.trim()) bad('persona', p.id);
    stmts.people.push({ sql: 'INSERT OR IGNORE INTO people (id, name) VALUES (?, ?)', args: [p.id, name.trim()] });
  }

  for (const t of trips) {
    const name = str(t.name, 40, { required: true });
    if (!name?.trim() || !currencyByCode(t.dest_currency) || !currencyByCode(t.home_currency) || t.dest_currency === t.home_currency) bad('viaje', t.id);
    const created = str(t.created_at, 40) || new Date().toISOString();
    stmts.trips.push({
      sql: 'INSERT OR IGNORE INTO trips (id, name, dest_currency, home_currency, created_at) VALUES (?, ?, ?, ?, ?)',
      args: [t.id, name.trim(), t.dest_currency, t.home_currency, created],
    });
  }

  for (const m of methods) {
    const name = str(m.name, 80, { required: true });
    const last4 = m.last4 == null || m.last4 === '' ? null : String(m.last4);
    if (!name?.trim() || !['card', 'pix', 'cash'].includes(m.kind)) bad('medio de pago', m.id);
    if (last4 != null && !/^\d{4}$/.test(last4)) bad('medio de pago', m.id);
    if (m.card_type != null && !['debit', 'credit'].includes(m.card_type)) bad('medio de pago', m.id);
    if (m.network != null && !Object.hasOwn(NETWORKS, m.network)) bad('medio de pago', m.id);
    if (m.color != null && m.color !== '' && !isHexColor(m.color)) bad('medio de pago', m.id);
    if (!known('people')(m.owner_person_id)) bad('el dueño de un medio de pago no existe', m.id);
    stmts.payment_methods.push({
      sql: `INSERT OR IGNORE INTO payment_methods (id, kind, name, last4, card_type, owner_person_id, color, network)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [m.id, m.kind, name.trim(), last4, m.card_type ?? null, m.owner_person_id, m.color || null, m.network ?? null],
    });
  }

  const links = new Map(); // expense_id -> [person_id]
  for (const l of file.expense_beneficiaries) {
    if (!isId(l.expense_id) || !isId(l.person_id)) bad('para quién es un gasto');
    if (!newIds.expenses.has(l.expense_id)) continue; // de un gasto que ya existe: no se toca
    if (!known('people')(l.person_id)) bad('una persona de un gasto no existe', l.person_id);
    if (!links.has(l.expense_id)) links.set(l.expense_id, new Set());
    links.get(l.expense_id).add(l.person_id);
  }

  for (const e of expenses) {
    const cents = e.amount_cents;
    const rate = optNum(e.rate, 0, 1e9);
    const lat = optNum(e.lat, -90, 90);
    const lng = optNum(e.lng, -180, 180);
    const description = str(e.description, 120);
    const place = str(e.place, 120);
    const flags = [e.amount_approx, e.pay_pending].map(flag);
    if (!isValidDate(e.date) || !Number.isInteger(cents) || cents <= 0 || cents > MAX_CENTS) bad('gasto', e.id);
    if (rate === undefined || lat === undefined || lng === undefined || description === null || place === null || flags.includes(undefined)) bad('gasto', e.id);
    if (e.rate_date != null && !isValidDate(e.rate_date)) bad('gasto', e.id);
    if ((lat == null) !== (lng == null)) bad('gasto', e.id);
    if (e.sort_order != null && !Number.isInteger(e.sort_order)) bad('gasto', e.id);
    if (!known('trips')(e.trip_id)) bad('el viaje de un gasto no existe', e.id);
    if (!known('payment_methods')(e.payment_method_id)) bad('el medio de pago de un gasto no existe', e.id);
    if (!links.get(e.id)?.size) bad('un gasto sin personas', e.id);
    stmts.expenses.push({
      sql: `INSERT OR IGNORE INTO expenses (id, date, amount_cents, description, payment_method_id, rate, rate_date,
              created_at, trip_id, lat, lng, place, amount_approx, sort_order, pay_pending)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [e.id, e.date, cents, description, e.payment_method_id, rate, rate == null ? null : (e.rate_date ?? e.date),
        str(e.created_at, 40) || new Date().toISOString(), e.trip_id, lat, lng, place || null, flags[0], e.sort_order ?? null, flags[1]],
    });
    for (const p of links.get(e.id)) {
      stmts.expense_beneficiaries.push({ sql: 'INSERT OR IGNORE INTO expense_beneficiaries (expense_id, person_id) VALUES (?, ?)', args: [e.id, p] });
    }
  }

  // Quién va en cada viaje: los viajes nuevos con su lista; en un viaje que ya existe solo se completan las
  // personas que hacen falta para los gastos que entran (no se vuelve a agregar a quien se quitó a propósito).
  const owners = new Map((await db.all('SELECT id, owner_person_id FROM payment_methods')).map((m) => [m.id, m.owner_person_id]));
  for (const m of methods) owners.set(m.id, m.owner_person_id);
  const needed = new Map(); // trip_id -> Set(person_id) de los gastos que entran
  for (const e of expenses) {
    if (!needed.has(e.trip_id)) needed.set(e.trip_id, new Set());
    for (const p of links.get(e.id)) needed.get(e.trip_id).add(p);
    const owner = owners.get(e.payment_method_id);
    if (owner) needed.get(e.trip_id).add(owner);
  }
  for (const l of file.trip_people) {
    if (!isId(l.trip_id) || !isId(l.person_id)) bad('quién va en un viaje');
    const isNewTrip = newIds.trips.has(l.trip_id);
    if (!isNewTrip && !(needed.get(l.trip_id)?.has(l.person_id))) continue;
    if (!known('trips')(l.trip_id) || !known('people')(l.person_id)) bad('quién va en un viaje');
    stmts.trip_people.push({ sql: 'INSERT OR IGNORE INTO trip_people (trip_id, person_id) VALUES (?, ?)', args: [l.trip_id, l.person_id] });
  }

  const add = { trips: trips.length, people: people.length, payment_methods: methods.length, expenses: expenses.length };
  if (!dry) {
    const all = [...stmts.people, ...stmts.trips, ...stmts.trip_people, ...stmts.payment_methods, ...stmts.expenses, ...stmts.expense_beneficiaries];
    if (all.length) await db.batch(all);
  }
  return { dry: Boolean(dry), add, skip };
}
