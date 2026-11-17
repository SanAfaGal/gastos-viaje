// Servidor local: sirve ./public y la API. Uso: npm run dev  ->  http://localhost:3000
// HOST=0.0.0.0 npm run dev  para abrirlo desde el celular en la misma red wifi.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, isAbsolute, join, normalize, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getDb } from './src/db.mjs';
import { handle } from './src/handlers.mjs';

const root = resolve(fileURLToPath(new URL('./public', import.meta.url)));
const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? '127.0.0.1';

const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : null;
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost'); // base fija: la cabecera Host puede venir mal formada
    if (url.pathname.startsWith('/api/')) {
      let body = null;
      try {
        body = await readBody(req);
      } catch {
        res.writeHead(400, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ error: 'JSON inválido' }));
      }
      const out = await handle({
        method: req.method,
        path: url.pathname,
        query: url.searchParams,
        body,
        passcode: req.headers['x-passcode'],
        ip: req.socket.remoteAddress,
        db: await getDb(),
      });
      res.writeHead(out.status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      return res.end(JSON.stringify(out.body));
    }

    const rel = url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname);
    const file = normalize(join(root, rel));
    const fromRoot = relative(root, file);
    if (fromRoot.startsWith('..') || isAbsolute(fromRoot)) {
      res.writeHead(403);
      return res.end();
    }
    const data = await readFile(file);
    res.writeHead(200, {
      'content-type': types[extname(file)] ?? 'application/octet-stream',
      'cache-control': 'no-cache',
    });
    res.end(data);
  } catch (err) {
    if (err.code === 'ERR_INVALID_URL') {
      res.writeHead(400);
      return res.end('Dirección inválida');
    }
    if (err.code === 'ENOENT' || err.code === 'EISDIR') {
      res.writeHead(404);
      return res.end('No encontrado');
    }
    console.error(err);
    res.writeHead(500);
    res.end('Error interno');
  }
});

server.listen(port, host, () => {
  console.log(`Gastos de viaje en http://${host === '0.0.0.0' ? 'localhost' : host}:${port}`);
});
