// API sin dependencias de servidor: recibe una petición simple y devuelve { status, body }.
// La usan server.mjs (local) y netlify/functions/api.mjs (en línea).
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { isValidDate, toHome, todayStr } from '../public/js/money.mjs';
import { currencyByCode } from '../public/js/currencies.mjs';
import { NETWORKS, isHexColor } from '../public/js/cards.mjs';
import { rateHistory, refreshRates, resolveRate } from './rates.mjs';

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const fail = (status, message) => {
  throw new HttpError(status, message);
};

const sha = (s) => createHash('sha256').update(String(s)).digest();

// Topes para que un dato absurdo no desborde los cálculos (cents * rate debe quedar bajo 2^53).
const MAX_CENTS = 5e9;
const MAX_FAILS = 10;
const MAX_GLOBAL = 300;
const LOCK_MS = 15 * 60 * 1000;

export function isAuthorized(passcode) {
  const expected = process.env.APP_PASSCODE;
  if (!expected) return true;
  return timingSafeEqual(sha(passcode ?? ''), sha(expected));
}

// Agrupa las IPv6 por su prefijo /64 (un atacante suele controlar una red completa) y deja las IPv4 igual.
function ipKey(ip) {
  if (!ip) return 'desconocida';
  let v = String(ip).toLowerCase();
  const mapped = v.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return mapped[1];
  if (!v.includes(':')) return v;
  const [head, tail = ''] = v.split('::');
  const h = head ? head.split(':') : [];
  const t = tail ? tail.split(':') : [];
  const groups = v.includes('::') ? [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill('0'), ...t] : h;
  return `${groups.slice(0, 4).map((g) => g || '0').join(':')}::/64`;
}

// Suma un intento de forma atómica (una sola sentencia, sin leer y luego escribir) y devuelve el total
// dentro de la ventana de bloqueo. Si la ventana venció, empieza de cero.
async function countAttempt(db, key, now) {
  const rows = await db.all(
    `INSERT INTO auth_failures (ip, fails, since) VALUES (?, 1, ?)
     ON CONFLICT(ip) DO UPDATE SET
       fails = CASE WHEN ? - since >= ? THEN 1 ELSE fails + 1 END,
       since = CASE WHEN ? - since >= ? THEN ? ELSE since END
     RETURNING fails`,
    [key, now, now, LOCK_MS, now, LOCK_MS, now],
  );
  return Number(rows[0].fails);
}

// Verifica el código con límite de intentos: por red (10 cada 15 min) y global (300 cada 15 min).
// Cada intento con código se cuenta ANTES de compararlo, así que aunque lleguen en paralelo solo
// se evalúan los primeros. Entrar sin código (primera visita) no cuenta.
// Compromiso: el límite global también permite que alguien bloquee a propósito por 15 minutos.
async function checkAuth(db, passcode, ip) {
  if (!process.env.APP_PASSCODE) return;
  if (!passcode) fail(401, 'Código incorrecto');
  const now = Date.now();
  const key = ipKey(ip);
  const [mine, all] = [await countAttempt(db, key, now), await countAttempt(db, 'global', now)];
  if (mine > MAX_FAILS || all > MAX_GLOBAL) fail(429, 'Demasiados intentos. Espera 15 minutos.');
  if (isAuthorized(passcode)) {
    // acierto: este intento no cuenta contra nadie
    await db.run('DELETE FROM auth_failures WHERE ip = ?', [key]);
    await db.run('UPDATE auth_failures SET fails = MAX(fails - 1, 0) WHERE ip = ?', ['global']);
    return;
  }
  await db.run('DELETE FROM auth_failures WHERE since < ? AND ip != ?', [now - LOCK_MS, 'global']); // limpieza
  fail(401, 'Código incorrecto');
}

function text(value, label, { max = 80, required = true } = {}) {
  const s = String(value ?? '').trim();
  if (required && !s) fail(400, `${label} es obligatorio`);
  if (s.length > max) fail(400, `${label} es muy largo`);
  return s;
}

// ---------- viajes ----------

// Sin id devuelve el primero (el más antiguo): así responden las peticiones viejas que no traen viaje.
async function getTrip(db, id) {
  const rows = id
    ? await db.all('SELECT * FROM trips WHERE id = ?', [id])
    : await db.all('SELECT * FROM trips ORDER BY rowid LIMIT 1');
  if (!rows.length) fail(400, 'El viaje no existe');
  return rows[0];
}

const tripPair = (t) => ({ dest: t.dest_currency, home: t.home_currency });

async function tripPeople(db, tripId) {
  const rows = await db.all('SELECT person_id FROM trip_people WHERE trip_id = ?', [tripId]);
  return new Set(rows.map((r) => r.person_id));
}

// Quién aparece en los gastos de un viaje: como beneficiario o como dueño del medio con que se pagó.
async function peopleInTripExpenses(db, tripId) {
  const rows = await db.all(
    `SELECT eb.person_id AS p FROM expense_beneficiaries eb JOIN expenses e ON e.id = eb.expense_id WHERE e.trip_id = ?
     UNION
     SELECT m.owner_person_id FROM expenses e JOIN payment_methods m ON m.id = e.payment_method_id WHERE e.trip_id = ?`,
    [tripId, tripId],
  );
  return new Set(rows.map((r) => r.p));
}

async function saveTrip(db, id, body) {
  const name = text(body.name, 'El nombre del viaje', { max: 40 });
  if (!currencyByCode(body.dest) || !currencyByCode(body.home)) fail(400, 'Moneda no válida');
  if (body.dest === body.home) fail(400, 'El país del viaje y tu moneda deben ser distintos');

  const prev = (await db.all('SELECT * FROM trips WHERE id = ?', [id]))[0];
  let ids;
  if (Array.isArray(body.people_ids)) {
    ids = [...new Set(body.people_ids)];
    if (ids.length) {
      const found = await db.all(`SELECT id FROM people WHERE id IN (${ids.map(() => '?').join(',')})`, ids);
      if (found.length !== ids.length) fail(400, 'Alguna persona no existe');
    }
  } else {
    // Sin lista: viaje nuevo con todas las personas; viaje existente, sin cambios.
    ids = prev ? [...(await tripPeople(db, id))] : (await db.all('SELECT id FROM people')).map((p) => p.id);
  }

  if (prev) {
    const used = (await db.all('SELECT COUNT(*) AS n FROM expenses WHERE trip_id = ?', [id]))[0].n;
    if (used > 0 && (prev.dest_currency !== body.dest || prev.home_currency !== body.home)) {
      fail(409, 'Este viaje ya tiene gastos: borra sus gastos para cambiar el país o la moneda');
    }
    const keep = new Set(ids);
    const inUse = await peopleInTripExpenses(db, id);
    const names = [];
    for (const p of await tripPeople(db, id)) {
      if (!keep.has(p) && inUse.has(p)) names.push((await db.all('SELECT name FROM people WHERE id = ?', [p]))[0]?.name ?? '¿?');
    }
    if (names.length) fail(409, `No se puede quitar a ${names.join(', ')}: tiene gastos en este viaje`);
  }

  await db.batch([
    {
      sql: `INSERT INTO trips (id, name, dest_currency, home_currency, created_at) VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET name = excluded.name,
              dest_currency = excluded.dest_currency, home_currency = excluded.home_currency`,
      args: [id, name, body.dest, body.home, new Date().toISOString()],
    },
    { sql: 'DELETE FROM trip_people WHERE trip_id = ?', args: [id] },
    ...ids.map((p) => ({ sql: 'INSERT INTO trip_people (trip_id, person_id) VALUES (?, ?)', args: [id, p] })),
  ]);
  return { id, name, dest: body.dest, home: body.home, people_ids: ids };
}

async function deleteTrip(db, id, withExpenses) {
  const trips = await db.all('SELECT id FROM trips');
  if (!trips.some((t) => t.id === id)) return;
  if (trips.length === 1) fail(400, 'No se puede borrar el único viaje');
  const n = (await db.all('SELECT COUNT(*) AS n FROM expenses WHERE trip_id = ?', [id]))[0].n;
  if (n > 0 && !withExpenses) fail(409, `Este viaje tiene ${n} gasto(s). Confirma para borrarlos junto con el viaje`);
  await db.batch([
    { sql: 'DELETE FROM expense_beneficiaries WHERE expense_id IN (SELECT id FROM expenses WHERE trip_id = ?)', args: [id] },
    { sql: 'DELETE FROM expenses WHERE trip_id = ?', args: [id] },
    { sql: 'DELETE FROM trip_people WHERE trip_id = ?', args: [id] },
    { sql: 'DELETE FROM trips WHERE id = ?', args: [id] },
  ]);
}

// ---------- personas ----------

async function savePerson(db, id, body) {
  const name = text(body.name, 'El nombre');
  const isNew = !(await db.all('SELECT id FROM people WHERE id = ?', [id])).length;
  await db.run(
    'INSERT INTO people (id, name) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET name = excluded.name',
    [id, name],
  );
  // Una persona nueva entra en el viaje indicado; sin viaje, en todos. Al renombrar no se toca nada.
  if (isNew) {
    if (body.trip_id) {
      const trip = await getTrip(db, body.trip_id);
      await db.run('INSERT OR IGNORE INTO trip_people (trip_id, person_id) VALUES (?, ?)', [trip.id, id]);
    } else {
      await db.run('INSERT OR IGNORE INTO trip_people (trip_id, person_id) SELECT id, ? FROM trips', [id]);
    }
  }
  return { id, name };
}

async function deletePerson(db, id) {
  const used = await db.all(
    `SELECT (SELECT COUNT(*) FROM payment_methods WHERE owner_person_id = ?) AS m,
            (SELECT COUNT(*) FROM expense_beneficiaries WHERE person_id = ?) AS b`,
    [id, id],
  );
  if (used[0].m > 0 || used[0].b > 0) {
    fail(409, 'No se puede borrar: tiene medios de pago o gastos asociados');
  }
  await db.batch([
    { sql: 'DELETE FROM trip_people WHERE person_id = ?', args: [id] },
    { sql: 'DELETE FROM people WHERE id = ?', args: [id] },
  ]);
}

// ---------- medios de pago ----------

async function saveMethod(db, id, body) {
  const kind = body.kind;
  if (!['card', 'pix', 'cash'].includes(kind)) fail(400, 'Tipo de medio de pago inválido');
  const name = text(body.name, 'El nombre');
  let last4 = null;
  let cardType = null;
  let network = null;
  if (kind === 'card') {
    // Hay tarjetas sin número visible: los últimos 4 son opcionales.
    const raw = String(body.last4 ?? '').trim();
    if (raw) {
      if (!/^\d{4}$/.test(raw)) fail(400, 'Los últimos dígitos deben ser 4 números');
      last4 = raw;
    }
    cardType = body.card_type;
    if (!['debit', 'credit'].includes(cardType)) fail(400, 'Indica si es débito o crédito');
    if (body.network) {
      if (!Object.hasOwn(NETWORKS, body.network)) fail(400, 'Red de tarjeta inválida');
      network = body.network;
    }
  }
  let color = null;
  if (body.color) {
    if (!isHexColor(body.color)) fail(400, 'Color inválido');
    color = body.color;
  }
  if (!body.owner_person_id) fail(400, 'Elige de quién es el medio de pago');
  const owner = await db.all('SELECT id FROM people WHERE id = ?', [body.owner_person_id]);
  if (!owner.length) fail(400, 'El dueño no existe');
  await db.run(
    `INSERT INTO payment_methods (id, kind, name, last4, card_type, owner_person_id, color, network)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET kind = excluded.kind, name = excluded.name,
       last4 = excluded.last4, card_type = excluded.card_type,
       owner_person_id = excluded.owner_person_id,
       color = excluded.color, network = excluded.network`,
    [id, kind, name, last4, cardType, body.owner_person_id, color, network],
  );
  return { id, kind, name, last4, card_type: cardType, owner_person_id: body.owner_person_id, color, network };
}

async function deleteMethod(db, id) {
  const used = await db.all('SELECT COUNT(*) AS n FROM expenses WHERE payment_method_id = ?', [id]);
  if (used[0].n > 0) fail(409, 'No se puede borrar: tiene gastos asociados');
  await db.run('DELETE FROM payment_methods WHERE id = ?', [id]);
}

// ---------- gastos ----------

async function saveExpense(db, id, body) {
  if (!isValidDate(body.date)) fail(400, 'Fecha inválida');
  const cents = Number(body.amount_cents);
  if (!Number.isInteger(cents) || cents <= 0) fail(400, 'El monto debe ser mayor a cero');
  if (cents > MAX_CENTS) fail(400, 'El monto es demasiado grande');
  const description = text(body.description, 'La descripción', { max: 120, required: false });

  // Un gasto que ya existe conserva su viaje. Uno nuevo va al viaje indicado; sin viaje (colas guardadas antes
  // de que hubiera varios viajes) va al primero.
  const prevTrip = (await db.all('SELECT trip_id FROM expenses WHERE id = ?', [id]))[0]?.trip_id;
  const trip = await getTrip(db, prevTrip ?? body.trip_id);
  const settings = tripPair(trip);
  const going = await tripPeople(db, trip.id);

  const method = await db.all('SELECT id, owner_person_id FROM payment_methods WHERE id = ?', [body.payment_method_id]);
  if (!method.length) fail(400, 'El medio de pago no existe');
  if (!going.has(method[0].owner_person_id)) fail(400, 'El dueño de ese medio de pago no va en este viaje');

  const ids = [...new Set(body.beneficiary_ids ?? [])];
  if (!ids.length) fail(400, 'Indica para quién es el gasto');
  const marks = ids.map(() => '?').join(',');
  const found = await db.all(`SELECT id FROM people WHERE id IN (${marks})`, ids);
  if (found.length !== ids.length) fail(400, 'Alguna persona no existe');
  if (ids.some((p) => !going.has(p))) fail(400, 'Alguna persona no va en este viaje');

  const homeDigits = currencyByCode(settings.home).digits;
  // La tasa siempre sale de la fuente (ya no hay tasa manual). La columna rate_manual queda en 0.
  let rate = null;
  let rateDate = null;
  let estimated = 0;
  const r = await resolveRate(db, body.date, settings);
  if (r) {
    rate = r.rate;
    rateDate = r.rate_date;
    estimated = r.estimated ? 1 : 0;
  }
  const amountHome = rate == null ? null : toHome(cents, rate, homeDigits);

  // Ubicación opcional: o vienen lat y lng válidas, o ninguna. Vacío (null, undefined, '') = sin ubicación.
  const blank = (v) => v == null || v === '';
  let lat = null;
  let lng = null;
  let place = null;
  if (!blank(body.lat) || !blank(body.lng)) {
    lat = Number(body.lat);
    lng = Number(body.lng);
    if (blank(body.lat) || blank(body.lng) || !Number.isFinite(lat) || !Number.isFinite(lng)
      || lat < -90 || lat > 90 || lng < -180 || lng > 180) fail(400, 'La ubicación no es válida');
    place = text(body.place, 'El lugar', { max: 120, required: false }) || null;
  }
  const approx = body.amount_approx ? 1 : 0;

  await db.batch([
    {
      sql: `INSERT INTO expenses (id, date, amount_cents, description, payment_method_id,
              rate, rate_date, rate_estimated, rate_manual, amount_home, created_at, trip_id,
              lat, lng, place, amount_approx)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET date = excluded.date,
              amount_cents = excluded.amount_cents, description = excluded.description,
              payment_method_id = excluded.payment_method_id,
              rate = excluded.rate, rate_date = excluded.rate_date,
              rate_estimated = excluded.rate_estimated, rate_manual = excluded.rate_manual,
              amount_home = excluded.amount_home,
              lat = excluded.lat, lng = excluded.lng, place = excluded.place,
              amount_approx = excluded.amount_approx,
              sort_order = CASE WHEN date <> excluded.date THEN NULL ELSE sort_order END`,
      args: [id, body.date, cents, description, body.payment_method_id, rate, rateDate,
        estimated, 0, amountHome, new Date().toISOString(), trip.id,
        lat, lng, place, approx],
    },
    { sql: 'DELETE FROM expense_beneficiaries WHERE expense_id = ?', args: [id] },
    ...ids.map((p) => ({
      sql: 'INSERT INTO expense_beneficiaries (expense_id, person_id) VALUES (?, ?)',
      args: [id, p],
    })),
  ]);
  return { id };
}

// Orden manual de los gastos de un día: la lista de ids, de arriba a abajo. Es idempotente; los ids que ya no
// existen se ignoran (por ejemplo, un gasto borrado desde otro celular).
async function saveOrder(db, body) {
  const ids = body?.ids;
  if (!Array.isArray(ids) || ids.length > 500 || ids.some((i) => typeof i !== 'string' || !i || i.length > 100)) fail(400, 'Orden inválido');
  if (ids.length) await db.batch(ids.map((id, i) => ({ sql: 'UPDATE expenses SET sort_order = ? WHERE id = ?', args: [i, id] })));
  return { ok: true };
}

async function deleteExpense(db, id) {
  await db.batch([
    { sql: 'DELETE FROM expense_beneficiaries WHERE expense_id = ?', args: [id] },
    { sql: 'DELETE FROM expenses WHERE id = ?', args: [id] },
  ]);
}

// "Actualizar tasas": revisa los gastos del viaje contra la tasa que hoy da la fuente para el día de cada uno.
// Con ?dry=1 solo cuenta qué cambiaría; sin él corrige las tasas guardadas y los montos de esos gastos.
async function refreshTripRates(db, query) {
  const trip = await getTrip(db, query.get('trip'));
  const dry = query.get('dry') === '1';
  const settings = tripPair(trip);
  const digits = currencyByCode(settings.home).digits;
  const rows = await db.all(
    'SELECT id, date, amount_cents, amount_home, rate, rate_estimated FROM expenses WHERE trip_id = ? AND rate_manual = 0',
    [trip.id],
  );
  const dates = [...new Set(rows.map((r) => r.date))].sort().slice(-120);
  let fresh;
  try {
    fresh = await refreshRates(db, settings, dates, { save: !dry });
  } catch {
    fail(503, 'No se pudo consultar la fuente de tasas. Intenta de nuevo con internet.');
  }
  let changed = 0;
  let unchanged = 0;
  let noData = 0;
  let before = 0;
  let after = 0;
  const updates = [];
  for (const e of rows) {
    const rate = fresh.get(e.date);
    before += e.amount_home ?? 0;
    if (rate == null) { // la fuente no trae ese día (o hoy aún no lo publica): no se toca
      noData += 1;
      after += e.amount_home ?? 0;
      continue;
    }
    const home = toHome(e.amount_cents, rate, digits);
    after += home;
    if (e.amount_home === home && e.rate === rate && !e.rate_estimated) { unchanged += 1; continue; }
    changed += 1;
    updates.push({
      sql: 'UPDATE expenses SET rate = ?, rate_date = ?, rate_estimated = 0, amount_home = ? WHERE id = ?',
      args: [rate, e.date, home, e.id],
    });
  }
  if (!dry && updates.length) await db.batch(updates);
  return { dry, changed, unchanged, no_data: noData, total_before: before, total_after: after };
}

// Gastos sin tasa (se guardaron sin internet) o con tasa estimada: reintenta conseguirla.
async function fillPendingRates(db) {
  const rows = await db.all(
    `SELECT e.id, e.date, e.amount_cents, e.amount_home, e.rate_estimated, e.rate_date,
            t.dest_currency, t.home_currency
     FROM expenses e JOIN trips t ON t.id = e.trip_id
     WHERE e.rate_manual = 0 AND (e.amount_home IS NULL OR e.rate_estimated = 1)
     ORDER BY e.date DESC LIMIT 8`,
  );
  for (const e of rows) {
    const homeDigits = currencyByCode(e.home_currency).digits;
    const r = await resolveRate(db, e.date, { dest: e.dest_currency, home: e.home_currency });
    if (!r) continue;
    const same = e.amount_home != null && r.estimated === Boolean(e.rate_estimated) && r.rate_date === e.rate_date;
    if (same) continue;
    await db.run(
      `UPDATE expenses SET rate = ?, rate_date = ?, rate_estimated = ?, amount_home = ?
       WHERE id = ?`,
      [r.rate, r.rate_date, r.estimated ? 1 : 0, toHome(e.amount_cents, r.rate, homeDigits), e.id],
    );
  }
}

async function getState(db) {
  await fillPendingRates(db);
  const [trips, tripLinks, people, methods, expenses, links] = await Promise.all([
    db.all('SELECT * FROM trips ORDER BY rowid'),
    db.all('SELECT trip_id, person_id FROM trip_people'),
    db.all('SELECT id, name FROM people ORDER BY name COLLATE NOCASE'),
    db.all('SELECT id, kind, name, last4, card_type, owner_person_id, color, network FROM payment_methods ORDER BY name COLLATE NOCASE'),
    db.all('SELECT * FROM expenses ORDER BY date DESC, created_at DESC'),
    db.all('SELECT expense_id, person_id FROM expense_beneficiaries'),
  ]);
  const byExpense = new Map();
  for (const l of links) {
    if (!byExpense.has(l.expense_id)) byExpense.set(l.expense_id, []);
    byExpense.get(l.expense_id).push(l.person_id);
  }
  const byTrip = new Map();
  for (const l of tripLinks) {
    if (!byTrip.has(l.trip_id)) byTrip.set(l.trip_id, []);
    byTrip.get(l.trip_id).push(l.person_id);
  }
  return {
    today: todayStr(),
    trips: trips.map((t) => ({ id: t.id, name: t.name, dest: t.dest_currency, home: t.home_currency, people_ids: byTrip.get(t.id) ?? [] })),
    people,
    payment_methods: methods,
    expenses: expenses.map((e) => ({ ...e, beneficiary_ids: byExpense.get(e.id) ?? [] })),
  };
}

// ---------- enrutador ----------

export async function handle({ method, path, query = new URLSearchParams(), body, passcode, ip, db }) {
  try {
    await checkAuth(db, passcode, ip);
    const parts = path.replace(/^\/api\/?/, '').split('/').filter(Boolean);
    const [resource, id] = parts;
    const put = (fn) => fn(db, id ?? body?.id ?? randomUUID(), body ?? {});
    const ok = (data, status = 200) => ({ status, body: data });

    if (resource === 'ping' && method === 'GET') return ok({ ok: true });
    if (resource === 'state' && method === 'GET') return ok(await getState(db));

    if (resource === 'trips') {
      if (method === 'POST' && !id) return ok(await put(saveTrip), 201);
      if (method === 'PUT' && id) return ok(await put(saveTrip));
      if (method === 'DELETE' && id) {
        await deleteTrip(db, id, query.get('con_gastos') === '1');
        return ok({ ok: true });
      }
    }

    // Las tasas dependen de las monedas del viaje (?trip=); sin viaje se usa el primero.
    if (resource === 'rates' && id === 'history' && method === 'GET') {
      return ok(await rateHistory(db, tripPair(await getTrip(db, query.get('trip'))), Number(query.get('days'))));
    }

    if (resource === 'rates' && id === 'refresh' && method === 'POST') return ok(await refreshTripRates(db, query));

    if (resource === 'rate' && method === 'GET') {
      const date = query.get('date') ?? todayStr();
      if (!isValidDate(date)) fail(400, 'Fecha inválida');
      const r = await resolveRate(db, date, tripPair(await getTrip(db, query.get('trip'))));
      return ok(r ?? { rate: null });
    }

    if (resource === 'order' && method === 'POST') return ok(await saveOrder(db, body));

    const writers = { people: [savePerson, deletePerson], 'payment-methods': [saveMethod, deleteMethod], expenses: [saveExpense, deleteExpense] };
    if (writers[resource]) {
      const [saver, deleter] = writers[resource];
      if (method === 'POST' && !id) return ok(await put(saver), 201);
      if (method === 'PUT' && id) return ok(await put(saver));
      if (method === 'DELETE' && id) {
        await deleter(db, id);
        return ok({ ok: true });
      }
    }
    return fail(404, 'Ruta no encontrada');
  } catch (err) {
    if (err instanceof HttpError) return { status: err.status, body: { error: err.message } };
    console.error(err);
    return { status: 500, body: { error: 'Error interno' } };
  }
}
