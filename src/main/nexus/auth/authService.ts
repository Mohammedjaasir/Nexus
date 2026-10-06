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

/** What a denial row records besides the principal. Untrusted: auditDenial caps and fixes it. */
export interface DenialAudit {
  action: string; reason: string; scope?: ScopeRef; needed?: Role;
  projectId?: string | null; workspaceId?: string | null; artifactId?: string | null; versionId?: string | null;
  jobId?: string | null; sessionId?: string | null; onBehalfOf?: string | null; attemptN?: number | null;
  entityType?: string | null; entityId?: string | null; details?: unknown;
}

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
    const { decision: d } = this.evaluate(p, action, scope);
    if (d.allowed) return d.role;
    const audited = this.auditDenial(p, {
      onBehalfOf: audit?.onBehalfOf, sessionId: audit?.sessionId, jobId: audit?.jobId, attemptN: audit?.attemptN,
      artifactId: audit?.artifactId, versionId: audit?.versionId, entityId: audit?.entityId, entityType: audit?.entityType,
      projectId: audit?.projectId, workspaceId: audit?.workspaceId, details: audit?.details,
      action, scope, reason: d.reason, needed: d.needed
    });
    throw new PlatformError('denied', `${String(action)} denied: ${d.reason}`, { reason: d.reason, needed: d.needed, audited });
  }

  /**
   * Records one denied activity row for a principal. require() uses it, and so do
   * refusals decided outside authorize() (for example a job input that was not
   * granted). It never trusts its input:
   * - the actor is the STORED principal: a known id with a mismatched kind is
   *   recorded with its stored kind and id, and the claim goes in
   *   `details.claimedKind`. An unknown principal is recorded as claimed (kind
   *   limited to user|agent|system, else 'user'), with its id capped;
   * - every id-like field and the action are capped at MAX_AUDIT_ID_CHARS. A
   *   scope's project and workspace win over the explicit fields;
   * - `reason`, `needed` and `claimedKind` are fixed fields that caller details cannot
   *   override; status is always 'denied'.
   * The row is written now in its own IMMEDIATE transaction, or, when a transaction
   * is open, queued and written once it has ended, so a rollback cannot lose it.
   * Returns true (written), 'deferred' (queued) or false (the write failed). Never throws.
   */
  auditDenial(p: Principal, a: DenialAudit): boolean | 'deferred' {
    const stored = isStr(p?.id) ? this.principals.get(p.id) : null;
    const action = String(a?.action ?? '').slice(0, MAX_AUDIT_ID_CHARS);
    const reason = String(a?.reason ?? 'denied').slice(0, MAX_AUDIT_ID_CHARS);
    const extra = a?.details && typeof a.details === 'object' && !Array.isArray(a.details) ? a.details as Record<string, unknown> : {};
    const details: Record<string, unknown> = { ...extra, reason };
    delete details.claimedKind;
    if (a?.needed) details.needed = a.needed; else delete details.needed;
    // A known id with a mismatched kind is recorded as the stored principal, with the claim alongside.
    const forged = stored !== null && stored.kind !== p.kind;
    if (forged) details.claimedKind = typeof p?.kind === 'string' ? String(p.kind).slice(0, 32) : String(p?.kind);
    const scope = a?.scope;
    const row: NewActivity = {
      onBehalfOf: cap(a?.onBehalfOf), sessionId: cap(a?.sessionId), jobId: cap(a?.jobId),
      attemptN: typeof a?.attemptN === 'number' && Number.isInteger(a.attemptN) ? a.attemptN : null,
      artifactId: cap(a?.artifactId), versionId: cap(a?.versionId), entityId: cap(a?.entityId),
      entityType: cap(a?.entityType) ?? (action.split('.')[0] || 'platform').slice(0, MAX_AUDIT_ID_CHARS),
      workspaceId: cap((scope ? scopeWorkspace(scope) : null) ?? a?.workspaceId),
      projectId: cap((scope ? scopeProject(scope) : null) ?? a?.projectId),
      // Fixed fields last: the caller cannot rewrite who acted, what was asked, or the outcome.
      actorKind: forged ? stored.kind : KINDS.includes(p?.kind) ? p.kind : 'user',
      actorId: forged ? stored.id : cap(p?.id) ?? String(p?.id ?? '').slice(0, MAX_AUDIT_ID_CHARS),
      action, status: 'denied', details
    };
    if (this.db.inTransaction) {
      // Writing now would put the row in the caller's transaction, which may roll back. Write it after.
      this.log(`[nexus] denial audit deferred until the open transaction ends: ${action} (${reason})`);
      const ts = this.deps.now();
      queueMicrotask(() => this.writeDeferred(row, ts, 1));
      return 'deferred';
    }
    try { appendActivityRow(this.db, row, this.deps.now()); return true; } catch { return false; }   // the denial stands either way
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
