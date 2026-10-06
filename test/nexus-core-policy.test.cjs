'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');
const P = loadTs('src/main/nexus/auth/policy.ts');
const user = { id: 'user:local', kind: 'user', displayName: 'Local owner' };
const system = { id: 'system', kind: 'system', displayName: 'Nexus platform' };
const agent = { id: 'agent:j1', kind: 'agent', displayName: 'agent run' };
const ALL = [...P.READ_ACTIONS, ...P.MEMBER_ACTIONS, ...P.ADMIN_ACTIONS, ...P.SYSTEM_ONLY_ACTIONS];

test('every action is classified exactly once', () => assert.equal(new Set(ALL).size, ALL.length));
test('owner can do every user action; viewer can only read', () => {
  for (const a of [...P.READ_ACTIONS, ...P.MEMBER_ACTIONS, ...P.ADMIN_ACTIONS]) assert.equal(P.decide({ principal: user, roles: ['owner'], action: a }).allowed, true, a);
  for (const a of P.READ_ACTIONS) assert.equal(P.decide({ principal: user, roles: ['viewer'], action: a }).allowed, true, a);
  assert.deepEqual(P.decide({ principal: user, roles: ['viewer'], action: 'artifact.create' }), { allowed: false, reason: 'role', needed: 'member' });
  assert.deepEqual(P.decide({ principal: user, roles: ['member'], action: 'artifact.archive' }), { allowed: false, reason: 'role', needed: 'admin' });
});
test('the strongest role across scopes wins', () => assert.equal(P.decide({ principal: user, roles: ['viewer', 'member'], action: 'job.create' }).allowed, true));
test('no membership, unknown and disabled principals are denied', () => {
  assert.equal(P.decide({ principal: user, roles: [], action: 'artifact.read' }).reason, 'no_membership');
  assert.equal(P.decide({ principal: null, roles: ['owner'], action: 'artifact.read' }).reason, 'unknown_principal');
  assert.equal(P.decide({ principal: user, disabled: true, roles: ['owner'], action: 'artifact.read' }).reason, 'disabled_principal');
});
test('agents are denied until capability tokens exist (later phase)', () =>
  assert.equal(P.decide({ principal: agent, roles: ['owner'], action: 'artifact.read' }).reason, 'agent_requires_token'));
test('system-only actions refuse users, even owners; the system principal may run them', () => {
  for (const a of P.SYSTEM_ONLY_ACTIONS) {
    assert.equal(P.decide({ principal: user, roles: ['owner'], action: a }).reason, 'system_only', a);
    assert.equal(P.decide({ principal: system, roles: ['admin'], action: a }).allowed, true, a);
  }
});
