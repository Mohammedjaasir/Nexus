/**
 * Job attempts (schema v9 `job_attempts`): one row per try, holding what actually executed.
 * Every function here runs INSIDE the caller's IMMEDIATE transaction; none opens its own.
 *
 * - Insert at lease (`insertAttemptTx`). The database only accepts the insert while the job is
 *   `leased` and `jobs.attempts = n` (tr_attempts_insert), so the caller moves the job to
 *   `leased` (which counts the attempt) and inserts attempt n in ONE transaction.
 * - Transitions (`transitionAttemptTx`) follow ATTEMPT_TRANSITIONS (mirrored by
 *   tr_attempts_transition). A terminal state sets `finished_at`; `running` sets
 *   `started_at`. `running` and `succeeded` need `sandbox_json` and `environment_json`, and
 *   `succeeded` needs an exit code and an outcome (the DDL CHECKs); this module refuses those
 *   cases first with a clear error. Each transition writes one `attempt.transition` event.
 * - Adopt (`adoptAttemptTx`, recovery): a live attempt's `lease_owner` moves to this boot.
 * - Heartbeat (`heartbeatTx`): extends the lease and records `heartbeat_at` and byte counts
 *   only. No activity row and no event (volume).
 * - A finished attempt is immutable (tr_attempts_terminal_frozen), so recovery can rebuild
 *   state from the rows: live attempts are exactly `starting` and `running`.
 */
import type Database from 'better-sqlite3';
import type { AttemptState } from '../../../shared/nexus/platform';
import { redactedErrorJson } from '../jobs/jobService';
import { PlatformError } from '../errors';
import { canTransitionAttempt, TERMINAL_ATTEMPT_STATES } from './attemptRules';
import { appendJobEventTx } from './events';

/** A lease is good for this long; heartbeats extend it. */
export const LEASE_MS = 60_000;
/** A gap this long between heartbeats of a running attempt writes one `attempt.heartbeat_gap` event. */
export const HEARTBEAT_GAP_MS = 45_000;
export const MAX_SANDBOX_JSON_CHARS = 32_768;
export const MAX_ENVIRONMENT_JSON_CHARS = 8_192;

export interface AttemptRow {
  id: string; job_id: string; n: number; state: AttemptState; boot_id: string; lease_owner: string; lease_expires_at: number;
  heartbeat_at: number | null; container_id: string | null; exit_code: number | null; signal: string | null; oom_killed: number | null;
  outcome: string | null; error_json: string | null; sandbox_json: string | null; environment_json: string | null;
  runtime_kind: string | null; runtime_ref: string | null; log_path: string | null; log_bytes: number; out_bytes: number;
  usage_json: string | null; created_at: number; started_at: number | null; finished_at: number | null; updated_at: number;
}

export function attemptRow(db: Database.Database, id: string): AttemptRow | null {
  return (db.prepare('SELECT * FROM job_attempts WHERE id = ?').get(id) as AttemptRow | undefined) ?? null;
}

export function liveAttemptOf(db: Database.Database, jobId: string): AttemptRow | null {
  return (db.prepare("SELECT * FROM job_attempts WHERE job_id = ? AND state IN ('starting','running')").get(jobId) as AttemptRow | undefined) ?? null;
}

function boundedJson(v: unknown, max: number, what: string): string {
  const text = JSON.stringify(v);
  if (typeof text !== 'string' || text.length > max) throw new PlatformError('invalid', `${what} exceeds ${max} characters`, { field: what });
  return text;
}

const requireTx = (db: Database.Database, what: string): void => {
  if (!db.inTransaction) throw new PlatformError('platform_unavailable', `${what} needs an open transaction`);
};

/** Inside the lease transaction, right after the job moved to `leased` (attempts = n). */
export function insertAttemptTx(db: Database.Database, a: {
  id: string; jobId: string; projectId: string; n: number; bootId: string; now: number; logPath: string | null;
  sandbox?: unknown; environment?: unknown;
}): AttemptRow {
  requireTx(db, 'insertAttemptTx');
  db.prepare(`INSERT INTO job_attempts (id, job_id, n, state, boot_id, lease_owner, lease_expires_at, log_path, sandbox_json,
      environment_json, created_at, updated_at) VALUES (?, ?, ?, 'starting', ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    a.id, a.jobId, a.n, a.bootId, a.bootId, a.now + LEASE_MS, a.logPath,
    a.sandbox === undefined ? null : boundedJson(a.sandbox, MAX_SANDBOX_JSON_CHARS, 'sandbox_json'),
    a.environment === undefined ? null : boundedJson(a.environment, MAX_ENVIRONMENT_JSON_CHARS, 'environment_json'),
    a.now, a.now);
  appendJobEventTx(db, { type: 'attempt.transition', summary: `attempt ${a.n} starting`, projectId: a.projectId, jobId: a.jobId,
    attemptN: a.n, data: { to: 'starting' } }, a.now);
  return attemptRow(db, a.id)!;
}

export interface AttemptChange {
  outcome?: string; error?: { code: string; message: string };
  containerId?: string; exit?: { code: number | null; signal?: string; oomKilled: boolean };
  sandbox?: unknown; environment?: unknown; logBytes?: number; outBytes?: number;
}

/** Inside the caller's transaction: move one attempt along ATTEMPT_TRANSITIONS, with its columns. */
export function transitionAttemptTx(db: Database.Database, a: AttemptRow, to: AttemptState, now: number, projectId: string,
  c: AttemptChange = {}): AttemptRow {
  requireTx(db, 'transitionAttemptTx');
  if (!canTransitionAttempt(a.state, to)) {
    throw new PlatformError('illegal_transition', `a ${a.state} attempt cannot move to ${to}`, { from: a.state, to });
  }
  const sets = ['state = ?', 'updated_at = ?']; const args: unknown[] = [to, now];
  if (to === 'running' && a.started_at === null) { sets.push('started_at = ?'); args.push(now); }
  if ((TERMINAL_ATTEMPT_STATES as readonly string[]).includes(to)) { sets.push('finished_at = ?'); args.push(now); }
  if (c.outcome !== undefined) { sets.push('outcome = ?'); args.push(c.outcome); }
  if (c.error !== undefined) { sets.push('error_json = ?'); args.push(redactedErrorJson(c.error)); }
  if (c.containerId !== undefined && a.container_id === null) { sets.push('container_id = ?'); args.push(c.containerId); }
  if (c.exit !== undefined) {
    sets.push('exit_code = ?', 'signal = ?', 'oom_killed = ?');
    args.push(c.exit.code, c.exit.signal ?? null, c.exit.oomKilled ? 1 : 0);
  }
  if (c.sandbox !== undefined) { sets.push('sandbox_json = ?'); args.push(boundedJson(c.sandbox, MAX_SANDBOX_JSON_CHARS, 'sandbox_json')); }
  if (c.environment !== undefined) {
    sets.push('environment_json = ?'); args.push(boundedJson(c.environment, MAX_ENVIRONMENT_JSON_CHARS, 'environment_json'));
  }
  if (c.logBytes !== undefined) { sets.push('log_bytes = MAX(log_bytes, ?)'); args.push(c.logBytes); }
  if (c.outBytes !== undefined) { sets.push('out_bytes = MAX(out_bytes, ?)'); args.push(c.outBytes); }
  // The DDL CHECKs, stated first so the caller gets a clear error rather than a CHECK failure.
  const sandboxSet = c.sandbox !== undefined || a.sandbox_json !== null;
  const envSet = c.environment !== undefined || a.environment_json !== null;
  if ((to === 'running' || to === 'succeeded') && (!sandboxSet || !envSet)) {
    throw new PlatformError('invalid', `a ${to} attempt records its sandbox and environment`, { to });
  }
  if (to === 'succeeded' && ((c.exit === undefined && a.exit_code === null) || (c.outcome === undefined && a.outcome === null))) {
    throw new PlatformError('invalid', 'a succeeded attempt records its exit code and outcome', { to });
  }
  const r = db.prepare(`UPDATE job_attempts SET ${sets.join(', ')} WHERE id = ? AND state = ?`).run(...args, a.id, a.state);
  if (r.changes !== 1) throw new PlatformError('conflict', 'the attempt changed before the update', { attemptId: a.id });
  appendJobEventTx(db, { type: 'attempt.transition', summary: `attempt ${a.n} ${a.state} -> ${to}${c.outcome ? ` (${c.outcome})` : ''}`,
    projectId, jobId: a.job_id, attemptN: a.n, data: { from: a.state, to, outcome: c.outcome ?? null, error: c.error?.code ?? null } }, now);
  return attemptRow(db, a.id)!;
}

/** Inside the caller's transaction (recovery): this boot takes over a live attempt's lease. */
export function adoptAttemptTx(db: Database.Database, a: AttemptRow, bootId: string, now: number, projectId: string): AttemptRow {
  requireTx(db, 'adoptAttemptTx');
  if (a.state !== 'starting' && a.state !== 'running') throw new PlatformError('illegal_transition', 'only a live attempt is adopted');
  db.prepare('UPDATE job_attempts SET lease_owner = ?, lease_expires_at = ?, updated_at = ? WHERE id = ?').run(bootId, now + LEASE_MS, now, a.id);
  appendJobEventTx(db, { type: 'recovery', summary: `attempt ${a.n} adopted`, projectId, jobId: a.job_id, attemptN: a.n,
    data: { decision: 'adopt' } }, now);
  return attemptRow(db, a.id)!;
}

/**
 * A heartbeat: extend the lease and record `heartbeat_at` and the byte counters. One small
 * UPDATE, guarded by the live state and the lease owner; returns false when nothing matched.
 */
const heartbeatStmts = new WeakMap<Database.Database, Database.Statement>();
export function heartbeatTx(db: Database.Database, attemptId: string, bootId: string, now: number, logBytes: number, outBytes: number): boolean {
  // The hot path: compiled once per connection (preparing it costs more than running it).
  let st = heartbeatStmts.get(db);
  if (!st) { st = db.prepare(`UPDATE job_attempts SET heartbeat_at = ?, lease_expires_at = ?, log_bytes = MAX(log_bytes, ?),
      out_bytes = MAX(out_bytes, ?), updated_at = ? WHERE id = ? AND lease_owner = ? AND state IN ('starting','running')`); heartbeatStmts.set(db, st); }
  return st.run(now, now + LEASE_MS, logBytes, outBytes, now, attemptId, bootId).changes === 1;
}
