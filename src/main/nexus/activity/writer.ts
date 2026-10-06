/**
 * Append-only activity writer: the single way rows enter `activity`.
 *
 * - Details always go through `redactDetails`, so `details_json` never holds a
 *   secret or content (see redact.ts).
 * - Every row is hash-chained to the previous one (see chain.ts); the first row
 *   chains to GENESIS_HASH.
 * - Call it inside the caller's transaction so the row commits or rolls back with
 *   the operation it records. Called outside a transaction (for example, an
 *   authorization denial that has no operation), it opens its own IMMEDIATE
 *   transaction so the read of the chain head and the insert stay atomic.
 * - CALLERS MUST USE IMMEDIATE TRANSACTIONS (`db.transaction(fn).immediate()`).
 *   An IMMEDIATE transaction takes the write lock before the chain head is read,
 *   so two writers serialise and the chain stays linear. In a DEFERRED transaction
 *   another connection can append between the head read and the insert; SQLite
 *   then rejects the insert with SQLITE_BUSY_SNAPSHOT (no fork is possible, but the
 *   whole operation fails and must be retried). The T6–T10 services use
 *   `.immediate()` for every mutation.
 * - The database rejects UPDATE and DELETE on `activity` (triggers in schema v7).
 */
import type Database from 'better-sqlite3';
import type { ActivityEntry, ActivityStatus, PrincipalKind } from '../../../shared/nexus/platform';
import { newId } from '../db/ids';
import { activityHash, GENESIS_HASH, verifyChainRows } from './chain';
import { redactDetails } from './redact';

export { activityHash, GENESIS_HASH } from './chain';
export type { ActivityHashInput } from './chain';

export interface NewActivity {
  actorKind: PrincipalKind; actorId: string; onBehalfOf?: string | null;
  sessionId?: string | null; jobId?: string | null; attemptN?: number | null; workspaceId?: string | null; projectId?: string | null;
  artifactId?: string | null; versionId?: string | null; entityType: string; entityId?: string | null;
  action: string; status: ActivityStatus; details?: unknown;
}

function insertRow(db: Database.Database, a: NewActivity, now: number): { seq: number; id: string; hash: string } {
  const last = db.prepare('SELECT hash FROM activity ORDER BY seq DESC LIMIT 1').get() as { hash: string } | undefined;
  const prevHash = last?.hash ?? GENESIS_HASH;
  const id = newId(now);
  const detailsJson = JSON.stringify(redactDetails(a.details));
  const hash = activityHash(prevHash, { ...a, id, ts: now, detailsJson });
  const res = db.prepare(`INSERT INTO activity (id, ts, actor_kind, actor_id, on_behalf_of, session_id, job_id, attempt_n,
      workspace_id, project_id, artifact_id, version_id, entity_type, entity_id, action, status, details_json, prev_hash, hash)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    id, now, a.actorKind, a.actorId, a.onBehalfOf ?? null, a.sessionId ?? null, a.jobId ?? null, a.attemptN ?? null,
    a.workspaceId ?? null, a.projectId ?? null, a.artifactId ?? null, a.versionId ?? null, a.entityType, a.entityId ?? null,
    a.action, a.status, detailsJson, prevHash, hash);
  return { seq: Number(res.lastInsertRowid), id, hash };
}

export function appendActivityRow(db: Database.Database, a: NewActivity, now: number): { seq: number; id: string; hash: string } {
  if (db.inTransaction) return insertRow(db, a, now);
  return db.transaction(() => insertRow(db, a, now)).immediate();
}

export interface ActivityDbRow {
  seq: number; id: string; ts: number; actor_kind: PrincipalKind; actor_id: string; on_behalf_of: string | null;
  session_id: string | null; job_id: string | null; attempt_n: number | null; workspace_id: string | null; project_id: string | null;
  artifact_id: string | null; version_id: string | null; entity_type: string; entity_id: string | null; action: string;
  status: ActivityStatus; details_json: string; prev_hash: string; hash: string;
}

export function toEntry(r: ActivityDbRow): ActivityEntry {
  let details: Record<string, unknown> = {};
  try { details = JSON.parse(r.details_json) as Record<string, unknown>; } catch { /* json_valid CHECK makes this unreachable */ }
  return { seq: r.seq, id: r.id, ts: r.ts, actorKind: r.actor_kind, actorId: r.actor_id, onBehalfOf: r.on_behalf_of,
    sessionId: r.session_id, jobId: r.job_id, attemptN: r.attempt_n, workspaceId: r.workspace_id, projectId: r.project_id, artifactId: r.artifact_id,
    versionId: r.version_id, entityType: r.entity_type, entityId: r.entity_id, action: r.action, status: r.status, details,
    prevHash: r.prev_hash, hash: r.hash };
}

/** Every activity row in chain order. */
export function readActivityRows(db: Database.Database): ActivityEntry[] {
  return (db.prepare('SELECT * FROM activity ORDER BY seq').all() as ActivityDbRow[]).map(toEntry);
}

/** Verify the whole stored chain, hashing the stored details text exactly as written. */
export function verifyActivityChain(db: Database.Database): { ok: true; rows: number } | { ok: false; brokenAtSeq: number } {
  const raw = db.prepare('SELECT * FROM activity ORDER BY seq').all() as ActivityDbRow[];
  return verifyChainRows(raw.map(toEntry), (_row, i) => raw[i].details_json);
}
