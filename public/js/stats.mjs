// Cálculos para el resumen del Inicio. Módulo puro (sin DOM): lo usan el navegador y las pruebas.
// Los montos son enteros en centésimas. Un gasto sin tasa todavía (amount_home null) no suma en la moneda
// de casa, pero sí en la del destino, y se cuenta aparte.
import { addDays } from './money.mjs';

const home = (e) => e.amount_home ?? 0;

// Un gasto está en la moneda del destino si no dice otra (gastos anteriores) o si coincide con `dest`.
// Sin `dest` (pruebas, llamadas viejas) todos cuentan como del destino.
const inDest = (e, dest) => !dest || !e.currency || e.currency === dest;

// Los días del viaje van del primer al último gasto en la moneda del destino: un vuelo comprado en casa una semana antes
// de salir, o lo gastado al volver, entra en el total pero no estira los días ni baja el promedio. Si no hay ningún gasto
// en la moneda del destino (solo gastos de casa), se usan todos.
function tripRange(expenses, dest) {
  const dates = expenses.filter((e) => inDest(e, dest)).map((e) => e.date).sort();
  const all = dates.length ? dates : expenses.map((e) => e.date).sort();
  return { first: all[0], last: all.at(-1) };
}

// Gasto por día, de más antiguo a más reciente, con ceros en los días sin gastos. `days` limita a los últimos N
// días hasta `today` (o hasta el último día con gastos, lo que sea más reciente). Con `dest`, `dest` de cada día
// suma solo los gastos en esa moneda y los días fuera del viaje (ver tripRange) no aparecen.
export function byDay(expenses, { today, days = 14, dest } = {}) {
  if (!expenses.length) return [];
  const range = tripRange(expenses, dest);
  const sums = new Map();
  for (const e of expenses) {
    if (e.date < range.first || e.date > range.last) continue;
    const d = sums.get(e.date) ?? { date: e.date, home: 0, dest: 0, count: 0 };
    d.home += home(e);
    if (inDest(e, dest)) d.dest += e.amount_cents;
    d.count += 1;
    sums.set(e.date, d);
  }
  const dates = [...sums.keys()].sort();
  const last = today && today > dates.at(-1) ? today : dates.at(-1);
  const first = dates[0] > addDays(last, -(days - 1)) ? dates[0] : addDays(last, -(days - 1));
  const out = [];
  for (let d = first; d <= last; d = addDays(d, 1)) out.push(sums.get(d) ?? { date: d, home: 0, dest: 0, count: 0 });
  return out;
}

// Reparto de lo gastado por una clave (medio de pago, quién pagó…), de mayor a menor, con su porcentaje.
// `keyOf(e)` devuelve { id, label } o null (el gasto no entra). Pasado `max`, el resto se junta en "Otros".
export function breakdown(expenses, keyOf, { max = 5 } = {}) {
  const map = new Map();
  for (const e of expenses) {
    const k = keyOf(e);
    if (!k) continue;
    const row = map.get(k.id) ?? { id: k.id, label: k.label, home: 0, count: 0 };
    row.home += home(e);
    row.count += 1;
    map.set(k.id, row);
  }
  let rows = [...map.values()].sort((a, b) => b.home - a.home || a.label.localeCompare(b.label));
  if (rows.length > max) {
    const rest = rows.slice(max - 1);
    rows = [...rows.slice(0, max - 1), { id: '__otros', label: 'Otros', home: rest.reduce((a, r) => a + r.home, 0), count: rest.reduce((a, r) => a + r.count, 0) }];
  }
  const total = rows.reduce((a, r) => a + r.home, 0);
  return rows.map((r) => ({ ...r, pct: total ? (r.home / total) * 100 : 0 }));
}

// Cifras de un vistazo. El promedio se calcula sobre los días corridos desde el primer gasto hasta el último
// (o hasta hoy, si hoy es posterior): los días sin gastos también cuentan. Con `dest`, esos días son los del viaje
// (ver tripRange): el total incluye todo, pero el promedio solo lo gastado dentro de esos días.
export function summary(expenses, today, dest) {
  if (!expenses.length) return null;
  const range = tripRange(expenses, dest);
  const first = range.first;
  const last = today && today > range.last ? today : range.last;
  const span = Math.round((Date.parse(`${last}T12:00:00Z`) - Date.parse(`${first}T12:00:00Z`)) / 86400000) + 1;
  const total = expenses.reduce((a, e) => a + home(e), 0);
  const inTrip = expenses.filter((e) => e.date >= first && e.date <= last).reduce((a, e) => a + home(e), 0);
  const top = expenses.filter((e) => e.amount_home != null).reduce((m, e) => (!m || e.amount_home > m.amount_home ? e : m), null);
  return {
    total,
    span,
    perDay: Math.round(inTrip / span),
    today: expenses.filter((e) => e.date === today).reduce((a, e) => a + home(e), 0),
    top,
    unconverted: expenses.filter((e) => e.amount_home == null && !e.amount_pending).length, // esperan la tasa
    noAmount: expenses.filter((e) => e.amount_pending).length, // esperan el monto
  };
}
