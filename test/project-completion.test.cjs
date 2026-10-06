'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const { TaskRouter } = loadTs('src/main/routing/taskRouter.ts');
const { ContextEngine } = loadTs('src/main/context/contextEngine.ts');
const { TaskExecutionCoordinator } = loadTs('src/main/execution/taskExecutionCoordinator.ts');
const { ProjectPlanner } = loadTs('src/main/plan/projectPlanner.ts');
const { ProjectGapAnalyzer } = loadTs('src/main/plan/projectGapAnalyzer.ts');
const { GoalPlanner } = loadTs('src/main/plan/goalPlanner.ts');
const { ProjectCompletionController } = loadTs('src/main/plan/projectCompletionController.ts');

class MockStore {
  constructor() {
    this.projects = new Map();
    this.nodes = new Map();
    this.edges = new Map();
    this.plans = new Map();
    this.gaps = new Map();
    this.goals = new Map();
  }
  getProject(id) { return this.projects.get(id) || null; }
  saveProject(p) { this.projects.set(p.id, p); }
  listProjects() { return Array.from(this.projects.values()); }
  getActiveProjectId() { return null; }
  setActiveProjectId() {}
  saveProjectGraph(pId, nodes, edges) {
    this.nodes.set(pId, [...nodes]);
    this.edges.set(pId, [...edges]);
  }
  getProjectGraphNodes(pId) { return this.nodes.get(pId) || []; }
  getProjectGraphEdges(pId) { return this.edges.get(pId) || []; }
  getProjectPlan(pId) { return this.plans.get(pId) || null; }
  saveProjectPlan(plan) { this.plans.set(plan.projectId, JSON.parse(JSON.stringify(plan))); }
  deleteProjectPlan(pId) { this.plans.delete(pId); }
  getProjectGapAnalysis(pId) { return this.gaps.get(pId) || null; }
  saveProjectGapAnalysis(res) { this.gaps.set(res.projectId, res); }
  deleteProjectGapAnalysis(pId) { this.gaps.delete(pId); }
  getProjectGoal(pId) { return this.goals.get(pId) || null; }
  saveProjectGoal(goal) { this.goals.set(goal.projectId, goal); }
  deleteProjectGoal(pId) { this.goals.delete(pId); }
}

function createSyntheticProject() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'md-comp-'));
  fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({
    name: 'synthetic-math-lib',
    version: '1.0.0',
    scripts: { test: 'node --test' }
  }));
  fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(tmpDir, 'src', 'index.ts'), 'export function add(a: number, b: number): number { return a + b; }\n');
  fs.mkdirSync(path.join(tmpDir, 'test'), { recursive: true });
  fs.writeFileSync(path.join(tmpDir, 'test', 'index.test.cjs'), `
    const test = require('node:test');
    const assert = require('node:assert/strict');
    test('add works', () => { assert.equal(1 + 2, 3); });
  `);

  const project = {
    id: 'proj-synthetic',
    name: 'synthetic-math-lib',
    rootPath: tmpDir,
    domainId: 'software-engineering',
    projectType: 'library',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    health: { healthScore: 90, hasTests: true, hasDocumentation: true, hasEntryPoints: true, hasGit: true, gitClean: true, dependencyCount: 1 },
    detectedLanguages: [{ language: 'TypeScript', fileCount: 2, extension: 'ts' }],
    frameworks: ['node'],
    dependencies: [],
    entryPoints: ['src/index.ts'],
    importantFiles: ['package.json'],
    testSuites: [{ framework: 'node:test', testFiles: ['test/index.test.cjs'] }],
    documentationFiles: []
  };

  return { tmpDir, project };
}

test('1. Next-ready-task selection picks highest-priority ready task in DAG order', () => {
  const store = new MockStore();
  const contextEngine = new ContextEngine(store);
  const router = new TaskRouter();
  const coordinator = new TaskExecutionCoordinator(store, contextEngine, router);
  const gapAnalyzer = new ProjectGapAnalyzer();
  const goalPlanner = new GoalPlanner();
  const controller = new ProjectCompletionController(store, coordinator, gapAnalyzer, goalPlanner);

  const plan = {
    projectId: 'p1',
    projectName: 'P1',
    domainId: 'software-engineering',
    milestones: [],
    tasks: [
      { taskId: 't1', title: 'Task 1', status: 'pending', priority: 'medium', dependencies: [] },
      { taskId: 't2', title: 'Task 2', status: 'ready', priority: 'low', dependencies: [] },
      { taskId: 't3', title: 'Task 3 (Critical)', status: 'ready', priority: 'critical', dependencies: [] }
    ],
    progress: { totalTasks: 3, completedTasks: 0, readyTasks: 2, blockedTasks: 0, failedTasks: 0, progressPercentage: 0, totalMilestones: 0, completedMilestones: 0 },
    createdAt: Date.now(),
    updatedAt: Date.now()
  };

  const { task } = controller.findNextReadyTask(plan);
  assert.ok(task);
  assert.equal(task.taskId, 't3'); // Critical priority prioritized over low priority
});

test('9. Goal completion contract: Evaluates strictly and 10. Rejects incomplete goals', () => {
  const store = new MockStore();
  const contextEngine = new ContextEngine(store);
  const router = new TaskRouter();
  const coordinator = new TaskExecutionCoordinator(store, contextEngine, router);
  const gapAnalyzer = new ProjectGapAnalyzer();
  const goalPlanner = new GoalPlanner();
  const controller = new ProjectCompletionController(store, coordinator, gapAnalyzer, goalPlanner);

  const { project } = createSyntheticProject();

  const incompleteGoalAnalysis = {
    goal: { goalId: 'g1', projectId: project.id, title: 'Math lib', description: '', domainId: 'software-engineering', requiredCapabilities: [], successCriteria: [], createdAt: 0, updatedAt: 0 },
    evaluatedCapabilities: [
      { capabilityId: 'c1', name: 'Core', description: '', category: 'implementation', required: true, status: 'in_progress', verificationRules: [], relevantDomainRoles: [], relevantGraphPatterns: [] }
    ],
    goalReadinessScore: 50,
    completedCapabilitiesCount: 0,
    inProgressCapabilitiesCount: 1,
    missingCapabilitiesCount: 0,
    blockedCapabilitiesCount: 0,
    analyzedAt: Date.now()
  };

  const plan = {
    projectId: project.id,
    projectName: project.name,
    domainId: project.domainId,
    milestones: [],
    tasks: [{ taskId: 't1', title: 'Task 1', status: 'pending', priority: 'medium', dependencies: [] }],
    progress: { totalTasks: 1, completedTasks: 0, readyTasks: 1, blockedTasks: 0, failedTasks: 0, progressPercentage: 0, totalMilestones: 0, completedMilestones: 0 },
    createdAt: Date.now(),
    updatedAt: Date.now()
  };

  const contract = controller.evaluateCompletionContract(project, incompleteGoalAnalysis, null, plan, true);
  assert.equal(contract.isGoalComplete, false);
  assert.equal(contract.requiredCapabilitiesCompleted, false);
  assert.ok(contract.reasons.some((r) => r.includes('Incomplete capabilities')));
});

test('11. Blocked goal state when task dependencies fail', () => {
  const store = new MockStore();
  const contextEngine = new ContextEngine(store);
  const router = new TaskRouter();
  const coordinator = new TaskExecutionCoordinator(store, contextEngine, router);
  const gapAnalyzer = new ProjectGapAnalyzer();
  const goalPlanner = new GoalPlanner();
  const controller = new ProjectCompletionController(store, coordinator, gapAnalyzer, goalPlanner);

  const plan = {
    projectId: 'p1',
    projectName: 'P1',
    domainId: 'software-engineering',
    milestones: [],
    tasks: [
      { taskId: 't1', title: 'Task 1', status: 'failed', priority: 'high', dependencies: [] },
      { taskId: 't2', title: 'Task 2', status: 'blocked', priority: 'medium', dependencies: ['t1'] }
    ],
    progress: { totalTasks: 2, completedTasks: 0, readyTasks: 0, blockedTasks: 1, failedTasks: 1, progressPercentage: 0, totalMilestones: 0, completedMilestones: 0 },
    createdAt: Date.now(),
    updatedAt: Date.now()
  };

  const state = controller.determineProjectState(
    { requiredCapabilitiesCompleted: false, noCriticalGaps: false, noBlockedTasks: false, verificationRulesPassed: false, testsPassed: false, successCriteriaSatisfied: false, isGoalComplete: false, reasons: [] },
    plan
  );
  assert.equal(state, 'blocked');
});

test('12. Needs review state reported correctly after failure threshold exceeded', () => {
  const store = new MockStore();
  const contextEngine = new ContextEngine(store);
  const router = new TaskRouter();
  const coordinator = new TaskExecutionCoordinator(store, contextEngine, router);
  const gapAnalyzer = new ProjectGapAnalyzer();
  const goalPlanner = new GoalPlanner();
  const controller = new ProjectCompletionController(store, coordinator, gapAnalyzer, goalPlanner);

  const plan = {
    projectId: 'p1',
    projectName: 'P1',
    domainId: 'software-engineering',
    milestones: [],
    tasks: [
      { taskId: 't1', title: 'Task 1', status: 'needs_review', priority: 'high', dependencies: [] }
    ],
    progress: { totalTasks: 1, completedTasks: 0, readyTasks: 0, blockedTasks: 0, failedTasks: 0, progressPercentage: 0, totalMilestones: 0, completedMilestones: 0 },
    createdAt: Date.now(),
    updatedAt: Date.now()
  };

  const state = controller.determineProjectState(
    { requiredCapabilitiesCompleted: false, noCriticalGaps: false, noBlockedTasks: true, verificationRulesPassed: true, testsPassed: true, successCriteriaSatisfied: false, isGoalComplete: false, reasons: [] },
    plan
  );
  assert.equal(state, 'needs_review');
});
