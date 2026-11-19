// Candidatos de lugar para "Estoy aquí". Módulo sin DOM: el navegador y las pruebas lo usan.
//
// El GPS nunca da dos veces el mismo punto: si te mueves 5 pasos las coordenadas cambian. Para que el mismo sitio quede
// igual en todos sus gastos, "Estoy aquí" ofrece:
//  1. Lugares que ya usaste en el viaje cerca de ti (se copian sus coordenadas y nombre exactos).
//  2. Sitios cercanos de OpenStreetMap: Overpass (negocios con nombre) y, si falla o no trae nada, Photon reverse.

import { distanceKm, parsePhoton } from './geosearch.mjs';
import { hasLocation } from './places.mjs';
import { icon } from './icons.mjs';

const SAME_PLACE_KM = 0.04; // gastos a menos de 40 m cuentan como el mismo lugar
const DUP_KM = 0.06; // un sitio cercano a menos de 60 m de un lugar usado con el mismo nombre es el mismo
const NOT_PLACES = ['highway', 'boundary', 'place', 'waterway']; // calles, límites, barrios y ríos no son "dónde compraste"
const OVERPASS_URL = 'https://overpass-api.de/api/interpreter';
const OVERPASS_TIMEOUT_MS = 4000;

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

// Tipo de sitio de OpenStreetMap (shop/amenity/...) -> [nombre del icono (ver icons.mjs), nombre en español]. Lo que no está aquí se muestra sin tipo.
const KINDS = {
  supermarket: ['cart', 'Supermercado'], convenience: ['bag', 'Tienda'], mall: ['bag', 'Centro comercial'], department_store: ['bag', 'Almacén'],
  marketplace: ['bag', 'Mercado'], greengrocer: ['leaf', 'Frutería'], bakery: ['utensils', 'Panadería'], butcher: ['utensils', 'Carnicería'],
  restaurant: ['utensils', 'Restaurante'], fast_food: ['utensils', 'Comida rápida'], cafe: ['coffee', 'Café'], bar: ['beer', 'Bar'], pub: ['beer', 'Bar'],
  ice_cream: ['icecream', 'Heladería'], pharmacy: ['pill', 'Farmacia'], chemist: ['droplet', 'Droguería'], clothes: ['shirt', 'Ropa'], shoes: ['bag', 'Zapatos'],
  fuel: ['fuel', 'Gasolinera'], atm: ['banknote', 'Cajero'], bank: ['landmark', 'Banco'], hotel: ['bed', 'Hotel'], hostel: ['bed', 'Hostal'],
  guest_house: ['bed', 'Posada'], taxi: ['car', 'Taxi'], bus_station: ['bus', 'Estación de buses'], museum: ['landmark', 'Museo'],
  attraction: ['ticket', 'Atracción'], cinema: ['film', 'Cine'], souvenir: ['gift', 'Souvenirs'], gift: ['gift', 'Regalos'],
  kiosk: ['bag', 'Quiosco'], hairdresser: ['scissors', 'Peluquería'], beach_resort: ['umbrella', 'Playa'], park: ['tree', 'Parque'],
};

export const placeIcon = (kind) => icon(KINDS[kind]?.[0] ?? 'mappin');
export const placeKind = (kind) => KINDS[kind]?.[1] ?? '';

// Centroide (centro de masa) de un contorno [{ lat, lon }]. El centro de la caja que lo rodea puede quedar fuera del edificio si tiene forma
// de L o es muy grande; el centroide casi siempre cae dentro. Si el contorno no cierra o no tiene área, se promedian sus puntos.
export function polygonCentroid(ring) {
  const pts = ring.filter((p) => Number.isFinite(p?.lat) && Number.isFinite(p?.lon));
  if (!pts.length) return null;
  const mean = () => ({ lat: pts.reduce((s, p) => s + p.lat, 0) / pts.length, lng: pts.reduce((s, p) => s + p.lon, 0) / pts.length });
  const closed = pts.length > 3 && pts[0].lat === pts.at(-1).lat && pts[0].lon === pts.at(-1).lon;
  if (!closed) return mean();
  // Se trabaja en metros alrededor del primer punto para que la longitud no pese más que la latitud lejos del ecuador.
  const k = Math.cos((pts[0].lat * Math.PI) / 180);
  const xy = pts.map((p) => ({ x: (p.lon - pts[0].lon) * k, y: p.lat - pts[0].lat }));
  let area = 0; let cx = 0; let cy = 0;
  for (let i = 0; i < xy.length - 1; i += 1) {
    const f = xy[i].x * xy[i + 1].y - xy[i + 1].x * xy[i].y;
    area += f; cx += (xy[i].x + xy[i + 1].x) * f; cy += (xy[i].y + xy[i + 1].y) * f;
  }
  if (Math.abs(area) < 1e-14) return mean();
  return { lat: pts[0].lat + cy / (3 * area), lng: pts[0].lon + cx / (3 * area) / k };
}

// Overpass con `out geom`: los nodos traen lat/lon, las vías su contorno (geometry) y las relaciones su caja (bounds). Se acepta también
// `center` por compatibilidad. `hasShape` indica que la posición sale de un edificio dibujado (más fiable que un punto aproximado).
export function parseOverpass(json) {
  const out = [];
  for (const el of json?.elements ?? []) {
    const t = el?.tags ?? {};
    let at = null;
    let hasShape = false;
    if (Array.isArray(el.geometry) && el.geometry.length > 2) { at = polygonCentroid(el.geometry); hasShape = Boolean(at); }
    if (!at && Number.isFinite(Number(el.lat ?? el.center?.lat)) && Number.isFinite(Number(el.lon ?? el.center?.lon))) {
      at = { lat: Number(el.lat ?? el.center.lat), lng: Number(el.lon ?? el.center.lon) };
    }
    if (!at && el.bounds) at = { lat: (el.bounds.minlat + el.bounds.maxlat) / 2, lng: (el.bounds.minlon + el.bounds.maxlon) / 2 };
    if (!t.name || !at || !Number.isFinite(at.lat) || !Number.isFinite(at.lng) || Math.abs(at.lat) > 90 || Math.abs(at.lng) > 180) continue;
    const kind = [t.shop, t.amenity, t.tourism, t.leisure].find((k) => k && k !== "yes") ?? "";
    const street = [t["addr:street"], t["addr:housenumber"]].filter(Boolean).join(" ");
    out.push({ name: String(t.name), detail: [placeKind(kind), street].filter(Boolean).join(" · "), kind, lat: at.lat, lng: at.lng, hasShape });
  }
  return out;
}

const get = async (fetchFn, url, init) => {
  const res = await fetchFn(url, init);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
};

// Junta la señal del usuario con un tope de tiempo: Overpass público a veces tarda y hay que pasar al respaldo.
function withTimeout(signal, ms) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  const onAbort = () => ctl.abort();
  signal?.addEventListener('abort', onAbort);
  if (signal?.aborted) ctl.abort();
  return { signal: ctl.signal, done: () => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); } };
}

const dedupe = (list) => {
  const out = [];
  for (const r of list) {
    if (!out.some((o) => norm(o.name) === norm(r.name) && distanceKm(o, r) <= DUP_KM)) out.push(r);
  }
  return out;
};

const byDistance = (found, ref) => dedupe(found.map((r) => ({ ...r, km: distanceKm(ref, r) })).sort((a, b) => a.km - b.km));

// Sitios con nombre de OpenStreetMap, Overpass: lo más preciso (trae el contorno del edificio) pero el servicio público a veces tarda
// mucho o se cae. Devuelve null si falla (y recuerda que está caído un rato para no esperar su tope en cada búsqueda).
let overpassDownUntil = 0;
const OVERPASS_COOLDOWN_MS = 5 * 60 * 1000;
export function _resetOverpass() { overpassDownUntil = 0; }

async function overpassNearby(ref, { radiusM, fetchFn, signal }) {
  if (Date.now() < overpassDownUntil) return null;
  const t = withTimeout(signal, OVERPASS_TIMEOUT_MS);
  try {
    // Sin calles, límites ni barrios (también tienen nombre y llenarían la lista). Se piden bastantes y se ordenan por distancia aquí,
    // porque Overpass no los devuelve del más cercano al más lejano y un tope bajo dejaría fuera justo el edificio que buscas.
    const query = `[out:json][timeout:4];nwr(around:${radiusM},${ref.lat},${ref.lng})["name"]${NOT_PLACES.map((k) => `[!"${k}"]`).join('')};out geom 80;`;
    return parseOverpass(await get(fetchFn, `${OVERPASS_URL}?${new URLSearchParams({ data: query })}`, { signal: t.signal }));
  } catch (err) {
    if (signal?.aborted) throw err; // lo canceló el usuario: no es una caída
    overpassDownUntil = Date.now() + OVERPASS_COOLDOWN_MS;
    return null;
  } finally {
    t.done();
  }
}

// Photon (OpenStreetMap): más rápido (~1 s) y más simple, con menos detalle de edificios.
async function photonNearby(ref, { limit, fetchFn, signal }) {
  const params = new URLSearchParams({ lat: String(ref.lat), lon: String(ref.lng), limit: String(limit), lang: 'default' });
  return parsePhoton(await get(fetchFn, `https://photon.komoot.io/reverse?${params}`, { signal })).filter((r) => !NOT_PLACES.includes(r.key));
}

// Sitios con nombre cerca de `ref`. Overpass y Photon se piden a la vez: no se espera el tope de Overpass para probar el respaldo. Si Photon
// llega antes, `onPartial({ results, source })` deja mostrar algo enseguida; la respuesta final usa Overpass si trajo algo y, si no, Photon.
// Lanza si ninguna fuente responde (o si se cancela).
export async function nearbyPlaces(ref, { radiusM = 80, limit = 10, fetchFn = fetch, signal, onPartial } = {}) {
  const overpass = overpassNearby(ref, { radiusM, fetchFn, signal });
  const photon = photonNearby(ref, { limit, fetchFn, signal });
  const photonResult = photon.then((r) => r, () => null); // no deja un rechazo sin atender si Overpass alcanza
  let overpassDone = false;
  const op = overpass.then((r) => { overpassDone = true; return r; });
  photonResult.then((r) => { if (r?.length && !overpassDone && !signal?.aborted) onPartial?.({ results: byDistance(r, ref).slice(0, limit), source: 'photon' }); });
  const found = await op;
  if (found?.length) return { results: byDistance(found, ref).slice(0, limit), source: 'overpass' };
  return { results: byDistance(await photon, ref).slice(0, limit), source: 'photon' };
}

// Quita de los sitios cercanos los que ya salen como lugares usados (mismo nombre y casi el mismo punto).
export function mergeCandidates(known, nearby) {
  return nearby.filter((n) => !known.some((k) => k.name && norm(k.name) === norm(n.name) && distanceKm(k, n) <= DUP_KM));
}
