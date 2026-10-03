import type { DomainId } from '@shared/domain';
import type { NexusIconName } from '../iconNames';

export const WORKSPACE_IDS = ['sde', 'ml', 'dl', 'data', 'research', 'qa', 'uiux', 'devops'] as const;
export type WorkspaceId = (typeof WORKSPACE_IDS)[number];

export interface WorkspaceConfig {
  id: WorkspaceId;
  label: string;          // short, short: 'SDE'
  name: string;           // long: 'Software Engineering'
  tagline: string;        // 'Code · APIs · Build'
  description: string;    // one sentence for tooltips and the workspace page
  icon: NexusIconName;
  hueSlot: number; // permanent; a new workspace takes max+1
  /** Analysed project domains that belong to this workspace (may be empty). */
  domainIds: DomainId[];
  /** Preset for "New project"; omitted when no domain maps here. */
  defaultDomainId?: DomainId;
  order: number;
  /** Modules this workspace will gain; shown as "Planned", never clickable. */
  plannedModules: string[];
}
