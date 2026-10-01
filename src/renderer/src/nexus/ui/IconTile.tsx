import { Icon, type NexusIconName } from '../icons';
import type { Hue } from '../iconNames';

export function IconTile({ icon, hue, size = 'md' }: { icon: NexusIconName; hue: Hue; size?: 'sm' | 'md' | 'lg' }) {
  const px = size === 'lg' ? 22 : size === 'md' ? 18 : 15;
  return (
    <span className={`nx-tile nx-tile--${size}`} data-hue={hue}>
      <Icon name={icon} size={px} />
    </span>
  );
}
