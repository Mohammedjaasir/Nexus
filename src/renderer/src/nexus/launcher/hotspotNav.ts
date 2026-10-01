export type Dir = 'left' | 'right' | 'up' | 'down';

/** Spatial arrow-key navigation over hotspot centres. Candidates must lie in
 *  a cone around the pressed direction; the score favours distance along that axis and
 *  penalises sideways drift, so "right" from the centre picks the card to the
 *  right rather than one far above it. */
export function nextHotspot(points: { x: number; y: number }[], current: number, dir: Dir): number {
  if (points.length === 0) return -1;
  if (current < 0 || current >= points.length) return 0;
  const o = points[current];
  let best = current;
  let bestScore = Infinity;
  points.forEach((p, i) => {
    if (i === current) return;
    const dx = p.x - o.x;
    const dy = p.y - o.y;
    const primary = dir === 'right' ? dx : dir === 'left' ? -dx : dir === 'down' ? dy : -dy;
    const side = dir === 'left' || dir === 'right' ? Math.abs(dy) : Math.abs(dx);
    // Must lie inside a cone around the pressed direction, so a card that is
    // essentially beside you is never chosen for up/down (and vice versa).
    if (primary <= 0 || primary < side * 0.5) return;
    const score = primary + side * 2;
    if (score < bestScore) { bestScore = score; best = i; }
  });
  return best;
}
