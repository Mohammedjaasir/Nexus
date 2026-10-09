/**
 * The Nexus data home: `<userData>/nexus`. Every host path the execution core uses is derived
 * here, in main, from ids main owns; the renderer never names one.
 *
 *   objects/<2 hex>/<62 hex>     content-addressed blobs; objects/tmp/ for in-flight writes
 *   logs/jobs/<jobId>/<n>.log    attempt logs (the stored `job_attempts.log_path` is this relative form)
 *   logs/images/<buildId>.log    image build logs
 *   work/<jobId>/<n>/{in,out}    attempt staging
 *
 * Confinement (`confineToDataHome`) reuses B1's segment rules (`relSegments`, applied with the
 * Windows rules on every platform): a relative path is refused when it is empty, absolute
 * (POSIX, drive letter, UNC, `\\?\`), holds NUL or a `..` segment, names an alternate data stream
 * (`:`), ends a segment in a dot or a space, or names a reserved device. Each existing step is
 * then checked with lstat: any link (a symlink or a junction) is refused, wherever it points, and
 * the real path of every step must stay under the real data home (fsRoots.isUnderRoot). The data
 * home itself must not be a link.
 *
 * Async only (fs.promises): no synchronous file-system call here (the main posture ratchet).
 */
import { lstat, mkdir, realpath, statfs } from 'node:fs/promises';
import * as path from 'node:path';
import { isUnderRoot } from '../fsRoots';
import { relSegments } from '../nexusIpc/sources';
import { PlatformError } from '../nexus/errors';

export const DATA_HOME_DIR = 'nexus';
/** The DDL bound on `job_attempts.log_path` and `image_builds.log_path`. */
export const MAX_LOG_PATH_CHARS = 200;
export const MAX_ATTEMPT_N = 1_000_000;
const ID_RE = /^[0-9A-Za-z_-]{1,64}$/;
const SHA_RE = /^[0-9a-f]{64}$/;

export interface DataHome {
  /** Absolute `<userData>/nexus`. */
  readonly root: string;
  readonly objectsDir: string;
  /** In-flight object writes; renamed into place once hashed. Recovery sweeps it. */
  readonly objectsTmpDir: string;
  readonly logsDir: string;
  readonly workDir: string;
  /** Absolute path of a blob's bytes. */
  objectPath(sha256: string): string;
  /** Absolute staging folder of one attempt (`in/` and `out/` live under it). */
  attemptWorkDir(jobId: string, n: number): string;
  /** RELATIVE log path of one attempt, as stored in `job_attempts.log_path` (forward slashes). */
  attemptLogPath(jobId: string, n: number): string;
  /** RELATIVE log path of one image build, as stored in `image_builds.log_path`. */
  imageLogPath(buildId: string): string;
  /** The absolute, confined location of `rel` under the data home, or null when it is refused. */
  confineToDataHome(rel: string): Promise<string | null>;
  /** Free bytes for an unprivileged writer at `dir` (default: the data home), or null when unknown. */
  freeBytesAt(dir?: string): Promise<number | null>;
  /** Create the layout (idempotent). Refuses a data home that is a link. */
  ensure(): Promise<void>;
}

function checkId(id: unknown, field: string): string {
  if (typeof id !== 'string' || !ID_RE.test(id)) throw new PlatformError('invalid', `${field} is not a plain id`, { field });
  return id;
}
function checkN(n: unknown): number {
  if (!Number.isSafeInteger(n) || (n as number) < 1 || (n as number) > MAX_ATTEMPT_N) throw new PlatformError('invalid', 'attempt number out of range', { field: 'n' });
  return n as number;
}

/** Whether a relative log path satisfies the DDL CHECK on `log_path` (mirrors it; the database stays the authority). */
export function satisfiesLogPathCheck(p: string): boolean {
  return typeof p === 'string' && p.length <= MAX_LOG_PATH_CHARS && !p.startsWith('/') && !p.includes(':') && !p.includes('..') && !p.includes('\\');
}

function relLog(parts: string[]): string {
  const rel = parts.join('/');
  // Belt and braces: the result must be a confinable relative path AND satisfy the DDL CHECK.
  if (!satisfiesLogPathCheck(rel) || relSegments(rel, 'win32') === null) throw new PlatformError('invalid', 'the log path is not storable', { field: 'log_path' });
  return rel;
}

const errCode = (e: unknown): string => (e && typeof e === 'object' && 'code' in e ? String((e as { code: unknown }).code) : '');

export async function freeBytesAt(dir: string): Promise<number | null> {
  if (typeof dir !== 'string' || !dir || dir.includes('\0') || !path.isAbsolute(dir)) return null;
  let cur = path.resolve(dir);
  for (;;) {
    try {
      const s = await statfs(cur);
      const free = Number(s.bavail) * Number(s.bsize);
      return Number.isFinite(free) && free >= 0 ? free : null;
    } catch (e) {
      const parent = path.dirname(cur);
      if (errCode(e) !== 'ENOENT' || parent === cur) return null;
      cur = parent;                                   // a folder not created yet: measure the volume it will live on
    }
  }
}

/** Confine `rel` under `root` (see the module comment). Exported for tests on temp folders. */
export async function confineUnder(root: string, rel: string): Promise<string | null> {
  const parts = relSegments(rel, 'win32');
  if (!parts || typeof root !== 'string' || !root || root.includes('\0') || !path.isAbsolute(root)) return null;
  let realRoot: string;
  try {
    if ((await lstat(root)).isSymbolicLink()) return null;
    realRoot = await realpath(root);
  } catch { return null; }
  let cur = realRoot;
  for (let k = 0; k < parts.length; k++) {
    const next = path.join(cur, parts[k]);
    let st;
    try { st = await lstat(next); } catch (e) {
      // Not there yet: the rest is a tail to be created under a confined, link-free parent.
      if (errCode(e) === 'ENOENT') return path.join(cur, ...parts.slice(k));
      return null;
    }
    if (st.isSymbolicLink()) return null;             // a symlink or a junction, wherever it points
    if (k < parts.length - 1 && !st.isDirectory()) return null;
    let real: string;
    try { real = await realpath(next); } catch { return null; }
    if (!isUnderRoot(realRoot, real)) return null;
    cur = real;
  }
  return cur;
}

export function resolveDataHome(userData: string): DataHome {
  if (typeof userData !== 'string' || !userData || userData.includes('\0') || !path.isAbsolute(userData)) {
    throw new PlatformError('invalid', 'userData must be an absolute path');
  }
  const root = path.join(path.resolve(userData), DATA_HOME_DIR);
  const objectsDir = path.join(root, 'objects');
  const objectsTmpDir = path.join(objectsDir, 'tmp');
  const logsDir = path.join(root, 'logs');
  const workDir = path.join(root, 'work');
  return Object.freeze({
    root, objectsDir, objectsTmpDir, logsDir, workDir,
    objectPath(sha256: string): string {
      if (typeof sha256 !== 'string' || !SHA_RE.test(sha256)) throw new PlatformError('invalid', 'not a lowercase sha256', { field: 'sha256' });
      return path.join(objectsDir, sha256.slice(0, 2), sha256.slice(2));
    },
    attemptWorkDir(jobId: string, n: number): string {
      return path.join(workDir, checkId(jobId, 'jobId'), String(checkN(n)));
    },
    attemptLogPath(jobId: string, n: number): string {
      return relLog(['logs', 'jobs', checkId(jobId, 'jobId'), `${checkN(n)}.log`]);
    },
    imageLogPath(buildId: string): string {
      return relLog(['logs', 'images', `${checkId(buildId, 'buildId')}.log`]);
    },
    confineToDataHome(rel: string): Promise<string | null> { return confineUnder(root, rel); },
    freeBytesAt(dir?: string): Promise<number | null> { return freeBytesAt(dir ?? root); },
    async ensure(): Promise<void> {
      for (const d of [objectsTmpDir, path.join(logsDir, 'jobs'), path.join(logsDir, 'images'), workDir]) await mkdir(d, { recursive: true });
      if ((await lstat(root)).isSymbolicLink()) throw new PlatformError('invalid', 'the data home must not be a link');
    }
  });
}
