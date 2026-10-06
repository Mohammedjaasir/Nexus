import { WORKSPACES } from '../workspaces/registry';
import { projectsForWorkspace } from '../workspaces/mapping';
import { recentProjects } from '../data/selectors';
import type { WorkspaceConfig } from '../workspaces/types';

type P = { id: string; name: string; domainId: string; updatedAt: number; rootPath: string };

export interface WorkspaceRow<T extends P = P> {
  id: WorkspaceConfig['id'];
  ws: WorkspaceConfig;
  count: number;
  /** The two most recently updated projects, newest first. */
  recent: T[];
  /** False when no analyzer domain files projects here yet. */
  hasDomain: boolean;
}

/** The Workspaces index, from real projects only. Pure: testable in node. */
export function buildWorkspaceIndex<T extends P>(projects: T[]) {
  const rows: WorkspaceRow<T>[] = WORKSPACES.map((ws) => {
    const mine = projectsForWorkspace(projects, ws.id);
    return { id: ws.id, ws, count: mine.length, recent: recentProjects(mine, 2), hasDomain: ws.domainIds.length > 0 };
  });
  const assigned = rows.reduce((n, r) => n + r.count, 0);
  return { rows, totalProjects: projects.length, unassigned: projects.length - assigned };
}
