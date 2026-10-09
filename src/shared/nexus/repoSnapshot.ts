// Repository snapshots (B2a Task 9): what a snapshot version records and the note the UI shows with it. Pure; no I/O.
// Code reaches a container as `git archive` of one commit, so a working tree with uncommitted changes is never what
// runs: the note says so whenever the snapshot recorded `dirty: true`.

export interface RepoSnapshotFacts { commit: string; branch: string | null; dirty: boolean; tree: string | null }

const COMMIT_RE = /^[0-9a-f]{40}$/;

/** The facts of a repository version from its storage and metadata, or null when they are not a snapshot's. */
export function snapshotFacts(storage: unknown, metadata: unknown): RepoSnapshotFacts | null {
  const st = typeof storage === 'object' && storage !== null ? storage as Record<string, unknown> : null;
  const md = typeof metadata === 'object' && metadata !== null ? metadata as Record<string, unknown> : {};
  const commit = st && st.kind === 'git' && typeof st.commit === 'string' && COMMIT_RE.test(st.commit) ? st.commit : null;
  if (!commit) return null;
  return {
    commit, branch: typeof md.branch === 'string' ? md.branch : null, dirty: md.dirty === true,
    tree: typeof md.tree === 'string' ? md.tree : null
  };
}

/**
 * The checkout note for work run on a snapshot: always the commit; when the working tree had uncommitted changes,
 * also that they are not included. Driven only by the recorded `dirty` flag.
 */
export function checkoutNote(facts: Pick<RepoSnapshotFacts, 'commit' | 'dirty'>): string {
  const short = facts.commit.slice(0, 7);
  return facts.dirty
    ? `Tests run on commit ${short}; uncommitted changes are not included.`
    : `Tests run on commit ${short}.`;
}
