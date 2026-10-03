import type { ReactNode } from 'react';
import { Icon, type NexusIconName } from '../icons';
export function EmptyState({ icon, title, body, actions }: { icon: NexusIconName; title: string; body: ReactNode; actions?: ReactNode }) {
  return (
    <div className="nx-empty" role="status">
      <h3 className="nx-empty__title"><Icon name={icon} size={16} className="nx-empty__icon" />{title}</h3>
      <div className="nx-empty__body">{body}</div>
      {actions && <div className="nx-empty__actions">{actions}</div>}
    </div>
  );
}
