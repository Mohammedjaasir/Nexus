/**
 * Staging an attempt's inputs into `work/<jobId>/<n>/in` (B2a Task 11), before any container exists.
 * - Source: `git archive --format=tar <commit>` written to `in/src.tar` and hashed while written (git.ts). The user's
 *   repository is never written: no worktree, no ref, no checkout. A commit that is not 40 hex characters is refused
 *   before git is spawned.
 * - Blobs: each input file is copied from `objects/<2>/<62>` to `in/<relPath>` and re-hashed while copied; bytes that
 *   do not hash to the recorded sha256 (or a missing object) refuse the attempt (`input_changed`) and the copy is removed.
 * - Dependency caches: the plan names the deps volume (`nexus-deps-<profile>-<lock12>`); the runner creates it with the
 *   attempt's labels when it does not exist yet (core.ts), read-only unless the plan is the approved install.
 * `staging.json` beside `in/` records what was staged (hashes and counts only).
 */
import * as path from 'node:path';
import type { ServicePlan, ToolPlan } from '../shared/nexus/execution';
import { archiveTo, COMMIT_RE, GitError } from './git';
import { copyHashing, SourceChangedError } from './objectStore';
import { badName } from './outputs';
import { ensureDirUnder, errCode, noLinkUnder, type HomePaths } from './paths';
import type { RunnerFs } from './types';

export const SOURCE_MAX_BYTES = 2 * 2 ** 30;
export const INPUT_MAX_BYTES = 2 * 2 ** 30;

export type StageResult =
  | { ok: true; source: { sha256: string; bytes: number } | null; blobs: number }
  | { ok: false; reason: 'input_changed' | 'bad_plan'; detail: string };

/** A staged relative path: plain segments only. */
export function stagedPathOk(rel: string): boolean {
  return typeof rel === 'string' && rel.length > 0 && rel.length <= 1024 && !rel.startsWith('/') && rel.split('/').every((s) => !badName(s));
}

export async function stageInputs(fs: RunnerFs, paths: HomePaths, plan: ToolPlan | ServicePlan, workDir: string, signal?: AbortSignal): Promise<StageResult> {
  const inDir = path.join(workDir, 'in');
  const outDir = path.join(workDir, 'out');
  if (!(await ensureDirUnder(fs, paths.root, inDir)) || !(await ensureDirUnder(fs, paths.root, outDir))) {
    return { ok: false, reason: 'bad_plan', detail: 'the staging folder is not a plain folder under the data home' };
  }
  let source: { sha256: string; bytes: number } | null = null;
  const src = plan.staging.source;
  if (src) {
    if (typeof src.commit !== 'string' || !COMMIT_RE.test(src.commit)) return { ok: false, reason: 'bad_plan', detail: 'the commit is not a full sha' };
    if (typeof src.repoPath !== 'string' || !path.isAbsolute(src.repoPath) || src.repoPath.includes('\0')) {
      return { ok: false, reason: 'bad_plan', detail: 'the project folder is not an absolute path' };
    }
    const tar = path.join(inDir, 'src.tar');
    try { await fs.unlink(tar); } catch (e) { if (errCode(e) !== 'ENOENT') return { ok: false, reason: 'bad_plan', detail: 'in/src.tar cannot be replaced' }; }
    try {
      source = await archiveTo(fs, src.repoPath, src.commit, tar, { signal, maxBytes: SOURCE_MAX_BYTES });
    } catch (e) {
      return { ok: false, reason: 'bad_plan', detail: e instanceof GitError ? e.message : 'the checkout could not be written' };
    }
  }
  let blobs = 0;
  for (const b of plan.staging.blobs) {
    if (!stagedPathOk(b.relPath)) return { ok: false, reason: 'bad_plan', detail: 'a staged input path is not a plain relative path' };
    let from: string;
    try { from = paths.objectPath(b.sha256); } catch { return { ok: false, reason: 'bad_plan', detail: 'a staged input has no sha256' }; }
    const dest = path.join(inDir, ...b.relPath.split('/'));
    if (!(await ensureDirUnder(fs, paths.root, path.dirname(dest)))) return { ok: false, reason: 'bad_plan', detail: 'a staged input folder is not a plain folder' };
    if (!(await noLinkUnder(fs, paths.root, from))) return { ok: false, reason: 'input_changed', detail: `${b.relPath}: the stored object is not a plain file` };
    try {
      const h = await copyHashing(fs, from, dest, INPUT_MAX_BYTES);
      if (h.sha256 !== b.sha256) {
        try { await fs.unlink(dest); } catch { /* best effort */ }
        return { ok: false, reason: 'input_changed', detail: `${b.relPath}: the stored bytes no longer match their hash` };
      }
    } catch (e) {
      try { await fs.unlink(dest); } catch { /* best effort */ }
      if (errCode(e) === 'ENOENT') return { ok: false, reason: 'input_changed', detail: `${b.relPath}: the stored object is missing` };
      if (e instanceof SourceChangedError) return { ok: false, reason: 'input_changed', detail: `${b.relPath}: ${e.message}` };
      if (errCode(e) === 'EEXIST') return { ok: false, reason: 'bad_plan', detail: `${b.relPath}: staged twice` };
      throw e;
    }
    blobs++;
  }
  await fs.writeFile(path.join(workDir, 'staging.json'), JSON.stringify({ source, blobs }), 'utf8');
  return { ok: true, source, blobs };
}
