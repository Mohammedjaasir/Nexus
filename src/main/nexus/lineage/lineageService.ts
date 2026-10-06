/**
 * Version-level lineage: a DAG of typed edges between artifact versions.
 *
 * - Edges come only from Nexus records. `record` takes ids and a relation from the
 *   `lineage_relations` vocabulary, never free text, so lineage cannot be inferred
 *   from messages. Sources:
 *     user_action  the caller is a user principal ('invalid' otherwise); no job;
 *     job_input    a job is named; `from` was produced by that job and `to` is one
 *                  of its declared inputs (job_inputs). An undeclared target is
 *                  'input_not_granted' with one denied activity row
 *                  (AuthService.auditDenial, action 'lineage.write');
 *     ingest       the system principal only ('denied', audited as system_only);
 *                  `from` was produced by the named job;
 *     handoff_convert  refused ('invalid') until handoffs exist.
 * - Endpoints. Both versions must exist and be in one project ('invalid'; the
 *   tr_edges_insert trigger is the backstop). The target is a source someone
 *   consumed, so it must be out of draft ('invalid'), as registerVersion requires
 *   of its inputs. The consumer (`from`) may still be a draft.
 * - Authority. `lineage.write` is required on each endpoint's project with the
 *   workspace of its STORED owner participation (never a caller-supplied
 *   workspace), BEFORE the transaction opens. Reads require `lineage.read` on the
 *   starting version the same way. An unknown version id is 'not_found' only for a
 *   principal authorized at platform scope; anyone else gets 'denied'.
 * - Writes. The dedupe, the cycle check and the insert run in ONE IMMEDIATE
 *   transaction (edgeWriter), so a second writer cannot slip a cycle in between.
 *   A new edge writes one activity row in the same transaction; an identical
 *   re-send returns the stored edge and writes nothing.
 * - Walks. upstream follows edges towards sources, downstream towards consumers,
 *   breadth first, one indexed query per level (the UNIQUE autoindex serves
 *   from_version_id, ix_edges_to serves to_version_id). Depth defaults to 6 and is
 *   clamped to 1..32. Each version appears once, at its minimum depth, with the
 *   alphabetically first relation that reaches it at that depth; results are
 *   ordered by depth, then version id.
 * - Walk visibility. Every reached version is checked with
 *   `auth.authorize(p, 'lineage.read', project scope + the workspace of its
 *   artifact's STORED owner participation)`, once per distinct (project, workspace)
 *   per walk (cached). This is a read-only filter: it writes no audit rows. A
 *   version the caller cannot read is dropped from the result and the walk does
 *   NOT expand through it, so nothing beyond it is revealed either (no redacted
 *   markers). A version reachable by another, readable path still appears there.
 * - Node cap. A walk returns at most MAX_LINEAGE_NODES versions. When more
 *   readable versions were reachable, the walk stops and reports
 *   `truncated: true`; the nodes returned are the shallowest ones, in result order.
 */
import type Database from 'better-sqlite3';
import type {
  ArtifactEdge, JobId, LineageNode, LineageRelation, PlatformAction, Principal, VersionId, VersionStatus
} from '../../../shared/nexus/platform';
import type { AuthService } from '../auth/authService';
import { appendActivityRow } from '../activity/writer';
import { immediateTx } from '../db/tx';
import { PlatformError } from '../errors';
import { ProjectAccess } from '../project/projectAccess';
import { isKnownRelation, writeEdge } from './edgeWriter';

export type RecordSource = 'job_input' | 'ingest' | 'user_action';
export interface RecordEdgeInput {
  fromVersionId: VersionId; toVersionId: VersionId; relation: LineageRelation; source: RecordSource; jobId?: JobId;
}

export const DEFAULT_LINEAGE_DEPTH = 6;
export const MAX_LINEAGE_DEPTH = 32;
export const MAX_LINEAGE_NODES = 5000;
export interface LineageWalk { nodes: LineageNode[]; truncated: boolean }
const IN_CHUNK = 500;
/** The node cap in force; only the test hook below lowers it. */
let nodeCap = MAX_LINEAGE_NODES;
const PLATFORM = { type: 'platform' } as const;

interface EndpointRow {
  id: string; artifact_id: string; project_id: string; status: VersionStatus; produced_by_job_id: string | null;
  owner_workspace_id: string | null;
}
interface NodeRow {
  id: string; artifact_id: string; kind: string; version_no: number; status: VersionStatus; project_id: string;
  owner_workspace_id: string | null;
}

const isStr = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
const isPlainObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export class LineageService {
  private readonly access: ProjectAccess;

  constructor(private readonly db: Database.Database, private readonly deps: { auth: AuthService; now: () => number }) {
    this.access = new ProjectAccess(db, { auth: deps.auth });
  }

  record(p: Principal, e: RecordEdgeInput): ArtifactEdge {
    if (!isPlainObject(e)) throw new PlatformError('invalid', 'input must be an object');
    if (!isStr(e.fromVersionId) || !isStr(e.toVersionId)) throw new PlatformError('invalid', 'fromVersionId and toVersionId are required');
    if (!isKnownRelation(this.db, e.relation)) throw new PlatformError('invalid', 'unknown lineage relation');
    const source = e.source as unknown;
    if (source === 'handoff_convert') throw new PlatformError('invalid', 'handoff edges arrive with handoffs');
    if (source !== 'user_action' && source !== 'job_input' && source !== 'ingest') throw new PlatformError('invalid', 'unknown edge source');
    const jobId = e.jobId === undefined ? null : e.jobId;
    if (jobId !== null && !isStr(jobId)) throw new PlatformError('invalid', 'jobId must be an id');
    if (source === 'user_action') {
      if (jobId !== null) throw new PlatformError('invalid', 'a user_action edge names no job');
      // The caller's kind is a claim; AuthService re-resolves the stored principal, so a forged kind is refused there.
      if (p?.kind !== 'user') throw new PlatformError('invalid', 'a user_action edge is recorded by a user principal');
    } else if (jobId === null) {
      throw new PlatformError('invalid', `a ${source} edge needs its job`);
    }
    if (e.fromVersionId === e.toVersionId) throw new PlatformError('cycle', 'a version cannot be its own lineage source');

    const from = this.loadEndpoint(p, e.fromVersionId, 'lineage.write');
    const to = this.loadEndpoint(p, e.toVersionId, 'lineage.write', from);
    if (to.project_id !== from.project_id) throw new PlatformError('invalid', 'lineage edges stay inside one project');
    if (to.status === 'draft') throw new PlatformError('invalid', 'a draft cannot be a lineage source');

    if (source === 'ingest' && p.kind !== 'system') {
      const audited = this.deps.auth.auditDenial(p, { action: 'lineage.write', reason: 'system_only', projectId: from.project_id,
        workspaceId: from.owner_workspace_id, artifactId: from.artifact_id, versionId: from.id, jobId, entityType: 'artifact_edge',
        details: { source } });
      throw new PlatformError('denied', 'ingest edges are recorded by the system principal', { reason: 'system_only', audited });
    }
    if (jobId !== null && source !== 'user_action') this.checkJobSource(p, source, jobId, from, to);

    const now = this.deps.now();
    return immediateTx(this.db, () => {
      const r = writeEdge(this.db, { fromVersionId: from.id, toVersionId: to.id, relation: e.relation, source, jobId, createdBy: p.id }, now);
      if (r.created) {
        appendActivityRow(this.db, { actorKind: p.kind, actorId: p.id, jobId, projectId: from.project_id,
          workspaceId: from.owner_workspace_id, artifactId: from.artifact_id, versionId: from.id, entityType: 'artifact_edge',
          entityId: r.edge.id, action: 'lineage.write', status: 'succeeded',
          details: { relation: e.relation, source, toVersionId: to.id } }, now);
      }
      return r.edge;
    });
  }

  /** The sources of a version, transitively: edges followed from consumer to source. */
  upstream(p: Principal, versionId: VersionId, o?: { depth?: number }): LineageWalk {
    return this.walk(p, versionId, 'up', o);
  }

  /** The consumers of a version, transitively: edges followed from source to consumer. */
  downstream(p: Principal, versionId: VersionId, o?: { depth?: number }): LineageWalk {
    return this.walk(p, versionId, 'down', o);
  }

  // ---------- helpers ----------

  private walk(p: Principal, versionId: VersionId, dir: 'up' | 'down', o?: { depth?: number }): LineageWalk {
    const depth = clampDepth(o === undefined || o === null ? undefined : (isPlainObject(o) ? o.depth : NaN));
    const start = this.loadEndpoint(p, versionId, 'lineage.read');
    const cap = nodeCap;
    const [near, far] = dir === 'up' ? ['from_version_id', 'to_version_id'] : ['to_version_id', 'from_version_id'];
    // Read-only visibility per (project, stored owner workspace); the start's scope was just required.
    const readable = new Map<string, boolean>([[scopeKey(start.project_id, start.owner_workspace_id), true]]);
    const canRead = (projectId: string, ws: string | null): boolean => {
      const key = scopeKey(projectId, ws);
      let ok = readable.get(key);
      if (ok === undefined) {
        ok = this.deps.auth.authorize(p, 'lineage.read', ws ? { type: 'project', projectId, workspaceId: ws } : { type: 'project', projectId }).allowed;
        readable.set(key, ok);
      }
      return ok;
    };
    const seen = new Set<string>([start.id]);
    const nodes: LineageNode[] = [];
    let truncated = false;
    let frontier = [start.id];
    for (let d = 1; d <= depth && frontier.length > 0 && !truncated; d++) {
      const reached = new Map<string, string>();
      for (const chunk of chunks(frontier)) {
        const rows = this.db.prepare(`SELECT ${far} AS v, relation FROM artifact_edges WHERE ${near} IN (${chunk.map(() => '?').join(',')})`)
          .all(...chunk) as { v: string; relation: string }[];
        for (const r of rows) {
          if (seen.has(r.v)) continue;
          const prev = reached.get(r.v);
          if (prev === undefined || r.relation < prev) reached.set(r.v, r.relation);
        }
      }
      const ids = [...reached.keys()].sort();
      const info = new Map<string, NodeRow>();
      for (const chunk of chunks(ids)) {
        const rows = this.db.prepare(`SELECT v.id, v.artifact_id, a.kind, v.version_no, v.status, v.project_id, a.owner_workspace_id
          FROM artifact_versions v JOIN artifacts a ON a.id = v.artifact_id WHERE v.id IN (${chunk.map(() => '?').join(',')})`)
          .all(...chunk) as NodeRow[];
        for (const r of rows) info.set(r.id, r);
      }
      const next: string[] = [];
      for (const id of ids) {
        seen.add(id);
        const n = info.get(id)!;
        if (!canRead(n.project_id, n.owner_workspace_id)) continue;     // dropped, and never expanded
        if (nodes.length >= cap) { truncated = true; break; }
        nodes.push({ versionId: id, artifactId: n.artifact_id, kind: n.kind, versionNo: n.version_no, status: n.status,
          depth: d, relation: reached.get(id) as LineageRelation });
        next.push(id);
      }
      frontier = next;
    }
    return { nodes, truncated };
  }

  /**
   * Loads a version with its artifact's STORED owner workspace and authorizes
   * `action` on its project with that workspace. Outside any transaction. When
   * `same` is the other endpoint in the same project and workspace, the check
   * already done for it covers this one.
   */
  private loadEndpoint(p: Principal, id: VersionId, action: PlatformAction, same?: EndpointRow): EndpointRow {
    const v = isStr(id)
      ? this.db.prepare(`SELECT v.id, v.artifact_id, v.project_id, v.status, v.produced_by_job_id, a.owner_workspace_id
          FROM artifact_versions v JOIN artifacts a ON a.id = v.artifact_id WHERE v.id = ?`).get(id) as EndpointRow | undefined
      : undefined;
    if (!v) {
      this.deps.auth.require(p, action, PLATFORM);
      throw new PlatformError('not_found', 'version not found');
    }
    if (!same || same.project_id !== v.project_id || same.owner_workspace_id !== v.owner_workspace_id) {
      this.access.require(p, v.project_id, action, v.owner_workspace_id ? { workspaceId: v.owner_workspace_id } : undefined);
    }
    return v;
  }

  /**
   * Read-only, before the transaction. The job exists ('not_found') and is in the
   * edge's project ('invalid'); `from` was produced by it ('invalid'). For
   * job_input, `to` must be one of the job's declared inputs, else
   * 'input_not_granted' with one denied activity row. Jobs, job_inputs and a
   * version's producer are immutable, so the result still holds in the transaction.
   */
  private checkJobSource(p: Principal, source: 'job_input' | 'ingest', jobId: string, from: EndpointRow, to: EndpointRow): void {
    const job = this.db.prepare('SELECT project_id FROM jobs WHERE id = ?').get(jobId) as { project_id: string } | undefined;
    if (!job) throw new PlatformError('not_found', 'job not found');
    if (job.project_id !== from.project_id) throw new PlatformError('invalid', 'the job belongs to another project');
    if (from.produced_by_job_id !== jobId) throw new PlatformError('invalid', 'the consuming version was not produced by that job');
    if (source !== 'job_input') return;
    if (this.db.prepare('SELECT 1 FROM job_inputs WHERE job_id = ? AND version_id = ? LIMIT 1').get(jobId, to.id) !== undefined) return;
    const audited = this.deps.auth.auditDenial(p, { action: 'lineage.write', reason: 'input_not_granted', jobId,
      projectId: from.project_id, workspaceId: from.owner_workspace_id, artifactId: from.artifact_id, versionId: from.id,
      entityType: 'artifact_edge', details: { source } });
    throw new PlatformError('input_not_granted', 'the target is not a declared input of the job', { audited });
  }
}

/** undefined -> the default; a finite number is truncated and clamped to 1..MAX; anything else is 'invalid'. */
function clampDepth(raw: unknown): number {
  if (raw === undefined) return DEFAULT_LINEAGE_DEPTH;
  if (typeof raw !== 'number' || !Number.isFinite(raw)) throw new PlatformError('invalid', 'depth must be a number');
  return Math.min(MAX_LINEAGE_DEPTH, Math.max(1, Math.trunc(raw)));
}

function scopeKey(projectId: string, ws: string | null): string {
  return `${projectId}\u0000${ws ?? ''}`;
}

function chunks<T>(xs: T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += IN_CHUNK) out.push(xs.slice(i, i + IN_CHUNK));
  return out;
}

/** Test-only entry points. Production code must not use these. */
export const __testing = {
  /** Runs `fn` with the walk node cap lowered to `n` (an integer in 1..MAX_LINEAGE_NODES), then restores it. */
  withNodeCap<T>(n: number, fn: () => T): T {
    if (!Number.isInteger(n) || n < 1 || n > MAX_LINEAGE_NODES) throw new RangeError('withNodeCap only lowers the cap: 1..MAX_LINEAGE_NODES');
    const prev = nodeCap;
    nodeCap = n;
    try { return fn(); } finally { nodeCap = prev; }
  }
};
