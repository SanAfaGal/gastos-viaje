import test from 'node:test';
import assert from 'node:assert/strict';
import { openMemoryDb } from '../src/db.mjs';
import { handle } from '../src/handlers.mjs';
import { isAllowedMapUrl, resolveMapLink } from '../src/maplink.mjs';
import { googleMapsUrl, isBareShortPlusCode, isShortMapLink, parseCoordinates, parsePlusCode, shortPlusCodeWithPlace } from '../public/js/geosearch.mjs';

delete process.env.APP_PASSCODE;
delete process.env.TURSO_DATABASE_URL;
delete process.env.TURSO_AUTH_TOKEN;

// ---- Plus Codes ----

test('Plus Code completo: el ejemplo de Google (Mountain View) y uno de Suiza', () => {
  const g = parsePlusCode('849VCWC8+R9');
  assert.ok(Math.abs(g.lat - 37.4221) < 0.0005 && Math.abs(g.lng + 122.0841) < 0.0005, JSON.stringify(g));
  const z = parsePlusCode('8FVC9G8F+6W');
  assert.ok(Math.abs(z.lat - 47.3656) < 0.0005 && Math.abs(z.lng - 8.5248) < 0.0005, JSON.stringify(z));
  assert.deepEqual(parsePlusCode('849vcwc8+r9'), g); // en minúsculas, igual
  assert.deepEqual(parsePlusCode('849VCWC8+R9 Mountain View, California'), g); // con la localidad al final
});

test('Plus Code corto: se completa con el punto de referencia más cercano y sin referencia no se adivina', () => {
  const full = parsePlusCode('849VCWC8+R9');
  assert.deepEqual(parsePlusCode('CWC8+R9', { ref: { lat: 37.39, lng: -122.08 } }), full);
  assert.deepEqual(parsePlusCode('CWC8+R9 Mountain View', { ref: { lat: 37.4, lng: -122.1 } }), full);
  assert.equal(parsePlusCode('CWC8+R9'), null);
  // Con referencia en otra ciudad el mismo código corto cae allí (por eso hace falta la referencia).
  const medellin = parsePlusCode('CWC8+R9', { ref: { lat: 6.2, lng: -75.57 } });
  assert.ok(Math.abs(medellin.lat - 6.2) < 1 && Math.abs(medellin.lng + 75.57) < 1, JSON.stringify(medellin));
});

test('Plus Code: lo que no lo es no se toma por uno', () => {
  for (const t of ['', 'hola', '8FVC9G8F', '8FVC9G8F+', '8FVC9G8F+6', 'AAAA+22', 'Calle 10 + 5', '123+456', '849VCWC8+R9X!', 'https://www.google.com/maps/place/Foo+Bar']) {
    assert.equal(parsePlusCode(t, { ref: { lat: 0, lng: 0 } }), null, t);
  }
  assert.deepEqual(parseCoordinates('6.1732244, -75.62967'), { lat: 6.1732244, lng: -75.62967 }); // lo de siempre sigue igual
  assert.deepEqual(parseCoordinates('8FVC9G8F+6W').lat.toFixed(3), '47.366');
});

test('isShortMapLink: solo los enlaces cortos de Google', () => {
  assert.equal(isShortMapLink('https://maps.app.goo.gl/AbC123xyz'), true);
  assert.equal(isShortMapLink(' https://goo.gl/maps/AbC123 '), true);
  assert.equal(isShortMapLink('https://g.co/kgs/abc'), true);
  assert.equal(isShortMapLink('https://www.google.com/maps/place/X/@1,2,3z'), false);
  assert.equal(isShortMapLink('https://maps.app.goo.gl.evil.com/x'), false);
  assert.equal(isShortMapLink('texto https://maps.app.goo.gl/x'), false);
});

// ---- enlaces cortos ----

test('hosts permitidos: solo Google y por https', () => {
  for (const u of ['https://maps.app.goo.gl/abc', 'https://goo.gl/maps/abc', 'https://g.co/kgs/abc', 'https://www.google.com/maps/place/X', 'https://www.google.com.co/maps', 'https://consent.google.com/ml?continue=x']) {
    assert.equal(isAllowedMapUrl(u), true, u);
  }
  for (const u of ['http://maps.app.goo.gl/abc', 'https://evil.com/maps', 'https://maps.app.goo.gl.evil.com/x', 'https://goo.gl/otra', 'https://g.co/otra', 'https://user:pw@maps.app.goo.gl/x',
    'https://google.evil.com/maps', 'https://www.google.evil.com/', 'https://maps.google.com.evil.com/', 'https://google.com.evil.io/', 'https://consent.google.evil.org/',
    'https://evilgoogle.com/', 'https://google.com./x', 'https://google.xyz.co/',
    'https://maps.app.goo.gl:8443/x', 'https://127.0.0.1/', 'https://localhost/', 'ftp://maps.app.goo.gl/x', 'no es url', '']) {
    assert.equal(isAllowedMapUrl(u), false, u);
  }
});

const redirect = (to) => ({ ok: false, status: 302, headers: new Headers({ location: to }), json: async () => ({}) });
const page = { ok: true, status: 200, headers: new Headers(), json: async () => ({}) };

test('enlace corto: sigue la redirección hasta la URL larga y saca el pin exacto y el nombre', async () => {
  const seen = [];
  const fetchFn = async (url, init) => {
    seen.push([String(url), init.redirect]);
    if (String(url).startsWith('https://maps.app.goo.gl/')) return redirect('https://www.google.com/maps/place/Samaria+Apartamentos/@-8.05,-34.9,17z/data=!3m1!4b1!4m6!3m5!1s0x0:0x0!8m2!3d-8.0512!4d-34.9011');
    return page;
  };
  const r = await resolveMapLink('https://maps.app.goo.gl/AbC123', { fetchFn });
  assert.deepEqual([r.lat, r.lng, r.name], [-8.0512, -34.9011, 'Samaria Apartamentos']);
  assert.equal(seen.length, 1); // en cuanto la URL trae coordenadas no hace falta abrirla
  assert.equal(seen[0][1], 'manual'); // las redirecciones las sigue el servidor, una a una
});

test('enlace corto: pasa por la página de consentimiento, y sin coordenadas devuelve al menos el nombre', async () => {
  const fetchFn = async (url) => {
    const u = String(url);
    if (u.startsWith('https://maps.app.goo.gl/')) return redirect('https://consent.google.com/ml?continue=https%3A%2F%2Fwww.google.com%2Fmaps%2Fplace%2FEdif%2BAtl%C3%A2ntico%2Fdata%3D!4m2');
    return page;
  };
  const r = await resolveMapLink('https://maps.app.goo.gl/zzz', { fetchFn });
  assert.equal(r.lat, undefined);
  assert.equal(r.name, 'Edif Atlântico');
  assert.match(r.url, /^https:\/\/www\.google\.com\/maps\/place\//);
});

test('enlace corto: rechaza hosts ajenos, redirecciones hacia fuera, bucles y caídas', async () => {
  await assert.rejects(resolveMapLink('https://evil.com/x', { fetchFn: async () => page }), (e) => e.status === 400);
  await assert.rejects(resolveMapLink('https://maps.app.goo.gl/x', { fetchFn: async () => redirect('https://evil.com/steal') }), (e) => e.status === 502);
  await assert.rejects(resolveMapLink('https://maps.app.goo.gl/x', { fetchFn: async () => redirect('http://169.254.169.254/latest') }), (e) => e.status === 502);
  await assert.rejects(resolveMapLink('https://maps.app.goo.gl/x', { fetchFn: async () => { throw new TypeError('sin red'); } }), (e) => e.status === 502);
  let n = 0;
  const loop = async () => { n += 1; return redirect(`https://maps.app.goo.gl/${n}`); };
  const r = await resolveMapLink('https://maps.app.goo.gl/x', { fetchFn: loop });
  assert.equal(r.lat, undefined);
  assert.ok(n <= 6, `siguió ${n} redirecciones`); // tope de redirecciones
});

test('API /resolve-place: valida el enlace y responde con las coordenadas', async () => {
  const db = await openMemoryDb();
  const get = (qs) => handle({ method: 'GET', path: '/api/resolve-place', query: new URLSearchParams(qs), db });
  assert.equal((await get('')).status, 400);
  assert.equal((await get('url=https://evil.com/x')).status, 400);
  const real = globalThis.fetch;
  globalThis.fetch = async () => redirect('https://www.google.com/maps/@6.2,-75.57,15z');
  try {
    const r = await get('url=https://maps.app.goo.gl/abc');
    assert.equal(r.status, 200);
    assert.deepEqual([r.body.lat, r.body.lng], [6.2, -75.57]);
  } finally { globalThis.fetch = real; }
});

test('Plus Code corto con ciudad: se separa el código de la ciudad y la ciudad sirve de referencia', () => {
  assert.deepEqual(shortPlusCodeWithPlace('59FC+73 Itagüi, Antioquia, Colombia'), { code: '59FC+73', place: 'Itagüi, Antioquia, Colombia' });
  assert.deepEqual(shortPlusCodeWithPlace('  59fc+73,   Itagüí '), { code: '59FC+73', place: 'Itagüí' });
  assert.equal(shortPlusCodeWithPlace('59FC+73'), null); // sin ciudad
  assert.equal(shortPlusCodeWithPlace('67R659FC+73 Itagüí'), null); // el completo no necesita ciudad
  assert.equal(shortPlusCodeWithPlace('hola Itagüí'), null);

  // Con la ciudad como referencia el código cae en Samaria. Con otra referencia (el último gasto en Recife) caía al mar.
  const itagui = { lat: 6.1725, lng: -75.61 };
  const samaria = parsePlusCode('59FC+73', { ref: itagui });
  assert.ok(Math.abs(samaria.lat - 6.1732) < 0.001 && Math.abs(samaria.lng + 75.6298) < 0.001, JSON.stringify(samaria));
  const recife = parsePlusCode('59FC+73', { ref: { lat: -8.119, lng: -34.903 } });
  assert.ok(Math.abs(recife.lat - 6.1732) > 5, 'con una referencia lejana el código corto se completa en otro lugar');
  // La referencia solo importa dentro de ~50 km: cualquier punto de la ciudad sirve.
  assert.deepEqual(parsePlusCode('59FC+73', { ref: { lat: 6.2442, lng: -75.5812 } }), samaria);
});

test('Plus Code corto sin ciudad se reconoce para pedir la ciudad, y el completo o con ciudad no', () => {
  assert.equal(isBareShortPlusCode('59FC+73'), true);
  assert.equal(isBareShortPlusCode('  59fc+73 '), true);
  assert.equal(isBareShortPlusCode('9G8F+6W'), true);
  assert.equal(isBareShortPlusCode('59FC+73 Itagüí'), false); // con ciudad se completa solo
  assert.equal(isBareShortPlusCode('67R659FC+73'), false); // el completo no necesita ciudad
  assert.equal(isBareShortPlusCode('6.17, -75.62'), false);
  assert.equal(isBareShortPlusCode('hola'), false);
  assert.equal(isBareShortPlusCode(null), false);
});

test('Abrir Google Maps: centrado donde se está mirando, o Google Maps a secas sin punto', () => {
  assert.equal(googleMapsUrl({ lat: 6.1731571, lng: -75.6297989 }), 'https://www.google.com/maps/@6.173157,-75.629799,17z');
  assert.equal(googleMapsUrl({ lat: -8.119, lng: -34.903 }, 15), 'https://www.google.com/maps/@-8.119000,-34.903000,15z');
  assert.equal(googleMapsUrl(null), 'https://www.google.com/maps');
  assert.equal(googleMapsUrl({ lat: 99, lng: 0 }), 'https://www.google.com/maps'); // punto inválido
  assert.equal(googleMapsUrl({ lat: NaN, lng: 0 }), 'https://www.google.com/maps');
  // La dirección generada la entiende el propio lector de enlaces: ida y vuelta.
  assert.deepEqual(parseCoordinates(googleMapsUrl({ lat: 6.17, lng: -75.62 })), { lat: 6.17, lng: -75.62 });
});
