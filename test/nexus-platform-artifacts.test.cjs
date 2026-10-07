'use strict';
const h = require('./helpers/sqlite.cjs');
if (!h.realSqliteOrSkip()) return;
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { Worker } = require('node:worker_threads');
const loadTs = require('./load-ts.cjs');
const { PersistStore } = loadTs('src/main/db.ts');
const { createNexusPlatform } = loadTs('src/main/nexus/platform.ts');
const { verifyActivityChain } = loadTs('src/main/nexus/activity/writer.ts');
function setup() {
  const { file } = h.v6Fixture(); const s = new PersistStore(file);
  s.open({ log: () => {}, backupDir: path.join(path.dirname(file), 'b'), now: () => h.NOW });
  const db = s.platformDatabase(); const nx = createNexusPlatform(db, { now: () => h.NOW });
  return { s, db, nx, file, me: nx.principals.localUser(), sys: nx.principals.system() };
}
const inline = (json) => ({ kind: 'inline', json });

test('create: the owner is the project participation in that workspace; the origin workspace is recorded', () => {
  const { s, nx, me } = setup();
  const a = nx.artifacts.create(me, { projectId: 'p-ledger', workspaceId: 'sde', kind: 'report', name: 'API notes' });
  assert.equal(a.ownerWorkspaceId, 'sde'); assert.equal(a.ownerScope, 'participation'); assert.equal(a.currentVersionId, null);
  assert.equal(a.ownerParticipationId, nx.workspaces.primaryOf(me, 'p-ledger').id);
  assert.throws(() => nx.artifacts.create(me, { projectId: 'p-ledger', workspaceId: 'qa', kind: 'report', name: 'x' }), (e) => e.code === 'not_participating');
  assert.throws(() => nx.artifacts.create(me, { projectId: 'p-ledger', workspaceId: 'sde', kind: 'repository', name: 'x' }), (e) => e.code === 'invalid');
  s.close();
});
test('version numbers are 1..n per artifact and the database rejects a duplicate', () => {
  const { s, db, nx, me } = setup();
  const a = nx.artifacts.create(me, { projectId: 'p-ledger', workspaceId: 'sde', kind: 'report', name: 'r' });
  const nos = [1, 2, 3].map((i) => nx.artifacts.registerVersion(me, { artifactId: a.id, storage: inline({ i }) }).version.versionNo);
  assert.deepEqual(nos, [1, 2, 3]);
  const v = db.prepare('SELECT * FROM artifact_versions WHERE artifact_id=? AND version_no=2').get(a.id);
  assert.throws(() => db.prepare(`INSERT INTO artifact_versions (id,artifact_id,version_no,project_id,participation_id,status,storage_kind,
    storage_ref_json,content_hash,actor_id,on_behalf_of,created_at,status_changed_at) VALUES ('dup',?,2,?,?,'draft','inline','{}','h','user:local','user:local',1,1)`)
    .run(a.id, v.project_id, v.participation_id), /UNIQUE/);
  s.close();
});
test('version_no allocation holds under two concurrent writer connections', async () => {
  const { s, nx, me, file } = setup();
  const a = nx.artifacts.create(me, { projectId: 'p-ledger', workspaceId: 'sde', kind: 'report', name: 'race' });
  s.close();
  const run = () => new Promise((res, rej) => {
    const w = new Worker(path.join(__dirname, 'helpers', 'register-worker.cjs'), { workerData: { file, artifactId: a.id, n: 25 } });
    w.on('message', res); w.on('error', rej);
  });
  await Promise.all([run(), run()]);
  const db = h.openRaw(file);
  const nos = db.prepare('SELECT version_no FROM artifact_versions WHERE artifact_id=? ORDER BY version_no').all(a.id).map((r) => r.version_no);
  assert.deepEqual(nos, Array.from({ length: 50 }, (_, i) => i + 1));
  assert.equal(verifyActivityChain(db).ok, true);                                   // the two writers kept one linear chain
  db.close();
});
test('version_no allocation holds when two connections interleave deterministically (backstop)', () => {
  const { s, nx, me, file } = setup();
  const a = nx.artifacts.create(me, { projectId: 'p-ledger', workspaceId: 'sde', kind: 'report', name: 'interleave' });
  const other = h.openRaw(file); const nx2 = createNexusPlatform(other, { now: () => h.NOW });
  const me2 = nx2.principals.localUser();
  const got = [];
  for (let i = 0; i < 5; i++) {
    got.push(nx.artifacts.registerVersion(me, { artifactId: a.id, storage: inline({ c: 1, i }) }).version.versionNo);
    got.push(nx2.artifacts.registerVersion(me2, { artifactId: a.id, storage: inline({ c: 2, i }) }).version.versionNo);
  }
  assert.deepEqual(got, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  other.close(); s.close();
});
test('drafts are editable; content is immutable once out of draft (service and database)', () => {
  const { s, db, nx, me, sys } = setup();
  const a = nx.artifacts.create(me, { projectId: 'p-ledger', workspaceId: 'sde', kind: 'report', name: 'r' });
  const { version: v } = nx.artifacts.registerVersion(me, { artifactId: a.id, storage: inline({ t: 1 }) });
  const edited = nx.artifacts.updateDraft(me, v.id, { storage: inline({ t: 2 }) });
  assert.notEqual(edited.contentHash, v.contentHash);
  nx.artifacts.finalize(sys, v.id, 'candidate');
  assert.throws(() => nx.artifacts.updateDraft(me, v.id, { metadata: { x: 1 } }), (e) => e.code === 'immutable');
  assert.throws(() => db.prepare("UPDATE artifact_versions SET metadata_json='{\"x\":1}' WHERE id=?").run(v.id), /immutable after draft/);
  assert.throws(() => db.prepare('UPDATE artifact_versions SET version_no=9 WHERE id=?').run(v.id), /identity is immutable/);
  assert.throws(() => db.prepare('DELETE FROM artifact_versions WHERE id=?').run(v.id), /never deleted/);
  assert.throws(() => nx.artifacts.finalize(me, v.id, 'candidate'), (e) => e.code === 'denied');   // users cannot act as the engine
  s.close();
});
test('only F.7 transitions are possible, even with raw SQL', () => {
  const { s, db, nx, me } = setup();
  const a = nx.artifacts.create(me, { projectId: 'p-ledger', workspaceId: 'sde', kind: 'report', name: 'r' });
  const { version: v } = nx.artifacts.registerVersion(me, { artifactId: a.id, storage: inline({}) });
  assert.throws(() => db.prepare("UPDATE artifact_versions SET status='active' WHERE id=?").run(v.id), /illegal version transition/);
  assert.equal(nx.artifacts.discard(me, v.id).status, 'deprecated');
  assert.throws(() => db.prepare("UPDATE artifact_versions SET status='draft' WHERE id=?").run(v.id), /illegal version transition/);
  s.close();
});
test('promotion is compare-and-set; the previous current version is deprecated', () => {
  const { s, nx, me, sys } = setup();
  const a = nx.artifacts.create(me, { projectId: 'p-ledger', workspaceId: 'sde', kind: 'report', name: 'r' });
  const v1 = nx.artifacts.registerVersion(me, { artifactId: a.id, storage: inline({ n: 1 }) }).version;
  const v2 = nx.artifacts.registerVersion(me, { artifactId: a.id, storage: inline({ n: 2 }) }).version;
  nx.artifacts.finalize(sys, v1.id, 'candidate'); nx.artifacts.finalize(sys, v2.id, 'candidate');
  assert.equal(nx.artifacts.promote(me, v1.id, null).ok, true);
  assert.deepEqual(nx.artifacts.promote(me, v2.id, null), { ok: false, code: 'conflict', currentVersionId: v1.id });
  const r = nx.artifacts.promote(me, v2.id, v1.id);
  assert.equal(r.ok, true); assert.equal(r.previous, v1.id);
  assert.equal(nx.artifacts.get(me, a.id).currentVersionId, v2.id);
  assert.equal(nx.artifacts.getVersion(me, v1.id).status, 'deprecated');
  assert.equal(nx.artifacts.promote(me, v1.id, v2.id).ok, true);                 // rollback by CAS
  s.close();
});
test('a discarded version that was never active cannot be rolled back into service', () => {
  const { s, nx, me } = setup();
  const a = nx.artifacts.create(me, { projectId: 'p-ledger', workspaceId: 'sde', kind: 'report', name: 'r' });
  const v = nx.artifacts.registerVersion(me, { artifactId: a.id, storage: inline({}) }).version;
  nx.artifacts.discard(me, v.id);
  assert.throws(() => nx.artifacts.promote(me, v.id, null), (e) => e.code === 'illegal_transition');
  assert.equal(nx.artifacts.get(me, a.id).currentVersionId, null);
  s.close();
});
test('the current pointer is always an active version of the same artifact', () => {
  const { s, db, nx, me, sys } = setup();
  const a = nx.artifacts.create(me, { projectId: 'p-ledger', workspaceId: 'sde', kind: 'report', name: 'a' });
  const b = nx.artifacts.create(me, { projectId: 'p-ledger', workspaceId: 'sde', kind: 'report', name: 'b' });
  const va = nx.artifacts.registerVersion(me, { artifactId: a.id, storage: inline({}) }).version;
  const vb = nx.artifacts.registerVersion(me, { artifactId: b.id, storage: inline({}) }).version;
  assert.throws(() => db.prepare('UPDATE artifacts SET current_version_id=? WHERE id=?').run(va.id, a.id), /active version of this artifact/);
  nx.artifacts.finalize(sys, vb.id, 'candidate'); nx.artifacts.promote(me, vb.id, null);
  assert.throws(() => db.prepare('UPDATE artifacts SET current_version_id=? WHERE id=?').run(vb.id, a.id), /active version of this artifact/);
  assert.throws(() => db.prepare("UPDATE artifact_versions SET status='deprecated' WHERE id=?").run(vb.id), /move the current pointer/);
  assert.throws(() => db.prepare('UPDATE artifacts SET current_version_id=NULL WHERE id=?').run(b.id), /not be cleared/);
  s.close();
});
test('a failed registration leaves no orphan rows and no activity', () => {
  const { s, db, nx, me } = setup();
  const a = nx.artifacts.create(me, { projectId: 'p-ledger', workspaceId: 'sde', kind: 'report', name: 'r' });
  const before = { v: h.count(db, 'artifact_versions'), e: h.count(db, 'artifact_edges'), act: h.count(db, 'activity') };
  assert.throws(() => nx.artifacts.registerVersion(me, { artifactId: a.id, storage: inline({}),
    inputs: [{ versionId: 'missing', role: 'source', relation: 'derived_from' }] }), (e) => e.code === 'not_found');
  assert.deepEqual({ v: h.count(db, 'artifact_versions'), e: h.count(db, 'artifact_edges'), act: h.count(db, 'activity') }, before);
  s.close();
});
test('inputs that carry a relation become edges in the same registration; drafts are not inputs', () => {
  const { s, db, nx, me, sys } = setup();
  const src = nx.artifacts.create(me, { projectId: 'p-ledger', workspaceId: 'sde', kind: 'dataset', name: 'src' });
  const out = nx.artifacts.create(me, { projectId: 'p-ledger', workspaceId: 'sde', kind: 'report', name: 'out' });
  const s1 = nx.artifacts.registerVersion(me, { artifactId: src.id, storage: inline({ s: 1 }) }).version;
  assert.throws(() => nx.artifacts.registerVersion(me, { artifactId: out.id, storage: inline({}),
    inputs: [{ versionId: s1.id, role: 'source', relation: 'derived_from' }] }), (e) => e.code === 'invalid');   // still a draft
  nx.artifacts.finalize(sys, s1.id, 'candidate');
  const s2 = nx.artifacts.registerVersion(me, { artifactId: src.id, storage: inline({ s: 2 }) }).version;
  nx.artifacts.finalize(sys, s2.id, 'candidate');
  const v = nx.artifacts.registerVersion(me, { artifactId: out.id, storage: inline({}),
    inputs: [{ versionId: s1.id, role: 'source', relation: 'derived_from' }, { versionId: s2.id, role: 'context' }] }).version;
  assert.deepEqual(v.inputs, [{ versionId: s1.id, role: 'source' }, { versionId: s2.id, role: 'context' }]);
  const edges = db.prepare('SELECT from_version_id, to_version_id, relation, source, job_id FROM artifact_edges').all();
  assert.deepEqual(edges, [{ from_version_id: v.id, to_version_id: s1.id, relation: 'derived_from', source: 'user_action', job_id: null }]);
  assert.throws(() => nx.artifacts.registerVersion(me, { artifactId: out.id, storage: inline({}),
    inputs: [{ versionId: s1.id, role: 'source', relation: 'not_a_relation' }] }), (e) => e.code === 'invalid');
  s.close();
});
test('only the owner participation appends; a withdrawn owner freezes its artifacts', () => {
  const { s, db, nx, me } = setup();
  nx.workspaces.attach(me, 'p-ledger', 'qa');
  const qaArt = nx.artifacts.create(me, { projectId: 'p-ledger', workspaceId: 'qa', kind: 'test_plan', name: 'plan' });
  const sdePw = nx.workspaces.primaryOf(me, 'p-ledger').id;
  assert.throws(() => db.prepare(`INSERT INTO artifact_versions (id,artifact_id,version_no,project_id,participation_id,status,storage_kind,
    storage_ref_json,content_hash,actor_id,on_behalf_of,created_at,status_changed_at) VALUES ('x',?,1,'p-ledger',?,'draft','inline','{}','h','user:local','user:local',1,1)`)
    .run(qaArt.id, sdePw), /owning participation/);
  nx.workspaces.withdraw(me, qaArt.ownerParticipationId);
  assert.throws(() => nx.artifacts.registerVersion(me, { artifactId: qaArt.id, storage: inline({}) }), (e) => e.code === 'participation_inactive');
  s.close();
});
test('a workspace grant authorizes through the STORED owner participation, and only while it is active', () => {
  const { s, db, nx, me } = setup();
  db.prepare("INSERT INTO principals (id,kind,display_name,disabled_at,created_at) VALUES ('user:tester','user','Tester',NULL,1)").run();
  db.prepare("INSERT INTO memberships (principal_id,scope_type,scope_id,role,created_at) VALUES ('user:tester','workspace','qa','member',1)").run();
  const tester = { id: 'user:tester', kind: 'user', displayName: 'Tester' };
  nx.workspaces.attach(me, 'p-ledger', 'qa');
  const mine = nx.artifacts.create(tester, { projectId: 'p-ledger', workspaceId: 'qa', kind: 'test_plan', name: 'plan' });
  assert.equal(mine.ownerWorkspaceId, 'qa');
  const sdeArt = nx.artifacts.create(me, { projectId: 'p-ledger', workspaceId: 'sde', kind: 'report', name: 'r' });
  assert.throws(() => nx.artifacts.create(tester, { projectId: 'p-ledger', workspaceId: 'sde', kind: 'report', name: 'x' }), (e) => e.code === 'denied');
  assert.throws(() => nx.artifacts.registerVersion(tester, { artifactId: sdeArt.id, storage: inline({}) }), (e) => e.code === 'denied');
  assert.equal(nx.artifacts.registerVersion(tester, { artifactId: mine.id, storage: inline({}) }).created, true);
  nx.workspaces.withdraw(me, mine.ownerParticipationId);
  assert.throws(() => nx.artifacts.get(tester, mine.id), (e) => e.code === 'denied');
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM activity WHERE status='denied'").get().n, 3);
  s.close();
});
test('registration is idempotent per (job, clientKey)', () => {
  const { s, db, nx, me } = setup();
  const pw = nx.workspaces.primaryOf(me, 'p-ledger').id;
  db.prepare(`INSERT INTO jobs (id,kind,project_id,workspace_id,participation_id,idempotency_key,requested_by,on_behalf_of,created_at,updated_at,state_changed_at)
    VALUES ('j1','tool.run','p-ledger','sde',?,'k1','user:local','user:local',1,1,1)`).run(pw);   // tool.run: agent.run needs a session (T10)
  const a = nx.artifacts.create(me, { projectId: 'p-ledger', workspaceId: 'sde', kind: 'report', name: 'r' });
  const first = nx.artifacts.registerVersion(me, { artifactId: a.id, storage: inline({}), producedByJobId: 'j1', clientKey: 'call-1' });
  const again = nx.artifacts.registerVersion(me, { artifactId: a.id, storage: inline({}), producedByJobId: 'j1', clientKey: 'call-1' });
  assert.equal(again.created, false); assert.equal(again.version.id, first.version.id);
  s.close();
});
test('a job may only consume the versions it was granted; a refusal writes one denied row', () => {
  const { s, db, nx, me, sys } = setup();
  const pw = nx.workspaces.primaryOf(me, 'p-ledger').id;
  db.prepare(`INSERT INTO jobs (id,kind,project_id,workspace_id,participation_id,idempotency_key,requested_by,on_behalf_of,created_at,updated_at,state_changed_at)
    VALUES ('j2','tool.run','p-ledger','sde',?,'k2','user:local','user:local',1,1,1)`).run(pw);
  const src = nx.artifacts.create(me, { projectId: 'p-ledger', workspaceId: 'sde', kind: 'dataset', name: 'src' });
  const out = nx.artifacts.create(me, { projectId: 'p-ledger', workspaceId: 'sde', kind: 'report', name: 'out' });
  const granted = nx.artifacts.registerVersion(me, { artifactId: src.id, storage: inline({ g: 1 }) }).version;
  const other = nx.artifacts.registerVersion(me, { artifactId: src.id, storage: inline({ g: 2 }) }).version;
  nx.artifacts.finalize(sys, granted.id, 'candidate'); nx.artifacts.finalize(sys, other.id, 'candidate');
  db.prepare("INSERT INTO job_inputs (job_id,version_id,role,content_hash) VALUES ('j2',?,'source',?)").run(granted.id, granted.contentHash);
  const before = { v: h.count(db, 'artifact_versions'), e: h.count(db, 'artifact_edges') };
  assert.throws(() => nx.artifacts.registerVersion(me, { artifactId: out.id, storage: inline({}), producedByJobId: 'j2',
    inputs: [{ versionId: other.id, role: 'source', relation: 'derived_from' }] }), (e) => e.code === 'input_not_granted');
  assert.deepEqual({ v: h.count(db, 'artifact_versions'), e: h.count(db, 'artifact_edges') }, before);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM activity WHERE status='denied' AND action='version.register'").get().n, 1);
  const ok = nx.artifacts.registerVersion(me, { artifactId: out.id, storage: inline({}), producedByJobId: 'j2',
    inputs: [{ versionId: granted.id, role: 'source', relation: 'derived_from' }] }).version;
  assert.equal(ok.producedByJobId, 'j2');
  assert.deepEqual(db.prepare('SELECT source, job_id FROM artifact_edges WHERE from_version_id=?').all(ok.id), [{ source: 'job_input', job_id: 'j2' }]);
  s.close();
});
test('storage beyond inline and git is refused until the blob store exists', () => {
  const { s, nx, me } = setup();
  const a = nx.artifacts.create(me, { projectId: 'p-ledger', workspaceId: 'sde', kind: 'report', name: 'r' });
  assert.throws(() => nx.artifacts.registerVersion(me, { artifactId: a.id, storage: { kind: 'blob', sha256: 'a'.repeat(64), bytes: 1, mediaType: 'text/plain' } }),
    (e) => e.code === 'storage_unavailable');
  assert.throws(() => nx.artifacts.registerVersion(me, { artifactId: a.id, storage: inline('x'.repeat(70000)) }), (e) => e.code === 'invalid');
  s.close();
});
test('each mutation writes exactly one activity row; a denial writes one denied row', () => {
  const { s, db, nx, me } = setup();
  const n0 = h.count(db, 'activity');
  const a = nx.artifacts.create(me, { projectId: 'p-ledger', workspaceId: 'sde', kind: 'report', name: 'r' });
  nx.artifacts.registerVersion(me, { artifactId: a.id, storage: inline({}) });
  assert.equal(h.count(db, 'activity'), n0 + 2);
  assert.throws(() => nx.artifacts.create({ id: 'user:guest', kind: 'user', displayName: 'g' }, { projectId: 'p-ledger', workspaceId: 'sde', kind: 'report', name: 'x' }));
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM activity WHERE status='denied'").get().n, 1);
  s.close();
});
test('artifacts-by-project reads use ix_artifacts_project_kind', () => {
  const { s, db } = setup();
  // Brief fix: better-sqlite3 refuses unbound parameters, so the plan query binds values.
  const plan = db.prepare('EXPLAIN QUERY PLAN SELECT * FROM artifacts WHERE project_id=? AND kind=?').all('p-ledger', 'report').map((r) => r.detail).join(' ');
  assert.match(plan, /ix_artifacts_project_kind/);
  s.close();
});

// ---------- fix round 1 ----------
function insertJob(db, id, projectId, workspaceId, participationId) {
  db.prepare(`INSERT INTO jobs (id,kind,project_id,workspace_id,participation_id,idempotency_key,requested_by,on_behalf_of,created_at,updated_at,state_changed_at)
    VALUES (?,'tool.run',?,?,?,?,'user:local','user:local',1,1,1)`).run(id, projectId, workspaceId, participationId, `key-${id}`);
}
function candidates(nx, me, sys, artifactId, n) {
  return Array.from({ length: n }, (_, i) => {
    const v = nx.artifacts.registerVersion(me, { artifactId, storage: inline({ c: i }) }).version;
    return nx.artifacts.finalize(sys, v.id, 'candidate');
  });
}
const deniedRegister = (db) => db.prepare("SELECT COUNT(*) AS n FROM activity WHERE status='denied' AND action='version.register'").get().n;
const tick = () => new Promise((r) => setTimeout(r, 50));

test('fix 1: an input_not_granted refusal inside a caller transaction that rolls back still leaves one denied row', async () => {
  const { s, db, nx, me, sys } = setup();
  insertJob(db, 'j-tx', 'p-ledger', 'sde', nx.workspaces.primaryOf(me, 'p-ledger').id);
  const src = nx.artifacts.create(me, { projectId: 'p-ledger', workspaceId: 'sde', kind: 'dataset', name: 'src' });
  const out = nx.artifacts.create(me, { projectId: 'p-ledger', workspaceId: 'sde', kind: 'report', name: 'out' });
  const [ungranted] = candidates(nx, me, sys, src.id, 1);
  const versionsBefore = h.count(db, 'artifact_versions');
  assert.throws(() => db.transaction(() => {
    nx.artifacts.registerVersion(me, { artifactId: out.id, storage: inline({}), producedByJobId: 'j-tx', inputs: [{ versionId: ungranted.id, role: 'source' }] });
  }).immediate(), (e) => e.code === 'input_not_granted' && e.detail.audited === 'deferred');
  assert.equal(deniedRegister(db), 0);                    // not written into the transaction that rolled back
  await tick();
  assert.equal(deniedRegister(db), 1);
  assert.equal(h.count(db, 'artifact_versions'), versionsBefore);
  s.close();
});
test('fix 2: a job input grant is per (version, role)', () => {
  const { s, db, nx, me, sys } = setup();
  insertJob(db, 'j-role', 'p-ledger', 'sde', nx.workspaces.primaryOf(me, 'p-ledger').id);
  const src = nx.artifacts.create(me, { projectId: 'p-ledger', workspaceId: 'sde', kind: 'dataset', name: 'src' });
  const out = nx.artifacts.create(me, { projectId: 'p-ledger', workspaceId: 'sde', kind: 'report', name: 'out' });
  const [v] = candidates(nx, me, sys, src.id, 1);
  db.prepare("INSERT INTO job_inputs (job_id,version_id,role,content_hash) VALUES ('j-role',?,'context',?)").run(v.id, v.contentHash);
  assert.throws(() => nx.artifacts.registerVersion(me, { artifactId: out.id, storage: inline({}), producedByJobId: 'j-role',
    inputs: [{ versionId: v.id, role: 'source' }] }), (e) => e.code === 'input_not_granted');
  assert.equal(deniedRegister(db), 1);
  assert.equal(nx.artifacts.registerVersion(me, { artifactId: out.id, storage: inline({}), producedByJobId: 'j-role',
    inputs: [{ versionId: v.id, role: 'context' }] }).created, true);
  s.close();
});
test('fix 3: an unknown or foreign producer is refused before the grant check, with no denied row', () => {
  const { s, db, nx, me, sys } = setup();
  insertJob(db, 'j-other', 'p-invoice', 'dl', nx.workspaces.primaryOf(me, 'p-invoice').id);
  const src = nx.artifacts.create(me, { projectId: 'p-ledger', workspaceId: 'sde', kind: 'dataset', name: 'src' });
  const out = nx.artifacts.create(me, { projectId: 'p-ledger', workspaceId: 'sde', kind: 'report', name: 'out' });
  const [v] = candidates(nx, me, sys, src.id, 1);
  const inputs = [{ versionId: v.id, role: 'source' }];   // not granted to any job
  assert.throws(() => nx.artifacts.registerVersion(me, { artifactId: out.id, storage: inline({}), producedByJobId: 'j-missing', inputs }), (e) => e.code === 'not_found');
  assert.throws(() => nx.artifacts.registerVersion(me, { artifactId: out.id, storage: inline({}), producedByJobId: 'j-other', inputs }), (e) => e.code === 'invalid');
  assert.throws(() => nx.artifacts.registerVersion(me, { artifactId: out.id, storage: inline({}), producedBySessionId: 's-missing' }), (e) => e.code === 'not_found');
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM activity WHERE status='denied'").get().n, 0);
  s.close();
});
test('fix 4: the producing job or session must act for the artifact owner participation', () => {
  const { s, db, nx, me } = setup();
  const sdePw = nx.workspaces.primaryOf(me, 'p-ledger').id;
  const qaPw = nx.workspaces.attach(me, 'p-ledger', 'qa').id;
  const qaArt = nx.artifacts.create(me, { projectId: 'p-ledger', workspaceId: 'qa', kind: 'test_plan', name: 'plan' });
  insertJob(db, 'j-sde', 'p-ledger', 'sde', sdePw);
  insertJob(db, 'j-none', 'p-ledger', 'sde', null);
  insertJob(db, 'j-qa', 'p-ledger', 'qa', qaPw);
  const session = db.prepare(`INSERT INTO agent_sessions (id,project_id,workspace_id,participation_id,principal_id,idempotency_key,created_at,updated_at,status_changed_at)
    VALUES (?,'p-ledger',?,?,'user:local',?,1,1,1)`);
  session.run('s-sde', 'sde', sdePw, 'sk-sde'); session.run('s-qa', 'qa', qaPw, 'sk-qa');
  for (const producedByJobId of ['j-sde', 'j-none']) {
    assert.throws(() => nx.artifacts.registerVersion(me, { artifactId: qaArt.id, storage: inline({}), producedByJobId }), (e) => e.code === 'invalid', producedByJobId);
  }
  assert.throws(() => nx.artifacts.registerVersion(me, { artifactId: qaArt.id, storage: inline({}), producedBySessionId: 's-sde' }), (e) => e.code === 'invalid');
  const v = nx.artifacts.registerVersion(me, { artifactId: qaArt.id, storage: inline({}), producedByJobId: 'j-qa', producedBySessionId: 's-qa' }).version;
  assert.deepEqual([v.producedByJobId, v.producedBySessionId], ['j-qa', 's-qa']);
  s.close();
});
test('fix 6: a frozen draft can be finalized only as failed', () => {
  const { s, nx, me, sys } = setup();
  nx.workspaces.attach(me, 'p-ledger', 'qa');
  const qaArt = nx.artifacts.create(me, { projectId: 'p-ledger', workspaceId: 'qa', kind: 'test_plan', name: 'plan' });
  const v = nx.artifacts.registerVersion(me, { artifactId: qaArt.id, storage: inline({}) }).version;
  nx.workspaces.withdraw(me, qaArt.ownerParticipationId);
  assert.throws(() => nx.artifacts.finalize(sys, v.id, 'candidate'), (e) => e.code === 'participation_inactive');
  assert.equal(nx.artifacts.getVersion(me, v.id).status, 'draft');
  assert.equal(nx.artifacts.finalize(sys, v.id, 'failed').status, 'failed');
  s.close();
});
test('fix 7: a repeated (job, clientKey) with different content is a conflict', () => {
  const { s, db, nx, me } = setup();
  insertJob(db, 'j-idem', 'p-ledger', 'sde', nx.workspaces.primaryOf(me, 'p-ledger').id);
  const a = nx.artifacts.create(me, { projectId: 'p-ledger', workspaceId: 'sde', kind: 'report', name: 'r' });
  const first = nx.artifacts.registerVersion(me, { artifactId: a.id, storage: inline({ n: 1 }), producedByJobId: 'j-idem', clientKey: 'call-1' });
  assert.throws(() => nx.artifacts.registerVersion(me, { artifactId: a.id, storage: inline({ n: 2 }), producedByJobId: 'j-idem', clientKey: 'call-1' }),
    (e) => e.code === 'conflict');
  const again = nx.artifacts.registerVersion(me, { artifactId: a.id, storage: inline({ n: 1 }), producedByJobId: 'j-idem', clientKey: 'call-1' });
  assert.deepEqual([again.created, again.version.id], [false, first.version.id]);
  assert.equal(h.count(db, 'artifact_versions'), 1);
  s.close();
});
test('fix 8: a write lock held past busy_timeout surfaces as platform_unavailable', () => {
  const { s, db, nx, me, file } = setup();
  const a = nx.artifacts.create(me, { projectId: 'p-ledger', workspaceId: 'sde', kind: 'report', name: 'r' });
  const other = h.openRaw(file);
  other.prepare('BEGIN IMMEDIATE').run();
  db.pragma('busy_timeout = 50');
  try {
    assert.throws(() => nx.artifacts.create(me, { projectId: 'p-ledger', workspaceId: 'sde', kind: 'report', name: 'x' }),
      (e) => e.code === 'platform_unavailable' && /^SQLITE_BUSY/.test(e.detail.sqliteCode));
    assert.throws(() => nx.artifacts.registerVersion(me, { artifactId: a.id, storage: inline({}) }), (e) => e.code === 'platform_unavailable');
  } finally { other.prepare('ROLLBACK').run(); other.close(); }
  assert.equal(nx.artifacts.registerVersion(me, { artifactId: a.id, storage: inline({}) }).created, true);
  s.close();
});

// ---------- fix round 2 ----------
test('N1: an own __proto__ key is refused in inline json and in metadata; nothing is written', () => {
  const { s, db, nx, me } = setup();
  const a = nx.artifacts.create(me, { projectId: 'p-ledger', workspaceId: 'sde', kind: 'report', name: 'r' });
  const before = { v: h.count(db, 'artifact_versions'), act: h.count(db, 'activity') };
  assert.throws(() => nx.artifacts.registerVersion(me, { artifactId: a.id, storage: inline(JSON.parse('{"__proto__":{"a":1}}')) }), (e) => e.code === 'invalid');
  assert.throws(() => nx.artifacts.registerVersion(me, { artifactId: a.id, storage: inline({}),
    metadata: { nested: [JSON.parse('{"ok":1,"__proto__":{"a":1}}')] } }), (e) => e.code === 'invalid');
  assert.throws(() => nx.artifacts.registerVersion(me, { artifactId: a.id, storage: inline({}),
    ioContract: JSON.parse('{"__proto__":{}}') }), (e) => e.code === 'invalid');
  assert.deepEqual({ v: h.count(db, 'artifact_versions'), act: h.count(db, 'activity') }, before);
  s.close();
});
test('N2: auditDenial records the stored principal, keeps the claim, fixes reason and caps every id', () => {
  const { s, db, nx } = setup();
  const last = () => db.prepare('SELECT * FROM activity ORDER BY seq DESC LIMIT 1').get();
  assert.equal(nx.auth.auditDenial({ id: 'user:local', kind: 'system', displayName: 'x' },
    { action: 'version.register', reason: 'input_not_granted', details: { claimedKind: 'user', reason: 'other', needed: 'owner' } }), true);
  let r = last();
  assert.deepEqual([r.actor_kind, r.actor_id, r.status, r.action], ['user', 'user:local', 'denied', 'version.register']);
  assert.deepEqual(JSON.parse(r.details_json), { claimedKind: 'system', reason: 'input_not_granted' });
  const long = (c) => c.repeat(5000);
  nx.auth.auditDenial({ id: long('u'), kind: 'system', displayName: 'x' }, { action: long('a'), reason: long('r'),
    projectId: long('p'), workspaceId: long('w'), artifactId: long('f'), versionId: long('v'), jobId: long('j'),
    sessionId: long('s'), onBehalfOf: long('o'), entityType: long('t'), entityId: long('e') });
  r = last();
  for (const col of ['actor_id', 'action', 'project_id', 'workspace_id', 'artifact_id', 'version_id', 'job_id', 'session_id',
    'on_behalf_of', 'entity_type', 'entity_id']) assert.equal(r[col].length, 128, col);
  assert.equal(JSON.parse(r.details_json).reason.length, 128);
  assert.equal(r.status, 'denied');
  // An unknown id claiming 'system' is recorded as 'user' with the claim, and the cut is flagged.
  assert.equal(r.actor_kind, 'user');
  assert.deepEqual([JSON.parse(r.details_json).claimedKind, JSON.parse(r.details_json).truncated], ['system', true]);
  s.close();
});

test('final fix 1: secret-shaped name, description, metadata or ioContract is refused before any write (inline content is not checked)', () => {
  const { s, db, nx, me } = setup();
  const SK = `sk-ant-api03-${'A1b2C3d4'.repeat(8)}`;
  const GHP = `ghp_${'a1B2c3D4e5'.repeat(4)}`.slice(0, 40);
  const isSecret = (e) => e.code === 'invalid' && e.detail?.reason === 'secret_in_metadata';
  const rows = () => [h.count(db, 'artifacts'), h.count(db, 'artifact_versions'), h.count(db, 'activity')];
  const base = { projectId: 'p-ledger', workspaceId: 'sde', kind: 'report' };
  let before = rows();
  assert.throws(() => nx.artifacts.create(me, { ...base, name: 'n', metadata: { apiKey: SK } }), isSecret);
  assert.throws(() => nx.artifacts.create(me, { ...base, name: 'n', metadata: { note: SK } }), isSecret);
  assert.throws(() => nx.artifacts.create(me, { ...base, name: 'n', description: `clone with ${GHP}` }), isSecret);
  assert.throws(() => nx.artifacts.create(me, { ...base, name: `token ${GHP}` }), isSecret);
  assert.deepEqual(rows(), before);
  const a = nx.artifacts.create(me, { ...base, name: 'clean', description: 'plain words', metadata: { tokensUsed: 12 } });
  const v = nx.artifacts.registerVersion(me, { artifactId: a.id, storage: inline({ d: 1 }) }).version;
  before = rows();
  const vrow = () => db.prepare('SELECT metadata_json, io_contract_json FROM artifact_versions WHERE id=?').get(v.id);
  const stored = vrow();
  assert.throws(() => nx.artifacts.registerVersion(me, { artifactId: a.id, storage: inline({ d: 2 }), metadata: { apiKey: SK } }), isSecret);
  assert.throws(() => nx.artifacts.registerVersion(me, { artifactId: a.id, storage: inline({ d: 2 }), ioContract: { auth: SK } }), isSecret);
  assert.throws(() => nx.artifacts.registerVersion(me, { artifactId: a.id, storage: inline({ d: 2 }), ioContract: { in: [GHP] } }), isSecret);
  assert.throws(() => nx.artifacts.updateDraft(me, v.id, { metadata: { apiKey: SK } }), isSecret);
  assert.throws(() => nx.artifacts.updateDraft(me, v.id, { ioContract: { header: `Bearer ${GHP}` } }), isSecret);
  assert.deepEqual(rows(), before);
  assert.deepEqual(vrow(), stored);
  // Inline storage CONTENT is product data: not secret-checked (secrets travel by reference).
  assert.equal(nx.artifacts.registerVersion(me, { artifactId: a.id, storage: inline({ sample: SK }) }).created, true);
  s.close();
});
