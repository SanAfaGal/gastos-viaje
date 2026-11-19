import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

// El service worker guarda la app para que abra sin internet: si falta un archivo en su lista, esa pantalla no carga sin conexión.
// Con la app partida en varios módulos es fácil olvidar uno, así que se comprueba aquí.
const root = path.resolve(import.meta.dirname, '..', 'public');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
const shell = [...read('sw.js').match(/const SHELL = \[([\s\S]*?)\];/)[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);

test('el service worker guarda todos los módulos de public/js y las hojas de estilo', () => {
  const modules = [
    ...fs.readdirSync(path.join(root, 'js')).filter((f) => /\.m?js$/.test(f)).map((f) => `/js/${f}`),
    ...fs.readdirSync(path.join(root, 'css')).filter((f) => f.endsWith('.css')).map((f) => `/css/${f}`),
  ];
  const missing = modules.filter((m) => !shell.includes(m));
  assert.deepEqual(missing, [], `faltan en SHELL de sw.js: ${missing.join(', ')}`);
});

test('todo lo que lista el service worker existe en disco y no se repite', () => {
  assert.equal(new Set(shell).size, shell.length, 'hay rutas repetidas en SHELL');
  const absent = shell.filter((p) => p !== '/' && !fs.existsSync(path.join(root, p)));
  assert.deepEqual(absent, [], `no existen: ${absent.join(', ')}`);
});

test('cada import relativo de un módulo apunta a un archivo que existe', () => {
  const bad = [];
  for (const f of fs.readdirSync(path.join(root, 'js')).filter((x) => /\.m?js$/.test(x))) {
    for (const m of read(`js/${f}`).matchAll(/from '(\.[^']+)'/g)) {
      if (!fs.existsSync(path.join(root, 'js', m[1]))) bad.push(`${f} -> ${m[1]}`);
    }
  }
  assert.deepEqual(bad, []);
});

test('index.html carga todas las hojas de estilo', () => {
  const html = read('index.html');
  const css = fs.readdirSync(path.join(root, 'css')).filter((f) => f.endsWith('.css'));
  assert.deepEqual(css.filter((f) => !html.includes(`href="/css/${f}"`)), []);
});

test('la precarga de index.html solo nombra archivos que existen', () => {
  const html = read('index.html');
  const hrefs = [...html.matchAll(/rel="modulepreload" href="([^"]+)"/g)].map((m) => m[1]);
  assert.ok(hrefs.length > 0);
  assert.deepEqual(hrefs.filter((h) => !fs.existsSync(path.join(root, h))), []);
});

test('ningún archivo de código de la app pasa de 700 líneas', () => {
  const big = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { if (e.name !== 'vendor' && e.name !== 'node_modules') walk(full); continue; }
      if (!/\.(m?js|css|html)$/.test(e.name)) continue;
      const lines = fs.readFileSync(full, 'utf8').split('\n').length;
      if (lines > 700) big.push(`${path.relative(path.resolve(root, '..'), full)} (${lines})`);
    }
  };
  walk(root);
  walk(path.resolve(root, '..', 'src'));
  assert.deepEqual(big, [], `pasan de 700 líneas: ${big.join(', ')}`);
});
