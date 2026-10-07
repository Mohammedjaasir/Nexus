/**
 * Workspaces and project participation (`project_workspaces`).
 *
 * - A project takes part in any number of workspaces through participation rows;
 *   it is never duplicated. Exactly one row may be primary (unique index), and the
 *   primary is owned by the legacy domain (legacyPrimary.ts): attach never creates
 *   a primary and withdraw refuses one.
 * - Every method takes a Principal and is authorized first (AuthService.require,
 *   which audits a denial), before any transaction is opened.
 * - Workspace ids from the caller are validated against the `workspaces` table but
 *   never used as authority: attach authorizes at plain project scope; withdraw
 *   passes the workspace of the STORED row it loaded (see ProjectAccess).
 * - Writes run in IMMEDIATE transactions with their activity row, through
 *   immediateTx, so a lock held past busy_timeout surfaces as 'platform_unavailable'.
 */
import type Database from 'better-sqlite3';
import type {
  ParticipationId, ParticipationStatus, Principal, ProjectId, ProjectWorkspace, WorkspaceId
} from '../../../shared/nexus/platform';
import { PLATFORM_WORKSPACE_IDS } from '../../../shared/nexus/workspaceCatalog';
import type { AuthService } from '../auth/authService';
import { appendActivityRow } from '../activity/writer';
import { newId } from '../db/ids';
import { immediateTx } from '../db/tx';
import { PlatformError } from '../errors';
import { ProjectAccess } from '../project/projectAccess';
import { syncPrimaryFromLegacyDomain } from './legacyPrimary';

/** Longest objective text accepted on attach. */
export const MAX_OBJECTIVE_CHARS = 2000;

interface PwDbRow {
  id: string; project_id: string; workspace_id: string; objective: string | null; status: ParticipationStatus;
  is_primary: number; source: ProjectWorkspace['source']; created_by: string; created_at: number; updated_at: number;
}

const toParticipation = (r: PwDbRow): ProjectWorkspace => ({
  id: r.id, projectId: r.project_id, workspaceId: r.workspace_id, status: r.status, isPrimary: r.is_primary === 1,
  objective: r.objective, source: r.source, createdBy: r.created_by, createdAt: r.created_at, updatedAt: r.updated_at
});

const PW_COLUMNS = 'id, project_id, workspace_id, objective, status, is_primary, source, created_by, created_at, updated_at';
const PLATFORM = { type: 'platform' } as const;

export class WorkspaceService {
  private readonly access: ProjectAccess;

  constructor(private readonly db: Database.Database, private readonly deps: {
    auth: AuthService; now: () => number; log?: (line: string) => void;
    /** Open ('sent') handoffs in either direction of a participation; absent below schema v8. Read-only. */
    openHandoffs?: (participationId: string) => number;
  }) {
    this.access = new ProjectAccess(db, { auth: deps.auth });
  }

  list(p: Principal): { id: WorkspaceId; retiredAt: number | null }[] {
    this.deps.auth.require(p, 'workspace.read', PLATFORM);
    return (this.db.prepare('SELECT id, retired_at FROM workspaces ORDER BY rowid').all() as { id: string; retired_at: number | null }[])
      .map((r) => ({ id: r.id, retiredAt: r.retired_at }));
  }

  /** INSERT OR IGNORE of the catalogue; returns how many rows were added. System only. */
  ensureCatalog(system: Principal): number {
    this.deps.auth.require(system, 'system.reconcile', PLATFORM);
    const now = this.deps.now();
    return immediateTx(this.db, () => {
      const ins = this.db.prepare('INSERT OR IGNORE INTO workspaces (id, created_at, retired_at) VALUES (?, ?, NULL)');
      const added: string[] = [];
      for (const id of PLATFORM_WORKSPACE_IDS) if (ins.run(id, now).changes === 1) added.push(id);
      if (added.length) {
        appendActivityRow(this.db, { actorKind: system.kind, actorId: system.id, entityType: 'workspace',
          action: 'workspace.catalog_ensured', status: 'succeeded', details: { added } }, now);
      }
      return added.length;
    });
  }

  /** Every participation of the project, primary first, then by workspace id. */
  participations(p: Principal, projectId: ProjectId): ProjectWorkspace[] {
    this.access.require(p, projectId, 'project.read');
    return (this.db.prepare(`SELECT ${PW_COLUMNS} FROM project_workspaces WHERE project_id = ?
      ORDER BY is_primary DESC, workspace_id`).all(projectId) as PwDbRow[]).map(toParticipation);
  }

  primaryOf(p: Principal, projectId: ProjectId): ProjectWorkspace | null {
    this.access.require(p, projectId, 'project.read');
    const r = this.db.prepare(`SELECT ${PW_COLUMNS} FROM project_workspaces WHERE project_id = ? AND is_primary = 1`)
      .get(projectId) as PwDbRow | undefined;
    return r ? toParticipation(r) : null;
  }

  /**
   * Every participation of every project the caller may read, for the cross-project screens: ordered by project,
   * the primary first, then by workspace id. Each row is kept only when a read-only
   * auth.authorize('project.read', project scope + the row's STORED workspace) allows it, cached per (project,
   * workspace), like lineage walks. No audit row is written; an unreadable row is simply absent.
   */
  listForReader(p: Principal): ProjectWorkspace[] {
    const readable = new Map<string, boolean>();
    const rows = this.db.prepare(`SELECT ${PW_COLUMNS} FROM project_workspaces ORDER BY project_id, is_primary DESC, workspace_id`)
      .all() as PwDbRow[];
    return rows.filter((r) => {
      const key = `${r.project_id}\u0000${r.workspace_id}`;
      let ok = readable.get(key);
      if (ok === undefined) {
        ok = this.deps.auth.authorize(p, 'project.read', { type: 'project', projectId: r.project_id, workspaceId: r.workspace_id }).allowed;
        readable.set(key, ok);
      }
      return ok;
    }).map(toParticipation);
  }

  /** Projects actively taking part in the workspace (ix_pw_workspace). */
  projectIdsIn(p: Principal, workspaceId: WorkspaceId): ProjectId[] {
    this.requireKnownWorkspace(workspaceId, false);
    this.deps.auth.require(p, 'workspace.read', { type: 'workspace', workspaceId });
    return (this.db.prepare("SELECT project_id FROM project_workspaces WHERE workspace_id = ? AND status = 'active'")
      .all(workspaceId) as { project_id: string }[]).map((r) => r.project_id).sort();
  }

  /**
   * Adds a NON-primary participation. Idempotent: an active row is returned as is; a
   * withdrawn row is re-activated. A 'complete' row is a conflict.
   */
  attach(p: Principal, projectId: ProjectId, workspaceId: WorkspaceId, o?: { objective?: string }): ProjectWorkspace {
    this.requireKnownWorkspace(workspaceId, true);
    const objective = o?.objective;
    if (objective !== undefined && (typeof objective !== 'string' || objective.length > MAX_OBJECTIVE_CHARS)) {
      throw new PlatformError('invalid', `objective must be a string of at most ${MAX_OBJECTIVE_CHARS} characters`);
    }
    // Project scope only: the workspace named by the caller is the target, not a source of authority.
    this.access.require(p, projectId, 'participation.attach');
    const now = this.deps.now();
    return immediateTx(this.db, () => {
      const existing = this.rowFor(projectId, workspaceId);
      if (existing && existing.status === 'active') return toParticipation(existing);
      if (existing && existing.status === 'complete') {
        throw new PlatformError('conflict', 'participation is complete', { participationId: existing.id });
      }
      let id: string;
      if (existing) {
        id = existing.id;
        this.db.prepare(`UPDATE project_workspaces SET status = 'active', objective = COALESCE(?, objective), updated_at = ? WHERE id = ?`)
          .run(objective ?? null, now, id);
      } else {
        id = newId(now);
        this.db.prepare(`INSERT INTO project_workspaces (id, project_id, workspace_id, objective, status, is_primary, source,
            completion_json, completion_hash, completion_at, created_by, created_at, updated_at)
          VALUES (?, ?, ?, ?, 'active', 0, 'user', NULL, NULL, NULL, ?, ?, ?)`).run(id, projectId, workspaceId, objective ?? null, p.id, now, now);
      }
      appendActivityRow(this.db, { actorKind: p.kind, actorId: p.id, projectId, workspaceId, entityType: 'project_workspace', entityId: id,
        action: 'participation.attach', status: 'succeeded', details: { reactivated: existing !== null } }, now);
      return toParticipation(this.rowById(id)!);
    });
  }

  /**
   * Marks a non-primary participation withdrawn (the row is kept). Refuses the primary ('invalid'), and refuses
   * with 'conflict' while the participation has any non-terminal job or agent session, or (schema v8) any open
   * handoff in either direction (`detail.openHandoffs`, from the injected `openHandoffs`).
   */
  withdraw(p: Principal, participationId: ParticipationId): ProjectWorkspace {
    const stored = typeof participationId === 'string' && participationId.length > 0 ? this.rowById(participationId) : null;
    if (!stored) {
      // No existence oracle: only a principal allowed to withdraw platform-wide learns that the id is unknown.
      this.deps.auth.require(p, 'participation.withdraw', PLATFORM);
      throw new PlatformError('not_found', 'participation not found');
    }
    // The stored row names the workspace; the caller never does.
    this.access.require(p, stored.project_id, 'participation.withdraw', { workspaceId: stored.workspace_id });
    const now = this.deps.now();
    return immediateTx(this.db, () => {
      const row = this.rowById(stored.id);
      if (!row) throw new PlatformError('not_found', 'participation not found');
      if (row.is_primary === 1) throw new PlatformError('invalid', 'the primary participation follows the project domain and cannot be withdrawn');
      if (row.status === 'withdrawn') return toParticipation(row);
      if (row.status !== 'active') throw new PlatformError('conflict', `participation is ${row.status}`);
      // Live work keeps a participation: finish or cancel its jobs and agent sessions first
      // (ix_jobs_participation, ix_sessions_participation).
      const liveJobs = (this.db.prepare(`SELECT COUNT(*) AS n FROM jobs j JOIN job_states s ON s.state = j.state
        WHERE j.participation_id = ? AND s.terminal = 0`).get(row.id) as { n: number }).n;
      const liveSessions = (this.db.prepare(`SELECT COUNT(*) AS n FROM agent_sessions a JOIN agent_session_states s ON s.state = a.status
        WHERE a.participation_id = ? AND s.terminal = 0`).get(row.id) as { n: number }).n;
      if (liveJobs > 0 || liveSessions > 0) {
        throw new PlatformError('conflict', 'the participation has unfinished jobs or agent sessions', { participationId: row.id, liveJobs, liveSessions });
      }
      // An open handoff (sent, unanswered) in either direction keeps both participations (schema v8).
      const openHandoffs = this.deps.openHandoffs?.(row.id) ?? 0;
      if (openHandoffs > 0) {
        throw new PlatformError('conflict', 'the participation has open handoffs; answer or withdraw them first', { participationId: row.id, openHandoffs });
      }
      this.db.prepare("UPDATE project_workspaces SET status = 'withdrawn', updated_at = ? WHERE id = ?").run(now, row.id);
      appendActivityRow(this.db, { actorKind: p.kind, actorId: p.id, projectId: row.project_id, workspaceId: row.workspace_id,
        entityType: 'project_workspace', entityId: row.id, action: 'participation.withdraw', status: 'succeeded', details: {} }, now);
      return toParticipation(this.rowById(row.id)!);
    });
  }

  /**
   * Brings every project's primary in line with its legacy domain (repairs a failed
   * in-save sync and rows written by an older build). Idempotent. System only.
   * One IMMEDIATE transaction; each project in its own savepoint, so one failure is
   * logged and skipped without losing the others.
   */
  reconcileLegacyPrimaries(system: Principal): { set: number; cleared: number } {
    this.deps.auth.require(system, 'system.reconcile', PLATFORM);
    const now = this.deps.now();
    const out = { set: 0, cleared: 0 };
    immediateTx(this.db, () => {
      const projects = this.db.prepare('SELECT id, domain_id FROM projects ORDER BY rowid').all() as { id: string; domain_id: string | null }[];
      for (const pr of projects) {
        try {
          const r = this.db.transaction(() => syncPrimaryFromLegacyDomain(this.db, pr.id, pr.domain_id, now, this.deps.log))();
          if (r === 'set') out.set++; else if (r === 'cleared') out.cleared++;
        } catch (e) {
          this.deps.log?.(`[nexus] reconcile primary failed project=${String(pr.id).slice(0, 128)} error=${(e as { code?: string })?.code ?? 'error'}`);
        }
      }
    });
    return out;
  }

  private requireKnownWorkspace(workspaceId: WorkspaceId, mustBeLive: boolean): void {
    const r = typeof workspaceId === 'string' && workspaceId.length > 0
      ? this.db.prepare('SELECT retired_at FROM workspaces WHERE id = ?').get(workspaceId) as { retired_at: number | null } | undefined
      : undefined;
    if (!r) throw new PlatformError('invalid', 'unknown workspace');
    if (mustBeLive && r.retired_at !== null) throw new PlatformError('invalid', 'workspace is retired');
  }

  private rowFor(projectId: ProjectId, workspaceId: WorkspaceId): PwDbRow | null {
    return (this.db.prepare(`SELECT ${PW_COLUMNS} FROM project_workspaces WHERE project_id = ? AND workspace_id = ?`)
      .get(projectId, workspaceId) as PwDbRow | undefined) ?? null;
  }

  private rowById(id: string): PwDbRow | null {
    return (this.db.prepare(`SELECT ${PW_COLUMNS} FROM project_workspaces WHERE id = ?`).get(id) as PwDbRow | undefined) ?? null;
  }
}
