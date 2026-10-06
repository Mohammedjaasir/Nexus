/**
 * Artifacts and their immutable versions.
 *
 * - Ownership. An artifact belongs to the ACTIVE participation of (project,
 *   workspace) that exists when it is created; the participation is resolved here,
 *   never taken from the caller. Only that participation appends versions (the
 *   database enforces it in tr_versions_insert). A withdrawn owner freezes its
 *   artifacts: register, edit, discard and promote refuse with
 *   'participation_inactive'. The engine's finalize may still close a frozen draft
 *   as 'failed', but finalizing it to 'candidate' is 'participation_inactive' too.
 *   `repository` (project-owned) is refused until B1.
 * - Producers. A producing job or session must exist ('not_found'), be in the
 *   artifact's project and act for the artifact's OWNER participation ('invalid'
 *   otherwise), and not be terminal ('conflict'). With a job, every input must be
 *   granted to it as the same (version, role) in job_inputs, else
 *   'input_not_granted' with one denied activity row (AuthService.auditDenial, so
 *   it survives a caller's rollback). A repeated (job, clientKey) returns the stored
 *   version when the content hash matches and is a 'conflict' when it does not.
 * - Authority. Every operation on an existing artifact or version authorizes with
 *   the workspace of the STORED owner participation (artifacts.owner_workspace_id),
 *   never a workspace named by the caller (see ProjectAccess). Authorization runs
 *   BEFORE any transaction is opened, so a denial is audited at once in its own
 *   transaction. An unknown id is 'not_found' only for a principal authorized for
 *   the action at platform scope; anyone else gets 'denied'.
 * - Versions. version_no is COALESCE(MAX)+1 inside BEGIN IMMEDIATE, so concurrent
 *   writers serialise; UNIQUE(artifact_id, version_no) is the backstop. Content is
 *   editable only while draft (F.7); the database rejects any later change.
 * - Promotion is compare-and-set on artifacts.current_version_id, in one IMMEDIATE
 *   transaction: activate the version, move the pointer, deprecate the previous
 *   active version(s). Every kind is single-active until the kind registry exists.
 * - Each mutation writes exactly one activity row in its own transaction. Every
 *   transaction runs through immediateTx, so a lock held past busy_timeout surfaces
 *   as 'platform_unavailable'.
 */
import type Database from 'better-sqlite3';
import type {
  Artifact, ArtifactId, ArtifactVersion, JobId, LineageRelation, PlatformAction, Principal, ProjectId,
  SessionId, StorageRef, VersionId, VersionInput, VersionStatus, WorkspaceId
} from '../../../shared/nexus/platform';
import type { AuthService } from '../auth/authService';
import { appendActivityRow } from '../activity/writer';
import { newId } from '../db/ids';
import { immediateTx } from '../db/tx';
import { PlatformError } from '../errors';
import { isKnownRelation, writeEdges, type EdgeSpec } from '../lineage/edgeWriter';
import { ProjectAccess } from '../project/projectAccess';
import { assertExactJson, contentHashOf, INLINE_MAX_BYTES, validateStorage } from './versionRules';

export interface CreateArtifactInput {
  projectId: ProjectId; workspaceId: WorkspaceId; kind: string; name: string; description?: string; metadata?: Record<string, unknown>;
}
export interface RegisterVersionInput {
  artifactId: ArtifactId; storage: StorageRef; metadata?: unknown; ioContract?: unknown;
  inputs?: (VersionInput & { relation?: LineageRelation })[];
  producedByJobId?: JobId; producedBySessionId?: SessionId;
  clientKey?: string; action?: string;
}
export type PromoteResult =
  | { ok: true; version: ArtifactVersion; previous: VersionId | null }
  | { ok: false; code: 'conflict'; currentVersionId: VersionId | null };

export const MAX_DESCRIPTION_CHARS = 2000;
export const MAX_VERSION_INPUTS = 256;
export const DEFAULT_LIST_LIMIT = 200;
export const MAX_LIST_LIMIT = 1000;
const KIND_RE = /^[a-z][a-z0-9_.-]{1,39}$/;
const ACTION_RE = /^[a-z][a-z0-9_.-]{0,63}$/;
const MAX_CLIENT_KEY_CHARS = 200;
const MAX_ROLE_CHARS = 64;
const PLATFORM = { type: 'platform' } as const;

interface ArtifactRow {
  id: string; project_id: string; kind: string; name: string; description: string | null; owner_scope: 'participation' | 'project';
  owner_participation_id: string | null; owner_workspace_id: string | null; created_by: string; status: 'active' | 'archived';
  current_version_id: string | null; metadata_json: string; created_at: number; updated_at: number;
}
interface VersionRow {
  id: string; artifact_id: string; version_no: number; project_id: string; participation_id: string | null; status: VersionStatus;
  draft_flag: 'cancelled_partial' | null; storage_kind: string; storage_ref_json: string; content_hash: string; inputs_json: string;
  io_contract_json: string | null; metadata_json: string; validation_state: ArtifactVersion['validationState'];
  produced_by_job_id: string | null; produced_by_session_id: string | null; produced_by_action: string | null;
  actor_id: string; on_behalf_of: string; created_at: number; status_changed_at: number; promoted_by: string | null;
  promoted_at: number | null; client_key: string | null;
}

const parse = (text: string | null): unknown => {
  if (text === null) return null;
  try { return JSON.parse(text) as unknown; } catch { return null; }   // json_valid CHECKs make this unreachable
};
const isStr = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
const isPlainObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

const toArtifact = (r: ArtifactRow): Artifact => ({
  id: r.id, projectId: r.project_id, kind: r.kind, name: r.name, description: r.description, ownerScope: r.owner_scope,
  ownerParticipationId: r.owner_participation_id, ownerWorkspaceId: r.owner_workspace_id, createdBy: r.created_by,
  status: r.status, currentVersionId: r.current_version_id,
  metadata: (isPlainObject(parse(r.metadata_json)) ? parse(r.metadata_json) : {}) as Record<string, unknown>,
  createdAt: r.created_at, updatedAt: r.updated_at
});
const toVersion = (r: VersionRow): ArtifactVersion => ({
  id: r.id, artifactId: r.artifact_id, versionNo: r.version_no, projectId: r.project_id, participationId: r.participation_id,
  status: r.status, draftFlag: r.draft_flag, storage: parse(r.storage_ref_json) as StorageRef, contentHash: r.content_hash,
  inputs: (parse(r.inputs_json) as VersionInput[] | null) ?? [], ioContract: parse(r.io_contract_json), metadata: parse(r.metadata_json),
  validationState: r.validation_state, producedByJobId: r.produced_by_job_id, producedBySessionId: r.produced_by_session_id,
  producedByAction: r.produced_by_action, actorId: r.actor_id, onBehalfOf: r.on_behalf_of, createdAt: r.created_at,
  statusChangedAt: r.status_changed_at, promotedBy: r.promoted_by, promotedAt: r.promoted_at, clientKey: r.client_key
});

/** JSON text for a caller-supplied value: exact JSON only (nothing coerced), bounded like inline storage. */
function jsonText(v: unknown, what: string): string {
  assertExactJson(v, what);
  const text = JSON.stringify(v);
  if (Buffer.byteLength(text, 'utf8') > INLINE_MAX_BYTES) throw new PlatformError('invalid', `${what} exceeds ${INLINE_MAX_BYTES} bytes`);
  return text;
}

export class ArtifactService {
  private readonly access: ProjectAccess;

  constructor(private readonly db: Database.Database, private readonly deps: { auth: AuthService; now: () => number }) {
    this.access = new ProjectAccess(db, { auth: deps.auth });
  }

  // ---------- artifacts ----------

  create(p: Principal, i: CreateArtifactInput): Artifact {
    if (!isPlainObject(i)) throw new PlatformError('invalid', 'input must be an object');
    if (!isStr(i.projectId) || !isStr(i.workspaceId)) throw new PlatformError('invalid', 'projectId and workspaceId are required');
    if (typeof i.kind !== 'string' || !KIND_RE.test(i.kind)) throw new PlatformError('invalid', 'kind must be a lowercase identifier of 2 to 40 characters');
    if (i.kind === 'repository') throw new PlatformError('invalid', 'repository artifacts are project-owned and arrive in a later phase');
    if (typeof i.name !== 'string' || i.name.trim().length === 0 || i.name.length > 200) throw new PlatformError('invalid', 'name must be 1 to 200 characters');
    if (i.description !== undefined && (typeof i.description !== 'string' || i.description.length > MAX_DESCRIPTION_CHARS)) {
      throw new PlatformError('invalid', `description must be at most ${MAX_DESCRIPTION_CHARS} characters`);
    }
    if (i.metadata !== undefined && !isPlainObject(i.metadata)) throw new PlatformError('invalid', 'metadata must be an object');
    const metadataJson = jsonText(i.metadata ?? {}, 'metadata');

    // The workspace input only SELECTS the participation; the stored row is the authority.
    const pw = this.activeParticipation(i.projectId, i.workspaceId);
    if (!pw) {
      // Authorize at plain project scope first, so an unauthorized caller learns nothing about participations.
      this.access.require(p, i.projectId, 'artifact.create');
      throw new PlatformError('not_participating', 'the project does not actively take part in that workspace');
    }
    this.access.require(p, pw.project_id, 'artifact.create', { workspaceId: pw.workspace_id });
    const now = this.deps.now();
    return immediateTx(this.db, () => {
      const live = this.activeParticipation(i.projectId, i.workspaceId);
      if (!live || live.id !== pw.id) throw new PlatformError('not_participating', 'the participation is no longer active');
      const id = newId(now);
      this.db.prepare(`INSERT INTO artifacts (id, project_id, kind, name, description, owner_scope, owner_participation_id,
          owner_workspace_id, created_by, status, current_version_id, metadata_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 'participation', ?, ?, ?, 'active', NULL, ?, ?, ?)`)
        .run(id, pw.project_id, i.kind, i.name, i.description ?? null, pw.id, pw.workspace_id, p.id, metadataJson, now, now);
      appendActivityRow(this.db, { actorKind: p.kind, actorId: p.id, projectId: pw.project_id, workspaceId: pw.workspace_id,
        artifactId: id, entityType: 'artifact', entityId: id, action: 'artifact.create', status: 'succeeded',
        details: { kind: i.kind } }, now);
      return toArtifact(this.artifactRow(id)!);
    });
  }

  get(p: Principal, id: ArtifactId): Artifact {
    return toArtifact(this.loadArtifact(p, id, 'artifact.read'));
  }

  listByProject(p: Principal, projectId: ProjectId, o?: { kind?: string; limit?: number }): Artifact[] {
    if (o?.kind !== undefined && (typeof o.kind !== 'string' || !KIND_RE.test(o.kind))) throw new PlatformError('invalid', 'invalid kind filter');
    const limit = o?.limit === undefined ? DEFAULT_LIST_LIMIT : o.limit;
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIST_LIMIT) throw new PlatformError('invalid', `limit must be 1 to ${MAX_LIST_LIMIT}`);
    // Project scope: a list spans every participation, so no single stored workspace applies.
    this.access.require(p, projectId, 'artifact.read');
    const rows = o?.kind !== undefined
      ? this.db.prepare('SELECT * FROM artifacts WHERE project_id = ? AND kind = ? ORDER BY created_at, id LIMIT ?').all(projectId, o.kind, limit)
      : this.db.prepare('SELECT * FROM artifacts WHERE project_id = ? ORDER BY created_at, id LIMIT ?').all(projectId, limit);
    return (rows as ArtifactRow[]).map(toArtifact);
  }

  archive(p: Principal, id: ArtifactId): Artifact {
    const stored = this.loadArtifact(p, id, 'artifact.archive');
    const now = this.deps.now();
    return immediateTx(this.db, () => {
      const a = this.artifactRow(stored.id)!;
      if (a.status === 'archived') return toArtifact(a);
      this.db.prepare("UPDATE artifacts SET status = 'archived', updated_at = ? WHERE id = ?").run(now, a.id);
      appendActivityRow(this.db, { actorKind: p.kind, actorId: p.id, projectId: a.project_id, workspaceId: a.owner_workspace_id,
        artifactId: a.id, entityType: 'artifact', entityId: a.id, action: 'artifact.archive', status: 'succeeded', details: {} }, now);
      return toArtifact(this.artifactRow(a.id)!);
    });
  }

  // ---------- versions: reads ----------

  getVersion(p: Principal, id: VersionId): ArtifactVersion {
    return toVersion(this.loadVersion(p, id, 'artifact.read').v);
  }

  listVersions(p: Principal, artifactId: ArtifactId): ArtifactVersion[] {
    const a = this.loadArtifact(p, artifactId, 'artifact.read');
    return (this.db.prepare('SELECT * FROM artifact_versions WHERE artifact_id = ? ORDER BY version_no').all(a.id) as VersionRow[]).map(toVersion);
  }

  // ---------- versions: writes ----------

  registerVersion(p: Principal, i: RegisterVersionInput): { version: ArtifactVersion; created: boolean } {
    if (!isPlainObject(i)) throw new PlatformError('invalid', 'input must be an object');
    const storage = validateStorage(i.storage);
    const contentHash = contentHashOf(storage);
    const metadataJson = jsonText(i.metadata === undefined ? {} : i.metadata, 'metadata');
    const ioContractJson = i.ioContract === undefined ? null : jsonText(i.ioContract, 'ioContract');
    const jobId = i.producedByJobId === undefined ? null : i.producedByJobId;
    const sessionId = i.producedBySessionId === undefined ? null : i.producedBySessionId;
    if (jobId !== null && !isStr(jobId)) throw new PlatformError('invalid', 'producedByJobId must be an id');
    if (sessionId !== null && !isStr(sessionId)) throw new PlatformError('invalid', 'producedBySessionId must be an id');
    const clientKey = i.clientKey === undefined ? null : i.clientKey;
    if (clientKey !== null) {
      if (!isStr(clientKey) || clientKey.length > MAX_CLIENT_KEY_CHARS) throw new PlatformError('invalid', 'clientKey must be a short string');
      // The unique index is (job, clientKey); without a job the key could not be idempotent.
      if (jobId === null) throw new PlatformError('invalid', 'clientKey needs producedByJobId');
    }
    const action = i.action === undefined ? null : i.action;
    if (action !== null && (typeof action !== 'string' || !ACTION_RE.test(action))) throw new PlatformError('invalid', 'action must be a short lowercase label');
    const inputs = this.validateInputs(i.inputs);

    const a = this.loadArtifact(p, i.artifactId, 'version.register');
    // Producers first (read-only): an unknown or foreign job/session is refused before any grant check, so it never
    // produces a denied row. Project and participation are immutable on jobs and sessions, so this check holds.
    if (jobId !== null) this.checkProducer('job', jobId, a);
    if (sessionId !== null) this.checkProducer('session', sessionId, a);
    // Inputs are checked before the transaction: versions are never deleted, never change project, never return to
    // draft, and job_inputs are append-only, so a check that passes here still holds when the insert runs.
    this.checkInputs(p, a, inputs, jobId);
    const now = this.deps.now();
    return immediateTx(this.db, () => {
      if (jobId !== null && clientKey !== null) {
        const prior = this.db.prepare('SELECT * FROM artifact_versions WHERE produced_by_job_id = ? AND client_key = ?')
          .get(jobId, clientKey) as VersionRow | undefined;
        if (prior) {
          if (prior.artifact_id !== a.id) throw new PlatformError('conflict', 'that (job, clientKey) already registered a version of another artifact');
          if (prior.content_hash !== contentHash) {
            throw new PlatformError('conflict', 'that (job, clientKey) already registered different content', { versionId: prior.id });
          }
          return { version: toVersion(prior), created: false };
        }
      }
      const art = this.requireWritableArtifact(a.id);
      if (jobId !== null) this.requireLiveJob(jobId);
      if (sessionId !== null) this.requireLiveSession(sessionId);
      const versionNo = (this.db.prepare('SELECT COALESCE(MAX(version_no), 0) + 1 AS n FROM artifact_versions WHERE artifact_id = ?')
        .get(art.id) as { n: number }).n;
      const id = newId(now);
      const inputsJson = JSON.stringify(inputs.map((x) => ({ versionId: x.versionId, role: x.role })));
      this.db.prepare(`INSERT INTO artifact_versions (id, artifact_id, version_no, project_id, participation_id, status, draft_flag,
          storage_kind, storage_ref_json, content_hash, inputs_json, io_contract_json, metadata_json, validation_state,
          produced_by_job_id, produced_by_session_id, produced_by_action, actor_id, on_behalf_of, environment_json,
          created_at, status_changed_at, promoted_by, promoted_at, purged_at, client_key, output_path)
        VALUES (?, ?, ?, ?, ?, 'draft', NULL, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, NULL, ?, ?, NULL, NULL, NULL, ?, NULL)`)
        .run(id, art.id, versionNo, art.project_id, art.owner_participation_id, storage.kind, JSON.stringify(storage), contentHash,
          inputsJson, ioContractJson, metadataJson, jobId, sessionId, action, p.id, p.id, now, now, clientKey);
      const edges: EdgeSpec[] = inputs.filter((x) => x.relation !== undefined)
        .map((x) => ({ toVersionId: x.versionId, relation: x.relation as LineageRelation }));
      const edgeCount = edges.length
        ? writeEdges(this.db, { fromVersionId: id, edges, source: jobId !== null ? 'job_input' : 'user_action', jobId, createdBy: p.id, now })
        : 0;
      this.db.prepare('UPDATE artifacts SET updated_at = ? WHERE id = ?').run(now, art.id);
      appendActivityRow(this.db, { actorKind: p.kind, actorId: p.id, onBehalfOf: p.id, jobId, sessionId, projectId: art.project_id,
        workspaceId: art.owner_workspace_id, artifactId: art.id, versionId: id, entityType: 'artifact_version', entityId: id,
        action: 'version.register', status: 'succeeded',
        details: { versionNo, storageKind: storage.kind, inputs: inputs.length, edges: edgeCount } }, now);
      return { version: toVersion(this.versionRow(id)!), created: true };
    });
  }

  updateDraft(p: Principal, versionId: VersionId, patch: { storage?: StorageRef; metadata?: unknown; ioContract?: unknown }): ArtifactVersion {
    if (!isPlainObject(patch)) throw new PlatformError('invalid', 'patch must be an object');
    const sets: string[] = []; const args: unknown[] = []; const changed: string[] = [];
    if (patch.storage !== undefined) {
      const storage = validateStorage(patch.storage);
      sets.push('storage_kind = ?', 'storage_ref_json = ?', 'content_hash = ?');
      args.push(storage.kind, JSON.stringify(storage), contentHashOf(storage)); changed.push('storage');
    }
    if (patch.metadata !== undefined) { sets.push('metadata_json = ?'); args.push(jsonText(patch.metadata, 'metadata')); changed.push('metadata'); }
    if (patch.ioContract !== undefined) { sets.push('io_contract_json = ?'); args.push(jsonText(patch.ioContract, 'ioContract')); changed.push('ioContract'); }
    if (sets.length === 0) throw new PlatformError('invalid', 'nothing to update');
    const { v: stored } = this.loadVersion(p, versionId, 'version.update_draft');
    const now = this.deps.now();
    return immediateTx(this.db, () => {
      const v = this.versionRow(stored.id)!;
      if (v.status !== 'draft') throw new PlatformError('immutable', 'version content is immutable after draft');
      const art = this.requireWritableArtifact(v.artifact_id);
      this.db.prepare(`UPDATE artifact_versions SET ${sets.join(', ')} WHERE id = ?`).run(...args, v.id);
      appendActivityRow(this.db, { actorKind: p.kind, actorId: p.id, projectId: v.project_id, workspaceId: art.owner_workspace_id,
        artifactId: v.artifact_id, versionId: v.id, entityType: 'artifact_version', entityId: v.id, action: 'version.update_draft',
        status: 'succeeded', details: { changed } }, now);
      return toVersion(this.versionRow(v.id)!);
    });
  }

  /**
   * Engine role (F.7): draft -> candidate | failed. System principals only. On a
   * frozen (withdrawn) owner only 'failed' is allowed, so the engine can close out a
   * draft it was writing; 'candidate' is 'participation_inactive'.
   */
  finalize(system: Principal, versionId: VersionId, to: 'candidate' | 'failed'): ArtifactVersion {
    if (to !== 'candidate' && to !== 'failed') throw new PlatformError('invalid', "finalize moves a draft to 'candidate' or 'failed'");
    const { v: stored } = this.loadVersion(system, versionId, 'version.finalize');
    const now = this.deps.now();
    return immediateTx(this.db, () => {
      const v = this.versionRow(stored.id)!;
      if (v.status === to) return toVersion(v);
      if (v.status !== 'draft') throw new PlatformError('illegal_transition', `cannot finalize a ${v.status} version`);
      if (to === 'candidate' && !this.ownerActive(v.artifact_id)) {
        throw new PlatformError('participation_inactive', 'the owning participation is not active; a frozen draft can only fail');
      }
      this.db.prepare('UPDATE artifact_versions SET status = ?, status_changed_at = ? WHERE id = ?').run(to, now, v.id);
      appendActivityRow(this.db, { actorKind: system.kind, actorId: system.id, projectId: v.project_id,
        workspaceId: this.ownerWorkspace(v.artifact_id), artifactId: v.artifact_id, versionId: v.id, jobId: v.produced_by_job_id,
        sessionId: v.produced_by_session_id, entityType: 'artifact_version', entityId: v.id, action: 'version.finalize',
        status: 'succeeded', details: { from: 'draft', to } }, now);
      return toVersion(this.versionRow(v.id)!);
    });
  }

  /** draft | candidate -> deprecated. Idempotent on a deprecated version. */
  discard(p: Principal, versionId: VersionId): ArtifactVersion {
    const { v: stored } = this.loadVersion(p, versionId, 'version.discard');
    const now = this.deps.now();
    return immediateTx(this.db, () => {
      const v = this.versionRow(stored.id)!;
      if (v.status === 'deprecated') return toVersion(v);
      if (v.status !== 'draft' && v.status !== 'candidate') throw new PlatformError('illegal_transition', `cannot discard a ${v.status} version`);
      const art = this.requireWritableArtifact(v.artifact_id);
      this.db.prepare("UPDATE artifact_versions SET status = 'deprecated', status_changed_at = ? WHERE id = ?").run(now, v.id);
      appendActivityRow(this.db, { actorKind: p.kind, actorId: p.id, projectId: v.project_id, workspaceId: art.owner_workspace_id,
        artifactId: v.artifact_id, versionId: v.id, entityType: 'artifact_version', entityId: v.id, action: 'version.discard',
        status: 'succeeded', details: { from: v.status } }, now);
      return toVersion(this.versionRow(v.id)!);
    });
  }

  /**
   * candidate -> active, or deprecated -> active for a version that was active before
   * (rollback). Compare-and-set on the artifact's current pointer: `expectedCurrentVersionId`
   * must equal it, else { ok: false, code: 'conflict' } and nothing changes.
   */
  promote(p: Principal, versionId: VersionId, expectedCurrentVersionId: VersionId | null): PromoteResult {
    if (expectedCurrentVersionId !== null && !isStr(expectedCurrentVersionId)) throw new PlatformError('invalid', 'expectedCurrentVersionId must be an id or null');
    const { v: stored } = this.loadVersion(p, versionId, 'version.promote');
    const now = this.deps.now();
    return immediateTx(this.db, (): PromoteResult => {
      const v = this.versionRow(stored.id)!;
      const art = this.requireWritableArtifact(v.artifact_id);
      const previous = art.current_version_id;
      if (previous !== expectedCurrentVersionId) return { ok: false, code: 'conflict', currentVersionId: previous };
      const rollback = v.status === 'deprecated' && v.promoted_at !== null;
      if (v.status !== 'candidate' && !rollback) {
        throw new PlatformError('illegal_transition', v.status === 'deprecated'
          ? 'only a version that was active before can be rolled back to'
          : `cannot promote a ${v.status} version`);
      }
      // 1. activate, 2. move the pointer (CAS), 3. deprecate the previous active version(s): single-active.
      this.db.prepare("UPDATE artifact_versions SET status = 'active', status_changed_at = ?, promoted_by = ?, promoted_at = ? WHERE id = ?")
        .run(now, p.id, now, v.id);
      const moved = this.db.prepare('UPDATE artifacts SET current_version_id = ?, updated_at = ? WHERE id = ? AND current_version_id IS ?')
        .run(v.id, now, art.id, expectedCurrentVersionId);
      if (moved.changes !== 1) throw new PlatformError('conflict', 'the current version moved during promotion');
      this.db.prepare("UPDATE artifact_versions SET status = 'deprecated', status_changed_at = ? WHERE artifact_id = ? AND status = 'active' AND id <> ?")
        .run(now, art.id, v.id);
      appendActivityRow(this.db, { actorKind: p.kind, actorId: p.id, projectId: v.project_id, workspaceId: art.owner_workspace_id,
        artifactId: art.id, versionId: v.id, entityType: 'artifact_version', entityId: v.id, action: 'version.promote',
        status: 'succeeded', details: { from: v.status, previous, rollback } }, now);
      return { ok: true, version: toVersion(this.versionRow(v.id)!), previous };
    });
  }

  // ---------- helpers ----------

  private activeParticipation(projectId: ProjectId, workspaceId: WorkspaceId): { id: string; project_id: string; workspace_id: string } | null {
    return (this.db.prepare("SELECT id, project_id, workspace_id FROM project_workspaces WHERE project_id = ? AND workspace_id = ? AND status = 'active'")
      .get(projectId, workspaceId) as { id: string; project_id: string; workspace_id: string } | undefined) ?? null;
  }

  private artifactRow(id: string): ArtifactRow | null {
    return (this.db.prepare('SELECT * FROM artifacts WHERE id = ?').get(id) as ArtifactRow | undefined) ?? null;
  }

  private versionRow(id: string): VersionRow | null {
    return (this.db.prepare('SELECT * FROM artifact_versions WHERE id = ?').get(id) as VersionRow | undefined) ?? null;
  }

  private ownerWorkspace(artifactId: string): string | null {
    return (this.db.prepare('SELECT owner_workspace_id AS w FROM artifacts WHERE id = ?').get(artifactId) as { w: string | null } | undefined)?.w ?? null;
  }

  /** Loads an artifact and authorizes `action` on it with the STORED owner workspace. Outside any transaction. */
  private loadArtifact(p: Principal, id: ArtifactId, action: PlatformAction): ArtifactRow {
    const a = isStr(id) ? this.artifactRow(id) : null;
    if (!a) {
      this.deps.auth.require(p, action, PLATFORM);
      throw new PlatformError('not_found', 'artifact not found');
    }
    this.access.require(p, a.project_id, action, a.owner_workspace_id ? { workspaceId: a.owner_workspace_id } : undefined);
    return a;
  }

  private loadVersion(p: Principal, id: VersionId, action: PlatformAction): { v: VersionRow; a: ArtifactRow } {
    const v = isStr(id) ? this.versionRow(id) : null;
    if (!v) {
      this.deps.auth.require(p, action, PLATFORM);
      throw new PlatformError('not_found', 'version not found');
    }
    const a = this.artifactRow(v.artifact_id)!;
    this.access.require(p, a.project_id, action, a.owner_workspace_id ? { workspaceId: a.owner_workspace_id } : undefined);
    return { v, a };
  }

  /** Inside the transaction: the artifact is active and its owner participation is active. */
  private requireWritableArtifact(artifactId: string): ArtifactRow {
    const art = this.artifactRow(artifactId);
    if (!art) throw new PlatformError('not_found', 'artifact not found');
    if (art.status !== 'active') throw new PlatformError('conflict', 'the artifact is archived');
    if (art.owner_participation_id === null) throw new PlatformError('invalid', 'project-owned artifacts are not writable in this phase');
    const pw = this.db.prepare('SELECT status FROM project_workspaces WHERE id = ?').get(art.owner_participation_id) as { status: string } | undefined;
    if (!pw || pw.status !== 'active') {
      throw new PlatformError('participation_inactive', 'the owning participation is not active; its artifacts are frozen');
    }
    return art;
  }

  /** True when the artifact's owner participation exists and is active. */
  private ownerActive(artifactId: string): boolean {
    return this.db.prepare(`SELECT 1 FROM artifacts a JOIN project_workspaces pw ON pw.id = a.owner_participation_id
      WHERE a.id = ? AND pw.status = 'active'`).get(artifactId) !== undefined;
  }

  /**
   * Read-only, before the transaction: the producing job or session exists
   * ('not_found'), is in the artifact's project and acts for the artifact's owner
   * participation ('invalid'). A job without a participation never matches. These
   * columns are immutable (identity triggers), so the result holds in the transaction.
   */
  private checkProducer(kind: 'job' | 'session', id: string, a: ArtifactRow): void {
    const row = (kind === 'job'
      ? this.db.prepare('SELECT project_id, participation_id FROM jobs WHERE id = ?').get(id)
      : this.db.prepare('SELECT project_id, participation_id FROM agent_sessions WHERE id = ?').get(id)
    ) as { project_id: string; participation_id: string | null } | undefined;
    if (!row) throw new PlatformError('not_found', `producing ${kind} not found`);
    if (row.project_id !== a.project_id) throw new PlatformError('invalid', `the producing ${kind} belongs to another project`);
    if (row.participation_id === null || row.participation_id !== a.owner_participation_id) {
      throw new PlatformError('invalid', `the producing ${kind} does not act for the artifact's owning participation`);
    }
  }

  /** Inside the transaction: the producing job has not finished (its state can move). */
  private requireLiveJob(jobId: string): void {
    const j = this.db.prepare('SELECT s.terminal FROM jobs j JOIN job_states s ON s.state = j.state WHERE j.id = ?')
      .get(jobId) as { terminal: number } | undefined;
    if (!j) throw new PlatformError('not_found', 'producing job not found');
    if (j.terminal === 1) throw new PlatformError('conflict', 'the producing job has finished');
  }

  /** Inside the transaction: the producing session has not ended. */
  private requireLiveSession(sessionId: string): void {
    const s = this.db.prepare('SELECT st.terminal FROM agent_sessions a JOIN agent_session_states st ON st.state = a.status WHERE a.id = ?')
      .get(sessionId) as { terminal: number } | undefined;
    if (!s) throw new PlatformError('not_found', 'producing session not found');
    if (s.terminal === 1) throw new PlatformError('conflict', 'the producing session has ended');
  }

  private validateInputs(raw: unknown): (VersionInput & { relation?: LineageRelation })[] {
    if (raw === undefined) return [];
    if (!Array.isArray(raw) || raw.length > MAX_VERSION_INPUTS) throw new PlatformError('invalid', `inputs must be a list of at most ${MAX_VERSION_INPUTS}`);
    const seen = new Set<string>();
    return raw.map((x: unknown) => {
      if (!isPlainObject(x) || !isStr(x.versionId) || !isStr(x.role) || x.role.length > MAX_ROLE_CHARS) {
        throw new PlatformError('invalid', 'each input needs a versionId and a role of at most 64 characters');
      }
      const key = `${x.versionId}\u0000${x.role}`;
      if (seen.has(key)) throw new PlatformError('invalid', 'duplicate input');
      seen.add(key);
      if (x.relation !== undefined && !isKnownRelation(this.db, x.relation)) throw new PlatformError('invalid', 'unknown lineage relation');
      return x.relation === undefined
        ? { versionId: x.versionId, role: x.role }
        : { versionId: x.versionId, role: x.role, relation: x.relation as LineageRelation };
    });
  }

  /**
   * Inputs must exist, be in the artifact's project and be out of draft. With a job,
   * every input must be granted to the job as the same (version, role) in job_inputs;
   * otherwise the registration is refused with 'input_not_granted' and one denied
   * activity row. The row goes through AuthService.auditDenial: written at once, or,
   * inside a caller's transaction, after it ends, so a rollback cannot lose it.
   */
  private checkInputs(p: Principal, a: ArtifactRow, inputs: VersionInput[], jobId: string | null): void {
    for (const x of inputs) {
      const v = this.db.prepare('SELECT project_id, status FROM artifact_versions WHERE id = ?').get(x.versionId) as { project_id: string; status: string } | undefined;
      if (!v) throw new PlatformError('not_found', 'input version not found');
      if (v.project_id !== a.project_id) throw new PlatformError('invalid', 'inputs come from the same project');
      if (v.status === 'draft') throw new PlatformError('invalid', 'a draft cannot be an input');
    }
    if (jobId === null || inputs.length === 0) return;
    const granted = this.db.prepare('SELECT 1 FROM job_inputs WHERE job_id = ? AND version_id = ? AND role = ?');
    const missing = inputs.filter((x) => granted.get(jobId, x.versionId, x.role) === undefined).length;
    if (missing === 0) return;
    const audited = this.deps.auth.auditDenial({ actorKind: p.kind, actorId: p.id, jobId, projectId: a.project_id,
      workspaceId: a.owner_workspace_id, artifactId: a.id, entityType: 'artifact_version', action: 'version.register',
      status: 'denied', details: { reason: 'input_not_granted', notGranted: missing } }, 'input_not_granted');
    throw new PlatformError('input_not_granted', 'an input is not granted to the job as that version and role', { audited });
  }
}
