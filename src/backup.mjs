// Respaldo y restauración de los datos de un espacio (viajes, personas, medios de pago, gastos y abonos).
//
// El respaldo es una copia cruda de las tablas (no el estado que ve la pantalla), así que conserva también
// los gastos con medio "por definir", las tasas guardadas, el orden manual y la hora de creación.
//
// Restaurar es aditivo: solo agrega lo que falta (por id) y nunca borra ni pisa lo que ya existe. Así se
// puede recuperar algo borrado, o llenar una base vacía, sin perder lo que se hizo después del respaldo.
// Todo se valida antes de escribir y se escribe en una sola transacción: o entra todo, o no entra nada.
import { createHash } from 'node:crypto';
import { isValidDate } from '../public/js/money.mjs';
import { currencyByCode } from '../public/js/currencies.mjs';
import { NETWORKS, isHexColor } from '../public/js/cards.mjs';

// Id de la copia de una fila ajena: siempre el mismo para el mismo espacio, tabla e id original, con forma de UUID.
function derivedId(space, table, id) {
  const h = createHash('sha256').update(`${space}\0${table}\0${id}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

const BACKUP_APP = 'gastos-viaje';
const BACKUP_VERSION = 1;
const LIMIT = 20000; // filas por tabla: un tope para que un archivo absurdo no atasque el servidor
const MAX_CENTS = 5e9;
const TABLES = ['people', 'trips', 'trip_people', 'payment_methods', 'expenses', 'expense_beneficiaries'];
// Secciones que los respaldos anteriores no traen: si faltan, se tratan como vacías.
const OPTIONAL_TABLES = ['payments'];

// Exige el espacio: sin él no se arma ninguna consulta (nunca se cae a "toda la base").
function needSpace(sp) {
  if (typeof sp !== 'string' || !sp) throw new Error('Falta el espacio');
}

// Respaldo de un solo espacio: sus personas, viajes y medios de pago, y los gastos, abonos y vínculos de sus viajes.
// El archivo tiene el mismo formato de siempre: no trae la tabla de espacios ni la columna space_id.
export async function dumpBackup(db, sp) {
  needSpace(sp);
  const tripsOf = 'SELECT id FROM trips WHERE space_id = ?';
  const expensesOf = `SELECT e.id FROM expenses e JOIN trips t ON t.id = e.trip_id WHERE t.space_id = ?`;
  const rows = await Promise.all([
    db.all('SELECT * FROM people WHERE space_id = ? ORDER BY name COLLATE NOCASE', [sp]),
    db.all('SELECT * FROM trips WHERE space_id = ? ORDER BY rowid', [sp]),
    db.all(`SELECT tp.* FROM trip_people tp WHERE tp.trip_id IN (${tripsOf})
              AND tp.person_id IN (SELECT id FROM people WHERE space_id = ?)`, [sp, sp]),
    db.all('SELECT * FROM payment_methods WHERE space_id = ? ORDER BY name COLLATE NOCASE', [sp]),
    db.all(`SELECT * FROM expenses WHERE trip_id IN (${tripsOf}) ORDER BY date, created_at`, [sp]),
    db.all(`SELECT * FROM expense_beneficiaries WHERE expense_id IN (${expensesOf})`, [sp]),
    db.all(`SELECT * FROM payments WHERE trip_id IN (${tripsOf}) ORDER BY date, created_at`, [sp]),
  ]);
  // space_id es interno: se quita para que el archivo no cambie y se pueda restaurar en cualquier espacio.
  const clean = (list) => list.map(({ space_id: _sp, ...r }) => r);
  return {
    app: BACKUP_APP,
    version: BACKUP_VERSION,
    exportado: new Date().toISOString(),
    ...Object.fromEntries([...TABLES, ...OPTIONAL_TABLES].map((t, i) => [t, clean(rows[i])])),
  };
}

// `fail(status, mensaje)` lanza el error HTTP (lo inyecta handlers.mjs para no depender de él).
// Con dry=true solo cuenta lo que entraría; sin él, lo escribe.
// `sp` es el espacio de quien restaura: las personas, viajes y medios de pago nuevos quedan en él (sin espacio
// no los vería nadie).
// Todo se mira solo dentro del espacio: lo que ya existe, las referencias y los dueños de los medios. Una fila de
// otro espacio cuenta como inexistente. Si el archivo trae filas cuyo id ya usa otro espacio, entran como copia con
// un id nuevo (ver `remap`); nunca se toca ni se enlaza una fila de otro espacio.
export async function restoreBackup(db, data, { dry, fail, sp }) {
  needSpace(sp);
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
  for (const t of OPTIONAL_TABLES) {
    const v = data[t] ?? [];
    if (!Array.isArray(v)) fail(400, `La sección «${t}» tiene datos inválidos`);
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

  // Para cada tabla, de dónde sale y cuál es el espacio de la fila (gastos y abonos: el de su viaje). Un gasto o
  // abono sin viaje no es de ningún espacio: cuenta como ajeno.
  const SOURCES = {
    people: ['people x', 'x.space_id'],
    trips: ['trips x', 'x.space_id'],
    payment_methods: ['payment_methods x', 'x.space_id'],
    expenses: ['expenses x LEFT JOIN trips t ON t.id = x.trip_id', 't.space_id'],
    payments: ['payments x LEFT JOIN trips t ON t.id = x.trip_id', 't.space_id'],
  };
  const idsWhere = async (table, op) => {
    const [from, space] = SOURCES[table];
    return new Set((await db.all(`SELECT x.id AS id FROM ${from} WHERE ${space} ${op} ?`, [sp])).map((r) => r.id));
  };
  const have = {}; // ids que ya existen en este espacio
  const foreign = {}; // ids que existen en otro espacio (o en ninguno)
  for (const table of Object.keys(SOURCES)) {
    have[table] = await idsWhere(table, 'IS');
    foreign[table] = await idsWhere(table, 'IS NOT');
  }
  // Un id del archivo que ya usa otro espacio no se puede reutilizar (por ejemplo, el respaldo de un espacio que se
  // restaura en otro): esa fila entra como copia con un id nuevo, derivado del espacio y del id original. Al ser
  // derivado, restaurar el mismo archivo otra vez cae en las filas ya copiadas y las omite en vez de duplicarlas.
  // Las referencias del archivo a esas filas se reescriben igual. Los ids propios y los nuevos no cambian.
  const remap = Object.fromEntries(Object.keys(SOURCES).map((t) => [t, new Map()]));
  for (const t of Object.keys(SOURCES)) {
    for (const r of file[t]) if (isId(r.id) && foreign[t].has(r.id)) remap[t].set(r.id, derivedId(sp, t, r.id));
  }
  const remapped = (rows, fields) => rows.map((r) => {
    const out = { ...r };
    for (const [field, table] of fields) if (typeof out[field] === 'string') out[field] = remap[table].get(out[field]) ?? out[field];
    return out;
  });
  file.people = remapped(file.people, [['id', 'people']]);
  file.trips = remapped(file.trips, [['id', 'trips']]);
  file.payment_methods = remapped(file.payment_methods, [['id', 'payment_methods'], ['owner_person_id', 'people']]);
  file.expenses = remapped(file.expenses, [['id', 'expenses'], ['trip_id', 'trips'], ['payment_method_id', 'payment_methods']]);
  file.payments = remapped(file.payments, [['id', 'payments'], ['trip_id', 'trips'], ['from_person_id', 'people'], ['to_person_id', 'people']]);
  file.expense_beneficiaries = remapped(file.expense_beneficiaries, [['expense_id', 'expenses'], ['person_id', 'people']]);
  file.trip_people = remapped(file.trip_people, [['trip_id', 'trips'], ['person_id', 'people']]);

  const known = (table) => (id) => have[table].has(id) || newIds[table].has(id);
  const newIds = { people: new Set(), trips: new Set(), payment_methods: new Set(), expenses: new Set(), payments: new Set() };
  const skip = { people: 0, trips: 0, payment_methods: 0, expenses: 0, payments: 0 };
  const stmts = { people: [], trips: [], trip_people: [], payment_methods: [], expenses: [], expense_beneficiaries: [], payments: [] };

  // Primero se decide qué falta (por id); las referencias se comprueban después contra "lo que ya hay + lo que entra".
  const pick = (table) => {
    const out = [];
    const seen = new Set();
    for (const r of file[table]) {
      if (!isId(r.id)) bad(table);
      if (seen.has(r.id)) bad(`${table} repetido`, r.id);
      seen.add(r.id);
      if (foreign[table].has(r.id)) bad(table); // sin el id: no se confirma qué existe en otro espacio
      if (have[table].has(r.id)) skip[table] += 1;
      else { out.push(r); newIds[table].add(r.id); }
    }
    return out;
  };
  const people = pick('people');
  const trips = pick('trips');
  const methods = pick('payment_methods');
  const expenses = pick('expenses');
  const payments = pick('payments');

  for (const p of people) {
    const name = str(p.name, 80, { required: true });
    if (!name?.trim()) bad('persona', p.id);
    stmts.people.push({ sql: 'INSERT INTO people (id, name, space_id) VALUES (?, ?, ?)', args: [p.id, name.trim(), sp] });
  }

  for (const t of trips) {
    const name = str(t.name, 40, { required: true });
    if (!name?.trim() || !currencyByCode(t.dest_currency) || !currencyByCode(t.home_currency) || t.dest_currency === t.home_currency) bad('viaje', t.id);
    const created = str(t.created_at, 40) || new Date().toISOString();
    stmts.trips.push({
      sql: 'INSERT INTO trips (id, name, dest_currency, home_currency, created_at, space_id) VALUES (?, ?, ?, ?, ?, ?)',
      args: [t.id, name.trim(), t.dest_currency, t.home_currency, created, sp],
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
      sql: `INSERT INTO payment_methods (id, kind, name, last4, card_type, owner_person_id, color, network, space_id)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [m.id, m.kind, name.trim(), last4, m.card_type ?? null, m.owner_person_id, m.color || null, m.network ?? null, sp],
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
    const rateSource = str(e.rate_source, 40);
    const flags = [e.amount_approx, e.pay_pending].map(flag);
    if (!isValidDate(e.date) || !Number.isInteger(cents) || cents <= 0 || cents > MAX_CENTS) bad('gasto', e.id);
    if (rate === undefined || lat === undefined || lng === undefined || description === null || place === null || rateSource === null || flags.includes(undefined)) bad('gasto', e.id);
    if (e.rate_date != null && !isValidDate(e.rate_date)) bad('gasto', e.id);
    if (e.currency != null && !currencyByCode(e.currency)) bad('gasto', e.id); // vacío = moneda del destino (copias anteriores)
    if ((lat == null) !== (lng == null)) bad('gasto', e.id);
    if (e.sort_order != null && !Number.isInteger(e.sort_order)) bad('gasto', e.id);
    if (!known('trips')(e.trip_id)) bad('el viaje de un gasto no existe', e.id);
    if (!known('payment_methods')(e.payment_method_id)) bad('el medio de pago de un gasto no existe', e.id);
    if (!links.get(e.id)?.size) bad('un gasto sin personas', e.id);
    stmts.expenses.push({
      sql: `INSERT INTO expenses (id, date, amount_cents, description, payment_method_id, rate, rate_date, rate_source,
              created_at, trip_id, lat, lng, place, amount_approx, sort_order, pay_pending, currency)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [e.id, e.date, cents, description, e.payment_method_id, rate, rate == null ? null : (e.rate_date ?? e.date), rate == null ? null : (rateSource || null),
        str(e.created_at, 40) || new Date().toISOString(), e.trip_id, lat, lng, place || null, flags[0], e.sort_order ?? null, flags[1], e.currency ?? null],
    });
    for (const p of links.get(e.id)) {
      stmts.expense_beneficiaries.push({ sql: 'INSERT OR IGNORE INTO expense_beneficiaries (expense_id, person_id) VALUES (?, ?)', args: [e.id, p] });
    }
  }

  for (const p of payments) {
    const cents = p.amount_cents;
    const rate = optNum(p.rate, 0, 1e9);
    const note = str(p.note, 120);
    const rateSource = str(p.rate_source, 40);
    if (!isValidDate(p.date) || !Number.isInteger(cents) || cents <= 0 || cents > MAX_CENTS) bad('abono', p.id);
    if (rate === undefined || note === null || rateSource === null) bad('abono', p.id);
    if (p.rate_date != null && !isValidDate(p.rate_date)) bad('abono', p.id);
    if (p.currency != null && !currencyByCode(p.currency)) bad('abono', p.id);
    if (!known('trips')(p.trip_id)) bad('el viaje de un abono no existe', p.id);
    if (!known('people')(p.from_person_id) || !known('people')(p.to_person_id) || p.from_person_id === p.to_person_id) bad('las personas de un abono', p.id);
    stmts.payments.push({
      sql: `INSERT INTO payments (id, trip_id, from_person_id, to_person_id, date, amount_cents, currency, rate, rate_date, rate_source, note, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [p.id, p.trip_id, p.from_person_id, p.to_person_id, p.date, cents, p.currency ?? null, rate, rate == null ? null : (p.rate_date ?? p.date),
        rate == null ? null : (rateSource || null), note, str(p.created_at, 40) || new Date().toISOString()],
    });
  }

  // Quién va en cada viaje: los viajes nuevos con su lista; en un viaje que ya existe solo se completan las
  // personas que hacen falta para los gastos que entran (no se vuelve a agregar a quien se quitó a propósito).
  const owners = new Map((await db.all('SELECT id, owner_person_id FROM payment_methods WHERE space_id = ?', [sp])).map((m) => [m.id, m.owner_person_id]));
  for (const m of methods) owners.set(m.id, m.owner_person_id);
  const needed = new Map(); // trip_id -> Set(person_id) de los gastos que entran
  for (const e of expenses) {
    if (!needed.has(e.trip_id)) needed.set(e.trip_id, new Set());
    for (const p of links.get(e.id)) needed.get(e.trip_id).add(p);
    const owner = owners.get(e.payment_method_id);
    if (owner) needed.get(e.trip_id).add(owner);
  }
  for (const p of payments) { // quienes se pagaron también tienen que ir en el viaje
    if (!needed.has(p.trip_id)) needed.set(p.trip_id, new Set());
    needed.get(p.trip_id).add(p.from_person_id).add(p.to_person_id);
  }
  for (const l of file.trip_people) {
    if (!isId(l.trip_id) || !isId(l.person_id)) bad('quién va en un viaje');
    const isNewTrip = newIds.trips.has(l.trip_id);
    if (!isNewTrip && !(needed.get(l.trip_id)?.has(l.person_id))) continue;
    if (!known('trips')(l.trip_id) || !known('people')(l.person_id)) bad('quién va en un viaje');
    stmts.trip_people.push({ sql: 'INSERT OR IGNORE INTO trip_people (trip_id, person_id) VALUES (?, ?)', args: [l.trip_id, l.person_id] });
  }

  const add = { trips: trips.length, people: people.length, payment_methods: methods.length, expenses: expenses.length, payments: payments.length };
  if (!dry) {
    const all = [...stmts.people, ...stmts.trips, ...stmts.trip_people, ...stmts.payment_methods, ...stmts.expenses, ...stmts.expense_beneficiaries, ...stmts.payments];
    // Las tablas con id usan INSERT simple: si entre la validación y esta escritura otro espacio ocupó un id, la
    // transacción entera se deshace en vez de saltarse esa fila en silencio (y dejar lo demás colgado de ella).
    // Solo los vínculos (trip_people, expense_beneficiaries) toleran repetidos.
    try {
      if (all.length) await db.batch(all);
    } catch (err) {
      if (/constraint/i.test(err?.message ?? '')) fail(409, 'Los datos cambiaron mientras se restauraba. No se guardó nada: vuelve a intentarlo.');
      throw err;
    }
  }
  return { dry: Boolean(dry), add, skip };
}
