// Enlaces cortos de Google Maps (maps.app.goo.gl/...): no traen coordenadas hasta que alguien los abre y sigue la redirección.
// El navegador no puede hacerlo por CORS, así que lo hace el servidor. Solo se siguen hosts de Google (si no, cualquiera
// podría usar el servidor para visitar páginas arbitrarias) y con tope de redirecciones y de tiempo.
import { parseCoordinates } from '../public/js/geosearch.mjs';

// Dominios de Google: el sufijo de país es exacto (com, dos letras como "es", o com./co. más dos letras como "com.co"). Un patrón
// abierto como google.[a-z.]+ dejaría pasar google.evil.com, que es de otra persona.
const GOOGLE_HOST = /^(?:(?:www|maps|consent)\.)?google\.(?:com|[a-z]{2}|com?\.[a-z]{2})$/;
const ALLOWED = [/^maps\.app\.goo\.gl$/, /^goo\.gl$/, /^g\.co$/, GOOGLE_HOST];
const MAX_REDIRECTS = 5;

export class MapLinkError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function isAllowedMapUrl(raw) {
  let u;
  try { u = new URL(raw); } catch { return false; }
  if (u.protocol !== 'https:' || u.username || u.password || u.port) return false;
  if (!ALLOWED.some((re) => re.test(u.hostname))) return false;
  // goo.gl y g.co solo sirven como enlace corto de mapas.
  if (u.hostname === 'goo.gl') return u.pathname.startsWith('/maps');
  if (u.hostname === 'g.co') return u.pathname.startsWith('/kgs');
  return true;
}

// Sigue las redirecciones de un enlace de Google Maps y devuelve { url, lat, lng, name? } (lat/lng solo si el enlace final los trae).
export async function resolveMapLink(rawUrl, { fetchFn = fetch } = {}) {
  let url = String(rawUrl ?? '').trim();
  if (!isAllowedMapUrl(url)) throw new MapLinkError(400, 'Solo se pueden abrir enlaces de Google Maps');
  for (let i = 0; i <= MAX_REDIRECTS; i += 1) {
    const found = parseCoordinates(url);
    if (found) return { url, ...found };
    let res;
    try {
      res = await fetchFn(url, { redirect: 'manual', headers: { 'user-agent': 'Mozilla/5.0 (compatible; gastos-viaje)', 'accept-language': 'es' }, signal: AbortSignal.timeout(8000) });
    } catch {
      throw new MapLinkError(502, 'No se pudo abrir el enlace');
    }
    const next = res.headers?.get?.('location');
    if (res.status >= 300 && res.status < 400 && next) {
      let target;
      try { target = new URL(next, url); } catch { throw new MapLinkError(502, 'El enlace redirige a una dirección inválida'); }
      // La página de consentimiento de Google lleva el destino real en ?continue=
      if (/^consent\.google\./.test(target.hostname) && target.searchParams.get('continue')) {
        try { target = new URL(target.searchParams.get('continue')); } catch { throw new MapLinkError(502, 'El enlace redirige a una dirección inválida'); }
      }
      url = target.toString();
      if (!isAllowedMapUrl(url)) throw new MapLinkError(502, 'El enlace sale de Google Maps: no se sigue');
      continue;
    }
    break; // no redirige más: no hay coordenadas en la dirección final
  }
  // Sin coordenadas: al menos el nombre del lugar, para buscarlo por texto.
  const place = url.match(/\/place\/([^/@?]+)/);
  let name = '';
  if (place) {
    try { name = decodeURIComponent(place[1]).replace(/\+/g, ' ').split(',')[0].trim().slice(0, 120); } catch { /* nombre ilegible: se omite */ }
  }
  return { url, ...(name ? { name } : {}) };
}
