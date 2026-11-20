// API sin dependencias de servidor: recibe una petición simple y devuelve { status, body }.
// La usan server.mjs (local) y netlify/functions/api.mjs (en línea).
import { randomUUID } from 'node:crypto';
import { isValidDate, toHome, todayStr } from '../public/js/money.mjs';
import { currencyByCode } from '../public/js/currencies.mjs';
import { NETWORKS, isHexColor } from '../public/js/cards.mjs';
import { rateHistory, refreshRates, resolveRate } from './rates.mjs';
import { dumpBackup, restoreBackup } from './backup.mjs';
import { MapLinkError, resolveMapLink } from './maplink.mjs';
import { HttpError, fail, text } from './errors.mjs';
import { checkAuth } from './auth.mjs';
import { createSpace, listSpaces, regenerateSpace, renameSpace, setSpaceActive } from './spaces.mjs';
import { assertNotForeign, owns, ownedIds } from './scope.mjs';

// Topes para que un dato absurdo no desborde los cálculos (cents * rate debe quedar bajo 2^53).
const MAX_CENTS = 5e9;

// ---------- viajes ----------

// Viaje del espacio `sp`. Sin id devuelve el primero (el más antiguo) de ese espacio: así responden las
// peticiones viejas que no traen viaje. Un viaje de otro espacio "no existe".
async function getTrip(db, sp, id) {
  const rows = id
    ? await db.all('SELECT * FROM trips WHERE id = ? AND space_id = ?', [id, sp])
    : await db.all('SELECT * FROM trips WHERE space_id = ? ORDER BY rowid LIMIT 1', [sp]);
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
     SELECT m.owner_person_id FROM expenses e JOIN payment_methods m ON m.id = e.payment_method_id WHERE e.trip_id = ? AND e.pay_pending = 0
     UNION
     SELECT from_person_id FROM payments WHERE trip_id = ?
     UNION
     SELECT to_person_id FROM payments WHERE trip_id = ?`,
    [tripId, tripId, tripId, tripId],
  );
  return new Set(rows.map((r) => r.p));
}

async function saveTrip(db, sp, id, body) {
  // Un id que ya es de otro espacio no se toca ni se copia: antes de validar nada, para no escribir nunca.
  await assertNotForeign(db, 'trips', id, sp);
  const name = text(body.name, 'El nombre del viaje', { max: 40 });
  if (!currencyByCode(body.dest) || !currencyByCode(body.home)) fail(400, 'Moneda no válida');
  if (body.dest === body.home) fail(400, 'El país del viaje y tu moneda deben ser distintos');

  const prev = (await db.all('SELECT * FROM trips WHERE id = ? AND space_id = ?', [id, sp]))[0];
  let ids;
  if (Array.isArray(body.people_ids)) {
    ids = [...new Set(body.people_ids)];
    if (ids.length && (await ownedIds(db, 'people', ids, sp)).size !== ids.length) fail(400, 'Alguna persona no existe');
  } else {
    // Sin lista: viaje nuevo con todas las personas del espacio; viaje existente, sin cambios.
    ids = prev ? [...(await tripPeople(db, id))] : (await db.all('SELECT id FROM people WHERE space_id = ?', [sp])).map((p) => p.id);
  }

  if (prev) {
    const used = (await db.all('SELECT (SELECT COUNT(*) FROM expenses WHERE trip_id = ?) + (SELECT COUNT(*) FROM payments WHERE trip_id = ?) AS n', [id, id]))[0].n;
    if (used > 0 && (prev.dest_currency !== body.dest || prev.home_currency !== body.home)) {
      fail(409, 'Este viaje ya tiene gastos: borra sus gastos para cambiar el país o la moneda');
    }
    const keep = new Set(ids);
    const inUse = await peopleInTripExpenses(db, id);
    const names = [];
    for (const p of await tripPeople(db, id)) {
      if (!keep.has(p) && inUse.has(p)) names.push((await db.all('SELECT name FROM people WHERE id = ? AND space_id = ?', [p, sp]))[0]?.name ?? '¿?');
    }
    if (names.length) fail(409, `No se puede quitar a ${names.join(', ')}: tiene gastos en este viaje`);
  }

  // El espacio se fija al crear y nunca cambia; el WHERE del ON CONFLICT es una segunda barrera.
  await db.batch([
    {
      sql: `INSERT INTO trips (id, name, dest_currency, home_currency, created_at, space_id) VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET name = excluded.name,
              dest_currency = excluded.dest_currency, home_currency = excluded.home_currency
            WHERE trips.space_id = excluded.space_id`,
      args: [id, name, body.dest, body.home, new Date().toISOString(), sp],
    },
    { sql: 'DELETE FROM trip_people WHERE trip_id IN (SELECT id FROM trips WHERE id = ? AND space_id = ?)', args: [id, sp] },
    ...ids.map((p) => ({
      sql: 'INSERT INTO trip_people (trip_id, person_id) SELECT id, ? FROM trips WHERE id = ? AND space_id = ?',
      args: [p, id, sp],
    })),
  ]);
  return { id, name, dest: body.dest, home: body.home, people_ids: ids };
}

async function deleteTrip(db, sp, id, withExpenses) {
  // Solo cuentan los viajes del espacio: un id ajeno no está en la lista y no pasa nada.
  const trips = await db.all('SELECT id FROM trips WHERE space_id = ?', [sp]);
  if (!trips.some((t) => t.id === id)) return;
  if (trips.length === 1) fail(400, 'No se puede borrar el único viaje');
  const n = (await db.all('SELECT COUNT(*) AS n FROM expenses WHERE trip_id = ?', [id]))[0].n;
  if (n > 0 && !withExpenses) fail(409, `Este viaje tiene ${n} gasto(s). Confirma para borrarlos junto con el viaje`);
  await db.batch([
    { sql: 'DELETE FROM expense_beneficiaries WHERE expense_id IN (SELECT id FROM expenses WHERE trip_id = ?)', args: [id] },
    { sql: 'DELETE FROM expenses WHERE trip_id = ?', args: [id] },
    { sql: 'DELETE FROM payments WHERE trip_id = ?', args: [id] },
    { sql: 'DELETE FROM trip_people WHERE trip_id = ?', args: [id] },
    { sql: 'DELETE FROM trips WHERE id = ?', args: [id] },
  ]);
}

// ---------- personas ----------

async function savePerson(db, sp, id, body) {
  await assertNotForeign(db, 'people', id, sp);
  const name = text(body.name, 'El nombre');
  const isNew = !(await owns(db, 'people', id, sp));
  // El viaje indicado se revisa antes de escribir: uno que no existe (o es de otro espacio) no deja la persona creada.
  const trip = isNew && body.trip_id ? await getTrip(db, sp, body.trip_id) : null;
  await db.run(
    `INSERT INTO people (id, name, space_id) VALUES (?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET name = excluded.name WHERE people.space_id = excluded.space_id`,
    [id, name, sp],
  );
  // Una persona nueva entra en el viaje indicado; sin viaje, en todos los del espacio. Al renombrar no se toca nada.
  if (isNew) {
    if (trip) {
      await db.run('INSERT OR IGNORE INTO trip_people (trip_id, person_id) VALUES (?, ?)', [trip.id, id]);
    } else {
      await db.run('INSERT OR IGNORE INTO trip_people (trip_id, person_id) SELECT id, ? FROM trips WHERE space_id = ?', [id, sp]);
    }
  }
  return { id, name };
}

async function deletePerson(db, sp, id) {
  if (!(await owns(db, 'people', id, sp))) return; // no existe o es de otro espacio: nada que borrar
  const used = await db.all(
    `SELECT (SELECT COUNT(*) FROM payment_methods WHERE owner_person_id = ?) AS m,
            (SELECT COUNT(*) FROM expense_beneficiaries WHERE person_id = ?) AS b,
            (SELECT COUNT(*) FROM payments WHERE from_person_id = ? OR to_person_id = ?) AS p`,
    [id, id, id, id],
  );
  if (used[0].m > 0 || used[0].b > 0 || used[0].p > 0) {
    fail(409, 'No se puede borrar: tiene medios de pago, gastos o abonos asociados');
  }
  await db.batch([
    { sql: 'DELETE FROM trip_people WHERE person_id = ?', args: [id] },
    { sql: 'DELETE FROM people WHERE id = ?', args: [id] },
  ]);
}

// ---------- medios de pago ----------

async function saveMethod(db, sp, id, body) {
  await assertNotForeign(db, 'payment_methods', id, sp);
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
  if (!(await owns(db, 'people', body.owner_person_id, sp))) fail(400, 'El dueño no existe');
  await db.run(
    `INSERT INTO payment_methods (id, kind, name, last4, card_type, owner_person_id, color, network, space_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET kind = excluded.kind, name = excluded.name,
       last4 = excluded.last4, card_type = excluded.card_type,
       owner_person_id = excluded.owner_person_id,
       color = excluded.color, network = excluded.network
     WHERE payment_methods.space_id = excluded.space_id`,
    [id, kind, name, last4, cardType, body.owner_person_id, color, network, sp],
  );
  return { id, kind, name, last4, card_type: cardType, owner_person_id: body.owner_person_id, color, network };
}

async function deleteMethod(db, sp, id) {
  if (!(await owns(db, 'payment_methods', id, sp))) return; // no existe o es de otro espacio: nada que borrar
  const used = await db.all('SELECT COUNT(*) AS n FROM expenses WHERE payment_method_id = ?', [id]);
  if (used[0].n > 0) fail(409, 'No se puede borrar: tiene gastos asociados');
  await db.run('DELETE FROM payment_methods WHERE id = ?', [id]);
}

// ---------- gastos ----------

async function saveExpense(db, sp, id, body) {
  // Un gasto que ya es de otro espacio no se toca ni se copia: antes de leer nada, para no escribir nunca.
  await assertNotForeign(db, 'expenses', id, sp);
  if (!isValidDate(body.date)) fail(400, 'Fecha inválida');
  const cents = Number(body.amount_cents);
  if (!Number.isInteger(cents) || cents <= 0) fail(400, 'El monto debe ser mayor a cero');
  if (cents > MAX_CENTS) fail(400, 'El monto es demasiado grande');
  const description = text(body.description, 'La descripción', { max: 120, required: false });

  // Un gasto que ya existe conserva su viaje. Uno nuevo va al viaje indicado; sin viaje (colas guardadas antes
  // de que hubiera varios viajes) va al primero.
  // (Llegado aquí, un gasto con ese id no existe o es del espacio: su viaje ya es del espacio.)
  const prevTrip = (await db.all('SELECT trip_id FROM expenses WHERE id = ?', [id]))[0]?.trip_id;
  const trip = await getTrip(db, sp, prevTrip ?? body.trip_id);
  // Moneda del gasto: la del destino del viaje (se guarda vacía), la de casa o cualquier otra del catálogo.
  const blankCur = body.currency == null || body.currency === '';
  if (!blankCur && !currencyByCode(body.currency)) fail(400, 'Moneda no válida');
  const currency = blankCur || body.currency === trip.dest_currency ? null : body.currency;
  const settings = { dest: currency ?? trip.dest_currency, home: trip.home_currency };
  const going = await tripPeople(db, trip.id);

  // Medio "por definir": se sabe que se debe el gasto pero no con qué se pagó. La columna payment_method_id
  // no admite vacío, así que se guarda un medio de relleno de alguien del viaje y se marca pay_pending.
  // Ese gasto no entra en las cuentas y el relleno no se muestra (getState lo devuelve como null).
  const payPending = body.payment_method_id == null || body.payment_method_id === '';
  let methodId = body.payment_method_id;
  if (payPending) {
    const own = await db.all('SELECT id, owner_person_id FROM payment_methods WHERE space_id = ? ORDER BY name COLLATE NOCASE', [sp]);
    const filler = own.find((m) => going.has(m.owner_person_id));
    if (!filler) fail(400, 'Agrega un medio de pago de alguien del viaje antes de registrar gastos');
    methodId = filler.id;
  } else {
    const method = await db.all('SELECT id, owner_person_id FROM payment_methods WHERE id = ? AND space_id = ?', [methodId, sp]);
    if (!method.length) fail(400, 'El medio de pago no existe');
    if (!going.has(method[0].owner_person_id)) fail(400, 'El dueño de ese medio de pago no va en este viaje');
  }

  const ids = [...new Set(body.beneficiary_ids ?? [])];
  if (!ids.length) fail(400, 'Indica para quién es el gasto');
  const marks = ids.map(() => '?').join(',');
  const found = await db.all(`SELECT id FROM people WHERE id IN (${marks}) AND space_id = ?`, [...ids, sp]);
  if (found.length !== ids.length) fail(400, 'Alguna persona no existe');
  if (ids.some((p) => !going.has(p))) fail(400, 'Alguna persona no va en este viaje');

  // La tasa siempre sale de la fuente. Solo se guarda la tasa y el día al que pertenece: el monto en tu moneda y si
  // la tasa es estimada (su día no es el del gasto) se calculan al leer, ver getState.
  let rate = null;
  let rateDate = null;
  let rateSource = null;
  const r = await resolveRate(db, body.date, settings);
  if (r) {
    rate = r.rate;
    rateDate = r.rate_date;
    rateSource = r.source;
  }
  // Al deshacer un borrado el gasto vuelve con su hora de creación y su lugar en el día. Se ignoran valores raros.
  const createdMs = typeof body.created_at === 'string' ? Date.parse(body.created_at) : NaN;
  const createdAt = Number.isFinite(createdMs) && createdMs <= Date.now() + 86400000 ? new Date(createdMs).toISOString() : new Date().toISOString();
  const sortOrder = Number.isInteger(body.sort_order) && body.sort_order >= 0 && body.sort_order < 100000 ? body.sort_order : null;

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
              rate, rate_date, rate_source, created_at, trip_id,
              lat, lng, place, amount_approx, pay_pending, sort_order, currency)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET date = excluded.date,
              amount_cents = excluded.amount_cents, description = excluded.description,
              payment_method_id = excluded.payment_method_id,
              rate = excluded.rate, rate_date = excluded.rate_date, rate_source = excluded.rate_source,
              lat = excluded.lat, lng = excluded.lng, place = excluded.place,
              amount_approx = excluded.amount_approx,
              pay_pending = excluded.pay_pending,
              currency = excluded.currency,
              sort_order = CASE WHEN date <> excluded.date THEN NULL ELSE sort_order END
            WHERE expenses.trip_id IN (SELECT id FROM trips WHERE space_id = ?)`,
      args: [id, body.date, cents, description, methodId, rate, rateDate, rateSource, createdAt, trip.id,
        lat, lng, place, approx, payPending ? 1 : 0, sortOrder, currency, sp],
    },
    // Las personas del gasto solo cambian si el gasto es del espacio (en un gasto nuevo, la fila de arriba ya
    // existe dentro de esta misma transacción).
    {
      sql: `DELETE FROM expense_beneficiaries WHERE expense_id = ?
              AND expense_id IN (SELECT e.id FROM expenses e JOIN trips t ON t.id = e.trip_id WHERE t.space_id = ?)`,
      args: [id, sp],
    },
    ...ids.map((p) => ({
      sql: `INSERT INTO expense_beneficiaries (expense_id, person_id)
            SELECT ?, ? WHERE EXISTS (SELECT 1 FROM expenses e JOIN trips t ON t.id = e.trip_id WHERE e.id = ? AND t.space_id = ?)`,
      args: [id, p, id, sp],
    })),
  ]);
  // Si entre la comprobación y la escritura otro espacio ocupó el id, la escritura no hizo nada: no se confirma.
  if (!(await owns(db, 'expenses', id, sp))) fail(404, 'No encontrado');
  return { id };
}

// Orden manual de los gastos de un día: la lista de ids, de arriba a abajo. Es idempotente; los ids que ya no
// existen se ignoran (por ejemplo, un gasto borrado desde otro celular), igual que los de otro espacio.
async function saveOrder(db, sp, body) {
  const ids = body?.ids;
  if (!Array.isArray(ids) || ids.length > 500 || ids.some((i) => typeof i !== 'string' || !i || i.length > 100)) fail(400, 'Orden inválido');
  if (ids.length) await db.batch(ids.map((id, i) => ({
    sql: 'UPDATE expenses SET sort_order = ? WHERE id = ? AND trip_id IN (SELECT id FROM trips WHERE space_id = ?)',
    args: [i, id, sp],
  })));
  return { ok: true };
}

async function deleteExpense(db, sp, id) {
  if (!(await owns(db, 'expenses', id, sp))) return; // no existe o es de otro espacio: nada que borrar
  await db.batch([
    { sql: 'DELETE FROM expense_beneficiaries WHERE expense_id = ?', args: [id] },
    { sql: 'DELETE FROM expenses WHERE id = ?', args: [id] },
  ]);
}

// ---------- abonos ----------
// Un abono es plata que una persona le pasó a otra para saldar lo que se deben. No es un gasto: no cuenta en
// los totales, solo descuenta del saldo entre las dos. Se guarda en la moneda en que se pagó, con la tasa de
// su día, igual que los gastos (el monto en tu moneda sale al leer, ver getState).

async function savePayment(db, sp, id, body) {
  await assertNotForeign(db, 'payments', id, sp);
  if (!isValidDate(body.date)) fail(400, 'Fecha inválida');
  const cents = Number(body.amount_cents);
  if (!Number.isInteger(cents) || cents <= 0) fail(400, 'El monto debe ser mayor a cero');
  if (cents > MAX_CENTS) fail(400, 'El monto es demasiado grande');
  const note = text(body.note, 'La nota', { max: 120, required: false });

  const prev = (await db.all('SELECT trip_id, created_at FROM payments WHERE id = ?', [id]))[0];
  const trip = await getTrip(db, sp, prev?.trip_id ?? body.trip_id);
  const blankCur = body.currency == null || body.currency === '';
  if (!blankCur && !currencyByCode(body.currency)) fail(400, 'Moneda no válida');
  const currency = blankCur || body.currency === trip.dest_currency ? null : body.currency;

  if (!body.from_person_id || !body.to_person_id) fail(400, 'Indica quién paga y a quién');
  if (body.from_person_id === body.to_person_id) fail(400, 'Quien paga y quien recibe deben ser personas distintas');
  const going = await tripPeople(db, trip.id);
  // Además de ir en el viaje, las dos deben ser del espacio (un vínculo roto en trip_people no basta).
  const mine = await ownedIds(db, 'people', [body.from_person_id, body.to_person_id], sp);
  if (![body.from_person_id, body.to_person_id].every((p) => going.has(p) && mine.has(String(p)))) fail(400, 'Alguna persona no va en este viaje');

  let rate = null;
  let rateDate = null;
  let rateSource = null;
  const r = await resolveRate(db, body.date, { dest: currency ?? trip.dest_currency, home: trip.home_currency });
  if (r) {
    rate = r.rate;
    rateDate = r.rate_date;
    rateSource = r.source;
  }
  await db.run(
    `INSERT INTO payments (id, trip_id, from_person_id, to_person_id, date, amount_cents, currency, rate, rate_date, rate_source, note, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET from_person_id = excluded.from_person_id, to_person_id = excluded.to_person_id,
       date = excluded.date, amount_cents = excluded.amount_cents, currency = excluded.currency,
       rate = excluded.rate, rate_date = excluded.rate_date, rate_source = excluded.rate_source, note = excluded.note
     WHERE payments.trip_id IN (SELECT id FROM trips WHERE space_id = ?)`,
    [id, trip.id, body.from_person_id, body.to_person_id, body.date, cents, currency, rate, rateDate, rateSource, note,
      prev?.created_at ?? new Date().toISOString(), sp],
  );
  // Si entre la comprobación y la escritura otro espacio ocupó el id, la escritura no hizo nada: no se confirma.
  if (!(await owns(db, 'payments', id, sp))) fail(404, 'No encontrado');
  return { id };
}

async function deletePayment(db, sp, id) {
  if (!(await owns(db, 'payments', id, sp))) return; // no existe o es de otro espacio: nada que borrar
  await db.run('DELETE FROM payments WHERE id = ?', [id]);
}

// "Actualizar tasas": revisa los gastos del viaje contra la tasa que hoy da la fuente para el día de cada uno.
// Con ?dry=1 solo cuenta qué cambiaría; sin él corrige las tasas guardadas y los montos de esos gastos.
async function refreshTripRates(db, sp, query) {
  const trip = await getTrip(db, sp, query.get('trip'));
  const dry = query.get('dry') === '1';
  const settings = tripPair(trip);
  const digits = currencyByCode(settings.home).digits;
  const rows = await db.all(
    'SELECT id, date, amount_cents, rate, rate_date, rate_source, currency FROM expenses WHERE trip_id = ?',
    [trip.id],
  );
  // Cada moneda tiene su par hacia la de casa. Las que ya están en la de casa no tienen tasa que revisar (siempre 1).
  const freshBy = new Map();
  for (const cur of new Set(rows.map((r) => r.currency ?? settings.dest))) {
    if (cur === settings.home) continue;
    const dates = [...new Set(rows.filter((r) => (r.currency ?? settings.dest) === cur).map((r) => r.date))].sort().slice(-120);
    try {
      freshBy.set(cur, await refreshRates(db, { dest: cur, home: settings.home }, dates, { save: !dry }));
    } catch {
      fail(503, 'No se pudo consultar la fuente de tasas. Intenta de nuevo con internet.');
    }
  }
  let changed = 0;
  let unchanged = 0;
  let noData = 0;
  let before = 0;
  let after = 0;
  const updates = [];
  for (const e of rows) {
    const fresh = freshBy.get(e.currency ?? settings.dest);
    if (!fresh) { // gasto en la moneda de casa: sin conversión
      const home = e.rate == null ? 0 : toHome(e.amount_cents, e.rate, digits);
      before += home;
      after += home;
      unchanged += 1;
      continue;
    }
    const got = fresh.get(e.date);
    const rate = got?.rate;
    const current = e.rate == null ? 0 : toHome(e.amount_cents, e.rate, digits);
    before += current;
    if (rate == null) { // la fuente no trae ese día (o hoy aún no lo publica): no se toca
      noData += 1;
      after += current;
      continue;
    }
    after += toHome(e.amount_cents, rate, digits);
    if (e.rate === rate && e.rate_date === e.date) {
      unchanged += 1;
      // Mismo valor: no cuenta como cambio, pero se anota la fuente si faltaba.
      if (got.source && e.rate_source !== got.source) updates.push({ sql: 'UPDATE expenses SET rate_source = ? WHERE id = ?', args: [got.source, e.id] });
      continue;
    }
    changed += 1;
    updates.push({ sql: 'UPDATE expenses SET rate = ?, rate_date = ?, rate_source = ? WHERE id = ?', args: [rate, e.date, got.source ?? null, e.id] });
  }
  if (!dry && updates.length) await db.batch(updates);
  return { dry, changed, unchanged, no_data: noData, total_before: before, total_after: after };
}

// Mantiene al día las tasas de los gastos (hasta 8 por consulta, los más recientes primero):
//  - sin tasa (se guardaron sin internet) o con tasa estimada (la del día de la tasa no es la del gasto): reintenta
//    conseguirla;
//  - de un día que ya cerró, cuya tasa no coincide con la guardada en la tabla rates para ese día: la cambia por la del
//    día cerrado. Así lo que se guardó hoy con el valor provisional de la fuente se corrige solo desde mañana, sin
//    pulsar "Actualizar tasas". No hace falta una marca aparte: la tabla rates solo guarda días cerrados, así que
//    "la tasa del gasto es la de rates" ya significa "es la definitiva", y deja de revisarse sola.
// Solo revisa filas de los viajes del espacio `sp`.
async function fillPendingRates(db, sp) {
  await fillPendingRatesOf(db, sp, 'expenses');
  await fillPendingRatesOf(db, sp, 'payments'); // los abonos tienen moneda y tasa igual que los gastos
}

// `table` es siempre una constante del código, nunca un dato de la petición.
async function fillPendingRatesOf(db, sp, table) {
  if (table !== 'expenses' && table !== 'payments') throw new Error(`Tabla no permitida: ${table}`);
  const rows = await db.all(
    `SELECT e.id, e.date, e.rate, e.rate_date, e.rate_source, COALESCE(e.currency, t.dest_currency) AS cur, t.home_currency
     FROM ${table} e JOIN trips t ON t.id = e.trip_id
     WHERE t.space_id = ? AND COALESCE(e.currency, t.dest_currency) <> t.home_currency
       AND (e.rate IS NULL OR e.rate_date <> e.date
        OR (e.date < ? AND NOT EXISTS (SELECT 1 FROM rates r
            WHERE r.pair = COALESCE(e.currency, t.dest_currency) || '-' || t.home_currency AND r.date = e.date AND r.rate = e.rate)))
     ORDER BY e.date DESC LIMIT 8`,
    [sp, todayStr()],
  );
  for (const e of rows) {
    const r = await resolveRate(db, e.date, { dest: e.cur, home: e.home_currency });
    if (!r) continue;
    // Sin red o sin dato de ese día, la tasa exacta del gasto no se cambia por una más vieja (solo se mejora una estimada).
    if (r.estimated && e.rate != null && e.rate_date === e.date) continue;
    if (r.rate === e.rate && r.rate_date === e.rate_date && (!r.source || r.source === e.rate_source)) continue;
    await db.run(`UPDATE ${table} SET rate = ?, rate_date = ?, rate_source = ? WHERE id = ?`, [r.rate, r.rate_date, r.source ?? null, e.id]);
  }
}

// Todo lo del espacio `sp` y nada más: los gastos, los abonos y los vínculos se filtran por su viaje.
async function getState(db, sp, space) {
  await fillPendingRates(db, sp);
  const [trips, tripLinks, people, methods, expenses, links, payments] = await Promise.all([
    db.all('SELECT * FROM trips WHERE space_id = ? ORDER BY rowid', [sp]),
    db.all('SELECT tp.trip_id, tp.person_id FROM trip_people tp JOIN trips t ON t.id = tp.trip_id WHERE t.space_id = ?', [sp]),
    db.all('SELECT id, name FROM people WHERE space_id = ? ORDER BY name COLLATE NOCASE', [sp]),
    db.all('SELECT id, kind, name, last4, card_type, owner_person_id, color, network FROM payment_methods WHERE space_id = ? ORDER BY name COLLATE NOCASE', [sp]),
    db.all('SELECT e.* FROM expenses e JOIN trips t ON t.id = e.trip_id WHERE t.space_id = ? ORDER BY e.date DESC, e.created_at DESC', [sp]),
    db.all(
      `SELECT eb.expense_id, eb.person_id FROM expense_beneficiaries eb
       JOIN expenses e ON e.id = eb.expense_id JOIN trips t ON t.id = e.trip_id WHERE t.space_id = ?`,
      [sp],
    ),
    db.all('SELECT p.* FROM payments p JOIN trips t ON t.id = p.trip_id WHERE t.space_id = ? ORDER BY p.date DESC, p.created_at DESC', [sp]),
  ]);
  const byExpense = new Map();
  for (const l of links) {
    if (!byExpense.has(l.expense_id)) byExpense.set(l.expense_id, []);
    byExpense.get(l.expense_id).push(l.person_id);
  }
  const homeDigits = new Map(trips.map((t) => [t.id, currencyByCode(t.home_currency)?.digits ?? 2]));
  const destOf = new Map(trips.map((t) => [t.id, t.dest_currency]));
  const byTrip = new Map();
  for (const l of tripLinks) {
    if (!byTrip.has(l.trip_id)) byTrip.set(l.trip_id, []);
    byTrip.get(l.trip_id).push(l.person_id);
  }
  return {
    today: todayStr(),
    space: { id: space.id, name: space.name, is_principal: Boolean(space.is_principal), is_manager: false },
    trips: trips.map((t) => ({ id: t.id, name: t.name, dest: t.dest_currency, home: t.home_currency, people_ids: byTrip.get(t.id) ?? [] })),
    people,
    payment_methods: methods,
    // Con medio por definir (pay_pending) el relleno interno no sale: payment_method_id llega como null.
    // El monto en tu moneda y si la tasa es estimada no se guardan: salen de la tasa y de la fecha de cada gasto.
    expenses: expenses.map(({ pay_pending: pp, ...e }) => ({
      ...e,
      currency: e.currency ?? destOf.get(e.trip_id), // siempre la moneda efectiva del gasto
      rate_estimated: e.rate != null && e.rate_date !== e.date ? 1 : 0,
      amount_home: e.rate == null ? null : toHome(e.amount_cents, e.rate, homeDigits.get(e.trip_id) ?? 2),
      payment_method_id: pp ? null : e.payment_method_id,
      beneficiary_ids: byExpense.get(e.id) ?? [],
    })),
    // Igual que los gastos: moneda efectiva, y el monto en tu moneda y si la tasa es estimada salen al leer.
    payments: payments.map((p) => ({
      ...p,
      currency: p.currency ?? destOf.get(p.trip_id),
      rate_estimated: p.rate != null && p.rate_date !== p.date ? 1 : 0,
      amount_home: p.rate == null ? null : toHome(p.amount_cents, p.rate, homeDigits.get(p.trip_id) ?? 2),
    })),
  };
}

// La administración no tiene datos: su estado es fijo y no consulta ninguna tabla.
const managerState = (space) => ({ today: todayStr(), space, trips: [], people: [], payment_methods: [], expenses: [], payments: [] });

// ---------- lugares (enlaces de Google Maps) ----------

// Enlace corto de Google Maps -> coordenadas (el servidor sigue la redirección). Ver maplink.mjs.
async function resolvePlaceLink(query) {
  try {
    return await resolveMapLink(query.get('url'));
  } catch (err) {
    if (err instanceof MapLinkError) fail(err.status, err.message);
    throw err;
  }
}

// ---------- enrutador ----------

export async function handle({ method, path, query = new URLSearchParams(), body, passcode, ip, db }) {
  try {
    const space = await checkAuth(db, passcode, ip);
    const sp = space.id; // toda función de dominio recibe el espacio como segundo parámetro
    const parts = path.replace(/^\/api\/?/, '').split('/').filter(Boolean);
    const [resource, id] = parts;
    const put = (fn) => fn(db, sp, id ?? body?.id ?? randomUUID(), body ?? {});
    const ok = (data, status = 200) => ({ status, body: data });

    // La administración solo llega a ping, state y spaces. Todo lo demás "no existe", igual que una ruta desconocida:
    // se decide antes de leer el cuerpo o tocar la base, así que nunca ve ni cambia datos de ningún espacio.
    if (space.is_manager && !['ping', 'state', 'spaces'].includes(resource)) fail(404, 'Ruta no encontrada');

    if (resource === 'ping' && method === 'GET') return ok({ ok: true, space });
    if (resource === 'state' && method === 'GET') return ok(space.is_manager ? managerState(space) : await getState(db, sp, space));

    if (resource === 'trips') {
      if (method === 'POST' && !id) return ok(await put(saveTrip), 201);
      if (method === 'PUT' && id) return ok(await put(saveTrip));
      if (method === 'DELETE' && id) {
        await deleteTrip(db, sp, id, query.get('con_gastos') === '1');
        return ok({ ok: true });
      }
    }

    // Las tasas dependen de las monedas del viaje (?trip=); sin viaje se usa el primero del espacio.
    if (resource === 'rates' && id === 'history' && method === 'GET') {
      return ok(await rateHistory(db, tripPair(await getTrip(db, sp, query.get('trip'))), Number(query.get('days'))));
    }

    if (resource === 'rates' && id === 'refresh' && method === 'POST') return ok(await refreshTripRates(db, sp, query));

    if (resource === 'rate' && method === 'GET') {
      const date = query.get('date') ?? todayStr();
      if (!isValidDate(date)) fail(400, 'Fecha inválida');
      const pair = tripPair(await getTrip(db, sp, query.get('trip')));
      const cur = query.get('currency'); // moneda del gasto si no es la del destino del viaje
      if (cur) {
        if (!currencyByCode(cur)) fail(400, 'Moneda no válida');
        pair.dest = cur;
      }
      const r = await resolveRate(db, date, pair);
      return ok(r ?? { rate: null });
    }

    if (resource === 'order' && method === 'POST') return ok(await saveOrder(db, sp, body));

    if (resource === 'resolve-place' && method === 'GET') return ok(await resolvePlaceLink(query));

    // Respaldo: copia cruda de las tablas del espacio. Restaurar solo agrega lo que falta, en el espacio de quien
    // restaura (con ?dry=1 solo cuenta).
    if (resource === 'backup' && method === 'GET') return ok(await dumpBackup(db, sp));
    if (resource === 'restore' && method === 'POST') return ok(await restoreBackup(db, body, { dry: query.get('dry') === '1', fail, sp }));

    // Administración de espacios: solo la administración (ADMIN_PASSCODE). Para un espacio de datos, o con la app
    // abierta, estas rutas no existen: se decide antes de leer el cuerpo o tocar la base, y no pueden saber si existen.
    if (resource === 'spaces') {
      if (!space.is_manager) fail(404, 'Ruta no encontrada');
      const action = parts[2];
      if (method === 'GET' && !id) return ok(await listSpaces(db));
      if (method === 'POST' && !id) return ok(await createSpace(db, body), 201);
      if (method === 'POST' && id && action === 'regenerate' && parts.length === 3) return ok(await regenerateSpace(db, id));
      if (method === 'PUT' && id && parts.length === 2) {
        // Exactamente una de las dos: renombrar (name) o activar/desactivar (active).
        const tiene = (k) => Object.hasOwn(Object(body), k);
        if (tiene('name') === tiene('active')) fail(400, 'Indica solo name o active');
        return ok(await (tiene('name') ? renameSpace : setSpaceActive)(db, id, body));
      }
    }

    const writers = { people: [savePerson, deletePerson], 'payment-methods': [saveMethod, deleteMethod], expenses: [saveExpense, deleteExpense], payments: [savePayment, deletePayment] };
    if (writers[resource]) {
      const [saver, deleter] = writers[resource];
      if (method === 'POST' && !id) return ok(await put(saver), 201);
      if (method === 'PUT' && id) return ok(await put(saver));
      if (method === 'DELETE' && id) {
        await deleter(db, sp, id);
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
