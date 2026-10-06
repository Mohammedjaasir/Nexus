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

function sqliteErr(code) { const e = new Error(code); e.code = code; return e; }

test('transient errors (BUSY, LOCKED, IOERR, FULL, READONLY) are never dropped by attempt count', () => {
  for (const code of ['SQLITE_BUSY', 'SQLITE_LOCKED', 'SQLITE_IOERR_WRITE', 'SQLITE_FULL', 'SQLITE_READONLY', 'EBUSY']) {
    const { q, logs, timers } = harness({ retryDelaysMs: [10, 20] }); let fail = true; const out = [];
    q.submit('w', () => { if (fail) throw sqliteErr(code); out.push(1); }, true);
    for (let i = 0; i < 12; i++) timers[timers.length - 1].fn();
    assert.equal(q.size, 1, code);
    assert.ok(!logs.some((l) => /was dropped/.test(l)), code);
    assert.equal(timers[timers.length - 1].ms, 20);
    fail = false; timers[timers.length - 1].fn();
    assert.deepEqual(out, [1]);
  }
});

test('deterministic SQLite errors (CONSTRAINT, MISMATCH, TOOBIG) are dropped after 5 attempts', () => {
  for (const code of ['SQLITE_CONSTRAINT_UNIQUE', 'SQLITE_MISMATCH', 'SQLITE_TOOBIG']) {
    const { q, logs, timers } = harness();
    q.submit('w', () => { throw sqliteErr(code); }, true);
    for (let i = 0; i < 4; i++) timers[timers.length - 1].fn();
    assert.equal(q.size, 0, code);
    assert.ok(logs.some((l) => /was dropped/.test(l)), code);
  }
});

test('coalescing keeps the attempt count so a poisoned head still reaches the drop policy', () => {
  const { q, logs, timers } = harness();
  q.submit('kv', () => { throw new Error('UNIQUE'); }, true, 'kv:z');
  for (let i = 0; i < 3; i++) {
    q.submit('kv', () => { throw new Error('UNIQUE'); }, true, 'kv:z'); // rewritten each time
    timers[timers.length - 1].fn();
  }
  timers[timers.length - 1].fn();
  assert.equal(q.size, 0);
  assert.ok(logs.some((l) => /was dropped/.test(l)));
});

// PersistStore wiring against an injected db stub (better-sqlite3 is built for Electron, so a real DB cannot load under node).
function loadStore() {
  const Module = require('node:module'); const origLoad = Module._load;
  Module._load = function (req, ...a) {
    if (req === 'electron') return { app: { getPath: () => require('node:os').tmpdir() } };
    if (req === 'better-sqlite3') return function Database() {};
    return origLoad.call(this, req, ...a);
  };
  try { return loadTs('src/main/db.ts').PersistStore; } finally { Module._load = origLoad; }
}
function fakeDb() {
  const d = { kv: {}, projects: {}, failWrites: 0, failCode: 'SQLITE_BUSY', pragmas: [], closed: false };
  const maybeFail = () => { if (d.failWrites > 0) { d.failWrites--; throw sqliteErr(d.failCode); } };
  d.pragma = (p) => { d.pragmas.push(p); };
  d.close = () => { d.closed = true; };
  d.transaction = (fn) => () => { const snap = JSON.stringify([d.kv, d.projects]); try { return fn(); } catch (e) { [d.kv, d.projects] = JSON.parse(snap); throw e; } };
  d.prepare = (sql) => ({
    run: (...a) => {
      if (/INSERT INTO kv/.test(sql)) { maybeFail(); d.kv[a[0]] = a[1]; return { changes: 1 }; }
      if (/INSERT INTO projects/.test(sql)) {
        maybeFail();
        d.projects[a[0]] = { id: a[0], name: a[1], root_path: a[2], domain_id: a[3], project_type: a[4], description: a[5], metadata_json: a[6], health_json: a[7], created_at: a[8], updated_at: a[9], last_analyzed_at: a[10] };
        return { changes: 1 };
      }
      if (/DELETE FROM projects/.test(sql)) { maybeFail(); const had = a[0] in d.projects; delete d.projects[a[0]]; return { changes: had ? 1 : 0 }; }
      throw new Error('unexpected sql ' + sql);
    },
    get: (k) => {
      if (/FROM kv/.test(sql)) return k in d.kv ? { value: d.kv[k] } : undefined;
      if (/FROM projects/.test(sql)) return d.projects[k];
      return undefined;
    },
    all: () => []
  });
  return d;
}
function project(id, name) { return { id, name, rootPath: '/x', domainId: 'software', projectType: 'app', createdAt: 1, updatedAt: 1, lastAnalyzedAt: 1 }; }
function newStore() {
  const PersistStore = loadStore(); const store = new PersistStore('unused'); const d = fakeDb(); store.db = d;
  return { store, d };
}
function captureErrors(fn) {
  const orig = console.error; const msgs = []; console.error = (...a) => msgs.push(a.map(String).join(' '));
  try { fn(msgs); } finally { console.error = orig; }
  return msgs;
}

test('PersistStore: pause/resume keeps the latest kv value and loses nothing', () => {
  const { store, d } = newStore();
  store.setKv('k', 1); assert.equal(store.getKv('k'), 1);
  store.pauseWrites(); store.setKv('k', 2); store.setKv('k', 3);
  assert.equal(store.pendingWrites, 1); assert.equal(store.getKv('k'), 1);
  store.resumeWrites();
  assert.equal(store.getKv('k'), 3); assert.equal(store.pendingWrites, 0);
  assert.equal(d.kv.k, '3');
});

test('PersistStore: a BUSY failure is queued and the retry writes the latest value', () => {
  const { store, d } = newStore();
  captureErrors(() => {
    d.failWrites = 1; store.setKv('k', 'old');
    assert.equal(store.pendingWrites, 1);
    store.setKv('k', 'new');
    assert.equal(store.pendingWrites, 1);
    store.resumeWrites();
  });
  assert.equal(d.kv.k, '"new"');
});

test('PersistStore: close() with pending writes names what was lost, and lowers busy_timeout first', () => {
  const { store, d } = newStore();
  const msgs = captureErrors(() => {
    d.failWrites = 100; store.setKv('window.bounds', { x: 1 }); store.saveProject(project('p1', 'A'));
    store.close();
  });
  assert.ok(d.pragmas.includes('busy_timeout = 500'));
  assert.ok(msgs.some((m) => /unsaved/.test(m) && /setKv:window\.bounds/.test(m) && /saveProject:p1/.test(m)), msgs.join('\n'));
  assert.ok(d.closed);
  const after = captureErrors(() => store.setKv('late', 1));
  assert.ok(after.some((m) => /after close/.test(m) && /setKv:late/.test(m)));
});

test('PersistStore: a queued updateProject re-reads the latest row when retried', () => {
  const { store, d } = newStore();
  store.saveProject(project('p1', 'A'));
  captureErrors(() => {
    d.failWrites = 1;
    store.updateProject('p1', { description: 'patched' });
    assert.equal(store.pendingWrites, 1);
    d.projects.p1.name = 'Changed'; // another writer changes the row while the update is queued
    store.resumeWrites();
  });
  assert.equal(d.projects.p1.name, 'Changed');
  assert.equal(d.projects.p1.description, 'patched');
});

test('PersistStore: deleteProject then updateProject on the same id keeps order', () => {
  const { store, d } = newStore();
  store.saveProject(project('p1', 'A'));
  captureErrors(() => {
    d.failWrites = 1;
    store.deleteProject('p1');
    store.updateProject('p1', { name: 'B' });
    assert.equal(store.pendingWrites, 2);
    store.resumeWrites();
  });
  assert.equal(d.projects.p1, undefined); // delete ran first, so the update found nothing
});

test('PersistStore: deleteProject resets the active project in the same transaction', () => {
  const { store, d } = newStore();
  store.saveProject(project('p1', 'A')); store.setActiveProjectId('p1');
  assert.equal(store.deleteProject('p1'), true);
  assert.equal(d.kv.active_project_id, 'null');
});
