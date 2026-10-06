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
const { validateStorage } = loadTs('src/main/nexus/artifact/versionRules.ts');
const { isSqliteBusy } = loadTs('src/main/nexus/db/tx.ts');
const { PlatformError } = loadTs('src/main/nexus/errors.ts');
test('fix 5: inline JSON must survive a round-trip exactly; nothing is coerced', () => {
  const cyclic = {}; cyclic.self = cyclic;
  const sparse = [1]; sparse[2] = 3;
  const bad = [() => 1, Symbol('s'), 10n, [undefined], [1, undefined], { a: undefined }, NaN, Infinity, -Infinity, -0,
    { n: NaN }, { b: 1n }, new Date(0), new Map(), { toJSON() { return 1; } }, cyclic, sparse, { [Symbol('k')]: 1 },
    Object.create({ inherited: 1 }), JSON.parse('{"__proto__":{"a":1}}'), { deep: [JSON.parse('{"__proto__":1}')] }];
  bad.forEach((json, i) => {
    assert.throws(() => validateStorage({ kind: 'inline', json }), (e) => e.code === 'invalid', `case ${i}`);
  });
  const good = { a: [1, 'x', null, true, { b: -1.5 }], c: {} };
  assert.deepEqual(validateStorage({ kind: 'inline', json: good }), { kind: 'inline', json: good });
  assert.deepEqual(validateStorage({ kind: 'inline', json: Object.assign(Object.create(null), { z: 0 }) }).json, { z: 0 });
});
test('fix 8: SQLITE_BUSY* and SQLITE_LOCKED* are recognised; other errors are not', () => {
  for (const code of ['SQLITE_BUSY', 'SQLITE_BUSY_SNAPSHOT', 'SQLITE_LOCKED', 'SQLITE_LOCKED_SHAREDCACHE']) assert.equal(isSqliteBusy({ code }), true, code);
  for (const e of [{ code: 'SQLITE_CONSTRAINT' }, { code: 'SQLITE_BUSYX' }, new PlatformError('conflict', 'x'), null, new Error('x')]) assert.equal(isSqliteBusy(e), false);
});
