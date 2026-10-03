import type { ChangeKind } from '../project/spineModel';

const ORDER: { kind: ChangeKind; title: string }[] = [
  { kind: 'modified', title: 'Modified' }, { kind: 'added', title: 'Added' }, { kind: 'renamed', title: 'Renamed' },
  { kind: 'deleted', title: 'Deleted' }, { kind: 'untracked', title: 'New, not tracked' }
];

export const REVIEW_PHASE_NOTE = 'You can review these changes here. Accepting or discarding them from Nexus arrives with agent workspaces; until then, commit or revert them in Files or your own git tools.';

export function groupChanges(changed: { path: string; kind: ChangeKind }[]) {
  return ORDER.map(({ kind, title }) => ({ kind, title, paths: changed.filter((c) => c.kind === kind).map((c) => c.path).sort() }))
    .filter((g) => g.paths.length > 0);
}
