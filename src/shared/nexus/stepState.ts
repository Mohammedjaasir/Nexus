// Lifecycle step state, computed on read from records (pure; no I/O). A step is
// never ticked by hand and a completed job alone never makes it done: `done`
// needs a version of the produced kind, in an allowed status, whose latest result
// for every listed validator is `passed`.

import type { LifecycleStep } from './domainSpec';
import { isAtOrBefore, type SubPhase, CURRENT_SUB_PHASE } from './domainSpec';

export type StepState = 'unavailable' | 'blocked' | 'ready' | 'in_progress' | 'done' | 'failed';
export const STEP_STATES: readonly StepState[] = ['unavailable', 'blocked', 'ready', 'in_progress', 'done', 'failed'];

export interface StepRecords {
  /** Versions of the step's produced kind, each with the latest status per validator. */
  versions: { status: 'draft' | 'candidate' | 'active' | 'failed' | 'deprecated'; validators: Readonly<Record<string, 'passed' | 'failed' | 'error' | 'skipped'>> }[];
  /** Jobs (and checks) still working toward the step. */
  liveJobs: number;
  /** Whether every kind the step consumes has a candidate or active version. */
  inputsAvailable: boolean;
  /** For a record-based step (participation, a healthy deployment): whether the record exists. */
  recordPresent?: boolean;
}

export function stepStateFrom(step: LifecycleStep, r: StepRecords, at: SubPhase = CURRENT_SUB_PHASE): StepState {
  if (step.status === 'FUTURE' || !isAtOrBefore(step.subPhase, at)) return 'unavailable';
  const waiting = (): StepState => (r.liveJobs > 0 ? 'in_progress' : r.inputsAvailable ? 'ready' : 'blocked');
  const done = step.doneWhen;
  if ('record' in done) return r.recordPresent ? 'done' : waiting();
  const allowed = done.statuses as readonly string[];
  if (r.versions.some((v) => allowed.includes(v.status) && done.validators.every((id) => v.validators[id] === 'passed'))) return 'done';
  if (r.liveJobs > 0) return 'in_progress';
  // A draft whose checks have not failed is still being validated (or waits for a Revalidate after an error).
  if (r.versions.some((v) => v.status === 'draft' && !Object.values(v.validators).includes('failed'))) return 'in_progress';
  if (r.versions.some((v) => v.status === 'failed' || done.validators.some((id) => v.validators[id] === 'failed'))) return 'failed';
  return r.inputsAvailable ? 'ready' : 'blocked';
}
