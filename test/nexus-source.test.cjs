'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');
const { provenanceLine } = loadTs('src/renderer/src/nexus/project/sourceProvenance.ts');

const now = 10_000_000_000;
const src = (over) => ({ kind: 'source', id: 'source', vcs: 'git', branch: 'main', head: { shortSha: 'abc1234', subject: 'Fix totals' }, ...over });
const ready = (over) => ({ status: 'ready', isRepo: true, branch: 'main', head: { sha: 'abc1234ff', shortSha: 'abc1234', subject: 'Fix totals', time: now / 1000 - 7200 }, changed: [], ...over });

test('git provenance states branch, commit and age', () => {
  assert.equal(provenanceLine(src(), ready(), now), 'Repository on branch main. Last commit abc1234 Fix totals, 2h ago.');
});

test('a failed branch or log read is unknown, never "detached" or "no commits"', () => {
  const line = provenanceLine(src({ branch: null, head: null }), ready({ branch: null, head: null, unknown: { branch: true, head: true } }), now);
  assert.equal(line, 'Repository. Branch unknown. Last commit unknown.');
  assert.doesNotMatch(line, /not on a branch|No commits/);
});

test('a truly detached, empty repository says so', () => {
  assert.equal(provenanceLine(src({ branch: null, head: null }), ready({ branch: null, head: null }), now), 'Repository, not on a branch. No commits yet.');
});

test('non-git states are not described by this line', () => {
  assert.equal(provenanceLine(src({ vcs: 'none', branch: null, head: null }), ready({ isRepo: false, branch: null, head: null }), now), null);
});
