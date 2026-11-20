// Función de Netlify: misma API que el servidor local, con Turso como base.
import { getDb } from '../../src/db.mjs';
import { handle } from '../../src/handlers.mjs';
import { toHttp } from '../../src/http.mjs';

export default async (req, context) => {
  const url = new URL(req.url);
  let body = null;
  if (req.method !== 'GET' && req.method !== 'DELETE') {
    try {
      body = await req.json();
    } catch {
      body = null;
    }
  }
  let db;
  try {
    db = await getDb();
  } catch (err) {
    // La base no abrió: un 500 normal (la próxima petición vuelve a intentar abrirla).
    console.error(err);
    return Response.json({ error: 'Error interno' }, { status: 500 });
  }
  const out = await handle({
    method: req.method,
    path: url.pathname,
    query: url.searchParams,
    body,
    passcode: req.headers.get('x-passcode'),
    ip: req.headers.get('x-nf-client-connection-ip') ?? context?.ip,
    db,
  });
  const res = toHttp(out, { method: req.method, path: url.pathname, ifNoneMatch: req.headers.get('if-none-match') });
  return new Response(res.body, { status: res.status, headers: res.headers });
};

export const config = { path: '/api/*' };
