/**
 * The runner's git (B2a Task 11): async `spawn('git', argv)` (proc.ts) in the project folder main accepted, with fixed
 * argv only. A commit is used only after it is validated as 40 lowercase hex characters; the only path ever named is
 * the fixed `nexus.app.json`. Nothing here writes the repository: `git archive` streams a tree out, the snapshot reads
 * refs and status (GIT_OPTIONAL_LOCKS=0, so status never takes the index lock).
 */
import { createHash } from 'node:crypto';
import { runGit, toolEnv, type RunResult } from './proc';
import type { RunnerFs } from './types';

export const COMMIT_RE = /^[0-9a-f]{40}$/;
const GIT_TIMEOUT_MS = 60_000;
const SMALL = 64 * 1024;

export const SNAPSHOT_ARGV = Object.freeze({
  commit: Object.freeze(['rev-parse', '--verify', 'HEAD^{commit}']),
  branch: Object.freeze(['symbolic-ref', '--short', '-q', 'HEAD']),
  status: Object.freeze(['status', '--porcelain=v1', '-z']),
  tree: Object.freeze(['rev-parse', 'HEAD^{tree}'])
});
export const APP_MANIFEST_PATH = 'nexus.app.json';

export class GitError extends Error { constructor(message: string) { super(message); this.name = 'GitError'; } }

export function archiveArgv(commit: string): string[] {
  if (!COMMIT_RE.test(commit)) throw new GitError('the commit is not a full sha');
  return ['archive', '--format=tar', commit];
}

/**
 * `git archive --format=tar <commit>` into `dest` (created exclusively), hashed while written. Returns the tar's
 * sha256 and size. Refuses a commit that is not 40 hex characters before anything is spawned.
 */
export async function archiveTo(fs: RunnerFs, repoPath: string, commit: string, dest: string, o: { signal?: AbortSignal; maxBytes: number }):
  Promise<{ sha256: string; bytes: number }> {
  const argv = archiveArgv(commit);
  const fh = await fs.open(dest, 'wx');
  const h = createHash('sha256');
  let bytes = 0; let overflow = false;
  let writes: Promise<unknown> = Promise.resolve();
  let r: RunResult;
  try {
    r = await runGit(argv, { cwd: repoPath, env: toolEnv(), timeoutMs: 10 * GIT_TIMEOUT_MS, maxStdout: 0, maxStderr: 4096, signal: o.signal,
      onStdout: (chunk) => {
        if (overflow) return;
        bytes += chunk.length;
        if (bytes > o.maxBytes) { overflow = true; return; }
        h.update(chunk);
        const copy = Buffer.from(chunk);
        writes = writes.then(() => fh.write(copy));
        return writes;
      } });
    await writes;
  } finally { await fh.close(); }
  if (overflow) throw new GitError('the checkout is larger than the staging limit');
  if (r.error) throw new GitError(`git could not run (${r.error})`);
  if (r.code !== 0) throw new GitError('git archive failed: the commit is not in this repository');
  return { sha256: h.digest('hex'), bytes };
}

async function git(repoPath: string, argv: readonly string[], signal?: AbortSignal, maxStdout = SMALL): Promise<RunResult> {
  const r = await runGit(argv, { cwd: repoPath, env: toolEnv(), timeoutMs: GIT_TIMEOUT_MS, maxStdout, maxStderr: 4096, signal });
  if (r.error) throw new GitError(`git could not run (${r.error})`);
  return r;
}

export interface SnapshotFacts { commit: string; branch: string | null; dirty: boolean; tree: string }

/**
 * `repo.snapshot`: HEAD's commit and tree, the short branch name (null when detached), and whether the work tree is
 * dirty. The dirty flag comes from the LENGTH of `status --porcelain=v1 -z` only: no file name leaves the runner.
 */
export async function snapshot(repoPath: string, signal?: AbortSignal): Promise<SnapshotFacts> {
  const c = await git(repoPath, SNAPSHOT_ARGV.commit, signal);
  const commit = c.stdout.trim();
  if (c.code !== 0 || !COMMIT_RE.test(commit)) throw new GitError('HEAD does not resolve to a commit');
  const b = await git(repoPath, SNAPSHOT_ARGV.branch, signal);
  const branchText = b.stdout.trim();
  const branch = b.code === 0 && branchText.length > 0 && branchText.length <= 255 && !/[\0\s]/.test(branchText) ? branchText : null;
  // Only the length is read; the names in the output are never kept or sent.
  const s = await runGit(SNAPSHOT_ARGV.status, { cwd: repoPath, env: toolEnv(), timeoutMs: GIT_TIMEOUT_MS, maxStdout: 0, maxStderr: 4096, signal });
  if (s.error || s.code !== 0) throw new GitError('git status failed');
  const t = await git(repoPath, SNAPSHOT_ARGV.tree, signal);
  const tree = t.stdout.trim();
  if (t.code !== 0 || !COMMIT_RE.test(tree)) throw new GitError('HEAD has no tree');
  return { commit, branch, dirty: s.stdoutBytes > 0, tree };
}

export function appManifestArgv(commit: string): { size: string[]; show: string[] } {
  if (!COMMIT_RE.test(commit)) throw new GitError('the commit is not a full sha');
  return { size: ['cat-file', '-s', `${commit}:${APP_MANIFEST_PATH}`], show: ['show', `${commit}:${APP_MANIFEST_PATH}`] };
}

/**
 * `sde.app.assemble`: the text of `nexus.app.json` at `commit`, and nothing else. Its size is asked first; a file over
 * `maxBytes` is refused without being read.
 */
export async function readAppManifest(repoPath: string, commit: string, maxBytes: number, signal?: AbortSignal):
  Promise<{ ok: true; text: Buffer } | { ok: false; reason: 'missing' | 'too_large' }> {
  const argv = appManifestArgv(commit);
  const size = await git(repoPath, argv.size, signal);
  const n = Number(size.stdout.trim());
  if (size.code !== 0 || !Number.isSafeInteger(n)) return { ok: false, reason: 'missing' };
  if (n > maxBytes) return { ok: false, reason: 'too_large' };
  const show = await runGit(argv.show, { cwd: repoPath, env: toolEnv(), timeoutMs: GIT_TIMEOUT_MS, maxStdout: maxBytes + 1, maxStderr: 4096, signal });
  if (show.error || show.code !== 0) return { ok: false, reason: 'missing' };
  if (show.stdoutBytes > maxBytes) return { ok: false, reason: 'too_large' };
  return { ok: true, text: Buffer.from(show.stdout, 'utf8') };
}
