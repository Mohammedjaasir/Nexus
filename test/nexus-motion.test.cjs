// test/nexus-motion.test.cjs
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');
const { withViewTransition } = loadTs('src/renderer/src/nexus/ui/viewTransition.ts');

test('uses the view transition when available and motion is allowed', () => {
  let used = false, ran = false;
  withViewTransition(() => { ran = true; }, { reduce: false, doc: { startViewTransition: (cb) => { used = true; cb(); } } });
  assert.ok(used && ran);
});

test('reduced motion or no support: runs the update directly', () => {
  for (const opts of [{ reduce: true, doc: { startViewTransition: () => assert.fail('must not animate') } }, { reduce: false, doc: {} }]) {
    let ran = false;
    withViewTransition(() => { ran = true; }, opts);
    assert.ok(ran);
  }
});
