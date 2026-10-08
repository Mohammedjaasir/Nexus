// The B2a validators as data. Implementations live in main
// (src/main/nexus/validation/validators/*). A version reaches candidate only when
// every blocking register and candidate validator of its kind has a latest
// `passed` row; a step is done only on that validated evidence.

import type { EvidenceType, ValidatorId, ValidatorStage } from './evidence';
import type { KindId, RecipeId, SubPhase } from './domainSpec';
import { deepFreeze } from './freeze';

/** Where the check runs: main itself, the runner (re-hash), a child job of a recipe, or the version's dev deployment. */
export type ValidatorExecutor = 'main' | 'runner' | 'child-job' | 'deployment';

export interface ValidatorDef {
  id: ValidatorId;
  version: 1;
  kinds: KindId[];
  stage: ValidatorStage;
  executes: ValidatorExecutor;
  /** For a child-job validator: the recipes it may run. */
  recipes?: RecipeId[];
  blocking: boolean;
  evidence: EvidenceType[];
  failsWhen: string;
  subPhase: SubPhase;
}

const v = (id: ValidatorId, kinds: KindId[], stage: ValidatorStage, executes: ValidatorExecutor, evidence: EvidenceType[],
  failsWhen: string, recipes?: RecipeId[]): ValidatorDef =>
  ({ id, version: 1, kinds, stage, executes, ...(recipes ? { recipes } : {}), blocking: true, evidence, failsWhen, subPhase: 'B2a' });

export const VALIDATORS: readonly ValidatorDef[] = deepFreeze([
  v('git.head_resolves', ['repository'], 'register', 'main', ['git'],
    'The commit does not resolve in the project folder, or its full hash differs.'),
  v('req.schema', ['requirement'], 'register', 'main', ['schema'],
    'The title is missing, there is no acceptance criterion, a criterion id repeats, the body is over 32 KiB, or it holds a secret.'),
  v('problem.schema', ['problem_statement'], 'register', 'main', ['schema'],
    'The question is missing or a field breaks the problem statement schema.'),
  v('suite.discovered', ['test_suite'], 'register', 'main', ['hash', 'number'],
    'No test was discovered, or the hash of the discovered list does not match.'),
  v('sde.tests_pass', ['test_suite'], 'candidate', 'child-job', ['junit', 'exit', 'hash', 'number'],
    'No test ran, a test failed or errored, the counts disagree, a test ran that discovery did not list, '
    + 'the exit code disagrees with the results, or the JUnit report is missing or unreadable.',
    ['sde.test.node', 'sde.test.pytest']),
  v('build.exit_zero', ['build'], 'candidate', 'main', ['exit'], 'The build exited with a non-zero code.'),
  v('build.manifest_present', ['build'], 'candidate', 'main', ['file', 'number'],
    'The output tree is missing or empty (an empty dist folder fails).'),
  v('build.output_hashed', ['build'], 'candidate', 'main', ['hash'], 'A file of the output tree has no stored blob.'),
  v('blob.integrity', ['build'], 'candidate', 'runner', ['hash'], 'A re-hash differs, or a stored object is missing.'),
  v('app.manifest_schema', ['application'], 'register', 'main', ['schema'], 'The nexus.app.json manifest breaks its schema.'),
  v('app.preview_health', ['application'], 'candidate', 'deployment', ['http', 'inspect'],
    'No 200 answer on the health path within 60 s, the container exited, or the port is bound anywhere but 127.0.0.1.'),
  v('diag.schema', ['diagnostic_report'], 'register', 'main', ['schema'],
    'A field of the report has no inspect, probe or log source.')
]);

export const VALIDATOR_IDS: readonly ValidatorId[] = deepFreeze(VALIDATORS.map((x) => x.id));

export function getValidator(id: string): ValidatorDef | null {
  return VALIDATORS.find((x) => x.id === id) ?? null;
}

/** The blocking validators that gate a version of this kind leaving draft (register and candidate stages). */
export function blockingValidatorsFor(kind: KindId): ValidatorDef[] {
  return VALIDATORS.filter((x) => x.blocking && x.kinds.includes(kind) && (x.stage === 'register' || x.stage === 'candidate'));
}
