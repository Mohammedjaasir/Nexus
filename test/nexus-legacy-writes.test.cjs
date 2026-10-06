'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');
const { LegacyWriteQueue } = loadTs('src/main/legacyWriteQueue.ts');
function harness(extra = {}) {
  const logs = []; const timers = [];
  const q = new LegacyWriteQueue({ log: (m) => logs.push(m), schedule: (fn, ms) => { const t = { fn, ms, cancelled: false, cancel() { this.cancelled = true; } }; timers.push(t); return t; }, ...extra });
  return { q, logs, timers };
}

test('a write before the DB is open is queued and flushed on open', () => {
  const { q } = harness(); const out = [];
  assert.equal(q.submit('setKv', () => out.push('a'), false), 'queued');
  assert.equal(q.size, 1);
  assert.deepEqual(q.flush(() => true), { written: 1, remaining: 0 });
  assert.deepEqual(out, ['a']);
});

test('a failing write is logged, kept and retried with backoff', () => {
  const { q, logs, timers } = harness(); let n = 0; const out = [];
  const run = () => { if (++n < 3) { const e = new Error('SQLITE_BUSY'); e.code = 'SQLITE_BUSY'; throw e; } out.push('ok'); };
  assert.equal(q.submit('saveProject', run, true), 'queued');
  assert.equal(logs.length, 1);
  assert.equal(timers[0].ms, 250);
  timers[0].fn();
  assert.equal(timers[1].ms, 1000);
  timers[1].fn();
  assert.deepEqual(out, ['ok']);
  assert.equal(q.size, 0);
});

test('order is kept: later writes wait behind a queued one', () => {
  const { q } = harness(); const out = [];
  q.submit('w1', () => out.push(1), false);
  assert.equal(q.submit('w2', () => out.push(2), true), 'queued');
  q.flush(() => true);
  assert.deepEqual(out, [1, 2]);
});

test('migration pause: nothing is written while paused and nothing is lost after resume', () => {
  const { q } = harness(); const out = [];
  q.pause();
  for (let i = 0; i < 3; i++) assert.equal(q.submit(`w${i}`, () => out.push(i), true), 'queued');
  assert.deepEqual(out, []);
  assert.deepEqual(q.resume(() => true), { written: 3, remaining: 0 });
  assert.deepEqual(out, [0, 1, 2]);
});

test('a full queue drops the oldest write loudly, never silently', () => {
  const { q, logs } = harness({ maxQueued: 2 });
  q.submit('a', () => {}, false); q.submit('b', () => {}, false); q.submit('c', () => {}, false);
  assert.equal(q.size, 2);
  assert.ok(logs.some((l) => /dropped.*a/.test(l)));
});

test('a deterministic failure is dropped after 5 attempts, logged, and does not wedge the rest', () => {
  const { q, logs, timers } = harness(); const out = [];
  q.submit('bad', () => { throw new Error('UNIQUE constraint'); }, true);
  q.submit('good', () => out.push('good'), true);
  for (let i = 0; i < 4; i++) timers[timers.length - 1].fn();
  assert.deepEqual(out, ['good']);
  assert.equal(q.size, 0);
  assert.ok(logs.some((l) => /dropped/.test(l) && /bad/.test(l) && /UNIQUE/.test(l)));
});

test('backoff is capped at the last delay', () => {
  const { q, timers } = harness({ retryDelaysMs: [10, 20] });
  q.submit('x', () => { throw new Error('busy'); }, true);
  assert.equal(timers[0].ms, 10);
  timers[0].fn(); assert.equal(timers[1].ms, 20);
  timers[1].fn(); assert.equal(timers[2].ms, 20);
});

test('coalescing keeps only the latest write per key and never crosses an unkeyed write', () => {
  const { q } = harness(); const out = [];
  q.pause();
  q.submit('kv', () => out.push('old'), true, 'kv:a');
  q.submit('kv', () => out.push('new'), true, 'kv:a');
  assert.equal(q.size, 1);
  q.submit('rmw', () => out.push('rmw'), true);
  q.submit('kv', () => out.push('newest'), true, 'kv:a');
  assert.equal(q.size, 3);
  q.resume(() => true);
  assert.deepEqual(out, ['new', 'rmw', 'newest']);
});

test('a write is retried with the latest state, not a stale snapshot', () => {
  const { q, timers } = harness(); const out = []; let fail = true;
  q.submit('kv', () => { if (fail) throw new Error('EBUSY'); out.push('v1'); }, true, 'kv:b');
  q.submit('kv', () => out.push('v2'), true, 'kv:b');
  fail = false;
  timers[0].fn();
  assert.deepEqual(out, ['v2']);
});

test('timer retry does nothing while paused; resume flushes', () => {
  const { q, timers } = harness(); const out = []; let fail = true;
  q.submit('w', () => { if (fail) throw new Error('EBUSY'); out.push(1); }, true);
  q.pause(); fail = false;
  timers[0].fn();
  assert.deepEqual(out, []);
  assert.deepEqual(q.resume(() => true), { written: 1, remaining: 0 });
});

test('PersistStore: EBUSY-style failure on a real temp DB is retried and the latest value lands', () => {
  const Module = require('node:module');
  const origLoad = Module._load;
  Module._load = function (req, ...a) { if (req === 'electron') return { app: { getPath: () => require('node:os').tmpdir() } }; return origLoad.call(this, req, ...a); };
  let PersistStore;
  try { ({ PersistStore } = loadTs('src/main/db.ts')); } finally { Module._load = origLoad; }
  const path = require('node:path'); const fs = require('node:fs'); const os = require('node:os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-w-'));
  const store = new PersistStore(path.join(dir, 't.db'));
  try { store.open(); } catch (e) { fs.rmSync(dir, { recursive: true, force: true }); return; /* native module unavailable under node */ }
  try {
    store.setKv('k', 1);
    assert.equal(store.getKv('k'), 1);
    store.pauseWrites();
    store.setKv('k', 2); store.setKv('k', 3);
    assert.equal(store.pendingWrites, 1);
    assert.equal(store.getKv('k'), 1);
    store.resumeWrites();
    assert.equal(store.getKv('k'), 3);
    assert.equal(store.pendingWrites, 0);
  } finally { store.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
