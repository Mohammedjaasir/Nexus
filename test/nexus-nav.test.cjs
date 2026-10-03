// test/nexus-nav.test.cjs
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');
const { pathSegments, MENU_GROUPS } = loadTs('src/renderer/src/nexus/chrome/navItems.ts');
const P = [{ id: 'p1', name: 'Invoice OCR', domainId: 'ai-ml' }, { id: 'p2', name: 'Sec scan', domainId: 'cybersecurity' }];

test('home has no path', () => { assert.deepEqual(pathSegments({ name: 'home' }, P), []); });
test('workspace shows one segment with its slot', () => {
  assert.deepEqual(pathSegments({ name: 'workspace', id: 'ml' }, P), [{ kind: 'workspace', id: 'ml', label: 'ML', hueSlot: 1 }]);
});
test('project shows its workspace then itself', () => {
  const s = pathSegments({ name: 'project', id: 'p1', tool: 'bench' }, P);
  assert.equal(s.length, 2);
  assert.equal(s[0].id, 'ml');
  assert.equal(s[1].label, 'Invoice OCR');
});
test('unassigned project has a neutral workspace segment', () => {
  const s = pathSegments({ name: 'project', id: 'p2', tool: 'bench' }, P);
  assert.deepEqual(s[0], { kind: 'workspace', id: 'unassigned', label: 'Unassigned', hueSlot: null });
});
test('unknown project id yields only what is known', () => {
  assert.deepEqual(pathSegments({ name: 'project', id: 'gone', tool: 'bench' }, P), []);
});
test('menu lists planned places separately', () => {
  const planned = MENU_GROUPS.flatMap((g) => g.items).filter((i) => i.planned).map((i) => i.id);
  assert.deepEqual(planned.sort(), ['artifacts', 'deployments', 'handoffs']);
});
