/** Emblems: one generated shape per workspace, drawn as a closed polygon with
 *  the same number of points for every shape. Because the point count never
 *  changes, the browser can interpolate the SVG `d` attribute and one emblem
 *  morphs smoothly into the next when the selection moves. */

export const EMBLEM_POINTS = 72;
export const EMBLEM_VIEW = 100;
const C = EMBLEM_VIEW / 2;
const R = 36;

type Radius = (t: number) => number;

const superellipse = (n: number): Radius => (t) =>
  1 / Math.pow(Math.pow(Math.abs(Math.cos(t)), n) + Math.pow(Math.abs(Math.sin(t)), n), 1 / n);

/** Regular polygon with straight edges, in polar form. */
const polygon = (sides: number, rot = 0): Radius => (t) => {
  const seg = (2 * Math.PI) / sides;
  const a = ((t - rot) % seg + seg) % seg - seg / 2;
  return Math.cos(Math.PI / sides) / Math.cos(a);
};

const SHAPES: Record<string, Radius> = {
  // code: a soft square
  sde: (t) => 0.92 * superellipse(4)(t),
  // neural: six soft petals
  ml: (t) => 0.8 + 0.16 * Math.cos(6 * t),
  // depth: a rounded triangle
  dl: (t) => 0.96 * polygon(3, -Math.PI / 2)(t),
  // charts: a five-point star
  data: (t) => 0.66 + 0.3 * Math.max(0, Math.cos(5 * (t + Math.PI / 2))),
  // inquiry: a lens
  research: (t) => 0.82 + 0.12 * Math.cos(2 * t),
  // quality: a hexagon
  qa: polygon(6),
  // design: an organic blob
  uiux: (t) => 0.84 + 0.08 * Math.sin(3 * t) + 0.05 * Math.cos(5 * t + 1),
  // operations: a four-point spark
  devops: (t) => 0.5 + 0.46 * Math.pow(Math.abs(Math.cos(2 * t)), 3),
  generic: () => 0.9
};

const fmt = (n: number) => String(Math.round(n * 10) / 10);

export function emblemPath(id: string): string {
  const r = SHAPES[id] ?? SHAPES.generic;
  const pts: string[] = [];
  for (let i = 0; i < EMBLEM_POINTS; i++) {
    const t = (i / EMBLEM_POINTS) * 2 * Math.PI - Math.PI / 2;
    const k = Math.min(1.25, Math.max(0.2, r(t)));
    pts.push(`${fmt(C + R * k * Math.cos(t))} ${fmt(C + R * k * Math.sin(t))}`);
  }
  return `M ${pts[0]} ${pts.slice(1).map((p) => `L ${p}`).join(' ')} Z`;
}
