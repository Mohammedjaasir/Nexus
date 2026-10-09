/**
 * Restart recovery (B2a Task 10: the plan's R.2, adapted; constraints 9, 10 and 13).
 *
 * SQLite is the only authority. What the runner reports at reconcile (a container's state, its exit from `docker
 * inspect`, the staged `/out`, the labelled Docker resources) only INFORMS a decision; none of it is stored as state.
 * No recovery decision ever completes a job or makes a version a candidate: a job completes only through ingest (an
 * exit the runner reports with its outputs, committed with the attempt's success), and a version becomes a candidate
 * only through the finalize rule over recorded validator results.
 *
 * Every decision is ONE small IMMEDIATE transaction. It moves the attempt and the job through the execution core's own
 * helpers (so each move keeps its own `job.transition` / `attempt.transition` rows), always ends a live attempt BEFORE
 * its job moves (the v9 backstop trigger), never moves the attempt count back, and writes exactly ONE `exec.recover`
 * activity row and exactly ONE `job_events` row of type `recovery`. A decision that throws rolls back alone, is logged
 * and counted; recovery never throws past its authorization check, so platform startup always reaches `ready`.
 *
 * Phase A (`recoverPhaseA`): platform startup, database only, no runner. Every `leased`, `running` and
 * `awaiting_approval` job:
 *   - no live attempt (an agent run, a B0b job): B1's rule (JobService.recoverJobTx): leased -> queued, else interrupted;
 *   - waiting for approval: a pending, unexpired approval (or one already consumed by this attempt, waiting for the
 *     scheduler) keeps waiting and its attempt is re-owned by this boot; an expired one expires now and the job fails
 *     `denied` (attempt failed); anything else interrupts the job;
 *   - an engine attempt (snapshot, assemble, diagnose; the work lived in the dead runner): abandoned; a leased job goes
 *     back to queued, a running one to retry_scheduled when its recipe is idempotent with attempts left, else interrupted;
 *   - a check main executes (a validate job without a recipe): abandoned; leased -> queued; running -> interrupted and the
 *     same check queued again as a new job (the v7 state table has no running -> queued); the version stays a draft;
 *   - a container attempt whose container was never recorded (never provisioned): abandoned; a leased tool job goes
 *     back to queued (nothing ran; the count is kept, so the next lease is n + 1), a dev deployment or a running job to
 *     retry_scheduled or interrupted;
 *   - an attempt with a recorded container: left for phase B (`pending`).
 *   Then pending approvals past `expires_at` that no waiting job holds (image preparation) expire, and image builds left
 *   `running` are `interrupted` (RC17: a leftover row would block `requestImage` until its deadline).
 *   Hold mode: on a v9 database whose execution is off (v9 not enabled, held, or its shape failed), only jobs WITHOUT a
 *   live attempt are recovered, by B1's rule and its rows alone (no v9 table is written); jobs with a live attempt are
 *   left exactly as they are (`pending`) for the next start with execution on. B1's whole-table routine is never used
 *   on a v9 file: it would end jobs whose attempts are live, which the v9 backstop refuses.
 *
 * Phase B (`recoverPhaseB`): at every runner `ready`, with the runner's `reconcile.result` for `reconcileList()`.
 * Every live attempt with a recorded container, by the container's state (an attempt the runner did not report, or a
 * different container id, is `missing`; Docker not running makes every one `missing`, reason
 * `docker_unavailable_at_recovery`):
 *   - running: adopted (lease_owner := this boot, one fresh LEASE_MS), `attempt.adopt` sent; heartbeats, events and the
 *     exit are then accepted from this boot's runner and the job finishes normally; a dev deployment keeps its status
 *     and its probes resume (one that had already been stopped is told `attempt.cancel`);
 *   - exited: the exit is known from inspect. When the staged outputs show the attempt cannot pass (OOM, a non-zero
 *     exit of a non-test recipe, a missing contract output, all exactly as `exitFailure`), it fails now and its container
 *     is released. Otherwise it is adopted for finalization (phase `collecting`) and `attempt.adopt` is sent: the runner
 *     re-hashes `/out` and reports `attempt.exited` again, with its parser results, and the exit is ingested exactly as a
 *     live exit (idempotent by (job, output path); never completed without ingest);
 *   - created (never started) or missing: abandoned; a tool job goes to retry_scheduled when idempotent with attempts
 *     left, else interrupted; a dev deployment's job is interrupted and its deployment stopped (`recovery`), except one
 *     whose deployment was already stopped before the restart (its job waited for the exit): that job fails
 *     `exit_not_reported`. A created container is released (the runner removes it).
 *   Approval waits still owned by another boot are re-owned (phase A ran with another boot id).
 *   Then `orphanDecisions`: the labelled resources to stop and remove.
 *
 * Leases and stall history (carried decision 8): the old process's in-memory stall record is gone at a restart, so
 * every attempt recovery adopts or re-owns gets exactly ONE fresh LEASE_MS from the recovery's `now`, and the wall
 * clock of an adopted attempt counts the downtime (only approval waits are excluded). An adopted attempt that is not
 * heard from (no heartbeat, no exit) within that lease fails `runner_lost` in the scheduler's sweep (retried only when
 * idempotent); one adopted for finalization is exempt from its wall clock (it already exited) but not from its lease.
 *
 * Orphans (`orphanDecisions`, pure): only resources carrying a `nexus.*` label are ever listed; an unlabelled resource
 * is never touched, whatever its name. A labelled resource is kept when its `nexus.attempt` is a live attempt owned by
 * this boot (adopted or started here) or when it is a dependency cache volume (`nexus-deps-*`, shared across attempts);
 * every other one is listed for stop and removal (`no_live_attempt`, or `not_adopted` for a live attempt of another boot).
 *
 * Blob store hygiene (`recoverBlobStore`, async, under the blob store's EXCLUSIVE lock, so no ingest and no GC runs
 * meanwhile): `objects/tmp` files older than 24 h are removed; unindexed `objects/<2>/<62>` files older than 24 h are
 * removed only while no attempt is live (GC's own rule: a landing object is never raced). A blob.gc run whose last row
 * is `started` (its process stopped before it recorded the file delete) is finished by that sweep and closed by its
 * row. A file that cannot be deleted (a hard link, a link, a refused path) is reported: a `blob.gc` row `failed` with
 * `fileDeleteFailed` and `hardLinked`, and a log line. Never silently.
 */
import type Database from 'better-sqlite3';
import type { JobState, Principal, ScopeRef } from '../../../shared/nexus/platform';
import type { ExitInfo, ParsedOutput, StagedOutput } from '../../../shared/nexus/execution';
import { parseRunnerMessage, type LabelledResource, type MainToRunner, type ReconciledAttempt } from '../../../shared/nexus/runnerProtocol';
import { getRecipe, type RecipeDef } from '../../../shared/nexus/recipes';
import { getKind } from '../../../shared/nexus/kinds';
import type { AuthService } from '../auth/authService';
import { appendActivityRow } from '../activity/writer';
import type { BlobIndex } from '../blobs/blobIndex';
import { immediateTx } from '../db/tx';
import { PlatformError } from '../errors';
import { canRetry } from '../jobs/jobRules';
import { redactedErrorJson, type JobRow, type JobService } from '../jobs/jobService';
import { adoptAttemptTx, attemptRow, liveAttemptOf, transitionAttemptTx, type AttemptRow } from './attempts';
import { appendJobEventTx } from './events';
import { backoffMs } from './scheduler';

/** The activity action of every recovery decision. */
export const RECOVER_ACTION = 'exec.recover';
/** Unindexed object files and `objects/tmp` files are swept only once they are older than this. */
export const STALE_OBJECT_MS = 24 * 60 * 60 * 1000;
/** The most object files one hygiene pass looks at. */
export const MAX_SWEEP_OBJECTS = 100_000;
const CANCEL_GRACE_MS = 10_000;
const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const PLATFORM: ScopeRef = { type: 'platform' };
const LIVE_JOB_STATES: readonly JobState[] = ['leased', 'running', 'awaiting_approval'];

/** The runner's reconcile answer (the `reconcile.result` message without its op). */
export interface ReconcileResult {
  attempts: ReconciledAttempt[];
  labelled: LabelledResource[];
  docker: 'running' | 'stopped' | 'missing';
}

export type RecoveryDecision =
  | 'requeue' | 'retry' | 'interrupt' | 'reown' | 'expire' | 'adopt' | 'finalize' | 'fail' | 'exit_lost' | 'image_interrupted' | 'orphans';

export interface PhaseAReport {
  /** Execution is off on this v9 database: only jobs without a live attempt were recovered (B1's rule). */
  held: boolean;
  /** Jobs that will run again (queued, or retry_scheduled). */
  requeued: number;
  /** Jobs interrupted, plus image builds interrupted. */
  interrupted: number;
  /** Approvals expired (a waiting job fails `denied`). */
  expired: number;
  /** Live attempts left for phase B, and approval waits that keep waiting. */
  pending: number;
  /** The jobs alone, for the `platform ready` line. */
  jobs: { interrupted: number; requeued: number };
  decisions: number;
  errors: number;
}

export interface OrphanRemoval { kind: LabelledResource['kind']; id: string; reason: 'no_live_attempt' | 'not_adopted' }

export interface PhaseBReport {
  adopted: number;
  /** Exited attempts finalized: adopted for their re-reported exit, or failed from inspect and the staged outputs. */
  finalized: number;
  requeued: number;
  interrupted: number;
  reowned: number;
  decisions: number;
  errors: number;
  /** Labelled resources to stop and remove (the runner applies the list). */
  remove: OrphanRemoval[];
}

export interface BlobSweepReport {
  ran: boolean;
  /** Why it did not run: `not_available` or `busy` (an ingest or a GC holds the store). */
  reason: string | null;
  tmpRemoved: number;
  tmpFailed: number;
  objectsRemoved: number;
  objectsFailed: number;
  hardLinked: number;
  /** Unindexed objects were not swept because an attempt is live. */
  objectsDeferred: boolean;
  /** A blob.gc run left `started` was finished and closed. */
  finishedGc: boolean;
}

/** The data home's object files (DataHome implements it; src/main/nexusExec/dataHome.ts). */
export interface BlobStoreFiles {
  listObjectFiles(limit: number): Promise<{ objects: { sha256: string; mtimeMs: number; nlink: number }[]; truncated: boolean }>;
  sweepObjectsTmp(cutoffMs: number): Promise<{ removed: number; failed: number }>;
  deleteObjects(shas: readonly string[]): Promise<{ failed: readonly string[] }>;
}

/** What recovery needs from the execution core (ExecutionService builds it over its own helpers). */
export interface RecoveryHost {
  readonly db: Database.Database;
  readonly auth: AuthService;
  readonly jobs: JobService;
  readonly available: boolean;
  readonly log: (line: string) => void;
  readonly blobs: BlobIndex | null;
  readonly files: BlobStoreFiles | null;
  /** The validation framework's replacement of an interrupted main check (null without validation). */
  readonly requeueCheckTx: ((system: Principal, jobId: string) => string[]) | null;
  moveJobTx(id: string, to: JobState, now: number, d?: { outcome?: string; error?: { code: string; message: string } }, expect?: JobState): void;
  failJobTx(id: string, outcome: string, error: { code: string; message: string }, now: number): void;
  setPhaseTx(id: string, phase: string | null, now: number): void;
  endAwaitingTx(jobId: string, error: { code: string; message: string }, now: number): void;
  send(msg: MainToRunner): boolean;
  /** The log path `attempt.adopt` carries (under the data home). */
  logPathOf(a: AttemptRow): string;
  /** An attempt adopted for finalization: it already exited, so its wall clock no longer runs (its lease still does). */
  awaitExit(attemptId: string): void;
}

/** Why a decision was taken, in words (the attempt's and the job's error message). */
const REASON_TEXT: Record<string, string> = {
  no_live_attempt: 'the app restarted; nothing was running for this job',
  never_started: 'the app restarted before the attempt started',
  engine_lost: 'the app restarted while the work ran in the runner',
  check_restarted: 'the app restarted while the check ran',
  no_recipe: 'the app restarted; the job has nothing to run again',
  approval_missing: 'the app restarted; the job has no approval to wait for',
  approval_expired: 'the approval was not answered in time',
  approval_denied: 'the approval was denied',
  container_created: 'the app restarted before the container started',
  container_missing: 'the container was gone after the app restarted',
  container_running: 'the container was still running after the app restarted',
  container_exited: 'the container exited while the app was closed',
  docker_unavailable_at_recovery: 'Docker was not running when the app restarted',
  restarted: 'the app restarted while the image was being built'
};
const reasonError = (reason: string): { code: string; message: string } => ({ code: reason, message: REASON_TEXT[reason] ?? 'the app restarted' });

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const codeOf = (e: unknown): string => (e instanceof PlatformError ? e.code : (e as Error)?.name ?? 'error');

/** A contract path a recipe's output must hold (`dir/**` any file below, `dir/*.ext` one level). */
export function contractMet(required: readonly string[], outputs: readonly StagedOutput[], parsed: readonly ParsedOutput[], engine: boolean): boolean {
  if (engine) {
    const facts = parsed.map((p) => p.normalized).find((n) => isObj(n));
    return !!facts && required.every((k) => Object.prototype.hasOwnProperty.call(facts, k));
  }
  const paths = outputs.map((o) => o.relPath);
  return required.every((req) => {
    if (req.endsWith('/**')) { const dir = req.slice(0, -2); return paths.some((p) => p.startsWith(dir) && p.length > dir.length); }
    const star = req.indexOf('*');
    if (star >= 0) {
      const pre = req.slice(0, star); const post = req.slice(star + 1);
      return paths.some((p) => p.startsWith(pre) && p.endsWith(post) && !p.slice(pre.length, p.length - post.length).includes('/'));
    }
    return paths.includes(req);
  });
}

/**
 * Why an exit cannot be ingested, or null (the execution core's rule for every exit, live or recovered): outputs the
 * runner refused, an OOM kill, a non-zero exit of a recipe without a test report, or a missing contract output (a tree
 * output is judged by its validators instead).
 */
export function exitFailure(recipe: RecipeDef, exit: { code: number | null; oomKilled: boolean }, outputs: readonly StagedOutput[],
  parsed: readonly ParsedOutput[], outputError?: string | null): { outcome: string; error: { code: string; message: string } } | null {
  const tests = recipe.parsers.includes('junit');
  const treeOutput = recipe.produces.some((k) => getKind(k)?.storage.includes('tree'));
  if (outputError) return { outcome: 'invalid_output', error: { code: outputError, message: `the outputs were refused: ${outputError}` } };
  if (exit.oomKilled) return { outcome: 'oom', error: { code: 'oom', message: 'the container ran out of memory' } };
  if (!tests && exit.code !== 0) return { outcome: 'nonzero_exit', error: { code: 'nonzero_exit', message: `exit code ${exit.code}` } };
  if (!treeOutput && !contractMet(recipe.outputContract.required, outputs, parsed, recipe.executor === 'engine')) {
    return { outcome: 'invalid_output', error: { code: 'outputs_missing', message: `required outputs missing: ${recipe.outputContract.required.join(', ')}` } };
  }
  return null;
}

/**
 * The labelled resources to stop and remove (see the module header). Pure. `liveAttempts` maps every live attempt id of
 * this database to its lease owner, AFTER phase B's decisions.
 */
export function orphanDecisions(reconcile: { labelled: readonly LabelledResource[] },
  ctx: { liveAttempts: ReadonlyMap<string, string>; bootId: string }): OrphanRemoval[] {
  const out: OrphanRemoval[] = [];
  const seen = new Set<string>();
  const kinds: readonly string[] = ['container', 'volume', 'network'];
  for (const r of (Array.isArray(reconcile?.labelled) ? reconcile.labelled : []) as LabelledResource[]) {
    if (!isObj(r) || !isObj(r.labels) || typeof r.id !== 'string' || !kinds.includes(r.kind)) continue;
    const labels = r.labels as Record<string, unknown>;
    // Only Nexus's own resources: an unlabelled resource is never listed, whatever it is called.
    if (!Object.keys(labels).some((k) => k.startsWith('nexus.'))) continue;
    // A dependency cache is shared by later attempts (written once by an approved install): never an orphan here.
    if (r.kind === 'volume' && (r.id.startsWith('nexus-deps-') || labels['nexus.kind'] === 'deps')) continue;
    const attempt = typeof labels['nexus.attempt'] === 'string' ? labels['nexus.attempt'] : null;
    const owner = attempt !== null ? ctx.liveAttempts.get(attempt) : undefined;
    if (owner !== undefined && owner === ctx.bootId) continue;
    const key = `${r.kind}\u0000${r.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ kind: r.kind, id: r.id, reason: owner === undefined ? 'no_live_attempt' : 'not_adopted' });
  }
  return out;
}

// ---------- internals ----------

interface Counters {
  requeued: number; interrupted: number; expired: number; pending: number; reowned: number; adopted: number; finalized: number;
  jobsRequeued: number; jobsInterrupted: number; decisions: number; errors: number;
}
type Count = 'requeued' | 'interrupted' | 'expired' | 'pending' | 'adopted' | 'finalized' | 'reowned' | 'images';
interface Outcome { decision: RecoveryDecision | null; count: Count | null; after?: () => void }

const counters = (): Counters => ({ requeued: 0, interrupted: 0, expired: 0, pending: 0, reowned: 0, adopted: 0, finalized: 0,
  jobsRequeued: 0, jobsInterrupted: 0, decisions: 0, errors: 0 });

function tally(c: Counters, o: Outcome): void {
  if (o.decision !== null) c.decisions++;
  switch (o.count) {
    case 'requeued': c.requeued++; c.jobsRequeued++; break;
    case 'interrupted': c.interrupted++; c.jobsInterrupted++; break;
    case 'images': c.interrupted++; break;
    case 'expired': c.expired++; break;
    case 'pending': c.pending++; break;
    case 'reowned': c.reowned++; c.pending++; break;
    case 'adopted': c.adopted++; break;
    case 'finalized': c.finalized++; break;
    default: break;
  }
}

/** One decision: its own IMMEDIATE transaction; its sends after commit; a throw rolls back that decision only. */
function decide(host: RecoveryHost, c: Counters, what: string, fn: () => Outcome | null): void {
  let o: Outcome | null;
  try {
    o = immediateTx(host.db, fn);
  } catch (e) {
    c.errors++;
    host.log(`[nexus] execution recovery: a decision about ${what} was not applied (${codeOf(e)}); it is left as it was`);
    return;
  }
  if (!o) return;
  tally(c, o);
  if (o.after) { try { o.after(); } catch { /* a send that fails is the runner's to retry (lease expiry) */ } }
}

function requireSystem(host: RecoveryHost, system: Principal, op: string): void {
  // Authorized and audited like B1's recovery: a user, an agent or a forged principal is denied.
  host.auth.require(system, 'job.transition', PLATFORM, { entityType: 'job', details: { op } });
  if (system?.kind !== 'system') throw new PlatformError('denied', 'restart recovery is performed by the system', { reason: 'system_only' });
}

function checkBoot(bootId: string): void {
  if (typeof bootId !== 'string' || !ULID_RE.test(bootId)) throw new PlatformError('invalid', 'bootId must be a ULID');
}

const jobRow = (db: Database.Database, id: string): JobRow | null =>
  (db.prepare('SELECT * FROM jobs WHERE id = ?').get(id) as JobRow | undefined) ?? null;

interface DecisionRecord {
  decision: RecoveryDecision; reason: string; summary: string;
  job?: JobRow | null; attemptN?: number | null;
  /** Without a job: the entity the decision is about (an approval or an image build). */
  entity?: { type: string; id: string; onBehalfOf: string | null; projectId: string | null } | null;
  approvalId?: string | null; imageBuildId?: string | null;
  data?: Record<string, unknown>;
  /** False when the decision's `recovery` event was already written (adoptAttemptTx writes it). */
  event?: boolean;
}

/** The decision's one `exec.recover` activity row and (unless written already) its one `recovery` event. */
function recordTx(host: RecoveryHost, system: Principal, d: DecisionRecord, now: number): void {
  const j = d.job ? jobRow(host.db, d.job.id) : null;
  const projectId = j ? j.project_id : d.entity?.projectId ?? null;
  const details = { decision: d.decision, reason: d.reason, ...(j ? { to: j.state } : {}), ...(d.data ?? {}) };
  appendActivityRow(host.db, { actorKind: system.kind, actorId: system.id, onBehalfOf: j ? j.on_behalf_of : d.entity?.onBehalfOf ?? null,
    sessionId: j?.session_id ?? null, jobId: j?.id ?? null, attemptN: d.attemptN ?? null, projectId, workspaceId: j?.workspace_id ?? null,
    entityType: j ? 'job' : d.entity?.type ?? 'execution', entityId: j ? j.id : d.entity?.id ?? null, action: RECOVER_ACTION,
    status: 'succeeded', details }, now);
  if (d.event === false) return;
  appendJobEventTx(host.db, { type: 'recovery', summary: d.summary, projectId, jobId: j?.id ?? null, attemptN: j ? d.attemptN ?? null : null,
    approvalId: d.approvalId ?? null, imageBuildId: d.imageBuildId ?? null, data: { decision: d.decision, reason: d.reason, ...(d.data ?? {}) } }, now);
}

function abandonTx(host: RecoveryHost, j: JobRow, a: AttemptRow, reason: string, now: number): void {
  transitionAttemptTx(host.db, a, 'abandoned', now, j.project_id, { outcome: reason, error: reasonError(reason) });
}

function interruptTx(host: RecoveryHost, system: Principal, j: JobRow, a: AttemptRow, reason: string, now: number, data?: Record<string, unknown>): Outcome {
  abandonTx(host, j, a, reason, now);
  host.moveJobTx(j.id, 'interrupted', now, { outcome: 'interrupted', error: reasonError(reason) });
  host.setPhaseTx(j.id, null, now);
  recordTx(host, system, { decision: 'interrupt', reason, job: j, attemptN: a.n, summary: `job interrupted: ${REASON_TEXT[reason] ?? reason}`, data }, now);
  return { decision: 'interrupt', count: 'interrupted' };
}

/** A leased job whose attempt never ran: the attempt is abandoned and the job waits again (or is interrupted: no resurrection). */
function requeueTx(host: RecoveryHost, system: Principal, j: JobRow, a: AttemptRow, reason: string, now: number): Outcome {
  if (j.state !== 'leased' || !host.jobs.runnableAgain(j)) return interruptTx(host, system, j, a, reason, now);
  abandonTx(host, j, a, reason, now);
  host.moveJobTx(j.id, 'queued', now, undefined, 'leased');
  host.setPhaseTx(j.id, null, now);
  recordTx(host, system, { decision: 'requeue', reason, job: j, attemptN: a.n, summary: `job queued again: ${REASON_TEXT[reason] ?? reason}` }, now);
  return { decision: 'requeue', count: 'requeued' };
}

/** A job whose attempt is lost: retried when idempotent with attempts left and runnable again, else interrupted. */
function retryOrInterruptTx(host: RecoveryHost, system: Principal, j: JobRow, a: AttemptRow, reason: string, now: number,
  data?: Record<string, unknown>): Outcome {
  const retry = host.jobs.toJob(j).retry;
  if (!canRetry({ kind: j.kind, attempts: j.attempts, retry }) || !host.jobs.runnableAgain(j)) return interruptTx(host, system, j, a, reason, now, data);
  abandonTx(host, j, a, reason, now);
  // The v7 state table reaches retry_scheduled through failed (as every infrastructure retry does).
  host.moveJobTx(j.id, 'failed', now, { outcome: 'interrupted', error: reasonError(reason) });
  host.moveJobTx(j.id, 'retry_scheduled', now);
  host.db.prepare('UPDATE jobs SET next_attempt_at = ?, phase = NULL WHERE id = ?').run(now + backoffMs(retry.backoffMs, j.attempts), j.id);
  recordTx(host, system, { decision: 'retry', reason, job: j, attemptN: a.n, summary: `job will be tried again: ${REASON_TEXT[reason] ?? reason}`, data }, now);
  return { decision: 'retry', count: 'requeued' };
}

/** Re-own a live attempt for this boot (no write when it is already this boot's). */
function reownTx(host: RecoveryHost, system: Principal, bootId: string, j: JobRow, a: AttemptRow, reason: string, now: number): Outcome {
  if (a.lease_owner === bootId) return { decision: null, count: 'pending' };
  adoptAttemptTx(host.db, a, bootId, now, j.project_id, { summary: `attempt ${a.n} re-owned: the job still waits for approval`,
    data: { decision: 'reown', reason } });
  recordTx(host, system, { decision: 'reown', reason, job: j, attemptN: a.n, summary: '', event: false }, now);
  return { decision: 'reown', count: 'reowned' };
}

interface ApprovalLite { id: string; project_id: string | null; job_id: string | null; status: string; expires_at: number; on_behalf_of: string;
  consumed_by_job_id: string | null; consumed_by_attempt_n: number | null }

function approvalWaitTx(host: RecoveryHost, system: Principal, bootId: string, j: JobRow, a: AttemptRow, now: number): Outcome {
  const ap = host.db.prepare(`SELECT id, project_id, job_id, status, expires_at, on_behalf_of, consumed_by_job_id, consumed_by_attempt_n FROM approvals
    WHERE job_id = ? ORDER BY requested_at DESC, rowid DESC LIMIT 1`).get(j.id) as ApprovalLite | undefined;
  if (ap && ap.status === 'pending' && ap.expires_at > now) return reownTx(host, system, bootId, j, a, 'approval_pending', now);
  // Consent given, start waiting for the scheduler's caps (it starts it, or fails it approval_stale after 15 minutes).
  if (ap && ap.status === 'approved' && ap.consumed_by_job_id === j.id && ap.consumed_by_attempt_n === a.n) {
    return reownTx(host, system, bootId, j, a, 'approval_consumed', now);
  }
  if (ap && (ap.status === 'pending' || ap.status === 'expired' || ap.status === 'denied')) {
    const reason = ap.status === 'denied' ? 'approval_denied' : 'approval_expired';
    if (ap.status === 'pending') {
      host.db.prepare("UPDATE approvals SET status = 'expired', status_changed_at = ? WHERE id = ? AND status = 'pending'").run(now, ap.id);
    }
    // The waiting job fails `denied`, its starting attempt first (nothing was sent to the runner; nothing is retried).
    host.endAwaitingTx(j.id, reasonError(reason), now);
    recordTx(host, system, { decision: 'expire', reason, job: j, attemptN: a.n, approvalId: ap.id,
      summary: reason === 'approval_denied' ? 'the job ends: its approval was denied' : 'approval expired while the app was closed; the job did not run',
      data: { approvalId: ap.id } }, now);
    return { decision: 'expire', count: 'expired' };
  }
  return interruptTx(host, system, j, a, 'approval_missing', now);
}

/** A check main executes (a validate job without a recipe). */
function mainCheckTx(host: RecoveryHost, system: Principal, j: JobRow, a: AttemptRow, now: number): Outcome {
  if (j.state === 'leased') return requeueTx(host, system, j, a, 'check_restarted', now);
  abandonTx(host, j, a, 'check_restarted', now);
  host.moveJobTx(j.id, 'interrupted', now, { outcome: 'interrupted', error: reasonError('check_restarted') });
  host.setPhaseTx(j.id, null, now);
  const ids = host.requeueCheckTx ? host.requeueCheckTx(system, j.id) : [];
  const requeued = ids.length > 0;
  recordTx(host, system, { decision: requeued ? 'requeue' : 'interrupt', reason: 'check_restarted', job: j, attemptN: a.n,
    summary: requeued ? 'check queued again: the app restarted while it ran' : 'check interrupted: the app restarted while it ran',
    data: { replacedBy: ids[0] ?? null } }, now);
  return requeued ? { decision: 'requeue', count: 'requeued' } : { decision: 'interrupt', count: 'interrupted' };
}

function phaseAJobTx(host: RecoveryHost, system: Principal, bootId: string, jobId: string, now: number): Outcome | null {
  const j = jobRow(host.db, jobId);
  if (!j || !LIVE_JOB_STATES.includes(j.state)) return null;
  const a = liveAttemptOf(host.db, j.id);
  if (!a) {
    const r = host.jobs.recoverJobTx(system, j.id, now);
    if (!r) return null;
    const decision = r === 'requeued' ? 'requeue' : 'interrupt';
    recordTx(host, system, { decision, reason: 'no_live_attempt', job: j, summary: r === 'requeued' ? 'job queued again after a restart' : 'job interrupted by a restart' }, now);
    return { decision, count: r };
  }
  if (j.state === 'awaiting_approval') return approvalWaitTx(host, system, bootId, j, a, now);
  const recipe = j.recipe_id ? getRecipe(j.recipe_id) : null;
  if (!recipe) return j.kind === 'validate' ? mainCheckTx(host, system, j, a, now) : interruptTx(host, system, j, a, 'no_recipe', now);
  if (recipe.executor === 'engine') {
    return j.state === 'leased' ? requeueTx(host, system, j, a, 'engine_lost', now) : retryOrInterruptTx(host, system, j, a, 'engine_lost', now);
  }
  // A container is recorded once its preflight passed: what happened to it is phase B's to learn from the runner.
  if (a.container_id !== null) return { decision: null, count: 'pending' };
  if (j.state === 'leased' && recipe.executor !== 'service') return requeueTx(host, system, j, a, 'never_started', now);
  // A dev deployment is never requeued (its one deployment row would wait as `starting`); a running job cannot go back to queued.
  return retryOrInterruptTx(host, system, j, a, 'never_started', now);
}

interface ApprovalRowLite extends ApprovalLite { reason: string }

function expireApprovalTx(host: RecoveryHost, system: Principal, approvalId: string, now: number): Outcome | null {
  const ap = host.db.prepare(`SELECT id, project_id, job_id, status, expires_at, on_behalf_of, consumed_by_job_id, consumed_by_attempt_n, reason
    FROM approvals WHERE id = ?`).get(approvalId) as ApprovalRowLite | undefined;
  if (!ap || ap.status !== 'pending' || ap.expires_at > now) return null;
  host.db.prepare("UPDATE approvals SET status = 'expired', status_changed_at = ? WHERE id = ? AND status = 'pending'").run(now, ap.id);
  const j = ap.job_id ? jobRow(host.db, ap.job_id) : null;
  if (j && j.state === 'awaiting_approval') host.endAwaitingTx(j.id, reasonError('approval_expired'), now);
  recordTx(host, system, { decision: 'expire', reason: 'approval_expired', job: j, attemptN: null, approvalId: ap.id,
    entity: { type: 'approval', id: ap.id, onBehalfOf: ap.on_behalf_of, projectId: ap.project_id },
    summary: `approval expired while the app was closed (${ap.reason})`, data: { approvalId: ap.id } }, now);
  return { decision: 'expire', count: 'expired' };
}

function interruptBuildTx(host: RecoveryHost, system: Principal, buildId: string, now: number): Outcome | null {
  const b = host.db.prepare('SELECT id, status, approval_id, requested_by, profile_id FROM image_builds WHERE id = ?').get(buildId) as
    { id: string; status: string; approval_id: string; requested_by: string; profile_id: string } | undefined;
  if (!b || b.status !== 'running') return null;
  host.db.prepare("UPDATE image_builds SET status = 'interrupted', error_json = ?, finished_at = ? WHERE id = ? AND status = 'running'")
    .run(redactedErrorJson(reasonError('restarted')), now, b.id);
  recordTx(host, system, { decision: 'image_interrupted', reason: 'restarted', entity: { type: 'image_build', id: b.id, onBehalfOf: b.requested_by, projectId: null },
    imageBuildId: b.id, approvalId: b.approval_id, summary: `image build of ${b.profile_id} interrupted by a restart`,
    data: { buildId: b.id, profileId: b.profile_id, status: 'interrupted' } }, now);
  return { decision: 'image_interrupted', count: 'images' };
}

// ---------- phase A ----------

/** Phase A (see the module header). System only; never throws past its authorization check. */
export function recoverPhaseA(host: RecoveryHost, system: Principal, bootId: string, now: number): PhaseAReport {
  requireSystem(host, system, 'recover_phase_a');
  checkBoot(bootId);
  const c = counters();
  const db = host.db;
  const ids = (db.prepare(`SELECT id FROM jobs WHERE state IN ('leased','running','awaiting_approval') ORDER BY created_at, rowid`).all() as
    { id: string }[]).map((r) => r.id);
  if (!host.available) {
    // Hold mode: no v9 table is written; a job with a live attempt (or any job, when the attempts cannot be read) stays.
    let live: Set<string> | null = null;
    try {
      live = new Set((db.prepare("SELECT DISTINCT job_id FROM job_attempts WHERE state IN ('starting','running')").all() as { job_id: string }[])
        .map((r) => r.job_id));
    } catch { live = null; }
    for (const id of ids) {
      if (live === null || live.has(id)) { c.pending++; continue; }
      decide(host, c, 'a job', () => {
        const r = host.jobs.recoverJobTx(system, id, now);
        return r ? { decision: r === 'requeued' ? 'requeue' : 'interrupt', count: r } : null;
      });
    }
    return report(c, true);
  }
  for (const id of ids) decide(host, c, 'a job', () => phaseAJobTx(host, system, bootId, id, now));
  // Pending approvals past their time that no waiting job held (image preparation; any other leftover).
  const due = db.prepare("SELECT id FROM approvals WHERE status = 'pending' AND expires_at <= ? ORDER BY expires_at, id").all(now) as { id: string }[];
  for (const { id } of due) decide(host, c, 'an approval', () => expireApprovalTx(host, system, id, now));
  // A `docker build` client dies with the runner: a build left running can never report.
  const builds = db.prepare("SELECT id FROM image_builds WHERE status = 'running' ORDER BY started_at, id").all() as { id: string }[];
  for (const { id } of builds) decide(host, c, 'an image build', () => interruptBuildTx(host, system, id, now));
  return report(c, false);
}

function report(c: Counters, held: boolean): PhaseAReport {
  return { held, requeued: c.requeued, interrupted: c.interrupted, expired: c.expired, pending: c.pending,
    jobs: { interrupted: c.jobsInterrupted, requeued: c.jobsRequeued }, decisions: c.decisions, errors: c.errors };
}

// ---------- phase B ----------

/** The `reconcile.list` main sends at runner `ready`: every live attempt whose container is recorded. */
export function reconcileList(db: Database.Database): { attemptId: string; containerId: string; kind: 'tool' | 'service' }[] {
  const rows = db.prepare(`SELECT a.id, a.container_id, j.recipe_id FROM job_attempts a JOIN jobs j ON j.id = a.job_id
    WHERE a.state IN ('starting','running') AND a.container_id IS NOT NULL ORDER BY a.created_at, a.id`).all() as
    { id: string; container_id: string; recipe_id: string | null }[];
  return rows.map((r) => ({ attemptId: r.id, containerId: r.container_id,
    kind: getRecipe(r.recipe_id ?? '')?.executor === 'service' ? 'service' as const : 'tool' as const }));
}

function phaseBContainerTx(host: RecoveryHost, system: Principal, bootId: string, attemptId: string, entry: ReconciledAttempt | undefined,
  dockerDown: boolean, now: number): Outcome | null {
  const db = host.db;
  const a = attemptRow(db, attemptId);
  if (!a || (a.state !== 'starting' && a.state !== 'running') || a.container_id === null) return null;
  const j = jobRow(db, a.job_id)!;
  const recipe = j.recipe_id ? getRecipe(j.recipe_id) : null;
  const service = recipe?.executor === 'service';
  // The runner's word informs the decision only: an unreported attempt, or another container under its label, is missing.
  const sameContainer = !entry?.containerId || entry.containerId === a.container_id;
  const state = dockerDown || !entry || !sameContainer ? 'missing' : entry.container;
  const reason = dockerDown ? 'docker_unavailable_at_recovery' : `container_${state}`;
  const short = a.container_id.slice(0, 12);
  const adoptMsg: MainToRunner = { op: 'attempt.adopt', attemptId: a.id, containerId: a.container_id, logPath: host.logPathOf(a) };
  if (state === 'running') {
    adoptAttemptTx(db, a, bootId, now, j.project_id, { summary: `attempt ${a.n} adopted: its container is still running`,
      data: { decision: 'adopt', reason, container: short } });
    recordTx(host, system, { decision: 'adopt', reason, job: j, attemptN: a.n, summary: '', event: false, data: { container: short } }, now);
    const msgs: MainToRunner[] = [adoptMsg];
    // A dev deployment stopped before the restart (its job waited for the exit): the runner stops what still runs.
    const dep = service ? db.prepare('SELECT status FROM deployments WHERE job_id = ?').get(j.id) as { status: string } | undefined : undefined;
    if (dep && (dep.status === 'stopped' || dep.status === 'failed')) msgs.push({ op: 'attempt.cancel', attemptId: a.id, graceMs: CANCEL_GRACE_MS, reason: 'timeout' });
    return { decision: 'adopt', count: 'adopted', after: () => { for (const m of msgs) host.send(m); } };
  }
  if (state === 'exited') {
    const exit: ExitInfo | undefined = entry?.exit;
    if (!service && recipe && exit && entry?.staged) {
      // Judged now from inspect and the staged list when they already show the attempt cannot pass; never ingested.
      const fail = exitFailure(recipe, exit, entry.staged, [], null);
      if (fail) {
        transitionAttemptTx(db, a, 'failed', now, j.project_id, { exit: { code: exit.code, signal: exit.signal, oomKilled: exit.oomKilled },
          outcome: fail.outcome, error: fail.error });
        host.failJobTx(j.id, fail.outcome, fail.error, now);
        recordTx(host, system, { decision: 'fail', reason, job: j, attemptN: a.n, summary: `exited while the app was closed; ${fail.error.message}`,
          data: { exit: exit.code, oomKilled: exit.oomKilled, staged: entry.staged.length, outcome: fail.outcome } }, now);
        return { decision: 'fail', count: 'finalized', after: () => { host.send({ op: 'attempt.release', attemptId: a.id }); } };
      }
    }
    // Adopted for finalization: the runner re-hashes `/out` and reports the exit again; it is ingested like a live one.
    adoptAttemptTx(db, a, bootId, now, j.project_id, { summary: `attempt ${a.n} exited while the app was closed; collecting its outputs`,
      data: { decision: 'finalize', reason, container: short, exit: exit ? exit.code : null, oomKilled: exit ? exit.oomKilled : null,
        staged: entry?.staged ? entry.staged.length : null } });
    if (!service) host.setPhaseTx(j.id, 'collecting', now);
    recordTx(host, system, { decision: 'finalize', reason, job: j, attemptN: a.n, summary: '', event: false,
      data: { container: short, exit: exit ? exit.code : null } }, now);
    return { decision: 'finalize', count: 'finalized', after: () => { host.awaitExit(a.id); host.send(adoptMsg); } };
  }
  // created (never started) or missing.
  let out: Outcome;
  if (service) {
    const dep = db.prepare('SELECT status FROM deployments WHERE job_id = ?').get(j.id) as { status: string } | undefined;
    // A dev deployment already stopped before the restart (its job waited for the exit): that exit will never come.
    out = dep && (dep.status === 'stopped' || dep.status === 'failed') ? exitLostTx(host, system, j, a, reason, now, short)
      : interruptTx(host, system, j, a, reason, now, { container: short });
  } else {
    out = retryOrInterruptTx(host, system, j, a, reason, now, { container: short });
  }
  if (state === 'created') out.after = () => { host.send({ op: 'attempt.release', attemptId: a.id }); };
  return out;
}

/**
 * A dev deployment stopped before the restart (the user, its lifetime, the app quitting) whose job waited for the exit,
 * and whose containers are gone: the job fails `exit_not_reported`, as the deployment pass ends it when no exit arrives
 * in time. Never completed: the exit that would have completed it was never observed. The deployment keeps its end.
 */
function exitLostTx(host: RecoveryHost, system: Principal, j: JobRow, a: AttemptRow, reason: string, now: number, short: string): Outcome {
  abandonTx(host, j, a, reason, now);
  const error = { code: 'exit_not_reported', message: 'the dev deployment was stopped before the restart and its exit was never reported' };
  host.moveJobTx(j.id, 'failed', now, { outcome: 'exit_not_reported', error });
  host.setPhaseTx(j.id, null, now);
  recordTx(host, system, { decision: 'exit_lost', reason, job: j, attemptN: a.n, summary: 'the stopped dev deployment\'s exit was never reported',
    data: { container: short } }, now);
  return { decision: 'exit_lost', count: 'interrupted' };
}

function phaseBApprovalWaitTx(host: RecoveryHost, system: Principal, bootId: string, attemptId: string, now: number): Outcome | null {
  const a = attemptRow(host.db, attemptId);
  if (!a || (a.state !== 'starting' && a.state !== 'running') || a.lease_owner === bootId) return null;
  const j = jobRow(host.db, a.job_id);
  if (!j || j.state !== 'awaiting_approval') return null;
  const o = reownTx(host, system, bootId, j, a, 'approval_pending', now);
  return o.decision ? o : null;
}

/** Phase B (see the module header). System only; needs execution. Never throws past its checks. */
export function recoverPhaseB(host: RecoveryHost, system: Principal, bootId: string, reconcile: ReconcileResult, now: number): PhaseBReport {
  requireSystem(host, system, 'recover_phase_b');
  checkBoot(bootId);
  if (!host.available) throw new PlatformError('platform_unavailable', 'execution is not available on this database', { reason: 'not_enabled' });
  // The same validation as the runner's own message (exact keys, shapes and bounds): a malformed answer decides nothing.
  const parsed = isObj(reconcile)
    ? parseRunnerMessage({ op: 'reconcile.result', docker: reconcile.docker, attempts: reconcile.attempts, labelled: reconcile.labelled }) : null;
  if (!parsed || parsed.op !== 'reconcile.result') throw new PlatformError('invalid', 'the reconcile result is malformed', { reason: 'bad_reconcile' });
  const c = counters();
  const db = host.db;
  const dockerDown = parsed.docker !== 'running';
  const byId = new Map(parsed.attempts.map((x) => [x.attemptId, x]));
  const live = db.prepare(`SELECT id, container_id FROM job_attempts WHERE state IN ('starting','running') ORDER BY created_at, id`).all() as
    { id: string; container_id: string | null }[];
  for (const a of live) {
    if (a.container_id !== null) decide(host, c, 'an attempt', () => phaseBContainerTx(host, system, bootId, a.id, byId.get(a.id), dockerDown, now));
    else decide(host, c, 'an approval wait', () => phaseBApprovalWaitTx(host, system, bootId, a.id, now));
  }
  const after = new Map((db.prepare("SELECT id, lease_owner FROM job_attempts WHERE state IN ('starting','running')").all() as
    { id: string; lease_owner: string }[]).map((r) => [r.id, r.lease_owner]));
  const remove = orphanDecisions(parsed, { liveAttempts: after, bootId });
  if (remove.length > 0) {
    const n = (k: string): number => remove.filter((r) => r.kind === k).length;
    decide(host, c, 'the leftover resources', () => {
      recordTx(host, system, { decision: 'orphans', reason: 'labelled_without_live_attempt', summary: '', event: false,
        data: { containers: n('container'), volumes: n('volume'), networks: n('network') } }, now);
      return { decision: 'orphans', count: null };
    });
  }
  host.log(`[nexus] execution recovery at runner ready: adopted=${c.adopted} finalized=${c.finalized} requeued=${c.requeued} `
    + `interrupted=${c.interrupted} reowned=${c.reowned} orphans=${remove.length} docker=${parsed.docker}${c.errors ? ` errors=${c.errors}` : ''}`);
  return { adopted: c.adopted, finalized: c.finalized, requeued: c.requeued, interrupted: c.interrupted, reowned: c.reowned,
    decisions: c.decisions, errors: c.errors, remove };
}

// ---------- blob store hygiene ----------

/**
 * Whether the latest `started` blob.gc row has no later closing row: a GC whose process stopped before it recorded its
 * file delete. A hygiene row that deferred the object sweep (`objectsDeferred`) does not close it: it did not finish it.
 */
function unfinishedGc(db: Database.Database): boolean {
  const s = db.prepare("SELECT seq FROM activity WHERE action = 'blob.gc' AND status = 'started' ORDER BY seq DESC LIMIT 1").get() as { seq: number } | undefined;
  if (!s) return false;
  return !db.prepare(`SELECT 1 FROM activity WHERE action = 'blob.gc' AND seq > ? AND status <> 'started'
    AND json_extract(details_json, '$.objectsDeferred') IS NOT 1 LIMIT 1`).get(s.seq);
}

function indexedShas(db: Database.Database, shas: readonly string[]): Set<string> {
  const out = new Set<string>();
  for (let i = 0; i < shas.length; i += 500) {
    const part = shas.slice(i, i + 500);
    for (const r of db.prepare(`SELECT sha256 FROM blobs WHERE sha256 IN (${part.map(() => '?').join(', ')})`).all(...part) as { sha256: string }[]) out.add(r.sha256);
  }
  return out;
}

/** Blob store hygiene (see the module header). System only. Resolves with what it did; never rejects past its checks. */
export async function recoverBlobStore(host: RecoveryHost, system: Principal, now: number): Promise<BlobSweepReport> {
  requireSystem(host, system, 'recover_blob_store');
  const none: BlobSweepReport = { ran: false, reason: null, tmpRemoved: 0, tmpFailed: 0, objectsRemoved: 0, objectsFailed: 0, hardLinked: 0,
    objectsDeferred: false, finishedGc: false };
  const files = host.files; const blobs = host.blobs;
  if (!host.available || !files || !blobs) return { ...none, reason: 'not_available' };
  const release = blobs.lock.tryExclusive();
  if (!release) return { ...none, reason: 'busy' };
  try {
    const db = host.db;
    const cutoff = now - STALE_OBJECT_MS;
    const out: BlobSweepReport = { ...none, ran: true };
    try {
      const tmp = await files.sweepObjectsTmp(cutoff);
      out.tmpRemoved = tmp.removed; out.tmpFailed = tmp.failed;
    } catch { out.tmpFailed++; }
    const open = unfinishedGc(db);
    const liveAttempts = (db.prepare("SELECT COUNT(*) AS n FROM job_attempts WHERE state IN ('starting','running')").get() as { n: number }).n;
    if (liveAttempts > 0) out.objectsDeferred = true;
    else {
      const listed = await files.listObjectFiles(MAX_SWEEP_OBJECTS);
      const old = listed.objects.filter((o) => o.mtimeMs < cutoff);
      const indexed = indexedShas(db, old.map((o) => o.sha256));
      const unindexed = old.filter((o) => !indexed.has(o.sha256));
      out.hardLinked = unindexed.filter((o) => o.nlink > 1).length;
      if (unindexed.length > 0) {
        let failed: readonly string[];
        try { failed = (await files.deleteObjects(unindexed.map((o) => o.sha256))).failed; } catch { failed = unindexed.map((o) => o.sha256); }
        out.objectsFailed = failed.length;
        out.objectsRemoved = unindexed.length - failed.length;
      }
      out.finishedGc = open;
    }
    const problems = out.objectsFailed + out.tmpFailed;
    if (out.tmpRemoved > 0 || out.objectsRemoved > 0 || problems > 0 || out.finishedGc) {
      try {
        immediateTx(db, () => appendActivityRow(db, { actorKind: system.kind, actorId: system.id, entityType: 'blob', action: 'blob.gc',
          status: problems > 0 ? 'failed' : 'succeeded',
          details: { recovered: true, removed: out.objectsRemoved, fileDeleteFailed: problems, hardLinked: out.hardLinked, tmpRemoved: out.tmpRemoved,
            objectsDeferred: out.objectsDeferred, finishedGc: out.finishedGc } }, now));
      } catch (e) {
        host.log(`[nexus] blob store hygiene: its activity row was not recorded (${codeOf(e)})`);
      }
    }
    host.log(`[nexus] blob store hygiene: tmpRemoved=${out.tmpRemoved} objectsRemoved=${out.objectsRemoved} fileDeleteFailed=${problems} `
      + `hardLinked=${out.hardLinked}${out.objectsDeferred ? ' objects=deferred (attempts live)' : ''}${out.finishedGc ? ' unfinishedGc=finished' : ''}`);
    return out;
  } finally {
    release();
  }
}
