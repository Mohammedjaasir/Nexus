'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const { buildWorkspaceIndex } = loadTs('src/renderer/src/nexus/pages/workspaceIndex.ts');
const { WORKSPACES } = loadTs('src/renderer/src/nexus/workspaces/registry.ts');
const { legacyIndex } = loadTs('src/renderer/src/nexus/workspaces/participation.ts');
// The legacy domain grouping as the participation index: the same expectations as before the authority flip.
const build = (projects) => buildWorkspaceIndex(projects, legacyIndex(projects));

const p = (id, domainId, updatedAt) => ({ id, name: `proj-${id}`, domainId, updatedAt, rootPath: `/r/${id}` });

test('index: one row per registry workspace, in registry order', () => {
  const idx = build([]);
  assert.deepEqual(idx.rows.map((r) => r.id), WORKSPACES.map((w) => w.id));
});

test('index: counts and the two most recent project names come from real projects', () => {
  const idx = build([p('a', 'ai-ml', 1), p('b', 'ai-ml', 3), p('c', 'ai-ml', 2), p('d', 'web-app-dev', 5)]);
  const ml = idx.rows.find((r) => r.id === 'ml');
  assert.equal(ml.count, 3);
  assert.deepEqual(ml.recent.map((x) => x.id), ['b', 'c']);
  assert.equal(idx.rows.find((r) => r.id === 'sde').count, 1);
  assert.equal(idx.rows.find((r) => r.id === 'qa').count, 0);
  assert.deepEqual(idx.rows.find((r) => r.id === 'qa').recent, []);
});

test('index: totals, and projects whose domain maps nowhere are counted as unassigned', () => {
  const idx = build([p('a', 'ai-ml', 1), p('x', 'cybersecurity', 2), p('y', 'not-a-domain', 3)]);
  assert.equal(idx.totalProjects, 3);
  assert.equal(idx.unassigned, 2);
});

test('index: a workspace with no analyzer domain says so instead of listing ids', () => {
  const idx = build([]);
  assert.equal(idx.rows.find((r) => r.id === 'qa').hasDomain, false);
  assert.equal(idx.rows.find((r) => r.id === 'ml').hasDomain, true);
});
