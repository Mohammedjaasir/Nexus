'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const { gridMove } = loadTs('src/renderer/src/nexus/launcher/gridNav.ts');
const { sceneFor, SCENE_KINDS } = loadTs('src/renderer/src/nexus/launcher/sceneKinds.ts');
const { WORKSPACES } = loadTs('src/renderer/src/nexus/workspaces/registry.ts');

test('gridMove: left/right step one tile and stop at the ends', () => {
  assert.equal(gridMove(0, 'ArrowRight', 4, 8), 1);
  assert.equal(gridMove(7, 'ArrowRight', 4, 8), 7);
  assert.equal(gridMove(3, 'ArrowLeft', 4, 8), 2);
  assert.equal(gridMove(0, 'ArrowLeft', 4, 8), 0);
});

test('gridMove: up/down move a whole row and clamp inside the list', () => {
  assert.equal(gridMove(1, 'ArrowDown', 4, 8), 5);
  assert.equal(gridMove(5, 'ArrowUp', 4, 8), 1);
  assert.equal(gridMove(1, 'ArrowUp', 4, 8), 1);
  assert.equal(gridMove(5, 'ArrowDown', 4, 6), 5, 'no tile below: stay');
  assert.equal(gridMove(2, 'ArrowDown', 4, 6), 5, 'partial last row: land on the last tile');
});

test('gridMove: Home/End, a single column, and empty lists', () => {
  assert.equal(gridMove(4, 'Home', 4, 8), 0);
  assert.equal(gridMove(2, 'End', 4, 8), 7);
  assert.equal(gridMove(2, 'ArrowDown', 1, 8), 3);
  assert.equal(gridMove(0, 'ArrowDown', 4, 0), -1);
  assert.equal(gridMove(3, 'Enter', 4, 8), 3, 'other keys do not move');
  assert.equal(gridMove(0, 'ArrowRight', 0, 8), 1, 'a zero column count is treated as one');
});

test('sceneFor: every workspace has its own scene; unknown ids get the generic one', () => {
  const kinds = WORKSPACES.map((w) => sceneFor(w.id));
  assert.equal(new Set(kinds).size, WORKSPACES.length);
  for (const k of kinds) assert.ok(SCENE_KINDS.includes(k), k);
  assert.equal(sceneFor('future-workspace'), 'generic');
});
