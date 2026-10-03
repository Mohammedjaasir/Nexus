'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');
const { provenanceHue, hueDistance, BASE_HUE } = loadTs('src/renderer/src/nexus/design/provenance.ts');
const { WORKSPACES } = loadTs('src/renderer/src/nexus/workspaces/registry.ts');

test('slot 0 is the base hue and slots are stable', () => {
  assert.equal(provenanceHue(0), BASE_HUE);
  assert.equal(provenanceHue(3), provenanceHue(3));
  assert.equal(provenanceHue(7), 147.6);
});

test('hues do not depend on how many workspaces exist', () => {
  const firstEight = [0, 1, 2, 3, 4, 5, 6, 7].map(provenanceHue);
  const firstEightOfTwenty = Array.from({ length: 20 }, (_, i) => provenanceHue(i)).slice(0, 8);
  assert.deepEqual(firstEight, firstEightOfTwenty);
});

test('the first eight slots are at least 30 degrees apart', () => {
  const h = [0, 1, 2, 3, 4, 5, 6, 7].map(provenanceHue);
  for (let i = 0; i < h.length; i++) for (let j = i + 1; j < h.length; j++) {
    assert.ok(hueDistance(h[i], h[j]) >= 30, `slots ${i},${j}: ${h[i]} vs ${h[j]}`);
  }
});

test('invalid slots are rejected', () => {
  assert.throws(() => provenanceHue(-1), RangeError);
  assert.throws(() => provenanceHue(1.5), RangeError);
});

test('every workspace has a unique integer slot', () => {
  const slots = WORKSPACES.map((w) => w.hueSlot);
  assert.ok(slots.every((s) => Number.isInteger(s) && s >= 0));
  assert.equal(new Set(slots).size, slots.length);
});
