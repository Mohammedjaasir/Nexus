/**
 * Handoffs (schema v8): artifact versions sent BY REFERENCE from one participation of a
 * project to another participation of the same project.
 *
 * - send. 1..MAX_SUBJECTS distinct candidate or active versions owned by the sending
 *   participation; a title (1..200) and an optional note (..2000), neither secret-shaped.
 *   The sending participation is loaded by id (an unknown id is 'not_found' only for a
 *   platform-authorized caller, 'denied' otherwise) and 'handoff.send' is required with its
 *   STORED project and workspace. Each subject must be readable by the caller in its
 *   owner's workspace (ProjectAccess.requireVersionReadable). One IMMEDIATE transaction:
 *   both participations re-checked active; a 'sent' handoff with the same from, to and
 *   exact subject set is returned with `created: false`; otherwise the handoff, its subjects
 *   (position 1..n, content hash copied as evidence) and one 'handoff.send' row.
 * - accept (user decision; conflicts C1 and C18). 'handoff.respond', 'artifact.create',
 *   'version.register', 'version.promote' and 'lineage.write' are required with the STORED
 *   receiving workspace, and 'version.finalize' for the system principal, all BEFORE the
 *   transaction. One IMMEDIATE transaction then creates a 'handoff_receipt' artifact owned
 *   by the receiving participation with one version whose inline content holds only
 *   references ({ handoffId, subjects: [{ versionId, contentHash }] }); no subject content
 *   is ever copied. The version is finalized by the system on the user's behalf
 *   (via 'accept_handoff'), promoted by the user, linked to every subject with a
 *   'depends_on' edge of source 'handoff_convert', and the handoff moves sent -> accepted
 *   with its receipt and answer fields in ONE compare-and-set update. Any failure rolls all
 *   of it back. Subjects are accepted AS SENT, whatever their current status (a subject
 *   discarded after send is still referenced, and its edge points at the deprecated
 *   version): the copied content hash is the evidence, and `get` shows the current status. 'handoff_convert' edges are written only here; LineageService.record
 *   refuses them.
 * - decline. 'handoff.respond' on the receiving workspace; CAS sent -> declined with the
 *   answer fields and an optional note. Nothing else is written besides its activity row.
 * - withdraw. 'handoff.withdraw' on the sending workspace; CAS sent -> withdrawn. The answer
 *   fields stay empty: nobody answered.
 * - Reads. get requires 'handoff.read' on either side's stored workspace (the receiving side
 *   is the audited one). list with a project filter requires 'handoff.read' at project scope;
 *   every row is then kept only when the side(s) its box looks at are readable (read-only
 *   authorize, cached per (project, workspace), no audit rows), so a list never leaks a
 *   handoff of a workspace the caller cannot read.
 * - Availability. Below schema v8 (or with v8 held or failed) the platform builds no
 *   HandoffService; a service built anyway refuses every method with 'platform_unavailable'
 *   (detail.reason 'handoffs_unavailable', detail.subReason) and never touches the tables.
 * - Every write authorizes first, takes workspaces from stored rows, audits denials through
 *   AuthService (require/auditDenial), runs in immediateTx and writes its activity rows in
 *   the same transaction.
 */
import type Database from 'better-sqlite3';
import type {
  HandoffDetail, HandoffId, HandoffStatus, HandoffSummary, ParticipationId, PlatformAction, Principal, ProjectId,
  VersionId, VersionStatus
} from '../../../shared/nexus/platform';
import type { ArtifactService } from '../artifact/artifactService';
import type { AuthService } from '../auth/authService';
import type { PrincipalResolver } from '../auth/principals';
import { redactText } from '../activity/redact';
import { appendActivityRow } from '../activity/writer';
import { contentHashOf, validateStorage } from '../artifact/versionRules';
import { newId } from '../db/ids';
import { v8ShapeProblem } from '../db/schemaV8';
import { immediateTx } from '../db/tx';
import { PlatformError } from '../errors';
import { writeEdge } from '../lineage/edgeWriter';
import { ProjectAccess } from '../project/projectAccess';
import {
  HANDOFF_STATUSES, MAX_NOTE_CHARS, MAX_SUBJECTS, MAX_TITLE_CHARS, RECEIPT_INPUT_ROLE, RECEIPT_KIND, RECEIPT_RELATION
} from './handoffRules';

export interface SendHandoffInput {
  projectId: ProjectId; fromParticipationId: ParticipationId; toParticipationId: ParticipationId;
  versionIds: VersionId[]; title: string; note?: string;
}
export interface HandoffListFilter {
  projectId?: string; workspaceId?: string; box?: 'inbox' | 'sent' | 'all'; status?: HandoffStatus; limit?: number;
}

export const DEFAULT_HANDOFF_LIST_LIMIT = 200;
export const MAX_HANDOFF_LIST_LIMIT = 1000;
const MAX_FILTER_ID_CHARS = 128;
const LIST_PAGE = 500;
const PLATFORM = { type: 'platform' } as const;

interface HandoffRow {
  id: string; project_id: string; from_participation_id: string; from_workspace_id: string; to_participation_id: string;
  to_workspace_id: string; title: string; note: string | null; subject_count: number; status: HandoffStatus; created_by: string;
  responded_by: string | null; responded_at: number | null; response_note: string | null; receipt_version_id: string | null;
  created_at: number; updated_at: number; status_changed_at: number;
}
interface PwRow { id: string; project_id: string; workspace_id: string; status: string }
interface SubjectRow { version_id: string; position: number; content_hash: string }

const isStr = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
const isPlainObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

const toHandoff = (r: HandoffRow): HandoffSummary => ({
  id: r.id, projectId: r.project_id, fromParticipationId: r.from_participation_id, fromWorkspaceId: r.from_workspace_id,
  toParticipationId: r.to_participation_id, toWorkspaceId: r.to_workspace_id, title: r.title, note: r.note,
  subjectCount: r.subject_count, status: r.status, createdBy: r.created_by, respondedBy: r.responded_by,
  respondedAt: r.responded_at, responseNote: r.response_note, receiptVersionId: r.receipt_version_id,
  createdAt: r.created_at, updatedAt: r.updated_at, statusChangedAt: r.status_changed_at
});

/** A title or note must not hold anything secret-shaped ('invalid', reason 'secret_in_metadata'). */
function refuseSecretText(s: string, what: string): void {
  if (redactText(s) !== s) throw new PlatformError('invalid', `${what} holds a secret-shaped value`, { reason: 'secret_in_metadata' });
}
function validNote(note: unknown, what: string): string | null {
  if (note === undefined || note === null) return null;
  if (typeof note !== 'string' || note.length > MAX_NOTE_CHARS) throw new PlatformError('invalid', `${what} must be at most ${MAX_NOTE_CHARS} characters`);
  refuseSecretText(note, what);
  return note;
}

export class HandoffService {
  private readonly access: ProjectAccess;
  /** null when the v8 tables are in place; otherwise why handoffs are off. */
  private readonly unavailable: string | null;

  constructor(private readonly db: Database.Database, private readonly deps: {
    auth: AuthService; principals: PrincipalResolver; artifacts: ArtifactService; now: () => number;
    /** Set when the caller already knows handoffs are off (for example v8 held); the shape is checked otherwise. */
    unavailableReason?: string | null;
  }) {
    this.access = new ProjectAccess(db, { auth: deps.auth });
    this.unavailable = deps.unavailableReason ?? (v8ShapeProblem(db, true) === null ? null : 'shape');
  }

  // ---------- writes ----------

  send(p: Principal, i: SendHandoffInput): { handoff: HandoffDetail; created: boolean } {
    this.requireAvailable();
    if (!isPlainObject(i)) throw new PlatformError('invalid', 'input must be an object');
    if (!isStr(i.projectId) || !isStr(i.fromParticipationId) || !isStr(i.toParticipationId)) {
      throw new PlatformError('invalid', 'projectId, fromParticipationId and toParticipationId are required');
    }
    const ids = i.versionIds as unknown;
    if (!Array.isArray(ids) || ids.length < 1 || ids.length > MAX_SUBJECTS || !ids.every((x) => isStr(x))) {
      throw new PlatformError('invalid', `versionIds must list 1 to ${MAX_SUBJECTS} version ids`);
    }
    const versionIds = ids as string[];
    if (new Set(versionIds).size !== versionIds.length) throw new PlatformError('invalid', 'versionIds must be distinct');
    if (typeof i.title !== 'string' || i.title.trim().length === 0 || i.title.length > MAX_TITLE_CHARS) {
      throw new PlatformError('invalid', `title must be 1 to ${MAX_TITLE_CHARS} characters`);
    }
    refuseSecretText(i.title, 'title');
    const note = validNote(i.note, 'note');

    // The sending participation, by id; the stored row names the project and the workspace (never the caller).
    const from = this.participation(i.fromParticipationId);
    if (!from) {
      this.deps.auth.require(p, 'handoff.send', PLATFORM);
      throw new PlatformError('not_found', 'participation not found');
    }
    this.access.require(p, from.project_id, 'handoff.send', { workspaceId: from.workspace_id });
    if (from.project_id !== i.projectId) throw new PlatformError('invalid', 'the sending participation belongs to another project');
    if (from.status !== 'active') throw new PlatformError('participation_inactive', 'the sending participation is not active');
    const to = this.participation(i.toParticipationId);
    if (!to) {
      this.deps.auth.require(p, 'handoff.send', PLATFORM);
      throw new PlatformError('not_found', 'receiving participation not found');
    }
    if (to.project_id !== from.project_id) {
      // A participation of another project is answered like an unknown id: no existence oracle.
      this.deps.auth.require(p, 'handoff.send', PLATFORM);
      throw new PlatformError('invalid', 'a handoff stays inside one project');
    }
    if (to.id === from.id) throw new PlatformError('invalid', 'a handoff goes to another participation');
    if (to.status !== 'active') throw new PlatformError('participation_inactive', 'the receiving participation is not active');

    // Every subject: readable by the caller in its owner's workspace (audited), then candidate or active and owned by
    // the sender. Versions never change project or owner and never return to draft; the status is re-checked below.
    const subjectOf = this.db.prepare(`SELECT v.status, v.content_hash, a.owner_participation_id FROM artifact_versions v
      JOIN artifacts a ON a.id = v.artifact_id WHERE v.id = ?`);
    for (const id of versionIds) {
      this.access.requireVersionReadable(p, id, from.project_id, 'subject');
      const v = subjectOf.get(id) as { status: VersionStatus; owner_participation_id: string | null };
      if (v.status !== 'candidate' && v.status !== 'active') throw new PlatformError('invalid', `a ${v.status} version cannot be handed off`);
      if (v.owner_participation_id !== from.id) throw new PlatformError('invalid', 'a subject must be owned by the sending participation');
    }

    const now = this.deps.now();
    return immediateTx(this.db, () => {
      const liveFrom = this.participation(from.id)!; const liveTo = this.participation(to.id)!;
      if (liveFrom.status !== 'active') throw new PlatformError('participation_inactive', 'the sending participation is not active');
      if (liveTo.status !== 'active') throw new PlatformError('participation_inactive', 'the receiving participation is not active');
      const subjects = versionIds.map((id) => {
        const v = subjectOf.get(id) as { status: VersionStatus; content_hash: string };
        if (v.status !== 'candidate' && v.status !== 'active') throw new PlatformError('invalid', `a ${v.status} version cannot be handed off`);
        return { versionId: id, contentHash: v.content_hash };
      });
      // Dedupe: an open handoff with the same sender, receiver and exact subject set.
      const wanted = [...versionIds].sort().join('\u0000');
      const open = this.db.prepare(`SELECT id FROM handoffs WHERE from_participation_id = ? AND to_participation_id = ?
        AND status = 'sent' AND subject_count = ? ORDER BY created_at, id`).all(from.id, to.id, versionIds.length) as { id: string }[];
      const subjectIds = this.db.prepare('SELECT version_id FROM handoff_subjects WHERE handoff_id = ?');
      for (const o of open) {
        const have = (subjectIds.all(o.id) as { version_id: string }[]).map((r) => r.version_id).sort().join('\u0000');
        if (have === wanted) return { handoff: this.detail(this.row(o.id)!), created: false };
      }
      const id = newId(now);
      this.db.prepare(`INSERT INTO handoffs (id, project_id, from_participation_id, from_workspace_id, to_participation_id,
          to_workspace_id, title, note, subject_count, status, created_by, responded_by, responded_at, response_note,
          receipt_version_id, created_at, updated_at, status_changed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'sent', ?, NULL, NULL, NULL, NULL, ?, ?, ?)`)
        .run(id, from.project_id, from.id, from.workspace_id, to.id, to.workspace_id, i.title, note, subjects.length, p.id, now, now, now);
      const ins = this.db.prepare('INSERT INTO handoff_subjects (handoff_id, version_id, position, content_hash) VALUES (?, ?, ?, ?)');
      subjects.forEach((s, k) => ins.run(id, s.versionId, k + 1, s.contentHash));
      appendActivityRow(this.db, { actorKind: p.kind, actorId: p.id, projectId: from.project_id, workspaceId: from.workspace_id,
        entityType: 'handoff', entityId: id, action: 'handoff.send', status: 'succeeded',
        details: { subjects: subjects.length, toWorkspaceId: to.workspace_id } }, now);
      return { handoff: this.detail(this.row(id)!), created: true };
    });
  }

  accept(p: Principal, id: HandoffId): HandoffDetail {
    this.requireAvailable();
    const stored = this.load(p, id, 'handoff.respond');
    // The stored receiving workspace is the authority for everything accept writes.
    const ws = { workspaceId: stored.to_workspace_id };
    this.access.require(p, stored.project_id, 'handoff.respond', ws);
    for (const action of ['artifact.create', 'version.register', 'version.promote', 'lineage.write'] as PlatformAction[]) {
      this.access.require(p, stored.project_id, action, ws);
    }
    // Resolved and authorized before the transaction: the receipt is finalized by the system on the user's behalf (C4).
    const system = this.deps.principals.system();
    this.access.require(system, stored.project_id, 'version.finalize', ws);
    const now = this.deps.now();
    return immediateTx(this.db, () => {
      const h = this.row(stored.id)!;
      if (h.status !== 'sent') throw new PlatformError('illegal_transition', `cannot accept a ${h.status} handoff`, { handoffId: h.id });
      const to = this.participation(h.to_participation_id)!;
      if (to.status !== 'active') throw new PlatformError('participation_inactive', 'the receiving participation is not active');
      const subjects = this.subjects(h.id);
      const arts = this.deps.artifacts;
      // 1. the receipt artifact and its version: references only, no subject content.
      const receipt = arts.insertArtifactTx(p, { participation: to, kind: RECEIPT_KIND, name: h.title, description: null,
        metadataJson: '{}', now });
      const storage = validateStorage({ kind: 'inline',
        json: { handoffId: h.id, subjects: subjects.map((s) => ({ versionId: s.version_id, contentHash: s.content_hash })) } });
      const version = arts.insertVersionTx(p, receipt.id, { storage, contentHash: contentHashOf(storage), metadataJson: '{}',
        ioContractJson: null, inputs: subjects.map((s) => ({ versionId: s.version_id, role: RECEIPT_INPUT_ROLE })),
        jobId: null, sessionId: null, action: 'user.accept_handoff', clientKey: null, now });
      // 2. finalize (system, on the user's behalf), 3. promote (the user), so the receipt is active before it is recorded.
      arts.setStatusTx(system, version.id, 'candidate', { now, onBehalfOf: p.id, via: 'accept_handoff' });
      const promoted = arts.promoteTx(p, version.id, null, now);
      if (!promoted.ok) throw new PlatformError('conflict', 'the receipt could not be made current');
      // 4. the receipt depends on each subject (handoff_convert: written only here).
      for (const s of subjects) {
        const e = writeEdge(this.db, { fromVersionId: version.id, toVersionId: s.version_id, relation: RECEIPT_RELATION,
          source: 'handoff_convert', jobId: null, createdBy: p.id }, now);
        if (e.created) {
          appendActivityRow(this.db, { actorKind: p.kind, actorId: p.id, projectId: h.project_id, workspaceId: h.to_workspace_id,
            artifactId: receipt.id, versionId: version.id, entityType: 'artifact_edge', entityId: e.edge.id, action: 'lineage.write',
            status: 'succeeded', details: { relation: RECEIPT_RELATION, source: 'handoff_convert', toVersionId: s.version_id } }, now);
        }
      }
      // 5. one compare-and-set: status, receipt and answer fields together (tr_handoffs_* are the backstop).
      const moved = this.db.prepare(`UPDATE handoffs SET status = 'accepted', receipt_version_id = ?, responded_by = ?, responded_at = ?,
          updated_at = ?, status_changed_at = ? WHERE id = ? AND status = 'sent'`).run(version.id, p.id, now, now, now, h.id);
      if (moved.changes !== 1) throw new PlatformError('conflict', 'the handoff changed during accept', { handoffId: h.id });
      // 6. the handoff's own row.
      appendActivityRow(this.db, { actorKind: p.kind, actorId: p.id, projectId: h.project_id, workspaceId: h.to_workspace_id,
        artifactId: receipt.id, versionId: version.id, entityType: 'handoff', entityId: h.id, action: 'handoff.accept',
        status: 'succeeded', details: { receiptVersionId: version.id, subjects: subjects.length } }, now);
      return this.detail(this.row(h.id)!);
    });
  }

  decline(p: Principal, id: HandoffId, note?: string): HandoffDetail {
    this.requireAvailable();
    const responseNote = validNote(note, 'note');
    const stored = this.load(p, id, 'handoff.respond');
    this.access.require(p, stored.project_id, 'handoff.respond', { workspaceId: stored.to_workspace_id });
    const now = this.deps.now();
    return immediateTx(this.db, () => {
      const h = this.row(stored.id)!;
      if (h.status !== 'sent') throw new PlatformError('illegal_transition', `cannot decline a ${h.status} handoff`, { handoffId: h.id });
      const moved = this.db.prepare(`UPDATE handoffs SET status = 'declined', responded_by = ?, responded_at = ?, response_note = ?,
          updated_at = ?, status_changed_at = ? WHERE id = ? AND status = 'sent'`).run(p.id, now, responseNote, now, now, h.id);
      if (moved.changes !== 1) throw new PlatformError('conflict', 'the handoff changed during decline', { handoffId: h.id });
      appendActivityRow(this.db, { actorKind: p.kind, actorId: p.id, projectId: h.project_id, workspaceId: h.to_workspace_id,
        entityType: 'handoff', entityId: h.id, action: 'handoff.decline', status: 'succeeded',
        details: { withNote: responseNote !== null } }, now);
      return this.detail(this.row(h.id)!);
    });
  }

  withdraw(p: Principal, id: HandoffId): HandoffDetail {
    this.requireAvailable();
    const stored = this.load(p, id, 'handoff.withdraw');
    this.access.require(p, stored.project_id, 'handoff.withdraw', { workspaceId: stored.from_workspace_id });
    const now = this.deps.now();
    return immediateTx(this.db, () => {
      const h = this.row(stored.id)!;
      if (h.status !== 'sent') throw new PlatformError('illegal_transition', `cannot withdraw a ${h.status} handoff`, { handoffId: h.id });
      // No one answered: the answer fields stay empty.
      const moved = this.db.prepare(`UPDATE handoffs SET status = 'withdrawn', updated_at = ?, status_changed_at = ?
          WHERE id = ? AND status = 'sent'`).run(now, now, h.id);
      if (moved.changes !== 1) throw new PlatformError('conflict', 'the handoff changed during withdraw', { handoffId: h.id });
      appendActivityRow(this.db, { actorKind: p.kind, actorId: p.id, projectId: h.project_id, workspaceId: h.from_workspace_id,
        entityType: 'handoff', entityId: h.id, action: 'handoff.withdraw', status: 'succeeded', details: {} }, now);
      return this.detail(this.row(h.id)!);
    });
  }

  // ---------- reads ----------

  get(p: Principal, id: HandoffId): HandoffDetail {
    this.requireAvailable();
    const h = this.load(p, id, 'handoff.read');
    // Either side's stored workspace may grant the read; the receiving side is the audited one.
    const fromOk = this.deps.auth.authorize(p, 'handoff.read', { type: 'project', projectId: h.project_id, workspaceId: h.from_workspace_id }).allowed;
    if (!fromOk) this.access.require(p, h.project_id, 'handoff.read', { workspaceId: h.to_workspace_id });
    return this.detail(h);
  }

  list(p: Principal, f: HandoffListFilter): HandoffSummary[] {
    this.requireAvailable();
    if (f !== undefined && !isPlainObject(f)) throw new PlatformError('invalid', 'filter must be an object');
    const o: HandoffListFilter = f ?? {};
    const box = o.box ?? 'all';
    if (box !== 'inbox' && box !== 'sent' && box !== 'all') throw new PlatformError('invalid', "box must be 'inbox', 'sent' or 'all'");
    const where: string[] = []; const args: unknown[] = [];
    if (o.projectId !== undefined) {
      if (!isStr(o.projectId) || o.projectId.length > MAX_FILTER_ID_CHARS) throw new PlatformError('invalid', 'invalid projectId filter');
      where.push('project_id = ?'); args.push(o.projectId);
    }
    if (o.workspaceId !== undefined) {
      if (!isStr(o.workspaceId) || o.workspaceId.length > MAX_FILTER_ID_CHARS) throw new PlatformError('invalid', 'invalid workspaceId filter');
      if (box === 'inbox') { where.push('to_workspace_id = ?'); args.push(o.workspaceId); }
      else if (box === 'sent') { where.push('from_workspace_id = ?'); args.push(o.workspaceId); }
      else { where.push('(to_workspace_id = ? OR from_workspace_id = ?)'); args.push(o.workspaceId, o.workspaceId); }
    }
    if (o.status !== undefined) {
      if (!HANDOFF_STATUSES.includes(o.status)) throw new PlatformError('invalid', `status must be one of ${HANDOFF_STATUSES.join(', ')}`);
      where.push('status = ?'); args.push(o.status);
    }
    const limit = o.limit === undefined ? DEFAULT_HANDOFF_LIST_LIMIT : o.limit;
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_HANDOFF_LIST_LIMIT) {
      throw new PlatformError('invalid', `limit must be 1 to ${MAX_HANDOFF_LIST_LIMIT}`);
    }
    if (o.projectId !== undefined) this.access.require(p, o.projectId, 'handoff.read');

    const readable = new Map<string, boolean>();
    const canRead = (projectId: string, ws: string): boolean => {
      const key = `${projectId}\u0000${ws}`;
      let ok = readable.get(key);
      if (ok === undefined) {
        ok = this.deps.auth.authorize(p, 'handoff.read', { type: 'project', projectId, workspaceId: ws }).allowed;
        readable.set(key, ok);
      }
      return ok;
    };
    // The box picks the side whose readability counts: the receiving side for the inbox, the sending side for sent.
    const keep = (r: HandoffRow): boolean => box === 'inbox' ? canRead(r.project_id, r.to_workspace_id)
      : box === 'sent' ? canRead(r.project_id, r.from_workspace_id)
        : canRead(r.project_id, r.to_workspace_id) || canRead(r.project_id, r.from_workspace_id);
    // Open handoffs first, then newest first.
    const page = this.db.prepare(`SELECT * FROM handoffs ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY (status = 'sent') DESC, created_at DESC, id DESC LIMIT ? OFFSET ?`);
    const out: HandoffSummary[] = [];
    for (let offset = 0; out.length < limit; offset += LIST_PAGE) {
      const rows = page.all(...args, LIST_PAGE, offset) as HandoffRow[];
      for (const r of rows) {
        if (!keep(r)) continue;
        out.push(toHandoff(r));
        if (out.length >= limit) break;
      }
      if (rows.length < LIST_PAGE) break;
    }
    return out;
  }

  /**
   * Open ('sent') handoffs in either direction of a participation. Internal and read-only: the platform passes it to
   * WorkspaceService, which calls it inside withdraw's transaction (ix_handoffs_from, ix_handoffs_to).
   */
  openCountFor(participationId: ParticipationId): number {
    this.requireAvailable();
    if (!isStr(participationId)) return 0;
    const n = (sql: string): number => (this.db.prepare(sql).get(participationId) as { n: number }).n;
    return n("SELECT COUNT(*) AS n FROM handoffs WHERE from_participation_id = ? AND status = 'sent'")
      + n("SELECT COUNT(*) AS n FROM handoffs WHERE to_participation_id = ? AND status = 'sent'");
  }

  // ---------- helpers ----------

  private requireAvailable(): void {
    if (this.unavailable !== null) {
      throw new PlatformError('platform_unavailable', 'handoffs are unavailable: schema v8 is not in place',
        { reason: 'handoffs_unavailable', subReason: this.unavailable });
    }
  }

  private row(id: string): HandoffRow | null {
    return (this.db.prepare('SELECT * FROM handoffs WHERE id = ?').get(id) as HandoffRow | undefined) ?? null;
  }

  private participation(id: string): PwRow | null {
    return (this.db.prepare('SELECT id, project_id, workspace_id, status FROM project_workspaces WHERE id = ?').get(id) as PwRow | undefined) ?? null;
  }

  private subjects(handoffId: string): SubjectRow[] {
    return this.db.prepare('SELECT version_id, position, content_hash FROM handoff_subjects WHERE handoff_id = ? ORDER BY position')
      .all(handoffId) as SubjectRow[];
  }

  /** Loads a handoff by id. An unknown id is 'not_found' only for a principal authorized for `action` platform-wide. */
  private load(p: Principal, id: HandoffId, action: PlatformAction): HandoffRow {
    const h = isStr(id) ? this.row(id) : null;
    if (!h) {
      this.deps.auth.require(p, action, PLATFORM);
      throw new PlatformError('not_found', 'handoff not found');
    }
    return h;
  }

  /** The handoff with each subject joined to its version and artifact, and the newest later version number, if any. */
  private detail(h: HandoffRow): HandoffDetail {
    const rows = this.db.prepare(`SELECT s.handoff_id, s.version_id, s.position, s.content_hash, v.artifact_id, v.version_no,
        v.status, a.name, a.kind,
        (SELECT MAX(x.version_no) FROM artifact_versions x WHERE x.artifact_id = v.artifact_id AND x.version_no > v.version_no) AS newer
      FROM handoff_subjects s JOIN artifact_versions v ON v.id = s.version_id JOIN artifacts a ON a.id = v.artifact_id
      WHERE s.handoff_id = ? ORDER BY s.position`).all(h.id) as Array<{
        handoff_id: string; version_id: string; position: number; content_hash: string; artifact_id: string; version_no: number;
        status: VersionStatus; name: string; kind: string; newer: number | null;
      }>;
    return {
      ...toHandoff(h),
      subjects: rows.map((r) => ({
        handoffId: r.handoff_id, versionId: r.version_id, position: r.position, contentHash: r.content_hash,
        artifactId: r.artifact_id, artifactName: r.name, kind: r.kind, versionNo: r.version_no, status: r.status,
        newerVersionNo: r.newer ?? null
      }))
    };
  }
}
