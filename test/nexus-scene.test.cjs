'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const { VIEW, toView, bridgePath, buildScene, FLOW_ROUTE, landmarkFor, LANDMARKS } =
  loadTs('src/renderer/src/nexus/launcher/sceneGeometry.ts');
const { WORKSPACES, LAUNCHER_SHORTCUTS } = loadTs('src/renderer/src/nexus/workspaces/registry.ts');

const core = LAUNCHER_SHORTCUTS[0];

test('toView maps stage percentages onto the 16:10 viewBox', () => {
  assert.equal(VIEW.w / VIEW.h, 1.6);
  assert.deepEqual(toView({ x: 0, y: 0 }), { x: 0, y: 0 });
  assert.deepEqual(toView({ x: 50, y: 50 }), { x: VIEW.w / 2, y: VIEW.h / 2 });
  assert.deepEqual(toView({ x: 100, y: 100 }), { x: VIEW.w, y: VIEW.h });
});

test('bridgePath is an arched quadratic curve between two points', () => {
  const d = bridgePath({ x: 100, y: 300 }, { x: 500, y: 300 });
  const m = d.match(/^M ([\d.-]+) ([\d.-]+) Q ([\d.-]+) ([\d.-]+) ([\d.-]+) ([\d.-]+)$/);
  assert.ok(m, d);
  const [, x1, y1, cx, cy, x2, y2] = m.map(Number);
  assert.deepEqual([x1, y1, x2, y2], [100, 300, 500, 300]);
  assert.equal(cx, 300);
  assert.ok(cy < 300, 'control point lifts the arch upward');
});

test('every registry workspace gets one island and one bridge from the core', () => {
  const scene = buildScene(WORKSPACES, core);
  assert.deepEqual(scene.islands.map((i) => i.id).sort(), WORKSPACES.map((w) => w.id).sort());
  assert.deepEqual(scene.bridges.map((b) => b.id).sort(), WORKSPACES.map((w) => w.id).sort());
  for (const b of scene.bridges) {
    const [, x1, y1] = b.d.match(/^M ([\d.-]+) ([\d.-]+)/).map(Number);
    assert.deepEqual({ x: x1, y: y1 }, scene.core.at, `${b.id} starts at the core`);
  }
});

test('all scene points stay inside the viewBox', () => {
  const scene = buildScene(WORKSPACES, core);
  for (const p of [scene.core.at, ...scene.islands.map((i) => i.at)]) {
    assert.ok(p.x >= 0 && p.x <= VIEW.w && p.y >= 0 && p.y <= VIEW.h, JSON.stringify(p));
  }
});

test('flow pulses follow the route in order and skip workspaces that do not exist', () => {
  const scene = buildScene(WORKSPACES, core);
  assert.deepEqual(FLOW_ROUTE, ['ml', 'sde', 'uiux', 'devops']);
  assert.deepEqual(scene.flow.map((f) => f.id), ['ml', 'sde', 'uiux', 'devops']);
  const delays = scene.flow.map((f) => f.delay);
  assert.deepEqual(delays, [...delays].sort((a, b) => a - b));
  const partial = buildScene(WORKSPACES.filter((w) => w.id !== 'sde'), core);
  assert.deepEqual(partial.flow.map((f) => f.id), ['ml', 'uiux', 'devops']);
});

test('the ML pulse travels toward the core; the others travel outward', () => {
  const scene = buildScene(WORKSPACES, core);
  const ml = scene.flow.find((f) => f.id === 'ml');
  const sde = scene.flow.find((f) => f.id === 'sde');
  const [, mx, my] = ml.d.match(/^M ([\d.-]+) ([\d.-]+)/).map(Number);
  const [, sx, sy] = sde.d.match(/^M ([\d.-]+) ([\d.-]+)/).map(Number);
  assert.deepEqual({ x: mx, y: my }, scene.islands.find((i) => i.id === 'ml').at);
  assert.deepEqual({ x: sx, y: sy }, scene.core.at);
});

test('landmarks: every phase A workspace has its own; unknown ids fall back to generic', () => {
  const kinds = WORKSPACES.map((w) => landmarkFor(w.id));
  assert.equal(new Set(kinds).size, WORKSPACES.length, 'each workspace has a distinct landmark');
  for (const k of kinds) assert.ok(LANDMARKS.includes(k), k);
  assert.equal(landmarkFor('future-workspace'), 'generic');
  assert.ok(LANDMARKS.includes('generic'));
});
