// Pantalla de inicio: resumen, barras por día y el gráfico interactivo de la tasa de cambio.
import { currencies, fmtDest, fmtHome, parseAmount, toHome, todayStr } from './money.mjs';
import { changeAt, nearestIndex, sparkline } from './chart.mjs';
import { hasLocation } from './places.mjs';
import { PENDING } from './filters.mjs';
import * as store from './store.js';
import { breakdown, byDay, summary } from './stats.mjs';
import { icon } from './icons.mjs';
import { $view, esc } from './ui.js';
import { ctx, dayLabel, needsSetup, personName, setupCard, shortDate } from './shared.js';
import { draft } from './view-form.js';

// ---------- pantallas ----------

// Resumen general: cifras clave y gráficos. El detalle de cada gasto está en Gastos y los saldos en Cuentas.
export let homeBars = []; // días del gráfico (para la lectura al tocar una barra)
export const barRead = (d) => `${dayLabel(d.date)} · ${d.count ? `${fmtHome(d.home)} · ${d.count} gasto(s)` : 'sin gastos'}`;
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
export function viewHome() {
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
// --- gráfico de la tasa, interactivo ---
// Pasa el dedo o el mouse por encima (o usa las flechas) para ver la tasa de cada día.
const RANGES = [7, 30, 90];
export let chartDays = RANGES.includes(Number(localStorage.getItem('bg_chartDays'))) ? Number(localStorage.getItem('bg_chartDays')) : 30;
export function setChartDays(value) { chartDays = value; return value; }
let history = null; // [{ date, rate }] o null mientras carga
export let chartGeo = null; // posiciones de los puntos (en %) del gráfico dibujado
export let chartIdx = 0; // punto mostrado en la lectura
let historyKey = ''; // viaje y período del historial cargado: evita pedirlo de nuevo en cada sincronización
const chartKey = () => `${store.activeTrip().id}|${chartDays}`;
export function homeChart() {
  if (history === null || historyKey !== chartKey()) loadHistory(); else renderChart();
}
export async function loadHistory() {
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
export function renderChart() {
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
export function paintReadout(i, scrubbing) {
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
// Recorrer el gráfico con el dedo, el mouse o las flechas del teclado.
function scrubTo(ev) {
  const plot = document.getElementById('c-plot');
  if (!plot || !history || !chartGeo) return;
  const r = plot.getBoundingClientRect();
  paintReadout(nearestIndex(history.length, (ev.clientX - r.left) / r.width), true);
}

export function initHome() {
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
}
