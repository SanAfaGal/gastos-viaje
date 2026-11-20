// La tarjeta "Espacios" de Ajustes: HTML puro (sin DOM), así que se prueba importando solo spaces-card.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { renameDialogHtml, spaceName, spacesCardHtml } from '../public/js/spaces-card.mjs';

const esc = (s) => String(s).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
const admin = { id: 'sp-admin', name: 'Principal', created_at: '2026-01-05T10:00:00.000Z', active: true };
const familia = { id: 'sp-1', name: 'Familia Gómez', created_at: '2026-03-14T08:30:00.000Z', active: true };
const inactivo = { id: 'sp-2', name: 'Amigos', created_at: '2026-04-02T08:30:00.000Z', active: false };

test('la tarjeta lista nombre, fecha y estado de cada espacio', () => {
  const html = spacesCardHtml({ spaces: [admin, familia, inactivo], shown: null, esc });
  assert.match(html, /Familia Gómez/);
  assert.match(html, /2026-03-14/);
  assert.match(html, /Amigos/);
  assert.match(html, /Desactivado/);
  assert.match(html, /Activo/);
  assert.match(html, /data-action="regen-space" data-id="sp-1"/);
  assert.match(html, /data-action="toggle-space" data-id="sp-1"/);
  assert.match(html, /Reactivar/); // el desactivado ofrece reactivar
  assert.match(html, /Desactivar/); // el activo ofrece desactivar
  assert.match(html, /data-action="new-space"/);
});

test('cada fila ofrece renombrar, nuevo código y desactivar, Principal incluido', () => {
  const html = spacesCardHtml({ spaces: [admin, familia], shown: null, esc });
  assert.doesNotMatch(html, /Administrador/);
  for (const id of ['sp-admin', 'sp-1']) {
    assert.match(html, new RegExp(`data-action="rename-space" data-id="${id}"`));
    assert.match(html, new RegExp(`data-action="regen-space" data-id="${id}"`));
    assert.match(html, new RegExp(`data-action="toggle-space" data-id="${id}"`));
  }
  // el orden de los botones de una fila: Renombrar, Nuevo código, Desactivar
  const fila = html.slice(html.indexOf('space-row'));
  assert.ok(fila.indexOf('rename-space') < fila.indexOf('regen-space'));
  assert.ok(fila.indexOf('regen-space') < fila.indexOf('toggle-space'));
});

test('el nombre de una fila sale escapado en el botón y en el texto', () => {
  const malo = { ...familia, name: '"><img src=x onerror=alert(1)><b>x</b>' };
  const html = spacesCardHtml({ spaces: [malo], shown: null, esc });
  assert.doesNotMatch(html, /<img|<b>x<\/b>/);
  assert.doesNotMatch(html, /"><img/);
  assert.match(html, /aria-label="Renombrar &quot;&gt;&lt;img/);
  assert.match(html, /&lt;b&gt;x&lt;\/b&gt;/);
});

test('el diálogo de renombrar muestra el nombre actual escapado', () => {
  const html = renameDialogHtml({ space: familia, esc });
  assert.match(html, /<dialog id="space-dialog"/);
  assert.match(html, /id="space-rename-form"[^>]*data-id="sp-1"/);
  assert.match(html, /id="s-rename"[^>]*maxlength="40"[^>]*value="Familia Gómez"/);
  assert.match(html, /id="s-error"/);
  assert.match(html, /data-action="cancel-rename"/);
  assert.match(html, /type="submit"[^>]*>Guardar/);
  const malo = renameDialogHtml({ space: { ...familia, id: 'a"b', name: '"><img src=x onerror=alert(1)>' }, esc });
  assert.doesNotMatch(malo, /<img/);
  assert.doesNotMatch(malo, /value=""><img/);
  assert.match(malo, /value="&quot;&gt;&lt;img src=x onerror=alert\(1\)&gt;"/);
  assert.match(malo, /data-id="a&quot;b"/);
});

test('el código recién creado se muestra con aviso de que no se vuelve a ver y botones de copiar y compartir', () => {
  const shown = { name: 'Familia Gómez', code: 'ABCD-EFGH-JKLM' };
  const html = spacesCardHtml({ spaces: [admin, familia], shown, esc });
  assert.match(html, /ABCD-EFGH-JKLM/);
  assert.match(html, /no se volverá a mostrar/i);
  assert.match(html, /data-action="copy-code"/);
  assert.match(html, /data-action="share-code"/);
  assert.match(html, /data-action="dismiss-code"/);
  const sinShare = spacesCardHtml({ spaces: [admin], shown, esc, canShare: false });
  assert.match(sinShare, /data-action="copy-code"/);
  assert.doesNotMatch(sinShare, /share-code/);
  const sin = spacesCardHtml({ spaces: [admin, familia], shown: null, esc });
  assert.doesNotMatch(sin, /ABCD-EFGH-JKLM/);
  assert.doesNotMatch(sin, /copy-code/);
});

test('un nombre con HTML se escapa', () => {
  const malo = { ...familia, name: '<b>x</b>' };
  const html = spacesCardHtml({ spaces: [malo], shown: { name: '<b>x</b>', code: 'AAAA' }, esc });
  assert.doesNotMatch(html, /<b>x<\/b>/);
  assert.match(html, /&lt;b&gt;x&lt;\/b&gt;/);
});

test('mientras carga (spaces = null) muestra un texto de carga y el botón de crear', () => {
  const html = spacesCardHtml({ spaces: null, shown: null, esc });
  assert.match(html, /Cargando/);
  assert.match(html, /data-action="new-space"/);
});

test('si falla recargar la lista, el código recién creado sigue visible junto al aviso de error', () => {
  const shown = { name: 'Familia Gómez', code: 'ABCD-EFGH-JKLM' };
  const html = spacesCardHtml({ spaces: null, shown, esc, error: 'No se pudo cargar la lista de espacios.' });
  assert.match(html, /ABCD-EFGH-JKLM/);
  assert.match(html, /no se volverá a mostrar/i);
  assert.match(html, /data-action="copy-code"/);
  assert.match(html, /data-action="share-code"/);
  assert.match(html, /data-action="dismiss-code"/);
  assert.match(html, /No se pudo cargar la lista de espacios/);
  assert.doesNotMatch(html, /Cargando/);
});

test('con error y sin código solo se ve el aviso de error, sin caja de código ni lista', () => {
  const html = spacesCardHtml({ spaces: [familia], shown: null, esc, error: 'No se pudo cargar la lista de espacios.' });
  assert.match(html, /No se pudo cargar la lista de espacios/);
  assert.doesNotMatch(html, /code-box|copy-code|dismiss-code/);
  assert.doesNotMatch(html, /Familia Gómez/);
});

test('spaceName: el nombre del espacio, o "este espacio" si la lista no cargó o no lo trae', () => {
  assert.equal(spaceName([admin, familia], 'sp-1'), 'Familia Gómez');
  assert.equal(spaceName(null, 'sp-1'), 'este espacio');
  assert.equal(spaceName([admin], 'sp-1'), 'este espacio');
  assert.equal(spaceName([{ ...familia, name: '' }], 'sp-1'), 'este espacio');
});
