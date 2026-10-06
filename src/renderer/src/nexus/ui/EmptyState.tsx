import type { ReactNode } from 'react';
import { Icon, type NexusIconName } from '../icons';

/** `level` keeps the outline intact: 1 when the empty state IS the page (no
 *  other h1), 2 directly under a page h1, 4 inside a workbench section (h3). */
export function EmptyState({ icon, title, body, actions, level = 3 }: { icon: NexusIconName; title: string; body: ReactNode; actions?: ReactNode; level?: 1 | 2 | 3 | 4 }) {
  const H = `h${level}` as 'h1' | 'h2' | 'h3' | 'h4';
  return (
    <div className="nx-empty" role="status">
      <H className="nx-empty__title" tabIndex={level === 1 ? -1 : undefined}><Icon name={icon} size={16} className="nx-empty__icon" />{title}</H>
      <div className="nx-empty__body">{body}</div>
      {actions && <div className="nx-empty__actions">{actions}</div>}
    </div>
  );
}
