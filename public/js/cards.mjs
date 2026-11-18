// Catálogo visual de tarjetas: redes, colores y bancos. Lo usan el servidor (validar) y la app (dibujar).

export const NETWORKS = {
  visa: 'Visa',
  mastercard: 'Mastercard',
  amex: 'American Express',
  elo: 'Elo',
  hipercard: 'Hipercard',
  discover: 'Discover',
  diners: 'Diners',
  other: 'Otra',
};

// Texto corto que se dibuja en la esquina de la tarjeta.
export const NETWORK_MARK = {
  visa: 'VISA',
  mastercard: 'Mastercard',
  amex: 'AMEX',
  elo: 'elo',
  hipercard: 'Hipercard',
  discover: 'Discover',
  diners: 'Diners',
  other: '',
};

// El color de una tarjeta es cualquier "#rrggbb" que elija el usuario (o vacío = automático).
export const isHexColor = (v) => typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v);

export const DEFAULT_COLOR = '#3b4252';
// Color de partida según el tipo de medio, si no se eligió otro.
export const KIND_COLOR = { card: '#3b4252', pix: '#2563eb', cash: '#0d8a6a', pending: '#6b7280' };

// Bancos frecuentes con un color sugerido. El nombre del medio es de texto libre (suele ser el banco);
// si contiene alguno de estos nombres, la tarjeta toma su color cuando no se eligió otro.
const BANKS = {
  Bancolombia: '#a8841a',
  Davivienda: '#dc2626',
  BBVA: '#1d4ed8',
  'Banco de Bogotá': '#1e40af',
  Nu: '#7c3aed',
  Itaú: '#c2410c',
  Bradesco: '#b91c1c',
  Santander: '#dc2626',
  Inter: '#ea580c',
  C6: '#27272a',
  'Banco do Brasil': '#a8841a',
  Caixa: '#1d4ed8',
};

// Del color elegido saca el degradado y un texto que se lea encima (blanco sobre oscuro, casi negro sobre claro).
export function cardPaint(hex) {
  const ok = isHexColor(hex) ? hex : DEFAULT_COLOR;
  const rgb = [1, 3, 5].map((i) => parseInt(ok.slice(i, i + 2), 16));
  const lin = rgb.map((v) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; });
  const light = 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2] > 0.4; // luminancia relativa
  const mix = (k) => `#${rgb.map((v) => Math.round(v * (1 - k)).toString(16).padStart(2, '0')).join('')}`;
  return { c1: ok, c2: mix(light ? 0.18 : 0.5), fg: light ? '#16181d' : '#ffffff', shadow: light ? 'none' : '0 1px 2px rgb(0 0 0 / .35)' };
}

// Deduce la red por los primeros dígitos (con 1 dígito ya adivina Visa o Mastercard; Elo necesita 4 o más).
// Devuelve la clave de NETWORKS o null si no reconoce el prefijo.
export function detectNetwork(input) {
  const d = String(input ?? '').replace(/\D/g, '');
  if (!d) return null;
  const n = (len) => Number(d.slice(0, len));
  const has = (len) => d.length >= len;

  if ((has(6) && n(6) === 606282) || (has(4) && n(4) === 3841)) return 'hipercard';
  const elo4 = [4011, 4312, 4389, 4514, 4576, 5041, 5066, 5067, 5090, 6277, 6362, 6363, 6516, 6550];
  if ((has(4) && elo4.includes(n(4))) || (has(3) && n(3) === 650)) return 'elo';
  if (d[0] === '4') return 'visa';
  if (has(2) && n(2) >= 51 && n(2) <= 55) return 'mastercard';
  if (has(4) && n(4) >= 2221 && n(4) <= 2720) return 'mastercard';
  if (has(2) && (n(2) === 34 || n(2) === 37)) return 'amex';
  if ((has(4) && n(4) === 6011) || (has(2) && n(2) === 65) || (has(3) && n(3) >= 644 && n(3) <= 649)) return 'discover';
  if ((has(2) && (n(2) === 36 || n(2) === 38 || n(2) === 39)) || (has(3) && n(3) >= 300 && n(3) <= 305)) return 'diners';
  return null;
}

// Color sugerido según el nombre escrito a mano (ignora mayúsculas y tildes). "Nu" y "C6" son tan cortos
// que solo cuentan como palabra completa, para no confundirlos con "Nueva" o "C60".
export function suggestColor(name) {
  const norm = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
  const text = norm(String(name ?? ''));
  if (!text) return null;
  const words = text.split(/[^a-z0-9]+/);
  const hit = Object.keys(BANKS).find((b) => {
    const key = norm(b);
    return key.length <= 3 ? words.includes(key) : text.includes(key);
  });
  return hit ? BANKS[hit] : null;
}
