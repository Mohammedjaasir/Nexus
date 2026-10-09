/**
 * Collecting `/out` (B2a Task 11). The host side of the `/out` bind mount is walked with lstat only, never following
 * a link, so nothing outside `/out` is read. The walk refuses (and no output of the attempt is trusted):
 * - a symlink or a junction (`symlink`), a file with a second hard link (`hardlink`: a second name for bytes that may
 *   live elsewhere), a FIFO, socket or device (`special_file`), a name holding NUL, `..`, a separator, `:`, a control
 *   character, a trailing dot or space, or a Windows device name (`bad_name`);
 * - more files than the contract allows (`too_many_files`), more bytes than `outputMaxBytes` (`output_too_large`).
 * The refused entry's relative path is reported (escaped). Every accepted file is hashed into `objects/tmp` and
 * renamed into place (objectStore.ts); a rename that stays locked fails `file_locked`.
 */
import * as path from 'node:path';
import type { OutputErrorCode, StagedOutput } from '../shared/nexus/execution';
import { errCode } from './paths';
import { FileLockedError, SourceChangedError, type ObjectStore } from './objectStore';
import type { RunnerFs } from './types';

export const MAX_OUT_DEPTH = 64;
const RESERVED = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;

export interface OutFile { rel: string; abs: string; bytes: number }
export type OutScan = { ok: true; files: OutFile[]; bytes: number } | { ok: false; code: OutputErrorCode; entry: string };

/** Why a single name is refused, or null. */
export function badName(name: string): boolean {
  if (typeof name !== 'string' || name.length === 0 || name.length > 255) return true;
  if (name.includes('..') || /[\x00-\x1f\x7f/\\:]/.test(name)) return true;
  if (/[. ]$/.test(name) || RESERVED.test(name)) return true;
  return false;
}

/** A printable, bounded form of a refused entry (control characters escaped; at most 200 characters). */
export function showEntry(rel: string): string {
  const s = JSON.stringify(rel).slice(1, -1);
  return s.length > 200 ? `${s.slice(0, 199)}…` : s;
}

/**
 * Walk `outDir`. `stopAtBytes`: the size guard's early stop (the walk ends as soon as the total passes it, reporting
 * `output_too_large`). Never follows a link; never opens a file.
 */
export async function scanOut(fs: RunnerFs, outDir: string, limits: { maxFiles: number; maxBytes: number }): Promise<OutScan> {
  let root;
  try { root = await fs.lstat(outDir); } catch (e) {
    if (errCode(e) === 'ENOENT') return { ok: true, files: [], bytes: 0 };
    throw e;
  }
  if (root.isSymbolicLink()) return { ok: false, code: 'symlink', entry: '.' };
  if (!root.isDirectory()) return { ok: false, code: 'special_file', entry: '.' };
  const files: OutFile[] = [];
  let bytes = 0;
  const walk = async (dir: string, rel: string, depth: number): Promise<OutScan | null> => {
    if (depth > MAX_OUT_DEPTH) return { ok: false, code: 'too_many_files', entry: rel };
    const names = (await fs.readdir(dir)).sort();
    for (const name of names) {
      const r = rel ? `${rel}/${name}` : name;
      if (badName(name)) return { ok: false, code: 'bad_name', entry: r };
      const abs = path.join(dir, name);
      const st = await fs.lstat(abs);
      if (st.isSymbolicLink()) return { ok: false, code: 'symlink', entry: r };
      if (st.isDirectory()) {
        const sub = await walk(abs, r, depth + 1);
        if (sub) return sub;
        continue;
      }
      if (!st.isFile()) return { ok: false, code: 'special_file', entry: r };
      if (st.nlink > 1) return { ok: false, code: 'hardlink', entry: r };
      files.push({ rel: r, abs, bytes: st.size });
      bytes += st.size;
      if (files.length > limits.maxFiles) return { ok: false, code: 'too_many_files', entry: r };
      if (bytes > limits.maxBytes) return { ok: false, code: 'output_too_large', entry: r };
    }
    return null;
  };
  const bad = await walk(outDir, '', 0);
  return bad ?? { ok: true, files, bytes };
}

/** The size guard's measure of `/out`: total bytes of regular files (lstat only; links are not followed or counted). */
export async function outBytes(fs: RunnerFs, outDir: string, stopAbove: number): Promise<number> {
  let total = 0;
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > MAX_OUT_DEPTH || total > stopAbove) return;
    let names: string[];
    try { names = await fs.readdir(dir); } catch { return; }
    for (const name of names) {
      let st;
      try { st = await fs.lstat(path.join(dir, name)); } catch { continue; }
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) await walk(path.join(dir, name), depth + 1);
      else if (st.isFile()) total += st.size;
      if (total > stopAbove) return;
    }
  };
  try {
    const st = await fs.lstat(outDir);
    if (!st.isDirectory() || st.isSymbolicLink()) return 0;
  } catch { return 0; }
  await walk(outDir, 0);
  return total;
}

const MEDIA: Record<string, string> = {
  '.xml': 'application/xml', '.json': 'application/json', '.txt': 'text/plain', '.log': 'text/plain', '.md': 'text/markdown',
  '.js': 'text/javascript', '.mjs': 'text/javascript', '.cjs': 'text/javascript', '.css': 'text/css', '.html': 'text/html',
  '.htm': 'text/html', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.ico': 'image/x-icon', '.map': 'application/json', '.wasm': 'application/wasm', '.whl': 'application/zip',
  '.zip': 'application/zip', '.tar': 'application/x-tar', '.gz': 'application/gzip', '.tgz': 'application/gzip', '.sha256': 'text/plain',
  '.py': 'text/x-python', '.ts': 'text/plain', '.csv': 'text/csv', '.woff': 'font/woff', '.woff2': 'font/woff2'
};
export function mediaTypeOf(rel: string): string {
  return MEDIA[path.extname(rel).toLowerCase()] ?? 'application/octet-stream';
}

export type Collected = { ok: true; outputs: StagedOutput[] } | { ok: false; code: OutputErrorCode; entry: string };

/** Scan, then hash every file into the object store. Any refusal returns its code and entry (nothing is trusted). */
export async function collectOut(fs: RunnerFs, store: ObjectStore, outDir: string, limits: { maxFiles: number; maxBytes: number }): Promise<Collected> {
  const scan = await scanOut(fs, outDir, limits);
  if (!scan.ok) return scan;
  const outputs: StagedOutput[] = [];
  for (const f of scan.files) {
    try {
      const h = await store.ingestFile(f.abs, { maxBytes: limits.maxBytes });
      outputs.push({ relPath: f.rel, sha256: h.sha256, bytes: h.bytes, mediaType: mediaTypeOf(f.rel) });
    } catch (e) {
      if (e instanceof FileLockedError) return { ok: false, code: 'file_locked', entry: f.rel };
      if (e instanceof SourceChangedError) {
        // A file swapped or still being written after the container stopped is held by something else: `file_locked`.
        const code: OutputErrorCode = /hard link/.test(e.message) ? 'hardlink' : /regular/.test(e.message) ? 'special_file'
          : /limit/.test(e.message) ? 'output_too_large' : 'file_locked';
        return { ok: false, code, entry: f.rel };
      }
      if (['EPERM', 'EBUSY', 'EACCES'].includes(errCode(e))) return { ok: false, code: 'file_locked', entry: f.rel };
      throw e;
    }
  }
  return { ok: true, outputs };
}
