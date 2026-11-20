// Control de acceso: el código que llega en cada petición se convierte en un espacio.
import { createHash, timingSafeEqual } from 'node:crypto';
import { fail } from './errors.mjs';
import { findSpaceByCode, getAdminSpace, isInactiveSpaceCode } from './spaces.mjs';

const MAX_FAILS = 10;
const MAX_GLOBAL = 300;
const LOCK_MS = 15 * 60 * 1000;

const sha = (s) => createHash('sha256').update(String(s)).digest();

// El código del administrador (APP_PASSCODE) se compara exacto y en tiempo constante.
function isAdminPasscode(passcode) {
  const expected = process.env.APP_PASSCODE;
  return Boolean(expected) && timingSafeEqual(sha(passcode ?? ''), sha(expected));
}

// Agrupa las IPv6 por su prefijo /64 (un atacante suele controlar una red completa) y deja las IPv4 igual.
function ipKey(ip) {
  if (!ip) return 'desconocida';
  let v = String(ip).toLowerCase();
  const mapped = v.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return mapped[1];
  if (!v.includes(':')) return v;
  const [head, tail = ''] = v.split('::');
  const h = head ? head.split(':') : [];
  const t = tail ? tail.split(':') : [];
  const groups = v.includes('::') ? [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill('0'), ...t] : h;
  return `${groups.slice(0, 4).map((g) => g || '0').join(':')}::/64`;
}

// Suma un intento de forma atómica (una sola sentencia, sin leer y luego escribir) y devuelve el total
// dentro de la ventana de bloqueo. Si la ventana venció, empieza de cero.
async function countAttempt(db, key, now) {
  const rows = await db.all(
    `INSERT INTO auth_failures (ip, fails, since) VALUES (?, 1, ?)
     ON CONFLICT(ip) DO UPDATE SET
       fails = CASE WHEN ? - since >= ? THEN 1 ELSE fails + 1 END,
       since = CASE WHEN ? - since >= ? THEN ? ELSE since END
     RETURNING fails`,
    [key, now, now, LOCK_MS, now, LOCK_MS, now],
  );
  return Number(rows[0].fails);
}

// Devuelve el espacio al que da acceso el código, con límite de intentos: por red (10 cada 15 min)
// y global (300 cada 15 min). Cada intento con código se cuenta ANTES de compararlo, así que aunque
// lleguen en paralelo solo se evalúan los primeros. Entrar sin código (primera visita) no cuenta.
// Compromiso: el límite global también permite que alguien bloquee a propósito por 15 minutos.
// Sin APP_PASSCODE la app está abierta: sin código o con uno desconocido se entra al espacio
// administrador, y no se cuentan intentos.
export async function checkAuth(db, passcode, ip) {
  if (!process.env.APP_PASSCODE) {
    return (passcode && (await findSpaceByCode(db, passcode))) || getAdminSpace(db);
  }
  if (!passcode) fail(401, 'Código incorrecto');
  const now = Date.now();
  const key = ipKey(ip);
  const [mine, all] = [await countAttempt(db, key, now), await countAttempt(db, 'global', now)];
  if (mine > MAX_FAILS || all > MAX_GLOBAL) fail(429, 'Demasiados intentos. Espera 15 minutos.');
  const space = isAdminPasscode(passcode) ? await getAdminSpace(db) : await findSpaceByCode(db, passcode);
  if (space) {
    // Acierto: este intento no cuenta contra nadie. Solo el código del administrador reinicia el contador de la red;
    // con el de un espacio se descuenta solo este intento, para que un miembro de un grupo no pueda intercalar
    // aciertos entre sus intentos de adivinar APP_PASSCODE y reiniciar así su límite.
    if (space.is_admin) await db.run('DELETE FROM auth_failures WHERE ip = ?', [key]);
    else await db.run('UPDATE auth_failures SET fails = MAX(fails - 1, 0) WHERE ip = ?', [key]);
    await db.run('UPDATE auth_failures SET fails = MAX(fails - 1, 0) WHERE ip = ?', ['global']);
    return space;
  }
  if (await isInactiveSpaceCode(db, passcode)) {
    // Quien lo manda tiene el código completo de un espacio que el administrador desactivó: se le dice el motivo y
    // este intento no cuenta, para que un celular que sigue con ese código no se bloquee solo recargando.
    await db.run('UPDATE auth_failures SET fails = MAX(fails - 1, 0) WHERE ip = ?', [key]);
    await db.run('UPDATE auth_failures SET fails = MAX(fails - 1, 0) WHERE ip = ?', ['global']);
    fail(403, 'Este espacio está desactivado. Habla con quien te dio el código.');
  }
  await db.run('DELETE FROM auth_failures WHERE since < ? AND ip != ?', [now - LOCK_MS, 'global']); // limpieza
  fail(401, 'Código incorrecto');
}
