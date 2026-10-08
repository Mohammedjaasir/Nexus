'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const {
  INITIAL_DOMAINS,
  listDomainDefinitions,
  getDomainDefinition,
  listDomainRoles,
  getDomainRole,
  getRolesForDomain,
  suggestRoleForTask
} = loadTs('src/shared/domain.ts');

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

function makeTmpDir(prefix = 'domain-role-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test('1. Domain Role Registry contains exactly 5 roles for each of the 3 primary domains', () => {
  const domains = listDomainDefinitions();
  assert.ok(domains.length >= 3, `Expected at least 3 domains, got ${domains.length}`);

  const sdeRoles = listDomainRoles('software-engineering');
  assert.equal(sdeRoles.length, 5);
  const sdeRoleIds = sdeRoles.map((r) => r.roleId);
  assert.deepEqual(sdeRoleIds, ['sde-planner', 'sde-engineer', 'sde-debugger', 'sde-tester', 'sde-reviewer']);

  const aimlRoles = listDomainRoles('ai-ml');
  assert.equal(aimlRoles.length, 5);
  const aimlRoleIds = aimlRoles.map((r) => r.roleId);
  assert.deepEqual(aimlRoleIds, ['aiml-engineer', 'aiml-data-scientist', 'aiml-researcher', 'aiml-debugger', 'aiml-evaluator']);

  const secRoles = listDomainRoles('cybersecurity');
  assert.equal(secRoles.length, 5);
  const secRoleIds = secRoles.map((r) => r.roleId);
  assert.deepEqual(secRoleIds, ['sec-analyst', 'sec-coder', 'sec-researcher', 'sec-tester', 'sec-doc']);

  // Total roles in global registry
  const allRoles = listDomainRoles();
  assert.ok(allRoles.length >= 15, `Expected at least 15 roles, got ${allRoles.length}`);
});

test('2. Role Schema data-driven validation', () => {
  const allRoles = listDomainRoles();
  for (const role of allRoles) {
    assert.ok(role.roleId, 'Role must have roleId');
    assert.ok(role.domainId, 'Role must have domainId');
    assert.ok(role.title, 'Role must have title');
    assert.ok(role.description, 'Role must have description');
    assert.ok(!('character' in role), 'Role must not carry a character field');
    assert.ok(role.preferredProvider, 'Role must have preferredProvider');
    assert.ok(Array.isArray(role.recommendedSkills), 'Role must have recommendedSkills array');
    assert.ok(Array.isArray(role.recommendedTools), 'Role must have recommendedTools array');
    assert.ok(Array.isArray(role.capabilities), 'Role must have capabilities array');
    assert.ok(Array.isArray(role.verificationRules), 'Role must have verificationRules array');
    assert.ok(role.contextStrategy, 'Role must have contextStrategy');
    assert.ok(typeof role.contextStrategy.defaultBudgetTokens === 'number');
    assert.ok(Array.isArray(role.contextStrategy.focusTiers));
    assert.ok(typeof role.contextStrategy.prioritizeTests === 'boolean');
    assert.ok(role.contextStrategy.systemPromptPreamble.length > 10);
  }
});

test('3. getDomainRole returns role definition by ID or null', () => {
  const planner = getDomainRole('sde-planner');
  assert.ok(planner);
  assert.equal(planner.title, 'Planner');
  assert.equal(planner.domainId, 'software-engineering');

  const mlEval = getDomainRole('aiml-evaluator');
  assert.ok(mlEval);
  assert.equal(mlEval.title, 'Evaluation Agent');
  assert.equal(mlEval.domainId, 'ai-ml');

  const secDoc = getDomainRole('sec-doc');
  assert.ok(secDoc);
  assert.equal(secDoc.title, 'Documentation Agent');
  assert.equal(secDoc.domainId, 'cybersecurity');

  const nonexistent = getDomainRole('nonexistent-role');
  assert.equal(nonexistent, null);
});

test('4. Project → Available Roles lookup via ProjectManager', async () => {
  const dir = makeTmpDir('proj-roles-');
  try {
    fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'my-sde-app' }));

    const store = new MockStore();
    const manager = new ProjectManager(store);

    const { project } = await manager.importProject(dir, 'software-engineering', 'MySdeApp');
    const roles = manager.getRolesForProject(project.id);

    assert.equal(roles.length, 5);
    assert.equal(roles[0].domainId, 'software-engineering');
    assert.equal(roles[0].roleId, 'sde-planner');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('5. Task → Suggested Role matching heuristic', () => {
  // Software Engineering Suggestions
  const sdePlan = suggestRoleForTask('Break down the requirements into an architecture plan', 'software-engineering');
  assert.equal(sdePlan.roleId, 'sde-planner');

  const sdeDebug = suggestRoleForTask('Fix bug and trace unexpected null pointer error in auth', 'software-engineering');
  assert.equal(sdeDebug.roleId, 'sde-debugger');

  const sdeTest = suggestRoleForTask('Design automated QA unit test suite with 90% coverage', 'software-engineering');
  assert.equal(sdeTest.roleId, 'sde-tester');

  const sdeReview = suggestRoleForTask('Perform code review and lint hygiene audit', 'software-engineering');
  assert.equal(sdeReview.roleId, 'sde-reviewer');

  const sdeEng = suggestRoleForTask('Implement new user profile REST endpoint', 'software-engineering');
  assert.equal(sdeEng.roleId, 'sde-engineer');

  // AI/ML Suggestions
  const mlData = suggestRoleForTask('Perform Exploratory Data Analysis and feature engineering', 'ai-ml');
  assert.equal(mlData.roleId, 'aiml-data-scientist');

  const mlEval = suggestRoleForTask('Evaluate validation loss and F1 benchmark metric thresholds', 'ai-ml');
  assert.equal(mlEval.roleId, 'aiml-evaluator');

  const mlDebug = suggestRoleForTask('Debug gradient divergence and NaN loss during epoch 3', 'ai-ml');
  assert.equal(mlDebug.roleId, 'aiml-debugger');

  const mlResearch = suggestRoleForTask('Review literature paper on transformer attention ablation', 'ai-ml');
  assert.equal(mlResearch.roleId, 'aiml-researcher');

  // Cybersecurity Suggestions
  const secScan = suggestRoleForTask('Scan codebase for hardcoded secrets and OWASP vulnerabilities', 'cybersecurity');
  assert.equal(secScan.roleId, 'sec-analyst');

  const secHarden = suggestRoleForTask('Harden auth token validation and sanitize input handlers', 'cybersecurity');
  assert.equal(secHarden.roleId, 'sec-coder');

  const secFuzz = suggestRoleForTask('Run fuzzing and boundary condition penetration tests', 'cybersecurity');
  assert.equal(secFuzz.roleId, 'sec-tester');

  const secDoc = suggestRoleForTask('Generate compliance report and incident remediation playbook', 'cybersecurity');
  assert.equal(secDoc.roleId, 'sec-doc');
});
