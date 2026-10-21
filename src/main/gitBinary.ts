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
 * The paths `resolveGitBinary` tries, in its order: `git.exe` (`git`) in each ABSOLUTE PATH folder, then the install
 * folders; only real executable names (`isGitBinary`), never one inside a `notInside` folder. Pure: no file system. The
 * legacy hive (src/main/hive.ts, whose git is synchronous) checks these same candidates itself (B2a close).
 */
export function gitBinaryCandidates(o: { env?: NodeJS.ProcessEnv; platform?: string; notInside?: readonly string[] } = {}): string[] {
  const env = o.env ?? process.env;
  const platform = o.platform ?? process.platform;
  const P = platform === 'win32' ? path.win32 : path.posix;
  const name = platform === 'win32' ? 'git.exe' : 'git';
  const dirs = String(env.PATH ?? env.Path ?? '').split(platform === 'win32' ? ';' : ':')
    .map((d) => d.trim().replace(/^"(.*)"$/, '$1')).filter((d) => d.length > 0 && P.isAbsolute(d));
  const forbidden = (o.notInside ?? []).filter((x) => typeof x === 'string' && x.length > 0);
  return [...dirs.map((d) => P.join(d, name)), ...gitInstallCandidates(platform, env)]
    .filter((c) => isGitBinary(c, platform) && !forbidden.some((f) => insideFolder(c, f, platform)));
}

/**
 * Finds git: absolute PATH folders first, then the install folders; never one inside a `notInside` folder (an optional
 * rule for callers that need it; main and the runner pass none, see `gitResolver`).
 */
export async function resolveGitBinary(fs: StatFs, o: { env?: NodeJS.ProcessEnv; platform?: string; notInside?: readonly string[] } = {}):
  Promise<string | null> {
  for (const c of gitBinaryCandidates(o)) {
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

/**
 * The git config every Nexus git call carries: no file system monitor process. It does NOT stop filter drivers (B2a final
 * review B1): a `filter.<name>.{smudge,clean,process}` from any config scope (Git for Windows' system config ships
 * `filter.lfs.*`, and git-lfs reaches the network with the user's credentials) runs on the host when an attribute names
 * it and a call converts content (`archive` smudges, `status` and a worktree `diff` clean). Callers that read content
 * neutralise every configured driver first (`FILTER_CONFIG_ARGV`, `filterDriverNames`, `neutralizeFilterArgs`) and set
 * `GIT_LFS_SKIP_SMUDGE=1`; an LFS file therefore stages as its pointer text, never as the large file.
 */
export const SAFE_GIT_CONFIG: readonly string[] = Object.freeze(['-c', 'core.fsmonitor=false']);

/**
 * The config every legacy `git:*` call in src/main/git.ts carries besides SAFE_GIT_CONFIG (B2a close, user decision
 * 2026-10-21): a repository's `log.showSignature=true` would make `log` (and `show`) verify signed commits by running the
 * `gpg.program` its own config names, so signatures are not shown, and every signature program is the resolved git
 * binary itself (as the runner's `inertSignatureArgs`): git refuses gpg's options and exits, nothing of the repository's
 * choosing runs. No legacy view parses signature output.
 */
export function inertSignatureConfig(gitBin: string): [string, string][] {
  return [['log.showSignature', 'false'], ['gpg.program', gitBin], ['gpg.ssh.program', gitBin], ['gpg.x509.program', gitBin]];
}

/**
 * `pairs` as command-scope git config in the environment (`GIT_CONFIG_COUNT`, `GIT_CONFIG_KEY_<n>`,
 * `GIT_CONFIG_VALUE_<n>`, git 2.31 and later): the same effect as `-c key=value` (it overrides every config file, the
 * repository's own included) without changing the argv. Entries already in `base` are kept; ours are appended after them.
 */
export function configEnv(pairs: readonly (readonly [string, string])[], base: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const raw = base.GIT_CONFIG_COUNT;
  const n0 = typeof raw === 'string' && /^\d{1,4}$/.test(raw) ? Number(raw) : 0;
  const out: Record<string, string> = {};
  pairs.forEach(([k, v], i) => { out[`GIT_CONFIG_KEY_${n0 + i}`] = k; out[`GIT_CONFIG_VALUE_${n0 + i}`] = v; });
  out.GIT_CONFIG_COUNT = String(n0 + pairs.length);
  return out;
}

/** Diff options for every legacy call that can produce a diff (diff, diff-tree, show): no external diff driver, no textconv. */
export const NO_DIFF_DRIVERS: readonly string[] = Object.freeze(['--no-ext-diff', '--no-textconv']);

/** Read-only: the names of every configured `filter.*` key, one per line (exit 1 with no output when there is none). */
export const FILTER_CONFIG_ARGV: readonly string[] = Object.freeze(['config', '--name-only', '--get-regexp', '^filter\\.']);

/** The environment a content-reading git call adds: git-lfs (if it runs at all) never downloads. */
export const FILTER_SAFE_ENV: Readonly<Record<string, string>> = Object.freeze({ GIT_LFS_SKIP_SMUDGE: '1' });

/**
 * The filter driver names in `git config --name-only --get-regexp "^filter\."` output (`filter.<name>.<key>` per line;
 * the name may hold dots), deduplicated in order. Null when a name cannot be passed back safely as `-c <key>=` (it holds
 * `=` or a control character): the caller then refuses the git call (fail closed). A key with no subsection is skipped.
 */
export function filterDriverNames(stdout: string): string[] | null {
  const out: string[] = [];
  for (const raw of String(stdout).split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (line === '') continue;
    if (!line.toLowerCase().startsWith('filter.')) return null;
    const last = line.lastIndexOf('.');
    if (last <= 'filter.'.length - 1) continue;              // `filter.<key>`: no driver named
    const name = line.slice('filter.'.length, last);
    if (name === '') continue;
    if (/[=\u0000-\u001f\u007f]/.test(name)) return null;
    if (!out.includes(name)) out.push(name);
  }
  return out;
}

/** `-c` pairs that switch every named driver off: no smudge, no clean, no long-running process, never required. */
export function neutralizeFilterArgs(names: readonly string[]): string[] {
  const out: string[] = [];
  for (const n of names) {
    out.push('-c', `filter.${n}.smudge=`, '-c', `filter.${n}.clean=`, '-c', `filter.${n}.process=`, '-c', `filter.${n}.required=false`);
  }
  return out;
}
