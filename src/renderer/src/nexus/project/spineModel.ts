import { workspaceForDomain, UNASSIGNED_LABEL } from '../workspaces/mapping';

export type ChangeKind = 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked';
export type GitState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; isRepo: boolean; branch: string | null; head: { sha: string; shortSha: string; subject: string; time: number } | null; changed: { path: string; kind: ChangeKind }[] };

export type SpineNode =
  | { kind: 'source'; id: 'source'; vcs: 'git' | 'none' | 'unknown' | 'error'; branch: string | null; head: { shortSha: string; subject: string } | null }
  | { kind: 'changes'; id: 'changes'; fileCount: number };

export type SpineGroup = { workspaceId: string; label: string; hueSlot: number | null; nodes: SpineNode[] };

/** Only real data becomes a node. Artifact nodes arrive with the Phase B
 *  artifact backend; until then the spine never shows placeholders. */
export function buildSpine(input: { domainId: string; git: GitState }): SpineGroup[] {
  const ws = workspaceForDomain(input.domainId);
  const group: SpineGroup = ws ? { workspaceId: ws.id, label: ws.label, hueSlot: ws.hueSlot, nodes: [] } : { workspaceId: 'unassigned', label: UNASSIGNED_LABEL, hueSlot: null, nodes: [] };
  const g = input.git;
  if (g.status !== 'ready') {
    group.nodes.push({ kind: 'source', id: 'source', vcs: g.status === 'error' ? 'error' : 'unknown', branch: null, head: null });
  } else if (!g.isRepo) {
    group.nodes.push({ kind: 'source', id: 'source', vcs: 'none', branch: null, head: null });
  } else {
    group.nodes.push({ kind: 'source', id: 'source', vcs: 'git', branch: g.branch, head: g.head ? { shortSha: g.head.shortSha, subject: g.head.subject } : null });
    if (g.changed.length > 0) group.nodes.push({ kind: 'changes', id: 'changes', fileCount: g.changed.length });
  }
  return [group];
}

export function nodeLabel(n: SpineNode): string {
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
