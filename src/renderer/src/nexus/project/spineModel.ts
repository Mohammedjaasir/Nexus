import type { VersionStatus } from '@shared/nexus/platform';
import type { ArtifactSummaryView } from '@shared/nexus/ipc';
import { UNASSIGNED_LABEL } from '../workspaces/mapping';
import { viewOf, type ParticipationIndex, type ParticipationRow } from '../workspaces/participation';
import { kindIsChecked, kindLabel, shownVersionOf, statusLabel } from './artifactModel';
import { checksWord } from './evidenceModel';
import type { RailRecords } from '../workspaces/lifecycleModel';

export type ChangeKind = 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked';
export type GitState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; isRepo: boolean; branch: string | null; head: { sha: string; shortSha: string; subject: string; time: number } | null; changed: { path: string; kind: ChangeKind }[];
      /** Set when a branch or log read failed, so null means "unknown", not "none". */
      unknown?: { branch?: boolean; head?: boolean } };

export type SourceNode = { kind: 'source'; id: 'source'; vcs: 'git' | 'none' | 'unknown' | 'error'; branch: string | null; head: { shortSha: string; subject: string } | null };
export type ChangesNode = { kind: 'changes'; id: 'changes'; fileCount: number };
export type ArtifactNode = {
  kind: 'artifact'; id: `artifact:${string}`; artifactId: string;
  artifactKind: string; name: string; versionNo: number; status: VersionStatus; isCurrent: boolean;
};
export type SpineNode = SourceNode | ChangesNode | ArtifactNode;

/** One artifact summary as nexus:artifacts:byProject returns it. */
export type ArtifactSummary = ArtifactSummaryView;

/** `muted` is set only on a group whose participation is no longer active but still owns artifacts. */
export type SpineGroup = { workspaceId: string; label: string; hueSlot: number | null; nodes: SpineNode[]; muted?: 'withdrawn' | 'complete' };

const groupOf = (row: ParticipationRow): SpineGroup => {
  const v = viewOf(row.workspaceId);
  return { workspaceId: v.id, label: v.label, hueSlot: v.hueSlot, nodes: [] };
};

/** Only real data becomes a node; the spine never shows placeholders.
 *  - One group per active participation, primary first, then registry order. Without a
 *    primary, an Unassigned group leads. Source and changes stay in the lead group.
 *  - Artifact nodes come only from real versions (the current one, else the latest),
 *    in creation order, in their owner workspace's group. An archived artifact is not shown.
 *  - A participation that is no longer active but owns artifacts gives a muted group. */
export function buildSpine(input: { idx: ParticipationIndex; projectId: string; git: GitState; artifacts: ArtifactSummary[] }): SpineGroup[] {
  const rows = input.idx.byProject.get(input.projectId) ?? [];
  const activeRows = rows.filter((r) => r.status === 'active');
  const primary = activeRows.find((r) => r.isPrimary) ?? null;
  const lead: SpineGroup = primary ? groupOf(primary) : { workspaceId: 'unassigned', label: UNASSIGNED_LABEL, hueSlot: null, nodes: [] };
  const groups: SpineGroup[] = [lead];
  const byRow = new Map<ParticipationRow, SpineGroup>();
  if (primary) byRow.set(primary, lead);
  for (const r of activeRows) {
    if (r === primary) continue;
    const g = groupOf(r);
    groups.push(g);
    byRow.set(r, g);
  }
  const group = lead;
  const g = input.git;
  if (g.status !== 'ready') {
    group.nodes.push({ kind: 'source', id: 'source', vcs: g.status === 'error' ? 'error' : 'unknown', branch: null, head: null });
  } else if (!g.isRepo) {
    group.nodes.push({ kind: 'source', id: 'source', vcs: 'none', branch: null, head: null });
  } else {
    group.nodes.push({ kind: 'source', id: 'source', vcs: 'git', branch: g.branch, head: g.head ? { shortSha: g.head.shortSha, subject: g.head.subject } : null });
    if (g.changed.length > 0) group.nodes.push({ kind: 'changes', id: 'changes', fileCount: g.changed.length });
  }
  const inactive = new Map<ParticipationRow, SpineGroup>();
  const ownerRow = (a: ArtifactSummary['artifact']): ParticipationRow | null =>
    rows.find((r) => r.id === a.ownerParticipationId)
    ?? (a.ownerWorkspaceId ? activeRows.find((r) => r.workspaceId === a.ownerWorkspaceId) ?? rows.find((r) => r.workspaceId === a.ownerWorkspaceId) : undefined)
    ?? null;
  const ordered = [...(input.artifacts ?? [])].filter((s) => s.artifact.status === 'active')
    .sort((x, y) => x.artifact.createdAt - y.artifact.createdAt || (x.artifact.id < y.artifact.id ? -1 : x.artifact.id > y.artifact.id ? 1 : 0));
  for (const s of ordered) {
    const v = shownVersionOf(s);
    if (!v) continue;
    const row = ownerRow(s.artifact);
    let target = row ? byRow.get(row) : lead;
    if (!target && row) {
      target = inactive.get(row);
      if (!target) { target = { ...groupOf(row), muted: row.status === 'complete' ? 'complete' : 'withdrawn' }; inactive.set(row, target); }
    }
    (target ?? lead).nodes.push({
      kind: 'artifact', id: `artifact:${s.artifact.id}`, artifactId: s.artifact.id, artifactKind: s.artifact.kind,
      name: s.artifact.name, versionNo: v.versionNo, status: v.status, isCurrent: v.isCurrent
    });
  }
  // Muted groups follow the active ones, in the participation order.
  for (const r of rows) { const m = inactive.get(r); if (m) groups.push(m); }
  return groups;
}

/** What the line under the spine says about artifacts:
 *  - loading: before the first answer (a neutral line, never the placeholder);
 *  - error: the read failed (the errorCopy sentence, with "Try again" when a retry can help);
 *  - empty: the read succeeded and the project has no artifact node (the placeholder);
 *  - null: artifact nodes are on the spine. */
export type SpineLine = { kind: 'loading' } | { kind: 'error'; text: string; retry: boolean } | { kind: 'empty' } | null;

export function spineLine(a: { loaded: boolean; error: string | null; retry: boolean }, groups: SpineGroup[]): SpineLine {
  if (a.error) return { kind: 'error', text: a.error, retry: a.retry };
  if (!a.loaded) return { kind: 'loading' };
  return hasArtifactNodes(groups) ? null : { kind: 'empty' };
}

/** True when any artifact node is on the spine (the placeholder line shows only while there is none). */
export function hasArtifactNodes(groups: SpineGroup[]): boolean {
  return groups.some((g) => g.nodes.some((n) => n.kind === 'artifact'));
}

export function nodeLabel(n: SpineNode): string {
  if (n.kind === 'artifact') return `${kindLabel(n.artifactKind)} ${n.name}, version ${n.versionNo}, ${statusLabel(n.status)}`;
  if (n.kind === 'changes') return `Uncommitted changes, ${n.fileCount} ${n.fileCount === 1 ? 'file' : 'files'}`;
  if (n.vcs === 'none') return 'Project folder, not a git repository';
  if (n.vcs === 'error') return 'Project folder, git status unavailable';
  if (n.vcs === 'unknown') return 'Project folder, reading git status';
  const parts = ['Repository'];
  if (n.branch) parts.push(`branch ${n.branch}`);
  if (n.head) parts.push(`last commit ${n.head.shortSha} ${n.head.subject}`);
  return parts.join(', ');
}

export function tabStopId(nodeIds: string[], selectedId: string): string | null {
  if (nodeIds.length === 0) return null;
  return nodeIds.includes(selectedId) ? selectedId : nodeIds[0];
}

export function kindOf(index: string, worktree: string): ChangeKind {
  const c = (index.trim() || worktree.trim())[0];
  return c === 'A' ? 'added' : c === 'D' ? 'deleted' : c === 'R' ? 'renamed' : 'modified';
}

// ---------- B2a: the checks word of each artifact node ----------

/** The shown versions whose checks the Spine reads (kinds that are checked before they leave draft), capped. */
export const SPINE_CHECK_READS = 40;
export function checkedVersionIds(artifacts: readonly ArtifactSummary[]): { nodeId: string; versionId: string; status: VersionStatus }[] {
  const out: { nodeId: string; versionId: string; status: VersionStatus }[] = [];
  for (const s of artifacts) {
    if (s.artifact.status !== 'active' || !kindIsChecked(s.artifact.kind)) continue;
    const v = shownVersionOf(s);
    if (v) out.push({ nodeId: `artifact:${s.artifact.id}`, versionId: v.id, status: v.status });
  }
  return out.slice(0, SPINE_CHECK_READS);
}

/**
 * Which of the wanted versions to read again after a change: a version not read yet, one whose status changed since
 * it was read, and every draft (its checks are what is still moving). A candidate or active version's blocking
 * results do not change without its status changing, so it is not read again (a finished job costs a few reads, not
 * one per node).
 */
export function versionsToRead<T extends { versionId: string; status: VersionStatus }>(wanted: readonly T[], readAt: ReadonlyMap<string, VersionStatus>): T[] {
  return wanted.filter((w) => w.status === 'draft' || readAt.get(w.versionId) !== w.status);
}

/** Node id -> its checks word, from the versions read (validation state and status); a node without one is left out. */
export function spineChecks(reads: readonly { nodeId: string; validationState: 'pending' | 'passed' | 'failed' | 'error'; status: VersionStatus }[]): Map<string, string> {
  const m = new Map<string, string>();
  for (const r of reads) { const w = checksWord(r.validationState, r.status); if (w) m.set(r.nodeId, w); }
  return m;
}

// ---------- B2a Task 15: the records behind each group's lifecycle rail ----------

export type ValidatorStatuses = Readonly<Record<string, 'passed' | 'failed' | 'error' | 'skipped'>>;

/**
 * The records of one participation group: the shown versions of the artifacts it owns, each with the latest blocking
 * result per validator (read with #32), the live jobs' actions and whether a dev deployment answers. Null while the
 * checks could not be read: the rail then claims no state at all.
 */
export function railRecordsFor(i: {
  workspaceId: string; artifacts: readonly ArtifactSummary[]; checks: ReadonlyMap<string, ValidatorStatuses> | null;
  liveActions: readonly string[]; deploymentHealthy: boolean; participating: boolean;
}): RailRecords | null {
  if (!i.checks) return null;
  const versions: RailRecords['versions'] = [];
  for (const s of i.artifacts) {
    if (s.artifact.status !== 'active' || s.artifact.ownerWorkspaceId !== i.workspaceId) continue;
    const v = shownVersionOf(s);
    if (!v) continue;
    // A checked kind whose version was not read (past SPINE_CHECK_READS) has no known results: it is marked unread,
    // so its step claims no state, never "In progress" from an empty list. An unchecked kind has no checks to read.
    const read = i.checks.get(v.id);
    if (read) versions.push({ kind: s.artifact.kind, status: v.status, validators: read });
    else if (kindIsChecked(s.artifact.kind)) versions.push({ kind: s.artifact.kind, status: v.status, validators: {}, unread: true });
    else versions.push({ kind: s.artifact.kind, status: v.status, validators: {} });
  }
  return { versions, liveActions: i.liveActions, participation: i.participating, deploymentHealthy: i.deploymentHealthy };
}
