import test from 'node:test';
import assert from 'node:assert/strict';
import { openMemoryDb } from '../src/db.mjs';
import { handle } from '../src/handlers.mjs';
import { PlacesError, parseFoursquare, searchFoursquare } from '../src/places.mjs';

delete process.env.APP_PASSCODE;
delete process.env.TURSO_DATABASE_URL;
delete process.env.TURSO_AUTH_TOKEN;

const place = (id, name, m, extra = {}) => ({ fsq_place_id: id, name, latitude: -8.22 + m * 1e-5, longitude: -34.92, distance: m, categories: [{ name: 'Structure' }], location: { address: 'Rua A 10' }, ...extra });
const ok = (json) => ({ ok: true, status: 200, json: async () => json });

test('Foursquare: arma nombre, tipo en español y dirección, y descarta lo incompleto', () => {
  const list = parseFoursquare({ results: [
    place('a', 'Edf. Estação Atlântico Sul - Nova Barra', 0),
    place('b', 'Barra Classic', 45, { categories: [{ name: 'Apartment or Condo' }], location: { locality: 'Recife' } }),
    place('c', 'R. Cruzeiro do Sul', 370, { categories: [{ name: 'Road' }] }), // las calles no son un lugar
    { name: 'Sin coordenadas', latitude: null, longitude: null },
    { latitude: -8.2, longitude: -34.9 },
  ] });
  assert.deepEqual(list.map((p) => p.name), ['Edf. Estação Atlântico Sul - Nova Barra', 'Barra Classic']);
  assert.equal(list[0].detail, 'Edificio · Rua A 10');
  assert.ok(list.every((p) => p.approx === true)); // la posición de Foursquare es aproximada
  assert.equal(list[1].detail, 'Edificio · Recife');
  assert.deepEqual(parseFoursquare(null), []);
});

test('Foursquare: sin texto pide negocios y edificios por separado, los junta sin repetir y ordena por distancia', async () => {
  const urls = [];
  const fetchFn = async (url, init) => {
    urls.push({ url: String(url), headers: init.headers });
    return String(url).includes('fsq_category_ids')
      ? ok({ results: [place('b', 'Edificio B', 30), place('a', 'Bar', 20)] })
      : ok({ results: [place('a', 'Bar', 20), place('c', 'Padaria', 5)] });
  };
  const list = await searchFoursquare({ lat: -8.22, lng: -34.92, radius: 100, key: 'K', fetchFn });
  assert.deepEqual(list.map((p) => p.name), ['Padaria', 'Bar', 'Edificio B']);
  assert.equal(urls.length, 2);
  assert.ok(urls.some((u) => u.url.includes('fsq_category_ids=')));
  assert.match(urls[0].url, /ll=-8\.22%2C-34\.92/);
  assert.equal(urls[0].headers.authorization, 'Bearer K');
  assert.ok(urls[0].headers['x-places-api-version']);
});

test('Foursquare: con texto hace una sola consulta por relevancia', async () => {
  const urls = [];
  const fetchFn = async (url) => { urls.push(String(url)); return ok({ results: [place('a', 'Edf. Estação Atlântico Sul - Nova Barra', 1000)] }); };
  const list = await searchFoursquare({ lat: -8.22, lng: -34.92, radius: 5000, query: 'Edf Estação', key: 'K', fetchFn });
  assert.equal(list.length, 1);
  assert.equal(urls.length, 1);
  assert.match(urls[0], /query=Edf\+Esta/);
  assert.match(urls[0], /sort=RELEVANCE/);
});

test('Foursquare: clave rechazada, cupo agotado y caída dan errores claros', async () => {
  const status = (s) => async () => ({ ok: false, status: s, json: async () => ({}) });
  await assert.rejects(searchFoursquare({ lat: 0, lng: 0, key: 'K', fetchFn: status(401) }), (e) => e instanceof PlacesError && e.status === 502 && /clave/.test(e.message));
  await assert.rejects(searchFoursquare({ lat: 0, lng: 0, key: 'K', fetchFn: status(429) }), (e) => e.status === 429);
  await assert.rejects(searchFoursquare({ lat: 0, lng: 0, key: 'K', fetchFn: status(500) }), (e) => e.status === 502);
});

test('API /places: sin clave avisa que no está configurado, y con clave valida y consulta', async () => {
  const db = await openMemoryDb();
  const get = (qs) => handle({ method: 'GET', path: '/api/places', query: new URLSearchParams(qs), db });
  const realKey = process.env.FOURSQUARE_API_KEY;
  const realFetch = globalThis.fetch;
  try {
    delete process.env.FOURSQUARE_API_KEY;
    assert.deepEqual((await get('lat=-8.2&lng=-34.9')).body, { configured: false, results: [] });

    process.env.FOURSQUARE_API_KEY = 'K';
    assert.equal((await get('lat=abc&lng=-34.9')).status, 400);
    assert.equal((await get('lat=95&lng=-34.9')).status, 400);
    assert.equal((await get('')).status, 400);

    const urls = [];
    globalThis.fetch = async (url) => { urls.push(String(url)); return ok({ results: [place('a', 'Bar', 20)] }); };
    const r = await get('lat=-8.2&lng=-34.9&radius=99999');
    assert.equal(r.status, 200);
    assert.equal(r.body.configured, true);
    assert.deepEqual(r.body.results.map((p) => p.name), ['Bar']);
    assert.match(urls[0], /radius=500/); // sin texto el radio se limita a 500 m

    globalThis.fetch = async () => ({ ok: false, status: 429, json: async () => ({}) });
    assert.equal((await get('lat=-8.2&lng=-34.9')).status, 429);
  } finally {
    globalThis.fetch = realFetch;
    if (realKey === undefined) delete process.env.FOURSQUARE_API_KEY; else process.env.FOURSQUARE_API_KEY = realKey;
  }
});
