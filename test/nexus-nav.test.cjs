// test/nexus-nav.test.cjs
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');
const { pathSegments, MENU_GROUPS } = loadTs('src/renderer/src/nexus/chrome/navItems.ts');
const { legacyIndex } = loadTs('src/renderer/src/nexus/workspaces/participation.ts');
const P = [{ id: 'p1', name: 'Invoice OCR', domainId: 'ai-ml' }, { id: 'p2', name: 'Sec scan', domainId: 'cybersecurity' }];
const I = legacyIndex(P);

test('home has no path', () => { assert.deepEqual(pathSegments({ name: 'home' }, P, I), []); });
test('workspace shows one segment with its slot', () => {
  assert.deepEqual(pathSegments({ name: 'workspace', id: 'ml' }, P, I), [{ kind: 'workspace', id: 'ml', label: 'ML', hueSlot: 1 }]);
});
test('project shows its workspace then itself', () => {
  const s = pathSegments({ name: 'project', id: 'p1', tool: 'bench' }, P, I);
  assert.equal(s.length, 2);
  assert.equal(s[0].id, 'ml');
  assert.equal(s[1].label, 'Invoice OCR');
});
test('unassigned project has a neutral workspace segment', () => {
  const s = pathSegments({ name: 'project', id: 'p2', tool: 'bench' }, P, I);
  assert.deepEqual(s[0], { kind: 'workspace', id: 'unassigned', label: 'Unassigned', hueSlot: null });
});
test('unknown project id yields only what is known', () => {
  assert.deepEqual(pathSegments({ name: 'project', id: 'gone', tool: 'bench' }, P, I), []);
});
test('menu lists planned places separately', () => {
  // Task 12: Artifacts is real and moved to "Go to"; Handoffs (until Task 13) and Deployments stay planned.
  const planned = MENU_GROUPS.flatMap((g) => g.items).filter((i) => i.planned).map((i) => i.id);
  assert.deepEqual(planned.sort(), ['deployments', 'handoffs']);
  assert.deepEqual(MENU_GROUPS.find((g) => g.label === 'Planned').items.map((i) => i.id), ['handoffs', 'deployments']);
});
test('Artifacts is a real place in "Go to", after Projects', () => {
  const go = MENU_GROUPS.find((g) => g.label === 'Go to').items;
  assert.deepEqual(go.map((i) => i.id), ['home', 'workspaces', 'projects', 'artifacts', 'agents']);
  const a = go.find((i) => i.id === 'artifacts');
  assert.deepEqual(a.route, { name: 'artifacts' });
  assert.equal(a.planned, undefined);
});
