// Tema de la app: modo automático (sigue al teléfono), claro u oscuro. El color de la app es siempre verde.
// Se guarda en este navegador. El mismo cálculo corre antes de pintar (script en index.html) para que no parpadee.
const KEY = 'bg_theme';
// `icon` es el contenido del <svg viewBox="0 0 24 24"> de cada opción.
export const MODES = [
  { id: 'auto', name: 'Automático', icon: '<circle cx="12" cy="12" r="9"/><path d="M12 3v18" /><path d="M12 3a9 9 0 0 1 0 18z" fill="currentColor"/>' },
  { id: 'light', name: 'Claro', icon: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>' },
  { id: 'dark', name: 'Oscuro', icon: '<path d="M20 14.5A8 8 0 0 1 9.5 4 8 8 0 1 0 20 14.5z"/>' },
];

const dark = window.matchMedia('(prefers-color-scheme: dark)');

export function getTheme() {
  try {
    const t = JSON.parse(localStorage.getItem(KEY) ?? '{}');
    return { mode: MODES.some((m) => m.id === t.mode) ? t.mode : 'auto' };
  } catch {
    return { mode: 'auto' };
  }
}

function applyTheme() {
  const { mode } = getTheme();
  const isDark = mode === 'dark' || (mode === 'auto' && dark.matches);
  const root = document.documentElement;
  root.dataset.scheme = isDark ? 'dark' : 'light';
  // Color de la barra del navegador en el celular
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = getComputedStyle(root).getPropertyValue('--brand').trim() || '#0b6b4a';
}

export function setTheme(change) {
  try {
    localStorage.setItem(KEY, JSON.stringify({ ...getTheme(), ...change }));
  } catch {
    /* sin almacenamiento: el cambio vale hasta recargar */
  }
  applyTheme();
}

// En modo automático, sigue al teléfono si cambia de claro a oscuro.
dark.addEventListener('change', () => {
  if (getTheme().mode === 'auto') applyTheme();
});
applyTheme();
