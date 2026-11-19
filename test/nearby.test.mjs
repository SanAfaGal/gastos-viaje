import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { _resetOverpass, knownPlaces, mergeCandidates, nearbyPlaces, parseOverpass, placeIcon, polygonCentroid, recentPlaces } from '../public/js/nearby.mjs';

beforeEach(() => _resetOverpass()); // Overpass caído se recuerda un rato: cada prueba empieza de cero

const REF = { lat: -8.05, lng: -34.9 };
const ok = (json) => ({ ok: true, status: 200, json: async () => json });
const bad = { ok: false, status: 504, json: async () => ({}) };
// ~0.000009° de latitud = 1 m
const at = (m, extra = {}) => ({ lat: REF.lat + m * 0.000009, lng: REF.lng, ...extra });
const exp = (id, date, m, place, extra = {}) => ({ id, date, created_at: `${date}T10:00:00Z`, place, ...at(m), ...extra });

test('knownPlaces: gastos a pocos metros son el mismo lugar y devuelve las coordenadas del más reciente', () => {
  const list = knownPlaces([
    exp(1, '2026-11-01', 5, 'Foco'),
    exp(2, '2026-11-03', 25, 'Foco'),
    exp(3, '2026-11-02', 10, ''),
  ], REF);
  assert.equal(list.length, 1);
  assert.equal(list[0].name, 'Foco');
  assert.equal(list[0].count, 3);
  assert.equal(list[0].lat, at(25).lat); // exacto, no un promedio
});

test('knownPlaces: toma el nombre más usado, ordena por cercanía y respeta el radio', () => {
  const list = knownPlaces([
    exp(1, '2026-11-01', 90, 'Lejos'),
    exp(2, '2026-11-01', 10, 'A'),
    exp(3, '2026-11-02', 11, 'B'),
    exp(4, '2026-11-03', 12, 'B'),
    exp(5, '2026-11-01', 400, 'Muy lejos'),
    { id: 6, date: '2026-11-01', lat: null, lng: null, place: 'Sin ubicación' },
  ], REF);
  assert.deepEqual(list.map((p) => p.name), ['B', 'Lejos']);
  assert.ok(list[0].km < list[1].km);
});

test('knownPlaces: sin gastos con ubicación no hay candidatos', () => {
  assert.deepEqual(knownPlaces([], REF), []);
  assert.deepEqual(knownPlaces([{ id: 1, date: '2026-11-01', lat: null, lng: null }], REF), []);
});

test('Overpass: lee nodos y centros, y descarta lo que no tiene nombre o coordenadas', () => {
  const list = parseOverpass({ elements: [
    { lat: -8.0501, lon: -34.9, tags: { name: 'Foco', shop: 'supermarket', 'addr:street': 'Av. Boa Viagem', 'addr:housenumber': '10' } },
    { center: { lat: -8.0502, lon: -34.9001 }, tags: { name: 'Mercado', amenity: 'marketplace' } },
    { lat: -8.0503, lon: -34.9, tags: {} },
    { tags: { name: 'Sin coordenadas' } },
  ] });
  assert.deepEqual(list.map((r) => r.name), ['Foco', 'Mercado']);
  assert.equal(list[0].detail, 'Supermercado · Av. Boa Viagem 10');
  assert.equal(list[0].kind, 'supermarket');
  assert.equal(list[1].lat, -8.0502);
  assert.match(placeIcon('supermarket'), /^<svg /); // icono SVG, no emoji
  assert.notEqual(placeIcon('supermarket'), placeIcon('cafe'));
  assert.equal(placeIcon('algo_raro'), placeIcon(undefined)); // un tipo desconocido cae al pin de lugar
  assert.equal(parseOverpass({ elements: [{ lat: 1, lon: 1, tags: { name: 'X', shop: 'yes', 'addr:street': 'Rua A' } }] })[0].detail, 'Rua A');
});

test('nearbyPlaces: usa Overpass, ordena por distancia y quita duplicados', async () => {
  const urls = [];
  const fetchFn = async (url) => {
    urls.push(String(url));
    return ok({ elements: [
      { lat: at(60).lat, lon: REF.lng, tags: { name: 'Lejos' } },
      { lat: at(5).lat, lon: REF.lng, tags: { name: 'Foco' } },
      { lat: at(6).lat, lon: REF.lng, tags: { name: 'foco' } },
    ] });
  };
  const { results, source } = await nearbyPlaces(REF, { fetchFn });
  assert.equal(source, 'overpass');
  assert.deepEqual(results.map((r) => r.name), ['Foco', 'Lejos']);
  assert.ok(results[0].km < 0.01);
  assert.match(urls[0], /overpass-api\.de/);
  assert.ok(urls.some((u) => /photon\.komoot\.io\/reverse/.test(u))); // Photon se pide a la vez, como respaldo
  assert.match(decodeURIComponent(urls[0]), /around:80,-8\.05,-34\.9/);
});

test('nearbyPlaces: si Overpass falla o viene vacío, usa Photon reverse', async () => {
  const photon = { features: [{ geometry: { coordinates: [REF.lng, at(8).lat] }, properties: { name: 'Padaria', city: 'Recife' } }] };
  for (const first of [bad, ok({ elements: [] })]) {
    _resetOverpass();
    const urls = [];
    const fetchFn = async (url) => { urls.push(String(url)); return urls.length === 1 ? first : ok(photon); };
    const { results, source } = await nearbyPlaces(REF, { fetchFn });
    assert.equal(source, 'photon');
    assert.equal(results[0].name, 'Padaria');
    assert.match(urls[1], /photon\.komoot\.io\/reverse\?/);
    assert.match(urls[1], /lat=-8\.05/);
  }
});

test('nearbyPlaces: la consulta excluye calles y límites, y Photon descarta calles', async () => {
  let overpassUrl = '';
  const photon = { features: [
    { geometry: { coordinates: [REF.lng, at(3).lat] }, properties: { name: 'Avenida Principal', osm_key: 'highway', osm_value: 'primary' } },
    { geometry: { coordinates: [REF.lng, at(9).lat] }, properties: { name: 'Edifício Miramar', osm_key: 'building', osm_value: 'residential' } },
  ] };
  const fetchFn = async (url) => { if (!overpassUrl) { overpassUrl = decodeURIComponent(String(url)); return bad; } return ok(photon); };
  const { results } = await nearbyPlaces(REF, { fetchFn });
  assert.match(overpassUrl, /\[!"highway"\]\[!"boundary"\]/);
  assert.deepEqual(results.map((r) => r.name), ['Edifício Miramar']);
});

test('nearbyPlaces: sin ninguna fuente lanza, y cancelar no cae al respaldo', async () => {
  await assert.rejects(nearbyPlaces(REF, { fetchFn: async () => { throw new Error('offline'); } }));
  const ctl = new AbortController();
  let calls = 0;
  const fetchFn = async (url, { signal }) => {
    calls += 1;
    ctl.abort();
    if (signal.aborted) throw Object.assign(new Error('abort'), { name: 'AbortError' });
    return ok({ elements: [] });
  };
  await assert.rejects(nearbyPlaces(REF, { fetchFn, signal: ctl.signal }), { name: 'AbortError' });
  assert.equal(calls, 1);
});

test('mergeCandidates: quita los sitios que ya salen como lugares usados', () => {
  const known = [{ name: 'Foco', ...at(5) }];
  const nearby = [{ name: 'foco', ...at(10) }, { name: 'Padaria', ...at(10) }, { name: 'Foco', ...at(500) }];
  assert.deepEqual(mergeCandidates(known, nearby).map((r) => r.name), ['Padaria', 'Foco']);
});

test('centroide: cuadrado, forma de L (la caja quedaría fuera del cuerpo) y contornos sin área', () => {
  const sq = [{ lat: 0, lon: 0 }, { lat: 0, lon: 2 }, { lat: 2, lon: 2 }, { lat: 2, lon: 0 }, { lat: 0, lon: 0 }];
  const c = polygonCentroid(sq);
  assert.ok(Math.abs(c.lat - 1) < 1e-9 && Math.abs(c.lng - 1) < 1e-9);
  const L = [{ lat: 0, lon: 0 }, { lat: 0, lon: 10 }, { lat: 2, lon: 10 }, { lat: 2, lon: 2 }, { lat: 10, lon: 2 }, { lat: 10, lon: 0 }, { lat: 0, lon: 0 }];
  const l = polygonCentroid(L);
  assert.ok(l.lat < 4 && l.lng < 4, JSON.stringify(l)); // el centro de la caja sería (5, 5): fuera de la L
  assert.deepEqual(polygonCentroid([{ lat: 1, lon: 1 }, { lat: 3, lon: 3 }]), { lat: 2, lng: 2 }); // línea abierta: promedio
  assert.equal(polygonCentroid([]), null);
  // giro contrario al reloj da lo mismo
  const rev = polygonCentroid([...sq].reverse());
  assert.ok(Math.abs(rev.lat - 1) < 1e-9 && Math.abs(rev.lng - 1) < 1e-9);
});

test('Overpass con geometría: usa el centroide del edificio; nodos y relaciones siguen funcionando', () => {
  const list = parseOverpass({ elements: [
    { type: 'way', tags: { name: 'Edf. L', building: 'yes' }, geometry: [{ lat: 0, lon: 0 }, { lat: 0, lon: 10 }, { lat: 2, lon: 10 }, { lat: 2, lon: 2 }, { lat: 10, lon: 2 }, { lat: 10, lon: 0 }, { lat: 0, lon: 0 }] },
    { type: 'node', lat: -8.05, lon: -34.9, tags: { name: 'Quiosco' } },
    { type: 'relation', bounds: { minlat: 1, maxlat: 3, minlon: 1, maxlon: 5 }, tags: { name: 'Mall' } },
  ] });
  assert.deepEqual(list.map((r) => [r.name, r.hasShape]), [['Edf. L', true], ['Quiosco', false], ['Mall', false]]);
  assert.ok(list[0].lat < 4); // no el centro de la caja (5)
  assert.deepEqual([list[2].lat, list[2].lng], [2, 3]);
});

test('recientes: los del mismo día primero, luego del más nuevo al más viejo; un lugar con varios gastos sale una vez', () => {
  const recent = recentPlaces([
    exp(1, '2026-11-10', 5, 'Foco'),
    exp(2, '2026-11-12', 500, 'Padaria'),
    exp(3, '2026-11-12', 504, 'Padaria', { created_at: '2026-11-12T18:00:00Z' }), // mismo lugar, otro pago
    exp(4, '2026-11-15', 1000, 'Museo'),
    exp(5, '2026-11-12', 2000, ''),
    { id: 6, date: '2026-11-16', lat: null, lng: null, place: 'Sin ubicación' },
  ], { date: '2026-11-12' });
  assert.deepEqual(recent.map((p) => p.name), ['Padaria', '', 'Museo', 'Foco']); // los de ese día primero (Padaria más nueva), luego Museo y Foco
  assert.deepEqual(recent.map((p) => p.today), [true, true, false, false]);
  assert.equal(recent[0].count, 2);
  assert.equal(recent[0].lat, at(504).lat); // coordenadas del gasto más reciente
});

test('recientes: sin fecha se ordena por lo más nuevo y se respeta el límite', () => {
  const list = [1, 2, 3, 4, 5, 6, 7].map((n) => exp(n, `2026-11-0${n}`, n * 300, `L${n}`));
  const r = recentPlaces(list, { limit: 3 });
  assert.deepEqual(r.map((p) => p.name), ['L7', 'L6', 'L5']);
  assert.ok(r.every((p) => p.today === false));
  assert.deepEqual(recentPlaces([]), []);
});

test('nearbyPlaces: Overpass y Photon van a la vez; si Photon llega antes avisa un resultado parcial y el final es el de Overpass', async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const photon = { features: [{ geometry: { coordinates: [REF.lng, at(8).lat] }, properties: { name: 'Padaria', osm_key: 'shop' } }] };
  const fetchFn = async (url) => {
    if (String(url).includes('overpass')) { await sleep(60); return ok({ elements: [{ lat: at(5).lat, lon: REF.lng, tags: { name: 'Foco' } }] }); }
    return ok(photon);
  };
  const partials = [];
  const final = await nearbyPlaces(REF, { fetchFn, onPartial: (p) => partials.push(p) });
  assert.equal(partials.length, 1);
  assert.equal(partials[0].source, 'photon');
  assert.deepEqual(partials[0].results.map((r) => r.name), ['Padaria']);
  assert.equal(final.source, 'overpass');
  assert.deepEqual(final.results.map((r) => r.name), ['Foco']);
});

test('nearbyPlaces: si Overpass falla, no se vuelve a esperar durante unos minutos (solo Photon)', async () => {
  const photon = { features: [{ geometry: { coordinates: [REF.lng, at(8).lat] }, properties: { name: 'Padaria', osm_key: 'shop' } }] };
  let overpassCalls = 0;
  const fetchFn = async (url) => {
    if (String(url).includes('overpass')) { overpassCalls += 1; throw new Error('HTTP 502'); }
    return ok(photon);
  };
  const first = await nearbyPlaces(REF, { fetchFn });
  assert.equal(first.source, 'photon');
  const second = await nearbyPlaces(REF, { fetchFn });
  assert.equal(second.source, 'photon');
  assert.equal(overpassCalls, 1); // la segunda vez ni lo intentó
});

test('nearbyPlaces: cancelar por el usuario no cuenta como caída de Overpass', async () => {
  const ctl = new AbortController();
  const aborting = async (url, { signal }) => {
    ctl.abort();
    if (signal.aborted) throw Object.assign(new Error('abort'), { name: 'AbortError' });
    return ok({ elements: [], features: [] });
  };
  await assert.rejects(nearbyPlaces(REF, { fetchFn: aborting, signal: ctl.signal }), { name: 'AbortError' });
  const fetchFn = async () => ok({ elements: [{ lat: -8.05, lon: -34.9, tags: { name: 'X' } }], features: [] });
  assert.equal((await nearbyPlaces(REF, { fetchFn })).source, 'overpass'); // sigue intentándolo
});
