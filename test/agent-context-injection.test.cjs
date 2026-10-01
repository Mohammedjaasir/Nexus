'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

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

const { ProjectManager } = loadTs('src/main/project/projectManager.ts');

function makeTmpDir(prefix = 'agent-ctx-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test('1. prepareAgentTaskContext packages enriched prompt with minimum sufficient context', async () => {
  const dir = makeTmpDir('inject-');
  try {
    fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'src', 'ollama.ts'),
      [
        'export interface OllamaConfig { host: string; }',
        'export function resolveOllamaPath(cwd: string) { return cwd.replace(/\\\\/g, "/"); }'
      ].join('\n')
    );
    fs.writeFileSync(
      path.join(dir, 'src', 'fs.ts'),
      'export function safeJoin(...parts: string[]) { return parts.join("/"); }'
    );

    const store = new MockStore();
    const manager = new ProjectManager(store);

    const { project } = await manager.importProject(dir, 'software-engineering', 'OllamaHarness');

    const result = await manager.prepareAgentTaskContext(
      project.id,
      'Fix the Ollama agent workspace/path issue.'
    );

    assert.ok(result);
    assert.equal(result.task, 'Fix the Ollama agent workspace/path issue.');
    assert.ok(result.contextPackage);
    assert.ok(result.enrichedPrompt);

    // Verify Envelope Formatting
    assert.ok(result.enrichedPrompt.includes('# TASK INSTRUCTIONS'));
    assert.ok(result.enrichedPrompt.includes('Fix the Ollama agent workspace/path issue.'));
    assert.ok(result.enrichedPrompt.includes('# PROJECT CONTEXT FOR: OLLAMAHARNESS'));
    assert.ok(result.enrichedPrompt.includes('TIER 1: CORE TARGET FILES (FULL CONTENT)'));
    assert.ok(result.enrichedPrompt.includes('resolveOllamaPath'));

    // Verify Token Budgeting
    assert.ok(result.contextPackage.estimatedTokens <= result.contextPackage.budgetTokens);
    assert.ok(result.contextPackage.selectedFiles.includes('src/ollama.ts'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('2. Enriched prompt preserves model context budget under strict limits', async () => {
  const dir = makeTmpDir('inject-strict-');
  try {
    fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'src', 'app.ts'), 'export function run() { ' + 'console.log("x");\n'.repeat(200) + ' }');

    const store = new MockStore();
    const manager = new ProjectManager(store);
    const { project } = await manager.importProject(dir, 'software-engineering', 'StrictApp');

    const result = await manager.prepareAgentTaskContext(
      project.id,
      'Refactor run logic',
      { budgetTokens: 100 }
    );

    assert.ok(result.contextPackage.estimatedTokens <= 150);
    assert.ok(result.contextPackage.warnings.length > 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
