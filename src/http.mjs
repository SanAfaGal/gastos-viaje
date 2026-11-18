// Respuesta HTTP de la API, igual para el servidor local y para la función de Netlify.
// GET /api/state lleva un ETag: si el navegador ya tiene esa versión (If-None-Match) se responde 304 sin cuerpo,
// y la sincronización periódica no vuelve a descargar todos los gastos cuando no cambió nada.
import { createHash } from 'node:crypto';

export function toHttp(out, { method = 'GET', path = '', ifNoneMatch = null } = {}) {
  const headers = { 'content-type': 'application/json', 'cache-control': 'no-store' };
  const body = JSON.stringify(out.body);
  if (method === 'GET' && out.status === 200 && path === '/api/state') {
    const etag = `"${createHash('sha1').update(body).digest('base64url')}"`;
    headers.etag = etag;
    if (ifNoneMatch === etag) return { status: 304, headers, body: null };
  }
  return { status: out.status, headers, body };
}
