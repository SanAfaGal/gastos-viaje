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

// Coordenadas pegadas en el buscador: "6.1732244, -75.62967" o un enlace largo de Google Maps. Devuelve { lat, lng, name? } o null.
// Google sabe lugares (y números de puerta) que OpenStreetMap no tiene: se abre el lugar allí, se copian las coordenadas y se pegan aquí.
// Los enlaces cortos (maps.app.goo.gl) no sirven: no traen coordenadas hasta que el navegador los abre.
export function parseCoordinates(text) {
  const t = String(text ?? '').trim();
  if (!t) return null;
  const done = (lat, lng, name) => (valid(lat, lng) ? { lat, lng, ...(name ? { name } : {}) } : null);
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
