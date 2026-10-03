import type { GitState, SpineNode } from './spineModel';
import { relativeTime } from '../data/selectors';

/** One sentence about a git source: branch and last commit. A read that
 *  failed is "unknown", never mistaken for a detached HEAD or an empty repo.
 *  Returns null for anything that is not a readable git source. */
export function provenanceLine(node: SpineNode, git: GitState, now: number): string | null {
  if (node.kind !== 'source' || node.vcs !== 'git' || git.status !== 'ready') return null;
  const unknown = git.unknown ?? {};
  const lead = git.branch ? `Repository on branch ${git.branch}.` : unknown.branch ? 'Repository. Branch unknown.' : 'Repository, not on a branch.';
  const h = git.head;
  const last = h
    ? `Last commit ${h.shortSha} ${h.subject}${h.time ? `, ${relativeTime(h.time * 1000, now)}` : ''}.`
    : unknown.head ? 'Last commit unknown.' : 'No commits yet.';
  return `${lead} ${last}`;
}
