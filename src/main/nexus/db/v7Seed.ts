// Frozen v7 seed: shipped migration data; never edit - later changes go in a new migration.
// Deliberately self-contained: it does not import the live catalogue, so a later
// catalogue change cannot alter what schema v7 seeds.

export const V7_WORKSPACE_IDS: readonly string[] = ['sde', 'ml', 'dl', 'data', 'research', 'qa', 'uiux', 'devops'];

export const V7_DOMAIN_TO_WORKSPACE: Readonly<Record<string, string>> = {
  'software-engineering': 'sde',
  'web-app-dev': 'sde',
  'mobile-dev': 'sde',
  'game-dev': 'sde',
  'embedded-systems': 'sde',
  'robotics-iot': 'sde',
  'blockchain-web3': 'sde',
  'automation-rpa': 'sde',
  'ai-ml': 'ml',
  'computer-vision': 'dl',
  'data-analytics': 'data',
  'data-science': 'data',
  'gis-geospatial': 'data',
  'research-scientific': 'research',
  'devops-cloud': 'devops'
};

export const V7_JOB_STATES: readonly { state: string; terminal: 0 | 1 }[] = [
  { state: 'queued', terminal: 0 },
  { state: 'leased', terminal: 0 },
  { state: 'running', terminal: 0 },
  { state: 'awaiting_approval', terminal: 0 },
  { state: 'retry_scheduled', terminal: 0 },
  { state: 'completed', terminal: 1 },
  { state: 'partial', terminal: 1 },
  { state: 'failed', terminal: 1 },
  { state: 'cancelled', terminal: 1 },
  { state: 'timed_out', terminal: 1 },
  { state: 'interrupted', terminal: 1 }
];

export const V7_JOB_TRANSITIONS: readonly (readonly [string, string])[] = [
  ['queued', 'leased'],
  ['queued', 'cancelled'],
  ['leased', 'running'],
  ['leased', 'queued'],
  ['leased', 'failed'],
  ['leased', 'cancelled'],
  ['leased', 'interrupted'],
  ['running', 'awaiting_approval'],
  ['running', 'completed'],
  ['running', 'partial'],
  ['running', 'failed'],
  ['running', 'cancelled'],
  ['running', 'timed_out'],
  ['running', 'interrupted'],
  ['awaiting_approval', 'running'],
  ['awaiting_approval', 'failed'],
  ['awaiting_approval', 'cancelled'],
  ['awaiting_approval', 'timed_out'],
  ['awaiting_approval', 'interrupted'],
  ['failed', 'retry_scheduled'],
  ['timed_out', 'retry_scheduled'],
  ['retry_scheduled', 'queued'],
  ['retry_scheduled', 'cancelled']
];

export const V7_SESSION_STATES: readonly { state: string; terminal: 0 | 1 }[] = [
  { state: 'open', terminal: 0 },
  { state: 'running', terminal: 0 },
  { state: 'awaiting_approval', terminal: 0 },
  { state: 'completed', terminal: 1 },
  { state: 'failed', terminal: 1 },
  { state: 'cancelled', terminal: 1 },
  { state: 'timed_out', terminal: 1 },
  { state: 'interrupted', terminal: 1 }
];

export const V7_SESSION_TRANSITIONS: readonly (readonly [string, string])[] = [
  ['open', 'running'],
  ['open', 'failed'],
  ['open', 'cancelled'],
  ['running', 'awaiting_approval'],
  ['running', 'completed'],
  ['running', 'failed'],
  ['running', 'cancelled'],
  ['running', 'timed_out'],
  ['running', 'interrupted'],
  ['awaiting_approval', 'running'],
  ['awaiting_approval', 'failed'],
  ['awaiting_approval', 'cancelled'],
  ['awaiting_approval', 'timed_out'],
  ['awaiting_approval', 'interrupted']
];

export const BRIEF_LINEAGE_RELATIONS: readonly string[] = [
  'derived_from', 'trained_on', 'evaluated_on', 'implements', 'serves', 'built_from', 'deployed_as', 'depends_on'
];

export const V7_LINEAGE_RELATIONS: readonly { relation: string; description: string; plannedPhase: string }[] = [
  { relation: 'derived_from', description: 'A newer version of the same kind, a new artifact derived from another version, or a change set derived from its base repository commit.', plannedPhase: 'B1' },
  { relation: 'contains', description: 'A repository snapshot that contains a change set, verified by git ancestry.', plannedPhase: 'B1' },
  { relation: 'extracted_from', description: 'An API description extracted from a repository.', plannedPhase: 'B1' },
  { relation: 'built_from', description: 'A build made from a repository.', plannedPhase: 'B1' },
  { relation: 'assembled_from', description: 'An application assembled from a build.', plannedPhase: 'B1' },
  { relation: 'fixes', description: 'A change set that fixes a defect.', plannedPhase: 'B2' },
  { relation: 'tests', description: 'A test run that tests a build or an application.', plannedPhase: 'B2' },
  { relation: 'executes', description: 'A test run that executes a test plan.', plannedPhase: 'B2' },
  { relation: 'found_in', description: 'A defect found in a build.', plannedPhase: 'B2' },
  { relation: 'evidenced_by', description: 'A defect evidenced by a test run.', plannedPhase: 'B2' },
  { relation: 'verified_by', description: 'A defect verified by a test run.', plannedPhase: 'B2' },
  { relation: 'summarizes', description: 'A quality report that summarizes a test run or a defect.', plannedPhase: 'B2' },
  { relation: 'recommends', description: 'A release recommendation that recommends a build.', plannedPhase: 'B2' },
  { relation: 'based_on', description: 'A release recommendation based on a quality report.', plannedPhase: 'B2' },
  { relation: 'depends_on', description: 'An experiment that depends on an evaluation as its baseline, a test plan that depends on a report, or an application that depends on an API.', plannedPhase: 'B2' },
  { relation: 'queried_from', description: 'A query that reads from a dataset.', plannedPhase: 'B3a' },
  { relation: 'visualizes', description: 'A dashboard that visualizes a query.', plannedPhase: 'B3a' },
  { relation: 'cites', description: 'A report or insight that cites a query, dashboard, analysis, experiment, evaluation or dataset.', plannedPhase: 'B3a' },
  { relation: 'analyzes', description: 'An analysis that analyzes a dataset or a query.', plannedPhase: 'B3a' },
  { relation: 'tested_on', description: 'An experiment that is tested on a dataset.', plannedPhase: 'B3b' },
  { relation: 'evaluates', description: 'An evaluation that evaluates a model or a model export.', plannedPhase: 'B3b' },
  { relation: 'evaluated_on', description: 'An evaluation that is run on a dataset.', plannedPhase: 'B3b' },
  { relation: 'run_of', description: 'A training run that belongs to an experiment.', plannedPhase: 'B4' },
  { relation: 'trained_on', description: 'A training run or model trained on a dataset.', plannedPhase: 'B4' },
  { relation: 'produced_by', description: 'A model or checkpoint produced by a training run.', plannedPhase: 'B4' },
  { relation: 'packages', description: 'A serving package that packages a model or a model export.', plannedPhase: 'B4' },
  { relation: 'serves', description: 'A change set that serves a serving package or model export version.', plannedPhase: 'B4' },
  { relation: 'resumed_from', description: 'A training run resumed from a checkpoint.', plannedPhase: 'B5' },
  { relation: 'selected_from', description: 'A model selected from a checkpoint.', plannedPhase: 'B5' },
  { relation: 'exported_from', description: 'A model export made from a model.', plannedPhase: 'B5' },
  { relation: 'deployed_as', description: 'A version rolled out as a deployment. Deployment records arrive in B6; vocabulary only until then.', plannedPhase: 'B6' },
  { relation: 'implements', description: 'A version that realises a specification or design version.', plannedPhase: 'unassigned' }
];

export const V7_PRINCIPALS: readonly { id: string; kind: 'user' | 'system'; displayName: string }[] = [
  { id: 'user:local', kind: 'user', displayName: 'Local owner' },
  { id: 'system', kind: 'system', displayName: 'Nexus platform' }
];

// Platform scope '*'. Phase 1 is single-user: the local owner owns the platform
// and the system principal administers it.
export const V7_MEMBERSHIPS: readonly { principalId: string; role: 'owner' | 'admin' }[] = [
  { principalId: 'user:local', role: 'owner' },
  { principalId: 'system', role: 'admin' }
];
