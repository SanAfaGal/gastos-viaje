// Lugares ya usados en los gastos de un viaje. Módulo sin DOM: el navegador y las pruebas lo usan.
//
// El GPS o un enlace nunca dan dos veces el mismo punto exacto. Para que el mismo sitio quede igual en todos sus gastos se ofrecen los
// lugares que ya usaste (se copian sus coordenadas y su nombre exactos): los cercanos a un punto, los recientes y todos los visitados.

import { distanceKm } from './geosearch.mjs';
import { hasLocation } from './places.mjs';

const SAME_PLACE_KM = 0.04; // gastos a menos de 40 m cuentan como el mismo lugar

const norm = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toLowerCase();

// Agrupa los gastos con ubicación por lugar. Se agrupa por distancia (no por redondeo): un gasto a menos de 40 m de otro es el mismo lugar.
// Cada grupo trae las coordenadas exactas del gasto más reciente (así elegirlo repite el punto tal cual), su nombre más usado, cuántos
// gastos tiene, sus fechas y la del último.
function groupPlaces(expenses) {
  const groups = [];
  const recentFirst = [...expenses].filter(hasLocation).sort((a, b) =>
    String(b.date).localeCompare(String(a.date)) || String(b.created_at ?? '').localeCompare(String(a.created_at ?? '')));
  for (const e of recentFirst) {
    const at = { lat: Number(e.lat), lng: Number(e.lng) };
    const g = groups.find((x) => distanceKm(x, at) <= SAME_PLACE_KM);
    const name = String(e.place ?? '').trim();
    if (g) {
      g.count += 1;
      g.dates.add(e.date);
      if (name) g.names.set(name, (g.names.get(name) ?? 0) + 1);
    } else {
      groups.push({ lat: at.lat, lng: at.lng, count: 1, names: new Map(name ? [[name, 1]] : []), dates: new Set([e.date]), last: String(e.date), lastAt: String(e.created_at ?? '') });
    }
  }
  return groups;
}

const topName = (g) => [...g.names].sort((a, b) => b[1] - a[1])[0]?.[0] ?? '';

// Lugares ya usados cerca de `ref`, del más cercano al más lejano.
export function knownPlaces(expenses, ref, { maxKm = 0.1 } = {}) {
  return groupPlaces(expenses)
    .map((g) => ({ name: topName(g), lat: g.lat, lng: g.lng, count: g.count, km: distanceKm(ref, g) }))
    .filter((p) => p.km <= maxKm)
    .sort((a, b) => a.km - b.km);
}

// Lugares usados hace poco, para volver a elegirlos de un toque (varios gastos en el mismo sitio con distinto medio de pago). Primero los
// que ya tienen un gasto del mismo día (`date`), luego el resto del más reciente al más antiguo.
export function recentPlaces(expenses, { date = '', limit = 5 } = {}) {
  return groupPlaces(expenses)
    .map((g) => ({ name: topName(g), lat: g.lat, lng: g.lng, count: g.count, last: g.last, lastAt: g.lastAt, today: Boolean(date) && g.dates.has(date) }))
    .sort((a, b) => Number(b.today) - Number(a.today) || b.last.localeCompare(a.last) || b.lastAt.localeCompare(a.lastAt))
    .slice(0, limit);
}

// Todos los lugares con ubicación de los gastos (los de un viaje), para volver a elegir uno ya visitado sin ir a Google Maps. Gastos a pocos metros
// son el mismo lugar. Con `query` se filtra por el nombre (sin acentos ni mayúsculas) y los que empiezan por lo escrito van primero; el resto,
// del más reciente al más antiguo.
export function visitedPlaces(expenses, { query = '' } = {}) {
  const q = norm(query).trim();
  return groupPlaces(expenses)
    .map((g) => ({ name: topName(g), lat: g.lat, lng: g.lng, count: g.count, last: g.last, lastAt: g.lastAt }))
    .filter((p) => !q || norm(p.name).includes(q))
    .sort((a, b) => (q ? Number(norm(b.name).startsWith(q)) - Number(norm(a.name).startsWith(q)) : 0)
      || b.last.localeCompare(a.last) || b.lastAt.localeCompare(a.lastAt) || a.name.localeCompare(b.name));
}
