// test/nexus-platform-state.test.cjs
// The platform view's transitions on a nexus:participations:list answer (Task 8, fix round 1).
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const S = loadTs('src/renderer/src/nexus/data/platformState.ts');
const { primaryOf } = loadTs('src/renderer/src/nexus/workspaces/participation.ts');

const view = (id, projectId, workspaceId, isPrimary) => ({
  id, projectId, workspaceId, status: 'active', isPrimary, objective: null, source: 'backfill', createdAt: 1, updatedAt: 1
});
const OK = { ok: true, data: [view('1', 'a', 'ml', true)] };
const unavailable = (reason) => ({ ok: false, code: 'platform_unavailable', message: 'x', ...(reason ? { reason } : {}) });
const BUSY = { ok: false, code: 'platform_unavailable', message: 'The database is busy. Try again in a moment.', reason: 'busy' };
const INTERNAL = { ok: false, code: 'internal', message: 'The request could not be completed.' };
const GENERIC = 'The request could not be completed. Try again.';

const loaded = () => S.nextPlatformState(S.INITIAL_PLATFORM_VIEW, OK);

test('the initial view is legacy with nothing to say and no writes', () => {
  assert.deepEqual(S.INITIAL_PLATFORM_VIEW, { mode: 'legacy', participations: null, unavailable: null, retry: null });
  assert.equal(S.canWrite(S.INITIAL_PLATFORM_VIEW), false);
});

test('ok → db mode with the index; retry and unavailable cleared', () => {
  const prev = { mode: 'legacy', participations: null, unavailable: { reason: 'held' }, retry: { text: 'old' } };
  const s = S.nextPlatformState(prev, OK);
  assert.equal(s.mode, 'db');
  assert.equal(s.participations.mode, 'db');
  assert.equal(primaryOf(s.participations, 'a').id, 'ml');
  assert.equal(s.unavailable, null);
  assert.equal(s.retry, null);
});

test('held, startup_failed or no reason → legacy mode with no DB index', () => {
  for (const reason of ['held', 'startup_failed', 'migration_failed', null]) {
    const s = S.nextPlatformState(loaded(), unavailable(reason));
    assert.equal(s.mode, 'legacy', String(reason));
    assert.equal(s.participations, null, String(reason));
    assert.deepEqual(s.unavailable, { reason }, String(reason));
    assert.equal(s.retry, null, String(reason));
  }
});

test('busy after a DB load keeps the index and sets "try again"', () => {
  const before = loaded();
  const s = S.nextPlatformState(before, BUSY);
  assert.equal(s.mode, 'db');
  assert.equal(s.participations, before.participations);
  assert.equal(s.unavailable, null);
  assert.match(s.retry.text, /Try again/);
});

test('internal keeps the index and offers the generic retry sentence', () => {
  const before = loaded();
  const s = S.nextPlatformState(before, INTERNAL);
  assert.equal(s.mode, 'db');
  assert.equal(s.participations, before.participations);
  assert.equal(s.retry.text, GENERIC);
});

test('an unexpected refusal or handoffs_unavailable on this channel reads as the generic retry, never its own copy', () => {
  const before = loaded();
  for (const r of [
    { ok: false, code: 'denied', message: 'no' },
    { ok: false, code: 'invalid', message: 'no', reason: 'too_large' },
    { ok: false, code: 'platform_unavailable', message: 'no', reason: 'handoffs_unavailable', subReason: 'held' }
  ]) {
    const s = S.nextPlatformState(before, r);
    assert.equal(s.retry.text, GENERIC, r.code);
    assert.equal(s.mode, 'db', r.code);
    assert.equal(s.participations, before.participations, r.code);
    assert.equal(s.unavailable, null, r.code);
  }
});

test('busy while unavailable keeps the unavailable notice', () => {
  const down = S.nextPlatformState(loaded(), unavailable('held'));
  const s = S.nextPlatformState(down, BUSY);
  assert.equal(s.mode, 'legacy');
  assert.equal(s.participations, null);
  assert.deepEqual(s.unavailable, { reason: 'held' });
  assert.equal(S.canWrite(s), false);
});

test('success after busy clears retry', () => {
  const busy = S.nextPlatformState(loaded(), BUSY);
  assert.ok(busy.retry);
  const s = S.nextPlatformState(busy, OK);
  assert.equal(s.retry, null);
  assert.equal(s.mode, 'db');
});

test('canWrite is true only in db mode with nothing unavailable', () => {
  assert.equal(S.canWrite({ mode: 'db', unavailable: null }), true);
  assert.equal(S.canWrite({ mode: 'db', unavailable: { reason: 'held' } }), false);
  assert.equal(S.canWrite({ mode: 'legacy', unavailable: null }), false);
  assert.equal(S.canWrite({ mode: 'legacy', unavailable: { reason: null } }), false);
  assert.equal(S.canWrite(loaded()), true);
  assert.equal(S.canWrite(S.nextPlatformState(loaded(), BUSY)), true, 'busy keeps the database authority');
});
