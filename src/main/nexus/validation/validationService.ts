/**
 * The validation framework (B2a, constraint 4): validator results with their evidence, the finalize rule, and the
 * `validate` jobs that run candidate checks.
 *
 * - Results. `recordResultTx` is the only writer of `validations` and accepts only the stored system principal
 *   (anyone else: 'denied', audited; the database refuses a non-system blocking pass or fail, tr_validations_insert).
 *   Evidence is persisted as given or not at all: a secret-shaped value (`containsSecret`) or an oversized list
 *   turns the result into `error` (`secret_in_evidence`, `evidence_too_large`) with an empty evidence list; evidence
 *   is never redacted in place. A result bound to a job also writes one `validation` job event.
 * - Latest per (version, validator) counts: the newest row by `finished_at`, then insertion order. A v2 row beside a
 *   v1 row simply supersedes it; old rows are never changed or removed.
 * - Finalize (`finalizeIfReady`, system, inside the caller's transaction or its own): an engine-made draft (a job or
 *   session produced it; a user's own draft is made ready by the user, B1) becomes `candidate`
 *   only when EVERY blocking register and candidate validator of its kind has a latest `passed` row; any latest
 *   blocking `failed` makes it `failed`; any `error` leaves it draft ("Checks could not run", Revalidate); advisory
 *   rows never gate. A `cancelled_partial` draft never finalizes on its own; only a revalidation may finalize it.
 *   A `repository` version that reaches candidate is promoted `active` by the system in the same transaction.
 * - Register validators run inline (`runRegisterTx`) over the facts the caller hands in (ingest, inline saves).
 * - Candidate validators run as system `validate` jobs (`enqueueCandidate`) carrying `params.versionId`, never
 *   job_inputs, so drafts can be validated. Main validators run here (`runPending`): one IMMEDIATE transaction
 *   leases the job, records attempt n (executor `main`), records the result bound to (job, n), completes the job and
 *   finalizes. `blob.integrity` asks the runner to re-hash every object (`blob.verify`) and completes when every
 *   answer is in; a runner fault, a failed send or 60 s without an answer is `error`, never `passed`. A recipe
 *   validator (`sde.tests_pass`) is a validate job with a recipe that the scheduler leases like a tool job; its
 *   ingest records the result. Deployment validators are recorded by the deployment (Task 9).
 * - `revalidate` (user, 'version.revalidate'): drafts only; new validate jobs for every blocking validator of the
 *   kind; old rows stay.
 */
import type Database from 'better-sqlite3';
import type { Evidence, ValidationResult, ValidationStatus, ValidatorStage } from '../../../shared/nexus/evidence';
import type { MainToRunner } from '../../../shared/nexus/runnerProtocol';
import type { JobState, Principal, ScopeRef, VersionStatus } from '../../../shared/nexus/platform';
import { blockingValidatorsFor, getValidator, VALIDATORS, type ValidatorDef } from '../../../shared/nexus/validators';
import { getRecipe, type RecipeDef } from '../../../shared/nexus/recipes';
import type { AuthService } from '../auth/authService';
import { PrincipalResolver } from '../auth/principals';
import { containsSecret, redactText } from '../activity/redact';
import type { ArtifactService } from '../artifact/artifactService';
import type { BlobIndex } from '../blobs/blobIndex';
import { newId } from '../db/ids';
import { immediateTx } from '../db/tx';
import { PlatformError } from '../errors';
import type { JobService } from '../jobs/jobService';
import { ProjectAccess } from '../project/projectAccess';
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

export const MAX_EVIDENCE_CHARS = 65_536;
export const MAX_SUMMARY_CHARS = 500;
/** How long `blob.integrity` waits for the runner's answers before the check is `error`. */
export const VERIFY_TIMEOUT_MS = 60_000;

export type ResolveCommit = (root: string, sha: string) => Promise<{ commit: string } | { error: string }>;

export interface ValidationDeps {
  auth: AuthService; artifacts: ArtifactService; jobs: JobService; now: () => number; log?: (line: string) => void;
  blobs: BlobIndex | null;
  /** main's own async commit resolution in the project folder (src/main/git.ts `resolveCommit`). */
  resolveCommit?: ResolveCommit | null;
  acceptFsRoot?: ((root: string) => string | null) | null;
  /** Sends a message to the runner (late-bound to the execution core); false when it did not go. */
  send?: (msg: MainToRunner) => boolean;
  appVersion?: string | null;
}

export interface RecordInput {
  versionId: string; validatorId: string; validatorVersion?: string; stage?: ValidatorStage; status: ValidationStatus;
  blocking?: boolean; advisory?: boolean; summary: string; evidence: unknown; jobId?: string | null; attemptN?: number | null;
  startedAt?: number; finishedAt?: number;
}

interface ValidationRow {
  id: string; version_id: string; validator_id: string; validator_version: string; stage: ValidatorStage; status: ValidationStatus;
  blocking: number; advisory: number; summary: string; evidence_json: string; job_id: string | null; attempt_n: number | null;
  created_by: string; started_at: number; finished_at: number;
}
interface VersionFacts {
  id: string; artifact_id: string; project_id: string; participation_id: string | null; status: VersionStatus; draft_flag: string | null;
  storage_ref_json: string; metadata_json: string; produced_by_job_id: string | null; produced_by_session_id: string | null; on_behalf_of: string; kind: string;
  owner_scope: string; owner_participation_id: string | null; owner_workspace_id: string | null; current_version_id: string | null;
}
interface ValidateJobRow { id: string; project_id: string; state: JobState; validator_id: string | null; recipe_id: string | null; params_json: string; created_at: number }

const PLATFORM: ScopeRef = { type: 'platform' };
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const parse = (t: string | null): unknown => { if (t === null) return null; try { return JSON.parse(t) as unknown; } catch { return null; } };

export function toValidationResult(r: ValidationRow): ValidationResult {
  return { id: r.id, versionId: r.version_id, validatorId: r.validator_id, validatorVersion: r.validator_version, status: r.status,
    blocking: r.blocking === 1, advisory: r.advisory === 1, summary: r.summary, evidence: (parse(r.evidence_json) as Evidence[] | null) ?? [],
    ...(r.job_id !== null ? { jobId: r.job_id } : {}), ...(r.attempt_n !== null ? { attemptN: r.attempt_n } : {}),
    startedAt: r.started_at, finishedAt: r.finished_at };
}

/** The typed digest fields of evidence (shared/nexus/evidence.ts): a pure hex digest there is an integrity hash, not a secret. */
const EVIDENCE_DIGEST_KEYS = new Set(['blobSha256', 'bodySha256', 'manifestSha256']);
const HEX_DIGEST = /^[0-9a-f]{40,128}$/;
/** The evidence as the secret check sees it: typed digest fields holding a hex digest are blanked; everything else is checked. */
function secretCheckView(v: unknown, depth = 0): unknown {
  if (depth > 32 || typeof v !== 'object' || v === null) return v;
  if (Array.isArray(v)) return v.map((x) => secretCheckView(x, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
    out[k] = EVIDENCE_DIGEST_KEYS.has(k) && typeof x === 'string' && HEX_DIGEST.test(x) ? '' : secretCheckView(x, depth + 1);
  }
  return out;
}

/** The summary as stored: one line, redacted, at most 500 characters, the machine reason appended. */
function summaryText(summary: string, reason: string | null): string {
  const base = redactText(String(summary ?? '')).replace(/[\r\n\t]+/g, ' ').trim() || 'checked';
  const withReason = reason ? `${base} (${reason})` : base;
  return withReason.length > MAX_SUMMARY_CHARS ? `${withReason.slice(0, MAX_SUMMARY_CHARS - 1)}…` : withReason;
}

/** The test recipe of a suite version (`sde.tests_pass` runs it): python for a python profile, node otherwise. */
export function testRecipeFor(metadata: unknown, def: ValidatorDef): RecipeDef | null {
  const profile = isObj(metadata) && typeof metadata.profile === 'string' ? metadata.profile : 'sde-node';
  const ids = def.recipes ?? [];
  const id = ids.find((r) => getRecipe(r)?.profiles.includes(profile as never)) ?? null;
  return id ? getRecipe(id) : null;
}

export class ValidationService {
  private readonly principals: PrincipalResolver;
  private readonly access: ProjectAccess;
  private readonly log: (line: string) => void;
  /** The 26-character owner of the attempts main itself executes (validate jobs run in main). */
  readonly mainBootId: string;
  /** blob.integrity checks waiting for the runner, by validate job. */
  private readonly verifies = new Map<string, { objects: string[]; answers: Record<string, integrity.VerifyAnswer>; startedAt: number }>();
  /** Validate jobs whose main facts are being gathered asynchronously (git resolution). */
  private readonly inflight = new Set<string>();
  private readonly pending = new Set<Promise<unknown>>();
  private queuedStmt: Database.Statement | null = null;
  private endedStmt: Database.Statement | null = null;

  constructor(private readonly db: Database.Database, private readonly deps: ValidationDeps) {
    this.principals = new PrincipalResolver(db);
    this.access = new ProjectAccess(db, { auth: deps.auth });
    this.log = deps.log ?? (() => {});
    this.mainBootId = newId(deps.now());
  }

  /** Late binding of the runner send (the execution core is built after this service). */
  setSender(send: (msg: MainToRunner) => boolean): void { this.deps.send = send; }

  /** Resolves when every asynchronous step started so far has settled (tests and shutdown). */
  async settled(): Promise<void> {
    while (this.pending.size > 0) await Promise.allSettled([...this.pending]);
  }

  private system(): Principal { return this.principals.system(); }
  private isSystem(p: Principal): boolean { return p?.kind === 'system' && this.principals.get(p.id)?.kind === 'system'; }

  private versionFacts(id: string): VersionFacts | null {
    return (this.db.prepare(`SELECT v.id, v.artifact_id, v.project_id, v.participation_id, v.status, v.draft_flag, v.storage_ref_json,
        v.metadata_json, v.produced_by_job_id, v.produced_by_session_id, v.on_behalf_of, a.kind, a.owner_scope, a.owner_participation_id, a.owner_workspace_id,
        a.current_version_id
      FROM artifact_versions v JOIN artifacts a ON a.id = v.artifact_id WHERE v.id = ?`).get(id) as VersionFacts | undefined) ?? null;
  }

  // ---------- results ----------

  /** System only, inside the caller's transaction (or its own). See the module header for the evidence rules. */
  recordResultTx(p: Principal, r: RecordInput): ValidationResult {
    if (!this.isSystem(p)) {
      // A user, an agent or a forged principal never writes a validation result: denied and audited.
      this.deps.auth.require(p, 'exec.ingest', PLATFORM, { entityType: 'validation' });
      throw new PlatformError('denied', 'validation results are recorded by the system', { reason: 'system_only' });
    }
    if (!isObj(r) || typeof r.versionId !== 'string' || typeof r.validatorId !== 'string') throw new PlatformError('invalid', 'a result names its version and validator');
    const now = this.deps.now();
    return immediateTx(this.db, () => {
      const v = this.versionFacts(r.versionId);
      if (!v) throw new PlatformError('not_found', 'version not found');
      const def = getValidator(r.validatorId);
      const blocking = r.blocking ?? def?.blocking ?? false;
      const advisory = r.advisory ?? !blocking;
      let status: ValidationStatus = r.status;
      let summary = r.summary;
      let evidenceJson = '[]';
      if (!['passed', 'failed', 'error', 'skipped'].includes(status)) throw new PlatformError('invalid', 'unknown validation status');
      if (!Array.isArray(r.evidence)) {
        status = 'error'; summary = summaryText('Checks could not run: the evidence was not a list.', 'bad_evidence');
      } else if (containsSecret(secretCheckView(r.evidence))) {
        status = 'error'; summary = summaryText('Checks could not run: the evidence held a secret-shaped value and was not stored.', 'secret_in_evidence');
      } else {
        const text = JSON.stringify(r.evidence);
        if (typeof text !== 'string' || text.length > MAX_EVIDENCE_CHARS) {
          status = 'error'; summary = summaryText('Checks could not run: the evidence was too large to store.', 'evidence_too_large');
        } else {
          evidenceJson = text;
          summary = summaryText(summary, null);
        }
      }
      const id = newId(now);
      const startedAt = r.startedAt ?? now; const finishedAt = Math.max(r.finishedAt ?? now, startedAt);
      this.db.prepare(`INSERT INTO validations (id, version_id, validator_id, validator_version, stage, status, blocking, advisory, summary,
          evidence_json, job_id, attempt_n, created_by, started_at, finished_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(id, v.id, r.validatorId, r.validatorVersion ?? String(def?.version ?? 1), r.stage ?? def?.stage ?? 'candidate', status,
          blocking ? 1 : 0, advisory && !blocking ? 1 : 0, summary, evidenceJson, r.jobId ?? null, r.jobId ? (r.attemptN ?? null) : null,
          p.id, startedAt, finishedAt);
      if (r.jobId) {
        const job = this.db.prepare('SELECT project_id FROM jobs WHERE id = ?').get(r.jobId) as { project_id: string } | undefined;
        if (job) {
          appendJobEventTx(this.db, { type: 'validation', summary: `${r.validatorId}: ${status}`, projectId: job.project_id, jobId: r.jobId,
            attemptN: r.attemptN ?? null, data: { versionId: v.id, validatorId: r.validatorId, status } }, now);
        }
      }
      return toValidationResult(this.db.prepare('SELECT * FROM validations WHERE id = ?').get(id) as ValidationRow);
    });
  }

  /** Records one validator outcome (system), bound to a job attempt when given. */
  recordOutcomeTx(versionId: string, validatorId: string, o: ValidatorOutcome, bind: { jobId?: string | null; attemptN?: number | null; startedAt?: number } = {}): ValidationResult {
    const def = getValidator(validatorId);
    return this.recordResultTx(this.system(), {
      versionId, validatorId, validatorVersion: String(def?.version ?? 1), stage: def?.stage ?? 'candidate', status: o.status,
      blocking: def?.blocking ?? false, advisory: false, summary: o.reason && o.status !== 'passed' ? `${o.summary} (${o.reason})` : o.summary,
      evidence: o.evidence, jobId: bind.jobId ?? null, attemptN: bind.attemptN ?? null, startedAt: bind.startedAt
    });
  }

  /** The latest row per validator of a version (newest `finished_at`, then insertion order). */
  private latestRows(versionId: string): ValidationRow[] {
    return this.db.prepare(`SELECT v.* FROM validations v WHERE v.version_id = ? AND NOT EXISTS (SELECT 1 FROM validations w
        WHERE w.version_id = v.version_id AND w.validator_id = v.validator_id
          AND (w.finished_at > v.finished_at OR (w.finished_at = v.finished_at AND w.rowid > v.rowid)))
      ORDER BY v.validator_id`).all(versionId) as ValidationRow[];
  }

  /** The latest result per validator of a version the caller may read. */
  latestForVersion(p: Principal, versionId: string): ValidationResult[] {
    const v = typeof versionId === 'string' && versionId.length > 0 ? this.versionFacts(versionId) : null;
    if (!v) {
      this.deps.auth.require(p, 'artifact.read', PLATFORM);
      throw new PlatformError('not_found', 'version not found');
    }
    this.access.require(p, v.project_id, 'artifact.read', v.owner_workspace_id ? { workspaceId: v.owner_workspace_id } : undefined);
    return this.latestRows(v.id).map(toValidationResult);
  }

  // ---------- register validators ----------

  /** The blocking register validators of a kind, run over the facts given (by validator id); every result recorded. */
  runRegisterTx(system: Principal, versionId: string, facts: Record<string, unknown>, bind: { jobId?: string | null; attemptN?: number | null } = {}): ValidationResult[] {
    if (!this.isSystem(system)) throw new PlatformError('denied', 'register validators are run by the system', { reason: 'system_only' });
    const v = this.versionFacts(versionId);
    if (!v) throw new PlatformError('not_found', 'version not found');
    const defs = VALIDATORS.filter((d) => d.blocking && d.stage === 'register' && d.kinds.includes(v.kind));
    return defs.map((d) => {
      const f = Object.prototype.hasOwnProperty.call(facts, d.id) ? facts[d.id] : undefined;
      const o = f === undefined ? errored('facts_missing', 'Checks could not run: the facts for this check were not recorded.') : this.runPure(d.id, f);
      return this.recordOutcomeTx(v.id, d.id, o, bind);
    });
  }

  /** A pure validator by id. */
  runPure(id: string, facts: unknown): ValidatorOutcome {
    switch (id) {
      case gitHead.ID: return gitHead.run(facts as gitHead.GitHeadFacts);
      case req.ID: return req.run(facts);
      case problem.ID: return problem.run(facts);
      case suite.ID: return suite.run(facts as suite.SuiteDiscoveredFacts);
      case appManifest.ID: return appManifest.run(facts);
      case diag.ID: return diag.run(facts);
      case build.EXIT_ZERO: return build.exitZero(facts as Parameters<typeof build.exitZero>[0]);
      case build.MANIFEST_PRESENT: return build.manifestPresent(facts as Parameters<typeof build.manifestPresent>[0]);
      case build.OUTPUT_HASHED: return build.outputHashed(facts as Parameters<typeof build.outputHashed>[0]);
      default: return errored('unknown_validator', 'Checks could not run: this check is not in this build.');
    }
  }

  /** For ArtifactService.saveInline (late-bound hook): the register validators of an inline kind over its content. */
  recordInlineRegisterTx(versionId: string, kind: string, content: unknown): void {
    const facts: Record<string, unknown> = {};
    for (const d of VALIDATORS) if (d.stage === 'register' && d.kinds.includes(kind)) facts[d.id] = content;
    this.runRegisterTx(this.system(), versionId, facts);
  }

  // ---------- finalize ----------

  /** The finalize rule (module header). Runs in the caller's transaction or its own. Returns the version's status. */
  finalizeIfReady(system: Principal, versionId: string, o: { allowPartial?: boolean } = {}): VersionStatus {
    if (!this.isSystem(system)) throw new PlatformError('denied', 'only the system finalizes a version', { reason: 'system_only' });
    const now = this.deps.now();
    return immediateTx(this.db, () => {
      const v = this.versionFacts(versionId);
      if (!v) throw new PlatformError('not_found', 'version not found');
      if (v.status !== 'draft') return v.status;
      // A user's own draft is made ready by the user (Mark ready, B1); only engine-made drafts are finalized here.
      if (v.produced_by_job_id === null && v.produced_by_session_id === null) return 'draft';
      if (v.draft_flag === 'cancelled_partial' && o.allowPartial !== true) return 'draft';
      const blockers = blockingValidatorsFor(v.kind);
      if (blockers.length === 0) return 'draft';
      const latest = new Map(this.latestRows(v.id).filter((r) => r.blocking === 1).map((r) => [r.validator_id, r.status]));
      const statuses = blockers.map((b) => latest.get(b.id) ?? 'pending');
      const setState = (s: 'passed' | 'failed' | 'error'): void => {
        this.db.prepare('UPDATE artifact_versions SET validation_state = ? WHERE id = ? AND validation_state IS NOT ?').run(s, v.id, s);
      };
      if (statuses.includes('failed')) {
        this.deps.artifacts.setStatusTx(system, v.id, 'failed', { now, onBehalfOf: v.on_behalf_of, via: 'validation' });
        setState('failed');
        return 'failed';
      }
      if (statuses.includes('error')) { setState('error'); return 'draft'; }
      if (statuses.some((s) => s !== 'passed')) return 'draft';
      const ownerActive = v.owner_scope === 'project' || !!this.db.prepare("SELECT 1 FROM project_workspaces WHERE id = ? AND status = 'active'")
        .get(v.owner_participation_id);
      if (!ownerActive) return 'draft';
      this.deps.artifacts.setStatusTx(system, v.id, 'candidate', { now, onBehalfOf: v.on_behalf_of, via: 'validation' });
      setState('passed');
      if (v.kind === 'repository') {
        // Platform policy: a validated snapshot records git state, not work product, so the system makes it current.
        const art = this.db.prepare('SELECT current_version_id FROM artifacts WHERE id = ?').get(v.artifact_id) as { current_version_id: string | null };
        const r = this.deps.artifacts.promoteTx(system, v.id, art.current_version_id, now, { onBehalfOf: v.on_behalf_of });
        if (!r.ok) throw new PlatformError('conflict', 'the repository moved during promotion');
        return 'active';
      }
      return 'candidate';
    });
  }

  // ---------- candidate validation jobs ----------

  /**
   * Creates one system `validate` job per blocking candidate validator of the version's kind that main, the runner
   * or a recipe executes (`params.versionId`; never job_inputs). Deployment validators are recorded by the
   * deployment. Runs in the caller's transaction or its own. Returns the job ids.
   */
  enqueueCandidate(system: Principal, versionId: string, o: { parentJobId?: string | null } = {}): string[] {
    if (!this.isSystem(system)) throw new PlatformError('denied', 'candidate validation is enqueued by the system', { reason: 'system_only' });
    return this.createValidateJobs(system, versionId, VALIDATORS.filter((d) => d.blocking && d.stage === 'candidate'), { parentJobId: o.parentJobId ?? null, revalidate: false });
  }

  private createValidateJobs(by: Principal, versionId: string, defs: readonly ValidatorDef[], o: { parentJobId: string | null; revalidate: boolean }): string[] {
    const now = this.deps.now();
    return immediateTx(this.db, () => {
      const v = this.versionFacts(versionId);
      if (!v) throw new PlatformError('not_found', 'version not found');
      const pwId = v.owner_participation_id ?? (v.produced_by_job_id
        ? (this.db.prepare('SELECT participation_id FROM jobs WHERE id = ?').get(v.produced_by_job_id) as { participation_id: string | null } | undefined)?.participation_id ?? null
        : null);
      if (!pwId) return [];
      const pw = this.db.prepare('SELECT project_id, workspace_id FROM project_workspaces WHERE id = ?').get(pwId) as { project_id: string; workspace_id: string } | undefined;
      if (!pw) return [];
      const out: string[] = [];
      for (const d of defs) {
        if (!d.kinds.includes(v.kind) || d.executes === 'deployment') continue;
        const recipe = d.executes === 'child-job' ? testRecipeFor(parse(v.metadata_json), d) : null;
        if (d.executes === 'child-job' && !recipe) continue;
        const seq = (this.db.prepare(`SELECT COUNT(*) AS n FROM jobs WHERE kind = 'validate' AND validator_id = ?
          AND json_extract(params_json, '$.versionId') = ?`).get(d.id, v.id) as { n: number }).n + 1;
        const res = this.deps.jobs.createTx(by, {
          kind: 'validate', projectId: pw.project_id, workspaceId: pw.workspace_id, idempotencyKey: `validate:${v.id}:${d.id}:${seq}`,
          validatorId: d.id, ...(recipe ? { recipeId: recipe.id } : {}), ...(o.parentJobId ? { parentJobId: o.parentJobId } : {}),
          params: o.revalidate ? { versionId: v.id, revalidate: true } : { versionId: v.id },
          retry: { idempotent: false, maxAttempts: 1, backoffMs: [] }
        });
        if (recipe) {
          const profile = recipe.profiles[0];
          const cap = { action: `validate.${d.id}`, recipe: recipe.id, recipeVersion: recipe.version, executor: recipe.executor, network: recipe.network, profile };
          const limits = recipe.limits
            ? { cpus: recipe.limits.cpus, memoryMb: recipe.limits.memoryMb, pids: 512, wallClockMs: recipe.wallClockMs, outputMaxBytes: recipe.limits.outputMaxBytes, tmpfsMb: 512 }
            : { wallClockMs: recipe.wallClockMs };
          this.db.prepare('UPDATE jobs SET capabilities_json = ?, limits_json = ? WHERE id = ?').run(JSON.stringify([cap]), JSON.stringify(limits), res.job.id);
        }
        appendJobEventTx(this.db, { type: 'job.transition', summary: `job queued: check ${d.id}`, projectId: pw.project_id, jobId: res.job.id,
          data: { from: null, to: 'queued', validator: d.id, versionId: v.id, recipe: recipe?.id ?? null } }, now);
        out.push(res.job.id);
      }
      return out;
    });
  }

  /** User: run every blocking check of a draft again (new rows; old rows stay). Returns the validate jobs. */
  revalidate(p: Principal, versionId: string): { jobs: string[] } {
    const v = typeof versionId === 'string' && versionId.length > 0 ? this.versionFacts(versionId) : null;
    if (!v) {
      this.deps.auth.require(p, 'version.revalidate', PLATFORM);
      throw new PlatformError('not_found', 'version not found');
    }
    this.access.require(p, v.project_id, 'version.revalidate', v.owner_workspace_id ? { workspaceId: v.owner_workspace_id } : undefined);
    if (v.status !== 'draft') throw new PlatformError('illegal_transition', `checks are run again only on a draft, not a ${v.status} version`, { from: v.status });
    // The user asked for it; the jobs act on the user's behalf, the results are still recorded by the system.
    const defs = blockingValidatorsFor(v.kind);
    const jobs = this.createValidateJobs(p, v.id, defs, { parentJobId: null, revalidate: true });
    this.runPending(this.deps.now());
    return { jobs };
  }

  // ---------- running validate jobs ----------

  /** Runs the queued main and runner validate jobs that can make progress now. Never throws. */
  runPending(now: number): void {
    let rows: ValidateJobRow[];
    try {
      // The scheduler's hot path (every tick): one cached statement over ix_jobs_sched.
      this.queuedStmt ??= this.db.prepare(`SELECT id, project_id, state, validator_id, recipe_id, params_json, created_at FROM jobs
        WHERE state = 'queued' AND kind = 'validate' AND recipe_id IS NULL ORDER BY created_at, rowid`);
      rows = this.queuedStmt.all() as ValidateJobRow[];
    } catch { return; }
    for (const j of rows) {
      try { this.step(j, now); } catch (e) {
        this.log(`[nexus] validation: check not run: ${e instanceof PlatformError ? e.code : (e as Error)?.name ?? 'error'}`);
      }
    }
    try { this.recordEndedRecipeChecks(); } catch { /* logged per job */ }
  }

  private step(j: ValidateJobRow, now: number): void {
    if (this.inflight.has(j.id)) return;
    const def = getValidator(j.validator_id ?? '');
    const params = parse(j.params_json);
    const versionId = isObj(params) && typeof params.versionId === 'string' ? params.versionId : null;
    if (!def || !versionId) { this.completeTx(j.id, null, errored('unknown_validator', 'Checks could not run: the check is unknown.'), now); return; }
    if (def.executes === 'main') {
      if (def.id === gitHead.ID) { this.gitStep(j, versionId, now); return; }
      this.completeTx(j.id, versionId, this.mainOutcome(def.id, versionId), now);
      return;
    }
    if (def.executes === 'runner') { this.verifyStep(j, versionId, now); return; }
  }

  /** Facts for a main validator from the stored version (a candidate check, or a revalidation). */
  private mainOutcome(id: string, versionId: string): ValidatorOutcome {
    const v = this.versionFacts(versionId);
    if (!v) return errored('version_missing', 'Checks could not run: the version is gone.');
    const storage = parse(v.storage_ref_json) as Record<string, unknown> | null;
    const meta = parse(v.metadata_json);
    const files = this.treeFiles(v.id);
    switch (id) {
      case req.ID: case problem.ID: case appManifest.ID: case diag.ID:
        return this.runPure(id, isObj(storage) && storage.kind === 'inline' ? storage.json : null);
      case suite.ID: {
        const disc = isObj(meta) ? meta.discovery : null;
        const stored = (this.db.prepare("SELECT sha256 FROM version_blobs WHERE version_id = ? AND role = 'discovery' LIMIT 1").get(v.id) as { sha256: string } | undefined)?.sha256 ?? null;
        return suite.run({ discovery: isObj(disc) ? { framework: disc.framework, ids: disc.ids ?? disc.files, files: disc.files } : null,
          listSha256: isObj(disc) && typeof disc.sha256 === 'string' ? disc.sha256 : null, storedSha256: stored });
      }
      case build.EXIT_ZERO: {
        const a = this.db.prepare(`SELECT ja.exit_code, ja.signal, ja.oom_killed FROM version_attempts va
          JOIN job_attempts ja ON ja.job_id = va.job_id AND ja.n = va.attempt_n WHERE va.version_id = ?`).get(v.id) as
          { exit_code: number | null; signal: string | null; oom_killed: number | null } | undefined;
        return build.exitZero({ exit: a && a.exit_code !== null ? { code: a.exit_code, ...(a.signal ? { signal: a.signal } : {}), oomKilled: a.oom_killed === 1 } : null });
      }
      case build.MANIFEST_PRESENT:
        return build.manifestPresent({ files, manifestSha256: isObj(storage) && typeof storage.manifestSha256 === 'string' ? storage.manifestSha256 : null });
      case build.OUTPUT_HASHED:
        return build.outputHashed({ files, recorded: files.map((f) => f.sha256).filter((s) => !!this.db.prepare('SELECT 1 FROM blobs WHERE sha256 = ?').get(s)),
          manifestSha256: isObj(storage) && typeof storage.manifestSha256 === 'string' ? storage.manifestSha256 : null,
          fileCount: isObj(storage) && typeof storage.files === 'number' ? storage.files : null });
      default: return errored('unknown_validator', 'Checks could not run: this check is not in this build.');
    }
  }

  /** The files of a tree version, as recorded (`version_blobs` role `file` joined to `blobs`). */
  private treeFiles(versionId: string): build.TreeFile[] {
    return (this.db.prepare(`SELECT vb.path, vb.sha256, b.bytes FROM version_blobs vb JOIN blobs b ON b.sha256 = vb.sha256
      WHERE vb.version_id = ? AND vb.role = 'file' ORDER BY vb.path`).all(versionId) as { path: string; sha256: string; bytes: number }[])
      .map((r) => ({ path: r.path, sha256: r.sha256, bytes: r.bytes }));
  }

  /** `git.head_resolves` on a stored repository version: main resolves the commit itself (async), then completes. */
  private gitStep(j: ValidateJobRow, versionId: string, now: number): void {
    const v = this.versionFacts(versionId);
    const storage = v ? parse(v.storage_ref_json) as Record<string, unknown> | null : null;
    const commit = isObj(storage) && typeof storage.commit === 'string' ? storage.commit : '';
    const root = this.repoPathOf(j.project_id);
    const resolve = this.deps.resolveCommit;
    if (!root || !resolve) { this.completeTx(j.id, versionId, gitHead.run({ storageCommit: commit, reported: null, resolved: null }), now); return; }
    this.inflight.add(j.id);
    const p = resolve(root, commit)
      .then((r) => ('commit' in r ? { commit: r.commit } : { error: String(r.error) }), () => ({ error: 'git_failed' }))
      .then((resolved) => { this.inflight.delete(j.id); this.completeTx(j.id, versionId, gitHead.run({ storageCommit: commit, reported: null, resolved }), this.deps.now()); })
      .catch(() => { this.inflight.delete(j.id); });
    this.track(p);
  }

  repoPathOf(projectId: string): string | null {
    const accept = this.deps.acceptFsRoot;
    if (!accept) return null;
    const p = this.db.prepare('SELECT root_path FROM projects WHERE id = ?').get(projectId) as { root_path: string | null } | undefined;
    if (!p || typeof p.root_path !== 'string' || p.root_path.length === 0) return null;
    try { return accept(p.root_path); } catch { return null; }
  }

  private track(p: Promise<unknown>): void {
    this.pending.add(p);
    void p.finally(() => this.pending.delete(p));
  }

  /** blob.integrity: ask the runner to re-hash each object once, then complete when every answer is in (or it cannot be). */
  private verifyStep(j: ValidateJobRow, versionId: string, now: number): void {
    let st = this.verifies.get(j.id);
    if (!st) {
      const objects = (this.db.prepare('SELECT DISTINCT sha256 FROM version_blobs WHERE version_id = ? ORDER BY sha256').all(versionId) as { sha256: string }[]).map((r) => r.sha256);
      if (objects.length === 0) { this.completeTx(j.id, versionId, integrity.run({ objects, answers: {} }), now); return; }
      st = { objects, answers: {}, startedAt: now };
      this.verifies.set(j.id, st);
      const send = this.deps.send;
      for (const sha of objects) {
        if (!send || !send({ op: 'blob.verify', sha256: sha })) st.answers[sha] = 'fault';
      }
    }
    const answered = st.objects.every((s) => st!.answers[s] !== undefined);
    const timedOut = now - st.startedAt >= VERIFY_TIMEOUT_MS;
    if (!answered && !timedOut) return;
    const answers: Record<string, integrity.VerifyAnswer> = {};
    for (const s of st.objects) answers[s] = st.answers[s] ?? 'no_answer';
    this.verifies.delete(j.id);
    this.completeTx(j.id, versionId, integrity.run({ objects: st.objects, answers }), now);
  }

  /** The runner's `blob.verified` answer. */
  onBlobVerified(sha256: string, ok: boolean): void {
    let hit = false;
    for (const st of this.verifies.values()) {
      if (st.objects.includes(sha256) && st.answers[sha256] === undefined) { st.answers[sha256] = ok ? 'ok' : 'mismatch'; hit = true; }
    }
    if (hit) this.runPending(this.deps.now());
  }

  /** A runner fault while re-hashes are outstanding: those checks could not run (`error`), never passed. */
  onRunnerFault(): void {
    let hit = false;
    for (const st of this.verifies.values()) {
      for (const s of st.objects) if (st.answers[s] === undefined) { st.answers[s] = 'fault'; hit = true; }
    }
    if (hit) this.runPending(this.deps.now());
  }

  /**
   * One IMMEDIATE transaction for a validate job executed in main: lease (attempt n), run, record the result bound to
   * (job, n), succeed, complete, finalize the version.
   */
  private completeTx(jobId: string, versionId: string | null, o: ValidatorOutcome, now: number): void {
    const system = this.system();
    immediateTx(this.db, () => {
      const j = this.db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId) as { id: string; project_id: string; state: JobState; validator_id: string | null; params_json: string; attempts: number } | undefined;
      if (!j || j.state !== 'queued') return;
      const move = (to: JobState, from: JobState, d?: { outcome?: string }): void => {
        this.deps.jobs.transitionTx(system, j.id, to, d, { expectState: from, now });
        const n = (this.db.prepare('SELECT attempts FROM jobs WHERE id = ?').get(j.id) as { attempts: number }).attempts;
        const has = !!this.db.prepare('SELECT 1 FROM job_attempts WHERE job_id = ? AND n = ?').get(j.id, n);
        appendJobEventTx(this.db, { type: 'job.transition', summary: `job ${from} -> ${to}${d?.outcome ? ` (${d.outcome})` : ''}`, projectId: j.project_id,
          jobId: j.id, attemptN: has ? n : null, data: { from, to, outcome: d?.outcome ?? null } }, now);
      };
      move('leased', 'queued');
      const n = (this.db.prepare('SELECT attempts FROM jobs WHERE id = ?').get(j.id) as { attempts: number }).attempts;
      const def = getValidator(j.validator_id ?? '');
      const sandbox = { executor: def?.executes === 'runner' ? 'runner' : 'main', validator: j.validator_id };
      const environment = { executor: sandbox.executor, validatorId: j.validator_id, validatorVersion: String(def?.version ?? 1), nexusVersion: this.deps.appVersion ?? null };
      const attemptId = newId(now);
      insertAttemptTx(this.db, { id: attemptId, jobId: j.id, projectId: j.project_id, n, bootId: this.mainBootId, now, logPath: null, sandbox, environment });
      transitionAttemptTx(this.db, attemptRow(this.db, attemptId)!, 'running', now, j.project_id);
      move('running', 'leased');
      if (versionId) this.recordOutcomeTx(versionId, j.validator_id ?? 'unknown', o, { jobId: j.id, attemptN: n, startedAt: now });
      transitionAttemptTx(this.db, attemptRow(this.db, attemptId)!, 'succeeded', now, j.project_id, { exit: { code: 0, oomKilled: false }, outcome: 'validated' });
      move('completed', 'running', { outcome: 'validated' });
      if (versionId) {
        const params = parse(j.params_json);
        this.finalizeIfReady(system, versionId, { allowPartial: isObj(params) && params.revalidate === true });
      }
    });
  }

  /**
   * A recipe validate job (`sde.tests_pass`) that ended without completing (no JUnit, an infrastructure failure, a
   * timeout) records its result once, bound to its last attempt: `failed` when the outputs were refused
   * (`invalid_output`: the report is missing), `error` otherwise (the check could not run). Then finalize.
   */
  recordEndedRecipeChecks(): void {
    this.endedStmt ??= this.db.prepare(`SELECT j.id, j.attempts, j.outcome, j.params_json, j.validator_id FROM jobs j
      WHERE j.state IN ('failed','timed_out','interrupted') AND j.kind = 'validate' AND j.recipe_id IS NOT NULL AND j.attempts > 0
        AND EXISTS (SELECT 1 FROM job_attempts a WHERE a.job_id = j.id AND a.n = j.attempts)
        AND NOT EXISTS (SELECT 1 FROM validations v WHERE v.job_id = j.id AND v.attempt_n = j.attempts)`);
    const rows = this.endedStmt.all() as
      { id: string; attempts: number; outcome: string | null; params_json: string; validator_id: string | null }[];
    const system = this.system();
    for (const r of rows) {
      const params = parse(r.params_json);
      const versionId = isObj(params) && typeof params.versionId === 'string' ? params.versionId : null;
      if (!versionId || !this.versionFacts(versionId)) continue;
      const a = this.db.prepare('SELECT outcome, exit_code, oom_killed FROM job_attempts WHERE job_id = ? AND n = ?').get(r.id, r.attempts) as
        { outcome: string | null; exit_code: number | null; oom_killed: number | null };
      const ev: Evidence[] = [{ type: 'exit', code: a.exit_code, oomKilled: a.oom_killed === 1 }];
      const o: ValidatorOutcome = a.outcome === 'invalid_output' || r.outcome === 'invalid_output'
        ? { status: 'failed', reason: 'junit_missing', summary: 'The JUnit report is missing or its outputs were refused.', evidence: ev }
        : errored(a.outcome ?? r.outcome ?? 'job_failed', 'Checks could not run: the test job did not finish.', ev);
      try {
        immediateTx(this.db, () => {
          this.recordOutcomeTx(versionId, r.validator_id ?? 'sde.tests_pass', o, { jobId: r.id, attemptN: r.attempts });
          this.finalizeIfReady(system, versionId, { allowPartial: isObj(params) && params.revalidate === true });
        });
      } catch (e) {
        this.log(`[nexus] validation: ended check not recorded: ${e instanceof PlatformError ? e.code : (e as Error)?.name ?? 'error'}`);
      }
    }
  }

  /** The scheduler's pass (every tick): progress waiting checks and time out unanswered re-hashes. */
  tick(now: number): void { this.runPending(now); }
}
