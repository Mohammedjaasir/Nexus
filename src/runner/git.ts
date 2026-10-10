/**
 * The runner's git (B2a Task 11): the ONE resolved absolute git binary (src/main/gitBinary.ts; never a `git` inside the
 * repository, never one found through a relative PATH entry), launched from the data home with the repository named by
 * `-C <repo>`, with fixed argv only and the config that keeps a repository's own settings from starting anything:
 * `-c core.fsmonitor=false -c core.hooksPath=<a folder that does not exist>`. A commit is used only after it is
 * validated as 40 lowercase hex characters; the only path ever named is the fixed `nexus.app.json`. Nothing here writes
 * the repository: `git archive` streams a tree out, the snapshot reads refs and status (GIT_OPTIONAL_LOCKS=0, so status
 * never takes the index lock).
 */
import { createHash } from 'node:crypto';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { gitResolver, insideFolder, isGitBinary, resolveGitBinary, SAFE_GIT_CONFIG } from '../main/gitBinary';
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

/**
 * `git_missing`: no git binary is installed (staging refuses the attempt `git_missing`: the job waits, never fails);
 * `refused`: the resolved binary is inside the repository or the data home; `failed`: anything else.
 */
export type GitErrorKind = 'git_missing' | 'refused' | 'failed';
export class GitError extends Error {
  readonly kind: GitErrorKind;
  constructor(message: string, kind: GitErrorKind = 'failed') { super(message); this.name = 'GitError'; this.kind = kind; }
}

export function archiveArgv(commit: string): string[] {
  if (!COMMIT_RE.test(commit)) throw new GitError('the commit is not a full sha');
  return ['archive', '--format=tar', commit];
}

export function appManifestArgv(commit: string): { size: string[]; show: string[] } {
  if (!COMMIT_RE.test(commit)) throw new GitError('the commit is not a full sha');
  return { size: ['cat-file', '-s', `${commit}:${APP_MANIFEST_PATH}`], show: ['show', `${commit}:${APP_MANIFEST_PATH}`] };
}

export interface SnapshotFacts { commit: string; branch: string | null; dirty: boolean; tree: string }

/** The options every runner git call starts with (before the subcommand). */
export function gitPrefix(repoPath: string, hooksDir: string): string[] {
  return ['-C', repoPath, ...SAFE_GIT_CONFIG, '-c', `core.hooksPath=${hooksDir}`];
}

export class GitRunner {
  private readonly resolver: ReturnType<typeof gitResolver>;

  /**
   * `cwd`: the neutral working folder (the data home). `resolve`: the binary resolver (tests may inject one); the default
   * is `resolveGitBinary` with no working-folder rule (a runner started from `C:\` or the home folder still finds git).
   * Either way a found binary is kept and a miss is asked again on the next attempt (`gitResolver`).
   */
  constructor(private readonly o: { cwd: string; resolve?: () => Promise<string | null> }) {
    this.resolver = gitResolver(o.resolve ?? (() => resolveGitBinary(fsp)));
  }

  /** A folder under the data home that never exists: git finds no hooks there. */
  get hooksDir(): string { return path.join(this.o.cwd, '.nexus-no-git-hooks'); }

  binary(): Promise<string | null> {
    return this.resolver.get();
  }

  /** Whether a usable git binary is installed (a git engine asks before it reports anything). */
  async available(): Promise<boolean> {
    const bin = await this.binary();
    return !!bin && isGitBinary(bin);
  }

  private async exec(repoPath: string, argv: readonly string[], o: { signal?: AbortSignal; maxStdout?: number; timeoutMs?: number;
    onStdout?: (b: Buffer) => void | Promise<unknown> } = {}): Promise<RunResult> {
    if (typeof repoPath !== 'string' || !path.isAbsolute(repoPath) || repoPath.includes('\0')) throw new GitError('the project folder is not an absolute path');
    const bin = await this.binary();
    if (!bin || !isGitBinary(bin)) throw new GitError('git is not installed', 'git_missing');
    if (insideFolder(bin, repoPath) || insideFolder(bin, this.o.cwd)) throw new GitError('git resolves inside the repository; refused', 'refused');
    const r = await runGit(bin, [...gitPrefix(repoPath, this.hooksDir), ...argv], { cwd: this.o.cwd, env: toolEnv(),
      timeoutMs: o.timeoutMs ?? GIT_TIMEOUT_MS, maxStdout: o.maxStdout ?? SMALL, maxStderr: 4096, signal: o.signal, onStdout: o.onStdout });
    if (r.error === 'ENOENT') {
      // The binary is gone (uninstalled while the runner runs): git is missing; it is resolved again next time.
      this.resolver.forget();
      throw new GitError('git is not installed', 'git_missing');
    }
    if (r.error) throw new GitError(`git could not run (${r.error})`);
    return r;
  }

  /**
   * `git archive --format=tar <commit>` into `dest` (created exclusively), hashed while written. Returns the tar's
   * sha256 and size. Refuses a commit that is not 40 hex characters before anything is spawned.
   */
  async archiveTo(fs: RunnerFs, repoPath: string, commit: string, dest: string, o: { signal?: AbortSignal; maxBytes: number }):
    Promise<{ sha256: string; bytes: number }> {
    const argv = archiveArgv(commit);
    const fh = await fs.open(dest, 'wx');
    const h = createHash('sha256');
    let bytes = 0; let overflow = false;
    let writes: Promise<unknown> = Promise.resolve();
    let r: RunResult;
    try {
      r = await this.exec(repoPath, argv, { signal: o.signal, maxStdout: 0, timeoutMs: 10 * GIT_TIMEOUT_MS,
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
    if (r.code !== 0) throw new GitError('git archive failed: the commit is not in this repository');
    return { sha256: h.digest('hex'), bytes };
  }

  /**
   * `repo.snapshot`: HEAD's commit and tree, the short branch name (null when detached), and whether the work tree is
   * dirty. The dirty flag comes from the LENGTH of `status --porcelain=v1 -z` only: no file name leaves the runner.
   */
  async snapshot(repoPath: string, signal?: AbortSignal): Promise<SnapshotFacts> {
    const c = await this.exec(repoPath, SNAPSHOT_ARGV.commit, { signal });
    const commit = c.stdout.trim();
    if (c.code !== 0 || !COMMIT_RE.test(commit)) throw new GitError('HEAD does not resolve to a commit');
    const b = await this.exec(repoPath, SNAPSHOT_ARGV.branch, { signal });
    const branchText = b.stdout.trim();
    const branch = b.code === 0 && branchText.length > 0 && branchText.length <= 255 && !/[\0\s]/.test(branchText) ? branchText : null;
    // Only the length is read; the names in the output are never kept or sent.
    const s = await this.exec(repoPath, SNAPSHOT_ARGV.status, { signal, maxStdout: 0 });
    if (s.code !== 0) throw new GitError('git status failed');
    const t = await this.exec(repoPath, SNAPSHOT_ARGV.tree, { signal });
    const tree = t.stdout.trim();
    if (t.code !== 0 || !COMMIT_RE.test(tree)) throw new GitError('HEAD has no tree');
    return { commit, branch, dirty: s.stdoutBytes > 0, tree };
  }

  /**
   * `sde.app.assemble`: the text of `nexus.app.json` at `commit`, and nothing else. Its size is asked first; a file over
   * `maxBytes` is refused without being read.
   */
  async readAppManifest(repoPath: string, commit: string, maxBytes: number, signal?: AbortSignal):
    Promise<{ ok: true; text: Buffer } | { ok: false; reason: 'missing' | 'too_large' }> {
    const argv = appManifestArgv(commit);
    const size = await this.exec(repoPath, argv.size, { signal });
    const n = Number(size.stdout.trim());
    if (size.code !== 0 || !Number.isSafeInteger(n)) return { ok: false, reason: 'missing' };
    if (n > maxBytes) return { ok: false, reason: 'too_large' };
    const show = await this.exec(repoPath, argv.show, { signal, maxStdout: maxBytes + 1 });
    if (show.code !== 0) return { ok: false, reason: 'missing' };
    if (show.stdoutBytes > maxBytes) return { ok: false, reason: 'too_large' };
    return { ok: true, text: Buffer.from(show.stdout, 'utf8') };
  }
}
