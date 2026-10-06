/**
 * Pure rules for jobs: the job state table, terminal states and the retry rule.
 * No I/O. The database enforces the same table through `job_state_transitions`
 * (seeded from V7_JOB_TRANSITIONS) and `tr_jobs_transition`; the two must stay
 * identical (test/nexus-core-states.test.cjs compares them).
 *
 * Eleven states (M1, user decision): the brief's nine plus `leased` and
 * `retry_scheduled`. `failed` and `timed_out` are terminal (they set finished_at)
 * but may move to `retry_scheduled` when the job is retryable (architecture J.7).
 */
import type { Job, JobRetryPolicy, JobState } from '../../../shared/nexus/platform';

const list = (...s: JobState[]): readonly JobState[] => Object.freeze(s);

/** 11 states, 23 transitions. Mirrors V7_JOB_TRANSITIONS exactly. */
export const JOB_TRANSITIONS: Readonly<Record<JobState, readonly JobState[]>> = Object.freeze({
  queued: list('leased', 'cancelled'),
  leased: list('running', 'queued', 'failed', 'cancelled', 'interrupted'),
  running: list('awaiting_approval', 'completed', 'partial', 'failed', 'cancelled', 'timed_out', 'interrupted'),
  awaiting_approval: list('running', 'failed', 'cancelled', 'timed_out', 'interrupted'),
  retry_scheduled: list('queued', 'cancelled'),
  completed: list(),
  partial: list(),
  failed: list('retry_scheduled'),
  cancelled: list(),
  timed_out: list('retry_scheduled'),
  interrupted: list()
});

export const JOB_STATES: readonly JobState[] = Object.freeze(Object.keys(JOB_TRANSITIONS) as JobState[]);

export const TERMINAL_JOB_STATES: ReadonlySet<JobState> = new Set<JobState>([
  'completed', 'partial', 'failed', 'cancelled', 'timed_out', 'interrupted'
]);

/** A job is retried only when the caller declared it idempotent; one attempt by default. */
export const DEFAULT_RETRY: JobRetryPolicy = Object.freeze({ idempotent: false, maxAttempts: 1, backoffMs: [] as number[] });

export function isJobState(s: unknown): s is JobState {
  return typeof s === 'string' && Object.prototype.hasOwnProperty.call(JOB_TRANSITIONS, s);
}

export function canTransitionJob(from: JobState, to: JobState): boolean {
  if (!isJobState(from) || !isJobState(to)) return false;
  return JOB_TRANSITIONS[from].includes(to);
}

/**
 * Architecture J.7: a job is retried only if it is idempotent, has attempts left,
 * and is not an agent run (an agent's side effects cannot be replayed safely).
 */
export function canRetry(job: Pick<Job, 'retry' | 'attempts' | 'kind'>): boolean {
  const r = job?.retry;
  if (!r || r.idempotent !== true) return false;
  if (typeof r.maxAttempts !== 'number' || typeof job.attempts !== 'number') return false;
  return job.attempts < r.maxAttempts && job.kind !== 'agent.run';
}
