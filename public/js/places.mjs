// Lugares donde se hicieron gastos. Módulo puro (sin DOM): lo usan el navegador y las pruebas.
import { compareChronological } from './order.mjs';

// ¿El gasto trae una ubicación válida?
export function hasLocation(e) {
  return e != null && e.lat != null && e.lng != null
    && Number.isFinite(Number(e.lat)) && Number.isFinite(Number(e.lng))
    && Math.abs(e.lat) <= 90 && Math.abs(e.lng) <= 180;
}

const keyOf = (e, decimals) => `${Number(e.lat).toFixed(decimals)},${Number(e.lng).toFixed(decimals)}`;

// Gastos con ubicación, del más antiguo al más reciente. Dentro de un día manda el orden de la lista
// (el que se arrastró a mano, o la hora de creación).
function byTime(expenses) {
  return expenses.filter(hasLocation).sort(compareChronological);
}

// Agrupa los gastos que están muy cerca (con 3 decimales, unos 100 m) en un solo lugar y recorre el viaje en orden:
//   places: paradas numeradas por su primera visita [{ n, lat, lng, place, count, total_home, total_dest, ids, first_date, last_date }]
//   path:   puntos [lat, lng] del recorrido; una vuelta a un lugar ya visitado cuenta, dos gastos seguidos en el mismo no.
// total_dest solo suma los gastos en la moneda del destino (`destCode`): los de otra moneda no se pueden sumar ahí.
export function routeFrom(expenses, decimals = 3, destCode = null) {
  const groups = new Map();
  const seq = [];
  for (const e of byTime(expenses)) {
    const key = keyOf(e, decimals);
    let g = groups.get(key);
    if (!g) {
      g = { n: groups.size + 1, sumLat: 0, sumLng: 0, place: '', count: 0, total_home: 0, total_dest: 0, ids: [], first_date: e.date, last_date: e.date };
      groups.set(key, g);
    }
    g.sumLat += Number(e.lat);
    g.sumLng += Number(e.lng);
    g.count += 1;
    g.total_home += e.amount_home ?? 0;
    if (!destCode || !e.currency || e.currency === destCode) g.total_dest += e.amount_cents ?? 0;
    g.ids.push(e.id);
    g.last_date = e.date;
    if (!g.place && e.place) g.place = e.place;
    if (seq.at(-1) !== g) seq.push(g);
  }
  const point = (g) => [g.sumLat / g.count, g.sumLng / g.count];
  const places = [...groups.values()].map((g) => {
    const [lat, lng] = point(g);
    return { n: g.n, lat, lng, place: g.place, count: g.count, total_home: g.total_home, total_dest: g.total_dest, ids: g.ids, first_date: g.first_date, last_date: g.last_date };
  });
  return { places, path: seq.map(point) };
}

// Solo los lugares (sin el recorrido).
export const placesFrom = (expenses, decimals = 3) => routeFrom(expenses, decimals).places;

// "4.60971, -74.08175" (5 decimales bastan: ~1 m).
export function formatCoords(lat, lng) {
  return `${Number(lat).toFixed(5)}, ${Number(lng).toFixed(5)}`;
}
