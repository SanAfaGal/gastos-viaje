// Tarjeta "Espacios" (solo la ve la administración, que gestiona los espacios sin ver sus datos). HTML puro: no toca `document`, así que se prueba en Node.
// `esc` lo pasa quien llama (ui.js necesita el navegador). `spaces` es null mientras carga; `shown` es el código recién
// creado o regenerado ({ name, code }), que se muestra una sola vez.
const dayOf = (iso) => String(iso ?? '').slice(0, 10);

// Nombre de un espacio para los textos de las acciones. Si la lista aún no cargó (o no lo trae), un texto genérico
// en vez de comillas vacías.
export const spaceName = (spaces, id) => spaces?.find((s) => s.id === id)?.name || 'este espacio';

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
  const state = s.active ? '<span class="tag info">Activo</span>' : '<span class="tag warn">Desactivado</span>';
  const id = esc(s.id);
  return `<div class="pay row space-row"><span><b>${esc(s.name)}</b> ${state}
        <div class="muted">Creado el ${esc(dayOf(s.created_at))}</div></span><span class="space-acts">
        <button type="button" class="btn secondary small" data-action="rename-space" data-id="${id}" aria-label="Renombrar ${esc(s.name)}">Renombrar</button>
        <button type="button" class="btn secondary small" data-action="regen-space" data-id="${id}">Nuevo código</button>
        <button type="button" class="btn ${s.active ? 'danger' : 'secondary'} small" data-action="toggle-space" data-id="${id}">${s.active ? 'Desactivar' : 'Reactivar'}</button></span></div>`;
}

// Diálogo de renombrar un espacio: mismo patrón que el de crear, con el nombre actual ya escrito.
export function renameDialogHtml({ space, esc }) {
  return `<dialog id="space-dialog" class="sheet" aria-labelledby="sd-title">
      <form id="space-rename-form" data-id="${esc(space.id)}" autocomplete="off">
        <header class="sheet-head"><h2 id="sd-title">Renombrar espacio</h2>
          <button type="button" class="sheet-x" data-action="cancel-rename" aria-label="Cerrar">×</button></header>
        <div class="sheet-body">
          <label for="s-rename">Nombre del grupo</label>
          <input id="s-rename" maxlength="40" value="${esc(space.name)}" required>
        </div>
        <footer class="sheet-foot"><p id="s-error" class="form-error" role="alert" hidden></p>
          <button class="btn secondary" type="button" data-action="cancel-rename">Cancelar</button>
          <button class="btn" type="submit">Guardar</button></footer>
      </form></dialog>`;
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
