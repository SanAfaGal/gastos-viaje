// Interfaz: router por hash y 5 pantallas, sin framework.
import { computeSettlement, splitEqual } from './settlement.mjs';
import { addDays, currencies, fmtDest, fmtHome, fmtRate, parseAmount, toHome, todayStr } from './money.mjs';
import { CURRENCIES, DEFAULT_SETTINGS } from './currencies.mjs';
import { DEFAULT_COLOR, KIND_COLOR, NETWORKS, NETWORK_MARK, cardPaint, detectNetwork, isHexColor, suggestColor } from './cards.mjs';
import { changeAt, nearestIndex, sparkline } from './chart.mjs';
import { formatCoords, hasLocation, routeFrom } from './places.mjs';
import { compareChronological, sameOrder } from './order.mjs';
import { ACCENTS, MODES, getTheme, setTheme } from './theme.js';
import * as store from './store.js';

const $view = document.getElementById('view');
const $title = document.getElementById('title');
const $status = document.getElementById('status');
const $toast = document.getElementById('toast');
const $tripBtn = document.getElementById('trip-btn');
const $tripSwitch = document.getElementById('trip-switch');

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// Aviso grande arriba de la pantalla. kind: 'ok' (verde, ✓) o 'error' (naranja/rojo, !, dura más). Se cierra al tocarlo.
let toastTimer;
function toast(msg, kind = 'ok') {
  const icon = document.createElement('span');
  icon.className = 'toast-icon';
  icon.setAttribute('aria-hidden', 'true');
  icon.textContent = kind === 'error' ? '!' : '✓';
  const text = document.createElement('span');
  text.textContent = msg;
  $toast.replaceChildren(icon, text);
  $toast.className = `toast ${kind}`;
  $toast.setAttribute('role', kind === 'error' ? 'alert' : 'status');
  void $toast.offsetWidth; // reinicia la animación si ya había un aviso
  $toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $toast.classList.remove('show'), kind === 'error' ? 6000 : 3500);
}
$toast.addEventListener('click', () => $toast.classList.remove('show'));

// ---------- datos derivados ----------

function ctx() {
  const state = store.getState();
  // `people` son quienes van en el viaje activo; `allPeople` toda la lista (Ajustes). Los medios de pago son
  // de todos los viajes (`methods`), pero en un viaje solo se usan los de dueños que van en él (`payMethods`).
  const people = state.participants;
  const allPeople = state.people;
  const peopleById = Object.fromEntries(allPeople.map((p) => [p.id, p]));
  const methodsById = Object.fromEntries(state.payment_methods.map((m) => [m.id, m]));
  const going = new Set(people.map((p) => p.id));
  const payMethods = state.payment_methods.filter((m) => going.has(m.owner_person_id));
  return {
    state, trip: state.trip, trips: state.trips, counts: state.counts,
    people, allPeople, peopleById, methodsById, methods: state.payment_methods, payMethods, expenses: state.expenses,
  };
}

const personName = (c, id) => c.peopleById[id]?.name ?? '¿?';

function methodLabel(m) {
  if (!m) return 'Medio borrado';
  if (m.kind === 'card') return `${m.name}${m.last4 ? ` ••${m.last4}` : ''} · ${m.card_type === 'credit' ? 'Crédito' : 'Débito'}`;
  // 'pix' es el código interno guardado en la base (de la primera versión); en pantalla se llama Transferencia
  return `${m.name} · ${m.kind === 'pix' ? 'Transferencia' : 'Efectivo'}`;
}

// Color de la tarjeta: el elegido, si no el sugerido por el banco, si no el del tipo de medio.
const cardColor = (m) => (isHexColor(m.color) ? m.color : suggestColor(m.name) ?? KIND_COLOR[m.kind] ?? DEFAULT_COLOR);

// Tarjeta dibujada (estilizada). Con pick=true es un botón del carrusel "Pagado con".
const ICONS = {
  cash: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="2" y="6" width="20" height="12" rx="2"/><circle cx="12" cy="12" r="3"/><path d="M6 9v.01M18 15v.01"/></svg>',
  pix: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 7h13M16 3l4 4-4 4M17 17H4M8 13l-4 4 4 4"/></svg>',
};

// Una tarjeta real solo para kind 'card' (banco, red, chip y número). Efectivo y transferencia no son
// tarjetas: se dibujan como una ficha plana, sin chip ni número. Los datos del dueño y el tipo van
// en un pie debajo, para no amontonar la tarjeta. Con pick=true es un botón del carrusel "Pagado con".
function cardHtml(m, { owner = '', pick = false, on = false } = {}) {
  const { c1, c2, fg, shadow } = cardPaint(cardColor(m));
  const isCard = m.kind === 'card';
  const kindText = isCard ? (m.card_type === 'credit' ? 'Crédito' : 'Débito') : m.kind === 'pix' ? 'Transferencia' : 'Efectivo';
  const cap = [isCard ? kindText : '', owner ? `de ${owner}` : ''].filter(Boolean).join(' · ');
  const face = isCard
    ? `<span class="pc-top"><span class="pc-bank">${esc(m.name || 'Nombre')}</span><span class="pc-net">${esc(NETWORK_MARK[m.network] ?? '')}</span></span>
       <span class="pc-chip"></span>
       <span class="pc-bot"><span class="pc-num">${m.last4 ? `•••• ${esc(m.last4)}` : ''}</span></span>`
    : `<span class="pc-top"><span class="pc-ico">${ICONS[m.kind] ?? ICONS.cash}</span><span class="pc-bank">${esc(kindText)}</span></span>
       <span class="pc-bot"><span class="pc-name">${esc(m.name || 'Nombre')}</span></span>`;
  const inner = `<span class="pcard ${isCard ? '' : 'flat'}" style="--c1:${c1};--c2:${c2};--fg:${fg};--tsh:${shadow}">${face}<span class="pc-check" aria-hidden="true">✓</span></span>
    <span class="pcap">${esc(cap)}</span>`;
  return pick
    ? `<button type="button" class="pitem ${on ? 'on' : ''}" role="radio" aria-checked="${on}" data-action="pick-method" data-id="${esc(m.id)}">${inner}</button>`
    : `<div class="pitem">${inner}</div>`;
}

// Vista previa de la tarjeta en el formulario de Ajustes, con lo que se va escribiendo.
function paintPreview() {
  const box = document.getElementById('card-preview');
  if (!box) return;
  const g = (id) => document.getElementById(id);
  const owner = g('m-owner').value ? g('m-owner').selectedOptions[0].textContent : '';
  const m = {
    kind: g('m-kind').value, name: g('m-name').value.trim(), last4: g('m-last4').value.trim(),
    card_type: g('m-type').value, network: g('m-network').value, color: g('m-color').value,
  };
  box.innerHTML = cardHtml(m, { owner });
  // En automático, el selector muestra el color que se está usando (el del banco o el del tipo de medio).
  if (!m.color) g('m-color-pick').value = cardColor(m);
  g('m-auto').classList.toggle('on', !m.color);
}

// Los primeros dígitos solo sirven para reconocer la red; no se envían ni se guardan.
// El selector de color fija el color; "Automático" lo deja vacío para que lo decida la app.
function onMethodForm(id) {
  const g = (x) => document.getElementById(x);
  if (id === 'm-bin') {
    const net = detectNetwork(g('m-bin').value);
    if (net) g('m-network').value = net;
  } else if (id === 'm-color-pick') g('m-color').value = g('m-color-pick').value;
  paintPreview();
}

// Deja la tarjeta elegida centrada en el carrusel sin mover la página.
function centerPicked() {
  const el = document.querySelector('#cards .pitem.on');
  if (el) el.parentElement.scrollLeft = el.offsetLeft - (el.parentElement.clientWidth - el.offsetWidth) / 2;
}

function settlementOf(c) {
  const input = c.expenses.map((e) => ({
    amount_home: e.amount_home,
    payer_id: c.methodsById[e.payment_method_id]?.owner_person_id,
    beneficiary_ids: e.beneficiary_ids,
  })).filter((e) => e.payer_id);
  const unit = 10 ** (2 - currencies().home.digits);
  return computeSettlement(input, c.people.map((p) => p.id), unit);
}

function forWho(c, e) {
  const ids = e.beneficiary_ids;
  if (ids.length === 1) return `Solo ${personName(c, ids[0])}`;
  if (ids.length === c.people.length) return 'Todos';
  return `${ids.length} personas`;
}

function dayLabel(date) {
  const t = todayStr();
  if (date === t) return 'Hoy';
  if (date === addDays(t, -1)) return 'Ayer';
  if (date === addDays(t, -2)) return 'Antier';
  return new Date(`${date}T12:00:00`).toLocaleDateString('es-CO', { weekday: 'long', day: 'numeric', month: 'long' });
}

const needsSetup = (c) => !c.people.length || !c.payMethods.length;
const setupCard = () => {
  const c = ctx();
  const text = c.allPeople.length && c.methods.length
    ? `En "${esc(c.trip.name)}" hace falta marcar quiénes van (Ajustes → Viajes → Editar) y que alguno de ellos tenga un medio de pago.`
    : 'Agrega las personas del paseo y los medios de pago (tarjetas, transferencias, efectivo) para poder registrar gastos. El país y la moneda del viaje se eligen en Viajes.';
  return `<div class="card"><h2>Primero lo primero</h2><p>${text}</p><a class="btn small" href="#/ajustes">Ir a Ajustes</a></div>`;
};

function expenseItem(c, e) {
  const m = c.methodsById[e.payment_method_id];
  const cop = e.amount_home == null ? 'Por convertir' : fmtHome(e.amount_home);
  return `<div class="item" data-action="edit" data-id="${esc(e.id)}">
    <div><div class="t">${esc(e.description || 'Gasto')}${hasLocation(e)
      ? ` <button type="button" class="pin" data-action="show-place" data-id="${esc(e.id)}" aria-label="Ver en el mapa" title="Ver en el mapa">📍</button>` : ''}</div>
      <div class="muted">${esc(methodLabel(m))}</div>
      <span class="tag">${esc(forWho(c, e))}</span>
      ${e.pending ? '<span class="tag warn">Sin enviar</span>' : ''}
      ${e.amount_home == null ? '<span class="tag warn">Esperando tasa</span>' : ''}
      ${e.rate_estimated ? '<span class="tag warn">Tasa estimada</span>' : ''}
      ${e.rate_manual ? '<span class="tag">Tasa manual</span>' : ''}
      ${e.amount_approx ? '<span class="tag warn">Monto aproximado</span>' : ''}</div>
    <div class="r"><div class="num">${cop}</div><div class="muted">${fmtDest(e.amount_cents)}</div></div>
  </div>`;
}

// ---------- pantallas ----------

// Los 5 más recientes (día más nuevo y, dentro del día, el último en haberse creado), sin importar el orden
// que tenga la lista.
const recentExpenses = (c) => [...c.expenses]
  .sort((a, b) => b.date.localeCompare(a.date) || String(b.created_at ?? '').localeCompare(String(a.created_at ?? '')))
  .slice(0, 5);

function viewHome() {
  const c = ctx();
  if (needsSetup(c)) return setupCard();
  const s = settlementOf(c);
  const totalCop = c.expenses.reduce((a, e) => a + (e.amount_home ?? 0), 0);
  const totalBrl = c.expenses.reduce((a, e) => a + e.amount_cents, 0);
  const rate = store.localRate(todayStr());
  const waiting = c.expenses.filter((e) => e.amount_home == null).length;
  const placed = c.expenses.filter(hasLocation).length;
  const unsent = store.pendingCount();
  return `
    ${unsent ? `<div class="banner">${unsent} gasto(s) sin enviar. Se envían solos cuando haya internet.</div>` : ''}
    ${waiting ? `<div class="banner">${waiting} gasto(s) esperando la tasa del día.</div>` : ''}
    <div class="card hero"><h2>Total gastado</h2>
      <div class="big">${fmtHome(totalCop)}</div>
      <div class="sub">${fmtDest(totalBrl)} · ${c.expenses.length} gasto(s)</div>
      <div class="sub">${rate ? `Hoy: ${fmtRate(rate.rate)}${rate.estimated ? ' (última conocida)' : ''}` : 'Tasa de hoy: sin datos todavía'}</div>
      <a class="hero-link" href="#/mapa">🗺 Ver mapa${placed ? ` · ${placed} con ubicación` : ''}</a>
    </div>
    <div class="card"><h2>Saldo por persona</h2>
      ${s.balances.map((b) => `<div class="pay row"><span><b>${esc(personName(c, b.person_id))}</b><div class="muted">Le tocan ${fmtHome(b.consumed)}</div></span>
        <span class="num ${b.net < 0 ? 'neg' : 'pos'}">${b.net < 0 ? '−' : b.net > 0 ? '+' : ''}${fmtHome(Math.abs(b.net))}</span></div>`).join('')}
    </div>
    <div class="card"><h2>Últimos gastos</h2>
      ${c.expenses.length ? recentExpenses(c).map((e) => expenseItem(c, e)).join('') : '<div class="empty">Aún no hay gastos. Toca el + para agregar.</div>'}
    </div>`;
}

const filters = { q: '', method: '', person: '', approx: false };

function viewList() {
  const c = ctx();
  if (needsSetup(c)) return setupCard();
  const q = filters.q.trim().toLowerCase();
  const list = c.expenses.filter((e) =>
    (!q || e.description.toLowerCase().includes(q)) &&
    (!filters.method || e.payment_method_id === filters.method) &&
    (!filters.person || e.beneficiary_ids.includes(filters.person)) &&
    (!filters.approx || e.amount_approx));
  const approxCount = c.expenses.filter((e) => e.amount_approx).length;
  // Solo se puede ordenar viendo el día completo: con un filtro puesto faltarían gastos y el orden saldría torcido.
  const sortable = !q && !filters.method && !filters.person && !filters.approx;
  const total = list.reduce((a, e) => a + (e.amount_home ?? 0), 0);
  const days = [];
  for (const e of list) {
    if (days.at(-1)?.date !== e.date) days.push({ date: e.date, items: [] });
    days.at(-1).items.push(e);
  }
  return `
    <div class="filters">
      <input id="f-q" type="search" placeholder="Buscar descripción" value="${esc(filters.q)}">
      <select id="f-method"><option value="">Todos los medios</option>
        ${c.payMethods.map((m) => `<option value="${esc(m.id)}" ${filters.method === m.id ? 'selected' : ''}>${esc(methodLabel(m))}</option>`).join('')}</select>
      <select id="f-person"><option value="">Para cualquiera</option>
        ${c.people.map((p) => `<option value="${esc(p.id)}" ${filters.person === p.id ? 'selected' : ''}>${esc(personName(c, p.id))}</option>`).join('')}</select>
      ${approxCount ? `<button type="button" class="chip ${filters.approx ? 'on' : ''}" data-action="f-approx" aria-pressed="${filters.approx}">Aproximados (${approxCount})</button>` : ''}
    </div>
    <div class="row" style="margin:0 4px 4px"><span class="muted">${list.length} gasto(s) · ${fmtHome(total)}</span>
      <a class="map-link" href="#/mapa">🗺 Ver mapa</a></div>
    ${sortable && days.some((d) => d.items.length > 1) ? '<div class="muted hint">Mantén presionado un gasto y arrástralo para ordenarlo dentro de su día.</div>' : ''}
    ${days.length ? days.map((d) => `<div class="day">${esc(dayLabel(d.date))}</div>
      <div class="card day-card" ${sortable ? `data-day="${esc(d.date)}"` : ''} style="padding:4px 16px">${d.items.map((e) => expenseItem(c, e)).join('')}</div>`).join('')
      : '<div class="empty">No hay gastos con ese filtro.</div>'}`;
}

// --- formulario de gasto ---

let draft = null;
let convRate = null; // { rate, estimated } para la fecha del formulario
let lastMethod = localStorage.getItem('bg_lastMethod') ?? '';
let lastBenes = JSON.parse(localStorage.getItem('bg_lastBenes') ?? '[]');

function newDraft(c, date = todayStr()) {
  const method = c.payMethods.some((m) => m.id === lastMethod) ? lastMethod : (c.payMethods[0]?.id ?? '');
  const going = new Set(c.people.map((p) => p.id));
  const benes = lastBenes.filter((id) => going.has(id));
  return { id: null, date, amountText: '', desc: '', method, benes: new Set(benes.length ? benes : c.people.map((p) => p.id)), created_at: null, approx: false, lat: null, lng: null, place: '' };
}

function draftFrom(c, id) {
  const e = c.expenses.find((x) => x.id === id);
  if (!e) return null;
  return {
    id: e.id, date: e.date, amountText: (e.amount_cents / 100).toFixed(2).replace('.', ','),
    desc: e.description, method: e.payment_method_id, benes: new Set(e.beneficiary_ids),
    created_at: e.created_at,
    approx: Boolean(e.amount_approx),
    lat: hasLocation(e) ? Number(e.lat) : null, lng: hasLocation(e) ? Number(e.lng) : null, place: e.place ?? '',
  };
}

// Fila de ubicación del formulario. Se vuelve a dibujar sola (sin render()) para no perder lo escrito.
function locHtml() {
  if (draft.locating) {
    return '<div class="loc-box"><div class="loc-wait" role="status"><span class="spin" aria-hidden="true"></span>Buscando tu ubicación…</div></div>';
  }
  if (draft.lat == null) {
    return `<div class="loc-box">
      <div class="loc-empty"><span class="loc-ico" aria-hidden="true">📍</span><span>Sin ubicación. Sirve para ver en el mapa dónde gastaste.</span></div>
      <div class="loc-btns">
        <button type="button" class="btn secondary small" data-action="locate">📍 Estoy aquí</button>
        <button type="button" class="btn secondary small" data-action="pick-map">🗺 Buscar en el mapa</button>
      </div></div>`;
  }
  return `<div class="loc-box set">
      <div class="loc-head"><span class="loc-ico on" aria-hidden="true">📍</span>
        <div class="loc-info"><b id="loc-name">${esc(draft.place.trim() || 'Ubicación guardada')}</b>
          <span class="muted">${esc(formatCoords(draft.lat, draft.lng))}</span></div></div>
      <input id="place" maxlength="120" placeholder="Ponle un nombre al lugar (opcional)" aria-label="Nombre del lugar" value="${esc(draft.place)}">
      <div class="loc-btns">
        <button type="button" class="btn secondary small" data-action="pick-map">Cambiar</button>
        <button type="button" class="btn danger small" data-action="unlocate">Quitar</button>
      </div></div>`;
}

function paintLoc() {
  const el = document.getElementById('loc');
  if (el && draft) el.innerHTML = locHtml();
}

function locate() {
  if (!draft || draft.locating) return;
  if (!navigator.geolocation) return toast('Este dispositivo no permite obtener la ubicación', 'error');
  const target = draft;
  target.locating = true;
  paintLoc();
  navigator.geolocation.getCurrentPosition((pos) => {
    target.locating = false;
    target.lat = pos.coords.latitude;
    target.lng = pos.coords.longitude;
    if (draft === target) paintLoc();
  }, (err) => {
    target.locating = false;
    if (draft === target) paintLoc();
    toast(err.code === 1 ? 'Sin permiso de ubicación. Actívalo en el navegador y vuelve a intentar.'
      : 'No se pudo obtener la ubicación. Intenta de nuevo.', 'error');
  }, { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 });
}

function viewForm(editId) {
  const c = ctx();
  if (needsSetup(c)) return setupCard();
  if (!draft || (editId ? draft.id !== editId : draft.id)) {
    draft = editId ? draftFrom(c, editId) : newDraft(c);
    if (!draft) { location.hash = '#/gastos'; return ''; }
    convRate = null;
    loadRate();
    loadHistory();
  }
  return `
    <form id="exp-form" autocomplete="off" novalidate>
      <div class="lab-row">
        <label for="amount">Monto en ${esc(currencies().dest.name.toLowerCase())} (${esc(currencies().dest.code)})</label>
        <button type="button" class="switch ${draft.approx ? 'on' : ''}" role="switch" aria-checked="${draft.approx}" data-action="approx"
          title="Márcalo si el monto es redondeado y hay que ajustarlo después"><span class="track" aria-hidden="true"></span>Aproximado</button>
      </div>
      <input id="amount" class="amount" inputmode="decimal" placeholder="0,00" value="${esc(draft.amountText)}">
      <div class="conv" id="conv"></div>
      <div class="chart" id="chart" role="img"></div>

      <label for="date">Día del gasto</label>
      <input id="date" type="date" max="${todayStr()}" value="${esc(draft.date)}">

      <label id="cards-l">Pagado con</label>
      <div class="cards" id="cards" role="radiogroup" aria-labelledby="cards-l">
        ${c.payMethods.map((m) => cardHtml(m, { owner: personName(c, m.owner_person_id), pick: true, on: m.id === draft.method })).join('')}
      </div>

      <label>¿Para quién es? (se divide en partes iguales)</label>
      <div class="chips" id="benes">
        ${c.people.map((p) => `<button type="button" class="chip ${draft.benes.has(p.id) ? 'on' : ''}" data-action="bene" data-id="${esc(p.id)}">${esc(personName(c, p.id))}</button>`).join('')}
        <button type="button" class="chip ghost" data-action="bene-all">Todos</button>
      </div>

      <label for="desc">Descripción (opcional)</label>
      <input id="desc" maxlength="120" placeholder="Almuerzo, Uber, entradas…" value="${esc(draft.desc)}">

      <label>Ubicación (opcional)</label>
      <div id="loc" class="loc">${locHtml()}</div>

      <button class="btn" type="submit" data-then="list">${draft.id ? 'Guardar cambios' : 'Guardar'}</button>
      ${draft.id ? '<button class="btn danger" type="button" data-action="del">Borrar gasto</button>'
        : '<button class="btn secondary" type="submit" data-then="again">Guardar y agregar otro</button>'}
    </form>`;
}

async function loadRate() {
  const date = draft.date;
  convRate = null;
  updateConv();
  const r = await store.fetchRate(date);
  if (draft && draft.date === date) {
    convRate = r ? { rate: r.rate, estimated: Boolean(r.estimated) } : null;
    convRate ??= null;
    updateConv(true);
  }
}

// --- gráfico de la tasa, interactivo ---
// Pasa el dedo o el mouse por encima (o usa las flechas) para ver la tasa de cada día.
const RANGES = [7, 30, 90];
let chartDays = RANGES.includes(Number(localStorage.getItem('bg_chartDays'))) ? Number(localStorage.getItem('bg_chartDays')) : 30;
let history = null; // [{ date, rate }] o null mientras carga
let chartGeo = null; // posiciones de los puntos (en %) del gráfico dibujado
let chartIdx = 0; // punto mostrado en la lectura

async function loadHistory() {
  const days = chartDays;
  history = null;
  renderChart();
  let points;
  try {
    points = await store.fetchHistory(days);
  } catch {
    points = [];
  }
  if (days !== chartDays) return; // cambió de rango mientras cargaba
  history = points;
  renderChart();
}

const numFmt = (v) => new Intl.NumberFormat(currencies().home.locale, { maximumFractionDigits: v < 10 ? 4 : 2 }).format(v);
const pctFmt = (v) => `${v > 0 ? '+' : ''}${new Intl.NumberFormat(currencies().home.locale, { maximumFractionDigits: 1, minimumFractionDigits: 1 }).format(v)} %`;
const dayShort = (d) => new Date(`${d}T12:00:00`).toLocaleDateString('es-CO', { weekday: 'short', day: 'numeric', month: 'short' });

function renderChart() {
  const el = document.getElementById('chart');
  if (!el || !draft) return;
  const tabs = `<div class="mini-tabs" role="group" aria-label="Período del gráfico">${RANGES.map((d) =>
    `<button type="button" class="mini-tab ${d === chartDays ? 'on' : ''}" data-action="range" data-id="${d}" aria-pressed="${d === chartDays}">${d} d</button>`).join('')}</div>`;
  const g = history ? sparkline(history, draft.date) : null;
  if (!g) {
    chartGeo = null;
    el.removeAttribute('aria-label');
    el.innerHTML = history === null
      ? `<div class="chart-top"><div class="chart-read"><div class="chart-meta">Cargando tasas…</div></div>${tabs}</div>`
      : '';
    return;
  }
  chartGeo = g;
  const cur = currencies();
  el.setAttribute('aria-label', `Tasa ${cur.dest.code} a ${cur.home.code} en los últimos ${history.length} días: mínimo ${numFmt(g.min)}, máximo ${numFmt(g.max)}, `
    + `${g.change >= 0 ? 'subió' : 'bajó'} ${pctFmt(Math.abs(g.change)).replace('+', '')}`);
  const sel = g.selectedIndex;
  el.innerHTML = `<div class="chart-top">
      <div class="chart-read" aria-hidden="true"><div class="chart-val" id="c-val"></div><div class="chart-meta" id="c-meta"></div><div class="chart-conv" id="c-conv"></div></div>
      ${tabs}</div>
    <div class="chart-plot" id="c-plot" tabindex="0" role="slider" aria-label="Recorrer los días del gráfico con las flechas"
      aria-valuemin="0" aria-valuemax="${history.length - 1}" aria-valuenow="${sel >= 0 ? sel : history.length - 1}">
      ${g.svg}
      ${sel >= 0 ? `<div class="chart-sel" style="left:${g.xs[sel]}%"></div><div class="chart-dot" style="left:${g.xs[sel]}%;top:${g.ys[sel]}%"></div>` : ''}
      <div class="chart-cross" id="c-cross" hidden></div><div class="chart-dot live" id="c-live" hidden></div>
    </div>
    <div class="chart-cap" aria-hidden="true"><span>Mín <b>${numFmt(g.min)}</b></span><span>Máx <b>${numFmt(g.max)}</b></span></div>`;
  chartIdx = sel >= 0 ? sel : history.length - 1;
  paintReadout(chartIdx, false);
}

// Escribe la lectura (tasa, fecha, variación y conversión del monto) del punto i y, si se está recorriendo, mueve la guía.
function paintReadout(i, scrubbing) {
  const val = document.getElementById('c-val');
  if (!val || !history?.[i]) return;
  chartIdx = i;
  const p = history[i];
  const cur = currencies();
  val.textContent = `${numFmt(p.rate)} ${cur.home.code}`;
  const isSel = !scrubbing && chartGeo.selectedIndex === i;
  document.getElementById('c-meta').textContent = `${isSel ? 'Día del gasto' : dayShort(p.date)} · ${pctFmt(changeAt(history, i))} en ${history.length} días`;
  const cents = parseAmount(draft?.amountText);
  document.getElementById('c-conv').textContent = cents ? `${fmtDest(cents)} ese día = ${fmtHome(toHome(cents, p.rate, cur.home.digits))}` : '';
  const cross = document.getElementById('c-cross');
  const live = document.getElementById('c-live');
  cross.hidden = !scrubbing;
  live.hidden = !scrubbing;
  if (scrubbing) {
    cross.style.left = `${chartGeo.xs[i]}%`;
    live.style.left = `${chartGeo.xs[i]}%`;
    live.style.top = `${chartGeo.ys[i]}%`;
  }
  const plot = document.getElementById('c-plot');
  plot.setAttribute('aria-valuenow', String(i));
  plot.setAttribute('aria-valuetext', `${dayShort(p.date)}: ${numFmt(p.rate)} ${cur.home.code}`);
}

function resetReadout() {
  if (!chartGeo) return;
  paintReadout(chartGeo.selectedIndex >= 0 ? chartGeo.selectedIndex : history.length - 1, false);
}

function updateConv(loaded = false) {
  const el = document.getElementById('conv');
  if (!el || !draft) return;
  if (chartGeo) paintReadout(chartIdx, !document.getElementById('c-cross')?.hidden);
  const cents = parseAmount(draft.amountText);
  const r = convRate;
  const c = ctx();
  if (!cents) { el.textContent = 'Escribe el monto para ver la conversión.'; return; }
  if (!r) {
    el.textContent = loaded ? 'Sin tasa por ahora. Se guardará y se convertirá cuando haya internet.' : 'Buscando la tasa…';
    return;
  }
  const cop = toHome(cents, r.rate, currencies().home.digits);
  const n = Math.max(draft.benes.size, 1);
  const each = Object.values(splitEqual(cop, [...draft.benes].length ? [...draft.benes] : ['x']))[0];
  el.innerHTML = `<b>${fmtDest(cents)} ≈ ${fmtHome(cop)}</b><br>
    <span class="muted">${fmtRate(r.rate)}${r.estimated ? ` (tasa estimada${r.rate_date ? ` del ${esc(dayLabel(r.rate_date).toLowerCase())}` : ''})` : ` (${esc(dayLabel(draft.date).toLowerCase())})`}
    ${n > 1 ? ` · ${n} personas: ${fmtHome(each)} c/u` : ''}</span>`;
  void c;
}

async function submitForm(then) {
  if (!draft) return;
  const cents = parseAmount(draft.amountText);
  if (!cents) return toast('Escribe un monto válido', 'error');
  if (!draft.method) return toast('Elige con qué se pagó', 'error');
  if (!draft.benes.size) return toast('Elige para quién es el gasto', 'error');
  const exp = {
    id: draft.id ?? store.uuid(),
    date: draft.date,
    amount_cents: cents,
    description: draft.desc.trim(),
    payment_method_id: draft.method,
    beneficiary_ids: [...draft.benes],
    created_at: draft.created_at ?? undefined,
    amount_approx: draft.approx,
    // null explícito: al editar y quitar la ubicación, el servidor la borra.
    lat: draft.lat, lng: draft.lng, place: draft.lat == null ? null : draft.place.trim(),
  };
  lastMethod = draft.method;
  lastBenes = [...draft.benes];
  localStorage.setItem('bg_lastMethod', lastMethod);
  localStorage.setItem('bg_lastBenes', JSON.stringify(lastBenes));
  const keepDate = draft.date;
  const wasEdit = Boolean(draft.id);
  const c = ctx();
  store.saveExpense(exp).then((r) => { if (r?.errors?.length) toast(r.errors[0], 'error'); });
  toast(wasEdit ? 'Cambios guardados' : 'Gasto guardado');
  if (then === 'again' && !wasEdit) {
    draft = newDraft(c, keepDate);
    convRate = null;
    render();
    document.getElementById('amount')?.focus();
    loadRate();
  } else {
    draft = null;
    location.hash = '#/gastos';
  }
}

function viewAccounts() {
  const c = ctx();
  if (needsSetup(c)) return setupCard();
  const s = settlementOf(c);
  const byMethod = {};
  for (const e of c.expenses) byMethod[e.payment_method_id] = (byMethod[e.payment_method_id] ?? 0) + (e.amount_home ?? 0);
  return `
    ${s.pending ? `<div class="banner">${s.pending} gasto(s) sin tasa todavía; no entran en estas cuentas hasta convertirse.</div>` : ''}
    <div class="card"><h2>Quién le paga a quién</h2>
      ${s.transfers.length ? s.transfers.map((t) => `<div class="pay row"><span><b>${esc(personName(c, t.from))}</b> le paga a <b>${esc(personName(c, t.to))}</b></span><span class="num">${fmtHome(t.amount)}</span></div>`).join('')
        : '<div class="empty">Nadie debe nada por ahora.</div>'}
    </div>
    <div class="card"><h2>Saldo por persona</h2>
      ${s.balances.map((b) => `<div class="pay"><div class="row"><b>${esc(personName(c, b.person_id))}</b>
        <span class="num ${b.net < 0 ? 'neg' : 'pos'}">${b.net < 0 ? '−' : b.net > 0 ? '+' : ''}${fmtHome(Math.abs(b.net))}</span></div>
        <div class="muted">Puso ${fmtHome(b.paid)} · Le tocan ${fmtHome(b.consumed)}</div></div>`).join('')}
    </div>
    <div class="card"><h2>Gastado por medio de pago</h2>
      ${c.payMethods.map((m) => `<div class="pay row"><span>${esc(methodLabel(m))}<div class="muted">de ${esc(personName(c, m.owner_person_id))}</div></span><span class="num">${fmtHome(byMethod[m.id] ?? 0)}</span></div>`).join('')}
    </div>`;
}

// --- ajustes ---

let editPerson = null;
let editMethod = null; // id del medio que se edita; null = uno nuevo
let methodOpen = false; // diálogo de medio de pago abierto
let personOpen = false; // diálogo de persona abierto (editPerson = a quién; null = una nueva)
let editTrip = null; // id del viaje que se edita; null = uno nuevo
let tripOpen = false; // diálogo de viaje abierto

function viewSettings() {
  const c = ctx();
  const p = editPerson ? (c.peopleById[editPerson] ?? {}) : {};
  const m = editMethod ? (c.methodsById[editMethod] ?? {}) : {};
  const kind = m.kind ?? 'card';
  const theme = getTheme();
  const t = editTrip ? (c.trips.find((x) => x.id === editTrip) ?? {}) : {};
  const tripLocked = Boolean(t.id) && (c.counts[t.id] ?? 0) > 0;
  const going = new Set(t.id ? t.people_ids : c.allPeople.map((x) => x.id)); // viaje nuevo: todos marcados
  const option = (code, sel) => {
    const x = CURRENCIES.find((k) => k.code === code);
    return `<option value="${esc(code)}" ${code === sel ? 'selected' : ''}>${esc(x.country)} · ${esc(x.code)} (${esc(x.name)})</option>`;
  };
  return `
    <div class="card"><h2>Viajes</h2>
      ${c.trips.map((x) => `<div class="pay row"><span><b>${esc(x.name)}</b>${x.id === c.trip.id ? ' <span class="tag">Activo</span>' : ''}
        <div class="muted">${esc(x.dest)} → ${esc(x.home)} · ${c.counts[x.id] ?? 0} gasto(s) · ${x.people_ids.length} persona(s)</div></span>
        <span><button class="btn secondary small" data-action="edit-trip" data-id="${esc(x.id)}">Editar</button>
        ${c.trips.length > 1 ? `<button class="btn danger small" data-action="del-trip" data-id="${esc(x.id)}">Borrar</button>` : ''}</span></div>`).join('')}
      <button class="btn" type="button" data-action="new-trip">+ Nuevo viaje</button>
      ${tripOpen ? `<dialog id="trip-dialog" class="sheet" aria-labelledby="td-title">
      <form id="trip-form" autocomplete="off">
        <header class="sheet-head"><h2 id="td-title">${t.id ? 'Editar viaje' : 'Nuevo viaje'}</h2>
          <button type="button" class="sheet-x" data-action="cancel-trip" aria-label="Cerrar">×</button></header>
        <div class="sheet-body">
          <label for="t-name">Nombre del viaje</label>
          <input id="t-name" maxlength="40" placeholder="Ej: Brasil 2026" value="${esc(t.name ?? '')}" required>
          <label for="t-dest">País donde gastas</label>
          <select id="t-dest" ${tripLocked ? 'disabled' : ''}>${CURRENCIES.map((x) => option(x.code, t.dest ?? DEFAULT_SETTINGS.dest)).join('')}</select>
          <label for="t-home">Tu moneda (la que usas para pagar al final)</label>
          <select id="t-home" ${tripLocked ? 'disabled' : ''}>${CURRENCIES.map((x) => option(x.code, t.home ?? DEFAULT_SETTINGS.home)).join('')}</select>
          ${tripLocked ? '<p class="muted">Este viaje ya tiene gastos, por eso no se puede cambiar el país ni la moneda.</p>' : ''}
          <label>Quiénes van</label>
          <div class="chips" id="t-people">
            ${c.allPeople.map((x) => `<button type="button" class="chip ${going.has(x.id) ? 'on' : ''}" aria-pressed="${going.has(x.id)}" data-action="trip-person" data-id="${esc(x.id)}">${esc(x.name)}</button>`).join('') || '<span class="muted">Primero agrega personas (más abajo).</span>'}
          </div>
        </div>
        <footer class="sheet-foot"><p id="t-error" class="form-error" role="alert" hidden></p>
          <button class="btn secondary" type="button" data-action="cancel-trip">Cancelar</button>
          <button class="btn" type="submit">${t.id ? 'Guardar' : 'Crear viaje'}</button></footer>
      </form></dialog>` : ''}
    </div>

    <div class="card"><h2>Apariencia</h2>
      <label>Modo</label>
      <div class="seg">${MODES.map((m) => `<button type="button" class="chip ${theme.mode === m.id ? 'on' : ''}" data-action="mode" data-id="${esc(m.id)}">${esc(m.name)}</button>`).join('')}</div>
      <label>Color</label>
      <div class="seg">${ACCENTS.map((a) => `<button type="button" class="chip ${theme.accent === a.id ? 'on' : ''}" data-action="accent" data-id="${esc(a.id)}"><span class="swatch" style="background:${esc(a.color)}"></span>${esc(a.name)}</button>`).join('')}</div>
    </div>

    <div class="card"><h2>Personas</h2>
      ${c.allPeople.map((x) => `<div class="pay row"><span><b>${esc(x.name)}</b></span>
        <span><button class="btn secondary small" data-action="edit-person" data-id="${esc(x.id)}">Editar</button>
        <button class="btn danger small" data-action="del-person" data-id="${esc(x.id)}">Borrar</button></span></div>`).join('') || '<div class="empty">Aún no hay personas.</div>'}
      <button class="btn" type="button" data-action="new-person">+ Agregar persona</button>
      ${personOpen ? `<dialog id="person-dialog" class="sheet" aria-labelledby="pd-title">
      <form id="person-form" autocomplete="off">
        <header class="sheet-head"><h2 id="pd-title">${editPerson ? 'Editar persona' : 'Nueva persona'}</h2>
          <button type="button" class="sheet-x" data-action="cancel-person" aria-label="Cerrar">×</button></header>
        <div class="sheet-body">
          <label for="p-name">Nombre</label>
          <input id="p-name" maxlength="40" placeholder="Nombre" value="${esc(p.name ?? '')}" required>
          <p class="muted">${editPerson ? 'Los viajes en los que va se cambian en Viajes → Editar.' : `Se agregará al viaje "${esc(c.trip.name)}". Los demás viajes se cambian en Viajes → Editar.`}</p>
        </div>
        <footer class="sheet-foot"><p id="p-error" class="form-error" role="alert" hidden></p>
          <button class="btn secondary" type="button" data-action="cancel-person">Cancelar</button>
          <button class="btn" type="submit">${editPerson ? 'Guardar' : 'Agregar'}</button></footer>
      </form></dialog>` : ''}
    </div>

    <div class="card"><h2>Medios de pago</h2>
      ${c.methods.map((x) => `<div class="pay row"><span><b>${esc(methodLabel(x))}</b><div class="muted">de ${esc(personName(c, x.owner_person_id))}</div></span>
        <span><button class="btn secondary small" data-action="edit-method" data-id="${esc(x.id)}">Editar</button>
        <button class="btn danger small" data-action="del-method" data-id="${esc(x.id)}">Borrar</button></span></div>`).join('') || '<div class="empty">Aún no hay medios de pago.</div>'}
      ${c.allPeople.length ? `<button class="btn" type="button" data-action="new-method">+ Agregar medio de pago</button>
      ${methodOpen ? `<dialog id="method-dialog" class="sheet" aria-labelledby="md-title">
      <form id="method-form" autocomplete="off">
        <header class="sheet-head"><h2 id="md-title">${editMethod ? 'Editar medio de pago' : 'Nuevo medio de pago'}</h2>
          <button type="button" class="sheet-x" data-action="cancel-method" aria-label="Cerrar">×</button></header>
        <div id="card-preview" class="sheet-preview">${cardHtml(m.kind ? m : { kind: 'card', card_type: 'debit' }, { owner: m.owner_person_id ? personName(c, m.owner_person_id) : '' })}</div>
        <div class="sheet-body">
        <label for="m-kind">Tipo de medio</label>
        <select id="m-kind"><option value="card" ${kind === 'card' ? 'selected' : ''}>Tarjeta</option><option value="pix" ${kind === 'pix' ? 'selected' : ''}>Transferencia</option><option value="cash" ${kind === 'cash' ? 'selected' : ''}>Efectivo</option></select>
        <label for="m-name">${kind === 'card' ? 'Nombre (el banco, por ejemplo)' : 'Nombre'}</label>
        <input id="m-name" maxlength="40" placeholder="${kind === 'card' ? 'Ej: Bancolombia, Nu, Visa de Ana' : kind === 'pix' ? 'Ej: Transferencia de Juan' : 'Ej: Efectivo de Ana'}" value="${esc(m.name ?? '')}" required>
        <div id="card-fields" ${kind === 'card' ? '' : 'hidden'}>
          <label for="m-bin">Primeros dígitos (opcional)</label>
          <input id="m-bin" inputmode="numeric" maxlength="8" autocomplete="off" placeholder="Solo para reconocer la red; no se guarda">
          <label for="m-network">Red</label>
          <select id="m-network"><option value="">Sin especificar</option>${Object.entries(NETWORKS).map(([k, v]) => `<option value="${esc(k)}" ${m.network === k ? 'selected' : ''}>${esc(v)}</option>`).join('')}</select>
          <label for="m-last4">Últimos 4 dígitos (opcional)</label>
          <input id="m-last4" inputmode="numeric" maxlength="4" placeholder="1234" value="${esc(m.last4 ?? '')}">
          <label for="m-type">Tipo</label>
          <select id="m-type"><option value="debit" ${m.card_type !== 'credit' ? 'selected' : ''}>Débito</option><option value="credit" ${m.card_type === 'credit' ? 'selected' : ''}>Crédito</option></select>
        </div>
        <label for="m-color-pick">Color</label>
        <input id="m-color" type="hidden" value="${isHexColor(m.color) ? esc(m.color) : ''}">
        <div class="colorrow">
          <input id="m-color-pick" type="color" value="${esc(cardColor(m))}">
          <button type="button" id="m-auto" class="chip ${isHexColor(m.color) ? '' : 'on'}" data-action="auto-color">Automático</button>
        </div>
        <label for="m-owner">De quién es (obligatorio)</label>
        <select id="m-owner" required>
          <option value="" disabled ${m.owner_person_id ? '' : 'selected'}>Elige una persona</option>
          ${c.allPeople.map((x) => `<option value="${esc(x.id)}" ${m.owner_person_id === x.id ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}
        </select>
        </div>
        <footer class="sheet-foot"><p id="m-error" class="form-error" role="alert" hidden></p>
          <button class="btn secondary" type="button" data-action="cancel-method">Cancelar</button>
          <button class="btn" type="submit">${editMethod ? 'Guardar' : 'Agregar'}</button></footer>
      </form></dialog>` : ''}` : '<div class="muted">Agrega primero una persona.</div>'}
    </div>

    <div class="card"><h2>Datos</h2>
      <a class="btn secondary" href="#/mapa">Mapa de lugares</a>
      <button class="btn secondary" data-action="refresh-rates">Actualizar tasas de este viaje</button>
      <button class="btn secondary" data-action="csv">Descargar gastos (CSV)</button>
      <button class="btn secondary" data-action="logout">Cambiar código de acceso</button>
      <p class="muted">Tarjetas y transferencias solo guardan nombre y últimos 4 dígitos; nunca números completos.</p>
    </div>`;
}

// --- mapa de lugares ---

const LEAFLET = '/vendor/leaflet/leaflet'; // Leaflet 1.9.4 alojado en la app (sin scripts de terceros)
let leafletLoading = null;
let leafletMap = null;

// Leaflet se carga solo al abrir un mapa (no pesa en el resto de la app).
function loadLeaflet() {
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

function viewMap() {
  const c = ctx();
  if (needsSetup(c)) return setupCard();
  const n = c.expenses.filter(hasLocation).length;
  if (!n) {
    return `<div class="card"><h2>Mapa de lugares</h2>
      <div class="empty">Aún no hay gastos con ubicación. Al agregar o editar un gasto, usa “Usar mi ubicación” o “Buscar o elegir en el mapa”.</div>
      <a class="btn secondary" href="#/gastos">Ir a Gastos</a></div>`;
  }
  return `<div class="muted" style="margin:0 4px 6px">${n} gasto(s) con ubicación en ${esc(c.trip.name)} · el número es el orden en que llegaste a cada lugar</div>
    <div id="map" class="map" role="region" aria-label="Mapa de lugares"><div class="empty">Cargando mapa…</div></div>
    <a class="btn secondary" href="#/">Volver</a>`;
}

async function initMap() {
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
  const { places, path } = routeFrom(c.expenses);
  let focus = null; // el lugar del gasto que se pidió ver (desde el pin de la lista)
  el.innerHTML = '';
  const map = L.map(el);
  leafletMap = map;
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19, attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
  }).addTo(map);
  // El recorrido (línea punteada) va debajo; encima, cada parada numerada por orden de primera visita.
  if (path.length > 1) L.polyline(path, { weight: 3, opacity: 0.6, dashArray: '6 8', interactive: false }).addTo(map);
  for (const p of places) {
    const lines = p.ids.slice(0, 5).map((id) => esc(byId[id]?.description || 'Gasto'));
    const more = p.ids.length > 5 ? `<br>y ${p.ids.length - 5} más` : '';
    const when = p.first_date === p.last_date ? dayLabel(p.first_date) : `${dayLabel(p.first_date)} a ${dayLabel(p.last_date)}`;
    const html = `<b>Parada ${p.n}: ${esc(p.place || formatCoords(p.lat, p.lng))}</b><br>${esc(when)}<br>
      ${lines.join('<br>')}${more}<br><b>${fmtHome(p.total_home)}</b> · ${fmtDest(p.total_dest)}`;
    const icon = L.divIcon({ className: 'stop', html: `<span>${p.n}</span>`, iconSize: [30, 30], iconAnchor: [15, 15], popupAnchor: [0, -15] });
    const marker = L.marker([p.lat, p.lng], { icon, title: `Parada ${p.n}`, alt: `Parada ${p.n}` }).addTo(map).bindPopup(html);
    if (mapFocus && p.ids.includes(mapFocus)) focus = { p, marker };
  }
  const pts = places.map((p) => [p.lat, p.lng]);
  if (focus) { map.setView([focus.p.lat, focus.p.lng], 16); focus.marker.openPopup(); }
  else if (prev) map.setView(prev.center, prev.zoom);
  else if (pts.length === 1) map.setView(pts[0], 15);
  else map.fitBounds(pts, { padding: [30, 30], maxZoom: 16 });
  lastMapSig = mapSig();
}

// La app se sincroniza sola cada 30 s y al volver a ella. Para que el mapa no se reinicie (zoom, popup abierto)
// con cada sincronización, solo se redibuja si cambió algo de lo que muestra.
let lastMapSig = '';
let mapFocus = ''; // id del gasto cuyo lugar se abre al entrar al mapa
const mapSig = () => JSON.stringify([routeFrom(ctx().expenses), mapFocus]);

// --- elegir el lugar en el mapa o buscándolo por nombre (para gastos de antes, o si ya no estás ahí) ---

const $pick = document.getElementById('map-pick');
const $pickOk = document.getElementById('pick-ok');
const $pickResults = document.getElementById('pick-results');
let pickMap = null;
let pickMarker = null;
let pickPoint = null;
let pickName = ''; // nombre del resultado buscado; se usa como "lugar" si el gasto no tiene uno
let pickLeaflet = null;

function setPickPoint(latlng, name = '') {
  pickPoint = { lat: latlng.lat, lng: latlng.lng };
  pickName = name;
  if (pickMarker) pickMarker.setLatLng(latlng);
  else pickMarker = pickLeaflet.marker(latlng).addTo(pickMap);
  $pickOk.disabled = false;
  document.getElementById('pick-hint').textContent = `${name ? name + ' · ' : ''}${formatCoords(pickPoint.lat, pickPoint.lng)} · toca otro punto para moverlo`;
}

async function openPicker() {
  if (!draft) return;
  const target = draft;
  pickPoint = null;
  pickName = '';
  $pick.pickFor = target;
  $pickOk.disabled = true;
  $pickResults.hidden = true;
  $pickResults.innerHTML = '';
  document.getElementById('pick-q').value = '';
  document.getElementById('pick-hint').textContent = 'Busca el lugar por nombre o toca el mapa donde fue la compra.';
  const box = document.getElementById('pick-map');
  box.innerHTML = '<div class="empty">Cargando mapa…</div>';
  $pick.showModal();
  try { pickLeaflet = await loadLeaflet(); } catch {
    box.innerHTML = '<div class="empty">No se pudo cargar el mapa.</div>';
    return;
  }
  if (!$pick.open) return;
  const L = pickLeaflet;
  box.innerHTML = '';
  pickMap?.remove();
  pickMarker = null;
  pickMap = L.map(box);
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19, attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
  }).addTo(pickMap);
  // Arranca donde ya estaba el gasto; si no, en el último gasto con ubicación del viaje; si no, el mundo.
  const last = ctx().expenses.find(hasLocation);
  if (target.lat != null) { pickMap.setView([target.lat, target.lng], 16); setPickPoint({ lat: target.lat, lng: target.lng }); }
  else if (last) pickMap.setView([last.lat, last.lng], 13);
  else pickMap.setView([20, 0], 2);
  pickMap.on('click', (ev) => setPickPoint(ev.latlng));
  pickMap.invalidateSize();
}

// Búsqueda por nombre con Nominatim (el buscador de OpenStreetMap). Solo al enviar, nunca letra por letra
// (su política lo prohíbe); prefiere resultados cerca de lo que se ve en el mapa.
let searching = false;
document.getElementById('pick-search').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const q = document.getElementById('pick-q').value.trim();
  if (!q || searching || !pickMap) return;
  searching = true;
  const btn = ev.target.querySelector('button');
  btn.disabled = true;
  $pickResults.hidden = false;
  $pickResults.innerHTML = '<div class="muted">Buscando…</div>';
  try {
    const b = pickMap.getBounds();
    const url = 'https://nominatim.openstreetmap.org/search?' + new URLSearchParams({
      q, format: 'jsonv2', limit: '6', 'accept-language': 'es',
      viewbox: [b.getWest(), b.getNorth(), b.getEast(), b.getSouth()].join(','),
    });
    const res = await fetch(url);
    if (!res.ok) throw new Error('búsqueda');
    const found = (await res.json()).filter((r) => Number.isFinite(Number(r.lat)) && Number.isFinite(Number(r.lon)));
    $pickResults.innerHTML = found.length
      ? found.map((r, i) => `<button type="button" class="pick-res" role="option" data-i="${i}">
          <b>${esc(r.name || r.display_name.split(',')[0])}</b><span class="muted">${esc(r.display_name)}</span></button>`).join('')
      : '<div class="muted">No se encontró. Prueba con otro nombre o agrega la ciudad.</div>';
    $pickResults.found = found;
  } catch {
    $pickResults.innerHTML = '<div class="muted">No se pudo buscar. Revisa tu conexión o toca el mapa.</div>';
  } finally {
    searching = false;
    btn.disabled = false;
  }
});

$pickResults.addEventListener('click', (ev) => {
  const b = ev.target.closest('.pick-res');
  const r = b && $pickResults.found?.[Number(b.dataset.i)];
  if (!r || !pickMap) return;
  const at = { lat: Number(r.lat), lng: Number(r.lon) };
  setPickPoint(at, r.name || r.display_name.split(',')[0]);
  pickMap.setView(at, 17);
  $pickResults.hidden = true;
});

$pickOk.addEventListener('click', () => {
  const target = $pick.pickFor;
  if (pickPoint && target && target === draft) {
    target.lat = pickPoint.lat;
    target.lng = pickPoint.lng;
    if (pickName && !target.place.trim()) target.place = pickName.slice(0, 120);
    paintLoc();
  }
  $pick.close();
});
$pick.addEventListener('click', (ev) => {
  if (ev.target === $pick || ev.target.closest('[data-pick-cancel]')) $pick.close();
});
$pick.addEventListener('close', () => { pickMap?.remove(); pickMap = null; pickMarker = null; $pick.pickFor = null; });

function viewLogin() {
  return `<form id="login" class="login card"><h2>Código de acceso</h2>
    <p class="muted">Esta app está protegida. Escribe el código para entrar.</p>
    <input id="code" type="password" autocomplete="current-password" placeholder="Código" required>
    <button class="btn" type="submit">Entrar</button></form>`;
}

function downloadCsv() {
  const c = ctx();
  const cur = currencies();
  const rows = [['Fecha', 'Descripción', 'Medio de pago', 'Pagó', 'Para', cur.dest.code, 'Tasa', cur.home.code, 'Aproximado', 'Lat', 'Lng', 'Lugar']];
  for (const e of [...c.expenses].sort(compareChronological)) {
    const m = c.methodsById[e.payment_method_id];
    rows.push([e.date, e.description, methodLabel(m), personName(c, m?.owner_person_id),
      e.beneficiary_ids.map((id) => personName(c, id)).join(' + '),
      (e.amount_cents / 100).toFixed(2), e.rate ?? '', e.amount_home == null ? '' : (e.amount_home / 100).toFixed(cur.home.digits),
      e.amount_approx ? 'Sí' : '', hasLocation(e) ? e.lat : '', hasLocation(e) ? e.lng : '', e.place ?? '']);
  }
  // Un texto que empieza con = + - @ se interpretaría como fórmula en Excel; se le antepone un apóstrofo.
  const cell = (v) => {
    let s = String(v ?? '');
    if (typeof v === 'string' && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return `"${s.replace(/"/g, '""')}"`;
  };
  const csv = rows.map((r) => r.map(cell).join(',')).join('\r\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob(['﻿' + csv], { type: 'text/csv' }));
  const slug = c.trip.name.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  a.download = `gastos-${slug || 'viaje'}-${todayStr()}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
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

function render() {
  updateStatus();
  $tripBtn.hidden = store.net.needsLogin;
  if (store.net.needsLogin) {
    $title.textContent = 'Gastos de viaje';
    $view.innerHTML = viewLogin();
    return;
  }
  const trip = store.activeTrip();
  $tripBtn.textContent = `✈ ${trip.name} · ${trip.dest}→${trip.home} ▾`;
  const { r, m } = currentRoute();
  mapFocus = r.map && m[1] ? decodeURIComponent(m[1]) : '';
  if (dragSt?.active) return; // no se redibuja la lista mientras se arrastra un gasto
  if (r.map && leafletMap && document.querySelector('#map.leaflet-container') && mapSig() === lastMapSig) return;
  if (!isFormRoute()) draft = null;
  if (r.tab !== 'ajustes') { methodOpen = false; tripOpen = false; personOpen = false; }
  $title.textContent = r.title;
  document.querySelectorAll('.tabbar a').forEach((a) => a.classList.toggle('active', a.dataset.tab === r.tab));
  if (!r.map && leafletMap) { leafletMap.remove(); leafletMap = null; }
  $view.innerHTML = r.view(m);
  if (r.map) initMap();
  if (isFormRoute() && draft) { updateConv(); renderChart(); centerPicked(); }
  if (methodOpen) document.getElementById('method-dialog')?.showModal();
  if (tripOpen) document.getElementById('trip-dialog')?.showModal();
  if (personOpen) document.getElementById('person-dialog')?.showModal();
}

// Los diálogos se cierran con Cancelar, la X, Escape o tocando fuera. Solo se limpia el estado: la próxima
// apertura vuelve a dibujar el formulario desde cero.
$view.addEventListener('close', (ev) => {
  if (ev.target.id === 'method-dialog') { methodOpen = false; editMethod = null; }
  else if (ev.target.id === 'trip-dialog') { tripOpen = false; editTrip = null; }
  else if (ev.target.id === 'person-dialog') { personOpen = false; editPerson = null; }
}, true);
$view.addEventListener('click', (ev) => { if (['method-dialog', 'trip-dialog', 'person-dialog'].includes(ev.target.id)) ev.target.close(); });

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
    draft = null; // el borrador y los filtros eran del otro viaje
    convRate = null;
    filters.method = '';
    filters.person = '';
    if (/^#\/nuevo\/.+/.test(location.hash)) location.hash = '#/gastos'; // el gasto que se editaba era del otro viaje
    else render();
  }
  $tripSwitch.close();
}

$tripBtn.addEventListener('click', openTripSwitch);
$tripSwitch.addEventListener('click', (ev) => {
  const opt = ev.target.closest('[data-trip]');
  if (opt) switchTrip(opt.dataset.trip);
  else if (ev.target === $tripSwitch || ev.target.closest('[data-close]')) $tripSwitch.close();
  else if (ev.target.closest('[data-manage]')) { $tripSwitch.close(); location.hash = '#/ajustes'; }
});

const formActive = () => isFormRoute() && draft && !store.net.needsLogin;

store.listeners.add(() => {
  if (formActive() || methodOpen || tripOpen || personOpen) updateStatus();
  else if (document.activeElement && ['INPUT', 'SELECT'].includes(document.activeElement.tagName) && $view.contains(document.activeElement)) updateStatus();
  else render();
});
window.addEventListener('hashchange', () => { render(); window.scrollTo(0, 0); });

// Acción en curso: mientras una acción que tarda (red) no termina se ignoran los demás toques, y el botón
// muestra un giro y su texto de "trabajando". Así no se ejecuta nada dos veces.
let working = false;
let cooldownUntil = 0; // pausa corta tras guardar o borrar un gasto, contra el doble toque
async function busy(btn, fn, label) {
  if (working) return undefined;
  working = true;
  $view.setAttribute('aria-busy', 'true');
  const original = btn?.innerHTML;
  if (btn) {
    btn.classList.add('busy');
    btn.disabled = true;
    if (label) btn.textContent = label;
  }
  try {
    return await fn();
  } finally {
    working = false;
    $view.removeAttribute('aria-busy');
    if (btn?.isConnected) {
      btn.classList.remove('busy');
      btn.disabled = false;
      btn.innerHTML = original;
    }
  }
}
function coolingDown() {
  if (Date.now() < cooldownUntil) return true;
  cooldownUntil = Date.now() + 700;
  return false;
}

// Animación de "presionado": se ve al menos 180 ms aunque el toque sea muy rápido.
document.addEventListener('pointerdown', (ev) => {
  const el = ev.target.closest?.('button, .item, .tabbar a, a.btn');
  if (!el || el.disabled) return;
  el.classList.add('pressed');
  setTimeout(() => el.classList.remove('pressed'), 180);
}, { passive: true });

$view.addEventListener('click', async (ev) => {
  const t = ev.target.closest('[data-action]');
  if (!t || working) return;
  const { action, id } = t.dataset;
  const c = ctx();
  const guard = async (fn) => {
    try { await fn(); } catch (err) { toast(err.offline ? 'Necesitas internet para esto' : err.message, 'error'); }
  };
  if (action === 'edit') location.hash = `#/nuevo/${encodeURIComponent(id)}`;
  else if (action === 'show-place') location.hash = `#/mapa/${encodeURIComponent(id)}`;
  else if (action === 'bene') {
    draft.benes.has(id) ? draft.benes.delete(id) : draft.benes.add(id);
    t.classList.toggle('on', draft.benes.has(id));
    updateConv();
  } else if (action === 'approx') {
    draft.approx = !draft.approx;
    t.classList.toggle('on', draft.approx);
    t.setAttribute('aria-checked', String(draft.approx));
  } else if (action === 'locate') locate();
  else if (action === 'pick-map') openPicker();
  else if (action === 'unlocate') { draft.lat = null; draft.lng = null; draft.place = ''; paintLoc(); }
  else if (action === 'f-approx') { filters.approx = !filters.approx; render(); }
  else if (action === 'bene-all') {
    draft.benes = new Set(c.people.map((p) => p.id));
    document.querySelectorAll('#benes .chip[data-id]').forEach((b) => b.classList.add('on'));
    updateConv();
  } else if (action === 'del') {
    if (draft && !coolingDown() && confirm('¿Borrar este gasto?')) {
      store.deleteExpense(draft.id);
      draft = null;
      toast('Gasto borrado');
      location.hash = '#/gastos';
    }
  } else if (action === 'range') {
    chartDays = Number(id);
    try { localStorage.setItem('bg_chartDays', String(chartDays)); } catch { /* sin almacenamiento */ }
    loadHistory();
  } else if (action === 'mode') { setTheme({ mode: id }); render(); }
  else if (action === 'accent') { setTheme({ accent: id }); render(); }
  else if (action === 'edit-person') { editPerson = id; personOpen = true; render(); }
  else if (action === 'new-person') { editPerson = null; personOpen = true; render(); }
  else if (action === 'cancel-person') document.getElementById('person-dialog')?.close();
  else if (action === 'pick-method') {
    draft.method = id;
    document.querySelectorAll('#cards .pitem').forEach((b) => {
      const on = b === t;
      b.classList.toggle('on', on);
      b.setAttribute('aria-checked', String(on));
    });
    t.scrollIntoView({ inline: 'center', block: 'nearest', behavior: 'smooth' });
  } else if (action === 'auto-color') {
    document.getElementById('m-color').value = '';
    paintPreview();
  } else if (action === 'edit-trip') { editTrip = id; tripOpen = true; render(); }
  else if (action === 'new-trip') { editTrip = null; tripOpen = true; render(); }
  else if (action === 'cancel-trip') document.getElementById('trip-dialog')?.close();
  else if (action === 'trip-person') {
    t.classList.toggle('on');
    t.setAttribute('aria-pressed', String(t.classList.contains('on')));
  } else if (action === 'del-trip') {
    const n = c.counts[id] ?? 0;
    const msg = n ? `Este viaje tiene ${n} gasto(s). ¿Borrar el viaje y todos sus gastos? No se puede deshacer.` : '¿Borrar este viaje?';
    if (confirm(msg)) await busy(t, () => guard(async () => { await store.deleteTrip(id, n > 0); toast('Viaje borrado'); render(); }), 'Borrando…');
  } else if (action === 'edit-method') { editMethod = id; methodOpen = true; render(); }
  else if (action === 'new-method') { editMethod = null; methodOpen = true; render(); }
  else if (action === 'cancel-method') document.getElementById('method-dialog')?.close();
  else if (action === 'del-person') {
    if (confirm('¿Borrar esta persona?')) await busy(t, () => guard(async () => { await store.deletePerson(id); toast('Persona borrada'); render(); }), 'Borrando…');
  } else if (action === 'del-method') {
    if (confirm('¿Borrar este medio de pago?')) await busy(t, () => guard(async () => { await store.deleteMethod(id); toast('Medio borrado'); render(); }), 'Borrando…');
  } else if (action === 'refresh-rates') {
    await busy(t, () => guard(async () => {
      const p = await store.refreshRatesNow(true);
      if (!p.changed) return toast(p.no_data ? 'Las tasas que la fuente tiene ya están al día' : 'Las tasas ya están al día');
      const msg = `${p.changed} gasto(s) cambiarían de valor: ${fmtHome(p.total_before)} → ${fmtHome(p.total_after)}.

Se usa la tasa que hoy da la fuente para el día de cada gasto. ¿Actualizar?`;
      if (!confirm(msg)) return undefined;
      const done = await store.refreshRatesNow(false);
      return toast(`${done.changed} gasto(s) actualizados`);
    }), 'Revisando…');
  } else if (action === 'csv') downloadCsv();
  else if (action === 'logout') { store.setPass(''); store.net.needsLogin = true; render(); }
});

// --- ordenar los gastos de un día: mantener presionado y arrastrar ---

let dragSt = null; // { item, card, ids, grab, timer, active, ... } mientras hay un gesto sobre un gasto
let suppressClick = false;
const HOLD_MS = 380; // tiempo presionado para empezar a arrastrar
const MOVE_TOL = 8; // si el dedo se mueve más antes de eso, es un scroll y no se arrastra

function dragEnd(commit) {
  const st = dragSt;
  if (!st) return;
  clearTimeout(st.timer);
  cancelAnimationFrame(st.raf);
  dragSt = null;
  if (!st.active) return;
  st.item.classList.remove('dragging');
  st.item.style.transform = '';
  st.item.style.zIndex = '';
  st.card.classList.remove('sorting');
  try { st.item.releasePointerCapture(st.pid); } catch { /* ya soltado */ }
  suppressClick = true; // el clic que sigue a soltar no debe abrir el gasto
  setTimeout(() => { suppressClick = false; }, 350);
  const ids = [...st.card.querySelectorAll('.item[data-id]')].map((el) => el.dataset.id);
  if (commit && !sameOrder(ids, st.ids)) store.saveOrder(ids, `${store.activeTrip().id}:${st.card.dataset.day}`);
  else render(); // cancelado o sin cambios: se restaura la lista
}

function dragStart() {
  const st = dragSt;
  if (!st || st.active) return;
  st.active = true;
  const r = st.item.getBoundingClientRect();
  st.grab = st.y - r.top; // dónde del gasto se tomó
  st.item.classList.add('dragging');
  st.item.style.zIndex = '5';
  st.card.classList.add('sorting');
  try { st.item.setPointerCapture(st.pid); } catch { /* el puntero ya terminó */ }
  navigator.vibrate?.(15);
  const tick = () => {
    if (!dragSt?.active) return;
    // Cerca del borde de la pantalla, la lista se desplaza sola.
    const edge = 90;
    if (st.y < edge) window.scrollBy(0, -Math.ceil((edge - st.y) / 6));
    else if (st.y > window.innerHeight - edge) window.scrollBy(0, Math.ceil((st.y - (window.innerHeight - edge)) / 6));
    dragFollow();
    st.raf = requestAnimationFrame(tick);
  };
  st.raf = requestAnimationFrame(tick);
}

// Mueve el gasto con el dedo y lo cambia de lugar cuando pasa por la mitad de su vecino.
function dragFollow() {
  const st = dragSt;
  if (!st?.active) return;
  const { item, card } = st;
  item.style.transform = '';
  const prev = item.previousElementSibling;
  const next = item.nextElementSibling;
  const mid = (el) => { const b = el.getBoundingClientRect(); return b.top + b.height / 2; };
  if (prev?.matches('.item') && st.y < mid(prev)) card.insertBefore(item, prev);
  else if (next?.matches('.item') && st.y > mid(next)) next.after(item);
  const nat = item.getBoundingClientRect();
  item.style.transform = `translateY(${st.y - st.grab - nat.top}px)`;
}

$view.addEventListener('pointerdown', (ev) => {
  if (dragSt || ev.button > 0) return;
  const item = ev.target.closest('.item[data-id]');
  const card = item?.closest('.day-card[data-day]');
  if (!card || ev.target.closest('button, a, input, select') || card.querySelectorAll('.item').length < 2) return;
  dragSt = {
    item, card, pid: ev.pointerId, x0: ev.clientX, y0: ev.clientY, y: ev.clientY, active: false,
    ids: [...card.querySelectorAll('.item[data-id]')].map((el) => el.dataset.id),
    timer: setTimeout(dragStart, HOLD_MS),
  };
});
$view.addEventListener('pointermove', (ev) => {
  const st = dragSt;
  if (!st || ev.pointerId !== st.pid) return;
  st.y = ev.clientY;
  if (!st.active && Math.hypot(ev.clientX - st.x0, ev.clientY - st.y0) > MOVE_TOL) { clearTimeout(st.timer); dragSt = null; }
});
$view.addEventListener('pointerup', (ev) => { if (dragSt && ev.pointerId === dragSt.pid) dragEnd(true); });
$view.addEventListener('pointercancel', (ev) => { if (dragSt && ev.pointerId === dragSt.pid) dragEnd(false); });
// En el celular, una vez que se empieza a arrastrar, el dedo no debe desplazar la página.
$view.addEventListener('touchmove', (ev) => { if (dragSt?.active) ev.preventDefault(); }, { passive: false });
// El menú del botón largo y la selección de texto estorban al arrastrar.
$view.addEventListener('contextmenu', (ev) => { if (ev.target.closest('.day-card[data-day] .item')) ev.preventDefault(); });
$view.addEventListener('click', (ev) => { if (suppressClick) { ev.stopPropagation(); ev.preventDefault(); } }, true);

// Recorrer el gráfico con el dedo, el mouse o las flechas del teclado.
function scrubTo(ev) {
  const plot = document.getElementById('c-plot');
  if (!plot || !history || !chartGeo) return;
  const r = plot.getBoundingClientRect();
  paintReadout(nearestIndex(history.length, (ev.clientX - r.left) / r.width), true);
}
$view.addEventListener('pointerdown', (ev) => { if (ev.target.closest('#c-plot')) scrubTo(ev); });
$view.addEventListener('pointermove', (ev) => {
  if (ev.target.closest('#c-plot') && (ev.pointerType === 'mouse' || ev.buttons)) scrubTo(ev);
});
$view.addEventListener('pointerup', (ev) => { if (ev.pointerType !== 'mouse') resetReadout(); });
$view.addEventListener('pointercancel', resetReadout);
$view.addEventListener('pointerleave', (ev) => { if (ev.target.id === 'c-plot') resetReadout(); }, true);
$view.addEventListener('keydown', (ev) => {
  if (ev.target.id !== 'c-plot' || !history) return;
  const step = { ArrowLeft: -1, ArrowRight: 1, Home: -1e9, End: 1e9 }[ev.key];
  if (!step) return;
  ev.preventDefault();
  paintReadout(Math.min(history.length - 1, Math.max(0, chartIdx + step)), true);
});
$view.addEventListener('focusout', (ev) => { if (ev.target.id === 'c-plot') resetReadout(); });

$view.addEventListener('input', (ev) => {
  const id = ev.target.id;
  if (id === 'amount') { draft.amountText = ev.target.value; updateConv(); }
  else if (id === 'desc') draft.desc = ev.target.value;
  else if (id === 'place') {
    draft.place = ev.target.value;
    const name = document.getElementById('loc-name');
    if (name) name.textContent = draft.place.trim() || 'Ubicación guardada';
  }
  else if (id === 'f-q') { filters.q = ev.target.value; const pos = ev.target.selectionStart; render(); const el = document.getElementById('f-q'); el.focus(); el.setSelectionRange(pos, pos); }
  else if (id.startsWith('m-')) onMethodForm(id);
});

$view.addEventListener('change', (ev) => {
  const id = ev.target.id;
  if (id === 'date') {
    if (ev.target.value) { draft.date = ev.target.value; loadRate(); renderChart(); }
  } else if (id === 'f-method') { filters.method = ev.target.value; render(); }
  else if (id === 'f-person') { filters.person = ev.target.value; render(); }
  else if (id === 'm-kind') {
    const isCard = ev.target.value === 'card';
    document.getElementById('card-fields').hidden = !isCard;
    document.getElementById('m-name').placeholder = isCard ? 'Ej: Bancolombia, Nu, Visa de Ana' : ev.target.value === 'pix' ? 'Ej: Transferencia de Juan' : 'Ej: Efectivo de Ana';
    document.querySelector('label[for="m-name"]').textContent = isCard ? 'Nombre (el banco, por ejemplo)' : 'Nombre';
  }
  if (id.startsWith('m-')) onMethodForm(id);
});

let lastSubmitter = null;
$view.addEventListener('click', (ev) => { lastSubmitter = ev.target.closest('button[type=submit]'); });

$view.addEventListener('submit', async (ev) => {
  ev.preventDefault();
  if (working) return;
  const f = ev.target.id;
  const btn = ev.submitter ?? lastSubmitter;
  const guard = async (fn) => {
    try { await fn(); } catch (err) { toast(err.offline ? 'Necesitas internet para esto' : err.message, 'error'); }
  };
  // Igual que guard, pero el error se muestra dentro del diálogo (el aviso de arriba queda tapado por él).
  const guardIn = async (errId, fn) => {
    const el = document.getElementById(errId);
    if (el) el.hidden = true;
    try { await fn(); } catch (err) {
      const msg = err.offline ? 'Necesitas internet para esto' : err.message;
      if (el) { el.textContent = msg; el.hidden = false; } else toast(msg, 'error');
    }
  };
  if (f === 'exp-form') {
    if (!coolingDown()) submitForm(lastSubmitter?.dataset.then ?? 'list');
  } else if (f === 'trip-form') {
    await busy(btn, () => guardIn('t-error', async () => {
      const wasNew = !editTrip;
      const out = await store.saveTrip({
        id: editTrip ?? undefined,
        name: document.getElementById('t-name').value,
        dest: document.getElementById('t-dest').value,
        home: document.getElementById('t-home').value,
        people_ids: [...document.querySelectorAll('#t-people .chip.on')].map((b) => b.dataset.id),
      });
      if (wasNew) store.setActiveTrip(out.id); // el viaje nuevo pasa a ser el activo
      tripOpen = false;
      editTrip = null;
      toast(wasNew ? 'Viaje creado' : 'Viaje guardado');
      render();
    }), 'Guardando…');
  } else if (f === 'person-form') {
    await busy(btn, () => guardIn('p-error', async () => {
      // Una persona nueva entra en el viaje activo; las ya existentes no cambian de viajes al renombrarlas.
      await store.savePerson({ id: editPerson ?? undefined, name: document.getElementById('p-name').value, trip_id: editPerson ? undefined : store.activeTrip().id });
      personOpen = false;
      editPerson = null;
      toast('Persona guardada');
      render();
    }), 'Guardando…');
  } else if (f === 'method-form') {
    await busy(btn, () => guardIn('m-error', async () => {
      const kind = document.getElementById('m-kind').value;
      await store.saveMethod({
        id: editMethod ?? undefined, kind, name: document.getElementById('m-name').value,
        last4: kind === 'card' ? document.getElementById('m-last4').value : null,
        card_type: kind === 'card' ? document.getElementById('m-type').value : null,
        network: kind === 'card' ? document.getElementById('m-network').value : null,
        color: document.getElementById('m-color').value,
        owner_person_id: document.getElementById('m-owner').value,
      });
      methodOpen = false;
      editMethod = null;
      toast('Medio de pago guardado');
      render();
    }), 'Guardando…');
  } else if (f === 'login') {
    await busy(btn, async () => {
      store.setPass(document.getElementById('code').value);
      await guard(async () => {
        await store.ping();
        await store.refresh();
        await store.flush();
        render();
      });
      if (store.net.needsLogin) toast('Código incorrecto', 'error');
    }, 'Entrando…');
  }
});

// ---------- arranque ----------

async function sync() {
  try {
    await store.flush();
    await store.refresh();
    store.fetchRate(todayStr());
  } catch { /* 401 o sin red: el estado ya lo muestra */ }
  updateStatus();
}

window.addEventListener('online', sync);
window.addEventListener('offline', () => { store.net.online = false; updateStatus(); });
document.addEventListener('visibilitychange', () => { if (!document.hidden && !formActive()) sync(); });
setInterval(() => { if (!document.hidden && !formActive()) sync(); }, 30000);

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}

render();
sync().then(() => { if (!formActive()) render(); });
