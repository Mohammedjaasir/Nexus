import type { CSSProperties } from 'react';
import { provenanceHue } from '../design/provenance';

export function provenanceStyle(slot: number | null): CSSProperties {
  return slot === null ? {} : ({ ['--ws-h' as string]: String(provenanceHue(slot)) } as CSSProperties);
}

/** A small square in the workspace's provenance hue. Decorative: the adjacent
 *  text label always carries the meaning. */
export function ProvenanceMark({ slot, size = 8 }: { slot: number | null; size?: number }) {
  return (
    <span aria-hidden="true" className={slot === null ? 'nx-prov nx-prov--none' : 'nx-prov'}
      style={{ ...provenanceStyle(slot), display: 'inline-block', width: size, height: size, borderRadius: 2, background: 'currentColor', flex: 'none' }} />
  );
}
