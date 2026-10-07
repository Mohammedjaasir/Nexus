'use strict';
const h = require('./helpers/sqlite.cjs');
if (!h.realSqliteOrSkip()) return;
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');
const { PersistStore } = loadTs('src/main/db.ts');
const { appendActivityRow } = loadTs('src/main/nexus/activity/writer.ts');
function v7() { const dir = h.tmpDir(); const s = new PersistStore(path.join(dir, 'harness.db')); s.open({ log: () => {}, backupDir: path.join(dir, 'b'), holdV8: true }); return { s, db: s.platformDatabase() }; }
const base = { actorKind: 'user', actorId: 'user:local', entityType: 'artifact', action: 'artifact.create', status: 'succeeded', projectId: 'p1' };

test('append writes a redacted, chained row', () => {
  const { s, db } = v7();
  const a = appendActivityRow(db, { ...base, details: { name: 'model card', apiKey: 'zzz' } }, h.NOW);
  const b = appendActivityRow(db, { ...base, details: {} }, h.NOW + 1);
  const rows = db.prepare('SELECT * FROM activity ORDER BY seq').all();
  const last = rows[rows.length - 1];
  assert.equal(last.prev_hash, a.hash); assert.equal(last.hash, b.hash);
  assert.doesNotMatch(rows.find((r) => r.id === a.id).details_json, /zzz/);
  s.close();
});
test('activity is append-only at the database level', () => {
  const { s, db } = v7(); appendActivityRow(db, base, h.NOW);
  assert.throws(() => db.prepare("UPDATE activity SET action='x'").run(), /append-only/);
  assert.throws(() => db.prepare('DELETE FROM activity').run(), /append-only/);
  s.close();
});
test('an activity row rolls back together with its failed operation', () => {
  const { s, db } = v7(); const n = h.count(db, 'activity');
  assert.throws(() => db.transaction(() => { appendActivityRow(db, base, h.NOW); throw new Error('operation failed'); })());
  assert.equal(h.count(db, 'activity'), n);
  s.close();
});
test('by-project and by-session reads use their indexes', () => {
  const { s, db } = v7();
  const plan = (sql) => db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all('x').map((r) => r.detail).join(' | ');  // binds the ? (the brief's .all() throws RangeError)
  assert.match(plan('SELECT * FROM activity WHERE project_id = ? ORDER BY seq DESC LIMIT 50'), /ix_activity_project/);
  assert.match(plan('SELECT * FROM activity WHERE session_id = ? ORDER BY seq DESC LIMIT 50'), /ix_activity_session/);
  assert.match(plan('SELECT * FROM activity WHERE job_id = ? ORDER BY seq DESC LIMIT 50'), /ix_activity_job/);
  s.close();
});

// ---- additions beyond the brief's pinned cases ----
const { verifyActivityChain, readActivityRows } = loadTs('src/main/nexus/activity/writer.ts');
const full = { actorKind: 'agent', actorId: 'agent:a1', onBehalfOf: 'user:local', sessionId: 's1', jobId: 'j1', attemptN: 2,
  workspaceId: 'ml', projectId: 'p1', artifactId: 'art1', versionId: 'v1', entityType: 'version', entityId: 'v1',
  action: 'version.register', status: 'succeeded', details: { contentHash: 'cd'.repeat(32), note: 'ok', token: 'tok' } };

test('every field of the brief is stored, the migration row is the chain head, and the chain verifies', () => {
  const { s, db } = v7();
  const head = db.prepare('SELECT * FROM activity ORDER BY seq').all();
  assert.equal(head.length, 1); assert.equal(head[0].action, 'db.migrated');
  const r = appendActivityRow(db, full, h.NOW + 5);
  const row = db.prepare('SELECT * FROM activity WHERE id = ?').get(r.id);
  assert.deepEqual({ ak: row.actor_kind, a: row.actor_id, o: row.on_behalf_of, se: row.session_id, j: row.job_id, n: row.attempt_n,
    w: row.workspace_id, p: row.project_id, ar: row.artifact_id, v: row.version_id, et: row.entity_type, ei: row.entity_id,
    ac: row.action, st: row.status, ts: row.ts },
  { ak: 'agent', a: 'agent:a1', o: 'user:local', se: 's1', j: 'j1', n: 2, w: 'ml', p: 'p1', ar: 'art1', v: 'v1', et: 'version', ei: 'v1',
    ac: 'version.register', st: 'succeeded', ts: h.NOW + 5 });
  assert.equal(row.prev_hash, head[0].hash);
  assert.deepEqual(JSON.parse(row.details_json), { contentHash: 'cd'.repeat(32), note: 'ok', token: '[redacted]' });
  assert.deepEqual(verifyActivityChain(db), { ok: true, rows: 2 });
  const entries = readActivityRows(db);
  assert.equal(entries[1].sessionId, 's1'); assert.equal(entries[1].details.token, '[redacted]');
  s.close();
});
test('tampering outside the app (triggers dropped) is detected by chain verification', () => {
  const { s, db } = v7();
  appendActivityRow(db, base, h.NOW + 1); const mid = appendActivityRow(db, base, h.NOW + 2); appendActivityRow(db, base, h.NOW + 3);
  assert.deepEqual(verifyActivityChain(db), { ok: true, rows: 4 });
  db.exec('DROP TRIGGER tr_activity_no_update; DROP TRIGGER tr_activity_no_delete;');
  db.prepare("UPDATE activity SET status = 'denied' WHERE id = ?").run(mid.id);
  assert.deepEqual(verifyActivityChain(db), { ok: false, brokenAtSeq: mid.seq });
  s.close();
  const { s: s2, db: db2 } = v7();
  appendActivityRow(db2, base, h.NOW + 1); const gone = appendActivityRow(db2, base, h.NOW + 2); const after = appendActivityRow(db2, base, h.NOW + 3);
  db2.exec('DROP TRIGGER tr_activity_no_delete');
  db2.prepare('DELETE FROM activity WHERE id = ?').run(gone.id);
  assert.deepEqual(verifyActivityChain(db2), { ok: false, brokenAtSeq: after.seq });
  s2.close();
});
test('the caller transaction commits the operation and its activity together', () => {
  const { s, db } = v7(); const n = h.count(db, 'activity');
  db.prepare('CREATE TEMP TABLE op (x INTEGER)').run();
  db.transaction(() => { db.prepare('INSERT INTO op VALUES (1)').run(); appendActivityRow(db, base, h.NOW); })();
  assert.equal(h.count(db, 'activity'), n + 1); assert.equal(db.prepare('SELECT COUNT(*) AS n FROM op').get().n, 1);
  assert.throws(() => db.transaction(() => { db.prepare('INSERT INTO op VALUES (2)').run(); appendActivityRow(db, base, h.NOW); throw new Error('boom'); })());
  assert.equal(h.count(db, 'activity'), n + 1); assert.equal(db.prepare('SELECT COUNT(*) AS n FROM op').get().n, 1);
  assert.deepEqual(verifyActivityChain(db), { ok: true, rows: n + 1 });
  s.close();
});
test('a standalone append (no caller transaction) still chains and leaves no transaction open', () => {
  const { s, db } = v7();
  assert.equal(db.inTransaction, false);
  appendActivityRow(db, { ...base, status: 'denied', details: { reason: 'role' } }, h.NOW);
  assert.equal(db.inTransaction, false);
  assert.deepEqual(verifyActivityChain(db), { ok: true, rows: 2 });
  s.close();
});
test('the migration activity row keeps its backup hash under the redacting writer', () => {
  const { dir, file } = h.v6Fixture();                         // a v6 database with data, so the migration takes a backup
  const s = new PersistStore(file); s.open({ log: () => {}, backupDir: path.join(dir, 'b'), holdV8: true });
  const db = s.platformDatabase();
  const rec = db.prepare('SELECT backup_sha256 FROM nexus_migrations WHERE version = 7').get();
  const a = db.prepare("SELECT details_json FROM activity WHERE action = 'db.migrated'").get();
  assert.match(rec.backup_sha256, /^[0-9a-f]{64}$/);
  assert.equal(JSON.parse(a.details_json).backupSha256, rec.backup_sha256);
  assert.deepEqual(verifyActivityChain(db), { ok: true, rows: 1 });
  s.close();
});

// ---- fix round 1 ----
test('attempt_n is read back and tampering with it breaks the chain', () => {
  const { s, db } = v7();
  const r = appendActivityRow(db, { ...base, jobId: 'j1', attemptN: 1, entityType: 'job', action: 'job.transition' }, h.NOW);
  assert.equal(readActivityRows(db).find((e) => e.id === r.id).attemptN, 1);
  assert.equal(readActivityRows(db)[0].attemptN, null);                   // the migration row
  assert.deepEqual(verifyActivityChain(db), { ok: true, rows: 2 });
  db.exec('DROP TRIGGER tr_activity_no_update');
  db.prepare('UPDATE activity SET attempt_n = 2 WHERE id = ?').run(r.id);
  assert.deepEqual(verifyActivityChain(db), { ok: false, brokenAtSeq: r.seq });
  s.close();
});
test('two connections: a DEFERRED caller whose head read is stale fails busy and never forks the chain; a retry succeeds', () => {
  const { s, db } = v7();
  const other = h.openRaw(db.name);
  const before = h.count(db, 'activity');
  let err;
  try {
    db.transaction(() => {
      db.prepare('SELECT hash FROM activity ORDER BY seq DESC LIMIT 1').get();   // DEFERRED: read snapshot taken here
      appendActivityRow(other, { ...base, actorId: 'user:other' }, h.NOW + 1);   // another connection appends and commits
      appendActivityRow(db, base, h.NOW + 2);                                    // stale head: the insert cannot commit
    })();
  } catch (e) { err = e; }
  assert.ok(err, 'the stale writer must fail');
  assert.match(String(err.code), /^SQLITE_BUSY/);
  assert.equal(h.count(db, 'activity'), before + 1);
  assert.deepEqual(verifyActivityChain(db), { ok: true, rows: before + 1 });
  db.transaction(() => { appendActivityRow(db, base, h.NOW + 3); }).immediate();     // the retry
  assert.deepEqual(verifyActivityChain(db), { ok: true, rows: before + 2 });
  other.close(); s.close();
});
test('two connections: an IMMEDIATE caller holds the write lock, so the other writer waits or fails busy, never forks', () => {
  const { s, db } = v7();
  const other = h.openRaw(db.name); other.pragma('busy_timeout = 50');
  let otherErr;
  db.transaction(() => {
    appendActivityRow(db, base, h.NOW + 1);
    try { appendActivityRow(other, { ...base, actorId: 'user:other' }, h.NOW + 2); } catch (e) { otherErr = e; }
    appendActivityRow(db, base, h.NOW + 3);
  }).immediate();
  assert.ok(otherErr); assert.match(String(otherErr.code), /^SQLITE_BUSY/);
  appendActivityRow(other, { ...base, actorId: 'user:other' }, h.NOW + 4);           // after commit it goes through
  assert.deepEqual(verifyActivityChain(db), { ok: true, rows: 4 });
  other.close(); s.close();
});
