import { WORKSPACES } from './registry';
import type { WorkspaceConfig } from './types';

export const UNASSIGNED_LABEL = 'Unassigned';

/** The legacy domain grouping. Screens never call this directly: they read the
 *  participation index (participation.ts), whose legacy fallback is its one caller. */
export function workspaceForDomain(domainId: string | undefined | null): WorkspaceConfig | null {
  if (!domainId) return null;
  return WORKSPACES.find((w) => (w.domainIds as string[]).includes(domainId)) ?? null;
}

export function workspaceTabs(ws: WorkspaceConfig): { id: string; label: string; available: boolean }[] {
  return [{ id: 'projects', label: 'Projects', available: true }, ...ws.plannedModules.map((m) => ({ id: m.toLowerCase().replace(/\s+/g, '-'), label: m, available: false }))];
}
