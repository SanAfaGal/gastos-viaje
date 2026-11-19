// Eventos de la página: clics por acción, escritura, cambios y envío de formularios.
import { addDays, currencies, fmtHome, parseAmount, todayStr } from './money.mjs';
import { currencyByCode } from './currencies.mjs';
import { setTheme } from './theme.js';
import * as store from './store.js';
import { openDatePicker } from './datepicker.mjs';
import { $view, busy, coolingDown, toast, working } from './ui.js';
import { ctx } from './shared.js';
import { downloadBackup, downloadCsv, editMethod, editPerson, editTrip, onMethodForm, paintPreview, restoreFromFile, setEditMethod, setEditPerson, setEditTrip, setMethodOpen, setPersonOpen, setTripOpen, undoDelete } from './view-settings.js';
import { barRead, chartDays, homeBars, loadHistory, setChartDays } from './view-home.js';
import { filters, filtersOpen, picked, resetFilters, setFiltersOpen } from './view-list.js';
import { clearFieldError, draft, paintBenes, paintCards, paintCur, paintLoc, setDraft, setDraftDate, submitForm, updateConv } from './view-form.js';
import { applyQuick, centsText, newPayDraft, paintPay, payDraft, readPayDraft, setPayCurrency, setPayDate, setPayDraft, setPayHist, setPayOpen, swapPay } from './view-accounts.js';
import { focusStop } from './view-map.js';
import { openPicker } from './place-picker.js';
import { render, sync } from './router.js';

let lastSubmitter = null;

export function initEvents() {
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
    else if (action === 'f-toggle') { setFiltersOpen(!filtersOpen); render(); }
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
        setDraft(null);
        toast('Gasto borrado', 'ok', gone && { label: 'Deshacer', run: () => undoDelete(gone) });
        location.hash = '#/gastos';
      }
    } else if (action === 'range') {
      setChartDays(Number(id));
      try { localStorage.setItem('bg_chartDays', String(chartDays)); } catch { /* sin almacenamiento */ }
      loadHistory();
    } else if (action === 'mode') { setTheme({ mode: id }); render(); }
    else if (action === 'edit-person') { setEditPerson(id); setPersonOpen(true); render(); }
    else if (action === 'new-person') { setEditPerson(null); setPersonOpen(true); render(); }
    else if (action === 'cancel-person') document.getElementById('person-dialog')?.close();
    else if (action === 'pay-new') {
      setPayDraft(newPayDraft(ctx(), t.dataset.from ?? '', t.dataset.to ?? '', Number(t.dataset.amount)));
      setPayOpen(true);
      render();
    } else if (action === 'pay-edit') {
      const x = ctx().payments.find((p) => p.id === id);
      if (x) {
        setPayDraft({ id: x.id, from: x.from_person_id, to: x.to_person_id, amountText: centsText(x.amount_cents), currency: x.currency, date: x.date, note: x.note ?? '' });
        setPayOpen(true);
        render();
      }
    } else if (action === 'pay-cancel') document.getElementById('pay-dialog')?.close();
    else if (action === 'pay-swap') swapPay();
    else if (action === 'pay-cur') setPayCurrency(id);
    else if (action === 'pay-quick') applyQuick(id);
    else if (action === 'pay-date-q') setPayDate(id === 'yesterday' ? addDays(todayStr(), -1) : todayStr());
    else if (action === 'pay-date-open') { readPayDraft(); openDatePicker({ value: payDraft.date, onPick: setPayDate }); }
    else if (action === 'pay-del') {
      if (confirm('¿Borrar este abono?')) await busy(t, () => guard(async () => { await store.deletePayment(id); setPayOpen(false); setPayDraft(null); toast('Abono borrado'); render(); }), 'Borrando…');
    }
    else if (action === 'pick-method') {
      draft.method = id;
      clearFieldError('method');
      document.querySelectorAll('#cards .pitem').forEach((b) => {
        const on = b === t;
        b.classList.toggle('on', on);
        b.setAttribute('aria-checked', String(on));
      });
      t.scrollIntoView({ inline: 'center', block: 'nearest', behavior: 'smooth' });
    } else if (action === 'auto-color') {
      document.getElementById('m-color').value = '';
      paintPreview();
    } else if (action === 'edit-trip') { setEditTrip(id); setTripOpen(true); render(); }
    else if (action === 'new-trip') { setEditTrip(null); setTripOpen(true); render(); }
    else if (action === 'cancel-trip') document.getElementById('trip-dialog')?.close();
    else if (action === 'trip-person') {
      t.classList.toggle('on');
      t.setAttribute('aria-pressed', String(t.classList.contains('on')));
    } else if (action === 'del-trip') {
      const n = c.counts[id] ?? 0;
    const msg = n ? `Este viaje tiene ${n} gasto(s). ¿Borrar el viaje y todos sus gastos? No se puede deshacer.` : '¿Borrar este viaje?';
      if (confirm(msg)) await busy(t, () => guard(async () => { await store.deleteTrip(id, n > 0); toast('Viaje borrado'); render(); }), 'Borrando…');
    } else if (action === 'edit-method') { setEditMethod(id); setMethodOpen(true); render(); }
    else if (action === 'new-method') { setEditMethod(null); setMethodOpen(true); render(); }
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
$view.addEventListener('toggle', (ev) => { if (ev.target.id === 'pay-hist') setPayHist(ev.target.open); }, true);
$view.addEventListener('input', (ev) => {
    const id = ev.target.id;
    if (id === 'amount') { draft.amountText = ev.target.value; clearFieldError('amount'); updateConv(); }
    else if (id === 'desc') draft.desc = ev.target.value;
    else if (id === 'f-q') { filters.q = ev.target.value; const pos = ev.target.selectionStart; render(); const el = document.getElementById('f-q'); el.focus(); el.setSelectionRange(pos, pos); }
    else if (id.startsWith('m-')) onMethodForm(id);
    else if (id.startsWith('pay-')) paintPay();
  });
$view.addEventListener('change', (ev) => {
    const id = ev.target.id;
    if (id === 'restore-file') {
      const file = ev.target.files?.[0];
      ev.target.value = ''; // permite elegir otra vez el mismo archivo
      restoreFromFile(file);
    } else if (id.startsWith('pay-')) {
      paintPay();
    } else if (id === 'cur-other') {
      if (ev.target.value && currencyByCode(ev.target.value)) { draft.currency = ev.target.value; paintCur(); }
    } else if (id === 'f-method') { filters.method = picked(ev.target); render(); }
    else if (id === 'f-person') { filters.person = picked(ev.target); render(); }
    else if (id === 'f-payer') { filters.payer = picked(ev.target); render(); }
    else if (id === 'f-day') { filters.day = picked(ev.target); render(); }
    else if (id === 'm-kind') {
      const isCard = ev.target.value === 'card';
      document.getElementById('card-fields').hidden = !isCard;
      document.getElementById('m-name').placeholder = isCard ? 'Ej: Bancolombia, Nu, Visa de Ana' : ev.target.value === 'pix' ? 'Ej: Transferencia de Juan' : 'Ej: Efectivo de Ana';
      document.querySelector('label[for="m-name"]').textContent = isCard ? 'Nombre (el banco, por ejemplo)' : 'Nombre';
    }
    if (id.startsWith('m-')) onMethodForm(id);
  });
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
        setTripOpen(false);
        setEditTrip(null);
        toast(wasNew ? 'Viaje creado' : 'Viaje guardado');
        render();
      }), 'Guardando…');
    } else if (f === 'person-form') {
      await busy(btn, () => guardIn('p-error', async () => {
        // Una persona nueva entra en el viaje activo; las ya existentes no cambian de viajes al renombrarlas.
        await store.savePerson({ id: editPerson ?? undefined, name: document.getElementById('p-name').value, trip_id: editPerson ? undefined : store.activeTrip().id });
        setPersonOpen(false);
        setEditPerson(null);
        toast('Persona guardada');
        render();
      }), 'Guardando…');
    } else if (f === 'pay-form') {
      await busy(btn, () => guardIn('pay-error', async () => {
        readPayDraft();
        const cents = parseAmount(payDraft.amountText);
        if (!payDraft.from || !payDraft.to) throw new Error('Elige quién paga y a quién');
        if (payDraft.from === payDraft.to) throw new Error('Quien paga y quien recibe deben ser personas distintas');
        if (!cents) throw new Error('Escribe un monto válido');
        await store.savePayment({
          id: payDraft.id ?? undefined, from_person_id: payDraft.from, to_person_id: payDraft.to,
          amount_cents: cents, currency: payDraft.currency, date: payDraft.date, note: payDraft.note,
        });
        const wasNew = !payDraft.id;
        setPayOpen(false);
        setPayDraft(null);
        toast(wasNew ? 'Abono registrado' : 'Abono guardado');
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
        setMethodOpen(false);
        setEditMethod(null);
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
}
