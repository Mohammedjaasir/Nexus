/**
 * Pure rules for approvals. No I/O; the database enforces the same table in
 * `approval_transitions` (seeded from V9_APPROVAL_TRANSITIONS) and `tr_approvals_transition`,
 * and the two must stay identical (test/nexus-core-states.test.cjs compares them).
 */
import type { ApprovalStatus } from '../../../shared/nexus/platform';

const to = (...states: ApprovalStatus[]): readonly ApprovalStatus[] => Object.freeze(states);

/** Mirrors the v9 seed exactly: pending -> approved | denied | expired | withdrawn. Nothing leaves a terminal state. */
export const APPROVAL_TRANSITIONS: Readonly<Record<ApprovalStatus, readonly ApprovalStatus[]>> = Object.freeze({
  pending: to('approved', 'denied', 'expired', 'withdrawn'),
  approved: to(),
  denied: to(),
  expired: to(),
  withdrawn: to()
});

export const APPROVAL_STATUSES: readonly ApprovalStatus[] = Object.freeze(
  ['pending', 'approved', 'denied', 'expired', 'withdrawn'] as ApprovalStatus[]);
export const TERMINAL_APPROVAL_STATUSES: readonly ApprovalStatus[] = Object.freeze(
  ['approved', 'denied', 'expired', 'withdrawn'] as ApprovalStatus[]);

export function canTransitionApproval(from: ApprovalStatus, to: ApprovalStatus): boolean {
  const next = Object.prototype.hasOwnProperty.call(APPROVAL_TRANSITIONS, from) ? APPROVAL_TRANSITIONS[from] : undefined;
  return Array.isArray(next) && next.includes(to);
}
