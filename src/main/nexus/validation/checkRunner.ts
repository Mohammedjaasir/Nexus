/**
 * Runs the system `validate` jobs of the validation framework (B2a): the checks main executes itself and the
 * runner's re-hashes (`blob.integrity`). Recipe checks (`sde.tests_pass`) are leased by the scheduler like tool
 * jobs; their ingest records the result, and a recipe check that ENDED without one is recorded here.
 *
 * - A job that cannot be a check never completes: an unknown validator, no `params.versionId`, a version that is
 *   gone, a version of another project, a kind the validator does not judge, or a validator main and the runner
 *   do not execute fails the job (`invalid_check`) in one transaction, with its attempt. It is never retried.
 * - A main check runs in ONE IMMEDIATE transaction: lease (attempt n, executor `main`), run, record the result
 *   bound to (job, n), succeed, complete, finalize.
 * - `blob.integrity` sends one `blob.verify` per stored object, then completes when every answer is in. Answers
 *   are matched in O(1) (by sha256) and complete only the job they belong to. A runner-wide fault (a `fault`
 *   naming no attempt, or the port leaving `ready` / being replaced) or 60 s without an answer is `error`,
 *   never `passed`.
 * - The scheduler's pass (`tick`, every second) does work only when there is some: checks were queued, a check
 *   job ended, a re-hash waits for its timeout, or the periodic safety pass is due (FULL_PASS_MS). `runPending`
 *   (called after ingest commits, by a revalidation, and by tests) always runs a full pass.
 * - Bounded slices (constraint 7): one pass stops after SLICE_MS of work and continues on a later turn.
 */
import { performance } from 'node:perf_hooks';
import type Database from 'better-sqlite3';
import type { Evidence, ValidationResult } from '../../../shared/nexus/evidence';
import type { MainToRunner } from '../../../shared/nexus/runnerProtocol';
import type { JobState, Principal, VersionStatus } from '../../../shared/nexus/platform';
import { getValidator } from '../../../shared/nexus/validators';
import { newId } from '../db/ids';
import { immediateTx } from '../db/tx';
import { PlatformError } from '../errors';
import type { JobService } from '../jobs/jobService';
import { insertAttemptTx, transitionAttemptTx, attemptRow } from '../exec/attempts';
import { appendJobEventTx } from '../exec/events';
import { errored, type ValidatorOutcome } from './normalized';
import * as gitHead from './validators/gitHeadResolves';
import * as req from './validators/reqSchema';
import * as problem from './validators/problemSchema';
import * as suite from './validators/suiteDiscovered';
import * as build from './validators/buildChecks';
import * as integrity from './validators/blobIntegrity';
import * as appManifest from './validators/appManifestSchema';
import * as diag from './validators/diagSchema';

/** How long `blob.integrity` waits for the runner's answers before the check is `error`. */
export const VERIFY_TIMEOUT_MS = 60_000;
/** The scheduler's safety pass over every queued and ended check, even when nothing flagged work. */
export const FULL_PASS_MS = 60_000;
/** One synchronous slice of check work; the rest continues on a later turn. */
export const SLICE_MS = 100;

export type ResolveCommit = (root: string, sha: string) => Promise<{ commit: string } | { error: string }>;

/** A version with its artifact, as the checks read it. */
export interface VersionFacts {
  id: string; artifact_id: string; project_id: string; participation_id: string | null; status: VersionStatus; draft_flag: string | null;
  storage_ref_json: string; metadata_json: string; produced_by_job_id: string | null; produced_by_session_id: string | null; on_behalf_of: string; kind: string;
  owner_scope: string; owner_participation_id: string | null; owner_workspace_id: string | null; current_version_id: string | null;
}

/** What the runner needs from the validation service (closures over its private parts). */
export interface CheckHost {
  db: Database.Database;
  jobs: JobService;
  now: () => number;
  log: (line: string) => void;
  mainBootId: string;
  appVersion: () => string | null;
  system(): Principal;
  versionFacts(id: string): VersionFacts | null;
  recordOutcomeTx(versionId: string, validatorId: string, o: ValidatorOutcome, bind: { jobId?: string | null; attemptN?: number | null; startedAt?: number }): ValidationResult;
  finalizeIfReady(system: Principal, versionId: string, o?: { allowPartial?: boolean }): VersionStatus;
  runPure(id: string, facts: unknown): ValidatorOutcome;
  repoPathOf(projectId: string): string | null;
  resolveCommit(): ResolveCommit | null;
  send(): ((msg: MainToRunner) => boolean) | null;
}

interface ValidateJobRow { id: string; project_id: string; state: JobState; validator_id: string | null; recipe_id: string | null; params_json: string; created_at: number }
interface VerifyState { jobId: string; versionId: string; objects: string[]; answers: Map<string, integrity.VerifyAnswer>; outstanding: number; startedAt: number }

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const parse = (t: string | null): unknown => { if (t === null) return null; try { return JSON.parse(t) as unknown; } catch { return null; } };
const codeOf = (e: unknown): string => (e instanceof PlatformError ? e.code : (e as Error)?.name ?? 'error');

export class CheckRunner {
  /** Checks may be queued (set by enqueue, cleared by a pass). True at start: a restart scans once. */
  private queuedDue = true;
  /** A recipe check may have ended without a result (set on job-end events). True at start. */
  private endedDue = true;
  private lastFullPassAt: number | null = null;
  private continuation = false;
  /** blob.integrity checks waiting for the runner, by validate job, and the jobs waiting for each sha256. */
  private readonly verifies = new Map<string, VerifyState>();
  private readonly verifyBySha = new Map<string, Set<string>>();
  /** Validate jobs whose main facts are being gathered asynchronously (git resolution). */
  private readonly inflight = new Set<string>();
  private readonly pending = new Set<Promise<unknown>>();
  private queuedStmt: Database.Statement | null = null;
  private endedStmt: Database.Statement | null = null;

  constructor(private readonly h: CheckHost) {}

  /** Resolves when every asynchronous step started so far has settled (tests and shutdown). */
  async settled(): Promise<void> {
    while (this.pending.size > 0) await Promise.allSettled([...this.pending]);
  }

  private track(p: Promise<unknown>): void {
    this.pending.add(p);
    void p.finally(() => this.pending.delete(p));
  }

  /** New checks were queued. */
  noteQueued(): void { this.queuedDue = true; }
  /** A validate job ended (any terminal state): a recipe check may need its result recorded. */
  onJobEnded(): void { this.endedDue = true; }

  /** The scheduler's pass: work only when some is due (see the module header). */
  tick(now: number): void {
    if (this.verifies.size > 0) this.expireVerifies(now);
    const periodic = this.lastFullPassAt === null || now - this.lastFullPassAt >= FULL_PASS_MS;
    if (this.queuedDue || this.endedDue || periodic) this.runPending(now);
  }

  /** A full pass: the queued main and runner checks that can progress now, then ended recipe checks. Never throws. */
  runPending(now: number): void {
    this.lastFullPassAt = now;
    this.queuedDue = false;
    this.endedDue = false;
    const start = performance.now();
    let rows: ValidateJobRow[];
    try {
      this.queuedStmt ??= this.h.db.prepare(`SELECT id, project_id, state, validator_id, recipe_id, params_json, created_at FROM jobs
        WHERE state = 'queued' AND kind = 'validate' AND recipe_id IS NULL ORDER BY created_at, rowid`);
      rows = this.queuedStmt.all() as ValidateJobRow[];
    } catch { return; }
    for (const j of rows) {
      if (performance.now() - start > SLICE_MS) { this.continueLater(); break; }
      try { this.step(j, now); } catch (e) {
        this.h.log(`[nexus] validation: check not run: ${codeOf(e)}`);
      }
    }
    try { this.recordEndedRecipeChecks(); } catch { /* logged per job */ }
  }

  /** The rest of a pass that ran out of its slice, on a later turn. */
  private continueLater(): void {
    this.queuedDue = true;
    if (this.continuation) return;
    this.continuation = true;
    this.track(new Promise<void>((resolve) => setImmediate(() => {
      this.continuation = false;
      try { this.runPending(this.h.now()); } catch { /* never throws */ }
      resolve();
    })));
  }

  private step(j: ValidateJobRow, now: number): void {
    if (this.inflight.has(j.id)) return;
    const waiting = this.verifies.get(j.id);
    if (waiting) { if (this.verifyDone(waiting, now)) this.finishVerify(waiting, now); return; }
    const def = getValidator(j.validator_id ?? '');
    const params = parse(j.params_json);
    const versionId = isObj(params) && typeof params.versionId === 'string' ? params.versionId : null;
    if (!def) { this.failTx(j.id, 'unknown_validator', 'the check is not in this build', now); return; }
    if (!versionId) { this.failTx(j.id, 'version_missing', 'the check names no version', now); return; }
    const v = this.h.versionFacts(versionId);
    if (!v) { this.failTx(j.id, 'version_missing', 'the version to check is gone', now); return; }
    if (v.project_id !== j.project_id) { this.failTx(j.id, 'version_mismatch', 'the version belongs to another project', now); return; }
    if (!def.kinds.includes(v.kind)) { this.failTx(j.id, 'kind_mismatch', `the check does not judge a ${v.kind}`, now); return; }
    if (def.executes === 'main') {
      if (def.id === gitHead.ID) { this.gitStep(j, v, now); return; }
      this.completeTx(j.id, v.id, this.mainOutcome(def.id, v), now);
      return;
    }
    if (def.executes === 'runner') { this.verifyStep(j, v.id, now); return; }
    // A recipe check without its recipe, or a deployment check: main cannot run it.
    this.failTx(j.id, 'not_runnable', 'this check is not run by main or the runner', now);
  }

  // ---------- main checks ----------

  /** Facts for a main validator from the stored version (a candidate check, or a revalidation). */
  private mainOutcome(id: string, v: VersionFacts): ValidatorOutcome {
    const storage = parse(v.storage_ref_json) as Record<string, unknown> | null;
    const meta = parse(v.metadata_json);
    const manifest = isObj(storage) && typeof storage.manifestSha256 === 'string' ? storage.manifestSha256 : null;
    switch (id) {
      case req.ID: case problem.ID: case appManifest.ID: case diag.ID:
        return this.h.runPure(id, isObj(storage) && storage.kind === 'inline' ? storage.json : null);
      case suite.ID: {
        const disc = isObj(meta) && isObj(meta.discovery) ? meta.discovery : null;
        const files = isObj(meta) && Array.isArray(meta.files) ? meta.files : disc?.files;
        const stored = (this.h.db.prepare("SELECT sha256 FROM version_blobs WHERE version_id = ? AND role = 'discovery' LIMIT 1").get(v.id) as { sha256: string } | undefined)?.sha256 ?? null;
        return suite.run({ discovery: disc ? { framework: disc.framework, ids: disc.ids ?? files, files } : null,
          listSha256: disc && typeof disc.sha256 === 'string' ? disc.sha256 : null, storedSha256: stored });
      }
      case build.EXIT_ZERO: {
        const a = this.h.db.prepare(`SELECT ja.exit_code, ja.signal, ja.oom_killed FROM version_attempts va
          JOIN job_attempts ja ON ja.job_id = va.job_id AND ja.n = va.attempt_n WHERE va.version_id = ?`).get(v.id) as
          { exit_code: number | null; signal: string | null; oom_killed: number | null } | undefined;
        return build.exitZero({ exit: a && a.exit_code !== null ? { code: a.exit_code, ...(a.signal ? { signal: a.signal } : {}), oomKilled: a.oom_killed === 1 } : null });
      }
      case build.MANIFEST_PRESENT:
        return build.manifestPresent({ files: this.treeFiles(v.id).files, manifestSha256: manifest });
      case build.OUTPUT_HASHED: {
        // One query: every file of the tree with whether its blob is recorded (never a statement per file).
        const t = this.treeFiles(v.id);
        return build.outputHashed({ files: t.files, recorded: t.recorded, manifestSha256: manifest,
          fileCount: isObj(storage) && typeof storage.files === 'number' ? storage.files : null });
      }
      default: return errored('unknown_validator', 'Checks could not run: this check is not in this build.');
    }
  }

  /** The files of a tree version (`version_blobs` role `file`) and which of them have a recorded blob, in one query. */
  private treeFiles(versionId: string): { files: build.TreeFile[]; recorded: string[] } {
    const rows = this.h.db.prepare(`SELECT vb.path, vb.sha256, b.bytes, b.sha256 IS NOT NULL AS known FROM version_blobs vb
      LEFT JOIN blobs b ON b.sha256 = vb.sha256 WHERE vb.version_id = ? AND vb.role = 'file' ORDER BY vb.path`).all(versionId) as
      { path: string; sha256: string; bytes: number | null; known: number }[];
    return { files: rows.map((r) => ({ path: r.path, sha256: r.sha256, bytes: r.bytes ?? 0 })), recorded: rows.filter((r) => r.known === 1).map((r) => r.sha256) };
  }

  /** `git.head_resolves` on a stored repository version: main resolves the commit itself (async), then completes. */
  private gitStep(j: ValidateJobRow, v: VersionFacts, now: number): void {
    const storage = parse(v.storage_ref_json) as Record<string, unknown> | null;
    const commit = isObj(storage) && typeof storage.commit === 'string' ? storage.commit : '';
    const root = this.h.repoPathOf(j.project_id);
    const resolve = this.h.resolveCommit();
    if (!root || !resolve) { this.completeTx(j.id, v.id, gitHead.run({ storageCommit: commit, reported: null, resolved: null }), now); return; }
    this.inflight.add(j.id);
    const p = resolve(root, commit)
      .then((r) => ('commit' in r ? { commit: r.commit } : { error: String(r.error) }), () => ({ error: 'git_failed' }))
      .then((resolved) => { this.inflight.delete(j.id); this.completeTx(j.id, v.id, gitHead.run({ storageCommit: commit, reported: null, resolved }), this.h.now()); })
      .catch((e) => { this.inflight.delete(j.id); this.h.log(`[nexus] validation: check not recorded: ${codeOf(e)}`); });
    this.track(p);
  }

  // ---------- blob.integrity (the runner re-hashes) ----------

  private verifyDone(st: VerifyState, now: number): boolean {
    return st.outstanding === 0 || now - st.startedAt >= VERIFY_TIMEOUT_MS;
  }

  /** Ask the runner to re-hash each object once; complete when every answer is in (or it cannot be). */
  private verifyStep(j: ValidateJobRow, versionId: string, now: number): void {
    const objects = (this.h.db.prepare('SELECT DISTINCT sha256 FROM version_blobs WHERE version_id = ? ORDER BY sha256').all(versionId) as { sha256: string }[])
      .map((r) => r.sha256);
    if (objects.length === 0) { this.completeTx(j.id, versionId, integrity.run({ objects, answers: {} }), now); return; }
    const fresh: VerifyState = { jobId: j.id, versionId, objects, answers: new Map(), outstanding: 0, startedAt: now };
    this.verifies.set(j.id, fresh);
    const send = this.h.send();
    for (const sha of objects) {
      if (send && send({ op: 'blob.verify', sha256: sha })) {
        fresh.outstanding++;
        let waiting = this.verifyBySha.get(sha);
        if (!waiting) { waiting = new Set(); this.verifyBySha.set(sha, waiting); }
        waiting.add(j.id);
      } else {
        fresh.answers.set(sha, 'fault');
      }
    }
    if (fresh.outstanding === 0) this.finishVerify(fresh, now);
  }

  /** The runner's `blob.verified` answer: O(1), and only the jobs waiting for this object progress. */
  onBlobVerified(sha256: string, ok: boolean): void {
    const waiting = this.verifyBySha.get(sha256);
    if (!waiting) return;
    this.verifyBySha.delete(sha256);
    const now = this.h.now();
    for (const id of waiting) {
      const st = this.verifies.get(id);
      if (!st || st.answers.has(sha256)) continue;
      st.answers.set(sha256, ok ? 'ok' : 'mismatch');
      st.outstanding--;
      if (st.outstanding === 0) this.finishVerify(st, now);
    }
  }

  /** A runner-wide fault while re-hashes are outstanding: those checks could not run (`error`), never passed. */
  onRunnerFault(): void {
    if (this.verifies.size === 0) return;
    const now = this.h.now();
    for (const st of [...this.verifies.values()]) {
      for (const sha of st.objects) if (!st.answers.has(sha)) st.answers.set(sha, 'fault');
      st.outstanding = 0;
      this.finishVerify(st, now);
    }
  }

  /** Re-hashes unanswered for VERIFY_TIMEOUT_MS: in memory, no query. */
  private expireVerifies(now: number): void {
    for (const st of [...this.verifies.values()]) if (now - st.startedAt >= VERIFY_TIMEOUT_MS) this.finishVerify(st, now);
  }

  private finishVerify(st: VerifyState, now: number): void {
    if (this.verifies.get(st.jobId) !== st) return;
    this.verifies.delete(st.jobId);
    const answers: Record<string, integrity.VerifyAnswer> = {};
    for (const sha of st.objects) {
      answers[sha] = st.answers.get(sha) ?? 'no_answer';
      const waiting = this.verifyBySha.get(sha);
      if (waiting) { waiting.delete(st.jobId); if (waiting.size === 0) this.verifyBySha.delete(sha); }
    }
    try {
      this.completeTx(st.jobId, st.versionId, integrity.run({ objects: st.objects, answers }), now);
    } catch (e) {
      this.h.log(`[nexus] validation: check not recorded: ${codeOf(e)}`);
    }
  }

  // ---------- job transactions ----------

  /** Inside the caller's transaction: lease the queued job and insert attempt n (executor main or runner). */
  private leaseTx(j: { id: string; project_id: string; validator_id: string | null }, now: number, move: (to: JobState, from: JobState, d?: { outcome?: string; error?: { code: string; message: string } }) => void): { n: number; attemptId: string } {
    move('leased', 'queued');
    const n = (this.h.db.prepare('SELECT attempts FROM jobs WHERE id = ?').get(j.id) as { attempts: number }).attempts;
    const def = getValidator(j.validator_id ?? '');
    const sandbox = { executor: def?.executes === 'runner' ? 'runner' : 'main', validator: j.validator_id };
    const environment = { executor: sandbox.executor, validatorId: j.validator_id, validatorVersion: String(def?.version ?? 1), nexusVersion: this.h.appVersion() };
    const attemptId = newId(now);
    insertAttemptTx(this.h.db, { id: attemptId, jobId: j.id, projectId: j.project_id, n, bootId: this.h.mainBootId, now, logPath: null, sandbox, environment });
    return { n, attemptId };
  }

  private mover(j: { id: string; project_id: string }, now: number): (to: JobState, from: JobState, d?: { outcome?: string; error?: { code: string; message: string } }) => void {
    const system = this.h.system();
    return (to, from, d) => {
      this.h.jobs.transitionTx(system, j.id, to, d, { expectState: from, now });
      const n = (this.h.db.prepare('SELECT attempts FROM jobs WHERE id = ?').get(j.id) as { attempts: number }).attempts;
      const has = !!this.h.db.prepare('SELECT 1 FROM job_attempts WHERE job_id = ? AND n = ?').get(j.id, n);
      appendJobEventTx(this.h.db, { type: 'job.transition', summary: `job ${from} -> ${to}${d?.outcome ? ` (${d.outcome})` : ''}`, projectId: j.project_id,
        jobId: j.id, attemptN: has ? n : null, data: { from, to, outcome: d?.outcome ?? null, error: d?.error?.code ?? null } }, now);
    };
  }

  /**
   * One IMMEDIATE transaction for a check executed in main: lease (attempt n), record the result bound to (job, n),
   * succeed, complete, finalize the version.
   */
  private completeTx(jobId: string, versionId: string, o: ValidatorOutcome, now: number): void {
    const system = this.h.system();
    immediateTx(this.h.db, () => {
      const j = this.h.db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId) as { id: string; project_id: string; state: JobState; validator_id: string | null; params_json: string } | undefined;
      if (!j || j.state !== 'queued') return;
      const move = this.mover(j, now);
      const { n, attemptId } = this.leaseTx(j, now, move);
      transitionAttemptTx(this.h.db, attemptRow(this.h.db, attemptId)!, 'running', now, j.project_id);
      move('running', 'leased');
      this.h.recordOutcomeTx(versionId, j.validator_id ?? 'unknown', o, { jobId: j.id, attemptN: n, startedAt: now });
      transitionAttemptTx(this.h.db, attemptRow(this.h.db, attemptId)!, 'succeeded', now, j.project_id, { exit: { code: 0, oomKilled: false }, outcome: 'validated' });
      move('completed', 'running', { outcome: 'validated' });
      const params = parse(j.params_json);
      this.h.finalizeIfReady(system, versionId, { allowPartial: isObj(params) && params.revalidate === true });
    });
  }

  /** A job that cannot be a check fails (`invalid_check`), with its attempt, in one transaction. Never completed, never retried. */
  private failTx(jobId: string, code: string, message: string, now: number): void {
    immediateTx(this.h.db, () => {
      const j = this.h.db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId) as { id: string; project_id: string; state: JobState; validator_id: string | null } | undefined;
      if (!j || j.state !== 'queued') return;
      const move = this.mover(j, now);
      const { attemptId } = this.leaseTx(j, now, move);
      const error = { code, message };
      transitionAttemptTx(this.h.db, attemptRow(this.h.db, attemptId)!, 'failed', now, j.project_id, { outcome: 'invalid_check', error });
      move('failed', 'leased', { outcome: 'invalid_check', error });
    });
    this.h.log(`[nexus] validation: a check job was refused (${code})`);
  }

  /**
   * A recipe check (`sde.tests_pass`) that ended without completing (no JUnit, an infrastructure failure, a
   * timeout) records its result once, bound to its last attempt: `failed` when the outputs were refused
   * (`invalid_output`: the report is missing), `error` otherwise (the check could not run). Then finalize.
   */
  recordEndedRecipeChecks(): void {
    this.endedStmt ??= this.h.db.prepare(`SELECT j.id, j.project_id, j.attempts, j.outcome, j.params_json, j.validator_id FROM jobs j
      WHERE j.state IN ('failed','timed_out','interrupted') AND j.kind = 'validate' AND j.recipe_id IS NOT NULL AND j.attempts > 0
        AND EXISTS (SELECT 1 FROM job_attempts a WHERE a.job_id = j.id AND a.n = j.attempts)
        AND NOT EXISTS (SELECT 1 FROM validations v WHERE v.job_id = j.id AND v.attempt_n = j.attempts)`);
    const rows = this.endedStmt.all() as
      { id: string; project_id: string; attempts: number; outcome: string | null; params_json: string; validator_id: string | null }[];
    if (rows.length === 0) return;
    const system = this.h.system();
    for (const r of rows) {
      const params = parse(r.params_json);
      const versionId = isObj(params) && typeof params.versionId === 'string' ? params.versionId : null;
      const v = versionId ? this.h.versionFacts(versionId) : null;
      if (!v || v.project_id !== r.project_id) continue;
      const a = this.h.db.prepare('SELECT outcome, exit_code, oom_killed FROM job_attempts WHERE job_id = ? AND n = ?').get(r.id, r.attempts) as
        { outcome: string | null; exit_code: number | null; oom_killed: number | null };
      const ev: Evidence[] = [{ type: 'exit', code: a.exit_code, oomKilled: a.oom_killed === 1 }];
      const o: ValidatorOutcome = a.outcome === 'invalid_output' || r.outcome === 'invalid_output'
        ? { status: 'failed', reason: 'junit_missing', summary: 'The JUnit report is missing or its outputs were refused.', evidence: ev }
        : errored(a.outcome ?? r.outcome ?? 'job_failed', 'Checks could not run: the test job did not finish.', ev);
      try {
        immediateTx(this.h.db, () => {
          this.h.recordOutcomeTx(v.id, r.validator_id ?? 'sde.tests_pass', o, { jobId: r.id, attemptN: r.attempts });
          this.h.finalizeIfReady(system, v.id, { allowPartial: isObj(params) && params.revalidate === true });
        });
      } catch (e) {
        this.h.log(`[nexus] validation: ended check not recorded: ${codeOf(e)}`);
      }
    }
  }
}
