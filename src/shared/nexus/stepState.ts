// Lifecycle step state, computed on read from records (pure; no I/O). A step is
// never ticked by hand and a completed job alone never makes it done: `done`
// needs a version of the produced kind, in an allowed status, whose latest result
// for every listed validator is `passed`.

import type { LifecycleStep } from './domainSpec';
import { isAtOrBefore, type SubPhase, CURRENT_SUB_PHASE } from './domainSpec';
import { getValidator } from './validators';

/**
 * `awaiting_check`: a draft whose only outstanding checks run on something the user starts (a dev deployment for
 * `app.preview_health`), with nothing live: nothing is working on the step, it waits for that action.
 */
export type StepState = 'unavailable' | 'blocked' | 'ready' | 'in_progress' | 'awaiting_check' | 'done' | 'failed';
export const STEP_STATES: readonly StepState[] = ['unavailable', 'blocked', 'ready', 'in_progress', 'awaiting_check', 'done', 'failed'];

export interface StepRecords {
  /** Versions of the step's produced kind, each with the latest status per validator. */
  versions: { status: 'draft' | 'candidate' | 'active' | 'failed' | 'deprecated'; validators: Readonly<Record<string, 'passed' | 'failed' | 'error' | 'skipped'>> }[];
  /** Jobs (and checks) still working toward the step. */
  liveJobs: number;
  /** Whether every kind the step consumes has a candidate or active version. */
  inputsAvailable: boolean;
  /** For a record-based step (participation, a healthy deployment): whether the record exists. */
  recordPresent?: boolean;
  /**
   * Dev deployments (and the jobs starting them) live now for the step's versions: a deployment-run check can be
   * running. Undefined when the caller did not read them: a draft then reads in progress, as before.
   */
  liveDeployments?: number;
}

/** True when a validator runs only on something the user starts (a dev deployment), never by itself. */
const runsOnUserAction = (id: string): boolean => getValidator(id)?.executes === 'deployment';

export function stepStateFrom(step: LifecycleStep, r: StepRecords, at: SubPhase = CURRENT_SUB_PHASE): StepState {
  if (step.status === 'FUTURE' || !isAtOrBefore(step.subPhase, at)) return 'unavailable';
  const waiting = (): StepState => (r.liveJobs > 0 ? 'in_progress' : r.inputsAvailable ? 'ready' : 'blocked');
  const done = step.doneWhen;
  if ('record' in done) return r.recordPresent ? 'done' : waiting();
  const allowed = done.statuses as readonly string[];
  if (r.versions.some((v) => allowed.includes(v.status) && done.validators.every((id) => v.validators[id] === 'passed'))) return 'done';
  if (r.liveJobs > 0) return 'in_progress';
  // Nothing is working on the step and a draft's checks could not run (`error`): it needs attention (Revalidate),
  // so it reads failed, never in progress forever.
  if (r.versions.some((v) => v.status === 'draft' && Object.values(v.validators).includes('error'))) return 'failed';
  // A draft whose checks have not failed is still being validated, unless every check it still lacks runs only on
  // something the user starts (a dev deployment) and nothing of that kind is live: then it waits for that action.
  const drafts = r.versions.filter((v) => v.status === 'draft' && !Object.values(v.validators).includes('failed'));
  if (drafts.length > 0) {
    const waitsOnUser = (v: StepRecords['versions'][number]): boolean => {
      const pending = done.validators.filter((id) => v.validators[id] !== 'passed');
      return pending.length > 0 && pending.every(runsOnUserAction);
    };
    if (r.liveDeployments === 0 && drafts.every(waitsOnUser)) return 'awaiting_check';
    return 'in_progress';
  }
  if (r.versions.some((v) => v.status === 'failed' || done.validators.some((id) => v.validators[id] === 'failed'))) return 'failed';
  return r.inputsAvailable ? 'ready' : 'blocked';
}
