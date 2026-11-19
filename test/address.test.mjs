import test from 'node:test';
import assert from 'node:assert/strict';
import { addressName, reverseAddress } from '../public/js/geosearch.mjs';

const feature = (properties) => ({ features: [{ geometry: { coordinates: [-75.63, 6.17] }, properties }] });

test('nombre de un punto: la dirección manda; sin calle, el barrio o la ciudad; el sitio más cercano va de último', () => {
  assert.equal(addressName(feature({ street: 'Carrera 65', housenumber: '36-61', name: 'Panadería Vecina', city: 'Itagüí' })), 'Carrera 65 36-61');
  assert.equal(addressName(feature({ street: 'Carrera 65', city: 'Itagüí' })), 'Carrera 65, Itagüí'); // calle sin número: se agrega la ciudad
  assert.equal(addressName(feature({ district: 'Villas de San Antonio', city: 'Itagüí' })), 'Villas de San Antonio');
  assert.equal(addressName(feature({ city: 'Itagüí' })), 'Itagüí');
  assert.equal(addressName(feature({ name: 'Parque Principal', city: 'Itagüí' })), 'Parque Principal');
  // Un sitio con número de puerta pero sin calle no se toma por nombre de lugar.
  assert.equal(addressName(feature({ name: 'Local 4', housenumber: '12', district: 'Centro' })), 'Centro');
  assert.equal(addressName(feature({ name: 'x'.repeat(300), city: '' })).length, 120);
});

test('nombre de un punto: sin datos devuelve null', () => {
  assert.equal(addressName(null), null);
  assert.equal(addressName({ features: [] }), null);
  assert.equal(addressName(feature({})), null);
  assert.equal(addressName(feature({ osm_key: 'highway' })), null);
});

test('reverseAddress pide el punto a Photon, devuelve null si falla y propaga la cancelación', async () => {
  const urls = [];
  const ok = async (url) => { urls.push(String(url)); return { ok: true, json: async () => feature({ street: 'Carrera 65', housenumber: '36-61' }) }; };
  assert.equal(await reverseAddress({ lat: 6.1731, lng: -75.6298 }, { fetchFn: ok }), 'Carrera 65 36-61');
  assert.match(urls[0], /photon\.komoot\.io\/reverse\?/);
  assert.match(urls[0], /lat=6\.1731/);
  assert.match(urls[0], /lon=-75\.6298/);

  assert.equal(await reverseAddress({ lat: 1, lng: 1 }, { fetchFn: async () => ({ ok: false, status: 503 }) }), null);
  assert.equal(await reverseAddress({ lat: 1, lng: 1 }, { fetchFn: async () => { throw new TypeError('sin red'); } }), null);
  const abort = async () => { const e = new Error('cancelado'); e.name = 'AbortError'; throw e; };
  await assert.rejects(reverseAddress({ lat: 1, lng: 1 }, { fetchFn: abort }), (e) => e.name === 'AbortError');
});
