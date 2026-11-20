// La tarjeta "Espacios" de Ajustes: HTML puro (sin DOM), así que se prueba importando solo spaces-card.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spacesCardHtml } from '../public/js/spaces-card.mjs';

const esc = (s) => String(s).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
const admin = { id: 'sp-admin', name: 'Principal', created_at: '2026-01-05T10:00:00.000Z', active: true, is_admin: true };
const familia = { id: 'sp-1', name: 'Familia Gómez', created_at: '2026-03-14T08:30:00.000Z', active: true, is_admin: false };
const inactivo = { id: 'sp-2', name: 'Amigos', created_at: '2026-04-02T08:30:00.000Z', active: false, is_admin: false };

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

test('el espacio administrador no tiene botones de regenerar ni desactivar', () => {
  const html = spacesCardHtml({ spaces: [admin], shown: null, esc });
  assert.match(html, /Principal/);
  assert.doesNotMatch(html, /regen-space/);
  assert.doesNotMatch(html, /toggle-space/);
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
