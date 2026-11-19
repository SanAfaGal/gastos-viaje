// Formulario de gasto: monto, moneda, fecha, medio de pago, para quién, descripción y lugar.
import { splitEqual } from './settlement.mjs';
import { addDays, currencies, fmtHome, fmtMoney, fmtRate, parseAmount, toHome, todayStr } from './money.mjs';
import { CURRENCIES, currencyByCode } from './currencies.mjs';
import { formatCoords, hasLocation } from './places.mjs';
import { PENDING } from './filters.mjs';
import * as store from './store.js';
import { icon } from './icons.mjs';
import { recentPlaces } from './nearby.mjs';
import { $view, esc, infoBtn, infoDialog, toast } from './ui.js';
import { PENDING_METHOD, cardHtml, ctx, dayLabel, initials, needsSetup, personName, rateSourceLabel, setupCard, shortDate } from './shared.js';
import { chartGeo, chartIdx, paintReadout, renderChart } from './view-home.js';
import { warmLocation } from './place-picker.js';
import { render } from './router.js';

// Deja la tarjeta elegida centrada en el carrusel sin mover la página.
export function centerPicked() {
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
// --- formulario de gasto ---

export let draft = null;
export function setDraft(value) { draft = value; return value; }
let convRate = null; // { rate, estimated, rate_date, source, local } para la fecha del formulario
export function setConvRate(value) { convRate = value; return value; }
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
    // Varios gastos en el mismo lugar con distinto medio de pago: se elige una vez y después basta un toque. Los lugares donde ya hubo un
    // gasto de este mismo día salen primero.
    draft.recentList = recentPlaces(ctx().expenses, { date: draft.date, limit: 3 });
    const chips = draft.recentList.map((r, i) => `<button type="button" class="chip loc-chip" data-action="use-recent" data-i="${i}"
        aria-label="Usar el lugar ${esc(r.name || 'sin nombre')}${r.today ? ', donde ya hay un gasto de este día' : ''}">${icon('mappin')} <span class="loc-chip-t">${esc(r.name || 'Sin nombre')}</span>${r.today ? ' <span class="loc-chip-s">este día</span>' : ''}</button>`).join('');
    return `<div class="loc-box empty">
      <button type="button" class="btn secondary loc-pick" data-action="pick-map">${icon('map')} Elegir lugar</button>
      ${chips ? `<div class="loc-recent"><span class="muted">O usa un lugar reciente</span><div class="loc-chips">${chips}</div></div>` : ''}</div>`;
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
export function paintLoc() {
  const el = document.getElementById('loc');
  if (el && draft) el.innerHTML = locHtml();
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
export function paintCards() {
  clearFieldError('method');
  const c = ctx();
  const box = document.getElementById('cards');
  if (!box || !draft) return;
  box.innerHTML = cardsHtml(c);
  box.scrollLeft = 0;
  paintCardDots();
  const f = document.getElementById('owner-f');
  if (f) f.outerHTML = ownerFilterHtml(c);
}
export function viewForm(editId) {
  const c = ctx();
  if (!editId) warmLocation(); // gasto nuevo: se lee dónde estás mientras lo llenas
  if (needsSetup(c)) return setupCard();
  if (!draft || (editId ? draft.id !== editId : draft.id)) {
    draft = editId ? draftFrom(c, editId) : newDraft(c);
    if (!draft) { location.hash = '#/gastos'; return ''; }
    convRate = null;
    loadRate();
  }
  return `
    <form id="exp-form" class="xform" autocomplete="off" novalidate>
      <section class="amount-hero" aria-label="Monto">
        <div class="hero-top">
          <label for="amount" id="amount-l">${amountLabel()}</label>
          <span class="lab-tools"><button type="button" class="switch ${draft.approx ? 'on' : ''}" role="switch" aria-checked="${draft.approx}" data-action="approx"><span class="track" aria-hidden="true"></span>Aproximado</button>
            ${infoBtn('approx', 'Monto aproximado')}</span>
        </div>
        <input id="amount" class="amount" inputmode="decimal" enterkeyhint="done" placeholder="0,00" value="${esc(draft.amountText)}" aria-describedby="err-amount">
        <p class="ferr" id="err-amount" role="alert" hidden></p>
        <div class="chips cur-chips" id="cur" role="radiogroup" aria-label="Moneda del gasto">${curHtml()}</div>
        <div class="conv-row"><div class="conv" id="conv"></div>${infoBtn('rate', 'Tasa de cambio e historial')}</div>
      </section>

      <section class="fcard frow" aria-labelledby="when-l">
        <span class="flab" id="when-l">Cuándo</span>
        <div class="chips date-chips" id="dates" role="group" aria-labelledby="when-l">${dateHtml()}</div>
      </section>

      <section class="fcard" aria-labelledby="cards-l">
        <div class="lab-row"><span class="flab" id="cards-l">Pagado con</span>${infoBtn('pay', 'Pagado con')}</div>
        ${ownerFilterHtml(c)}
        <div class="cards" id="cards" role="radiogroup" aria-labelledby="cards-l" aria-describedby="err-method">${cardsHtml(c)}</div>
        <div class="cards-dots" id="cards-dots" role="group" aria-label="Medios de pago disponibles"></div>
        <p class="ferr" id="err-method" role="alert" hidden></p>
      </section>

      <section class="fcard" aria-labelledby="benes-l">
        <div class="lab-row"><span class="flab" id="benes-l">¿Para quién es?</span>${infoBtn('who', 'Para quién es')}</div>
        <div id="benes" role="group" aria-labelledby="benes-l" aria-describedby="err-benes">${benesHtml(c)}</div>
        <p class="ferr" id="err-benes" role="alert" hidden></p>
      </section>

      <section class="fcard" aria-label="Detalles del gasto">
        <div class="fsub">
          <label class="flab" for="desc">Descripción <span class="opt">(opcional)</span></label>
          <input id="desc" maxlength="120" placeholder="Almuerzo, Uber, entradas…" value="${esc(draft.desc)}">
        </div>
        <div class="fsub">
          <div class="lab-row"><span class="flab" id="where-l">Dónde <span class="opt">(opcional)</span></span>${infoBtn('loc', 'Ubicación')}</div>
          <div id="loc" class="loc" role="group" aria-labelledby="where-l">${locHtml()}</div>
        </div>
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
      ${infoDialog('loc', 'Ubicación', 'Opcional. Sirve para ver en el mapa dónde gastaste. Va al final del formulario para que, mientras llenas lo demás, el celular ya vaya ubicándote y al elegir el lugar tu punto aparezca de una vez.')}
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
export function setDraftDate(date) {
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
export function paintBenes() {
  clearFieldError('benes');
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
export function paintCur() {
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
export function updateConv(loaded = false) {
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
// Error de un campo del formulario: el mensaje sale junto al campo (y lo anuncia el lector de pantalla), el campo se marca como inválido y el foco
// va a él. Se limpia solo en cuanto el valor cambia (clearFieldError). `target` es el control que recibe el foco.
const FIELD_ERRORS = { amount: ['amount', '#amount'], method: ['cards', '#cards .pitem.on, #cards .pitem[data-action]'], benes: ['benes', '#benes button'] };
function fieldError(field, message) {
  const [boxId, focusSel] = FIELD_ERRORS[field];
  const msg = document.getElementById(`err-${field}`);
  if (msg) { msg.textContent = message; msg.hidden = false; }
  document.getElementById(boxId)?.setAttribute('aria-invalid', 'true');
  const target = document.querySelector(focusSel);
  target?.focus();
  target?.scrollIntoView?.({ block: 'center', behavior: 'smooth' });
}
export function clearFieldError(field) {
  const [boxId] = FIELD_ERRORS[field];
  const msg = document.getElementById(`err-${field}`);
  if (msg) { msg.textContent = ''; msg.hidden = true; }
  document.getElementById(boxId)?.removeAttribute('aria-invalid');
}
export async function submitForm(then) {
  if (!draft) return;
  for (const f of Object.keys(FIELD_ERRORS)) clearFieldError(f);
  const cents = parseAmount(draft.amountText);
  // Se avisan todos los que falten (no solo el primero) y el foco va al primero.
  const missing = [];
  if (!cents) missing.push(['amount', 'Escribe un monto válido.']);
  if (!draft.method) missing.push(['method', 'Elige con qué se pagó, o “Por definir” si no lo sabes.']);
  if (!draft.benes.size) missing.push(['benes', 'Elige para quién es el gasto.']);
  if (missing.length) {
    for (const [f, m] of [...missing].reverse()) fieldError(f, m); // el foco queda en el primero
    return;
  }
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
  } else {
    draft = null;
    location.hash = '#/gastos';
  }
}
let dotsRaf = 0;

export function initForm() {
$view.addEventListener('scroll', (ev) => { // el evento scroll no sube: se escucha en la fase de captura
    if (ev.target.id !== 'cards' || dotsRaf) return;
    dotsRaf = requestAnimationFrame(() => { dotsRaf = 0; paintCardDots(); });
  }, true);
}
