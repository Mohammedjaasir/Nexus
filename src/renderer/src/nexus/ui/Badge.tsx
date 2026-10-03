import type { ReactNode } from 'react';
/** One neutral badge. Colour is reserved for provenance, so badges carry no tone. */
export function Badge({ children }: { children: ReactNode }) {
  return <span className="nx-badge">{children}</span>;
}
