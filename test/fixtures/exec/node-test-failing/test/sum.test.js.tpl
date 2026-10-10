'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
test('adds correctly', () => { assert.equal(1 + 1, 2); });
test('is wrong on purpose', () => { assert.equal(1 + 1, 3); });
