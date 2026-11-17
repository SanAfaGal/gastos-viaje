// Lugares donde se hicieron gastos. Módulo puro (sin DOM): lo usan el navegador y las pruebas.

// ¿El gasto trae una ubicación válida?
export function hasLocation(e) {
  return e != null && e.lat != null && e.lng != null
    && Number.isFinite(Number(e.lat)) && Number.isFinite(Number(e.lng))
    && Math.abs(e.lat) <= 90 && Math.abs(e.lng) <= 180;
}

// Agrupa los gastos con ubicación que están muy cerca (con 3 decimales, unos 100 m) en un solo lugar.
// Devuelve [{ lat, lng, place, count, total_home, total_dest, ids }] con el punto promedio del grupo.
export function placesFrom(expenses, decimals = 3) {
  const groups = new Map();
  for (const e of expenses) {
    if (!hasLocation(e)) continue;
    const key = `${Number(e.lat).toFixed(decimals)},${Number(e.lng).toFixed(decimals)}`;
    let g = groups.get(key);
    if (!g) groups.set(key, (g = { sumLat: 0, sumLng: 0, place: '', count: 0, total_home: 0, total_dest: 0, ids: [] }));
    g.sumLat += Number(e.lat);
    g.sumLng += Number(e.lng);
    g.count += 1;
    g.total_home += e.amount_home ?? 0;
    g.total_dest += e.amount_cents ?? 0;
    g.ids.push(e.id);
    if (!g.place && e.place) g.place = e.place;
  }
  return [...groups.values()].map((g) => ({
    lat: g.sumLat / g.count,
    lng: g.sumLng / g.count,
    place: g.place,
    count: g.count,
    total_home: g.total_home,
    total_dest: g.total_dest,
    ids: g.ids,
  }));
}

// "4.60971, -74.08175" (5 decimales bastan: ~1 m).
export function formatCoords(lat, lng) {
  return `${Number(lat).toFixed(5)}, ${Number(lng).toFixed(5)}`;
}
