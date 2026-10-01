'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');
const { readPref, writePref } = loadTs('src/renderer/src/nexus/state/prefs.ts');

function memory() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) };
}
const throwing = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('quota'); }, removeItem() { throw new Error('denied'); } };

test('prefs round-trip with nx. prefix and removal', () => {
  const s = memory();
  writePref(s, 'lastWorkspace', 'ml');
  assert.equal(s.getItem('nx.lastWorkspace'), 'ml');
  assert.equal(readPref(s, 'lastWorkspace'), 'ml');
  writePref(s, 'lastWorkspace', null);
  assert.equal(readPref(s, 'lastWorkspace'), null);
});

test('prefs never throw when storage is unavailable', () => {
  assert.equal(readPref(throwing, 'x'), null);
  assert.doesNotThrow(() => writePref(throwing, 'x', 'y'));
  assert.equal(readPref(null, 'x'), null);
  assert.doesNotThrow(() => writePref(null, 'x', 'y'));
});
