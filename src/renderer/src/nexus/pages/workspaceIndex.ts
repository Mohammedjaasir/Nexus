import { WORKSPACES } from '../workspaces/registry';
import { projectsInWorkspace, unassignedCount, type ParticipationIndex } from '../workspaces/participation';
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

/** The Workspaces index, from real projects and their participations only.
 *  `count` is every active participation (primary plus attached); `unassigned`
 *  is the projects with no primary. Pure: testable in node. */
export function buildWorkspaceIndex<T extends P>(projects: T[], idx: ParticipationIndex) {
  const rows: WorkspaceRow<T>[] = WORKSPACES.map((ws) => {
    const mine = projectsInWorkspace(idx, projects, ws.id).map((x) => x.project);
    return { id: ws.id, ws, count: mine.length, recent: recentProjects(mine, 2), hasDomain: ws.domainIds.length > 0 };
  });
  return { rows, totalProjects: projects.length, unassigned: unassignedCount(idx, projects) };
}
