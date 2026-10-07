'use strict';
const h = require('./helpers/sqlite.cjs');
if (!h.realSqliteOrSkip()) return;
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');
const { PersistStore } = loadTs('src/main/db.ts');
const { applyV8, V8_EXPECTED, v8ShapeProblem } = loadTs('src/main/nexus/db/schemaV8.ts');
const ctx = (over) => ({ now: () => h.NOW, appVersion: 't', fromVersion: 7, preCounts: null, backup: null, ...over });
// Before Task 2 the store stops at v7 on its own; after Task 2, holdV8 keeps it there.
function v7db() {
  const { file } = h.v6Fixture(); const s = new PersistStore(file);
  s.open({ log: () => {}, backupDir: path.join(path.dirname(file), 'b'), now: () => h.NOW, holdV8: true });
  s.close(); return h.openRaw(file);
}
const names = (db, type) => db.prepare("SELECT name FROM sqlite_master WHERE type = ? AND name NOT LIKE 'sqlite_%'").all(type).map((r) => r.name);

test('v8 objects: 4 tables, 8 named indexes, 9 triggers, seeds, clean shape', () => {
  const db = v7db();
  db.transaction(() => applyV8(db, ctx()))();
  for (const t of Object.keys(V8_EXPECTED.tables)) assert.ok(names(db, 'table').includes(t), t);
  assert.equal(Object.keys(V8_EXPECTED.tables).length, 4);
  assert.equal(V8_EXPECTED.indexes.length, 8); assert.equal(V8_EXPECTED.triggers.length, 9);
  for (const i of V8_EXPECTED.indexes) assert.ok(names(db, 'index').includes(i), i);
  for (const t of V8_EXPECTED.triggers) assert.ok(names(db, 'trigger').includes(t), t);
  assert.equal(v8ShapeProblem(db, true), null);
  assert.deepEqual(db.prepare('SELECT state, terminal FROM handoff_states ORDER BY state').all(), [
    { state: 'accepted', terminal: 0 }, { state: 'declined', terminal: 1 }, { state: 'sent', terminal: 0 }, { state: 'withdrawn', terminal: 1 }]);
  assert.deepEqual(db.prepare("SELECT from_state || '>' || to_state AS t FROM handoff_transitions ORDER BY t").all().map((r) => r.t),
    ['sent>accepted', 'sent>declined', 'sent>withdrawn']);
  assert.deepEqual(db.pragma('foreign_key_check'), []);
});
test('applyV8 refuses a pre-existing object of the wrong shape; a re-run is a no-op', () => {
  const bad = v7db(); bad.exec('CREATE TABLE handoffs (id TEXT PRIMARY KEY)');
  assert.throws(() => bad.transaction(() => applyV8(bad, ctx()))(), /cannot be applied over an existing object/);
  const db = v7db(); db.transaction(() => applyV8(db, ctx()))();
  const n = db.prepare('SELECT COUNT(*) n FROM activity').get().n;
  db.transaction(() => applyV8(db, ctx()))();
  assert.equal(db.prepare('SELECT COUNT(*) n FROM activity').get().n, n, 'no second db.migrated row');
});
test('applyV8 refuses a database whose v7 shape is not exact', () => {
  const db = v7db(); db.exec('DROP TRIGGER tr_activity_no_delete');   // temp copy only
  assert.throws(() => db.transaction(() => applyV8(db, ctx()))(), /v7/);
});

// ---------- extra pins on the module itself ----------

test('the generic parser finds exactly the v8 objects, and ddlObjects is the v7 parser', () => {
  const { V8_DDL } = loadTs('src/main/nexus/db/schemaV8.ts');
  const v7 = loadTs('src/main/nexus/db/schemaV7.ts');
  assert.equal(v7.ddlObjects, v7.v7DdlObjects);
  const objs = v7.ddlObjects(V8_DDL);
  assert.deepEqual(objs.filter((o) => o.type === 'table').map((o) => o.name), Object.keys(V8_EXPECTED.tables));
  assert.deepEqual(objs.filter((o) => o.type === 'index').map((o) => o.name), V8_EXPECTED.indexes);
  assert.deepEqual(objs.filter((o) => o.type === 'trigger').map((o) => o.name), V8_EXPECTED.triggers);
  assert.equal(objs.find((o) => o.name === 'ix_versions_project_status').table, 'artifact_versions');
  assert.equal(objs.find((o) => o.name === 'ix_artifacts_updated').table, 'artifacts');
  assert.match(objs.find((o) => o.name === 'ux_handoffs_receipt').sql, /WHERE receipt_version_id IS NOT NULL$/);
  for (const o of objs.filter((x) => x.type === 'trigger')) assert.match(o.sql, /END$/, o.name);
  assert.doesNotMatch(V8_DDL, /\b(DROP|ALTER)\b/i);
});
test('applyV8: migration record, one db.migrated row, columns as declared, v7 shape still exact', () => {
  const { v7ShapeProblem } = loadTs('src/main/nexus/db/schemaV7.ts');
  const db = v7db();
  const before = h.count(db, 'activity');
  const out = db.transaction(() => applyV8(db, ctx({ preCounts: { projects: h.count(db, 'projects'), activity: before } })))();
  assert.deepEqual(out, { handoffStates: 4, handoffTransitions: 3 });
  const rec = db.prepare('SELECT * FROM nexus_migrations WHERE version = 8').get();
  assert.equal(rec.from_version, 7); assert.equal(rec.backfill_json, '{}'); assert.equal(rec.applied_at, h.NOW);
  assert.equal(h.count(db, 'activity'), before + 1);
  const row = db.prepare('SELECT * FROM activity ORDER BY seq DESC LIMIT 1').get();
  assert.equal(row.action, 'db.migrated'); assert.equal(row.entity_id, '8'); assert.equal(row.actor_kind, 'system');
  assert.deepEqual(JSON.parse(row.details_json), { from: 7, to: 8, backupFile: null, backupSha256: null });
  for (const [t, cols] of Object.entries(V8_EXPECTED.tables)) {
    assert.deepEqual(db.prepare(`PRAGMA table_info("${t}")`).all().map((c) => c.name), cols, t);
  }
  assert.equal(v7ShapeProblem(db, true), null);
});
test('verifyV8 fails on a pre-count mismatch, and the transaction rolls back', () => {
  const db = v7db();
  assert.throws(() => db.transaction(() => applyV8(db, ctx({ preCounts: { projects: 999 } })))(), /projects has \d+ rows, expected 999/);
  assert.equal(names(db, 'table').includes('handoffs'), false);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM nexus_migrations WHERE version = 8').get().n, 0);
});
test('v8ShapeProblem reports a missing object and a changed definition', () => {
  const db = v7db();
  assert.match(v8ShapeProblem(db, true), /missing/);
  assert.equal(v8ShapeProblem(db, false), null);
  db.transaction(() => applyV8(db, ctx()))();
  db.exec('DROP INDEX ix_artifacts_updated; CREATE INDEX ix_artifacts_updated ON artifacts(updated_at)');
  assert.match(v8ShapeProblem(db, true), /index ix_artifacts_updated has a different definition/);
});

// ---------- triggers T1-T12, on raw rows in a temp database ----------

const T0 = h.NOW;
function seedHandoffWorld(db) {
  const p1 = db.prepare("SELECT id FROM project_workspaces WHERE project_id = 'p-ledger' AND workspace_id = 'sde'").get().id;
  const other = db.prepare("SELECT id FROM project_workspaces WHERE project_id = 'p-invoice' AND workspace_id = 'dl'").get().id;
  const pw = db.prepare(`INSERT INTO project_workspaces (id, project_id, workspace_id, status, is_primary, source, created_by, created_at, updated_at)
    VALUES (?, ?, ?, ?, 0, 'user', 'user:local', ?, ?)`);
  pw.run('pw-ops', 'p-ledger', 'devops', 'active', T0, T0);
  pw.run('pw-qa-gone', 'p-ledger', 'qa', 'withdrawn', T0, T0);
  const art = db.prepare(`INSERT INTO artifacts (id, project_id, kind, name, owner_participation_id, owner_workspace_id, created_by, created_at, updated_at)
    VALUES (?, 'p-ledger', ?, ?, ?, ?, 'user:local', ?, ?)`);
  const ver = db.prepare(`INSERT INTO artifact_versions (id, artifact_id, version_no, project_id, participation_id, status, storage_kind,
    storage_ref_json, content_hash, actor_id, on_behalf_of, created_at, status_changed_at)
    VALUES (?, ?, ?, 'p-ledger', ?, 'draft', 'inline', '{}', ?, 'user:local', 'user:local', ?, ?)`);
  const cand = (id) => db.prepare("UPDATE artifact_versions SET status = 'candidate' WHERE id = ?").run(id);
  art.run('a-1', 'report', 'notes', p1, 'sde', T0, T0);
  ver.run('v-1', 'a-1', 1, p1, 'hash-1', T0, T0); cand('v-1');
  ver.run('v-1b', 'a-1', 2, p1, 'hash-1b', T0, T0); cand('v-1b');
  ver.run('v-draft', 'a-1', 3, p1, 'hash-d', T0, T0);
  art.run('a-ops', 'report', 'ops notes', 'pw-ops', 'devops', T0, T0);
  ver.run('v-ops', 'a-ops', 1, 'pw-ops', 'hash-ops', T0, T0); cand('v-ops');
  art.run('a-rcpt', 'handoff_receipt', 'receipt', 'pw-ops', 'devops', T0, T0);
  ver.run('v-rcpt', 'a-rcpt', 1, 'pw-ops', 'hash-r', T0, T0);
  ver.run('v-rcpt2', 'a-rcpt', 2, 'pw-ops', 'hash-r2', T0, T0);
  art.run('a-rcpt-sender', 'handoff_receipt', 'sender receipt', p1, 'sde', T0, T0);
  ver.run('v-rcpt-sender', 'a-rcpt-sender', 1, p1, 'hash-rs', T0, T0);
  return { p1, p2: 'pw-ops', other };
}
function world() {
  const db = v7db(); db.transaction(() => applyV8(db, ctx()))();
  return { db, ...seedHandoffWorld(db) };
}
let seq = 0;
function insHandoff(db, w, over = {}) {
  const r = { id: `h-${++seq}`, project_id: 'p-ledger', from_participation_id: w.p1, from_workspace_id: 'sde',
    to_participation_id: w.p2, to_workspace_id: 'devops', title: 'Send notes', note: null, subject_count: 1, status: 'sent',
    created_by: 'user:local', responded_by: null, responded_at: null, response_note: null, receipt_version_id: null,
    created_at: T0, updated_at: T0, status_changed_at: T0, ...over };
  const cols = Object.keys(r);
  db.prepare(`INSERT INTO handoffs (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`).run(...cols.map((c) => r[c]));
  return r.id;
}
const insSubject = (db, hid, vid, pos, hash) => db.prepare('INSERT INTO handoff_subjects (handoff_id, version_id, position, content_hash) VALUES (?, ?, ?, ?)')
  .run(hid, vid, pos, hash);
/** A sent handoff carrying v-1 at position 1. */
function sentHandoff(db, w, over) { const id = insHandoff(db, w, over); insSubject(db, id, 'v-1', 1, 'hash-1'); return id; }
const answer = (db, id, status, extra = '') => db.prepare(
  `UPDATE handoffs SET status = ?, responded_by = 'user:local', responded_at = ?, updated_at = ?, status_changed_at = ?${extra} WHERE id = ?`)
  .run(status, T0 + 1, T0 + 1, T0 + 1, id);
const accept = (db, id, receipt) => db.prepare(
  "UPDATE handoffs SET status = 'accepted', receipt_version_id = ?, responded_by = 'user:local', responded_at = ?, updated_at = ?, status_changed_at = ? WHERE id = ?")
  .run(receipt, T0 + 1, T0 + 1, T0 + 1, id);

test('T1: a handoff starts sent, unanswered and without a receipt', () => {
  const { db, ...w } = world();
  const re = /starts as sent, unanswered and without a receipt/;
  assert.throws(() => insHandoff(db, w, { status: 'accepted' }), re);
  assert.throws(() => insHandoff(db, w, { responded_by: 'user:local', responded_at: T0 }), re);
  assert.throws(() => insHandoff(db, w, { response_note: 'x', responded_by: 'user:local', responded_at: T0 }), re);
  assert.throws(() => insHandoff(db, w, { receipt_version_id: 'v-rcpt' }), re);
  insHandoff(db, w);
});
test('T2: a withdrawn participation cannot send or receive', () => {
  const { db, ...w } = world();
  assert.throws(() => insHandoff(db, w, { from_participation_id: 'pw-qa-gone', from_workspace_id: 'qa' }), /sending participation must be active/);
  assert.throws(() => insHandoff(db, w, { to_participation_id: 'pw-qa-gone', to_workspace_id: 'qa' }), /receiving participation must be active/);
});
test('T3: a participation of another project is refused', () => {
  const { db, ...w } = world();
  assert.throws(() => insHandoff(db, w, { to_participation_id: w.other, to_workspace_id: 'dl' }), /receiving participation must be active, in this project/);
  assert.throws(() => insHandoff(db, w, { from_participation_id: w.other, from_workspace_id: 'dl' }), /sending participation must be active, in this project/);
});
test('T4: a workspace id that does not match its participation is refused', () => {
  const { db, ...w } = world();
  assert.throws(() => insHandoff(db, w, { from_workspace_id: 'qa' }), /sending participation .* name its workspace/);
  assert.throws(() => insHandoff(db, w, { to_workspace_id: 'qa' }), /receiving participation .* name its workspace/);
});
test('T5: a subject must be a candidate or active version owned by the sender, with its hash', () => {
  const { db, ...w } = world();
  const id = insHandoff(db, w, { subject_count: 3 });
  const re = /a subject is a candidate or active version owned by the sending participation/;
  assert.throws(() => insSubject(db, id, 'v-draft', 1, 'hash-d'), re);
  assert.throws(() => insSubject(db, id, 'v-ops', 1, 'hash-ops'), re);
  assert.throws(() => insSubject(db, id, 'v-1', 1, 'hash-wrong'), re);
  insSubject(db, id, 'v-1', 1, 'hash-1');
});
test('T6: subject n+1 and a duplicate position are refused', () => {
  const { db, ...w } = world();
  const one = sentHandoff(db, w);
  assert.throws(() => insSubject(db, one, 'v-1b', 2, 'hash-1b'), /up to its declared count/);
  const two = insHandoff(db, w, { subject_count: 2 });
  insSubject(db, two, 'v-1', 1, 'hash-1');
  assert.throws(() => insSubject(db, two, 'v-1b', 1, 'hash-1b'), /UNIQUE/);
  assert.throws(() => insSubject(db, two, 'v-1', 2, 'hash-1'), /UNIQUE/);
  insSubject(db, two, 'v-1b', 2, 'hash-1b');
});
test('T7: no answer while fewer subjects than declared exist', () => {
  const { db, ...w } = world();
  const id = insHandoff(db, w, { subject_count: 2 });
  insSubject(db, id, 'v-1', 1, 'hash-1');
  const re = /answered only once all its subjects are recorded/;
  assert.throws(() => answer(db, id, 'declined'), re);
  assert.throws(() => db.prepare("UPDATE handoffs SET status = 'withdrawn' WHERE id = ?").run(id), re);
  assert.throws(() => accept(db, id, 'v-rcpt'), re);
  insSubject(db, id, 'v-1b', 2, 'hash-1b');
  answer(db, id, 'declined');
});
test('T8: accept needs a handoff_receipt version owned by the receiving participation', () => {
  const { db, ...w } = world();
  const id = sentHandoff(db, w);
  assert.throws(() => answer(db, id, 'accepted'), /an accepted handoff records its receipt/);
  assert.throws(() => accept(db, id, 'v-ops'), /must be a handoff_receipt version owned by the receiving participation/);
  assert.throws(() => accept(db, id, 'v-rcpt-sender'), /must be a handoff_receipt version owned by the receiving participation/);
  accept(db, id, 'v-rcpt');
  const row = db.prepare('SELECT status, receipt_version_id FROM handoffs WHERE id = ?').get(id);
  assert.deepEqual({ ...row }, { status: 'accepted', receipt_version_id: 'v-rcpt' });
  // A receipt serves one handoff only, and is set only in the accepting update.
  const second = sentHandoff(db, w);
  assert.throws(() => accept(db, second, 'v-rcpt'), /UNIQUE/);
  assert.throws(() => db.prepare("UPDATE handoffs SET receipt_version_id = 'v-rcpt2' WHERE id = ?").run(second), /a receipt is set once, in the update that accepts/);
  assert.throws(() => db.prepare("UPDATE handoffs SET receipt_version_id = 'v-rcpt2' WHERE id = ?").run(id), /a receipt is set once/);
  assert.deepEqual(db.pragma('foreign_key_check'), []);
});
test('T9: a second answer, or a changed response note, is refused', () => {
  const { db, ...w } = world();
  const id = sentHandoff(db, w);
  answer(db, id, 'declined', ", response_note = 'not now'");
  assert.throws(() => db.prepare("UPDATE handoffs SET response_note = 'changed' WHERE id = ?").run(id), /a handoff answer is recorded once/);
  assert.throws(() => db.prepare('UPDATE handoffs SET responded_at = ? WHERE id = ?').run(T0 + 5, id), /a handoff answer is recorded once/);
  assert.throws(() => db.prepare("UPDATE handoffs SET status = 'withdrawn' WHERE id = ?").run(id), /illegal handoff transition/);
  const acc = sentHandoff(db, w);
  accept(db, acc, 'v-rcpt');
  assert.throws(() => db.prepare("UPDATE handoffs SET status = 'declined' WHERE id = ?").run(acc), /illegal handoff transition/);
  assert.throws(() => db.prepare("UPDATE handoffs SET response_note = 'late' WHERE id = ?").run(acc), /a handoff answer is recorded once/);
});
test('T10: declined -> accepted and withdrawn -> sent are refused', () => {
  const { db, ...w } = world();
  const d = sentHandoff(db, w); answer(db, d, 'declined');
  assert.throws(() => db.prepare("UPDATE handoffs SET status = 'accepted', receipt_version_id = 'v-rcpt' WHERE id = ?").run(d));
  assert.throws(() => db.prepare("UPDATE handoffs SET status = 'accepted' WHERE id = ?").run(d), /illegal handoff transition/);
  const x = sentHandoff(db, w);
  db.prepare("UPDATE handoffs SET status = 'withdrawn', updated_at = ?, status_changed_at = ? WHERE id = ?").run(T0 + 1, T0 + 1, x);
  assert.throws(() => db.prepare("UPDATE handoffs SET status = 'sent' WHERE id = ?").run(x), /illegal handoff transition/);
  assert.equal(db.prepare('SELECT status FROM handoffs WHERE id = ?').get(d).status, 'declined');
});
test('T11: handoffs and subjects are never deleted; subjects are never updated', () => {
  const { db, ...w } = world();
  const id = sentHandoff(db, w);
  assert.throws(() => db.prepare('DELETE FROM handoffs WHERE id = ?').run(id), /handoffs are never deleted/);
  assert.throws(() => db.prepare('DELETE FROM handoff_subjects WHERE handoff_id = ?').run(id), /handoff subjects are immutable/);
  assert.throws(() => db.prepare("UPDATE handoff_subjects SET content_hash = 'x' WHERE handoff_id = ?").run(id), /handoff subjects are immutable/);
  assert.throws(() => db.prepare('UPDATE handoff_subjects SET position = 1 WHERE handoff_id = ?').run(id), /handoff subjects are immutable/);
});
test('T12: title, subject_count, created_by and to_participation_id are immutable', () => {
  const { db, ...w } = world();
  const id = sentHandoff(db, w);
  const re = /handoff identity and request are immutable/;
  assert.throws(() => db.prepare("UPDATE handoffs SET title = 'other' WHERE id = ?").run(id), re);
  assert.throws(() => db.prepare('UPDATE handoffs SET subject_count = 2 WHERE id = ?').run(id), re);
  assert.throws(() => db.prepare("UPDATE handoffs SET created_by = 'system' WHERE id = ?").run(id), re);
  assert.throws(() => db.prepare("UPDATE handoffs SET to_participation_id = ? WHERE id = ?").run(w.p1, id), re);
  assert.throws(() => db.prepare("UPDATE handoffs SET note = 'n' WHERE id = ?").run(id), re);
  db.prepare('UPDATE handoffs SET updated_at = ? WHERE id = ?').run(T0 + 9, id);
});
