/**
 * Pure rules for agent sessions: the session state table and terminal states.
 * No I/O. The database enforces the same table through `agent_session_transitions`
 * (seeded from V7_SESSION_TRANSITIONS) and `tr_sessions_transition`; the two must
 * stay identical (test/nexus-core-states.test.cjs compares them).
 */
import type { AgentSessionStatus } from '../../../shared/nexus/platform';

const list = (...s: AgentSessionStatus[]): readonly AgentSessionStatus[] => Object.freeze(s);

/** 8 states, 14 transitions. Mirrors V7_SESSION_TRANSITIONS exactly. */
export const SESSION_TRANSITIONS: Readonly<Record<AgentSessionStatus, readonly AgentSessionStatus[]>> = Object.freeze({
  open: list('running', 'failed', 'cancelled'),
  running: list('awaiting_approval', 'completed', 'failed', 'cancelled', 'timed_out', 'interrupted'),
  awaiting_approval: list('running', 'failed', 'cancelled', 'timed_out', 'interrupted'),
  completed: list(),
  failed: list(),
  cancelled: list(),
  timed_out: list(),
  interrupted: list()
});

export const SESSION_STATES: readonly AgentSessionStatus[] = Object.freeze(Object.keys(SESSION_TRANSITIONS) as AgentSessionStatus[]);

export const TERMINAL_SESSION_STATES: ReadonlySet<AgentSessionStatus> = new Set<AgentSessionStatus>([
  'completed', 'failed', 'cancelled', 'timed_out', 'interrupted'
]);

export function isSessionStatus(s: unknown): s is AgentSessionStatus {
  return typeof s === 'string' && Object.prototype.hasOwnProperty.call(SESSION_TRANSITIONS, s);
}

export function canTransitionSession(from: AgentSessionStatus, to: AgentSessionStatus): boolean {
  if (!isSessionStatus(from) || !isSessionStatus(to)) return false;
  return SESSION_TRANSITIONS[from].includes(to);
}
