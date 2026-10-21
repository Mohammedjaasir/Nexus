// The B2a and B2b validators as data. Implementations live in main
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
/** A B2b validator: every one judges a change set; `blocking: false` is advisory (it never gates anything). */
const vB2b = (id: ValidatorId, stage: ValidatorStage, executes: ValidatorExecutor, blocking: boolean, evidence: EvidenceType[],
  failsWhen: string, recipes?: RecipeId[]): ValidatorDef =>
  ({ id, version: 1, kinds: ['change_set'], stage, executes, ...(recipes ? { recipes } : {}), blocking, evidence, failsWhen, subPhase: 'B2b' });

export const VALIDATORS: readonly ValidatorDef[] = deepFreeze([
  v('git.head_resolves', ['repository'], 'register', 'main', ['git'],
    'The commit does not resolve in the project folder, or its full hash differs.'),
  v('req.schema', ['requirement'], 'register', 'main', ['schema'],
    'The title is missing, there is no acceptance criterion, a criterion id repeats, the body is over 32 KiB, or it holds a secret.'),
  v('problem.schema', ['problem_statement'], 'register', 'main', ['schema'],
    'The question is missing or a field breaks the problem statement schema.'),
  v('suite.discovered', ['test_suite'], 'register', 'main', ['hash', 'number'],
    'No test was discovered, or the hash of the discovered list does not match.'),
  v('sde.tests_pass', ['test_suite'], 'candidate', 'child-job', ['junit', 'exit', 'hash', 'number', 'case'],
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
    'A field of the report has no inspect, probe or log source.'),
  // B2a Task 13 fix round 1: the evidence of a dependency install (sde.deps.node / sde.deps.python). ADVISORY: it never
  // gates the repository version it is recorded on; it is the install job's own result, bound to (job, attempt n).
  { id: 'sde.deps.lock_matches', version: 1, kinds: ['repository'], stage: 'candidate', executes: 'main', blocking: false,
    evidence: ['hash', 'exit'], subPhase: 'B2a',
    failsWhen: 'The exit is not 0, lock.sha256 is missing or is not the only output, it does not hold 64 lowercase hex characters, '
      + 'or it differs from the repository version\'s lockfile hash or from the lockfile hash of the approval this attempt consumed.' },
  // ----- B2b: change sets -----
  vB2b('git.diff_nonempty', 'register', 'main', true, ['git', 'number'],
    'The change has no file change between its base and its head.'),
  vB2b('git.paths_in_scope', 'register', 'main', true, ['git'],
    'A changed path is outside the path scope, is not a plain relative path, or has a sensitive name (.git, .env, a key or a credentials file).'),
  vB2b('sec.secret_scan', 'register', 'main', true, ['location', 'number'],
    'An added line holds a provider key or a private-key header. The evidence names the path and line only.'),
  vB2b('sec.entropy_notes', 'register', 'main', false, ['location', 'number'],
    'Advisory: an added line outside a lockfile holds a long high-entropy string. It never gates the change.'),
  vB2b('cs.tests_pass', 'candidate', 'child-job', true, ['junit', 'hash', 'number'],
    'The test suite discovered at the head of the change did not pass: no test ran, a test failed or errored, or the run could not be judged.',
    ['sde.test.discover', 'sde.test.node', 'sde.test.pytest']),
  vB2b('git.applies_cleanly', 'candidate', 'child-job', true, ['git'],
    'The change does not merge onto the current integration head without a conflict.', ['changeset.merge_check'])
]);

export const VALIDATOR_IDS: readonly ValidatorId[] = deepFreeze(VALIDATORS.map((x) => x.id));

export function getValidator(id: string): ValidatorDef | null {
  return VALIDATORS.find((x) => x.id === id) ?? null;
}

/** The blocking validators that gate a version of this kind leaving draft (register and candidate stages). */
export function blockingValidatorsFor(kind: KindId): ValidatorDef[] {
  return VALIDATORS.filter((x) => x.blocking && x.kinds.includes(kind) && (x.stage === 'register' || x.stage === 'candidate'));
}
