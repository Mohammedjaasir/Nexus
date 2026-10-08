// The artifact kinds the six domains name. Every kind is listed now so the
// registry's ids resolve; `availableFrom` says when it becomes real, and the
// boot check refuses a REAL step that produces a kind from a later sub-phase.

import type { KindId, SubPhase, ViewerId } from './domainSpec';
import { deepFreeze } from './freeze';

export type StorageForm = 'inline' | 'git' | 'blob' | 'tree' | 'external';

export interface KindDef {
  id: KindId;
  label: string;
  plural: string;
  storage: StorageForm[];
  /** Only one active version per artifact at a time (the default, F.7); change sets and checkpoints are not. */
  singleActive: boolean;
  /** `nexus:artifact:saveInline` (or a B1 user save) may create it. */
  userAuthorable: boolean;
  viewer: ViewerId;
  availableFrom: SubPhase;
}

const k = (id: KindId, label: string, plural: string, storage: StorageForm[], availableFrom: SubPhase,
  o: { singleActive?: boolean; userAuthorable?: boolean } = {}): KindDef =>
  ({ id, label, plural, storage, singleActive: o.singleActive ?? true, userAuthorable: o.userAuthorable ?? false,
    viewer: `viewer.${id}`, availableFrom });

export const KINDS: readonly KindDef[] = deepFreeze([
  // B1 kinds, unchanged.
  k('git_commit', 'Commit', 'Commits', ['git'], 'B1', { userAuthorable: true }),
  k('text_file', 'Text file', 'Text files', ['inline'], 'B1', { userAuthorable: true }),
  k('handoff_receipt', 'Handoff receipt', 'Handoff receipts', ['inline'], 'B1'),
  // B2a: SDE tool path and problem statements.
  k('repository', 'Repository snapshot', 'Repository snapshots', ['git'], 'B2a'),
  k('requirement', 'Requirement', 'Requirements', ['inline'], 'B2a', { userAuthorable: true }),
  k('problem_statement', 'Problem statement', 'Problem statements', ['inline'], 'B2a', { userAuthorable: true }),
  k('test_suite', 'Test suite', 'Test suites', ['git'], 'B2a'),
  k('build', 'Build', 'Builds', ['tree'], 'B2a'),
  k('application', 'Application', 'Applications', ['inline'], 'B2a'),
  k('diagnostic_report', 'Diagnostic report', 'Diagnostic reports', ['inline'], 'B2a'),
  // B2b: agent changes.
  k('change_set', 'Change', 'Changes', ['git'], 'B2b', { singleActive: false }),
  // B2c: QA.
  k('test_plan', 'Test plan', 'Test plans', ['inline'], 'B2c', { userAuthorable: true }),
  k('test_case', 'Test case', 'Test cases', ['inline'], 'B2c', { userAuthorable: true }),
  k('test_run', 'Test run', 'Test runs', ['blob'], 'B2c'),
  k('defect', 'Defect', 'Defects', ['inline'], 'B2c', { userAuthorable: true }),
  k('regression_report', 'Regression report', 'Regression reports', ['inline'], 'B2c'),
  k('quality_report', 'Quality report', 'Quality reports', ['inline', 'blob'], 'B2c'),
  k('release_recommendation', 'Release recommendation', 'Release recommendations', ['inline'], 'B2c'),
  // B3: Data Analyst.
  k('dataset', 'Dataset', 'Datasets', ['blob', 'tree', 'external'], 'B3'),
  k('query', 'Query', 'Queries', ['inline', 'blob'], 'B3', { userAuthorable: true }),
  k('analysis', 'Analysis', 'Analyses', ['git', 'blob'], 'B3'),
  k('chart', 'Chart', 'Charts', ['blob'], 'B3'),
  k('dashboard', 'Dashboard', 'Dashboards', ['blob'], 'B3'),
  k('report', 'Report', 'Reports', ['blob'], 'B3'),
  k('insight', 'Insight', 'Insights', ['inline'], 'B3', { userAuthorable: true }),
  // B4: Data Scientist.
  k('feature_set', 'Feature set', 'Feature sets', ['blob', 'external'], 'B4'),
  k('experiment', 'Experiment', 'Experiments', ['inline'], 'B4', { userAuthorable: true }),
  k('model', 'Model', 'Models', ['blob'], 'B4'),
  k('evaluation', 'Evaluation', 'Evaluations', ['inline', 'blob'], 'B4'),
  // B5: ML Engineer.
  k('expectation_suite', 'Expectation suite', 'Expectation suites', ['inline'], 'B5', { userAuthorable: true }),
  k('training_run', 'Training run', 'Training runs', ['inline', 'blob'], 'B5'),
  k('serving_package', 'Serving package', 'Serving packages', ['blob'], 'B5'),
  k('inference_service', 'Inference service', 'Inference services', ['inline'], 'B5'),
  k('monitoring_report', 'Monitoring report', 'Monitoring reports', ['inline'], 'B5'),
  // B6: DL Engineer.
  k('checkpoint', 'Checkpoint', 'Checkpoints', ['blob'], 'B6', { singleActive: false }),
  k('preprocessing_pipeline', 'Preprocessing pipeline', 'Preprocessing pipelines', ['git'], 'B6'),
  k('architecture', 'Architecture', 'Architectures', ['git'], 'B6'),
  k('model_export', 'Model export', 'Model exports', ['blob'], 'B6'),
  k('benchmark', 'Benchmark', 'Benchmarks', ['inline'], 'B6')
]);

export const KIND_IDS: readonly KindId[] = deepFreeze(KINDS.map((x) => x.id));

export function getKind(id: string): KindDef | null {
  return KINDS.find((x) => x.id === id) ?? null;
}
