// Pure: which workspaces each project takes part in. Every screen reads this one
// model. In 'db' mode it is built from the platform's project_workspaces rows
// (nexus:participations:list); in 'legacy' mode, while the platform is not
// available, it is derived from the project's detected domain, the same grouping
// the backfill wrote as each project's primary. Labels, hues and planned modules
// stay in the renderer registry, keyed by workspace id.
import { WORKSPACES, getWorkspace } from './registry';
import { workspaceForDomain } from './mapping';
import type { WorkspaceConfig, WorkspaceId } from './types';

export type ParticipationRow = {
  id: string; projectId: string; workspaceId: string;
  status: 'active' | 'withdrawn' | 'complete'; isPrimary: boolean; source: string;
};

export interface ParticipationIndex { mode: 'db' | 'legacy'; byProject: ReadonlyMap<string, ParticipationRow[]> }

/** How a workspace id is shown. An id the registry does not know keeps its id as its label and has no hue. */
export interface WorkspaceView { id: string; label: string; hueSlot: number | null; config: WorkspaceConfig | null }

const ORDER = new Map<string, number>(WORKSPACES.map((w, i) => [w.id, i]));
const rank = (r: ParticipationRow): number => (r.isPrimary ? -1 : ORDER.get(r.workspaceId) ?? WORKSPACES.length);
const isActive = (r: ParticipationRow): boolean => r.status === 'active';

function index(mode: ParticipationIndex['mode'], rows: ParticipationRow[]): ParticipationIndex {
  const byProject = new Map<string, ParticipationRow[]>();
  for (const r of rows) {
    const list = byProject.get(r.projectId);
    if (list) list.push(r); else byProject.set(r.projectId, [r]);
  }
  for (const list of byProject.values()) list.sort((a, b) => rank(a) - rank(b));
  return { mode, byProject };
}

export function fromRows(rows: ParticipationRow[]): ParticipationIndex {
  return index('db', rows);
}

/** The fallback while the platform is unavailable: one active primary per project whose domain maps to a workspace. */
export function legacyIndex(projects: { id: string; domainId: string }[]): ParticipationIndex {
  const rows: ParticipationRow[] = [];
  for (const p of projects) {
    const ws = workspaceForDomain(p.domainId);
    if (ws) rows.push({ id: `legacy:${p.id}`, projectId: p.id, workspaceId: ws.id, status: 'active', isPrimary: true, source: 'legacy_domain' });
  }
  return index('legacy', rows);
}

export function viewOf(workspaceId: string): WorkspaceView {
  const config = getWorkspace(workspaceId);
  return config ? { id: config.id, label: config.label, hueSlot: config.hueSlot, config } : { id: workspaceId, label: workspaceId, hueSlot: null, config: null };
}

const rowsOf = (idx: ParticipationIndex, projectId: string): ParticipationRow[] => idx.byProject.get(projectId) ?? [];
const primaryRow = (idx: ParticipationIndex, projectId: string): ParticipationRow | null =>
  rowsOf(idx, projectId).find((r) => r.isPrimary && isActive(r)) ?? null;

/** The registry config of the project's active primary; null when it has none (Unassigned) or the id is unknown. */
export function primaryOf(idx: ParticipationIndex, projectId: string): WorkspaceConfig | null {
  const r = primaryRow(idx, projectId);
  return r ? getWorkspace(r.workspaceId) : null;
}

/** How to show the project's primary; null means Unassigned. */
export function primaryViewOf(idx: ParticipationIndex, projectId: string): WorkspaceView | null {
  const r = primaryRow(idx, projectId);
  return r ? viewOf(r.workspaceId) : null;
}

/** Active participations, primary first, then registry order (unknown ids last). */
export function activeWorkspacesOf(idx: ParticipationIndex, projectId: string): { ws: WorkspaceConfig | null; row: ParticipationRow }[] {
  return rowsOf(idx, projectId).filter(isActive).map((row) => ({ ws: getWorkspace(row.workspaceId), row }));
}

/** Projects with an active participation in `ws`: primaries first, then attached, each in input order. */
export function projectsInWorkspace<P extends { id: string }>(idx: ParticipationIndex, projects: P[], ws: WorkspaceId): { project: P; role: 'primary' | 'attached' }[] {
  const primary: { project: P; role: 'primary' | 'attached' }[] = [];
  const attached: { project: P; role: 'primary' | 'attached' }[] = [];
  for (const project of projects) {
    const r = rowsOf(idx, project.id).find((x) => x.workspaceId === ws && isActive(x));
    if (!r) continue;
    (r.isPrimary ? primary : attached).push({ project, role: r.isPrimary ? 'primary' : 'attached' });
  }
  return [...primary, ...attached];
}

/** Active participations per registry workspace (primary plus attached). Unknown ids are not counted. */
export function countsByWorkspace(idx: ParticipationIndex, projects: { id: string }[]): Record<WorkspaceId, number> {
  const counts = Object.fromEntries(WORKSPACES.map((w) => [w.id, 0])) as Record<WorkspaceId, number>;
  for (const p of projects) {
    for (const r of rowsOf(idx, p.id)) {
      if (isActive(r) && Object.prototype.hasOwnProperty.call(counts, r.workspaceId)) counts[r.workspaceId as WorkspaceId] += 1;
    }
  }
  return counts;
}

/** Projects with no active primary: shown as Unassigned. */
export function unassignedCount(idx: ParticipationIndex, projects: { id: string }[]): number {
  return projects.filter((p) => primaryRow(idx, p.id) === null).length;
}

/** Registry workspaces the project could be attached to: not active there and not complete there. */
export function attachChoices(idx: ParticipationIndex, projectId: string): WorkspaceConfig[] {
  const taken = new Set(rowsOf(idx, projectId).filter((r) => r.status !== 'withdrawn').map((r) => r.workspaceId));
  return WORKSPACES.filter((w) => !taken.has(w.id));
}
