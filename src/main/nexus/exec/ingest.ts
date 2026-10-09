/**
 * Ingest of runner outputs (architecture §12.7, B2a). The execution core calls it after an attempt's exit is
 * durable: `prepare` (async, outside any transaction) gathers what main observes itself (its own `resolveCommit`
 * for a snapshot); `ingestTx` then runs inside ONE IMMEDIATE transaction, under the shared blob ingest lock, and
 * the core moves the attempt to `succeeded` and the job to `completed` in that same transaction, or fails both.
 *
 * In the transaction, per recipe:
 * - contract: the outputs the recipe needs are re-read from the report (shapes re-validated, never trusted);
 * - targets: a new or existing artifact owned by the job's participation, or the project's one `repository`;
 * - versions: drafts with `output_path`, `environment_json` (the attempt's, exactly) and `storage_kind`
 *   `inline` / `git` / `tree`, written whole while draft (ArtifactService.insertSystemVersionTx), with the
 *   producing attempt in `version_attempts`; blobs recorded and attached (role `discovery`, `file`, `junit`);
 * - lineage: edges to the job's granted inputs (source `job_input`) and to the previous version (source `ingest`);
 * - validators: register validators inline (ValidationService.runRegisterTx), then the finalize rule, then the
 *   candidate validate jobs (ValidationService.enqueueCandidate);
 * - idempotent: by `(produced_by_job_id, output_path)`, and by content hash (the same commit, the same list,
 *   the same tree). Output that deduplicates to an existing version still records a validation bound to
 *   (job, attempt n), so the evidence backstop sees the attempt's evidence.
 *
 * A recipe without an ingest rule here (dependency install, diagnostics: Task 9 and later) is refused with
 * `ingest_unavailable` / `no_ingest_rule`: unfinished work is never completed.
 */
import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { StagedOutput } from '../../../shared/nexus/execution';
import type { Principal } from '../../../shared/nexus/platform';
import type { ArtifactService } from '../artifact/artifactService';
import type { BlobIndex, IngestToken } from '../blobs/blobIndex';
import { PlatformError } from '../errors';
import type { ResolveCommit, ValidationService } from '../validation/validationService';
import { checkDiscovery, checkGitFacts, COMMIT_RE } from '../validation/normalized';
import * as tests from '../validation/validators/testsPass';
import { manifestSha256, exitZero, EXIT_ZERO, type TreeFile } from '../validation/validators/buildChecks';
import type { AttemptExited, IngestContext, IngestDecision, IngestPort } from './executionService';

export type { AttemptExited };

export interface IngestDeps {
  artifacts: ArtifactService;
  validation: ValidationService;
  blobs: BlobIndex | null;
  now: () => number;
  /** main's own async commit resolution in the project folder (src/main/git.ts resolveCommit). */
  resolveCommit?: ResolveCommit | null;
  /** Fault injection for tests: called inside the transaction after the version rows are written. */
  faults?: { afterRows?: (recipeId: string) => void } | null;
}

interface VersionRow { id: string; artifact_id: string; status: string; content_hash: string; storage_ref_json: string; metadata_json: string; draft_flag: string | null }
interface InputRow { version_id: string; role: string; status: string; storage_ref_json: string; metadata_json: string; kind: string }

const ok: IngestDecision = { ok: true };
const refuse = (outcome: string, code: string, message: string): IngestDecision => ({ ok: false, outcome, error: { code, message } });
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const parse = (t: string | null): unknown => { if (t === null) return null; try { return JSON.parse(t) as unknown; } catch { return null; } };
const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');
/** The version listing of the discovered files stays small; the full list is in the `ids.txt` blob. */
export const MAX_METADATA_FILES = 1000;

export class IngestService implements IngestPort {
  constructor(private readonly db: Database.Database, private readonly deps: IngestDeps) {}

  /** Async facts main observes itself, before the transaction: the snapshot's commit, resolved in the project folder. */
  prepare(ctx: IngestContext): unknown {
    if (ctx.recipe.id !== 'repo.snapshot') return null;
    const parsed = ctx.exited.parsed.find((p) => p.parser === 'repo-snapshot')?.normalized
      ?? ctx.exited.parsed.find((p) => isObj(p.normalized))?.normalized;
    const g = checkGitFacts(parsed);
    if (!g.ok) return { resolved: null };
    const root = this.deps.validation.repoPathOf(ctx.job.project_id);
    const resolve = this.deps.resolveCommit;
    if (!root || !resolve) return { resolved: null };
    return resolve(root, g.value.commit)
      .then((r) => ({ resolved: 'commit' in r ? { commit: r.commit } : { error: String(r.error) } }), () => ({ resolved: { error: 'git_failed' } }));
  }

  ingestTx(ctx: IngestContext): IngestDecision {
    if (!this.db.inTransaction) throw new PlatformError('platform_unavailable', 'ingest runs inside the exit transaction');
    switch (ctx.recipe.id) {
      case 'repo.snapshot': return this.snapshot(ctx);
      case 'sde.test.discover': return this.discovery(ctx);
      case 'sde.test.node': case 'sde.test.pytest': return this.testRun(ctx);
      case 'sde.build.node': case 'sde.build.python': return this.build(ctx);
      case 'sde.app.assemble': return this.assemble(ctx);
      default: return refuse('ingest_unavailable', 'no_ingest_rule', `outputs of ${ctx.recipe.id} are not ingested in this build`);
    }
  }

  // ---------- helpers ----------

  private token(ctx: IngestContext): IngestToken {
    if (!this.deps.blobs || !ctx.token) throw new PlatformError('conflict', 'blob writes need the ingest lock', { reason: 'lock_not_held' });
    return ctx.token;
  }

  private environment(ctx: IngestContext): unknown { return parse(ctx.attempt.environment_json); }

  /** The job's granted inputs of a slot, with their versions. */
  private inputs(jobId: string, role?: string): InputRow[] {
    return this.db.prepare(`SELECT ji.version_id, ji.role, v.status, v.storage_ref_json, v.metadata_json, a.kind FROM job_inputs ji
      JOIN artifact_versions v ON v.id = ji.version_id JOIN artifacts a ON a.id = v.artifact_id
      WHERE ji.job_id = ?${role ? ' AND ji.role = ?' : ''} ORDER BY ji.rowid`).all(...(role ? [jobId, role] : [jobId])) as InputRow[];
  }

  /** A version this job already ingested at this output path (idempotency by (produced_by_job_id, output_path)). */
  private already(jobId: string, outputPath: string): VersionRow | null {
    return (this.db.prepare('SELECT * FROM artifact_versions WHERE produced_by_job_id = ? AND output_path = ?').get(jobId, outputPath) as VersionRow | undefined) ?? null;
  }

  /** The live (draft, candidate or active) version of an artifact with this content, newest first. */
  private sameContent(artifactId: string, contentHash: string): VersionRow | null {
    return (this.db.prepare(`SELECT * FROM artifact_versions WHERE artifact_id = ? AND content_hash = ? AND status IN ('draft','candidate','active')
      ORDER BY version_no DESC LIMIT 1`).get(artifactId, contentHash) as VersionRow | undefined) ?? null;
  }

  /** The newest live version of an artifact (the `derived_from` source of the next one). */
  private latestLive(artifactId: string): VersionRow | null {
    return (this.db.prepare(`SELECT * FROM artifact_versions WHERE artifact_id = ? AND status IN ('draft','candidate','active')
      ORDER BY version_no DESC LIMIT 1`).get(artifactId) as VersionRow | undefined) ?? null;
  }

  /** The participation-owned artifact of this kind and name the job's participation writes to, or null. */
  private ownedArtifact(participationId: string, kind: string, name: string): string | null {
    return (this.db.prepare(`SELECT id FROM artifacts WHERE owner_participation_id = ? AND kind = ? AND name = ? AND status = 'active'
      ORDER BY created_at, id LIMIT 1`).get(participationId, kind, name) as { id: string } | undefined)?.id ?? null;
  }

  private bindAttempt(versionId: string, jobId: string, n: number): void {
    this.db.prepare('INSERT INTO version_attempts (version_id, job_id, attempt_n) VALUES (?, ?, ?)').run(versionId, jobId, n);
  }

  private record(token: IngestToken, outputs: StagedOutput[]): void {
    if (outputs.length) this.deps.blobs!.recordBlobsTx(token, outputs.map((o) => ({ sha256: o.sha256, bytes: o.bytes, mediaType: o.mediaType })));
  }

  // ---------- repository snapshot (engine) ----------

  private snapshot(ctx: IngestContext): IngestDecision {
    const { job, attempt, system } = ctx;
    const reported = ctx.exited.parsed.find((p) => p.parser === 'repo-snapshot')?.normalized
      ?? ctx.exited.parsed.find((p) => isObj(p.normalized))?.normalized;
    const g = checkGitFacts(reported);
    if (!g.ok) return refuse('invalid_output', 'parser_contract', `the snapshot facts were not usable: ${g.message}`);
    const facts = isObj(ctx.facts) ? ctx.facts : {};
    const resolved = (isObj(facts.resolved) ? facts.resolved : null) as { commit: string } | { error: string } | null;
    const headFacts = { storageCommit: g.value.commit, reported, resolved };
    const repo = this.db.prepare("SELECT id FROM artifacts WHERE project_id = ? AND kind = 'repository' AND status = 'active' LIMIT 1")
      .get(job.project_id) as { id: string } | undefined;
    const contentHash = `git:${g.value.commit}`;
    const prior = this.already(job.id, 'facts') ?? (repo ? this.sameContent(repo.id, contentHash) : null);
    if (prior) {
      // The same commit was already snapshotted: one version. The check still runs and binds this attempt's evidence.
      this.deps.validation.recordOutcomeTx(prior.id, 'git.head_resolves', this.deps.validation.runPure('git.head_resolves', headFacts),
        { jobId: job.id, attemptN: attempt.n });
      return ok;
    }
    const previous = repo ? this.latestLive(repo.id) : null;
    const v = this.deps.artifacts.insertSystemVersionTx(system, {
      ...(repo ? { artifactId: repo.id } : { newArtifact: { kind: 'repository', name: 'Repository', participation: null } }),
      storage: { kind: 'git', commit: g.value.commit, ...(g.value.branch ? { ref: g.value.branch } : {}) },
      contentHash, metadata: { branch: g.value.branch, dirty: g.value.dirty, tree: g.value.tree },
      environment: this.environment(ctx), jobId: job.id, attemptN: attempt.n, outputPath: 'facts', action: 'exec.snapshot',
      onBehalfOf: job.on_behalf_of, now: this.deps.now(),
      inputs: previous ? [{ versionId: previous.id, role: 'previous', relation: 'derived_from', source: 'ingest' }] : []
    });
    this.bindAttempt(v.id, job.id, attempt.n);
    this.deps.faults?.afterRows?.(ctx.recipe.id);
    this.deps.validation.runRegisterTx(system, v.id, { 'git.head_resolves': headFacts }, { jobId: job.id, attemptN: attempt.n });
    this.deps.validation.finalizeIfReady(system, v.id);
    return ok;
  }

  // ---------- test discovery ----------

  private discovery(ctx: IngestContext): IngestDecision {
    const { job, attempt, system } = ctx;
    const staged = ctx.exited.outputs.find((o) => o.relPath === 'ids.txt');
    if (!staged) return refuse('invalid_output', 'outputs_missing', 'the discovered list (ids.txt) is missing');
    const parsed = ctx.exited.parsed.find((p) => p.parser === 'discovery');
    const repo = this.inputs(job.id, 'repository')[0];
    if (!repo || job.participation_id === null) return refuse('invalid_output', 'bad_input', 'discovery has no repository input');
    const repoStorage = parse(repo.storage_ref_json) as Record<string, unknown> | null;
    const commit = isObj(repoStorage) && typeof repoStorage.commit === 'string' && COMMIT_RE.test(repoStorage.commit) ? repoStorage.commit : null;
    if (!commit) return refuse('invalid_output', 'bad_input', 'the repository input stores no commit');
    const d = checkDiscovery(parsed?.normalized);
    const repoMeta = parse(repo.metadata_json);
    const env = parse(ctx.attempt.environment_json);
    const profile = isObj(repoMeta) && typeof repoMeta.profile === 'string' ? repoMeta.profile
      : isObj(env) && typeof env.profile === 'string' ? env.profile : null;
    const registerFacts = { 'suite.discovered': { discovery: parsed?.normalized ?? null, listSha256: parsed?.sourceSha256 ?? null, storedSha256: staged.sha256 } };
    const contentHash = sha256(`test_suite\n${commit}\n${staged.sha256}`);
    const artifactId = this.ownedArtifact(job.participation_id, 'test_suite', 'Test suite');
    const prior = this.already(job.id, 'ids.txt') ?? (artifactId ? this.sameContent(artifactId, contentHash) : null);
    if (prior) {
      this.deps.validation.recordOutcomeTx(prior.id, 'suite.discovered', this.deps.validation.runPure('suite.discovered', registerFacts['suite.discovered']),
        { jobId: job.id, attemptN: attempt.n });
      return ok;
    }
    const previous = artifactId ? this.latestLive(artifactId) : null;
    const files = d.ok ? d.value.files.slice(0, MAX_METADATA_FILES) : [];
    const ids = d.ok ? d.value.ids.slice(0, MAX_METADATA_FILES) : [];
    const v = this.deps.artifacts.insertSystemVersionTx(system, {
      ...(artifactId ? { artifactId } : { newArtifact: { kind: 'test_suite', name: 'Test suite', participation: job.participation_id } }),
      storage: { kind: 'git', commit }, contentHash,
      metadata: { profile: profile ?? 'sde-node', framework: d.ok ? d.value.framework : null, files, commit,
        count: d.ok ? Math.max(d.value.ids.length, d.value.files.length) : 0,
        discovery: { sha256: parsed?.sourceSha256 ?? null, framework: d.ok ? d.value.framework : null, files, ids,
          truncated: d.ok ? d.value.files.length > MAX_METADATA_FILES || d.value.ids.length > MAX_METADATA_FILES : false } },
      environment: this.environment(ctx), jobId: job.id, attemptN: attempt.n, outputPath: 'ids.txt', action: 'exec.discover',
      onBehalfOf: job.on_behalf_of, now: this.deps.now(),
      inputs: [{ versionId: repo.version_id, role: 'repository', relation: 'derived_from', source: 'job_input' },
        ...(previous ? [{ versionId: previous.id, role: 'previous', relation: 'derived_from' as const, source: 'ingest' as const }] : [])]
    });
    this.bindAttempt(v.id, job.id, attempt.n);
    const token = this.token(ctx);
    this.record(token, [staged]);
    this.deps.blobs!.attachTx(token, v.id, [{ sha256: staged.sha256, role: 'discovery', path: 'ids.txt' }]);
    this.deps.faults?.afterRows?.(ctx.recipe.id);
    this.deps.validation.runRegisterTx(system, v.id, registerFacts, { jobId: job.id, attemptN: attempt.n });
    if (this.deps.validation.finalizeIfReady(system, v.id) === 'draft' && this.registerPassed(v.id)) {
      this.deps.validation.enqueueCandidate(system, v.id, { parentJobId: job.id });
    }
    return ok;
  }

  /** Every register validator of the version's latest rows passed. */
  private registerPassed(versionId: string): boolean {
    return !this.db.prepare(`SELECT 1 FROM validations v WHERE v.version_id = ? AND v.stage = 'register' AND v.blocking = 1 AND v.status <> 'passed'
      AND NOT EXISTS (SELECT 1 FROM validations w WHERE w.version_id = v.version_id AND w.validator_id = v.validator_id
        AND (w.finished_at > v.finished_at OR (w.finished_at = v.finished_at AND w.rowid > v.rowid)))`).get(versionId);
  }

  // ---------- a test run (the sde.tests_pass check, or a user's run on a suite) ----------

  private testRun(ctx: IngestContext): IngestDecision {
    const { job, attempt, system } = ctx;
    let suiteId: string | null = null;
    if (job.kind === 'validate') {
      const params = parse(job.params_json);
      suiteId = isObj(params) && typeof params.versionId === 'string' ? params.versionId : null;
    } else {
      suiteId = this.inputs(job.id, 'suite')[0]?.version_id ?? null;
    }
    const suite = suiteId ? this.db.prepare(`SELECT v.*, a.kind FROM artifact_versions v JOIN artifacts a ON a.id = v.artifact_id
      WHERE v.id = ? AND v.project_id = ?`).get(suiteId, job.project_id) as (VersionRow & { kind: string }) | undefined : undefined;
    if (!suite || suite.kind !== 'test_suite') return refuse('invalid_output', 'bad_input', 'the test run has no test suite');
    const meta = parse(suite.metadata_json);
    const disc = isObj(meta) && isObj(meta.discovery) ? meta.discovery : null;
    const list = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
    const files = list(disc?.files ?? (isObj(meta) ? meta.files : []));
    const ids = list(disc?.ids ?? files);
    const staged = ctx.exited.outputs.find((o) => o.relPath === 'junit.xml') ?? null;
    const parsed = ctx.exited.parsed.find((p) => p.parser === 'junit');
    const env = parse(ctx.attempt.environment_json);
    const outcome = tests.run({
      junit: parsed?.normalized ?? null, junitSha256: staged?.sha256 ?? null,
      exit: { code: ctx.exited.exit.code, ...(ctx.exited.exit.signal ? { signal: ctx.exited.exit.signal } : {}), oomKilled: ctx.exited.exit.oomKilled },
      discovery: { ids, files },
      imageId: isObj(env) && typeof env.imageId === 'string' ? env.imageId : null,
      lockfileSha256: isObj(env) && typeof env.lockfileSha256 === 'string' ? env.lockfileSha256 : null
    });
    if (staged && suite.status === 'draft') {
      // The report's bytes stay with the suite they judged (attached while it is still a draft).
      const token = this.token(ctx);
      this.record(token, [staged]);
      this.deps.blobs!.attachTx(token, suite.id, [{ sha256: staged.sha256, role: 'junit', path: `junit/${job.id}-${attempt.n}.xml` }]);
    }
    this.deps.faults?.afterRows?.(ctx.recipe.id);
    this.deps.validation.recordOutcomeTx(suite.id, tests.ID, outcome, { jobId: job.id, attemptN: attempt.n });
    const params = parse(job.params_json);
    this.deps.validation.finalizeIfReady(system, suite.id, { allowPartial: isObj(params) && params.revalidate === true });
    return ok;
  }

  // ---------- build (a tree) ----------

  private build(ctx: IngestContext): IngestDecision {
    const { job, attempt, system } = ctx;
    const repo = this.inputs(job.id, 'repository')[0];
    if (!repo || job.participation_id === null) return refuse('invalid_output', 'bad_input', 'the build has no repository input');
    const files: TreeFile[] = ctx.exited.outputs.filter((o) => o.relPath.startsWith('dist/') && o.relPath.length > 5)
      .map((o) => ({ path: o.relPath.slice(5), sha256: o.sha256, bytes: o.bytes }));
    const tree = { kind: 'tree' as const, manifestSha256: manifestSha256(files), files: files.length, bytes: files.reduce((s, f) => s + f.bytes, 0) };
    const contentHash = `tree:${tree.manifestSha256}`;
    const artifactId = this.ownedArtifact(job.participation_id, 'build', 'Build');
    const prior = this.already(job.id, 'dist') ?? (artifactId ? this.sameContent(artifactId, contentHash) : null);
    const exitFacts = { exit: { code: ctx.exited.exit.code, ...(ctx.exited.exit.signal ? { signal: ctx.exited.exit.signal } : {}), oomKilled: ctx.exited.exit.oomKilled } };
    if (prior) {
      this.deps.validation.recordOutcomeTx(prior.id, EXIT_ZERO, exitZero(exitFacts), { jobId: job.id, attemptN: attempt.n });
      return ok;
    }
    const repoMeta = parse(repo.metadata_json);
    const repoStorage = parse(repo.storage_ref_json);
    const commit = isObj(repoStorage) && typeof repoStorage.commit === 'string' && COMMIT_RE.test(repoStorage.commit) ? repoStorage.commit : null;
    const previous = artifactId ? this.latestLive(artifactId) : null;
    const v = this.deps.artifacts.insertSystemVersionTx(system, {
      ...(artifactId ? { artifactId } : { newArtifact: { kind: 'build', name: 'Build', participation: job.participation_id } }),
      storage: tree, contentHash,
      metadata: { profile: isObj(repoMeta) && typeof repoMeta.profile === 'string' ? repoMeta.profile : null, commit, files: files.length, bytes: tree.bytes },
      environment: this.environment(ctx), jobId: job.id, attemptN: attempt.n, outputPath: 'dist', action: 'exec.build',
      onBehalfOf: job.on_behalf_of, now: this.deps.now(),
      inputs: [{ versionId: repo.version_id, role: 'repository', relation: 'built_from', source: 'job_input' },
        ...(previous ? [{ versionId: previous.id, role: 'previous', relation: 'derived_from' as const, source: 'ingest' as const }] : [])]
    });
    this.bindAttempt(v.id, job.id, attempt.n);
    if (files.length) {
      const token = this.token(ctx);
      const staged = ctx.exited.outputs.filter((o) => o.relPath.startsWith('dist/') && o.relPath.length > 5);
      this.record(token, staged);
      this.deps.blobs!.attachTx(token, v.id, files.map((f) => ({ sha256: f.sha256, role: 'file' as const, path: f.path })));
    }
    this.deps.faults?.afterRows?.(ctx.recipe.id);
    this.deps.validation.enqueueCandidate(system, v.id, { parentJobId: job.id });
    return ok;
  }

  // ---------- application assembly (engine) ----------

  private assemble(ctx: IngestContext): IngestDecision {
    const { job, attempt, system } = ctx;
    const buildIn = this.inputs(job.id, 'build')[0];
    if (!buildIn || job.participation_id === null) return refuse('invalid_output', 'bad_input', 'assembly has no build input');
    // The engine reports `{ manifest }`: the nexus.app.json it read at the build's commit (re-validated by app.manifest_schema).
    const facts = ctx.exited.parsed.find((p) => p.parser === 'app-manifest')?.normalized
      ?? ctx.exited.parsed.find((p) => isObj(p.normalized))?.normalized;
    const manifest = isObj(facts) ? facts.manifest : undefined;
    if (!isObj(manifest)) return refuse('invalid_output', 'parser_contract', 'the manifest was not usable');
    let storage: { kind: 'inline'; json: unknown };
    try { storage = { kind: 'inline', json: JSON.parse(JSON.stringify(manifest)) as unknown }; } catch { return refuse('invalid_output', 'parser_contract', 'the manifest is not JSON'); }
    const contentHash = sha256(`application\n${buildIn.version_id}\n${JSON.stringify(manifest)}`);
    const artifactId = this.ownedArtifact(job.participation_id, 'application', 'Application');
    const prior = this.already(job.id, 'manifest') ?? (artifactId ? this.sameContent(artifactId, contentHash) : null);
    if (prior) {
      this.deps.validation.recordOutcomeTx(prior.id, 'app.manifest_schema', this.deps.validation.runPure('app.manifest_schema', manifest), { jobId: job.id, attemptN: attempt.n });
      return ok;
    }
    const previous = artifactId ? this.latestLive(artifactId) : null;
    const v = this.deps.artifacts.insertSystemVersionTx(system, {
      ...(artifactId ? { artifactId } : { newArtifact: { kind: 'application', name: 'Application', participation: job.participation_id } }),
      storage, contentHash, metadata: {}, environment: this.environment(ctx), jobId: job.id, attemptN: attempt.n, outputPath: 'manifest',
      action: 'exec.assemble', onBehalfOf: job.on_behalf_of, now: this.deps.now(),
      inputs: [{ versionId: buildIn.version_id, role: 'build', relation: 'assembled_from', source: 'job_input' },
        ...(previous ? [{ versionId: previous.id, role: 'previous', relation: 'derived_from' as const, source: 'ingest' as const }] : [])]
    });
    this.bindAttempt(v.id, job.id, attempt.n);
    this.deps.faults?.afterRows?.(ctx.recipe.id);
    this.deps.validation.runRegisterTx(system, v.id, { 'app.manifest_schema': manifest }, { jobId: job.id, attemptN: attempt.n });
    this.deps.validation.finalizeIfReady(system, v.id);
    return ok;
  }
}

/** Ingest one exited attempt through the execution core (system only): the interface the plan names. */
export function ingestAttempt(exec: { ingestAttempt(system: Principal, attemptId: string, exited: AttemptExited): Promise<void> },
  system: Principal, attemptId: string, exited: AttemptExited): Promise<void> {
  return exec.ingestAttempt(system, attemptId, exited);
}
