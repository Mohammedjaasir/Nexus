/**
 * Internal lineage edge writer, used by ArtifactService.registerVersion and
 * LineageService.record. It never opens a transaction: it must run inside the
 * caller's IMMEDIATE transaction, so the cycle check and the insert see the same
 * graph (no TOCTOU with a second writer) and the edges commit or roll back with
 * the operation they describe. It writes no activity row: the caller's own
 * activity row covers the operation.
 *
 * Rules applied here, for every source:
 * - a version is never its own source ('cycle'; the table CHECK is the backstop);
 * - the relation is in the `lineage_relations` vocabulary ('invalid'; the FK is
 *   the backstop);
 * - an edge (from, to, relation) that already exists is returned as is, provided
 *   it has the same source and job; otherwise it is a 'conflict';
 * - an edge that would close a cycle is refused ('cycle'). The check walks the
 *   whole reachable graph with no depth cap (D6): UNION dedupes version ids, so it
 *   terminates on any graph and cannot miss a deep cycle.
 * Same-project and append-only are enforced by the database triggers; services
 * check same-project themselves so the error is typed.
 */
import type Database from 'better-sqlite3';
import type { ArtifactEdge, EdgeSource, JobId, LineageRelation, PrincipalId, VersionId } from '../../../shared/nexus/platform';
import { newId } from '../db/ids';
import { PlatformError } from '../errors';

export interface EdgeSpec { toVersionId: VersionId; relation: LineageRelation }

interface EdgeRow {
  id: string; from_version_id: string; to_version_id: string; relation: string; source: string;
  job_id: string | null; created_by: string; created_at: number;
}

const toEdge = (r: EdgeRow): ArtifactEdge => ({
  id: r.id, fromVersionId: r.from_version_id, toVersionId: r.to_version_id, relation: r.relation as LineageRelation,
  source: r.source as EdgeSource, jobId: r.job_id, createdBy: r.created_by, createdAt: r.created_at
});

export function isKnownRelation(db: Database.Database, relation: unknown): relation is LineageRelation {
  return typeof relation === 'string' && relation.length > 0
    && db.prepare('SELECT 1 FROM lineage_relations WHERE relation = ?').get(relation) !== undefined;
}

/**
 * True when an edge from -> to would close a cycle, that is, when `from` is
 * already reachable from `to` by following edges towards their sources (or the
 * two are the same version). Run it inside the transaction that inserts the edge.
 */
export function wouldCycle(db: Database.Database, fromVersionId: VersionId, toVersionId: VersionId): boolean {
  if (fromVersionId === toVersionId) return true;
  return db.prepare(`WITH RECURSIVE up(v) AS (
      SELECT ?
      UNION
      SELECT e.to_version_id FROM artifact_edges e JOIN up ON e.from_version_id = up.v
    )
    SELECT 1 FROM up WHERE v = ? LIMIT 1`).get(toVersionId, fromVersionId) !== undefined;
}

/** Writes one edge (or returns the identical existing one). Inside the caller's IMMEDIATE transaction only. */
export function writeEdge(db: Database.Database, e: {
  fromVersionId: VersionId; toVersionId: VersionId; relation: LineageRelation;
  source: EdgeSource; jobId?: JobId | null; createdBy: PrincipalId;
}, now: number): { edge: ArtifactEdge; created: boolean } {
  if (!db.inTransaction) throw new PlatformError('invalid', 'lineage edges are written inside the caller transaction');
  const jobId = e.jobId ?? null;
  if (e.fromVersionId === e.toVersionId) throw new PlatformError('cycle', 'a version cannot be its own lineage source');
  if (!isKnownRelation(db, e.relation)) throw new PlatformError('invalid', 'unknown lineage relation');
  const prior = db.prepare('SELECT * FROM artifact_edges WHERE from_version_id = ? AND to_version_id = ? AND relation = ?')
    .get(e.fromVersionId, e.toVersionId, e.relation) as EdgeRow | undefined;
  if (prior) {
    if (prior.source !== e.source || prior.job_id !== jobId) {
      throw new PlatformError('conflict', 'that edge already exists with another source or job', { edgeId: prior.id });
    }
    return { edge: toEdge(prior), created: false };
  }
  if (wouldCycle(db, e.fromVersionId, e.toVersionId)) throw new PlatformError('cycle', 'the edge would close a lineage cycle');
  const id = newId(now);
  db.prepare(`INSERT INTO artifact_edges (id, from_version_id, to_version_id, relation, source, job_id, created_by, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(id, e.fromVersionId, e.toVersionId, e.relation, e.source, jobId, e.createdBy, now);
  return { edge: toEdge(db.prepare('SELECT * FROM artifact_edges WHERE id = ?').get(id) as EdgeRow), created: true };
}

/** Writes one edge per distinct (to, relation) through writeEdge; returns how many were created. */
export function writeEdges(db: Database.Database, e: {
  fromVersionId: VersionId; edges: EdgeSpec[]; source: EdgeSource; jobId: JobId | null; createdBy: PrincipalId; now: number;
}): number {
  if (!db.inTransaction) throw new PlatformError('invalid', 'lineage edges are written inside the caller transaction');
  let written = 0;
  for (const edge of e.edges) {
    const r = writeEdge(db, { fromVersionId: e.fromVersionId, toVersionId: edge.toVersionId, relation: edge.relation,
      source: e.source, jobId: e.jobId, createdBy: e.createdBy }, e.now);
    if (r.created) written++;
  }
  return written;
}
