// Tarjeta "Espacios" de Ajustes (solo la ve el administrador). HTML puro: no toca `document`, así que se prueba en Node.
// `esc` lo pasa quien llama (ui.js necesita el navegador). `spaces` es null mientras carga; `shown` es el código recién
// creado o regenerado ({ name, code }), que se muestra una sola vez.
const dayOf = (iso) => String(iso ?? '').slice(0, 10);

function codeBlock(shown, canShare, esc) {
  return `<div class="code-box" role="status">
      <p><b>Código de "${esc(shown.name)}"</b></p>
      <p class="code-value" translate="no">${esc(shown.code)}</p>
      <p class="muted">Guárdalo ahora: no se volverá a mostrar. Si lo pierdes, genera uno nuevo y el anterior dejará de funcionar.</p>
      <div class="code-acts">
        <button type="button" class="btn secondary small" data-action="copy-code">Copiar</button>
        ${canShare ? '<button type="button" class="btn secondary small" data-action="share-code">Compartir</button>' : ''}
        <button type="button" class="btn small" data-action="dismiss-code">Listo, ya lo guardé</button>
      </div>
    </div>`;
}

function spaceRow(s, esc) {
  const state = s.is_admin ? '<span class="tag">Administrador</span>' : s.active ? '<span class="tag info">Activo</span>' : '<span class="tag warn">Desactivado</span>';
  const acts = s.is_admin ? '' : `<span class="space-acts">
        <button type="button" class="btn secondary small" data-action="regen-space" data-id="${esc(s.id)}">Nuevo código</button>
        <button type="button" class="btn ${s.active ? 'danger' : 'secondary'} small" data-action="toggle-space" data-id="${esc(s.id)}">${s.active ? 'Desactivar' : 'Reactivar'}</button></span>`;
  return `<div class="pay row space-row"><span><b>${esc(s.name)}</b> ${state}
        <div class="muted">Creado el ${esc(dayOf(s.created_at))}</div></span>${acts}</div>`;
}

// `error` (texto): la lista no se pudo cargar; se muestra el aviso en su lugar, pero el código recién creado nunca se oculta.
export function spacesCardHtml({ spaces, shown, esc, canShare = true, error = null }) {
  if (error) {
    return `<div class="card"><h2>Espacios</h2>
      ${shown ? codeBlock(shown, canShare, esc) : ''}
      <p class="muted">${esc(error)}</p>
    </div>`;
  }
  const list = spaces === null
    ? '<div class="muted">Cargando…</div>'
    : spaces.map((s) => spaceRow(s, esc)).join('') || '<div class="empty">Aún no hay espacios.</div>';
  return `<div class="card"><h2>Espacios</h2>
      <p class="muted">Cada espacio es un grupo con su propio código y sus propios viajes, personas y gastos. Nadie ve los datos de otro grupo.</p>
      ${shown ? codeBlock(shown, canShare, esc) : ''}
      ${list}
      <button class="btn" type="button" data-action="new-space">+ Nuevo espacio</button>
    </div>`;
}
