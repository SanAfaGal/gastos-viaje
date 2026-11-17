// Tasa de cambio por día entre dos monedas (destino -> la tuya). Fuente gratis sin llave:
// @fawazahmed0/currency-api (jsdelivr, con currency-api.pages.dev de respaldo). Un valor por día.
import { addDays, todayStr } from '../public/js/money.mjs';

const TIMEOUT_MS = 4000;
const RETRY_AFTER_MS = 60_000;
const netFailures = new Map(); // par|fecha -> hasta cuándo no reintentar (evita esperar el timeout en cada llamada)

function urls(version, dest) {
  const d = dest.toLowerCase();
  return [
    `https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@${version}/v1/currencies/${d}.json`,
    `https://${version}.currency-api.pages.dev/v1/currencies/${d}.json`,
  ];
}

// Devuelve la tasa (número), null si esa fecha o moneda no existe en la fuente (404),
// o lanza si hay un problema de red.
async function fetchRate(version, { dest, home }, fetchFn) {
  let notFound = false;
  let lastErr;
  for (const url of urls(version, dest)) {
    try {
      const res = await fetchFn(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (res.status === 404) {
        notFound = true;
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      const rate = json?.[dest.toLowerCase()]?.[home.toLowerCase()];
      if (typeof rate === 'number' && Number.isFinite(rate) && rate > 0 && rate <= 1e6) return rate;
      notFound = true;
    } catch (err) {
      lastErr = err;
    }
  }
  if (notFound) return null;
  throw lastErr ?? new Error('sin respuesta');
}

async function cachedRate(db, pair, date) {
  const rows = await db.all('SELECT rate FROM rates WHERE pair = ? AND date = ?', [pair, date]);
  return rows[0]?.rate ?? null;
}

async function saveRate(db, pair, date, rate) {
  await db.run(
    'INSERT INTO rates (pair, date, rate) VALUES (?, ?, ?) ON CONFLICT(pair, date) DO UPDATE SET rate = excluded.rate',
    [pair, date, rate],
  );
}

// Resuelve cuántas unidades de `home` vale 1 de `dest` el día `date`.
// Devuelve { rate, rate_date, estimated } o null si no hay ninguna.
//  - estimated=true: no hay tasa exacta de ese día; se usó la del día anterior más cercano.
export async function resolveRate(db, date, currencies, opts = {}) {
  const { dest, home } = currencies;
  if (dest === home) return { rate: 1, rate_date: date, estimated: false };
  const fetchFn = opts.fetchFn ?? fetch;
  const today = opts.today ?? todayStr();
  const pair = `${dest}-${home}`;
  const target = date > today ? today : date;

  const exact = await cachedRate(db, pair, target);
  if (exact != null) return { rate: exact, rate_date: target, estimated: date !== target };

  const failKey = `${pair}|${target}`;
  if (Date.now() >= (netFailures.get(failKey) ?? 0)) {
    try {
      for (let i = 0; i <= 3; i += 1) {
        const d = addDays(target, -i);
        let rate = i > 0 ? await cachedRate(db, pair, d) : null;
        if (rate == null) {
          rate = await fetchRate(d === today ? 'latest' : d, currencies, fetchFn);
          if (rate != null) await saveRate(db, pair, d, rate);
        }
        if (rate != null) return { rate, rate_date: d, estimated: d !== date };
      }
    } catch {
      netFailures.set(failKey, Date.now() + RETRY_AFTER_MS);
    }
  }

  const prev = await db.all(
    'SELECT date, rate FROM rates WHERE pair = ? AND date <= ? ORDER BY date DESC LIMIT 1',
    [pair, target],
  );
  if (prev[0]) return { rate: prev[0].rate, rate_date: prev[0].date, estimated: true };
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
  const rows = await db.all('SELECT date, rate FROM rates WHERE pair = ? AND date >= ? AND date <= ?', [pair, dates[0], today]);
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
          const rate = await fetchRate(d === today ? 'latest' : d, currencies, fetchFn);
          if (rate != null) {
            have.set(d, rate);
            await saveRate(db, pair, d, rate);
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

// Solo para pruebas.
export function _resetFailures() {
  netFailures.clear();
}
