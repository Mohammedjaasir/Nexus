'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

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

function makeTmpDir(prefix = 'e2e-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test('1. Task → Role → Context integration produces complete TaskExecutionPlan', async () => {
  const dir = makeTmpDir('plan-');
  try {
    fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'src', 'calc.ts'), 'export function add(a: number, b: number) { return a + b; }');

    const store = new MockStore();
    const manager = new ProjectManager(store);
    const { project } = await manager.importProject(dir, 'software-engineering', 'CalcProject');

    const plan = await manager.prepareTaskExecutionPlan(
      project.id,
      'Implement multiply function in calc.ts and add test'
    );

    assert.ok(plan);
    assert.equal(plan.projectId, project.id);
    assert.equal(plan.task, 'Implement multiply function in calc.ts and add test');
    assert.ok(plan.routing);
    assert.equal(plan.routing.recommendedRole.roleId, 'sde-engineer');
    assert.ok(plan.contextPackage);
    assert.ok(plan.assembledPrompt.includes('ROLE SPECIFICATION: SOFTWARE ENGINEER'));
    assert.ok(plan.assembledPrompt.includes('TASK INSTRUCTIONS'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('2. Role contextStrategy propagation into execution plan', async () => {
  const dir = makeTmpDir('strat-');
  try {
    fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'src', 'auth.ts'), 'export function login() {}');

    const store = new MockStore();
    const manager = new ProjectManager(store);
    const { project } = await manager.importProject(dir, 'cybersecurity', 'SecProject');

    const plan = await manager.prepareTaskExecutionPlan(
      project.id,
      'Scan codebase for hardcoded credentials and auth leaks'
    );

    assert.equal(plan.routing.recommendedRole.roleId, 'sec-analyst');
    assert.equal(plan.contextPackage.budgetTokens, 32000);
    assert.ok(plan.verificationRuleIds.includes('rule-sec-audit') || plan.verificationRuleIds.includes('rule-secret-scan'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('3. Model and provider selection / override in execution plan', async () => {
  const dir = makeTmpDir('provider-');
  try {
    fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'src', 'app.ts'), 'export const x = 1;');

    const store = new MockStore();
    const manager = new ProjectManager(store);
    const { project } = await manager.importProject(dir, 'software-engineering', 'ModelApp');

    // Override with Ollama local provider and deepseek model
    const plan = await manager.prepareTaskExecutionPlan(
      project.id,
      'Refactor app.ts constant exports',
      {
        provider: 'ollama',
        model: 'deepseek-r1:14b',
        budgetTokens: 16000
      }
    );

    assert.equal(plan.selectedProvider, 'ollama');
    assert.equal(plan.selectedModel, 'deepseek-r1:14b');
    assert.equal(plan.contextPackage.budgetTokens, 16000);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('4. Project root propagation & 5. Agent receives optimized context without mutation', async () => {
  const dir = makeTmpDir('root-prop-');
  try {
    fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
    const initialContent = 'export function initial() { return "original"; }';
    fs.writeFileSync(path.join(dir, 'src', 'service.ts'), initialContent);

    const store = new MockStore();
    const manager = new ProjectManager(store);
    const { project } = await manager.importProject(dir, 'software-engineering', 'RootApp');

    const plan = await manager.prepareTaskExecutionPlan(
      project.id,
      'Enhance service.ts function'
    );

    // Verify context was assembled without mutating original file on disk
    const onDiskContent = fs.readFileSync(path.join(dir, 'src', 'service.ts'), 'utf8');
    assert.equal(onDiskContent, initialContent);
    assert.ok(plan.contextPackage.items.length > 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('8. Cancellation before execution: Plan remains discarded without state side-effects', async () => {
  const dir = makeTmpDir('cancel-');
  try {
    fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'src', 'index.ts'), 'export const active = false;');

    const store = new MockStore();
    const manager = new ProjectManager(store);
    const { project } = await manager.importProject(dir, 'software-engineering', 'CancelApp');

    const plan = await manager.prepareTaskExecutionPlan(project.id, 'Modify index.ts to true');
    assert.ok(plan);

    // Simulate user cancelling: plan is not executed
    const content = fs.readFileSync(path.join(dir, 'src', 'index.ts'), 'utf8');
    assert.equal(content, 'export const active = false;');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
