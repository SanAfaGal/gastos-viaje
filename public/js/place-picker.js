// Diálogo "Lugar del gasto": pegar desde Google Maps, tocar el mapa, lugares visitados y tu ubicación.
import { hasLocation } from './places.mjs';
import * as store from './store.js';
import { googleMapsUrl, isBareShortPlusCode, isShortMapLink, parseCoordinates, parsePlusCode, reverseAddress, searchPlaces, shortPlusCodeWithPlace } from './geosearch.mjs';
import { PICK_MIN_ZOOM, TAP_ZOOM, buildList, confirmPlace, selectionSummary } from './picker.mjs';
import { icon } from './icons.mjs';
import { readPosition, zoomForAccuracy } from './geolocate.mjs';
import { knownPlaces, recentPlaces, visitedPlaces } from './nearby.mjs';
import { esc, toast } from './ui.js';
import { ctx, dayLabel } from './shared.js';
import { draft, paintLoc } from './view-form.js';
import { addBaseTiles, loadLeaflet } from './view-map.js';

// --- Lugar del gasto: un solo diálogo con mapa (la lógica sin DOM está en picker.mjs) ---
//
// El lugar sale de Google Maps: se abre allí (botón "Abrir Google Maps"), se busca el sitio y se pega aquí el enlace, las coordenadas o el
// Plus Code. También se puede usar 📍 Mi ubicación o tocar el mapa. Toda acción fija un *ancla*: "Este punto" (seleccionado por defecto, con
// su nombre) y, debajo, los lugares que ya usaste cerca. "Usar este lugar" confirma. El mapa tiene alto fijo y la lista hace scroll debajo.

const $pick = document.getElementById('map-pick');
const $pickOk = document.getElementById('pick-ok');
const $pickPanel = document.getElementById('pick-panel');
const $pickSel = document.getElementById('pick-sel');
const $pickPaste = document.getElementById('pick-paste');
const $pickGmaps = document.getElementById('pick-gmaps');
const $pickVisited = document.getElementById('pick-visited');
let pickMap = null;
let pickLeaflet = null;
let pickLayer = null; // marcadores numerados de los lugares ya usados
let pickPin = null; // el pin de lo elegido
let pickResize = null;
let pickGps = null; // punto azul + círculo de precisión de dónde estás
let geoRef = null; // última ubicación del dispositivo en esta sesión, si dio permiso
let geoFix = null; // la misma, con su precisión y la hora en que se leyó: { lat, lng, accuracy, at }
let geoWarm = null; // lectura en segundo plano en curso (promesa)
let geoDenied = false; // el usuario negó el permiso: no se vuelve a pedir solo
const GEO_FRESH_MS = 60 * 1000; // una lectura de hace menos de esto se muestra de una vez al abrir el selector
const pk = {
  target: null, anchor: null, known: [], items: [], selKey: 'point', typed: '', note: '', touched: false,
  seq: 0, ctl: null, locCtl: null, userMoved: false,
  visitedOpen: false, vq: '', visited: [], // lista de lugares ya visitados en este viaje, con su búsqueda
  recent: [], // lugares usados hace poco (con los del mismo día primero), para elegirlos de un toque al abrir
};
const pickSel = () => pk.items.find((i) => i.key === pk.selKey) ?? null;
// Una fila de la lista: número (el mismo del mapa), nombre, detalle y una marca si es la elegida.
function rowHtml(c, i, attr = 'data-i') {
  const sel = c.key === pk.selKey;
  const point = c.kind === 'point';
  const where = selectionSummary({ ...c, name: '' });
  const name = point ? 'Este punto' : (c.name || 'Sin nombre');
  const sub = point ? `${where.title} · ${where.sub}` : `✓ Ya lo usaste · ${c.count} gasto${c.count === 1 ? '' : 's'}`;
  const badge = point ? `<span class="pk-ico" aria-hidden="true">${icon('mappin')}</span>` : `<span class="stop-n" aria-hidden="true">${c.n ?? '•'}</span>`;
  return `<button type="button" class="pick-res${sel ? ' sel' : ''}${point ? '' : ' known'}" ${attr}="${i}" aria-pressed="${sel}">${badge}
    <span class="sug-txt"><b>${esc(name)}</b><span class="muted">${esc(sub)}</span></span><span class="pk-tick" aria-hidden="true">✓</span></button>`;
}
function idleHtml() {
  // Con lugares recientes se muestran primero (un toque y listo).
  const recent = pk.recent.length ? `<section class="pk-sec known"><h3 class="sug-h">Lugares recientes</h3><div class="sug-list">${pk.recent.map((r, i) => `<button type="button" class="pick-res known" data-r="${i}">
        <span class="pk-ico" aria-hidden="true">${icon('clock')}</span>
        <span class="sug-txt"><b>${esc(r.name || 'Sin nombre')}</b><span class="muted">${esc(`${r.today ? 'Ya hay un gasto de este día' : dayLabel(r.last)} · ${r.count} gasto${r.count === 1 ? '' : 's'}`)}</span></span><span class="pk-tick" aria-hidden="true">✓</span></button>`).join('')}</div></section>` : '';
  return `${recent}<div class="pk-help"><p><b>Lo que puedes pegar</b></p>
    <ul><li><span aria-hidden="true">${icon('pin')}</span><span><b>Enlace</b> de Google Maps, corto o largo <span class="muted">(maps.app.goo.gl/…)</span></span></li>
    <li><span aria-hidden="true">${icon('crosshair')}</span><span><b>Coordenadas</b> <span class="muted">(6.1732, -75.6298)</span></span></li>
    <li><span aria-hidden="true">${icon('pointer')}</span><span><b>Plus Code</b> con la ciudad <span class="muted">(59FC+73 Itagüí)</span></span></li></ul></div>
    ${pk.note ? `<div class="sug-note">${esc(pk.note)}</div>` : ''}`;
}
function anchorHtml() {
  const [point, ...rest] = pk.items;
  const known = rest.filter((c) => c.kind === 'known');
  const idx = (c) => pk.items.indexOf(c);
  const nameInput = point.key === pk.selKey
    ? `<div class="pk-name"><label for="pick-name" class="sr-only">Nombre del lugar (obligatorio)</label>
        <input id="pick-name" maxlength="120" autocomplete="off" placeholder="Nombre del lugar (obligatorio)" aria-required="true" value="${esc(pk.typed)}"></div>` : '';
  return `${rowHtml(point, 0)}${nameInput}
    ${known.length ? `<section class="pk-sec known"><h3 class="sug-h">Lugares que ya usaste <span>${known.length}</span></h3><div class="sug-list">${known.map((c) => rowHtml(c, idx(c))).join('')}</div></section>` : ''}
    ${pk.note ? `<div class="sug-note">${esc(pk.note)}</div>` : ''}`;
}
// Lugares visitados en este viaje (con ubicación): una búsqueda y la lista completa, del más reciente al más antiguo. Elegir uno es un toque.
function visitedListHtml() {
  pk.visited = visitedPlaces(ctx().expenses, { query: pk.vq });
  if (!pk.visited.length) return `<div class="sug-note">${pk.vq.trim() ? 'Ningún lugar visitado coincide con esa búsqueda.' : 'Todavía no hay lugares con ubicación en este viaje.'}</div>`;
  return pk.visited.map((r, i) => `<button type="button" class="pick-res known" data-v="${i}">
      <span class="pk-ico" aria-hidden="true">${icon('clock')}</span>
      <span class="sug-txt"><b>${esc(r.name || 'Sin nombre')}</b><span class="muted">${esc(`${dayLabel(r.last)} · ${r.count} gasto${r.count === 1 ? '' : 's'}`)}</span></span><span class="pk-tick" aria-hidden="true">✓</span></button>`).join('');
}
function visitedHtml() {
  const list = visitedListHtml();
  return `<section class="pk-sec known"><h3 class="sug-h">Lugares visitados en este viaje <span id="pick-vn">${pk.visited.length}</span></h3>
    <div class="pk-name"><label for="pick-vq" class="sr-only">Buscar entre los lugares visitados</label>
      <input id="pick-vq" type="search" maxlength="80" autocomplete="off" placeholder="Buscar un lugar visitado" value="${esc(pk.vq)}"></div>
    <div class="sug-list" id="pick-vlist">${list}</div></section>`;
}
function paintPick() {
  pk.items = buildList({ anchor: pk.anchor, known: pk.known, typed: pk.typed });
  if (!pk.items.some((i) => i.key === pk.selKey)) pk.selKey = 'point';
  const top = $pickPanel.scrollTop;
  const mode = pk.visitedOpen ? 'visited' : pk.anchor ? 'anchor' : 'idle';
  $pickPanel.innerHTML = mode === 'visited' ? visitedHtml() : mode === 'anchor' ? anchorHtml() : idleHtml();
  $pickVisited.setAttribute('aria-pressed', String(pk.visitedOpen));
  if ($pickPanel.dataset.mode === mode) $pickPanel.scrollTop = top; // el redibujo no manda la lista de vuelta al inicio
  $pickPanel.dataset.mode = mode;
  updatePickFoot();
}
function updatePickFoot() {
  const sel = pickSel();
  const { title, sub } = selectionSummary(sel);
  // Todo lugar lleva al menos un nombre: un punto del mapa sin nombre no se puede usar hasta que se escriba uno (o se elija un sitio de la lista).
  const needsName = Boolean(sel) && sel.kind === 'point' && !String(sel.name ?? '').trim();
  $pickSel.innerHTML = needsName
    ? '<b>Falta el nombre</b><span class="muted">Escribe cómo llamar a este lugar o elige uno de la lista.</span>'
    : `<b>${esc(title)}</b><span class="muted">${esc(sub)}</span>`;
  $pickOk.disabled = !sel || needsName;
}
// Mapa: el pin va donde está lo elegido; los demás candidatos son círculos numerados (tocar uno lo elige).
function drawPickMap() {
  if (!pickMap || !pickLayer) return;
  const L = pickLeaflet;
  pickLayer.clearLayers();
  const sel = pickSel();
  const pts = [];
  pk.items.forEach((c, i) => {
    if (c.kind === 'point') return;
    pts.push([c.lat, c.lng]);
    if (c === sel) return; // lo elegido lo representa el pin
    const icon = L.divIcon({ className: `stop${c.kind === 'known' ? '' : ' last'}`, html: `<span>${c.n}</span>`, iconSize: [34, 34], iconAnchor: [17, 17] });
    L.marker([c.lat, c.lng], { icon, title: c.name || `Lugar ${c.n}`, alt: c.name || `Lugar ${c.n}` })
      .on('click', () => selectPick(i)).addTo(pickLayer);
  });
  if (sel) {
    if (pickPin) pickPin.setLatLng([sel.lat, sel.lng]);
    else {
      pickPin = L.marker([sel.lat, sel.lng], { title: 'Lugar elegido', alt: 'Lugar elegido', keyboard: false }).addTo(pickMap);
    }
  }
  // Con tu ubicación o un resultado se encuadra el ancla con sus candidatos; con un toque suelto no se toca la vista (el usuario ya
  // eligió dónde mirar). Si moviste el mapa tú, tampoco.
  if (!pk.touched && pk.anchor && ['gps', 'result', 'coords'].includes(pk.anchor.source) && pts.length) {
    pickMap.fitBounds([[pk.anchor.lat, pk.anchor.lng], ...pts], { padding: [40, 40], maxZoom: 18, animate: false });
  }
}
function selectPick(i) {
  const c = pk.items[i];
  if (!c) return;
  pk.selKey = c.key;
  paintPick();
  drawPickMap();
  const ll = [c.lat, c.lng];
  if (pickMap && !pickMap.getBounds().pad(-0.12).contains(ll)) pickMap.panTo(ll);
}
// Fija el ancla y arma la lista: "Este punto" y los lugares que ya usaste cerca (al instante, sin red).
function setAnchor(at, { source, name = '' } = {}) {
  Object.assign(pk, {
    anchor: { lat: at.lat, lng: at.lng, source }, typed: name, selKey: 'point', known: knownPlaces(ctx().expenses, at),
    note: '', touched: false, visitedOpen: false,
  });
  pk.ctl?.abort();
  pk.ctl = new AbortController();
  const seq = (pk.seq += 1);
  pickMap?.getContainer().addEventListener('pointerdown', () => { pk.touched = true; }, { once: true });
  paintPick();
  drawPickMap();
  if (!name.trim()) suggestPointName(at, seq);
}
// Un punto sin nombre (un toque en el mapa, tu ubicación, coordenadas) arranca con la dirección del sitio como nombre, que se puede cambiar:
// así casi nunca hay que escribir uno. Es gratis (Photon). Si ya escribiste un nombre, no lo pisa.
async function suggestPointName(at, seq) {
  try {
    const found = await reverseAddress(at, { signal: pk.ctl?.signal });
    if (!found || seq !== pk.seq || pk.typed.trim()) return;
    if (document.activeElement?.id === 'pick-name') return; // lo está escribiendo
    pk.typed = found;
    const point = pk.items.find((i) => i.key === 'point');
    if (point) point.name = found;
    paintPick();
    updatePickFoot();
  } catch { /* sin red o cancelado: queda el campo vacío para escribirlo */ }
}
function onMapTap(ll) {
  const z = pickMap.getZoom();
  // Muy alejado un toque no distingue una tienda de otra: se acerca al punto en vez de ignorarlo.
  if (z < PICK_MIN_ZOOM) pickMap.setView(ll, TAP_ZOOM);
  setAnchor(ll, { source: 'tap' });
}
export async function openPicker() {
  if (!draft) return;
  const target = draft;
  for (const c of [pk.ctl, pk.locCtl]) c?.abort();
  Object.assign(pk, {
    target, anchor: null, known: [], items: [], selKey: 'point', typed: '', note: '',
    touched: false, userMoved: false, locating: false, force: false, visitedOpen: false, vq: '', visited: [],
    recent: target.lat == null ? recentPlaces(ctx().expenses, { date: target.date, limit: 5 }) : [],
  });
  pk.seq += 1;
  // El mapa de la vez anterior ya no sirve.
  pickGps = null;
  pickResize?.disconnect();
  pickMap?.remove();
  pickMap = null;
  pickPin = null;
  $pickVisited.disabled = !visitedPlaces(ctx().expenses).length;
  $pickVisited.title = $pickVisited.disabled ? 'Aún no hay lugares visitados en este viaje' : 'Elegir entre los lugares ya visitados';
  paintPick();
  const box = document.getElementById('pick-map');
  box.innerHTML = '<div class="empty">Cargando mapa…</div>';
  $pick.showModal();
  try { pickLeaflet = await loadLeaflet(); } catch {
    box.innerHTML = '<div class="empty">No se pudo cargar el mapa. Puedes pegar el enlace, las coordenadas o el Plus Code de Google Maps.</div>';
    return;
  }
  if (!$pick.open || pk.target !== target) return;
  const L = pickLeaflet;
  box.innerHTML = '';
  pickResize?.disconnect();
  pickMap?.remove();
  pickPin = null;
  pickMap = L.map(box, { zoomControl: false });
  L.control.zoom({ position: 'bottomright', zoomInTitle: 'Acercar', zoomOutTitle: 'Alejar' }).addTo(pickMap);
  addBaseTiles(L, pickMap);
  pickLayer = L.layerGroup().addTo(pickMap);
  // Dentro del diálogo el tamaño real se conoce un instante después de abrirlo, y cambia si aparece el teclado o se gira el teléfono.
  if (typeof ResizeObserver === 'function') {
    pickResize = new ResizeObserver(() => pickMap?.invalidateSize());
    pickResize.observe(box);
  }
  // Arranca donde ya estaba el gasto; si no, donde estuviste hace poco; si no, en el último gasto con ubicación; si no, el mundo.
  const last = ctx().expenses.find(hasLocation);
  if (target.lat != null) {
    pickMap.setView([target.lat, target.lng], 17);
    setAnchor({ lat: target.lat, lng: target.lng }, { source: 'saved', name: target.place });
  } else if (last) pickMap.setView([Number(last.lat), Number(last.lng)], 15);
  else pickMap.setView([20, 0], 2);
  addLocateControl(L, pickMap);
  pickMap.on('dragstart', () => { pk.userMoved = true; }); // si ya moviste el mapa tú, tu ubicación no lo mueve
  // Siempre se muestra dónde estás (punto azul). Si ya hay una lectura de hace poco (la de segundo plano), aparece de una vez; si la lectura de
  // segundo plano sigue en curso, se dibuja cuando termine; y si no hay nada reciente, se lee ahora. Sin lugar guardado el mapa se centra ahí;
  // con uno guardado el mapa se queda en ese lugar y solo se ve el punto.
  const center = target.lat == null;
  const now = freshFix();
  if (now) drawMe(now, { move: center });
  if (geoWarm) geoWarm.then(() => { const f = freshFix(); if (f && pk.target === target) drawMe(f, { move: center && !pk.userMoved }); });
  if (!now || now.accuracy > 50) locateMe(target);
  pickMap.on('click', (ev) => onMapTap(ev.latlng)); // un toque en el mapa elige ese punto
  requestAnimationFrame(() => pickMap?.invalidateSize());
}
// --- pegar desde Google Maps ---

// Punto de referencia para abrir Google Maps cerca de donde se está mirando: el ancla, o lo que se ve en el mapa, o el último gasto.
function pickSearchRef() {
  if (pk.anchor) return { lat: pk.anchor.lat, lng: pk.anchor.lng };
  const c = pickMap?.getCenter();
  if (c && pickMap.getZoom() >= 8) return { lat: c.lat, lng: c.lng };
  if (geoRef) return { ...geoRef };
  const last = ctx().expenses.find(hasLocation);
  return last ? { lat: Number(last.lat), lng: Number(last.lng) } : null;
}
// Lo que se pega tiene que venir de Google Maps: un enlace, coordenadas o un Plus Code. No hay búsqueda por nombre.
function handlePasted(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return;
  pk.note = '';
  // Con la ciudad escrita ("59FC+73 Itagüí, Antioquia"), la ciudad es la referencia del código, no el mapa ni tu último gasto.
  const withCity = shortPlusCodeWithPlace(text);
  if (withCity) return openShortPlusCode(withCity);
  // Un código corto sin ciudad se completaría con el mapa o con tu último gasto, que pueden estar en otro país: mejor pedir la ciudad.
  if (isBareShortPlusCode(text)) {
    pk.note = 'Ese Plus Code es corto: agrégale la ciudad (por ejemplo “59FC+73 Itagüí”) o pega el código completo.';
    return paintPick();
  }
  const found = parseCoordinates(text);
  if (found) return chooseCoords(found);
  if (isShortMapLink(text)) return openShortLink(text);
  pk.note = 'No reconozco eso. Copia de Google Maps el enlace, las coordenadas o el Plus Code (toca la “i” para ver cómo).';
  paintPick();
}
// Plus Code corto con ciudad: se ubica la ciudad (Photon y Nominatim, gratis) y con ella se completa el código.
let plusSeq = 0;
async function openShortPlusCode({ code, place }) {
  const seq = (plusSeq += 1);
  pk.note = '';
  toast(`Ubicando “${place}” para completar el código…`);
  try {
    const { results } = await searchPlaces(place, { ref: null });
    if (seq !== plusSeq || !$pick.open) return;
    // La primera con coordenadas que sea una zona (ciudad, barrio) o cualquier lugar: basta con que esté cerca del código.
    const city = results.find((r) => Number.isFinite(r.lat) && Number.isFinite(r.lng));
    const found = city ? parsePlusCode(code, { ref: city }) : null;
    if (found) {
      chooseCoords({ lat: found.lat, lng: found.lng });
    } else {
      pk.note = `No pude ubicar “${place}”. Pega el código completo (empieza con 4 letras o números más, por ejemplo 67R659FC+73) o las coordenadas.`;
      paintPick();
    }
  } catch (err) {
    if (seq !== plusSeq) return;
    pk.note = 'No se pudo ubicar la ciudad del código. Revisa tu conexión.';
    paintPick();
  }
}
// Enlace corto de Google Maps: el servidor lo abre y devuelve las coordenadas.
let linkSeq = 0;
async function openShortLink(url) {
  const seq = (linkSeq += 1);
  pk.note = '';
  toast('Abriendo el enlace de Google Maps…');
  try {
    const r = await store.resolvePlaceLink(url);
    if (seq !== linkSeq || !$pick.open) return;
    if (r.lat != null && r.lng != null) {
      chooseCoords({ lat: r.lat, lng: r.lng, name: r.name });
    } else {
      pk.note = 'Ese enlace no trae las coordenadas. En Google Maps toca el lugar y copia el enlace desde “Compartir”, o copia las coordenadas o el Plus Code.';
      paintPick();
    }
  } catch (err) {
    if (seq !== linkSeq) return;
    pk.note = err.offline ? 'Necesitas internet para abrir un enlace de Google Maps.' : `No se pudo abrir el enlace: ${err.message}`;
    paintPick();
  } finally {
  }
}
// Se guarda toda lectura buena para tenerla lista la próxima vez.
function rememberFix(f) {
  geoFix = { lat: f.lat, lng: f.lng, accuracy: f.accuracy, at: Date.now() };
  geoRef = { lat: f.lat, lng: f.lng };
}
const freshFix = () => (geoFix && Date.now() - geoFix.at < GEO_FRESH_MS ? geoFix : null);
// Mientras llenas el gasto (monto, medio de pago…) se lee dónde estás en segundo plano, para que al tocar "Elegir lugar" el punto ya esté ahí.
// Una sola lectura a la vez; si hay una reciente no se repite; si negaste el permiso no se insiste.
export function warmLocation() {
  if (!navigator.geolocation || geoWarm || geoDenied || freshFix()) return;
  geoWarm = readPosition({ maxMs: 12000 })
    .then((f) => { rememberFix(f); })
    .catch((err) => { if (err?.code === 1) geoDenied = true; })
    .finally(() => { geoWarm = null; });
}
// Al abrir el diálogo: se lee el GPS (si el navegador lo permite) y el mapa se centra donde estás, con un punto azul y
// su círculo de precisión. Solo mira: no pone el pin ni elige nada, y si ya moviste el mapa o elegiste un punto, no lo mueve.
function drawMe(fix, { move, force = false }) {
  if (!$pick.open || !pickMap || !pickLeaflet) return;
  const L = pickLeaflet;
  const color = getComputedStyle(document.documentElement).getPropertyValue('--brand').trim() || '#0b6b4a';
  pickGps?.clearLayers();
  pickGps ??= L.layerGroup().addTo(pickMap);
  if (fix.accuracy) L.circle([fix.lat, fix.lng], { radius: fix.accuracy, color, weight: 1, fillOpacity: 0.1, interactive: false }).addTo(pickGps);
  L.circleMarker([fix.lat, fix.lng], { radius: 8, color: '#fff', weight: 3, fillColor: color, fillOpacity: 1, interactive: false }).addTo(pickGps);
  // Al abrir no se mueve el mapa si ya lo moviste tú o ya elegiste un punto; con el botón de la mira (force) siempre.
  if (move && (force || (!pk.userMoved && !pk.anchor))) pickMap.setView([fix.lat, fix.lng], zoomForAccuracy(fix.accuracy), { animate: false });
}
// Lee el GPS y centra el mapa donde estás. Al abrir es silencioso (sin permiso o sin señal, el mapa queda donde estaba); con el botón de la
// mira (`bar`) mueve el mapa siempre y avisa si no pudo. Tocar la mira mientras ya se está buscando hace que la siguiente lectura sí mueva el mapa.
async function locateMe(target, { bar = null } = {}) {
  if (!navigator.geolocation) { if (bar) toast('Este dispositivo no permite obtener la ubicación.', 'error'); return; }
  if (bar) { pk.force = true; bar.classList.add('locating'); }
  if (pk.locating) return;
  pk.locating = true;
  pk.locCtl = new AbortController();
  try {
    let moved = false;
    const fix = await readPosition({
      maxMs: 8000, signal: pk.locCtl.signal,
      // La primera lectura (aunque sea aproximada) mueve el mapa; las mejores solo afinan el punto.
      onFix: (f) => { if (pk.target === target) { drawMe(f, { move: !moved || pk.force, force: pk.force }); moved = true; pk.force = false; } },
    });
    if (pk.target !== target) return;
    rememberFix(fix);
    geoDenied = false;
    drawMe(fix, { move: pk.force, force: pk.force });
  } catch (err) {
    if (err?.code === 1) geoDenied = true;
    if (pk.force && err?.code !== 0 && pk.target === target) toast(err?.code === 1 ? 'Sin permiso de ubicación. Actívalo en el navegador.' : 'No se pudo obtener tu ubicación.', 'error');
  } finally {
    pk.locating = false;
    pk.force = false;
    document.querySelector('#pick-map .locate-ctl')?.classList.remove('locating');
  }
}
// Botón de la mira en el mapa: vuelve a centrarlo donde estás.
function addLocateControl(L, map) {
  if (!navigator.geolocation) return;
  const control = L.control({ position: 'bottomright' });
  control.onAdd = () => {
    const bar = L.DomUtil.create('div', 'leaflet-bar locate-ctl');
    const btn = L.DomUtil.create('a', '', bar);
    btn.href = '#';
    btn.setAttribute('role', 'button');
    btn.setAttribute('aria-label', 'Ir a mi ubicación');
    btn.title = 'Ir a mi ubicación';
    btn.innerHTML = '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" focusable="false"><circle cx="12" cy="12" r="6.5" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="12" cy="12" r="2.2" fill="currentColor"/><path d="M12 2v3.5M12 18.5V22M2 12h3.5M18.5 12H22" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
    L.DomEvent.disableClickPropagation(bar);
    L.DomEvent.on(btn, 'click', (ev) => { L.DomEvent.preventDefault(ev); if (pk.target) locateMe(pk.target, { bar }); });
    return bar;
  };
  control.addTo(map);
}
// Elegir un lugar reciente: el mapa va ahí y queda como "Este punto" con su nombre y sus coordenadas exactas (listo para confirmar).
function pickRecent(r) {
  if (!r) return;
  if (pickMap) pickMap.setView([r.lat, r.lng], Math.max(pickMap.getZoom(), TAP_ZOOM), { animate: false });
  setAnchor({ lat: r.lat, lng: r.lng }, { source: 'recent', name: r.name });
}
// Punto pegado desde Google Maps: el mapa va ahí y queda como "Este punto", con el nombre del enlace si traía (si no, la dirección).
function chooseCoords(c) {
  if (pickMap) pickMap.setView([c.lat, c.lng], Math.max(pickMap.getZoom(), TAP_ZOOM), { animate: false });
  setAnchor({ lat: c.lat, lng: c.lng }, { source: 'coords', name: (c.name ?? '').slice(0, 120) });
}
// Ayuda del selector de lugar (el ⓘ de arriba): todas las formas de encontrar el sitio, con un ejemplo de cada una.
function pickHelpHtml() {
  const row = (ic, title, text) => `<li><span class="bd pinb" aria-hidden="true">${icon(ic)}</span><span><b>${title}</b><span class="muted">${text}</span></span></li>`;
  return `<ul class="legend">
    ${row('pin', 'Desde Google Maps (lo más preciso)', 'Toca <b>Abrir Google Maps</b>, busca el lugar y elige una de estas formas. Luego vuelve y toca <b>Pegar</b>.')}
    ${row('pin', 'Enlace', 'En el lugar toca <b>Compartir → Copiar enlace</b>. Sirve el enlace corto (<i>maps.app.goo.gl/…</i>) y el largo. Necesita internet.')}
    ${row('pin', 'Plus Code', 'Toca el lugar y mira debajo de las coordenadas (por ejemplo <i>59FC+73 Itagüí</i>). Cópialo con la ciudad, o completo (<i>67R659FC+73</i>).')}
    ${row('pin', 'Coordenadas', 'Toca el lugar en Google Maps y copia los números de arriba (<i>6.1732, -75.6298</i>). También sirven en grados (<i>6°10′23″N 75°37′47″W</i>).')}
    ${row('mappin', 'Tu ubicación', 'Al abrir esta pantalla el mapa se centra donde estás, con un punto azul. El botón de la mira, en el mapa, vuelve a centrarlo. Solo sirve para orientarte: el lugar del gasto lo eliges tú.')}
    ${row('pin', 'Tocar el mapa', 'Toca el sitio exacto en el mapa de esta pantalla.')}
    ${row('clock', 'Lugares visitados', 'El botón <b>Visitados</b> abre la lista de todos los lugares de este viaje, con un buscador. Elegir uno es un toque: no hace falta volver a Google Maps. Los que están cerca del punto elegido también salen en verde debajo.')}
  </ul>
  <p class="muted">Todo lugar lleva un nombre. Si no hay uno, se sugiere la dirección y lo puedes cambiar. Si el punto quedó corrido, toca el mapa donde es.</p>`;
}
const $pickHelp = document.getElementById('pick-help');

export function initPicker() {
  // "Pegar": lee el portapapeles (el navegador pide permiso la primera vez) y procesa lo que haya. Si no puede leerlo, pide pegarlo a mano.
$pickPaste.addEventListener('click', async () => {
    let text = '';
    try {
      text = await navigator.clipboard.readText();
    } catch {
      text = window.prompt('Pega aquí el enlace, las coordenadas o el Plus Code de Google Maps:') ?? '';
      if (!text.trim()) return;
    }
    if (!String(text).trim()) { pk.note = 'No hay nada copiado. En Google Maps copia el enlace, las coordenadas o el Plus Code y vuelve a tocar Pegar.'; return paintPick(); }
    handlePasted(text);
  });
  // "Abrir Google Maps": en otra pestaña (o en la app de Mapas del celular), centrado donde estás mirando. Ahí se busca el lugar y se copia.
$pickGmaps.addEventListener('click', () => {
    window.open(googleMapsUrl(pickSearchRef()), '_blank', 'noopener');
  });
  // "Visitados": muestra u oculta la lista de lugares ya visitados en este viaje.
$pickVisited.addEventListener('click', () => {
    pk.visitedOpen = !pk.visitedOpen;
    pk.vq = '';
    paintPick();
    if (pk.visitedOpen) $pickPanel.scrollTop = 0;
  });
$pickPanel.addEventListener('click', (ev) => {
    const t = ev.target;
    const vp = t.closest('[data-v]');
    if (vp) { pickRecent(pk.visited[Number(vp.dataset.v)]); return; } // setAnchor cierra la lista
    const rc = t.closest('[data-r]');
    if (rc) { pickRecent(pk.recent[Number(rc.dataset.r)]); return; }
    const r = t.closest('[data-i]');
    if (r) selectPick(Number(r.dataset.i));
  });
$pickPanel.addEventListener('input', (ev) => {
    if (ev.target.id === 'pick-vq') { // solo se redibuja la lista: así el campo no pierde el foco
      pk.vq = ev.target.value;
      document.getElementById('pick-vlist').innerHTML = visitedListHtml();
      document.getElementById('pick-vn').textContent = pk.visited.length;
      return;
    }
    if (ev.target.id !== 'pick-name') return;
    pk.typed = ev.target.value;
    // La lista ya está armada con el nombre de antes: se pone el nuevo en el punto elegido. Sin esto el pie del diálogo y
    // "Usar este lugar" seguían usando el nombre vacío y lo escrito se perdía.
    const point = pk.items.find((i) => i.key === 'point');
    if (point) point.name = pk.typed;
    updatePickFoot();
  });
$pickOk.addEventListener('click', () => {
    const sel = pickSel();
    const target = pk.target;
    if (sel && target && target === draft) {
      target.lat = sel.lat;
      target.lng = sel.lng;
      target.place = confirmPlace(target.place, sel);
      paintLoc();
    }
    $pick.close();
  });
document.getElementById('pick-help-body').innerHTML = pickHelpHtml();
$pickHelp.addEventListener('click', (ev) => { if (ev.target === $pickHelp || ev.target.closest('[data-help-close]')) $pickHelp.close(); });
$pick.addEventListener('click', (ev) => {
    if (ev.target.closest('#pick-info')) return $pickHelp.showModal();
    if (ev.target === $pick || ev.target.closest('[data-pick-cancel]')) $pick.close();
  });
$pick.addEventListener('close', () => {
    for (const c of [pk.ctl, pk.locCtl]) c?.abort();
    pk.seq += 1;
    pickResize?.disconnect();
    pickMap?.remove();
    pickMap = null;
    pickLayer = null;
    pickPin = null;
    pickGps = null;
    pk.target = null;
  });
}
