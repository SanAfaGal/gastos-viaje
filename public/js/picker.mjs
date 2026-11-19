// Lógica sin DOM del diálogo "Lugar del gasto": el navegador y las pruebas la usan.
//
// Modelo: toda acción (pegar un enlace, coordenadas o Plus Code de Google Maps, tocar el mapa, elegir un lugar ya visitado) fija un *ancla*.
// Alrededor del ancla se arma una lista: "Este punto" (siempre, seleccionado por defecto) y los lugares que ya usaste cerca. El usuario
// elige una fila y confirma. Así el mismo sitio queda con las mismas coordenadas y el punto exacto sigue siendo una opción.

import { formatCoords } from './places.mjs';

export const PICK_MIN_ZOOM = 15; // con menos zoom un toque no distingue una tienda de otra
export const TAP_ZOOM = 17; // a donde se acerca el mapa si tocas estando muy alejado

// Lo que se ve y se elige: "Este punto" primero y luego los lugares ya usados cerca, numerados como en el mapa.
export function buildList({ anchor, known = [], typed = '' }) {
  const items = [];
  if (anchor) items.push({ key: 'point', kind: 'point', name: typed, lat: anchor.lat, lng: anchor.lng, source: anchor.source });
  known.forEach((c, i) => items.push({ ...c, key: `known:${c.lat.toFixed(6)},${c.lng.toFixed(6)}`, kind: 'known', n: i + 1 }));
  return items;
}

// Título y detalle de lo elegido (para el pie del diálogo).
export function selectionSummary(sel) {
  if (!sel) return { title: 'Nada elegido', sub: 'Pega un enlace de Google Maps, toca el mapa o elige un lugar visitado.' };
  if (sel.kind === 'point') {
    const where = sel.source === 'saved' ? 'Ubicación guardada' : sel.source === 'recent' ? 'Lugar reciente' : sel.source === 'coords' ? 'Desde Google Maps' : 'Punto del mapa';
    return { title: sel.name.trim() || where, sub: `${sel.name.trim() ? `${where} · ` : ''}${formatCoords(sel.lat, sel.lng)}` };
  }
  return { title: sel.name || 'Sin nombre', sub: sel.detail || (sel.kind === 'known' ? 'Lugar que ya usaste' : formatCoords(sel.lat, sel.lng)) };
}

// El nombre del gasto al confirmar. Si el usuario eligió o escribió un nombre, ese gana (aunque el gasto ya tuviera otro);
// si no hay nombre explícito (un punto sin nombre, un lugar usado "Sin nombre"), se conserva el que había.
export function confirmPlace(currentPlace, sel) {
  const explicit = String(sel?.name ?? '').trim();
  return explicit ? explicit.slice(0, 120) : String(currentPlace ?? '');
}
