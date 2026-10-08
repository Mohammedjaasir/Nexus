// Data Analyst (workspace id `data`, seeded in v7 as "Data Analytics"). In B2a
// only business questions (problem statements) are real; the rest of the
// workflow arrives in B3.

import type { DomainSpec, LifecycleStep, PrerequisiteId, StepDoneWhen } from '../domainSpec';

const later = (id: string, label: string, consumes: string[], produces: string[], doneWhen: StepDoneWhen,
  prerequisites: PrerequisiteId[] = ['docker', 'image:data-python'], scopeNote = 'Data Analyst workflows arrive in B3.'): LifecycleStep =>
  ({ id, label, consumes, produces, via: [], doneWhen, status: 'FUTURE', subPhase: 'B3', prerequisites, scopeNote });
const kind = (k: string): StepDoneWhen => ({ kind: k, statuses: ['candidate', 'active'], validators: [] });

export const DATA: DomainSpec = {
  specVersion: 3,
  id: 'data', label: 'Data Analyst', shortLabel: 'DA',
  description: 'Answer a business question with reproducible queries over versioned data, and publish the answer.',
  tier: 'first-class', hueSlot: 3, icon: 'data', order: 4,
  participationFromSubPhase: 'B1',
  statusNote: 'You can write business questions in this release. Data sources, queries, analyses, charts and reports arrive in B3.',
  legacyDomainIds: ['data-analytics', 'data-science', 'gis-geospatial'],
  vocabulary: {
    problem_statement: { singular: 'Business question', plural: 'Business questions' },
    dataset: { singular: 'Data source', plural: 'Data sources' },
    query: { singular: 'Query', plural: 'Queries' },
    analysis: { singular: 'Analysis', plural: 'Analyses' },
    chart: { singular: 'Chart', plural: 'Charts' },
    dashboard: { singular: 'Dashboard', plural: 'Dashboards' },
    report: { singular: 'Report', plural: 'Reports' },
    insight: { singular: 'Insight', plural: 'Insights' }
  },
  kindsProduced: ['problem_statement', 'dataset', 'query', 'analysis', 'chart', 'dashboard', 'report', 'insight'],
  kindsAccepted: ['report', 'insight', 'dataset'],
  capabilities: [
    { id: 'code.read' }, { id: 'code.edit', scope: { paths: ['analysis/**'] } }, { id: 'git.commit' }, { id: 'sandbox.exec' },
    { id: 'artifact.read' }, { id: 'artifact.register' }, { id: 'job.request' }, { id: 'handoff.create' }, { id: 'review.request' },
    { id: 'data.read' }, { id: 'data.register' }, { id: 'sql.query' }
  ],
  recipes: [], skills: [], actions: ['data.problem.write'],
  lifecycle: [
    { id: 'business-question', label: 'Business question', consumes: [], produces: ['problem_statement'],
      via: [{ userAction: 'data.problem.write' }],
      doneWhen: { kind: 'problem_statement', statuses: ['candidate', 'active'], validators: ['problem.schema'] },
      status: 'REAL', subPhase: 'B2a', prerequisites: [], e2eTestId: 'e2e.data.business-question',
      scopeNote: 'You write it in Nexus. The rest of this workflow arrives in B3.' },
    later('data-source', 'Data source', [], ['dataset'], kind('dataset'), ['disk:5GiB'],
      'Arrives in B3 for local files and folders; database and cloud connectors are not in the planned phases.'),
    later('inspection', 'Inspection', ['dataset'], ['dataset'], kind('dataset')),
    later('cleaning', 'Cleaning', ['dataset'], ['query', 'dataset'], kind('dataset')),
    later('query', 'Query', ['dataset'], ['query'], kind('query')),
    later('analysis', 'Analysis', ['dataset', 'query'], ['analysis'], kind('analysis')),
    later('visualization', 'Visualization', ['query'], ['chart'], kind('chart')),
    later('dashboard-report', 'Dashboard and report', ['chart', 'query'], ['dashboard', 'report'], kind('report')),
    later('insight', 'Insight', ['query', 'chart', 'analysis'], ['insight'], kind('insight'), []),
    later('publish', 'Publish and share', ['report', 'dashboard'], [], { record: 'export' }, [],
      'Arrives in B3 as a file export and in-app handoffs; hosted links and scheduled refresh are not in the planned phases.')
  ],
  handoffRoutes: [
    { to: 'data-scientist', kinds: ['dataset', 'query', 'insight', 'report', 'problem_statement'], action: 'investigate', subPhase: 'B4' },
    { to: 'data-scientist', kinds: ['dataset', 'query', 'insight', 'report', 'problem_statement'], action: 'use-as-input', subPhase: 'B4' },
    { to: 'ml', kinds: ['dataset', 'insight'], action: 'use-as-input', subPhase: 'B5' },
    { to: 'ml', kinds: ['dataset', 'insight'], action: 'feature-idea', subPhase: 'B5' }
  ],
  completionRules: [{ id: 'data.end-to-end', label: 'End-to-end flow',
    steps: ['business-question', 'data-source', 'inspection', 'cleaning', 'query', 'analysis', 'visualization', 'dashboard-report',
      'insight', 'publish'], subPhase: 'B3' }],
  modules: [
    { id: 'questions', label: 'Questions', kinds: ['problem_statement'], subPhase: 'B2a' },
    { id: 'data-sources', label: 'Data sources', kinds: ['dataset'], subPhase: 'B3' },
    { id: 'queries', label: 'Queries', kinds: ['query'], subPhase: 'B3' },
    { id: 'analyses', label: 'Analyses', kinds: ['analysis'], subPhase: 'B3' },
    { id: 'charts', label: 'Charts', kinds: ['chart'], subPhase: 'B3' },
    { id: 'dashboards', label: 'Dashboards', kinds: ['dashboard'], subPhase: 'B3' },
    { id: 'reports', label: 'Reports', kinds: ['report'], subPhase: 'B3' },
    { id: 'insights', label: 'Insights', kinds: ['insight'], subPhase: 'B3' },
    { id: 'published', label: 'Published', kinds: [], subPhase: 'B3' }
  ]
};
