'use strict';
// B1 Task 3: platform service additions. Single-transaction user saves, mark ready on the
// user's behalf, source links, cross-project reads and the withdraw guard. Real SQLite only.
const h = require('./helpers/sqlite.cjs');
if (!h.realSqliteOrSkip()) return;
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');
const { PersistStore } = loadTs('src/main/db.ts');
const { createNexusPlatform } = loadTs('src/main/nexus/platform.ts');
const { WorkspaceService } = loadTs('src/main/nexus/workspace/workspaceService.ts');
const { verifyActivityChain } = loadTs('src/main/nexus/activity/writer.ts');

function setup() {
  const { file } = h.v6Fixture(); const s = new PersistStore(file);
  s.open({ log: () => {}, backupDir: path.join(path.dirname(file), 'b'), now: () => h.NOW });
  const db = s.platformDatabase(); const nx = createNexusPlatform(db, { now: () => h.NOW });
  return { s, db, nx, me: nx.principals.localUser(), sys: nx.principals.system() };
}
/** Every test ends here: the activity chain still verifies after what it did. */
function done(s, db) {
  assert.equal(verifyActivityChain(db).ok, true, 'activity chain verifies');
  s.close();
}
const sha = (n) => n.toString(16).padStart(40, '0');
const commitSave = (projectId, workspaceId, target, commit = sha(1)) => ({
  projectId, workspaceId, kind: 'git_commit', target, storage: { kind: 'git', commit }, metadata: { subject: 'Release' }, action: 'user.save_commit'
});
const textSave = (projectId, workspaceId, target, text = 'some text') => ({
  projectId, workspaceId, kind: 'text_file', target, storage: { kind: 'inline', json: { path: 'notes.md', text } },
  metadata: { path: 'notes.md' }, action: 'user.save_file'
});
const count = (db, sql, ...args) => db.prepare(`SELECT COUNT(*) AS n FROM ${sql}`).get(...args).n;
/** A saved text version marked ready (candidate). */
function readyVersion(nx, me, projectId, workspaceId, name, text = name) {
  const { version } = nx.artifacts.saveUserVersion(me, textSave(projectId, workspaceId, { name }, text));
  return nx.artifacts.markReady(me, version.id);
}

test('S1 save as a new artifact is one transaction: a failing version insert leaves no empty artifact; a resend is deduped', () => {
  const { s, db, nx, me } = setup();
  const n0 = db.prepare('SELECT COUNT(*) n FROM artifacts').get().n;
  const a0 = count(db, 'activity');
  db.exec("CREATE TEMP TRIGGER fail_v BEFORE INSERT ON artifact_versions BEGIN SELECT RAISE(ABORT, 'injected'); END;");
  assert.throws(() => nx.artifacts.saveUserVersion(me, commitSave('p-ledger', 'sde', { name: 'Release' })));
  db.exec('DROP TRIGGER temp.fail_v');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM artifacts').get().n, n0);
  assert.equal(count(db, 'activity'), a0, 'no activity row survives the rollback');
  const r = nx.artifacts.saveUserVersion(me, commitSave('p-ledger', 'sde', { name: 'Release' }));
  assert.deepEqual([r.created, r.version.versionNo, r.version.status], [true, 1, 'draft']);
  assert.deepEqual([r.artifact.kind, r.artifact.ownerWorkspaceId, r.version.producedByAction], ['git_commit', 'sde', 'user.save_commit']);
  assert.deepEqual(db.prepare('SELECT action FROM activity WHERE artifact_id = ? ORDER BY seq').all(r.artifact.id).map((x) => x.action),
    ['artifact.create', 'version.register']);
  const a1 = count(db, 'activity');
  const again = nx.artifacts.saveUserVersion(me, commitSave('p-ledger', 'sde', { name: 'Release' }));
  assert.deepEqual([again.created, again.version.id], [false, r.version.id]);
  assert.equal(count(db, 'activity'), a1, 'a deduped resend writes nothing');
  // The dedupe looks at the latest LIVE version only: once discarded, the same content saves again.
  nx.artifacts.discard(me, r.version.id);
  const fresh = nx.artifacts.saveUserVersion(me, commitSave('p-ledger', 'sde', { name: 'Release' }));
  assert.equal(fresh.created, true); assert.notEqual(fresh.artifact.id, r.artifact.id);
  // The dedupe is per owner participation: the same name and hash in qa and in another project are new artifacts.
  nx.workspaces.attach(me, 'p-ledger', 'qa');
  const inQa = nx.artifacts.saveUserVersion(me, commitSave('p-ledger', 'qa', { name: 'Release' }));
  const invoicePrimary = nx.workspaces.primaryOf(me, 'p-invoice').workspaceId;
  const inInvoice = nx.artifacts.saveUserVersion(me, commitSave('p-invoice', invoicePrimary, { name: 'Release' }));
  assert.deepEqual([inQa.created, inInvoice.created], [true, true]);
  assert.equal(new Set([fresh.artifact.id, inQa.artifact.id, inInvoice.artifact.id]).size, 3);
  assert.equal(new Set([fresh.version.contentHash, inQa.version.contentHash, inInvoice.version.contentHash]).size, 1);
  done(s, db);
});

test('S2 append gives v2; a kind mismatch and a workspace other than the owner\'s are invalid', () => {
  const { s, db, nx, me } = setup();
  const r = nx.artifacts.saveUserVersion(me, commitSave('p-ledger', 'sde', { name: 'Release' }));
  const v2 = nx.artifacts.saveUserVersion(me, commitSave('p-ledger', 'sde', { artifactId: r.artifact.id }, sha(2)));
  assert.deepEqual([v2.created, v2.version.versionNo, v2.artifact.id], [true, 2, r.artifact.id]);
  const same = nx.artifacts.saveUserVersion(me, commitSave('p-ledger', 'sde', { artifactId: r.artifact.id }, sha(2)));
  assert.deepEqual([same.created, same.version.id], [false, v2.version.id]);
  assert.throws(() => nx.artifacts.saveUserVersion(me, textSave('p-ledger', 'sde', { artifactId: r.artifact.id })),
    (e) => e.code === 'invalid' && e.detail?.reason === 'kind_mismatch');
  nx.workspaces.attach(me, 'p-ledger', 'qa');
  assert.throws(() => nx.artifacts.saveUserVersion(me, commitSave('p-ledger', 'qa', { artifactId: r.artifact.id }, sha(3))), (e) => e.code === 'invalid');
  assert.throws(() => nx.artifacts.saveUserVersion(me, commitSave('p-invoice', 'sde', { artifactId: r.artifact.id }, sha(3))), (e) => e.code === 'invalid');
  // Malformed inputs: a kind outside the user-save set, a storage that does not fit the kind, a two-key target.
  assert.throws(() => nx.artifacts.saveUserVersion(me, { ...commitSave('p-ledger', 'sde', { name: 'x' }), kind: 'report' }), (e) => e.code === 'invalid');
  assert.throws(() => nx.artifacts.saveUserVersion(me, { ...commitSave('p-ledger', 'sde', { name: 'x' }), storage: { kind: 'inline', json: {} } }), (e) => e.code === 'invalid');
  assert.throws(() => nx.artifacts.saveUserVersion(me, commitSave('p-ledger', 'sde', { name: 'x', artifactId: r.artifact.id })), (e) => e.code === 'invalid');
  assert.equal(count(db, 'artifact_versions WHERE artifact_id = ?', r.artifact.id), 2);
  done(s, db);
});

test('S3 saving into a non-participating workspace is not_participating; appending to a frozen artifact is participation_inactive', () => {
  const { s, db, nx, me } = setup();
  assert.throws(() => nx.artifacts.saveUserVersion(me, commitSave('p-ledger', 'qa', { name: 'x' })), (e) => e.code === 'not_participating');
  const qa = nx.workspaces.attach(me, 'p-ledger', 'qa');
  const r = nx.artifacts.saveUserVersion(me, commitSave('p-ledger', 'qa', { name: 'QA commit' }));
  assert.equal(r.artifact.ownerParticipationId, qa.id);
  nx.workspaces.withdraw(me, qa.id);
  assert.throws(() => nx.artifacts.saveUserVersion(me, commitSave('p-ledger', 'qa', { artifactId: r.artifact.id }, sha(9))),
    (e) => e.code === 'participation_inactive');
  assert.throws(() => nx.artifacts.saveUserVersion(me, commitSave('p-ledger', 'qa', { name: 'y' })), (e) => e.code === 'not_participating');
  done(s, db);
});

test('S4 markReady runs finalize as the system principal on the user\'s behalf; finalize itself stays system-only', () => {
  const { s, db, nx, me } = setup();
  const { version } = nx.artifacts.saveUserVersion(me, textSave('p-ledger', 'sde', { name: 'Notes' }));
  assert.equal(nx.artifacts.markReady(me, version.id).status, 'candidate');
  const row = db.prepare("SELECT actor_kind, actor_id, on_behalf_of, details_json FROM activity WHERE version_id = ? AND action = 'version.finalize'").get(version.id);
  assert.deepEqual([row.actor_kind, row.actor_id, row.on_behalf_of, JSON.parse(row.details_json).via], ['system', 'system', 'user:local', 'mark_ready']);
  assert.deepEqual(JSON.parse(row.details_json), { from: 'draft', to: 'candidate', via: 'mark_ready' });
  const { version: v2 } = nx.artifacts.saveUserVersion(me, textSave('p-ledger', 'sde', { name: 'Notes2' }));
  assert.throws(() => nx.artifacts.finalize(me, v2.id, 'candidate'), (e) => e.code === 'denied');
  // A principal without the draft-edit right cannot mark ready (denied, audited), and nothing moves.
  db.prepare("INSERT INTO principals VALUES ('user:viewer','user','viewer',NULL,?)").run(h.NOW);
  db.prepare("INSERT INTO memberships VALUES ('user:viewer','project','p-ledger','viewer',?)").run(h.NOW);
  const viewer = { id: 'user:viewer', kind: 'user', displayName: 'viewer' };
  const denied0 = count(db, "activity WHERE status = 'denied'");
  assert.throws(() => nx.artifacts.markReady(viewer, v2.id), (e) => e.code === 'denied');
  assert.equal(count(db, "activity WHERE status = 'denied'"), denied0 + 1);
  assert.equal(nx.artifacts.getVersion(me, v2.id).status, 'draft');
  // A member holding only a qa workspace grant cannot mark an sde draft ready: denied, one audited row.
  nx.workspaces.attach(me, 'p-ledger', 'qa');
  db.prepare("INSERT INTO principals VALUES ('user:qa','user','qa',NULL,?)").run(h.NOW);
  db.prepare("INSERT INTO memberships VALUES ('user:qa','workspace','qa','member',?)").run(h.NOW);
  const qaMember = { id: 'user:qa', kind: 'user', displayName: 'qa' };
  const denied1 = count(db, "activity WHERE status = 'denied'");
  assert.throws(() => nx.artifacts.markReady(qaMember, v2.id), (e) => e.code === 'denied');
  assert.equal(count(db, "activity WHERE status = 'denied'"), denied1 + 1);
  assert.equal(count(db, "activity WHERE status = 'denied' AND actor_id = 'user:qa' AND action = 'version.update_draft'"), 1);
  assert.equal(nx.artifacts.getVersion(me, v2.id).status, 'draft');
  // The system principal is not a user: mark ready is refused for it.
  assert.throws(() => nx.artifacts.markReady(nx.principals.system(), v2.id), (e) => e.code === 'invalid');
  done(s, db);
});

test('S5 markReady: a candidate is returned unchanged; active is illegal_transition; a job-produced draft is invalid (produced_by_job)', () => {
  const { s, db, nx, me } = setup();
  const c = readyVersion(nx, me, 'p-ledger', 'sde', 'Spec');
  const f0 = count(db, "activity WHERE action = 'version.finalize'");
  const again = nx.artifacts.markReady(me, c.id);
  assert.deepEqual([again.status, again.statusChangedAt], ['candidate', c.statusChangedAt]);
  assert.equal(count(db, "activity WHERE action = 'version.finalize'"), f0, 'no second finalize row');
  assert.equal(nx.artifacts.promote(me, c.id, null).ok, true);
  assert.throws(() => nx.artifacts.markReady(me, c.id), (e) => e.code === 'illegal_transition');
  const job = nx.jobs.create(me, { kind: 'tool.run', projectId: 'p-ledger', workspaceId: 'sde', idempotencyKey: 's5-job' }).job;
  const a = nx.artifacts.create(me, { projectId: 'p-ledger', workspaceId: 'sde', kind: 'report', name: 'engine draft' });
  const jv = nx.artifacts.registerVersion(me, { artifactId: a.id, storage: { kind: 'inline', json: { n: 1 } }, producedByJobId: job.id }).version;
  assert.throws(() => nx.artifacts.markReady(me, jv.id), (e) => e.code === 'invalid' && e.detail?.reason === 'produced_by_job');
  assert.equal(nx.artifacts.getVersion(me, jv.id).status, 'draft');
  const session = nx.sessions.open(me, { projectId: 'p-ledger', workspaceId: 'sde', idempotencyKey: 's5-session' }).session;
  const sv = nx.artifacts.registerVersion(me, { artifactId: a.id, storage: { kind: 'inline', json: { n: 2 } }, producedBySessionId: session.id }).version;
  assert.throws(() => nx.artifacts.markReady(me, sv.id), (e) => e.code === 'invalid' && e.detail?.reason === 'produced_by_job');
  assert.equal(nx.artifacts.getVersion(me, sv.id).status, 'draft');
  done(s, db);
});

test('S6 a promote CAS conflict still returns currentVersionId after the helper extraction', () => {
  const { s, db, nx, me } = setup();
  const r = nx.artifacts.saveUserVersion(me, textSave('p-ledger', 'sde', { name: 'Doc' }, 'one'));
  const v2 = nx.artifacts.saveUserVersion(me, textSave('p-ledger', 'sde', { artifactId: r.artifact.id }, 'two')).version;
  nx.artifacts.markReady(me, r.version.id); nx.artifacts.markReady(me, v2.id);
  assert.equal(nx.artifacts.promote(me, r.version.id, null).ok, true);
  assert.deepEqual(nx.artifacts.promote(me, v2.id, null), { ok: false, code: 'conflict', currentVersionId: r.version.id });
  const ok = nx.artifacts.promote(me, v2.id, r.version.id);
  assert.deepEqual([ok.ok, ok.previous, ok.version.status], [true, r.version.id, 'active']);
  done(s, db);
});

test('S7 linkSources writes 3 edges and 3 rows in one transaction; one draft target or a late failure writes nothing', () => {
  const { s, db, nx, me } = setup();
  const from = nx.artifacts.saveUserVersion(me, textSave('p-ledger', 'sde', { name: 'Consumer' })).version;   // a draft consumer is fine
  const t = ['A', 'B', 'C'].map((n) => readyVersion(nx, me, 'p-ledger', 'sde', n));
  const w0 = count(db, "activity WHERE action = 'lineage.write'");
  const r = nx.lineage.linkSources(me, from.id, t.map((v) => v.id));
  assert.equal(r.created, 3); assert.equal(r.edges.length, 3);
  assert.ok(r.edges.every((e) => e.relation === 'derived_from' && e.source === 'user_action' && e.fromVersionId === from.id));
  assert.equal(count(db, "activity WHERE action = 'lineage.write'"), w0 + 3);
  const resend = nx.lineage.linkSources(me, from.id, t.map((v) => v.id));
  assert.equal(resend.created, 0); assert.equal(count(db, "activity WHERE action = 'lineage.write'"), w0 + 3);

  const from2 = nx.artifacts.saveUserVersion(me, textSave('p-ledger', 'sde', { name: 'Consumer2' })).version;
  const draft = nx.artifacts.saveUserVersion(me, textSave('p-ledger', 'sde', { name: 'Draft source' })).version;
  assert.throws(() => nx.lineage.linkSources(me, from2.id, [t[0].id, t[1].id, draft.id]), (e) => e.code === 'invalid');
  assert.equal(count(db, 'artifact_edges WHERE from_version_id = ?', from2.id), 0);
  // A failure on the third edge, inside the transaction, rolls back the first two.
  db.prepare(`CREATE TEMP TRIGGER fail_third BEFORE INSERT ON artifact_edges WHEN NEW.to_version_id = '${t[2].id}'
    BEGIN SELECT RAISE(ABORT, 'injected'); END;`).run();
  const w1 = count(db, "activity WHERE action = 'lineage.write'");
  assert.throws(() => nx.lineage.linkSources(me, from2.id, t.map((v) => v.id)));
  db.exec('DROP TRIGGER temp.fail_third');
  assert.equal(count(db, 'artifact_edges WHERE from_version_id = ?', from2.id), 0);
  assert.equal(count(db, "activity WHERE action = 'lineage.write'"), w1);
  // Bounds: 0 or 21 targets, duplicates and a self link are refused.
  assert.throws(() => nx.lineage.linkSources(me, from2.id, []), (e) => e.code === 'invalid');
  assert.throws(() => nx.lineage.linkSources(me, from2.id, Array.from({ length: 21 }, (_, i) => `v${i}`)), (e) => e.code === 'invalid');
  assert.throws(() => nx.lineage.linkSources(me, from2.id, [t[0].id, t[0].id]), (e) => e.code === 'invalid');
  assert.throws(() => nx.lineage.linkSources(me, from2.id, [from2.id]), (e) => e.code === 'cycle');
  assert.throws(() => nx.lineage.linkSources(nx.principals.system(), from2.id, [t[0].id]), (e) => e.code === 'invalid');
  done(s, db);
});

test('S8 a linkSources that would close a cycle is refused and nothing is written', () => {
  const { s, db, nx, me } = setup();
  const a = readyVersion(nx, me, 'p-ledger', 'sde', 'A');
  const b = readyVersion(nx, me, 'p-ledger', 'sde', 'B');
  const c = readyVersion(nx, me, 'p-ledger', 'sde', 'C');
  nx.lineage.linkSources(me, a.id, [b.id]);                    // a derived_from b
  const e0 = count(db, 'artifact_edges'); const w0 = count(db, "activity WHERE action = 'lineage.write'");
  assert.throws(() => nx.lineage.linkSources(me, b.id, [c.id, a.id]), (e) => e.code === 'cycle');
  assert.equal(count(db, 'artifact_edges'), e0, 'the c edge written first was rolled back');
  assert.equal(count(db, "activity WHERE action = 'lineage.write'"), w0);
  done(s, db);
});

test('S9 a source owned by another workspace of the same project links; a version of another project is invalid', () => {
  const { s, db, nx, me } = setup();
  nx.workspaces.attach(me, 'p-ledger', 'qa');
  const qaV = readyVersion(nx, me, 'p-ledger', 'qa', 'QA report');
  const from = nx.artifacts.saveUserVersion(me, textSave('p-ledger', 'sde', { name: 'Fix' })).version;
  assert.equal(nx.lineage.linkSources(me, from.id, [qaV.id]).created, 1);
  const invoicePrimary = nx.workspaces.primaryOf(me, 'p-invoice').workspaceId;
  const foreign = readyVersion(nx, me, 'p-invoice', invoicePrimary, 'Other project');
  assert.throws(() => nx.lineage.linkSources(me, from.id, [foreign.id]), (e) => e.code === 'invalid');
  assert.equal(count(db, 'artifact_edges WHERE to_version_id = ?', foreign.id), 0);
  // A member holding only an sde grant cannot link to a qa source: denied, one audited row, no edge.
  db.prepare("INSERT INTO principals VALUES ('user:sde','user','sde',NULL,?)").run(h.NOW);
  db.prepare("INSERT INTO memberships VALUES ('user:sde','workspace','sde','member',?)").run(h.NOW);
  const sdeMember = { id: 'user:sde', kind: 'user', displayName: 'sde' };
  const qaV2 = readyVersion(nx, me, 'p-ledger', 'qa', 'QA report 2');
  const denied0 = count(db, "activity WHERE status = 'denied'");
  assert.throws(() => nx.lineage.linkSources(sdeMember, from.id, [qaV2.id]), (e) => e.code === 'denied');
  assert.equal(count(db, "activity WHERE status = 'denied'"), denied0 + 1);
  assert.equal(count(db, "activity WHERE status = 'denied' AND actor_id = 'user:sde' AND action = 'lineage.write'"), 1);
  assert.equal(count(db, 'artifact_edges WHERE to_version_id = ?', qaV2.id), 0);
  done(s, db);
});

test('S10 a viewer of one project gets only that project\'s rows from listForReader, and no denied rows are written', () => {
  const { s, db, nx, me } = setup();
  nx.artifacts.saveUserVersion(me, textSave('p-ledger', 'sde', { name: 'Ledger notes' }));
  const invoicePrimary = nx.workspaces.primaryOf(me, 'p-invoice').workspaceId;
  nx.artifacts.saveUserVersion(me, textSave('p-invoice', invoicePrimary, { name: 'Invoice notes' }));
  db.prepare("INSERT INTO principals VALUES ('user:viewer','user','viewer',NULL,?)").run(h.NOW);
  db.prepare("INSERT INTO memberships VALUES ('user:viewer','project','p-ledger','viewer',?)").run(h.NOW);
  const viewer = { id: 'user:viewer', kind: 'user', displayName: 'viewer' };
  const denied0 = count(db, "activity WHERE status = 'denied'");
  const mine = nx.artifacts.listForReader(me, {});
  assert.deepEqual([...new Set(mine.map((r) => r.artifact.projectId))].sort(), ['p-invoice', 'p-ledger']);
  const seen = nx.artifacts.listForReader(viewer, {});
  assert.ok(seen.length >= 1);
  assert.ok(seen.every((r) => r.artifact.projectId === 'p-ledger'));
  assert.equal(seen.length, mine.filter((r) => r.artifact.projectId === 'p-ledger').length);
  assert.deepEqual(nx.artifacts.listForReader(viewer, { projectId: 'p-invoice' }), []);
  const ws = nx.workspaces.listForReader(viewer);
  assert.ok(ws.length >= 1 && ws.every((r) => r.projectId === 'p-ledger'));
  assert.equal(count(db, "activity WHERE status = 'denied'"), denied0, 'filtering writes no denied rows');
  // Filters and the limit.
  assert.equal(nx.artifacts.listForReader(me, { limit: 1 }).length, 1);
  assert.ok(nx.artifacts.listForReader(me, { kind: 'text_file', status: 'active', workspaceId: 'sde' }).every((r) => r.artifact.ownerWorkspaceId === 'sde'));
  assert.throws(() => nx.artifacts.listForReader(me, { limit: 0 }), (e) => e.code === 'invalid');
  assert.throws(() => nx.artifacts.listForReader(me, { status: 'gone' }), (e) => e.code === 'invalid');
  done(s, db);
});

test('S11 summariesByProject reports latest and current correctly after promote, discard and rollback', () => {
  const { s, db, nx, me } = setup();
  const r = nx.artifacts.saveUserVersion(me, textSave('p-ledger', 'sde', { name: 'Plan' }, 'v1'));
  const id = r.artifact.id;
  const sum = () => nx.artifacts.summariesByProject(me, 'p-ledger').find((x) => x.artifact.id === id);
  assert.deepEqual([sum().versionCount, sum().latest, sum().current], [1, { id: r.version.id, versionNo: 1, status: 'draft' }, null]);
  nx.artifacts.markReady(me, r.version.id); nx.artifacts.promote(me, r.version.id, null);
  const v2 = nx.artifacts.saveUserVersion(me, textSave('p-ledger', 'sde', { artifactId: id }, 'v2')).version;
  nx.artifacts.markReady(me, v2.id); nx.artifacts.promote(me, v2.id, r.version.id);
  const v3 = nx.artifacts.saveUserVersion(me, textSave('p-ledger', 'sde', { artifactId: id }, 'v3')).version;
  nx.artifacts.discard(me, v3.id);
  assert.deepEqual([sum().versionCount, sum().latest, sum().current], [3, { id: v3.id, versionNo: 3, status: 'deprecated' }, { id: v2.id, versionNo: 2 }]);
  assert.equal(nx.artifacts.promote(me, r.version.id, v2.id).ok, true);   // rollback
  assert.deepEqual(sum().current, { id: r.version.id, versionNo: 1 });
  assert.throws(() => nx.artifacts.summariesByProject(me, 'p-none'), (e) => e.code === 'not_found');
  done(s, db);
});

test('S12 workspaces listForReader returns the primary first in each project', () => {
  const { s, db, nx, me } = setup();
  nx.workspaces.attach(me, 'p-ledger', 'qa'); nx.workspaces.attach(me, 'p-ledger', 'devops');
  const rows = nx.workspaces.listForReader(me);
  const byProject = new Map();
  for (const r of rows) { if (!byProject.has(r.projectId)) byProject.set(r.projectId, []); byProject.get(r.projectId).push(r); }
  assert.deepEqual(byProject.get('p-ledger').map((r) => [r.workspaceId, r.isPrimary]), [['sde', true], ['devops', false], ['qa', false]]);
  for (const [pid, list] of byProject) {
    const primary = list.findIndex((r) => r.isPrimary);
    assert.ok(primary <= 0, `${pid}: the primary, when there is one, comes first`);
    assert.deepEqual(list.map((r) => r.id), nx.workspaces.participations(me, pid).map((r) => r.id));
  }
  done(s, db);
});

test('S13 withdraw is refused while openHandoffs reports an open handoff', () => {
  const { s, db, nx, me } = setup();
  const qa = nx.workspaces.attach(me, 'p-ledger', 'qa');
  const seen = [];
  const blocked = new WorkspaceService(db, { auth: nx.auth, now: () => h.NOW, openHandoffs: (id) => { seen.push(id); return 1; } });
  const a0 = count(db, 'activity');
  assert.throws(() => blocked.withdraw(me, qa.id), (e) => e.code === 'conflict' && e.detail?.openHandoffs === 1);
  assert.deepEqual(seen, [qa.id]);
  assert.equal(count(db, 'activity'), a0);
  assert.equal(nx.workspaces.primaryOf(me, 'p-ledger').workspaceId, 'sde');
  assert.equal(db.prepare('SELECT status FROM project_workspaces WHERE id = ?').get(qa.id).status, 'active');
  const free = new WorkspaceService(db, { auth: nx.auth, now: () => h.NOW, openHandoffs: () => 0 });
  assert.equal(free.withdraw(me, qa.id).status, 'withdrawn');
  done(s, db);
});

test('S15 a secret-shaped name or metadata is invalid (secret_in_metadata) and nothing is written', () => {
  const { s, db, nx, me } = setup();
  const SK = `sk-ant-api03-${'A1b2C3d4'.repeat(8)}`;
  const isSecret = (e) => e.code === 'invalid' && e.detail?.reason === 'secret_in_metadata';
  const rows = () => [count(db, 'artifacts'), count(db, 'artifact_versions'), count(db, 'activity')];
  const before = rows();
  assert.throws(() => nx.artifacts.saveUserVersion(me, commitSave('p-ledger', 'sde', { name: `key ${SK}` })), isSecret);
  assert.throws(() => nx.artifacts.saveUserVersion(me, { ...commitSave('p-ledger', 'sde', { name: 'ok' }), metadata: { subject: SK } }), isSecret);
  assert.throws(() => nx.artifacts.saveUserVersion(me, { ...textSave('p-ledger', 'sde', { name: 'ok' }), metadata: { apiKey: 'abc' } }), isSecret);
  assert.deepEqual(rows(), before);
  done(s, db);
});

test('S16 the activity chain verifies after a mixed B1 flow', () => {
  const { s, db, nx, me } = setup();
  const qa = nx.workspaces.attach(me, 'p-ledger', 'qa');
  const a = readyVersion(nx, me, 'p-ledger', 'sde', 'A');
  const b = readyVersion(nx, me, 'p-ledger', 'qa', 'B');
  const c = nx.artifacts.saveUserVersion(me, commitSave('p-ledger', 'sde', { name: 'Commit' })).version;
  nx.lineage.linkSources(me, c.id, [a.id, b.id]);
  nx.artifacts.promote(me, a.id, null);
  nx.artifacts.listForReader(me, {}); nx.workspaces.listForReader(me);
  nx.workspaces.withdraw(me, qa.id);
  const v = verifyActivityChain(db);
  assert.equal(v.ok, true); assert.ok(v.rows > 0);
  done(s, db);
});

// ---------- fix round 1 ----------
test('F1 ArtifactService exposes exactly its public API plus the four @internal *Tx helpers', () => {
  const { s, db, nx, me } = setup();
  const proto = Object.getPrototypeOf(nx.artifacts);
  const PRIVATE = ['requireTx', 'activeParticipation', 'artifactRow', 'versionRow', 'latestLiveVersion', 'summaryOf', 'ownerWorkspace',
    'loadArtifact', 'loadVersion', 'requireWritableArtifact', 'ownerActive', 'checkProducer', 'requireLiveJob', 'requireLiveSession',
    'validateInputs', 'checkInputs'];
  assert.deepEqual(Object.getOwnPropertyNames(proto).filter((k) => k !== 'constructor' && typeof proto[k] === 'function' && !PRIVATE.includes(k)).sort(),
    ['archive', 'create', 'discard', 'finalize', 'get', 'getVersion', 'listByProject', 'listForReader', 'listVersions', 'markReady',
      'promote', 'registerVersion', 'saveUserVersion', 'summariesByProject', 'updateDraft',
      // B2a Task 8: the inline save of user-authorable kinds (requirement, problem_statement).
      'saveInline',
      // @internal: in-transaction, authorize nothing; never map them to a transport.
      'insertArtifactTx', 'insertVersionTx', 'promoteTx', 'setStatusTx',
      // @internal (B2a Task 8): the ingest-only system insert (blob/tree storage, the project-owned repository).
      'insertSystemVersionTx'].sort());
  // Outside a transaction the helpers refuse; setStatusTx refuses a non-system actor even inside one.
  const { version } = nx.artifacts.saveUserVersion(me, textSave('p-ledger', 'sde', { name: 'Draft' }));
  assert.throws(() => nx.artifacts.setStatusTx(nx.principals.system(), version.id, 'candidate', { now: h.NOW }), (e) => e.code === 'invalid');
  assert.throws(() => db.transaction(() => nx.artifacts.setStatusTx(me, version.id, 'candidate', { now: h.NOW })).immediate(), (e) => e.code === 'invalid');
  assert.equal(nx.artifacts.getVersion(me, version.id).status, 'draft');
  done(s, db);
});

test('F2 linkSources refuses a consumer whose artifact is archived (conflict) or whose owner is withdrawn (participation_inactive)', () => {
  const { s, db, nx, me } = setup();
  const src = readyVersion(nx, me, 'p-ledger', 'sde', 'Source');
  const archived = nx.artifacts.saveUserVersion(me, textSave('p-ledger', 'sde', { name: 'Archived consumer' }));
  nx.artifacts.archive(me, archived.artifact.id);
  const w0 = count(db, "activity WHERE action = 'lineage.write'");
  assert.throws(() => nx.lineage.linkSources(me, archived.version.id, [src.id]), (e) => e.code === 'conflict');
  assert.equal(count(db, 'artifact_edges WHERE from_version_id = ?', archived.version.id), 0);
  const qa = nx.workspaces.attach(me, 'p-ledger', 'qa');
  const frozen = nx.artifacts.saveUserVersion(me, textSave('p-ledger', 'qa', { name: 'QA consumer' }));
  nx.workspaces.withdraw(me, qa.id);
  assert.throws(() => nx.lineage.linkSources(me, frozen.version.id, [src.id]), (e) => e.code === 'participation_inactive');
  assert.equal(count(db, 'artifact_edges WHERE from_version_id = ?', frozen.version.id), 0);
  assert.equal(count(db, "activity WHERE action = 'lineage.write'"), w0);
  done(s, db);
});
