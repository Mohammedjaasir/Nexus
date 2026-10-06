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
  ['queued', 'awaiting_approval'],
  ['awaiting_approval', 'queued'],
  ['awaiting_approval', 'running'],
  ['awaiting_approval', 'cancelled'],
  ['awaiting_approval', 'timed_out'],
  ['awaiting_approval', 'interrupted'],
  ['leased', 'running'],
  ['leased', 'queued'],
  ['leased', 'cancelled'],
  ['leased', 'interrupted'],
  ['running', 'awaiting_approval'],
  ['running', 'completed'],
  ['running', 'partial'],
  ['running', 'failed'],
  ['running', 'cancelled'],
  ['running', 'timed_out'],
  ['running', 'interrupted'],
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
  ['open', 'cancelled'],
  ['open', 'interrupted'],
  ['open', 'failed'],
  ['running', 'awaiting_approval'],
  ['running', 'completed'],
  ['running', 'failed'],
  ['running', 'cancelled'],
  ['running', 'timed_out'],
  ['running', 'interrupted'],
  ['awaiting_approval', 'running'],
  ['awaiting_approval', 'cancelled'],
  ['awaiting_approval', 'timed_out'],
  ['awaiting_approval', 'interrupted']
];

export const BRIEF_LINEAGE_RELATIONS: readonly string[] = [
  'derived_from', 'trained_on', 'evaluated_on', 'implements', 'serves', 'built_from', 'deployed_as', 'depends_on'
];

export const V7_LINEAGE_RELATIONS: readonly { relation: string; description: string; plannedPhase: string }[] = [
  { relation: 'derived_from', description: 'A version produced by transforming another version.', plannedPhase: 'B1' },
  { relation: 'trained_on', description: 'A model version fitted on a dataset version.', plannedPhase: 'B3' },
  { relation: 'evaluated_on', description: 'A version scored against an evaluation dataset version.', plannedPhase: 'B3' },
  { relation: 'implements', description: 'A version that realises a specification or design version.', plannedPhase: 'B2' },
  { relation: 'serves', description: 'A deployable version that serves a model or service version.', plannedPhase: 'B6' },
  { relation: 'built_from', description: 'A build output made from a source version.', plannedPhase: 'B2' },
  { relation: 'deployed_as', description: 'A version rolled out as a deployment.', plannedPhase: 'B6' },
  { relation: 'depends_on', description: 'A version that requires another version to work.', plannedPhase: 'B1' },
  { relation: 'contains', description: 'A collection version that holds another version.', plannedPhase: 'B1' },
  { relation: 'extracted_from', description: 'A version extracted from a larger source version.', plannedPhase: 'B4' },
  { relation: 'queried_from', description: 'A result version produced by querying a data version.', plannedPhase: 'B4' },
  { relation: 'visualizes', description: 'A chart or dashboard version that presents a data version.', plannedPhase: 'B4' },
  { relation: 'cites', description: 'A document version that references another version as a source.', plannedPhase: 'B5' },
  { relation: 'analyzes', description: 'An analysis version that examines another version.', plannedPhase: 'B4' },
  { relation: 'tested_on', description: 'A version exercised against a test input version.', plannedPhase: 'B5' },
  { relation: 'run_of', description: 'A run record that executed a particular version.', plannedPhase: 'B3' },
  { relation: 'produced_by', description: 'A version output by a run or job.', plannedPhase: 'B1' },
  { relation: 'resumed_from', description: 'A run version continued from an earlier checkpoint version.', plannedPhase: 'B3' },
  { relation: 'selected_from', description: 'A version chosen out of a set of candidate versions.', plannedPhase: 'B3' },
  { relation: 'evaluates', description: 'An evaluation version that judges another version.', plannedPhase: 'B3' },
  { relation: 'packages', description: 'A package version that bundles another version.', plannedPhase: 'B6' },
  { relation: 'exported_from', description: 'A version exported from another version in a new format.', plannedPhase: 'B3' },
  { relation: 'fixes', description: 'A version that corrects a defect recorded against another version.', plannedPhase: 'B5' },
  { relation: 'assembled_from', description: 'A composite version assembled from several part versions.', plannedPhase: 'B2' },
  { relation: 'tests', description: 'A test version that checks another version.', plannedPhase: 'B5' },
  { relation: 'executes', description: 'A version that runs another version.', plannedPhase: 'B2' },
  { relation: 'found_in', description: 'A finding version located within another version.', plannedPhase: 'B5' },
  { relation: 'evidenced_by', description: 'A claim version backed by an evidence version.', plannedPhase: 'B5' },
  { relation: 'verified_by', description: 'A version confirmed by a verification version.', plannedPhase: 'B5' },
  { relation: 'summarizes', description: 'A summary version that condenses another version.', plannedPhase: 'B5' },
  { relation: 'recommends', description: 'A recommendation version that proposes acting on another version.', plannedPhase: 'B4' },
  { relation: 'based_on', description: 'A version that takes another version as its basis.', plannedPhase: 'B1' }
];

export const V7_PRINCIPALS: readonly { id: string; kind: 'user' | 'system'; displayName: string }[] = [
  { id: 'local-user', kind: 'user', displayName: 'Local user' },
  { id: 'system', kind: 'system', displayName: 'System' }
];

// Platform scope '*'. Phase 1 is single-user: the local user owns the platform.
export const V7_MEMBERSHIPS: readonly { principalId: string; role: 'owner' | 'admin' }[] = [
  { principalId: 'local-user', role: 'owner' }
];
