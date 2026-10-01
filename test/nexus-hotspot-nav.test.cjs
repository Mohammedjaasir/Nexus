'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');
const { nextHotspot } = loadTs('src/renderer/src/nexus/launcher/hotspotNav.ts');

// 0 centre, 1 right, 2 far right, 3 up, 4 down-left
const pts = [{ x: 50, y: 50 }, { x: 70, y: 52 }, { x: 90, y: 50 }, { x: 52, y: 20 }, { x: 30, y: 80 }];

test('moves to the nearest point in the pressed direction', () => {
  assert.equal(nextHotspot(pts, 0, 'right'), 1);
  assert.equal(nextHotspot(pts, 1, 'right'), 2);
  assert.equal(nextHotspot(pts, 0, 'up'), 3);
  assert.equal(nextHotspot(pts, 0, 'down'), 4);
  assert.equal(nextHotspot(pts, 0, 'left'), 4);
});

test('stays put when nothing lies that way', () => {
  assert.equal(nextHotspot(pts, 2, 'right'), 2);
  assert.equal(nextHotspot(pts, 3, 'up'), 3);
});

test('handles empty and out-of-range input', () => {
  assert.equal(nextHotspot([], 0, 'right'), -1);
  assert.equal(nextHotspot(pts, 99, 'right'), 0);
});
