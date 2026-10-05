/** Arrow-key movement over the launcher's tile grid. Left/right step one
 *  tile, up/down move a whole row, Home/End jump to the ends. Moves clamp
 *  inside the list; moving down into a partial last row lands on its last
 *  tile. Returns -1 for an empty list. */
export function gridMove(index: number, key: string, cols: number, length: number): number {
  if (length <= 0) return -1;
  const c = Math.max(1, cols);
  const last = length - 1;
  const i = Math.min(last, Math.max(0, index));
  switch (key) {
    case 'ArrowRight': return Math.min(last, i + 1);
    case 'ArrowLeft': return Math.max(0, i - 1);
    case 'ArrowDown': {
      const below = i + c;
      if (below <= last) return below;
      // Only move if a later row exists at all.
      return Math.floor(last / c) > Math.floor(i / c) ? last : i;
    }
    case 'ArrowUp': return i - c >= 0 ? i - c : i;
    case 'Home': return 0;
    case 'End': return last;
    default: return i;
  }
}
