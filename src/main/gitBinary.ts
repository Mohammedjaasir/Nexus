/**
 * The one `git` binary main and the runner launch (B2a Task 11 review: a `git.exe`, `git.cmd` or `git.bat` committed at
 * a repository's root must never run). On Windows, `spawn('git', ..., { cwd })` searches the child's working folder
 * before PATH, so `git` is resolved ONCE to an absolute path instead: each ABSOLUTE PATH folder is checked with `fs`
 * (a relative entry such as `.` is skipped), then the Git for Windows install folders (or the usual POSIX ones). Only
 * the real executable name counts (`git.exe` on Windows, `git` elsewhere; never `.cmd` or `.bat`). Every call refuses a
 * binary inside the repository it runs on (`insideFolder`). Callers then spawn the absolute path with a neutral working
 * folder and pass the repository as `-C <repo>`, plus `-c core.fsmonitor=false` (a repository's config cannot start a
 * monitor process). Node only, async (no synchronous call: main's posture).
 *
 * The process's own working folder is NOT a forbidden place (review round 2): an app launched from `C:\`,
 * `C:\Program Files` or the home folder (Win+R, a terminal) must still find a Program Files, scoop or per-user git.
 * Nothing is ever launched from the working folder anyway: relative PATH entries are skipped and the binary is spawned
 * by its absolute path.
 */
import * as path from 'node:path';

export interface StatFs { stat(p: string): Promise<{ isFile(): boolean }> }

/** The install folders tried after PATH. */
export function gitInstallCandidates(platform: string, env: NodeJS.ProcessEnv): string[] {
  if (platform === 'win32') {
    const pf = env.ProgramFiles || env.PROGRAMFILES || 'C:\\Program Files';
    const pf86 = env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
    const local = env.LOCALAPPDATA;
    return [path.win32.join(pf, 'Git', 'cmd', 'git.exe'), path.win32.join(pf, 'Git', 'bin', 'git.exe'), path.win32.join(pf86, 'Git', 'cmd', 'git.exe'),
      ...(local ? [path.win32.join(local, 'Programs', 'Git', 'cmd', 'git.exe')] : [])];
  }
  if (platform === 'darwin') return ['/usr/bin/git', '/usr/local/bin/git', '/opt/homebrew/bin/git'];
  return ['/usr/bin/git', '/usr/local/bin/git'];
}

/** Whether `p` is `folder` or inside it (case-insensitive on Windows). */
export function insideFolder(p: string, folder: string, platform: string = process.platform): boolean {
  if (typeof p !== 'string' || typeof folder !== 'string' || !p || !folder) return false;
  const P = platform === 'win32' ? path.win32 : path.posix;
  const norm = (x: string): string => { const r = P.resolve(x); return platform === 'win32' ? r.toLowerCase() : r; };
  const rel = P.relative(norm(folder), norm(p));
  return rel === '' || (!rel.startsWith('..') && !P.isAbsolute(rel));
}

/** The git executable's file name on this platform. */
export function isGitBinary(bin: string, platform: string = process.platform): boolean {
  const P = platform === 'win32' ? path.win32 : path.posix;
  if (typeof bin !== 'string' || !bin || bin.includes('\0') || !P.isAbsolute(bin)) return false;
  const base = P.basename(bin);
  return platform === 'win32' ? base.toLowerCase() === 'git.exe' : base === 'git';
}

/**
 * Finds git: absolute PATH folders first, then the install folders; never one inside a `notInside` folder (an optional
 * rule for callers that need it; main and the runner pass none, see `gitResolver`).
 */
export async function resolveGitBinary(fs: StatFs, o: { env?: NodeJS.ProcessEnv; platform?: string; notInside?: readonly string[] } = {}):
  Promise<string | null> {
  const env = o.env ?? process.env;
  const platform = o.platform ?? process.platform;
  const P = platform === 'win32' ? path.win32 : path.posix;
  const name = platform === 'win32' ? 'git.exe' : 'git';
  const dirs = String(env.PATH ?? env.Path ?? '').split(platform === 'win32' ? ';' : ':')
    .map((d) => d.trim().replace(/^"(.*)"$/, '$1')).filter((d) => d.length > 0 && P.isAbsolute(d));
  const forbidden = (o.notInside ?? []).filter((x) => typeof x === 'string' && x.length > 0);
  for (const c of [...dirs.map((d) => P.join(d, name)), ...gitInstallCandidates(platform, env)]) {
    if (!isGitBinary(c, platform) || forbidden.some((f) => insideFolder(c, f, platform))) continue;
    try { if ((await fs.stat(c)).isFile()) return c; } catch { /* not there */ }
  }
  return null;
}

/**
 * How main (src/main/git.ts) and the runner (GitRunner) keep the binary `find` returns (both call `resolveGitBinary`
 * with no working-folder rule). A found binary is kept; a miss is not (a git installed while the app runs is found on
 * the next call, so a job waiting for git proceeds without a restart); `forget()` drops a binary that stopped launching
 * (ENOENT: uninstalled meanwhile). A `find` that throws counts as a miss.
 */
export function gitResolver(find: () => Promise<string | null>): { get(): Promise<string | null>; forget(): void } {
  let found: Promise<string | null> | null = null;
  return {
    get(): Promise<string | null> {
      if (found) return found;
      const p = Promise.resolve().then(find).then((bin) => (typeof bin === 'string' ? bin : null), () => null);
      found = p;
      void p.then((bin) => { if (bin === null && found === p) found = null; });
      return p;
    },
    forget(): void { found = null; }
  };
}

/** The git config every Nexus git call carries (a repository's own config cannot start a process for it). */
export const SAFE_GIT_CONFIG: readonly string[] = Object.freeze(['-c', 'core.fsmonitor=false']);
