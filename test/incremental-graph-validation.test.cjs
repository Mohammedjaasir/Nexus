'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const {
  extractProjectKnowledgeGraph,
  updateProjectKnowledgeGraphIncremental
} = loadTs('src/main/project/projectGraphExtractor.ts');

function createTestRepo() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'md-graph-test-'));
  fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({ name: 'graph-test-pkg', version: '1.0.0' }));
  fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(tmpDir, 'src', 'utils.ts'), 'export function helperA(): string { return "A"; }\n');
  fs.writeFileSync(path.join(tmpDir, 'src', 'index.ts'), 'import { helperA } from "./utils";\nexport function run(): string { return helperA(); }\n');
  fs.mkdirSync(path.join(tmpDir, 'test'), { recursive: true });
  fs.writeFileSync(path.join(tmpDir, 'test', 'index.test.ts'), 'import { run } from "../src/index";\n');

  return tmpDir;
}

test('1. File added: Incremental update adds file node, symbols, and parent contains edge', () => {
  const rootPath = createTestRepo();
  const projectId = 'proj-graph-1';

  // Initial graph
  const initialGraph = extractProjectKnowledgeGraph(projectId, rootPath);
  const initialNodeCount = initialGraph.nodes.length;

  // Add new file
  fs.writeFileSync(path.join(rootPath, 'src', 'math.ts'), 'export function add(a: number, b: number): number { return a + b; }\n');

  const incrementalGraph = updateProjectKnowledgeGraphIncremental(projectId, rootPath, initialGraph, [
    { path: 'src/math.ts', changeType: 'added' }
  ]);

  const fullRebuild = extractProjectKnowledgeGraph(projectId, rootPath);

  assert.ok(incrementalGraph.nodes.length > initialNodeCount);
  assert.ok(incrementalGraph.nodes.some((n) => n.path === 'src/math.ts'));
  assert.ok(incrementalGraph.nodes.some((n) => n.id === 'fn:src/math.ts#add'));

  // Compare incremental vs full rebuild: exact node ids match
  const incNodeIds = new Set(incrementalGraph.nodes.map((n) => n.id));
  const fullNodeIds = new Set(fullRebuild.nodes.map((n) => n.id));
  assert.deepEqual(Array.from(incNodeIds).sort(), Array.from(fullNodeIds).sort());

  fs.rmSync(rootPath, { recursive: true, force: true });
});

test('2. File modified: Incremental update updates symbols without duplicates', () => {
  const rootPath = createTestRepo();
  const projectId = 'proj-graph-2';

  const initialGraph = extractProjectKnowledgeGraph(projectId, rootPath);

  // Modify src/utils.ts: remove helperA, add helperB and helperC
  fs.writeFileSync(
    path.join(rootPath, 'src', 'utils.ts'),
    'export function helperB(): string { return "B"; }\nexport function helperC(): string { return "C"; }\n'
  );

  const incrementalGraph = updateProjectKnowledgeGraphIncremental(projectId, rootPath, initialGraph, [
    { path: 'src/utils.ts', changeType: 'modified' }
  ]);

  const fullRebuild = extractProjectKnowledgeGraph(projectId, rootPath);

  // helperA should be gone; helperB and helperC should exist
  assert.equal(incrementalGraph.nodes.some((n) => n.id === 'fn:src/utils.ts#helperA'), false);
  assert.equal(incrementalGraph.nodes.some((n) => n.id === 'fn:src/utils.ts#helperB'), true);
  assert.equal(incrementalGraph.nodes.some((n) => n.id === 'fn:src/utils.ts#helperC'), true);

  const incNodeIds = new Set(incrementalGraph.nodes.map((n) => n.id));
  const fullNodeIds = new Set(fullRebuild.nodes.map((n) => n.id));
  assert.deepEqual(Array.from(incNodeIds).sort(), Array.from(fullNodeIds).sort());

  fs.rmSync(rootPath, { recursive: true, force: true });
});

test('3. File deleted: Incremental update removes file, child symbols, and all associated edges', () => {
  const rootPath = createTestRepo();
  const projectId = 'proj-graph-3';

  const initialGraph = extractProjectKnowledgeGraph(projectId, rootPath);

  // Delete src/utils.ts
  fs.unlinkSync(path.join(rootPath, 'src', 'utils.ts'));

  const incrementalGraph = updateProjectKnowledgeGraphIncremental(projectId, rootPath, initialGraph, [
    { path: 'src/utils.ts', changeType: 'deleted' }
  ]);

  const fullRebuild = extractProjectKnowledgeGraph(projectId, rootPath);

  assert.equal(incrementalGraph.nodes.some((n) => n.path === 'src/utils.ts'), false);
  assert.equal(incrementalGraph.nodes.some((n) => n.id === 'fn:src/utils.ts#helperA'), false);
  assert.equal(incrementalGraph.edges.some((e) => e.target.includes('src/utils.ts') || e.source.includes('src/utils.ts')), false);

  const incNodeIds = new Set(incrementalGraph.nodes.map((n) => n.id));
  const fullNodeIds = new Set(fullRebuild.nodes.map((n) => n.id));
  assert.deepEqual(Array.from(incNodeIds).sort(), Array.from(fullNodeIds).sort());

  fs.rmSync(rootPath, { recursive: true, force: true });
});

test('4. File renamed: Incremental update migrates node path and cleans up old node', () => {
  const rootPath = createTestRepo();
  const projectId = 'proj-graph-4';

  const initialGraph = extractProjectKnowledgeGraph(projectId, rootPath);

  // Rename src/utils.ts -> src/helpers.ts
  fs.renameSync(path.join(rootPath, 'src', 'utils.ts'), path.join(rootPath, 'src', 'helpers.ts'));

  const incrementalGraph = updateProjectKnowledgeGraphIncremental(projectId, rootPath, initialGraph, [
    { path: 'src/helpers.ts', oldPath: 'src/utils.ts', changeType: 'renamed' }
  ]);

  const fullRebuild = extractProjectKnowledgeGraph(projectId, rootPath);

  assert.equal(incrementalGraph.nodes.some((n) => n.path === 'src/utils.ts'), false);
  assert.equal(incrementalGraph.nodes.some((n) => n.path === 'src/helpers.ts'), true);
  assert.equal(incrementalGraph.nodes.some((n) => n.id === 'fn:src/helpers.ts#helperA'), true);

  const incNodeIds = new Set(incrementalGraph.nodes.map((n) => n.id));
  const fullNodeIds = new Set(fullRebuild.nodes.map((n) => n.id));
  assert.deepEqual(Array.from(incNodeIds).sort(), Array.from(fullNodeIds).sort());

  fs.rmSync(rootPath, { recursive: true, force: true });
});

test('5. Import changed: Incremental update refreshes import dependency edge', () => {
  const rootPath = createTestRepo();
  const projectId = 'proj-graph-5';

  const initialGraph = extractProjectKnowledgeGraph(projectId, rootPath);
  assert.ok(initialGraph.edges.some((e) => e.kind === 'imports' && e.target === 'file:src/utils.ts'));

  // Change import in src/index.ts to import external module
  fs.writeFileSync(path.join(rootPath, 'src', 'index.ts'), 'import axios from "axios";\nexport function run(): void {}\n');

  const incrementalGraph = updateProjectKnowledgeGraphIncremental(projectId, rootPath, initialGraph, [
    { path: 'src/index.ts', changeType: 'modified' }
  ]);

  assert.equal(incrementalGraph.edges.some((e) => e.source === 'file:src/index.ts' && e.target === 'file:src/utils.ts'), false);
  assert.equal(incrementalGraph.edges.some((e) => e.source === 'file:src/index.ts' && e.target === 'mod:axios'), true);

  fs.rmSync(rootPath, { recursive: true, force: true });
});

test('6. Function added/removed: Incremental update precisely modifies AST function nodes', () => {
  const rootPath = createTestRepo();
  const projectId = 'proj-graph-6';

  const initialGraph = extractProjectKnowledgeGraph(projectId, rootPath);

  fs.writeFileSync(
    path.join(rootPath, 'src', 'utils.ts'),
    'export function helperOne(): void {}\nexport function helperTwo(): void {}\n'
  );

  const incrementalGraph = updateProjectKnowledgeGraphIncremental(projectId, rootPath, initialGraph, [
    { path: 'src/utils.ts', changeType: 'modified' }
  ]);

  assert.equal(incrementalGraph.nodes.some((n) => n.id === 'fn:src/utils.ts#helperA'), false);
  assert.equal(incrementalGraph.nodes.some((n) => n.id === 'fn:src/utils.ts#helperOne'), true);
  assert.equal(incrementalGraph.nodes.some((n) => n.id === 'fn:src/utils.ts#helperTwo'), true);

  fs.rmSync(rootPath, { recursive: true, force: true });
});

test('7. Test added/removed: Incremental update tracks test suite and tests edge', () => {
  const rootPath = createTestRepo();
  const projectId = 'proj-graph-7';

  const initialGraph = extractProjectKnowledgeGraph(projectId, rootPath);

  // Add new test file
  fs.writeFileSync(path.join(rootPath, 'test', 'utils.test.ts'), 'import { helperA } from "../src/utils";\n');

  const incrementalGraph = updateProjectKnowledgeGraphIncremental(projectId, rootPath, initialGraph, [
    { path: 'test/utils.test.ts', changeType: 'added' }
  ]);

  assert.ok(incrementalGraph.nodes.some((n) => n.id === 'test:test/utils.test.ts'));
  assert.ok(incrementalGraph.edges.some((e) => e.source === 'test:test/utils.test.ts' && e.target === 'file:src/utils.ts' && e.kind === 'tests'));

  // Delete test file
  fs.unlinkSync(path.join(rootPath, 'test', 'utils.test.ts'));

  const postDeleteGraph = updateProjectKnowledgeGraphIncremental(projectId, rootPath, incrementalGraph, [
    { path: 'test/utils.test.ts', changeType: 'deleted' }
  ]);

  assert.equal(postDeleteGraph.nodes.some((n) => n.id === 'test:test/utils.test.ts'), false);
  assert.equal(postDeleteGraph.edges.some((e) => e.source === 'test:test/utils.test.ts'), false);

  fs.rmSync(rootPath, { recursive: true, force: true });
});
