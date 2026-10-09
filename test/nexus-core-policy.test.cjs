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
test('B1 handoff actions: classified exactly once, read for viewers, the three writes need a member', () => {
  const NEW = ['handoff.read', 'handoff.send', 'handoff.respond', 'handoff.withdraw'];
  for (const a of NEW) assert.equal(ALL.filter((x) => x === a).length, 1, a);
  assert.ok(P.READ_ACTIONS.includes('handoff.read'));
  assert.equal(P.decide({ principal: user, roles: ['viewer'], action: 'handoff.read' }).allowed, true);
  for (const a of ['handoff.send', 'handoff.respond', 'handoff.withdraw']) {
    assert.ok(P.MEMBER_ACTIONS.includes(a), a);
    assert.deepEqual(P.decide({ principal: user, roles: ['viewer'], action: a }), { allowed: false, reason: 'role', needed: 'member' }, a);
    assert.equal(P.decide({ principal: user, roles: ['member'], action: a }).allowed, true, a);
  }
  assert.ok(P.SYSTEM_ONLY_ACTIONS.includes('version.finalize'), 'finalize stays system only');
});
test('B2a execution actions: each classified exactly once, with its minimum role or system only', () => {
  const owner = P.OWNER_ACTIONS;
  const every = [...ALL, ...owner];
  assert.equal(new Set(every).size, every.length);
  const rows = [
    ['approval.read', 'viewer'], ['platform.health', 'viewer'],
    ['deployment.stop', 'member'], ['version.revalidate', 'member'],
    ['blob.gc', 'admin'], ['approval.respond', 'owner']
  ];
  const below = { viewer: null, member: 'viewer', admin: 'member', owner: 'admin' };
  for (const [a, role] of rows) {
    assert.equal(every.filter((x) => x === a).length, 1, a);
    assert.equal(P.decide({ principal: user, roles: [role], action: a }).allowed, true, a);
    if (below[role]) assert.deepEqual(P.decide({ principal: user, roles: [below[role]], action: a }), { allowed: false, reason: 'role', needed: role }, a);
    assert.equal(P.decide({ principal: agent, roles: ['owner'], action: a }).reason, 'agent_requires_token', a);
  }
  for (const a of ['approval.create', 'deployment.transition', 'exec.ingest']) {
    assert.ok(P.SYSTEM_ONLY_ACTIONS.includes(a), a);
    assert.equal(P.decide({ principal: user, roles: ['owner'], action: a }).reason, 'system_only', a);
    assert.equal(P.decide({ principal: system, roles: ['admin'], action: a }).allowed, true, a);
  }
});
