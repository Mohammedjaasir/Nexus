/** Provenance colour: a workspace's hue comes from its permanent slot, never
 *  from the workspace count, so adding a domain never recolours existing work.
 *  Slots walk the golden angle from BASE_HUE for even spread at any size. */
export const BASE_HUE = 265;
export const GOLDEN_ANGLE = 137.508;

export function provenanceHue(slot: number): number {
  if (!Number.isInteger(slot) || slot < 0) throw new RangeError(`hue slot must be a non-negative integer, got ${slot}`);
  const h = (BASE_HUE + slot * GOLDEN_ANGLE) % 360;
  return Math.round(h * 10) / 10;
}

export function hueDistance(a: number, b: number): number {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}
