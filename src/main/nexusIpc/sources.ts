/**
 * Main-process adapters behind UserSaves' SourcePorts: the project folder, a confined
 * text-file read and a commit resolve. Outside src/main/nexus on purpose: the core
 * never touches the file system or git (see the composition pins).
 *
 * Trust boundary (B0a, O.9 #4):
 * - The folder comes ONLY from the stored project row (`getProject(id).rootPath`) and
 *   must be accepted by `acceptFsRoot` (its real path lies inside a root main knows).
 *   The renderer never names a folder.
 * - A relative path is refused when absolute (POSIX, drive letter or UNC), when it holds
 *   NUL, or when any segment is `..`. Backslashes become '/'. Every existing step is then
 *   resolved by realpath (symlinks and junctions followed) and must stay inside the real
 *   root, before and after the read.
 * - Only a regular file is read. Its size is checked before reading, and at most
 *   `maxBytes + 1` bytes are ever read, so a file that grows cannot slip past the cap.
 * - A commit is resolved by git in that folder (git.ts, async spawn; never a shell).
 * Async only: no synchronous file system or process call here.
 */
import { lstat, open, realpath, stat } from 'node:fs/promises';
import * as path from 'node:path';
import { isUnderRoot } from '../fsRoots';
import { resolveCommit } from '../git';
import type { SourcePorts } from '../nexus/commands/userSaves';

export interface SourcePortDeps {
  /** main's acceptFsRoot: the real path of an allowed root, or null. */
  acceptFsRoot: (root: string) => string | null;
  /** The stored project row (projectManager.getProject), or null. */
  getProject: (id: string) => { rootPath?: unknown } | null | undefined;
}

const MAX_REL_PATH_CHARS = 1024;

/**
 * The segments of a renderer-supplied relative path, or null when it is refused:
 * empty, too long, NUL, absolute (POSIX, drive letter, UNC) or any '..' segment.
 * '.' and empty segments are dropped. On Windows a segment holding ':' is refused too.
 */
export function relSegments(rel: unknown, platform: NodeJS.Platform = process.platform): string[] | null {
  if (typeof rel !== 'string' || rel.length === 0 || rel.length > MAX_REL_PATH_CHARS || rel.includes('\0')) return null;
  const s = rel.replace(/\\/g, '/');
  if (s.startsWith('/') || /^[A-Za-z]:/.test(s) || path.isAbsolute(rel)) return null;
  const parts = s.split('/').filter((x) => x.length > 0 && x !== '.');
  if (parts.length === 0 || parts.some((x) => x === '..')) return null;
  // Windows: a colon in a segment names an alternate data stream (or a drive); never part of a project file name.
  if (platform === 'win32' && parts.some((x) => x.includes(':'))) return null;
  return parts;
}

const errCode = (e: unknown): string => (e && typeof e === 'object' && 'code' in e ? String((e as { code: unknown }).code) : '');

export function createSourcePorts(deps: SourcePortDeps): SourcePorts {
  return {
    async projectRoot(projectId: string): Promise<string | null> {
      if (typeof projectId !== 'string' || projectId.length === 0) return null;
      let row: { rootPath?: unknown } | null | undefined;
      try { row = deps.getProject(projectId); } catch { return null; }
      const rootPath = row?.rootPath;
      if (typeof rootPath !== 'string' || rootPath.trim().length === 0) return null;
      let accepted: string | null;
      try { accepted = deps.acceptFsRoot(rootPath); } catch { return null; }
      if (typeof accepted !== 'string' || accepted.length === 0) return null;
      try {
        const s = await stat(accepted);
        return s.isDirectory() ? accepted : null;
      } catch { return null; }
    },

    async readFile(root: string, rel: string, maxBytes: number) {
      const parts = relSegments(rel);
      if (!parts || typeof root !== 'string' || !root || root.includes('\0')) return { error: 'path_refused' as const };
      if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) return { error: 'too_large' as const };
      let realRoot: string;
      try { realRoot = await realpath(root); } catch { return { error: 'path_refused' as const }; }
      // Walk down one segment at a time: every existing step is resolved by realpath and must stay inside
      // the real root, so a missing file behind a link that leaves the project is refused, not reported missing.
      let cur = realRoot;
      for (let k = 0; k < parts.length; k++) {
        const next = path.join(cur, parts[k]);
        try { await lstat(next); } catch (e) {
          return errCode(e) === 'ENOENT' || errCode(e) === 'ENOTDIR' ? { error: 'not_found' as const } : { error: 'path_refused' as const };
        }
        let real: string;
        try { real = await realpath(next); } catch { return { error: 'path_refused' as const }; }   // a dangling link
        if (!isUnderRoot(realRoot, real)) return { error: 'path_refused' as const };
        cur = real;
      }
      let st;
      try { st = await stat(cur); } catch { return { error: 'not_found' as const }; }
      if (!st.isFile()) return { error: 'not_a_file' as const };
      if (st.size > maxBytes) return { error: 'too_large' as const };
      let fh;
      try { fh = await open(cur, 'r'); } catch { return { error: 'not_found' as const }; }
      try {
        const fst = await fh.stat();
        if (!fst.isFile()) return { error: 'not_a_file' as const };
        if (fst.size > maxBytes) return { error: 'too_large' as const };
        const buf = Buffer.alloc(maxBytes + 1);
        let n = 0;
        while (n < buf.length) {
          const { bytesRead } = await fh.read(buf, n, buf.length - n, n);
          if (bytesRead === 0) break;
          n += bytesRead;
        }
        if (n > maxBytes) return { error: 'too_large' as const };
        // The file must still be where it was confined (a link swapped during the read is refused).
        let after: string;
        try { after = await realpath(cur); } catch { return { error: 'path_refused' as const }; }
        if (after !== cur || !isUnderRoot(realRoot, after)) return { error: 'path_refused' as const };
        const normalisedRel = path.relative(realRoot, cur).split(path.sep).join('/');
        if (!normalisedRel || normalisedRel.startsWith('..') || path.isAbsolute(normalisedRel)) return { error: 'path_refused' as const };
        return { bytes: Buffer.from(buf.subarray(0, n)), normalisedRel };
      } catch {
        return { error: 'not_found' as const };
      } finally {
        await fh.close().catch(() => {});
      }
    },

    async resolveCommit(root: string, sha: string) {
      return resolveCommit(root, sha);
    }
  };
}
