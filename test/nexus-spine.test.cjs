// test/nexus-spine.test.cjs
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');
const { buildSpine, nodeLabel } = loadTs('src/renderer/src/nexus/project/spineModel.ts');
const ready = (o) => ({ status: 'ready', isRepo: true, branch: 'main', head: { sha: 'abc1234def', shortSha: 'abc1234', subject: 'Fix totals parser', time: 1 }, changed: [], ...o });
const nodes = (g) => g.flatMap((x) => x.nodes);

test('clean git repo: one source node, no changes node, no artifacts', () => {
  const g = buildSpine({ domainId: 'ai-ml', git: ready({}) });
  assert.equal(g.length, 1);
  assert.equal(g[0].workspaceId, 'ml');
  assert.equal(g[0].hueSlot, 1);
  assert.deepEqual(nodes(g).map((n) => n.kind), ['source']);
  assert.equal(nodes(g)[0].vcs, 'git');
});

test('dirty repo: changes node carries the real count', () => {
  const g = buildSpine({ domainId: 'ai-ml', git: ready({ changed: [{ path: 'a.py', kind: 'modified' }, { path: 'b.py', kind: 'untracked' }] }) });
  assert.deepEqual(nodes(g).map((n) => n.kind), ['source', 'changes']);
  assert.equal(nodes(g)[1].fileCount, 2);
});

test('non-git folder: plain folder node, never a changes node', () => {
  const g = buildSpine({ domainId: 'ai-ml', git: { status: 'ready', isRepo: false, branch: null, head: null, changed: [] } });
  assert.deepEqual(nodes(g).map((n) => [n.kind, n.vcs]), [['source', 'none']]);
});

test('loading or error: source node with unknown vcs', () => {
  for (const git of [{ status: 'loading' }, { status: 'error', message: 'boom' }]) {
    const g = buildSpine({ domainId: 'ai-ml', git });
    assert.deepEqual(nodes(g).map((n) => [n.kind, n.vcs]), [['source', 'unknown']]);
  }
});

test('unassigned domain: neutral group', () => {
  const g = buildSpine({ domainId: 'cybersecurity', git: ready({}) });
  assert.deepEqual([g[0].workspaceId, g[0].label, g[0].hueSlot], ['unassigned', 'Unassigned', null]);
});

test('labels describe real state only', () => {
  const [src] = nodes(buildSpine({ domainId: 'ai-ml', git: ready({}) }));
  assert.equal(nodeLabel(src), 'Repository, branch main, last commit abc1234 Fix totals parser');
  const [folder] = nodes(buildSpine({ domainId: 'ai-ml', git: { status: 'ready', isRepo: false, branch: null, head: null, changed: [] } }));
  assert.equal(nodeLabel(folder), 'Project folder, not a git repository');
  const g = buildSpine({ domainId: 'ai-ml', git: ready({ changed: [{ path: 'a', kind: 'modified' }] }) });
  assert.equal(nodeLabel(nodes(g)[1]), 'Uncommitted changes, 1 file');
});
