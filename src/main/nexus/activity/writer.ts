/**
 * Minimal append-only activity writer, used by the v7 migration.
 * A later task extends it with detail redaction; until then callers must pass
 * non-sensitive details only (the migration passes versions, counts and the
 * backup basename and hash).
 *
 * Every row is chained: hash = sha256(prev_hash + canonicalJson(row)), with the
 * first row chained to GENESIS_HASH. Call it inside the caller's transaction so
 * the row commits or rolls back with the operation it records.
 */
import type Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { canonicalJson } from '../db/canonical';
import { newId } from '../db/ids';

export interface NewActivity {
  actorKind: 'user' | 'agent' | 'system'; actorId: string; onBehalfOf?: string | null;
  sessionId?: string | null; jobId?: string | null; attemptN?: number | null; workspaceId?: string | null; projectId?: string | null;
  artifactId?: string | null; versionId?: string | null; entityType: string; entityId?: string | null;
  action: string; status: 'started' | 'succeeded' | 'failed' | 'denied' | 'cancelled'; details?: unknown;
}

export const GENESIS_HASH: string = '0'.repeat(64);

/** The hashed fields of one activity row (`details` as its stored JSON text). */
export interface ActivityHashInput {
  id: string; ts: number; actorKind: string; actorId: string; onBehalfOf?: string | null;
  sessionId?: string | null; jobId?: string | null; workspaceId?: string | null; projectId?: string | null;
  artifactId?: string | null; versionId?: string | null; entityType: string; entityId?: string | null;
  action: string; status: string; detailsJson: string;
}

export function activityHash(prevHash: string, row: ActivityHashInput): string {
  const body = canonicalJson({
    id: row.id, ts: row.ts, actorKind: row.actorKind, actorId: row.actorId, onBehalfOf: row.onBehalfOf ?? null,
    sessionId: row.sessionId ?? null, jobId: row.jobId ?? null, workspaceId: row.workspaceId ?? null,
    projectId: row.projectId ?? null, artifactId: row.artifactId ?? null, versionId: row.versionId ?? null,
    entityType: row.entityType, entityId: row.entityId ?? null, action: row.action, status: row.status,
    detailsJson: row.detailsJson
  });
  return createHash('sha256').update(prevHash).update(body).digest('hex');
}

export function appendActivityRow(db: Database.Database, a: NewActivity, now: number): { seq: number; id: string; hash: string } {
  const last = db.prepare('SELECT hash FROM activity ORDER BY seq DESC LIMIT 1').get() as { hash: string } | undefined;
  const prevHash = last?.hash ?? GENESIS_HASH;
  const id = newId(now);
  const detailsJson = JSON.stringify(a.details ?? {}) ?? '{}';
  const hash = activityHash(prevHash, { ...a, id, ts: now, detailsJson });
  const res = db.prepare(`INSERT INTO activity (id, ts, actor_kind, actor_id, on_behalf_of, session_id, job_id, attempt_n,
      workspace_id, project_id, artifact_id, version_id, entity_type, entity_id, action, status, details_json, prev_hash, hash)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    id, now, a.actorKind, a.actorId, a.onBehalfOf ?? null, a.sessionId ?? null, a.jobId ?? null, a.attemptN ?? null,
    a.workspaceId ?? null, a.projectId ?? null, a.artifactId ?? null, a.versionId ?? null, a.entityType, a.entityId ?? null,
    a.action, a.status, detailsJson, prevHash, hash);
  return { seq: Number(res.lastInsertRowid), id, hash };
}
