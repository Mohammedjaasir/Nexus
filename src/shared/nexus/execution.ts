// Shared execution contracts (B2a): the sandbox a job runs in, the plan main
// hands to the runner, and the facts the runner reports back. Types and a few
// constant tables only; no I/O. Main builds every value of these types; the
// renderer never supplies a path, a command, a network or a limit.

/** The sandbox profiles. Each maps to one pinned image. */
export type SandboxProfileId = 'sde-node' | 'sde-python' | 'qa-web' | 'data-python' | 'ml-python' | 'dl-cpu' | 'nexus-fwd';
export const SANDBOX_PROFILE_IDS: readonly SandboxProfileId[] =
  ['sde-node', 'sde-python', 'qa-web', 'data-python', 'ml-python', 'dl-cpu', 'nexus-fwd'];

/** Every container runs as this non-root user (`--user`). */
export const SANDBOX_UID = 10001;
export const SANDBOX_GID = 10001;
export const SANDBOX_USER = `${SANDBOX_UID}:${SANDBOX_GID}`;
/** The two tmpfs mounts every container gets; `/tmp` is sized by `ResourceLimits.tmpfsMb`. */
export const TMP_TMPFS_PATH = '/tmp';
export const HOME_TMPFS_PATH = '/home/nexus';
export const HOME_TMPFS_MB = 256;

export interface SandboxProfile {
  id: SandboxProfileId;
  /**
   * `repository` and `digest` name the pinned base (recorded per attempt). `source`: `built` (default; every B2a
   * profile: Nexus builds the image locally, so containers are created by the local image id `sha256:<id>`) or
   * `pulled` (an image pulled from a registry by digest: containers are created by `repository@digest`).
   */
  image: { repository: string; digest: `sha256:${string}`; source?: 'built' | 'pulled' };
  user: { uid: 10001; gid: 10001 };                              // non-root
  defaults: ResourceLimits;
  /** The Nexus-owned entry (`nexus-entry <wallSeconds> … --`); the recipe argv follows it as `Cmd`. */
  entrypoint: string[];
  /** ENV names the image itself sets (PATH, HOME, LANG, NODE_VERSION, …). Any other name in a container is refused. */
  imageEnv: string[];
}

export interface ResourceLimits {
  cpus: number;            // --cpus
  memoryMb: number;        // --memory and --memory-swap (no swap)
  pids: number;            // --pids-limit
  wallClockMs: number;     // runner timer + the entry script's own timeout
  outputMaxBytes: number;  // the /out size guard
  tmpfsMb: number;         // size of the /tmp tmpfs
}

export type NetworkMode =
  | { mode: 'none' }
  | { mode: 'egress-approved'; approvalId: string; purpose: 'deps' | 'weights' }   // per-job bridge nexus-egress-<jobId>
  | { mode: 'service-internal'; network: string }                                // internal nexus-svc-<jobId>
  | { mode: 'test-internal'; network: string };                                  // joins a preview's internal network

export interface MountSpec {
  kind: 'input' | 'workspace' | 'out' | 'deps' | 'log';
  /** An absolute host path (a bind mount) or a named volume (`nexus-ws-<attemptId>`, `nexus-deps-…`). */
  hostPath: string;
  containerPath: string;
  readOnly: boolean;
  versionId?: string;
  contentHash?: string;
}

export interface ContainerLabels {
  'nexus.job': string; 'nexus.attempt': string; 'nexus.boot': string; 'nexus.project': string;
  /** What the container is for (`tool`, `service`, `forwarder`); main sets it on every container it plans. */
  'nexus.kind'?: string;
  /**
   * This install: the first 16 hex characters of the sha256 of the resolved data-home root. Restart recovery removes
   * only resources that carry this install's value (another Nexus on the same Docker daemon is never touched).
   */
  'nexus.home'?: string;
}

/**
 * The labels the runner puts on every volume and network it creates for an attempt (`nexus-ws-*`, `nexus-egress-*`,
 * `nexus-svc-*`, `nexus-pub-*`), exactly as given: restart recovery scopes its removals by `nexus.home` and `nexus.attempt`.
 */
export interface ResourceLabels {
  'nexus.job': string; 'nexus.attempt': string; 'nexus.boot': string; 'nexus.project': string; 'nexus.home': string;
}

export interface ContainerSpec {
  name: `nexus-${string}`;
  labels: ContainerLabels;
  profile: SandboxProfileId;
  /**
   * The image to run, digest-pinned: `ref` is `<repository>@sha256:<64 hex>` or the local image id itself
   * (`sha256:<64 hex>`, for an image Nexus built); `id` is the local image id. Main fills it from the
   * profile and the latest succeeded image build.
   */
  image: { ref: string; id: `sha256:${string}` };
  entrypoint: string[];                 // the profile's entry, exactly (Config.Entrypoint)
  argv: string[];                       // filled from the recipe template; never a shell string (Config.Cmd)
  imageEnv: string[];                   // copied from the profile: ENV names the image may set
  env: Record<string, string>;          // non-secret, recipe-declared, validated
  mounts: MountSpec[];
  network: NetworkMode;
  limits: ResourceLimits;
  readOnlyRootfs: true;
  capDrop: ['ALL'];
  noNewPrivileges: true;
  /** An app container's port and health path; reachable only through the forwarder. */
  service?: { containerPort: number; healthPath: string };
  /** The forwarder only: the single loopback port it publishes. */
  publish?: { hostIp: '127.0.0.1'; hostPort: number; containerPort: number };
}

export interface PreflightObserved {
  nanoCpus: number; memory: number; memorySwap: number; pidsLimit: number; networkMode: string; readonlyRootfs: boolean;
  capDrop: string[]; capAdd: string[]; privileged: boolean; user: string; securityOpt: string[];
  mounts: { dst: string; rw: boolean; type: string }[]; portBindings: string[]; tmpfs: string[]; devices: string[];
}

/** The result of comparing `docker inspect` with the spec. Any problem: remove the container, fail `limits_not_applied`. */
export interface PreflightReport {
  ok: boolean;
  observed: PreflightObserved;
  problems: string[];
}

export interface ExitInfo { code: number | null; signal?: string; oomKilled: boolean; finishedAt: number }

export interface SandboxProbe {
  docker: 'missing' | 'stopped' | 'running';
  version?: string; os?: string; wsl2?: boolean;
  cpus?: number; memoryBytes?: number;
  gpu: { detected: boolean; model?: string; usableInContainers: false };
}

export interface ImageStatus {
  profile: SandboxProfileId;
  present: boolean;
  digestMatches: boolean;
  sizeBytes?: number;
  imageId?: string;
  contextSha256?: string;
}

export interface SandboxDriver {
  probe(): Promise<SandboxProbe>;
  imageStatus(profile: SandboxProfileId): Promise<{ present: boolean; digestMatches: boolean; sizeBytes?: number }>;
  prepareImage(profile: SandboxProfileId, approvalId: string, signal: AbortSignal): AsyncIterable<{ phase: string; bytes?: number }>;
  create(spec: ContainerSpec): Promise<{ containerId: string }>;
  preflight(containerId: string, spec: ContainerSpec): Promise<PreflightReport>;
  start(containerId: string): Promise<void>;
  exec(containerId: string, argv: string[], o: { timeoutMs: number; signal: AbortSignal; maxOutputBytes: number }):
    Promise<{ exit: ExitInfo; stdout: string; stderr: string; truncated: boolean }>;
  wait(containerId: string, signal: AbortSignal): Promise<ExitInfo>;
  inspect(containerId: string): Promise<{ state: 'created' | 'running' | 'exited' | 'missing'; exit?: ExitInfo; restartCount: number }>;
  stop(containerId: string, graceMs: number): Promise<void>;
  remove(containerId: string): Promise<void>;
  listByLabels(labels: Partial<ContainerLabels>): Promise<{ containerId: string; labels: Record<string, string>; state: string }[]>;
}

/** One file the runner hashed out of `/out` into the object store (already under `objects/`). */
export interface StagedOutput { relPath: string; sha256: string; bytes: number; mediaType: string }

export type ParserId =
  | 'junit' | 'discovery' | 'app-manifest' | 'repo-snapshot' | 'diagnostic'
  | 'cobertura' | 'metrics-json' | 'metrics-jsonl' | 'stats-json' | 'duckdb-summary' | 'papermill';
export const PARSER_IDS: readonly ParserId[] = ['junit', 'discovery', 'app-manifest', 'repo-snapshot', 'diagnostic',
  'cobertura', 'metrics-json', 'metrics-jsonl', 'stats-json', 'duckdb-summary', 'papermill'];

/** A parser's normalized result. `normalized` is schema-checked again by main before it becomes evidence. */
export interface ParsedOutput { parser: ParserId; sourceSha256: string; normalized: unknown }

/**
 * Why the runner refused the contents of `/out` (no output from that attempt is trusted). `secret_in_report`: a parser
 * result held a secret-shaped value, so the runner withheld it (no secret leaves the runner in a message).
 */
export type OutputErrorCode =
  | 'symlink' | 'hardlink' | 'special_file' | 'bad_name' | 'file_locked' | 'too_many_files'
  | 'output_too_large' | 'workspace_too_large' | 'secret_in_report';
export const OUTPUT_ERROR_CODES: readonly OutputErrorCode[] = ['symlink', 'hardlink', 'special_file', 'bad_name', 'file_locked',
  'too_many_files', 'output_too_large', 'workspace_too_large', 'secret_in_report'];

// ----- attempt plans (main → runner); every path in a plan is main-owned, under the data home -----

interface PlanBase {
  attemptId: string;
  jobId: string;
  attemptN: number;
  recipe: { id: string; version: string };
  workDir: string;        // <dataHome>/work/<jobId>/<n>, with in/ and out/
  logPath: string;        // <dataHome>/logs/jobs/<jobId>/<n>.log
}

/** A recipe that runs to completion in one container. */
export interface ToolPlan extends PlanBase {
  kind: 'tool';
  container: ContainerSpec;
  /** What the runner stages into `in/` before create: a git archive of one commit, and blobs copied with a re-hash. */
  staging: {
    source?: { repoPath: string; commit: string };
    blobs: { sha256: string; relPath: string }[];
    depsVolume?: { name: string; readOnly: boolean };
  };
  /** The labels of every volume and network the runner creates for this attempt (with `nexus.home`). */
  resourceLabels: ResourceLabels;
  /** Files under `/out` that must exist for the attempt to count as having produced its outputs. */
  outputContract: { required: string[]; maxFiles: number };
  parse: { parser: ParserId; relPath: string }[];
  /**
   * Egress plans only: the approval main consumed for THIS attempt (its id, and the job and attempt number that consumed
   * it). The runner refuses an `egress-approved` network whose `approvalId` is absent or differs from it, or whose
   * consumer is another job or attempt (defense in depth; main's plan builder already refuses).
   */
  approval?: { id: string; jobId: string; attemptN: number };
}

/** A long-lived app container behind a loopback forwarder (dev deployment). */
export interface ServicePlan extends PlanBase {
  kind: 'service';
  deploymentId: string;
  app: ContainerSpec;
  forwarder: ContainerSpec;
  networks: { internal: string; publish: string };
  /** The labels of every volume and network the runner creates for this attempt (with `nexus.home`). */
  resourceLabels: ResourceLabels;
  health: { path: string; startTimeoutMs: number; intervalMs: number };
  idleTtlMs: number;
  staging: ToolPlan['staging'];
}

/** Work the runner does itself, without a container (async git, `docker inspect`). */
export type EngineTask =
  | { engine: 'repo.snapshot'; repoPath: string }
  | { engine: 'sde.app.assemble'; repoPath: string; commit: string }
  | { engine: 'sde.diagnose'; containerIds: string[]; logRanges: { attemptId: string; offset: number; length: number }[] };

export interface EnginePlan extends PlanBase {
  kind: 'engine';
  task: EngineTask;
  wallClockMs: number;
}

export type AttemptPlan = ToolPlan | ServicePlan | EnginePlan;
