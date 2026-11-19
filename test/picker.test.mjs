import test from 'node:test';
import assert from 'node:assert/strict';
import { buildList, combineNearby, confirmPlace, dedupeByName, normalizeName, preferOsm, rankSearch, selectionSummary, tapRadiusM } from '../public/js/picker.mjs';

const REF = { lat: -8.05, lng: -34.9 };
const at = (m, extra = {}) => ({ lat: REF.lat + m * 0.000009, lng: REF.lng, ...extra });

test('radio del toque: ~30 px según el zoom, entre 15 y 120 m', () => {
  assert.equal(tapRadiusM(19, -8), 15); // muy cerca: mínimo
  assert.ok(tapRadiusM(17, -8) > 15 && tapRadiusM(17, -8) < 120);
  assert.equal(tapRadiusM(15, -8), 120); // más lejos: máximo
  assert.ok(tapRadiusM(17, -8) > tapRadiusM(18, -8));
});

test('repetidos: mismo nombre cerca se une y se queda el primero; mismo nombre lejos no', () => {
  const list = dedupeByName([
    { name: 'Foco', ...at(0), id: 'fsq' },
    { name: ' foco ', ...at(10), id: 'osm' },
    { name: 'Foco', ...at(500), id: 'otro' },
    { name: 'Padaria', ...at(5) },
  ]);
  assert.deepEqual(list.map((r) => r.id ?? r.name), ['fsq', 'otro', 'Padaria']);
});

test('búsqueda: lo cercano primero con su distancia, lo lejano limitado y aparte', () => {
  const far = (n) => ({ name: `Lejos ${n}`, lat: 41.16, lng: -8.65 });
  const r = rankSearch([far(1), { name: 'B', ...at(300) }, far(2), { name: 'A', ...at(20) }, far(3), far(4)], REF);
  assert.deepEqual(r.near.map((x) => x.name), ['A', 'B']);
  assert.ok(r.near[0].km < r.near[1].km);
  assert.deepEqual(r.far.map((x) => x.name), ['Lejos 1', 'Lejos 2', 'Lejos 3']); // máximo 3
});

test('búsqueda: si no hay nada cerca, lo lejano es lo único y se muestra; sin referencia no se reordena', () => {
  const r = rankSearch([{ name: 'X', lat: 41.16, lng: -8.65 }, { name: 'Y', lat: 40, lng: -8 }], REF);
  assert.equal(r.near.length, 2);
  assert.deepEqual(r.far, []);
  const sinRef = rankSearch([{ name: 'Z', ...at(1) }, { name: 'W', ...at(2) }], null);
  assert.deepEqual(sinRef.near.map((x) => x.name), ['Z', 'W']);
});

test('lista: "Este punto" primero, luego usados y cercanos numerados seguidos', () => {
  const anchor = { ...at(0), source: 'gps', accuracy: 15 };
  const items = buildList({
    anchor,
    known: [{ name: 'Casa', ...at(5), km: 0.005, count: 2 }],
    nearby: [{ name: 'Bar', ...at(20), km: 0.02 }, { name: 'Padaria', ...at(30), km: 0.03 }],
    typed: '',
  });
  assert.deepEqual(items.map((i) => i.kind), ['point', 'known', 'near', 'near']);
  assert.deepEqual(items.map((i) => i.n), [undefined, 1, 2, 3]);
  assert.equal(new Set(items.map((i) => i.key)).size, 4); // llaves únicas para reconocer la fila elegida
  assert.equal(items[0].accuracy, 15);
  assert.deepEqual(buildList({ anchor: null }), []);
});

test('resumen del pie: nombre, o de dónde sale el punto con coordenadas', () => {
  assert.equal(selectionSummary(null).title, 'Nada elegido');
  const gps = selectionSummary({ kind: 'point', name: '', lat: -8.22424, lng: -34.92927, source: 'gps', accuracy: 15.4 });
  assert.equal(gps.title, 'Tu ubicación');
  assert.match(gps.sub, /-8\.22424/);
  assert.match(gps.sub, /±15 m/);
  assert.equal(selectionSummary({ kind: 'point', name: '', lat: 1, lng: 2, source: 'tap' }).title, 'Punto del mapa');
  const named = selectionSummary({ kind: 'point', name: 'Mi tienda', lat: 1, lng: 2, source: 'tap' });
  assert.equal(named.title, 'Mi tienda');
  assert.match(named.sub, /^Punto del mapa · /);
  const near = selectionSummary({ kind: 'near', name: 'Bar', detail: 'Beer Garden · Rua A', lat: 1, lng: 2 });
  assert.deepEqual(near, { title: 'Bar', sub: 'Beer Garden · Rua A' });
  assert.equal(selectionSummary({ kind: 'known', name: '', lat: 1, lng: 2 }).title, 'Sin nombre');
});

test('nombre al confirmar: el elegido o escrito gana aunque ya hubiera otro; sin nombre se conserva', () => {
  assert.equal(confirmPlace('Viejo', { name: 'Nuevo' }), 'Nuevo');
  assert.equal(confirmPlace('', { name: '  Edf. X  ' }), 'Edf. X');
  assert.equal(confirmPlace('Viejo', { name: '' }), 'Viejo');
  assert.equal(confirmPlace(undefined, { name: '' }), '');
  assert.equal(confirmPlace('', { name: 'x'.repeat(200) }).length, 120);
});

test('nombres: sin acentos ni el tipo de lugar, así "Edf." y "Edifício" son el mismo', () => {
  assert.equal(normalizeName('Edf. Estação Atlântico Sul - Nova Barra'), 'estacao atlantico sul nova barra');
  assert.equal(normalizeName('Edifício Estacao Atlantico Sul'), 'estacao atlantico sul');
  assert.equal(normalizeName('Condomínio Lady Sarisse'), 'lady sarisse');
  assert.equal(normalizeName('ED. Athenas'), 'athenas');
  assert.equal(normalizeName(undefined), '');
});

test('mismo lugar en Foursquare y OSM: se usa la posición de OSM y el de OSM no se repite', () => {
  const fsq = [
    { name: 'Edf. Athenas', ...at(40), approx: true, id: 'a' },
    { name: 'Padaria Sol', ...at(10), approx: true, id: 'b' },
    { name: 'Edf. Risoleta', ...at(400), approx: true, id: 'c' }, // mismo nombre pero demasiado lejos
  ];
  const osm = [
    { name: 'Edifício Athenas', ...at(0), hasShape: true },
    { name: 'Edifício Risoleta', ...at(0), hasShape: true },
    { name: 'Farmácia', ...at(5) },
  ];
  const r = preferOsm(fsq, osm);
  assert.deepEqual(r.fsq.map((x) => [x.id, x.merged ?? false, x.approx]), [['a', true, false], ['b', false, true], ['c', false, true]]);
  assert.equal(r.fsq[0].lat, at(0).lat); // posición de OSM
  assert.equal(r.fsq[0].name, 'Edf. Athenas'); // nombre de Foursquare
  assert.deepEqual(r.osm.map((x) => x.name), ['Edifício Risoleta', 'Farmácia']); // el de Athenas se unió
});

test('lista con posición ajustada: cambia las coordenadas de esa fila y no el resto', () => {
  const anchor = { ...at(0), source: 'tap', approx: false };
  const nearby = [{ name: 'Bar', ...at(20), km: 0.02, approx: true }];
  const base = buildList({ anchor, nearby });
  const adjusted = new Map([[base[1].key, { lat: -8.1, lng: -34.8 }]]);
  const items = buildList({ anchor, nearby, adjusted });
  assert.equal(items[1].lat, -8.1);
  assert.equal(items[1].adjusted, true);
  assert.equal(items[1].approx, false); // ya no es aproximada: la corrigió el usuario
  assert.equal(items[0].lat, anchor.lat); // el punto no cambió
  assert.equal(items[1].key, base[1].key); // la llave sigue igual
});

test('pie: avisa si la posición es aproximada o fue ajustada', () => {
  assert.match(selectionSummary({ kind: 'near', name: 'Bar', detail: 'Edificio', lat: 1, lng: 2, approx: true }).sub, /posición aproximada$/);
  assert.match(selectionSummary({ kind: 'near', name: 'Bar', detail: 'Edificio', lat: 1, lng: 2, adjusted: true }).sub, /posición ajustada$/);
  assert.match(selectionSummary({ kind: 'point', name: '', lat: 1, lng: 2, source: 'tap', adjusted: true }).sub, /posición ajustada$/);
});

test('sitios cercanos de dos fuentes: sin repetidos, sin los ya usados, con la posición de OSM y ordenados por cercanía', () => {
  const known = [{ name: 'Casa', ...at(5), km: 0.005 }];
  const osm = [{ name: 'Edifício Athenas', ...at(0), km: 0.04 }, { name: 'Casa', ...at(6), km: 0.006 }, { name: 'Farmácia', ...at(5), km: 0.005 }];
  const fsq = [
    { name: 'Edf. Athenas', ...at(40), km: 0.04, approx: true }, // mismo edificio que el de OSM
    { name: 'Padaria Sol', ...at(30), km: 0.03, approx: true },
    { name: 'Casa', ...at(5), km: 0.005, approx: true }, // ya es un lugar usado
  ];
  const list = combineNearby({ known, osm, fsq });
  assert.deepEqual(list.map((x) => x.name), ['Farmácia', 'Padaria Sol', 'Edifício Athenas']);
  assert.equal(list.find((x) => x.name === 'Padaria Sol').approx, true);
  assert.deepEqual(combineNearby({ known, osm: [], fsq: [] }), []);
  // llega primero Foursquare y después OSM: el resultado es el mismo
  assert.deepEqual(combineNearby({ known, osm: [], fsq }).map((x) => x.name), ['Padaria Sol', 'Edf. Athenas']);
});

test('llave de un sitio cercano: no cambia aunque otra fuente afine sus coordenadas', () => {
  const anchor = { ...at(0), source: 'gps' };
  const a = buildList({ anchor, nearby: [{ name: 'Bar', ...at(20), km: 0.02 }, { name: 'Bar', ...at(90), km: 0.09 }] });
  const b = buildList({ anchor, nearby: [{ name: 'Bar', ...at(23), km: 0.023 }, { name: 'Bar', ...at(88), km: 0.088 }] });
  assert.deepEqual(a.map((x) => x.key), b.map((x) => x.key));
  assert.equal(new Set(a.map((x) => x.key)).size, 3); // dos "Bar" distintos: llaves distintas
});
