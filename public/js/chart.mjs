// Gráfico de la tasa de cambio (SVG a mano, sin librerías). Módulo puro: recibe puntos
// [{ date, rate }] ordenados por fecha y devuelve el dibujo y las posiciones de cada punto.
// La interacción (línea guía al pasar el dedo o el mouse) la hace app.js con estas posiciones.
const W = 300;
const H = 72;
const PAD = 8;

export function sparkline(points, selected) {
  if (!Array.isArray(points) || points.length < 2) return null;
  const rates = points.map((p) => p.rate);
  const min = Math.min(...rates);
  const max = Math.max(...rates);
  const span = max - min || 1;
  const x = (i) => PAD + (i * (W - 2 * PAD)) / (points.length - 1);
  const y = (r) => H - PAD - ((r - min) / span) * (H - 2 * PAD);
  const line = points.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)} ${y(p.rate).toFixed(1)}`).join(' ');
  const area = `${line} L${x(points.length - 1).toFixed(1)} ${H - PAD} L${x(0).toFixed(1)} ${H - PAD} Z`;
  const si = points.findIndex((p) => p.date === selected);
  const first = points[0];
  return {
    // Solo la línea y el área: los puntos y guías van como HTML para que no se deformen al estirar el SVG.
    svg: `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true">` +
      `<path class="chart-area" d="${area}"/><path class="chart-line" d="${line}"/></svg>`,
    xs: points.map((_, i) => +((x(i) / W) * 100).toFixed(2)), // posición horizontal de cada punto, en %
    ys: points.map((p) => +((y(p.rate) / H) * 100).toFixed(2)), // posición vertical, en %
    min,
    max,
    first,
    last: points.at(-1),
    selectedIndex: si,
    selected: si >= 0 ? points[si] : null,
    change: ((points.at(-1).rate - first.rate) / first.rate) * 100,
  };
}

// Variación (%) de un punto respecto al primero del período.
export const changeAt = (points, i) => ((points[i].rate - points[0].rate) / points[0].rate) * 100;

// Índice del punto más cercano a una posición horizontal (0 = borde izquierdo, 1 = derecho).
export function nearestIndex(n, fraction) {
  const t = (Math.min(1, Math.max(0, fraction)) * W - PAD) / (W - 2 * PAD);
  return Math.min(n - 1, Math.max(0, Math.round(t * (n - 1))));
}
