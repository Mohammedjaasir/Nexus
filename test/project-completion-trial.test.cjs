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
    this.plans = new Map();
    this.gaps = new Map();
    this.goals = new Map();
    this.activeId = null;
  }
  getProject(id) { return this.projects.get(id) || null; }
  saveProject(p) { this.projects.set(p.id, p); }
  listProjects() { return Array.from(this.projects.values()); }
  getActiveProjectId() { return this.activeId; }
  setActiveProjectId(id) { this.activeId = id; }
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

function setupDisposableProject() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'md-trial-repo-'));

  fs.writeFileSync(
    path.join(tmpDir, 'package.json'),
    JSON.stringify(
      {
        name: 'ts-math-utility',
        version: '0.1.0',
        scripts: {
          test: 'node --test',
          build: 'node -e "console.log(\'Build clean\')"'
        }
      },
      null,
      2
    )
  );

  fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
  fs.writeFileSync(
    path.join(tmpDir, 'src', 'index.ts'),
    'export function add(a: number, b: number): number {\n  return a + b;\n}\n'
  );

  fs.mkdirSync(path.join(tmpDir, 'test'), { recursive: true });
  fs.writeFileSync(
    path.join(tmpDir, 'test', 'index.test.cjs'),
    `const test = require('node:test');
const assert = require('node:assert/strict');
test('add function adds two numbers', () => {
  assert.equal(1 + 2, 3);
});
`
  );

  return tmpDir;
}

test('Real Project Controlled Completion Trial: End-to-end goal execution on physical workspace', async () => {
  const repoPath = setupDisposableProject();
  const store = new MockStore();
  const manager = new ProjectManager(store);

  // 1. Import Project
  const { project } = await manager.importProject(repoPath, 'software-engineering', 'ts-math-utility');
  assert.ok(project);
  assert.equal(project.domainId, 'software-engineering');
  assert.ok(project.health.hasTests);

  // 2. Set Goal
  const goalTitle = 'Build a small TypeScript utility library with one exported function, tests, and a passing build';
  const goalAnalysis = manager.setProjectGoal(project.id, goalTitle);
  assert.ok(goalAnalysis);
  assert.ok(goalAnalysis.goal.requiredCapabilities.length >= 4);

  // 3. Initial Plan
  const plan = manager.getProjectPlan(project.id);
  assert.ok(plan);
  assert.ok(plan.tasks.length >= 2);

  // 4. Step 1: Execute next ready task (create src/math.ts)
  const next1 = await manager.getNextProjectTask(project.id);
  assert.ok(next1);
  assert.ok(next1.task);
  assert.equal(next1.task.status, 'ready');

  const step1 = await manager.executeProjectStep(
    project.id,
    async () => {
      const mathPath = path.join(repoPath, 'src', 'math.ts');
      fs.writeFileSync(
        mathPath,
        'export function multiply(a: number, b: number): number {\n  return a * b;\n}\n'
      );
      return ['src/math.ts'];
    },
    'node --test test/index.test.cjs'
  );

  assert.ok(step1);
  assert.equal(step1.executionResult.verification.status, 'success');
  assert.ok(fs.existsSync(path.join(repoPath, 'src', 'math.ts')));

  // Verify graph reflects physical changes
  const graphNodesAfterStep1 = store.getProjectGraphNodes(project.id);
  assert.ok(graphNodesAfterStep1.some((n) => n.path === 'src/math.ts'));
  assert.ok(graphNodesAfterStep1.some((n) => n.id === 'fn:src/math.ts#multiply'));

  // 5. Step 2: Execute next ready task (add test file test/math.test.cjs)
  const next2 = await manager.getNextProjectTask(project.id);
  assert.ok(next2);

  const step2 = await manager.executeProjectStep(
    project.id,
    async () => {
      const testPath = path.join(repoPath, 'test', 'math.test.cjs');
      fs.writeFileSync(
        testPath,
        `const test = require('node:test');
const assert = require('node:assert/strict');
test('multiply function', () => {
  assert.equal(2 * 3, 6);
});
`
      );
      return ['test/math.test.cjs'];
    },
    'node --test test/index.test.cjs test/math.test.cjs'
  );

  assert.ok(step2);
  assert.equal(step2.executionResult.verification.status, 'success');
  assert.ok(fs.existsSync(path.join(repoPath, 'test', 'math.test.cjs')));

  // 6. Step 3: Run build validation task
  const next3 = await manager.getNextProjectTask(project.id);
  if (next3 && next3.task && !next3.contract.isGoalComplete) {
    const step3 = await manager.executeProjectStep(
      project.id,
      async () => [],
      'node -e "console.log(\'Build verified\')"'
    );
    assert.ok(step3);
    assert.equal(step3.executionResult.verification.status, 'success');
  }

  // 7. Verify Completion Contract Audit
  const contract = manager.evaluateProjectCompletionContract(project.id);
  assert.ok(contract);
  assert.equal(contract.noBlockedTasks, true);
  assert.equal(contract.verificationRulesPassed, true);
  assert.equal(contract.testsPassed, true);

  // Clean up disposable repo
  fs.rmSync(repoPath, { recursive: true, force: true });
});
