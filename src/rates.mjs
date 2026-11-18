// Tasa de cambio por día entre dos monedas (destino -> la tuya). Fuentes gratis sin llave, en este orden:
// @fawazahmed0/currency-api (jsdelivr y currency-api.pages.dev) y, si fallan o van atrasadas, Frankfurter.
// Cada tasa guardada lleva su fuente (nombre en SOURCE_*) y cuándo se consultó, para poder explicar de dónde salió.
// Un valor por día. La tasa de HOY no se guarda en la base (la fuente la va actualizando durante el día y a
// veces aún trae la de ayer): se pregunta cada vez, y solo los días ya cerrados quedan como caché.
import { addDays, todayStr } from '../public/js/money.mjs';

const SOURCE_FAWAZ = 'fawazahmed0';
const SOURCE_FRANKFURTER = 'frankfurter';
const TIMEOUT_MS = 4000;
const RETRY_AFTER_MS = 60_000;
const netFailures = new Map(); // par|fecha -> hasta cuándo no reintentar (evita esperar el timeout en cada llamada)

const isYmd = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
const okRate = (r) => typeof r === 'number' && Number.isFinite(r) && r > 0 && r <= 1e6;

// Cada fuente: url, cómo leer { rate, date } de su respuesta y su nombre (el que se guarda con la tasa). `version` es una fecha o 'latest'.
function sources(version, { dest, home }) {
  const d = dest.toLowerCase();
  const h = home.toLowerCase();
  const fawaz = (json) => ({ rate: json?.[d]?.[h], date: json?.date });
  const frank = (json) => ({ rate: json?.rate, date: json?.date });
  return [
    { url: `https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@${version}/v1/currencies/${d}.json`, read: fawaz, source: SOURCE_FAWAZ },
    { url: `https://${version}.currency-api.pages.dev/v1/currencies/${d}.json`, read: fawaz, source: SOURCE_FAWAZ },
    { url: `https://api.frankfurter.dev/v2/rate/${dest}/${home}${version === 'latest' ? '' : `?date=${version}`}`, read: frank, source: SOURCE_FRANKFURTER },
  ];
}

// Devuelve { rate, date, source } con la fecha a la que pertenece el valor (puede ser anterior a `want` si la fuente
// aún no publica el día), null si esa fecha o moneda no existe en ninguna fuente (404/422), o lanza si hay un
// problema de red. Se queda con la primera fuente que trae el día pedido; si ninguna lo trae, con la más reciente.
async function fetchRate(version, currencies, fetchFn, want = version) {
  let notFound = false;
  let lastErr;
  let best = null;
  for (const { url, read, source } of sources(version, currencies)) {
    try {
      const res = await fetchFn(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (res.status === 404 || res.status === 422) {
        notFound = true;
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const { rate, date } = read(await res.json());
      if (!okRate(rate)) {
        notFound = true;
        continue;
      }
      const cand = { rate, date: isYmd(date) ? date : want, source };
      if (cand.date >= want) return cand;
      if (!best || cand.date > best.date) best = cand;
    } catch (err) {
      lastErr = err;
    }
  }
  if (best) return best;
  if (notFound) return null;
  throw lastErr ?? new Error('sin respuesta');
}

// { rate, source } del día guardado, o null. `source` es null en las tasas guardadas antes de que se registrara.
async function cachedRate(db, pair, date) {
  const rows = await db.all('SELECT rate, source FROM rates WHERE pair = ? AND date = ?', [pair, date]);
  return rows[0] ?? null;
}

async function saveRate(db, pair, date, rate, source) {
  await db.run(
    `INSERT INTO rates (pair, date, rate, source, fetched_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(pair, date) DO UPDATE SET rate = excluded.rate, source = excluded.source, fetched_at = excluded.fetched_at`,
    [pair, date, rate, source ?? null, new Date().toISOString()],
  );
}

// Resuelve cuántas unidades de `home` vale 1 de `dest` el día `date`.
// Devuelve { rate, rate_date, estimated, source } o null si no hay ninguna. `source` es la fuente que dio el valor
// (null si la tasa se guardó antes de registrarla).
//  - estimated=true: no hay tasa exacta de ese día; se usó la del día anterior más cercano.
export async function resolveRate(db, date, currencies, opts = {}) {
  const { dest, home } = currencies;
  if (dest === home) return { rate: 1, rate_date: date, estimated: false, source: null };
  const fetchFn = opts.fetchFn ?? fetch;
  const today = opts.today ?? todayStr();
  const pair = `${dest}-${home}`;
  const target = date > today ? today : date;

  // Solo los días cerrados se leen de la base; hoy siempre se pregunta a la fuente.
  if (target !== today) {
    const exact = await cachedRate(db, pair, target);
    if (exact) return { rate: exact.rate, rate_date: target, estimated: date !== target, source: exact.source };
  }

  const failKey = `${pair}|${target}`;
  if (Date.now() >= (netFailures.get(failKey) ?? 0)) {
    try {
      for (let i = 0; i <= 3; i += 1) {
        const d = addDays(target, -i);
        const hit = i > 0 && d !== today ? await cachedRate(db, pair, d) : null;
        let rate = hit?.rate ?? null;
        let source = hit?.source ?? null;
        let rateDate = d;
        if (rate == null) {
          const got = await fetchRate(d === today ? 'latest' : d, currencies, fetchFn, d);
          if (got) {
            rate = got.rate;
            source = got.source;
            rateDate = got.date;
            if (got.date < today) await saveRate(db, pair, got.date, got.rate, got.source); // día cerrado: ya no cambia
          }
        }
        if (rate != null) return { rate, rate_date: rateDate, estimated: rateDate !== date, source };
      }
    } catch {
      netFailures.set(failKey, Date.now() + RETRY_AFTER_MS);
    }
  }

  const prev = await db.all(
    'SELECT date, rate, source FROM rates WHERE pair = ? AND date <= ? AND date < ? ORDER BY date DESC LIMIT 1',
    [pair, target, today],
  );
  if (prev[0]) return { rate: prev[0].rate, rate_date: prev[0].date, estimated: true, source: prev[0].source };
  return null;
}

// Tasas de los últimos `days` días (hasta hoy) para dibujar el gráfico. Lo que ya está guardado se lee de
// la base; lo que falta se pide a la fuente (6 a la vez) y se guarda. Los días sin dato simplemente no salen.
export async function rateHistory(db, currencies, days = 45, opts = {}) {
  const { dest, home } = currencies;
  const today = opts.today ?? todayStr();
  const n = Math.min(Math.max(Math.floor(Number(days)) || 45, 2), 90);
  const dates = Array.from({ length: n }, (_, i) => addDays(today, -(n - 1 - i)));
  if (dest === home) return dates.map((date) => ({ date, rate: 1 }));

  const pair = `${dest}-${home}`;
  // Hoy no se lee de la base (puede ser un valor viejo guardado antes de que la fuente lo actualizara).
  const rows = await db.all('SELECT date, rate FROM rates WHERE pair = ? AND date >= ? AND date < ?', [pair, dates[0], today]);
  const have = new Map(rows.map((r) => [r.date, r.rate]));
  const queue = dates.filter((d) => !have.has(d));
  const fetchFn = opts.fetchFn ?? fetch;
  const failKey = `${pair}|historial`;
  let failed = false;

  if (queue.length && Date.now() >= (netFailures.get(failKey) ?? 0)) {
    const worker = async () => {
      while (queue.length && !failed) {
        const d = queue.shift();
        try {
          const got = await fetchRate(d === today ? 'latest' : d, currencies, fetchFn, d);
          // Un valor con fecha anterior a la pedida (la fuente aún no publica hoy) no se pone en ese día.
          if (got && got.date === d) {
            have.set(d, got.rate);
            if (d < today) await saveRate(db, pair, d, got.rate, got.source);
          }
        } catch {
          failed = true;
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(6, queue.length) }, worker));
    if (failed) netFailures.set(failKey, Date.now() + RETRY_AFTER_MS);
  }
  return dates.filter((d) => have.has(d)).map((date) => ({ date, rate: have.get(date) }));
}

// Botón "Actualizar tasas": vuelve a pedir a la fuente la tasa de cada día de `dates` (sin mirar la base) y
// devuelve un Map fecha -> { rate, source } solo con los días que la fuente trae exactos. Si `save`, los días cerrados
// quedan guardados en la base (se sobrescribe lo que hubiera). Lanza si la fuente no responde.
export async function refreshRates(db, currencies, dates, { save = true, fetchFn = fetch, today = todayStr() } = {}) {
  const { dest, home } = currencies;
  const out = new Map();
  const queue = [...new Set(dates)].filter((d) => d <= today);
  if (dest === home) { queue.forEach((d) => out.set(d, { rate: 1, source: null })); return out; }
  const pair = `${dest}-${home}`;
  let failure = null;
  const worker = async () => {
    while (queue.length && !failure) {
      const d = queue.shift();
      try {
        const got = await fetchRate(d === today ? 'latest' : d, currencies, fetchFn, d);
        if (got && got.date === d) {
          out.set(d, { rate: got.rate, source: got.source });
          if (save && d < today) await saveRate(db, pair, d, got.rate, got.source);
        }
      } catch (err) {
        failure = err;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(6, queue.length) }, worker));
  if (failure) throw failure;
  return out;
}

// Solo para pruebas.
export function _resetFailures() {
  netFailures.clear();
}
