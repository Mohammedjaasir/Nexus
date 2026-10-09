/**
 * The build validators (build, candidate, blocking). Pure, over the facts main recorded at ingest:
 * - `build.exit_zero` v1: the producing attempt exited 0 (never enough on its own).
 * - `build.manifest_present` v1: the output tree holds at least one file and more than 0 bytes. A missing
 *   tree, an empty `dist/` folder, or a folder holding only empty folders fails; a README beside it counts for nothing.
 * - `build.output_hashed` v1: every file of the tree has a stored blob, and the stored manifest hash is the
 *   sha256 of the canonical per-file list.
 */
import { createHash } from 'node:crypto';
import { canonicalJson } from '../../db/canonical';
import { errored, failed, passed, type ValidatorOutcome } from '../normalized';

export const EXIT_ZERO = 'build.exit_zero';
export const MANIFEST_PRESENT = 'build.manifest_present';
export const OUTPUT_HASHED = 'build.output_hashed';
export const VERSION = '1';

export interface TreeFile { path: string; sha256: string; bytes: number }

/** The manifest hash: sha256 of the canonical JSON of the per-file list sorted by path. */
export function manifestSha256(files: readonly TreeFile[]): string {
  const list = [...files].map((f) => ({ path: f.path, sha256: f.sha256, bytes: f.bytes }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return createHash('sha256').update(canonicalJson(list)).digest('hex');
}

export function exitZero(f: { exit: { code: number | null; signal?: string; oomKilled: boolean } | null }): ValidatorOutcome {
  if (!f.exit) return errored('no_exit_record', 'Checks could not run: the build attempt has no recorded exit.');
  const ev = [{ type: 'exit' as const, code: f.exit.code, ...(f.exit.signal ? { signal: f.exit.signal } : {}), oomKilled: f.exit.oomKilled }];
  if (f.exit.code !== 0) return failed('nonzero_exit', `The build exited with code ${f.exit.code}.`, ev);
  return passed('The build exited with code 0.', ev);
}

export function manifestPresent(f: { files: readonly TreeFile[]; manifestSha256: string | null }): ValidatorOutcome {
  const bytes = f.files.reduce((s, x) => s + x.bytes, 0);
  const sha = f.manifestSha256 ?? '0'.repeat(64);
  const ev = [
    { type: 'file' as const, path: 'manifest', sha256: sha, bytes },
    { type: 'number' as const, name: 'files', value: f.files.length, bound: { op: '>=' as const, value: 1 }, source: { blobSha256: sha, pointer: '/length' } },
    { type: 'number' as const, name: 'bytes', value: bytes, bound: { op: '>' as const, value: 0 }, source: { blobSha256: sha, pointer: '/bytes' } }
  ];
  if (f.files.length === 0) return failed('empty_tree', 'The build output tree is missing or empty.', ev);
  if (bytes === 0) return failed('empty_tree', 'Every file of the build output is empty.', ev);
  return passed(`The build output holds ${f.files.length} file(s).`, ev);
}

export function outputHashed(f: { files: readonly TreeFile[]; recorded: readonly string[]; manifestSha256: string | null; fileCount: number | null }): ValidatorOutcome {
  const computed = manifestSha256(f.files);
  const ev = [{ type: 'hash' as const, label: 'manifest', sha256: computed }];
  const have = new Set(f.recorded);
  const missing = f.files.filter((x) => !have.has(x.sha256));
  if (missing.length > 0) return failed('unhashed_file', `${missing.length} file(s) of the build have no stored blob.`, ev);
  if (f.manifestSha256 !== computed || (f.fileCount !== null && f.fileCount !== f.files.length)) {
    return failed('manifest_mismatch', 'The stored manifest does not match the stored files.', ev);
  }
  return passed('Every file of the build is stored and hashed.', ev);
}
