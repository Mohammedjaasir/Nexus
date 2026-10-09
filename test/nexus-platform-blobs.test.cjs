'use strict';
// B2a Task 6: the blob index (real SQLite at v9, enableV9 on a fixture), the GC lock, and the confined data home (temp folders).
const h = require('./helpers/sqlite.cjs');
if (!h.realSqliteOrSkip()) return;
// B2a Task 10 fix round 3: every store and raw handle this file opens is closed, and its temp dirs removed, by one after hook.
const C = require('./helpers/cleanup.cjs'); C.cleanupAfterAll();
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');
const { PersistStore: PersistStoreUntracked } = loadTs('src/main/db.ts');
/** Every store this file opens is tracked: the cleanup hook closes it even when a test fails before its own close(). */
class PersistStore extends PersistStoreUntracked { constructor(...a) { super(...a); C.track(this); } }
const { createNexusPlatform } = loadTs('src/main/nexus/platform.ts');
const { V9_DDL } = loadTs('src/main/nexus/db/schemaV9.ts');
const { newId } = loadTs('src/main/nexus/db/ids.ts');
const B = loadTs('src/main/nexus/blobs/blobIndex.ts');
const D = loadTs('src/main/nexusExec/dataHome.ts');

const DAY = 24 * 60 * 60 * 1000;
const SHA = (c) => c.repeat(64);
const blob = (c, bytes = 10) => ({ sha256: SHA(c), bytes, mediaType: 'application/octet-stream' });

function setup() {
  const { file } = h.v6Fixture(); const s = new PersistStore(file);
  s.open({ log: () => {}, backupDir: path.join(path.dirname(file), 'b'), now: () => h.NOW, enableV9: true });
  assert.equal(s.platformDatabase().pragma('user_version', { simple: true }), 9);
  const db = s.platformDatabase();
  const clock = { t: h.NOW };
  const nx = createNexusPlatform(db, { now: () => clock.t });
  const bi = new B.BlobIndex(db, { auth: nx.auth, now: () => clock.t });
  return { s, db, nx, bi, clock, me: nx.principals.localUser(), sys: nx.principals.system() };
}
function draft(nx, me, name = 'r') {
  const a = nx.artifacts.create(me, { projectId: 'p-ledger', workspaceId: 'sde', kind: 'report', name });
  return nx.artifacts.registerVersion(me, { artifactId: a.id, storage: { kind: 'inline', json: { name } } }).version;
}
const NODEL = async () => ({ failed: [] });
const rejectsCode = async (p, code, reason) => {
  await assert.rejects(p, (e) => e.code === code && (reason === undefined || e.detail?.reason === reason));
};

test('B1: record and attach on a draft; attach to a candidate is refused as immutable (the database trigger, through the service)', async () => {
  const { s, db, nx, bi, me, sys } = setup();
  const v = draft(nx, me);
  await bi.withIngestLock((t) => {
    assert.deepEqual(bi.recordBlobsTx(t, [blob('a'), blob('b', 20)]), { inserted: 2, touched: 0 });
    assert.deepEqual(bi.attachTx(t, v.id, [{ sha256: SHA('a'), role: 'content' }, { sha256: SHA('b'), role: 'file', path: 'dist/app.js' }]), { attached: 2 });
    assert.deepEqual(bi.attachTx(t, v.id, [{ sha256: SHA('a'), role: 'content' }]), { attached: 0 });       // idempotent
  });
  assert.equal(bi.isReferenced(SHA('a')), true); assert.equal(bi.isReferenced(SHA('c')), false);
  assert.deepEqual(db.prepare('SELECT sha256, role, path FROM version_blobs WHERE version_id = ? ORDER BY role').all(v.id).map((r) => ({ ...r })),
    [{ sha256: SHA('a'), role: 'content', path: '' }, { sha256: SHA('b'), role: 'file', path: 'dist/app.js' }]);
  nx.artifacts.finalize(sys, v.id, 'candidate');
  await bi.withIngestLock((t) => {
    bi.recordBlobsTx(t, [blob('c')]);
    assert.throws(() => bi.attachTx(t, v.id, [{ sha256: SHA('c'), role: 'content' }]), (e) => e.code === 'immutable');
    assert.throws(() => bi.attachTx(t, 'no-such-version', [{ sha256: SHA('c'), role: 'content' }]), (e) => e.code === 'not_found');
    assert.throws(() => bi.attachTx(t, draft(nx, me, 'd2').id, [{ sha256: SHA('d'), role: 'content' }]), (e) => e.code === 'invalid');  // not recorded
    for (const bad of ['../x', 'a/../b', '/abs', 'a\\b', 'a\0b', 'a//b'])
      assert.throws(() => bi.attachTx(t, v.id, [{ sha256: SHA('c'), role: 'file', path: bad }]), (e) => e.code === 'invalid', JSON.stringify(bad));
    assert.throws(() => bi.attachTx(t, v.id, [{ sha256: SHA('c'), role: 'binary' }]), (e) => e.code === 'invalid');
  });
  // The database refuses directly too.
  assert.throws(() => db.prepare("INSERT INTO version_blobs (version_id, sha256, role) VALUES (?, ?, 'content')").run(v.id, SHA('c')), /only while it is a draft/);
  // Writes outside the ingest lock are refused (see also the token test).
  assert.throws(() => bi.recordBlobsTx(undefined, [blob('e')]), (e) => e.code === 'conflict' && e.detail.reason === 'lock_not_held');
  assert.throws(() => bi.attachTx({ ingest: true }, v.id, [{ sha256: SHA('a'), role: 'content' }]), (e) => e.code === 'conflict');
  // Input validation.
  await bi.withIngestLock((t) => {
    for (const bad of [{ sha256: 'A'.repeat(64), bytes: 1, mediaType: 'x/y' }, { sha256: SHA('f'), bytes: -1, mediaType: 'x/y' },
      { sha256: SHA('f'), bytes: 1, mediaType: 'x' }, { sha256: SHA('f').slice(1), bytes: 1, mediaType: 'x/y' }])
      assert.throws(() => bi.recordBlobsTx(t, [bad]), (e) => e.code === 'invalid', JSON.stringify(bad));
  });
  s.close();
});

test('B2: the same bytes twice are one blob and last_referenced_at moves forward; a size mismatch is a conflict', async () => {
  const { s, db, bi, clock } = setup();
  await bi.withIngestLock((t) => bi.recordBlobsTx(t, [blob('a')]));
  clock.t += 5000;
  await bi.withIngestLock((t) => assert.deepEqual(bi.recordBlobsTx(t, [blob('a'), blob('a')]), { inserted: 0, touched: 1 }));
  assert.equal(h.count(db, 'blobs'), 1);
  const row = db.prepare('SELECT * FROM blobs').get();
  assert.equal(row.created_at, h.NOW); assert.equal(row.last_referenced_at, h.NOW + 5000);
  await bi.withIngestLock((t) => {
    assert.throws(() => bi.recordBlobsTx(t, [blob('a', 11)]), (e) => e.code === 'conflict' && e.detail.reason === 'size_mismatch');
    assert.throws(() => bi.recordBlobsTx(t, [blob('b', 1), blob('b', 2)]), (e) => e.code === 'conflict');
  });
  assert.equal(h.count(db, 'blobs'), 1);
  // A failed record rolls back as a whole (savepoint semantics).
  await bi.withIngestLock((t) => assert.throws(() => bi.recordBlobsTx(t, [blob('c'), blob('a', 99)]), (e) => e.code === 'conflict'));
  assert.equal(h.count(db, 'blobs'), 1);
  // The method joins a caller's transaction as a savepoint.
  await bi.withIngestLock((t) => db.transaction(() => { bi.recordBlobsTx(t, [blob('d')]); })());
  assert.equal(h.count(db, 'blobs'), 2);
  s.close();
});

test('B3: the dry run lists only unreferenced blobs older than 24 h; the candidates hash is stable', async () => {
  const { s, nx, bi, me, clock } = setup();
  const v = draft(nx, me);
  await bi.withIngestLock((t) => { bi.recordBlobsTx(t, [blob('a'), blob('b'), blob('c', 7)]); bi.attachTx(t, v.id, [{ sha256: SHA('b'), role: 'content' }]); });
  clock.t = h.NOW + DAY / 2;
  await bi.withIngestLock((t) => bi.recordBlobsTx(t, [blob('d')]));        // young
  assert.deepEqual(bi.gcCandidates().candidates, []);
  clock.t = h.NOW + DAY;                                               // exactly 24 h: not yet older
  assert.deepEqual(bi.gcCandidates().candidates, []);
  clock.t = h.NOW + DAY + 1;
  const dry = bi.gcCandidates();
  assert.deepEqual(dry.candidates.map((c) => c.sha256), [SHA('a'), SHA('c')]);
  assert.equal(dry.totalBytes, 17); assert.equal(dry.liveAttempts, 0);
  assert.match(dry.candidatesHash, /^[0-9a-f]{64}$/);
  assert.equal(bi.gcCandidates().candidatesHash, dry.candidatesHash);
  assert.equal(B.candidatesHash([...dry.candidates].reverse()), dry.candidatesHash, 'order-free');
  assert.notEqual(B.candidatesHash(dry.candidates.slice(1)), dry.candidatesHash);
  assert.notEqual(B.candidatesHash([{ ...dry.candidates[0], lastReferencedAt: 1 }, dry.candidates[1]]), dry.candidatesHash);
  assert.equal(B.candidatesHash([]), bi.candidatesHash([]));
  s.close();
});

test('B4: apply with a stale hash is a conflict; the right hash removes rows and returns the shas; referenced blobs are never removed', async () => {
  const { s, db, nx, bi, me, sys, clock } = setup();
  const v = draft(nx, me);
  await bi.withIngestLock((t) => { bi.recordBlobsTx(t, [blob('a'), blob('b'), blob('c')]); bi.attachTx(t, v.id, [{ sha256: SHA('b'), role: 'content' }]); });
  clock.t = h.NOW + DAY + 1;
  const dry = bi.gcCandidates();
  // The list changes between the dry run and the apply: a candidate is touched by a new ingest.
  await bi.withIngestLock((t) => bi.recordBlobsTx(t, [blob('c')]));
  await rejectsCode(bi.gcApply(me, dry.candidatesHash, NODEL), 'conflict', 'stale');
  await rejectsCode(bi.gcApply(me, 'not-a-hash', NODEL), 'invalid');
  await rejectsCode(bi.gcApply(me, dry.candidatesHash), 'invalid');            // deleteObjects is required
  assert.equal(h.count(db, 'blobs'), 3);
  const dry2 = bi.gcCandidates();
  assert.deepEqual(dry2.candidates.map((c) => c.sha256), [SHA('a')]);
  const deleted = [];
  const actBefore = h.count(db, 'activity');
  const out = await bi.gcApply(me, dry2.candidatesHash, async (shas) => { assert.equal(bi.isExclusiveHeld(), true); deleted.push(...shas); return { failed: [] }; });
  assert.deepEqual(out, { removedShas: [SHA('a')], fileDeleteFailed: [] }); assert.deepEqual(deleted, [SHA('a')]);
  assert.equal(bi.lock.exclusiveHeld, false);
  assert.deepEqual(db.prepare('SELECT sha256 FROM blobs ORDER BY sha256').all().map((r) => r.sha256), [SHA('b'), SHA('c')]);
  assert.equal(h.count(db, 'activity'), actBefore + 2);
  const acts = db.prepare('SELECT * FROM activity ORDER BY seq DESC LIMIT 2').all().reverse();
  assert.deepEqual(acts.map((a) => [a.action, a.status, a.actor_id]), [['blob.gc', 'started', me.id], ['blob.gc', 'succeeded', me.id]]);
  assert.deepEqual(JSON.parse(acts[0].details_json), { removed: 1, bytes: 10 });
  assert.deepEqual(JSON.parse(acts[1].details_json), { removed: 1, fileDeleteFailed: 0 });
  // A referenced blob is never a candidate, however old, and the trigger blocks a forced delete.
  clock.t = h.NOW + 100 * DAY;
  assert.ok(!bi.gcCandidates().candidates.some((c) => c.sha256 === SHA('b')));
  assert.throws(() => db.prepare('DELETE FROM blobs WHERE sha256 = ?').run(SHA('b')), /held by a version is never deleted/);
  // An empty list applies cleanly with its own hash; a principal that is not a user or the system is refused.
  const sys2 = await bi.gcApply(sys, bi.gcCandidates().candidatesHash, NODEL);
  assert.deepEqual(sys2.removedShas, [SHA('c')]);
  assert.deepEqual((await bi.gcApply(sys, B.candidatesHash([]), NODEL)).removedShas, []);
  await rejectsCode(bi.gcApply({ id: 'agent:x', kind: 'agent', displayName: 'x' }, B.candidatesHash([]), NODEL), 'denied');
  assert.equal(bi.isReferenced(SHA('b')), true);
  s.close();
});

test('B5: apply while an ingest holds the shared lock is a conflict; a second GC is a conflict; ingest waits for GC; GC refuses while an attempt is live', async () => {
  const { s, db, nx, bi, me, sys, clock } = setup();
  await bi.withIngestLock((t) => bi.recordBlobsTx(t, [blob('a')]));
  clock.t = h.NOW + DAY + 1;
  const dry = bi.gcCandidates();
  let open; const gate = new Promise((r) => { open = r; });
  const ingest = bi.withIngestLock(async () => { await gate; return 'ingested'; });
  await new Promise((r) => setImmediate(r));
  assert.equal(bi.lock.sharedHolders, 1);
  await rejectsCode(bi.gcApply(me, dry.candidatesHash, NODEL), 'conflict', 'busy');
  open(); assert.equal(await ingest, 'ingested');
  assert.equal(h.count(db, 'blobs'), 1, 'nothing was removed while the ingest held the lock');
  // While a GC holds the lock: a second GC is refused at once, and a new ingest waits until the GC releases.
  let release; const slow = new Promise((r) => { release = r; });
  const order = [];
  const gc = bi.gcApply(me, dry.candidatesHash, async () => { order.push('gc-delete-start'); await slow; order.push('gc-delete-end'); return { failed: [] }; });
  await new Promise((r) => setImmediate(r));
  await rejectsCode(bi.gcApply(me, dry.candidatesHash, NODEL), 'conflict', 'busy');
  const waiting = bi.withIngestLock((t) => { order.push('ingest'); });
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(order, ['gc-delete-start']);
  release(); await gc; await waiting;
  assert.deepEqual(order, ['gc-delete-start', 'gc-delete-end', 'ingest']);
  // A live attempt blocks GC (checked under the lock), and the lock is released after the refusal.
  await bi.withIngestLock((t) => bi.recordBlobsTx(t, [blob('b')]));
  clock.t += DAY + 1;
  const job = nx.jobs.create(me, { kind: 'tool.run', projectId: 'p-ledger', workspaceId: 'sde', idempotencyKey: 'gc-live' }).job;
  nx.jobs.transition(sys, job.id, 'leased');
  const BOOT = newId(h.NOW);
  db.prepare(`INSERT INTO job_attempts (id, job_id, n, state, boot_id, lease_owner, lease_expires_at, created_at, updated_at)
    VALUES (?, ?, 1, 'starting', ?, ?, ?, ?, ?)`).run(newId(h.NOW), job.id, BOOT, BOOT, clock.t + 60_000, clock.t, clock.t);
  const live = bi.gcCandidates();
  assert.equal(live.liveAttempts, 1);
  await rejectsCode(bi.gcApply(me, live.candidatesHash, NODEL), 'conflict', 'attempts_live');
  assert.equal(bi.lock.exclusiveHeld, false);
  assert.equal(h.count(db, 'blobs'), 1);
  s.close();
});

// ---------- the data home (temp folders only) ----------

test('B6: confineToDataHome refuses .., absolute paths, NUL, devices, streams, trailing dots and spaces, and links or junctions', async () => {
  const userData = h.tmpDir('nx-home-');
  const outside = h.tmpDir('nx-outside-');
  const home = D.resolveDataHome(userData);
  assert.equal(home.root, path.join(userData, 'nexus'));
  await home.ensure();
  for (const d of ['objects/tmp', 'logs/jobs', 'logs/images', 'work']) assert.ok(fs.statSync(path.join(home.root, d)).isDirectory(), d);
  const realRoot = fs.realpathSync(home.root);
  assert.equal(await home.confineToDataHome('work/J1/1/out/a.txt'), path.join(realRoot, 'work', 'J1', '1', 'out', 'a.txt'));
  assert.equal(await home.confineToDataHome('logs\\jobs\\x.log'), path.join(realRoot, 'logs', 'jobs', 'x.log'));
  const refused = ['', '..', '../x', 'work/../../x', 'work/..', '/etc/passwd', '\\\\server\\share\\x', 'C:\\x', 'C:x', '\\\\?\\C:\\x',
    'a\0b', 'work/con', 'work/NUL.txt', 'work/com1', 'logs/a.log:secret', 'logs/a.log::$DATA', 'work/a.', 'work/a ', 'work/dir./x',
    outside, path.join(outside, 'x')];
  for (const r of refused) assert.equal(await home.confineToDataHome(r), null, JSON.stringify(r));
  // A junction (and a directory symlink when the OS allows one) that leads outside is refused, and so is a link inside.
  fs.symlinkSync(outside, path.join(home.root, 'work', 'jout'), 'junction');
  assert.equal(await home.confineToDataHome('work/jout'), null);
  assert.equal(await home.confineToDataHome('work/jout/x.txt'), null);
  fs.symlinkSync(path.join(home.root, 'logs'), path.join(home.root, 'work', 'jin'), 'junction');
  assert.equal(await home.confineToDataHome('work/jin/jobs'), null, 'a link is refused even when it points inside');
  let fileLink = true;
  try { fs.symlinkSync(path.join(outside, 'f'), path.join(home.root, 'work', 'flink')); } catch { fileLink = false; }
  if (fileLink) assert.equal(await home.confineToDataHome('work/flink'), null);   // a dangling file symlink
  // A file in the middle of the path is refused; a missing tail under a real folder is allowed.
  fs.writeFileSync(path.join(home.root, 'work', 'f.txt'), 'x');
  assert.equal(await home.confineToDataHome('work/f.txt/x'), null);
  assert.equal(await home.confineToDataHome('work/f.txt'), path.join(realRoot, 'work', 'f.txt'));
  // A data home that is itself a junction is refused.
  const ud2 = h.tmpDir('nx-home2-');
  fs.symlinkSync(outside, path.join(ud2, 'nexus'), 'junction');
  assert.equal(await D.resolveDataHome(ud2).confineToDataHome('work/x'), null);
  await assert.rejects(D.resolveDataHome(ud2).ensure(), (e) => e.code === 'invalid');
  // Paths main derives.
  const sha = 'ab' + 'c'.repeat(62);
  assert.equal(home.objectRel(sha), `objects/ab/${'c'.repeat(62)}`);
  assert.equal(await home.objectPath(sha), path.join(realRoot, 'objects', 'ab', 'c'.repeat(62)));
  assert.throws(() => home.objectRel('AB' + 'c'.repeat(62)), (e) => e.code === 'invalid');
  assert.throws(() => home.objectRel('../x'), (e) => e.code === 'invalid');
  assert.equal(await home.attemptWorkDir('J1', 2), path.join(realRoot, 'work', 'J1', '2'));
  for (const [id, n] of [['../x', 1], ['a/b', 1], ['a.b', 1], ['', 1], ['J1', 0], ['J1', 1.5], ['J1', -1], ['x'.repeat(65), 1]])
    assert.throws(() => home.attemptWorkRel(id, n), (e) => e.code === 'invalid', `${id}/${n}`);
  // A derived path behind a link is refused, not followed.
  fs.symlinkSync(outside, path.join(home.root, 'work', 'JX'), 'junction');
  assert.equal(await home.attemptWorkDir('JX', 1), null);
  assert.throws(() => home.attemptLogPath('con', 1), (e) => e.code === 'invalid');
  assert.equal(home.imageLogPath('B1'), 'logs/images/B1.log');
  assert.throws(() => D.resolveDataHome('relative/dir'), (e) => e.code === 'invalid');
  assert.throws(() => D.resolveDataHome('C:\\a\0b'), (e) => e.code === 'invalid');
  // Free space is measured with statfs, also for a folder that does not exist yet.
  const free = await home.freeBytesAt();
  assert.ok(Number.isFinite(free) && free > 0, String(free));
  assert.ok((await home.freeBytesAt(path.join(home.root, 'not', 'yet'))) > 0);
  assert.equal(await home.freeBytesAt('relative'), null);
});

test('B7: attemptLogPath always satisfies the DDL CHECK on log_path (1,000 generated ids, checked by SQLite itself)', () => {
  const m = V9_DDL.match(/CREATE TABLE IF NOT EXISTS job_attempts \([\s\S]*?\n  (log_path\s+TEXT CHECK \([\s\S]*?'%\\%'\)\)),/);
  assert.ok(m, 'the log_path column definition was found in V9_DDL');
  const db = C.openRaw(path.join(h.tmpDir('nx-logcheck-'), 'x.db'));
  db.exec(`CREATE TABLE t (${m[1]})`);
  const ins = db.prepare('INSERT INTO t (log_path) VALUES (?)');
  for (const bad of ['/abs.log', 'C:/x.log', 'a/../b.log', 'a\\b.log']) assert.throws(() => ins.run(bad), /CHECK/, bad);
  const home = D.resolveDataHome(h.tmpDir('nx-home-'));
  const ALPH = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz_-';
  let seed = 7;
  const rnd = (k) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % k; };
  for (let i = 0; i < 1000; i++) {
    const id = i % 2 === 0 ? newId(h.NOW + i) : Array.from({ length: 1 + rnd(64) }, () => ALPH[rnd(ALPH.length)]).join('');
    const n = 1 + rnd(i % 10 === 0 ? D.MAX_ATTEMPT_N : 50);
    let rel;
    try { rel = home.attemptLogPath(id, n); } catch (e) {
      // Only a reserved device name may be refused among generated plain ids.
      assert.match(id, /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i, id); continue;
    }
    assert.equal(rel, `logs/jobs/${id}/${n}.log`);
    assert.ok(D.satisfiesLogPathCheck(rel), rel);
    ins.run(rel);
  }
  assert.ok(db.prepare('SELECT COUNT(*) AS n FROM t').get().n >= 990);
  db.close();
});

// ---------- fix round 1 ----------

test('F1: blob writes need a live token of this index: no exported row writers, no stale, foreign or borrowed-lock writes', async () => {
  const { s, db, nx, bi, clock } = setup();
  for (const k of ['recordBlobsTx', 'attachBlobsTx', 'writeBlobRows', 'writeVersionBlobRows']) assert.equal(B[k], undefined, k);
  let kept;
  await bi.withIngestLock((t) => { kept = t; bi.recordBlobsTx(t, [blob('a')]); });
  assert.throws(() => bi.recordBlobsTx(kept, [blob('b')]), (e) => e.code === 'conflict' && e.detail.reason === 'lock_not_held', 'a token dies with its callback');
  // Another ingest holds the shared lock: a write without the caller's own live token is still refused.
  let open; const gate = new Promise((r) => { open = r; });
  const other = bi.withIngestLock(async () => { await gate; });
  await new Promise((r) => setImmediate(r));
  assert.equal(bi.lock.sharedHolders, 1);
  assert.throws(() => bi.recordBlobsTx(kept, [blob('b')]), (e) => e.code === 'conflict');
  assert.throws(() => bi.recordBlobsTx(Object.freeze({ ingest: true }), [blob('b')]), (e) => e.code === 'conflict');
  open(); await other;
  // A token of another index (its own lock) is refused here.
  const bi2 = new B.BlobIndex(db, { auth: nx.auth, now: () => clock.t });
  await bi2.withIngestLock((t2) => assert.throws(() => bi.recordBlobsTx(t2, [blob('b')]), (e) => e.code === 'conflict'));
  assert.equal(h.count(db, 'blobs'), 1);
  assert.equal(bi.isExclusiveHeld(), false);
  s.close();
});

test('F2: a failed file delete is reported truthfully: result and a failed blob.gc activity row', async () => {
  const { s, db, bi, me, clock } = setup();
  await bi.withIngestLock((t) => bi.recordBlobsTx(t, [blob('a'), blob('b'), blob('c')]));
  clock.t = h.NOW + DAY + 1;
  const last = () => db.prepare("SELECT status, details_json FROM activity WHERE action = 'blob.gc' ORDER BY seq DESC LIMIT 1").get();
  // The delete reports one failure.
  let dry = bi.gcCandidates();
  let r = await bi.gcApply(me, dry.candidatesHash, async (shas) => ({ failed: [shas[1]] }));
  assert.deepEqual(r, { removedShas: [SHA('a'), SHA('b'), SHA('c')], fileDeleteFailed: [SHA('b')] });
  assert.equal(last().status, 'failed'); assert.deepEqual(JSON.parse(last().details_json), { removed: 3, fileDeleteFailed: 1 });
  assert.equal(bi.isExclusiveHeld(), false);
  // The delete throws: every removed sha is reported, the lock is released.
  await bi.withIngestLock((t) => bi.recordBlobsTx(t, [blob('d'), blob('e')]));
  clock.t += DAY + 1;
  dry = bi.gcCandidates();
  r = await bi.gcApply(me, dry.candidatesHash, async () => { throw new Error('disk gone'); });
  assert.deepEqual(r.fileDeleteFailed, [SHA('d'), SHA('e')]);
  assert.equal(last().status, 'failed'); assert.deepEqual(JSON.parse(last().details_json), { removed: 2, fileDeleteFailed: 2 });
  assert.equal(bi.isExclusiveHeld(), false);
  s.close();
});

test('F3: gcApply authorizes blob.gc first; a viewer or a principal without membership is denied and audited, nothing changes', async () => {
  const { s, db, bi, clock } = setup();
  db.prepare("INSERT INTO principals (id,kind,display_name,disabled_at,created_at) VALUES ('user:viewer','user','Viewer',NULL,1)").run();
  db.prepare("INSERT INTO memberships (principal_id,scope_type,scope_id,role,created_at) VALUES ('user:viewer','platform','*','viewer',1)").run();
  db.prepare("INSERT INTO principals (id,kind,display_name,disabled_at,created_at) VALUES ('user:nobody','user','Nobody',NULL,1)").run();
  await bi.withIngestLock((t) => bi.recordBlobsTx(t, [blob('a')]));
  clock.t = h.NOW + DAY + 1;
  const dry = bi.gcCandidates();
  let called = 0;
  for (const [id, reason] of [['user:viewer', 'role'], ['user:nobody', 'no_membership']]) {
    const before = h.count(db, 'activity');
    await assert.rejects(bi.gcApply({ id, kind: 'user', displayName: id }, dry.candidatesHash, async () => { called++; return { failed: [] }; }),
      (e) => e.code === 'denied' && e.detail.reason === reason && e.detail.audited === true);
    assert.equal(h.count(db, 'activity'), before + 1);
    const row = db.prepare('SELECT * FROM activity ORDER BY seq DESC LIMIT 1').get();
    assert.equal(row.action, 'blob.gc'); assert.equal(row.status, 'denied'); assert.equal(row.actor_id, id);
  }
  assert.equal(called, 0); assert.equal(h.count(db, 'blobs'), 1); assert.equal(bi.isExclusiveHeld(), false);
  const { decide, ADMIN_ACTIONS } = loadTs('src/main/nexus/auth/policy.ts');
  assert.ok(ADMIN_ACTIONS.includes('blob.gc'));
  assert.equal(decide({ principal: { id: 'system', kind: 'system', displayName: 's' }, roles: ['admin'], action: 'blob.gc' }).allowed, true);
  assert.deepEqual(decide({ principal: { id: 'u', kind: 'user', displayName: 'u' }, roles: ['member'], action: 'blob.gc' }), { allowed: false, reason: 'role', needed: 'admin' });
  s.close();
});

test('F4: ensure() never creates anything outside: a junction at nexus/objects, a data home that is a junction', async () => {
  const outside = h.tmpDir('nx-outside-');
  const listing = () => fs.readdirSync(outside);
  // nexus/objects is a junction to a folder outside.
  const ud = h.tmpDir('nx-home-');
  fs.mkdirSync(path.join(ud, 'nexus'));
  fs.symlinkSync(outside, path.join(ud, 'nexus', 'objects'), 'junction');
  const home = D.resolveDataHome(ud);
  await assert.rejects(home.ensure(), (e) => e.code === 'invalid');
  assert.deepEqual(listing(), [], 'no tmp folder was created through the junction');
  assert.equal(await home.objectPath(SHA('a')), null);
  // The data home itself is a junction.
  const ud2 = h.tmpDir('nx-home2-');
  fs.symlinkSync(outside, path.join(ud2, 'nexus'), 'junction');
  await assert.rejects(D.resolveDataHome(ud2).ensure(), (e) => e.code === 'invalid');
  assert.deepEqual(listing(), []);
  // A file where a layout folder belongs is refused too; a clean home is created and re-ensured idempotently.
  const ud3 = h.tmpDir('nx-home3-');
  fs.mkdirSync(path.join(ud3, 'nexus')); fs.writeFileSync(path.join(ud3, 'nexus', 'work'), 'x');
  await assert.rejects(D.resolveDataHome(ud3).ensure(), (e) => e.code === 'invalid');
  const ud4 = path.join(h.tmpDir('nx-home4-'), 'not-yet');
  const h4 = D.resolveDataHome(ud4);
  await h4.ensure(); await h4.ensure();
  for (const d of ['objects/tmp', 'logs/jobs', 'logs/images', 'work']) assert.ok(fs.lstatSync(path.join(h4.root, d)).isDirectory(), d);
});

test('F5: a hard-linked file is refused by confinement; the GC file delete uses confined paths only', async () => {
  const home = D.resolveDataHome(h.tmpDir('nx-home-'));
  await home.ensure();
  const realRoot = fs.realpathSync(home.root);
  const f = path.join(home.root, 'work', 'one.txt');
  fs.writeFileSync(f, 'x');
  assert.equal(await home.confineToDataHome('work/one.txt'), path.join(realRoot, 'work', 'one.txt'));
  fs.linkSync(f, path.join(home.root, 'work', 'two.txt'));
  assert.equal(await home.confineToDataHome('work/one.txt'), null);
  assert.equal(await home.confineToDataHome('work/two.txt'), null);
  // deleteObjectFiles: a normal object goes, a missing one counts as gone, a hard-linked one and one behind a junction are refused.
  const put = (sha) => {
    const dir = path.join(home.root, 'objects', sha.slice(0, 2)); fs.mkdirSync(dir, { recursive: true });
    const p = path.join(dir, sha.slice(2)); fs.writeFileSync(p, sha); return p;
  };
  const okFile = put(SHA('a'));
  const linked = put(SHA('b')); fs.linkSync(linked, path.join(home.root, 'work', 'b-copy'));
  const outside = h.tmpDir('nx-outside-');
  fs.writeFileSync(path.join(outside, 'd'.repeat(62)), 'keep');
  fs.symlinkSync(outside, path.join(home.root, 'objects', 'dd'), 'junction');
  const r = await D.deleteObjectFiles(home, [SHA('a'), SHA('b'), SHA('c'), SHA('d'), 'not-a-sha']);
  assert.deepEqual(r.failed, [SHA('b'), SHA('d'), 'not-a-sha']);
  assert.equal(fs.existsSync(okFile), false);
  assert.equal(fs.existsSync(linked), true);
  assert.equal(fs.readFileSync(path.join(outside, 'd'.repeat(62)), 'utf8'), 'keep', 'nothing outside was deleted');
});
