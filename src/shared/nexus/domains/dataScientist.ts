// Data Scientist (`data-scientist`). Listed with its lifecycle in B2a, but a
// project cannot take part in it until B4, when its workspace row is added
// (v13). Legacy `data-science` projects stay with Data Analyst until then.

import type { DomainSpec, LifecycleStep, PrerequisiteId, StepDoneWhen } from '../domainSpec';

const RUNS: PrerequisiteId[] = ['docker', 'image:data-python'];
const later = (id: string, label: string, consumes: string[], produces: string[], doneWhen: StepDoneWhen,
  prerequisites: PrerequisiteId[] = RUNS, scopeNote = 'Data Scientist workflows arrive in B4.'): LifecycleStep =>
  ({ id, label, consumes, produces, via: [], doneWhen, status: 'FUTURE', subPhase: 'B4', prerequisites, scopeNote });
const kind = (k: string): StepDoneWhen => ({ kind: k, statuses: ['candidate', 'active'], validators: [] });

export const DATA_SCIENTIST: DomainSpec = {
  specVersion: 3,
  id: 'data-scientist', label: 'Data Scientist', shortLabel: 'DS',
  description: 'Establish what is true in the data and what a baseline model can predict, reproducibly, and hand results on to ML.',
  tier: 'first-class', hueSlot: 8, icon: 'data', order: 9,
  availableFromSubPhase: 'B4',
  statusNote: 'Shown with its lifecycle in this release. A project can take part in Data Scientist work from B4.',
  legacyDomainIds: [],
  vocabulary: {
    problem_statement: { singular: 'Business problem', plural: 'Business problems' },
    dataset: { singular: 'Dataset', plural: 'Datasets' },
    analysis: { singular: 'Notebook', plural: 'Notebooks' },
    feature_set: { singular: 'Feature set', plural: 'Feature sets' },
    experiment: { singular: 'Experiment', plural: 'Experiments' },
    model: { singular: 'Baseline model', plural: 'Baseline models' },
    evaluation: { singular: 'Evaluation', plural: 'Evaluations' },
    insight: { singular: 'Insight', plural: 'Insights' },
    report: { singular: 'Report', plural: 'Reports' }
  },
  kindsProduced: ['problem_statement', 'dataset', 'analysis', 'feature_set', 'experiment', 'model', 'evaluation', 'insight', 'report'],
  kindsAccepted: ['dataset', 'query', 'insight', 'report', 'problem_statement'],
  capabilities: [
    { id: 'code.read' }, { id: 'code.edit', scope: { paths: ['notebooks/**', 'ds/**'] } }, { id: 'git.commit' }, { id: 'sandbox.exec' },
    { id: 'artifact.read' }, { id: 'artifact.register' }, { id: 'job.request' }, { id: 'handoff.create' }, { id: 'review.request' },
    { id: 'data.read' }, { id: 'data.register' }, { id: 'sql.query' }, { id: 'notebook.run' }, { id: 'stats.run' },
    { id: 'model.train.cpu' }, { id: 'model.evaluate' }
  ],
  recipes: [], skills: [], actions: ['data-scientist.problem.write'],
  lifecycle: [
    { id: 'business-problem', label: 'Business problem', consumes: [], produces: ['problem_statement'],
      via: [{ userAction: 'data-scientist.problem.write' }],
      doneWhen: { kind: 'problem_statement', statuses: ['candidate', 'active'], validators: ['problem.schema'] },
      status: 'REAL', subPhase: 'B2a', prerequisites: [], e2eTestId: 'e2e.data-scientist.business-problem',
      scopeNote: 'Problem statements are real in this release; a project can take part in Data Scientist work from B4.' },
    later('acquisition', 'Acquisition', [], ['dataset'], kind('dataset'), ['disk:5GiB'],
      'Arrives in B4 for local files and handoffs; external connectors are not in the planned phases.'),
    later('exploration', 'Exploration', ['dataset'], ['analysis'], kind('analysis')),
    later('cleaning', 'Cleaning', ['dataset'], ['dataset'], kind('dataset')),
    later('features', 'Feature engineering', ['dataset'], ['feature_set'], kind('feature_set')),
    later('statistics', 'Statistical analysis', ['dataset'], ['analysis'], kind('analysis')),
    later('experiment', 'Experiment', ['dataset', 'problem_statement'], ['experiment'], { record: 'conclusion' }),
    later('modeling', 'Modeling', ['dataset', 'feature_set'], ['dataset', 'model'], kind('model')),
    later('evaluation', 'Evaluation', ['model', 'dataset'], ['evaluation'], kind('evaluation')),
    later('insight-model', 'Insight or model', ['evaluation', 'analysis'], ['insight', 'model'], kind('insight'), []),
    later('report', 'Report', ['analysis', 'experiment', 'evaluation'], ['report'], kind('report')),
    later('handoff', 'Handoff', ['model', 'evaluation', 'feature_set', 'report'], [], { record: 'handoff_sent' }, [])
  ],
  handoffRoutes: [
    { to: 'ml', kinds: ['model', 'evaluation', 'feature_set', 'dataset', 'report'], action: 'productionize', subPhase: 'B5' },
    { to: 'data', kinds: ['report', 'insight'], action: 'inform', subPhase: 'B4' }
  ],
  completionRules: [{ id: 'data-scientist.end-to-end', label: 'Executable end to end',
    steps: ['business-problem', 'acquisition', 'exploration', 'cleaning', 'features', 'statistics', 'experiment', 'modeling',
      'evaluation', 'insight-model', 'report', 'handoff'], subPhase: 'B4' }],
  modules: [
    { id: 'problems', label: 'Problems', kinds: ['problem_statement'], subPhase: 'B4' },
    { id: 'datasets', label: 'Datasets', kinds: ['dataset'], subPhase: 'B4' },
    { id: 'notebooks', label: 'Notebooks', kinds: ['analysis'], subPhase: 'B4' },
    { id: 'features', label: 'Features', kinds: ['feature_set'], subPhase: 'B4' },
    { id: 'statistics', label: 'Statistics', kinds: ['analysis'], subPhase: 'B4' },
    { id: 'experiments', label: 'Experiments', kinds: ['experiment'], subPhase: 'B4' },
    { id: 'models', label: 'Models', kinds: ['model'], subPhase: 'B4' },
    { id: 'evaluations', label: 'Evaluations', kinds: ['evaluation'], subPhase: 'B4' },
    { id: 'reports', label: 'Reports', kinds: ['report'], subPhase: 'B4' }
  ]
};
