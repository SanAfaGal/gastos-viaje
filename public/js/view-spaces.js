// Sección "Espacios" de Ajustes (administrador): estado, carga de la lista y acciones. El HTML de la tarjeta vive en spaces-card.mjs.
import * as store from './store.js';
import { busy, esc, toast } from './ui.js';
import { ctx } from './shared.js';
import { render } from './router.js';
import { spacesCardHtml } from './spaces-card.mjs';

let spaces = null; // null = cargando; arreglo = lista
let status = 'idle'; // idle | loading | ready | na (el servidor no ofrece la administración) | error
let shown = null; // { name, code } recién creado o regenerado: solo vive aquí y en la pantalla, nunca se guarda
let epoch = 0; // sube al salir de Ajustes: una carga que termina después ya no vale
export let spaceOpen = false; // diálogo de nuevo espacio abierto
export function setSpaceOpen(value) { spaceOpen = value; return value; }

const isAdmin = () => Boolean(ctx().state.space?.is_admin);

// Al salir de Ajustes se olvida todo, incluido el código mostrado.
export function resetSpaces() {
  epoch += 1;
  spaces = null;
  status = 'idle';
  shown = null;
  spaceOpen = false;
}
// Carga la lista al entrar en Ajustes y tras cada acción. 404 = este servidor no tiene administración (sin APP_PASSCODE).
export async function loadSpaces() {
  if (!isAdmin() || status === 'loading') return;
  status = 'loading';
  const mine = epoch;
  let result;
  try {
    result = { list: await store.listSpaces(), status: 'ready' };
  } catch (err) {
    result = { list: null, status: err.status === 404 ? 'na' : 'error' };
  }
  if (mine !== epoch) return;
  if (result.list) spaces = result.list;
  status = result.status;
  render();
}
export function ensureSpaces() {
  if (status === 'idle') loadSpaces();
}

export function viewSpaces() {
  if (!isAdmin() || status === 'na') return '';
  if (status === 'error') return '<div class="card"><h2>Espacios</h2><p class="muted">No se pudo cargar la lista de espacios. Revisa tu conexión y vuelve a entrar a Ajustes.</p></div>';
  const card = spacesCardHtml({ spaces, shown, esc, canShare: typeof navigator.share === 'function' });
  const dialog = spaceOpen ? `<dialog id="space-dialog" class="sheet" aria-labelledby="sd-title">
      <form id="space-form" autocomplete="off">
        <header class="sheet-head"><h2 id="sd-title">Nuevo espacio</h2>
          <button type="button" class="sheet-x" data-action="cancel-space" aria-label="Cerrar">×</button></header>
        <div class="sheet-body">
          <label for="s-name">Nombre del grupo</label>
          <input id="s-name" maxlength="40" placeholder="Ej: Familia Gómez" required>
          <p class="muted">Al crearlo se genera un código para entrar. Se mostrará una sola vez.</p>
        </div>
        <footer class="sheet-foot"><p id="s-error" class="form-error" role="alert" hidden></p>
          <button class="btn secondary" type="button" data-action="cancel-space">Cancelar</button>
          <button class="btn" type="submit">Crear espacio</button></footer>
      </form></dialog>` : '';
  return card + dialog;
}

// Crea el espacio y muestra su código. Los errores los muestra quien llama dentro del diálogo.
export async function submitSpace(name) {
  const out = await store.createSpace(name);
  shown = { name: out.name, code: out.code };
  spaceOpen = false;
  toast('Espacio creado');
  spaces = null;
  status = 'idle';
  render(); // cierra el diálogo y muestra el código; ensureSpaces vuelve a cargar la lista
}

const nameOf = (id) => spaces?.find((s) => s.id === id)?.name ?? '';
async function guarded(fn) {
  try { await fn(); } catch (err) { toast(err.offline ? 'Necesitas internet para esto' : err.message, 'error'); }
}
async function reload() {
  status = 'idle';
  render();
}

// Acciones de la tarjeta. Devuelve true si la acción era de esta sección.
export async function spaceAction(action, id, btn) {
  if (action === 'new-space') { spaceOpen = true; render(); }
  else if (action === 'cancel-space') document.getElementById('space-dialog')?.close();
  else if (action === 'dismiss-code') { shown = null; render(); }
  else if (action === 'copy-code') {
    if (!shown) return true;
    try {
      await navigator.clipboard.writeText(shown.code);
      toast('Código copiado');
    } catch { toast('No se pudo copiar: selecciónalo y cópialo a mano', 'error'); }
  } else if (action === 'share-code') {
    if (!shown) return true;
    try {
      await navigator.share({ title: 'Código de acceso', text: `Código de "${shown.name}" en Gastos de viaje: ${shown.code}` });
    } catch (err) { if (err?.name !== 'AbortError') toast('No se pudo compartir', 'error'); }
  } else if (action === 'regen-space') {
    if (confirm(`¿Generar un nuevo código para "${nameOf(id)}"? El código anterior deja de funcionar de inmediato y los celulares que lo usan volverán a pedir un código.`)) {
      await busy(btn, () => guarded(async () => {
        const out = await store.regenerateSpace(id);
        shown = { name: nameOf(id), code: out.code };
        await reload();
      }), 'Generando…');
    }
  } else if (action === 'toggle-space') {
    const s = spaces?.find((x) => x.id === id);
    if (!s) return true;
    if (!s.active || confirm(`¿Desactivar "${s.name}"? Ese grupo no podrá entrar hasta que lo reactives. Sus datos se conservan.`)) {
      await busy(btn, () => guarded(async () => {
        await store.setSpaceActive(id, !s.active);
        toast(s.active ? 'Espacio desactivado' : 'Espacio reactivado');
        await reload();
      }), 'Guardando…');
    }
  } else return false;
  return true;
}
