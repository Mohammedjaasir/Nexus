'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const { slugOf, digitIndex } = loadTs('src/renderer/src/nexus/launcher/wallModel.ts');
const { WORKSPACES } = loadTs('src/renderer/src/nexus/workspaces/registry.ts');

test('slugOf: lower-case path segment for the panel header', () => {
  assert.equal(slugOf('Software Engineering'), 'software-engineering');
  assert.equal(slugOf('UI / UX Design'), 'ui-ux-design');
  assert.equal(slugOf('  DevOps  '), 'devops');
  assert.equal(slugOf('Data & Analytics!'), 'data-analytics');
});

test('slugOf: every registry workspace gets a distinct, non-empty slug', () => {
  const slugs = WORKSPACES.map((w) => slugOf(w.name));
  assert.ok(slugs.every((s) => /^[a-z0-9]+(-[a-z0-9]+)*$/.test(s)), slugs.join(' '));
  assert.equal(new Set(slugs).size, slugs.length);
});

test('digitIndex: keys 1-9 map to visible panels, anything else does not', () => {
  assert.equal(digitIndex('1', 8), 0);
  assert.equal(digitIndex('8', 8), 7);
  assert.equal(digitIndex('9', 8), -1, 'no ninth panel');
  assert.equal(digitIndex('3', 2), -1, 'filtered down to two');
  assert.equal(digitIndex('0', 8), -1);
  assert.equal(digitIndex('a', 8), -1);
  assert.equal(digitIndex('12', 20), -1, 'single keys only');
});
