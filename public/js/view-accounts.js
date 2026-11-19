// Pantalla de cuentas: quién le paga a quién, saldos y abonos registrados.
import { currencies, fmtHome, fmtMoney, todayStr } from './money.mjs';
import { PENDING } from './filters.mjs';
import { esc } from './ui.js';
import { ctx, dayLabel, methodLabel, needsSetup, personName, settlementOf, setupCard } from './shared.js';

// Abono: plata que una persona le pasó a otra. `payDraft` guarda lo escrito mientras el diálogo está abierto, así un
// redibujado (por ejemplo al sincronizar) no borra lo que la persona iba escribiendo.
export let payOpen = false;
export function setPayOpen(value) { payOpen = value; return value; }
export let payDraft = null; // { id, from, to, amountText, currency, date, note }
export function setPayDraft(value) { payDraft = value; return value; }
export const centsText = (cents) => (cents / 100).toFixed(2).replace('.', ',');
function payDialog(c) {
  const d = payDraft;
  const { dest, home } = currencies();
  const who = (sel) => c.people.map((p) => `<option value="${esc(p.id)}" ${p.id === sel ? 'selected' : ''}>${esc(p.name)}</option>`).join('');
  return `<dialog id="pay-dialog" class="sheet" aria-labelledby="pay-title">
    <form id="pay-form" autocomplete="off">
      <header class="sheet-head"><h2 id="pay-title">${d.id ? 'Editar abono' : 'Registrar abono'}</h2>
        <button type="button" class="sheet-x" data-action="pay-cancel" aria-label="Cerrar">×</button></header>
      <div class="sheet-body">
        <label for="pay-from">Quién paga</label>
        <select id="pay-from" required><option value="" hidden>Elegir…</option>${who(d.from)}</select>
        <label for="pay-to">A quién le paga</label>
        <select id="pay-to" required><option value="" hidden>Elegir…</option>${who(d.to)}</select>
        <label for="pay-amount">Monto</label>
        <input id="pay-amount" inputmode="decimal" placeholder="0" value="${esc(d.amountText)}" required>
        <label for="pay-cur">Moneda en que se pagó</label>
        <select id="pay-cur">${[dest, home].map((x) => `<option value="${esc(x.code)}" ${x.code === d.currency ? 'selected' : ''}>${esc(x.code)} · ${esc(x.name)}</option>`).join('')}</select>
        <label for="pay-date">Fecha</label>
        <input id="pay-date" type="date" value="${esc(d.date)}" max="${esc(todayStr())}" required>
        <label for="pay-note">Nota (opcional)</label>
        <input id="pay-note" maxlength="120" placeholder="Ej: Pix, efectivo" value="${esc(d.note)}">
        <p class="muted">Se descuenta de lo que se deben. Si se pagó en otra moneda, se convierte con la tasa de ese día.</p>
      </div>
      <footer class="sheet-foot"><p id="pay-error" class="form-error" role="alert" hidden></p>
        ${d.id ? `<button class="btn danger" type="button" data-action="pay-del" data-id="${esc(d.id)}">Borrar</button>` : ''}
        <button class="btn secondary" type="button" data-action="pay-cancel">Cancelar</button>
        <button class="btn" type="submit">${d.id ? 'Guardar' : 'Registrar'}</button></footer>
    </form></dialog>`;
}
export function readPayDraft() {
  if (!payDraft) return;
  const v = (id) => document.getElementById(id)?.value ?? '';
  payDraft = { ...payDraft, from: v('pay-from'), to: v('pay-to'), amountText: v('pay-amount'), currency: v('pay-cur'), date: v('pay-date'), note: v('pay-note') };
}
export function viewAccounts() {
  const c = ctx();
  if (needsSetup(c)) return setupCard();
  const s = settlementOf(c);
  const byMethod = {};
  for (const e of c.expenses) byMethod[e.payment_method_id ?? PENDING] = (byMethod[e.payment_method_id ?? PENDING] ?? 0) + (e.amount_home ?? 0);
  const noMethod = c.expenses.filter((e) => e.payment_method_id == null).length;
  return `
    ${noMethod ? `<div class="banner">${noMethod} gasto(s) con el medio de pago por definir; no entran en estas cuentas hasta que les pongas medio.</div>` : ''}
    ${s.pending ? `<div class="banner">${s.pending} gasto(s) sin tasa todavía; no entran en estas cuentas hasta convertirse.</div>` : ''}
    ${s.pendingPayments ? `<div class="banner">${s.pendingPayments} abono(s) sin tasa todavía; no se descuentan hasta convertirse.</div>` : ''}
    <div class="card"><h2>Quién le paga a quién</h2>
      ${s.transfers.length ? s.transfers.map((t) => `<div class="pay row"><span><b>${esc(personName(c, t.from))}</b> le paga a <b>${esc(personName(c, t.to))}</b></span>
          <span class="pay-end"><span class="num">${fmtHome(t.amount)}</span>
          <button type="button" class="btn secondary small" data-action="pay-new" data-from="${esc(t.from)}" data-to="${esc(t.to)}" data-amount="${t.amount}" aria-label="Registrar abono de ${esc(personName(c, t.from))} a ${esc(personName(c, t.to))}">Abonar</button></span></div>`).join('')
        : '<div class="empty">Nadie debe nada por ahora.</div>'}
    </div>
    <div class="card"><h2>Abonos registrados</h2>
      ${c.payments.length ? c.payments.map((x) => `<div class="pay row"><span><b>${esc(personName(c, x.from_person_id))}</b> le pagó a <b>${esc(personName(c, x.to_person_id))}</b>
          <div class="muted">${esc(dayLabel(x.date))}${x.note ? ` · ${esc(x.note)}` : ''}${x.currency !== currencies().home.code ? ` · ${x.amount_home == null ? 'sin tasa todavía' : `≈ ${fmtHome(x.amount_home)}`}` : ''}${x.rate_estimated ? ' · tasa estimada' : ''}</div></span>
          <span class="pay-end"><span class="num">${esc(fmtMoney(x.currency, x.amount_cents))}</span>
          <button type="button" class="btn secondary small" data-action="pay-edit" data-id="${esc(x.id)}">Editar</button></span></div>`).join('')
        : '<div class="empty">Aún no hay abonos. Cuando alguien le pague a otra persona, regístralo aquí y se descuenta de lo que se deben.</div>'}
      <button class="btn" type="button" data-action="pay-new">+ Registrar abono</button>
    </div>
    ${payOpen ? payDialog(c) : ''}
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
