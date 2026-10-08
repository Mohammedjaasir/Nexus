/**
 * Pure rules for job attempts. No I/O; the database enforces the same table in
 * `attempt_transitions` (seeded from V9_ATTEMPT_TRANSITIONS) and `tr_attempts_transition`,
 * and the two must stay identical (test/nexus-core-states.test.cjs compares them).
 */
import type { AttemptState } from '../../../shared/nexus/platform';

const to = (...states: AttemptState[]): readonly AttemptState[] => Object.freeze(states);

/** Mirrors the v9 seed exactly. Nothing leaves a terminal state. */
export const ATTEMPT_TRANSITIONS: Readonly<Record<AttemptState, readonly AttemptState[]>> = Object.freeze({
  starting: to('running', 'succeeded', 'failed', 'cancelled', 'abandoned'),
  running: to('succeeded', 'failed', 'cancelled', 'timed_out', 'abandoned'),
  succeeded: to(),
  failed: to(),
  cancelled: to(),
  timed_out: to(),
  abandoned: to()
});

export const ATTEMPT_STATES: readonly AttemptState[] = Object.freeze(
  ['starting', 'running', 'succeeded', 'failed', 'cancelled', 'timed_out', 'abandoned'] as AttemptState[]);
/** The states in which an attempt is live (the `ux_attempts_live` predicate). */
export const LIVE_ATTEMPT_STATES: readonly AttemptState[] = Object.freeze(['starting', 'running'] as AttemptState[]);
export const TERMINAL_ATTEMPT_STATES: readonly AttemptState[] = Object.freeze(
  ['succeeded', 'failed', 'cancelled', 'timed_out', 'abandoned'] as AttemptState[]);

export function canTransitionAttempt(from: AttemptState, to: AttemptState): boolean {
  const next = Object.prototype.hasOwnProperty.call(ATTEMPT_TRANSITIONS, from) ? ATTEMPT_TRANSITIONS[from] : undefined;
  return Array.isArray(next) && next.includes(to);
}
