// The B2a recipes as data. A recipe names argv *templates* by id; main builds the
// actual argv array (never a string) from the template, the pinned profile and
// main-resolved inputs. The renderer never supplies any part of it. Engine-side
// recipes run in the runner process itself (async git, `docker inspect`) and
// start no container.

import type { ParserId, SandboxProfileId } from './execution';
import type { KindId, ParamsSchema, RecipeId, SubPhase } from './domainSpec';

export type RecipeExecutor = 'engine' | 'tool' | 'service';
/** `not-applicable`: an engine-side recipe runs no container. Egress happens only behind approval A1. */
export type RecipeNetwork = 'none' | 'egress-approved' | 'service-internal' | 'not-applicable';

export interface RecipeDef {
  id: RecipeId;
  version: string;
  executor: RecipeExecutor;
  /** Candidate profiles; main picks one from the repository (package.json or a Python project). Empty for engine recipes. */
  profiles: SandboxProfileId[];
  /** Ids of the argv templates main expands, in the order they run (after the Nexus entry). */
  argvTemplates: string[];
  /** Parameters main passes to the recipe; derived from the job's inputs, never from renderer text. */
  params: ParamsSchema;
  network: RecipeNetwork;
  retry: { idempotent: boolean; maxAttempts: number };
  wallClockMs: number;
  /** Container limits; null for engine recipes. */
  limits: { cpus: number; memoryMb: number; outputMaxBytes: number } | null;
  /** What must exist for the attempt to count as having produced its outputs (paths under `/out`, or engine facts). */
  outputContract: { required: string[]; description: string };
  parsers: ParserId[];
  produces: KindId[];
  subPhase: SubPhase;
}

export const NO_PARAMS: ParamsSchema = { type: 'object', properties: {}, required: [], additionalProperties: false };
const MIN = 60_000;
const MIB = 2 ** 20;
const engine = { executor: 'engine' as const, profiles: [] as SandboxProfileId[], network: 'not-applicable' as const, limits: null };
const NODE_OR_PY: SandboxProfileId[] = ['sde-node', 'sde-python'];

export const RECIPES: readonly RecipeDef[] = [
  { id: 'repo.snapshot', version: '1', ...engine,
    argvTemplates: ['git.rev-parse-head-commit', 'git.symbolic-ref-short', 'git.status-porcelain-z', 'git.rev-parse-head-tree'],
    params: NO_PARAMS, retry: { idempotent: true, maxAttempts: 3 }, wallClockMs: 60_000,
    outputContract: { required: ['commit', 'branch', 'dirty', 'tree'], description: 'Facts: commit, branch, dirty flag and tree.' },
    parsers: ['repo-snapshot'], produces: ['repository'], subPhase: 'B2a' },
  { id: 'sde.deps.node', version: '1', executor: 'tool', profiles: ['sde-node'],
    argvTemplates: ['npm.ci-ignore-scripts'], params: NO_PARAMS, network: 'egress-approved',
    retry: { idempotent: true, maxAttempts: 2 }, wallClockMs: 15 * MIN, limits: { cpus: 2, memoryMb: 2048, outputMaxBytes: 1 * MIB },
    outputContract: { required: ['lock.sha256'], description: 'The lockfile hash, equal to the lockfile in the checkout.' },
    parsers: [], produces: [], subPhase: 'B2a' },
  { id: 'sde.deps.python', version: '1', executor: 'tool', profiles: ['sde-python'],
    argvTemplates: ['pip.install-binary-hashes'], params: NO_PARAMS, network: 'egress-approved',
    retry: { idempotent: true, maxAttempts: 2 }, wallClockMs: 15 * MIN, limits: { cpus: 2, memoryMb: 2048, outputMaxBytes: 1 * MIB },
    outputContract: { required: ['lock.sha256'], description: 'The lockfile hash, equal to the lockfile in the checkout.' },
    parsers: [], produces: [], subPhase: 'B2a' },
  { id: 'sde.test.discover', version: '1', executor: 'tool', profiles: NODE_OR_PY,
    argvTemplates: ['node-test.glob', 'jest.list-tests', 'vitest.list', 'mocha.dry-run', 'pytest.collect-only'],
    params: NO_PARAMS, network: 'none',
    retry: { idempotent: true, maxAttempts: 2 }, wallClockMs: 5 * MIN, limits: { cpus: 1, memoryMb: 1024, outputMaxBytes: 8 * MIB },
    outputContract: { required: ['ids.txt'], description: 'The discovered test ids or files.' },
    parsers: ['discovery'], produces: ['test_suite'], subPhase: 'B2a' },
  { id: 'sde.test.node', version: '1', executor: 'tool', profiles: ['sde-node'],
    argvTemplates: ['node-test.junit', 'jest.junit', 'vitest.junit', 'mocha.junit'], params: NO_PARAMS, network: 'none',
    retry: { idempotent: false, maxAttempts: 1 }, wallClockMs: 15 * MIN, limits: { cpus: 2, memoryMb: 2048, outputMaxBytes: 64 * MIB },
    outputContract: { required: ['junit.xml'], description: 'A JUnit report written by a forced reporter.' },
    parsers: ['junit'], produces: [], subPhase: 'B2a' },
  { id: 'sde.test.pytest', version: '1', executor: 'tool', profiles: ['sde-python'],
    argvTemplates: ['pytest.junit'], params: NO_PARAMS, network: 'none',
    retry: { idempotent: false, maxAttempts: 1 }, wallClockMs: 15 * MIN, limits: { cpus: 2, memoryMb: 2048, outputMaxBytes: 64 * MIB },
    outputContract: { required: ['junit.xml'], description: 'A JUnit report.' },
    parsers: ['junit'], produces: [], subPhase: 'B2a' },
  { id: 'sde.build.node', version: '1', executor: 'tool', profiles: ['sde-node'],
    argvTemplates: ['npm.run-build', 'entry.collect-output'], params: NO_PARAMS, network: 'none',
    retry: { idempotent: false, maxAttempts: 1 }, wallClockMs: 15 * MIN, limits: { cpus: 2, memoryMb: 2048, outputMaxBytes: 256 * MIB },
    outputContract: { required: ['dist/**'], description: 'The build output tree.' },
    parsers: [], produces: ['build'], subPhase: 'B2a' },
  { id: 'sde.build.python', version: '1', executor: 'tool', profiles: ['sde-python'],
    argvTemplates: ['python.build-wheel'], params: NO_PARAMS, network: 'none',
    retry: { idempotent: false, maxAttempts: 1 }, wallClockMs: 15 * MIN, limits: { cpus: 2, memoryMb: 2048, outputMaxBytes: 256 * MIB },
    outputContract: { required: ['dist/*.whl'], description: 'One or more wheels.' },
    parsers: [], produces: ['build'], subPhase: 'B2a' },
  { id: 'sde.app.assemble', version: '1', ...engine,
    argvTemplates: ['git.show-app-manifest'], params: NO_PARAMS, retry: { idempotent: true, maxAttempts: 3 }, wallClockMs: 60_000,
    outputContract: { required: ['manifest'], description: 'The nexus.app.json manifest of the built commit (at most 16 KiB).' },
    parsers: ['app-manifest'], produces: ['application'], subPhase: 'B2a' },
  { id: 'sde.preview.start', version: '1', executor: 'service', profiles: [...NODE_OR_PY, 'nexus-fwd'],
    argvTemplates: ['app.manifest-run', 'fwd.socat-loopback'], params: NO_PARAMS, network: 'service-internal',
    retry: { idempotent: false, maxAttempts: 1 }, wallClockMs: 60_000, limits: { cpus: 1, memoryMb: 1024, outputMaxBytes: 1 * MIB },
    outputContract: { required: ['health'], description: 'A health probe answered on 127.0.0.1 within 60 s; idle for 2 h, it stops.' },
    parsers: [], produces: [], subPhase: 'B2a' },
  { id: 'sde.diagnose', version: '1', ...engine,
    argvTemplates: ['docker.inspect', 'probe.table', 'log.ranges'], params: NO_PARAMS, retry: { idempotent: true, maxAttempts: 3 },
    wallClockMs: 60_000,
    outputContract: { required: ['report'], description: 'A report whose every field comes from inspect, a probe or a log range.' },
    parsers: ['diagnostic'], produces: ['diagnostic_report'], subPhase: 'B2a' }
];

/** How long an idle dev deployment lives before it is stopped. */
export const PREVIEW_IDLE_TTL_MS = 2 * 60 * MIN;
export const RETRY_BACKOFF_MS: readonly number[] = [10_000, 60_000, 300_000];

export const RECIPE_IDS: readonly RecipeId[] = RECIPES.map((r) => r.id);

export function getRecipe(id: string): RecipeDef | null {
  return RECIPES.find((r) => r.id === id) ?? null;
}
