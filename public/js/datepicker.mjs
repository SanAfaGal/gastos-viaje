// Calendario propio (en lugar del que trae cada navegador): una hoja desde abajo con el mes, días grandes para tocar con el dedo
// y la misma apariencia que el resto de la app. Semana desde el lunes. No deja elegir días después de `max` (hoy, por defecto).
import { icon } from './icons.mjs';
import { todayStr } from './money.mjs';

const MONTHS = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
const DOW = ['lu', 'ma', 'mi', 'ju', 'vi', 'sá', 'do'];
const pad = (n) => String(n).padStart(2, '0');
const ymd = (y, m, d) => `${y}-${pad(m + 1)}-${pad(d)}`;

let dlg = null;
let st = null; // { y, m, value, min, max, onPick }

// Cuadrícula del mes: celdas vacías hasta el lunes y luego los días con su estado. Función pura (se prueba sin navegador).
export function monthCells(y, m, { value, min, max, today }) {
  const lead = (new Date(Date.UTC(y, m, 1)).getUTCDay() + 6) % 7; // lunes = 0
  const days = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  const cells = Array.from({ length: lead }, () => null);
  for (let d = 1; d <= days; d += 1) {
    const date = ymd(y, m, d);
    cells.push({ d, date, sel: date === value, today: date === today, off: date > max || date < min });
  }
  return cells;
}

function paint() {
  const { y, m, value, min, max } = st;
  const cells = monthCells(y, m, { value, min, max, today: todayStr() });
  const prevOff = ymd(y, m, 1) <= min;
  const nextOff = m === 11 ? ymd(y + 1, 0, 1) > max : ymd(y, m + 1, 1) > max;
  dlg.querySelector('.cal-title').textContent = `${MONTHS[m]} ${y}`;
  dlg.querySelector('[data-cal-prev]').disabled = prevOff;
  dlg.querySelector('[data-cal-next]').disabled = nextOff;
  dlg.querySelector('.cal-grid').innerHTML = DOW.map((x) => `<span class="cal-dow" aria-hidden="true">${x}</span>`).join('')
    + cells.map((c) => (c
      ? `<button type="button" class="cal-day${c.sel ? ' sel' : ''}${c.today ? ' today' : ''}" data-date="${c.date}" ${c.off ? 'disabled' : ''} aria-pressed="${c.sel}" aria-label="${c.d} de ${MONTHS[m]} de ${y}${c.today ? ', hoy' : ''}">${c.d}</button>`
      : '<span></span>')).join('');
}

function shift(n) {
  st.m += n;
  if (st.m < 0) { st.m = 11; st.y -= 1; }
  if (st.m > 11) { st.m = 0; st.y += 1; }
  paint();
}

function ensureDialog() {
  if (dlg) return dlg;
  dlg = document.createElement('dialog');
  dlg.className = 'sheet cal-sheet';
  dlg.setAttribute('aria-labelledby', 'cal-title');
  dlg.innerHTML = `<header class="sheet-head"><h2 id="cal-h">Elige el día</h2><button type="button" class="sheet-x" data-cal-close aria-label="Cerrar">${icon('x')}</button></header>
    <div class="sheet-body cal-body">
      <div class="cal-nav">
        <button type="button" class="cal-arrow" data-cal-prev aria-label="Mes anterior">${icon('chevron', 'cal-left')}</button>
        <b class="cal-title" id="cal-title" aria-live="polite"></b>
        <button type="button" class="cal-arrow" data-cal-next aria-label="Mes siguiente">${icon('chevron', 'cal-right')}</button>
      </div>
      <div class="cal-grid"></div>
    </div>
    <div class="sheet-foot"><button type="button" class="btn secondary" data-cal-today>Hoy</button></div>`;
  document.body.append(dlg);
  dlg.addEventListener('click', (ev) => {
    if (ev.target === dlg || ev.target.closest('[data-cal-close]')) return dlg.close();
    if (ev.target.closest('[data-cal-prev]')) return shift(-1);
    if (ev.target.closest('[data-cal-next]')) return shift(1);
    const pick = (date) => { const cb = st?.onPick; dlg.close(); cb?.(date); };
    if (ev.target.closest('[data-cal-today]')) return pick(st.max < todayStr() ? st.max : todayStr());
    const day = ev.target.closest('[data-date]');
    if (day && !day.disabled) pick(day.dataset.date);
  });
  return dlg;
}

// `value` YYYY-MM-DD (el día marcado), `min` y `max` límites, `onPick(date)` al elegir un día.
export function openDatePicker({ value, min = '2000-01-01', max = todayStr(), onPick }) {
  const d = ensureDialog();
  const v = /^\d{4}-\d{2}-\d{2}$/.test(value ?? '') ? value : max;
  st = { y: Number(v.slice(0, 4)), m: Number(v.slice(5, 7)) - 1, value: v, min, max, onPick };
  paint();
  d.showModal();
  d.querySelector('.cal-day.sel, .cal-day.today')?.focus({ preventScroll: true });
}
