import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export interface BackupRecord {
  file: string;
  path: string;
  bytes: number;
  sha256: string;
  fromVersion: number;
  rowCounts: Record<string, number>;
  verifiedAt: number;
}

export interface BackupOptions {
  dir: string;
  fromVersion: number;
  rowCounts: Record<string, number>;
  now: () => number;
}

export class BackupError extends Error {
  readonly stage: 'write' | 'verify' | 'exists';
  constructor(stage: 'write' | 'verify' | 'exists', message: string) {
    super(message);
    this.name = 'BackupError';
    this.stage = stage;
  }
}

const quoteIdent = (name: string): string => `"${name.replace(/"/g, '""')}"`;

/** Row count of every user table, keyed by table name, keys sorted. */
export function tableRowCounts(db: Database.Database): Record<string, number> {
  const names = (db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all() as Array<{ name: string }>).map((r) => r.name);
  const out: Record<string, number> = {};
  for (const name of [...names].sort()) {
    out[name] = (db.prepare(`SELECT COUNT(*) AS n FROM ${quoteIdent(name)}`).get() as { n: number }).n;
  }
  return out;
}

export function integrityOk(db: Database.Database, mode: 'integrity' | 'quick' = 'integrity'): boolean {
  const rows = db.pragma(mode === 'quick' ? 'quick_check' : 'integrity_check') as Array<Record<string, unknown>>;
  return rows.length === 1 && Object.values(rows[0])[0] === 'ok';
}

/** Free bytes on the volume holding `dir`, or null when statfs is unsupported or fails. */
export function freeBytes(dir: string): number | null {
  try {
    const statfs = (fs as unknown as { statfsSync?: (p: string) => { bavail: number; bsize: number } }).statfsSync;
    if (!statfs) return null;
    let probe = path.resolve(dir);
    while (!fs.existsSync(probe)) {
      const parent = path.dirname(probe);
      if (parent === probe) break;
      probe = parent;
    }
    const s = statfs(probe);
    return Number(s.bavail) * Number(s.bsize);
  } catch {
    return null;
  }
}

/** UTC stamp such as 20261006T120000Z. */
export function backupStamp(ms: number): string {
  return new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

function sameCounts(a: Record<string, number>, b: Record<string, number>): string | null {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of [...keys].sort()) {
    if (a[k] !== b[k]) return `row count mismatch in ${k}: expected ${a[k] ?? 'none'}, found ${b[k] ?? 'none'}`;
  }
  return null;
}

function vacuumInto(db: Database.Database, target: string): void {
  try {
    db.prepare('VACUUM INTO ?').run(target);
  } catch (err) {
    if (!/parameter|bind/i.test(String((err as Error)?.message))) throw err;
    db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
  }
}

function removeQuietly(file: string): void {
  try { fs.rmSync(file, { force: true }); } catch { /* best effort */ }
}

/**
 * Consistent snapshot via VACUUM INTO (outside any transaction, includes WAL content),
 * verified, renamed into place, then hashed. Never overwrites an existing backup.
 */
export function backupAndVerify(db: Database.Database, o: BackupOptions): BackupRecord {
  const stamp = backupStamp(o.now());
  const file = `harness-v${o.fromVersion}-${stamp}.db`;
  const finalPath = path.resolve(o.dir, file);
  const partial = `${finalPath}.partial`;
  try {
    fs.mkdirSync(o.dir, { recursive: true });
  } catch (err) {
    throw new BackupError('write', `cannot create backup directory (${(err as NodeJS.ErrnoException).code ?? 'error'})`);
  }
  if (fs.existsSync(finalPath) || fs.existsSync(partial)) {
    throw new BackupError('exists', `backup ${file} already exists`);
  }
  try {
    vacuumInto(db, partial);
  } catch (err) {
    removeQuietly(partial);
    throw new BackupError('write', `VACUUM INTO failed: ${(err as Error).message}`);
  }
  let copy: Database.Database | null = null;
  try {
    copy = new Database(partial, { fileMustExist: true });
    copy.pragma('journal_mode = DELETE');
    if (!integrityOk(copy)) throw new BackupError('verify', 'backup integrity_check failed');
    const version = copy.pragma('user_version', { simple: true }) as number;
    if (version !== o.fromVersion) {
      throw new BackupError('verify', `backup user_version ${version} does not match source ${o.fromVersion}`);
    }
    const mismatch = sameCounts(o.rowCounts, tableRowCounts(copy));
    if (mismatch) throw new BackupError('verify', mismatch);
    copy.close();
    copy = null;
  } catch (err) {
    try { copy?.close(); } catch { /* already closed */ }
    removeQuietly(partial);
    removeQuietly(`${partial}-wal`);
    removeQuietly(`${partial}-shm`);
    if (err instanceof BackupError) throw err;
    throw new BackupError('verify', `backup could not be verified: ${(err as Error).message}`);
  }
  try {
    fs.renameSync(partial, finalPath);
  } catch (err) {
    removeQuietly(partial);
    throw new BackupError('write', `cannot finalise backup (${(err as NodeJS.ErrnoException).code ?? 'error'})`);
  }
  const bytes = fs.statSync(finalPath).size;
  const sha256 = createHash('sha256').update(fs.readFileSync(finalPath)).digest('hex');
  return { file, path: finalPath, bytes, sha256, fromVersion: o.fromVersion, rowCounts: { ...o.rowCounts }, verifiedAt: o.now() };
}
