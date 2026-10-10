/**
 * The runner's own interfaces (B2a Task 11): the sandbox driver it drives (the shared `SandboxDriver` plus the few
 * operations the runner needs beyond it), its transport, its clock and its file system. Tests inject a fake driver
 * (test/helpers/fakeSandboxDriver.cjs), a fake clock and an in-process MessageChannel.
 */
import type { ContainerSpec, DiagnoseContainerFacts, ExitInfo, SandboxDriver, SandboxProfileId } from '../shared/nexus/execution';

export type ResourceKind = 'container' | 'volume' | 'network';

/** A labelled Docker resource as the runner lists it (containers also carry their state and exit). */
export interface ResourceFacts {
  kind: ResourceKind;
  id: string;
  name: string;
  labels: Record<string, string>;
  /** Containers only. */
  state?: 'created' | 'running' | 'exited' | 'missing';
  exit?: ExitInfo;
}

export interface CreateOptions {
  /** A replacement container name (the one retry after a name conflict). */
  name?: string;
  /** The app container of a dev deployment answers as `app` on its internal network (the forwarder's target). */
  alias?: string;
}

export interface ImageInfo {
  present: boolean;
  digestMatches: boolean;
  sizeBytes?: number;
  imageId?: string;
  contextSha256?: string;
  /** The `nexus.versions` label (the tool versions the image's build self-test checked). */
  versions?: string;
}

/** What `docker build` reports while it runs. */
export interface BuildProgress { phase: string; bytes?: number }

/** The runner's sandbox driver: the shared contract plus the runner's own operations. */
export interface RunnerDriver extends SandboxDriver {
  create(spec: ContainerSpec, o?: CreateOptions): Promise<{ containerId: string }>;
  /** `docker kill` (a container that already stopped is not an error). */
  kill(containerId: string): Promise<void>;
  /** Creates a named volume with exactly these labels (idempotent: an existing volume is kept as it is). */
  createVolume(name: string, labels: Record<string, string>): Promise<void>;
  removeVolume(name: string): Promise<void>;
  /** Creates a network with exactly these labels (idempotent); `internal` has no route out. */
  createNetwork(name: string, labels: Record<string, string>, o: { internal: boolean }): Promise<void>;
  removeNetwork(name: string): Promise<void>;
  /**
   * Every container, volume and network carrying ALL these labels and a `nexus.attempt` label (the driver always
   * filters by label; an unlabelled resource is never listed).
   */
  listResources(labels: Record<string, string>): Promise<ResourceFacts[]>;
  /** One resource's labels (null when it does not exist). */
  inspectResource(kind: ResourceKind, id: string): Promise<ResourceFacts | null>;
  /** Follows a container's output until it ends or `signal` aborts; `sinceMs` resumes after a restart. */
  streamLogs(containerId: string, onChunk: (stream: 'stdout' | 'stderr', chunk: string) => void, signal: AbortSignal, sinceMs?: number): Promise<void>;
  /** The local image Nexus built for a profile (labelled `nexus.profile`), with its context label. */
  imageInfo(profile: SandboxProfileId): Promise<ImageInfo>;
  /**
   * A diagnosis's view of one container (B2a Task 12): its labels (ownership is checked by the caller first) and the
   * fixed fact set of `docker inspect`; null when it does not exist. Throws when Docker cannot answer.
   */
  inspectFacts(containerId: string): Promise<{ labels: Record<string, string>; facts: DiagnoseContainerFacts } | null>;
}

/** The transport: a MessagePort-like object (node:worker_threads MessagePort in tests, Electron's in the app). */
export interface RunnerTransport {
  postMessage(msg: unknown): void;
  on(event: 'message', fn: (data: unknown) => void): unknown;
}

/** The timers the runner uses (a fake clock in tests). */
export interface RunnerTimers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(h: unknown): void;
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(h: unknown): void;
}

export const REAL_TIMERS: RunnerTimers = {
  setTimeout: (fn, ms) => { const t = setTimeout(fn, ms); (t as { unref?: () => void }).unref?.(); return t; },
  clearTimeout: (h) => clearTimeout(h as NodeJS.Timeout),
  setInterval: (fn, ms) => { const t = setInterval(fn, ms); (t as { unref?: () => void }).unref?.(); return t; },
  clearInterval: (h) => clearInterval(h as NodeJS.Timeout)
};

/** The slice of `node:fs/promises` the runner uses (tests wrap it to inject EPERM, slow reads, ...). */
export type RunnerFs = typeof import('node:fs/promises');
