'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');
const { groupChanges, REVIEW_PHASE_NOTE } = loadTs('src/renderer/src/nexus/review/reviewModel.ts');

test('groups by kind in a fixed order, paths sorted', () => {
  const g = groupChanges([{ path: 'b.py', kind: 'modified' }, { path: 'new.md', kind: 'untracked' }, { path: 'a.py', kind: 'modified' }, { path: 'old.py', kind: 'deleted' }]);
  assert.deepEqual(g.map((x) => [x.title, x.paths]), [['Modified', ['a.py', 'b.py']], ['Deleted', ['old.py']], ['New, not tracked', ['new.md']]]);
});

test('empty input gives no groups', () => { assert.deepEqual(groupChanges([]), []); });

test('the phase note says why accept and discard are missing', () => {
  assert.match(REVIEW_PHASE_NOTE, /accept/i);
  assert.match(REVIEW_PHASE_NOTE, /discard/i);
});
