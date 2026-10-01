'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const { TaskRouter } = loadTs('src/main/routing/taskRouter.ts');
const { ProjectPlanner } = loadTs('src/main/plan/projectPlanner.ts');
const { ProjectManager } = loadTs('src/main/project/projectManager.ts');

class MockStore {
  constructor() {
    this.projects = new Map();
    this.nodes = new Map();
    this.edges = new Map();
    this.plans = new Map();
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
}

const mockSdeProject = {
  id: 'proj-sde-plan',
  name: 'EcommerceApp',
  rootPath: '/fake/ecommerce',
  domainId: 'software-engineering',
  projectType: 'application',
  createdAt: Date.now(),
  updatedAt: Date.now(),
  health: { healthScore: 85, hasTests: true, hasDocumentation: true, hasEntryPoints: true, hasGit: true, gitClean: true, dependencyCount: 14 },
  detectedLanguages: [{ language: 'TypeScript', fileCount: 25, extension: 'ts' }],
  detectedFrameworks: ['express', 'react'],
  packageManagers: ['npm'],
  dependencies: [],
  entryPoints: ['src/index.ts'],
  importantFiles: ['package.json'],
  testSuites: [{ framework: 'node:test' }],
  documentationFiles: ['README.md']
};

const mockMlProject = {
  ...mockSdeProject,
  id: 'proj-ml-plan',
  name: 'OcrDiffusionModel',
  domainId: 'ai-ml',
  projectType: 'notebook_pipeline'
};

const mockSecProject = {
  ...mockSdeProject,
  id: 'proj-sec-plan',
  name: 'SecurityGateway',
  domainId: 'cybersecurity',
  projectType: 'service'
};

test('1. Plan creation & 2. Milestone creation for SDE, AI/ML, and Security domains', () => {
  const router = new TaskRouter();
  const planner = new ProjectPlanner(router);

  const sdePlan = planner.generateInitialPlan(mockSdeProject);
  assert.equal(sdePlan.projectId, 'proj-sde-plan');
  assert.equal(sdePlan.domainId, 'software-engineering');
  assert.ok(sdePlan.milestones.length >= 3);
  assert.ok(sdePlan.tasks.length >= 6);

  const mlPlan = planner.generateInitialPlan(mockMlProject);
  assert.equal(mlPlan.domainId, 'ai-ml');
  assert.ok(mlPlan.milestones.some((m) => m.title.includes('Data Ingestion') || m.title.includes('Model Architecture')));

  const secPlan = planner.generateInitialPlan(mockSecProject);
  assert.equal(secPlan.domainId, 'cybersecurity');
  assert.ok(secPlan.milestones.some((m) => m.title.includes('Vulnerability') || m.title.includes('Hardening')));
});

test('3. Task creation contains all required metadata and status fields', () => {
  const router = new TaskRouter();
  const planner = new ProjectPlanner(router);
  const plan = planner.generateInitialPlan(mockSdeProject);

  for (const task of plan.tasks) {
    assert.ok(task.taskId);
    assert.equal(task.projectId, mockSdeProject.id);
    assert.ok(task.milestoneId);
    assert.ok(task.title);
    assert.ok(task.description);
    assert.ok(['pending', 'ready', 'running', 'blocked', 'completed', 'failed', 'needs_review'].includes(task.status));
    assert.ok(['low', 'medium', 'high', 'critical'].includes(task.priority));
    assert.ok(Array.isArray(task.dependencies));
    assert.ok(task.suggestedRoleId);
    assert.ok(Array.isArray(task.verificationRules));
    assert.ok(task.createdAt > 0);
    assert.ok(task.updatedAt > 0);
  }
});

test('4. Task dependencies form an ordered DAG across milestones', () => {
  const router = new TaskRouter();
  const planner = new ProjectPlanner(router);
  const plan = planner.generateInitialPlan(mockSdeProject);

  const taskMap = new Map(plan.tasks.map((t) => [t.taskId, t]));

  // Ensure first task has 0 dependencies, downstream tasks have dependencies
  assert.equal(plan.tasks[0].dependencies.length, 0);
  assert.ok(plan.tasks[1].dependencies.length > 0);
  assert.ok(plan.tasks[1].dependencies.includes(plan.tasks[0].taskId));

  // Verify DAG validity without cycle
  assert.doesNotThrow(() => {
    ProjectPlanner.validateDag(plan.tasks);
  });
});

test('5. Circular dependency rejection in task graph', () => {
  const invalidTasks = [
    { taskId: 't1', title: 'Task 1', dependencies: ['t2'] },
    { taskId: 't2', title: 'Task 2', dependencies: ['t3'] },
    { taskId: 't3', title: 'Task 3', dependencies: ['t1'] }
  ];

  assert.throws(() => {
    ProjectPlanner.validateDag(invalidTasks);
  }, /Circular dependency detected/);
});

test('6. Ready vs blocked tasks dynamic computation', () => {
  const router = new TaskRouter();
  const planner = new ProjectPlanner(router);
  const plan = planner.generateInitialPlan(mockSdeProject);

  // Initially, tasks with 0 dependencies are ready, others are pending
  const readyTasks = plan.tasks.filter((t) => t.status === 'ready');
  const pendingTasks = plan.tasks.filter((t) => t.status === 'pending');
  assert.ok(readyTasks.length >= 1);
  assert.ok(pendingTasks.length >= 1);

  // Complete first task -> second task becomes ready
  const firstTaskId = readyTasks[0].taskId;
  const firstTask = plan.tasks.find((t) => t.taskId === firstTaskId);
  firstTask.status = 'completed';

  ProjectPlanner.recomputePlanStatuses(plan.milestones, plan.tasks);

  const updatedSecondTask = plan.tasks.find((t) => t.dependencies.includes(firstTaskId));
  assert.equal(updatedSecondTask.status, 'ready');

  // If a prerequisite fails -> dependent task becomes blocked
  firstTask.status = 'failed';
  ProjectPlanner.recomputePlanStatuses(plan.milestones, plan.tasks);
  assert.equal(updatedSecondTask.status, 'blocked');
});

test('7. Evidence-based progress metrics calculation', () => {
  const router = new TaskRouter();
  const planner = new ProjectPlanner(router);
  const plan = planner.generateInitialPlan(mockSdeProject);

  assert.equal(plan.progress.completedTasks, 0);
  assert.equal(plan.progress.progressPercentage, 0);

  // Complete half of the tasks
  const halfCount = Math.floor(plan.tasks.length / 2);
  for (let i = 0; i < halfCount; i++) {
    plan.tasks[i].status = 'completed';
  }

  ProjectPlanner.recomputePlanStatuses(plan.milestones, plan.tasks);
  const updatedProgress = ProjectPlanner.computeProgress(plan.milestones, plan.tasks);

  assert.equal(updatedProgress.completedTasks, halfCount);
  assert.ok(updatedProgress.progressPercentage >= 40 && updatedProgress.progressPercentage <= 60);
});

test('8. Project persistence & updates via ProjectManager', async () => {
  const store = new MockStore();
  const manager = new ProjectManager(store);
  store.saveProject(mockSdeProject);

  const plan = manager.getProjectPlan('proj-sde-plan');
  assert.ok(plan);
  assert.equal(plan.projectId, 'proj-sde-plan');

  // Update a task status
  const targetTask = plan.tasks[0];
  const updatedPlan = manager.updateTaskStatus('proj-sde-plan', targetTask.taskId, 'completed');

  assert.ok(updatedPlan);
  assert.equal(updatedPlan.tasks.find((t) => t.taskId === targetTask.taskId).status, 'completed');
  assert.ok(updatedPlan.progress.completedTasks >= 1);

  // Verify reload from store preserves state
  const reloaded = manager.getProjectPlan('proj-sde-plan');
  assert.equal(reloaded.tasks.find((t) => t.taskId === targetTask.taskId).status, 'completed');
});

test('9. Deterministic repeatability of initial plan generation', () => {
  const router = new TaskRouter();
  const planner = new ProjectPlanner(router);

  const plan1 = planner.generateInitialPlan(mockSdeProject);
  const plan2 = planner.generateInitialPlan(mockSdeProject);

  assert.equal(plan1.milestones.length, plan2.milestones.length);
  assert.equal(plan1.tasks.length, plan2.tasks.length);
  for (let i = 0; i < plan1.milestones.length; i++) {
    assert.equal(plan1.milestones[i].title, plan2.milestones[i].title);
  }
  for (let i = 0; i < plan1.tasks.length; i++) {
    assert.equal(plan1.tasks[i].title, plan2.tasks[i].title);
    assert.equal(plan1.tasks[i].suggestedRoleId, plan2.tasks[i].suggestedRoleId);
  }
});

test('10. TaskRouter integration assigns domain-accurate roles', () => {
  const router = new TaskRouter();
  const planner = new ProjectPlanner(router);

  const sdePlan = planner.generateInitialPlan(mockSdeProject);
  for (const t of sdePlan.tasks) {
    assert.ok(t.suggestedRoleId.startsWith('sde-'));
  }

  const mlPlan = planner.generateInitialPlan(mockMlProject);
  for (const t of mlPlan.tasks) {
    assert.ok(t.suggestedRoleId.startsWith('aiml-'));
  }

  const secPlan = planner.generateInitialPlan(mockSecProject);
  for (const t of secPlan.tasks) {
    assert.ok(t.suggestedRoleId.startsWith('sec-'));
  }
});
