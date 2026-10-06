/**
 * Authorization: principal -> scope -> authorize(action).
 *
 * - The principal is re-resolved from `principals` on every call. The caller's
 *   object only names an id; its kind must match the stored kind, otherwise the
 *   caller is treated as unknown. A caller cannot raise itself to 'system'.
 * - Roles come from `memberships` rows that match the scope:
 *     platform  -> the platform '*' row;
 *     workspace -> platform + that workspace's row;
 *     project   -> platform + that project's row (+ the workspace's row when the
 *                  scope names the workspace the project is acting in).
 *   An unrecognised scope matches nothing (fail closed).
 * - `authorize()` is a pure read. `require()` additionally audits a denial: one
 *   `denied` activity row, redacted, written in its OWN IMMEDIATE transaction
 *   (appendActivityRow opens one when no transaction is active), then throws
 *   PlatformError('denied'). Services call require() BEFORE opening their own
 *   transaction, so a rollback of the operation cannot take the denial row with it.
 */
import type Database from 'better-sqlite3';
import type {
  AuthDecision, PlatformAction, Principal, PrincipalId, PrincipalKind, Role, ScopeRef
} from '../../../shared/nexus/platform';
import { PlatformError } from '../errors';
import { appendActivityRow, type NewActivity } from '../activity/writer';
import { decide } from './policy';
import { PrincipalResolver } from './principals';

const KINDS: readonly PrincipalKind[] = ['user', 'agent', 'system'];
const isStr = (v: unknown): v is string => typeof v === 'string' && v.length > 0;

export class AuthService {
  private readonly principals: PrincipalResolver;

  constructor(private readonly db: Database.Database, private readonly deps: { now: () => number }) {
    this.principals = new PrincipalResolver(db);
  }

  rolesFor(principalId: PrincipalId, scope: ScopeRef): Role[] {
    if (!isStr(principalId) || !scope || typeof scope !== 'object') return [];
    const clauses: string[] = ["(scope_type = 'platform' AND scope_id = '*')"];
    const args: string[] = [principalId];
    if (scope.type === 'platform') {
      // platform row only
    } else if (scope.type === 'workspace' && isStr(scope.workspaceId)) {
      clauses.push("(scope_type = 'workspace' AND scope_id = ?)"); args.push(scope.workspaceId);
    } else if (scope.type === 'project' && isStr(scope.projectId)) {
      clauses.push("(scope_type = 'project' AND scope_id = ?)"); args.push(scope.projectId);
      if (isStr(scope.workspaceId)) { clauses.push("(scope_type = 'workspace' AND scope_id = ?)"); args.push(scope.workspaceId); }
    } else {
      return [];
    }
    const rows = this.db.prepare(`SELECT role FROM memberships WHERE principal_id = ? AND (${clauses.join(' OR ')})`)
      .all(...args) as { role: Role }[];
    return rows.map((r) => r.role);
  }

  authorize(p: Principal, action: PlatformAction, scope: ScopeRef): AuthDecision {
    const stored = isStr(p?.id) ? this.principals.get(p.id) : null;
    // The stored record is the identity; a mismatched kind is not that principal.
    const principal = stored && stored.kind === p.kind ? stored : null;
    return decide({
      principal,
      disabled: principal ? principal.disabledAt !== null : false,
      roles: principal ? this.rolesFor(principal.id, scope) : [],
      action
    });
  }

  require(p: Principal, action: PlatformAction, scope: ScopeRef, audit?: Partial<NewActivity>): Role | 'system' {
    const d = this.authorize(p, action, scope);
    if (d.allowed) return d.role;
    const extra = audit?.details && typeof audit.details === 'object' && !Array.isArray(audit.details) ? audit.details as Record<string, unknown> : {};
    const details: Record<string, unknown> = { ...extra, reason: d.reason };
    if (d.needed) details.needed = d.needed; else delete details.needed;
    const row: NewActivity = {
      onBehalfOf: audit?.onBehalfOf ?? null, sessionId: audit?.sessionId ?? null, jobId: audit?.jobId ?? null,
      attemptN: audit?.attemptN ?? null, artifactId: audit?.artifactId ?? null, versionId: audit?.versionId ?? null,
      entityId: audit?.entityId ?? null,
      entityType: isStr(audit?.entityType) ? audit!.entityType : String(action).split('.')[0] || 'platform',
      workspaceId: scopeWorkspace(scope) ?? audit?.workspaceId ?? null,
      projectId: scopeProject(scope) ?? audit?.projectId ?? null,
      // Fixed fields last: the audit hint cannot rewrite who acted, what was asked, or the outcome.
      actorKind: KINDS.includes(p?.kind) ? p.kind : 'user',
      actorId: isStr(p?.id) ? p.id : String(p?.id ?? ''),
      action: String(action), status: 'denied', details
    };
    let audited = true;
    try { appendActivityRow(this.db, row, this.deps.now()); } catch { audited = false; }   // the denial stands either way
    throw new PlatformError('denied', `${String(action)} denied: ${d.reason}`, { reason: d.reason, needed: d.needed, audited });
  }
}

function scopeProject(s: ScopeRef): string | null {
  return s && s.type === 'project' && isStr(s.projectId) ? s.projectId : null;
}
function scopeWorkspace(s: ScopeRef): string | null {
  if (!s) return null;
  if (s.type === 'workspace' && isStr(s.workspaceId)) return s.workspaceId;
  if (s.type === 'project' && isStr(s.workspaceId)) return s.workspaceId;
  return null;
}
