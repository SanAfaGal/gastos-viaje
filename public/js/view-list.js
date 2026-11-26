// Pantalla de gastos: listado por día con filtros y reordenamiento arrastrando.
import { currencies, dayRate, fmtDest, fmtHome, fmtRate } from './money.mjs';
import { hasLocation } from './places.mjs';
import { newestFirst, sameOrder } from './order.mjs';
import { PENDING, activeCount as countFilters, applyFilters, filtersOff, isFiltered, keepValid } from './filters.mjs';
import * as store from './store.js';
import { icon } from './icons.mjs';
import { $view, announce, esc, infoBtn, infoDialog } from './ui.js';
import { ctx, dayLabel, expenseItem, legendHtml, methodLabel, needsSetup, personName, setupCard } from './shared.js';
import { render } from './router.js';

export const filters = filtersOff();
export const resetFilters = () => Object.assign(filters, filtersOff());
export const picked = (select) => [...select.selectedOptions].map((o) => o.value); // opciones marcadas de un filtro múltiple
export let filtersOpen = false; // panel de filtros plegado por defecto: casi no se usa
export function setFiltersOpen(value) { filtersOpen = value; return value; }
const MAP_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 21s-6.5-5.6-6.5-11a6.5 6.5 0 0 1 13 0c0 5.4-6.5 11-6.5 11Z"/><circle cx="12" cy="10" r="2.3"/></svg>';
// Tasa del día bajo la fecha. "≈" si todavía es estimada.
const dayRateHtml = (r) => (r ? `<span class="day-rate${r.estimated ? ' est' : ''}"${r.estimated ? ' title="Tasa estimada: puede cambiar un poco"' : ''}>${r.estimated ? '≈ ' : ''}${esc(fmtRate(r.rate))}</span>` : '');
export function viewList() {
  const c = ctx();
  if (needsSetup(c)) return setupCard();
  const dayList = [...new Set(c.expenses.map((e) => e.date))]; // días con gastos, del más nuevo al más viejo
  filters.day = keepValid(filters.day, dayList);
  const list = applyFilters(c.expenses, filters, { methodsById: c.methodsById, hasLocation });
  const approxCount = c.expenses.filter((e) => e.amount_approx).length;
  const nolocCount = c.expenses.filter((e) => !hasLocation(e)).length;
  const rateCount = c.expenses.filter((e) => e.amount_home == null || e.rate_estimated).length;
  const owners = [...new Set(c.expenses.map((e) => c.methodsById[e.payment_method_id]?.owner_person_id).filter(Boolean))];
  const filtered = isFiltered(filters);
  const activeCount = countFilters(filters); // la búsqueda se ve aparte
  const sel = (k, v) => (filters[k].includes(v) ? 'selected' : '');
  // Medios de pago agrupados por dueño: así dos "Transferencia" de dueños distintos no se confunden.
  const methodGroups = c.people.map((p) => ({ owner: p, methods: c.payMethods.filter((m) => m.owner_person_id === p.id) })).filter((g) => g.methods.length);
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
      <select id="f-day" multiple data-all="Todos los días" aria-label="Día">
        ${dayList.map((d) => `<option value="${esc(d)}" ${sel('day', d)}>${esc(dayLabel(d))} (${c.expenses.filter((e) => e.date === d).length})</option>`).join('')}</select>
      <select id="f-method" multiple data-all="Todos los medios" aria-label="Medio de pago">
        ${c.expenses.some((e) => e.payment_method_id == null) ? `<option value="${PENDING}" ${sel('method', PENDING)}>Por definir</option>` : ''}
        ${methodGroups.map((g) => `<optgroup label="${esc(g.owner.name)}">${g.methods.map((m) => `<option value="${esc(m.id)}" data-btn="${esc(`${methodLabel(m)} · de ${g.owner.name}`)}" ${sel('method', m.id)}>${esc(methodLabel(m))}</option>`).join('')}</optgroup>`).join('')}</select>
      <select id="f-person" multiple data-all="Para cualquiera" aria-label="Para quién">
        ${c.people.map((p) => `<option value="${esc(p.id)}" ${sel('person', p.id)}>${esc(personName(c, p.id))}</option>`).join('')}</select>
      ${owners.length > 1 ? `<select id="f-payer" multiple data-all="Pagó cualquiera" aria-label="Quién pagó">
        ${owners.map((o) => `<option value="${esc(o)}" ${sel('payer', o)}>Pagó ${esc(personName(c, o))}</option>`).join('')}</select>` : ''}
      <div class="chips filt-chips">
        ${approxCount ? `<button type="button" class="chip ${filters.approx ? 'on' : ''}" data-action="f-approx" aria-pressed="${filters.approx}">Aproximados (${approxCount})</button>` : ''}
        ${nolocCount ? `<button type="button" class="chip ${filters.noloc ? 'on' : ''}" data-action="f-noloc" aria-pressed="${filters.noloc}">Sin ubicación (${nolocCount})</button>` : ''}
        ${rateCount ? `<button type="button" class="chip ${filters.rate ? 'on' : ''}" data-action="f-rate" aria-pressed="${filters.rate}">Tasa pendiente (${rateCount})</button>` : ''}
      </div>
      </div>
    </div>
    ${sortable && days.some((d) => d.items.length > 1) ? '<div class="muted hint">Mantén presionado un gasto y arrástralo para ordenarlo dentro de su día. Con teclado: Alt + ↑ o ↓ sobre el gasto.</div>' : ''}
    ${days.length ? days.map((d) => `<div class="day"><span class="day-l"><span>${esc(dayLabel(d.date))}</span>${dayRateHtml(dayRate(d.items, cur.dest.code))}</span><span class="day-tot"><b>${fmtHome(sumHome(d.items))}</b>${sumDest(d.items) ? ` <span class="muted">${fmtDest(sumDest(d.items))}</span>` : ''}</span></div>
      <div class="card day-card" ${sortable ? `data-day="${esc(d.date)}"` : ''} style="padding:4px 16px">${d.items.map((e) => expenseItem(c, e, orderOf.get(e.id))).join('')}</div>`).join('')
      : '<div class="empty">No hay gastos con ese filtro.</div>'}`;
}
// --- ordenar los gastos de un día: mantener presionado y arrastrar ---

export let dragSt = null; // { item, card, ids, grab, timer, active, ... } mientras hay un gesto sobre un gasto
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

export function initList() {
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
}
