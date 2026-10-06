import * as path from 'node:path';

/**
 * File-system root policy for the `fs:*` IPC handlers (O.9 #4). Pure: the
 * realpath / exists functions are injected so the checks are unit-tested on
 * real temp folders (test/nexus-fs-roots.test.cjs).
 *
 * Main decides which roots exist (projects, registered repos, the harness home,
 * agent folders); the renderer only names one, and it must resolve inside an
 * allowed root. Every path is checked AFTER realpath, so neither `..` nor a
 * symlink or junction can lead outside.
 */

/**
 * Lexical confinement of `rel` inside `root`. Returns the absolute path, or
 * null when it escapes. Does not touch the disk (symlinks are not followed;
 * `confineToRoot` adds that). Re-exported from fs.ts for git.ts and the
 * project/context engines: one path-escape policy in the app.
 */
export function safeJoin(root: string, rel: string): string | null {
  const absRoot = path.resolve(root);
  const absPath = path.isAbsolute(rel) ? path.normalize(rel) : path.resolve(absRoot, rel);
  const rel2 = path.relative(absRoot, absPath);
  if (rel2.startsWith('..') || path.isAbsolute(rel2)) return null;
  return absPath;
}

/**
 * Whether `target` is `root` or inside it. Win32 rules (drive letters, UNC,
 * backslashes, case-insensitive) when `platform` is `win32`, POSIX otherwise.
 */
export function isUnderRoot(root: string, target: string, platform: NodeJS.Platform = process.platform): boolean {
  if (typeof root !== 'string' || typeof target !== 'string' || !root || !target) return false;
  const p = platform === 'win32' ? path.win32 : path.posix;
  let r = p.resolve(root);
  let t = p.resolve(target);
  if (platform === 'win32') { r = r.toLowerCase(); t = t.toLowerCase(); }
  if (r === t) return true;
  const rel = p.relative(r, t);
  if (!rel) return true;
  if (rel === '..' || rel.startsWith('..' + p.sep) || p.isAbsolute(rel)) return false;
  return true;
}

/**
 * Accept a renderer-supplied root only if its real path lies inside one of the
 * `allowed` roots (also compared by real path). Returns the real path of the
 * requested root, or null. Missing folders and relative paths are refused.
 */
export function resolveAllowedRoot(
  requested: string,
  allowed: readonly string[],
  realpath: (p: string) => string
): string | null {
  if (typeof requested !== 'string' || !requested || requested.includes('\0')) return null;
  if (!path.isAbsolute(requested)) return null;
  let real: string;
  try { real = realpath(requested); } catch { return null; }
  for (const a of allowed) {
    if (typeof a !== 'string' || !a || !path.isAbsolute(a)) continue;
    let realA: string;
    try { realA = realpath(a); } catch { continue; }
    if (isUnderRoot(realA, real)) return real;
  }
  return null;
}

/**
 * Resolve `rel` under `root` so that the REAL location stays under the real
 * root. Steps: lexical `safeJoin`; walk up to the deepest existing ancestor;
 * realpath it; require it under realpath(root); return that real ancestor
 * joined with the not-yet-existing tail (so new files can be written).
 *
 * `exists` should report a dangling symlink as existing (lstat semantics): its
 * realpath then throws and the path is refused, instead of a write following
 * the link out of the root.
 */
export function confineToRoot(
  root: string,
  rel: string,
  realpath: (p: string) => string,
  exists: (p: string) => boolean
): string | null {
  if (typeof root !== 'string' || typeof rel !== 'string' || rel.includes('\0') || root.includes('\0')) return null;
  const abs = safeJoin(root, rel);
  if (!abs) return null;
  let realRoot: string;
  try { realRoot = realpath(root); } catch { return null; }
  let cur = abs;
  const tail: string[] = [];
  while (!exists(cur)) {
    const parent = path.dirname(cur);
    if (parent === cur) return null;
    tail.unshift(path.basename(cur));
    cur = parent;
  }
  let real: string;
  try { real = realpath(cur); } catch { return null; }
  if (!isUnderRoot(realRoot, real)) return null;
  return tail.length ? path.join(real, ...tail) : real;
}
