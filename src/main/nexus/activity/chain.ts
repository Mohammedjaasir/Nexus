/**
 * The activity hash chain. Each row's hash is
 *   sha256(prev_hash + canonicalJson(hashed fields, with details as their stored JSON text)),
 * and the first row chains to GENESIS_HASH. Changing, removing or inserting a row
 * breaks the chain at that row or the row after it.
 *
 * Pure: no database access, so it loads in plain node tests.
 */
import { createHash } from 'node:crypto';
import type { ActivityEntry } from '../../../shared/nexus/platform';
import { canonicalJson } from '../db/canonical';

export const GENESIS_HASH: string = '0'.repeat(64);

/**
 * The hashed fields of one activity row: `Omit<ActivityEntry, 'seq' | 'hash' | 'prevHash' | 'details'>`
 * plus `detailsJson` (details as their stored JSON text), with the nullable ids and attemptN optional (they hash as null).
 */
export interface ActivityHashInput {
  id: string; ts: number; actorKind: ActivityEntry['actorKind']; actorId: string; onBehalfOf?: string | null;
  sessionId?: string | null; jobId?: string | null; attemptN?: number | null; workspaceId?: string | null; projectId?: string | null;
  artifactId?: string | null; versionId?: string | null; entityType: string; entityId?: string | null;
  action: string; status: ActivityEntry['status']; detailsJson: string;
}

export function activityHash(prevHash: string, row: ActivityHashInput): string {
  const body = canonicalJson({
    id: row.id, ts: row.ts, actorKind: row.actorKind, actorId: row.actorId, onBehalfOf: row.onBehalfOf ?? null,
    sessionId: row.sessionId ?? null, jobId: row.jobId ?? null, attemptN: row.attemptN ?? null, workspaceId: row.workspaceId ?? null,
    projectId: row.projectId ?? null, artifactId: row.artifactId ?? null, versionId: row.versionId ?? null,
    entityType: row.entityType, entityId: row.entityId ?? null, action: row.action, status: row.status,
    detailsJson: row.detailsJson
  });
  return createHash('sha256').update(prevHash).update(body).digest('hex');
}

/**
 * Verify a full chain, in seq order, from the genesis row. Returns the seq of the
 * first row whose link or hash does not match. `detailsJsonOf` gives the stored
 * details text when the caller has it (the DB reader); otherwise the parsed
 * details are re-serialised, which is lossless for redactDetails output.
 */
export function verifyChainRows(rows: ActivityEntry[], detailsJsonOf?: (row: ActivityEntry, index: number) => string):
  { ok: true; rows: number } | { ok: false; brokenAtSeq: number } {
  let prev = GENESIS_HASH;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (row.prevHash !== prev) return { ok: false, brokenAtSeq: row.seq };
    const detailsJson = detailsJsonOf ? detailsJsonOf(row, i) : (JSON.stringify(row.details ?? {}) ?? '{}');
    if (activityHash(prev, { ...row, detailsJson }) !== row.hash) return { ok: false, brokenAtSeq: row.seq };
    prev = row.hash;
  }
  return { ok: true, rows: rows.length };
}
