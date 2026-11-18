// Interfaz: router por hash y 5 pantallas, sin framework.
import { computeSettlement, splitEqual } from './settlement.mjs';
import { addDays, currencies, fmtDest, fmtHome, fmtRate, parseAmount, toHome, todayStr } from './money.mjs';
import { CURRENCIES, DEFAULT_SETTINGS } from './currencies.mjs';
import { DEFAULT_COLOR, KIND_COLOR, NETWORKS, NETWORK_MARK, cardPaint, detectNetwork, isHexColor, suggestColor } from './cards.mjs';
import { changeAt, nearestIndex, sparkline } from './chart.mjs';
import { formatCoords, hasLocation, routeFrom } from './places.mjs';
import { compareChronological, sameOrder } from './order.mjs';
import { MODES, getTheme, setTheme } from './theme.js';
import * as store from './store.js';
import { breakdown, byDay, summary } from './stats.mjs';
import { formatDistance, searchPlaces } from './geosearch.mjs';

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
// `action` = { label, run }: agrega un botón al aviso (por ejemplo "Deshacer") y lo deja visible más tiempo.
function toast(msg, kind = 'ok', action = null) {
  const icon = document.createElement('span');
  icon.className = 'toast-icon';
  icon.setAttribute('aria-hidden', 'true');
  icon.textContent = kind === 'error' ? '!' : '✓';
  const text = document.createElement('span');
  text.textContent = msg;
  $toast.replaceChildren(icon, text);
  if (action) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'toast-act';
    btn.textContent = action.label;
    btn.addEventListener('click', (ev) => { ev.stopPropagation(); $toast.classList.remove('show'); action.run(); });
    $toast.append(btn);
  }
  $toast.className = `toast ${kind}`;
  void $toast.offsetWidth; // reinicia la animación si ya había un aviso
  $toast.classList.add('show');
  toastMs = kind === 'error' ? 8000 : action ? 12000 : 4000;
  armToast();
  announce(action ? `${msg}. ${action.label} disponible` : msg, kind === 'error');
}
// El aviso visible no es una región en vivo (cambiar el role después de poner el texto no se anuncia de forma fiable):
// el texto se repite en dos regiones fijas ocultas, una amable (status) y una urgente (alert).
function announce(msg, urgent = false) {
  const live = document.getElementById(urgent ? 'live-alert' : 'live-status');
  live.textContent = '';
  setTimeout(() => { live.textContent = msg; }, 50);
}
let toastMs = 4000;
const armToast = () => { clearTimeout(toastTimer); toastTimer = setTimeout(() => $toast.classList.remove('show'), toastMs); };
// Mientras el puntero o el foco están sobre el aviso no se cierra solo (WCAG 2.2.1).
$toast.addEventListener('pointerenter', () => clearTimeout(toastTimer));
$toast.addEventListener('pointerleave', () => { if ($toast.classList.contains('show')) armToast(); });
$toast.addEventListener('focusin', () => clearTimeout(toastTimer));
$toast.addEventListener('focusout', () => { if ($toast.classList.contains('show')) armToast(); });
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

// "Por definir": se sabe que se debe el gasto pero no con qué se pagó. No es un medio real: en el servidor
// el gasto queda con payment_method_id = null y fuera de las cuentas.
const PENDING = 'pending';
const PENDING_METHOD = { id: PENDING, kind: 'pending', name: 'Por definir' };

function methodLabel(m) {
  if (!m) return 'Medio borrado';
  if (m.kind === 'pending') return 'Medio por definir';
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
  pending: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.7.4-1 .9-1 1.7M12 17v.01"/></svg>',
};

// Una tarjeta real solo para kind 'card' (banco, red, chip y número). Efectivo y transferencia no son
// tarjetas: se dibujan como una ficha plana, sin chip ni número. Los datos del dueño y el tipo van
// en un pie debajo, para no amontonar la tarjeta. Con pick=true es un botón del carrusel "Pagado con".
function cardHtml(m, { owner = '', pick = false, on = false } = {}) {
  const { c1, c2, fg, shadow } = cardPaint(cardColor(m));
  const isCard = m.kind === 'card';
  const kindText = isCard ? (m.card_type === 'credit' ? 'Crédito' : 'Débito') : m.kind === 'pix' ? 'Transferencia' : m.kind === 'pending' ? 'Pendiente' : 'Efectivo';
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
  g('m-auto').setAttribute('aria-pressed', String(!m.color));
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

// `n`: posición del gasto dentro de su día (solo en la lista, cuando el día tiene varios gastos).
function expenseItem(c, e, n) {
  const m = c.methodsById[e.payment_method_id];
  const cop = e.amount_home == null ? 'Por convertir' : fmtHome(e.amount_home);
  return `<div class="item" data-action="edit" data-id="${esc(e.id)}">
    <div><div class="t">${n ? `<span class="ord" title="Orden dentro del día">${n}</span>` : ''}<button type="button" class="item-open" data-action="edit" data-id="${esc(e.id)}" aria-label="${esc(`Editar: ${e.description || 'Gasto'}, ${cop}`)}">${esc(e.description || 'Gasto')}</button>${hasLocation(e)
      ? ` <button type="button" class="pin" data-action="show-place" data-id="${esc(e.id)}" aria-label="Ver en el mapa" title="Ver en el mapa">📍</button>` : ''}</div>
      <div class="muted">${e.payment_method_id == null ? 'Medio por definir' : esc(methodLabel(m))}</div>
      <span class="tag">${esc(forWho(c, e))}</span>
      ${e.payment_method_id == null ? '<span class="tag danger">Sin medio de pago</span>' : ''}
      ${e.pending ? '<span class="tag info">Sin enviar</span>' : ''}
      ${e.amount_home == null ? '<span class="tag warn">Esperando tasa</span>' : ''}
      ${e.rate_estimated ? '<span class="tag warn">Tasa estimada</span>' : ''}
      ${e.amount_approx ? '<span class="tag approx">Monto aproximado</span>' : ''}</div>
    <div class="r"><div class="num">${cop}</div><div class="muted">${fmtDest(e.amount_cents)}</div></div>
  </div>`;
}

// ---------- pantallas ----------

// Resumen general: cifras clave y gráficos. El detalle de cada gasto está en Gastos y los saldos en Cuentas.
let homeBars = []; // días del gráfico (para la lectura al tocar una barra)

const shortDate = (d) => new Date(`${d}T12:00:00`).toLocaleDateString('es-CO', { day: 'numeric', month: 'short' });
const barRead = (d) => `${dayLabel(d.date)} · ${d.count ? `${fmtHome(d.home)} · ${d.count} gasto(s)` : 'sin gastos'}`;

function hbarsHtml(rows) {
  return rows.map((r) => `<div class="hbar">
      <div class="hbar-top"><span class="hbar-l">${esc(r.label)}</span><b>${fmtHome(r.home)}</b></div>
      <div class="hbar-track" aria-hidden="true"><span style="width:${Math.max(r.pct, 1.5).toFixed(1)}%"></span></div>
      <div class="muted hbar-sub">${r.pct.toFixed(r.pct < 10 ? 1 : 0)} % · ${r.count} gasto(s)</div></div>`).join('');
}

function viewHome() {
  const c = ctx();
  if (needsSetup(c)) return setupCard();
  const today = todayStr();
  const rate = store.localRate(today);
  const waiting = c.expenses.filter((e) => e.amount_home == null).length;
  const placed = c.expenses.filter(hasLocation).length;
  const unsent = store.pendingCount();
  const cur = currencies();
  const s = summary(c.expenses, today);
  const totalDest = c.expenses.reduce((a, e) => a + e.amount_cents, 0);
  homeBars = byDay(c.expenses, { today, days: 14 });
  const peak = homeBars.reduce((m, d) => (d.home > m.home ? d : m), homeBars[0] ?? { home: 0 });
  const methodRows = breakdown(c.expenses, (e) => {
    if (e.payment_method_id == null) return { id: PENDING, label: 'Por definir' };
    const m = c.methodsById[e.payment_method_id];
    return { id: e.payment_method_id, label: m ? `${m.name}${m.last4 ? ` ••${m.last4}` : ''}` : 'Medio borrado' };
  });
  const payerRows = breakdown(c.expenses, (e) => {
    const owner = c.methodsById[e.payment_method_id]?.owner_person_id;
    return owner ? { id: owner, label: personName(c, owner) } : null;
  });
  return `
    ${unsent ? `<div class="banner">${unsent} gasto(s) sin enviar. Se envían solos cuando haya internet.</div>` : ''}
    ${waiting ? `<div class="banner">${waiting} gasto(s) esperando la tasa del día.</div>` : ''}
    <div class="card hero"><h2>Total gastado</h2>
      <div class="big">${fmtHome(s?.total ?? 0)}</div>
      <div class="sub">${fmtDest(totalDest)} · ${c.expenses.length} gasto(s)</div>
      <div class="sub">${rate ? `Hoy: ${fmtRate(rate.rate)}${rate.estimated ? ' (última conocida)' : ''}` : 'Tasa de hoy: sin datos todavía'}</div>
      <a class="hero-link" href="#/mapa">🗺 Ver mapa${placed ? ` · ${placed} con ubicación` : ''}</a>
    </div>
    ${s ? `
    <div class="kpis">
      <div class="kpi"><span class="muted">Hoy</span><b>${fmtHome(s.today)}</b></div>
      <div class="kpi"><span class="muted">Promedio por día</span><b>${fmtHome(s.perDay)}</b><span class="muted">${s.span} día(s)</span></div>
      <div class="kpi"><span class="muted">Gasto mayor</span><b>${s.top ? fmtHome(s.top.amount_home) : '—'}</b><span class="muted kpi-d">${s.top ? esc(s.top.description || dayLabel(s.top.date)) : ''}</span></div>
    </div>
    <div class="card"><h2>Gasto por día · en ${esc(cur.home.code)}</h2>
      <div class="bar-read" id="bar-read" aria-live="polite">${esc(barRead(homeBars.at(-1)))}</div>
      <div class="bars" role="group" aria-label="Gasto de cada uno de los últimos días">${homeBars.map((d, i) => `<button type="button" class="bar ${d.home ? '' : 'zero'} ${i === homeBars.length - 1 ? 'sel' : ''} ${d === peak && d.home ? 'peak' : ''}" data-action="bar" data-i="${i}" style="--h:${peak.home ? ((d.home / peak.home) * 100).toFixed(1) : 0}%" aria-label="${esc(barRead(d))}"></button>`).join('')}</div>
      <div class="bar-axis"><span>${esc(shortDate(homeBars[0].date))}</span><span>${peak.home ? `Máx. ${fmtHome(peak.home)}` : ''}</span><span>${esc(dayLabel(homeBars.at(-1).date))}</span></div>
    </div>
    <div class="card"><h2>Por medio de pago</h2>${hbarsHtml(methodRows)}</div>
    ${payerRows.length > 1 ? `<div class="card"><h2>Quién pagó</h2>${hbarsHtml(payerRows)}</div>` : ''}` : '<div class="card"><div class="empty">Aún no hay gastos. Toca el + para agregar.</div></div>'}`;
}

const FILTERS_OFF = { q: '', method: '', person: '', payer: '', day: '', approx: false, noloc: false, rate: false };
const filters = { ...FILTERS_OFF };
const resetFilters = () => Object.assign(filters, FILTERS_OFF);
let filtersOpen = false; // panel de filtros plegado por defecto: casi no se usa

const MAP_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 21s-6.5-5.6-6.5-11a6.5 6.5 0 0 1 13 0c0 5.4-6.5 11-6.5 11Z"/><circle cx="12" cy="10" r="2.3"/></svg>';

function viewList() {
  const c = ctx();
  if (needsSetup(c)) return setupCard();
  const dayList = [...new Set(c.expenses.map((e) => e.date))]; // días con gastos, del más nuevo al más viejo
  if (filters.day && !dayList.includes(filters.day)) filters.day = '';
  const q = filters.q.trim().toLowerCase();
  const list = c.expenses.filter((e) =>
    (!q || e.description.toLowerCase().includes(q)) &&
    (!filters.method || (filters.method === PENDING ? e.payment_method_id == null : e.payment_method_id === filters.method)) &&
    (!filters.person || e.beneficiary_ids.includes(filters.person)) &&
    (!filters.payer || c.methodsById[e.payment_method_id]?.owner_person_id === filters.payer) &&
    (!filters.day || e.date === filters.day) &&
    (!filters.approx || e.amount_approx) &&
    (!filters.noloc || !hasLocation(e)) &&
    (!filters.rate || e.amount_home == null || e.rate_estimated));
  const approxCount = c.expenses.filter((e) => e.amount_approx).length;
  const nolocCount = c.expenses.filter((e) => !hasLocation(e)).length;
  const rateCount = c.expenses.filter((e) => e.amount_home == null || e.rate_estimated).length;
  const owners = [...new Set(c.expenses.map((e) => c.methodsById[e.payment_method_id]?.owner_person_id).filter(Boolean))];
  const filtered = Object.keys(FILTERS_OFF).some((k) => (typeof FILTERS_OFF[k] === 'boolean' ? filters[k] : String(filters[k]).trim() !== ''));
  const activeCount = ['method', 'person', 'payer', 'day', 'approx', 'noloc', 'rate'].filter((k) => filters[k]).length; // la búsqueda se ve aparte
  // Solo se puede ordenar viendo el día completo: con un filtro puesto faltarían gastos y el orden saldría torcido.
  const sortable = !filtered;
  const sumHome = (items) => items.reduce((a, e) => a + (e.amount_home ?? 0), 0);
  const sumDest = (items) => items.reduce((a, e) => a + e.amount_cents, 0);
  const unconverted = list.filter((e) => e.amount_home == null).length;
  const cur = currencies();
  // Número de cada gasto dentro de su día completo (no cambia al filtrar). c.expenses ya viene en el orden del día.
  const perDay = {};
  for (const e of c.expenses) perDay[e.date] = (perDay[e.date] ?? 0) + 1;
  const seen = {};
  const orderOf = new Map(c.expenses.map((e) => [e.id, perDay[e.date] > 1 ? (seen[e.date] = (seen[e.date] ?? 0) + 1) : 0]));
  const days = [];
  for (const e of list) {
    if (days.at(-1)?.date !== e.date) days.push({ date: e.date, items: [] });
    days.at(-1).items.push(e);
  }
  return `
    <div class="card sum">
      <div class="sum-top"><h2>${filtered ? 'Con filtros' : 'Todos los gastos'}</h2>
        <a class="pill-link" href="#/mapa">${MAP_ICON}Mapa</a></div>
      <div class="sum-vals">
        <div><div class="big">${fmtHome(sumHome(list))}</div><div class="muted">en ${esc(cur.home.code)}</div></div>
        <div><div class="big alt">${fmtDest(sumDest(list))}</div><div class="muted">en ${esc(cur.dest.code)}, lo que se pagó</div></div>
      </div>
      <div class="sum-foot"><span class="muted">${list.length} gasto(s)${unconverted ? ` · ${unconverted} sin convertir` : ''}</span>
        ${filtered ? '<button type="button" class="chip small" data-action="f-clear">Quitar filtros</button>' : ''}</div>
    </div>
    <div class="filters">
      <div class="filt-bar">
        <input id="f-q" type="search" aria-label="Buscar en la descripción" placeholder="Buscar descripción" value="${esc(filters.q)}">
        <button type="button" class="chip filt-btn ${filtersOpen || activeCount ? 'on' : ''}" data-action="f-toggle" aria-expanded="${filtersOpen}" aria-controls="f-panel">Filtros${activeCount ? ` · ${activeCount}` : ''} <span aria-hidden="true">${filtersOpen ? '▴' : '▾'}</span></button>
      </div>
      <div class="filt-panel" id="f-panel" ${filtersOpen ? '' : 'hidden'}>
      <select id="f-day" aria-label="Día"><option value="">Todos los días</option>
        ${dayList.map((d) => `<option value="${esc(d)}" ${filters.day === d ? 'selected' : ''}>${esc(dayLabel(d))} · ${c.expenses.filter((e) => e.date === d).length}</option>`).join('')}</select>
      <select id="f-method" aria-label="Medio de pago"><option value="">Todos los medios</option>
        ${c.payMethods.map((m) => `<option value="${esc(m.id)}" ${filters.method === m.id ? 'selected' : ''}>${esc(methodLabel(m))}</option>`).join('')}
        ${c.expenses.some((e) => e.payment_method_id == null) ? `<option value="${PENDING}" ${filters.method === PENDING ? 'selected' : ''}>Por definir</option>` : ''}</select>
      <select id="f-person" aria-label="Para quién"><option value="">Para cualquiera</option>
        ${c.people.map((p) => `<option value="${esc(p.id)}" ${filters.person === p.id ? 'selected' : ''}>${esc(personName(c, p.id))}</option>`).join('')}</select>
      ${owners.length > 1 ? `<select id="f-payer" aria-label="Quién pagó"><option value="">Pagó cualquiera</option>
        ${owners.map((o) => `<option value="${esc(o)}" ${filters.payer === o ? 'selected' : ''}>Pagó ${esc(personName(c, o))}</option>`).join('')}</select>` : ''}
      <div class="chips filt-chips">
        ${approxCount ? `<button type="button" class="chip ${filters.approx ? 'on' : ''}" data-action="f-approx" aria-pressed="${filters.approx}">Aproximados (${approxCount})</button>` : ''}
        ${nolocCount ? `<button type="button" class="chip ${filters.noloc ? 'on' : ''}" data-action="f-noloc" aria-pressed="${filters.noloc}">Sin ubicación (${nolocCount})</button>` : ''}
        ${rateCount ? `<button type="button" class="chip ${filters.rate ? 'on' : ''}" data-action="f-rate" aria-pressed="${filters.rate}">Tasa pendiente (${rateCount})</button>` : ''}
      </div>
      </div>
    </div>
    ${sortable && days.some((d) => d.items.length > 1) ? '<div class="muted hint">Mantén presionado un gasto y arrástralo para ordenarlo dentro de su día. Con teclado: Alt + ↑ o ↓ sobre el gasto.</div>' : ''}
    ${days.length ? days.map((d) => `<div class="day"><span>${esc(dayLabel(d.date))}</span><span class="day-tot">${fmtHome(sumHome(d.items))} · ${fmtDest(sumDest(d.items))}</span></div>
      <div class="card day-card" ${sortable ? `data-day="${esc(d.date)}"` : ''} style="padding:4px 16px">${d.items.map((e) => expenseItem(c, e, orderOf.get(e.id))).join('')}</div>`).join('')
      : '<div class="empty">No hay gastos con ese filtro.</div>'}`;
}

// --- formulario de gasto ---

let draft = null;
let convRate = null; // { rate, estimated } para la fecha del formulario
let lastBenes = JSON.parse(localStorage.getItem('bg_lastBenes') ?? '[]');

function newDraft(c, date = todayStr()) {
  // El medio de pago empieza vacío: hay que elegirlo a propósito (o marcar "Por definir").
  const method = '';
  const going = new Set(c.people.map((p) => p.id));
  const benes = lastBenes.filter((id) => going.has(id));
  return { id: null, date, amountText: '', desc: '', method, benes: new Set(benes.length ? benes : c.people.map((p) => p.id)), created_at: null, approx: false, lat: null, lng: null, place: '' };
}

function draftFrom(c, id) {
  const e = c.expenses.find((x) => x.id === id);
  if (!e) return null;
  return {
    id: e.id, date: e.date, amountText: (e.amount_cents / 100).toFixed(2).replace('.', ','),
    desc: e.description, method: e.payment_method_id ?? PENDING, benes: new Set(e.beneficiary_ids),
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
      <div class="loc-empty"><span class="loc-ico" aria-hidden="true">📍</span><span>Sin ubicación</span></div>
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

// Con muchos medios de pago el carrusel se vuelve largo. Se ordenan por el uso más reciente (los que más
// usas quedan al principio) y, si hay varios dueños, se puede filtrar por dueño. "Por definir" va siempre al final.
const MANY_METHODS = 4;

function methodsByRecentUse(c) {
  const last = new Map();
  for (const e of c.expenses) {
    if (e.payment_method_id == null) continue;
    const t = `${e.date}|${e.created_at ?? ''}`;
    if (t > (last.get(e.payment_method_id) ?? '')) last.set(e.payment_method_id, t);
  }
  return [...c.payMethods].sort((a, b) => (last.get(b.id) ?? '').localeCompare(last.get(a.id) ?? ''));
}

function ownerFilterHtml(c) {
  const owners = [...new Set(c.payMethods.map((m) => m.owner_person_id))];
  if (c.payMethods.length <= MANY_METHODS || owners.length < 2) return '';
  const chip = (id, label) => `<button type="button" class="chip small ${(draft.owner ?? '') === id ? 'on' : ''}" data-action="pm-owner" data-id="${esc(id)}" aria-pressed="${(draft.owner ?? '') === id}">${esc(label)}</button>`;
  return `<div class="chips owner-f" id="owner-f" aria-label="Filtrar medios por dueño">${chip('', 'Todos')}${owners.map((o) => chip(o, personName(c, o))).join('')}</div>`;
}

function cardsHtml(c) {
  const shown = methodsByRecentUse(c).filter((m) => !draft.owner || m.owner_person_id === draft.owner || m.id === draft.method);
  return shown.map((m) => cardHtml(m, { owner: personName(c, m.owner_person_id), pick: true, on: m.id === draft.method })).join('')
    + cardHtml(PENDING_METHOD, { pick: true, on: draft.method === PENDING });
}

function paintCards() {
  const c = ctx();
  const box = document.getElementById('cards');
  if (!box || !draft) return;
  box.innerHTML = cardsHtml(c);
  box.scrollLeft = 0;
  const f = document.getElementById('owner-f');
  if (f) f.outerHTML = ownerFilterHtml(c);
}

// Icono ⓘ que abre o cierra una explicación corta (ver la acción 'info'). Mantiene el formulario limpio.
// La explicación sale en un diálogo (hoja desde abajo en celular), así no mueve ni deforma el formulario.
const infoBtn = (id, label) => `<button type="button" class="info-btn" data-action="info" data-id="${id}" aria-haspopup="dialog" aria-label="Más información: ${esc(label)}">i</button>`;
const infoDialog = (id, title, html) => `<dialog id="info-${id}" class="sheet info" aria-labelledby="info-${id}-t">
  <header class="sheet-head"><h2 id="info-${id}-t">${esc(title)}</h2><button type="button" class="sheet-x" data-action="info-close" aria-label="Cerrar">×</button></header>
  <div class="sheet-body">${html}</div></dialog>`;

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
        <span class="lab-tools"><button type="button" class="switch ${draft.approx ? 'on' : ''}" role="switch" aria-checked="${draft.approx}" data-action="approx"><span class="track" aria-hidden="true"></span>Aproximado</button>
          ${infoBtn('approx', 'Monto aproximado')}</span>
      </div>
      <input id="amount" class="amount" inputmode="decimal" placeholder="0,00" value="${esc(draft.amountText)}">
      <div class="conv-row"><div class="conv" id="conv"></div>${infoBtn('rate', 'Tasa de cambio e historial')}</div>

      <label for="date">Día del gasto</label>
      <input id="date" type="date" max="${todayStr()}" value="${esc(draft.date)}">

      <div class="lab-row"><span class="label" id="cards-l">Pagado con</span>${infoBtn('pay', 'Pagado con')}</div>
      ${ownerFilterHtml(c)}
      <div class="cards" id="cards" role="radiogroup" aria-labelledby="cards-l">${cardsHtml(c)}</div>

      <div class="lab-row"><span class="label" id="benes-l">¿Para quién es?</span>${infoBtn('who', 'Para quién es')}</div>
      <div class="chips" id="benes" role="group" aria-labelledby="benes-l">
        ${c.people.map((p) => `<button type="button" class="chip ${draft.benes.has(p.id) ? 'on' : ''}" data-action="bene" data-id="${esc(p.id)}" aria-pressed="${draft.benes.has(p.id)}">${esc(personName(c, p.id))}</button>`).join('')}
        <button type="button" class="chip ghost" data-action="bene-all">Todos</button>
      </div>

      <label for="desc">Descripción</label>
      <input id="desc" maxlength="120" placeholder="Almuerzo, Uber, entradas…" value="${esc(draft.desc)}">

      <div class="lab-row"><span class="label" id="loc-l">Ubicación</span>${infoBtn('loc', 'Ubicación')}</div>
      <div id="loc" class="loc" role="group" aria-labelledby="loc-l">${locHtml()}</div>

      <button class="btn" type="submit" data-then="list">${draft.id ? 'Guardar cambios' : 'Guardar'}</button>
      ${draft.id ? '' : '<button class="btn secondary" type="submit" data-then="again">Guardar y agregar otro</button>'}
      ${draft.id ? '<div class="form-danger"><button class="icon-del" type="button" data-action="del" aria-label="Borrar este gasto" title="Borrar este gasto"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg></button></div>' : ''}
      ${infoDialog('rate', 'Tasa de cambio', '<div class="muted" id="conv-detail"></div><div class="chart" id="chart" role="img"></div>')}
      ${infoDialog('pay', 'Pagado con', 'Elige con qué se pagó. Si no lo sabes, elige «Por definir» y lo completas después; ese gasto no entra en las cuentas hasta entonces.')}
      ${infoDialog('who', '¿Para quién es?', 'El gasto se divide en partes iguales entre las personas marcadas. «Todos» marca a todas las del viaje.')}
      ${infoDialog('approx', 'Monto aproximado', 'Márcalo si el monto es redondeado y hay que ajustarlo después. El gasto queda con la etiqueta «Monto aproximado» y puedes filtrarlos.')}
      ${infoDialog('loc', 'Ubicación', 'Opcional. Sirve para ver en el mapa dónde gastaste.')}
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
  const det = document.getElementById('conv-detail'); // detalle de la tasa, dentro del ⓘ
  if (chartGeo) paintReadout(chartIdx, !document.getElementById('c-cross')?.hidden);
  const cents = parseAmount(draft.amountText);
  const r = convRate;
  const c = ctx();
  if (!cents) { el.textContent = 'Escribe el monto para ver la conversión.'; if (det) det.textContent = ''; return; }
  if (!r) {
    el.textContent = loaded ? 'Sin tasa por ahora. Se guardará y se convertirá cuando haya internet.' : 'Buscando la tasa…';
    if (det) det.textContent = '';
    return;
  }
  const cop = toHome(cents, r.rate, currencies().home.digits);
  const n = Math.max(draft.benes.size, 1);
  const each = Object.values(splitEqual(cop, [...draft.benes].length ? [...draft.benes] : ['x']))[0];
  el.innerHTML = `<b>${fmtDest(cents)} ≈ ${fmtHome(cop)}</b>`;
  if (det) {
    det.innerHTML = `${fmtRate(r.rate)}${r.estimated ? ` (tasa estimada${r.rate_date ? ` del ${esc(dayLabel(r.rate_date).toLowerCase())}` : ''})` : ` (${esc(dayLabel(draft.date).toLowerCase())})`}
    ${n > 1 ? ` · ${n} personas: ${fmtHome(each)} c/u` : ''}`;
  }
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
    payment_method_id: draft.method === PENDING ? null : draft.method,
    beneficiary_ids: [...draft.benes],
    created_at: draft.created_at ?? undefined,
    amount_approx: draft.approx,
    // null explícito: al editar y quitar la ubicación, el servidor la borra.
    lat: draft.lat, lng: draft.lng, place: draft.lat == null ? null : draft.place.trim(),
  };
  lastBenes = [...draft.benes];
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
  for (const e of c.expenses) byMethod[e.payment_method_id ?? PENDING] = (byMethod[e.payment_method_id ?? PENDING] ?? 0) + (e.amount_home ?? 0);
  const noMethod = c.expenses.filter((e) => e.payment_method_id == null).length;
  return `
    ${noMethod ? `<div class="banner">${noMethod} gasto(s) con el medio de pago por definir; no entran en estas cuentas hasta que les pongas medio.</div>` : ''}
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
      ${noMethod ? `<div class="pay row"><span>Por definir<div class="muted">sin medio de pago</div></span><span class="num">${fmtHome(byMethod[PENDING] ?? 0)}</span></div>` : ''}
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
  const placed = c.expenses.filter(hasLocation).length;
  const rate = store.localRate(todayStr());
  const unsent = store.pendingCount();
  const syncText = store.net.online ? (unsent ? `${unsent} por enviar` : `Al día · ${agoText(store.net.lastSync)}`) : `Sin conexión${unsent ? ` · ${unsent} por enviar` : ''}`;
  const option = (code, sel) => {
    const x = CURRENCIES.find((k) => k.code === code);
    return `<option value="${esc(code)}" ${code === sel ? 'selected' : ''}>${esc(x.country)} · ${esc(x.code)} (${esc(x.name)})</option>`;
  };
  const nTripPeople = c.trip.people_ids.length;
  return `
    <div class="scope scope-trip"><span class="scope-chip">Este viaje</span><b>${esc(c.trip.name)}</b></div>
    <div class="card trip-card">
      <div class="pay row"><span><b>${esc(c.trip.name)}</b>
        <div class="muted">${esc(c.trip.dest)} → ${esc(c.trip.home)} · ${c.counts[c.trip.id] ?? 0} gasto(s) · ${nTripPeople} persona(s)</div></span>
        <span><button class="btn secondary small" data-action="edit-trip" data-id="${esc(c.trip.id)}">Editar</button></span></div>
      <div class="acts">
        ${actTile('map', 'Mapa de lugares', placed ? `${placed} con ubicación` : 'Sin ubicaciones aún', 'href="#/mapa"', { link: true })}
        ${actTile('rates', 'Actualizar tasas', rate ? `Hoy: ${fmtRate(rate.rate)}` : 'Sin datos todavía', 'data-action="refresh-rates"')}
        ${actTile('csv', 'Exportar CSV', `${c.expenses.length} gasto(s)`, 'data-action="csv"')}
      </div>
      <p class="muted">Estas acciones solo afectan a este viaje. Para cambiar de viaje usa el selector de arriba.</p>
    </div>

    <div class="scope scope-all"><span class="scope-chip">Global</span><b>Todos los viajes</b></div>
    <p class="muted scope-note">Viajes, personas, medios de pago, apariencia y copias de seguridad son comunes a todos los viajes.</p>
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
          <span class="label" id="t-people-l">Quiénes van</span>
          <div class="chips" id="t-people" role="group" aria-labelledby="t-people-l">
            ${c.allPeople.map((x) => `<button type="button" class="chip ${going.has(x.id) ? 'on' : ''}" aria-pressed="${going.has(x.id)}" data-action="trip-person" data-id="${esc(x.id)}">${esc(x.name)}</button>`).join('') || '<span class="muted">Primero agrega personas (más abajo).</span>'}
          </div>
        </div>
        <footer class="sheet-foot"><p id="t-error" class="form-error" role="alert" hidden></p>
          <button class="btn secondary" type="button" data-action="cancel-trip">Cancelar</button>
          <button class="btn" type="submit">${t.id ? 'Guardar' : 'Crear viaje'}</button></footer>
      </form></dialog>` : ''}
    </div>

    <div class="card"><h2>Apariencia</h2>
      <div class="seg theme-seg" role="group" aria-label="Tema de la app">${MODES.map((m) => `<button type="button" class="chip ${theme.mode === m.id ? 'on' : ''}" data-action="mode" data-id="${esc(m.id)}" aria-pressed="${theme.mode === m.id}"><svg viewBox="0 0 24 24" aria-hidden="true">${m.icon}</svg>${esc(m.name)}</button>`).join('')}</div>
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
          <button type="button" id="m-auto" class="chip ${isHexColor(m.color) ? '' : 'on'}" data-action="auto-color" aria-pressed="${!isHexColor(m.color)}">Automático</button>
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

    <div class="card"><h2>Datos y acceso</h2>
      <div class="acts">
        ${actTile('sync', 'Sincronizar', syncText, 'data-action="sync-now"')}
        ${actTile('backup', 'Respaldo', 'Todos los viajes en un JSON', 'data-action="backup"')}
        ${actTile('restore', 'Restaurar', 'Agrega lo que falte', 'data-action="restore"')}
        ${actTile('key', 'Cambiar código', 'De este dispositivo', 'data-action="logout"', { danger: true })}
      </div>
      <input id="restore-file" type="file" accept="application/json,.json" hidden>
      <p class="muted">Tarjetas y transferencias solo guardan nombre y últimos 4 dígitos; nunca números completos.</p>
    </div>`;
}

// Acciones de la tarjeta Datos: son botones (no registros), en cuadrícula de dos columnas con icono, nombre y una línea de estado.
const ACT_ICONS = {
  map: '<path d="M12 21s-6.5-5.6-6.5-11a6.5 6.5 0 0 1 13 0c0 5.4-6.5 11-6.5 11Z"/><circle cx="12" cy="10" r="2.3"/>',
  sync: '<path d="M20 11a8 8 0 0 0-14-4M4 5v3h3M4 13a8 8 0 0 0 14 4M20 19v-3h-3"/>',
  rates: '<path d="M4 17l5-5 4 4 7-8M15 8h5v5"/>',
  csv: '<path d="M6 3h8l4 4v14H6zM14 3v4h4M9 13h6M9 17h6"/>',
  backup: '<path d="M12 4v11M7.5 10.5 12 15l4.5-4.5M5 19h14"/>',
  restore: '<path d="M12 20V9M7.5 13.5 12 9l4.5 4.5M5 5h14"/>',
  key: '<circle cx="8" cy="15" r="3.5"/><path d="M10.5 12.5 19 4M16 7l2.5 2.5"/>',
};
const actTile = (icon, title, sub, attrs, { danger = false, link = false } = {}) => {
  const inner = `<svg viewBox="0 0 24 24" aria-hidden="true">${ACT_ICONS[icon]}</svg><b>${esc(title)}</b><span>${esc(sub)}</span>`;
  const cls = `act${danger ? ' danger' : ''}`;
  return link ? `<a class="${cls}" ${attrs}>${inner}</a>` : `<button type="button" class="${cls}" ${attrs}>${inner}</button>`;
};

function agoText(ms) {
  if (!ms) return 'sin sincronizar todavía';
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return 'hace un momento';
  if (s < 3600) return `hace ${Math.round(s / 60)} min`;
  if (s < 86400) return `hace ${Math.round(s / 3600)} h`;
  return `hace ${Math.round(s / 86400)} día(s)`;
}

// Deshacer un borrado: se vuelve a guardar el mismo gasto (mismo id, hora de creación y lugar en el día).
function undoDelete(e) {
  const placed = hasLocation(e);
  store.saveExpense({
    id: e.id, date: e.date, amount_cents: e.amount_cents, description: e.description ?? '',
    payment_method_id: e.payment_method_id, beneficiary_ids: e.beneficiary_ids, amount_approx: Boolean(e.amount_approx),
    lat: placed ? Number(e.lat) : null, lng: placed ? Number(e.lng) : null, place: placed ? (e.place ?? '') : null,
    created_at: e.created_at, sort_order: e.sort_order ?? undefined, trip_id: e.trip_id,
  }).then((r) => { if (r?.errors?.length) toast(r.errors[0], 'error'); });
  toast('Gasto restaurado');
}

// Restaurar un respaldo: se elige el archivo, se cuenta qué falta y, con confirmación, se agrega. No borra ni pisa nada.
async function restoreFromFile(file) {
  if (!file) return;
  if (file.size > 8 * 1024 * 1024) return toast('Ese archivo es demasiado grande para ser un respaldo', 'error');
  let data;
  try { data = JSON.parse(await file.text()); } catch { return toast('El archivo no es un respaldo válido', 'error'); }
  await busy(null, async () => {
    try {
      const plan = await store.restoreBackup(data, true);
      const a = plan.add;
      const parts = [[a.trips, 'viaje(s)'], [a.people, 'persona(s)'], [a.payment_methods, 'medio(s) de pago'], [a.expenses, 'gasto(s)']]
        .filter(([n]) => n > 0).map(([n, w]) => `${n} ${w}`);
      if (!parts.length) return toast('No falta nada: todo lo del respaldo ya está en la app');
      if (!confirm(`Se agregarán ${parts.join(', ')}.

Lo que ya existe no se toca ni se borra. ¿Restaurar?`)) return undefined;
      await store.restoreBackup(data, false);
      toast('Respaldo restaurado');
      return render();
    } catch (err) {
      return toast(err.offline ? 'Necesitas internet para esto' : err.message, 'error');
    }
  });
}

function downloadBackup(data) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
  a.download = `respaldo-gastos-viaje-${todayStr()}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
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
  const { places } = routeFrom(c.expenses);
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
const stopMarkers = new Map(); // número de parada -> marcador de Leaflet

function focusStop(n) {
  const marker = stopMarkers.get(Number(n));
  if (!marker || !leafletMap) return;
  leafletMap.flyTo(marker.getLatLng(), Math.max(leafletMap.getZoom(), 16), { duration: 0.6 });
  marker.openPopup();
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
  const map = L.map(el, { zoomControl: false });
  leafletMap = map;
  L.control.zoom({ position: 'bottomright', zoomInTitle: 'Acercar', zoomOutTitle: 'Alejar' }).addTo(map);
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19, attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
  }).addTo(map);
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
  clearTimeout(searchTimer);
  searchCtl?.abort();
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
  // Sin gasto con ubicación donde centrarse: se usa dónde estás (si das permiso) para centrar el mapa y ordenar las búsquedas.
  if (target.lat == null && !last && navigator.geolocation) {
    navigator.geolocation.getCurrentPosition((pos) => {
      geoRef = { lat: pos.coords.latitude, lng: pos.coords.longitude };
      if (pickMap && !pickPoint && pickMap.getZoom() < 8) pickMap.setView([geoRef.lat, geoRef.lng], 14);
    }, () => {}, { timeout: 6000, maximumAge: 600000 });
  }
  pickMap.on('click', (ev) => setPickPoint(ev.latlng));
  pickMap.invalidateSize();
}

// Búsqueda por nombre: sugerencias mientras escribes (con una pausa corta) y también al enviar. Prefiere lo que está cerca
// de tu ubicación o de lo que se ve en el mapa (ver geosearch.mjs): "Foco" encuentra el de tu ciudad, no uno de otro país.
let geoRef = null; // última ubicación del dispositivo, si dio permiso
let searchSeq = 0;
let searchCtl = null;
let searchTimer = null;

// Punto de referencia para ordenar los resultados: lo que se ve en el mapa (si ya está cerca de algo) o tu ubicación.
function searchRef() {
  const c = pickMap?.getCenter();
  if (c && pickMap.getZoom() >= 8) return { lat: c.lat, lng: c.lng };
  if (pickPoint) return { ...pickPoint };
  return geoRef;
}

async function runSearch(q) {
  if (!pickMap) return;
  const text = q.trim();
  searchCtl?.abort();
  if (text.length < 2) { $pickResults.hidden = true; return; }
  const seq = (searchSeq += 1);
  searchCtl = new AbortController();
  $pickResults.hidden = false;
  if (!$pickResults.childElementCount) $pickResults.innerHTML = '<div class="muted">Buscando…</div>';
  try {
    const { results } = await searchPlaces(text, { ref: searchRef(), signal: searchCtl.signal });
    if (seq !== searchSeq) return;
    $pickResults.found = results;
    $pickResults.innerHTML = results.length
      ? results.map((r, i) => `<button type="button" class="pick-res" data-i="${i}">
          <span class="pick-line"><b>${esc(r.name)}</b>${r.km == null ? '' : `<span class="pick-km">${esc(formatDistance(r.km))}</span>`}</span>
          <span class="muted">${esc(r.detail)}</span></button>`).join('')
      : '<div class="muted">No se encontró. Prueba con otro nombre o agrega la ciudad.</div>';
  } catch (err) {
    if (err?.name === 'AbortError' || seq !== searchSeq) return;
    $pickResults.innerHTML = '<div class="muted">No se pudo buscar. Revisa tu conexión o toca el mapa.</div>';
  }
}

document.getElementById('pick-search').addEventListener('submit', (ev) => {
  ev.preventDefault();
  clearTimeout(searchTimer);
  runSearch(document.getElementById('pick-q').value);
});
document.getElementById('pick-q').addEventListener('input', (ev) => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => runSearch(ev.target.value), 450);
});

$pickResults.addEventListener('click', (ev) => {
  const b = ev.target.closest('.pick-res');
  const r = b && $pickResults.found?.[Number(b.dataset.i)];
  if (!r || !pickMap) return;
  const at = { lat: r.lat, lng: r.lng };
  setPickPoint(at, r.name);
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
    <input id="code" type="password" aria-label="Código de acceso" autocomplete="current-password" placeholder="Código" required>
    <button class="btn" type="submit">Entrar</button></form>`;
}

function downloadCsv() {
  const c = ctx();
  const cur = currencies();
  const rows = [['Fecha', 'Descripción', 'Medio de pago', 'Pagó', 'Para', cur.dest.code, 'Tasa', cur.home.code, 'Aproximado', 'Lat', 'Lng', 'Lugar']];
  for (const e of [...c.expenses].sort(compareChronological)) {
    const m = c.methodsById[e.payment_method_id];
    rows.push([e.date, e.description, e.payment_method_id == null ? 'Por definir' : methodLabel(m), m ? personName(c, m.owner_person_id) : '',
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

let lastHash = null;
// Selector del elemento enfocado dentro de la pantalla, para devolverle el foco tras redibujar.
function focusKey() {
  const el = document.activeElement;
  if (!el || !$view.contains(el) || el === $view) return null;
  if (el.id) return `#${CSS.escape(el.id)}`;
  const { action, id } = el.dataset;
  return action ? `${el.localName}[data-action="${CSS.escape(action)}"]${id ? `[data-id="${CSS.escape(id)}"]` : ''}` : null;
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
  document.title = r.tab === 'home' ? 'Gastos de viaje' : `${r.title} · Gastos de viaje`;
  document.querySelectorAll('.tabbar a').forEach((a) => {
    const here = a.dataset.tab === r.tab;
    a.classList.toggle('active', here);
    if (here) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  });
  if (!r.map && leafletMap) { leafletMap.remove(); leafletMap = null; }
  if (!r.map) lastNonMap = location.hash || '#/';
  const keep = location.hash === lastHash ? focusKey() : null;
  lastHash = location.hash;
  $view.innerHTML = r.view(m);
  if (keep) $view.querySelector(keep)?.focus({ preventScroll: true }); // el redibujo no le quita el foco a quien navega con teclado
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
$view.addEventListener('click', (ev) => { if (['method-dialog', 'trip-dialog', 'person-dialog'].includes(ev.target.id) || ev.target.matches?.('dialog.info')) ev.target.close(); });

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
    resetFilters();
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
// Al cambiar de pantalla el foco pasa al contenido (si no, queda en un enlace que ya no está donde se esperaba).
window.addEventListener('hashchange', () => { render(); window.scrollTo(0, 0); $view.focus({ preventScroll: true }); });

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
  else if (action === 'map-stop') focusStop(id);
  else if (action === 'pm-owner') { draft.owner = id; paintCards(); }
  else if (action === 'info') document.getElementById(`info-${id}`)?.showModal();
  else if (action === 'info-close') t.closest('dialog')?.close();
  else if (action === 'bene') {
    draft.benes.has(id) ? draft.benes.delete(id) : draft.benes.add(id);
    t.classList.toggle('on', draft.benes.has(id));
    t.setAttribute('aria-pressed', String(draft.benes.has(id)));
    updateConv();
  } else if (action === 'approx') {
    draft.approx = !draft.approx;
    t.classList.toggle('on', draft.approx);
    t.setAttribute('aria-checked', String(draft.approx));
  } else if (action === 'locate') locate();
  else if (action === 'pick-map') openPicker();
  else if (action === 'unlocate') { draft.lat = null; draft.lng = null; draft.place = ''; paintLoc(); }
  else if (action === 'bar') {
    const d = homeBars[Number(id ?? t.dataset.i)];
    if (d) {
      document.getElementById('bar-read').textContent = barRead(d);
      document.querySelectorAll('.bars .bar').forEach((b) => b.classList.toggle('sel', b === t));
    }
  }
  else if (action === 'f-approx') { filters.approx = !filters.approx; render(); }
  else if (action === 'f-toggle') { filtersOpen = !filtersOpen; render(); }
  else if (action === 'f-noloc') { filters.noloc = !filters.noloc; render(); }
  else if (action === 'f-rate') { filters.rate = !filters.rate; render(); }
  else if (action === 'f-clear') { resetFilters(); render(); }
  else if (action === 'bene-all') {
    draft.benes = new Set(c.people.map((p) => p.id));
    document.querySelectorAll('#benes .chip[data-id]').forEach((b) => { b.classList.add('on'); b.setAttribute('aria-pressed', 'true'); });
    updateConv();
  } else if (action === 'del') {
    if (draft && !coolingDown() && confirm('¿Borrar este gasto?')) {
      const gone = c.expenses.find((x) => x.id === draft.id);
      store.deleteExpense(draft.id);
      draft = null;
      toast('Gasto borrado', 'ok', gone && { label: 'Deshacer', run: () => undoDelete(gone) });
      location.hash = '#/gastos';
    }
  } else if (action === 'range') {
    chartDays = Number(id);
    try { localStorage.setItem('bg_chartDays', String(chartDays)); } catch { /* sin almacenamiento */ }
    loadHistory();
  } else if (action === 'mode') { setTheme({ mode: id }); render(); }
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
  } else if (action === 'sync-now') {
    await busy(t, async () => { await sync(); toast(store.net.online && !store.pendingCount() ? 'Todo al día' : 'Aún hay gastos por enviar'); render(); }, 'Sincronizando…');
  } else if (action === 'backup') {
    await busy(t, () => guard(async () => { downloadBackup(await store.backupData()); toast('Respaldo descargado'); }), 'Preparando…');
  } else if (action === 'restore') document.getElementById('restore-file')?.click();
  else if (action === 'csv') downloadCsv();
  else if (action === 'logout') { store.setPass(''); store.net.needsLogin = true; render(); }
});

// --- ordenar los gastos de un día: mantener presionado y arrastrar ---

let dragSt = null; // { item, card, ids, grab, timer, active, ... } mientras hay un gesto sobre un gasto
let suppressClick = false;
let movedAway = false; // el puntero se movió antes de la espera: con mouse, soltar no debe contar como clic
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
  // El gasto sigue al dedo, pero solo dentro de la tarjeta de su día: no puede salirse hacia otros días.
  const nat = item.getBoundingClientRect();
  const box = card.getBoundingClientRect();
  const top = Math.min(Math.max(st.y - st.grab, box.top), Math.max(box.top, box.bottom - nat.height));
  item.style.transform = `translateY(${top - nat.top}px)`;
}

$view.addEventListener('pointerdown', (ev) => {
  movedAway = false;
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
  if (!st.active && Math.hypot(ev.clientX - st.x0, ev.clientY - st.y0) > MOVE_TOL) { clearTimeout(st.timer); dragSt = null; movedAway = true; }
});
$view.addEventListener('pointerup', (ev) => { if (dragSt && ev.pointerId === dragSt.pid) dragEnd(true); });
$view.addEventListener('pointercancel', (ev) => { if (dragSt && ev.pointerId === dragSt.pid) dragEnd(false); });
// En el celular, una vez que se empieza a arrastrar, el dedo no debe desplazar la página.
$view.addEventListener('touchmove', (ev) => { if (dragSt?.active) ev.preventDefault(); }, { passive: false });
// El menú del botón largo y la selección de texto estorban al arrastrar.
$view.addEventListener('contextmenu', (ev) => { if (ev.target.closest('.day-card[data-day] .item')) ev.preventDefault(); });
// El clic (si lo hay) llega justo después de soltar; pasado ese instante el aviso se apaga, para no tragarse
// un clic posterior hecho con el teclado.
for (const type of ['pointerup', 'pointercancel']) {
  $view.addEventListener(type, () => { if (movedAway) setTimeout(() => { movedAway = false; }, 50); });
}
$view.addEventListener('click', (ev) => {
  if (suppressClick || movedAway) { movedAway = false; ev.stopPropagation(); ev.preventDefault(); }
}, true);

// Reordenar con teclado: Alt + ↑ / ↓ sobre un gasto lo sube o baja dentro de su día.
$view.addEventListener('keydown', (ev) => {
  if (!ev.altKey || (ev.key !== 'ArrowUp' && ev.key !== 'ArrowDown')) return;
  const item = ev.target.closest?.('.item-open')?.closest('.item[data-id]');
  const card = item?.closest('.day-card[data-day]');
  if (!card) return;
  ev.preventDefault();
  const ids = [...card.querySelectorAll('.item[data-id]')].map((el) => el.dataset.id);
  const from = ids.indexOf(item.dataset.id);
  const to = from + (ev.key === 'ArrowUp' ? -1 : 1);
  if (to < 0 || to >= ids.length) return;
  [ids[from], ids[to]] = [ids[to], ids[from]];
  store.saveOrder(ids, `${store.activeTrip().id}:${card.dataset.day}`);
  announce(`Movido a la posición ${to + 1} de ${ids.length}`);
});

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
  if (id === 'restore-file') {
    const file = ev.target.files?.[0];
    ev.target.value = ''; // permite elegir otra vez el mismo archivo
    restoreFromFile(file);
  } else if (id === 'date') {
    if (ev.target.value) { draft.date = ev.target.value; loadRate(); renderChart(); }
  } else if (id === 'f-method') { filters.method = ev.target.value; render(); }
  else if (id === 'f-person') { filters.person = ev.target.value; render(); }
  else if (id === 'f-payer') { filters.payer = ev.target.value; render(); }
  else if (id === 'f-day') { filters.day = ev.target.value; render(); }
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
setInterval(() => { if (!document.hidden && !formActive()) sync(); }, 60000);

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}

render(); // primero lo guardado en el teléfono; si el servidor trae algo distinto, refresh() avisa y se redibuja
sync();
