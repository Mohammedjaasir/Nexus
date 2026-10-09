/**
 * The authorization policy: a pure function from (principal, roles, action) to a
 * decision. No I/O; AuthService resolves the principal and its roles from the DB.
 *
 * Decision order (first match wins):
 *   1. unknown principal         -> 'unknown_principal'
 *   2. disabled principal        -> 'disabled_principal'
 *   3. agent principal           -> 'agent_requires_token' (agents act only through
 *                                   capability tokens, which arrive in a later phase)
 *   4. system-only action        -> allowed only for kind 'system', else 'system_only'
 *   5. no role in scope          -> 'no_membership'
 *   6. strongest role (max ROLE_RANK across all matching scopes) must cover the
 *      action's minimum role     -> else 'role' with `needed`.
 *
 * Max-role semantics: a broad grant (for example a platform owner) is not narrowed
 * by a weaker, narrower row. Multi-user can add explicit deny rows later without
 * changing the scope model.
 */
import type { AuthDecision, PlatformAction, Principal, Role } from '../../../shared/nexus/platform';

export const ROLE_RANK: Record<Role, number> = { viewer: 1, member: 2, admin: 3, owner: 4 };

export const READ_ACTIONS: readonly PlatformAction[] = Object.freeze([
  'project.read', 'workspace.read', 'artifact.read', 'lineage.read', 'job.read', 'session.read', 'activity.read',
  'handoff.read', 'approval.read', 'platform.health'
] as PlatformAction[]);

export const MEMBER_ACTIONS: readonly PlatformAction[] = Object.freeze([
  'participation.attach', 'participation.withdraw', 'artifact.create',
  'version.register', 'version.update_draft', 'version.discard', 'version.promote',
  'lineage.write', 'job.create', 'job.cancel', 'session.open', 'session.cancel',
  'handoff.send', 'handoff.respond', 'handoff.withdraw', 'deployment.stop', 'version.revalidate'
] as PlatformAction[]);

// blob.gc: apply a blob GC (B2a, A6) at platform scope; the local owner and the system principal (admin) may.
export const ADMIN_ACTIONS: readonly PlatformAction[] = Object.freeze(['artifact.archive', 'blob.gc'] as PlatformAction[]);

// approval.respond: a user's once-only consent (egress, image preparation). Owner today; admin for those in multi-user later.
export const OWNER_ACTIONS: readonly PlatformAction[] = Object.freeze(['approval.respond'] as PlatformAction[]);

// approval.create, deployment.transition and exec.ingest: written by the execution core as the system principal only.
export const SYSTEM_ONLY_ACTIONS: readonly PlatformAction[] = Object.freeze([
  'version.finalize', 'job.transition', 'session.transition', 'system.reconcile',
  'approval.create', 'deployment.transition', 'exec.ingest'
] as PlatformAction[]);

const MIN_ROLE = new Map<PlatformAction, Role>([
  ...READ_ACTIONS.map((a) => [a, 'viewer'] as const),
  ...MEMBER_ACTIONS.map((a) => [a, 'member'] as const),
  ...ADMIN_ACTIONS.map((a) => [a, 'admin'] as const),
  ...OWNER_ACTIONS.map((a) => [a, 'owner'] as const)
]);
const SYSTEM_ONLY = new Set<PlatformAction>(SYSTEM_ONLY_ACTIONS);

export function decide(i: { principal: Principal | null; disabled?: boolean; roles: Role[]; action: PlatformAction }): AuthDecision {
  const p = i.principal;
  if (!p) return { allowed: false, reason: 'unknown_principal' };
  if (i.disabled) return { allowed: false, reason: 'disabled_principal' };
  if (p.kind === 'agent') return { allowed: false, reason: 'agent_requires_token' };
  if (p.kind !== 'user' && p.kind !== 'system') return { allowed: false, reason: 'unknown_principal' };
  if (SYSTEM_ONLY.has(i.action)) return p.kind === 'system' ? { allowed: true, role: 'system' } : { allowed: false, reason: 'system_only' };
  let best: Role | null = null;
  for (const r of i.roles) if (ROLE_RANK[r] && (best === null || ROLE_RANK[r] > ROLE_RANK[best])) best = r;
  if (best === null) return { allowed: false, reason: 'no_membership' };
  // An action missing from every list (impossible while the lists cover PlatformAction) needs owner: fail closed.
  const needed = MIN_ROLE.get(i.action) ?? 'owner';
  return ROLE_RANK[best] >= ROLE_RANK[needed] ? { allowed: true, role: best } : { allowed: false, reason: 'role', needed };
}
