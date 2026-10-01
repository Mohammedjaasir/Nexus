'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const { TaskRouter } = loadTs('src/main/routing/taskRouter.ts');
const { ProjectPlanner } = loadTs('src/main/plan/projectPlanner.ts');
const { ProjectGapAnalyzer } = loadTs('src/main/plan/projectGapAnalyzer.ts');
const { ProjectManager } = loadTs('src/main/project/projectManager.ts');

class MockStore {
  constructor() {
    this.projects = new Map();
    this.nodes = new Map();
    this.edges = new Map();
    this.plans = new Map();
    this.gaps = new Map();
  }
  getProject(id) { return this.projects.get(id) || null; }
  saveProject(p) { this.projects.set(p.id, p); }
  listProjects() { return Array.from(this.projects.values()); }
  getActiveProjectId() { return null; }
  setActiveProjectId() {}
  saveProjectGraph(pId, nodes, edges) {
    for (const n of nodes) this.nodes.set(`${pId}:${n.id}`, { ...n, projectId: pId });
    for (const e of edges) this.edges.set(`${pId}:${e.id}`, { ...e, projectId: pId });
  }
  getProjectGraphNodes(pId) { return Array.from(this.nodes.values()).filter((n) => n.projectId === pId); }
  getProjectGraphEdges(pId) { return Array.from(this.edges.values()).filter((e) => e.projectId === pId); }
  getProjectPlan(pId) { return this.plans.get(pId) || null; }
  saveProjectPlan(plan) { this.plans.set(plan.projectId, plan); }
  deleteProjectPlan(pId) { this.plans.delete(pId); }
  getProjectGapAnalysis(pId) { return this.gaps.get(pId) || null; }
  saveProjectGapAnalysis(res) { this.gaps.set(res.projectId, res); }
  deleteProjectGapAnalysis(pId) { this.gaps.delete(pId); }
}

const mockCompleteSdeProject = {
  id: 'proj-sde-complete',
  name: 'CompleteApp',
  rootPath: '/fake/complete',
  domainId: 'software-engineering',
  projectType: 'application',
  createdAt: Date.now(),
  updatedAt: Date.now(),
  health: { healthScore: 95, hasTests: true, hasDocumentation: true, hasEntryPoints: true, hasGit: true, gitClean: true, dependencyCount: 15 },
  detectedLanguages: [{ language: 'TypeScript', fileCount: 50, extension: 'ts' }],
  frameworks: ['express', 'node'],
  packageManagers: ['npm'],
  dependencies: [{ name: 'express', version: '4.18.2' }],
  entryPoints: ['src/server.ts', 'src/index.ts'],
  importantFiles: ['package.json', 'tsconfig.json'],
  testSuites: [{ framework: 'node:test', testFiles: ['test/server.test.ts'] }],
  documentationFiles: ['README.md', 'ARCHITECTURE.md']
};

const mockIncompleteMlProject = {
  id: 'proj-ml-incomplete',
  name: 'RawMlProject',
  rootPath: '/fake/raw-ml',
  domainId: 'ai-ml',
  projectType: 'notebook_pipeline',
  createdAt: Date.now(),
  updatedAt: Date.now(),
  health: { healthScore: 40, hasTests: false, hasDocumentation: false, hasEntryPoints: true, hasGit: true, gitClean: false, dependencyCount: 3 },
  detectedLanguages: [{ language: 'Python', fileCount: 8, extension: 'py' }],
  frameworks: ['torch'],
  packageManagers: ['pip'],
  dependencies: [{ name: 'torch', version: '2.0.1' }],
  entryPoints: ['pipeline.py'],
  importantFiles: ['requirements.txt'],
  testSuites: [],
  documentationFiles: []
};

const mockGraphNodesComplete = [
  { id: 'f1', projectId: 'proj-sde-complete', kind: 'file', name: 'server.ts', path: 'src/server.ts' },
  { id: 'fn1', projectId: 'proj-sde-complete', kind: 'function', name: 'createApp', path: 'src/server.ts' },
  { id: 'fn2', projectId: 'proj-sde-complete', kind: 'function', name: 'startServer', path: 'src/server.ts' },
  { id: 'fn3', projectId: 'proj-sde-complete', kind: 'function', name: 'authHandler', path: 'src/auth.ts' },
  { id: 'fn4', projectId: 'proj-sde-complete', kind: 'function', name: 'dbConnect', path: 'src/db.ts' },
  { id: 'fn5', projectId: 'proj-sde-complete', kind: 'function', name: 'routeUsers', path: 'src/routes.ts' },
  { id: 't1', projectId: 'proj-sde-complete', kind: 'test_suite', name: 'server.test.ts', path: 'test/server.test.ts' }
];

test('1. Completed capability detection: Verified architecture, implementation & tests', () => {
  const analyzer = new ProjectGapAnalyzer();
  const res = analyzer.analyzeGaps(mockCompleteSdeProject, mockGraphNodesComplete);

  assert.equal(res.projectId, 'proj-sde-complete');
  assert.ok(res.gaps.length >= 4);

  const archGap = res.gaps.find((g) => g.category === 'architecture');
  assert.equal(archGap.status, 'completed');
  assert.ok(archGap.confidence >= 0.9);

  const implGap = res.gaps.find((g) => g.category === 'implementation');
  assert.equal(implGap.status, 'completed');

  const testGap = res.gaps.find((g) => g.category === 'testing');
  assert.equal(testGap.status, 'completed');

  const docGap = res.gaps.find((g) => g.category === 'documentation');
  assert.equal(docGap.status, 'completed');
});

test('2. Missing capability detection: Detects missing tests and documentation in raw project', () => {
  const analyzer = new ProjectGapAnalyzer();
  const res = analyzer.analyzeGaps(mockIncompleteMlProject, []);

  assert.equal(res.projectId, 'proj-ml-incomplete');

  const testGap = res.gaps.find((g) => g.category === 'testing');
  assert.equal(testGap.status, 'missing');
  assert.ok(testGap.isCritical);

  const docGap = res.gaps.find((g) => g.category === 'documentation');
  assert.equal(docGap.status, 'missing');
  assert.equal(docGap.isCritical, false);
});

test('3. In-progress detection: Partial implementation in graph mapped to in_progress', () => {
  const analyzer = new ProjectGapAnalyzer();
  const partialNodes = [
    { id: 'fn1', projectId: 'proj-ml-incomplete', kind: 'function', name: 'train_step', path: 'train.py' }
  ];

  const res = analyzer.analyzeGaps(mockIncompleteMlProject, partialNodes);
  const implGap = res.gaps.find((g) => g.category === 'implementation');
  assert.equal(implGap.status, 'in_progress');
});

test('4. Duplicate-task prevention during plan reconciliation', () => {
  const router = new TaskRouter();
  const planner = new ProjectPlanner(router);
  const analyzer = new ProjectGapAnalyzer();

  const plan = planner.generateInitialPlan(mockIncompleteMlProject);
  const initialTaskCount = plan.tasks.length;

  const gapsResult = analyzer.analyzeGaps(mockIncompleteMlProject, [], [], plan);
  const reconciled1 = analyzer.reconcilePlan(plan, gapsResult);
  const reconciled2 = analyzer.reconcilePlan(reconciled1, gapsResult);

  // Subsequent reconciliation passes do not duplicate tasks
  assert.equal(reconciled1.tasks.length, reconciled2.tasks.length);
  const titles = reconciled2.tasks.map((t) => t.title);
  const uniqueTitles = new Set(titles);
  assert.equal(titles.length, uniqueTitles.size);
});

test('5. Blocked-gap detection and propagation to dependent tasks', () => {
  const router = new TaskRouter();
  const planner = new ProjectPlanner(router);
  const analyzer = new ProjectGapAnalyzer();

  const plan = planner.generateInitialPlan(mockCompleteSdeProject);
  // Simulate task 1 failing
  plan.tasks[0].status = 'failed';
  ProjectPlanner.recomputePlanStatuses(plan.milestones, plan.tasks);

  const gapsResult = analyzer.analyzeGaps(mockCompleteSdeProject, mockGraphNodesComplete, [], plan);
  // Mark testing gap as blocked
  const testGap = gapsResult.gaps.find((g) => g.category === 'testing');
  testGap.status = 'blocked';

  const reconciled = analyzer.reconcilePlan(plan, gapsResult);
  assert.ok(reconciled.tasks.some((t) => t.status === 'blocked'));
});

test('6. Evidence collection contains concrete provenance reasons', () => {
  const analyzer = new ProjectGapAnalyzer();
  const res = analyzer.analyzeGaps(mockCompleteSdeProject, mockGraphNodesComplete);

  for (const gap of res.gaps) {
    assert.ok(gap.evidence.length > 0);
    for (const ev of gap.evidence) {
      assert.equal(typeof ev, 'string');
      assert.ok(ev.length > 5);
    }
  }
});

test('7. Plan reconciliation preserves user completed tasks and updates progress', () => {
  const router = new TaskRouter();
  const planner = new ProjectPlanner(router);
  const analyzer = new ProjectGapAnalyzer();

  const plan = planner.generateInitialPlan(mockCompleteSdeProject);
  // User manually completed task 2
  plan.tasks[1].status = 'completed';

  const gapsResult = analyzer.analyzeGaps(mockCompleteSdeProject, mockGraphNodesComplete, [], plan);
  const reconciled = analyzer.reconcilePlan(plan, gapsResult);

  // Task 2 status is preserved as completed
  assert.equal(reconciled.tasks[1].status, 'completed');
  assert.ok(reconciled.progress.completedTasks >= 1);
});

test('8. Completion confidence calculation adheres to evidence-based breakdown', () => {
  const analyzer = new ProjectGapAnalyzer();

  const completeRes = analyzer.analyzeGaps(mockCompleteSdeProject, mockGraphNodesComplete);
  assert.ok(completeRes.completionConfidence >= 75);
  assert.ok(completeRes.confidenceBreakdown.testEvidenceScore > 0);

  const incompleteRes = analyzer.analyzeGaps(mockIncompleteMlProject, []);
  assert.ok(incompleteRes.completionConfidence < 50);
  assert.ok(incompleteRes.confidenceBreakdown.criticalGapsPenalty > 0);
});

test('9. Deterministic repeatability of gap analysis and plan reconciliation', () => {
  const router = new TaskRouter();
  const planner = new ProjectPlanner(router);
  const analyzer = new ProjectGapAnalyzer();

  const plan = planner.generateInitialPlan(mockCompleteSdeProject);
  const res1 = analyzer.analyzeGaps(mockCompleteSdeProject, mockGraphNodesComplete, [], plan);
  const res2 = analyzer.analyzeGaps(mockCompleteSdeProject, mockGraphNodesComplete, [], plan);

  assert.equal(res1.completionConfidence, res2.completionConfidence);
  assert.equal(res1.gaps.length, res2.gaps.length);
  for (let i = 0; i < res1.gaps.length; i++) {
    assert.equal(res1.gaps[i].title, res2.gaps[i].title);
    assert.equal(res1.gaps[i].status, res2.gaps[i].status);
    assert.equal(res1.gaps[i].confidence, res2.gaps[i].confidence);
  }
});

test('10. ProjectManager gap analysis and reconciliation integration', async () => {
  const store = new MockStore();
  const manager = new ProjectManager(store);
  store.saveProject(mockCompleteSdeProject);

  const gapAnalysis = manager.analyzeProjectGaps('proj-sde-complete');
  assert.ok(gapAnalysis);
  assert.equal(gapAnalysis.projectId, 'proj-sde-complete');
  assert.ok(gapAnalysis.gaps.length >= 4);

  const reconciliation = manager.reconcileProjectPlan('proj-sde-complete');
  assert.ok(reconciliation);
  assert.ok(reconciliation.plan);
  assert.ok(reconciliation.gaps);
  assert.ok(reconciliation.plan.tasks.length > 0);
});
