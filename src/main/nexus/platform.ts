/**
 * The Nexus platform composition root. It wires the core services onto the one
 * better-sqlite3 connection that PersistStore opened at schema v7. It grows task by
 * task; it holds principal resolution, authorization, the activity read API,
 * workspaces and project participation, project-scoped access checks, artifacts
 * with their versions, the version-level lineage DAG, durable jobs, agent
 * sessions and, at schema v8, handoffs (null below v8 or when v8 is held or
 * failed). At schema v9, with `execution` on, it also composes the execution core
 * (ExecutionService, its runner attached later by main) and the one BlobIndex, the
 * validation framework and ingest, and (B2a Task 9) the approval service (once-only
 * egress and image approvals, image builds), dev deployments and snapshot requests,
 * each late-bound to the execution core.
 *
 * No IPC is registered here. Callers in main pass a Principal resolved through
 * `principals`; the renderer never supplies identity.
 */
import type Database from 'better-sqlite3';
import { ActivityService } from './activity/activityService';
import { ArtifactService } from './artifact/artifactService';
import { AuthService } from './auth/authService';
import { HandoffService } from './handoff/handoffService';
import { JobService } from './jobs/jobService';
import { BlobIndex } from './blobs/blobIndex';
import { ExecutionService, type ExecDataHome, type EgressApprovalPort, type IngestPort } from './exec/executionService';
import { IngestService } from './exec/ingest';
import { ApprovalService, type ImageContext } from './approvals/approvalService';
import { DeploymentService } from './deployments/deploymentService';
import { RepoService } from './repo/repoService';
import { ValidationService, type ResolveCommit } from './validation/validationService';
import type { ArtifactValidatorHooks } from './artifact/artifactService';
import type { SandboxProfile } from '../../shared/nexus/execution';
import { PrincipalResolver } from './auth/principals';
import { LineageService } from './lineage/lineageService';
import { ProjectAccess } from './project/projectAccess';
import { v8ShapeProblem } from './db/schemaV8';
import { v9ShapeProblem } from './db/schemaV9';
import { SessionService } from './sessions/sessionService';
import { WorkspaceService } from './workspace/workspaceService';

export interface NexusPlatform {
  principals: PrincipalResolver;
  auth: AuthService;
  activity: ActivityService;
  workspaces: WorkspaceService;
  projects: ProjectAccess;
  artifacts: ArtifactService;
  lineage: LineageService;
  jobs: JobService;
  sessions: SessionService;
  /** Handoffs between participations (schema v8); null when v8 is held, failed or not in place. */
  handoffs: HandoffService | null;
  /** True exactly when `handoffs` is built: the store is at v8 with its shape checked. */
  handoffsAvailable: boolean;
  /**
   * True when the caller (main) turned execution on (`opts.execution`, from PersistStore.executionAvailable),
   * handoffs are built and the v9 shape checks. False by default.
   */
  executionAvailable: boolean;
  /**
   * The execution core. Always built; while `executionAvailable` is false every user-facing method refuses
   * with platform_unavailable (reason `not_enabled` or the store's sub-reason) and it never touches a v9
   * table. The runner is attached later by main (null until the runner host exists).
   */
  exec: ExecutionService;
  /** The one blob index of this platform (ingest and GC share it and its lock); null unless execution is available. */
  blobs: BlobIndex | null;
  /** Validator results, the finalize rule and the validate jobs (schema v9); null unless execution is available. */
  validation: ValidationService | null;
  /** Once-only approvals (egress, image preparation) and image builds (schema v9); null unless execution is available. */
  approvals: ApprovalService | null;
  /** Local dev deployments (schema v9); null unless execution is available. */
  deployments: DeploymentService | null;
  /** Repository snapshot requests and the app manifest contract; null unless execution is available. */
  repo: RepoService | null;
  startup(): NexusStartupReport;
}

/** What one startup pass did; every count is 0 on a clean restart. */
export interface NexusStartupReport {
  catalogAdded: number;
  primaries: { set: number; cleared: number };
  sessions: { interrupted: number };
  jobs: { interrupted: number; requeued: number };
}

export interface NexusPlatformOptions {
  now?: () => number; log?: (line: string) => void; handoffs?: boolean; execution?: boolean;
  /** Why execution is off, as PersistStore says (`held`, `auto_held`, `backup_failed`, `failed`, `shape`); default `not_enabled`. */
  executionUnavailableReason?: string | null;
  /** Execution wiring (main): the data home, the pinned sandbox profiles, the project-folder acceptance. */
  dataHome?: ExecDataHome | null;
  profiles?: readonly SandboxProfile[];
  acceptFsRoot?: ((root: string) => string | null) | null;
  /**
   * The egress approval port of the execution core: omitted, the platform's own ApprovalService (which also expires
   * approvals on the scheduler's cadence); null, none (egress recipes are refused); an object, that port (tests).
   */
  approvals?: EgressApprovalPort | null;
  /** The build context of each profile image (B2a Task 12, from infra/images); without it image preparation is refused. */
  imageContexts?: ((profileId: string) => ImageContext | null) | null;
  /** main's own async git repository check (src/main/git.ts isRepo); without it snapshot requests are unavailable. */
  isRepository?: ((root: string) => Promise<boolean>) | null;
  /** The ingest of runner outputs: omitted, the platform's own (Task 8); null, none (exits then fail ingest_unavailable). */
  ingest?: IngestPort | null;
  /** main's own async commit resolution in the project folder (src/main/git.ts resolveCommit), for git.head_resolves. */
  resolveCommit?: ResolveCommit | null;
  /** Tests only: fault injection inside the ingest transaction. */
  ingestFaults?: { afterRows?: (recipeId: string) => void } | null;
  /** The Nexus app version recorded in each attempt's environment. */
  appVersion?: string | null;
}

export function createNexusPlatform(db: Database.Database, opts?: NexusPlatformOptions): NexusPlatform {
  const now = opts?.now ?? Date.now;
  const log = opts?.log ?? (() => {});
  // The caller (main) may turn handoffs off; they are on only when the v8 shape also checks, so a forced `true` on a
  // bad shape never builds a refusing service that would block workspace withdraw.
  const handoffsOn = (opts?.handoffs ?? true) && v8ShapeProblem(db, true) === null;
  const principals = new PrincipalResolver(db);
  const auth = new AuthService(db, { now, log });
  const activity = new ActivityService(db, { auth });
  // Late-bound: the withdraw guard counts open handoffs once the handoff service exists (never below v8).
  let handoffs: HandoffService | null = null;
  const workspaces = new WorkspaceService(db, { auth, now, log, openHandoffs: (id) => handoffs?.openCountFor(id) ?? 0 });
  const projects = new ProjectAccess(db, { auth });
  // Late-bound: inline saves record their register validators once the validation service exists (v9).
  const artifactHooks: ArtifactValidatorHooks = {};
  const artifacts = new ArtifactService(db, { auth, now, validators: artifactHooks });
  const lineage = new LineageService(db, { auth, now });
  const jobs = new JobService(db, { auth, now });
  const sessions = new SessionService(db, { auth, jobs, now });
  if (handoffsOn) handoffs = new HandoffService(db, { auth, principals, artifacts, now });
  else log('[nexus] handoffs unavailable: schema v8 not in place');
  const handoffsAvailable = handoffs !== null;
  // Execution is off unless the caller turns it on (v9 stays off until verified); like handoffs, a forced `true`
  // counts only when the v9 shape also checks. Nothing executes yet: this flag is read by later services.
  const executionAvailable = (opts?.execution ?? false) && handoffsAvailable && v9ShapeProblem(db, true) === null;
  const unavailableReason = executionAvailable ? null
    : !(opts?.execution ?? false) ? (opts?.executionUnavailableReason ?? 'not_enabled')
      : !handoffsAvailable ? 'v8_unavailable' : 'shape';
  // Exactly one BlobIndex per platform, shared by ingest and GC (one lock); built only with execution.
  const blobs = executionAvailable ? new BlobIndex(db, { auth, now }) : null;
  const validation = executionAvailable ? new ValidationService(db, { auth, artifacts, jobs, now, log, blobs,
    resolveCommit: opts?.resolveCommit ?? null, acceptFsRoot: opts?.acceptFsRoot ?? null, appVersion: opts?.appVersion ?? null }) : null;
  if (validation) artifactHooks.recordInlineRegisterTx = (versionId, kind, content) => validation.recordInlineRegisterTx(versionId, kind, content);
  const ingest: IngestPort | null = opts?.ingest !== undefined ? opts.ingest
    : validation ? new IngestService(db, { artifacts, validation, blobs, now, resolveCommit: opts?.resolveCommit ?? null, faults: opts?.ingestFaults ?? null })
      : null;
  // Task 9: approvals and image builds, dev deployments, snapshot requests. Each is late-bound to the execution core.
  const approvals = executionAvailable ? new ApprovalService(db, { auth, now, log, imageContext: opts?.imageContexts ?? null }) : null;
  const deployments = executionAvailable && validation ? new DeploymentService(db, { auth, now, log, validation }) : null;
  const repo = executionAvailable ? new RepoService(db, { auth, now, log, acceptFsRoot: opts?.acceptFsRoot ?? null,
    isRepository: opts?.isRepository ?? null }) : null;
  const exec = new ExecutionService(db, {
    auth, jobs, now, log, available: executionAvailable, unavailableReason, blobs,
    dataHome: opts?.dataHome ?? null, profiles: opts?.profiles ?? [], acceptFsRoot: opts?.acceptFsRoot ?? null,
    approvals: opts?.approvals !== undefined ? opts.approvals : approvals, images: approvals, deployments,
    // With main's repository check wired in, a snapshot starts only through RepoService (which runs it first).
    snapshotsNeedRepositoryCheck: !!opts?.isRepository,
    ingest, validation, appVersion: opts?.appVersion ?? null
  });
  validation?.setSender((msg) => exec.sendToRunner(msg));
  approvals?.bindExecution(exec);
  deployments?.bindExecution(exec);
  repo?.bindExecution(exec);
  if (executionAvailable) log('[nexus] execution core ready: runner not attached');
  return {
    principals, auth, activity, workspaces, projects, artifacts, lineage, jobs, sessions, handoffs, handoffsAvailable, executionAvailable,
    exec, blobs, validation, approvals, deployments, repo,
    startup(): NexusStartupReport {
      // The seeded principals must resolve; a missing one throws platform_unavailable.
      principals.localUser();
      const system = principals.system();
      const added = workspaces.ensureCatalog(system);
      // Repairs a primary whose in-save sync failed and rows written by an older build.
      const r = workspaces.reconcileLegacyPrimaries(system);
      // Nothing executes across a restart: sessions first, then their jobs.
      const s = sessions.recoverAfterRestart(system);
      const j = jobs.recoverAfterRestart(system);
      log(`[nexus] platform ready: principals ok, workspaces added=${added}, primaries set=${r.set} cleared=${r.cleared}, `
        + `sessions interrupted=${s.interrupted}, jobs interrupted=${j.interrupted} requeued=${j.requeued}`);
      return {
        catalogAdded: added,
        primaries: { set: r.set, cleared: r.cleared },
        sessions: { interrupted: s.interrupted },
        jobs: { interrupted: j.interrupted, requeued: j.requeued }
      };
    }
  };
}
