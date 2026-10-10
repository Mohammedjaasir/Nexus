// Pure: a persisted job (JobView, #26/#27) as a run strip and one plain sentence.
// The stages come from main's headline only; a job never reads "Completed" when
// the checks on what it made failed, and no percentage is ever shown (main
// reports no step counts in B2a, so there is nothing to compute one from).
import type { JobHeadline, JobView } from '@shared/nexus/ipc';
import type { JobState } from '@shared/nexus/platform';
import { getUserAction } from '@shared/nexus/actions';

export type JobStageId = 'queued' | 'provisioning' | 'running' | 'collecting' | 'validating' | 'result';
export type JobStageState = 'done' | 'active' | 'waiting' | 'pending' | 'stopped';
export interface JobStage { id: JobStageId; label: string; state: JobStageState }
export type JobResult = 'passed' | 'failed' | 'could_not_run' | 'failed_run' | 'cancelled' | 'timed_out' | 'interrupted' | null;

export interface JobRunView {
  id: string;
  title: string;
  /** One plain sentence; never "Completed", never a percentage. */
  headline: string;
  /** The status in one or two words (status is always text, never colour alone). */
  word: string;
  stages: JobStage[];
  result: JobResult;
  live: boolean;
  canCancel: boolean;
  canRetry: boolean;
  /** True while the job waits for the person (an approval). */
  needsYou: boolean;
}

const STAGES: { id: JobStageId; label: string }[] = [
  { id: 'queued', label: 'Queued' }, { id: 'provisioning', label: 'Sandbox' }, { id: 'running', label: 'Running' },
  { id: 'collecting', label: 'Collecting' }, { id: 'validating', label: 'Checking' }, { id: 'result', label: 'Result' }
];

export const STAGE_STATE_TEXT: Readonly<Record<JobStageState, string>> = Object.freeze({
  done: 'done', active: 'in progress', waiting: 'waiting', pending: 'not started', stopped: 'stopped here'
});

const LIVE_STATES: readonly JobState[] = ['queued', 'leased', 'running', 'awaiting_approval', 'retry_scheduled'];
const RETRY_STATES: readonly JobState[] = ['failed', 'timed_out', 'cancelled', 'interrupted'];

/** Cancel only while the job is live (and not already asked to stop). */
export const canCancelJob = (j: Pick<JobView, 'state' | 'cancelRequested'>): boolean => LIVE_STATES.includes(j.state) && !j.cancelRequested;
/** Retry only after a failure, a timeout, a cancel or an interruption; a run whose checks failed is run again from its action. */
export const canRetryJob = (j: Pick<JobView, 'state'>): boolean => RETRY_STATES.includes(j.state);

const WAITING: Partial<Record<JobHeadline, string>> = {
  queued: 'Queued; it starts when a slot is free',
  'waiting:runner': 'Waiting: the execution runner is not running',
  'waiting:docker': 'Waiting: Docker is not running',
  'waiting:image': 'Waiting: the sandbox image is not prepared',
  'waiting:disk': 'Waiting: there is not enough free disk',
  'waiting:slots': 'Waiting: other runs are using every slot',
  'waiting:memory': 'Waiting: Docker memory is in use by other containers',
  'waiting:git': 'Waiting: git is not available',
  'waiting:retry': 'Waiting to try again after a passing fault'
};

type Flavour = 'tests' | 'discover' | 'build' | 'deps' | 'snapshot' | 'assemble' | 'preview' | 'diagnose' | 'check' | 'other';
function flavourOf(j: Pick<JobView, 'actionId' | 'recipeId' | 'kind'>): Flavour {
  const a = j.actionId ?? ''; const r = j.recipeId ?? '';
  if (a === 'sde.tests.run' || r === 'sde.test.node' || r === 'sde.test.pytest') return 'tests';
  if (a === 'sde.tests.discover' || r === 'sde.test.discover') return 'discover';
  if (a === 'sde.build.run' || r.startsWith('sde.build.')) return 'build';
  if (a === 'sde.deps.install' || r.startsWith('sde.deps.')) return 'deps';
  if (a === 'sde.repository.snapshot' || r === 'repo.snapshot') return 'snapshot';
  if (a === 'sde.app.assemble' || r === 'sde.app.assemble') return 'assemble';
  if (a === 'sde.preview.start' || r === 'sde.preview.start') return 'preview';
  if (a === 'sde.diagnose' || r === 'sde.diagnose') return 'diagnose';
  if (j.kind === 'validate') return 'check';
  return 'other';
}

const RAN: Record<Flavour, string> = {
  tests: 'Tests ran', discover: 'Tests were listed', build: 'The build ran', deps: 'Dependencies were installed', snapshot: 'The snapshot was taken',
  assemble: 'The application was assembled', preview: 'The dev deployment started', diagnose: 'The diagnosis ran', check: 'The check ran', other: 'The run finished'
};

/** A reason from a record (a check summary, an error message): lower-cased first letter, no trailing full stop. */
function clause(reason: string | null | undefined): string {
  const t = (reason ?? '').trim().replace(/\.+$/, '');
  if (!t) return '';
  return `: ${t[0].toLowerCase()}${t.slice(1)}`;
}

/** The title: the action's words from the registry, else the check or the job kind. */
export function jobTitle(j: Pick<JobView, 'actionId' | 'recipeId' | 'kind'>): string {
  const a = j.actionId ? getUserAction(j.actionId) : null;
  if (a) return a.label;
  if (j.kind === 'validate') return 'Check';
  if (j.kind === 'ingest') return 'Collect outputs';
  return j.recipeId ?? 'Run';
}

function stagesFor(h: JobHeadline, started: boolean): { stages: JobStage[]; result: JobResult } {
  const at = (active: JobStageId, state: JobStageState, result: JobResult = null): { stages: JobStage[]; result: JobResult } => {
    const i = STAGES.findIndex((s) => s.id === active);
    return { stages: STAGES.map((s, k) => ({ ...s, state: k < i ? 'done' : k === i ? state : 'pending' })), result };
  };
  const all = (result: JobResult): { stages: JobStage[]; result: JobResult } =>
    ({ stages: STAGES.map((s) => ({ ...s, state: s.id === 'result' ? 'stopped' : 'done' })), result });
  switch (h) {
    case 'queued': return at('queued', 'active');
    case 'provisioning': return at('provisioning', 'active');
    case 'running': return at('running', 'active');
    case 'waiting_for_approval': return at('running', 'waiting');
    case 'collecting': return at('collecting', 'active');
    case 'validating': return at('validating', 'active');
    case 'checks_passed': return { stages: STAGES.map((s) => ({ ...s, state: 'done' })), result: 'passed' };
    case 'checks_failed': return all('failed');
    case 'checks_could_not_run': return all('could_not_run');
    case 'failed': case 'cancelled': case 'timed_out': case 'interrupted': {
      const result: JobResult = h === 'failed' ? 'failed_run' : h;
      return at(started ? 'running' : 'queued', 'stopped', result);
    }
    default: return at('queued', 'waiting'); // waiting:* (before the sandbox exists)
  }
}

const KNOWN = new Set<string>(['queued', 'waiting:runner', 'waiting:docker', 'waiting:image', 'waiting:disk', 'waiting:slots', 'waiting:memory',
  'waiting:git', 'waiting:retry', 'provisioning', 'running', 'waiting_for_approval', 'collecting', 'validating', 'checks_passed', 'checks_failed',
  'checks_could_not_run', 'failed', 'cancelled', 'timed_out', 'interrupted']);

const RESULT_WORD: Record<Exclude<JobResult, null>, string> = {
  passed: 'Checks passed', failed: 'Checks failed', could_not_run: 'Checks could not run', failed_run: 'Failed', cancelled: 'Cancelled',
  timed_out: 'Timed out', interrupted: 'Interrupted'
};

/**
 * The run view of a job. `reason` is a sourced sentence when the caller has one (the first failed check's summary of
 * an output, or the job's own error); without it the headline stops at what the headline itself knows.
 */
export function jobRun(j: JobView, o: { reason?: string | null } = {}): JobRunView {
  const h = j.headline;
  const f = flavourOf(j);
  const reason = o.reason ?? j.error?.message ?? null;
  const { stages, result } = stagesFor(h, j.startedAt !== null);
  let headline: string;
  if (WAITING[h]) headline = WAITING[h]!;
  else if (h === 'waiting_for_approval') headline = f === 'deps' ? 'Waiting for your approval to download dependencies' : 'Waiting for your approval';
  else if (h === 'provisioning') headline = 'Preparing the sandbox';
  else if (h === 'running') headline = j.cancelRequested ? 'Stopping: cancel requested' : 'Running';
  else if (h === 'collecting') headline = 'Collecting the outputs';
  else if (h === 'validating') headline = `${RAN[f]}; checking the results`;
  else if (h === 'checks_passed') headline = `${RAN[f]}; checks passed`;
  else if (h === 'checks_failed') headline = `${RAN[f]}; checks failed${clause(o.reason)}`;
  else if (h === 'checks_could_not_run') headline = `${RAN[f]}; checks could not run${clause(o.reason)}`;
  else if (h === 'cancelled') headline = 'Cancelled';
  else if (h === 'timed_out') headline = `Stopped: it ran past its time limit${clause(reason)}`;
  else if (h === 'interrupted') headline = 'Interrupted: the app stopped while it ran';
  else if (h === 'failed') headline = `Failed${clause(reason)}`;
  // A headline this build does not know (a newer main): neutral words, never a verdict.
  else headline = `Status: ${String(j.state).replace(/_/g, ' ')}`;
  const live = LIVE_STATES.includes(j.state);
  const known = KNOWN.has(h);
  const word = result ? RESULT_WORD[result] : h === 'waiting_for_approval' ? 'Waiting for you' : h === 'validating' ? 'Checking'
    : !known ? 'Status unknown' : live ? (h.startsWith('waiting') || h === 'queued' ? 'Waiting' : 'In progress') : 'Ended';
  return {
    id: j.id, title: jobTitle(j), headline, word, stages, result, live,
    canCancel: canCancelJob(j), canRetry: canRetryJob(j), needsYou: h === 'waiting_for_approval'
  };
}
