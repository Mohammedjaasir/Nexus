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
const { JOB_TRANSITIONS, TERMINAL_JOB_STATES, canTransitionJob, canRetry } = loadTs('src/main/nexus/jobs/jobRules.ts');
const { SESSION_TRANSITIONS, TERMINAL_SESSION_STATES } = loadTs('src/main/nexus/sessions/sessionRules.ts');
const seed = loadTs('src/main/nexus/db/v7Seed.ts');
const flat = (t) => Object.entries(t).flatMap(([a, bs]) => bs.map((b) => `${a}>${b}`)).sort();
test('the job table in code equals the seeded table (11 states, 23 transitions)', () => {
  assert.deepEqual(flat(JOB_TRANSITIONS), seed.V7_JOB_TRANSITIONS.map(([a, b]) => `${a}>${b}`).sort());
  assert.deepEqual([...TERMINAL_JOB_STATES].sort(), ['cancelled', 'completed', 'failed', 'interrupted', 'partial', 'timed_out']);
  for (const t of ['completed', 'partial', 'cancelled', 'interrupted']) assert.deepEqual([...JOB_TRANSITIONS[t]], [], t);
  for (const t of ['failed', 'timed_out']) assert.deepEqual([...JOB_TRANSITIONS[t]], ['retry_scheduled'], t);
  assert.equal(canTransitionJob('queued', 'running'), false);
  assert.equal(canTransitionJob('completed', 'running'), false);
});
test('retry needs an idempotent, non-agent job with attempts left', () => {
  const r = { idempotent: true, maxAttempts: 3, backoffMs: [10] };
  assert.equal(canRetry({ kind: 'validate', retry: r, attempts: 1 }), true);
  assert.equal(canRetry({ kind: 'validate', retry: r, attempts: 3 }), false);
  assert.equal(canRetry({ kind: 'validate', retry: { ...r, idempotent: false }, attempts: 1 }), false);
  assert.equal(canRetry({ kind: 'agent.run', retry: r, attempts: 1 }), false);
});
const { HANDOFF_TRANSITIONS, canTransitionHandoff } = loadTs('src/main/nexus/handoff/handoffRules.ts');
const { V8_HANDOFF_TRANSITIONS, V8_HANDOFF_STATES } = loadTs('src/main/nexus/db/v8Seed.ts');
test('the handoff table in code equals the v8 seed (4 states, 3 transitions)', () => {
  assert.deepEqual(flat(HANDOFF_TRANSITIONS), V8_HANDOFF_TRANSITIONS.map(([a, b]) => `${a}>${b}`).sort());
  assert.deepEqual(Object.keys(HANDOFF_TRANSITIONS).sort(), V8_HANDOFF_STATES.map((s) => s.state).sort());
  for (const s of V8_HANDOFF_STATES.filter((x) => x.terminal === 1)) assert.deepEqual([...HANDOFF_TRANSITIONS[s.state]], [], s.state);
  assert.equal(canTransitionHandoff('sent', 'accepted'), true);
  assert.equal(canTransitionHandoff('accepted', 'declined'), false);
});
test('the session table in code equals the seeded table (8 states, 14 transitions)', () => {
  assert.deepEqual(flat(SESSION_TRANSITIONS), seed.V7_SESSION_TRANSITIONS.map(([a, b]) => `${a}>${b}`).sort());
  for (const t of TERMINAL_SESSION_STATES) assert.deepEqual([...SESSION_TRANSITIONS[t]], [], t);
});
// B2a Task 4: the v9 vocabularies in code equal the v9 seed.
const v9 = loadTs('src/main/nexus/db/v9Seed.ts');
const { ATTEMPT_TRANSITIONS, ATTEMPT_STATES, TERMINAL_ATTEMPT_STATES, canTransitionAttempt } = loadTs('src/main/nexus/exec/attemptRules.ts');
const { APPROVAL_TRANSITIONS, APPROVAL_STATUSES, TERMINAL_APPROVAL_STATUSES, canTransitionApproval } = loadTs('src/main/nexus/approvals/approvalRules.ts');
const { DEPLOYMENT_TRANSITIONS, DEPLOYMENT_STATUSES, TERMINAL_DEPLOYMENT_STATUSES, canTransitionDeployment } = loadTs('src/main/nexus/deployments/deploymentRules.ts');
function sameAsSeed(table, states, terminal, seedStates, seedMoves) {
  assert.deepEqual(flat(table), seedMoves.map(([a, b]) => `${a}>${b}`).sort());
  assert.deepEqual(Object.keys(table).sort(), seedStates.map((s) => s.state).sort());
  assert.deepEqual([...states].sort(), seedStates.map((s) => s.state).sort());
  assert.deepEqual([...terminal].sort(), seedStates.filter((s) => s.terminal === 1).map((s) => s.state).sort());
  for (const s of seedStates.filter((x) => x.terminal === 1)) assert.deepEqual([...table[s.state]], [], s.state);
}
test('the attempt table in code equals the v9 seed (7 states, 10 transitions)', () => {
  assert.equal(v9.V9_ATTEMPT_TRANSITIONS.length, 10);
  sameAsSeed(ATTEMPT_TRANSITIONS, ATTEMPT_STATES, TERMINAL_ATTEMPT_STATES, v9.V9_ATTEMPT_STATES, v9.V9_ATTEMPT_TRANSITIONS);
  assert.equal(canTransitionAttempt('starting', 'running'), true);
  assert.equal(canTransitionAttempt('starting', 'timed_out'), false);
  assert.equal(canTransitionAttempt('succeeded', 'running'), false);
});
test('the approval table in code equals the v9 seed (5 states, 4 transitions)', () => {
  assert.equal(v9.V9_APPROVAL_TRANSITIONS.length, 4);
  sameAsSeed(APPROVAL_TRANSITIONS, APPROVAL_STATUSES, TERMINAL_APPROVAL_STATUSES, v9.V9_APPROVAL_STATES, v9.V9_APPROVAL_TRANSITIONS);
  assert.equal(canTransitionApproval('pending', 'approved'), true);
  assert.equal(canTransitionApproval('approved', 'denied'), false);
});
test('the deployment table in code equals the v9 seed (5 states, 9 transitions)', () => {
  assert.equal(v9.V9_DEPLOYMENT_TRANSITIONS.length, 9);
  sameAsSeed(DEPLOYMENT_TRANSITIONS, DEPLOYMENT_STATUSES, TERMINAL_DEPLOYMENT_STATUSES, v9.V9_DEPLOYMENT_STATES, v9.V9_DEPLOYMENT_TRANSITIONS);
  assert.equal(canTransitionDeployment('starting', 'stopped'), true);
  assert.equal(canTransitionDeployment('starting', 'unhealthy'), false);
  assert.equal(canTransitionDeployment('stopped', 'healthy'), false);
});
