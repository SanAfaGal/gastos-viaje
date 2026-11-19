// Pantalla del mapa de lugares del viaje: teselas, recorrido y paradas.
import { currencies, fmtDest, fmtHome } from './money.mjs';
import { formatCoords, hasLocation, routeFrom } from './places.mjs';
import { icon } from './icons.mjs';
import { esc } from './ui.js';
import { ctx, dayLabel, needsSetup, setupCard } from './shared.js';

// --- mapa de lugares ---

const LEAFLET = '/vendor/leaflet/leaflet'; // Leaflet 1.9.4 alojado en la app (sin scripts de terceros)
let leafletLoading = null;
export let leafletMap = null;
export function setLeafletMap(value) { leafletMap = value; return value; }
// Leaflet se carga solo al abrir un mapa (no pesa en el resto de la app).
export function loadLeaflet() {
  if (globalThis.L) return Promise.resolve(globalThis.L);
  leafletLoading ??= new Promise((resolve, reject) => {
    const css = document.createElement('link');
    css.rel = 'stylesheet';
    css.href = `${LEAFLET}.css`;
    document.head.append(css);
    const js = document.createElement('script');
    js.src = `${LEAFLET}.js`;
    js.onload = () => resolve(globalThis.L);
    js.onerror = () => { leafletLoading = null; js.remove(); reject(new Error('sin red')); };
    document.head.append(js);
  });
  return leafletLoading;
}
// Capa base de todos los mapas. Un solo lugar para cambiar de proveedor.
//  - Stadia Maps: "OSM Bright" (con color: parques, agua, calles) en el tema claro y "Alidade Smooth Dark" en el oscuro. En el navegador
//    no lleva clave: Stadia identifica el sitio por su dirección (autenticación por dominio; "localhost" funciona sin configurar).
//    El dominio de producción se registra en su panel.
//  - Si Stadia falla (dominio sin registrar, cupo agotado, caída), OpenStreetMap, que no usa clave y no vence. Una vez que falla,
//    los demás mapas de esa sesión van directo a OpenStreetMap (recargar la app vuelve a probar con Stadia).
// Las teselas de OpenStreetMap se invierten con CSS en el tema oscuro (clase osm-tiles en el mapa); las de Stadia ya vienen oscuras.
const OSM_TILES = { url: "https://tile.openstreetmap.org/{z}/{x}/{y}.png", maxZoom: 19, attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>' };
const STADIA = "https://tiles.stadiamaps.com/tiles";
let stadiaFailed = false;
let stadiaProbe = null; // ¿Stadia acepta este sitio? Se pregunta una vez por sesión.
// Cuando Stadia no autoriza (401), la respuesta es una imagen de error con estado 401: para el navegador eso es una tesela "buena" y
// el evento tileerror nunca salta. Por eso se pide una tesela con fetch y se mira el estado (Stadia permite este acceso entre sitios).
function stadiaAllowed(style) {
  stadiaProbe ??= fetch(`${STADIA}/${style}/0/0/0.png`, { cache: "no-store" }).then((r) => r.ok).catch(() => true); // sin red: que decida tileerror
  return stadiaProbe;
}
export function addBaseTiles(L, map) {
  const useOsm = () => {
    stadiaFailed = true;
    map.getContainer().classList.add("osm-tiles");
    return L.tileLayer(OSM_TILES.url, { maxZoom: OSM_TILES.maxZoom, attribution: OSM_TILES.attribution }).addTo(map);
  };
  if (stadiaFailed) return useOsm();
  const style = document.documentElement.dataset.scheme === "dark" ? "alidade_smooth_dark" : "osm_bright";
  const layer = L.tileLayer(`${STADIA}/${style}/{z}/{x}/{y}{r}.png`, {
    maxZoom: 20, detectRetina: true,
    attribution: '© <a href="https://stadiamaps.com/" target="_blank" rel="noopener">Stadia Maps</a> © <a href="https://openmaptiles.org/" target="_blank" rel="noopener">OpenMapTiles</a> © <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
  }).addTo(map);
  const swap = () => { if (map.hasLayer(layer)) { map.removeLayer(layer); useOsm(); } };
  stadiaAllowed(style).then((ok) => { if (!ok) swap(); });
  // Varias teselas seguidas con error de red = Stadia no responde: también se cambia a OpenStreetMap.
  let errors = 0;
  layer.on("tileerror", () => { errors += 1; if (errors === 4) swap(); });
  return layer;
}
export function viewMap() {
  const c = ctx();
  if (needsSetup(c)) return setupCard();
  const n = c.expenses.filter(hasLocation).length;
  if (!n) {
    return `<div class="card"><h2>Mapa de lugares</h2>
      <div class="empty">Aún no hay gastos con ubicación. Al agregar o editar un gasto, usa “Elegir lugar en el mapa”.</div>
      <a class="btn secondary" href="#/gastos">Ir a Gastos</a></div>`;
  }
  const { places } = routeFrom(c.expenses, 3, currencies().dest.code);
  const chip = (p) => {
    const tag = places.length > 1 && p.n === 1 ? 'Inicio' : places.length > 1 && p.n === places.length ? 'Último' : '';
    return `<button type="button" class="stop-chip" data-action="map-stop" data-id="${p.n}">
      <span class="stop-n ${tag === 'Último' ? 'last' : ''}">${p.n}</span>
      <span class="stop-t"><b>${esc(p.place || 'Sin nombre')}</b><span>${tag ? `${tag} · ` : ''}${esc(dayLabel(p.first_date))} · ${fmtHome(p.total_home)}</span></span></button>`;
  };
  return `<div class="map-head">
      <a class="map-back" href="${esc(lastNonMap)}"><span aria-hidden="true">‹</span> Volver</a>
      <div class="map-sum"><b>${places.length} lugar(es)</b><span>${n} gasto(s) · ${esc(c.trip.name)}</span></div>
    </div>
    <div id="map" class="map" role="region" aria-label="Mapa de lugares"><div class="empty">Cargando mapa…</div></div>
    <div class="stops" aria-label="Paradas, en el orden en que llegaste">${places.map(chip).join('')}</div>`;
}
// A qué pantalla vuelve el botón "Volver" del mapa: la última que no fue el mapa.
let lastNonMap = '#/gastos';
export function setLastNonMap(value) { lastNonMap = value; return value; }
const stopMarkers = new Map(); // número de parada -> marcador de Leaflet
export function focusStop(n) {
  const marker = stopMarkers.get(Number(n));
  if (!marker || !leafletMap) return;
  leafletMap.flyTo(marker.getLatLng(), Math.max(leafletMap.getZoom(), 16), { duration: 0.6 });
  marker.openPopup();
}
// Botón del Mapa de lugares: encuadra todas las paradas (útil después de acercarte a una o de mirar algo lejos).
function addFitControl(L, map, pts) {
  const control = L.control({ position: "bottomleft" });
  control.onAdd = () => {
    const bar = L.DomUtil.create("div", "leaflet-bar fit-ctl");
    const btn = L.DomUtil.create("a", "", bar);
    btn.href = "#";
    btn.setAttribute("role", "button");
    btn.setAttribute("aria-label", "Ver todas las paradas");
    btn.title = "Ver todas las paradas";
    btn.innerHTML = `${icon('map')} Ver todo`;
    L.DomEvent.disableClickPropagation(bar);
    L.DomEvent.on(btn, "click", (ev) => {
      L.DomEvent.preventDefault(ev);
      map.closePopup();
      map.fitBounds(pts, { padding: [30, 30], maxZoom: 16 });
    });
    return bar;
  };
  control.addTo(map);
}
export async function initMap() {
  const el = document.getElementById('map');
  if (!el) return;
  // Si el mapa ya estaba abierto y se redibuja por datos nuevos, conserva el zoom y el lugar donde estabas.
  const prev = leafletMap ? { center: leafletMap.getCenter(), zoom: leafletMap.getZoom() } : null;
  leafletMap?.remove();
  leafletMap = null;
  let L;
  try { L = await loadLeaflet(); } catch {
    if (document.getElementById('map') === el) el.innerHTML = '<div class="empty">Necesitas internet para ver el mapa.</div>';
    return;
  }
  if (document.getElementById('map') !== el) return; // se cambió de pantalla mientras cargaba
  const c = ctx();
  const byId = Object.fromEntries(c.expenses.map((e) => [e.id, e]));
  const { places, path } = routeFrom(c.expenses, 3, currencies().dest.code);
  let focus = null; // el lugar del gasto que se pidió ver (desde el pin de la lista)
  el.innerHTML = '';
  const map = L.map(el, { zoomControl: false });
  leafletMap = map;
  L.control.zoom({ position: 'bottomright', zoomInTitle: 'Acercar', zoomOutTitle: 'Alejar' }).addTo(map);
  addBaseTiles(L, map);
  // El recorrido (línea punteada) va debajo; encima, cada parada numerada por orden de primera visita.
  const brand = getComputedStyle(document.documentElement).getPropertyValue('--brand').trim() || '#0b6b4a';
  if (path.length > 1) L.polyline(path, { color: brand, weight: 4, opacity: 0.75, dashArray: '2 9', lineCap: 'round', interactive: false }).addTo(map);
  stopMarkers.clear();
  for (const p of places) {
    const lines = p.ids.slice(0, 5).map((id) => `<li>${esc(byId[id]?.description || 'Gasto')}</li>`).join('');
    const more = p.ids.length > 5 ? `<li class="more">y ${p.ids.length - 5} más</li>` : '';
    const when = p.first_date === p.last_date ? dayLabel(p.first_date) : `${dayLabel(p.first_date)} a ${dayLabel(p.last_date)}`;
    const html = `<div class="pop"><div class="pop-t">Parada ${p.n}</div><b>${esc(p.place || formatCoords(p.lat, p.lng))}</b>
      <div class="pop-d">${esc(when)}</div><ul>${lines}${more}</ul>
      <div class="pop-total">${fmtHome(p.total_home)} <span>${fmtDest(p.total_dest)}</span></div></div>`;
    const last = places.length > 1 && p.n === places.length;
    const icon = L.divIcon({ className: `stop${last ? ' last' : ''}`, html: `<span>${p.n}</span>`, iconSize: [34, 34], iconAnchor: [17, 17], popupAnchor: [0, -17] });
    const marker = L.marker([p.lat, p.lng], { icon, title: `Parada ${p.n}`, alt: `Parada ${p.n}` }).addTo(map).bindPopup(html, { maxWidth: 260 });
    stopMarkers.set(p.n, marker);
    if (mapFocus && p.ids.includes(mapFocus)) focus = { p, marker };
  }
  const pts = places.map((p) => [p.lat, p.lng]);
  if (pts.length > 1) addFitControl(L, map, pts);
  if (focus) { map.setView([focus.p.lat, focus.p.lng], 16); focus.marker.openPopup(); }
  else if (prev) map.setView(prev.center, prev.zoom);
  else if (pts.length === 1) map.setView(pts[0], 15);
  else map.fitBounds(pts, { padding: [30, 30], maxZoom: 16 });
  lastMapSig = mapSig();
}
// La app se sincroniza sola cada 30 s y al volver a ella. Para que el mapa no se reinicie (zoom, popup abierto)
// con cada sincronización, solo se redibuja si cambió algo de lo que muestra.
export let lastMapSig = '';
let mapFocus = ''; // id del gasto cuyo lugar se abre al entrar al mapa
export function setMapFocus(value) { mapFocus = value; return value; }
export const mapSig = () => JSON.stringify([routeFrom(ctx().expenses, 3, currencies().dest.code), mapFocus]);
