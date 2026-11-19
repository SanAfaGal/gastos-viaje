// Búsqueda de lugares por nombre que prefiere lo que está cerca. Módulo sin DOM: el navegador y las pruebas lo usan.
//
// Una búsqueda como "Foco" existe en muchos países; sin saber dónde estás, el buscador devuelve lo más "famoso".
// Por eso se busca con una referencia (tu ubicación o el lugar que se ve en el mapa):
//  1. Photon (komoot, datos de OpenStreetMap) con sesgo hacia la referencia: sirve para escribir y ver sugerencias.
//  2. Si falla, Nominatim primero dentro de unos 30 km alrededor de la referencia y, si no hay nada, en todo el mundo.
// Los resultados cercanos (hasta NEAR_KM) van primero y cada uno trae su distancia.

const NEAR_KM = 50;

const rad = (d) => (d * Math.PI) / 180;

export function distanceKm(a, b) {
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.min(1, Math.sqrt(h)));
}

// "850 m", "2,4 km", "38 km", "1.250 km"
export function formatDistance(km) {
  if (km < 1) return `${Math.max(10, Math.round((km * 1000) / 10) * 10)} m`;
  if (km < 10) return `${km.toFixed(1).replace('.', ',')} km`;
  return `${Math.round(km).toLocaleString('es-CO')} km`;
}

const valid = (lat, lng) => Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;

const num = (s) => (s == null ? NaN : Number(String(s).replace(',', '.')));

// --- Plus Codes (Open Location Code): "8FVC9G8F+6W", o corto "9G8F+6W Medellín" (necesita un punto de referencia cercano) ---
const OLC = '23456789CFGHJMPQRVWX';
const OLC_RE = /^([23456789CFGHJMPQRVWX]{4,8})\+([23456789CFGHJMPQRVWX]{2,})(?=$|[\s,])/i;

// Código completo (8 caracteres antes del +) -> centro del recuadro que describe. Los códigos con más dígitos son más precisos.
function decodeFull(code) {
  const digits = code.replace('+', '').toUpperCase();
  let lat = -90;
  let lng = -180;
  let size = 20;
  const pairs = Math.min(digits.length, 10);
  for (let i = 0; i < pairs; i += 2) {
    lat += OLC.indexOf(digits[i]) * size;
    lng += OLC.indexOf(digits[i + 1]) * size;
    if (i + 2 < pairs) size /= 20;
  }
  let latSize = size;
  let lngSize = size;
  for (let i = 10; i < digits.length; i += 1) { // dígitos de cuadrícula: el recuadro se parte en 5 filas x 4 columnas
    const d = OLC.indexOf(digits[i]);
    latSize /= 5;
    lngSize /= 4;
    lat += Math.floor(d / 4) * latSize;
    lng += (d % 4) * lngSize;
  }
  return { lat: lat + latSize / 2, lng: lng + lngSize / 2 };
}

// Primeros `n` caracteres (pares lat/lng) del código del punto de referencia.
function encodePrefix(lat, lng, n) {
  let l = Math.min(Math.max(lat, -90), 90 - 1e-9) + 90;
  let g = lng + 180;
  let size = 20;
  let out = '';
  for (let i = 0; i < n / 2; i += 1) {
    const a = Math.floor(l / size);
    const b = Math.floor(g / size);
    out += OLC[a] + OLC[b];
    l -= a * size;
    g -= b * size;
    size /= 20;
  }
  return out;
}

// Plus Code -> { lat, lng } o null. Un código corto ("9G8F+6W") se completa con el punto de referencia: el lugar más cercano a él.
export function parsePlusCode(text, { ref } = {}) {
  const m = String(text ?? '').trim().match(OLC_RE);
  if (!m) return null;
  const head = m[1];
  if (head.length % 2 !== 0) return null;
  const code = `${head}+${m[2]}`;
  if (head.length === 8) {
    const p = decodeFull(code);
    return valid(p.lat, p.lng) ? p : null;
  }
  if (!ref || !valid(ref.lat, ref.lng)) return null;
  const padding = 8 - head.length;
  const full = decodeFull(`${encodePrefix(ref.lat, ref.lng, padding)}${code}`);
  const resolution = 20 ** (2 - padding / 2);
  const half = resolution / 2;
  let { lat, lng } = full;
  if (ref.lat + half < lat && lat - resolution >= -90) lat -= resolution;
  else if (ref.lat - half > lat && lat + resolution <= 90) lat += resolution;
  if (ref.lng + half < lng) lng -= resolution;
  else if (ref.lng - half > lng) lng += resolution;
  return valid(lat, lng) ? { lat, lng } : null;
}

// Plus Code corto con la ciudad escrita después ("59FC+73 Itagüí, Antioquia, Colombia") -> { code, place }, o null si no es un código corto
// con ciudad. Un código corto solo dice dónde está dentro de su zona (unos 50 km), así que hace falta ubicar esa ciudad primero y
// completar el código con ella: usar el mapa o el último gasto, que pueden estar en otro país, lo mandaría a cualquier parte.
export function shortPlusCodeWithPlace(text) {
  const t = String(text ?? '').trim();
  const m = t.match(OLC_RE);
  if (!m || m[1].length >= 8 || m[1].length % 2) return null;
  const place = t.slice(m[0].length).replace(/^[\s,]+/, '').trim();
  return place ? { code: `${m[1]}+${m[2]}`.toUpperCase(), place } : null;
}

// Plus Code corto sin ciudad ("59FC+73"): solo dice dónde está dentro de su zona, así que sin la ciudad no se puede completar con seguridad.
export const isBareShortPlusCode = (text) => {
  const m = String(text ?? '').trim().match(OLC_RE);
  return Boolean(m) && m[1].length < 8 && m[1].length % 2 === 0 && String(text).trim().length === m[0].length;
};

// Dirección de Google Maps centrada en un punto (sin pin): ahí se busca el lugar y se copia el enlace, las coordenadas o el Plus Code.
// Sin punto, abre Google Maps a secas.
export const googleMapsUrl = (at, zoom = 17) => (valid(at?.lat, at?.lng) ? `https://www.google.com/maps/@${at.lat.toFixed(6)},${at.lng.toFixed(6)},${zoom}z` : 'https://www.google.com/maps');

// ¿Es un enlace corto de Google Maps (que solo el servidor puede abrir)? No trae coordenadas hasta seguir su redirección.
export const isShortMapLink = (text) => /^https:\/\/(?:maps\.app\.goo\.gl\/|goo\.gl\/maps\/|g\.co\/kgs\/)\S+$/i.test(String(text ?? '').trim());

// Coordenadas pegadas en el buscador: "6.1732244, -75.62967", un enlace largo de Google Maps o un Plus Code. Devuelve { lat, lng, name? } o null.
// Google sabe lugares (y números de puerta) que OpenStreetMap no tiene: se abre el lugar allí, se copian las coordenadas y se pegan aquí.
// Los enlaces cortos (maps.app.goo.gl) no se resuelven aquí: no traen coordenadas hasta seguir su redirección (ver isShortMapLink y /api/resolve-place).
// `ref` ({ lat, lng }) solo hace falta para un Plus Code corto.
export function parseCoordinates(text, { ref } = {}) {
  const t = String(text ?? '').trim();
  if (!t) return null;
  const done = (lat, lng, name) => (valid(lat, lng) ? { lat, lng, ...(name ? { name } : {}) } : null);
  const plus = parsePlusCode(t, { ref });
  if (plus) return plus;
  if (/^https?:\/\//i.test(t)) {
    let decoded = t;
    try { decoded = decodeURIComponent(t); } catch { /* queda el texto crudo */ }
    const pin = decoded.match(/!3d(-?\d+(?:\.\d+)?)!4d(-?\d+(?:\.\d+)?)/); // el pin exacto del lugar
    const query = decoded.match(/[?&](?:q|ll|query|destination)=(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)/);
    const view = decoded.match(/@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/); // el centro de la vista: casi siempre el mismo sitio
    const m = pin ?? query ?? view;
    if (!m) return null;
    const place = decoded.match(/\/place\/([^/@?]+)/);
    const name = place ? place[1].replace(/\+/g, ' ').split(',')[0].trim().slice(0, 120) : '';
    return done(Number(m[1]), Number(m[2]), name);
  }
  // Grados, minutos y segundos como los muestra Google Maps: 8°13'31.2"S 34°56'34.7"W (S y W son negativos).
  const part = String.raw`(\d{1,3})\s*°\s*(?:(\d{1,2})\s*['′’]\s*)?(?:(\d{1,2}(?:\.\d+)?)\s*(?:["″”]|'')\s*)?([NSEW])`;
  const dms = t.match(new RegExp(String.raw`^${part}[\s,;]*${part}$`, 'i'));
  if (dms) {
    const sign = (h) => (/[SW]/i.test(h) ? -1 : 1);
    const toDeg = (d, m, sec, h) => sign(h) * (Number(d) + Number(m ?? 0) / 60 + Number(sec ?? 0) / 3600);
    if (/[NS]/i.test(dms[4]) === /[NS]/i.test(dms[8])) return null; // los dos son latitud o los dos longitud
    const a = toDeg(dms[1], dms[2], dms[3], dms[4]);
    const b = toDeg(dms[5], dms[6], dms[7], dms[8]);
    return /[NS]/i.test(dms[4]) ? done(a, b) : done(b, a);
  }
  // Un par de números, los dos con decimales: así "65 36" o "36-61" (números de una dirección) no se toman por coordenadas.
  const m = t.match(/^(-?\d{1,2}\.\d+)\s*°?\s*[,;\s]\s*(-?\d{1,3}\.\d+)\s*°?$/);
  return m ? done(num(m[1]), num(m[2])) : null;
}

// Nombre para un punto sin nombre, a partir de lo que Photon sabe de ese sitio: la dirección ("Carrera 65 36-61"), que es lo que identifica
// un punto; si no hay calle, el barrio o la ciudad; y solo si no hay nada más, el nombre del sitio más cercano (puede ser un negocio vecino,
// así que va de último). Devuelve null si Photon no sabe nada de ese punto.
export function addressName(json) {
  for (const f of json?.features ?? []) {
    const p = f?.properties ?? {};
    const street = p.street ? [p.street, p.housenumber].filter(Boolean).join(' ') : ''; // un número sin calle no dice nada
    const where = p.district ?? p.locality ?? p.city ?? p.county;
    const name = street || (p.name && !p.housenumber ? p.name : '') || where;
    if (name) return String(street && p.city && !p.housenumber ? `${street}, ${p.city}` : name).slice(0, 120);
  }
  return null;
}

// Pide a Photon (gratis, sin clave) cómo se llama el sitio de un punto. Devuelve el nombre o null (sin red, sin datos).
export async function reverseAddress(ref, { fetchFn = fetch, signal } = {}) {
  try {
    const params = new URLSearchParams({ lat: String(ref.lat), lon: String(ref.lng), limit: '1', lang: 'default' });
    return addressName(await get(fetchFn, `https://photon.komoot.io/reverse?${params}`, signal));
  } catch (err) {
    if (err?.name === 'AbortError') throw err;
    return null;
  }
}

export function parsePhoton(json) {
  const out = [];
  for (const f of json?.features ?? []) {
    const [lng, lat] = f?.geometry?.coordinates ?? [];
    const p = f?.properties ?? {};
    if (!valid(lat, lng) || !p.name) continue;
    const street = [p.street, p.housenumber].filter(Boolean).join(' ');
    const detail = [street, p.district, p.city ?? p.county, p.state, p.country].filter((x, i, a) => x && a.indexOf(x) === i).join(', ');
    out.push({ name: String(p.name), detail, lat, lng, kind: p.osm_value ? String(p.osm_value) : '', key: p.osm_key ? String(p.osm_key) : '' });
  }
  return out;
}

export function parseNominatim(json) {
  const out = [];
  for (const r of Array.isArray(json) ? json : []) {
    const lat = Number(r.lat);
    const lng = Number(r.lon);
    if (!valid(lat, lng)) continue;
    const full = String(r.display_name ?? '');
    const name = r.name || full.split(',')[0];
    out.push({ name, detail: full.startsWith(name) ? full.slice(name.length).replace(/^,\s*/, '') : full, lat, lng });
  }
  return out;
}

// Pone primero lo cercano (respetando el orden del buscador) y agrega la distancia a cada resultado.
export function rankByNearby(results, ref, maxKm = NEAR_KM) {
  if (!ref) return results.map((r) => ({ ...r, km: null }));
  const withKm = results.map((r) => ({ ...r, km: distanceKm(ref, r) }));
  return [...withKm.filter((r) => r.km <= maxKm), ...withKm.filter((r) => r.km > maxKm)];
}

const get = async (fetchFn, url, signal) => {
  const res = await fetchFn(url, { signal });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
};

// Devuelve { results, source } con hasta `limit` lugares. `ref` = { lat, lng } o null. Lanza si ninguna fuente responde.
export async function searchPlaces(query, { ref = null, limit = 8, fetchFn = fetch, signal } = {}) {
  const q = String(query ?? '').trim();
  if (q.length < 2) return { results: [], source: null };
  try {
    const params = new URLSearchParams({ q, limit: String(limit), lang: 'default' });
    if (ref) { params.set('lat', String(ref.lat)); params.set('lon', String(ref.lng)); params.set('location_bias_scale', '0.3'); }
    const found = parsePhoton(await get(fetchFn, `https://photon.komoot.io/api/?${params}`, signal));
    return { results: rankByNearby(found, ref), source: 'photon' };
  } catch (err) {
    if (err?.name === 'AbortError') throw err;
  }
  const base = { q, format: 'jsonv2', limit: String(limit), 'accept-language': 'es' };
  const nominatim = async (extra) => parseNominatim(await get(fetchFn, `https://nominatim.openstreetmap.org/search?${new URLSearchParams({ ...base, ...extra })}`, signal));
  let found = [];
  if (ref) {
    const d = 0.3; // ~33 km de lado a lado
    found = await nominatim({ viewbox: [ref.lng - d, ref.lat + d, ref.lng + d, ref.lat - d].join(','), bounded: '1' });
  }
  if (!found.length) found = await nominatim({});
  return { results: rankByNearby(found, ref), source: 'nominatim' };
}
