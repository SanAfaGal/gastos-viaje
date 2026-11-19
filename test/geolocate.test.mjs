import test from 'node:test';
import assert from 'node:assert/strict';
import { readPosition, zoomForAccuracy } from '../public/js/geolocate.mjs';

// Un GPS falso: `quick` y `watch` son los callbacks que el código registró; el test decide cuándo y qué lecturas llegan.
function fakeGeo() {
  const g = { quick: null, watch: null, cleared: [], opts: {} };
  g.getCurrentPosition = (ok, err, opts) => { g.quick = { ok, err }; g.opts.quick = opts; };
  g.watchPosition = (ok, err, opts) => { g.watch = { ok, err }; g.opts.watch = opts; return 7; };
  g.clearWatch = (id) => g.cleared.push(id);
  return g;
}
const pos = (lat, lng, accuracy) => ({ coords: { latitude: lat, longitude: lng, accuracy } });
const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

test('GPS: una lectura rápida llega primero (se avisa ya) y la exacta la reemplaza y termina la espera', async () => {
  const geo = fakeGeo();
  const fixes = [];
  const p = readPosition({ onFix: (f) => fixes.push(f.accuracy) }, geo);
  assert.equal(geo.opts.quick.enableHighAccuracy, false); // la rápida acepta red o Wi-Fi
  assert.equal(geo.opts.quick.maximumAge, 30000); // y una lectura de hace menos de 30 s
  assert.equal(geo.opts.watch.enableHighAccuracy, true);
  assert.equal(geo.opts.watch.maximumAge, 0); // la exacta siempre es nueva
  geo.quick.ok(pos(6.17, -75.63, 800));
  geo.watch.ok(pos(6.1731, -75.6298, 12));
  assert.deepEqual(await p, { lat: 6.1731, lng: -75.6298, accuracy: 12 });
  assert.deepEqual(fixes, [800, 12]); // la pantalla vio las dos, la primera al instante
  assert.deepEqual(geo.cleared, [7]); // y la escucha se apagó
});

test('GPS: una lectura peor que la que ya hay no la reemplaza', async () => {
  const geo = fakeGeo();
  const fixes = [];
  const p = readPosition({ maxMs: 40, okAfterMs: 20, onFix: (f) => fixes.push(f.accuracy) }, geo);
  geo.watch.ok(pos(1, 1, 40));
  geo.watch.ok(pos(2, 2, 90));
  assert.deepEqual(await p, { lat: 1, lng: 1, accuracy: 40 }); // a los 20 ms ya había una de ±40 m (<= 60) y termina
  assert.deepEqual(fixes, [40]);
});

test('GPS: con solo una lectura aproximada espera hasta el tope y entrega esa', async () => {
  const geo = fakeGeo();
  const t0 = Date.now();
  const p = readPosition({ maxMs: 60, okAfterMs: 20 }, geo);
  geo.quick.ok(pos(6.2, -75.5, 3000)); // muy imprecisa: no basta para terminar antes
  const fix = await p;
  assert.equal(fix.accuracy, 3000);
  assert.ok(Date.now() - t0 >= 55, 'esperó el tiempo completo por una lectura mejor');
  assert.deepEqual(geo.cleared, [7]);
});

test('GPS: un error de señal no corta la espera si luego llega una lectura; permiso denegado sí', async () => {
  let geo = fakeGeo();
  let p = readPosition({ maxMs: 200 }, geo);
  geo.quick.err({ code: 3 });
  geo.watch.err({ code: 2 });
  await tick();
  geo.watch.ok(pos(3, 3, 10));
  assert.deepEqual(await p, { lat: 3, lng: 3, accuracy: 10 });

  geo = fakeGeo();
  p = readPosition({ maxMs: 200 }, geo);
  geo.watch.err({ code: 1 });
  await assert.rejects(p, (e) => e.code === 1);
  assert.deepEqual(geo.cleared, [7]);
});

test('GPS: sin ninguna lectura rechaza al llegar al tope con "se acabó el tiempo"', async () => {
  const geo = fakeGeo();
  await assert.rejects(readPosition({ maxMs: 30 }, geo), (e) => e.code === 3);
  assert.deepEqual(geo.cleared, [7]);
});

test('GPS: cancelar rechaza con code 0, apaga la escucha y una lectura tardía no hace nada', async () => {
  const geo = fakeGeo();
  const ctl = new AbortController();
  const fixes = [];
  const p = readPosition({ maxMs: 500, signal: ctl.signal, onFix: (f) => fixes.push(f) }, geo);
  ctl.abort();
  await assert.rejects(p, (e) => e.code === 0);
  geo.watch.ok(pos(1, 1, 5)); // llega tarde
  assert.deepEqual(fixes, []);
  assert.deepEqual(geo.cleared, [7]);
  // Ya cancelada de antemano: ni empieza.
  const g2 = fakeGeo();
  await assert.rejects(readPosition({ signal: ctl.signal }, g2), (e) => e.code === 0);
  assert.equal(g2.watch, null);
});

test('GPS: sin soporte del dispositivo, lecturas inválidas ignoradas y precisión ausente tomada como mala', async () => {
  await assert.rejects(readPosition({}, null), (e) => e.code === 2);

  const geo = fakeGeo();
  const p = readPosition({ maxMs: 30, okAfterMs: 10 }, geo);
  geo.watch.ok(null);
  geo.watch.ok({ coords: { latitude: NaN, longitude: 1, accuracy: 5 } });
  geo.watch.ok({ coords: { latitude: 4, longitude: 5 } }); // sin precisión
  const fix = await p;
  assert.deepEqual([fix.lat, fix.lng, fix.accuracy], [4, 5, 9999]);

  const broken = { getCurrentPosition() { throw new Error('bloqueado'); }, watchPosition() { return 1; }, clearWatch() {} };
  await assert.rejects(readPosition({}, broken), (e) => e.code === 2);
});

test('GPS: una lectura inmediata que ya es buena termina sin dejar la escucha encendida', async () => {
  const geo = fakeGeo();
  geo.getCurrentPosition = (ok) => ok(pos(9, 9, 5)); // el navegador responde al instante, antes de que exista la escucha
  assert.deepEqual(await readPosition({}, geo), { lat: 9, lng: 9, accuracy: 5 });
  assert.deepEqual(geo.cleared, [7]);
});

test('zoom: cerca si la lectura es buena, y se aleja cuando el círculo de error es grande', () => {
  assert.equal(zoomForAccuracy(10), 18);
  assert.equal(zoomForAccuracy(150), 18);
  assert.equal(zoomForAccuracy(null), 18);
  assert.equal(zoomForAccuracy(300), 16);
  assert.equal(zoomForAccuracy(1000), 14);
  assert.equal(zoomForAccuracy(100000), 12); // nunca más lejos del mínimo
  const zs = [10, 100, 400, 2000, 20000].map((m) => zoomForAccuracy(m));
  assert.deepEqual(zs, [...zs].sort((a, b) => b - a)); // a peor precisión, menos zoom
});

test('GPS: una lectura usable que se estanca termina pronto; una que sigue mejorando sigue esperando', async () => {
  // Estancada en ±120 m: termina a los stallMs, mucho antes del tope.
  let geo = fakeGeo();
  let t0 = Date.now();
  let p = readPosition({ maxMs: 2000, okAfterMs: 1500, stallMs: 40 }, geo);
  geo.watch.ok(pos(1, 1, 120));
  assert.equal((await p).accuracy, 120);
  assert.ok(Date.now() - t0 < 500, 'no esperó el tope');

  // Mejorando (cada lectura reinicia el reloj): sigue hasta llegar a una buena.
  geo = fakeGeo();
  p = readPosition({ maxMs: 2000, okAfterMs: 1500, stallMs: 60 }, geo);
  geo.watch.ok(pos(1, 1, 140));
  await tick(30);
  geo.watch.ok(pos(1, 1, 110));
  await tick(30);
  geo.watch.ok(pos(1, 1, 80));
  await tick(30);
  geo.watch.ok(pos(1, 1, 20)); // buena: termina
  assert.equal((await p).accuracy, 20);

  // Una lectura aproximada (a kilómetros) no cuenta como estancada: se espera al tope por si el GPS responde.
  geo = fakeGeo();
  t0 = Date.now();
  p = readPosition({ maxMs: 120, okAfterMs: 50, stallMs: 20 }, geo);
  geo.quick.ok(pos(6, -75, 2500));
  assert.equal((await p).accuracy, 2500);
  assert.ok(Date.now() - t0 >= 100, 'esperó el tiempo completo');

  // ±50 m a los okAfterMs ya basta (antes hacía falta ±60 y ahora el umbral es más exigente: ±55 sigue esperando).
  geo = fakeGeo();
  p = readPosition({ maxMs: 400, okAfterMs: 30, stallMs: 1000, stallM: 0 }, geo);
  geo.watch.ok(pos(1, 1, 49));
  t0 = Date.now();
  assert.equal((await p).accuracy, 49);
  assert.ok(Date.now() - t0 < 200);
});
