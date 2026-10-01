'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const { TaskRouter } = loadTs('src/main/routing/taskRouter.ts');
const { ProjectPlanner } = loadTs('src/main/plan/projectPlanner.ts');
const { GoalPlanner } = loadTs('src/main/plan/goalPlanner.ts');
const { ProjectManager } = loadTs('src/main/project/projectManager.ts');

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
  getProjectGoal(pId) { return this.goals.get(pId) || null; }
  saveProjectGoal(goal) { this.goals.set(goal.projectId, goal); }
  deleteProjectGoal(pId) { this.goals.delete(pId); }
}

const mockOcrProject = {
  id: 'proj-ocr-api',
  name: 'OcrPipelineApp',
  rootPath: '/fake/ocr-pipeline',
  domainId: 'ai-ml',
  projectType: 'service',
  createdAt: Date.now(),
  updatedAt: Date.now(),
  health: { healthScore: 70, hasTests: true, hasDocumentation: true, hasEntryPoints: true, hasGit: true, gitClean: true, dependencyCount: 12 },
  detectedLanguages: [{ language: 'Python', fileCount: 20, extension: 'py' }],
  frameworks: ['torch', 'fastapi'],
  dependencies: [{ name: 'torch', version: '2.0.1' }, { name: 'fastapi', version: '0.100.0' }],
  entryPoints: ['app/main.py'],
  importantFiles: ['requirements.txt', 'app/main.py'],
  testSuites: [{ framework: 'pytest', testFiles: ['tests/test_model.py'] }],
  documentationFiles: ['README.md']
};

const mockGraphNodes = [
  { id: 'f1', projectId: 'proj-ocr-api', kind: 'file', name: 'main.py', path: 'app/main.py' },
  { id: 'fn1', projectId: 'proj-ocr-api', kind: 'function', name: 'preprocess_image', path: 'app/prep.py' },
  { id: 'fn2', projectId: 'proj-ocr-api', kind: 'function', name: 'load_dataset', path: 'app/dataset.py' },
  { id: 'fn3', projectId: 'proj-ocr-api', kind: 'function', name: 'forward', path: 'app/model.py' },
  { id: 'fn4', projectId: 'proj-ocr-api', kind: 'function', name: 'predict_ocr', path: 'app/model.py' },
  { id: 'fn5', projectId: 'proj-ocr-api', kind: 'function', name: 'ocr_endpoint', path: 'app/routes.py' },
  { id: 't1', projectId: 'proj-ocr-api', kind: 'test_suite', name: 'test_model.py', path: 'tests/test_model.py' }
];

test('1. Goal creation creates structured ProjectGoal with metadata', () => {
  const goalPlanner = new GoalPlanner();
  const goal = goalPlanner.createProjectGoal('proj-ocr-api', 'Build a production OCR API', 'Production-grade OCR service with FastAPI and PyTorch', 'ai-ml');

  assert.equal(goal.projectId, 'proj-ocr-api');
  assert.equal(goal.title, 'Build a production OCR API');
  assert.equal(goal.domainId, 'ai-ml');
  assert.ok(goal.requiredCapabilities.length >= 5);
  assert.ok(goal.successCriteria.length >= 3);
});

test('2. Capability creation includes verification rules, domain roles, and graph patterns', () => {
  const goalPlanner = new GoalPlanner();
  const { capabilities } = goalPlanner.deriveCapabilitiesForGoal('Build an invoice fraud detection platform', 'ai-ml');

  for (const cap of capabilities) {
    assert.ok(cap.capabilityId);
    assert.ok(cap.name);
    assert.ok(cap.description);
    assert.ok(Array.isArray(cap.verificationRules));
    assert.ok(cap.verificationRules.length > 0);
    assert.ok(Array.isArray(cap.relevantDomainRoles));
    assert.ok(cap.relevantDomainRoles.length > 0);
    assert.ok(Array.isArray(cap.relevantGraphPatterns));
    assert.ok(cap.relevantGraphPatterns.length > 0);
  }
});

test('3. Goal → capability mapping derives domain-appropriate capabilities for SDE, AI/ML, and Security', () => {
  const goalPlanner = new GoalPlanner();

  const aimlCaps = goalPlanner.deriveCapabilitiesForGoal('Build a production OCR API', 'ai-ml');
  assert.ok(aimlCaps.capabilities.some((c) => c.category === 'data_pipeline'));
  assert.ok(aimlCaps.capabilities.some((c) => c.category === 'model'));

  const sdeCaps = goalPlanner.deriveCapabilitiesForGoal('Build an e-commerce backend API', 'software-engineering');
  assert.ok(sdeCaps.capabilities.some((c) => c.category === 'architecture'));
  assert.ok(sdeCaps.capabilities.some((c) => c.category === 'implementation'));

  const secCaps = goalPlanner.deriveCapabilitiesForGoal('Harden API against authentication bypass', 'cybersecurity');
  assert.ok(secCaps.capabilities.some((c) => c.category === 'security'));
});

test('4. Completed capability detection: Matches implementation and tests in knowledge graph', () => {
  const goalPlanner = new GoalPlanner();
  const goal = goalPlanner.createProjectGoal('proj-ocr-api', 'Build a production OCR API', '', 'ai-ml');
  const res = goalPlanner.evaluateGoal(goal, mockOcrProject, mockGraphNodes);

  assert.equal(res.goal.projectId, 'proj-ocr-api');
  assert.ok(res.goalReadinessScore >= 50);

  const prepCap = res.evaluatedCapabilities.find((c) => c.capabilityId === 'cap-aiml-prep');
  assert.equal(prepCap.status, 'completed');
  assert.ok(prepCap.evidence.length > 0);

  const modelCap = res.evaluatedCapabilities.find((c) => c.capabilityId === 'cap-aiml-inference');
  assert.equal(modelCap.status, 'completed');

  const testCap = res.evaluatedCapabilities.find((c) => c.capabilityId === 'cap-aiml-testing');
  assert.equal(testCap.status, 'completed');
});

test('5. Missing capability detection: Correctly identifies missing deployment/monitoring', () => {
  const goalPlanner = new GoalPlanner();
  const goal = goalPlanner.createProjectGoal('proj-ocr-api', 'Build a production OCR API', '', 'ai-ml');
  const res = goalPlanner.evaluateGoal(goal, mockOcrProject, mockGraphNodes);

  const deployCap = res.evaluatedCapabilities.find((c) => c.capabilityId === 'cap-aiml-deployment');
  assert.equal(deployCap.status, 'missing');
  assert.ok(deployCap.evidence.some((e) => e.includes('No graph nodes found')));
});

test('6. Goal-aware task creation: Generates tasks only for missing/incomplete capabilities', () => {
  const router = new TaskRouter();
  const planner = new ProjectPlanner(router);
  const goalPlanner = new GoalPlanner();

  const plan = planner.generateInitialPlan(mockOcrProject);
  const initialTaskCount = plan.tasks.length;

  const goal = goalPlanner.createProjectGoal('proj-ocr-api', 'Build a production OCR API', '', 'ai-ml');
  const evaluation = goalPlanner.evaluateGoal(goal, mockOcrProject, mockGraphNodes, [], plan);

  const reconciledPlan = goalPlanner.reconcileGoalPlan(goal, evaluation.evaluatedCapabilities, plan, mockOcrProject);

  // New tasks generated for missing deployment
  const deployTask = reconciledPlan.tasks.find((t) => t.title.includes('Production Packaging') || t.title.includes('Deployment'));
  assert.ok(deployTask);
  assert.ok(['pending', 'ready'].includes(deployTask.status));
  assert.ok(deployTask.suggestedRoleId);
});

test('7. Duplicate prevention on multiple goal reconciliation passes', () => {
  const router = new TaskRouter();
  const planner = new ProjectPlanner(router);
  const goalPlanner = new GoalPlanner();

  const plan = planner.generateInitialPlan(mockOcrProject);
  const goal = goalPlanner.createProjectGoal('proj-ocr-api', 'Build a production OCR API', '', 'ai-ml');

  const eval1 = goalPlanner.evaluateGoal(goal, mockOcrProject, mockGraphNodes, [], plan);
  const pass1 = goalPlanner.reconcileGoalPlan(goal, eval1.evaluatedCapabilities, plan, mockOcrProject);

  const eval2 = goalPlanner.evaluateGoal(goal, mockOcrProject, mockGraphNodes, [], pass1);
  const pass2 = goalPlanner.reconcileGoalPlan(goal, eval2.evaluatedCapabilities, pass1, mockOcrProject);

  assert.equal(pass1.tasks.length, pass2.tasks.length);
  const titles = pass2.tasks.map((t) => t.title);
  const uniqueTitles = new Set(titles);
  assert.equal(titles.length, uniqueTitles.size);
});

test('8. User-completed task preservation across goal evaluations', () => {
  const router = new TaskRouter();
  const planner = new ProjectPlanner(router);
  const goalPlanner = new GoalPlanner();

  const plan = planner.generateInitialPlan(mockOcrProject);
  plan.tasks[0].status = 'completed';

  const goal = goalPlanner.createProjectGoal('proj-ocr-api', 'Build a production OCR API', '', 'ai-ml');
  const evalResult = goalPlanner.evaluateGoal(goal, mockOcrProject, mockGraphNodes, [], plan);
  const reconciled = goalPlanner.reconcileGoalPlan(goal, evalResult.evaluatedCapabilities, plan, mockOcrProject);

  assert.equal(reconciled.tasks[0].status, 'completed');
  assert.ok(reconciled.progress.completedTasks >= 1);
});

test('9. Deterministic repeatability of goal evaluation and capability scoring', () => {
  const goalPlanner = new GoalPlanner();
  const goal = goalPlanner.createProjectGoal('proj-ocr-api', 'Build a production OCR API', '', 'ai-ml');

  const res1 = goalPlanner.evaluateGoal(goal, mockOcrProject, mockGraphNodes);
  const res2 = goalPlanner.evaluateGoal(goal, mockOcrProject, mockGraphNodes);

  assert.equal(res1.goalReadinessScore, res2.goalReadinessScore);
  assert.equal(res1.evaluatedCapabilities.length, res2.evaluatedCapabilities.length);
  for (let i = 0; i < res1.evaluatedCapabilities.length; i++) {
    assert.equal(res1.evaluatedCapabilities[i].name, res2.evaluatedCapabilities[i].name);
    assert.equal(res1.evaluatedCapabilities[i].status, res2.evaluatedCapabilities[i].status);
    assert.equal(res1.evaluatedCapabilities[i].confidence, res2.evaluatedCapabilities[i].confidence);
  }
});

test('10. ProjectManager E2E goal setting & plan reconciliation', async () => {
  const store = new MockStore();
  const manager = new ProjectManager(store);
  store.saveProject(mockOcrProject);
  for (const n of mockGraphNodes) {
    store.nodes.set(`proj-ocr-api:${n.id}`, { ...n, projectId: 'proj-ocr-api' });
  }

  const goalResult = manager.setProjectGoal('proj-ocr-api', 'Build a production OCR API', 'FastAPI OCR Service');
  assert.ok(goalResult);
  assert.equal(goalResult.goal.title, 'Build a production OCR API');
  assert.ok(goalResult.evaluatedCapabilities.length >= 5);

  const reconciled = manager.reconcileGoalPlan('proj-ocr-api');
  assert.ok(reconciled);
  assert.ok(reconciled.plan.tasks.length > 0);
  assert.ok(reconciled.goalAnalysis);
});
