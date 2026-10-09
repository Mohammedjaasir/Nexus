/**
 * The execution core in main (B2a): it starts recipe jobs for user actions, leases them to
 * attempts under the scheduler's caps, hands each attempt's plan to the runner through a
 * `RunnerPort`, and records what the runner reports. SQLite is the only authority for job
 * state; the runner holds none (constraint 9).
 *
 * - Availability. Built by the platform always; when execution is not enabled (schema v9 off,
 *   held, failed, or the caller's `execution` option false) every user-facing method refuses
 *   with 'platform_unavailable' (`detail.reason` = the sub-reason, default 'not_enabled'),
 *   `tick` and `onRunnerMessage` do nothing, and no v9 table is read or written.
 * - Authority. `start` and `retry` authorize `job.create` with the STORED participation
 *   (requireActiveParticipation) before any transaction, so a denial is audited once and
 *   nothing else is written. Inputs must be readable by the caller and be candidate or active
 *   versions of a kind the action's slot accepts (`input_not_allowed`). Params follow the
 *   action's closed schema (`bad_params`) and are refused when secret-shaped
 *   (`secret_in_params`). `cancel` authorizes `job.cancel`, reads `job.read`.
 * - Leases. One IMMEDIATE transaction per lease: the job moves `queued -> leased` as a
 *   compare-and-set (`AND state = 'queued'`, one row), which counts the attempt, and attempt n
 *   is inserted (tr_attempts_insert accepts it only then). A throw between the two rolls both
 *   back. Main refuses to lease or start while blob GC holds its exclusive lock.
 * - Running. A container attempt becomes `running` only on an `attempt.provisioned` report
 *   carrying a passing preflight (constraint 7); a failing or missing report fails the attempt
 *   `limits_not_applied`, the job `failed: infra_error`, and the runner is told to release
 *   (remove) the container. An engine attempt becomes `running` on a container-less report.
 * - Ending. A live attempt is always ended BEFORE its job is requeued or ended (the v9
 *   backstop trigger). A job completes only through the ingest port after its current attempt
 *   succeeded; without an ingest port (Task 8) an exit with its outputs present fails
 *   `ingest_unavailable`: unfinished work is never marked completed (constraint 4).
 * - Runner messages are validated by `parseRunnerMessage`, then: the attempt is known, its
 *   lease owner is this boot, `attempt.event` seq is strictly increasing. Anything else is
 *   dropped with one log line and no write. Each handler is one small transaction.
 * - Cancel cascades to children first (ix_jobs_parent), withdraws a pending approval, ends
 *   the live attempt (`cancelled`), flags the job's drafts `cancelled_partial`, then cancels
 *   the job, all in one transaction; `attempt.cancel` is sent after commit. A later exit of a
 *   cancelled attempt is dropped (cancel wins).
 * - Timeout: the wall clock of the current attempt, counted from its lease and excluding time
 *   the job spent in `awaiting_approval`. Retry: an idempotent recipe whose attempt failed for
 *   an infrastructure reason goes `retry_scheduled` (backoff 10 s, 60 s, 300 s), then `queued`.
 * - Heartbeats extend the lease and set `heartbeat_at` only (no activity, no event). The message
 *   handler keeps the latest one per attempt in memory; the next tick (every second) writes them
 *   all in one transaction before it sweeps leases. A 45 s gap writes one `attempt.heartbeat_gap` event.
 * - Every job transition writes one activity row (JobService) and one `job_events` row in the
 *   same transaction. Recovery (Task 10) rebuilds from these rows: live attempts are exactly
 *   the `starting` and `running` ones, each with its lease owner.
 */
import type Database from 'better-sqlite3';
import type { SandboxProfile, SandboxProfileId, StagedOutput, ParsedOutput, ExitInfo, ResourceLimits } from '../../../shared/nexus/execution';
import { SANDBOX_PROFILE_IDS } from '../../../shared/nexus/execution';
import type { Job, JobKind, JobState, Principal, ScopeRef } from '../../../shared/nexus/platform';
import { getUserAction, type UserActionDef } from '../../../shared/nexus/actions';
import type { ParamsSchema } from '../../../shared/nexus/domainSpec';
import { getRecipe, RETRY_BACKOFF_MS, type RecipeDef } from '../../../shared/nexus/recipes';
import { parseRunnerMessage, type CancelReason, type RunnerToMain } from '../../../shared/nexus/runnerProtocol';
import { evaluateGate, leaseFloorBytes, type GateResult } from '../../../shared/nexus/resourceGate';
import type { AuthService } from '../auth/authService';
import { PrincipalResolver } from '../auth/principals';
import { appendActivityRow } from '../activity/writer';
import { containsSecret } from '../activity/redact';
import type { BlobIndex } from '../blobs/blobIndex';
import { newId } from '../db/ids';
import { immediateTx } from '../db/tx';
import { PlatformError } from '../errors';
import { ProjectAccess } from '../project/projectAccess';
import { canRetry, isJobState, TERMINAL_JOB_STATES } from '../jobs/jobRules';
import { JOB_KINDS, requireActiveParticipation, storedWorkspace, validateKey, type JobRow, type JobService } from '../jobs/jobService';
import { attemptRow, HEARTBEAT_GAP_MS, LEASE_MS, heartbeatTx, insertAttemptTx, liveAttemptOf, transitionAttemptTx, type AttemptRow } from './attempts';
import { appendJobEventTx, toJobEvent, type JobEvent, type JobEventRow } from './events';
import { buildPlan, lockfileSha256Of, sandboxRecord, type PlanApproval, type PlanInput } from './planBuilder';
import type { RunnerPort } from './runnerPort';
import { backoffMs, DEFAULT_CAPS, leaseGuard, SOLO_MEMORY_SHARE, usableImage, type LiveUse, type ProbeCache, type SchedulerCaps } from './scheduler';

export interface StartJobRequest {
  projectId: string; workspaceId: string; actionId: string;
  inputs: { versionId: string; slot: string }[]; params: Record<string, unknown>; intentId: string;
}
export interface JobFilter { projectId?: string; workspaceId?: string; states?: JobState[]; jobKind?: JobKind; limit?: number }

export type Headline =
  | 'queued' | 'waiting:runner' | 'waiting:docker' | 'waiting:image' | 'waiting:disk' | 'waiting:slots' | 'waiting:memory'
  | 'waiting:retry' | 'provisioning' | 'running' | 'waiting_for_approval' | 'collecting' | 'validating'
  | 'checks_passed' | 'checks_failed' | 'checks_could_not_run' | 'failed' | 'cancelled' | 'timed_out' | 'interrupted';

export interface ExecJob extends Job {
  recipeId: string | null; actionId: string | null; phase: string | null; nextAttemptAt: number | null; headline: Headline;
}
export interface AttemptView {
  id: string; n: number; state: string; outcome: string | null; exitCode: number | null; signal: string | null; oomKilled: boolean | null;
  network: string | null; preflight: { ok: boolean; problems: string[] } | null; error: { code: string; message: string } | null;
  createdAt: number; startedAt: number | null; finishedAt: number | null;
}
export interface JobDetail extends ExecJob {
  /** Every attempt, oldest first (`attempts` stays the count). */
  attemptHistory: AttemptView[];
  approvals: { id: string; status: string; reason: string; expiresAt: number }[];
  outputs: { versionId: string; status: string; outputPath: string | null }[];
}
export interface HealthSnapshot {
  execution: { available: boolean; reason: string | null };
  runner: { state: string; attached: boolean; faults: number };
  docker: { state: 'unknown' | 'missing' | 'stopped' | 'running'; version?: string; cpus?: number; memoryBytes?: number };
  images: { profile: SandboxProfileId; present: boolean; matches: boolean }[];
  disk: { freeBytes: number | null; leaseFloorBytes: number };
  gate: GateResult | null;
  checkedAt: number | null;
}

/** The approval path for egress recipes (Task 9 provides it); it only inserts the pending approval row. */
export interface EgressApprovalPort {
  requestEgressTx(job: { id: string; projectId: string; onBehalfOf: string }, attempt: { id: string; n: number }, recipe: RecipeDef, now: number): string;
}

export interface IngestContext {
  system: Principal; job: JobRow; attempt: AttemptRow; recipe: RecipeDef;
  exited: { exit: ExitInfo; outputs: StagedOutput[]; parsed: ParsedOutput[]; logBytes: number };
}
/** What ingest decided inside the exit transaction. `ok` completes the job; anything else fails it. */
export type IngestDecision = { ok: true; outcome?: string } | { ok: false; outcome: string; error: { code: string; message: string } };
/** Ingest (Task 8) runs INSIDE the exit transaction and writes versions, blobs and validations there. */
export interface IngestPort { ingestTx(ctx: IngestContext): IngestDecision }

export interface ExecDataHome { root: string; attemptWorkRel(jobId: string, n: number): string; attemptLogPath(jobId: string, n: number): string }

export interface ExecutionDeps {
  auth: AuthService; jobs: JobService; now: () => number; log?: (line: string) => void;
  available: boolean; unavailableReason?: string | null;
  blobs: BlobIndex | null;
  dataHome?: ExecDataHome | null;
  profiles?: readonly SandboxProfile[];
  /** main's acceptance of a stored project folder (index.ts `acceptFsRoot`); null refuses it. */
  acceptFsRoot?: ((root: string) => string | null) | null;
  approvals?: EgressApprovalPort | null;
  ingest?: IngestPort | null;
  caps?: Partial<SchedulerCaps>;
  hooks?: { afterLeaseTransition?: (jobId: string) => void };
  /** The Nexus app version, recorded in every attempt's environment. */
  appVersion?: string | null;
}

interface ExecJobRow extends JobRow {
  capabilities_json: string; limits_json: string; next_attempt_at: number | null; state_json: string | null;
}
interface Capability { action: string; recipe: string; recipeVersion: string; executor: string; network: string; profile: SandboxProfileId | null }

const PLATFORM: ScopeRef = { type: 'platform' };
const LIVE_JOB_STATES: readonly JobState[] = ['queued', 'leased', 'running', 'awaiting_approval', 'retry_scheduled'];
/** Attempt failures an idempotent recipe is retried for (infrastructure, not the work itself). */
const RETRYABLE = new Set(['docker_resources', 'disk_full', 'container_vanished', 'docker_error', 'ingest_error', 'runner_lost']);
const CANCEL_GRACE_MS = 10_000;
export const MAX_START_INPUTS = 64;
export const MAX_EXEC_LIST_LIMIT = 500;
export const DEFAULT_EXEC_LIST_LIMIT = 100;
export const MAX_EVENTS_LIMIT = 500;
const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const REFUSE_TO_FAIL = new Set(['bad_plan', 'network_not_approved', 'unknown_attempt']);
const REFUSAL_WAIT: Record<string, string> = {
  docker_missing: 'waiting:docker', docker_stopped: 'waiting:docker', image_missing: 'waiting:image', image_mismatch: 'waiting:image',
  disk_low: 'waiting:disk', busy: 'waiting:slots'
};

const isStr = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v) && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);
const parseJson = (text: string | null): unknown => { if (text === null) return null; try { return JSON.parse(text) as unknown; } catch { return null; } };
const invalid = (reason: string, message: string): never => { throw new PlatformError('invalid', message, { reason }); };

/** Params against an action's closed schema; also refuses paths, `..` and NUL in any string. */
export function checkParams(schema: ParamsSchema, params: unknown): Record<string, unknown> {
  if (!isPlainObject(params)) return invalid('bad_params', 'params must be an object');
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(params)) {
    if (!Object.prototype.hasOwnProperty.call(schema.properties, k)) invalid('bad_params', `unknown parameter ${k.slice(0, 32)}`);
  }
  for (const r of schema.required) if (!Object.prototype.hasOwnProperty.call(params, r)) invalid('bad_params', `parameter ${r} is required`);
  for (const [k, def] of Object.entries(schema.properties)) {
    if (!Object.prototype.hasOwnProperty.call(params, k)) continue;
    const v = params[k];
    if (def.type === 'string') {
      if (typeof v !== 'string' || v.length > def.maxLength) invalid('bad_params', `parameter ${k} must be a string of at most ${def.maxLength}`);
      const s = v as string;
      if (s.includes('\0') || s.includes('/') || s.includes('\\') || s.includes('..')) invalid('bad_params', `parameter ${k} may not hold a path`);
      if (def.pattern !== undefined && !new RegExp(def.pattern).test(s)) invalid('bad_params', `parameter ${k} has a bad shape`);
      if (def.enum !== undefined && !def.enum.includes(s)) invalid('bad_params', `parameter ${k} is not an allowed value`);
    } else if (def.type === 'integer') {
      if (typeof v !== 'number' || !Number.isInteger(v) || v < def.minimum || v > def.maximum) invalid('bad_params', `parameter ${k} is out of range`);
    } else if (typeof v !== 'boolean') {
      invalid('bad_params', `parameter ${k} must be a boolean`);
    }
    out[k] = v;
  }
  if (containsSecret(params)) throw new PlatformError('invalid', 'params hold a secret-shaped key or value', { reason: 'secret_in_params' });
  return out;
}

/** The headline of a job (see ExecutionService.headline): never a bare "completed". */
export function headlineFrom(f: { state: JobState; phase: string | null; liveAttempt: string | null;
  checks?: { failed: number; error: number; passed: number; pending: number } }): Headline {
  switch (f.state) {
    case 'queued': return f.phase && /^waiting:(runner|docker|image|disk|slots|memory)$/.test(f.phase) ? f.phase as Headline : 'queued';
    case 'retry_scheduled': return 'waiting:retry';
    case 'leased': return 'provisioning';
    case 'awaiting_approval': return 'waiting_for_approval';
    case 'running': return f.phase === 'approval' ? 'waiting_for_approval' : f.liveAttempt === 'running' ? 'running' : 'provisioning';
    case 'completed': case 'partial': {
      const c = f.checks ?? { failed: 0, error: 0, passed: 0, pending: 0 };
      if (c.failed > 0) return 'checks_failed';
      if (c.error > 0) return 'checks_could_not_run';
      if (c.pending > 0) return 'validating';
      return c.passed > 0 ? 'checks_passed' : 'checks_could_not_run';
    }
    default: return f.state as Headline;
  }
}

/** Whether every required contract path is among the staged outputs (`dir/**` any file below, `dir/*.ext` one level). */
export function contractMet(required: readonly string[], outputs: readonly StagedOutput[], parsed: readonly ParsedOutput[], engine: boolean): boolean {
  if (engine) {
    const facts = parsed.map((p) => p.normalized).find((n) => isPlainObject(n));
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

export class ExecutionService {
  private readonly access: ProjectAccess;
  private readonly principals: PrincipalResolver;
  private readonly log: (line: string) => void;
  private readonly caps: SchedulerCaps;
  private port: RunnerPort | null = null;
  private unsubscribe: (() => void) | null = null;
  private bootId: string | null = null;
  private probe: ProbeCache | null = null;
  private probeSentAt: number | null = null;
  private faults = 0;
  private readonly lastSeq = new Map<string, number>();
  private readonly gapFlagged = new Set<string>();
  /** The latest heartbeat of each attempt, written by the next tick (the message path does no I/O for heartbeats). */
  private readonly hbPending = new Map<string, { at: number; logBytes: number; outBytes: number }>();
  private attemptById: Database.Statement | null = null;

  constructor(private readonly db: Database.Database, private readonly deps: ExecutionDeps) {
    this.access = new ProjectAccess(db, { auth: deps.auth });
    this.principals = new PrincipalResolver(db);
    this.log = deps.log ?? (() => {});
    this.caps = { ...DEFAULT_CAPS, ...(deps.caps ?? {}) };
  }

  get available(): boolean { return this.deps.available; }

  private requireAvailable(): void {
    if (!this.deps.available) {
      throw new PlatformError('platform_unavailable', 'execution is not available on this database', { reason: this.deps.unavailableReason ?? 'not_enabled' });
    }
  }

  private system(): Principal { return this.principals.system(); }

  // ---------- runner ----------

  /** Attach (or detach, with null) the runner. Sends `hello` and a `probe`; messages flow to onRunnerMessage. */
  attachRunner(port: RunnerPort | null, bootId: string): void {
    if (this.unsubscribe) { try { this.unsubscribe(); } catch { /* the old port is gone */ } }
    this.unsubscribe = null; this.port = null; this.probe = null; this.probeSentAt = null;
    if (!this.deps.available) { if (port) this.log('[nexus] exec: runner not attached: execution is not available'); return; }
    if (!port) return;
    if (typeof bootId !== 'string' || !ULID_RE.test(bootId)) throw new PlatformError('invalid', 'bootId must be a ULID');
    this.port = port; this.bootId = bootId;
    this.unsubscribe = port.onMessage((raw) => this.onRunnerMessage(raw));
    this.send({ op: 'hello', bootId, dataHome: this.deps.dataHome?.root ?? '', profiles: [...(this.deps.profiles ?? [])] });
    this.sendProbe(this.deps.now());
  }

  private send(msg: Parameters<RunnerPort['send']>[0]): boolean {
    if (!this.port) return false;
    try { this.port.send(msg); return true; } catch (e) {
      this.log(`[nexus] exec: could not send ${msg.op} to the runner (${(e as Error)?.name ?? 'error'})`);
      return false;
    }
  }

  private sendProbe(now: number): void { if (this.send({ op: 'probe' })) this.probeSentAt = now; }

  private runnerReady(): boolean {
    try { return !!this.port && this.port.state() === 'ready' && this.bootId !== null && !!this.deps.dataHome; } catch { return false; }
  }

  private drop(op: string, why: string): void { this.log(`[nexus] exec: dropped runner message ${op}: ${why}`); }

  /** Validates and applies one runner report. Never throws. */
  onRunnerMessage(raw: unknown): void {
    if (!this.deps.available) { this.drop('?', 'execution is not available'); return; }
    const m = parseRunnerMessage(raw);
    if (!m) { this.drop('?', 'malformed'); return; }
    try {
      switch (m.op) {
        case 'ready': this.log(`[nexus] exec: runner ready${m.bootId === this.bootId ? '' : ' (another boot id)'}`); return;
        case 'probe.result':
          this.probe = { probe: m.probe, images: m.images, freeBytes: m.freeBytes, at: this.deps.now() };
          return;
        case 'attempt.provisioned': return this.onProvisioned(m);
        case 'attempt.refused': return this.onRefused(m);
        case 'attempt.event': return this.onEvent(m);
        case 'attempt.heartbeat': return this.onHeartbeat(m);
        case 'attempt.exited': return this.onExited(m);
        case 'fault': return this.onFault(m);
        default: this.drop(m.op, 'not handled in this build');
      }
    } catch (e) {
      this.log(`[nexus] exec: runner message ${m.op} not applied: ${e instanceof PlatformError ? e.code : (e as Error)?.name ?? 'error'}`);
    }
  }

  /** The attempt a report names, when it is known and owned by this boot; else null (and one log line). */
  private ownAttempt(op: string, attemptId: string): AttemptRow | null {
    // The hot path of every report (heartbeats arrive often): one cached statement.
    this.attemptById ??= this.db.prepare('SELECT * FROM job_attempts WHERE id = ?');
    const a = (this.attemptById.get(attemptId) as AttemptRow | undefined) ?? null;
    if (!a) { this.drop(op, 'unknown attempt'); return null; }
    if (a.lease_owner !== this.bootId) { this.drop(op, 'attempt owned by another boot'); return null; }
    return a;
  }

  private onProvisioned(m: Extract<RunnerToMain, { op: 'attempt.provisioned' }>): void {
    const a = this.ownAttempt(m.op, m.attemptId); if (!a) return;
    if (a.state !== 'starting') {
      this.drop(m.op, `attempt is ${a.state}`);
      // Cancelled (or timed out) while provisioning: the container the runner just made must go.
      if (m.containerId !== undefined && a.state !== 'running') this.send({ op: 'attempt.release', attemptId: a.id });
      return;
    }
    const j = this.row(a.job_id)!;
    const recipe = getRecipe(j.recipe_id ?? '');
    if (!recipe || (j.state !== 'leased' && j.state !== 'running')) { this.drop(m.op, `job is ${j.state}`); return; }
    const now = this.deps.now();
    const sandbox = (parseJson(a.sandbox_json) ?? {}) as Record<string, unknown>;
    if (recipe.executor === 'engine') {
      if (m.containerId !== undefined) { this.drop(m.op, 'an engine attempt reported a container'); return; }
      immediateTx(this.db, () => {
        transitionAttemptTx(this.db, attemptRow(this.db, a.id)!, 'running', now, j.project_id);
        appendJobEventTx(this.db, { type: 'attempt.provisioned', summary: `attempt ${a.n} handed to the runner`, projectId: j.project_id,
          jobId: j.id, attemptN: a.n, data: { engine: true } }, now);
        if (this.row(j.id)!.state === 'leased') this.moveJobTx(j.id, 'running', now, undefined, 'leased');
        this.setPhaseTx(j.id, 'running', now);
      });
      return;
    }
    // A container attempt: only a passing preflight report from the runner lets it run (constraint 7).
    const expected = isPlainObject(sandbox.image) && typeof sandbox.image.id === 'string' ? sandbox.image.id : null;
    const problems: string[] = [];
    if (!m.preflight || !m.containerId) problems.push('no preflight report for the container');
    else {
      if (!m.preflight.ok) problems.push(...m.preflight.problems);
      if (m.imageDigest !== undefined && expected !== null && m.imageDigest !== expected) problems.push(`image ${m.imageDigest} is not the planned ${expected}`);
    }
    const preflight = m.preflight ? { ok: problems.length === 0, problems: problems.slice(0, 50), observed: m.preflight.observed } : null;
    let record: Record<string, unknown> = { ...sandbox, containerId: m.containerId ?? null, imageDigest: m.imageDigest ?? null, preflight };
    if (JSON.stringify(record).length > 30_000) record = { ...sandbox, containerId: m.containerId ?? null, preflight: { ok: problems.length === 0, problems: problems.slice(0, 20) } };
    let release = false;
    immediateTx(this.db, () => {
      const cur = attemptRow(this.db, a.id)!;
      if (problems.length === 0) {
        transitionAttemptTx(this.db, cur, 'running', now, j.project_id, { containerId: m.containerId, sandbox: record });
        appendJobEventTx(this.db, { type: 'attempt.provisioned', summary: `attempt ${a.n} container passed preflight`, projectId: j.project_id,
          jobId: j.id, attemptN: a.n, data: { preflight: 'ok', container: m.containerId!.slice(0, 12) } }, now);
        appendJobEventTx(this.db, { type: 'preflight', summary: 'preflight passed', projectId: j.project_id, jobId: j.id, attemptN: a.n,
          data: { ok: true } }, now);
        if (this.row(j.id)!.state === 'leased') this.moveJobTx(j.id, 'running', now, undefined, 'leased');
        this.setPhaseTx(j.id, 'running', now);
      } else {
        release = m.containerId !== undefined;
        transitionAttemptTx(this.db, cur, 'failed', now, j.project_id, { outcome: 'limits_not_applied', containerId: m.containerId, sandbox: record,
          error: { code: 'limits_not_applied', message: problems.join('; ') } });
        appendJobEventTx(this.db, { type: 'preflight', summary: `preflight refused the container: ${problems.length} problem(s)`, projectId: j.project_id,
          jobId: j.id, attemptN: a.n, data: { ok: false, problems: problems.slice(0, 20) } }, now);
        this.moveJobTx(j.id, 'failed', now, { outcome: 'infra_error', error: { code: 'limits_not_applied', message: problems.join('; ') } });
      }
    });
    if (release) this.send({ op: 'attempt.release', attemptId: a.id });
  }

  private onRefused(m: Extract<RunnerToMain, { op: 'attempt.refused' }>): void {
    const a = this.ownAttempt(m.op, m.attemptId); if (!a) return;
    if (a.state !== 'starting') { this.drop(m.op, `attempt is ${a.state}`); return; }
    const j = this.row(a.job_id)!;
    const now = this.deps.now();
    immediateTx(this.db, () => {
      const cur = attemptRow(this.db, a.id)!;
      const error = { code: m.reason, message: m.detail ?? `the runner refused: ${m.reason}` };
      if (REFUSE_TO_FAIL.has(m.reason) || j.state !== 'leased') {
        transitionAttemptTx(this.db, cur, 'failed', now, j.project_id, { outcome: m.reason, error });
        this.failJobTx(j.id, 'infra_error', error, now);
        return;
      }
      // Refused before anything ran: the attempt is abandoned and the job waits again (the count is kept).
      transitionAttemptTx(this.db, cur, 'abandoned', now, j.project_id, { outcome: m.reason, error });
      this.moveJobTx(j.id, 'queued', now, undefined, 'leased');
      this.setPhaseTx(j.id, REFUSAL_WAIT[m.reason] ?? 'queued', now);
    });
  }

  private onEvent(m: Extract<RunnerToMain, { op: 'attempt.event' }>): void {
    const a = this.ownAttempt(m.op, m.attemptId); if (!a) return;
    if (a.state !== 'starting' && a.state !== 'running') { this.drop(m.op, `attempt is ${a.state}`); return; }
    const last = this.lastSeq.get(a.id);
    if (last !== undefined && m.seq <= last) { this.drop(m.op, `seq ${m.seq} is not after ${last}`); return; }
    this.lastSeq.set(a.id, m.seq);
    const j = this.row(a.job_id)!;
    const now = this.deps.now();
    const ev = m.event;
    immediateTx(this.db, () => {
      appendJobEventTx(this.db, { type: 'attempt.progress', projectId: j.project_id, jobId: j.id, attemptN: a.n,
        summary: ev.t === 'phase' ? `attempt ${a.n}: ${ev.phase}` : `attempt ${a.n}: size guard ${ev.guard}`,
        data: ev.t === 'phase' ? { seq: m.seq, phase: ev.phase } : { seq: m.seq, guard: ev.guard, bytes: ev.bytes, limitBytes: ev.limitBytes } }, now);
    });
  }

  private onHeartbeat(m: Extract<RunnerToMain, { op: 'attempt.heartbeat' }>): void {
    const a = this.ownAttempt(m.op, m.attemptId); if (!a) return;
    if (a.state !== 'starting' && a.state !== 'running') { this.drop(m.op, `attempt is ${a.state}`); return; }
    const now = this.deps.now();
    if (m.container === 'missing' && a.state === 'running') {
      const j = this.row(a.job_id)!;
      const error = { code: 'container_vanished', message: 'the container disappeared while running' };
      immediateTx(this.db, () => {
        transitionAttemptTx(this.db, attemptRow(this.db, a.id)!, 'failed', now, j.project_id, { outcome: 'container_vanished', error,
          logBytes: m.logBytes, outBytes: m.outBytes });
        this.failJobTx(j.id, 'infra_error', error, now);
      });
      return;
    }
    this.gapFlagged.delete(a.id);
    const prev = this.hbPending.get(a.id);
    const hb = { at: now, logBytes: Math.max(m.logBytes, prev?.logBytes ?? 0), outBytes: Math.max(m.outBytes, prev?.outBytes ?? 0) };
    // No I/O on the message path: the next tick writes it (all pending heartbeats in one transaction).
    this.hbPending.set(a.id, hb);
  }

  /** Writes the coalesced heartbeats (one small transaction). */
  private flushHeartbeats(): void {
    if (this.hbPending.size === 0 || this.bootId === null) return;
    const list = [...this.hbPending.entries()];
    this.hbPending.clear();
    immediateTx(this.db, () => {
      for (const [id, hb] of list) heartbeatTx(this.db, id, this.bootId!, hb.at, hb.logBytes, hb.outBytes);
    });
  }

  private onExited(m: Extract<RunnerToMain, { op: 'attempt.exited' }>): void {
    const a = this.ownAttempt(m.op, m.attemptId); if (!a) return;
    if (a.state !== 'running') {
      // Cancel (or a timeout) already ended it: the exit changes nothing, the container may go.
      this.drop(m.op, `attempt is ${a.state}`);
      if (a.state !== 'starting') this.send({ op: 'attempt.release', attemptId: a.id });
      return;
    }
    const j = this.row(a.job_id)!;
    const recipe = getRecipe(j.recipe_id ?? '');
    if (!recipe) { this.drop(m.op, 'job has no recipe'); return; }
    const now = this.deps.now();
    const exit = { code: m.exit.code, signal: m.exit.signal, oomKilled: m.exit.oomKilled };
    const tests = recipe.parsers.includes('junit');
    let failure: { outcome: string; error: { code: string; message: string } } | null = null;
    if (m.outputError) failure = { outcome: 'invalid_output', error: { code: m.outputError, message: `the outputs were refused: ${m.outputError}` } };
    else if (m.exit.oomKilled) failure = { outcome: 'oom', error: { code: 'oom', message: 'the container ran out of memory' } };
    else if (!tests && m.exit.code !== 0) failure = { outcome: 'nonzero_exit', error: { code: 'nonzero_exit', message: `exit code ${m.exit.code}` } };
    else if (!contractMet(recipe.outputContract.required, m.outputs, m.parsed, recipe.executor === 'engine')) {
      failure = { outcome: 'invalid_output', error: { code: 'outputs_missing', message: `required outputs missing: ${recipe.outputContract.required.join(', ')}` } };
    }
    const decided = failure;
    let ingestThrew: string | null = null;
    try {
      immediateTx(this.db, () => {
        const cur = attemptRow(this.db, a.id)!;
        let fail = decided;
        if (!fail) {
          const ingest = this.deps.ingest;
          if (!ingest) fail = { outcome: 'ingest_unavailable', error: { code: 'ingest_unavailable', message: 'outputs cannot be ingested in this build' } };
          else {
            let d: IngestDecision;
            try {
              d = ingest.ingestTx({ system: this.system(), job: this.row(j.id)!, attempt: cur, recipe,
                exited: { exit: m.exit, outputs: m.outputs, parsed: m.parsed, logBytes: m.logBytes } });
            } catch (e) {
              ingestThrew = e instanceof PlatformError ? e.code : (e as Error)?.name ?? 'error';
              throw e;                                   // rolls back everything ingest wrote; recorded below
            }
            if (d.ok && !this.hasEvidence(j.id, cur.n)) {
              // Constraint 4 in the core: an ingest that reports success but bound nothing to this attempt completes nothing.
              d = { ok: false, outcome: 'no_evidence', error: { code: 'no_evidence', message: 'ingest bound no version or validation to the attempt' } };
            }
            if (d.ok) {
              // The attempt succeeds first: the job completes only after its current attempt succeeded (backstop trigger).
              transitionAttemptTx(this.db, cur, 'succeeded', now, j.project_id, { exit, outcome: d.outcome ?? 'succeeded', logBytes: m.logBytes });
              this.moveJobTx(j.id, 'completed', now, { outcome: d.outcome ?? 'completed' });
              return;
            }
            fail = { outcome: d.outcome, error: d.error };
          }
        }
        transitionAttemptTx(this.db, cur, 'failed', now, j.project_id, { exit, outcome: fail.outcome, error: fail.error, logBytes: m.logBytes });
        this.failJobTx(j.id, fail.outcome, fail.error, now);
      });
    } catch (e) {
      if (ingestThrew === null) throw e;
      // The exit is never lost: a second small transaction records the ingest failure (retryable infrastructure).
      const error = { code: 'ingest_error', message: `ingest failed: ${ingestThrew}` };
      immediateTx(this.db, () => {
        const cur = attemptRow(this.db, a.id)!;
        if (cur.state !== 'running') return;
        transitionAttemptTx(this.db, cur, 'failed', now, j.project_id, { exit, outcome: 'ingest_error', error, logBytes: m.logBytes });
        this.failJobTx(j.id, 'infra_error', error, now);
      });
    }
    this.send({ op: 'attempt.release', attemptId: a.id });
  }

  private onFault(m: Extract<RunnerToMain, { op: 'fault' }>): void {
    const a = m.attemptId !== undefined ? attemptRow(this.db, m.attemptId) : null;
    if (!a || !m.failureClass || a.lease_owner !== this.bootId || a.state !== 'starting') {
      this.faults++;
      this.log('[nexus] exec: runner fault (not attributed to a starting attempt of this boot)');
      return;
    }
    const cls = m.failureClass;
    const j = this.row(a.job_id)!;
    const now = this.deps.now();
    const error = { code: cls, message: `the container could not be created: ${m.message}` };
    immediateTx(this.db, () => {
      transitionAttemptTx(this.db, attemptRow(this.db, a.id)!, 'failed', now, j.project_id, { outcome: cls, error });
      this.failJobTx(j.id, 'infra_error', error, now);
    });
  }

  /** Whether a validation or an ingested version is bound to (job, attempt n). */
  private hasEvidence(jobId: string, n: number): boolean {
    return !!this.db.prepare(`SELECT 1 FROM validations WHERE job_id = ? AND attempt_n = ?
      UNION ALL SELECT 1 FROM version_attempts WHERE job_id = ? AND attempt_n = ? LIMIT 1`).get(jobId, n, jobId, n);
  }

  // ---------- job transitions (inside the caller's transaction) ----------

  /** One job transition: JobService's rules and activity row, plus one `job_events` row. */
  private moveJobTx(id: string, to: JobState, now: number, d?: { outcome?: string; error?: { code: string; message: string } }, expect?: JobState): ExecJobRow {
    const before = this.row(id)!;
    this.deps.jobs.transitionTx(this.system(), id, to, d, { expectState: expect, now });
    const after = this.row(id)!;
    appendJobEventTx(this.db, { type: 'job.transition', summary: `job ${before.state} -> ${to}${d?.outcome ? ` (${d.outcome})` : ''}`,
      projectId: after.project_id, jobId: id,
      // The event names the current attempt once its row exists (the lease writes this event just before the insert).
      attemptN: after.attempts > 0 && this.db.prepare('SELECT 1 FROM job_attempts WHERE job_id = ? AND n = ?').get(id, after.attempts) ? after.attempts : null,
      data: { from: before.state, to, outcome: after.outcome, error: d?.error?.code ?? null } }, now);
    return after;
  }

  private setPhaseTx(id: string, phase: string | null, now: number): void {
    this.db.prepare('UPDATE jobs SET phase = ?, updated_at = ? WHERE id = ? AND phase IS NOT ?').run(phase, now, id, phase);
  }

  /** The job fails; an idempotent recipe failed for an infrastructure reason is scheduled for another attempt. */
  private failJobTx(id: string, outcome: string, error: { code: string; message: string }, now: number): void {
    const j = this.moveJobTx(id, 'failed', now, { outcome, error });
    if (!RETRYABLE.has(error.code)) return;
    const retry = this.deps.jobs.toJob(j).retry;
    if (!canRetry({ kind: j.kind, attempts: j.attempts, retry })) return;
    const pw = j.participation_id === null ? undefined
      : this.db.prepare('SELECT status FROM project_workspaces WHERE id = ?').get(j.participation_id) as { status: string } | undefined;
    if (!pw || pw.status !== 'active') return;
    this.moveJobTx(id, 'retry_scheduled', now);
    this.db.prepare('UPDATE jobs SET next_attempt_at = ?, phase = NULL WHERE id = ?').run(now + backoffMs(retry.backoffMs, j.attempts), id);
  }

  // ---------- scheduler ----------

  /** One scheduler pass (see scheduler.ts). Called every second and after runner messages. Never throws. */
  tick(now: number): void {
    if (!this.deps.available) return;
    try {
      this.flushHeartbeats();
      this.requeueDue(now);
      this.sweep(now);
      if (this.runnerReady() && (this.probeSentAt === null || now - this.probeSentAt >= this.caps.probeRefreshMs)) this.sendProbe(now);
      // The blob store contract: no lease and no start while GC holds its exclusive lock.
      if (this.deps.blobs?.isExclusiveHeld()) return;
      this.leaseQueued(now);
    } catch (e) {
      this.log(`[nexus] exec: scheduler pass stopped: ${e instanceof PlatformError ? e.code : (e as Error)?.name ?? 'error'}`);
    }
  }

  private requeueDue(now: number): void {
    const due = this.db.prepare(`SELECT id FROM jobs WHERE state = 'retry_scheduled' AND next_attempt_at IS NOT NULL AND next_attempt_at <= ?
      ORDER BY next_attempt_at, id`).all(now) as { id: string }[];
    for (const { id } of due) {
      try {
        immediateTx(this.db, () => {
          const j = this.row(id)!;
          if (j.state !== 'retry_scheduled') return;
          try {
            this.moveJobTx(id, 'queued', now, undefined, 'retry_scheduled');
          } catch (e) {
            if (!(e instanceof PlatformError) || e.code !== 'illegal_transition') throw e;
            // No resurrection: the participation is gone, so the scheduled retry ends here.
            this.moveJobTx(id, 'cancelled', now, { outcome: 'participation_inactive' }, 'retry_scheduled');
          }
          this.db.prepare('UPDATE jobs SET next_attempt_at = NULL, phase = NULL WHERE id = ?').run(id);
        });
      } catch (e) {
        this.log(`[nexus] exec: retry not requeued: ${e instanceof PlatformError ? e.code : 'error'}`);
      }
    }
  }

  /** Time the job spent in awaiting_approval during attempt n (an open wait counts until now). */
  private approvalWaitMs(jobId: string, n: number, now: number): number {
    const rows = this.db.prepare(`SELECT ts, data_json FROM job_events WHERE job_id = ? AND attempt_n = ? AND type = 'job.transition' ORDER BY seq`)
      .all(jobId, n) as { ts: number; data_json: string }[];
    let total = 0; let since: number | null = null;
    for (const r of rows) {
      const d = parseJson(r.data_json) as { from?: string; to?: string } | null;
      if (d?.to === 'awaiting_approval' && since === null) since = r.ts;
      else if (d?.from === 'awaiting_approval' && since !== null) { total += r.ts - since; since = null; }
    }
    if (since !== null) total += now - since;
    return total;
  }

  private sweep(now: number): void {
    if (this.bootId === null) return;
    const live = this.db.prepare(`SELECT a.id AS attempt_id, a.n, a.state AS attempt_state, a.created_at, a.started_at, a.heartbeat_at,
        a.lease_expires_at, j.id AS job_id, j.state AS job_state, j.phase, j.limits_json, j.project_id FROM job_attempts a JOIN jobs j ON j.id = a.job_id
      WHERE a.state IN ('starting','running') AND a.lease_owner = ?`).all(this.bootId) as
      { attempt_id: string; n: number; attempt_state: string; created_at: number; started_at: number | null; heartbeat_at: number | null;
        lease_expires_at: number; job_id: string; job_state: JobState; phase: string | null; limits_json: string; project_id: string }[];
    // In-memory per-attempt state lives only as long as the attempt does.
    const liveIds = new Set(live.map((r) => r.attempt_id));
    for (const id of [...this.lastSeq.keys()]) if (!liveIds.has(id)) this.lastSeq.delete(id);
    for (const id of [...this.gapFlagged]) if (!liveIds.has(id)) this.gapFlagged.delete(id);
    for (const r of live) {
      const limits = parseJson(r.limits_json) as { wallClockMs?: number } | null;
      const wall = typeof limits?.wallClockMs === 'number' ? limits.wallClockMs : null;
      if (wall !== null && (r.job_state === 'running' || r.job_state === 'leased')) {
        const elapsed = now - r.created_at - this.approvalWaitMs(r.job_id, r.n, now);
        if (elapsed > wall) { this.timeOut(r.job_id, r.attempt_id, now); continue; }
      }
      // A lease that ran out without a heartbeat: the runner is gone for this attempt (an approval wait holds no lease).
      if (r.lease_expires_at < now && r.job_state !== 'awaiting_approval' && r.phase !== 'approval') { this.runnerLost(r.attempt_id, now); continue; }
      if (r.attempt_state === 'running') {
        const last = r.heartbeat_at ?? r.started_at ?? r.created_at;
        if (now - last >= HEARTBEAT_GAP_MS && !this.gapFlagged.has(r.attempt_id)) {
          this.gapFlagged.add(r.attempt_id);
          immediateTx(this.db, () => appendJobEventTx(this.db, { type: 'attempt.heartbeat_gap', summary: `attempt ${r.n}: no heartbeat for ${Math.round((now - last) / 1000)} s`,
            projectId: r.project_id, jobId: r.job_id, attemptN: r.n, data: { gapMs: now - last } }, now));
        }
      }
    }
  }

  private runnerLost(attemptId: string, now: number): void {
    immediateTx(this.db, () => {
      const a = attemptRow(this.db, attemptId)!;
      const j = this.row(a.job_id)!;
      const error = { code: 'runner_lost', message: 'the lease ran out without a heartbeat from the runner' };
      transitionAttemptTx(this.db, a, 'failed', now, j.project_id, { outcome: 'runner_lost', error });
      this.failJobTx(j.id, 'infra_error', error, now);
    });
  }

  private timeOut(jobId: string, attemptId: string, now: number): void {
    immediateTx(this.db, () => {
      const a = attemptRow(this.db, attemptId)!;
      const j = this.row(jobId)!;
      const error = { code: 'timed_out', message: 'the wall clock of the attempt ran out' };
      if (a.state === 'running') transitionAttemptTx(this.db, a, 'timed_out', now, j.project_id, { outcome: 'timed_out', error });
      else transitionAttemptTx(this.db, a, 'failed', now, j.project_id, { outcome: 'timed_out', error });
      if (j.state === 'running') this.moveJobTx(jobId, 'timed_out', now, { outcome: 'timed_out', error });
      else this.moveJobTx(jobId, 'failed', now, { outcome: 'timed_out', error });
    });
    this.send({ op: 'attempt.cancel', attemptId, graceMs: CANCEL_GRACE_MS, reason: 'timeout' });
  }

  private liveUse(): LiveUse {
    // A job waiting for approval holds no container yet, so it holds no slot and no memory.
    const rows = this.db.prepare(`SELECT j.recipe_id, j.limits_json FROM job_attempts a JOIN jobs j ON j.id = a.job_id
      WHERE a.state IN ('starting','running') AND j.state <> 'awaiting_approval' AND j.phase IS NOT 'approval'`).all() as { recipe_id: string | null; limits_json: string }[];
    const use: LiveUse = { jobContainers: 0, serviceContainers: 0, reservedMemoryMb: 0 };
    for (const r of rows) {
      const recipe = getRecipe(r.recipe_id ?? '');
      if (!recipe || recipe.executor === 'engine') continue;
      if (recipe.executor === 'service') use.serviceContainers++; else use.jobContainers++;
      const l = parseJson(r.limits_json) as { memoryMb?: number } | null;
      use.reservedMemoryMb += typeof l?.memoryMb === 'number' ? l.memoryMb : 0;
    }
    return use;
  }

  private leaseQueued(now: number): void {
    const queued = this.db.prepare(`SELECT * FROM jobs WHERE state = 'queued' AND kind = 'tool.run' AND recipe_id IS NOT NULL
      ORDER BY priority, created_at, rowid`).all() as ExecJobRow[];
    if (queued.length === 0) return;
    const ready = this.runnerReady();
    const use = this.liveUse();
    for (const j of queued) {
      const recipe = getRecipe(j.recipe_id ?? '');
      const cap = this.capabilityOf(j);
      if (!recipe || !cap) continue;
      const limits = parseJson(j.limits_json) as Partial<ResourceLimits> | null;
      const memoryMb = typeof limits?.memoryMb === 'number' ? limits.memoryMb : 0;
      const wait = leaseGuard({ recipe, profile: cap.profile, memoryMb }, ready, this.probe, use, this.caps);
      if (wait !== null) {
        if (j.phase !== wait) immediateTx(this.db, () => this.setPhaseTx(j.id, wait, now));
        continue;
      }
      try {
        if (this.lease(j, recipe, cap, now)) {
          if (recipe.executor === 'service') use.serviceContainers++;
          else if (recipe.executor === 'tool') use.jobContainers++;
          use.reservedMemoryMb += recipe.executor === 'engine' ? 0 : memoryMb;
        }
      } catch (e) {
        this.log(`[nexus] exec: lease not taken: ${e instanceof PlatformError ? e.code : (e as Error)?.name ?? 'error'}`);
      }
    }
  }

  /** The plan inputs of a job: its job_inputs joined to their versions. */
  private planInputs(jobId: string): PlanInput[] {
    const rows = this.db.prepare(`SELECT ji.version_id, ji.role, ji.content_hash, v.storage_ref_json, v.metadata_json FROM job_inputs ji
      JOIN artifact_versions v ON v.id = ji.version_id WHERE ji.job_id = ? ORDER BY ji.rowid`).all(jobId) as
      { version_id: string; role: string; content_hash: string; storage_ref_json: string; metadata_json: string }[];
    return rows.map((r) => ({ versionId: r.version_id, slot: r.role, contentHash: r.content_hash,
      storage: (parseJson(r.storage_ref_json) ?? { kind: 'unknown' }) as PlanInput['storage'], metadata: parseJson(r.metadata_json) }));
  }

  private repoPathOf(projectId: string): string | null {
    const accept = this.deps.acceptFsRoot;
    if (!accept) return null;
    const p = this.db.prepare('SELECT root_path FROM projects WHERE id = ?').get(projectId) as { root_path: string | null } | undefined;
    if (!p || typeof p.root_path !== 'string' || p.root_path.length === 0) return null;
    try { return accept(p.root_path); } catch { return null; }
  }

  /** One IMMEDIATE lease transaction. Returns true when the job was leased. */
  private lease(j: ExecJobRow, recipe: RecipeDef, cap: Capability, now: number): boolean {
    const home = this.deps.dataHome!;
    const n = j.attempts + 1;
    const attemptId = newId(now);
    const egress = recipe.network === 'egress-approved';
    const profile = (this.deps.profiles ?? []).find((p) => p.id === cap.profile) ?? null;
    const image = usableImage(this.probe, cap.profile);
    const inputs = this.planInputs(j.id);
    const needsRepo = recipe.executor === 'engine' || inputs.some((i) => i.storage?.kind === 'git');
    const repoPath = needsRepo ? this.repoPathOf(j.project_id) : null;
    const workRel = home.attemptWorkRel(j.id, n);
    const logRel = home.attemptLogPath(j.id, n);
    // Egress plans are built only after the approval is consumed; every other plan is built now.
    let plan: ReturnType<typeof buildPlan> | null = null;
    let planError: { code: string; message: string } | null = null;
    if (!egress) {
      try {
        plan = buildPlan({ job: { id: j.id, projectId: j.project_id }, attempt: { id: attemptId, n }, bootId: this.bootId!, recipe,
          profile, imageId: (image?.imageId as `sha256:${string}` | undefined) ?? null, dataHomeRoot: home.root, workRel, logRel, inputs, repoPath,
          approval: null });
      } catch (e) {
        if (!(e instanceof PlatformError)) throw e;
        planError = { code: String(e.detail?.reason ?? 'bad_plan'), message: e.message };
      }
    }
    const environment = {
      recipeId: recipe.id, recipeVersion: recipe.version, executor: recipe.executor, profile: cap.profile,
      imageRef: profile ? `${profile.image.repository}@${profile.image.digest}` : null, imageId: image?.imageId ?? null,
      baseDigest: profile?.image.digest ?? null, contextSha256: image?.contextSha256 ?? null,
      dockerVersion: this.probe?.probe.version ?? null, runnerBootId: this.bootId, nexusVersion: this.deps.appVersion ?? null,
      lockfileSha256: lockfileSha256Of(inputs)
    };
    const leased = immediateTx(this.db, () => {
      const cur = this.row(j.id);
      if (!cur || cur.state !== 'queued') return false;
      this.moveJobTx(j.id, 'leased', now, undefined, 'queued');
      this.deps.hooks?.afterLeaseTransition?.(j.id);
      insertAttemptTx(this.db, { id: attemptId, jobId: j.id, projectId: j.project_id, n, bootId: this.bootId!, now, logPath: logRel,
        sandbox: plan ? sandboxRecord(plan) : undefined, environment });
      this.setPhaseTx(j.id, 'provisioning', now);
      if (egress) {
        const approvals = this.deps.approvals;
        if (!approvals) {
          planError = { code: 'approvals_unavailable', message: 'network approvals are not available in this build' };
        } else {
          const approvalId = approvals.requestEgressTx({ id: j.id, projectId: j.project_id, onBehalfOf: j.on_behalf_of }, { id: attemptId, n }, recipe, now);
          this.moveJobTx(j.id, 'running', now, undefined, 'leased');
          this.setPhaseTx(j.id, 'approval', now);
          this.moveJobTx(j.id, 'awaiting_approval', now, undefined, 'running');
          appendJobEventTx(this.db, { type: 'approval', summary: 'waiting for approval of network access', projectId: j.project_id, jobId: j.id,
            attemptN: n, approvalId, data: { approvalId } }, now);
          return true;
        }
      }
      if (planError) {
        transitionAttemptTx(this.db, attemptRow(this.db, attemptId)!, 'failed', now, j.project_id, { outcome: 'bad_plan', error: planError });
        this.moveJobTx(j.id, 'failed', now, { outcome: 'infra_error', error: planError });
      }
      return true;
    });
    if (leased && plan && !planError && !this.send({ op: 'attempt.start', attemptId, plan })) this.unsent(attemptId, now);
    return leased;
  }

  /** `attempt.start` did not reach the runner: nothing ran, so the attempt is abandoned and the job waits again (as on a refusal). */
  private unsent(attemptId: string, now: number): void {
    immediateTx(this.db, () => {
      const a = attemptRow(this.db, attemptId);
      if (!a || a.state !== 'starting') return;
      const j = this.row(a.job_id)!;
      const error = { code: 'not_sent', message: 'the plan did not reach the runner' };
      transitionAttemptTx(this.db, a, 'abandoned', now, j.project_id, { outcome: 'not_sent', error });
      if (j.state === 'leased') {
        this.moveJobTx(j.id, 'queued', now, undefined, 'leased');
        this.setPhaseTx(j.id, 'waiting:runner', now);
      } else {
        this.failJobTx(j.id, 'infra_error', { code: 'runner_lost', message: 'the plan did not reach the runner' }, now);
      }
    });
  }

  /**
   * @internal For the approval service (Task 9): after the user's `once` was recorded and the approval
   * consumed by this job's current attempt, the job moves `awaiting_approval -> running` and the plan
   * (now carrying the approval) is built. Runs in the caller's transaction (or its own); returns the send
   * to perform AFTER the caller commits.
   */
  resumeApproved(jobId: string): () => void {
    this.requireAvailable();
    const now = this.deps.now();
    return immediateTx(this.db, () => {
      const j = this.row(jobId);
      if (!j || j.state !== 'awaiting_approval') throw new PlatformError('illegal_transition', 'the job is not waiting for approval');
      const a = liveAttemptOf(this.db, j.id);
      const recipe = getRecipe(j.recipe_id ?? '');
      const cap = this.capabilityOf(j);
      if (!a || !recipe || !cap || !this.deps.dataHome) throw new PlatformError('illegal_transition', 'the job has no attempt to resume');
      // A job waiting for approval held no slot or memory: the caps are checked again before it starts.
      const limits = parseJson(j.limits_json) as Partial<ResourceLimits> | null;
      const wait = leaseGuard({ recipe, profile: cap.profile, memoryMb: typeof limits?.memoryMb === 'number' ? limits.memoryMb : 0 },
        this.runnerReady(), this.probe, this.liveUse(), this.caps);
      if (wait !== null) throw new PlatformError('conflict', `the job cannot start now (${wait})`, { reason: wait });
      const approval = this.db.prepare(`SELECT id, job_id, status, consumed_at, consumed_by_job_id, consumed_by_attempt_n FROM approvals
        WHERE job_id = ? AND status = 'approved' ORDER BY status_changed_at DESC LIMIT 1`).get(j.id) as PlanApproval | undefined;
      const profile = (this.deps.profiles ?? []).find((p) => p.id === cap.profile) ?? null;
      const image = usableImage(this.probe, cap.profile);
      const plan = buildPlan({ job: { id: j.id, projectId: j.project_id }, attempt: { id: a.id, n: a.n }, bootId: this.bootId ?? '', recipe,
        profile, imageId: (image?.imageId as `sha256:${string}` | undefined) ?? null, dataHomeRoot: this.deps.dataHome.root,
        workRel: this.deps.dataHome.attemptWorkRel(j.id, a.n), logRel: this.deps.dataHome.attemptLogPath(j.id, a.n),
        inputs: this.planInputs(j.id), repoPath: this.repoPathOf(j.project_id), approval: approval ?? null });
      this.db.prepare('UPDATE job_attempts SET sandbox_json = ?, lease_expires_at = ?, updated_at = ? WHERE id = ?')
        .run(JSON.stringify(sandboxRecord(plan)), now + LEASE_MS, now, a.id);
      this.moveJobTx(j.id, 'running', now, undefined, 'awaiting_approval');
      this.setPhaseTx(j.id, 'provisioning', now);
      return () => { if (!this.send({ op: 'attempt.start', attemptId: a.id, plan })) this.unsent(a.id, this.deps.now()); };
    });
  }

  // ---------- user operations ----------

  start(p: Principal, r: StartJobRequest): { job: ExecJob; created: boolean } {
    this.requireAvailable();
    if (!isPlainObject(r)) throw new PlatformError('invalid', 'request must be an object');
    if (!isStr(r.projectId) || !isStr(r.workspaceId)) throw new PlatformError('invalid', 'projectId and workspaceId are required');
    // Authorization first, so every denial is audited whatever else is wrong with the request.
    const pw = requireActiveParticipation(this.access, this.db, p, r.projectId, r.workspaceId, 'job.create');
    const key = validateKey(r.intentId);
    const action = typeof r.actionId === 'string' ? getUserAction(r.actionId) : null;
    if (!action || !('recipes' in action.run)) return invalid('unknown_action', 'unknown action');
    if (action.domain !== r.workspaceId) return invalid('action_not_in_domain', 'the action belongs to another domain');
    const params = checkParams(action.params, r.params ?? {});
    const inputs = this.validateInputShape(action, r.inputs);
    return this.createExecJob(p, { action, projectId: pw.project_id, workspaceId: pw.workspace_id, key, params, inputs, retryOf: null });
  }

  retry(p: Principal, jobId: string, intentId: string): { job: ExecJob } {
    this.requireAvailable();
    const key = validateKey(intentId);
    const j = this.load(p, jobId, 'job.create');
    const cap = this.capabilityOf(j);
    const action = cap ? getUserAction(cap.action) : null;
    if (!action || !('recipes' in action.run)) throw new PlatformError('invalid', 'only a job started from an action can be retried', { reason: 'unknown_action' });
    if (!['failed', 'timed_out', 'cancelled', 'interrupted'].includes(j.state)) {
      throw new PlatformError('illegal_transition', `a ${j.state} job is not retried`, { from: j.state });
    }
    const pwRow = this.db.prepare('SELECT project_id, workspace_id FROM project_workspaces WHERE id = ?').get(j.participation_id) as
      { project_id: string; workspace_id: string } | undefined;
    if (!pwRow) throw new PlatformError('participation_inactive', 'the participation is gone');
    const pw = requireActiveParticipation(this.access, this.db, p, pwRow.project_id, pwRow.workspace_id, 'job.create');
    const inputs = (this.db.prepare('SELECT version_id AS versionId, role AS slot FROM job_inputs WHERE job_id = ? ORDER BY rowid').all(j.id) as
      { versionId: string; slot: string }[]).map((x) => ({ ...x }));
    const params = (parseJson(j.params_json) ?? {}) as Record<string, unknown>;
    return { job: this.createExecJob(p, { action, projectId: pw.project_id, workspaceId: pw.workspace_id, key, params, inputs, retryOf: j.id }).job };
  }

  private validateInputShape(action: UserActionDef, raw: unknown): { versionId: string; slot: string }[] {
    const list = raw === undefined ? [] : raw;
    if (!Array.isArray(list) || list.length > MAX_START_INPUTS) return invalid('input_not_allowed', `inputs must be a list of at most ${MAX_START_INPUTS}`);
    const seen = new Set<string>();
    const out = list.map((x: unknown) => {
      if (!isPlainObject(x) || !isStr(x.versionId) || !isStr(x.slot) || Object.keys(x).some((k) => k !== 'versionId' && k !== 'slot')) {
        return invalid('input_not_allowed', 'each input is { versionId, slot }');
      }
      if (!action.inputs.some((s) => s.slot === x.slot)) invalid('input_not_allowed', `the action has no input slot ${String(x.slot).slice(0, 32)}`);
      const k = `${x.versionId}\u0000${x.slot}`;
      if (seen.has(k)) invalid('input_not_allowed', 'duplicate input');
      seen.add(k);
      return { versionId: x.versionId as string, slot: x.slot as string };
    });
    for (const s of action.inputs) {
      const n = out.filter((x) => x.slot === s.slot).length;
      if (n < s.min || n > s.max) invalid('input_not_allowed', `slot ${s.slot} takes ${s.min} to ${s.max} input(s)`);
    }
    return out;
  }

  /** Authorization is done; checks inputs (readable, candidate or active, an accepted kind), picks the recipe, creates the job. */
  private createExecJob(p: Principal, o: { action: UserActionDef; projectId: string; workspaceId: string; key: string;
    params: Record<string, unknown>; inputs: { versionId: string; slot: string }[]; retryOf: string | null }): { job: ExecJob; created: boolean } {
    const prior = this.db.prepare('SELECT id FROM jobs WHERE idempotency_key = ?').get(o.key) as { id: string } | undefined;
    const recipes = ('recipes' in o.action.run ? o.action.run.recipes : []).map((id) => getRecipe(id)).filter((x): x is RecipeDef => x !== null);
    const facts: { kind: string; metadata: unknown }[] = [];
    for (const x of o.inputs) {
      try {
        this.access.requireVersionReadable(p, x.versionId, o.projectId);
      } catch (e) {
        if (e instanceof PlatformError && e.code === 'invalid') throw new PlatformError('invalid', 'the input is not allowed', { reason: 'input_not_allowed' });
        throw e;
      }
      const v = this.db.prepare(`SELECT v.status, v.metadata_json, a.kind FROM artifact_versions v JOIN artifacts a ON a.id = v.artifact_id WHERE v.id = ?`)
        .get(x.versionId) as { status: string; metadata_json: string; kind: string };
      const slot = o.action.inputs.find((s) => s.slot === x.slot)!;
      if ((v.status !== 'candidate' && v.status !== 'active') || !slot.kinds.includes(v.kind as never)) {
        throw new PlatformError('invalid', 'the input is not allowed', { reason: 'input_not_allowed' });
      }
      facts.push({ kind: v.kind, metadata: parseJson(v.metadata_json) });
    }
    const profile = this.profileFor(o.projectId, facts);
    const recipe = recipes.find((rc) => rc.executor === 'engine' || rc.profiles.includes(profile)) ?? null;
    if (!recipe) return invalid('no_recipe', 'no recipe of this action fits the repository');
    if (recipe.executor === 'service' || recipe.id === 'sde.diagnose') return invalid('not_in_this_build', 'this action arrives with dev deployments');
    if (recipe.network === 'egress-approved' && !this.deps.approvals) return invalid('approvals_unavailable', 'network approvals are not available in this build');
    const cap: Capability = { action: o.action.id, recipe: recipe.id, recipeVersion: recipe.version, executor: recipe.executor, network: recipe.network,
      profile: recipe.executor === 'engine' ? null : profile };
    const limits = recipe.limits
      ? { cpus: recipe.limits.cpus, memoryMb: recipe.limits.memoryMb, pids: 512, wallClockMs: recipe.wallClockMs, outputMaxBytes: recipe.limits.outputMaxBytes, tmpfsMb: 512 }
      : { wallClockMs: recipe.wallClockMs };
    const create = {
      kind: 'tool.run' as const, projectId: o.projectId, workspaceId: o.workspaceId, idempotencyKey: o.key, recipeId: recipe.id,
      ...(o.retryOf ? { retryOf: o.retryOf } : {}),
      params: o.params, inputs: o.inputs.map((x) => ({ versionId: x.versionId, role: x.slot })),
      retry: { idempotent: recipe.retry.idempotent, maxAttempts: recipe.retry.maxAttempts, backoffMs: RETRY_BACKOFF_MS.slice(0, Math.max(recipe.retry.maxAttempts - 1, 0)) }
    };
    if (!prior) this.requireQueueRoom(o.projectId);
    const now = this.deps.now();
    return immediateTx(this.db, () => {
      if (!this.db.prepare('SELECT 1 FROM jobs WHERE idempotency_key = ?').get(o.key)) this.requireQueueRoom(o.projectId);
      const res = this.deps.jobs.createTx(p, create);
      if (res.created) {
        this.db.prepare('UPDATE jobs SET capabilities_json = ?, limits_json = ?, phase = NULL WHERE id = ?')
          .run(JSON.stringify([cap]), JSON.stringify(limits), res.job.id);
        appendJobEventTx(this.db, { type: 'job.transition', summary: `job queued: ${o.action.label}`, projectId: o.projectId, jobId: res.job.id,
          data: { from: null, to: 'queued', action: o.action.id, recipe: recipe.id, retryOf: o.retryOf } }, now);
      }
      return { job: this.toExecJob(this.row(res.job.id)!), created: res.created };
    });
  }

  private requireQueueRoom(projectId: string): void {
    const n = (this.db.prepare(`SELECT COUNT(*) AS n FROM jobs WHERE project_id = ? AND state IN (${LIVE_JOB_STATES.map(() => '?').join(', ')})`)
      .get(projectId, ...LIVE_JOB_STATES) as { n: number }).n;
    if (n >= this.caps.perProjectQueue) invalid('queue_full', `a project holds at most ${this.caps.perProjectQueue} waiting or running jobs`);
  }

  /** The sandbox profile for this project's repository: an input's recorded profile, else the project's languages, else node. */
  private profileFor(projectId: string, facts: { kind: string; metadata: unknown }[]): SandboxProfileId {
    for (const f of facts) {
      const m = isPlainObject(f.metadata) ? f.metadata.profile : undefined;
      if (typeof m === 'string' && (SANDBOX_PROFILE_IDS as readonly string[]).includes(m)) return m as SandboxProfileId;
    }
    const row = this.db.prepare('SELECT metadata_json FROM projects WHERE id = ?').get(projectId) as { metadata_json: string | null } | undefined;
    const meta = parseJson(row?.metadata_json ?? null);
    const langs = isPlainObject(meta) && Array.isArray(meta.detectedLanguages) ? meta.detectedLanguages.map((x) => String(x).toLowerCase()) : [];
    if (langs.includes('python') && !langs.some((l) => l === 'javascript' || l === 'typescript')) return 'sde-python';
    return 'sde-node';
  }

  cancel(p: Principal, jobId: string): ExecJob {
    this.requireAvailable();
    const j = this.load(p, jobId, 'job.cancel');
    if (TERMINAL_JOB_STATES.has(j.state)) throw new PlatformError('illegal_transition', `a ${j.state} job cannot be cancelled`, { from: j.state });
    const now = this.deps.now();
    const toCancel: { attemptId: string; reason: CancelReason }[] = [];
    immediateTx(this.db, () => {
      // Children first (deepest first), then the job itself.
      const tree = this.db.prepare(`WITH RECURSIVE t(id, depth) AS (SELECT id, 1 FROM jobs WHERE parent_job_id = ?
          UNION ALL SELECT j.id, t.depth + 1 FROM jobs j JOIN t ON j.parent_job_id = t.id WHERE t.depth < 16)
        SELECT id, MAX(depth) AS depth FROM t GROUP BY id ORDER BY depth DESC, id`).all(j.id) as { id: string }[];
      for (const c of tree) this.cancelOneTx(p, c.id, 'parent', now, toCancel);
      this.cancelOneTx(p, j.id, 'user', now, toCancel);
    });
    for (const c of toCancel) this.send({ op: 'attempt.cancel', attemptId: c.attemptId, graceMs: CANCEL_GRACE_MS, reason: c.reason });
    return this.toExecJob(this.row(j.id)!);
  }

  private cancelOneTx(p: Principal, id: string, reason: CancelReason, now: number, out: { attemptId: string; reason: CancelReason }[]): void {
    const j = this.row(id)!;
    if (TERMINAL_JOB_STATES.has(j.state)) return;
    if (j.cancel_requested_at === null) this.db.prepare('UPDATE jobs SET cancel_requested_at = ?, updated_at = ? WHERE id = ?').run(now, now, id);
    const a = liveAttemptOf(this.db, id);
    if (a) {
      transitionAttemptTx(this.db, a, 'cancelled', now, j.project_id, { outcome: 'cancelled', error: { code: 'cancelled', message: `cancelled (${reason})` } });
      out.push({ attemptId: a.id, reason });
    }
    const pending = this.db.prepare("SELECT id FROM approvals WHERE job_id = ? AND status = 'pending'").all(id) as { id: string }[];
    for (const ap of pending) {
      this.db.prepare("UPDATE approvals SET status = 'withdrawn', status_changed_at = ? WHERE id = ? AND status = 'pending'").run(now, ap.id);
      appendActivityRow(this.db, { actorKind: p.kind, actorId: p.id, onBehalfOf: j.on_behalf_of, jobId: id, projectId: j.project_id,
        workspaceId: j.workspace_id, entityType: 'approval', entityId: ap.id, action: 'approval.withdraw', status: 'succeeded',
        details: { reason: 'job_cancelled' } }, now);
      appendJobEventTx(this.db, { type: 'approval', summary: 'approval withdrawn: the job was cancelled', projectId: j.project_id, jobId: id,
        approvalId: ap.id, data: { status: 'withdrawn' } }, now);
    }
    this.db.prepare("UPDATE artifact_versions SET draft_flag = 'cancelled_partial' WHERE produced_by_job_id = ? AND status = 'draft' AND draft_flag IS NULL")
      .run(id);
    this.moveJobTx(id, 'cancelled', now, { outcome: 'cancelled' });
    this.setPhaseTx(id, null, now);
  }

  list(p: Principal, f: JobFilter = {}): { jobs: ExecJob[]; truncated: boolean } {
    this.requireAvailable();
    if (!isPlainObject(f)) throw new PlatformError('invalid', 'filter must be an object');
    const limit = f.limit === undefined ? DEFAULT_EXEC_LIST_LIMIT : f.limit;
    if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > MAX_EXEC_LIST_LIMIT) {
      throw new PlatformError('invalid', `limit must be 1 to ${MAX_EXEC_LIST_LIMIT}`);
    }
    if (f.states !== undefined && (!Array.isArray(f.states) || f.states.length === 0 || !f.states.every(isJobState))) {
      throw new PlatformError('invalid', 'states must be a non-empty list of job states');
    }
    if (f.jobKind !== undefined && !JOB_KINDS.includes(f.jobKind as JobKind)) throw new PlatformError('invalid', 'unknown job kind');
    if (f.projectId !== undefined) {
      if (!isStr(f.projectId)) throw new PlatformError('invalid', 'projectId must be an id');
      this.access.require(p, f.projectId, 'job.read');
    } else {
      this.deps.auth.require(p, 'job.read', PLATFORM, { entityType: 'job' });
    }
    const where: string[] = []; const args: unknown[] = [];
    if (f.projectId !== undefined) { where.push('project_id = ?'); args.push(f.projectId); }
    if (f.workspaceId !== undefined) { if (!isStr(f.workspaceId)) throw new PlatformError('invalid', 'workspaceId must be an id'); where.push('workspace_id = ?'); args.push(f.workspaceId); }
    if (f.states !== undefined) { where.push(`state IN (${f.states.map(() => '?').join(', ')})`); args.push(...f.states); }
    if (f.jobKind !== undefined) { where.push('kind = ?'); args.push(f.jobKind); }
    const rows = this.db.prepare(`SELECT * FROM jobs ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at DESC, id DESC LIMIT ?`)
      .all(...args, limit + 1) as ExecJobRow[];
    return { jobs: rows.slice(0, limit).map((r) => this.toExecJob(r)), truncated: rows.length > limit };
  }

  get(p: Principal, jobId: string): JobDetail {
    this.requireAvailable();
    const j = this.load(p, jobId, 'job.read');
    const attempts = (this.db.prepare('SELECT * FROM job_attempts WHERE job_id = ? ORDER BY n').all(j.id) as AttemptRow[]).map((a) => {
      const sb = parseJson(a.sandbox_json) as Record<string, unknown> | null;
      const net = sb && isPlainObject(sb.network) && typeof sb.network.mode === 'string' ? sb.network.mode : sb && typeof sb.network === 'string' ? sb.network : null;
      const pf = sb && isPlainObject(sb.preflight) ? { ok: sb.preflight.ok === true, problems: Array.isArray(sb.preflight.problems) ? (sb.preflight.problems as unknown[]).map(String).slice(0, 20) : [] } : null;
      const err = parseJson(a.error_json) as { code?: string; message?: string } | null;
      return { id: a.id, n: a.n, state: a.state, outcome: a.outcome, exitCode: a.exit_code, signal: a.signal,
        oomKilled: a.oom_killed === null ? null : a.oom_killed === 1, network: net, preflight: pf,
        error: err && typeof err.code === 'string' && typeof err.message === 'string' ? { code: err.code, message: err.message } : null,
        createdAt: a.created_at, startedAt: a.started_at, finishedAt: a.finished_at };
    });
    const approvals = (this.db.prepare('SELECT id, status, reason, expires_at FROM approvals WHERE job_id = ? ORDER BY requested_at').all(j.id) as
      { id: string; status: string; reason: string; expires_at: number }[]).map((x) => ({ id: x.id, status: x.status, reason: x.reason, expiresAt: x.expires_at }));
    const outputs = (this.db.prepare('SELECT id, status, output_path FROM artifact_versions WHERE produced_by_job_id = ? ORDER BY created_at, id').all(j.id) as
      { id: string; status: string; output_path: string | null }[]).map((x) => ({ versionId: x.id, status: x.status, outputPath: x.output_path }));
    return { ...this.toExecJob(j), attemptHistory: attempts, approvals, outputs };
  }

  eventsSince(p: Principal, q: { sinceSeq: number; projectId?: string; limit?: number }): { events: JobEvent[]; lastSeq: number } {
    this.requireAvailable();
    if (!isPlainObject(q) || typeof q.sinceSeq !== 'number' || !Number.isSafeInteger(q.sinceSeq) || q.sinceSeq < 0) {
      throw new PlatformError('invalid', 'sinceSeq must be a non-negative integer');
    }
    const limit = q.limit === undefined ? 200 : q.limit;
    if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > MAX_EVENTS_LIMIT) throw new PlatformError('invalid', `limit must be 1 to ${MAX_EVENTS_LIMIT}`);
    let rows: JobEventRow[];
    if (q.projectId !== undefined) {
      if (!isStr(q.projectId)) throw new PlatformError('invalid', 'projectId must be an id');
      this.access.require(p, q.projectId, 'job.read');
      rows = this.db.prepare('SELECT * FROM job_events WHERE project_id = ? AND seq > ? ORDER BY seq LIMIT ?').all(q.projectId, q.sinceSeq, limit) as JobEventRow[];
    } else {
      this.deps.auth.require(p, 'job.read', PLATFORM, { entityType: 'job' });
      rows = this.db.prepare('SELECT * FROM job_events WHERE seq > ? ORDER BY seq LIMIT ?').all(q.sinceSeq, limit) as JobEventRow[];
    }
    const events = rows.map(toJobEvent);
    return { events, lastSeq: events.length ? events[events.length - 1].seq : q.sinceSeq };
  }

  /** The cached probe and the resource gate; never waits on the runner or Docker, never throws. */
  health(): HealthSnapshot {
    let runnerState = 'unavailable';
    try { if (this.port) runnerState = this.port.state(); } catch { runnerState = 'unavailable'; }
    const c = this.probe;
    const floor = leaseFloorBytes(0);
    return {
      execution: { available: this.deps.available, reason: this.deps.available ? null : (this.deps.unavailableReason ?? 'not_enabled') },
      runner: { state: runnerState, attached: this.port !== null, faults: this.faults },
      docker: c ? { state: c.probe.docker, version: c.probe.version, cpus: c.probe.cpus, memoryBytes: c.probe.memoryBytes } : { state: 'unknown' },
      images: c ? c.images.map((i) => ({ profile: i.profile, present: i.present, matches: i.digestMatches })) : [],
      disk: { freeBytes: c ? c.freeBytes : null, leaseFloorBytes: floor },
      gate: c ? evaluateGate(c.probe, c.freeBytes ?? -1, c.images) : null,
      checkedAt: c ? c.at : null
    };
  }

  /**
   * Whether a container action could run on this machine now, as a `setup:*` reason (the IPC layer maps
   * it to `unavailable`). Image preparation additionally needs the full 30 GiB gate (`setup:disk_low`).
   */
  setupAvailability(what: { actionId: string } | { imagePreparation: true }): { available: boolean; reason: string | null } {
    if (!this.deps.available) return { available: false, reason: `execution:${this.deps.unavailableReason ?? 'not_enabled'}` };
    if (!this.runnerReady()) return { available: false, reason: 'setup:runner_unavailable' };
    const c = this.probe;
    if (!c) return { available: false, reason: 'setup:runner_unavailable' };
    if (c.probe.docker !== 'running') return { available: false, reason: c.probe.docker === 'stopped' ? 'setup:docker_stopped' : 'setup:docker_missing' };
    if ('imagePreparation' in what) {
      const g = evaluateGate(c.probe, c.freeBytes ?? -1, []);
      return g.problems.some((x) => x.id === 'disk_low') ? { available: false, reason: 'setup:disk_low' } : { available: true, reason: null };
    }
    const action = getUserAction(what.actionId);
    if (!action || !('recipes' in action.run)) return { available: false, reason: 'not_applicable' };
    const recipes = action.run.recipes.map((id) => getRecipe(id)).filter((x): x is RecipeDef => x !== null).filter((x) => x.executor !== 'engine');
    if (recipes.length === 0) return { available: true, reason: null };
    const profiles = [...new Set(recipes.flatMap((x) => x.profiles))].filter((x) => x !== 'nexus-fwd');
    for (const pr of profiles) {
      const s = c.images.find((i) => i.profile === pr);
      if (!s || s.present !== true) return { available: false, reason: 'setup:image_missing' };
      if (s.digestMatches !== true) return { available: false, reason: 'setup:image_mismatch' };
    }
    const needMb = Math.max(...recipes.map((x) => x.limits?.memoryMb ?? 0));
    if (typeof c.probe.memoryBytes !== 'number' || needMb > (c.probe.memoryBytes / 2 ** 20) * SOLO_MEMORY_SHARE) {
      return { available: false, reason: 'setup:docker_memory_low' };
    }
    const floor = leaseFloorBytes(Math.max(...recipes.map((x) => x.limits?.outputMaxBytes ?? 0)));
    if (c.freeBytes === null || c.freeBytes < floor) return { available: false, reason: 'setup:disk_low' };
    return { available: true, reason: null };
  }

  // ---------- reads ----------

  private row(id: string): ExecJobRow | null {
    return (this.db.prepare('SELECT * FROM jobs WHERE id = ?').get(id) as ExecJobRow | undefined) ?? null;
  }

  private capabilityOf(j: ExecJobRow): Capability | null {
    const c = parseJson(j.capabilities_json);
    const first = Array.isArray(c) ? c[0] : null;
    return isPlainObject(first) && typeof first.action === 'string' && typeof first.recipe === 'string' ? first as unknown as Capability : null;
  }

  /** Loads a job and authorizes `action` with its STORED participation (unknown: 'not_found' only for a platform-wide reader). */
  private load(p: Principal, id: string, action: 'job.read' | 'job.cancel' | 'job.create'): ExecJobRow {
    const j = isStr(id) ? this.row(id) : null;
    if (!j) {
      this.deps.auth.require(p, action, PLATFORM, { entityType: 'job' });
      throw new PlatformError('not_found', 'job not found');
    }
    const ws = storedWorkspace(this.db, j.participation_id);
    this.access.require(p, j.project_id, action, ws ? { workspaceId: ws } : undefined);
    return j;
  }

  /** The headline of a job, from the job, its live attempt and the validations of its outputs. */
  headline(j: ExecJobRow): Headline {
    const live = liveAttemptOf(this.db, j.id);
    let checks: { failed: number; error: number; passed: number; pending: number } | undefined;
    if (j.state === 'completed' || j.state === 'partial') {
      const rel = `(v.job_id = @id OR v.job_id IN (SELECT id FROM jobs WHERE parent_job_id = @id)
        OR v.version_id IN (SELECT id FROM artifact_versions WHERE produced_by_job_id = @id))`;
      const latest = this.db.prepare(`SELECT v.status FROM validations v WHERE v.blocking = 1 AND ${rel}
        AND NOT EXISTS (SELECT 1 FROM validations w WHERE w.version_id = v.version_id AND w.validator_id = v.validator_id
          AND (w.finished_at > v.finished_at OR (w.finished_at = v.finished_at AND w.id > v.id)))`).all({ id: j.id }) as { status: string }[];
      const outs = this.db.prepare('SELECT status FROM artifact_versions WHERE produced_by_job_id = ?').all(j.id) as { status: string }[];
      const liveChildren = (this.db.prepare(`SELECT COUNT(*) AS n FROM jobs WHERE parent_job_id = ? AND state IN (${LIVE_JOB_STATES.map(() => '?').join(', ')})`)
        .get(j.id, ...LIVE_JOB_STATES) as { n: number }).n;
      checks = {
        failed: latest.filter((x) => x.status === 'failed').length + outs.filter((x) => x.status === 'failed').length,
        error: latest.filter((x) => x.status === 'error').length,
        passed: latest.filter((x) => x.status === 'passed').length,
        pending: outs.filter((x) => x.status === 'draft').length + liveChildren
      };
    }
    return headlineFrom({ state: j.state, phase: j.phase, liveAttempt: live?.state ?? null, checks });
  }

  private toExecJob(j: ExecJobRow): ExecJob {
    const cap = this.capabilityOf(j);
    return { ...this.deps.jobs.toJob(j), recipeId: j.recipe_id, actionId: cap?.action ?? null, phase: j.phase, nextAttemptAt: j.next_attempt_at,
      headline: this.headline(j) };
  }
}
