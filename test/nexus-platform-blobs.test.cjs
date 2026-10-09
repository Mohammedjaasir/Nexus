'use strict';
// B2a Task 6: the blob index (real SQLite at v9, enableV9 on a fixture), the GC lock, and the confined data home (temp folders).
const h = require('./helpers/sqlite.cjs');
if (!h.realSqliteOrSkip()) return;
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');
const { PersistStore } = loadTs('src/main/db.ts');
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
  const bi = new B.BlobIndex(db, { now: () => clock.t });
  return { s, db, nx, bi, clock, me: nx.principals.localUser(), sys: nx.principals.system() };
}
function draft(nx, me, name = 'r') {
  const a = nx.artifacts.create(me, { projectId: 'p-ledger', workspaceId: 'sde', kind: 'report', name });
  return nx.artifacts.registerVersion(me, { artifactId: a.id, storage: { kind: 'inline', json: { name } } }).version;
}
const rejectsCode = async (p, code, reason) => {
  await assert.rejects(p, (e) => e.code === code && (reason === undefined || e.detail?.reason === reason));
};

test('B1: record and attach on a draft; attach to a candidate is refused as immutable (the database trigger, through the service)', async () => {
  const { s, db, nx, bi, me, sys } = setup();
  const v = draft(nx, me);
  await bi.withIngestLock(() => {
    assert.deepEqual(bi.recordBlobsTx([blob('a'), blob('b', 20)]), { inserted: 2, touched: 0 });
    assert.deepEqual(bi.attachTx(v.id, [{ sha256: SHA('a'), role: 'content' }, { sha256: SHA('b'), role: 'file', path: 'dist/app.js' }]), { attached: 2 });
    assert.deepEqual(bi.attachTx(v.id, [{ sha256: SHA('a'), role: 'content' }]), { attached: 0 });       // idempotent
  });
  assert.equal(bi.isReferenced(SHA('a')), true); assert.equal(bi.isReferenced(SHA('c')), false);
  assert.deepEqual(db.prepare('SELECT sha256, role, path FROM version_blobs WHERE version_id = ? ORDER BY role').all(v.id).map((r) => ({ ...r })),
    [{ sha256: SHA('a'), role: 'content', path: '' }, { sha256: SHA('b'), role: 'file', path: 'dist/app.js' }]);
  nx.artifacts.finalize(sys, v.id, 'candidate');
  await bi.withIngestLock(() => {
    bi.recordBlobsTx([blob('c')]);
    assert.throws(() => bi.attachTx(v.id, [{ sha256: SHA('c'), role: 'content' }]), (e) => e.code === 'immutable');
    assert.throws(() => bi.attachTx('no-such-version', [{ sha256: SHA('c'), role: 'content' }]), (e) => e.code === 'not_found');
    assert.throws(() => bi.attachTx(draft(nx, me, 'd2').id, [{ sha256: SHA('d'), role: 'content' }]), (e) => e.code === 'invalid');  // not recorded
    for (const bad of ['../x', 'a/../b', '/abs', 'a\\b', 'a\0b', 'a//b'])
      assert.throws(() => bi.attachTx(v.id, [{ sha256: SHA('c'), role: 'file', path: bad }]), (e) => e.code === 'invalid', JSON.stringify(bad));
    assert.throws(() => bi.attachTx(v.id, [{ sha256: SHA('c'), role: 'binary' }]), (e) => e.code === 'invalid');
  });
  // The database refuses directly too.
  assert.throws(() => db.prepare("INSERT INTO version_blobs (version_id, sha256, role) VALUES (?, ?, 'content')").run(v.id, SHA('c')), /only while it is a draft/);
  // Writes outside the ingest lock are refused.
  assert.throws(() => bi.recordBlobsTx([blob('e')]), (e) => e.code === 'conflict' && e.detail.reason === 'lock_not_held');
  assert.throws(() => bi.attachTx(v.id, [{ sha256: SHA('a'), role: 'content' }]), (e) => e.code === 'conflict');
  // Input validation.
  await bi.withIngestLock(() => {
    for (const bad of [{ sha256: 'A'.repeat(64), bytes: 1, mediaType: 'x/y' }, { sha256: SHA('f'), bytes: -1, mediaType: 'x/y' },
      { sha256: SHA('f'), bytes: 1, mediaType: 'x' }, { sha256: SHA('f').slice(1), bytes: 1, mediaType: 'x/y' }])
      assert.throws(() => bi.recordBlobsTx([bad]), (e) => e.code === 'invalid', JSON.stringify(bad));
  });
  s.close();
});

test('B2: the same bytes twice are one blob and last_referenced_at moves forward; a size mismatch is a conflict', async () => {
  const { s, db, bi, clock } = setup();
  await bi.withIngestLock(() => bi.recordBlobsTx([blob('a')]));
  clock.t += 5000;
  await bi.withIngestLock(() => assert.deepEqual(bi.recordBlobsTx([blob('a'), blob('a')]), { inserted: 0, touched: 1 }));
  assert.equal(h.count(db, 'blobs'), 1);
  const row = db.prepare('SELECT * FROM blobs').get();
  assert.equal(row.created_at, h.NOW); assert.equal(row.last_referenced_at, h.NOW + 5000);
  await bi.withIngestLock(() => {
    assert.throws(() => bi.recordBlobsTx([blob('a', 11)]), (e) => e.code === 'conflict' && e.detail.reason === 'size_mismatch');
    assert.throws(() => bi.recordBlobsTx([blob('b', 1), blob('b', 2)]), (e) => e.code === 'conflict');
  });
  assert.equal(h.count(db, 'blobs'), 1);
  // A failed record rolls back as a whole (savepoint semantics).
  await bi.withIngestLock(() => assert.throws(() => bi.recordBlobsTx([blob('c'), blob('a', 99)]), (e) => e.code === 'conflict'));
  assert.equal(h.count(db, 'blobs'), 1);
  // The free function joins a caller's transaction.
  db.transaction(() => { B.recordBlobsTx(db, [blob('d')], h.NOW); })();
  assert.equal(h.count(db, 'blobs'), 2);
  s.close();
});

test('B3: the dry run lists only unreferenced blobs older than 24 h; the candidates hash is stable', async () => {
  const { s, nx, bi, me, clock } = setup();
  const v = draft(nx, me);
  await bi.withIngestLock(() => { bi.recordBlobsTx([blob('a'), blob('b'), blob('c', 7)]); bi.attachTx(v.id, [{ sha256: SHA('b'), role: 'content' }]); });
  clock.t = h.NOW + DAY / 2;
  await bi.withIngestLock(() => bi.recordBlobsTx([blob('d')]));        // young
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
  await bi.withIngestLock(() => { bi.recordBlobsTx([blob('a'), blob('b'), blob('c')]); bi.attachTx(v.id, [{ sha256: SHA('b'), role: 'content' }]); });
  clock.t = h.NOW + DAY + 1;
  const dry = bi.gcCandidates();
  // The list changes between the dry run and the apply: a candidate is touched by a new ingest.
  await bi.withIngestLock(() => bi.recordBlobsTx([blob('c')]));
  await rejectsCode(bi.gcApply(me, dry.candidatesHash), 'conflict', 'stale');
  await rejectsCode(bi.gcApply(me, 'not-a-hash'), 'invalid');
  assert.equal(h.count(db, 'blobs'), 3);
  const dry2 = bi.gcCandidates();
  assert.deepEqual(dry2.candidates.map((c) => c.sha256), [SHA('a')]);
  const deleted = [];
  const actBefore = h.count(db, 'activity');
  const out = await bi.gcApply(me, dry2.candidatesHash, async (shas) => { assert.equal(bi.lock.exclusiveHeld, true); deleted.push(...shas); });
  assert.deepEqual(out.removedShas, [SHA('a')]); assert.deepEqual(deleted, [SHA('a')]);
  assert.equal(bi.lock.exclusiveHeld, false);
  assert.deepEqual(db.prepare('SELECT sha256 FROM blobs ORDER BY sha256').all().map((r) => r.sha256), [SHA('b'), SHA('c')]);
  assert.equal(h.count(db, 'activity'), actBefore + 1);
  const act = db.prepare('SELECT * FROM activity ORDER BY seq DESC LIMIT 1').get();
  assert.equal(act.action, 'blobs.gc'); assert.equal(act.actor_id, me.id); assert.deepEqual(JSON.parse(act.details_json), { removed: 1, bytes: 10 });
  // A referenced blob is never a candidate, however old, and the trigger blocks a forced delete.
  clock.t = h.NOW + 100 * DAY;
  assert.ok(!bi.gcCandidates().candidates.some((c) => c.sha256 === SHA('b')));
  assert.throws(() => db.prepare('DELETE FROM blobs WHERE sha256 = ?').run(SHA('b')), /held by a version is never deleted/);
  // An empty list applies cleanly with its own hash; a principal that is not a user or the system is refused.
  const sys2 = await bi.gcApply(sys, bi.gcCandidates().candidatesHash);
  assert.deepEqual(sys2.removedShas, [SHA('c')]);
  assert.deepEqual((await bi.gcApply(sys, B.candidatesHash([]))).removedShas, []);
  await rejectsCode(bi.gcApply({ id: 'agent:x', kind: 'agent', displayName: 'x' }, B.candidatesHash([])), 'denied');
  assert.equal(bi.isReferenced(SHA('b')), true);
  s.close();
});

test('B5: apply while an ingest holds the shared lock is a conflict; a second GC is a conflict; ingest waits for GC; GC refuses while an attempt is live', async () => {
  const { s, db, nx, bi, me, sys, clock } = setup();
  await bi.withIngestLock(() => bi.recordBlobsTx([blob('a')]));
  clock.t = h.NOW + DAY + 1;
  const dry = bi.gcCandidates();
  let open; const gate = new Promise((r) => { open = r; });
  const ingest = bi.withIngestLock(async () => { await gate; return 'ingested'; });
  await new Promise((r) => setImmediate(r));
  assert.equal(bi.lock.sharedHolders, 1);
  await rejectsCode(bi.gcApply(me, dry.candidatesHash), 'conflict', 'busy');
  open(); assert.equal(await ingest, 'ingested');
  assert.equal(h.count(db, 'blobs'), 1, 'nothing was removed while the ingest held the lock');
  // While a GC holds the lock: a second GC is refused at once, and a new ingest waits until the GC releases.
  let release; const slow = new Promise((r) => { release = r; });
  const order = [];
  const gc = bi.gcApply(me, dry.candidatesHash, async () => { order.push('gc-delete-start'); await slow; order.push('gc-delete-end'); });
  await new Promise((r) => setImmediate(r));
  await rejectsCode(bi.gcApply(me, dry.candidatesHash), 'conflict', 'busy');
  const waiting = bi.withIngestLock(() => { order.push('ingest'); });
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(order, ['gc-delete-start']);
  release(); await gc; await waiting;
  assert.deepEqual(order, ['gc-delete-start', 'gc-delete-end', 'ingest']);
  // A live attempt blocks GC (checked under the lock), and the lock is released after the refusal.
  await bi.withIngestLock(() => bi.recordBlobsTx([blob('b')]));
  clock.t += DAY + 1;
  const job = nx.jobs.create(me, { kind: 'tool.run', projectId: 'p-ledger', workspaceId: 'sde', idempotencyKey: 'gc-live' }).job;
  nx.jobs.transition(sys, job.id, 'leased');
  const BOOT = newId(h.NOW);
  db.prepare(`INSERT INTO job_attempts (id, job_id, n, state, boot_id, lease_owner, lease_expires_at, created_at, updated_at)
    VALUES (?, ?, 1, 'starting', ?, ?, ?, ?, ?)`).run(newId(h.NOW), job.id, BOOT, BOOT, clock.t + 60_000, clock.t, clock.t);
  const live = bi.gcCandidates();
  assert.equal(live.liveAttempts, 1);
  await rejectsCode(bi.gcApply(me, live.candidatesHash), 'conflict', 'attempts_live');
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
  assert.equal(home.objectPath(sha), path.join(home.root, 'objects', 'ab', 'c'.repeat(62)));
  assert.throws(() => home.objectPath('AB' + 'c'.repeat(62)), (e) => e.code === 'invalid');
  assert.throws(() => home.objectPath('../x'), (e) => e.code === 'invalid');
  assert.equal(home.attemptWorkDir('J1', 2), path.join(home.root, 'work', 'J1', '2'));
  for (const [id, n] of [['../x', 1], ['a/b', 1], ['a.b', 1], ['', 1], ['J1', 0], ['J1', 1.5], ['J1', -1], ['x'.repeat(65), 1]])
    assert.throws(() => home.attemptWorkDir(id, n), (e) => e.code === 'invalid', `${id}/${n}`);
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
  const db = h.openRaw(path.join(h.tmpDir('nx-logcheck-'), 'x.db'));
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
