// ML Engineer. In B2a only problem statements are real; the workflow (CPU
// training, local serving, local-traffic monitoring) arrives in B5.

import type { DomainSpec, LifecycleStep, PrerequisiteId, StepDoneWhen } from '../domainSpec';

const RUNS: PrerequisiteId[] = ['docker', 'image:ml-python'];
const later = (id: string, label: string, consumes: string[], produces: string[], doneWhen: StepDoneWhen,
  prerequisites: PrerequisiteId[] = RUNS, scopeNote = 'ML Engineer workflows arrive in B5.'): LifecycleStep =>
  ({ id, label, consumes, produces, via: [], doneWhen, status: 'FUTURE', subPhase: 'B5', prerequisites, scopeNote });
const kind = (k: string, statuses: ('candidate' | 'active')[] = ['candidate', 'active']): StepDoneWhen =>
  ({ kind: k, statuses, validators: [] });

export const ML: DomainSpec = {
  specVersion: 3,
  id: 'ml', label: 'ML Engineer', shortLabel: 'ML',
  description: 'Turn data and a problem into a validated, packaged, served and monitored model, with a reproducible record of every run.',
  tier: 'first-class', hueSlot: 1, icon: 'ml', order: 2,
  participationFromSubPhase: 'B1',
  statusNote: 'You can write problem statements in this release. Datasets, training, evaluation, packaging and serving arrive in B5.',
  legacyDomainIds: ['ai-ml'],
  vocabulary: {
    problem_statement: { singular: 'Problem', plural: 'Problems' },
    dataset: { singular: 'Dataset', plural: 'Datasets' },
    expectation_suite: { singular: 'Expectation suite', plural: 'Expectations' },
    feature_set: { singular: 'Feature set', plural: 'Features' },
    experiment: { singular: 'Experiment', plural: 'Experiments' },
    training_run: { singular: 'Run', plural: 'Runs' },
    model: { singular: 'Model', plural: 'Models' },
    evaluation: { singular: 'Evaluation', plural: 'Evaluations' },
    serving_package: { singular: 'Package', plural: 'Packages' },
    inference_service: { singular: 'Service', plural: 'Services' },
    monitoring_report: { singular: 'Monitoring report', plural: 'Monitoring' }
  },
  kindsProduced: ['problem_statement', 'dataset', 'expectation_suite', 'feature_set', 'experiment', 'training_run', 'model',
    'evaluation', 'serving_package', 'inference_service', 'monitoring_report'],
  kindsAccepted: ['dataset', 'insight', 'model', 'evaluation', 'feature_set', 'report', 'model_export', 'benchmark'],
  capabilities: [
    { id: 'code.read' }, { id: 'code.edit', scope: { paths: ['ml/**'] } }, { id: 'git.commit' }, { id: 'sandbox.exec' },
    { id: 'artifact.read' }, { id: 'artifact.register' }, { id: 'job.request' }, { id: 'handoff.create' }, { id: 'review.request' },
    { id: 'approval.request' }, { id: 'data.read' }, { id: 'data.register' }, { id: 'sql.query' }, { id: 'model.train.cpu' },
    { id: 'model.evaluate' }, { id: 'model.package' }, { id: 'model.serve' }
  ],
  recipes: [], skills: [], actions: ['ml.problem.write'],
  lifecycle: [
    { id: 'problem', label: 'Problem', consumes: [], produces: ['problem_statement'],
      via: [{ userAction: 'ml.problem.write' }],
      doneWhen: { kind: 'problem_statement', statuses: ['candidate', 'active'], validators: ['problem.schema'] },
      status: 'REAL', subPhase: 'B2a', prerequisites: [], e2eTestId: 'e2e.ml.problem',
      scopeNote: 'You write it in Nexus. The rest of this workflow arrives in B5.' },
    later('dataset', 'Dataset', [], ['dataset'], kind('dataset')),
    later('data-validation', 'Data validation', ['dataset'], ['expectation_suite'], kind('expectation_suite')),
    later('data-prep', 'Data preparation and features', ['dataset'], ['feature_set', 'dataset'], kind('feature_set')),
    later('experiment', 'Experiment', ['problem_statement', 'evaluation'], ['experiment'], kind('experiment'), []),
    later('training', 'Training', ['experiment', 'dataset'], ['training_run', 'model'], kind('training_run'), RUNS,
      'Arrives in B5, on the CPU only; GPU training is not in the planned phases.'),
    later('evaluation', 'Evaluation', ['model', 'dataset'], ['evaluation'], kind('evaluation')),
    later('model-version', 'Model version', ['training_run'], ['model'], kind('model')),
    later('validation', 'Validation', ['model', 'evaluation'], ['model'], kind('model', ['active'])),
    later('packaging', 'Packaging', ['model'], ['serving_package'], kind('serving_package')),
    later('serving', 'Serving and API', ['serving_package'], ['inference_service'], kind('inference_service'),
      [...RUNS, 'image:nexus-fwd'], 'Arrives in B5, served locally on 127.0.0.1.'),
    later('monitoring', 'Monitoring', ['inference_service'], ['monitoring_report'], kind('monitoring_report'), RUNS,
      'Arrives in B5 for local traffic only; alerting and production traffic are not in the planned phases.'),
    later('iteration', 'Iteration', ['monitoring_report', 'evaluation'], ['experiment', 'training_run'], kind('training_run'))
  ],
  handoffRoutes: [
    { to: 'sde', kinds: ['serving_package', 'inference_service', 'evaluation'], action: 'create-api', subPhase: 'B5' },
    { to: 'qa', kinds: ['inference_service'], action: 'test-api', subPhase: 'B5' },
    { to: 'data', kinds: ['dataset'], action: 'inform', subPhase: 'B5' }
  ],
  completionRules: [{ id: 'ml.end-to-end', label: 'End-to-end flow',
    steps: ['problem', 'dataset', 'data-validation', 'data-prep', 'experiment', 'training', 'evaluation', 'model-version',
      'validation', 'packaging', 'serving', 'monitoring', 'iteration'], subPhase: 'B5' }],
  modules: [
    { id: 'problems', label: 'Problems', kinds: ['problem_statement'], subPhase: 'B2a' },
    { id: 'datasets', label: 'Datasets', kinds: ['dataset'], subPhase: 'B5' },
    { id: 'expectations', label: 'Expectations', kinds: ['expectation_suite'], subPhase: 'B5' },
    { id: 'features', label: 'Features', kinds: ['feature_set'], subPhase: 'B5' },
    { id: 'experiments', label: 'Experiments', kinds: ['experiment'], subPhase: 'B5' },
    { id: 'runs', label: 'Runs', kinds: ['training_run'], subPhase: 'B5' },
    { id: 'models', label: 'Models', kinds: ['model'], subPhase: 'B5' },
    { id: 'evaluations', label: 'Evaluations', kinds: ['evaluation'], subPhase: 'B5' },
    { id: 'packages', label: 'Packages', kinds: ['serving_package'], subPhase: 'B5' },
    { id: 'services', label: 'Services', kinds: ['inference_service'], subPhase: 'B5' },
    { id: 'monitoring', label: 'Monitoring', kinds: ['monitoring_report'], subPhase: 'B5' }
  ]
};
