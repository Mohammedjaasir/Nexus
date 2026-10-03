import type { Project } from '@shared/project';
import { WORKSPACES } from './registry';
import type { WorkspaceConfig, WorkspaceId } from './types';

export const UNASSIGNED_LABEL = 'Unassigned';

export function workspaceForDomain(domainId: string | undefined | null): WorkspaceConfig | null {
  if (!domainId) return null;
  return WORKSPACES.find((w) => (w.domainIds as string[]).includes(domainId)) ?? null;
}

export function projectsForWorkspace<P extends Pick<Project, 'domainId'>>(projects: P[], id: WorkspaceId): P[] {
  return projects.filter((p) => workspaceForDomain(p.domainId)?.id === id);
}

export function countsByWorkspace(projects: Pick<Project, 'domainId'>[]): Record<WorkspaceId, number> {
  const counts = Object.fromEntries(WORKSPACES.map((w) => [w.id, 0])) as Record<WorkspaceId, number>;
  for (const p of projects) {
    const w = workspaceForDomain(p.domainId);
    if (w) counts[w.id] += 1;
  }
  return counts;
}

export function workspaceTabs(ws: WorkspaceConfig): { id: string; label: string; available: boolean }[] {
  return [{ id: 'projects', label: 'Projects', available: true }, ...ws.plannedModules.map((m) => ({ id: m.toLowerCase().replace(/\s+/g, '-'), label: m, available: false }))];
}
