/**
 * Project-scoped authorization for the platform services.
 *
 * RULE for every caller (workspaces now; jobs, sessions and versions later):
 * `o.workspaceId` must come from a STORED participation row the service has just
 * loaded (for example, the row a withdraw acts on, or the participation a job
 * runs in). Never pass a workspace id supplied by the caller or the renderer: a
 * workspace grant widens a principal's roles on the project, so a caller-chosen id
 * would let the caller pick its own authority. When there is no stored row (for
 * example, attaching a project to a new workspace), authorize at plain PROJECT
 * scope, with no workspaceId. AuthService additionally applies a workspace grant
 * only while that participation is ACTIVE.
 *
 * Order: authorization first, then existence. A principal without access gets
 * 'denied' whether or not the project exists, so a denial reveals nothing; an
 * authorized principal gets 'not_found' for a missing project. Services that look
 * up a child record by id (a participation, later an artifact, job or session)
 * follow the same rule: an unknown id is 'not_found' only for a principal that is
 * authorized for the action at PLATFORM scope; anyone else gets 'denied'.
 *
 * require() calls AuthService.require, which audits a denial. Call it BEFORE
 * opening a transaction (a denial raised inside one is audited after it ends).
 */
import type Database from 'better-sqlite3';
import type { PlatformAction, Principal, ProjectId, ScopeRef, WorkspaceId } from '../../../shared/nexus/platform';
import type { AuthService } from '../auth/authService';
import { PlatformError } from '../errors';

export class ProjectAccess {
  constructor(private readonly db: Database.Database, private readonly deps: { auth: AuthService }) {}

  exists(projectId: ProjectId): boolean {
    if (typeof projectId !== 'string' || projectId.length === 0) return false;
    return this.db.prepare('SELECT 1 FROM projects WHERE id = ?').get(projectId) !== undefined;
  }

  /** Throws PlatformError 'denied' (audited) or 'not_found'. See the rule above for `o.workspaceId`. */
  require(p: Principal, projectId: ProjectId, action: PlatformAction, o?: { workspaceId?: WorkspaceId }): void {
    const scope: ScopeRef = typeof o?.workspaceId === 'string' && o.workspaceId.length > 0
      ? { type: 'project', projectId, workspaceId: o.workspaceId }
      : { type: 'project', projectId };
    this.deps.auth.require(p, action, scope);
    if (!this.exists(projectId)) throw new PlatformError('not_found', 'project not found', { projectId: String(projectId).slice(0, 128) });
  }
}
