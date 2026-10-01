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
  getProject(id) {
    return this.projects.get(id) || null;
  }
  saveProject(p) {
    this.projects.set(p.id, p);
  }
  saveProjectGraph(projectId, nodes, edges) {
    for (const n of nodes) this.nodes.set(`${projectId}:${n.id}`, { ...n, projectId });
    for (const e of edges) this.edges.set(`${projectId}:${e.id}`, { ...e, projectId });
  }
  getProjectGraphNodes(projectId) {
    return Array.from(this.nodes.values()).filter((n) => n.projectId === projectId);
  }
  getProjectGraphEdges(projectId) {
    return Array.from(this.edges.values()).filter((e) => e.projectId === projectId);
  }
}

const { ContextEngine } = loadTs('src/main/context/contextEngine.ts');
const { estimateTokens } = loadTs('src/main/context/tokenEstimator.ts');
const { extractProjectKnowledgeGraph } = loadTs('src/main/project/projectGraphExtractor.ts');

function makeTmpDir(prefix = 'ctx-engine-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test('1. Direct target selection & 8. Provenance reason', async () => {
  const dir = makeTmpDir('ctx-direct-');
  try {
    fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'src', 'auth.ts'),
      'export function authenticateUser(token: string) { return !!token; }'
    );
    fs.writeFileSync(
      path.join(dir, 'src', 'utils.ts'),
      'export function formatString(s: string) { return s.trim(); }'
    );

    const store = new MockStore();
    store.saveProject({ id: 'p1', name: 'AuthProject', rootPath: dir, domainId: 'cybersecurity' });
    const graph = extractProjectKnowledgeGraph('p1', dir);
    store.saveProjectGraph('p1', graph.nodes, graph.edges);

    const engine = new ContextEngine(store);
    const ctx = await engine.assembleContext('p1', 'Fix the authenticateUser token validation bug');

    assert.ok(ctx.selectedFiles.includes('src/auth.ts'));
    const authItem = ctx.items.find((i) => i.path === 'src/auth.ts');
    assert.ok(authItem);
    assert.equal(authItem.reason, 'direct_target');
    assert.ok(authItem.score >= 100);

    const prov = ctx.provenance.find((p) => p.path === 'src/auth.ts');
    assert.ok(prov);
    assert.ok(prov.explanation.includes('directly matched task keywords'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('2. Graph neighbor expansion & 3. Dependency ranking', async () => {
  const dir = makeTmpDir('ctx-expansion-');
  try {
    fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'src', 'server.ts'),
      [
        'import { DatabaseClient } from "./db";',
        'export function startServer() { const db = new DatabaseClient(); db.connect(); }'
      ].join('\n')
    );
    fs.writeFileSync(
      path.join(dir, 'src', 'db.ts'),
      'export class DatabaseClient { connect() {} }'
    );
    fs.writeFileSync(
      path.join(dir, 'src', 'unrelated.ts'),
      'export function unrelatedWork() {}'
    );

    const store = new MockStore();
    store.saveProject({ id: 'p2', name: 'ServerApp', rootPath: dir, domainId: 'software-engineering' });
    const graph = extractProjectKnowledgeGraph('p2', dir);
    store.saveProjectGraph('p2', graph.nodes, graph.edges);

    const engine = new ContextEngine(store);
    const ctx = await engine.assembleContext('p2', 'Update startServer startup sequence');

    assert.ok(ctx.selectedFiles.includes('src/server.ts'));
    assert.ok(ctx.selectedFiles.includes('src/db.ts'));

    const serverItem = ctx.items.find((i) => i.path === 'src/server.ts');
    const dbItem = ctx.items.find((i) => i.path === 'src/db.ts');

    assert.ok(serverItem);
    assert.ok(dbItem);
    assert.equal(serverItem.reason, 'direct_target');
    assert.equal(dbItem.reason, 'import_dependency');
    assert.ok(serverItem.score > dbItem.score, 'Direct target should rank higher than imported dependency');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('4. Test file inclusion with test_dependency reason', async () => {
  const dir = makeTmpDir('ctx-tests-');
  try {
    fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'test'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'src', 'parser.ts'),
      'export function parseYaml(input: string) { return JSON.parse(input); }'
    );
    fs.writeFileSync(
      path.join(dir, 'test', 'parser.test.ts'),
      [
        'import { parseYaml } from "../src/parser";',
        'describe("parser", () => {',
        '  test("parses correctly", () => {});',
        '});'
      ].join('\n')
    );

    const store = new MockStore();
    store.saveProject({ id: 'p3', name: 'ParserLib', rootPath: dir, domainId: 'software-engineering' });
    const graph = extractProjectKnowledgeGraph('p3', dir);
    store.saveProjectGraph('p3', graph.nodes, graph.edges);

    const engine = new ContextEngine(store);
    const ctx = await engine.assembleContext('p3', 'Fix parseYaml handling of invalid input');

    assert.ok(ctx.selectedFiles.includes('src/parser.ts'));
    assert.ok(ctx.selectedFiles.includes('test/parser.test.ts'));

    const testItem = ctx.items.find((i) => i.path === 'test/parser.test.ts');
    assert.ok(testItem);
    assert.equal(testItem.reason, 'test_dependency');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('5. Context tiering (Tier 1 FULL, Tier 2 SIGNATURE, Tier 3 SUMMARY)', async () => {
  const dir = makeTmpDir('ctx-tiers-');
  try {
    fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'src', 'main.ts'),
      [
        'import { helper } from "./helper";',
        'export function executeTask() { helper(); }'
      ].join('\n')
    );
    fs.writeFileSync(
      path.join(dir, 'src', 'helper.ts'),
      [
        'export interface HelperConfig { debug: boolean; }',
        'export function helper() { return 42; }'
      ].join('\n')
    );

    const store = new MockStore();
    store.saveProject({ id: 'p4', name: 'TierApp', rootPath: dir });
    const graph = extractProjectKnowledgeGraph('p4', dir);
    store.saveProjectGraph('p4', graph.nodes, graph.edges);

    const engine = new ContextEngine(store);
    const ctx = await engine.assembleContext('p4', 'Modify executeTask execution flow');

    const mainItem = ctx.items.find((i) => i.path === 'src/main.ts');
    const helperItem = ctx.items.find((i) => i.path === 'src/helper.ts');

    assert.equal(mainItem.tier, 'tier1_full');
    assert.ok(mainItem.content.includes('FULL FILE'));
    assert.ok(['tier2_signature', 'tier3_summary'].includes(helperItem.tier));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('6. Context budget trimming & warning generation', async () => {
  const dir = makeTmpDir('ctx-budget-');
  try {
    fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
    // Write large file
    const largeContent = 'export function bigFunction() {\n' + '  const x = 1;\n'.repeat(500) + '}\n';
    fs.writeFileSync(path.join(dir, 'src', 'big.ts'), largeContent);

    const store = new MockStore();
    store.saveProject({ id: 'p5', name: 'BigProj', rootPath: dir });
    const graph = extractProjectKnowledgeGraph('p5', dir);
    store.saveProjectGraph('p5', graph.nodes, graph.edges);

    const engine = new ContextEngine(store);
    // Request with very strict token budget (50 tokens)
    const ctx = await engine.assembleContext('p5', 'Refactor bigFunction logic', {
      budgetTokens: 50
    });

    assert.ok(ctx.warnings.length > 0);
    assert.ok(ctx.warnings[0].includes('exceeded budget'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('7. Deterministic repeatability of context output', async () => {
  const dir = makeTmpDir('ctx-repeat-');
  try {
    fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'src', 'model.py'), 'def train_model(): pass');
    fs.writeFileSync(path.join(dir, 'src', 'infer.py'), 'from .model import train_model\ndef predict(): pass');

    const store = new MockStore();
    store.saveProject({ id: 'p6', name: 'PyML', rootPath: dir, domainId: 'ai-ml' });
    const graph = extractProjectKnowledgeGraph('p6', dir);
    store.saveProjectGraph('p6', graph.nodes, graph.edges);

    const engine = new ContextEngine(store);

    const res1 = await engine.assembleContext('p6', 'Fine tune train_model parameter weights');
    const res2 = await engine.assembleContext('p6', 'Fine tune train_model parameter weights');

    assert.equal(res1.estimatedTokens, res2.estimatedTokens);
    assert.equal(res1.reductionPercentage, res2.reductionPercentage);
    assert.deepEqual(res1.selectedFiles, res2.selectedFiles);
    assert.equal(res1.assembledText, res2.assembledText);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('9. Token estimation accuracy', () => {
  const empty = estimateTokens('');
  assert.equal(empty, 0);

  const sample = 'function calculateTotal(price: number, tax: number): number { return price * (1 + tax); }';
  const tokens = estimateTokens(sample);
  assert.ok(tokens >= 15 && tokens <= 35, `Token estimate ${tokens} should be in reasonable range`);
});

test('10. Relevance noise prevention: Unrelated utilities/scripts NOT selected', async () => {
  const dir = makeTmpDir('ctx-noise-');
  try {
    fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'tools'), { recursive: true });

    fs.writeFileSync(path.join(dir, 'src', 'payment.ts'), 'export function processPayment() {}');
    fs.writeFileSync(path.join(dir, 'src', 'db.ts'), 'export class Database {}');
    fs.writeFileSync(path.join(dir, 'tools', 'gen-b99-map.cjs'), 'function generateMap() {}');
    fs.writeFileSync(path.join(dir, 'tools', 'bench.cjs'), 'function benchmark() {}');

    const store = new MockStore();
    store.saveProject({ id: 'p10', name: 'NoiseApp', rootPath: dir });
    const graph = extractProjectKnowledgeGraph('p10', dir);
    store.saveProjectGraph('p10', graph.nodes, graph.edges);

    const engine = new ContextEngine(store);
    const ctx = await engine.assembleContext('p10', 'Fix payment transaction status bug');

    assert.ok(ctx.selectedFiles.includes('src/payment.ts'));
    assert.ok(!ctx.selectedFiles.includes('tools/gen-b99-map.cjs'), 'Unrelated tool script must NOT be selected');
    assert.ok(!ctx.selectedFiles.includes('tools/bench.cjs'), 'Unrelated benchmark script must NOT be selected');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('11. Git recency priority boost', async () => {
  const dir = makeTmpDir('ctx-git-');
  try {
    fs.mkdirSync(path.join(dir, 'src'), { recursive: true });

    fs.writeFileSync(path.join(dir, 'src', 'auth1.ts'), 'export function loginUser() {}');
    fs.writeFileSync(path.join(dir, 'src', 'auth2.ts'), 'export function loginUser() {}');

    const store = new MockStore();
    store.saveProject({
      id: 'p11',
      name: 'GitApp',
      rootPath: dir,
      gitInfo: {
        recentCommits: [
          { message: 'Fix login', modifiedFiles: ['src/auth2.ts'] }
        ]
      }
    });
    const graph = extractProjectKnowledgeGraph('p11', dir);
    store.saveProjectGraph('p11', graph.nodes, graph.edges);

    const engine = new ContextEngine(store);
    const ctx = await engine.assembleContext('p11', 'Fix loginUser validation');

    const item1 = ctx.items.find(i => i.path === 'src/auth1.ts');
    const item2 = ctx.items.find(i => i.path === 'src/auth2.ts');

    assert.ok(item1 && item2);
    assert.ok(item2.score > item1.score, 'Recently modified file should receive score boost');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

