// Lógica sin DOM del diálogo "Lugar del gasto": el navegador y las pruebas la usan.
//
// Modelo: toda acción (📍 Mi ubicación, tocar el mapa, elegir un resultado de búsqueda) fija un *ancla*. Alrededor del ancla se arma
// una lista: "Este punto" (siempre, seleccionado por defecto), los lugares que ya usaste y los sitios cercanos. El usuario elige una
// fila y confirma. Así el mismo sitio queda con las mismas coordenadas y el punto exacto sigue siendo una opción.

import { distanceKm } from './geosearch.mjs';
import { formatCoords } from './places.mjs';
import { mergeCandidates } from './nearby.mjs';

export const PICK_MIN_ZOOM = 15; // con menos zoom un toque no distingue una tienda de otra
export const TAP_ZOOM = 17; // a donde se acerca el mapa si tocas estando muy alejado

// Radio (m) para buscar sitios alrededor de un toque: unos 30 píxeles a ese zoom, entre 15 y 120 m.
export function tapRadiusM(zoom, lat) {
  const mPerPx = (156543 * Math.cos((lat * Math.PI) / 180)) / 2 ** zoom;
  return Math.min(120, Math.max(15, Math.round(mPerPx * 30)));
}

// Quita repetidos (mismo nombre a menos de 60 m); se queda con el primero. Pasa primero lo mejor (Foursquare) y luego OpenStreetMap.
export function dedupeByName(list) {
  const out = [];
  for (const r of list) {
    const name = r.name.trim().toLowerCase();
    if (!out.some((o) => o.name.trim().toLowerCase() === name && distanceKm(o, r) <= 0.06)) out.push(r);
  }
  return out;
}

// Nombre sin acentos, mayúsculas ni el tipo ("Edf.", "Edificio", "Condominio"…): "Edf. Estação Atlântico" y "Edifício Estacao Atlantico" son el mismo.
const NAME_NOISE = /\b(edf|edificio|ed|condominio|residencial|res|torre)\b\.?/g;
export function normalizeName(name) {
  return String(name ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(NAME_NOISE, ' ').replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
}

const sameName = (a, b) => {
  const x = normalizeName(a);
  const y = normalizeName(b);
  return Boolean(x) && Boolean(y) && (x === y || (Math.min(x.length, y.length) >= 4 && (x.includes(y) || y.includes(x))));
};

// Foursquare y OpenStreetMap pueden traer el mismo lugar. La posición de Foursquare es aproximada (un punto por dirección que suele caer en
// la calle: en una prueba, 18 m de mediana y 6 de 9 fuera del edificio); la de OpenStreetMap, cuando el edificio está dibujado, es su
// centro. Si el mismo lugar está en las dos fuentes (nombre equivalente a menos de maxM metros), se usa la posición de OpenStreetMap:
// el lugar queda con nombre de Foursquare, marcado merged y sin "aproximada". Devuelve los de Foursquare y los de OSM que no se unieron.
export function preferOsm(fsqList, osmList, { maxM = 150 } = {}) {
  const used = new Set();
  const fsq = fsqList.map((f) => {
    let best = null;
    osmList.forEach((o, i) => {
      if (used.has(i) || !sameName(f.name, o.name)) return;
      const m = distanceKm(f, o) * 1000;
      if (m <= maxM && (!best || m < best.m)) best = { i, m, o };
    });
    if (!best) return f;
    used.add(best.i);
    return { ...f, lat: best.o.lat, lng: best.o.lng, approx: false, merged: true };
  });
  return { fsq, osm: osmList.filter((_, i) => !used.has(i)) };
}

// Los sitios cercanos llegan de dos fuentes y en momentos distintos (OpenStreetMap y Foursquare). Cada vez que llega una se recalcula la lista
// completa: sin los ya usados, sin repetidos (el mismo lugar en las dos fuentes sale con la posición de OpenStreetMap) y del más cercano al más lejano.
export function combineNearby({ known = [], osm = [], fsq = [] }) {
  const o = mergeCandidates(known, osm);
  const f = mergeCandidates([...known, ...o], preferOsm(fsq, o).fsq.filter((r) => !r.merged));
  return [...o, ...f].sort((a, b) => (a.km ?? 1e9) - (b.km ?? 1e9));
}

// Resultados de una búsqueda por nombre: lo cercano a `ref` (hasta farKm) primero, con su distancia. Lo lejano se limita a maxFar
// y va aparte, porque el buscador mezcla sitios de otras ciudades. Si no hay nada cerca, lo lejano es lo único que hay y se muestra.
export function rankSearch(results, ref, { farKm = 100, maxFar = 3 } = {}) {
  if (!ref) return { near: results.map((r) => ({ ...r, km: r.km ?? null })), far: [] };
  const withKm = results.map((r) => ({ ...r, km: distanceKm(ref, r) }));
  const near = withKm.filter((r) => r.km <= farKm).sort((a, b) => a.km - b.km || 0);
  const far = withKm.filter((r) => r.km > farKm);
  return near.length ? { near, far: far.slice(0, maxFar) } : { near: far, far: [] };
}

// Lo que se ve y se elige: "Este punto" primero, luego lugares usados (verdes) y sitios cercanos (amarillos), numerados como en el mapa.
export function buildList({ anchor, known = [], nearby = [], typed = '', adjusted = new Map() }) {
  const items = [];
  if (anchor) {
    items.push({
      key: 'point', kind: 'point', name: typed, lat: anchor.lat, lng: anchor.lng,
      source: anchor.source, accuracy: anchor.accuracy ?? null, approx: Boolean(anchor.approx),
    });
  }
  let n = 0;
  const seen = new Map();
  for (const c of known) { n += 1; items.push({ ...c, key: `known:${c.lat.toFixed(6)},${c.lng.toFixed(6)}`, kind: 'known', n }); }
  for (const c of nearby) { n += 1; const nth = (seen.get(c.name) ?? 0) + 1; seen.set(c.name, nth); items.push({ ...c, key: `near:${c.name}#${nth}`, kind: 'near', n }); }
  // Posición corregida por el usuario (arrastró el pin o tocó "Ajustar"): la llave sigue siendo la original, solo cambian las coordenadas.
  return items.map((it) => {
    const adj = adjusted.get(it.key);
    return adj ? { ...it, lat: adj.lat, lng: adj.lng, adjusted: true, approx: false } : it;
  });
}

// Título y detalle de lo elegido (para el pie del diálogo).
export function selectionSummary(sel) {
  if (!sel) return { title: 'Nada elegido', sub: 'Toca el mapa, busca un nombre o usa Mi ubicación.' };
  if (sel.kind === 'point') {
    const where = sel.source === 'gps' ? 'Tu ubicación' : sel.source === 'saved' ? 'Ubicación guardada' : sel.source === 'recent' ? 'Lugar reciente' : sel.source === 'coords' ? 'Coordenadas de Google Maps' : 'Punto del mapa';
    return {
      title: sel.name.trim() || where,
      sub: `${sel.name.trim() ? `${where} · ` : ''}${formatCoords(sel.lat, sel.lng)}${sel.accuracy ? ` · ±${Math.max(5, Math.round(sel.accuracy))} m` : ''}${sel.adjusted ? ' · posición ajustada' : ''}`,
    };
  }
  const base = sel.detail || (sel.kind === 'known' ? 'Lugar que ya usaste' : formatCoords(sel.lat, sel.lng));
  return { title: sel.name || 'Sin nombre', sub: sel.adjusted ? `${base} · posición ajustada` : sel.approx ? `${base} · posición aproximada` : base };
}

// El nombre del gasto al confirmar. Si el usuario eligió o escribió un nombre, ese gana (aunque el gasto ya tuviera otro);
// si no hay nombre explícito (un punto sin nombre, un lugar usado "Sin nombre"), se conserva el que había.
export function confirmPlace(currentPlace, sel) {
  const explicit = String(sel?.name ?? '').trim();
  return explicit ? explicit.slice(0, 120) : String(currentPlace ?? '');
}
