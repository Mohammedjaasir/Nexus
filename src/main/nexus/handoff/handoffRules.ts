/**
 * Pure rules for handoffs. No I/O; the database enforces the same table in
 * `handoff_transitions` (seeded from V8_HANDOFF_TRANSITIONS) and
 * `tr_handoffs_transition`, and the two must stay identical.
 */
import type { HandoffStatus } from '../../../shared/nexus/platform';

/** Mirrors the v8 seed exactly: sent -> accepted | declined | withdrawn. Nothing leaves a terminal state. */
export const HANDOFF_TRANSITIONS: Readonly<Record<HandoffStatus, readonly HandoffStatus[]>> = Object.freeze({
  sent: Object.freeze(['accepted', 'declined', 'withdrawn'] as HandoffStatus[]),
  accepted: Object.freeze([] as HandoffStatus[]),
  declined: Object.freeze([] as HandoffStatus[]),
  withdrawn: Object.freeze([] as HandoffStatus[])
});

export const HANDOFF_STATUSES: readonly HandoffStatus[] = Object.freeze(['sent', 'accepted', 'declined', 'withdrawn'] as HandoffStatus[]);

/** The artifact kind accepting a handoff creates in the receiving workspace: references only, never content. */
export const RECEIPT_KIND = 'handoff_receipt';
/** Most versions one handoff carries (the subject_count CHECK is the backstop). */
export const MAX_SUBJECTS = 20;
/** The receipt depends on each subject (conflict C18: an existing relation, no vocabulary change). */
export const RECEIPT_RELATION = 'depends_on';
/** The role each subject has in the receipt version's inputs. */
export const RECEIPT_INPUT_ROLE = 'received';
export const MAX_TITLE_CHARS = 200;
export const MAX_NOTE_CHARS = 2000;

export function canTransitionHandoff(from: HandoffStatus, to: HandoffStatus): boolean {
  const next = Object.prototype.hasOwnProperty.call(HANDOFF_TRANSITIONS, from) ? HANDOFF_TRANSITIONS[from] : undefined;
  return Array.isArray(next) && next.includes(to);
}
