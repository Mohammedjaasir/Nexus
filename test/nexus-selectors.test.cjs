'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');
const { recentProjects, repoHealth, relativeTime, setupSteps, setupProgress } =
  loadTs('src/renderer/src/nexus/data/selectors.ts');

test('recentProjects: newest first, limit 4, stable ties by name, input untouched', () => {
  const input = [
    { name: 'b', updatedAt: 5 }, { name: 'a', updatedAt: 5 }, { name: 'c', updatedAt: 9 },
    { name: 'd', updatedAt: 1 }, { name: 'e', updatedAt: 7 }
  ];
  const copy = JSON.parse(JSON.stringify(input));
  assert.deepEqual(recentProjects(input).map((p) => p.name), ['c', 'e', 'a', 'b']);
  assert.deepEqual(input, copy);
  assert.deepEqual(recentProjects([], 4), []);
  assert.deepEqual(recentProjects(input, 2).map((p) => p.name), ['c', 'e']);
});

test('repoHealth: only a real finite 0-100 healthScore renders', () => {
  assert.equal(repoHealth({ health: { healthScore: 75 } }), 75);
  assert.equal(repoHealth({ health: { healthScore: 0 } }), 0);
  assert.equal(repoHealth({ health: { healthScore: 99.6 } }), 100);
  for (const bad of [undefined, null, {}, { health: null }, { health: {} },
    { health: { healthScore: NaN } }, { health: { healthScore: null } }, { health: { healthScore: '80' } },
    { health: { healthScore: -5 } }, { health: { healthScore: 140 } }, { health: { healthScore: Infinity } }]) {
    assert.equal(repoHealth(bad), null, JSON.stringify(bad));
  }
});

test('relativeTime: boundaries', () => {
  const now = Date.UTC(2026, 9, 1, 12, 0, 0);
  assert.equal(relativeTime(now - 10_000, now), 'just now');
  assert.equal(relativeTime(now - 5 * 60_000, now), '5m ago');
  assert.equal(relativeTime(now - 2 * 3_600_000, now), '2h ago');
  assert.equal(relativeTime(now - 3 * 86_400_000, now), '3d ago');
  assert.match(relativeTime(now - 40 * 86_400_000, now), /^[A-Z][a-z]{2} \d{1,2}$/);
  assert.equal(relativeTime(NaN, now), '');
  assert.equal(relativeTime(now + 60_000, now), 'just now'); // clock skew
});

test('setupSteps: two real steps, two locked', () => {
  const fresh = setupSteps({ lastWorkspace: null, projectCount: 0 });
  assert.deepEqual(fresh.map((s) => [s.id, s.state]), [['workspace', 'todo'], ['project', 'todo'], ['artifact', 'locked'], ['deploy', 'locked']]);
  const done = setupSteps({ lastWorkspace: 'ml', projectCount: 3 });
  assert.deepEqual(done.map((s) => s.state), ['done', 'done', 'locked', 'locked']);
  assert.deepEqual(setupProgress(done), { done: 2, available: 2, total: 4 });
  assert.deepEqual(setupProgress(fresh), { done: 0, available: 2, total: 4 });
});
