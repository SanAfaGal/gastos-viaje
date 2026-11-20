// Rutas, dibujo de la pantalla actual, cambio de viaje, estado de conexión y sincronización.
import * as store from './store.js';
import { icon } from './icons.mjs';
import { $status, $title, $tripBtn, $tripSwitch, $view, esc, toast } from './ui.js';
import { ctx } from './shared.js';
import { centerPicked, draft, setConvRate, setDraft, updateConv, viewForm } from './view-form.js';
import { homeChart, viewHome } from './view-home.js';
import { dragSt, resetFilters, viewList } from './view-list.js';
import { payOpen, setPayDraft, setPayOpen, viewAccounts } from './view-accounts.js';
import { methodOpen, personOpen, setEditMethod, setEditPerson, setEditTrip, setMethodOpen, setPersonOpen, setTripOpen, tripOpen, viewSettings } from './view-settings.js';
import { resetSpaces, ensureSpaces, setSpaceOpen, spaceOpen, viewManage } from './view-spaces.js';
import { initMap, lastMapSig, leafletMap, mapSig, setLastNonMap, setLeafletMap, setMapFocus, viewMap } from './view-map.js';

function viewLogin() {
  return `<form id="login" class="login card"><h2>Código de acceso</h2>
    ${store.net.lockReason ? `<p class="form-error" role="alert">${esc(store.net.lockReason)}</p>` : ''}
    <p class="muted">Esta app está protegida. Escribe el código para entrar.</p>
    <input id="code" type="password" aria-label="Código de acceso" autocomplete="current-password" placeholder="Código" required>
    <button class="btn" type="submit">Entrar</button></form>`;
}
// ---------- router y eventos ----------

const routes = [
  { re: /^#\/?$/, tab: 'home', title: 'Inicio', view: viewHome },
  { re: /^#\/gastos$/, tab: 'gastos', title: 'Gastos', view: viewList },
  { re: /^#\/nuevo\/(.+)$/, tab: 'nuevo', title: 'Editar gasto', view: (m) => viewForm(decodeURIComponent(m[1])) },
  { re: /^#\/nuevo$/, tab: 'nuevo', title: 'Nuevo gasto', view: () => viewForm(null), form: true },
  { re: /^#\/cuentas$/, tab: 'cuentas', title: 'Cuentas', view: viewAccounts },
  { re: /^#\/ajustes$/, tab: 'ajustes', title: 'Ajustes', view: viewSettings },
  { re: /^#\/mapa(?:\/(.+))?$/, tab: 'ajustes', title: 'Mapa', view: viewMap, map: true },
];
function currentRoute() {
  const hash = location.hash || '#/';
  for (const r of routes) {
    const m = hash.match(r.re);
    if (m) return { r, m };
  }
  return { r: routes[0], m: hash.match(routes[0].re) ?? [] };
}
const isFormRoute = () => /^#\/nuevo/.test(location.hash);
function updateStatus() {
  const n = store.pendingCount();
  let text = 'En línea';
  let cls = 'status';
  if (store.net.syncing) { text = 'Sincronizando…'; cls += ' sync'; }
  else if (!store.net.online) { text = n ? `Sin conexión · ${n} por enviar` : 'Sin conexión'; cls += ' offline'; }
  else if (n) { text = `${n} por enviar`; cls += ' sync'; }
  $status.textContent = text;
  $status.className = cls;
}
let lastHash = null;
// Selector del elemento enfocado dentro de la pantalla, para devolverle el foco tras redibujar.
function focusKey() {
  const el = document.activeElement;
  if (!el || !$view.contains(el) || el === $view) return null;
  if (el.id) return `#${CSS.escape(el.id)}`;
  const { action, id } = el.dataset;
  return action ? `${el.localName}[data-action="${CSS.escape(action)}"]${id ? `[data-id="${CSS.escape(id)}"]` : ''}` : null;
}
// La versión de la app es el nombre de su caché (gastos-viaje-vNN). Se muestra al final de Ajustes para poder comprobar
// que el celular o el navegador ya tiene la última.
async function showAppVersion() {
  let text = 'sin instalar (se carga desde internet)';
  try {
    const v = (await caches.keys()).filter((k) => k.startsWith('gastos-viaje-v')).sort().pop();
    if (v) text = v.replace('gastos-viaje-', '');
  } catch { /* sin Cache API */ }
  if (!document.getElementById('app-version')) $view.insertAdjacentHTML('beforeend', '<p id="app-version" class="muted" style="text-align:center;margin:16px 0 0"></p>');
  const el = document.getElementById('app-version');
  if (el) el.textContent = `Versión de la app: ${text}`;
}
// Una versión nueva de la app: el service worker nuevo toma el control, pero la pantalla abierta sigue con el código viejo hasta
// recargar. Se recarga sola, salvo que haya un gasto a medias: entonces espera a que lo termines o lo cierres.
let updatePending = false;
export function applyUpdate() {
  if (formActive()) {
    updatePending = true;
    toast('Hay una versión nueva. Se aplicará al terminar este gasto.');
    return;
  }
  location.reload();
}
export function render() {
  if (updatePending && !formActive()) { updatePending = false; location.reload(); return; }
  updateStatus();
  // La administración no tiene datos: ni pestañas, ni selector de viaje, ni vistas de viajes, sea cual sea la ruta.
  // Tras una recarga con su código, hasta que llega el primer estado (`awaitingManager`) la pantalla queda vacía.
  const manager = !store.net.needsLogin && (store.isManager() || store.awaitingManager());
  $tripBtn.hidden = store.net.needsLogin || manager;
  document.documentElement.classList.toggle('logged-out', store.net.needsLogin);
  document.documentElement.classList.toggle('manager', manager);
  if (store.net.needsLogin) {
    resetSpaces(); // un código mostrado no sobrevive a cerrar la sesión
    $title.textContent = 'Gastos de viaje';
    $view.innerHTML = viewLogin();
    return;
  }
  if (manager) { renderManager(); return; }
  resetSpaces(); // la tarjeta de espacios solo vive en la pantalla de la administración
  const trip = store.activeTrip();
  $tripBtn.innerHTML = `${icon('plane')} ${esc(trip.name)} · ${esc(trip.dest)}→${esc(trip.home)} ${icon('chevron', 'trip-ch')}`;
  const { r, m } = currentRoute();
  setMapFocus(r.map && m[1] ? decodeURIComponent(m[1]) : '');
  if (dragSt?.active) return; // no se redibuja la lista mientras se arrastra un gasto
  if (r.map && leafletMap && document.querySelector('#map.leaflet-container') && mapSig() === lastMapSig) return;
  if (!isFormRoute()) setDraft(null);
  if (r.tab !== 'ajustes') { setMethodOpen(false); setTripOpen(false); setPersonOpen(false); }
  if (r.tab !== 'cuentas') { setPayOpen(false); setPayDraft(null); }
  $title.textContent = r.title;
  document.title = r.tab === 'home' ? 'Gastos de viaje' : `${r.title} · Gastos de viaje`;
  document.querySelectorAll('.tabbar a').forEach((a) => {
    const here = a.dataset.tab === r.tab;
    a.classList.toggle('active', here);
    if (here) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  });
  if (!r.map && leafletMap) { leafletMap.remove(); setLeafletMap(null); }
  if (!r.map) setLastNonMap(location.hash || '#/');
  const keep = location.hash === lastHash ? focusKey() : null;
  lastHash = location.hash;
  $view.innerHTML = r.view(m);
  if (keep) $view.querySelector(keep)?.focus({ preventScroll: true }); // el redibujo no le quita el foco a quien navega con teclado
  if (r.map) initMap();
  if (r.tab === 'ajustes' && !r.map) showAppVersion();
  if (r.tab === 'home') homeChart();
  if (isFormRoute() && draft) { updateConv(); centerPicked(); }
  if (methodOpen) document.getElementById('method-dialog')?.showModal();
  if (tripOpen) document.getElementById('trip-dialog')?.showModal();
  if (personOpen) document.getElementById('person-dialog')?.showModal();
  if (payOpen) document.getElementById('pay-dialog')?.showModal();
}
// Pantalla de la administración. Nada de lo que dibujan las vistas de datos queda abierto (borrador, diálogos, mapa).
function renderManager() {
  setDraft(null);
  setMethodOpen(false); setTripOpen(false); setPersonOpen(false);
  setPayOpen(false); setPayDraft(null);
  if (leafletMap) { leafletMap.remove(); setLeafletMap(null); }
  if (!store.isManager()) { // aún no llega el primer estado: no se muestra nada
    $title.textContent = 'Gastos de viaje';
    document.title = 'Gastos de viaje';
    $view.innerHTML = '';
    return;
  }
  $title.textContent = 'Administración';
  document.title = 'Administración · Gastos de viaje';
  const keep = location.hash === lastHash ? focusKey() : null;
  lastHash = location.hash;
  $view.innerHTML = viewManage();
  if (keep) $view.querySelector(keep)?.focus({ preventScroll: true });
  ensureSpaces();
  if (spaceOpen) document.getElementById('space-dialog')?.showModal();
}
// Selector de viaje (arriba, en todas las pantallas).
function openTripSwitch() {
  const c = ctx();
  document.getElementById('trip-list').innerHTML = c.trips.map((t) => `
    <button type="button" class="trip-opt ${t.id === c.trip.id ? 'on' : ''}" role="radio" aria-checked="${t.id === c.trip.id}" data-trip="${esc(t.id)}">
      <span><b>${esc(t.name)}</b><span class="muted">${esc(t.dest)} → ${esc(t.home)} · ${c.counts[t.id] ?? 0} gasto(s)</span></span>
      <span class="trip-tick" aria-hidden="true">✓</span>
    </button>`).join('');
  $tripSwitch.showModal();
}
function switchTrip(id) {
  if (id !== store.activeTrip().id) {
    store.setActiveTrip(id);
    setDraft(null); // el borrador y los filtros eran del otro viaje
    setConvRate(null);
    resetFilters();
    if (/^#\/nuevo\/.+/.test(location.hash)) location.hash = '#/gastos'; // el gasto que se editaba era del otro viaje
    else render();
  }
  $tripSwitch.close();
}
const formActive = () => isFormRoute() && draft && !store.net.needsLogin;
// ---------- arranque ----------

export async function sync() {
  try {
    await store.syncNow();
  } catch { /* 401 o sin red: el estado ya lo muestra */ }
  updateStatus();
}

export function initRouter() {
  // Los diálogos se cierran con Cancelar, la X, Escape o tocando fuera. Solo se limpia el estado: la próxima
  // apertura vuelve a dibujar el formulario desde cero.
$view.addEventListener('close', (ev) => {
    if (ev.target.id === 'method-dialog') { setMethodOpen(false); setEditMethod(null); }
    else if (ev.target.id === 'trip-dialog') { setTripOpen(false); setEditTrip(null); }
    else if (ev.target.id === 'person-dialog') { setPersonOpen(false); setEditPerson(null); }
    else if (ev.target.id === 'pay-dialog') { setPayOpen(false); setPayDraft(null); }
    else if (ev.target.id === 'space-dialog') setSpaceOpen(false);
  }, true);
$view.addEventListener('click', (ev) => { if (['method-dialog', 'trip-dialog', 'person-dialog', 'space-dialog', 'pay-dialog'].includes(ev.target.id) || ev.target.matches?.('dialog.info')) ev.target.close(); });
$tripBtn.addEventListener('click', openTripSwitch);
$tripSwitch.addEventListener('click', (ev) => {
    const opt = ev.target.closest('[data-trip]');
    if (opt) switchTrip(opt.dataset.trip);
    else if (ev.target === $tripSwitch || ev.target.closest('[data-close]')) $tripSwitch.close();
    else if (ev.target.closest('[data-manage]')) { $tripSwitch.close(); location.hash = '#/ajustes'; }
  });
store.listeners.add(() => {
    if (formActive() || methodOpen || tripOpen || personOpen || spaceOpen) updateStatus();
    else if (document.activeElement && ['INPUT', 'SELECT'].includes(document.activeElement.tagName) && $view.contains(document.activeElement)) updateStatus();
    else render();
  });
  // Al cambiar de pantalla el foco pasa al contenido (si no, queda en un enlace que ya no está donde se esperaba).
window.addEventListener('hashchange', () => { render(); window.scrollTo(0, 0); $view.focus({ preventScroll: true }); });
window.addEventListener('online', sync);
window.addEventListener('offline', () => { store.net.online = false; updateStatus(); });
document.addEventListener('visibilitychange', () => { if (!document.hidden && !formActive()) sync(); });
setInterval(() => { if (!document.hidden && !formActive()) sync(); }, 60000);
}
