'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { route } = require('../src/handler');
test('serves its home page', () => { assert.equal(route('/').status, 200); });
