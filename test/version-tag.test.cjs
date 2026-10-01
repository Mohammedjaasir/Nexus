'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const { formatVersionTag, parseVersionTag } = loadTs('src/main/utils/versionTag.ts');

test('1. formatVersionTag formats standard and pre-release semver tags correctly', () => {
  assert.equal(formatVersionTag(1, 2, 3), 'v1.2.3');
  assert.equal(formatVersionTag(0, 4, 4), 'v0.4.4');
  assert.equal(formatVersionTag(2, 0, 0, 'beta.1'), 'v2.0.0-beta.1');
  assert.equal(formatVersionTag(1, 0, 0, 'rc.2'), 'v1.0.0-rc.2');
});

test('2. parseVersionTag parses valid semver tags into parts', () => {
  const parsed = parseVersionTag('v1.2.3');
  assert.deepEqual(parsed, { major: 1, minor: 2, patch: 3, preRelease: undefined });

  const pre = parseVersionTag('v2.0.0-alpha.5');
  assert.deepEqual(pre, { major: 2, minor: 0, patch: 0, preRelease: 'alpha.5' });

  const invalid = parseVersionTag('not-a-version');
  assert.equal(invalid, null);
});
