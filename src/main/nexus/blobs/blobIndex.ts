/**
 * The content-addressed blob store's index (schema v9: `blobs`, `version_blobs`). DB only:
 * the bytes live under `<dataHome>/objects` (src/main/nexusExec/dataHome.ts) and are written,
 * hashed and deleted by the runner; this module never touches the file system.
 *
 * - Record. `recordBlobsTx` is upsert-free: `INSERT OR IGNORE` the row, then move
 *   `last_referenced_at` forward. The same bytes recorded twice are one row. A known sha256
 *   recorded with a different size is a `conflict` (the stored identity is immutable,
 *   tr_blobs_identity).
 * - Attach. Bytes are attached to a version only while it is a draft. The database is the
 *   authority (tr_version_blobs_insert); the service maps its refusal to `immutable`. An
 *   unknown version is `not_found`; an unknown blob is `invalid` (record it first). Attaching
 *   touches `last_referenced_at` of each blob.
 * - Lock. One in-process reader/writer lock per BlobIndex. Ingest takes it SHARED for the whole
 *   of "bytes land in objects/ -> rows recorded -> rows attached" (`withIngestLock`); the
 *   class's writes refuse to run outside it. GC apply takes it EXCLUSIVE without waiting: a
 *   held shared lock (an ingest in flight) or a second GC is a `conflict`. While GC holds it,
 *   a new ingest waits.
 * - GC is two-step (A6). `gcCandidates` is a dry run: the unreferenced blobs whose last
 *   reference is older than 24 h, and `candidatesHash` over them. `gcApply(expectedHash)`
 *   recomputes the list under the exclusive lock in one IMMEDIATE transaction and deletes the
 *   rows only when the hash is the same (else `conflict`, reason `stale`). It refuses while any
 *   attempt is live (`starting` or `running`), checked under the lock. A blob held by a version
 *   is never a candidate, and tr_blobs_delete refuses its delete anyway. The removed shas are
 *   returned (and passed to `deleteObjects`, still under the lock) so the runner deletes the
 *   files; a file left behind by a failed delete is an unindexed object that recovery phase B
 *   sweeps. GC writes one activity row (`blobs.gc`); record and attach are part of the ingest
 *   that calls them and write none of their own.
 * - Every write runs in `immediateTx` (a savepoint inside a caller's transaction).
 */
import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { Principal, VersionId } from '../../../shared/nexus/platform';
import { appendActivityRow } from '../activity/writer';
import { immediateTx } from '../db/tx';
import { PlatformError } from '../errors';

export type VersionBlobRole = 'content' | 'manifest' | 'file' | 'discovery' | 'junit' | 'report' | 'log';
export const VERSION_BLOB_ROLES: readonly VersionBlobRole[] = Object.freeze(
  ['content', 'manifest', 'file', 'discovery', 'junit', 'report', 'log'] as VersionBlobRole[]);
/** An unreferenced blob is a GC candidate once its last reference is older than this. */
export const BLOB_GC_MIN_AGE_MS = 24 * 60 * 60 * 1000;
export const MAX_BLOB_PATH_CHARS = 1024;
export const MAX_BLOBS_PER_CALL = 10_000;

export interface BlobRecord { sha256: string; bytes: number; mediaType: string }
export interface BlobAttachItem { sha256: string; role: VersionBlobRole; path?: string }
export interface BlobGcCandidate { sha256: string; bytes: number; lastReferencedAt: number }
export interface BlobGcDryRun { candidates: BlobGcCandidate[]; candidatesHash: string; totalBytes: number; liveAttempts: number }

const SHA_RE = /^[0-9a-f]{64}$/;
export const isSha256 = (s: unknown): s is string => typeof s === 'string' && SHA_RE.test(s);

function checkSha(s: unknown, field: string): string {
  if (!isSha256(s)) throw new PlatformError('invalid', `${field} is not a lowercase sha256`, { field });
  return s;
}

/** A version_blobs path: '' or a relative POSIX path with no '..' segment, no backslash and no NUL (the DDL CHECK, stated here). */
export function isBlobPath(p: unknown): p is string {
  if (typeof p !== 'string') return false;
  if (p === '') return true;
  if (p.length > MAX_BLOB_PATH_CHARS || p.includes('\0') || p.includes('\\') || p.startsWith('/')) return false;
  return !p.split('/').some((s) => s === '..' || s === '');
}

function validRecords(blobs: readonly BlobRecord[]): BlobRecord[] {
  if (!Array.isArray(blobs) || blobs.length > MAX_BLOBS_PER_CALL) throw new PlatformError('invalid', 'blobs must be a bounded list');
  const seen = new Map<string, BlobRecord>();
  for (const b of blobs) {
    const sha = checkSha(b?.sha256, 'sha256');
    if (!Number.isSafeInteger(b.bytes) || b.bytes < 0) throw new PlatformError('invalid', 'bytes must be a non-negative integer', { field: 'bytes' });
    if (typeof b.mediaType !== 'string' || b.mediaType.length < 3 || b.mediaType.length > 100)
      throw new PlatformError('invalid', 'mediaType must be 3 to 100 characters', { field: 'mediaType' });
    const prev = seen.get(sha);
    if (prev && prev.bytes !== b.bytes) throw new PlatformError('conflict', 'one sha256 named with two sizes', { reason: 'size_mismatch' });
    if (!prev) seen.set(sha, { sha256: sha, bytes: b.bytes, mediaType: b.mediaType });
  }
  return [...seen.values()];
}

/**
 * Record blobs (INSERT OR IGNORE) and move their `last_referenced_at` to `now`. Returns how many
 * rows were new. Runs in the caller's transaction as a savepoint, or in its own IMMEDIATE one.
 */
export function recordBlobsTx(db: Database.Database, blobs: readonly BlobRecord[], now: number): { inserted: number; touched: number } {
  const list = validRecords(blobs);
  return immediateTx(db, () => {
    const ins = db.prepare('INSERT OR IGNORE INTO blobs (sha256, bytes, media_type, created_at, last_referenced_at) VALUES (?, ?, ?, ?, ?)');
    const get = db.prepare('SELECT bytes FROM blobs WHERE sha256 = ?');
    const touch = db.prepare('UPDATE blobs SET last_referenced_at = ? WHERE sha256 = ? AND last_referenced_at < ?');
    let inserted = 0; let touched = 0;
    for (const b of list) {
      if (ins.run(b.sha256, b.bytes, b.mediaType, now, now).changes === 1) { inserted++; continue; }
      const row = get.get(b.sha256) as { bytes: number } | undefined;
      if (!row || row.bytes !== b.bytes) throw new PlatformError('conflict', 'a stored blob has another size', { reason: 'size_mismatch' });
      touched += touch.run(now, b.sha256, now).changes;
    }
    return { inserted, touched };
  });
}

/**
 * Attach recorded blobs to a DRAFT version. Idempotent per (version, sha256, role, path).
 * The draft rule is the database's (tr_version_blobs_insert), surfaced as `immutable`.
 */
export function attachBlobsTx(db: Database.Database, versionId: VersionId, items: readonly BlobAttachItem[], now: number): { attached: number } {
  if (typeof versionId !== 'string' || versionId.length === 0 || versionId.length > 64) throw new PlatformError('invalid', 'versionId is required');
  if (!Array.isArray(items) || items.length === 0 || items.length > MAX_BLOBS_PER_CALL) throw new PlatformError('invalid', 'items must be a non-empty bounded list');
  const list = items.map((it) => {
    const sha = checkSha(it?.sha256, 'sha256');
    if (!VERSION_BLOB_ROLES.includes(it.role)) throw new PlatformError('invalid', 'unknown blob role', { field: 'role' });
    const p = it.path ?? '';
    if (!isBlobPath(p)) throw new PlatformError('invalid', 'the blob path is not a confined relative path', { field: 'path' });
    return { sha, role: it.role, path: p };
  });
  return immediateTx(db, () => {
    const v = db.prepare('SELECT id FROM artifact_versions WHERE id = ?').get(versionId);
    if (!v) throw new PlatformError('not_found', 'no such version');
    const has = db.prepare('SELECT 1 FROM blobs WHERE sha256 = ?');
    const ins = db.prepare('INSERT OR IGNORE INTO version_blobs (version_id, sha256, role, path) VALUES (?, ?, ?, ?)');
    const touch = db.prepare('UPDATE blobs SET last_referenced_at = ? WHERE sha256 = ? AND last_referenced_at < ?');
    let attached = 0;
    for (const it of list) {
      if (!has.get(it.sha)) throw new PlatformError('invalid', 'the blob is not recorded', { reason: 'blob_unknown' });
      try {
        attached += ins.run(versionId, it.sha, it.role, it.path).changes;
      } catch (e) {
        if (/attached to a version only while it is a draft/.test(String((e as Error)?.message))) {
          throw new PlatformError('immutable', 'bytes are attached to a version only while it is a draft');
        }
        throw e;
      }
      touch.run(now, it.sha, now);
    }
    return { attached };
  });
}

/** Whether any version holds this blob. */
export function isBlobReferenced(db: Database.Database, sha256: string): boolean {
  checkSha(sha256, 'sha256');
  return !!db.prepare('SELECT 1 FROM version_blobs WHERE sha256 = ? LIMIT 1').get(sha256);
}

/** The stable hash of a candidate list: order-free, and it changes when any candidate's size or last reference does. */
export function candidatesHash(candidates: readonly BlobGcCandidate[]): string {
  const rows = [...candidates].map((c) => [c.sha256, c.bytes, c.lastReferencedAt] as const)
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return createHash('sha256').update('nexus.blobs.gc.v1\n').update(JSON.stringify(rows)).digest('hex');
}

const liveAttemptCount = (db: Database.Database): number =>
  (db.prepare("SELECT COUNT(*) AS n FROM job_attempts WHERE state IN ('starting','running')").get() as { n: number }).n;

/** The unreferenced blobs whose last reference is older than 24 h, by sha256. */
export function listGcCandidates(db: Database.Database, now: number): BlobGcCandidate[] {
  const rows = db.prepare(`SELECT b.sha256, b.bytes, b.last_referenced_at FROM blobs b
    WHERE b.last_referenced_at < ? AND NOT EXISTS (SELECT 1 FROM version_blobs vb WHERE vb.sha256 = b.sha256)
    ORDER BY b.sha256`).all(now - BLOB_GC_MIN_AGE_MS) as { sha256: string; bytes: number; last_referenced_at: number }[];
  return rows.map((r) => ({ sha256: r.sha256, bytes: r.bytes, lastReferencedAt: r.last_referenced_at }));
}

/** In-process reader/writer lock: ingest shares it, GC takes it exclusively and never waits. */
export class BlobGcLock {
  private shared = 0;
  private exclusive = false;
  private waiters: (() => void)[] = [];

  get sharedHolders(): number { return this.shared; }
  get exclusiveHeld(): boolean { return this.exclusive; }

  /** Take the lock shared; waits while a GC holds it. The returned release is idempotent. */
  async acquireShared(): Promise<() => void> {
    while (this.exclusive) await new Promise<void>((res) => this.waiters.push(res));
    this.shared++;
    let done = false;
    return () => { if (done) return; done = true; this.shared--; };
  }

  /** Take the lock exclusively now, or null when anyone holds it. The returned release is idempotent. */
  tryExclusive(): (() => void) | null {
    if (this.exclusive || this.shared > 0) return null;
    this.exclusive = true;
    let done = false;
    return () => {
      if (done) return; done = true; this.exclusive = false;
      const w = this.waiters.splice(0);
      for (const f of w) f();
    };
  }
}

export class BlobIndex {
  readonly lock: BlobGcLock;

  constructor(private readonly db: Database.Database, private readonly deps: { now: () => number; lock?: BlobGcLock }) {
    this.lock = deps.lock ?? new BlobGcLock();
  }

  /** Run an ingest step holding the lock shared (released when `fn` settles). */
  async withIngestLock<T>(fn: () => Promise<T> | T): Promise<T> {
    const release = await this.lock.acquireShared();
    try { return await fn(); } finally { release(); }
  }

  private requireShared(): void {
    if (this.lock.sharedHolders < 1 || this.lock.exclusiveHeld) {
      throw new PlatformError('conflict', 'blob writes run under the ingest lock', { reason: 'lock_not_held' });
    }
  }

  recordBlobsTx(blobs: readonly BlobRecord[]): { inserted: number; touched: number } {
    this.requireShared();
    return recordBlobsTx(this.db, blobs, this.deps.now());
  }

  attachTx(versionId: VersionId, items: readonly BlobAttachItem[]): { attached: number } {
    this.requireShared();
    return attachBlobsTx(this.db, versionId, items, this.deps.now());
  }

  isReferenced(sha256: string): boolean { return isBlobReferenced(this.db, sha256); }

  /** Step one of GC: what would be removed now, and the hash that step two must present. */
  gcCandidates(): BlobGcDryRun {
    const candidates = listGcCandidates(this.db, this.deps.now());
    return { candidates, candidatesHash: candidatesHash(candidates), totalBytes: candidates.reduce((s, c) => s + c.bytes, 0),
      liveAttempts: liveAttemptCount(this.db) };
  }

  candidatesHash(candidates: readonly BlobGcCandidate[]): string { return candidatesHash(candidates); }

  /**
   * Step two of GC: under the exclusive lock, delete the candidate rows only when the list still hashes
   * to `expectedHash` and no attempt is live. Returns the removed shas; `deleteObjects` (the runner's
   * file delete) is awaited while the lock is still held.
   */
  async gcApply(by: Principal, expectedHash: string, deleteObjects?: (shas: readonly string[]) => Promise<void>): Promise<{ removedShas: string[] }> {
    if (!by || (by.kind !== 'user' && by.kind !== 'system')) throw new PlatformError('denied', 'blob GC is run by a user or the system');
    checkSha(expectedHash, 'expectedHash');
    const release = this.lock.tryExclusive();
    if (!release) throw new PlatformError('conflict', 'an ingest or another GC holds the blob store', { reason: 'busy' });
    try {
      const now = this.deps.now();
      const removedShas = immediateTx(this.db, () => {
        if (liveAttemptCount(this.db) > 0) throw new PlatformError('conflict', 'GC never runs while an attempt is live', { reason: 'attempts_live' });
        const current = listGcCandidates(this.db, now);
        if (candidatesHash(current) !== expectedHash) throw new PlatformError('conflict', 'the GC candidates changed since the dry run', { reason: 'stale' });
        const del = this.db.prepare('DELETE FROM blobs WHERE sha256 = ? AND NOT EXISTS (SELECT 1 FROM version_blobs vb WHERE vb.sha256 = ?)');
        const out: string[] = [];
        for (const c of current) if (del.run(c.sha256, c.sha256).changes === 1) out.push(c.sha256);
        appendActivityRow(this.db, { actorKind: by.kind, actorId: by.id, entityType: 'blob', action: 'blobs.gc', status: 'succeeded',
          details: { removed: out.length, bytes: current.reduce((s, c) => s + c.bytes, 0) } }, now);
        return out;
      });
      if (deleteObjects && removedShas.length > 0) await deleteObjects(removedShas);
      return { removedShas };
    } finally {
      release();
    }
  }
}
