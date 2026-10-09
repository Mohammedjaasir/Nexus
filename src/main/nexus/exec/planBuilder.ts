/**
 * The plan builder: job + recipe + inputs -> an `AttemptPlan` with a fully resolved
 * `ContainerSpec`. Pure (no I/O): the caller hands in rows main has read and paths main
 * derived; the renderer never supplies any part of a plan.
 *
 * - argv comes from the recipe's argv templates (`ARGV_TEMPLATES`, fixed arrays) and
 *   main-resolved, validated values only (discovered test files from an input version).
 *   Never a shell string. Recipes whose templates are framework alternatives
 *   (`node-test.*`, `jest.*`, `vitest.*`, `mocha.*`, `pytest.*`) run exactly one; any other
 *   recipe runs its templates in order, joined by the entry's `STEP_SEPARATOR`.
 * - env comes from the recipe's allow-list only (`ALLOWED_ENV_NAMES`); a name outside it, or a
 *   value that `looksSecret` (shared) or `containsSecret` (main's redactor) flags, refuses
 *   the plan. No host variable is ever copied.
 * - mounts: bind mounts only under the data home (`work/<jobId>/<n>/{in,out}`), plus named
 *   volumes (`nexus-ws-<attemptId>`, `nexus-deps-<profile>-<lock12>`). Nothing else.
 * - network: `none` unless the recipe is `egress-approved` AND the caller passes an approval
 *   of THIS job that is approved and was consumed by THIS attempt; otherwise the plan is
 *   refused (`network_not_approved`). Never `egress-approved` for any other recipe.
 * - labels, limits (`--pids-limit 512`, the recipe's CPUs, memory and output cap, a 512 MiB
 *   `/tmp`), read-only root, `--cap-drop ALL`, no-new-privileges: fixed.
 * - Engine recipes (`repo.snapshot`, `sde.app.assemble`) get an `EnginePlan` whose repository
 *   folder is the one main accepted from the `projects` row (`acceptFsRoot`), never a param.
 * - The service recipe (`sde.preview.start`, B2a Task 9) gets a `ServicePlan`: the app container runs the
 *   application manifest's validated `run` argv (an array, never a shell string) on the internal network
 *   `nexus-svc-<jobId>` only (no egress); the `nexus-fwd` forwarder joins it and `nexus-pub-<jobId>` and publishes
 *   exactly one port, on 127.0.0.1 (`publish.hostPort` 0: the runner picks it from its ephemeral range before
 *   create and reports it). The build's files are staged from the blob store; the lifetime is fixed (2 h).
 *
 * Errors are PlatformError 'invalid' with `detail.reason` (`network_not_approved`,
 * `env_not_allowed`, `secret_in_env`, `image_missing`, `mount_outside_data_home`,
 * `project_folder_unavailable`, `bad_input`, `not_in_this_build`).
 */
import { createHash } from 'node:crypto';
import * as path from 'node:path';
import type {
  AttemptPlan, ContainerSpec, EnginePlan, MountSpec, NetworkMode, ResourceLabels, ResourceLimits, SandboxProfile, ServicePlan, ToolPlan
} from '../../../shared/nexus/execution';
import type { RecipeDef } from '../../../shared/nexus/recipes';
import { looksSecret } from '../../../shared/nexus/secretShape';
import { containsSecret } from '../activity/redact';
import { PlatformError } from '../errors';

/** The environment names a container may receive from main (values are main's, never the host's). */
export const ALLOWED_ENV_NAMES: readonly string[] = Object.freeze([
  'HOME', 'CI', 'NODE_ENV', 'PYTHONPATH', 'JEST_JUNIT_OUTPUT_FILE', 'PIP_NO_INPUT', 'npm_config_cache', 'PYTHONDONTWRITEBYTECODE'
]);
export const PIDS_LIMIT = 512;
export const TMPFS_MB = 512;
/** The Nexus entry splits a multi-step recipe's argv on this token (the entry script is Task 12). */
export const STEP_SEPARATOR = '--nexus-then';
export const MAX_DISCOVERED_FILES = 5000;
const FRAMEWORKS = ['node-test', 'jest', 'vitest', 'mocha', 'pytest'] as const;
export type TestFramework = (typeof FRAMEWORKS)[number];

/** argv templates by id: fixed arrays, run after the Nexus entry. Values main adds are appended by `expand`. */
export const ARGV_TEMPLATES: Readonly<Record<string, readonly string[]>> = Object.freeze({
  'npm.ci-ignore-scripts': ['npm', 'ci', '--ignore-scripts', '--no-audit', '--no-fund'],
  'pip.install-binary-hashes': ['python', '-m', 'pip', 'install', '--only-binary=:all:', '--require-hashes', '--no-deps',
    '-r', '/workspace/requirements.txt', '--target', '/deps'],
  'node-test.glob': ['nexus-glob', '--out', '/out/ids.txt', '**/*.test.js', '**/*.test.mjs', '**/*.test.cjs',
    'test/**/*.js', 'test/**/*.mjs', 'test/**/*.cjs'],
  'jest.list-tests': ['nexus-capture', '--out', '/out/ids.txt', '--', './node_modules/.bin/jest', '--listTests', '--json'],
  'vitest.list': ['nexus-capture', '--out', '/out/ids.txt', '--', './node_modules/.bin/vitest', 'list', '--json'],
  'mocha.dry-run': ['nexus-capture', '--out', '/out/ids.txt', '--', './node_modules/.bin/mocha', '--dry-run', '--reporter', 'json'],
  'pytest.collect-only': ['nexus-capture', '--out', '/out/ids.txt', '--', 'python', '-m', 'pytest', '--collect-only', '-q',
    '-p', 'no:cacheprovider'],
  'node-test.junit': ['node', '--test', '--test-reporter=junit', '--test-reporter-destination=/out/junit.xml'],
  'jest.junit': ['./node_modules/.bin/jest', '--ci', '--reporters=/opt/nexus/reporters/node_modules/jest-junit'],
  'vitest.junit': ['./node_modules/.bin/vitest', 'run', '--reporter=junit', '--outputFile=/out/junit.xml'],
  'mocha.junit': ['./node_modules/.bin/mocha', '--reporter', '/opt/nexus/reporters/node_modules/mocha-junit-reporter',
    '--reporter-options', 'mochaFile=/out/junit.xml'],
  'pytest.junit': ['python', '-m', 'pytest', '-q', '--junitxml=/out/junit.xml', '-p', 'no:cacheprovider'],
  'npm.run-build': ['npm', 'run', 'build'],
  'entry.collect-output': ['nexus-collect', '--from', 'dist', '--to', '/out/dist'],
  'python.build-wheel': ['python', '-m', 'build', '--wheel', '--no-isolation', '--outdir', '/out/dist'],
  // A dev deployment: the app runs the manifest's validated argv (appended by main); the forwarder's target is appended.
  'app.manifest-run': [],
  'fwd.socat-loopback': ['socat', 'TCP-LISTEN:8080,fork,reuseaddr']
});

/** The forwarder listens on this port inside its container; the runner publishes it on 127.0.0.1 only. */
export const FORWARDER_PORT = 8080;
export const SERVICE_START_TIMEOUT_MS = 60_000;
export const SERVICE_HEALTH_INTERVAL_MS = 5_000;
/** The forwarder's own small limits (it only relays bytes). */
export const FORWARDER_LIMITS = Object.freeze({ cpus: 0.5, memoryMb: 128, tmpfsMb: 16, outputMaxBytes: 2 ** 20 });
export const MAX_RUN_ARGS = 32;
export const MAX_RUN_ARG_CHARS = 512;
const HEALTH_PATH_RE = /^\/[A-Za-z0-9/_.-]{0,200}$/;
const STAGED_PATH_RE = /^(?![./-])[A-Za-z0-9_@+=,.\- /]{1,1024}$/;

/** What a dev deployment's plan needs beyond a tool plan (main reads it from the application version and the probe). */
export interface ServiceContext {
  deploymentId: string;
  /** The application manifest (`nexus.app.json`), already validated by `app.manifest_schema`; re-checked here. */
  manifest: { profile: string; run: unknown; port: unknown; healthPath: unknown };
  forwarder: SandboxProfile | null;
  forwarderImageId: `sha256:${string}` | null;
  /** The build's files (blob sha256 and the path inside the build tree), staged into `in/dist/<path>`. */
  files: readonly { sha256: string; path: string }[];
  /** The fixed lifetime of a dev deployment (the containers' wall clock). */
  lifetimeMs: number;
}

/** A consumed approval as read from `approvals` (only the fields the builder checks). */
export interface PlanApproval {
  id: string; job_id: string | null; status: string; consumed_at: number | null;
  consumed_by_job_id: string | null; consumed_by_attempt_n: number | null;
}

export interface PlanInput {
  versionId: string; slot: string; contentHash: string;
  storage: { kind: string; commit?: string } & Record<string, unknown>;
  metadata: unknown;
}

export interface PlanContext {
  job: { id: string; projectId: string };
  attempt: { id: string; n: number };
  bootId: string;
  recipe: RecipeDef;
  /** Tool recipes: the sandbox profile main picked for this job, and the local image id of its pinned image. */
  profile?: SandboxProfile | null;
  imageId?: `sha256:${string}` | null;
  dataHomeRoot: string;
  workRel: string;
  logRel: string;
  inputs: readonly PlanInput[];
  framework?: TestFramework | null;
  /** The project folder, as main accepted it from the `projects` row (acceptFsRoot); null when refused. */
  repoPath?: string | null;
  approval?: PlanApproval | null;
  /** The service recipe only (a dev deployment). */
  service?: ServiceContext | null;
}

const refuse = (reason: string, message: string): never => { throw new PlatformError('invalid', message, { reason }); };
const COMMIT_RE = /^[0-9a-f]{40}$/;
const LOCK_RE = /^[0-9a-f]{64}$/;
const DISCOVERED_RE = /^(?![./-])[A-Za-z0-9_@+=,.\- /]{1,512}$/;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * This install's `nexus.home` label: the first 16 hex characters of the sha256 of the resolved data-home root. Every
 * container, volume and network of an attempt carries it; restart recovery removes only resources with this value.
 */
export function homeLabel(root: string): string {
  return createHash('sha256').update(path.resolve(root)).digest('hex').slice(0, 16);
}

/** The labels of an attempt's volumes and networks (and the base of its containers' labels). */
function attemptLabels(ctx: PlanContext): ResourceLabels {
  return { 'nexus.job': ctx.job.id, 'nexus.attempt': ctx.attempt.id, 'nexus.boot': ctx.bootId, 'nexus.project': ctx.job.projectId,
    'nexus.home': homeLabel(ctx.dataHomeRoot) };
}

/** A bind-mount source (and an adopted attempt's log path): `<root>/<rel>`, which must stay inside the data home. */
export function underDataHome(root: string, rel: string): string {
  const base = path.resolve(root);
  const full = path.resolve(base, rel);
  const r = path.relative(base, full);
  if (r === '' || r.startsWith('..') || path.isAbsolute(r)) refuse('mount_outside_data_home', 'a mount must stay under the data home');
  return full;
}

/** The framework of a test recipe: the caller's, else the one the input version recorded, else the profile's default. */
export function pickFramework(recipe: RecipeDef, profileId: string | null, given: string | null | undefined, inputs: readonly PlanInput[]): TestFramework | null {
  const alternatives = recipe.argvTemplates.some((t) => FRAMEWORKS.some((f) => t.startsWith(`${f}.`)));
  if (!alternatives) return null;
  const meta = inputs.map((i) => (isPlainObject(i.metadata) ? i.metadata.framework : undefined)).find((x) => typeof x === 'string');
  const want = given ?? (typeof meta === 'string' ? meta : null) ?? (profileId === 'sde-python' ? 'pytest' : 'node-test');
  if (!(FRAMEWORKS as readonly string[]).includes(want)) refuse('bad_input', 'unknown test framework');
  if (!recipe.argvTemplates.some((t) => t.startsWith(`${want}.`))) refuse('bad_input', `the recipe has no ${want} template`);
  return want as TestFramework;
}

/** The discovered test files a node-test run is limited to (from an input version), validated as plain relative paths. */
function discoveredFiles(inputs: readonly PlanInput[]): string[] {
  for (const i of inputs) {
    const files = isPlainObject(i.metadata) ? i.metadata.files : undefined;
    if (!Array.isArray(files)) continue;
    if (files.length > MAX_DISCOVERED_FILES) refuse('bad_input', 'too many discovered files');
    for (const f of files) {
      if (typeof f !== 'string' || !DISCOVERED_RE.test(f) || f.split('/').some((s) => s === '..' || s === '' || s === '.')) {
        refuse('bad_input', 'a discovered file is not a plain relative path');
      }
    }
    return [...files] as string[];
  }
  return [];
}

export function expandArgv(recipe: RecipeDef, framework: TestFramework | null, inputs: readonly PlanInput[]): string[] {
  const ids = framework === null ? recipe.argvTemplates : recipe.argvTemplates.filter((t) => t.startsWith(`${framework}.`));
  const out: string[] = [];
  for (const id of ids) {
    const base = ARGV_TEMPLATES[id];
    if (!base) refuse('not_in_this_build', `argv template ${id} is not in this build`);
    if (out.length > 0) out.push(STEP_SEPARATOR);
    out.push(...base);
    if (id === 'node-test.junit') out.push(...discoveredFiles(inputs));
  }
  return out;
}

export function envFor(recipe: RecipeDef, profileId: string, framework: TestFramework | null): Record<string, string> {
  const env: Record<string, string> = { HOME: '/home/nexus', CI: 'true' };
  if (profileId === 'sde-node') {
    env.npm_config_cache = '/home/nexus/.npm';
    if (recipe.id.startsWith('sde.build.')) env.NODE_ENV = 'production';
    else if (recipe.id.startsWith('sde.test.')) env.NODE_ENV = 'test';
  }
  if (profileId === 'sde-python') { env.PIP_NO_INPUT = '1'; env.PYTHONPATH = '/deps'; env.PYTHONDONTWRITEBYTECODE = '1'; }
  if (framework === 'jest') env.JEST_JUNIT_OUTPUT_FILE = '/out/junit.xml';
  return checkEnv(env);
}

/** Every name allow-listed, every value free of secrets by both detectors. Returns a fresh copy. */
export function checkEnv(env: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (!ALLOWED_ENV_NAMES.includes(k)) refuse('env_not_allowed', `environment name ${k.slice(0, 64)} is not allowed`);
    if (typeof v !== 'string' || v.includes('\0') || looksSecret(v) || containsSecret({ [k]: v })) {
      refuse('secret_in_env', `environment value of ${k} is refused`);
    }
    out[k] = v;
  }
  return out;
}

/** The network of a recipe's container. Egress only with this job's approval, consumed by this attempt. */
export function networkFor(recipe: RecipeDef, job: { id: string }, attempt: { n: number }, approval: PlanApproval | null | undefined): NetworkMode {
  if (recipe.network === 'none' || recipe.network === 'not-applicable') return { mode: 'none' };
  if (recipe.network === 'egress-approved') {
    const a = approval;
    if (!a || a.job_id !== job.id || a.status !== 'approved' || a.consumed_at === null
      || a.consumed_by_job_id !== job.id || a.consumed_by_attempt_n !== attempt.n) {
      return refuse('network_not_approved', 'egress needs an approval of this job, consumed by this attempt');
    }
    return { mode: 'egress-approved', approvalId: a.id, purpose: 'deps' };
  }
  return refuse('not_in_this_build', 'service networks arrive with dev deployments');
}

function sourceOf(inputs: readonly PlanInput[]): { commit: string } | null {
  for (const i of inputs) {
    const c = i.storage?.kind === 'git' ? i.storage.commit : isPlainObject(i.metadata) ? i.metadata.commit : undefined;
    if (typeof c === 'string') {
      if (!COMMIT_RE.test(c)) refuse('bad_input', 'an input commit is not a full sha');
      return { commit: c };
    }
  }
  return null;
}

/** The lockfile hash an input version recorded (`metadata.lockfile.sha256`), or null. */
export function lockfileSha256Of(inputs: readonly PlanInput[]): string | null {
  for (const i of inputs) {
    const lf = isPlainObject(i.metadata) ? i.metadata.lockfile : undefined;
    const sha = isPlainObject(lf) ? lf.sha256 : undefined;
    if (typeof sha === 'string' && LOCK_RE.test(sha)) return sha;
  }
  return null;
}

function depsVolume(profileId: string, inputs: readonly PlanInput[]): string | null {
  const lock = lockfileSha256Of(inputs);
  return lock ? `nexus-deps-${profileId}-${lock.slice(0, 12)}` : null;
}

export function limitsFor(recipe: RecipeDef): ResourceLimits {
  const l = recipe.limits;
  if (!l) return refuse('not_in_this_build', 'an engine recipe has no container limits');
  return { cpus: l.cpus, memoryMb: l.memoryMb, pids: PIDS_LIMIT, wallClockMs: recipe.wallClockMs, outputMaxBytes: l.outputMaxBytes, tmpfsMb: TMPFS_MB };
}

/** Builds the plan for one attempt (see the module header). Throws PlatformError 'invalid' with a reason. */
export function buildPlan(ctx: PlanContext): AttemptPlan {
  const { recipe, job, attempt } = ctx;
  const base = {
    attemptId: attempt.id, jobId: job.id, attemptN: attempt.n, recipe: { id: recipe.id, version: recipe.version },
    workDir: underDataHome(ctx.dataHomeRoot, ctx.workRel), logPath: underDataHome(ctx.dataHomeRoot, ctx.logRel)
  };
  if (recipe.executor === 'engine') return buildEnginePlan(ctx, base);
  if (recipe.executor === 'service') return buildServicePlan(ctx, base);
  if (recipe.executor !== 'tool') return refuse('not_in_this_build', 'this executor is not in this build');
  const profile = ctx.profile;
  if (!profile || !recipe.profiles.includes(profile.id)) return refuse('image_missing', 'no sandbox profile for this recipe');
  if (!ctx.imageId || !/^sha256:[0-9a-f]{64}$/.test(ctx.imageId)) return refuse('image_missing', 'the profile image is not present');
  const framework = pickFramework(recipe, profile.id, ctx.framework, ctx.inputs);
  const source = sourceOf(ctx.inputs);
  if (source && !ctx.repoPath) refuse('project_folder_unavailable', 'the project folder is not available');
  const deps = depsVolume(profile.id, ctx.inputs);
  const egress = recipe.network === 'egress-approved';
  const mounts: MountSpec[] = [
    { kind: 'input', hostPath: underDataHome(ctx.dataHomeRoot, `${ctx.workRel}/in`), containerPath: '/in', readOnly: true },
    { kind: 'out', hostPath: underDataHome(ctx.dataHomeRoot, `${ctx.workRel}/out`), containerPath: '/out', readOnly: false },
    { kind: 'workspace', hostPath: `nexus-ws-${attempt.id}`, containerPath: '/workspace', readOnly: false }
  ];
  if (deps) mounts.push({ kind: 'deps', hostPath: deps, containerPath: profile.id === 'sde-python' ? '/deps' : '/workspace/node_modules', readOnly: !egress });
  const container: ContainerSpec = {
    name: `nexus-${attempt.id.toLowerCase()}`,
    labels: { ...attemptLabels(ctx), 'nexus.kind': 'tool' },
    profile: profile.id,
    image: { ref: `${profile.image.repository}@${profile.image.digest}`, id: ctx.imageId },
    entrypoint: [...profile.entrypoint],
    argv: expandArgv(recipe, framework, ctx.inputs),
    imageEnv: [...profile.imageEnv],
    env: envFor(recipe, profile.id, framework),
    mounts,
    network: networkFor(recipe, job, attempt, ctx.approval),
    limits: limitsFor(recipe),
    readOnlyRootfs: true,
    capDrop: ['ALL'],
    noNewPrivileges: true
  };
  const plan: ToolPlan = {
    ...base, kind: 'tool', container, resourceLabels: attemptLabels(ctx),
    staging: {
      ...(source && ctx.repoPath ? { source: { repoPath: ctx.repoPath, commit: source.commit } } : {}),
      blobs: [],
      ...(deps ? { depsVolume: { name: deps, readOnly: !egress } } : {})
    },
    outputContract: { required: [...recipe.outputContract.required], maxFiles: 10_000 },
    parse: recipe.parsers.map((p) => ({ parser: p, relPath: p === 'junit' ? 'junit.xml' : p === 'discovery' ? 'ids.txt' : '' }))
      .filter((x) => x.relPath !== '')
  };
  return plan;
}

/** The manifest's run argv as a container argv: 1-32 plain strings, none secret-shaped. Never a shell string. */
export function checkRunArgv(run: unknown): string[] {
  if (!Array.isArray(run) || run.length < 1 || run.length > MAX_RUN_ARGS) return refuse('bad_input', 'the app manifest run list is not 1 to 32 arguments');
  const out: string[] = [];
  for (const a of run as unknown[]) {
    if (typeof a !== 'string' || a.length === 0 || a.length > MAX_RUN_ARG_CHARS || a.includes('\0')) refuse('bad_input', 'an app manifest argument is not plain text');
    if (looksSecret(a as string) || containsSecret([a])) refuse('secret_in_argv', 'an app manifest argument is secret-shaped');
    out.push(a as string);
  }
  return out;
}

type ServiceBase = Omit<ServicePlan, 'kind' | 'deploymentId' | 'app' | 'forwarder' | 'networks' | 'resourceLabels' | 'health' | 'idleTtlMs' | 'staging'>;

function buildServicePlan(ctx: PlanContext, base: ServiceBase): ServicePlan {
  const { recipe, job, attempt } = ctx;
  const s = ctx.service;
  if (!s || typeof s.deploymentId !== 'string' || s.deploymentId.length === 0) return refuse('bad_input', 'a dev deployment needs its deployment and manifest');
  const profile = ctx.profile;
  if (!profile || profile.id !== s.manifest.profile || !recipe.profiles.includes(profile.id) || profile.id === 'nexus-fwd') {
    return refuse('image_missing', 'no sandbox profile for this app');
  }
  if (!ctx.imageId || !/^sha256:[0-9a-f]{64}$/.test(ctx.imageId)) return refuse('image_missing', 'the app profile image is not present');
  const fwd = s.forwarder;
  if (!fwd || fwd.id !== 'nexus-fwd' || !s.forwarderImageId || !/^sha256:[0-9a-f]{64}$/.test(s.forwarderImageId)) {
    return refuse('image_missing', 'the forwarder image is not present');
  }
  const port = s.manifest.port;
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 1024 || port > 65535) return refuse('bad_input', 'the app port is out of range');
  const healthPath = s.manifest.healthPath;
  if (typeof healthPath !== 'string' || !HEALTH_PATH_RE.test(healthPath)) return refuse('bad_input', 'the health path is not a plain path');
  const argv = checkRunArgv(s.manifest.run);
  const lifetime = s.lifetimeMs;
  if (!Number.isSafeInteger(lifetime) || lifetime <= 0) return refuse('bad_input', 'a dev deployment needs a lifetime');
  for (const f of s.files) {
    if (typeof f?.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(f.sha256) || typeof f.path !== 'string' || !STAGED_PATH_RE.test(f.path)
      || f.path.split('/').some((x) => x === '' || x === '.' || x === '..')) {
      refuse('bad_input', 'a build file is not a plain relative path');
    }
  }
  const source = sourceOf(ctx.inputs);
  if (source && !ctx.repoPath) refuse('project_folder_unavailable', 'the project folder is not available');
  const deps = depsVolume(profile.id, ctx.inputs);
  const internal = `nexus-svc-${job.id.toLowerCase()}`;
  const publish = `nexus-pub-${job.id.toLowerCase()}`;
  const labels = (kind: string): ContainerSpec['labels'] => ({ ...attemptLabels(ctx), 'nexus.kind': kind });
  const mounts: MountSpec[] = [
    { kind: 'input', hostPath: underDataHome(ctx.dataHomeRoot, `${ctx.workRel}/in`), containerPath: '/in', readOnly: true },
    { kind: 'out', hostPath: underDataHome(ctx.dataHomeRoot, `${ctx.workRel}/out`), containerPath: '/out', readOnly: false },
    { kind: 'workspace', hostPath: `nexus-ws-${attempt.id}`, containerPath: '/workspace', readOnly: false }
  ];
  if (deps) mounts.push({ kind: 'deps', hostPath: deps, containerPath: profile.id === 'sde-python' ? '/deps' : '/workspace/node_modules', readOnly: true });
  const network: NetworkMode = { mode: 'service-internal', network: internal };
  const app: ContainerSpec = {
    name: `nexus-${attempt.id.toLowerCase()}-app`, labels: labels('service'), profile: profile.id,
    image: { ref: `${profile.image.repository}@${profile.image.digest}`, id: ctx.imageId },
    entrypoint: [...profile.entrypoint], argv, imageEnv: [...profile.imageEnv], env: envFor(recipe, profile.id, null), mounts, network,
    limits: { ...limitsFor(recipe), wallClockMs: lifetime }, readOnlyRootfs: true, capDrop: ['ALL'], noNewPrivileges: true,
    service: { containerPort: port, healthPath }
  };
  const forwarder: ContainerSpec = {
    name: `nexus-${attempt.id.toLowerCase()}-fwd`, labels: labels('forwarder'), profile: 'nexus-fwd',
    image: { ref: `${fwd.image.repository}@${fwd.image.digest}`, id: s.forwarderImageId },
    entrypoint: [...fwd.entrypoint], argv: [...ARGV_TEMPLATES['fwd.socat-loopback'], `TCP:app:${port}`], imageEnv: [...fwd.imageEnv],
    env: checkEnv({ HOME: '/home/nexus' }), mounts: [], network,
    limits: { cpus: FORWARDER_LIMITS.cpus, memoryMb: FORWARDER_LIMITS.memoryMb, pids: PIDS_LIMIT, wallClockMs: lifetime,
      outputMaxBytes: FORWARDER_LIMITS.outputMaxBytes, tmpfsMb: FORWARDER_LIMITS.tmpfsMb },
    readOnlyRootfs: true, capDrop: ['ALL'], noNewPrivileges: true,
    publish: { hostIp: '127.0.0.1', hostPort: 0, containerPort: FORWARDER_PORT }
  };
  return {
    ...base, kind: 'service', deploymentId: s.deploymentId, app, forwarder, networks: { internal, publish }, resourceLabels: attemptLabels(ctx),
    health: { path: healthPath, startTimeoutMs: SERVICE_START_TIMEOUT_MS, intervalMs: SERVICE_HEALTH_INTERVAL_MS },
    idleTtlMs: lifetime,
    staging: {
      ...(source && ctx.repoPath ? { source: { repoPath: ctx.repoPath, commit: source.commit } } : {}),
      blobs: s.files.map((f) => ({ sha256: f.sha256, relPath: `dist/${f.path}` })),
      ...(deps ? { depsVolume: { name: deps, readOnly: true } } : {})
    }
  };
}

function buildEnginePlan(ctx: PlanContext, base: Omit<EnginePlan, 'kind' | 'task' | 'wallClockMs'>): EnginePlan {
  const repoPath = ctx.repoPath;
  if (!repoPath) return refuse('project_folder_unavailable', 'the project folder is not available');
  if (ctx.recipe.id === 'repo.snapshot') return { ...base, kind: 'engine', task: { engine: 'repo.snapshot', repoPath }, wallClockMs: ctx.recipe.wallClockMs };
  if (ctx.recipe.id === 'sde.app.assemble') {
    const src = sourceOf(ctx.inputs);
    if (!src) return refuse('bad_input', 'assembly needs the commit of its build');
    return { ...base, kind: 'engine', task: { engine: 'sde.app.assemble', repoPath, commit: src.commit }, wallClockMs: ctx.recipe.wallClockMs };
  }
  return refuse('not_in_this_build', `${ctx.recipe.id} arrives with dev deployments`);
}

/** What `job_attempts.sandbox_json` records of a plan: argv, env NAMES, mounts without host paths, network, limits. */
export function sandboxRecord(plan: AttemptPlan): Record<string, unknown> {
  if (plan.kind === 'engine') return { executor: 'engine', engine: plan.task.engine, network: 'not-applicable', wallClockMs: plan.wallClockMs };
  if (plan.kind === 'service') {
    const rec = (c: ContainerSpec): Record<string, unknown> => ({
      name: c.name, profile: c.profile, image: c.image, entrypoint: c.entrypoint, argv: c.argv.slice(0, MAX_RUN_ARGS).map((x) => x.slice(0, 200)),
      argvCount: c.argv.length, argvSha256: createHash('sha256').update(JSON.stringify(c.argv)).digest('hex'), envNames: Object.keys(c.env).sort(),
      mounts: c.mounts.map((m) => ({ kind: m.kind, containerPath: m.containerPath, readOnly: m.readOnly })), network: c.network, limits: c.limits,
      ...(c.service ? { service: c.service } : {}), ...(c.publish ? { publish: { hostIp: c.publish.hostIp, containerPort: c.publish.containerPort } } : {})
    });
    return {
      executor: 'service', deploymentId: plan.deploymentId, image: plan.app.image, network: plan.app.network, app: rec(plan.app),
      forwarder: rec(plan.forwarder), networks: plan.networks, health: plan.health, idleTtlMs: plan.idleTtlMs, user: '10001:10001',
      readOnlyRootfs: true, capDrop: ['ALL'], noNewPrivileges: true, stagedFiles: plan.staging.blobs.length
    };
  }
  if (plan.kind !== 'tool') return { executor: 'unknown' };
  const c = plan.container;
  const argv = c.argv.slice(0, 200);
  const argvSha256 = createHash('sha256').update(JSON.stringify(c.argv)).digest('hex');
  return {
    executor: 'tool', name: c.name, profile: c.profile, image: c.image, entrypoint: c.entrypoint, argv, argvCount: c.argv.length, argvSha256,
    envNames: Object.keys(c.env).sort(), mounts: c.mounts.map((m) => ({ kind: m.kind, containerPath: m.containerPath, readOnly: m.readOnly })),
    network: c.network, limits: c.limits, user: '10001:10001', readOnlyRootfs: c.readOnlyRootfs, capDrop: c.capDrop,
    noNewPrivileges: c.noNewPrivileges, tmpfs: { '/tmp': `${c.limits.tmpfsMb}m`, '/home/nexus': '256m' },
    sizeGuard: { outputMaxBytes: c.limits.outputMaxBytes, pollMs: 5000 }
  };
}
