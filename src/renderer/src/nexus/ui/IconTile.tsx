import { Icon, type NexusIconName } from '../icons';
import { provenanceStyle } from './ProvenanceMark';

/** Transitional: Task 6 deletes this. Coloured by the workspace's provenance slot. */
export function IconTile({ icon, slot, size = 'md' }: { icon: NexusIconName; slot: number | null; size?: 'sm' | 'md' | 'lg' }) {
  const px = size === 'lg' ? 22 : size === 'md' ? 18 : 15;
  return (
    <span className={`nx-tile nx-tile--${size} ${slot === null ? 'nx-prov nx-prov--none' : 'nx-prov'}`} style={{ ...provenanceStyle(slot), background: 'currentColor' }}>
      <span style={{ color: '#fff', display: 'inline-grid' }}><Icon name={icon} size={px} /></span>
    </span>
  );
}
