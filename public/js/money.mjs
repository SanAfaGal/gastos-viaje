// Utilidades de dinero compartidas entre el servidor y el navegador.
// Convención: todos los montos son enteros en centésimas (2 decimales) de su moneda.
//   dest = moneda del país donde se gasta (ej. BRL). home = tu moneda (ej. COP).
import { currencyByCode, DEFAULT_SETTINGS } from './currencies.mjs';

let current;
function formatterFor(c) {
  return new Intl.NumberFormat(c.locale, {
    style: 'currency',
    currency: c.code,
    minimumFractionDigits: c.digits,
    maximumFractionDigits: c.digits,
  });
}

// Fija las monedas con las que se muestran los montos (el navegador lo llama al cargar el estado).
export function setCurrencies(destCode, homeCode) {
  const dest = currencyByCode(destCode) ?? currencyByCode(DEFAULT_SETTINGS.dest);
  const home = currencyByCode(homeCode) ?? currencyByCode(DEFAULT_SETTINGS.home);
  current = { dest, home, fd: formatterFor(dest), fh: formatterFor(home) };
}
setCurrencies(DEFAULT_SETTINGS.dest, DEFAULT_SETTINGS.home);

export const currencies = () => ({ dest: current.dest, home: current.home });

export const fmtDest = (cents) => current.fd.format(cents / 100);
export const fmtHome = (cents) => current.fh.format(cents / 100);

// "1 BRL = 585,03 COP"
export function fmtRate(rate) {
  const n = new Intl.NumberFormat(current.home.locale, { maximumFractionDigits: rate < 10 ? 4 : 2 }).format(rate);
  return `1 ${current.dest.code} = ${n} ${current.home.code}`;
}

// "12,50", "12.50", "1.234,56", "R$ 8" -> centésimas enteras; null si no es válido.
export function parseAmount(text) {
  let s = String(text ?? '').replace(/[^\d.,]/g, '');
  if (!s) return null;
  if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
  const cents = Math.round(parseFloat(s) * 100);
  return cents > 0 ? cents : null;
}

// Convierte de la moneda del destino a la tuya. `digits` = decimales con que se muestra tu moneda:
// COP (0) queda en pesos enteros; USD (2) queda en centavos.
export function toHome(cents, rate, digits = 2) {
  const unit = 10 ** (2 - digits);
  return Math.round((cents * rate) / unit) * unit;
}

// YYYY-MM-DD de hoy en la zona horaria del dispositivo.
export function todayStr(now = new Date()) {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function isValidDate(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

export function addDays(dateStr, n) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
