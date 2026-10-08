// DL Engineer. In B2a only problem statements are real; the workflow (CPU
// training, ONNX export, dynamic int8 optimization, local serving) arrives in B6.
// The legacy id `deep-learning` joins the live map only in its own phase.

import type { DomainSpec, LifecycleStep, PrerequisiteId, StepDoneWhen } from '../domainSpec';

const RUNS: PrerequisiteId[] = ['docker', 'image:dl-cpu'];
const later = (id: string, label: string, consumes: string[], produces: string[], doneWhen: StepDoneWhen,
  prerequisites: PrerequisiteId[] = RUNS, scopeNote = 'DL Engineer workflows arrive in B6.'): LifecycleStep =>
  ({ id, label, consumes, produces, via: [], doneWhen, status: 'FUTURE', subPhase: 'B6', prerequisites, scopeNote });
const kind = (k: string): StepDoneWhen => ({ kind: k, statuses: ['candidate', 'active'], validators: [] });

export const DL: DomainSpec = {
  specVersion: 3,
  id: 'dl', label: 'DL Engineer', shortLabel: 'DL',
  description: 'Train, compare, export, optimize and serve neural networks, with checkpoints and parity evidence.',
  tier: 'first-class', hueSlot: 2, icon: 'dl', order: 3,
  availableFromSubPhase: 'B1',
  statusNote: 'You can write problem statements in this release. Training, checkpoints, export and serving arrive in B6.',
  legacyDomainIds: ['computer-vision'],
  vocabulary: {
    problem_statement: { singular: 'Problem', plural: 'Problems' },
    dataset: { singular: 'Dataset', plural: 'Datasets' },
    preprocessing_pipeline: { singular: 'Pipeline', plural: 'Pipelines' },
    architecture: { singular: 'Architecture', plural: 'Architectures' },
    training_run: { singular: 'Training run', plural: 'Training runs' },
    checkpoint: { singular: 'Checkpoint', plural: 'Checkpoints' },
    evaluation: { singular: 'Evaluation', plural: 'Evaluations' },
    experiment: { singular: 'Comparison', plural: 'Comparisons' },
    model: { singular: 'Model', plural: 'Models' },
    model_export: { singular: 'Export', plural: 'Exports' },
    benchmark: { singular: 'Benchmark', plural: 'Benchmarks' },
    inference_service: { singular: 'Service', plural: 'Services' }
  },
  kindsProduced: ['problem_statement', 'dataset', 'preprocessing_pipeline', 'architecture', 'training_run', 'checkpoint',
    'evaluation', 'experiment', 'model', 'model_export', 'benchmark', 'inference_service'],
  kindsAccepted: [],
  capabilities: [
    { id: 'code.read' }, { id: 'code.edit', scope: { paths: ['dl/**'] } }, { id: 'git.commit' }, { id: 'sandbox.exec' },
    { id: 'artifact.read' }, { id: 'artifact.register' }, { id: 'job.request' }, { id: 'handoff.create' }, { id: 'review.request' },
    { id: 'approval.request' }, { id: 'data.read' }, { id: 'data.register' }, { id: 'model.train.cpu' }, { id: 'model.evaluate' },
    { id: 'model.package' }, { id: 'model.serve' }, { id: 'model.export' }, { id: 'model.optimize' }
  ],
  recipes: [], skills: [], actions: ['dl.problem.write'],
  lifecycle: [
    { id: 'problem', label: 'Problem', consumes: [], produces: ['problem_statement'],
      via: [{ userAction: 'dl.problem.write' }],
      doneWhen: { kind: 'problem_statement', statuses: ['candidate', 'active'], validators: ['problem.schema'] },
      status: 'REAL', subPhase: 'B2a', prerequisites: [], e2eTestId: 'e2e.dl.problem',
      scopeNote: 'You write it in Nexus. The rest of this workflow arrives in B6.' },
    later('dataset', 'Dataset', [], ['dataset'], kind('dataset'), ['disk:5GiB']),
    later('dataset-prep', 'Dataset preparation', ['dataset'], ['dataset'], kind('dataset')),
    later('preprocessing', 'Preprocessing', ['dataset'], ['preprocessing_pipeline', 'dataset'], kind('preprocessing_pipeline')),
    later('architecture', 'Architecture and config', [], ['architecture'], kind('architecture')),
    later('training', 'Training', ['architecture', 'dataset'], ['training_run', 'checkpoint'], kind('training_run'), RUNS,
      'Arrives in B6, on the CPU only; GPU training is not in the planned phases.'),
    later('checkpoint', 'Checkpoint', ['training_run'], ['checkpoint'], kind('checkpoint')),
    later('evaluation', 'Evaluation', ['checkpoint', 'dataset'], ['evaluation'], kind('evaluation')),
    later('comparison', 'Experiment comparison', ['training_run', 'evaluation'], ['experiment'], { record: 'selection' }, []),
    later('model-version', 'Model version', ['checkpoint'], ['model'], kind('model'), []),
    later('export', 'Export', ['model'], ['model_export'], kind('model_export')),
    later('inference', 'Inference', ['model_export'], ['benchmark'], kind('benchmark')),
    later('optimization', 'Optimization', ['model_export'], ['model_export', 'benchmark', 'evaluation'], kind('model_export'), RUNS,
      'Arrives in B6 as dynamic int8 quantization only; pruning, distillation and static quantization are not in the planned phases.'),
    later('serving', 'Serving', ['model_export'], ['inference_service'], kind('inference_service'), [...RUNS, 'image:nexus-fwd'],
      'Arrives in B6, served locally on 127.0.0.1.'),
    later('iteration', 'Iteration', ['checkpoint', 'architecture'], ['training_run', 'architecture'], kind('training_run'))
  ],
  handoffRoutes: [
    { to: 'ml', kinds: ['model_export', 'model', 'evaluation', 'benchmark'], action: 'package', subPhase: 'B6' },
    { to: 'sde', kinds: ['model_export'], action: 'create-api', subPhase: 'B6' }
  ],
  completionRules: [{ id: 'dl.end-to-end', label: 'Executable end to end',
    steps: ['problem', 'dataset', 'dataset-prep', 'preprocessing', 'architecture', 'training', 'checkpoint', 'evaluation',
      'comparison', 'model-version', 'export', 'inference', 'optimization', 'serving', 'iteration'], subPhase: 'B6' }],
  modules: [
    { id: 'problems', label: 'Problems', kinds: ['problem_statement'], subPhase: 'B2a' },
    { id: 'datasets', label: 'Datasets', kinds: ['dataset'], subPhase: 'B6' },
    { id: 'pipelines', label: 'Pipelines', kinds: ['preprocessing_pipeline'], subPhase: 'B6' },
    { id: 'architectures', label: 'Architectures', kinds: ['architecture'], subPhase: 'B6' },
    { id: 'training-runs', label: 'Training runs', kinds: ['training_run'], subPhase: 'B6' },
    { id: 'checkpoints', label: 'Checkpoints', kinds: ['checkpoint'], subPhase: 'B6' },
    { id: 'comparison', label: 'Comparison', kinds: ['experiment'], subPhase: 'B6' },
    { id: 'models', label: 'Models', kinds: ['model'], subPhase: 'B6' },
    { id: 'exports', label: 'Exports', kinds: ['model_export'], subPhase: 'B6' },
    { id: 'benchmarks', label: 'Benchmarks', kinds: ['benchmark'], subPhase: 'B6' },
    { id: 'services', label: 'Services', kinds: ['inference_service'], subPhase: 'B6' }
  ]
};
