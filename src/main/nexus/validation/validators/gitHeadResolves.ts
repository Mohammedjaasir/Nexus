/**
 * `git.head_resolves` v1 (repository, register, blocking). Pure: main resolves the commit itself, in the
 * project folder, with its own async `resolveCommit` BEFORE the check; this function only compares.
 * The runner's report is never trusted: its `%H` must equal what main resolved, and the stored commit too.
 */
import { checkGitFacts, errored, failed, passed, COMMIT_RE, type ValidatorOutcome } from '../normalized';

export const ID = 'git.head_resolves';
export const VERSION = '1';

export interface GitHeadFacts {
  /** The commit the version stores (`storage.commit`). */
  storageCommit: string;
  /** The runner's snapshot facts, when the check runs at ingest (null on a revalidation from the stored version). */
  reported: unknown;
  /** What main's `resolveCommit` answered for the commit; null when main could not ask (no project folder, no resolver). */
  resolved: { commit: string } | { error: string } | null;
}

export function run(f: GitHeadFacts): ValidatorOutcome {
  const commit = typeof f.storageCommit === 'string' && COMMIT_RE.test(f.storageCommit) ? f.storageCommit : null;
  if (commit === null) return failed('bad_commit', 'The version does not store a full commit hash.');
  const ev = (detail: string) => [{ type: 'git' as const, commit, check: 'resolves' as const, detail: detail.slice(0, 200) }];
  if (f.reported !== null && f.reported !== undefined) {
    const g = checkGitFacts(f.reported);
    if (!g.ok) return errored('parser_contract', 'Checks could not run: the snapshot facts from the runner were not usable.', ev(g.message));
    if (g.value.commit !== commit) return failed('hash_differs', 'The reported commit is not the stored commit.', ev(`reported ${g.value.commit}`));
  }
  if (f.resolved === null) return errored('resolver_unavailable', 'Checks could not run: the project folder could not be read.', ev('not resolved'));
  if ('error' in f.resolved) return failed('does_not_resolve', 'The commit does not resolve in the project folder.', ev(String(f.resolved.error)));
  if (f.resolved.commit !== commit) return failed('hash_differs', 'The commit resolves to a different full hash.', ev(`resolved ${f.resolved.commit}`));
  return passed('The commit resolves in the project folder.', ev('resolved'));
}
