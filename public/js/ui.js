// Piezas básicas de la interfaz: elementos fijos de la página, escape de HTML, avisos (toast), diálogos de ayuda y el candado que evita acciones dobles.

export const $view = document.getElementById('view');
export const $title = document.getElementById('title');
export const $status = document.getElementById('status');
const $toast = document.getElementById('toast');
export const $tripBtn = document.getElementById('trip-btn');
export const $tripSwitch = document.getElementById('trip-switch');
export const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
// Aviso grande arriba de la pantalla. kind: 'ok' (verde, ✓) o 'error' (naranja/rojo, !, dura más). Se cierra al tocarlo.
let toastTimer;
// `action` = { label, run }: agrega un botón al aviso (por ejemplo "Deshacer") y lo deja visible más tiempo.
export function toast(msg, kind = 'ok', action = null) {
  const icon = document.createElement('span');
  icon.className = 'toast-icon';
  icon.setAttribute('aria-hidden', 'true');
  icon.textContent = kind === 'error' ? '!' : '✓';
  const text = document.createElement('span');
  text.textContent = msg;
  $toast.replaceChildren(icon, text);
  if (action) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'toast-act';
    btn.textContent = action.label;
    btn.addEventListener('click', (ev) => { ev.stopPropagation(); $toast.classList.remove('show'); action.run(); });
    $toast.append(btn);
  }
  $toast.className = `toast ${kind}`;
  void $toast.offsetWidth; // reinicia la animación si ya había un aviso
  $toast.classList.add('show');
  toastMs = kind === 'error' ? 8000 : action ? 12000 : 4000;
  armToast();
  announce(action ? `${msg}. ${action.label} disponible` : msg, kind === 'error');
}
// El aviso visible no es una región en vivo (cambiar el role después de poner el texto no se anuncia de forma fiable):
// el texto se repite en dos regiones fijas ocultas, una amable (status) y una urgente (alert).
export function announce(msg, urgent = false) {
  const live = document.getElementById(urgent ? 'live-alert' : 'live-status');
  live.textContent = '';
  setTimeout(() => { live.textContent = msg; }, 50);
}
let toastMs = 4000;
const armToast = () => { clearTimeout(toastTimer); toastTimer = setTimeout(() => $toast.classList.remove('show'), toastMs); };
// Icono ⓘ que abre o cierra una explicación corta (ver la acción 'info'). Mantiene el formulario limpio.
// La explicación sale en un diálogo (hoja desde abajo en celular), así no mueve ni deforma el formulario.
export const infoBtn = (id, label) => `<button type="button" class="info-btn" data-action="info" data-id="${id}" aria-haspopup="dialog" aria-label="Más información: ${esc(label)}">i</button>`;
export const infoDialog = (id, title, html) => `<dialog id="info-${id}" class="sheet info" aria-labelledby="info-${id}-t">
  <header class="sheet-head"><h2 id="info-${id}-t">${esc(title)}</h2><button type="button" class="sheet-x" data-action="info-close" aria-label="Cerrar">×</button></header>
  <div class="sheet-body">${html}</div></dialog>`;
// Acción en curso: mientras una acción que tarda (red) no termina se ignoran los demás toques, y el botón
// muestra un giro y su texto de "trabajando". Así no se ejecuta nada dos veces.
export let working = false;
let cooldownUntil = 0; // pausa corta tras guardar o borrar un gasto, contra el doble toque
export async function busy(btn, fn, label) {
  if (working) return undefined;
  working = true;
  $view.setAttribute('aria-busy', 'true');
  const original = btn?.innerHTML;
  if (btn) {
    btn.classList.add('busy');
    btn.disabled = true;
    if (label) btn.textContent = label;
  }
  try {
    return await fn();
  } finally {
    working = false;
    $view.removeAttribute('aria-busy');
    if (btn?.isConnected) {
      btn.classList.remove('busy');
      btn.disabled = false;
      btn.innerHTML = original;
    }
  }
}
export function coolingDown() {
  if (Date.now() < cooldownUntil) return true;
  cooldownUntil = Date.now() + 700;
  return false;
}

export function initUi() {
  // Mientras el puntero o el foco están sobre el aviso no se cierra solo (WCAG 2.2.1).
$toast.addEventListener('pointerenter', () => clearTimeout(toastTimer));
$toast.addEventListener('pointerleave', () => { if ($toast.classList.contains('show')) armToast(); });
$toast.addEventListener('focusin', () => clearTimeout(toastTimer));
$toast.addEventListener('focusout', () => { if ($toast.classList.contains('show')) armToast(); });
$toast.addEventListener('click', () => $toast.classList.remove('show'));
}
