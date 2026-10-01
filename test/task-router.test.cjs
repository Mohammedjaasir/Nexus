'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const { TaskRouter } = loadTs('src/main/routing/taskRouter.ts');
const { ProjectManager } = loadTs('src/main/project/projectManager.ts');

class MockStore {
  constructor() {
    this.projects = new Map();
    this.nodes = new Map();
    this.edges = new Map();
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
}

const mockSdeProject = {
  id: 'proj-sde',
  name: 'BackendAPI',
  rootPath: '/fake/path',
  domainId: 'software-engineering',
  projectType: 'application',
  createdAt: Date.now(),
  updatedAt: Date.now(),
  health: { healthScore: 90, hasTests: true, hasDocumentation: true, hasEntryPoints: true, hasGit: true, gitClean: true, dependencyCount: 12 },
  detectedLanguages: [{ language: 'TypeScript', fileCount: 40, extension: 'ts' }],
  detectedFrameworks: ['express', 'node'],
  packageManagers: ['npm'],
  dependencies: [],
  entryPoints: ['src/server.ts'],
  importantFiles: ['package.json'],
  testSuites: [{ framework: 'node:test' }],
  documentationFiles: ['README.md']
};

const mockMlProject = {
  ...mockSdeProject,
  id: 'proj-ml',
  name: 'VisionPipeline',
  domainId: 'ai-ml',
  projectType: 'notebook_pipeline'
};

const mockSecProject = {
  ...mockSdeProject,
  id: 'proj-sec',
  name: 'AuthGateway',
  domainId: 'cybersecurity',
  projectType: 'service'
};

test('1. Obvious SDE task → SDE role with explainable reasons', () => {
  const router = new TaskRouter();

  const planRes = router.routeTask('Plan the migration of user storage to PostgreSQL', mockSdeProject);
  assert.equal(planRes.recommendedRole.roleId, 'sde-planner');
  assert.equal(planRes.recommendedRole.title, 'Planner');
  assert.ok(planRes.reasons.length > 0);

  const engRes = router.routeTask('Implement user authentication REST endpoint in express', mockSdeProject);
  assert.equal(engRes.recommendedRole.roleId, 'sde-engineer');
  assert.equal(engRes.recommendedRole.title, 'Software Engineer');

  const debugRes = router.routeTask('Fix null pointer crash error in session handler', mockSdeProject);
  assert.equal(debugRes.recommendedRole.roleId, 'sde-debugger');
  assert.equal(debugRes.recommendedRole.title, 'Debugger');

  const testRes = router.routeTask('Add automated regression test suite for billing workflow', mockSdeProject);
  assert.equal(testRes.recommendedRole.roleId, 'sde-tester');
  assert.equal(testRes.recommendedRole.title, 'Tester / QA');
});

test('2. ML task → ML Engineer / Data Scientist / Evaluator', () => {
  const router = new TaskRouter();

  const trainRes = router.routeTask('Train PyTorch diffusion model on GPU cluster with mixed precision', mockMlProject);
  assert.equal(trainRes.recommendedRole.roleId, 'aiml-engineer');
  assert.equal(trainRes.recommendedRole.title, 'ML Engineer');

  const edaRes = router.routeTask('Perform Exploratory Data Analysis and clean dataset outliers with pandas', mockMlProject);
  assert.equal(edaRes.recommendedRole.roleId, 'aiml-data-scientist');
  assert.equal(edaRes.recommendedRole.title, 'Data Scientist');

  const evalRes = router.routeTask('Evaluate model drift, benchmark perplexity, and check validation metrics', mockMlProject);
  assert.equal(evalRes.recommendedRole.roleId, 'aiml-evaluator');
  assert.equal(evalRes.recommendedRole.title, 'Evaluation Agent');
});

test('3. Security task → Security role (Analyst / Coder / Pentester)', () => {
  const router = new TaskRouter();

  const scanRes = router.routeTask('Scan codebase for exposed API keys and OWASP vulnerabilities', mockSecProject);
  assert.equal(scanRes.recommendedRole.roleId, 'sec-analyst');
  assert.equal(scanRes.recommendedRole.title, 'Security Analyst');

  const hardenRes = router.routeTask('Harden JWT token signing and sanitize request parameters', mockSecProject);
  assert.equal(hardenRes.recommendedRole.roleId, 'sec-coder');
  assert.equal(hardenRes.recommendedRole.title, 'Secure Coding Agent');

  const fuzzRes = router.routeTask('Run fuzzing penetration test against auth gateway endpoints', mockSecProject);
  assert.equal(fuzzRes.recommendedRole.roleId, 'sec-tester');
  assert.equal(fuzzRes.recommendedRole.title, 'Testing Agent');
});

test('4. Ambiguous task → Ranked alternatives list returned', () => {
  const router = new TaskRouter();
  const res = router.routeTask('Check the system and make updates', mockSdeProject);

  assert.ok(res.recommendedRole);
  assert.ok(res.alternatives.length >= 4);
  // Ensure alternatives are sorted descending by score
  for (let i = 0; i < res.alternatives.length - 1; i++) {
    assert.ok(res.alternatives[i].score >= res.alternatives[i + 1].score);
  }
});

test('5. Secondary domain influence on routing', () => {
  const router = new TaskRouter();
  const dualProject = {
    ...mockSdeProject,
    secondaryDomains: ['cybersecurity']
  };

  const secTask = 'Fix critical JWT secret token exposure vulnerability';
  const res = router.routeTask(secTask, dualProject);

  // Security role from secondary domain wins over generic SDE role due to high signal
  assert.ok(res.recommendedRole.roleId.startsWith('sec-'));
  assert.ok(res.reasons.some((r) => r.includes('Secondary domain')));
});

test('6. Project type influence on scoring', () => {
  const router = new TaskRouter();
  const pipelineProj = {
    ...mockSdeProject,
    domainId: 'ai-ml',
    projectType: 'notebook_pipeline'
  };

  const res = router.routeTask('Inspect data pipeline transformations', pipelineProj);
  assert.ok(res.reasons.some((r) => r.includes('notebook pipeline')));
});

test('7. Routing result contains reasons and explainability', () => {
  const router = new TaskRouter();
  const res = router.routeTask('Fix failing integration test in user billing module', mockSdeProject);

  assert.ok(res.reasons.length >= 2);
  assert.ok(res.score > 0);
  for (const alt of res.alternatives) {
    assert.ok(alt.reasons.length > 0);
  }
});

test('8. Role contextStrategy & preparedConfig are returned', () => {
  const router = new TaskRouter();
  const res = router.routeTask('Design new microservice architecture plan', mockSdeProject);

  assert.ok(res.contextStrategy);
  assert.equal(typeof res.contextStrategy.defaultBudgetTokens, 'number');
  assert.ok(res.contextStrategy.systemPromptPreamble);

  assert.ok(res.preparedConfig);
  assert.equal(res.preparedConfig.roleId, 'sde-planner');
  assert.equal(res.preparedConfig.character, 'michael');
  assert.ok(res.preparedConfig.recommendedTools.includes('Read'));
});

test('9. Deterministic repeatability of task routing', () => {
  const router = new TaskRouter();
  const task = 'Fix SQLite migration indexing error in db.ts';

  const res1 = router.routeTask(task, mockSdeProject);
  const res2 = router.routeTask(task, mockSdeProject);

  assert.equal(res1.recommendedRole.roleId, res2.recommendedRole.roleId);
  assert.equal(res1.score, res2.score);
  assert.deepEqual(res1.reasons, res2.reasons);
  assert.deepEqual(
    res1.alternatives.map((a) => a.role.roleId),
    res2.alternatives.map((a) => a.role.roleId)
  );
});

test('10. Knowledge graph evidence boosts matching roles', () => {
  const router = new TaskRouter();
  const graphNodes = [
    { id: 'file:src/auth/jwt.ts', name: 'jwt.ts', kind: 'file', path: 'src/auth/jwt.ts' },
    { id: 'func:verifyToken', name: 'verifyToken', kind: 'function', path: 'src/auth/jwt.ts' }
  ];

  const res = router.routeTask('Audit authorization token verify function', mockSdeProject, graphNodes);
  assert.ok(res.reasons.some((r) => r.includes('Knowledge graph contains matching components')));
});

test('11. ProjectManager.routeTask bridge integration', () => {
  const store = new MockStore();
  const manager = new ProjectManager(store);
  store.saveProject(mockSdeProject);

  const result = manager.routeTask('proj-sde', 'Refactor database connection pool');
  assert.ok(result);
  assert.equal(result.projectId, 'proj-sde');
  assert.ok(result.recommendedRole);
  assert.ok(['sde-engineer', 'sde-debugger'].includes(result.recommendedRole.roleId));
});
