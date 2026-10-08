// User actions (renderer → main through `nexus:job:start` and the inline save).
// An action is an id with input slots and a parameter schema: never a command,
// a path, a network, an image or an identity. Main picks the recipe from the
// action's list (by the repository's profile), resolves every path and builds
// the container spec. Only steps that are REAL in this build have actions.

import type { KindId, ParamsSchema, PlatformFlowId, PrerequisiteId, RecipeId, SubPhase, UserActionId } from './domainSpec';
import { NO_PARAMS } from './recipes';

/** One recipe job (main picks among `recipes`), an inline save of a user-authored kind, or a control on a live record. */
export type ActionRun =
  | { recipes: RecipeId[] }
  | { inlineKind: KindId }
  | { control: 'deployment.stop' };

export interface InputSlot { slot: string; kinds: KindId[]; min: number; max: number }

export interface UserActionDef {
  id: UserActionId;
  domain: string;
  labelKey: string;
  /** Plain words in the domain's language. */
  label: string;
  run: ActionRun;
  inputs: InputSlot[];
  params: ParamsSchema;
  /** Platform prerequisites. A profile-dependent image (sde-node or sde-python) is resolved per repository by main. */
  prerequisites: PrerequisiteId[];
  subPhase: SubPhase;
}

/** Existing platform flows (B0b/B1) a step can name; they are not jobs. */
export const PLATFORM_FLOWS: readonly PlatformFlowId[] = ['project.import', 'project.attach', 'user.save_commit', 'user.save_file'];

const ID = '^[A-Za-z0-9_-]{1,64}$';
const one = (slot: string, kind: KindId): InputSlot => ({ slot, kinds: [kind], min: 1, max: 1 });
const a = (id: UserActionId, domain: string, label: string, run: ActionRun, inputs: InputSlot[],
  prerequisites: PrerequisiteId[], params: ParamsSchema = NO_PARAMS): UserActionDef =>
  ({ id, domain, labelKey: `action.${id}`, label, run, inputs, params, prerequisites, subPhase: 'B2a' });

export const USER_ACTIONS: readonly UserActionDef[] = [
  a('sde.requirement.write', 'sde', 'Write a requirement', { inlineKind: 'requirement' }, [], []),
  a('sde.repository.snapshot', 'sde', 'Take a repository snapshot', { recipes: ['repo.snapshot'] }, [], ['git']),
  a('sde.deps.install', 'sde', 'Install dependencies', { recipes: ['sde.deps.node', 'sde.deps.python'] },
    [one('repository', 'repository')], ['git', 'docker', 'disk:5GiB']),
  a('sde.tests.discover', 'sde', 'Find tests on a commit', { recipes: ['sde.test.discover'] },
    [one('repository', 'repository')], ['git', 'docker', 'disk:5GiB']),
  a('sde.tests.run', 'sde', 'Run tests on a commit', { recipes: ['sde.test.node', 'sde.test.pytest'] },
    [one('suite', 'test_suite')], ['git', 'docker', 'disk:5GiB']),
  a('sde.build.run', 'sde', 'Build', { recipes: ['sde.build.node', 'sde.build.python'] },
    [one('repository', 'repository')], ['git', 'docker', 'disk:5GiB']),
  a('sde.app.assemble', 'sde', 'Assemble the application', { recipes: ['sde.app.assemble'] },
    [one('build', 'build')], ['git']),
  a('sde.preview.start', 'sde', 'Start a dev deployment', { recipes: ['sde.preview.start'] },
    [one('application', 'application')], ['docker', 'image:nexus-fwd', 'disk:5GiB']),
  a('sde.preview.stop', 'sde', 'Stop the dev deployment', { control: 'deployment.stop' }, [], ['docker'],
    { type: 'object', properties: { deploymentId: { type: 'string', maxLength: 64, pattern: ID } }, required: ['deploymentId'],
      additionalProperties: false }),
  a('sde.diagnose', 'sde', 'Diagnose', { recipes: ['sde.diagnose'] }, [], ['docker'],
    { type: 'object', properties: { target: { type: 'string', maxLength: 16, enum: ['deployment', 'job'] },
      targetId: { type: 'string', maxLength: 64, pattern: ID } }, required: ['target', 'targetId'], additionalProperties: false }),
  a('data.problem.write', 'data', 'Write a business question', { inlineKind: 'problem_statement' }, [], []),
  a('data-scientist.problem.write', 'data-scientist', 'Write a business problem', { inlineKind: 'problem_statement' }, [], []),
  a('ml.problem.write', 'ml', 'Write a problem statement', { inlineKind: 'problem_statement' }, [], []),
  a('dl.problem.write', 'dl', 'Write a problem statement', { inlineKind: 'problem_statement' }, [], [])
];

export const USER_ACTION_IDS: readonly UserActionId[] = USER_ACTIONS.map((x) => x.id);

export function getUserAction(id: string): UserActionDef | null {
  return USER_ACTIONS.find((x) => x.id === id) ?? null;
}
