/**
 * Durable jobs: the record of one unit of work in a project's workspace.
 *
 * Nothing executes in B0b. There is no executor, scheduler, lease or timer: the
 * service records intent (create), lets the system principal move a job through
 * the state table (transition), lets a user cancel, and repairs state after a
 * restart. Execution phases attach to the hand-off points marked below.
 *
 * - Participation. A job runs in the ACTIVE participation of (project, workspace);
 *   the row is resolved here, never taken from the caller: no row is
 *   'not_participating', a withdrawn or complete row is 'participation_inactive'.
 * - Authority. Every operation authorizes BEFORE any transaction, with the
 *   workspace of the STORED participation row (jobs.participation_id), never a
 *   workspace the caller names (see ProjectAccess). An unknown job id is
 *   'not_found' only for a principal authorized for the action at platform
 *   scope; anyone else gets 'denied'. transition and recoverAfterRestart are
 *   system-only.
 * - Idempotency. create is idempotent by `idempotencyKey`: a re-sent intent returns
 *   the stored job (created: false) when it names the same work, and is a
 *   'conflict' when it does not.
 * - Inputs must be candidate or active versions of the job's project; their
 *   content hash is copied from the version into job_inputs.
 * - Agent runs. `agent.run` needs a live (non-terminal) session in the same
 *   project and workspace; the database CHECK and tr_jobs_insert back this up.
 * - State. The table in jobRules.ts mirrors job_state_transitions; tr_jobs_transition
 *   refuses anything else. -> leased counts an attempt; the first -> running sets
 *   started_at; a terminal state sets finished_at; retry_scheduled -> queued clears
 *   it. -> retry_scheduled needs canRetry (J.7).
 * - Redaction. Params are stored exactly; params holding anything secret-shaped
 *   are refused ('invalid', reason 'secret_in_params'). Runtime refs that look like
 *   secrets are refused. Errors are stored redacted (cap-free redactText).
 * - Reads. Every input version must be readable by the caller in its owner's
 *   workspace (ProjectAccess.requireVersionReadable, before the transaction).
 * - No resurrection. -> retry_scheduled and -> queued are refused while the
 *   participation is not active or the session has ended.
 * - Every mutation writes its activity row(s) in the same IMMEDIATE transaction
 *   (immediateTx), each carrying the job id and the session id when there is one.
 */
import type Database from 'better-sqlite3';
import type {
  Job, JobError, JobId, JobKind, JobRetryPolicy, JobState, ParticipationId, PlatformAction, Principal, ProjectId,
  SessionId, VersionInput, WorkspaceId
} from '../../../shared/nexus/platform';
import type { AuthService } from '../auth/authService';
import { appendActivityRow } from '../activity/writer';
import { containsSecret, redactSecretText, redactText } from '../activity/redact';
import { canonicalJson } from '../db/canonical';
import { newId } from '../db/ids';
import { immediateTx } from '../db/tx';
import { PlatformError } from '../errors';
import { ProjectAccess } from '../project/projectAccess';
import { assertExactJson, INLINE_MAX_BYTES } from '../artifact/versionRules';
import { canRetry, canTransitionJob, DEFAULT_RETRY, isJobState, TERMINAL_JOB_STATES } from './jobRules';

export interface CreateJobInput {
  kind: JobKind; projectId: ProjectId; workspaceId: WorkspaceId; idempotencyKey: string;
  sessionId?: SessionId;
  parentJobId?: JobId; retryOf?: JobId; recipeId?: string; validatorId?: string; priority?: 0 | 1 | 2;
  params?: unknown; inputs?: VersionInput[]; retry?: JobRetryPolicy; runtime?: { kind: string; ref?: string };
}

export const JOB_KINDS: readonly JobKind[] = Object.freeze(['agent.run', 'tool.run', 'validate', 'ingest'] as JobKind[]);
export const MAX_IDEMPOTENCY_KEY_CHARS = 200;
export const MAX_JOB_INPUTS = 256;
export const MAX_RETRY_ATTEMPTS = 20;
export const MAX_BACKOFF_MS = 86_400_000;
export const DEFAULT_LIST_LIMIT = 200;
export const MAX_LIST_LIMIT = 1000;
export const MAX_ERROR_MESSAGE_CHARS = 4096;
/** An error message is first cut to this many characters (64 Ki): the redactor's input is bounded. */
export const MAX_ERROR_INPUT_CHARS = 65536;
const LABEL_RE = /^[a-z][a-z0-9_.-]{0,63}$/;
const REF_RE = /^[A-Za-z0-9._:/@+=-]{1,256}$/;
const MAX_ROLE_CHARS = 64;
const PLATFORM = { type: 'platform' } as const;

/** A validated create request, as compared on an idempotent re-send. undefined / null: not supplied. */
interface Intent {
  kind: JobKind; projectId: string; workspaceId: string; sessionId: string | null; parentJobId: string | null; retryOf: string | null;
  recipeId: string | null; validatorId: string | null; priority: number | undefined; params: string | undefined;
  inputs: VersionInput[] | undefined; retry: JobRetryPolicy | undefined; runtime: { kind: string; ref: string | null } | null;
}

export interface JobRow {
  id: string; kind: JobKind; recipe_id: string | null; validator_id: string | null; project_id: string; workspace_id: string;
  participation_id: string | null; session_id: string | null; parent_job_id: string | null; retry_of: string | null;
  idempotency_key: string; requested_by: string; on_behalf_of: string; state: JobState; phase: string | null;
  outcome: string | null; error_json: string | null; priority: 0 | 1 | 2; params_json: string; retry_json: string;
  attempts: number; runtime_kind: string | null; runtime_ref: string | null; created_at: number; updated_at: number;
  state_changed_at: number; started_at: number | null; finished_at: number | null; cancel_requested_at: number | null;
}
interface PwRow { id: string; project_id: string; workspace_id: string; status: string }

const isStr = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
const isPlainObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const parse = (text: string | null): unknown => {
  if (text === null) return null;
  try { return JSON.parse(text) as unknown; } catch { return null; }   // json_valid CHECKs make this unreachable
};

// ---------- helpers shared with SessionService ----------

/**
 * The (project, workspace) participation row, whatever its status, or null.
 * Callers refuse a missing row with 'not_participating' and a non-active one with
 * 'participation_inactive', after authorizing at plain project scope.
 */
export function participationFor(db: Database.Database, projectId: ProjectId, workspaceId: WorkspaceId): PwRow | null {
  if (!isStr(projectId) || !isStr(workspaceId)) return null;
  return (db.prepare('SELECT id, project_id, workspace_id, status FROM project_workspaces WHERE project_id = ? AND workspace_id = ?')
    .get(projectId, workspaceId) as PwRow | undefined) ?? null;
}

/** The workspace of a STORED participation row: the only workspace a job or session authorizes with. */
export function storedWorkspace(db: Database.Database, participationId: ParticipationId | null): WorkspaceId | undefined {
  if (!isStr(participationId)) return undefined;
  return (db.prepare('SELECT workspace_id AS w FROM project_workspaces WHERE id = ?').get(participationId) as { w: string } | undefined)?.w;
}

/**
 * Resolves the participation a new job or session acts in, authorizing `action`
 * with the stored row's workspace. A missing or inactive row is refused only after
 * the caller passed plain project-scope authorization, so a stranger learns nothing.
 */
export function requireActiveParticipation(access: ProjectAccess, db: Database.Database, p: Principal, projectId: ProjectId,
  workspaceId: WorkspaceId, action: PlatformAction): PwRow {
  const pw = participationFor(db, projectId, workspaceId);
  if (!pw || pw.status !== 'active') {
    access.require(p, projectId, action);
    if (!pw) throw new PlatformError('not_participating', 'the project does not take part in that workspace');
    throw new PlatformError('participation_inactive', `the participation is ${pw.status}`, { participationId: pw.id });
  }
  access.require(p, pw.project_id, action, { workspaceId: pw.workspace_id });
  return pw;
}

/** An idempotency key: a non-empty string of at most MAX_IDEMPOTENCY_KEY_CHARS. */
export function validateKey(k: unknown): string {
  if (!isStr(k) || k.length > MAX_IDEMPOTENCY_KEY_CHARS) throw new PlatformError('invalid', `idempotencyKey must be 1 to ${MAX_IDEMPOTENCY_KEY_CHARS} characters`);
  return k;
}

/** runtime: { kind: label, ref?: id-like string }; nothing else. */
export function validateRuntime(r: unknown): { kind: string; ref: string | null } | null {
  if (r === undefined) return null;
  if (!isPlainObject(r)) throw new PlatformError('invalid', 'runtime must be an object');
  for (const k of Object.keys(r)) if (k !== 'kind' && k !== 'ref') throw new PlatformError('invalid', `runtime has an unknown field ${k.slice(0, 32)}`);
  if (typeof r.kind !== 'string' || !LABEL_RE.test(r.kind)) throw new PlatformError('invalid', 'runtime.kind must be a short lowercase label');
  return { kind: r.kind, ref: r.ref === undefined ? null : validateRef(r.ref, 'runtime.ref') };
}

/** A runtime's own reference (session id, process ref): a short id-like string that is not secret-shaped. */
export function validateRef(v: unknown, what = 'runtimeRef'): string {
  if (typeof v !== 'string' || !REF_RE.test(v)) throw new PlatformError('invalid', `${what} must be an id-like string of at most 256 characters`);
  // A ref is stored as is, so one the redactor would touch (a key, a token, long hex) is refused.
  if (redactText(v) !== v) throw new PlatformError('invalid', `${what} looks like a secret`, { reason: 'secret_in_ref' });
  return v;
}

/**
 * { code, message } stored redacted, for jobs and sessions alike. The code is a
 * label. The message is handled in this order, so a secret can never straddle a cut:
 *   1. bound the input: cut to MAX_ERROR_INPUT_CHARS (64 Ki characters; longer
 *      messages are truncated, not refused, so an error report never fails a transition);
 *   2. redact the WHOLE bounded message with redactSecretText (redactText plus: an
 *      unterminated private-key block is redacted to the end of the string, which
 *      also covers a key cut by step 1);
 *   3. only then cut to MAX_ERROR_MESSAGE_CHARS for storage.
 * It is never replaced by a size marker.
 */
export function redactedErrorJson(e: unknown): string {
  if (!isPlainObject(e) || typeof e.code !== 'string' || typeof e.message !== 'string') {
    throw new PlatformError('invalid', 'error must be { code, message }');
  }
  if (!LABEL_RE.test(e.code)) throw new PlatformError('invalid', 'error.code must be a short lowercase label');
  const redacted = redactSecretText(e.message.slice(0, MAX_ERROR_INPUT_CHARS));
  return JSON.stringify({ code: e.code, message: redacted.slice(0, MAX_ERROR_MESSAGE_CHARS) });
}

export function parseError(text: string | null): JobError | null {
  const e = parse(text);
  return isPlainObject(e) && typeof e.code === 'string' && typeof e.message === 'string' ? { code: e.code, message: e.message } : null;
}

export function validateOutcome(v: unknown): string {
  if (typeof v !== 'string' || !LABEL_RE.test(v)) throw new PlatformError('invalid', 'outcome must be a short lowercase label');
  return v;
}

export function listLimit(v: unknown): number {
  const limit = v === undefined ? DEFAULT_LIST_LIMIT : v;
  if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > MAX_LIST_LIMIT) {
    throw new PlatformError('invalid', `limit must be 1 to ${MAX_LIST_LIMIT}`);
  }
  return limit;
}

function validateRetry(r: unknown): JobRetryPolicy {
  if (r === undefined) return { ...DEFAULT_RETRY, backoffMs: [] };
  if (!isPlainObject(r)) throw new PlatformError('invalid', 'retry must be an object');
  for (const k of Object.keys(r)) if (!['idempotent', 'maxAttempts', 'backoffMs'].includes(k)) throw new PlatformError('invalid', 'retry has an unknown field');
  if (typeof r.idempotent !== 'boolean') throw new PlatformError('invalid', 'retry.idempotent must be a boolean');
  if (typeof r.maxAttempts !== 'number' || !Number.isInteger(r.maxAttempts) || r.maxAttempts < 1 || r.maxAttempts > MAX_RETRY_ATTEMPTS) {
    throw new PlatformError('invalid', `retry.maxAttempts must be 1 to ${MAX_RETRY_ATTEMPTS}`);
  }
  const b = r.backoffMs === undefined ? [] : r.backoffMs;
  if (!Array.isArray(b) || b.length > MAX_RETRY_ATTEMPTS
    || !b.every((x) => typeof x === 'number' && Number.isInteger(x) && x >= 0 && x <= MAX_BACKOFF_MS)) {
    throw new PlatformError('invalid', `retry.backoffMs must be at most ${MAX_RETRY_ATTEMPTS} whole delays of 0 to ${MAX_BACKOFF_MS} ms`);
  }
  return { idempotent: r.idempotent, maxAttempts: r.maxAttempts, backoffMs: [...b] as number[] };
}

function parseRetry(text: string): JobRetryPolicy {
  const r = parse(text);
  if (isPlainObject(r) && typeof r.idempotent === 'boolean' && typeof r.maxAttempts === 'number' && Array.isArray(r.backoffMs)) {
    return { idempotent: r.idempotent, maxAttempts: r.maxAttempts, backoffMs: r.backoffMs as number[] };
  }
  return { ...DEFAULT_RETRY, backoffMs: [] };
}

/**
 * Params: an exact JSON object (nothing coerced), at most INLINE_MAX_BYTES, stored
 * EXACTLY. A params object that holds anything secret-shaped (a secret-named key,
 * or a key or string the redactor would change) is refused with
 * detail.reason 'secret_in_params': secrets never reach params_json. Harmless keys
 * that match the secret-key pattern (for example `tokenizer`) are refused too;
 * callers rename them.
 */
function paramsJson(v: unknown): string {
  if (v === undefined) return '{}';
  if (!isPlainObject(v)) throw new PlatformError('invalid', 'params must be an object');
  assertExactJson(v, 'params');
  const text = JSON.stringify(v);
  if (Buffer.byteLength(text, 'utf8') > INLINE_MAX_BYTES) throw new PlatformError('invalid', `params exceed ${INLINE_MAX_BYTES} bytes`);
  if (containsSecret(v)) throw new PlatformError('invalid', 'params hold a secret-shaped key or value', { reason: 'secret_in_params' });
  return text;
}

function optionalLabel(v: unknown, what: string): string | null {
  if (v === undefined) return null;
  if (typeof v !== 'string' || !LABEL_RE.test(v)) throw new PlatformError('invalid', `${what} must be a short lowercase label`);
  return v;
}

function optionalId(v: unknown, what: string): string | null {
  if (v === undefined) return null;
  if (!isStr(v) || v.length > 128) throw new PlatformError('invalid', `${what} must be an id`);
  return v;
}

/**
 * Inside a caller's IMMEDIATE transaction (requestCancel, SessionService.cancel):
 * cancel one non-terminal job and write one activity row carrying `sessionId`.
 * The caller has already authorized the cancel; this is not an entry point.
 *
 * EXECUTOR HAND-OFF (architecture J.5): B0b has no executor, so the job goes
 * straight to cancelled. When execution lands, the executor is signalled right
 * after cancel_requested_at is persisted below, and the move to a terminal state
 * happens when the executor confirms (or its lease expires), not here.
 */
export function cancelJobInTx(db: Database.Database, p: Principal, j: JobRow, now: number, sessionId: string | null): void {
  if (!db.inTransaction) throw new PlatformError('platform_unavailable', 'cancelJobInTx needs an open transaction');
  if (j.cancel_requested_at === null) {
    db.prepare('UPDATE jobs SET cancel_requested_at = ?, updated_at = ? WHERE id = ?').run(now, now, j.id);
  }
  // <- executor hand-off goes here (J.5).
  db.prepare(`UPDATE jobs SET state = 'cancelled', outcome = 'cancelled', state_changed_at = ?, updated_at = ?, finished_at = ?
    WHERE id = ?`).run(now, now, now, j.id);
  appendActivityRow(db, { actorKind: p.kind, actorId: p.id, onBehalfOf: j.on_behalf_of, jobId: j.id, sessionId,
    attemptN: j.attempts, projectId: j.project_id, workspaceId: j.workspace_id, entityType: 'job', entityId: j.id,
    action: 'job.cancel', status: 'cancelled', details: { from: j.state, to: 'cancelled' } }, now);
}

export class JobService {
  private readonly access: ProjectAccess;

  constructor(private readonly db: Database.Database, private readonly deps: { auth: AuthService; now: () => number }) {
    this.access = new ProjectAccess(db, { auth: deps.auth });
  }

  create(p: Principal, i: CreateJobInput): { job: Job; created: boolean } {
    if (!isPlainObject(i)) throw new PlatformError('invalid', 'input must be an object');
    if (!JOB_KINDS.includes(i.kind)) throw new PlatformError('invalid', 'unknown job kind');
    if (!isStr(i.projectId) || !isStr(i.workspaceId)) throw new PlatformError('invalid', 'projectId and workspaceId are required');
    const key = validateKey(i.idempotencyKey);
    const sessionId = optionalId(i.sessionId, 'sessionId');
    if (i.kind === 'agent.run' && sessionId === null) throw new PlatformError('invalid', 'an agent.run job needs its session');
    const parentJobId = optionalId(i.parentJobId, 'parentJobId');
    const retryOf = optionalId(i.retryOf, 'retryOf');
    const recipeId = optionalLabel(i.recipeId, 'recipeId');
    const validatorId = optionalLabel(i.validatorId, 'validatorId');
    const priority = i.priority === undefined ? 1 : i.priority;
    if (priority !== 0 && priority !== 1 && priority !== 2) throw new PlatformError('invalid', 'priority must be 0, 1 or 2');
    const params = paramsJson(i.params);
    const retry = validateRetry(i.retry);
    const runtime = validateRuntime(i.runtime);
    const inputs = this.validateInputs(i.inputs);

    const intent: Intent = { kind: i.kind, projectId: i.projectId, workspaceId: i.workspaceId, sessionId, parentJobId, retryOf,
      recipeId, validatorId, priority: i.priority, params: i.params === undefined ? undefined : params,
      inputs: i.inputs === undefined ? undefined : inputs, retry: i.retry === undefined ? undefined : retry, runtime };

    // A re-sent intent: authorize against the stored job's participation, then compare.
    const prior = this.rowByKey(key);
    if (prior) {
      this.authorizeRow(p, prior, 'job.create');
      this.requireSameIntent(prior, p, intent);
      return { job: this.toJob(prior), created: false };
    }

    const pw = requireActiveParticipation(this.access, this.db, p, i.projectId, i.workspaceId, 'job.create');
    // Read-only references, checked after authorization so a stranger learns nothing about them.
    if (sessionId !== null) {
      this.requireLiveSessionFor(sessionId, pw);
      this.requireSessionPrincipal(p, sessionId, pw);
    }
    if (parentJobId !== null) this.requireParentJob(parentJobId, pw, sessionId);
    if (retryOf !== null) {
      const r = this.requireRelatedJob(retryOf, pw.project_id, 'retried job');
      if (r.kind !== i.kind) throw new PlatformError('invalid', 'a retry has the kind of the job it retries');
    }
    // Every input must be readable by the caller in its owner's workspace ('denied', audited).
    for (const x of inputs) this.access.requireVersionReadable(p, x.versionId, pw.project_id);
    const now = this.deps.now();
    return immediateTx(this.db, () => {
      const again = this.rowByKey(key);
      if (again) {
        this.requireSameIntent(again, p, intent);
        return { job: this.toJob(again), created: false };
      }
      const live = this.db.prepare('SELECT status FROM project_workspaces WHERE id = ?').get(pw.id) as { status: string } | undefined;
      if (!live || live.status !== 'active') throw new PlatformError('participation_inactive', 'the participation is no longer active');
      if (sessionId !== null) this.requireLiveSessionFor(sessionId, pw);
      const versions = inputs.map((x) => ({ ...x, contentHash: this.requireInputVersion(x.versionId, pw.project_id) }));
      const id = newId(now);
      this.db.prepare(`INSERT INTO jobs (id, kind, recipe_id, validator_id, project_id, workspace_id, participation_id, session_id,
          parent_job_id, retry_of, idempotency_key, requested_by, on_behalf_of, state, priority, params_json, retry_json,
          attempts, runtime_kind, runtime_ref, created_at, updated_at, state_changed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, 0, ?, ?, ?, ?, ?)`)
        .run(id, i.kind, recipeId, validatorId, pw.project_id, pw.workspace_id, pw.id, sessionId, parentJobId, retryOf, key,
          p.id, p.id, priority, params, JSON.stringify(retry), runtime?.kind ?? null, runtime?.ref ?? null, now, now, now);
      const ins = this.db.prepare('INSERT INTO job_inputs (job_id, version_id, role, content_hash) VALUES (?, ?, ?, ?)');
      for (const v of versions) ins.run(id, v.versionId, v.role, v.contentHash);
      appendActivityRow(this.db, { actorKind: p.kind, actorId: p.id, onBehalfOf: p.id, jobId: id, sessionId,
        projectId: pw.project_id, workspaceId: pw.workspace_id, entityType: 'job', entityId: id, action: 'job.create',
        status: 'succeeded', details: { kind: i.kind, priority, inputs: versions.length, retryable: retry.idempotent } }, now);
      return { job: this.toJob(this.row(id)!), created: true };
    });
  }

  get(p: Principal, id: JobId): Job {
    return this.toJob(this.load(p, id, 'job.read'));
  }

  listByProject(p: Principal, projectId: ProjectId, o?: { states?: JobState[]; kind?: JobKind; limit?: number }): Job[] {
    const limit = listLimit(o?.limit);
    const states = o?.states;
    if (states !== undefined && (!Array.isArray(states) || states.length === 0 || !states.every(isJobState))) {
      throw new PlatformError('invalid', 'states must be a non-empty list of job states');
    }
    if (o?.kind !== undefined && !JOB_KINDS.includes(o.kind)) throw new PlatformError('invalid', 'unknown job kind');
    // Project scope: a list spans every participation, so no single stored workspace applies.
    this.access.require(p, projectId, 'job.read');
    const where = ['project_id = ?']; const args: unknown[] = [projectId];
    if (states !== undefined) { where.push(`state IN (${states.map(() => '?').join(', ')})`); args.push(...states); }
    if (o?.kind !== undefined) { where.push('kind = ?'); args.push(o.kind); }
    const rows = this.db.prepare(`SELECT * FROM jobs WHERE ${where.join(' AND ')} ORDER BY created_at DESC, id DESC LIMIT ?`)
      .all(...args, limit) as JobRow[];
    return rows.map((r) => this.toJob(r));
  }

  /** The jobs of an agent session, oldest first (ix_jobs_session). Authorized with the session's stored participation. */
  listBySession(p: Principal, sessionId: SessionId): Job[] {
    const s = isStr(sessionId)
      ? this.db.prepare('SELECT id, project_id, participation_id FROM agent_sessions WHERE id = ?').get(sessionId) as
        { id: string; project_id: string; participation_id: string } | undefined
      : undefined;
    if (!s) {
      this.deps.auth.require(p, 'job.read', PLATFORM);
      throw new PlatformError('not_found', 'session not found');
    }
    const ws = storedWorkspace(this.db, s.participation_id);
    this.access.require(p, s.project_id, 'job.read', ws ? { workspaceId: ws } : undefined);
    return (this.db.prepare('SELECT * FROM jobs WHERE session_id = ? ORDER BY created_at, id').all(s.id) as JobRow[]).map((r) => this.toJob(r));
  }

  /** System only. Moves a job along the state table; see the header for the column rules. */
  transition(system: Principal, id: JobId, to: JobState, d?: { outcome?: string; error?: JobError; runtimeRef?: string }): Job {
    const t = this.prepareTransition(system, id, to, d);
    const now = this.deps.now();
    return immediateTx(this.db, () => {
      const j = this.row(t.stored.id)!;
      this.applyTransition(system, j, to, now, { ...t.o, action: 'job.transition' });
      return this.toJob(this.row(j.id)!);
    });
  }

  /**
   * @internal For the execution core only (ExecutionService), INSIDE the caller's IMMEDIATE transaction.
   * The same rules, byte for byte, as `create`: it IS `create`, whose own immediateTx becomes a savepoint of
   * the caller's transaction. The caller authorizes BEFORE opening its transaction (a denial raised in here
   * is audited only after the transaction ends).
   */
  createTx(p: Principal, i: CreateJobInput): { job: Job; created: boolean } {
    if (!this.db.inTransaction) throw new PlatformError('platform_unavailable', 'createTx needs an open transaction');
    return this.create(p, i);
  }

  /**
   * @internal For the execution core only, INSIDE the caller's IMMEDIATE transaction. The same rules as
   * `transition` (system only, the state table, canRetry, no resurrection, the column rules and one activity
   * row). `expectState` makes the UPDATE a compare-and-set (`AND state = ?`, exactly one row changed, else
   * 'conflict'); `action` names the activity row (default 'job.transition'). `now` defaults to the clock.
   */
  transitionTx(system: Principal, id: JobId, to: JobState, d?: { outcome?: string; error?: JobError; runtimeRef?: string },
    o?: { expectState?: JobState; action?: string; now?: number }): Job {
    if (!this.db.inTransaction) throw new PlatformError('platform_unavailable', 'transitionTx needs an open transaction');
    const t = this.prepareTransition(system, id, to, d);
    const j = this.row(t.stored.id)!;
    if (o?.expectState !== undefined && j.state !== o.expectState) {
      throw new PlatformError('conflict', `the job is ${j.state}, not ${o.expectState}`, { from: j.state, expected: o.expectState });
    }
    this.applyTransition(system, j, to, o?.now ?? this.deps.now(), { ...t.o, action: o?.action ?? 'job.transition' }, o?.expectState);
    return this.toJob(this.row(j.id)!);
  }

  private prepareTransition(system: Principal, id: JobId, to: JobState, d?: { outcome?: string; error?: JobError; runtimeRef?: string }):
    { stored: JobRow; o: { outcome: string | null; errorJson: string | null; runtimeRef: string | null } } {
    if (!isJobState(to)) throw new PlatformError('invalid', 'unknown job state');
    if (d !== undefined && !isPlainObject(d)) throw new PlatformError('invalid', 'details must be an object');
    const outcome = d?.outcome === undefined ? null : validateOutcome(d.outcome);
    const errorJson = d?.error === undefined ? null : redactedErrorJson(d.error);
    const runtimeRef = d?.runtimeRef === undefined ? null : validateRef(d.runtimeRef);
    const stored = this.load(system, id, 'job.transition');
    return { stored, o: { outcome, errorJson, runtimeRef } };
  }

  /**
   * A user's cancel. cancel_requested_at and the activity row are written first,
   * then the job moves to cancelled, all in one transaction. A terminal job is
   * returned unchanged. It does NOT cascade to the job's children
   * (parent_job_id): child cancellation is the J.5 executor follow-up. A session
   * cancel covers a whole tree, because parent and children share the session.
   */
  requestCancel(p: Principal, id: JobId): Job {
    const stored = this.load(p, id, 'job.cancel');
    const now = this.deps.now();
    return immediateTx(this.db, () => {
      const j = this.row(stored.id)!;
      if (TERMINAL_JOB_STATES.has(j.state)) return this.toJob(j);
      cancelJobInTx(this.db, p, j, now, j.session_id);
      return this.toJob(this.row(j.id)!);
    });
  }

  /**
   * After a restart nothing is executing: running and awaiting_approval jobs become
   * interrupted (outcome 'interrupted'), leased jobs go back to queued (R.2 step 4);
   * queued and retry_scheduled jobs are untouched. System only; idempotent. Correct
   * only while nothing executes across restarts: the execution phase replaces it
   * with the full R.2 routine.
   */
  recoverAfterRestart(system: Principal): { interrupted: number; requeued: number } {
    this.deps.auth.require(system, 'job.transition', PLATFORM, { entityType: 'job', details: { op: 'recover_after_restart' } });
    const now = this.deps.now();
    return immediateTx(this.db, () => {
      const out = { interrupted: 0, requeued: 0 };
      const rows = this.db.prepare("SELECT * FROM jobs WHERE state IN ('leased', 'running', 'awaiting_approval') ORDER BY created_at, id")
        .all() as JobRow[];
      for (const j of rows) {
        // A leased job goes back to queued unless it could never run again (its session
        // ended or its participation is gone): then it is interrupted like a running one.
        if (j.state === 'leased' && this.resurrectionBlock(j) === null) {
          this.applyTransition(system, j, 'queued', now, { outcome: null, errorJson: null, runtimeRef: null, action: 'job.recover' });
          out.requeued++;
        } else {
          this.applyTransition(system, j, 'interrupted', now, { outcome: 'interrupted', errorJson: null, runtimeRef: null, action: 'job.recover' });
          out.interrupted++;
        }
      }
      return out;
    });
  }

  // ---------- helpers ----------

  private applyTransition(actor: Principal, j: JobRow, to: JobState, now: number,
    o: { outcome: string | null; errorJson: string | null; runtimeRef: string | null; action: string }, expectState?: JobState): void {
    if (!canTransitionJob(j.state, to)) {
      throw new PlatformError('illegal_transition', `a ${j.state} job cannot move to ${to}`, { from: j.state, to });
    }
    if (to === 'retry_scheduled' && !canRetry({ kind: j.kind, attempts: j.attempts, retry: parseRetry(j.retry_json) })) {
      throw new PlatformError('illegal_transition', 'the job is not retryable', { from: j.state, to, reason: 'not_retryable' });
    }
    if (to === 'retry_scheduled' || to === 'queued') {
      // No resurrection: a job whose participation is gone or whose session ended never becomes runnable again.
      const reason = this.resurrectionBlock(j);
      if (reason !== null) throw new PlatformError('illegal_transition', `the job cannot run again: ${reason}`, { from: j.state, to, reason });
    }
    const sets = ['state = ?', 'state_changed_at = ?', 'updated_at = ?']; const args: unknown[] = [to, now, now];
    let attempts = j.attempts;
    if (to === 'leased') { sets.push('attempts = attempts + 1'); attempts++; }
    if (to === 'running' && j.started_at === null) { sets.push('started_at = ?'); args.push(now); }
    if (TERMINAL_JOB_STATES.has(to)) {
      sets.push('finished_at = ?', 'outcome = ?'); args.push(now, o.outcome ?? to);
    } else if (o.outcome !== null) {
      sets.push('outcome = ?'); args.push(o.outcome);
    }
    if (j.state === 'retry_scheduled' && to === 'queued') {
      // A new attempt starts clean; the previous outcome stays in the activity log.
      sets.push('finished_at = NULL');
      if (o.outcome === null) sets.push('outcome = NULL');
      if (o.errorJson === null) sets.push('error_json = NULL');
    }
    if (o.errorJson !== null) { sets.push('error_json = ?'); args.push(o.errorJson); }
    if (o.runtimeRef !== null) { sets.push('runtime_ref = ?'); args.push(o.runtimeRef); }
    if (expectState === undefined) {
      this.db.prepare(`UPDATE jobs SET ${sets.join(', ')} WHERE id = ?`).run(...args, j.id);
    } else if (this.db.prepare(`UPDATE jobs SET ${sets.join(', ')} WHERE id = ? AND state = ?`).run(...args, j.id, expectState).changes !== 1) {
      throw new PlatformError('conflict', `the job left ${expectState} before the change`, { expected: expectState });
    }
    appendActivityRow(this.db, { actorKind: actor.kind, actorId: actor.id, onBehalfOf: j.on_behalf_of, jobId: j.id,
      sessionId: j.session_id, attemptN: attempts, projectId: j.project_id, workspaceId: j.workspace_id, entityType: 'job',
      entityId: j.id, action: o.action, status: 'succeeded',
      details: { from: j.state, to, outcome: TERMINAL_JOB_STATES.has(to) ? (o.outcome ?? to) : o.outcome,
        error: o.errorJson !== null ? parseError(o.errorJson)?.code : undefined } }, now);
  }

  /** Why a job may not become runnable again, or null: 'participation_inactive' or 'session_ended'. */
  private resurrectionBlock(j: JobRow): 'participation_inactive' | 'session_ended' | null {
    const pw = j.participation_id === null ? undefined
      : this.db.prepare('SELECT status FROM project_workspaces WHERE id = ?').get(j.participation_id) as { status: string } | undefined;
    if (!pw || pw.status !== 'active') return 'participation_inactive';
    if (j.session_id !== null) {
      const s = this.db.prepare(`SELECT st.terminal FROM agent_sessions a JOIN agent_session_states st ON st.state = a.status
        WHERE a.id = ?`).get(j.session_id) as { terminal: number } | undefined;
      if (!s || s.terminal === 1) return 'session_ended';
    }
    return null;
  }

  row(id: string): JobRow | null {
    return (this.db.prepare('SELECT * FROM jobs WHERE id = ?').get(id) as JobRow | undefined) ?? null;
  }

  private rowByKey(key: string): JobRow | null {
    return (this.db.prepare('SELECT * FROM jobs WHERE idempotency_key = ?').get(key) as JobRow | undefined) ?? null;
  }

  /** Loads a job and authorizes `action` with its STORED participation's workspace. Outside any transaction. */
  private load(p: Principal, id: JobId, action: PlatformAction): JobRow {
    const j = isStr(id) ? this.row(id) : null;
    if (!j) {
      this.deps.auth.require(p, action, PLATFORM);
      throw new PlatformError('not_found', 'job not found');
    }
    this.authorizeRow(p, j, action);
    return j;
  }

  private authorizeRow(p: Principal, j: JobRow, action: PlatformAction): void {
    const ws = storedWorkspace(this.db, j.participation_id);
    this.access.require(p, j.project_id, action, ws ? { workspaceId: ws } : undefined);
  }

  /**
   * A re-sent create must name the same work. Always compared: requester, kind,
   * project, workspace, session, parent and retryOf. Compared when supplied:
   * recipe, validator, priority, inputs (as a set), retry, runtime and the RAW params.
   */
  private requireSameIntent(j: JobRow, p: Principal, x: Intent): void {
    const inputsKey = (list: { versionId: string; role: string }[]): string =>
      JSON.stringify(list.map((v) => [v.versionId, v.role]).sort((a, b) => (a.join('\u0000') < b.join('\u0000') ? -1 : 1)));
    const stored = (): { versionId: string; role: string }[] =>
      this.db.prepare('SELECT version_id AS versionId, role FROM job_inputs WHERE job_id = ?').all(j.id) as { versionId: string; role: string }[];
    const same = j.kind === x.kind && j.project_id === x.projectId && j.workspace_id === x.workspaceId && j.requested_by === p.id
      && j.session_id === x.sessionId && j.parent_job_id === x.parentJobId && j.retry_of === x.retryOf
      && (x.recipeId === null || j.recipe_id === x.recipeId)
      && (x.validatorId === null || j.validator_id === x.validatorId)
      && (x.priority === undefined || j.priority === x.priority)
      && (x.params === undefined || canonicalJson(parse(j.params_json)) === canonicalJson(parse(x.params)))
      && (x.retry === undefined || canonicalJson(parseRetry(j.retry_json)) === canonicalJson(x.retry))
      && (x.runtime === null || (j.runtime_kind === x.runtime.kind && (x.runtime.ref === null || j.runtime_ref === x.runtime.ref)))
      && (x.inputs === undefined || inputsKey(stored()) === inputsKey(x.inputs));
    if (!same) throw new PlatformError('conflict', 'that idempotency key already names different work', { jobId: j.id });
  }

  /**
   * Only the session's own principal (or the system) adds jobs to it. Refused with
   * 'denied' and one audited row (reason 'not_session_principal'). Before the transaction.
   */
  private requireSessionPrincipal(p: Principal, sessionId: string, pw: PwRow): void {
    const s = this.db.prepare('SELECT principal_id FROM agent_sessions WHERE id = ?').get(sessionId) as { principal_id: string } | undefined;
    if (!s || s.principal_id === p.id || p.kind === 'system') return;
    const audited = this.deps.auth.auditDenial(p, { action: 'job.create', reason: 'not_session_principal', sessionId,
      projectId: pw.project_id, workspaceId: pw.workspace_id, entityType: 'job' });
    throw new PlatformError('denied', 'only the session principal adds jobs to a session', { reason: 'not_session_principal', audited });
  }

  /** A parent job is in the same project, the same participation and the same session (both null or equal). */
  private requireParentJob(parentJobId: string, pw: PwRow, sessionId: string | null): void {
    const parent = this.requireRelatedJob(parentJobId, pw.project_id, 'parent job');
    if (parent.participation_id !== pw.id) throw new PlatformError('invalid', 'a parent job acts for the same participation');
    if (parent.session_id !== sessionId) throw new PlatformError('invalid', 'a parent job belongs to the same session');
  }

  private requireRelatedJob(id: string, projectId: string, what: string): JobRow {
    const r = this.row(id);
    if (!r) throw new PlatformError('not_found', `${what} not found`);
    if (r.project_id !== projectId) throw new PlatformError('invalid', `the ${what} belongs to another project`);
    return r;
  }

  /** Inside the transaction: the session exists, is in the job's project and workspace, and has not ended. */
  private requireLiveSessionFor(sessionId: string, pw: PwRow): void {
    const s = this.db.prepare(`SELECT a.project_id, a.workspace_id, a.participation_id, st.terminal FROM agent_sessions a
      JOIN agent_session_states st ON st.state = a.status WHERE a.id = ?`).get(sessionId) as
      { project_id: string; workspace_id: string; participation_id: string; terminal: number } | undefined;
    if (!s) throw new PlatformError('not_found', 'session not found');
    if (s.project_id !== pw.project_id || s.workspace_id !== pw.workspace_id || s.participation_id !== pw.id) {
      throw new PlatformError('invalid', 'the session belongs to another project or workspace');
    }
    if (s.terminal === 1) throw new PlatformError('conflict', 'the session has ended');
  }

  /** Inside the transaction: an input is a candidate or active version of the project. Returns its content hash. */
  private requireInputVersion(versionId: string, projectId: string): string {
    const v = this.db.prepare('SELECT project_id, status, content_hash FROM artifact_versions WHERE id = ?').get(versionId) as
      { project_id: string; status: string; content_hash: string } | undefined;
    if (!v) throw new PlatformError('not_found', 'input version not found');
    if (v.project_id !== projectId) throw new PlatformError('invalid', 'inputs come from the job project');
    if (v.status !== 'candidate' && v.status !== 'active') throw new PlatformError('invalid', 'an input must be a candidate or active version');
    return v.content_hash;
  }

  private validateInputs(raw: unknown): VersionInput[] {
    if (raw === undefined) return [];
    if (!Array.isArray(raw) || raw.length > MAX_JOB_INPUTS) throw new PlatformError('invalid', `inputs must be a list of at most ${MAX_JOB_INPUTS}`);
    const seen = new Set<string>();
    return raw.map((x: unknown) => {
      if (!isPlainObject(x) || !isStr(x.versionId) || !isStr(x.role) || x.role.length > MAX_ROLE_CHARS) {
        throw new PlatformError('invalid', 'each input needs a versionId and a role of at most 64 characters');
      }
      const k = `${x.versionId}\u0000${x.role}`;
      if (seen.has(k)) throw new PlatformError('invalid', 'duplicate input');
      seen.add(k);
      return { versionId: x.versionId, role: x.role };
    });
  }

  toJob(r: JobRow): Job {
    const inputs = (this.db.prepare('SELECT version_id, role, content_hash FROM job_inputs WHERE job_id = ? ORDER BY rowid').all(r.id) as
      { version_id: string; role: string; content_hash: string }[]).map((x) => ({ versionId: x.version_id, role: x.role, contentHash: x.content_hash }));
    const params = parse(r.params_json);
    return {
      id: r.id, kind: r.kind, projectId: r.project_id, workspaceId: r.workspace_id, participationId: r.participation_id,
      sessionId: r.session_id, parentJobId: r.parent_job_id, retryOf: r.retry_of, idempotencyKey: r.idempotency_key,
      requestedBy: r.requested_by, onBehalfOf: r.on_behalf_of, state: r.state, outcome: r.outcome, error: parseError(r.error_json),
      priority: r.priority, params: isPlainObject(params) ? params : {}, retry: parseRetry(r.retry_json), attempts: r.attempts,
      runtimeKind: r.runtime_kind, runtimeRef: r.runtime_ref, inputs, createdAt: r.created_at, updatedAt: r.updated_at,
      stateChangedAt: r.state_changed_at, startedAt: r.started_at, finishedAt: r.finished_at, cancelRequestedAt: r.cancel_requested_at
    };
  }
}
