'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');
const { VERSION_TRANSITIONS, canTransitionVersion, contentHashOf } = loadTs('src/main/nexus/artifact/versionRules.ts');
test('the version table is exactly F.7', () => {
  assert.deepEqual(Object.fromEntries(Object.entries(VERSION_TRANSITIONS).map(([k, v]) => [k, [...v].sort()])), {
    draft: ['candidate', 'deprecated', 'failed'], candidate: ['active', 'deprecated'], active: ['deprecated'], failed: [], deprecated: ['active'] });
  assert.equal(canTransitionVersion('draft', 'active'), false);
});
test('content hash: inline is canonical JSON, key order does not matter; git is the commit', () => {
  assert.equal(contentHashOf({ kind: 'inline', json: { a: 1, b: 2 } }), contentHashOf({ kind: 'inline', json: { b: 2, a: 1 } }));
  assert.equal(contentHashOf({ kind: 'git', commit: 'a'.repeat(40) }), `git:${'a'.repeat(40)}`);
});
