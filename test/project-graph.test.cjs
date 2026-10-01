'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

class InMemoryGraphStore {
  constructor() {
    this.projects = new Map();
    this.nodes = new Map(); // key: `${projectId}:${id}`
    this.edges = new Map(); // key: `${projectId}:${id}`
    this.activeId = null;
  }
  open() {}
  close() {}
  saveProject(project) {
    this.projects.set(project.id, { ...project, updatedAt: Date.now() });
  }
  getProject(id) {
    return this.projects.get(id) || null;
  }
  listProjects() {
    return Array.from(this.projects.values()).sort((a, b) => b.updatedAt - a.updatedAt);
  }
  updateProject(id, patch) {
    const existing = this.getProject(id);
    if (!existing) return null;
    const updated = { ...existing, ...patch, id, updatedAt: Date.now() };
    this.saveProject(updated);
    return updated;
  }
  deleteProject(id) {
    const existed = this.projects.delete(id);
    this.deleteProjectGraph(id);
    if (this.activeId === id) this.activeId = null;
    return existed;
  }
  getActiveProjectId() {
    return this.activeId;
  }
  setActiveProjectId(id) {
    this.activeId = id;
  }

  saveProjectGraph(projectId, nodes, edges) {
    // Delete existing
    for (const [key] of this.nodes) {
      if (key.startsWith(`${projectId}:`)) this.nodes.delete(key);
    }
    for (const [key] of this.edges) {
      if (key.startsWith(`${projectId}:`)) this.edges.delete(key);
    }
    // Save new
    for (const n of nodes) {
      this.nodes.set(`${projectId}:${n.id}`, { ...n, projectId });
    }
    for (const e of edges) {
      this.edges.set(`${projectId}:${e.id}`, { ...e, projectId });
    }
  }

  getProjectGraphNode(projectId, nodeId) {
    return this.nodes.get(`${projectId}:${nodeId}`) || null;
  }

  getProjectGraphNodes(projectId, filter) {
    let result = Array.from(this.nodes.values()).filter((n) => n.projectId === projectId);
    if (filter?.kind) result = result.filter((n) => n.kind === filter.kind);
    if (filter?.path) result = result.filter((n) => n.path === filter.path);
    if (filter?.name) result = result.filter((n) => n.name.includes(filter.name));
    return result;
  }

  getProjectGraphEdges(projectId, filter) {
    let result = Array.from(this.edges.values()).filter((e) => e.projectId === projectId);
    if (filter?.sourceId) result = result.filter((e) => e.source === filter.sourceId);
    if (filter?.targetId) result = result.filter((e) => e.target === filter.targetId);
    if (filter?.kind) result = result.filter((e) => e.kind === filter.kind);
    return result;
  }

  getProjectGraphNeighbors(projectId, nodeId, direction = 'both') {
    const allEdges = Array.from(this.edges.values()).filter((e) => e.projectId === projectId);
    const matchedEdges = allEdges.filter((e) => {
      if (direction === 'outgoing') return e.source === nodeId;
      if (direction === 'incoming') return e.target === nodeId;
      return e.source === nodeId || e.target === nodeId;
    });

    const neighborIds = new Set();
    for (const e of matchedEdges) {
      if (e.source !== nodeId) neighborIds.add(e.source);
      if (e.target !== nodeId) neighborIds.add(e.target);
    }

    const nodes = Array.from(neighborIds)
      .map((id) => this.getProjectGraphNode(projectId, id))
      .filter(Boolean);

    return { nodes, edges: matchedEdges };
  }

  getProjectSubgraph(projectId, rootNodeId, depth = 1) {
    const maxDepth = Math.max(1, Math.min(5, depth));
    const visited = new Set([rootNodeId]);
    const collectedEdges = new Map();
    let frontier = new Set([rootNodeId]);

    for (let d = 0; d < maxDepth; d++) {
      if (frontier.size === 0) break;
      const nextFrontier = new Set();
      for (const e of Array.from(this.edges.values()).filter((e) => e.projectId === projectId)) {
        if (frontier.has(e.source) || frontier.has(e.target)) {
          collectedEdges.set(e.id, e);
          if (!visited.has(e.source)) {
            visited.add(e.source);
            nextFrontier.add(e.source);
          }
          if (!visited.has(e.target)) {
            visited.add(e.target);
            nextFrontier.add(e.target);
          }
        }
      }
      frontier = nextFrontier;
    }

    const nodes = Array.from(visited)
      .map((id) => this.getProjectGraphNode(projectId, id))
      .filter(Boolean);

    return {
      rootNodeId,
      depth: maxDepth,
      nodes,
      edges: Array.from(collectedEdges.values())
    };
  }

  getProjectGraphStats(projectId) {
    const nodes = Array.from(this.nodes.values()).filter((n) => n.projectId === projectId);
    const edges = Array.from(this.edges.values()).filter((e) => e.projectId === projectId);

    const byKind = {};
    for (const n of nodes) {
      byKind[n.kind] = (byKind[n.kind] || 0) + 1;
    }

    const byRelation = {};
    for (const e of edges) {
      byRelation[e.kind] = (byRelation[e.kind] || 0) + 1;
    }

    return {
      projectId,
      nodeCount: nodes.length,
      edgeCount: edges.length,
      fileCount: byKind['file'] || 0,
      functionCount: byKind['function'] || 0,
      classCount: byKind['class'] || 0,
      testCount: (byKind['test_suite'] || 0) + (byKind['test_case'] || 0),
      docCount: byKind['documentation'] || 0,
      byKind,
      byRelation
    };
  }

  deleteProjectGraph(projectId) {
    for (const [key] of this.nodes) {
      if (key.startsWith(`${projectId}:`)) this.nodes.delete(key);
    }
    for (const [key] of this.edges) {
      if (key.startsWith(`${projectId}:`)) this.edges.delete(key);
    }
  }
}

const { extractProjectKnowledgeGraph } = loadTs('src/main/project/projectGraphExtractor.ts');
const { ProjectManager } = loadTs('src/main/project/projectManager.ts');

function makeTmpDir(prefix = 'proj-graph-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test('1. Graph creation & 4. Function/class/endpoint detection', () => {
  const dir = makeTmpDir('graph-create-');
  try {
    fs.writeFileSync(
      path.join(dir, 'package.json'),
      JSON.stringify({ name: 'test-api', dependencies: { express: '^4.18.2' } })
    );
    fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'src', 'server.ts'),
      [
        'import express from "express";',
        'import { DatabaseClient } from "./db";',
        'const app = express();',
        'export class ApiServer {',
        '  start() {}',
        '}',
        'export function setupRoutes() {',
        '  app.get("/api/users", (req, res) => res.json([]));',
        '  app.post("/api/login", (req, res) => res.json({}));',
        '}'
      ].join('\n')
    );
    fs.writeFileSync(
      path.join(dir, 'src', 'db.ts'),
      'export class DatabaseClient { connect() {} }'
    );
    fs.writeFileSync(path.join(dir, 'README.md'), '# API Docs');

    const graph = extractProjectKnowledgeGraph('proj_123', dir, 'test-api');

    assert.equal(graph.projectId, 'proj_123');
    assert.ok(graph.nodes.length > 5);
    assert.ok(graph.edges.length > 5);

    // Assert Node Types
    const kinds = new Set(graph.nodes.map((n) => n.kind));
    assert.ok(kinds.has('project'));
    assert.ok(kinds.has('folder'));
    assert.ok(kinds.has('file'));
    assert.ok(kinds.has('module'));
    assert.ok(kinds.has('class'));
    assert.ok(kinds.has('function'));
    assert.ok(kinds.has('api_endpoint'));
    assert.ok(kinds.has('documentation'));

    // Assert Specific Identifiers
    assert.ok(graph.nodes.some((n) => n.id === 'class:src/server.ts#ApiServer'));
    assert.ok(graph.nodes.some((n) => n.id === 'class:src/db.ts#DatabaseClient'));
    assert.ok(graph.nodes.some((n) => n.id === 'fn:src/server.ts#setupRoutes'));
    assert.ok(graph.nodes.some((n) => n.id === 'api:GET:/api/users'));
    assert.ok(graph.nodes.some((n) => n.id === 'api:POST:/api/login'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('2. Graph persistence & statistics via ProjectManager', async () => {
  const dir = makeTmpDir('graph-persist-');
  try {
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'persist-proj' }));
    fs.writeFileSync(path.join(dir, 'index.js'), 'export function main() {}');
    fs.writeFileSync(path.join(dir, 'README.md'), '# Title');

    const store = new InMemoryGraphStore();
    const manager = new ProjectManager(store);

    const { project } = await manager.importProject(dir);

    const stats = manager.getGraphStats(project.id);
    assert.ok(stats.nodeCount >= 3);
    assert.ok(stats.edgeCount >= 2);
    assert.equal(stats.fileCount, 2);
    assert.equal(stats.functionCount, 1);
    assert.equal(stats.docCount, 1);

    const nodes = manager.getGraphNodes(project.id);
    assert.equal(nodes.length, stats.nodeCount);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('3. Import relationships & 5. Test relationships', () => {
  const dir = makeTmpDir('graph-rel-');
  try {
    fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'src', 'calculator.ts'),
      'export function add(a: number, b: number) { return a + b; }'
    );
    fs.mkdirSync(path.join(dir, 'test'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'test', 'calculator.test.ts'),
      [
        'import { add } from "../src/calculator";',
        'describe("calculator", () => {',
        '  test("adds numbers", () => {});',
        '});'
      ].join('\n')
    );

    const graph = extractProjectKnowledgeGraph('p1', dir);

    // Import Edge
    const importEdge = graph.edges.find((e) => e.kind === 'imports' && e.source === 'file:test/calculator.test.ts');
    assert.ok(importEdge);
    assert.ok(importEdge.target.includes('calculator'));

    // Test Suite and Test Case nodes
    assert.ok(graph.nodes.some((n) => n.kind === 'test_suite' && n.name === 'calculator'));
    assert.ok(graph.nodes.some((n) => n.kind === 'test_case' && n.name === 'adds numbers'));

    // Tests Edge
    const testsEdge = graph.edges.find((e) => e.kind === 'tests');
    assert.ok(testsEdge);
    assert.equal(testsEdge.source, 'file:test/calculator.test.ts');
    assert.equal(testsEdge.target, 'file:src/calculator.ts');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('6. Subgraph queries and depth traversal', async () => {
  const dir = makeTmpDir('graph-subgraph-');
  try {
    fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'src', 'main.ts'),
      [
        'import { helper } from "./helper";',
        'export function run() { helper(); }'
      ].join('\n')
    );
    fs.writeFileSync(
      path.join(dir, 'src', 'helper.ts'),
      'export function helper() {}'
    );

    const store = new InMemoryGraphStore();
    const manager = new ProjectManager(store);
    const { project } = await manager.importProject(dir);

    // Subgraph from src/main.ts with depth 1
    const sub1 = manager.getGraphSubgraph(project.id, 'file:src/main.ts', 1);
    assert.equal(sub1.rootNodeId, 'file:src/main.ts');
    assert.ok(sub1.nodes.some((n) => n.id === 'fn:src/main.ts#run'));

    // Subgraph from src/main.ts with depth 2 (reaches helper.ts and its functions)
    const sub2 = manager.getGraphSubgraph(project.id, 'file:src/main.ts', 2);
    assert.ok(sub2.nodes.length >= sub1.nodes.length);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('7. Project graph isolation', async () => {
  const dirA = makeTmpDir('projA-');
  const dirB = makeTmpDir('projB-');
  try {
    fs.writeFileSync(path.join(dirA, 'a.ts'), 'export function a() {}');
    fs.writeFileSync(path.join(dirB, 'b.ts'), 'export function b() {}');

    const store = new InMemoryGraphStore();
    const manager = new ProjectManager(store);

    const { project: pA } = await manager.importProject(dirA, 'software-engineering', 'Proj A');
    const { project: pB } = await manager.importProject(dirB, 'software-engineering', 'Proj B');

    const nodesA = manager.getGraphNodes(pA.id);
    const nodesB = manager.getGraphNodes(pB.id);

    assert.ok(nodesA.some((n) => n.id === 'fn:a.ts#a'));
    assert.ok(!nodesA.some((n) => n.id === 'fn:b.ts#b'));

    assert.ok(nodesB.some((n) => n.id === 'fn:b.ts#b'));
    assert.ok(!nodesB.some((n) => n.id === 'fn:a.ts#a'));
  } finally {
    fs.rmSync(dirA, { recursive: true, force: true });
    fs.rmSync(dirB, { recursive: true, force: true });
  }
});

test('8. Deterministic repeatability', () => {
  const dir = makeTmpDir('graph-repeat-');
  try {
    fs.writeFileSync(
      path.join(dir, 'requirements.txt'),
      ['torch', 'fastapi'].join('\n')
    );
    fs.writeFileSync(
      path.join(dir, 'main.py'),
      [
        'from fastapi import FastAPI',
        'app = FastAPI()',
        'class ModelService:',
        '  pass',
        '@app.get("/predict")',
        'def predict():',
        '  return {}'
      ].join('\n')
    );

    const run1 = extractProjectKnowledgeGraph('proj_rep', dir);
    const run2 = extractProjectKnowledgeGraph('proj_rep', dir);

    assert.equal(run1.nodes.length, run2.nodes.length);
    assert.equal(run1.edges.length, run2.edges.length);

    const nodeIds1 = run1.nodes.map((n) => n.id).sort();
    const nodeIds2 = run2.nodes.map((n) => n.id).sort();
    assert.deepEqual(nodeIds1, nodeIds2);

    const edgeIds1 = run1.edges.map((e) => e.id).sort();
    const edgeIds2 = run2.edges.map((e) => e.id).sort();
    assert.deepEqual(edgeIds1, edgeIds2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
