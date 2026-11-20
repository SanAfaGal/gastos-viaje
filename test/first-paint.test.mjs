// Primer pintado: sin código guardado, la pantalla de acceso tiene que verse desde el primer instante.
// El script en línea de index.html corre antes de pintar y marca <html class="logged-out">, que oculta la barra de
// pestañas. Sin él, la barra (HTML fijo) se ve hasta que el módulo de la app termina de cargar y dibuja el acceso.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const root = path.resolve(import.meta.dirname, '..', 'public');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const inline = html.match(/<script>([\s\S]*?)<\/script>/)[1];

// Ejecuta el script en línea con un almacenamiento falso y devuelve las clases que le puso a <html>.
function firstPaint(storage, { throwing = false, scheme = false } = {}) {
  const classes = new Set();
  const dataset = {};
  const doc = { documentElement: { dataset, classList: { add: (c) => classes.add(c) } } };
  const localStorage = {
    getItem: (k) => {
      if (throwing) throw new Error('almacenamiento bloqueado');
      return k in storage ? storage[k] : null;
    },
  };
  vm.runInNewContext(inline, { document: doc, localStorage, window: { matchMedia: () => ({ matches: false }) }, matchMedia: () => ({ matches: false }) });
  return scheme ? dataset : classes;
}

test('primer pintado: sin código guardado ni marca de servidor abierto, el acceso se ve desde el inicio', () => {
  assert.ok(firstPaint({}).has('logged-out'));
});

test('primer pintado: con código guardado no se oculta nada', () => {
  assert.ok(!firstPaint({ bg_pass: 'abc' }).has('logged-out'));
});

test('primer pintado: un servidor que ya abrió sin código no se oculta', () => {
  assert.ok(!firstPaint({ bg_open: '1' }).has('logged-out'));
});

test('primer pintado: sin almacenamiento se trata como sin código', () => {
  assert.ok(firstPaint({}, { throwing: true }).has('logged-out'));
});

test('primer pintado: el tema sigue aplicándose', () => {
  const dark = firstPaint({ bg_theme: '{"mode":"dark"}' }, { scheme: true });
  assert.equal(dark.scheme, 'dark');
  assert.equal(firstPaint({ bg_theme: '{"mode":"light"}' }, { scheme: true }).scheme, 'light');
});

test('la barra de pestañas se oculta con la clase puesta en <html>, y el router la quita desde ahí', () => {
  const css = fs.readFileSync(path.join(root, 'css', 'app.css'), 'utf8');
  const router = fs.readFileSync(path.join(root, 'js', 'router.js'), 'utf8');
  assert.match(css, /\.logged-out \.tabbar\s*\{\s*display:\s*none/);
  // Si el router la pusiera en <body>, la de <html> (puesta por el script en línea) nunca se quitaría al entrar.
  assert.match(router, /document\.documentElement\.classList\.toggle\('logged-out'/);
});
