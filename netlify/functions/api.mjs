// Función de Netlify: misma API que el servidor local, con Turso como base.
import { getDb } from '../../src/db.mjs';
import { handle } from '../../src/handlers.mjs';

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
  const out = await handle({
    method: req.method,
    path: url.pathname,
    query: url.searchParams,
    body,
    passcode: req.headers.get('x-passcode'),
    ip: req.headers.get('x-nf-client-connection-ip') ?? context?.ip,
    db: await getDb(),
  });
  return new Response(JSON.stringify(out.body), {
    status: out.status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
};

export const config = { path: '/api/*' };
