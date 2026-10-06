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
 *   transaction. If a denial happens while a transaction is open anyway, the row is
 *   not written into it (a rollback would lose it): it is queued and written once
 *   the transaction has ended (bounded retries, then a logged warning), and the
 *   error's detail says `audited: 'deferred'`.
 * - A workspace grant applies to a project scope only while the project has an
 *   ACTIVE project_workspaces row for that workspace.
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

/** Every id-like string written to a denial row is truncated to this many characters. */
export const MAX_AUDIT_ID_CHARS = 128;
/** A denial raised inside a caller's transaction is written later; this many attempts, then give up. */
export const DEFERRED_AUDIT_ATTEMPTS = 5;

const cap = (v: unknown): string | null => (isStr(v) ? v.slice(0, MAX_AUDIT_ID_CHARS) : null);

export class AuthService {
  private readonly principals: PrincipalResolver;
  private readonly log: (line: string) => void;

  constructor(private readonly db: Database.Database, private readonly deps: { now: () => number; log?: (line: string) => void }) {
    this.principals = new PrincipalResolver(db);
    this.log = deps.log ?? (() => {});
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
      // A workspace grant reaches a project only while the project actively participates in that workspace.
      if (isStr(scope.workspaceId)) {
        clauses.push(`(scope_type = 'workspace' AND scope_id = ? AND EXISTS (SELECT 1 FROM project_workspaces pw
          WHERE pw.project_id = ? AND pw.workspace_id = ? AND pw.status = 'active'))`);
        args.push(scope.workspaceId, scope.projectId, scope.workspaceId);
      }
    } else {
      return [];
    }
    const rows = this.db.prepare(`SELECT role FROM memberships WHERE principal_id = ? AND (${clauses.join(' OR ')})`)
      .all(...args) as { role: Role }[];
    return rows.map((r) => r.role);
  }

  authorize(p: Principal, action: PlatformAction, scope: ScopeRef): AuthDecision {
    return this.evaluate(p, action, scope).decision;
  }

  private evaluate(p: Principal, action: PlatformAction, scope: ScopeRef) {
    const stored = isStr(p?.id) ? this.principals.get(p.id) : null;
    // The stored record is the identity; a mismatched kind is not that principal.
    const principal = stored && stored.kind === p.kind ? stored : null;
    const decision = decide({
      principal,
      disabled: principal ? principal.disabledAt !== null : false,
      roles: principal ? this.rolesFor(principal.id, scope) : [],
      action
    });
    return { decision, stored };
  }

  require(p: Principal, action: PlatformAction, scope: ScopeRef, audit?: Partial<NewActivity>): Role | 'system' {
    const { decision: d, stored } = this.evaluate(p, action, scope);
    if (d.allowed) return d.role;
    const extra = audit?.details && typeof audit.details === 'object' && !Array.isArray(audit.details) ? audit.details as Record<string, unknown> : {};
    const details: Record<string, unknown> = { ...extra, reason: d.reason };
    delete details.claimedKind;
    if (d.needed) details.needed = d.needed; else delete details.needed;
    // A known id with a mismatched kind is recorded as the stored principal, with the claim alongside.
    const forged = stored !== null && stored.kind !== p.kind;
    if (forged) details.claimedKind = typeof p?.kind === 'string' ? String(p.kind).slice(0, 32) : String(p?.kind);
    const row: NewActivity = {
      onBehalfOf: cap(audit?.onBehalfOf), sessionId: cap(audit?.sessionId), jobId: cap(audit?.jobId),
      attemptN: audit?.attemptN ?? null, artifactId: cap(audit?.artifactId), versionId: cap(audit?.versionId),
      entityId: cap(audit?.entityId),
      entityType: cap(audit?.entityType) ?? (String(action).split('.')[0] || 'platform').slice(0, MAX_AUDIT_ID_CHARS),
      workspaceId: cap(scopeWorkspace(scope) ?? audit?.workspaceId),
      projectId: cap(scopeProject(scope) ?? audit?.projectId),
      // Fixed fields last: the audit hint cannot rewrite who acted, what was asked, or the outcome.
      actorKind: forged ? stored.kind : KINDS.includes(p?.kind) ? p.kind : 'user',
      actorId: forged ? stored.id : cap(p?.id) ?? String(p?.id ?? '').slice(0, MAX_AUDIT_ID_CHARS),
      action: String(action).slice(0, MAX_AUDIT_ID_CHARS), status: 'denied', details
    };
    const audited = this.auditDenial(row, d.reason);
    throw new PlatformError('denied', `${String(action)} denied: ${d.reason}`, { reason: d.reason, needed: d.needed, audited });
  }

  /**
   * Records one denied activity row for a refusal decided outside authorize() (for
   * example a job input that was not granted). Same rule as require(): written now
   * in its own IMMEDIATE transaction, or, when a transaction is open, queued and
   * written once it has ended, so a rollback cannot lose it. Never throws.
   * `row.status` is forced to 'denied'.
   */
  auditDenial(row: NewActivity, reason?: string): boolean | 'deferred' {
    const denied: NewActivity = { ...row, status: 'denied' };
    if (this.db.inTransaction) {
      // Writing now would put the row in the caller's transaction, which may roll back. Write it after.
      this.log(`[nexus] denial audit deferred until the open transaction ends: ${denied.action}${reason ? ` (${reason})` : ''}`);
      const ts = this.deps.now();
      queueMicrotask(() => this.writeDeferred(denied, ts, 1));
      return 'deferred';
    }
    try { appendActivityRow(this.db, denied, this.deps.now()); return true; } catch { return false; }   // the denial stands either way
  }

  private writeDeferred(row: NewActivity, ts: number, attempt: number): void {
    if (this.db.inTransaction || !this.db.open) {
      if (attempt >= DEFERRED_AUDIT_ATTEMPTS || !this.db.open) {
        this.log(`[nexus] warning: denial audit dropped after ${attempt} attempt(s): ${row.action}`);
        return;
      }
      setTimeout(() => this.writeDeferred(row, ts, attempt + 1), 10 * attempt);
      return;
    }
    try { appendActivityRow(this.db, row, ts); } catch (e) {
      this.log(`[nexus] warning: deferred denial audit failed: ${row.action} (${(e as { code?: string })?.code ?? 'error'})`);
    }
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
