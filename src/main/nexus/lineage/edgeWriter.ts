/**
 * Internal lineage edge writer, used by ArtifactService.registerVersion. Minimal in
 * this task: it refuses self-edges and relations outside the vocabulary, dedupes,
 * and inserts. Task 9 adds the lineage service and full cycle protection around it.
 *
 * It must run inside the caller's IMMEDIATE transaction, so the edges commit or
 * roll back with the version they describe. It writes no activity row: the caller's
 * own activity row covers the registration.
 */
import type Database from 'better-sqlite3';
import type { EdgeSource, JobId, LineageRelation, PrincipalId, VersionId } from '../../../shared/nexus/platform';
import { newId } from '../db/ids';
import { PlatformError } from '../errors';

export interface EdgeSpec { toVersionId: VersionId; relation: LineageRelation }

export function isKnownRelation(db: Database.Database, relation: unknown): relation is LineageRelation {
  return typeof relation === 'string' && relation.length > 0
    && db.prepare('SELECT 1 FROM lineage_relations WHERE relation = ?').get(relation) !== undefined;
}

/** Inserts one edge per distinct (to, relation); returns how many were written. */
export function writeEdges(db: Database.Database, e: {
  fromVersionId: VersionId; edges: EdgeSpec[]; source: EdgeSource; jobId: JobId | null; createdBy: PrincipalId; now: number;
}): number {
  if (!db.inTransaction) throw new PlatformError('invalid', 'lineage edges are written inside the caller transaction');
  const ins = db.prepare(`INSERT OR IGNORE INTO artifact_edges (id, from_version_id, to_version_id, relation, source, job_id, created_by, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
  let written = 0;
  for (const edge of e.edges) {
    if (edge.toVersionId === e.fromVersionId) throw new PlatformError('cycle', 'a version cannot be its own lineage source');
    if (!isKnownRelation(db, edge.relation)) throw new PlatformError('invalid', 'unknown lineage relation');
    written += ins.run(newId(e.now), e.fromVersionId, edge.toVersionId, edge.relation, e.source, e.jobId, e.createdBy, e.now).changes;
  }
  return written;
}
