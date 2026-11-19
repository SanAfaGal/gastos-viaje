// Segunda fuente de lugares: Foursquare Places. Se consulta desde el servidor para que la clave (FOURSQUARE_API_KEY) nunca llegue
// al navegador. OpenStreetMap es la fuente principal; esta sirve cuando un edificio o negocio no está allí (por ejemplo,
// "Edf. Estação Atlântico Sul" no está en OpenStreetMap, pero sí en Foursquare).
//
// Dos hallazgos de las pruebas con la API real:
//  - Una búsqueda por cercanía sin texto NO devuelve edificios (solo negocios). Para verlos hay que pedirlos por categoría.
//  - Con texto, "Edf Estação Atlântico Sul" lo encuentra pero "Estação Atlântico Sul" no: el texto debe parecerse al nombre completo.

const URL_SEARCH = 'https://places-api.foursquare.com/places/search';
const VERSION = '2025-06-17';
// Structure, Apartment or Condo, Residential Building: los edificios (de viviendas y de oficinas) que no salen sin pedirlos.
const BUILDING_CATEGORIES = '4bf58dd8d48988d130941735,4d954b06a243a5684965b473,4e67e38e036454776db1fb3a';
const CATEGORY_ES = {
  Structure: 'Edificio', 'Apartment or Condo': 'Edificio', 'Residential Building (Apartment / Condo)': 'Edificio',
  Office: 'Oficina', 'Coworking Space': 'Coworking', 'Shopping Mall': 'Centro comercial', Pizzeria: 'Pizzería',
  Restaurant: 'Restaurante', Café: 'Café', Cafe: 'Café', Pharmacy: 'Farmacia', Supermarket: 'Supermercado', Bakery: 'Panadería',
  Bar: 'Bar', Hotel: 'Hotel', 'Gas Station': 'Gasolinera', 'Convenience Store': 'Tienda',
};

// Foursquare también devuelve calles, barrios y ciudades: no son un lugar donde se compra.
const NOT_VENUES = new Set(['Road', 'Street', 'Intersection', 'Highway', 'Bridge', 'Neighborhood', 'City', 'State', 'Country', 'Town', 'Village']);

export class PlacesError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// Respuesta de Foursquare -> [{ id, name, detail, lat, lng, m }] (m = metros hasta el punto buscado, si los trae).
export function parseFoursquare(json) {
  const out = [];
  for (const r of json?.results ?? []) {
    const lat = r?.latitude == null ? NaN : Number(r.latitude); // Number(null) es 0: un lugar sin coordenadas no debe quedar en 0,0
    const lng = r?.longitude == null ? NaN : Number(r.longitude);
    if (!r?.name || !Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) continue;
    const cat = r.categories?.[0]?.name ?? '';
    if (NOT_VENUES.has(cat)) continue;
    const where = r.location?.address || r.location?.locality || ''; // formatted_address a veces es solo el estado ("Pernambuco")
    out.push({
      id: String(r.fsq_place_id ?? ''),
      name: String(r.name),
      detail: [CATEGORY_ES[cat] ?? cat, where].filter(Boolean).join(' · '),
      lat, lng,
      m: Number.isFinite(r.distance) ? r.distance : null,
      approx: true, // punto geocodificado por dirección: suele caer en la calle o a decenas de metros del edificio
    });
  }
  return out;
}

async function call(params, { key, fetchFn }) {
  const res = await fetchFn(`${URL_SEARCH}?${new URLSearchParams(params)}`, {
    headers: { authorization: `Bearer ${key}`, 'x-places-api-version': VERSION, accept: 'application/json' },
    signal: AbortSignal.timeout(8000),
  });
  if (res.status === 401 || res.status === 403) throw new PlacesError(502, 'Foursquare rechazó la clave');
  if (res.status === 429) throw new PlacesError(429, 'Se acabó el cupo de Foursquare por ahora');
  if (!res.ok) throw new PlacesError(502, 'Foursquare no respondió');
  return parseFoursquare(await res.json());
}

// Lugares cerca de (lat, lng). Sin `query`: negocios y edificios dentro de `radius` metros (dos consultas en paralelo).
// Con `query`: búsqueda por nombre alrededor del punto. Devuelve del más cercano al más lejano, sin repetir.
export async function searchFoursquare({ lat, lng, radius = 120, query = '', key, fetchFn = fetch, limit = 15 }) {
  const base = { ll: `${lat},${lng}`, radius: String(radius), limit: String(limit), sort: 'DISTANCE' };
  const lists = query
    ? [await call({ ...base, query, sort: 'RELEVANCE' }, { key, fetchFn })]
    : await Promise.all([call(base, { key, fetchFn }), call({ ...base, fsq_category_ids: BUILDING_CATEGORIES }, { key, fetchFn })]);
  const seen = new Set();
  const merged = [];
  for (const p of lists.flat()) {
    const k = p.id || `${p.name}|${p.lat}|${p.lng}`;
    if (!seen.has(k)) { seen.add(k); merged.push(p); }
  }
  return query ? merged : merged.sort((a, b) => (a.m ?? 1e9) - (b.m ?? 1e9));
}
