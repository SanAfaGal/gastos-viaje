import test from 'node:test';
import assert from 'node:assert/strict';
import { distanceKm, formatDistance, parseNominatim, parsePhoton, rankByNearby, searchPlaces } from '../public/js/geosearch.mjs';

const RECIFE = { lat: -8.05, lng: -34.9 };
const feat = (name, lng, lat, extra = {}) => ({ geometry: { coordinates: [lng, lat] }, properties: { name, ...extra } });
const ok = (json) => ({ ok: true, status: 200, json: async () => json });

test('distancia: Recife a Olinda ~ 7 km, y de Recife a Oporto > 5000 km', () => {
  const olinda = { lat: -8.0089, lng: -34.8553 };
  const d = distanceKm(RECIFE, olinda);
  assert.ok(d > 5 && d < 9, String(d));
  assert.ok(distanceKm(RECIFE, { lat: 41.16, lng: -8.65 }) > 5000);
  assert.equal(distanceKm(RECIFE, RECIFE), 0);
});

test('distancia: se escribe en metros o kilómetros según el tamaño', () => {
  assert.equal(formatDistance(0.85), '850 m');
  assert.equal(formatDistance(0.004), '10 m');
  assert.equal(formatDistance(2.44), '2,4 km');
  assert.equal(formatDistance(38.2), '38 km');
});

test('Photon: arma nombre y detalle sin repetir y descarta lo que no tiene coordenadas o nombre', () => {
  const json = { features: [
    feat('Foco', -34.9165, -8.1375, { street: 'Av. Marechal', housenumber: '6133', district: 'Imbiribeira', city: 'Recife', country: 'Brasil' }),
    feat('Sin coordenadas', NaN, NaN),
    { geometry: { coordinates: [-34.9, -8.0] }, properties: {} },
    feat('Foco', -8.64, 41.16, { city: 'Porto', country: 'Portugal' }),
  ] };
  const r = parsePhoton(json);
  assert.deepEqual(r.map((x) => x.name), ['Foco', 'Foco']);
  assert.equal(r[0].detail, 'Av. Marechal 6133, Imbiribeira, Recife, Brasil');
  assert.deepEqual(parsePhoton(null), []);
});

test('Nominatim: el detalle no repite el nombre', () => {
  const r = parseNominatim([{ name: 'Foco', lat: '-8.1', lon: '-34.9', display_name: 'Foco, Imbiribeira, Recife, Brasil' }, { lat: 'x', lon: '1', display_name: 'roto' }]);
  assert.equal(r.length, 1);
  assert.equal(r[0].detail, 'Imbiribeira, Recife, Brasil');
});

test('cercanos primero, con su distancia; sin referencia queda en el orden del buscador', () => {
  const lejos = { name: 'Foco Porto', lat: 41.16, lng: -8.65 };
  const cerca = { name: 'Foco Recife', lat: -8.1375, lng: -34.9165 };
  const r = rankByNearby([lejos, cerca], RECIFE);
  assert.deepEqual(r.map((x) => x.name), ['Foco Recife', 'Foco Porto']);
  assert.ok(r[0].km < 15 && r[1].km > 5000);
  assert.deepEqual(rankByNearby([lejos, cerca], null).map((x) => [x.name, x.km]), [['Foco Porto', null], ['Foco Recife', null]]);
});

test('búsqueda: Photon recibe la ubicación como sesgo y lo cercano sale primero', async () => {
  let url;
  const fetchFn = async (u) => { url = new URL(u); return ok({ features: [feat('Foco', -8.64, 41.16, { city: 'Porto' }), feat('Foco', -34.9165, -8.1375, { city: 'Recife' })] }); };
  const { results, source } = await searchPlaces('foco', { ref: RECIFE, fetchFn });
  assert.equal(source, 'photon');
  assert.equal(url.hostname, 'photon.komoot.io');
  assert.equal(url.searchParams.get('lat'), '-8.05');
  assert.equal(url.searchParams.get('lon'), '-34.9');
  assert.equal(results[0].detail, 'Recife');
});

test('búsqueda: si Photon falla usa Nominatim acotado alrededor, y si no hay nada, en todo el mundo', async () => {
  const calls = [];
  const fetchFn = async (u) => {
    const url = new URL(u);
    calls.push(url);
    if (url.hostname === 'photon.komoot.io') return { ok: false, status: 503, json: async () => ({}) };
    return ok(url.searchParams.get('bounded') ? [] : [{ name: 'Foco', lat: '41.16', lon: '-8.65', display_name: 'Foco, Porto, Portugal' }]);
  };
  const { results, source } = await searchPlaces('foco', { ref: RECIFE, fetchFn });
  assert.equal(source, 'nominatim');
  assert.deepEqual(calls.map((c) => [c.hostname, c.searchParams.get('bounded')]), [['photon.komoot.io', null], ['nominatim.openstreetmap.org', '1'], ['nominatim.openstreetmap.org', null]]);
  assert.equal(results.length, 1);
  assert.ok(results[0].km > 5000);
});

test('búsqueda: texto muy corto no consulta, cancelar se propaga y sin red lanza error', async () => {
  const never = async () => { throw new Error('no debería consultar'); };
  assert.deepEqual(await searchPlaces('a', { fetchFn: never }), { results: [], source: null });
  const abort = async () => { throw Object.assign(new Error('x'), { name: 'AbortError' }); };
  await assert.rejects(() => searchPlaces('foco', { fetchFn: abort }), { name: 'AbortError' });
  const down = async () => { throw new TypeError('sin red'); };
  await assert.rejects(() => searchPlaces('foco', { ref: RECIFE, fetchFn: down }));
});
