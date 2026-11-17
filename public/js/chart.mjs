// Gráfico pequeño de la tasa de cambio (SVG a mano, sin librerías). Módulo puro: recibe puntos
// [{ date, rate }] ordenados por fecha y devuelve el SVG y un resumen. Si hay menos de 2 puntos, null.
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
  const dot = si >= 0
    ? `<line class="chart-sel" x1="${x(si).toFixed(1)}" x2="${x(si).toFixed(1)}" y1="${PAD}" y2="${H - PAD}"/>` +
      `<circle class="chart-dot" cx="${x(si).toFixed(1)}" cy="${y(points[si].rate).toFixed(1)}" r="4.5"/>`
    : '';
  const first = points[0];
  const last = points.at(-1);
  return {
    svg: `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true">` +
      `<path class="chart-area" d="${area}"/><path class="chart-line" d="${line}"/>${dot}</svg>`,
    min,
    max,
    first,
    last,
    selected: si >= 0 ? points[si] : null,
    change: ((last.rate - first.rate) / first.rate) * 100,
  };
}
