import type { DomainId } from '@shared/domain';
import type { Hue, NexusIconName } from '../iconNames';

export const WORKSPACE_IDS = ['sde', 'ml', 'dl', 'data', 'research', 'qa', 'uiux', 'devops'] as const;
export type WorkspaceId = (typeof WORKSPACE_IDS)[number];

/** Hotspot centre on the launcher stage, as a percentage of its width/height. */
export interface IslandPoint { x: number; y: number }

export interface WorkspaceConfig {
  id: WorkspaceId;
  label: string;          // short, shown on hotspots: 'SDE'
  name: string;           // long: 'Software Engineering'
  tagline: string;        // 'Code · APIs · Build'
  description: string;    // one sentence for tooltips and the workspace page
  icon: NexusIconName;
  hue: Hue;
  /** Analysed project domains that belong to this workspace (may be empty). */
  domainIds: DomainId[];
  /** Preset for "New project"; omitted when no domain maps here. */
  defaultDomainId?: DomainId;
  island: IslandPoint;
  order: number;
  /** Modules this workspace will gain; shown as "Planned", never clickable. */
  plannedModules: string[];
}

/** A launcher entry that is NOT a workspace (e.g. Your Projects). */
export interface LauncherShortcut {
  id: 'projects';
  label: string;
  tagline: string;
  icon: NexusIconName;
  island: IslandPoint;
}
