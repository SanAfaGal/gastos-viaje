// Interfaz: router por hash y 5 pantallas, sin framework.
import { computeSettlement, splitEqual } from './settlement.mjs';
import { addDays, currencies, fmtDest, fmtHome, fmtMoney, fmtRate, parseAmount, toHome, todayStr } from './money.mjs';
import { CURRENCIES, DEFAULT_SETTINGS, currencyByCode } from './currencies.mjs';
import { DEFAULT_COLOR, KIND_COLOR, NETWORKS, NETWORK_MARK, cardPaint, isHexColor, suggestColor } from './cards.mjs';
import { changeAt, nearestIndex, sparkline } from './chart.mjs';
import { formatCoords, hasLocation, routeFrom } from './places.mjs';
import { compareChronological, newestFirst, sameOrder } from './order.mjs';
import { MODES, getTheme, setTheme } from './theme.js';
import * as store from './store.js';
import { breakdown, byDay, summary } from './stats.mjs';
import { distanceKm, formatDistance, parseCoordinates, searchPlaces } from './geosearch.mjs';
import { PICK_MIN_ZOOM, TAP_ZOOM, buildList, combineNearby, confirmPlace, dedupeByName, preferOsm, rankSearch, selectionSummary, tapRadiusM } from './picker.mjs';
import { icon } from './icons.mjs';
import { initSelects } from './select.mjs';
import { openDatePicker } from './datepicker.mjs';
import { knownPlaces, nearbyPlaces, placeIcon, placeKind, recentPlaces } from './nearby.mjs';

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

// El selector de color fija el color; "Automático" lo deja vacío para que lo decida la app.
function onMethodForm(id) {
  const g = (x) => document.getElementById(x);
  if (id === 'm-color-pick') g('m-color').value = g('m-color-pick').value;
  paintPreview();
}

// Deja la tarjeta elegida centrada en el carrusel sin mover la página.
function centerPicked() {
  const el = document.querySelector('#cards .pitem.on');
  if (el) el.parentElement.scrollLeft = el.offsetLeft - (el.parentElement.clientWidth - el.offsetWidth) / 2;
  paintCardDots();
}

// Indicador del carrusel de medios de pago: "2 de 5", un punto por tarjeta (el de la que está al centro va marcado) y un
// desvanecido en el borde por donde hay más. Sin esto solo se ven dos tarjetas y nada dice que existen más.
function paintCardDots() {
  const box = document.getElementById('cards');
  const dots = document.getElementById('cards-dots');
  if (!box || !dots) return;
  const items = [...box.querySelectorAll('.pitem')];
  const atEnd = box.scrollLeft + box.clientWidth >= box.scrollWidth - 6;
  const mid = box.scrollLeft + box.clientWidth / 2;
  let active = 0;
  let best = Infinity;
  items.forEach((el, i) => {
    const d = Math.abs(el.offsetLeft + el.offsetWidth / 2 - mid);
    if (d < best) { best = d; active = i; }
  });
  if (atEnd) active = items.length - 1; // al llegar al final el último no siempre alcanza el centro
  else if (box.scrollLeft <= 6) active = 0;
  box.classList.toggle('more-right', !atEnd);
  box.classList.toggle('more-left', box.scrollLeft > 6);
  dots.hidden = items.length < 2;
  dots.innerHTML = `<span class="cards-n">${active + 1} de ${items.length}</span>${items.length <= 8 ? items.map((_, i) => `<button type="button" class="cdot${i === active ? ' on' : ''}" data-action="card-go" data-i="${i}" aria-label="Ir al medio de pago ${i + 1} de ${items.length}"></button>`).join('') : ''}`;
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

// Estados de un gasto como iconos pequeños junto al título (en vez de etiquetas con texto): caben en una línea aunque haya varios.
// Cada uno tiene su explicación en el ⓘ del listado (ver legendHtml).
const STATUS = {
  nomethod: ['danger', 'cardoff', 'Sin medio de pago: no entra en Cuentas hasta que lo elijas'],
  rate: ['warn', 'clock', 'Esperando la tasa del día'],
  estimated: ['warn', 'clock', 'Tasa estimada: puede cambiar un poco'],
  approx: ['approx', null, 'Monto aproximado'],
  unsent: ['info', 'upload', 'Sin enviar: se envía cuando haya internet'],
};

function statusOf(e) {
  const out = [];
  if (e.payment_method_id == null) out.push('nomethod');
  if (e.amount_home == null) out.push('rate'); else if (e.rate_estimated) out.push('estimated');
  if (e.amount_approx) out.push('approx');
  if (e.pending) out.push('unsent');
  return out;
}

const statusHtml = (keys, extra = '') => (keys.length || extra
  ? `<span class="bds">${keys.map((k) => { const [tone, ic, label] = STATUS[k]; return `<span class="bd ${tone}" role="img" aria-label="${esc(label)}" title="${esc(label)}">${ic ? icon(ic) : '≈'}</span>`; }).join('')}${extra}</span>`
  : '');

// Quién va en el gasto: círculos con la inicial (cada persona siempre del mismo color). Hasta 3 y "+N".
function whoHtml(c, e) {
  const ids = e.beneficiary_ids;
  const shown = ids.slice(0, 3).map((id) => {
    const i = Math.max(0, c.people.findIndex((p) => p.id === id));
    return `<span class="av" style="background:var(--seg-${(i % 5) + 1})">${esc(initials(personName(c, id)))}</span>`;
  }).join('');
  return `<span class="avs sm" role="img" aria-label="${esc(forWho(c, e))}" title="${esc(forWho(c, e))}">${shown}${ids.length > 3 ? `<span class="av more">+${ids.length - 3}</span>` : ''}</span>`;
}

// Iniciales para el círculo de una persona: la de cada palabra del nombre, hasta dos ("Ana María" es AM, "Santiago" es S).
const initials = (name) => String(name ?? '').trim().split(/\s+/).filter(Boolean).slice(0, 2).map((w) => [...w][0].toUpperCase()).join('') || '?';

const METHOD_ICON = { card: 'card', pix: 'transfer', cash: 'banknote' };

// `n`: posición del gasto dentro de su día (solo en la lista, cuando el día tiene varios gastos).
function expenseItem(c, e, n) {
  const m = c.methodsById[e.payment_method_id];
  const cop = e.amount_home == null ? 'Por convertir' : fmtHome(e.amount_home);
  const { dest, home } = currencies();
  const cur = e.currency ?? dest.code;
  // Debajo del monto va el original, en su propia moneda. Si ya es la de casa no se convierte y se dice cuál es.
  const original = cur === home.code ? `en ${home.code}` : fmtMoney(cur, e.amount_cents);
  const keys = statusOf(e);
  const paint = m ? cardPaint(cardColor(m)) : null;
  const tile = m
    ? `<span class="tile" style="background:color-mix(in srgb, ${paint.c1} 50%, transparent)" aria-hidden="true">${icon(METHOD_ICON[m.kind] ?? 'card')}</span>`
    : '<span class="tile none" aria-hidden="true">' + icon('cardoff') + '</span>';
  const multiOwner = new Set(c.payMethods.map((x) => x.owner_person_id)).size > 1;
  const methodText = e.payment_method_id == null ? 'Medio por definir'
    : m ? `${esc(m.name)}${m.last4 ? ` ••${esc(m.last4)}` : ''}${multiOwner ? ` <span class="own">de ${esc(personName(c, m.owner_person_id))}</span>` : ''}`
      : 'Medio borrado';
  const title = e.description || 'Gasto';
  // La última palabra del título y los iconos van juntos en un bloque que no se parte: así los iconos nunca quedan solos en otra línea.
  // El botón (para el teclado) lleva el resto del título y su nombre completo en aria-label.
  const words = title.trim().split(/\s+/);
  const split = words.length > 1 && words.at(-1).length <= 18;
  const head = split ? `${words.slice(0, -1).join(' ')} ` : title;
  const tail = split ? `<span aria-hidden="true">${esc(words.at(-1))}</span>` : '';
  const pinBtn = hasLocation(e)
    ? `<button type="button" class="bd pinb pin" data-action="show-place" data-id="${esc(e.id)}" aria-label="Ver en el mapa" title="Ver en el mapa">${icon('mappin')}</button>` : '';
  return `<div class="item" data-action="edit" data-id="${esc(e.id)}">
    ${tile}
    <div class="im"><div class="t">${n ? `<span class="ord" title="Orden dentro del día">${n}</span>` : ''}<button type="button" class="item-open" data-action="edit" data-id="${esc(e.id)}" aria-label="${esc(`Editar: ${title}, ${cop}`)}">${esc(head)}</button><span class="tail">${tail}${statusHtml(keys, pinBtn)}</span></div>
      <div class="sub"><span class="mt">${methodText}</span>${whoHtml(c, e)}</div></div>
    <div class="r"><div class="num">${cop}</div><div class="muted">${esc(original)}</div></div>
  </div>`;
}

// Qué significa cada icono del listado (se abre con el ⓘ de arriba).
function legendHtml() {
  const row = (k) => { const [tone, ic, label] = STATUS[k]; const [t, rest] = label.split(': '); return `<li><span class="bd ${tone}" aria-hidden="true">${ic ? icon(ic) : '≈'}</span><span><b>${esc(t)}</b>${rest ? `<span class="muted">${esc(rest)}</span>` : ''}</span></li>`; };
  return `<ul class="legend">${['nomethod', 'rate', 'estimated', 'approx', 'unsent'].map(row).join('')}
    <li><span class="bd pinb" aria-hidden="true">${icon('mappin')}</span><span><b>Tiene ubicación</b><span class="muted">Tócalo para verlo en el mapa</span></span></li>
    <li><span class="avs sm" aria-hidden="true"><span class="av" style="background:var(--seg-1)">S</span><span class="av" style="background:var(--seg-2)">A</span></span><span><b>Para quién es</b><span class="muted">Un círculo con la inicial de cada persona</span></span></li></ul>`;
}

// ---------- pantallas ----------

// Resumen general: cifras clave y gráficos. El detalle de cada gasto está en Gastos y los saldos en Cuentas.
let homeBars = []; // días del gráfico (para la lectura al tocar una barra)

// Fuente de una tasa, como se muestra. Vacía = se guardó antes de que la app registrara la fuente.
const RATE_SOURCES = { fawazahmed0: 'fawazahmed0/currency-api', frankfurter: 'Frankfurter' };
const rateSourceLabel = (source) => RATE_SOURCES[source] ?? (source || 'No registrada');

const shortDate = (d) => new Date(`${d}T12:00:00`).toLocaleDateString('es-CO', { day: 'numeric', month: 'short' });
const barRead = (d) => `${dayLabel(d.date)} · ${d.count ? `${fmtHome(d.home)} · ${d.count} gasto(s)` : 'sin gastos'}`;

// Una barra horizontal apilada al 100 %: cada tramo es una parte del total (su ancho es el porcentaje). Los montos ya están en Cuentas; aquí
// solo se ve qué parte del gasto fue de cada uno. La leyenda dice el nombre y el porcentaje de cada tramo (los tramos pequeños no caben).
const STACK_COLORS = ['var(--seg-1)', 'var(--seg-2)', 'var(--seg-3)', 'var(--seg-4)', 'var(--seg-5)'];
const pctText = (p) => `${p.toFixed(p < 10 ? 1 : 0).replace('.', ',')} %`;

function stackHtml(title, rows, colorOf) {
  const colors = rows.map((r, i) => colorOf(r, i));
  const aria = rows.map((r) => `${r.label} ${pctText(r.pct)}`).join(', ');
  return `<div class="stack-block"><div class="stack-title">${esc(title)}</div>
    <div class="stack" role="img" aria-label="${esc(`${title}: ${aria}`)}">${rows.map((r, i) => `<span class="stack-seg" style="flex:${Math.max(r.pct, 0.8).toFixed(2)};background:${colors[i]}"></span>`).join('')}</div>
    <ul class="stack-legend">${rows.map((r, i) => `<li><span class="stack-dot" style="background:${colors[i]}" aria-hidden="true"></span><span class="stack-name">${esc(r.label)}</span><b>${pctText(r.pct)}</b></li>`).join('')}</ul></div>`;
}

function viewHome() {
  const c = ctx();
  if (needsSetup(c)) return setupCard();
  const today = todayStr();
  const waiting = c.expenses.filter((e) => e.amount_home == null).length;
  const placed = c.expenses.filter(hasLocation).length;
  const unsent = store.pendingCount();
  const cur = currencies();
  const s = summary(c.expenses, today, cur.dest.code);
  const destOnly = c.expenses.filter((e) => !e.currency || e.currency === cur.dest.code); // las de otra moneda no se suman en la del destino
  const totalDest = destOnly.reduce((a, e) => a + e.amount_cents, 0);
  homeBars = byDay(c.expenses, { today, days: 14, dest: cur.dest.code });
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
  const rateCard = `<div class="card"><h2>Tasa de cambio · ${esc(cur.dest.code)} → ${esc(cur.home.code)}</h2>
      <div class="chart" id="chart" role="group"></div></div>`;
  return `
    ${unsent ? `<div class="banner">${unsent} gasto(s) sin enviar. Se envían solos cuando haya internet.</div>` : ''}
    ${waiting ? `<div class="banner">${waiting} gasto(s) esperando la tasa del día.</div>` : ''}
    <div class="card hero"><h2>Total gastado</h2>
      <div class="big">${fmtHome(s?.total ?? 0)}</div>
      <div class="sub">${fmtDest(totalDest)} · ${c.expenses.length} gasto(s)</div>
      <a class="hero-link" href="#/mapa">${icon('map')} Ver mapa${placed ? ` · ${placed} con ubicación` : ''}</a>
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
    ${rateCard}
    <div class="card"><h2>Cómo se pagó · en porcentaje</h2>
      ${stackHtml('Por medio de pago', methodRows, (r, i) => (r.id === '__otros' || r.id === PENDING ? 'var(--seg-other)' : STACK_COLORS[i % STACK_COLORS.length]))}
      ${payerRows.length > 1 ? stackHtml('Quién pagó', payerRows, (r, i) => (r.id === '__otros' ? 'var(--seg-other)' : STACK_COLORS[i % STACK_COLORS.length])) : ''}
    </div>` : `<div class="card"><div class="empty">Aún no hay gastos. Toca el + para agregar.</div></div>${rateCard}`}`;
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
  const cur = currencies();
  // Solo los gastos en la moneda del destino suman ahí: los de otra moneda (la de casa, un tercer país) ya están en el total de arriba.
  const sumDest = (items) => items.filter((e) => !e.currency || e.currency === cur.dest.code).reduce((a, e) => a + e.amount_cents, 0);
  const unconverted = list.filter((e) => e.amount_home == null).length;
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
  for (const d of days) d.items = newestFirst(d.items); // en pantalla el último gasto del día va arriba
  return `
    <div class="card sum">
      <div class="sum-top"><h2>${filtered ? 'Con filtros' : 'Todos los gastos'}</h2>
        <span class="sum-tools"><a class="pill-link" href="#/mapa">${MAP_ICON}Mapa</a>${infoBtn('legend', 'Qué significan los iconos')}</span></div>
      <div class="sum-vals">
        <div><div class="big">${fmtHome(sumHome(list))}</div><div class="muted">en ${esc(cur.home.code)}</div></div>
        <div><div class="big alt">${fmtDest(sumDest(list))}</div><div class="muted">en ${esc(cur.dest.code)}, lo que se pagó</div></div>
      </div>
      <div class="sum-foot"><span class="muted">${list.length} gasto(s)</span>${unconverted ? `<span class="bd warn wide">${icon('clock')} ${unconverted} sin convertir</span>` : ''}
        ${filtered ? '<button type="button" class="chip small" data-action="f-clear">Quitar filtros</button>' : ''}</div>
    </div>
    ${infoDialog('legend', 'Qué significan los iconos', legendHtml())}
    <div class="filters">
      <div class="filt-bar">
        <input id="f-q" type="search" aria-label="Buscar en la descripción" placeholder="Buscar descripción" value="${esc(filters.q)}">
        <button type="button" class="chip filt-btn ${filtersOpen || activeCount ? 'on' : ''}" data-action="f-toggle" aria-expanded="${filtersOpen}" aria-controls="f-panel">Filtros${activeCount ? ` · ${activeCount}` : ''} <span aria-hidden="true">${filtersOpen ? '▴' : '▾'}</span></button>
      </div>
      <div class="filt-panel" id="f-panel" ${filtersOpen ? '' : 'hidden'}>
      <select id="f-day" aria-label="Día"><option value="">Todos los días</option>
        ${dayList.map((d) => `<option value="${esc(d)}" ${filters.day === d ? 'selected' : ''}>${esc(dayLabel(d))} (${c.expenses.filter((e) => e.date === d).length})</option>`).join('')}</select>
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
    ${days.length ? days.map((d) => `<div class="day"><span>${esc(dayLabel(d.date))}</span><span class="day-tot"><b>${fmtHome(sumHome(d.items))}</b>${sumDest(d.items) ? ` <span class="muted">${fmtDest(sumDest(d.items))}</span>` : ''}</span></div>
      <div class="card day-card" ${sortable ? `data-day="${esc(d.date)}"` : ''} style="padding:4px 16px">${d.items.map((e) => expenseItem(c, e, orderOf.get(e.id))).join('')}</div>`).join('')
      : '<div class="empty">No hay gastos con ese filtro.</div>'}`;
}

// --- formulario de gasto ---

let draft = null;
let convRate = null; // { rate, estimated, rate_date, source, local } para la fecha del formulario
let lastBenes = JSON.parse(localStorage.getItem('bg_lastBenes') ?? '[]');

function newDraft(c, date = todayStr()) {
  // El medio de pago empieza vacío: hay que elegirlo a propósito (o marcar "Por definir").
  const method = '';
  const going = new Set(c.people.map((p) => p.id));
  const benes = lastBenes.filter((id) => going.has(id));
  return { id: null, date, currency: currencies().dest.code, amountText: '', desc: '', method, benes: new Set(benes.length ? benes : c.people.map((p) => p.id)), created_at: null, approx: false, lat: null, lng: null, place: '' };
}

function draftFrom(c, id) {
  const e = c.expenses.find((x) => x.id === id);
  if (!e) return null;
  return {
    id: e.id, date: e.date, currency: e.currency ?? currencies().dest.code, amountText: (e.amount_cents / 100).toFixed(2).replace('.', ','),
    desc: e.description, method: e.payment_method_id ?? PENDING, benes: new Set(e.beneficiary_ids),
    created_at: e.created_at,
    approx: Boolean(e.amount_approx),
    lat: hasLocation(e) ? Number(e.lat) : null, lng: hasLocation(e) ? Number(e.lng) : null, place: e.place ?? '',
  };
}

// Fila de ubicación del formulario. Se vuelve a dibujar sola (sin render()) para no perder lo escrito.
// Elegir el lugar (mapa, ubicación, búsqueda y sugerencias) es un solo diálogo: ver openPicker.
function locHtml() {
  if (draft.lat == null) {
    const here = draft.here;
    // Buscando con el GPS: se ve que algo pasa y se puede cancelar.
    if (here?.state === 'locating' && !here.options?.length) {
      return `<div class="loc-box"><div class="loc-wait"><span class="spin" aria-hidden="true"></span><span>Buscando dónde estás…</span>
        <button type="button" class="linkbtn" data-action="here-cancel">Cancelar</button></div></div>`;
    }
    // Con el GPS: el sitio más cercano se ofrece de un toque y los siguientes quedan como alternativas.
    if (here?.options?.length) {
      const [best, ...rest] = here.options;
      const detail = (o) => [placeKind(o.kind) || o.detail || (o.count ? 'Ya usaste este lugar' : ''), o.km != null ? formatDistance(o.km) : ''].filter(Boolean).join(' · ');
      return `<div class="loc-box sug">
        <div class="loc-head"><span class="loc-ico" aria-hidden="true">${placeIcon(best.kind)}</span>
          <div class="loc-info"><span class="muted">Estás aquí</span><b>${esc(best.name || 'Lugar sin nombre')}</b><span class="muted">${esc(detail(best))}</span></div></div>
        <button type="button" class="btn loc-cta" data-action="here-use" data-i="0">Usar este lugar</button>
        ${rest.length ? `<div class="loc-chips">${rest.map((o, i) => `<button type="button" class="chip loc-chip" data-action="here-use" data-i="${i + 1}">${placeIcon(o.kind)} <span class="loc-chip-t">${esc(o.name || 'Sin nombre')}</span>${o.km != null ? ` <span class="loc-chip-s">${esc(formatDistance(o.km))}</span>` : ''}</button>`).join('')}</div>` : ''}
        ${here.state === 'locating' ? '<div class="loc-more muted"><span class="spin" aria-hidden="true"></span> Buscando más sitios…</div>' : ''}
        <div class="loc-links"><button type="button" class="linkbtn" data-action="pick-map">Elegir en el mapa</button><button type="button" class="linkbtn" data-action="here-point">Solo mi punto, sin nombre</button></div></div>`;
    }
    // Varios gastos en el mismo lugar con distinto medio de pago: se elige una vez y después basta un toque. Los lugares donde ya hubo un
    // gasto de este mismo día salen primero.
    draft.recentList = recentPlaces(ctx().expenses, { date: draft.date, limit: 3 });
    const chips = draft.recentList.map((r, i) => `<button type="button" class="chip loc-chip" data-action="use-recent" data-i="${i}"
        aria-label="Usar el lugar ${esc(r.name || 'sin nombre')}${r.today ? ', donde ya hay un gasto de este día' : ''}">${icon('mappin')} <span class="loc-chip-t">${esc(r.name || 'Sin nombre')}</span>${r.today ? ' <span class="loc-chip-s">este día</span>' : ''}</button>`).join('');
    const note = { empty: 'No encontré sitios con nombre aquí.', denied: 'Sin permiso de ubicación. Actívalo en el navegador.', error: 'No se pudo obtener tu ubicación.' }[here?.state];
    return `<div class="loc-box">
      <div class="loc-empty"><span class="loc-ico" aria-hidden="true">${icon('mappin')}</span><span>${esc(note ?? 'Lugar del gasto (opcional)')}</span></div>
      ${chips ? `<div class="loc-recent"><span class="muted">Usar un lugar reciente</span><div class="loc-chips">${chips}</div></div>` : ''}
      <div class="loc-btns">
        <button type="button" class="btn secondary" data-action="here">${icon('crosshair')} ¿Dónde estoy?</button>
        <button type="button" class="btn secondary" data-action="pick-map">${icon('map')} En el mapa</button></div>
      ${here?.state === 'empty' && here.fix ? '<div class="loc-links"><button type="button" class="linkbtn" data-action="here-point">Usar mi punto, sin nombre</button></div>' : ''}</div>`;
  }
  return `<div class="loc-box set">
      <div class="loc-head"><span class="loc-ico on" aria-hidden="true">${icon('mappin')}</span>
        <div class="loc-info"><span class="muted">Lugar elegido</span><b id="loc-name">${esc(draft.place.trim() || 'Ubicación sin nombre')}</b>
          <span class="muted">${esc(formatCoords(draft.lat, draft.lng))}${draft.place.trim() ? '' : ' · toca Cambiar para ponerle nombre'}</span></div></div>
      <div class="loc-btns">
        <button type="button" class="btn secondary small" data-action="pick-map">Cambiar</button>
        <button type="button" class="btn danger small" data-action="unlocate">Quitar</button>
      </div></div>`;
}

function paintLoc() {
  const el = document.getElementById('loc');
  if (el && draft) el.innerHTML = locHtml();
}

// --- sugerencia de lugar con el GPS ---
// Al abrir un gasto nuevo, si el teléfono ya te dio permiso de ubicación, se busca solo dónde estás y se ofrece el sitio más cercano
// (primero los que ya usaste, luego OpenStreetMap; Foursquare solo si no hay nada, para cuidar el cupo gratis). Sin permiso, no se
// pide nada solo: queda el botón "¿Dónde estoy?". Nada se guarda hasta que tocas "Usar este lugar".
const hereCache = { key: '', at: 0, osm: [], fsq: [] }; // la misma zona varios gastos seguidos no vuelve a consultar
let hereSeq = 0;
let hereCtl = null;

async function geoGranted() {
  try { return (await navigator.permissions?.query({ name: 'geolocation' }))?.state === 'granted'; } catch { return false; }
}

function autoHere() {
  if (!draft || draft.id || draft.lat != null || !navigator.geolocation) return;
  const target = draft;
  geoGranted().then((ok) => { if (ok && draft === target && target.lat == null && !target.here) suggestHere(); });
}

async function suggestHere() {
  const target = draft;
  if (!target || target.lat != null) return;
  if (!navigator.geolocation) { target.here = { state: 'error' }; return paintLoc(); }
  hereCtl?.abort();
  hereCtl = new AbortController();
  const signal = hereCtl.signal;
  const seq = (hereSeq += 1);
  const alive = () => draft === target && seq === hereSeq && target.lat == null && !signal.aborted;
  target.here = { state: 'locating', options: [] };
  paintLoc();
  let fix;
  try {
    fix = await readPosition({ maxMs: 5000, goodM: 30, signal });
  } catch (err) {
    if (err?.code === 0 || !alive()) return; // lo cancelaste
    target.here = { state: err?.code === 1 ? 'denied' : 'error' };
    return paintLoc();
  }
  if (!alive()) return;
  geoRef = { lat: fix.lat, lng: fix.lng };
  const key = `${fix.lat.toFixed(4)},${fix.lng.toFixed(4)}`;
  const fresh = hereCache.key === key && Date.now() - hereCache.at < CACHE_MS;
  let osm = fresh ? hereCache.osm : [];
  let fsq = fresh ? hereCache.fsq : [];
  const known = knownPlaces(ctx().expenses, fix);
  const show = (done) => {
    if (!alive()) return;
    const options = combineNearby({ known, osm, fsq }).slice(0, 3);
    target.here = { state: done ? (options.length ? 'found' : 'empty') : 'locating', fix, options };
    paintLoc();
  };
  show(fresh);
  if (fresh) return;
  try {
    const r = await nearbyPlaces(fix, { radiusM: 80, limit: 6, signal, onPartial: ({ results }) => { osm = results; show(false); } });
    osm = r.results;
  } catch (err) {
    if (err?.name === 'AbortError' || !alive()) return;
  }
  // Foursquare (con edificios) solo si con lo anterior no hay nada que ofrecer.
  if (alive() && !combineNearby({ known, osm, fsq }).length) {
    try {
      const { configured, results } = await store.fetchMorePlaces({ lat: fix.lat, lng: fix.lng, radius: 150 });
      if (configured) fsq = results.map((x) => ({ ...x, km: distanceKm(fix, x) }));
    } catch { /* sin Foursquare: queda lo que haya */ }
  }
  hereCache.key = key; hereCache.at = Date.now(); hereCache.osm = osm; hereCache.fsq = fsq;
  show(true);
}

function useHere(i) {
  const here = draft?.here;
  const o = here?.options?.[i];
  if (!o) return;
  draft.lat = o.lat; draft.lng = o.lng; draft.place = String(o.name ?? '').slice(0, 120);
  draft.here = null;
  paintLoc();
}

function useHerePoint() {
  const fix = draft?.here?.fix;
  if (!fix) return;
  draft.lat = fix.lat; draft.lng = fix.lng; draft.place = '';
  draft.here = null;
  paintLoc();
}

// Una sola lectura del GPS suele traer un punto impreciso. Se escucha unos segundos y se queda con la lectura más exacta
// (o la primera que llegue a ±25 m). Rechaza con el error del navegador si no hubo ninguna.
// `onProgress(precisión en m)` avisa cada vez que mejora la lectura; `signal` la cancela (rechaza con { code: 0 }).
function readPosition({ goodM = 25, maxMs = 6000, onProgress, signal } = {}) {
  return new Promise((resolve, reject) => {
    let best = null;
    let id = null;
    let timer = null;
    const stop = () => { navigator.geolocation.clearWatch(id); clearTimeout(timer); signal?.removeEventListener('abort', cancel); };
    const finish = (err) => {
      stop();
      if (best) resolve(best); else reject(err ?? { code: 3 });
    };
    function cancel() { stop(); reject({ code: 0 }); }
    if (signal?.aborted) return reject({ code: 0 });
    signal?.addEventListener('abort', cancel);
    id = navigator.geolocation.watchPosition((pos) => {
      if (!best || pos.coords.accuracy < best.accuracy) {
        best = { lat: pos.coords.latitude, lng: pos.coords.longitude, accuracy: pos.coords.accuracy };
        onProgress?.(best.accuracy);
      }
      if (best.accuracy <= goodM) finish();
    }, (err) => { if (err.code === 1 || !best) finish(err); }, { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 });
    timer = setTimeout(() => finish(), maxMs);
  });
}

// Botón "Ir a mi ubicación" para los mapas: si estás viendo algo lejos, vuelve a donde estás y marca tu posición con un
// punto (y un círculo con la precisión). No cambia nada del gasto; solo mueve la vista. `onError(texto)` avisa si falla.
function addLocateControl(L, map, onError) {
  if (!navigator.geolocation) return;
  const control = L.control({ position: 'bottomright' });
  let dot = null;
  let ring = null;
  let busy = false;
  control.onAdd = () => {
    const bar = L.DomUtil.create('div', 'leaflet-bar locate-ctl');
    const btn = L.DomUtil.create('a', '', bar);
    btn.href = '#';
    btn.setAttribute('role', 'button');
    btn.setAttribute('aria-label', 'Ir a mi ubicación');
    btn.title = 'Ir a mi ubicación';
    // Icono dibujado (mira con punto central): el carácter ◎ no existe en todas las tipografías y a veces no se veía.
    btn.innerHTML = '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" focusable="false"><circle cx="12" cy="12" r="6.5" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="12" cy="12" r="2.2" fill="currentColor"/><path d="M12 2v3.5M12 18.5V22M2 12h3.5M18.5 12H22" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
    L.DomEvent.disableClickPropagation(bar);
    L.DomEvent.on(btn, 'click', async (ev) => {
      L.DomEvent.preventDefault(ev);
      if (busy) return;
      busy = true;
      bar.classList.add('locating'); // no 'busy': esa clase global dibuja un giro a la izquierda
      try {
        const fix = await readPosition({ maxMs: 5000 });
        if (!map.getContainer().isConnected) return; // se cambió de pantalla mientras buscaba
        geoRef = { lat: fix.lat, lng: fix.lng };
        const at = [fix.lat, fix.lng];
        const color = getComputedStyle(document.documentElement).getPropertyValue('--brand').trim() || '#0b6b4a';
        dot?.remove();
        ring?.remove();
        ring = L.circle(at, { radius: fix.accuracy, color, weight: 1, fillOpacity: 0.1, interactive: false }).addTo(map);
        dot = L.circleMarker(at, { radius: 8, color: '#fff', weight: 3, fillColor: color, fillOpacity: 1, interactive: false }).addTo(map);
        map.flyTo(at, Math.max(map.getZoom(), 16), { duration: 0.6 });
      } catch (err) {
        onError(err?.code === 1 ? 'Sin permiso de ubicación. Actívalo en el navegador.' : 'No se pudo obtener tu ubicación.');
      } finally {
        busy = false;
        bar.classList.remove('locating');
      }
    });
    return bar;
  };
  control.addTo(map);
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
  paintCardDots();
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
    autoHere(); // un gasto nuevo con permiso de ubicación ya concedido: sugiere dónde estás
  }
  return `
    <form id="exp-form" class="xform" autocomplete="off" novalidate>
      <section class="amount-hero" aria-label="Monto">
        <div class="hero-top">
          <label for="amount" id="amount-l">${amountLabel()}</label>
          <span class="lab-tools"><button type="button" class="switch ${draft.approx ? 'on' : ''}" role="switch" aria-checked="${draft.approx}" data-action="approx"><span class="track" aria-hidden="true"></span>Aproximado</button>
            ${infoBtn('approx', 'Monto aproximado')}</span>
        </div>
        <input id="amount" class="amount" inputmode="decimal" placeholder="0,00" value="${esc(draft.amountText)}">
        <div class="chips cur-chips" id="cur" role="radiogroup" aria-label="Moneda del gasto">${curHtml()}</div>
        <div class="conv-row"><div class="conv" id="conv"></div>${infoBtn('rate', 'Tasa de cambio e historial')}</div>
      </section>

      <section class="fcard" aria-labelledby="when-l">
        <div class="lab-row"><span class="flab" id="when-l">Cuándo y dónde</span>${infoBtn('loc', 'Ubicación')}</div>
        <div class="chips date-chips" id="dates" role="group" aria-label="Día del gasto">${dateHtml()}</div>
        <div id="loc" class="loc" role="group" aria-label="Lugar del gasto">${locHtml()}</div>
      </section>

      <section class="fcard" aria-labelledby="cards-l">
        <div class="lab-row"><span class="flab" id="cards-l">Pagado con</span>${infoBtn('pay', 'Pagado con')}</div>
        ${ownerFilterHtml(c)}
        <div class="cards" id="cards" role="radiogroup" aria-labelledby="cards-l">${cardsHtml(c)}</div>
        <div class="cards-dots" id="cards-dots" role="group" aria-label="Medios de pago disponibles"></div>
      </section>

      <section class="fcard" aria-labelledby="benes-l">
        <div class="lab-row"><span class="flab" id="benes-l">¿Para quién es?</span>${infoBtn('who', 'Para quién es')}</div>
        <div id="benes" role="group" aria-labelledby="benes-l">${benesHtml(c)}</div>
      </section>

      <section class="fcard">
        <label class="flab" for="desc">Descripción</label>
        <input id="desc" maxlength="120" placeholder="Almuerzo, Uber, entradas…" value="${esc(draft.desc)}">
      </section>

      <button class="btn" type="submit" data-then="list">${draft.id ? 'Guardar cambios' : 'Guardar'}</button>
      ${draft.id ? '' : '<button class="btn secondary" type="submit" data-then="again">Guardar y agregar otro</button>'}
      ${draft.id ? '<div class="form-danger"><button class="icon-del" type="button" data-action="del" aria-label="Borrar este gasto" title="Borrar este gasto"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg></button></div>' : ''}
      ${infoDialog('rate', 'Tasa de cambio', `<div class="muted" id="conv-detail"></div>
      <p class="muted">La tasa sale de una fuente gratuita que publica un valor por día. Suele ser el cierre del día anterior, así que puede diferir un poco de lo que muestra Google, y tu banco o tarjeta además aplica su propio margen. La de hoy es provisional hasta que cierre el día.</p>
      <p class="muted">El gráfico con el historial de la tasa está en <a href="#/">Inicio</a>.</p>`)}
      ${infoDialog('pay', 'Pagado con', 'Elige con qué se pagó. Si no lo sabes, elige «Por definir» y lo completas después; ese gasto no entra en las cuentas hasta entonces.')}
      ${infoDialog('who', '¿Para quién es?', 'El gasto se divide en partes iguales entre las personas marcadas. «Todos» marca a todas las del viaje.')}
      ${infoDialog('approx', 'Monto aproximado', 'Márcalo si el monto es redondeado y hay que ajustarlo después. El gasto queda con la etiqueta «Monto aproximado» y puedes filtrarlos.')}
      ${infoDialog('loc', 'Ubicación', 'Opcional. Sirve para ver en el mapa dónde gastaste.')}
    </form>`;
}

// Día del gasto: casi siempre es hoy o ayer, así que son dos toques; cualquier otro día abre el calendario del teléfono.
function dateHtml() {
  const today = todayStr();
  const yesterday = addDays(today, -1);
  const other = draft.date !== today && draft.date !== yesterday;
  const chip = (id, label, on) => `<button type="button" class="chip ${on ? 'on' : ''}" data-action="date-q" data-id="${id}" aria-pressed="${on}">${label}</button>`;
  return `${chip('today', 'Hoy', draft.date === today)}${chip('yesterday', 'Ayer', draft.date === yesterday)}
    <button type="button" class="chip date-other ${other ? 'on' : ''}" data-action="date-open" aria-haspopup="dialog" aria-pressed="${other}">${icon('calendar')} <span>${other ? esc(shortDate(draft.date)) : 'Otro día'}</span></button>`;
}

function paintDates() {
  const el = document.getElementById('dates');
  if (el && draft) el.innerHTML = dateHtml();
}

// Se cambió el día: la tasa, el gráfico y los lugares de ese día (pasan al principio) se ponen al día.
function setDraftDate(date) {
  draft.date = date;
  paintDates();
  loadRate();
  renderChart();
  if (draft.lat == null) paintLoc();
}

// ¿Para quién? Con 3 o más personas se pliega en una línea (casi siempre es igual que la vez anterior) y se abre al tocarla.
function benesHtml(c) {
  const chosen = c.people.filter((p) => draft.benes.has(p.id));
  if (c.people.length >= 3 && chosen.length && !draft.benesOpen) {
    const all = chosen.length === c.people.length;
    const names = all ? `Todos (${chosen.length})` : chosen.map((p) => personName(c, p.id)).join(', ');
    const dots = chosen.slice(0, 4).map((p) => `<span class="av">${esc(initials(personName(c, p.id)))}</span>`).join('');
    return `<button type="button" class="benes-sum" data-action="benes-open" aria-label="Para quién es: ${esc(names)}. Cambiar">
      <span class="avs" aria-hidden="true">${dots}</span><span class="benes-t">${esc(names)}</span><span class="benes-c">Cambiar ›</span></button>`;
  }
  return `<div class="chips">${c.people.map((p) => `<button type="button" class="chip ${draft.benes.has(p.id) ? 'on' : ''}" data-action="bene" data-id="${esc(p.id)}" aria-pressed="${draft.benes.has(p.id)}">${esc(personName(c, p.id))}</button>`).join('')}
    <button type="button" class="chip ghost" data-action="bene-all">Todos</button></div>`;
}

function paintBenes() {
  const el = document.getElementById('benes');
  if (el && draft) el.innerHTML = benesHtml(ctx());
}

// Moneda del gasto: la del destino, la de casa (sin conversión) u otra del catálogo (un tercer país).
const amountLabel = () => {
  const c = currencyByCode(draft.currency) ?? currencies().dest;
  return `Monto en ${esc(c.name.toLowerCase())} (${esc(c.code)})`;
};

function curHtml() {
  const { dest, home } = currencies();
  const main = [dest.code, home.code];
  const other = main.includes(draft.currency) ? '' : draft.currency;
  const chip = (code, extra = '') => `<button type="button" class="chip ${draft.currency === code ? 'on' : ''}" role="radio" aria-checked="${draft.currency === code}" data-action="cur" data-id="${esc(code)}">${esc(code)}${extra}</button>`;
  const options = CURRENCIES.filter((x) => !main.includes(x.code))
    .map((x) => `<option value="${esc(x.code)}" ${x.code === other ? 'selected' : ''}>${esc(`${x.code} · ${x.name}`)}</option>`).join('');
  return `${chip(dest.code)}${chip(home.code)}
    <select id="cur-other" class="chip cur-other ${other ? 'on' : ''}" aria-label="Otra moneda"><option value="" hidden>Otra moneda…</option>${options}</select>`;
}

function paintCur() {
  const el = document.getElementById('cur');
  if (el) el.innerHTML = curHtml();
  const l = document.getElementById('amount-l');
  if (l) l.innerHTML = amountLabel();
  loadRate();
}

async function loadRate() {
  const date = draft.date;
  const currency = draft.currency;
  convRate = null;
  updateConv();
  const r = await store.fetchRate(date, currency);
  if (draft && draft.date === date && draft.currency === currency) {
    convRate = r ? { rate: r.rate, estimated: Boolean(r.estimated), rate_date: r.rate_date, source: r.source, local: r.local } : null;
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

let historyKey = ''; // viaje y período del historial cargado: evita pedirlo de nuevo en cada sincronización
const chartKey = () => `${store.activeTrip().id}|${chartDays}`;

function homeChart() {
  if (history === null || historyKey !== chartKey()) loadHistory(); else renderChart();
}

async function loadHistory() {
  const days = chartDays;
  historyKey = chartKey();
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
  if (!el) return;
  const tabs = `<div class="mini-tabs" role="group" aria-label="Período del gráfico">${RANGES.map((d) =>
    `<button type="button" class="mini-tab ${d === chartDays ? 'on' : ''}" data-action="range" data-id="${d}" aria-pressed="${d === chartDays}">${d} d</button>`).join('')}</div>`;
  const g = history ? sparkline(history, draft?.date ?? null) : null;
  if (!g) {
    chartGeo = null;
    el.removeAttribute('aria-label');
    el.innerHTML = history === null
      ? `<div class="chart-top"><div class="chart-read"><div class="chart-meta">Cargando tasas…</div></div>${tabs}</div>`
      : '<div class="chart-meta">Todavía no hay historial de esta tasa.</div>';
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
  val.textContent = `1 ${cur.dest.code} = ${numFmt(p.rate)} ${cur.home.code}`;
  const isSel = !scrubbing && chartGeo.selectedIndex === i;
  document.getElementById('c-meta').textContent = `${isSel ? 'Día del gasto' : p.date === todayStr() ? 'Hoy' : dayShort(p.date)} · ${pctFmt(changeAt(history, i))} en ${history.length} días`;
  const cents = parseAmount(draft?.amountText);
  // El gráfico es de la moneda del destino: en un gasto de otra moneda no sirve para convertir.
  document.getElementById('c-conv').textContent = cents && (!draft?.currency || draft.currency === cur.dest.code) ? `${fmtDest(cents)} ese día = ${fmtHome(toHome(cents, p.rate, cur.home.digits))}` : '';
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
  if (draft.currency === currencies().home.code) { // en la moneda de casa no se convierte: suma tal cual
    el.innerHTML = `<b>${fmtHome(cop)}</b> · sin conversión`;
    if (det) det.innerHTML = `Este gasto ya está en ${esc(currencies().home.code)}: suma directo al total, sin tasa de cambio.${n > 1 ? ` ${n} personas: ${fmtHome(each)} c/u` : ''}`;
    return;
  }
  el.innerHTML = `<b>${fmtMoney(draft.currency, cents)} ≈ ${fmtHome(cop)}</b>`;
  if (det) {
    const provisional = !r.estimated && (r.rate_date ?? draft.date) === todayStr(); // la tasa de hoy aún puede cambiar
    det.innerHTML = `${fmtRate(r.rate, draft.currency)}${r.estimated ? ` (tasa estimada${r.rate_date ? ` del ${esc(dayLabel(r.rate_date).toLowerCase())}` : ''})` : ` (${esc(dayLabel(draft.date).toLowerCase())})`}
    ${n > 1 ? ` · ${n} personas: ${fmtHome(each)} c/u` : ''}
    <div>Fuente: ${esc(r.local ? 'guardada en este teléfono' : rateSourceLabel(r.source))}${provisional ? ' · provisional hasta que cierre el día' : ''}</div>`;
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
    currency: draft.currency,
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
  const keepCurrency = draft.currency;
  const wasEdit = Boolean(draft.id);
  const c = ctx();
  store.saveExpense(exp).then((r) => { if (r?.errors?.length) toast(r.errors[0], 'error'); });
  toast(wasEdit ? 'Cambios guardados' : 'Gasto guardado');
  if (then === 'again' && !wasEdit) {
    draft = newDraft(c, keepDate);
    draft.currency = keepCurrency; // varios gastos seguidos en la misma moneda (los de un día en casa)
    convRate = null;
    render();
    document.getElementById('amount')?.focus();
    loadRate();
    autoHere();
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

function addBaseTiles(L, map) {
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

function viewMap() {
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
const stopMarkers = new Map(); // número de parada -> marcador de Leaflet

function focusStop(n) {
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
  const { places, path } = routeFrom(c.expenses, 3, currencies().dest.code);
  let focus = null; // el lugar del gasto que se pidió ver (desde el pin de la lista)
  el.innerHTML = '';
  const map = L.map(el, { zoomControl: false });
  leafletMap = map;
  L.control.zoom({ position: 'bottomright', zoomInTitle: 'Acercar', zoomOutTitle: 'Alejar' }).addTo(map);
  addLocateControl(L, map, (msg) => toast(msg, 'error'));
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
let lastMapSig = '';
let mapFocus = ''; // id del gasto cuyo lugar se abre al entrar al mapa
const mapSig = () => JSON.stringify([routeFrom(ctx().expenses, 3, currencies().dest.code), mapFocus]);

// --- Lugar del gasto: un solo diálogo con mapa, búsqueda y sugerencias (la lógica sin DOM está en picker.mjs) ---
//
// Toda acción fija un *ancla* (📍 Mi ubicación, un toque en el mapa o un resultado de búsqueda). Alrededor del ancla se arma la lista:
// "Este punto" (seleccionado por defecto), los lugares que ya usaste y los sitios cercanos. Tocar una fila la selecciona (el pin se
// mueve ahí) y "Usar este lugar" confirma. El mapa tiene alto fijo y la lista hace scroll debajo: nada salta al aparecer resultados.

const $pick = document.getElementById('map-pick');
const $pickOk = document.getElementById('pick-ok');
const $pickPanel = document.getElementById('pick-panel');
const $pickSel = document.getElementById('pick-sel');
const $pickQ = document.getElementById('pick-q');
const $pickHere = document.getElementById('pick-here');
const $pickHereT = document.getElementById('pick-here-t');
let pickMap = null;
let pickLeaflet = null;
let pickLayer = null; // marcadores numerados de los candidatos
let pickGps = null; // punto azul + círculo de precisión de tu ubicación
let pickPin = null; // el pin de lo elegido
let pickResize = null;
let geoRef = null; // última ubicación del dispositivo, si dio permiso
let searchTimer = null;

const pk = {
  target: null, anchor: null, known: [], nearby: [], items: [], selKey: 'point', typed: '',
  osm: 'done', more: 'idle', note: '', search: null, radiusM: 60, touched: false, locating: false,
  seq: 0, ctl: null, sseq: 0, sctl: null, locCtl: null,
  recent: [], // lugares usados hace poco (con los del mismo día primero), para elegirlos de un toque al abrir
  osmList: [], fsqList: [], // sitios cercanos de cada fuente; pk.nearby es la combinación (se recalcula al pintar)
  tab: 'near', // con una búsqueda activa: 'near' (Cerca del pin) o 'results' (Resultados); la búsqueda no se pierde al mover el pin
  farOpen: false, // el bloque "Más lejos" de los resultados está desplegado
  adjusted: new Map(), // llave de la fila -> { lat, lng } corregidos por el usuario (arrastró el pin o usó "Ajustar pin")
  moveMode: false, // mientras está activo, un toque en el mapa mueve el pin en vez de elegir un punto nuevo
};
let pickAdjustBtn = null;

const pickSel = () => pk.items.find((i) => i.key === pk.selKey) ?? null;
const skeleton = (n) => '<div class="sug-skel" aria-hidden="true"></div>'.repeat(n);

// Bloque "Buscar más lugares" (Foursquare): el botón, o el estado de la consulta.
function moreHtml(state, attr = 'data-more') {
  const btn = `<button type="button" class="btn secondary small more-btn" ${attr}>${icon('search')} Buscar más lugares</button>`;
  if (state === 'loading') return `<div class="pick-wait" role="status"><span class="spin" aria-hidden="true"></span>Buscando más lugares…</div>${skeleton(1)}`;
  if (state === 'off') return '<div class="sug-note">La búsqueda ampliada no está activada (falta la clave de Foursquare en el servidor).</div>';
  if (state === 'none') return '<div class="sug-note">No hay más lugares nuevos aquí.</div>';
  if (state === 'error') return `<div class="sug-note">No se pudo buscar más lugares. Revisa tu conexión.</div>${btn}`;
  if (state === 'done') return '<p class="muted sug-credit">Algunos sitios vienen de Foursquare.</p>';
  return btn;
}

// Una fila de la lista: número (el mismo del mapa), nombre, detalle, distancia y una marca si es la elegida.
function rowHtml(c, i, attr = 'data-i') {
  const sel = c.key === pk.selKey;
  const point = c.kind === 'point';
  const where = selectionSummary({ ...c, name: '' });
  const name = point ? 'Este punto' : (c.name || 'Sin nombre');
  const sub = point ? `${where.title} · ${where.sub}`
    : c.kind === 'known' ? `✓ Ya lo usaste · ${c.count} gasto${c.count === 1 ? '' : 's'}`
    : `${c.kind ? `${placeIcon(c.kind)} ` : ''}${c.detail || formatCoords(c.lat, c.lng)}${c.approx ? ' · posición aproximada' : ''}`;
  const badge = point ? `<span class="pk-ico" aria-hidden="true">${icon('mappin')}</span>`
    : `<span class="stop-n${c.kind === 'known' ? '' : ' last'}" aria-hidden="true">${c.n ?? '•'}</span>`;
  const km = !point && c.km != null ? `<span class="pick-km">${esc(formatDistance(c.km))}</span>` : '';
  return `<button type="button" class="pick-res${sel ? ' sel' : ''}${point ? '' : c.kind === 'known' ? ' known' : ' near'}" ${attr}="${i}" aria-pressed="${sel}">${badge}
    <span class="sug-txt"><b>${esc(name)}</b><span class="muted">${esc(sub)}</span></span>${km}<span class="pk-tick" aria-hidden="true">✓</span></button>`;
}

function idleHtml() {
  // Con lugares recientes se muestran primero (un toque y listo); la ayuda larga solo cuando todavía no hay ninguno.
  if (pk.recent.length) {
    const rows = pk.recent.map((r, i) => `<button type="button" class="pick-res known" data-r="${i}">
        <span class="pk-ico" aria-hidden="true">${icon('clock')}</span>
        <span class="sug-txt"><b>${esc(r.name || 'Sin nombre')}</b><span class="muted">${esc(`${r.today ? 'Ya hay un gasto de este día' : dayLabel(r.last)} · ${r.count} gasto${r.count === 1 ? '' : 's'}`)}</span></span><span class="pk-tick" aria-hidden="true">✓</span></button>`).join('');
    return `<section class="pk-sec known"><h3 class="sug-h">Lugares recientes</h3><div class="sug-list">${rows}</div></section>
      <p class="muted pk-tip">O toca el mapa, usa Mi ubicación o busca el nombre.</p>
      ${pk.note ? `<div class="sug-note">${esc(pk.note)}</div>` : ''}`;
  }
  return `<div class="pk-help"><p><b>¿Dónde fue el gasto?</b></p>
    <ul><li><span aria-hidden="true">${icon('crosshair')}</span><span>Toca <b>Mi ubicación</b> para usar tu GPS</span></li>
    <li><span aria-hidden="true">${icon('pointer')}</span><span>Toca el mapa donde fue la compra</span></li>
    <li><span aria-hidden="true">${icon('search')}</span><span>O busca el nombre de la tienda o del edificio</span></li></ul></div>
    ${pk.note ? `<div class="sug-note">${esc(pk.note)}</div>` : ''}`;
}

// Aviso sobre la posición: cómo corregirla si el pin no está donde debe, y qué hacer mientras está el modo mover.
function hintHtml() {
  const sel = pickSel();
  if (pk.moveMode) return '<div class="pk-hint move" role="status">Toca el mapa donde está el lugar de verdad, o arrastra el pin. Luego toca “Listo”.</div>';
  if (sel?.approx) return '<div class="pk-hint">La posición de este lugar es aproximada. Si el pin no está bien, arrástralo o toca “Ajustar pin” en el mapa.</div>';
  return '';
}

// Pestañas "Cerca del pin" / "Resultados": solo cuando hay una búsqueda y un pin. Los resultados siguen ahí aunque muevas el pin.
function tabsHtml() {
  if (!pk.search || !pk.anchor) return '';
  const n = searchList().all.length;
  const tab = (id, label) => `<button type="button" class="pk-tab${pk.tab === id ? ' on' : ''}" role="tab" aria-selected="${pk.tab === id}" data-tab="${id}">${label}</button>`;
  return `<div class="pk-tabs" role="tablist">${tab('near', 'Cerca del pin')}${tab('results', `Resultados${n ? ` (${n})` : ''}`)}
    <button type="button" class="linkbtn" data-clear-search aria-label="Quitar la búsqueda">✕</button></div>`;
}

function anchorHtml() {
  const [point, ...rest] = pk.items;
  const known = rest.filter((c) => c.kind === 'known');
  const near = rest.filter((c) => c.kind === 'near');
  const idx = (c) => pk.items.indexOf(c);
  const nameInput = point.key === pk.selKey
    ? `<div class="pk-name"><label for="pick-name" class="sr-only">Nombre del lugar (opcional)</label>
        <input id="pick-name" maxlength="120" autocomplete="off" placeholder="Nombre del lugar (opcional)" value="${esc(pk.typed)}"></div>` : '';
  const nearStatus = pk.osm === 'loading' ? `<div class="muted" role="status">${near.length ? 'Afinando resultados…' : 'Buscando sitios cerca…'}</div>${near.length ? '' : skeleton(2)}`
    : pk.osm === 'error' && !near.length ? '<div class="sug-note">No se pudieron cargar los sitios de OpenStreetMap. Revisa tu conexión.</div>'
    : !near.length && pk.more !== 'loading' ? '<div class="sug-note">No hay sitios con nombre aquí. Usa “Este punto” o busca el nombre.</div>' : '';
  return `${tabsHtml()}${hintHtml()}${rowHtml(point, 0)}${nameInput}
    ${known.length ? `<section class="pk-sec known"><h3 class="sug-h">Lugares que ya usaste <span>${known.length}</span></h3><div class="sug-list">${known.map((c) => rowHtml(c, idx(c))).join('')}</div></section>` : ''}
    <section class="pk-sec near"><h3 class="sug-h">Sitios cercanos${near.length ? ` <span>${near.length}</span>` : ''}</h3>
    <div class="sug-list">${near.map((c) => rowHtml(c, idx(c))).join('')}${nearStatus}</div>
    ${pk.osm === 'loading' ? '' : `<div class="sug-more">${moreHtml(pk.more)}</div>`}</section>
    ${pk.note ? `<div class="sug-note">${esc(pk.note)}</div>` : ''}`;
}

// Resultados de una búsqueda por nombre: Foursquare (ordenado por parecido) y OpenStreetMap juntos, lo cercano primero.
function searchList() {
  const s = pk.search;
  // El mismo lugar en las dos fuentes sale una vez, con la posición de OpenStreetMap (la de Foursquare es aproximada).
  const merged = preferOsm(s.fsq, s.osm);
  const found = dedupeByName([...merged.fsq, ...merged.osm]);
  // Se ordena por lo cercano al pin de ahora (no al de cuando se buscó): si lo mueves, el orden se adapta. Nada se oculta: lo lejano va aparte.
  const { near, far } = rankSearch(found, pk.anchor ? { lat: pk.anchor.lat, lng: pk.anchor.lng } : s.ref, { maxFar: 50 });
  return { near, far, all: [...near, ...far] };
}

function searchHtml() {
  const s = pk.search;
  const { near, far, all } = searchList();
  const row = (c) => {
    const badge = `<span class="pk-ico res" aria-hidden="true">${c.kind ? placeIcon(c.kind) : icon('mappin')}</span>`;
    const km = c.km != null ? `<span class="pick-km">${esc(formatDistance(c.km))}</span>` : '';
    return `<button type="button" class="pick-res res" data-s="${all.indexOf(c)}">${badge}
      <span class="sug-txt"><b>${esc(c.name)}</b><span class="muted">${esc(`${c.detail || formatCoords(c.lat, c.lng)}${c.approx ? ' · posición aproximada' : ''}`)}</span></span>${km}</button>`;
  };
  const busy = s.state === 'loading' || s.fsqState === 'loading';
  const status = busy && !all.length ? `<div class="muted" role="status">Buscando…</div>${skeleton(3)}`
    : !busy && !all.length ? `<div class="sug-note">${s.state === 'error' && s.fsqState !== 'done'
      ? 'No se pudo buscar. Revisa tu conexión.' : 'No se encontró. Prueba con el nombre completo (por ejemplo con “Edf.”) o toca el mapa donde fue.'}</div>` : '';
  const fsq = s.fsqState === 'idle' ? moreHtml('idle', 'data-more-search')
    : s.fsqState === 'noref' ? '<div class="sug-note">Mueve el mapa o usa Mi ubicación para buscar con más alcance.</div>'
    : moreHtml(s.fsqState, 'data-more-search');
  // Si el pin está lejos de donde se buscó, se ofrece repetir la búsqueda cerca del pin.
  const moved = pk.anchor && s.ref && distanceKm(pk.anchor, s.ref) > 1.5;
  const research = moved ? `<button type="button" class="btn secondary small more-btn" data-research>${icon('search')} Buscar “${esc(s.q)}” cerca del pin</button>` : '';
  return `${hintHtml()}${pk.anchor ? tabsHtml() : ''}<section class="pk-sec res">
    <h3 class="sug-h">Resultados de “${esc(s.q)}”${all.length ? ` <span>${all.length}</span>` : ''}</h3>
    <div class="sug-list" aria-busy="${busy}">${near.map(row).join('')}${status}</div>
    ${far.length ? `<details class="pk-far"${pk.farOpen ? ' open' : ''}><summary>Más lejos (${far.length})</summary><div class="sug-list">${far.map(row).join('')}</div></details>` : ''}
    <div class="sug-more">${research}${fsq}</div></section>`;
}

function paintPick() {
  pk.nearby = combineNearby({ known: pk.known, osm: pk.osmList, fsq: pk.fsqList });
  pk.items = buildList({ anchor: pk.anchor, known: pk.known, nearby: pk.nearby, typed: pk.typed, adjusted: pk.adjusted });
  if (!pk.items.some((i) => i.key === pk.selKey)) pk.selKey = 'point'; // lo elegido ya no está en la lista (llegó una fuente que lo reemplazó)
  const top = $pickPanel.scrollTop;
  // Con una búsqueda activa y un pin puesto hay dos pestañas: la búsqueda no se pierde al tocar el mapa o mover el pin.
  const mode = pk.search && (pk.tab === 'results' || !pk.anchor) ? 'search' : pk.anchor ? 'anchor' : 'idle';
  $pickPanel.innerHTML = mode === 'search' ? searchHtml() : mode === 'anchor' ? anchorHtml() : idleHtml();
  if ($pickPanel.dataset.mode === mode) $pickPanel.scrollTop = top; // el redibujo no manda la lista de vuelta al inicio
  $pickPanel.dataset.mode = mode;
  updatePickFoot();
}

function updatePickFoot() {
  const sel = pickSel();
  const { title, sub } = selectionSummary(sel);
  $pickSel.innerHTML = `<b>${esc(title)}</b><span class="muted">${esc(sub)}</span>`;
  $pickOk.disabled = !sel;
  updateAdjust();
}

// Botón del mapa "📌 Ajustar pin" (solo con algo elegido): activa el modo mover; "✓ Listo" lo apaga. Alternativa a arrastrar el pin, que en
// el celular queda tapado por el dedo.
function addAdjustControl(L, map) {
  const control = L.control({ position: 'bottomleft' });
  control.onAdd = () => {
    const bar = L.DomUtil.create('div', 'leaflet-bar adjust-ctl');
    const btn = L.DomUtil.create('a', '', bar);
    btn.href = '#';
    btn.setAttribute('role', 'button');
    L.DomEvent.disableClickPropagation(bar);
    L.DomEvent.on(btn, 'click', (ev) => {
      L.DomEvent.preventDefault(ev);
      pk.moveMode = !pk.moveMode;
      paintPick();
      drawPickMap(); // en modo mover los números del mapa dejan de ser tocables: un toque encima también mueve el pin
    });
    pickAdjustBtn = btn;
    return bar;
  };
  control.addTo(map);
  updateAdjust();
}

function updateAdjust() {
  if (!pickAdjustBtn) return;
  pickAdjustBtn.parentElement.hidden = !pickSel();
  pickAdjustBtn.innerHTML = pk.moveMode ? `${icon('check')} Listo` : `${icon('pin')} Ajustar pin`;
  pickAdjustBtn.setAttribute('aria-pressed', String(pk.moveMode));
  pickAdjustBtn.parentElement.classList.toggle('on', pk.moveMode);
  pickMap?.getContainer().classList.toggle('moving', pk.moveMode);
}

// El usuario corrigió la posición de lo elegido (arrastró el pin o tocó el mapa en modo mover): se conserva el nombre y cambian las coordenadas.
function setAdjusted(ll) {
  const sel = pickSel();
  if (!sel) return;
  pk.adjusted.set(sel.key, { lat: ll.lat, lng: ll.lng });
  paintPick();
  drawPickMap();
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
    L.marker([c.lat, c.lng], { icon, title: c.name || `Lugar ${c.n}`, alt: c.name || `Lugar ${c.n}`, interactive: !pk.moveMode, keyboard: !pk.moveMode })
      .on('click', () => selectPick(i)).addTo(pickLayer);
  });
  if (sel) {
    if (pickPin) pickPin.setLatLng([sel.lat, sel.lng]);
    else {
      pickPin = L.marker([sel.lat, sel.lng], { title: 'Lugar elegido (arrástralo para corregir la posición)', alt: 'Lugar elegido', keyboard: false, draggable: true })
        .on('dragend', (ev) => setAdjusted(ev.target.getLatLng())).addTo(pickMap);
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
  pk.moveMode = false;
  pk.tab = 'near'; // tocar un número del mapa muestra la fila elegida en "Cerca del pin"
  paintPick();
  drawPickMap();
  const ll = [c.lat, c.lng];
  if (pickMap && !pickMap.getBounds().pad(-0.12).contains(ll)) pickMap.panTo(ll);
}

// Fija el ancla y arma la lista: lugares usados al instante (sin red) y sitios cercanos de OpenStreetMap cuando lleguen.
// Caché de sitios cercanos por punto (10 min): volver a tocar casi el mismo lugar, o reabrir el diálogo, no repite las consultas ni gasta cupo.
const anchorCache = new Map();
const CACHE_MS = 10 * 60 * 1000;
const anchorRadius = (a) => (a.source === 'gps' ? 80 : pk.radiusM);
const anchorKey = (a) => `${a.lat.toFixed(4)},${a.lng.toFixed(4)}|${anchorRadius(a)}`;

function rememberAnchor() {
  const a = pk.anchor;
  if (a && pk.osm === 'done') anchorCache.set(anchorKey(a), { at: Date.now(), osm: pk.osmList, fsq: pk.fsqList, fsqDone: pk.more === 'done' || pk.more === 'none' });
}

// Fija el ancla y arma la lista: lugares usados al instante (sin red) y los sitios cercanos a medida que llegan. OpenStreetMap (Overpass y
// Photon) y Foursquare se piden a la vez y la lista se completa con lo que llegue primero; nada espera a que otra fuente termine.
function setAnchor(at, { source, accuracy = null, name = '', radiusM = 60, approx = false } = {}) {
  const radius = source === 'gps' ? 80 : radiusM;
  const hit = anchorCache.get(`${at.lat.toFixed(4)},${at.lng.toFixed(4)}|${radius}`);
  const cached = hit && Date.now() - hit.at < CACHE_MS ? hit : null;
  Object.assign(pk, {
    anchor: { lat: at.lat, lng: at.lng, source, accuracy, approx }, radiusM, typed: name, selKey: 'point', known: knownPlaces(ctx().expenses, at),
    osmList: cached?.osm ?? [], fsqList: cached?.fsq ?? [], more: cached?.fsqDone ? 'done' : 'idle', osm: cached ? 'done' : 'loading',
    note: '', tab: 'near', touched: false, adjusted: new Map(), moveMode: false,
  });
  pk.ctl?.abort();
  pk.ctl = new AbortController();
  const seq = (pk.seq += 1);
  pickMap?.getContainer().addEventListener('pointerdown', () => { pk.touched = true; }, { once: true });
  paintPick();
  drawPickMap();
  // Con tu ubicación o un resultado también se pide Foursquare solo (justo ahí suelen faltar edificios y negocios pequeños). Con un toque
  // suelto queda el botón, para no gastar el cupo gratis en cada toque.
  const auto = source === 'gps' || source === 'result' || source === 'coords';
  if (cached) { if (auto && !cached.fsqDone) loadMorePick(); return; }
  if (auto) loadMorePick();
  nearbyPlaces(at, {
    radiusM: radius, limit: 8, signal: pk.ctl.signal,
    onPartial: ({ results }) => { if (seq !== pk.seq || pk.osm !== 'loading') return; pk.osmList = results; paintPick(); drawPickMap(); }, // Photon llegó antes
  }).then(({ results }) => {
    if (seq !== pk.seq) return;
    pk.osmList = results;
    pk.osm = 'done';
    paintPick();
    drawPickMap();
    rememberAnchor();
  }).catch((err) => {
    if (err?.name === 'AbortError' || seq !== pk.seq) return;
    pk.osm = 'error';
    paintPick();
  });
}

// "Buscar más lugares" para el ancla: Foursquare (incluye edificios) alrededor del punto; lo nuevo se suma a la lista y al mapa.
async function loadMorePick() {
  const a = pk.anchor;
  if (!a || pk.more === 'loading') return;
  const seq = pk.seq;
  const set = (state) => { if (seq === pk.seq) { pk.more = state; paintPick(); drawPickMap(); rememberAnchor(); } };
  set('loading');
  try {
    const radius = a.source === 'gps' ? 150 : Math.max(40, pk.radiusM * 1.5);
    const { configured, results } = await store.fetchMorePlaces({ lat: a.lat, lng: a.lng, radius });
    if (!configured) return set('off');
    if (seq !== pk.seq) return;
    const before = combineNearby({ known: pk.known, osm: pk.osmList, fsq: [] }).length;
    pk.fsqList = results.map((r) => ({ ...r, km: distanceKm(a, r) }));
    set(combineNearby({ known: pk.known, osm: pk.osmList, fsq: pk.fsqList }).length > before ? 'done' : 'none');
  } catch { set('error'); }
}

function onMapTap(ll) {
  const z = pickMap.getZoom();
  // Muy alejado un toque no distingue una tienda de otra: se acerca al punto en vez de ignorarlo.
  if (z < PICK_MIN_ZOOM) pickMap.setView(ll, TAP_ZOOM);
  setAnchor(ll, { source: 'tap', radiusM: tapRadiusM(z < PICK_MIN_ZOOM ? TAP_ZOOM : z, ll.lat) });
}

// Botón 📍 Mi ubicación: lee el GPS (la mejor lectura en unos segundos), lo marca en el mapa y lo usa de ancla. Tocarlo otra vez cancela.
function setHere(text) {
  $pickHere.classList.toggle('locating', Boolean(text));
  $pickHere.setAttribute('aria-label', text ? 'Cancelar la búsqueda de tu ubicación' : 'Usar mi ubicación');
  $pickHereT.textContent = text ?? 'Mi ubicación';
}

async function pickLocate() {
  if (pk.locating) { pk.locCtl?.abort(); return; }
  if (!navigator.geolocation) { pk.note = 'Este dispositivo no permite obtener la ubicación.'; paintPick(); return; }
  pk.locating = true;
  pk.locCtl = new AbortController();
  pk.note = '';
  setHere('Buscando…');
  try {
    const fix = await readPosition({ maxMs: 6000, signal: pk.locCtl.signal, onProgress: (m) => setHere(`Buscando · ±${Math.max(5, Math.round(m))} m`) });
    if (!$pick.open || !pickMap) return;
    geoRef = { lat: fix.lat, lng: fix.lng };
    const L = pickLeaflet;
    const color = getComputedStyle(document.documentElement).getPropertyValue('--brand').trim() || '#0b6b4a';
    pickGps?.clearLayers();
    pickGps ??= L.layerGroup().addTo(pickMap);
    if (fix.accuracy) L.circle([fix.lat, fix.lng], { radius: fix.accuracy, color, weight: 1, fillOpacity: 0.1, interactive: false }).addTo(pickGps);
    L.circleMarker([fix.lat, fix.lng], { radius: 8, color: '#fff', weight: 3, fillColor: color, fillOpacity: 1, interactive: false }).addTo(pickGps);
    pickMap.setView([fix.lat, fix.lng], 18, { animate: false });
    setAnchor(fix, { source: 'gps', accuracy: fix.accuracy, radiusM: 80 });
  } catch (err) {
    if (err?.code === 0) return; // lo cancelaste tú
    pk.note = err?.code === 1 ? 'Sin permiso de ubicación. Actívalo en el navegador y vuelve a intentar.' : 'No se pudo obtener tu ubicación. Intenta de nuevo.';
    paintPick();
  } finally {
    pk.locating = false;
    setHere(null);
  }
}

async function openPicker() {
  if (!draft) return;
  const target = draft;
  for (const c of [pk.ctl, pk.sctl, pk.locCtl]) c?.abort();
  clearTimeout(searchTimer);
  Object.assign(pk, {
    target, anchor: null, known: [], nearby: [], items: [], selKey: 'point', typed: '', osm: 'done', more: 'idle', note: '',
    search: null, touched: false, locating: false, adjusted: new Map(), moveMode: false,
    recent: target.lat == null ? recentPlaces(ctx().expenses, { date: target.date, limit: 5 }) : [],
  });
  pk.seq += 1;
  pk.sseq += 1;
  $pickQ.value = '';
  setHere(null);
  paintPick();
  const box = document.getElementById('pick-map');
  box.innerHTML = '<div class="empty">Cargando mapa…</div>';
  $pick.showModal();
  try { pickLeaflet = await loadLeaflet(); } catch {
    box.innerHTML = '<div class="empty">No se pudo cargar el mapa. Puedes buscar el lugar por nombre.</div>';
    return;
  }
  if (!$pick.open || pk.target !== target) return;
  const L = pickLeaflet;
  box.innerHTML = '';
  pickResize?.disconnect();
  pickMap?.remove();
  pickPin = null;
  pickGps = null;
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
  } else if (geoRef) pickMap.setView([geoRef.lat, geoRef.lng], 16);
  else if (last) pickMap.setView([Number(last.lat), Number(last.lng)], 15);
  else pickMap.setView([20, 0], 2);
  addAdjustControl(L, pickMap);
  // En modo mover un toque corrige la posición de lo elegido; si no, elige un punto nuevo.
  pickMap.on('click', (ev) => { if (pk.moveMode && pickSel()) setAdjusted(ev.latlng); else onMapTap(ev.latlng); });
  requestAnimationFrame(() => pickMap?.invalidateSize());
}

// --- búsqueda por nombre ---

// Punto de referencia para ordenar los resultados: el ancla, o lo que se ve en el mapa, o tu ubicación, o el último gasto.
function pickSearchRef() {
  if (pk.anchor) return { lat: pk.anchor.lat, lng: pk.anchor.lng };
  const c = pickMap?.getCenter();
  if (c && pickMap.getZoom() >= 8) return { lat: c.lat, lng: c.lng };
  if (geoRef) return { ...geoRef };
  const last = ctx().expenses.find(hasLocation);
  return last ? { lat: Number(last.lat), lng: Number(last.lng) } : null;
}

// Foursquare por nombre, alrededor de la referencia. Solo al enviar la búsqueda o con el botón (no en cada letra: cuida el cupo gratis).
async function searchFsq() {
  const s = pk.search;
  if (!s || s.fsqState === 'loading') return;
  if (!s.ref) { s.fsqState = 'noref'; paintPick(); return; }
  const seq = pk.sseq;
  const key = `fsq|${searchKey(s.q, s.ref)}`;
  const hit = searchCache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) { s.fsq = hit.results; s.fsqState = 'done'; paintPick(); return; }
  s.fsqState = 'loading';
  paintPick();
  try {
    const { configured, results } = await store.fetchMorePlaces({ lat: s.ref.lat, lng: s.ref.lng, q: s.q, radius: 5000 });
    if (seq !== pk.sseq) return;
    s.fsq = results;
    s.fsqState = configured ? 'done' : 'off';
    if (configured) searchCache.set(key, { at: Date.now(), results });
  } catch {
    if (seq !== pk.sseq) return;
    s.fsqState = 'error';
  }
  paintPick();
}

// Caché de búsquedas por nombre (10 min): repetir una búsqueda, o volver a la misma desde otro pin cercano, no vuelve a pedir nada.
const searchCache = new Map();
const searchKey = (q, ref) => `${q.toLowerCase()}|${ref ? `${ref.lat.toFixed(2)},${ref.lng.toFixed(2)}` : 'sin-ref'}`;

// Mientras escribes solo se busca con 3 letras o más (menos peticiones); al enviar basta con 2.
function runPickSearch(q, { auto = false } = {}) {
  const text = q.trim();
  pk.sctl?.abort();
  // Coordenadas o enlace de Google Maps: no es una búsqueda, es el punto exacto. Solo al enviar o pegar (no a medio escribir).
  const pasted = parseCoordinates(text);
  if (pasted) {
    if (auto) { pk.search = null; chooseCoords(pasted); }
    return;
  }
  if (text.length < 2) { pk.search = null; pk.tab = 'near'; paintPick(); return; }
  if (!auto && text.length < 3) return;
  const ref = pickSearchRef();
  const seq = (pk.sseq += 1);
  pk.sctl = new AbortController();
  const s = { q: text, ref, osm: [], fsq: [], state: 'loading', fsqState: 'idle' };
  pk.search = s;
  pk.tab = 'results';
  pk.farOpen = false;
  const hit = searchCache.get(searchKey(text, ref));
  if (hit && Date.now() - hit.at < CACHE_MS) {
    s.osm = hit.results;
    s.state = 'done';
  } else {
    searchPlaces(text, { ref, signal: pk.sctl.signal }).then(({ results }) => {
      if (seq !== pk.sseq) return;
      s.osm = results;
      s.state = 'done';
      searchCache.set(searchKey(text, ref), { at: Date.now(), results });
      paintPick();
    }).catch((err) => {
      if (err?.name === 'AbortError' || seq !== pk.sseq) return;
      s.state = 'error';
      paintPick();
    });
  }
  paintPick();
  if (auto) searchFsq(); // al enviar la búsqueda siempre se completa con Foursquare: OpenStreetMap suele traer sitios de otras ciudades
}

// Elegir un lugar reciente: el mapa va ahí y queda como "Este punto" con su nombre y sus coordenadas exactas (listo para confirmar).
function pickRecent(r) {
  if (!r) return;
  if (pickMap) pickMap.setView([r.lat, r.lng], Math.max(pickMap.getZoom(), TAP_ZOOM), { animate: false });
  setAnchor({ lat: r.lat, lng: r.lng }, { source: 'recent', name: r.name });
}

// Elegir un resultado: el mapa va ahí, ese punto pasa a ser el ancla y el nombre del resultado queda como nombre del lugar.
function chooseResult(c) {
  // La búsqueda se conserva (pestaña "Resultados"): si el lugar elegido no era el correcto, se vuelve a ella sin escribir de nuevo.
  const at = { lat: c.lat, lng: c.lng };
  if (pickMap) pickMap.setView([at.lat, at.lng], Math.max(pickMap.getZoom(), TAP_ZOOM), { animate: false });
  setAnchor(at, { source: 'result', name: c.name.slice(0, 120), approx: Boolean(c.approx) });
}

// Punto pegado desde Google Maps: igual que un resultado (el mapa va ahí y se piden los sitios cercanos), con el nombre del enlace si traía.
function chooseCoords(c) {
  if (pickMap) pickMap.setView([c.lat, c.lng], Math.max(pickMap.getZoom(), TAP_ZOOM), { animate: false });
  setAnchor({ lat: c.lat, lng: c.lng }, { source: 'coords', name: (c.name ?? '').slice(0, 120) });
}

$pickQ.addEventListener('paste', (ev) => {
  if (parseCoordinates(ev.clipboardData?.getData('text'))) setTimeout(() => { clearTimeout(searchTimer); runPickSearch($pickQ.value, { auto: true }); }, 0);
});

document.getElementById('pick-search').addEventListener('submit', (ev) => {
  ev.preventDefault();
  clearTimeout(searchTimer);
  runPickSearch($pickQ.value, { auto: true });
});
$pickQ.addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => runPickSearch($pickQ.value), 400);
});
$pickHere.addEventListener('click', pickLocate);

$pickPanel.addEventListener('click', (ev) => {
  const t = ev.target;
  if (t.closest('[data-more]')) return loadMorePick();
  if (t.closest('[data-more-search]')) return searchFsq();
  if (t.closest('[data-clear-search]')) { pk.search = null; pk.tab = 'near'; pk.sctl?.abort(); $pickQ.value = ''; paintPick(); return; }
  const tab = t.closest('[data-tab]');
  if (tab) { pk.tab = tab.dataset.tab; paintPick(); return; }
  if (t.closest('[data-research]')) { runPickSearch(pk.search?.q ?? '', { auto: true }); return; }
  const s = t.closest('[data-s]');
  if (s) { const c = searchList().all[Number(s.dataset.s)]; if (c) chooseResult(c); return; }
  const rc = t.closest('[data-r]');
  if (rc) { pickRecent(pk.recent[Number(rc.dataset.r)]); return; }
  const r = t.closest('[data-i]');
  if (r) selectPick(Number(r.dataset.i));
});
$pickPanel.addEventListener('toggle', (ev) => { if (ev.target.classList?.contains('pk-far')) pk.farOpen = ev.target.open; }, true);
$pickPanel.addEventListener('input', (ev) => {
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
$pick.addEventListener('click', (ev) => {
  if (ev.target === $pick || ev.target.closest('[data-pick-cancel]')) $pick.close();
});
$pick.addEventListener('close', () => {
  for (const c of [pk.ctl, pk.sctl, pk.locCtl]) c?.abort();
  pk.seq += 1;
  pk.sseq += 1;
  clearTimeout(searchTimer);
  pickResize?.disconnect();
  pickMap?.remove();
  pickMap = null;
  pickLayer = null;
  pickGps = null;
  pickPin = null;
  pickAdjustBtn = null;
  pk.target = null;
  pk.moveMode = false;
});

function viewLogin() {
  return `<form id="login" class="login card"><h2>Código de acceso</h2>
    <p class="muted">Esta app está protegida. Escribe el código para entrar.</p>
    <input id="code" type="password" aria-label="Código de acceso" autocomplete="current-password" placeholder="Código" required>
    <button class="btn" type="submit">Entrar</button></form>`;
}

function downloadCsv() {
  const c = ctx();
  const cur = currencies();
  const rows = [['Fecha', 'Descripción', 'Medio de pago', 'Pagó', 'Para', 'Monto', 'Moneda', 'Tasa', 'Fecha de la tasa', 'Fuente de la tasa', cur.home.code, 'Aproximado', 'Lat', 'Lng', 'Lugar']];
  for (const e of [...c.expenses].sort(compareChronological)) {
    const m = c.methodsById[e.payment_method_id];
    rows.push([e.date, e.description, e.payment_method_id == null ? 'Por definir' : methodLabel(m), m ? personName(c, m.owner_person_id) : '',
      e.beneficiary_ids.map((id) => personName(c, id)).join(' + '),
      (e.amount_cents / 100).toFixed(2), e.currency ?? cur.dest.code, e.rate ?? '', e.rate == null ? '' : e.rate_date ?? e.date, e.rate == null ? '' : rateSourceLabel(e.rate_source), e.amount_home == null ? '' : (e.amount_home / 100).toFixed(cur.home.digits),
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
function applyUpdate() {
  if (formActive()) {
    updatePending = true;
    toast('Hay una versión nueva. Se aplicará al terminar este gasto.');
    return;
  }
  location.reload();
}

function render() {
  if (updatePending && !formActive()) { updatePending = false; location.reload(); return; }
  updateStatus();
  $tripBtn.hidden = store.net.needsLogin;
  if (store.net.needsLogin) {
    $title.textContent = 'Gastos de viaje';
    $view.innerHTML = viewLogin();
    return;
  }
  const trip = store.activeTrip();
  $tripBtn.innerHTML = `${icon('plane')} ${esc(trip.name)} · ${esc(trip.dest)}→${esc(trip.home)} ${icon('chevron', 'trip-ch')}`;
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
  if (r.tab === 'ajustes' && !r.map) showAppVersion();
  if (r.tab === 'home') homeChart();
  if (isFormRoute() && draft) { updateConv(); centerPicked(); }
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
  else if (action === 'cur') { if (draft.currency !== id) { draft.currency = id; paintCur(); } }
  else if (action === 'date-q') setDraftDate(id === 'yesterday' ? addDays(todayStr(), -1) : todayStr());
  else if (action === 'date-open') openDatePicker({ value: draft.date, onPick: setDraftDate });
  else if (action === 'benes-open') { draft.benesOpen = true; paintBenes(); }
  else if (action === 'card-go') {
    const box = document.getElementById('cards');
    const el = box?.querySelectorAll('.pitem')[Number(t.dataset.i)];
    if (el) box.scrollTo({ left: el.offsetLeft - (box.clientWidth - el.offsetWidth) / 2, behavior: 'smooth' });
  }
  else if (action === 'here') suggestHere();
  else if (action === 'here-cancel') { hereCtl?.abort(); draft.here = null; paintLoc(); }
  else if (action === 'here-use') useHere(Number(t.dataset.i));
  else if (action === 'here-point') useHerePoint();
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
  } else if (action === 'pick-map') openPicker();
  else if (action === 'use-recent') {
    const r = draft?.recentList?.[Number(t.dataset.i)];
    if (r) { draft.lat = r.lat; draft.lng = r.lng; if (r.name) draft.place = r.name; paintLoc(); }
  }
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
  if (commit && !sameOrder(ids, st.ids)) store.saveOrder(newestFirst(ids),`${store.activeTrip().id}:${st.card.dataset.day}`);
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
  store.saveOrder(newestFirst(ids),`${store.activeTrip().id}:${card.dataset.day}`);
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

let dotsRaf = 0;
$view.addEventListener('scroll', (ev) => { // el evento scroll no sube: se escucha en la fase de captura
  if (ev.target.id !== 'cards' || dotsRaf) return;
  dotsRaf = requestAnimationFrame(() => { dotsRaf = 0; paintCardDots(); });
}, true);

$view.addEventListener('input', (ev) => {
  const id = ev.target.id;
  if (id === 'amount') { draft.amountText = ev.target.value; updateConv(); }
  else if (id === 'desc') draft.desc = ev.target.value;
  else if (id === 'f-q') { filters.q = ev.target.value; const pos = ev.target.selectionStart; render(); const el = document.getElementById('f-q'); el.focus(); el.setSelectionRange(pos, pos); }
  else if (id.startsWith('m-')) onMethodForm(id);
});

$view.addEventListener('change', (ev) => {
  const id = ev.target.id;
  if (id === 'restore-file') {
    const file = ev.target.files?.[0];
    ev.target.value = ''; // permite elegir otra vez el mismo archivo
    restoreFromFile(file);
  } else if (id === 'cur-other') {
    if (ev.target.value && currencyByCode(ev.target.value)) { draft.currency = ev.target.value; paintCur(); }
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
  const hadController = Boolean(navigator.serviceWorker.controller); // la primera instalación no recarga; una actualización sí
  navigator.serviceWorker.addEventListener('controllerchange', () => { if (hadController) applyUpdate(); });
  navigator.serviceWorker.register('/sw.js').then((reg) => {
    // El navegador solo busca un service worker nuevo al abrir la app; también se busca al volver a ella y cada 30 minutos.
    const check = () => reg.update().catch(() => {});
    document.addEventListener('visibilitychange', () => { if (!document.hidden) check(); });
    setInterval(check, 30 * 60 * 1000);
  }).catch(() => {});
}

initSelects(); // menús desplegables con el estilo de la app
render(); // primero lo guardado en el teléfono; si el servidor trae algo distinto, refresh() avisa y se redibuja
sync();
