// QA/Test Engineer. The lifecycle is shown in B2a; nothing in it runs yet.
// Every step arrives in B2c. Sending and accepting handoffs (B1) already work
// through the platform, outside this lifecycle.

import type { DomainSpec, LifecycleStep, PrerequisiteId, StepDoneWhen } from '../domainSpec';

const later = (id: string, label: string, consumes: string[], produces: string[], doneWhen: StepDoneWhen,
  prerequisites: PrerequisiteId[] = []): LifecycleStep =>
  ({ id, label, consumes, produces, via: [], doneWhen, status: 'FUTURE', subPhase: 'B2c', prerequisites,
    scopeNote: 'QA workflows arrive in B2c.' });
const kind = (k: string): StepDoneWhen => ({ kind: k, statuses: ['candidate', 'active'], validators: [] });
const RUNS: PrerequisiteId[] = ['docker', 'image:qa-web'];

export const QA: DomainSpec = {
  specVersion: 3,
  id: 'qa', label: 'QA/Test Engineer', shortLabel: 'QA',
  description: 'Decide, with computed evidence, whether a specific build is fit to release.',
  tier: 'first-class', hueSlot: 5, icon: 'qa', order: 6,
  participationFromSubPhase: 'B1',
  statusNote: 'The QA lifecycle is shown so you can see what is coming; none of its steps runs in this release. QA workflows arrive in B2c.',
  legacyDomainIds: [],
  vocabulary: {
    handoff_receipt: { singular: 'Intake', plural: 'Intakes' },
    test_plan: { singular: 'Test plan', plural: 'Test plans' },
    test_case: { singular: 'Test case', plural: 'Test cases' },
    test_suite: { singular: 'Test suite', plural: 'Test suites' },
    test_run: { singular: 'Test run', plural: 'Test runs' },
    defect: { singular: 'Defect', plural: 'Defects' },
    regression_report: { singular: 'Regression report', plural: 'Regression reports' },
    quality_report: { singular: 'Quality report', plural: 'Quality reports' },
    release_recommendation: { singular: 'Release decision', plural: 'Release decisions' }
  },
  kindsProduced: ['handoff_receipt', 'test_plan', 'test_case', 'test_suite', 'test_run', 'defect', 'regression_report',
    'quality_report', 'release_recommendation'],
  kindsAccepted: ['application', 'build', 'requirement', 'test_suite', 'diagnostic_report', 'inference_service'],
  capabilities: [
    { id: 'code.read' }, { id: 'code.edit', scope: { paths: ['tests/**', 'e2e/**'] } }, { id: 'git.commit' }, { id: 'sandbox.exec' },
    { id: 'artifact.read' }, { id: 'artifact.register' }, { id: 'job.request' }, { id: 'handoff.create' }, { id: 'review.request' },
    { id: 'test.run' }, { id: 'test.author' }, { id: 'defect.propose' }, { id: 'preview.request' }
  ],
  recipes: [], skills: [], actions: [],
  lifecycle: [
    later('intake', 'Application and build intake', ['application', 'build'], ['handoff_receipt'], kind('handoff_receipt')),
    later('test-plan', 'Test plan', ['application', 'requirement'], ['test_plan'], kind('test_plan')),
    later('strategy', 'Strategy', ['test_plan'], ['test_plan'], kind('test_plan')),
    later('test-cases', 'Test cases', ['requirement', 'test_plan'], ['test_case'], kind('test_case')),
    later('execution', 'Execution', ['application', 'test_case'], ['test_run'], kind('test_run'), RUNS),
    later('automation', 'Automation', ['test_case'], ['test_suite'], kind('test_suite'),
      [...RUNS, 'runtime:agent', 'credential:agent']),
    later('defect', 'Defect', ['test_run'], ['defect'], kind('defect')),
    later('retest', 'Retest', ['defect', 'application'], ['test_run'], kind('test_run'), RUNS),
    later('regression', 'Regression', ['test_run'], ['test_run', 'regression_report'], kind('regression_report'), RUNS),
    later('quality-report', 'Quality report', ['test_run', 'defect'], ['quality_report'], kind('quality_report')),
    later('release-recommendation', 'Release recommendation', ['quality_report'], ['release_recommendation'], { record: 'signature' })
  ],
  handoffRoutes: [
    { to: 'sde', kinds: ['defect', 'test_run'], action: 'fix', subPhase: 'B2c' },
    { to: 'sde', kinds: ['release_recommendation', 'quality_report'], action: 'release-gate', subPhase: 'B2c' }
  ],
  completionRules: [{ id: 'qa.end-to-end', label: 'End-to-end flow',
    steps: ['intake', 'test-plan', 'strategy', 'test-cases', 'execution', 'automation', 'defect', 'retest', 'regression',
      'quality-report', 'release-recommendation'], subPhase: 'B2c' }],
  modules: [
    { id: 'inbox', label: 'Inbox', kinds: ['handoff_receipt'], subPhase: 'B2c' },
    { id: 'test-plans', label: 'Test plans', kinds: ['test_plan'], subPhase: 'B2c' },
    { id: 'cases', label: 'Cases', kinds: ['test_case'], subPhase: 'B2c' },
    { id: 'test-suites', label: 'Test suites', kinds: ['test_suite'], subPhase: 'B2c' },
    { id: 'runs', label: 'Runs', kinds: ['test_run'], subPhase: 'B2c' },
    { id: 'defects', label: 'Defects', kinds: ['defect'], subPhase: 'B2c' },
    { id: 'regression', label: 'Regression', kinds: ['regression_report'], subPhase: 'B2c' },
    { id: 'quality-reports', label: 'Quality reports', kinds: ['quality_report'], subPhase: 'B2c' },
    { id: 'release-decisions', label: 'Release decisions', kinds: ['release_recommendation'], subPhase: 'B2c' }
  ]
};
