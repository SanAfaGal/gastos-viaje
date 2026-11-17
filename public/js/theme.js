// Tema de la app: modo (automático, claro, oscuro) y color de acento. Se guarda en este navegador.
// El mismo cálculo corre antes de pintar (script en index.html) para que no parpadee al abrir.
const KEY = 'bg_theme';
export const ACCENTS = [
  { id: 'verde', name: 'Verde', color: '#0b6b4a' },
  { id: 'azul', name: 'Azul', color: '#1d4ed8' },
  { id: 'morado', name: 'Morado', color: '#6d28d9' },
  { id: 'naranja', name: 'Naranja', color: '#c2410c' },
];
export const MODES = [
  { id: 'auto', name: 'Automático' },
  { id: 'light', name: 'Claro' },
  { id: 'dark', name: 'Oscuro' },
];

const dark = window.matchMedia('(prefers-color-scheme: dark)');

export function getTheme() {
  try {
    const t = JSON.parse(localStorage.getItem(KEY) ?? '{}');
    return {
      mode: MODES.some((m) => m.id === t.mode) ? t.mode : 'auto',
      accent: ACCENTS.some((a) => a.id === t.accent) ? t.accent : 'verde',
    };
  } catch {
    return { mode: 'auto', accent: 'verde' };
  }
}

export function applyTheme() {
  const { mode, accent } = getTheme();
  const isDark = mode === 'dark' || (mode === 'auto' && dark.matches);
  const root = document.documentElement;
  root.dataset.scheme = isDark ? 'dark' : 'light';
  root.dataset.accent = accent;
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
