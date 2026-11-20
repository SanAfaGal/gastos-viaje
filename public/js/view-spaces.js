// Pantalla "Administración" (código ADMIN_PASSCODE): la tarjeta de espacios, su estado, la carga de la lista y sus
// acciones. El HTML de la tarjeta vive en spaces-card.mjs.
import * as store from './store.js';
import { busy, esc, toast } from './ui.js';
import { render } from './router.js';
import { renameDialogHtml, spaceName, spacesCardHtml } from './spaces-card.mjs';
import { icon } from './icons.mjs';

let spaces = null; // null = cargando; arreglo = lista
let status = 'idle'; // idle | loading | ready | na (el servidor no ofrece la administración) | error
let shown = null; // { name, code } recién creado o regenerado: solo vive aquí y en la pantalla, nunca se guarda
let epoch = 0; // sube al salir de la administración: una carga que termina después ya no vale
export let spaceOpen = false; // hay un diálogo abierto: el de nuevo espacio o, con `renaming`, el de renombrar
let renaming = null; // id del espacio que se renombra (diálogo de renombrar abierto) o null
// El router llama a esto al cerrarse el diálogo (Cancelar, X, Escape, fuera): ninguno de los dos debe reabrirse solo.
export function setSpaceOpen(value) { spaceOpen = value; if (!value) renaming = null; return value; }

// La tarjeta solo existe con el código de la administración (el último estado recibido lo dice).
const isAdmin = () => store.isManager();

// Al salir de la administración (cerrar sesión o cambiar de espacio) se olvida todo, incluido el código mostrado.
export function resetSpaces() {
  epoch += 1;
  spaces = null;
  status = 'idle';
  shown = null;
  spaceOpen = false;
  renaming = null;
}
// Carga la lista al abrir la administración y tras cada acción. 404 = este servidor no tiene
// administración (sin ADMIN_PASSCODE). Hoy 'na' casi no puede darse: sin ADMIN_PASSCODE nadie llega a esta pantalla.
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
  if (!isAdmin() || (status === 'na' && !shown)) return ''; // con un código por mostrar, la tarjeta no se oculta nunca
  const error = status === 'error' ? 'No se pudo cargar la lista de espacios. Revisa tu conexión y recarga la página.' : null;
  const card = spacesCardHtml({ spaces, shown, esc, canShare: typeof navigator.share === 'function', error });
  const toRename = renaming && spaces?.find((x) => x.id === renaming);
  // Renombrando y el espacio ya no está en la lista: ningún diálogo (nunca el de crear en su lugar) y se da por cerrado,
  // para que el router vuelva a redibujar con cada cambio en vez de esperar a un diálogo que no está.
  if (renaming && !toRename) { renaming = null; spaceOpen = false; }
  const dialog = toRename ? renameDialogHtml({ space: toRename, esc }) : spaceOpen ? `<dialog id="space-dialog" class="sheet" aria-labelledby="sd-title">
      <form id="space-form" autocomplete="off">
        <header class="sheet-head"><h2 id="sd-title">Nuevo espacio</h2>
          <button type="button" class="sheet-x" data-action="cancel-space" aria-label="Cerrar">${icon('x')}</button></header>
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

// Pantalla única de la administración: la lista de espacios (con sus diálogos) y la salida. Sin viajes ni datos.
export function viewManage() {
  return `${viewSpaces()}
    <div class="card"><h2>Acceso</h2>
      <p class="muted">Este código solo administra espacios: no abre viajes ni gastos de ningún grupo.</p>
      <button class="btn secondary" type="button" data-action="logout">Cambiar código</button>
    </div>`;
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

// Guarda el nuevo nombre, cierra el diálogo y recarga la lista. Los errores los muestra quien llama dentro del diálogo.
export async function submitRename(id, name) {
  await store.renameSpace(id, name);
  renaming = null;
  spaceOpen = false;
  toast('Nombre guardado');
  await reload();
}

const nameOf = (id) => spaceName(spaces, id);
async function guarded(fn) {
  try { await fn(); } catch (err) { toast(err.offline ? 'Necesitas internet para esto' : err.message, 'error'); }
}
async function reload() {
  status = 'idle';
  render();
}

// Acciones de la tarjeta. Devuelve true si la acción era de esta sección.
export async function spaceAction(action, id, btn) {
  if (action === 'new-space') { renaming = null; spaceOpen = true; render(); }
  else if (action === 'rename-space') { if (spaces?.some((x) => x.id === id)) { renaming = id; spaceOpen = true; render(); } }
  else if (action === 'cancel-space' || action === 'cancel-rename') document.getElementById('space-dialog')?.close();
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
