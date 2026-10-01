import type { ReactNode } from 'react';
export function Badge({ tone = 'neutral', children }: { tone?: 'neutral' | 'planned' | 'accent'; children: ReactNode }) {
  return <span className={`nx-badge nx-badge--${tone}`}>{children}</span>;
}
