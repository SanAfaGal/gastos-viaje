// Interfaz: router por hash y 5 pantallas, sin framework.
import { computeSettlement, splitEqual } from './settlement.mjs';
import { addDays, currencies, fmtDest, fmtHome, fmtRate, parseAmount, toHome, todayStr } from './money.mjs';
import { CURRENCIES } from './currencies.mjs';
import { sparkline } from './chart.mjs';
import * as store from './store.js';

const $view = document.getElementById('view');
const $title = document.getElementById('title');
const $status = document.getElementById('status');
const $toast = document.getElementById('toast');

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

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
  const people = state.people;
  const peopleById = Object.fromEntries(people.map((p) => [p.id, p]));
  const methodsById = Object.fromEntries(state.payment_methods.map((m) => [m.id, m]));
  return { state, people, peopleById, methodsById, methods: state.payment_methods, expenses: state.expenses };
}

const personName = (c, id) => c.peopleById[id]?.name ?? '¿?';

function methodLabel(m) {
  if (!m) return 'Medio borrado';
  if (m.kind === 'card') return `${m.name} ••${m.last4} · ${m.card_type === 'credit' ? 'Crédito' : 'Débito'}`;
  // 'pix' es el código interno guardado en la base (de la primera versión); en pantalla se llama Transferencia
  return `${m.name} · ${m.kind === 'pix' ? 'Transferencia' : 'Efectivo'}`;
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

const needsSetup = (c) => !c.people.length || !c.methods.length;
const setupCard = () => `
  <div class="card"><h2>Primero lo primero</h2>
    <p>Elige el país del viaje y tu moneda, agrega las personas del paseo y los medios de pago (tarjetas, transferencias, efectivo) para poder registrar gastos.</p>
    <a class="btn small" href="#/ajustes">Ir a Ajustes</a></div>`;

function expenseItem(c, e) {
  const m = c.methodsById[e.payment_method_id];
  const cop = e.amount_home == null ? 'Por convertir' : fmtHome(e.amount_home);
  return `<div class="item" data-action="edit" data-id="${esc(e.id)}">
    <div><div class="t">${esc(e.description || 'Gasto')}</div>
      <div class="muted">${esc(methodLabel(m))}</div>
      <span class="tag">${esc(forWho(c, e))}</span>
      ${e.pending ? '<span class="tag warn">Sin enviar</span>' : ''}
      ${e.amount_home == null ? '<span class="tag warn">Esperando tasa</span>' : ''}
      ${e.rate_estimated ? '<span class="tag warn">Tasa estimada</span>' : ''}
      ${e.rate_manual ? '<span class="tag">Tasa manual</span>' : ''}</div>
    <div class="r"><div class="num">${cop}</div><div class="muted">${fmtDest(e.amount_cents)}</div></div>
  </div>`;
}

// ---------- pantallas ----------

function viewHome() {
  const c = ctx();
  if (needsSetup(c)) return setupCard();
  const s = settlementOf(c);
  const totalCop = c.expenses.reduce((a, e) => a + (e.amount_home ?? 0), 0);
  const totalBrl = c.expenses.reduce((a, e) => a + e.amount_cents, 0);
  const rate = store.localRate(todayStr());
  const waiting = c.expenses.filter((e) => e.amount_home == null).length;
  const unsent = store.pendingCount();
  return `
    ${unsent ? `<div class="banner">${unsent} gasto(s) sin enviar. Se envían solos cuando haya internet.</div>` : ''}
    ${waiting ? `<div class="banner">${waiting} gasto(s) esperando la tasa del día.</div>` : ''}
    <div class="card hero"><h2>Total gastado</h2>
      <div class="big">${fmtHome(totalCop)}</div>
      <div class="sub">${fmtDest(totalBrl)} · ${c.expenses.length} gasto(s)</div>
      <div class="sub">${rate ? `Hoy: ${fmtRate(rate.rate)}${rate.estimated ? ' (última conocida)' : ''}` : 'Tasa de hoy: sin datos todavía'}</div>
    </div>
    <div class="card"><h2>Saldo por persona</h2>
      ${s.balances.map((b) => `<div class="pay row"><span><b>${esc(personName(c, b.person_id))}</b><div class="muted">Le tocan ${fmtHome(b.consumed)}</div></span>
        <span class="num ${b.net < 0 ? 'neg' : 'pos'}">${b.net < 0 ? '−' : b.net > 0 ? '+' : ''}${fmtHome(Math.abs(b.net))}</span></div>`).join('')}
    </div>
    <div class="card"><h2>Últimos gastos</h2>
      ${c.expenses.length ? c.expenses.slice(0, 5).map((e) => expenseItem(c, e)).join('') : '<div class="empty">Aún no hay gastos. Toca el + para agregar.</div>'}
    </div>`;
}

const filters = { q: '', method: '', person: '' };

function viewList() {
  const c = ctx();
  if (needsSetup(c)) return setupCard();
  const q = filters.q.trim().toLowerCase();
  const list = c.expenses.filter((e) =>
    (!q || e.description.toLowerCase().includes(q)) &&
    (!filters.method || e.payment_method_id === filters.method) &&
    (!filters.person || e.beneficiary_ids.includes(filters.person)));
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
        ${c.methods.map((m) => `<option value="${esc(m.id)}" ${filters.method === m.id ? 'selected' : ''}>${esc(methodLabel(m))}</option>`).join('')}</select>
      <select id="f-person"><option value="">Para cualquiera</option>
        ${c.people.map((p) => `<option value="${esc(p.id)}" ${filters.person === p.id ? 'selected' : ''}>${esc(personName(c, p.id))}</option>`).join('')}</select>
    </div>
    <div class="muted" style="margin:0 4px 4px">${list.length} gasto(s) · ${fmtHome(total)}</div>
    ${days.length ? days.map((d) => `<div class="day">${esc(dayLabel(d.date))}</div>
      <div class="card" style="padding:4px 16px">${d.items.map((e) => expenseItem(c, e)).join('')}</div>`).join('')
      : '<div class="empty">No hay gastos con ese filtro.</div>'}`;
}

// --- formulario de gasto ---

let draft = null;
let convRate = null; // { rate, estimated } para la fecha del formulario
let lastMethod = localStorage.getItem('bg_lastMethod') ?? '';
let lastBenes = JSON.parse(localStorage.getItem('bg_lastBenes') ?? '[]');

function newDraft(c, date = todayStr()) {
  const method = c.methodsById[lastMethod] ? lastMethod : (c.methods[0]?.id ?? '');
  const benes = lastBenes.filter((id) => c.peopleById[id]);
  return { id: null, date, amountText: '', desc: '', method, benes: new Set(benes.length ? benes : c.people.map((p) => p.id)), manual: '', created_at: null };
}

function draftFrom(c, id) {
  const e = c.expenses.find((x) => x.id === id);
  if (!e) return null;
  return {
    id: e.id, date: e.date, amountText: (e.amount_cents / 100).toFixed(2).replace('.', ','),
    desc: e.description, method: e.payment_method_id, benes: new Set(e.beneficiary_ids),
    manual: e.rate_manual ? String(e.rate ?? '') : '', created_at: e.created_at,
  };
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
      <label for="amount">Monto en ${esc(currencies().dest.name.toLowerCase())} (${esc(currencies().dest.code)})</label>
      <input id="amount" class="amount" inputmode="decimal" placeholder="0,00" value="${esc(draft.amountText)}">
      <div class="conv" id="conv"></div>
      <div class="chart" id="chart" role="img"></div>

      <label for="date">Día del gasto</label>
      <input id="date" type="date" max="${todayStr()}" value="${esc(draft.date)}">

      <label for="method">Pagado con</label>
      <select id="method">${c.methods.map((m) => `<option value="${esc(m.id)}" ${m.id === draft.method ? 'selected' : ''}>${esc(methodLabel(m))} — de ${esc(personName(c, m.owner_person_id))}</option>`).join('')}</select>

      <label>¿Para quién es? (se divide en partes iguales)</label>
      <div class="chips" id="benes">
        ${c.people.map((p) => `<button type="button" class="chip ${draft.benes.has(p.id) ? 'on' : ''}" data-action="bene" data-id="${esc(p.id)}">${esc(personName(c, p.id))}</button>`).join('')}
        <button type="button" class="chip ghost" data-action="bene-all">Todos</button>
      </div>

      <label for="desc">Descripción (opcional)</label>
      <input id="desc" maxlength="120" placeholder="Almuerzo, Uber, entradas…" value="${esc(draft.desc)}">

      <details ${draft.manual ? 'open' : ''}><summary>Poner la tasa a mano</summary>
        <label for="manual">${esc(currencies().home.code)} por 1 ${esc(currencies().dest.code)}</label>
        <input id="manual" inputmode="decimal" placeholder="Ej: 585,5" value="${esc(draft.manual)}">
      </details>

      <button class="btn" type="submit" data-then="list">${draft.id ? 'Guardar cambios' : 'Guardar'}</button>
      ${draft.id ? '<button class="btn danger" type="button" data-action="del">Borrar gasto</button>'
        : '<button class="btn secondary" type="submit" data-then="again">Guardar y agregar otro</button>'}
    </form>`;
}

function manualRate() {
  const n = Number(String(draft.manual).replace(',', '.'));
  return n > 0 ? n : null;
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

// --- gráfico de la tasa (últimos 45 días) ---
let history = null; // [{ date, rate }] o null mientras carga

async function loadHistory() {
  try {
    history = await store.fetchHistory();
  } catch {
    history = [];
  }
  renderChart();
}

function renderChart() {
  const el = document.getElementById('chart');
  if (!el || !draft) return;
  const g = history ? sparkline(history, draft.date) : null;
  if (!g) {
    el.innerHTML = '';
    el.removeAttribute('aria-label');
    return;
  }
  const cur = currencies();
  const n = (v) => new Intl.NumberFormat(cur.home.locale, { maximumFractionDigits: v < 10 ? 4 : 2 }).format(v);
  const pct = (v) => new Intl.NumberFormat(cur.home.locale, { maximumFractionDigits: 1, minimumFractionDigits: 1 }).format(v);
  const trend = `${g.change > 0 ? '+' : ''}${pct(g.change)} %`;
  const label = `Tasa ${cur.dest.code} a ${cur.home.code} en los últimos ${history.length} días: mínimo ${n(g.min)}, máximo ${n(g.max)}, `
    + `${g.change >= 0 ? 'subió' : 'bajó'} ${pct(Math.abs(g.change))} %`;
  el.setAttribute('aria-label', label);
  el.innerHTML = `${g.svg}<div class="chart-cap" aria-hidden="true">
    <span>Mín <b>${n(g.min)}</b> · Máx <b>${n(g.max)}</b></span>
    <span>${esc(history.length)} días: <b>${trend}</b></span>
    ${g.selected ? `<span>El día del gasto: <b>${n(g.selected.rate)}</b></span>` : ''}</div>`;
}

function updateConv(loaded = false) {
  const el = document.getElementById('conv');
  if (!el || !draft) return;
  const cents = parseAmount(draft.amountText);
  const m = manualRate();
  const r = m ? { rate: m, estimated: false, manual: true } : convRate;
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
    <span class="muted">${fmtRate(r.rate)}${r.manual ? ' (manual)' : r.estimated ? ' (tasa estimada)' : ` (${esc(dayLabel(draft.date).toLowerCase())})`}
    ${n > 1 ? ` · ${n} personas: ${fmtHome(each)} c/u` : ''}</span>`;
  void c;
}

async function submitForm(then) {
  const cents = parseAmount(draft.amountText);
  if (!cents) return toast('Escribe un monto válido', 'error');
  if (!draft.method) return toast('Elige con qué se pagó', 'error');
  if (!draft.benes.size) return toast('Elige para quién es el gasto', 'error');
  if (draft.manual && !manualRate()) return toast('La tasa manual no es válida', 'error');
  const exp = {
    id: draft.id ?? store.uuid(),
    date: draft.date,
    amount_cents: cents,
    description: draft.desc.trim(),
    payment_method_id: draft.method,
    beneficiary_ids: [...draft.benes],
    rate_manual: manualRate() ?? undefined,
    created_at: draft.created_at ?? undefined,
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
      ${c.methods.map((m) => `<div class="pay row"><span>${esc(methodLabel(m))}<div class="muted">de ${esc(personName(c, m.owner_person_id))}</div></span><span class="num">${fmtHome(byMethod[m.id] ?? 0)}</span></div>`).join('')}
    </div>`;
}

// --- ajustes ---

let editPerson = null;
let editMethod = null;

function viewSettings() {
  const c = ctx();
  const p = editPerson ? (c.peopleById[editPerson] ?? {}) : {};
  const m = editMethod ? (c.methodsById[editMethod] ?? {}) : {};
  const kind = m.kind ?? 'card';
  const cur = currencies();
  const locked = c.expenses.length > 0;
  const option = (code, sel) => {
    const x = CURRENCIES.find((k) => k.code === code);
    return `<option value="${esc(code)}" ${code === sel ? 'selected' : ''}>${esc(x.country)} · ${esc(x.code)} (${esc(x.name)})</option>`;
  };
  return `
    <div class="card"><h2>Viaje</h2>
      <form id="trip-form" autocomplete="off">
        <label for="t-dest">País donde gastas</label>
        <select id="t-dest" ${locked ? 'disabled' : ''}>${CURRENCIES.map((x) => option(x.code, cur.dest.code)).join('')}</select>
        <label for="t-home">Tu moneda (la que usas para pagar al final)</label>
        <select id="t-home" ${locked ? 'disabled' : ''}>${CURRENCIES.map((x) => option(x.code, cur.home.code)).join('')}</select>
        ${locked ? '<p class="muted">Ya hay gastos registrados, por eso no se puede cambiar. Para cambiarlo, borra todos los gastos.</p>'
          : '<button class="btn" type="submit">Guardar</button>'}
      </form></div>

    <div class="card"><h2>Personas</h2>
      ${c.people.map((x) => `<div class="pay row"><span><b>${esc(x.name)}</b></span>
        <span><button class="btn secondary small" data-action="edit-person" data-id="${esc(x.id)}">Editar</button>
        <button class="btn danger small" data-action="del-person" data-id="${esc(x.id)}">Borrar</button></span></div>`).join('') || '<div class="empty">Aún no hay personas.</div>'}
      <form id="person-form" autocomplete="off">
        <label for="p-name">${editPerson ? 'Editar persona' : 'Agregar persona'}</label>
        <input id="p-name" maxlength="40" placeholder="Nombre" value="${esc(p.name ?? '')}" required>
        <button class="btn" type="submit">${editPerson ? 'Guardar' : 'Agregar'}</button>
        ${editPerson ? '<button class="btn secondary" type="button" data-action="cancel-person">Cancelar</button>' : ''}
      </form></div>

    <div class="card"><h2>Medios de pago</h2>
      ${c.methods.map((x) => `<div class="pay row"><span><b>${esc(methodLabel(x))}</b><div class="muted">de ${esc(personName(c, x.owner_person_id))}</div></span>
        <span><button class="btn secondary small" data-action="edit-method" data-id="${esc(x.id)}">Editar</button>
        <button class="btn danger small" data-action="del-method" data-id="${esc(x.id)}">Borrar</button></span></div>`).join('') || '<div class="empty">Aún no hay medios de pago.</div>'}
      ${c.people.length ? `<form id="method-form" autocomplete="off">
        <label for="m-kind">${editMethod ? 'Editar medio de pago' : 'Agregar medio de pago'}</label>
        <select id="m-kind"><option value="card" ${kind === 'card' ? 'selected' : ''}>Tarjeta</option><option value="pix" ${kind === 'pix' ? 'selected' : ''}>Transferencia</option><option value="cash" ${kind === 'cash' ? 'selected' : ''}>Efectivo</option></select>
        <label for="m-name">Nombre</label>
        <input id="m-name" maxlength="40" placeholder="Ej: Visa de Ana, Transferencia de Juan" value="${esc(m.name ?? '')}" required>
        <div id="card-fields" ${kind === 'card' ? '' : 'hidden'}>
          <label for="m-last4">Últimos 4 dígitos</label>
          <input id="m-last4" inputmode="numeric" maxlength="4" placeholder="1234" value="${esc(m.last4 ?? '')}">
          <label for="m-type">Tipo</label>
          <select id="m-type"><option value="debit" ${m.card_type !== 'credit' ? 'selected' : ''}>Débito</option><option value="credit" ${m.card_type === 'credit' ? 'selected' : ''}>Crédito</option></select>
        </div>
        <label for="m-owner">De quién es</label>
        <select id="m-owner">${c.people.map((x) => `<option value="${esc(x.id)}" ${(m.owner_person_id ?? c.people[0]?.id) === x.id ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</select>
        <button class="btn" type="submit">${editMethod ? 'Guardar' : 'Agregar'}</button>
        ${editMethod ? '<button class="btn secondary" type="button" data-action="cancel-method">Cancelar</button>' : ''}
      </form>` : '<div class="muted">Agrega primero una persona.</div>'}
    </div>

    <div class="card"><h2>Datos</h2>
      <button class="btn secondary" data-action="csv">Descargar gastos (CSV)</button>
      <button class="btn secondary" data-action="logout">Cambiar código de acceso</button>
      <p class="muted">Tarjetas y transferencias solo guardan nombre y últimos 4 dígitos; nunca números completos.</p>
    </div>`;
}

function viewLogin() {
  return `<form id="login" class="login card"><h2>Código de acceso</h2>
    <p class="muted">Esta app está protegida. Escribe el código para entrar.</p>
    <input id="code" type="password" autocomplete="current-password" placeholder="Código" required>
    <button class="btn" type="submit">Entrar</button></form>`;
}

function downloadCsv() {
  const c = ctx();
  const cur = currencies();
  const rows = [['Fecha', 'Descripción', 'Medio de pago', 'Pagó', 'Para', cur.dest.code, 'Tasa', cur.home.code]];
  for (const e of [...c.expenses].reverse()) {
    const m = c.methodsById[e.payment_method_id];
    rows.push([e.date, e.description, methodLabel(m), personName(c, m?.owner_person_id),
      e.beneficiary_ids.map((id) => personName(c, id)).join(' + '),
      (e.amount_cents / 100).toFixed(2), e.rate ?? '', e.amount_home == null ? '' : (e.amount_home / 100).toFixed(cur.home.digits)]);
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
  a.download = `gastos-viaje-${todayStr()}.csv`;
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
  if (store.net.needsLogin) {
    $title.textContent = 'Gastos de viaje';
    $view.innerHTML = viewLogin();
    return;
  }
  const { r, m } = currentRoute();
  if (!isFormRoute()) draft = null;
  $title.textContent = r.title;
  document.querySelectorAll('.tabbar a').forEach((a) => a.classList.toggle('active', a.dataset.tab === r.tab));
  $view.innerHTML = r.view(m);
  if (isFormRoute() && draft) { updateConv(); renderChart(); }
}

const formActive = () => isFormRoute() && draft && !store.net.needsLogin;

store.listeners.add(() => {
  if (formActive()) updateStatus();
  else if (document.activeElement && ['INPUT', 'SELECT'].includes(document.activeElement.tagName) && $view.contains(document.activeElement)) updateStatus();
  else render();
});
window.addEventListener('hashchange', () => { render(); window.scrollTo(0, 0); });

$view.addEventListener('click', async (ev) => {
  const t = ev.target.closest('[data-action]');
  if (!t) return;
  const { action, id } = t.dataset;
  const c = ctx();
  const guard = async (fn) => {
    try { await fn(); } catch (err) { toast(err.offline ? 'Necesitas internet para esto' : err.message, 'error'); }
  };
  if (action === 'edit') location.hash = `#/nuevo/${encodeURIComponent(id)}`;
  else if (action === 'bene') {
    draft.benes.has(id) ? draft.benes.delete(id) : draft.benes.add(id);
    t.classList.toggle('on', draft.benes.has(id));
    updateConv();
  } else if (action === 'bene-all') {
    draft.benes = new Set(c.people.map((p) => p.id));
    document.querySelectorAll('#benes .chip[data-id]').forEach((b) => b.classList.add('on'));
    updateConv();
  } else if (action === 'del') {
    if (confirm('¿Borrar este gasto?')) {
      store.deleteExpense(draft.id);
      draft = null;
      toast('Gasto borrado');
      location.hash = '#/gastos';
    }
  } else if (action === 'edit-person') { editPerson = id; render(); }
  else if (action === 'cancel-person') { editPerson = null; render(); }
  else if (action === 'edit-method') { editMethod = id; render(); }
  else if (action === 'cancel-method') { editMethod = null; render(); }
  else if (action === 'del-person') {
    if (confirm('¿Borrar esta persona?')) await guard(async () => { await store.deletePerson(id); toast('Persona borrada'); render(); });
  } else if (action === 'del-method') {
    if (confirm('¿Borrar este medio de pago?')) await guard(async () => { await store.deleteMethod(id); toast('Medio borrado'); render(); });
  } else if (action === 'csv') downloadCsv();
  else if (action === 'logout') { store.setPass(''); store.net.needsLogin = true; render(); }
});

$view.addEventListener('input', (ev) => {
  const id = ev.target.id;
  if (id === 'amount') { draft.amountText = ev.target.value; updateConv(); }
  else if (id === 'desc') draft.desc = ev.target.value;
  else if (id === 'manual') { draft.manual = ev.target.value; updateConv(); }
  else if (id === 'f-q') { filters.q = ev.target.value; const pos = ev.target.selectionStart; render(); const el = document.getElementById('f-q'); el.focus(); el.setSelectionRange(pos, pos); }
});

$view.addEventListener('change', (ev) => {
  const id = ev.target.id;
  if (id === 'date') {
    if (ev.target.value) { draft.date = ev.target.value; loadRate(); renderChart(); }
  } else if (id === 'method') draft.method = ev.target.value;
  else if (id === 'f-method') { filters.method = ev.target.value; render(); }
  else if (id === 'f-person') { filters.person = ev.target.value; render(); }
  else if (id === 'm-kind') document.getElementById('card-fields').hidden = ev.target.value !== 'card';
});

let lastSubmitter = null;
$view.addEventListener('click', (ev) => { lastSubmitter = ev.target.closest('button[type=submit]'); });

$view.addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const f = ev.target.id;
  const guard = async (fn) => {
    try { await fn(); } catch (err) { toast(err.offline ? 'Necesitas internet para esto' : err.message, 'error'); }
  };
  if (f === 'exp-form') submitForm(lastSubmitter?.dataset.then ?? 'list');
  else if (f === 'trip-form') {
    await guard(async () => {
      await store.saveSettings({ dest: document.getElementById('t-dest').value, home: document.getElementById('t-home').value });
      toast('Viaje guardado');
      render();
    });
  } else if (f === 'person-form') {
    await guard(async () => {
      await store.savePerson({ id: editPerson ?? undefined, name: document.getElementById('p-name').value });
      editPerson = null;
      toast('Persona guardada');
      render();
    });
  } else if (f === 'method-form') {
    await guard(async () => {
      const kind = document.getElementById('m-kind').value;
      await store.saveMethod({
        id: editMethod ?? undefined, kind, name: document.getElementById('m-name').value,
        last4: kind === 'card' ? document.getElementById('m-last4').value : null,
        card_type: kind === 'card' ? document.getElementById('m-type').value : null,
        owner_person_id: document.getElementById('m-owner').value,
      });
      editMethod = null;
      toast('Medio de pago guardado');
      render();
    });
  } else if (f === 'login') {
    store.setPass(document.getElementById('code').value);
    await guard(async () => {
      await store.ping();
      await store.refresh();
      await store.flush();
      render();
    });
    if (store.net.needsLogin) toast('Código incorrecto', 'error');
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
