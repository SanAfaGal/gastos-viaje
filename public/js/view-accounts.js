// Pantalla de cuentas: lo que falta por saldar (con su avance), saldo por persona, abonos y gasto por medio de pago.
// También el diálogo para registrar un abono (la lógica de montos está en accounts.mjs).
import { addDays, currencies, fmtHome, fmtMoney, fmtRate, parseAmount, toHome, todayStr } from './money.mjs';
import { PENDING } from './filters.mjs';
import { icon } from './icons.mjs';
import { localRate } from './store.js';
import { abonoEffect, balanceBars, debtProgress, methodShares, owedBetween, quickAmounts } from './accounts.mjs';
import { esc } from './ui.js';
import { ctx, dayLabel, initials, methodLabel, needsSetup, personName, settlementOf, setupCard, shortDate } from './shared.js';

// Abono: plata que una persona le pasó a otra. `payDraft` guarda lo escrito mientras el diálogo está abierto, así un
// redibujado (por ejemplo al sincronizar) no borra lo que la persona iba escribiendo.
export let payOpen = false;
export function setPayOpen(value) { payOpen = value; return value; }
export let payDraft = null; // { id, from, to, amountText, currency, date, note }
export function setPayDraft(value) { payDraft = value; return value; }
export let payHist = false; // el historial de abonos está desplegado
export function setPayHist(value) { payHist = value; return value; }
export const centsText = (cents) => (cents / 100).toFixed(2).replace('.', ',');

// Abono nuevo. Sin personas indicadas se parte de la deuda más grande (si la hay) con su monto.
export function newPayDraft(c, from = '', to = '', amount = 0) {
  if (!from && !to) {
    const t = settlementOf(c).transfers[0];
    if (t) { from = t.from; to = t.to; amount = t.amount; }
  }
  return { id: null, from, to, amountText: amount > 0 ? centsText(amount) : '', currency: currencies().home.code, date: todayStr(), note: '' };
}

// Lo que se ve del abono según lo escrito: monto en tu moneda, cuánto se debe hoy y cómo queda la cuenta.
function payFacts(c, d) {
  const { home } = currencies();
  const unit = 10 ** (2 - home.digits);
  const cents = parseAmount(d.amountText);
  let amountHome;
  let rate = null;
  let estimated = false;
  if (!cents) amountHome = undefined;
  else if (d.currency === home.code) amountHome = cents;
  else {
    const r = localRate(d.date, c.trip, d.currency);
    if (r) { rate = r.rate; estimated = Boolean(r.estimated); amountHome = toHome(cents, r.rate, home.digits); } else amountHome = null;
  }
  // Al editar, el abono que se edita ya está contado en las cuentas: se calcula sin él.
  const others = d.id ? c.payments.filter((p) => p.id !== d.id) : c.payments;
  const owed = owedBetween(settlementOf({ ...c, payments: others }).transfers, d.from, d.to);
  return { cents, amountHome, rate, estimated, owed, unit, home, effect: abonoEffect({ owed, amount: amountHome, unit }) };
}

const chipBtn = (label, { on = false, action, id = '', radio = false }) =>
  `<button type="button" class="chip ${on ? 'on' : ''}" ${radio ? `role="radio" aria-checked="${on}"` : `aria-pressed="${on}"`} data-action="${action}"${id ? ` data-id="${esc(id)}"` : ''}>${label}</button>`;

// Las partes del diálogo que cambian al escribir; se dibujan de nuevo sin tocar el campo del monto (así no pierde el foco).
function payLive(c, d) {
  const f = payFacts(c, d);
  const { dest, home } = currencies();
  const a = esc(personName(c, d.from));
  const b = esc(personName(c, d.to));
  const ready = Boolean(d.from && d.to && d.from !== d.to);
  const cur = [dest, home].map((x) => chipBtn(esc(x.code), { on: d.currency === x.code, action: 'pay-cur', id: x.code, radio: true })).join('');
  let quick = '';
  if (d.currency === home.code && ready) {
    const q = quickAmounts(f.owed, f.unit);
    if (q.all > 0) {
      const text = Boolean(d.amountText.trim());
      quick = chipBtn(`Todo · ${fmtHome(q.all)}`, { on: f.cents === q.all, action: 'pay-quick', id: 'all' })
        + chipBtn(`Mitad · ${fmtHome(q.half)}`, { on: f.cents === q.half && q.half !== q.all, action: 'pay-quick', id: 'half' })
        + chipBtn('Otro monto', { on: text && f.cents !== q.all && f.cents !== q.half, action: 'pay-quick', id: 'other' });
    }
  }
  let conv = '';
  if (f.cents && d.currency !== home.code) {
    conv = f.amountHome == null ? 'La tasa de ese día se pone al guardar.'
      : `≈ ${fmtHome(f.amountHome)} · ${fmtRate(f.rate, d.currency)}${f.estimated ? ' (tasa estimada)' : ''}`;
  }
  let tone = 'hint';
  let effect;
  if (!ready) effect = d.from && d.from === d.to ? 'Quien paga y quien recibe deben ser personas distintas.' : 'Elige quién paga y a quién.';
  else if (f.effect.kind === 'none') effect = `Hoy ${f.owed > 0 ? `${a} le debe ${fmtHome(f.owed)} a ${b}` : f.owed < 0 ? `${b} le debe ${fmtHome(-f.owed)} a ${a}` : `${a} y ${b} están a mano`}. Escribe el monto para ver cómo queda.`;
  else if (f.effect.kind === 'unknown') effect = 'Se convertirá a tu moneda con la tasa del día al guardar.';
  else if (f.effect.kind === 'square') { tone = 'ok'; effect = `${icon('check')} Con este abono, ${a} y ${b} quedan a mano.`; }
  else if (f.effect.kind === 'owes') effect = `${a} seguirá debiendo ${fmtHome(f.effect.rest)} a ${b}.`;
  else {
    tone = 'warn';
    const rest = fmtHome(f.effect.rest);
    effect = f.owed > 0 ? `Este abono se pasa: ${b} le deberá ${rest} a ${a}.`
      : f.owed < 0 ? `${b} ya le debe ${fmtHome(-f.owed)} a ${a}: con este abono le deberá ${rest}.`
      : `${a} no le debe nada a ${b} hoy: con este abono, ${b} le deberá ${rest} a ${a}.`;
  }
  const today = todayStr();
  const yesterday = addDays(today, -1);
  const other = d.date !== today && d.date !== yesterday;
  const dates = chipBtn('Hoy', { on: d.date === today, action: 'pay-date-q', id: 'today' }) + chipBtn('Ayer', { on: d.date === yesterday, action: 'pay-date-q', id: 'yesterday' })
    + `<button type="button" class="chip date-other ${other ? 'on' : ''}" data-action="pay-date-open" aria-haspopup="dialog" aria-pressed="${other}">${icon('calendar')} <span>${other ? esc(shortDate(d.date)) : 'Otro día'}</span></button>`;
  const label = d.id ? 'Guardar cambios' : f.cents ? `Registrar abono de ${esc(fmtMoney(d.currency, f.cents))}` : 'Registrar abono';
  return { cur, quick, conv, effect, tone, dates, label, valid: ready && Boolean(f.cents) };
}

function payDialog(c) {
  const d = payDraft;
  const l = payLive(c, d);
  const who = (sel) => c.people.map((p) => `<option value="${esc(p.id)}" ${p.id === sel ? 'selected' : ''}>${esc(p.name)}</option>`).join('');
  return `<dialog id="pay-dialog" class="sheet pay-sheet" aria-labelledby="pay-title">
    <form id="pay-form" autocomplete="off">
      <header class="sheet-head"><h2 id="pay-title">${d.id ? 'Editar abono' : 'Registrar abono'}</h2>
        <button type="button" class="sheet-x" data-action="pay-cancel" aria-label="Cerrar">${icon('x')}</button></header>
      <div class="sheet-body">
        <div class="pay-who">
          <div><label class="flab" for="pay-from">Quién paga</label><select id="pay-from" required><option value="" hidden>Elegir…</option>${who(d.from)}</select></div>
          <button type="button" class="pay-swap" data-action="pay-swap" aria-label="Invertir quién paga y quién recibe">${icon('transfer')}</button>
          <div><label class="flab" for="pay-to">A quién le paga</label><select id="pay-to" required><option value="" hidden>Elegir…</option>${who(d.to)}</select></div>
        </div>
        <section class="amount-hero" aria-label="Monto del abono">
          <div class="hero-top"><label for="pay-amount">Monto</label></div>
          <input id="pay-amount" class="amount" inputmode="decimal" enterkeyhint="done" placeholder="0,00" value="${esc(d.amountText)}">
          <div class="chips cur-chips" id="pay-cur" role="radiogroup" aria-label="Moneda en que se pagó">${l.cur}</div>
          <div class="chips cur-chips" id="pay-quick" role="group" aria-label="Montos rápidos">${l.quick}</div>
          <div class="conv-row"><div class="conv" id="pay-conv">${l.conv}</div></div>
        </section>
        <div id="pay-effect" class="pay-effect ${l.tone}" role="status">${l.effect}</div>
        <div class="fsub"><span class="flab" id="pay-when-l">Cuándo</span><div class="chips date-chips" id="pay-dates" role="group" aria-labelledby="pay-when-l">${l.dates}</div></div>
        <div class="fsub"><label class="flab" for="pay-note">Nota <span class="opt">(opcional)</span></label>
          <input id="pay-note" maxlength="120" placeholder="Ej: Pix, efectivo" value="${esc(d.note)}"></div>
      </div>
      <footer class="sheet-foot"><p id="pay-error" class="form-error" role="alert" hidden></p>
        ${d.id ? `<button class="btn danger" type="button" data-action="pay-del" data-id="${esc(d.id)}">Borrar</button>` : ''}
        <button class="btn secondary" type="button" data-action="pay-cancel">Cancelar</button>
        <button class="btn" id="pay-submit" type="submit" ${l.valid ? '' : 'disabled'}>${l.label}</button></footer>
    </form></dialog>`;
}

// Lo escrito en el diálogo pasa al borrador (la moneda y la fecha ya viven en él: se cambian con sus botones).
export function readPayDraft() {
  if (!payDraft || !document.getElementById('pay-form')) return;
  const v = (id) => document.getElementById(id)?.value ?? '';
  payDraft = { ...payDraft, from: v('pay-from'), to: v('pay-to'), amountText: v('pay-amount'), note: v('pay-note') };
}

// Redibuja lo que cambia al escribir o elegir (moneda, montos rápidos, equivalente, efecto, fecha y botón) sin tocar los campos.
export function paintPay() {
  if (!payDraft || !document.getElementById('pay-form')) return;
  readPayDraft();
  const l = payLive(ctx(), payDraft);
  const html = { 'pay-cur': l.cur, 'pay-quick': l.quick, 'pay-conv': l.conv, 'pay-dates': l.dates };
  for (const [id, h] of Object.entries(html)) { const el = document.getElementById(id); if (el) el.innerHTML = h; }
  const eff = document.getElementById('pay-effect');
  if (eff) { eff.className = `pay-effect ${l.tone}`; eff.innerHTML = l.effect; }
  const btn = document.getElementById('pay-submit');
  if (btn && !btn.classList.contains('busy')) { btn.innerHTML = l.label; btn.disabled = !l.valid; }
}

export function swapPay() {
  readPayDraft();
  payDraft = { ...payDraft, from: payDraft.to, to: payDraft.from };
  for (const [id, v] of [['pay-from', payDraft.from], ['pay-to', payDraft.to]]) document.getElementById(id).value = v;
  for (const id of ['pay-from', 'pay-to']) document.getElementById(id).dispatchEvent(new Event('change', { bubbles: true })); // el menú propio repinta su botón
  paintPay();
}
export function setPayCurrency(code) { readPayDraft(); payDraft = { ...payDraft, currency: code }; paintPay(); }
export function setPayDate(date) { readPayDraft(); payDraft = { ...payDraft, date }; paintPay(); }
export function applyQuick(which) {
  readPayDraft();
  const input = document.getElementById('pay-amount');
  if (which === 'other') { input.value = ''; payDraft = { ...payDraft, amountText: '' }; paintPay(); input.focus(); return; }
  const f = payFacts(ctx(), payDraft);
  const q = quickAmounts(f.owed, f.unit);
  const text = centsText(which === 'all' ? q.all : q.half);
  input.value = text;
  payDraft = { ...payDraft, amountText: text };
  paintPay();
}

const avatar = (c, id) => `<span class="acc-av" style="background:var(--seg-${(Math.max(0, c.people.findIndex((p) => p.id === id)) % 5) + 1})" aria-hidden="true">${esc(initials(personName(c, id)))}</span>`;

export function viewAccounts() {
  const c = ctx();
  if (needsSetup(c)) return setupCard();
  const s = settlementOf(c);
  const byMethod = {};
  for (const e of c.expenses) byMethod[e.payment_method_id ?? PENDING] = (byMethod[e.payment_method_id ?? PENDING] ?? 0) + (e.amount_home ?? 0);
  const noMethod = c.expenses.filter((e) => e.payment_method_id == null).length;
  const total = s.balances.reduce((n, b) => n + b.paid, 0);
  const counted = c.expenses.filter((e) => e.amount_home != null && e.payment_method_id != null).length;
  const puso = s.balances.filter((b) => b.paid > 0).map((b) => `${esc(personName(c, b.person_id))} puso ${fmtHome(b.paid)}`).join(' · ');
  const labels = Object.fromEntries(c.payMethods.map((m) => [m.id, m]));
  const shares = methodShares(byMethod, [...c.payMethods.map((m) => m.id), ...(noMethod ? [PENDING] : [])]);
  const homeCode = currencies().home.code;
  const debt = (t) => {
    const p = debtProgress(t, c.payments);
    const names = `<b>${esc(personName(c, t.from))}</b> le debe a <b>${esc(personName(c, t.to))}</b>`;
    return `<div class="card acc-debt">
      <div class="acc-who">${avatar(c, t.from)}<span class="acc-arrow" aria-hidden="true">${icon('chevron')}</span>${avatar(c, t.to)}<span>${names}</span></div>
      <div class="acc-left"><span class="acc-big neg num">${fmtHome(t.amount)}</span><span class="muted">falta por pagar</span></div>
      ${p.paid > 0 ? `<div class="acc-track" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${p.pct}" aria-label="Abonado ${p.pct} por ciento de la deuda"><div class="acc-fill" style="width:${p.pct}%"></div></div>
        <div class="row muted"><span>Abonado <b class="num">${fmtHome(p.paid)}</b></span><span>de <b class="num">${fmtHome(p.total)}</b></span></div>` : ''}
      <button type="button" class="btn" data-action="pay-new" data-from="${esc(t.from)}" data-to="${esc(t.to)}" data-amount="${t.amount}" aria-label="Registrar abono de ${esc(personName(c, t.from))} a ${esc(personName(c, t.to))}">Registrar abono</button>
    </div>`;
  };
  const settled = `<div class="card acc-ok">${icon('check')}<span><b>${c.payments.length ? 'Están a mano' : 'Nadie debe nada por ahora'}</b>${c.payments.length ? '<span class="muted">Con los abonos registrados no queda nada por pagar.</span>' : ''}</span></div>`;
  return `
    ${noMethod ? `<div class="banner">${noMethod} gasto(s) con el medio de pago por definir; no entran en estas cuentas hasta que les pongas medio.</div>` : ''}
    ${s.noAmount ? `<div class="banner">${s.noAmount} gasto(s) sin monto todavía; no entran en estas cuentas hasta que les pongas monto.</div>` : ''}
    ${s.pending ? `<div class="banner">${s.pending} gasto(s) sin tasa todavía; no entran en estas cuentas hasta convertirse.</div>` : ''}
    ${s.pendingPayments ? `<div class="banner">${s.pendingPayments} abono(s) sin tasa todavía; no se descuentan hasta convertirse.</div>` : ''}
    <div class="card acc-hero"><h2>Total del viaje</h2>
      <div class="acc-total num">${fmtHome(total)}</div>
      <div class="acc-sub">${counted} gasto${counted === 1 ? '' : 's'} entre ${c.people.length} persona${c.people.length === 1 ? '' : 's'}${puso ? ` · ${puso}` : ''}</div>
    </div>
    <h2 class="acc-h">Por saldar</h2>
    ${s.transfers.length ? s.transfers.map(debt).join('') : settled}
    <div class="card"><h2>Saldo por persona</h2>
      ${balanceBars(s.balances).map((b) => { const bal = s.balances.find((x) => x.person_id === b.person_id); return `<div class="acc-bal"><div class="row"><b>${esc(personName(c, b.person_id))}</b>
        <span class="num ${b.side}">${b.side === 'neg' ? '−' : b.side === 'pos' ? '+' : ''}${fmtHome(Math.abs(b.net))}</span></div>
        <div class="acc-track thin" aria-hidden="true"><div class="acc-fill ${b.side}" style="width:${b.pct}%"></div></div>
        <div class="muted">Puso ${fmtHome(bal.paid)} · Le tocan ${fmtHome(bal.consumed)}</div></div>`; }).join('')}
    </div>
    <details class="card acc-hist" id="pay-hist" ${payHist ? 'open' : ''}>
      <summary><span><b>Abonos</b> <span class="acc-count">${c.payments.length}</span></span><span class="muted acc-more">${c.payments.length ? '<span class="when-closed">Ver historial</span><span class="when-open">Ocultar</span>' : '<span>Sin abonos</span>'} ${icon('chevron')}</span></summary>
      ${c.payments.length ? c.payments.map((x) => `<div class="pay row"><span><b>${esc(personName(c, x.from_person_id))}</b> le pagó a <b>${esc(personName(c, x.to_person_id))}</b>
          <div class="muted">${esc(dayLabel(x.date))}${x.note ? ` · ${esc(x.note)}` : ''}${x.currency !== homeCode ? ` · ${x.amount_home == null ? 'sin tasa todavía' : `≈ ${fmtHome(x.amount_home)}`}` : ''}${x.rate_estimated ? ' · tasa estimada' : ''}</div></span>
          <span class="pay-end"><span class="num">${esc(fmtMoney(x.currency, x.amount_cents))}</span>
          <button type="button" class="btn secondary small" data-action="pay-edit" data-id="${esc(x.id)}" aria-label="Editar el abono de ${esc(personName(c, x.from_person_id))} a ${esc(personName(c, x.to_person_id))}">Editar</button></span></div>`).join('')
        : '<div class="empty">Aún no hay abonos. Cuando alguien le pague a otra persona, regístralo aquí y se descuenta de lo que se deben.</div>'}
      <button class="btn secondary" type="button" data-action="pay-new">+ Registrar abono</button>
    </details>
    ${payOpen ? payDialog(c) : ''}
    <div class="card"><h2>Gastado por medio de pago</h2>
      ${shares.map((r) => { const m = labels[r.id]; return `<div class="acc-meth"><div class="row"><span>${m ? esc(methodLabel(m)) : 'Por definir'}<div class="muted">${m ? `de ${esc(personName(c, m.owner_person_id))}` : 'sin medio de pago'}</div></span><span class="num">${fmtHome(r.amount)}</span></div>
        <div class="acc-track thin" aria-hidden="true"><div class="acc-fill meth" style="width:${r.pct}%"></div></div></div>`; }).join('')}
    </div>`;
}
