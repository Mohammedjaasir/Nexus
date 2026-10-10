'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { route } = require('../src/handler');
describe('routes', () => {
  it('answers /health with 200', () => { assert.equal(route('/health').status, 200); });
  it('answers an unknown path with 404', () => { assert.equal(route('/nope').status, 404); });
});
