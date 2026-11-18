import test from 'node:test';
import assert from 'node:assert/strict';
import { toHttp } from '../src/http.mjs';

const estado = { status: 200, body: { trips: [], expenses: [{ id: 'a' }] } };
const pedir = (ifNoneMatch) => toHttp(estado, { method: 'GET', path: '/api/state', ifNoneMatch });

test('el estado lleva ETag y, si el navegador ya tiene esa versión, se responde 304 sin cuerpo', () => {
  const primera = pedir(null);
  assert.equal(primera.status, 200);
  assert.ok(primera.headers.etag);
  assert.equal(primera.body, JSON.stringify(estado.body));

  const repetida = pedir(primera.headers.etag);
  assert.equal(repetida.status, 304);
  assert.equal(repetida.body, null);
});

test('si el estado cambió, el ETag cambia y se manda completo', () => {
  const antes = pedir(null).headers.etag;
  const despues = toHttp({ status: 200, body: { trips: [], expenses: [] } }, { method: 'GET', path: '/api/state', ifNoneMatch: antes });
  assert.equal(despues.status, 200);
  assert.notEqual(despues.headers.etag, antes);
});

test('lo que no es el estado no lleva ETag ni responde 304', () => {
  const otra = toHttp(estado, { method: 'GET', path: '/api/rates/history', ifNoneMatch: '"x"' });
  assert.equal(otra.status, 200);
  assert.equal(otra.headers.etag, undefined);
  const error = toHttp({ status: 401, body: { error: 'no' } }, { method: 'GET', path: '/api/state' });
  assert.equal(error.status, 401);
  assert.equal(error.headers.etag, undefined);
});
