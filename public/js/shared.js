// Datos derivados y piezas de pantalla que usan varias pantallas: contexto del viaje activo, medios de pago, cuentas, estado de cada gasto y su fila.
import { computeSettlement } from './settlement.mjs';
import { addDays, currencies, fmtHome, fmtMoney, todayStr } from './money.mjs';
import { DEFAULT_COLOR, KIND_COLOR, NETWORK_MARK, cardPaint, isHexColor, suggestColor } from './cards.mjs';
import { hasLocation } from './places.mjs';
import { PENDING } from './filters.mjs';
import * as store from './store.js';
import { icon } from './icons.mjs';
import { esc } from './ui.js';

// ---------- datos derivados ----------

export function ctx() {
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
    payments: state.payments ?? [],
  };
}
export const personName = (c, id) => c.peopleById[id]?.name ?? '¿?';
// "Por definir": se sabe que se debe el gasto pero no con qué se pagó. No es un medio real: en el servidor
// el gasto queda con payment_method_id = null y fuera de las cuentas.
export const PENDING_METHOD = { id: PENDING, kind: 'pending', name: 'Por definir' };
export function methodLabel(m) {
  if (!m) return 'Medio borrado';
  if (m.kind === 'pending') return 'Medio por definir';
  if (m.kind === 'card') return `${m.name}${m.last4 ? ` ••${m.last4}` : ''} · ${m.card_type === 'credit' ? 'Crédito' : 'Débito'}`;
  // 'pix' es el código interno guardado en la base (de la primera versión); en pantalla se llama Transferencia
  return `${m.name} · ${m.kind === 'pix' ? 'Transferencia' : 'Efectivo'}`;
}
// Color de la tarjeta: el elegido, si no el sugerido por el banco, si no el del tipo de medio.
export const cardColor = (m) => (isHexColor(m.color) ? m.color : suggestColor(m.name) ?? KIND_COLOR[m.kind] ?? DEFAULT_COLOR);
// Tarjeta dibujada (estilizada). Con pick=true es un botón del carrusel "Pagado con".
const ICONS = {
  cash: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="2" y="6" width="20" height="12" rx="2"/><circle cx="12" cy="12" r="3"/><path d="M6 9v.01M18 15v.01"/></svg>',
  pix: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 7h13M16 3l4 4-4 4M17 17H4M8 13l-4 4 4 4"/></svg>',
  pending: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.7.4-1 .9-1 1.7M12 17v.01"/></svg>',
};
// Una tarjeta real solo para kind 'card' (banco, red, chip y número). Efectivo y transferencia no son
// tarjetas: se dibujan como una ficha plana, sin chip ni número. Los datos del dueño y el tipo van
// en un pie debajo, para no amontonar la tarjeta. Con pick=true es un botón del carrusel "Pagado con".
export function cardHtml(m, { owner = '', pick = false, on = false } = {}) {
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
export function settlementOf(c) {
  const input = c.expenses.map((e) => ({
    amount_home: e.amount_home,
    payer_id: c.methodsById[e.payment_method_id]?.owner_person_id,
    beneficiary_ids: e.beneficiary_ids,
  })).filter((e) => e.payer_id);
  const unit = 10 ** (2 - currencies().home.digits);
  const paid = c.payments.map((x) => ({ from: x.from_person_id, to: x.to_person_id, amount_home: x.amount_home }));
  return computeSettlement(input, c.people.map((p) => p.id), unit, paid);
}
function forWho(c, e) {
  const ids = e.beneficiary_ids;
  if (ids.length === 1) return `Solo ${personName(c, ids[0])}`;
  if (ids.length === c.people.length) return 'Todos';
  return `${ids.length} personas`;
}
export function dayLabel(date) {
  const t = todayStr();
  if (date === t) return 'Hoy';
  if (date === addDays(t, -1)) return 'Ayer';
  if (date === addDays(t, -2)) return 'Antier';
  return new Date(`${date}T12:00:00`).toLocaleDateString('es-CO', { weekday: 'long', day: 'numeric', month: 'long' });
}
export const needsSetup = (c) => !c.people.length || !c.payMethods.length;
export const setupCard = () => {
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
export const initials = (name) => String(name ?? '').trim().split(/\s+/).filter(Boolean).slice(0, 2).map((w) => [...w][0].toUpperCase()).join('') || '?';
const METHOD_ICON = { card: 'card', pix: 'transfer', cash: 'banknote' };
// `n`: posición del gasto dentro de su día (solo en la lista, cuando el día tiene varios gastos).
export function expenseItem(c, e, n) {
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
export function legendHtml() {
  const row = (k) => { const [tone, ic, label] = STATUS[k]; const [t, rest] = label.split(': '); return `<li><span class="bd ${tone}" aria-hidden="true">${ic ? icon(ic) : '≈'}</span><span><b>${esc(t)}</b>${rest ? `<span class="muted">${esc(rest)}</span>` : ''}</span></li>`; };
  return `<ul class="legend">${['nomethod', 'rate', 'estimated', 'approx', 'unsent'].map(row).join('')}
    <li><span class="bd pinb" aria-hidden="true">${icon('mappin')}</span><span><b>Tiene ubicación</b><span class="muted">Tócalo para verlo en el mapa</span></span></li>
    <li><span class="avs sm" aria-hidden="true"><span class="av" style="background:var(--seg-1)">S</span><span class="av" style="background:var(--seg-2)">A</span></span><span><b>Para quién es</b><span class="muted">Un círculo con la inicial de cada persona</span></span></li></ul>`;
}
// Fuente de una tasa, como se muestra. Vacía = se guardó antes de que la app registrara la fuente.
const RATE_SOURCES = { fawazahmed0: 'fawazahmed0/currency-api', frankfurter: 'Frankfurter' };
export const rateSourceLabel = (source) => RATE_SOURCES[source] ?? (source || 'No registrada');
export const shortDate = (d) => new Date(`${d}T12:00:00`).toLocaleDateString('es-CO', { day: 'numeric', month: 'short' });
