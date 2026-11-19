// Pantalla de ajustes: viajes, personas, medios de pago, respaldo y exportación.
import { currencies, fmtRate, todayStr } from './money.mjs';
import { CURRENCIES, DEFAULT_SETTINGS } from './currencies.mjs';
import { NETWORKS, isHexColor } from './cards.mjs';
import { hasLocation } from './places.mjs';
import { compareChronological } from './order.mjs';
import { MODES, getTheme } from './theme.js';
import * as store from './store.js';
import { busy, esc, toast } from './ui.js';
import { cardColor, cardHtml, ctx, methodLabel, personName, rateSourceLabel } from './shared.js';
import { render } from './router.js';

// Vista previa de la tarjeta en el formulario de Ajustes, con lo que se va escribiendo.
export function paintPreview() {
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
export function onMethodForm(id) {
  const g = (x) => document.getElementById(x);
  if (id === 'm-color-pick') g('m-color').value = g('m-color-pick').value;
  paintPreview();
}
// --- ajustes ---

export let editPerson = null;
export function setEditPerson(value) { editPerson = value; return value; }
export let editMethod = null; // id del medio que se edita; null = uno nuevo
export function setEditMethod(value) { editMethod = value; return value; }
export let methodOpen = false; // diálogo de medio de pago abierto
export function setMethodOpen(value) { methodOpen = value; return value; }
export let personOpen = false; // diálogo de persona abierto (editPerson = a quién; null = una nueva)
export function setPersonOpen(value) { personOpen = value; return value; }
export let editTrip = null; // id del viaje que se edita; null = uno nuevo
export function setEditTrip(value) { editTrip = value; return value; }
export let tripOpen = false; // diálogo de viaje abierto
export function setTripOpen(value) { tripOpen = value; return value; }
export function viewSettings() {
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
export function undoDelete(e) {
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
export async function restoreFromFile(file) {
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
export function downloadBackup(data) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
  a.download = `respaldo-gastos-viaje-${todayStr()}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
}
export function downloadCsv() {
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
