'use strict';
// B1 Task 4: HandoffService. Send by reference, accept with a receipt and handoff_convert edges in
// one transaction, decline, withdraw, reads, the withdraw guard and availability. Real SQLite only.
const h = require('./helpers/sqlite.cjs');
if (!h.realSqliteOrSkip()) return;
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');
const { PersistStore } = loadTs('src/main/db.ts');
const { createNexusPlatform } = loadTs('src/main/nexus/platform.ts');
const { HandoffService } = loadTs('src/main/nexus/handoff/handoffService.ts');
const { verifyActivityChain } = loadTs('src/main/nexus/activity/writer.ts');

function setup(o = {}) {
  const { file } = h.v6Fixture(); const s = new PersistStore(file);
  s.open({ log: () => {}, backupDir: path.join(path.dirname(file), 'b'), now: () => h.NOW, holdV8: o.holdV8 === true });
  const db = s.platformDatabase(); const logs = [];
  const nx = createNexusPlatform(db, { now: () => h.NOW, log: (l) => logs.push(l), ...(o.handoffs === undefined ? {} : { handoffs: o.handoffs }) });
  return { s, db, nx, logs, me: nx.principals.localUser(), sys: nx.principals.system() };
}
/** H16: every case ends here: no dangling reference, and the activity chain still verifies. */
function done(s, db) {
  assert.deepEqual(db.pragma('foreign_key_check'), []);
  assert.equal(verifyActivityChain(db).ok, true, 'activity chain verifies');
  s.close();
}
const count = (db, sql, ...args) => db.prepare(`SELECT COUNT(*) AS n FROM ${sql}`).get(...args).n;
const textSave = (projectId, workspaceId, target, text) => ({
  projectId, workspaceId, kind: 'text_file', target, storage: { kind: 'inline', json: { path: 'notes.md', text } },
  metadata: { path: 'notes.md' }, action: 'user.save_file'
});
/** A saved text version marked ready (candidate). */
function readyVersion(nx, me, projectId, workspaceId, text, name = text) {
  const { version } = nx.artifacts.saveUserVersion(me, textSave(projectId, workspaceId, { name }, text));
  return nx.artifacts.markReady(me, version.id);
}
/** p-ledger with qa attached and one sent handoff sde -> qa carrying one ready version. */
function sentHandoff(o) {
  const ctx = setup(o);
  const { nx, me } = ctx;
  const qa = nx.workspaces.attach(me, 'p-ledger', 'qa'); const sde = nx.workspaces.primaryOf(me, 'p-ledger');
  const v = readyVersion(nx, me, 'p-ledger', 'sde', 'some text');
  const { handoff } = nx.handoffs.send(me, { projectId: 'p-ledger', fromParticipationId: sde.id, toParticipationId: qa.id, versionIds: [v.id], title: 'Check the parser' });
  return { ...ctx, qa, sde, v, h: handoff };
}
function addViewer(db) {
  db.prepare("INSERT INTO principals VALUES ('user:viewer','user','viewer',NULL,?)").run(h.NOW);
  db.prepare("INSERT INTO memberships VALUES ('user:viewer','project','p-ledger','viewer',?)").run(h.NOW);
  return { id: 'user:viewer', kind: 'user', displayName: 'viewer' };
}

test('H1 send writes 1 handoff, n subjects and 1 activity row; a resend is deduped', () => {
  const { s, db, nx, me } = setup();
  const qa = nx.workspaces.attach(me, 'p-ledger', 'qa'); const sde = nx.workspaces.primaryOf(me, 'p-ledger');
  const a = readyVersion(nx, me, 'p-ledger', 'sde', 'alpha'); const b = readyVersion(nx, me, 'p-ledger', 'sde', 'beta');
  nx.artifacts.promote(me, b.id, null);
  const a0 = count(db, 'activity');
  const input = { projectId: 'p-ledger', fromParticipationId: sde.id, toParticipationId: qa.id, versionIds: [a.id, b.id], title: 'Two notes', note: 'please check' };
  const r = nx.handoffs.send(me, input);
  assert.equal(r.created, true);
  assert.deepEqual([r.handoff.status, r.handoff.subjectCount, r.handoff.fromWorkspaceId, r.handoff.toWorkspaceId, r.handoff.note],
    ['sent', 2, 'sde', 'qa', 'please check']);
  assert.deepEqual([r.handoff.respondedBy, r.handoff.respondedAt, r.handoff.receiptVersionId], [null, null, null]);
  assert.deepEqual(r.handoff.subjects.map((x) => [x.position, x.versionId, x.contentHash, x.status]),
    [[1, a.id, a.contentHash, 'candidate'], [2, b.id, b.contentHash, 'active']]);
  assert.equal(count(db, 'handoffs'), 1); assert.equal(count(db, 'handoff_subjects'), 2);
  assert.equal(count(db, 'activity'), a0 + 1);
  const row = db.prepare("SELECT workspace_id, project_id, entity_id, details_json FROM activity WHERE action = 'handoff.send'").get();
  assert.deepEqual([row.workspace_id, row.project_id, row.entity_id], ['sde', 'p-ledger', r.handoff.id]);
  assert.deepEqual(JSON.parse(row.details_json), { subjects: 2, toWorkspaceId: 'qa' });
  // Same from, to and subject set (in any order): the open handoff comes back and nothing is written.
  const again = nx.handoffs.send(me, { ...input, versionIds: [b.id, a.id], title: 'Another title' });
  assert.deepEqual([again.created, again.handoff.id], [false, r.handoff.id]);
  assert.equal(count(db, 'handoffs'), 1); assert.equal(count(db, 'activity'), a0 + 1);
  // A different subject set is a new handoff.
  assert.equal(nx.handoffs.send(me, { ...input, versionIds: [a.id] }).created, true);
  assert.equal(count(db, 'handoffs'), 2);
  done(s, db);
});

test('H2 a draft subject, a subject owned by another participation or one from another project is invalid', () => {
  const { s, db, nx, me } = setup();
  const qa = nx.workspaces.attach(me, 'p-ledger', 'qa'); const sde = nx.workspaces.primaryOf(me, 'p-ledger');
  const send = (versionIds) => nx.handoffs.send(me, { projectId: 'p-ledger', fromParticipationId: sde.id, toParticipationId: qa.id, versionIds, title: 't' });
  const draft = nx.artifacts.saveUserVersion(me, textSave('p-ledger', 'sde', { name: 'Draft' }, 'draft text')).version;
  assert.throws(() => send([draft.id]), (e) => e.code === 'invalid');
  const qaOwned = readyVersion(nx, me, 'p-ledger', 'qa', 'qa text');
  assert.throws(() => send([qaOwned.id]), (e) => e.code === 'invalid');
  const invoicePrimary = nx.workspaces.primaryOf(me, 'p-invoice').workspaceId;
  const foreign = readyVersion(nx, me, 'p-invoice', invoicePrimary, 'foreign text');
  assert.throws(() => send([foreign.id]), (e) => e.code === 'invalid');
  const ok = readyVersion(nx, me, 'p-ledger', 'sde', 'fine');
  const discarded = readyVersion(nx, me, 'p-ledger', 'sde', 'gone'); nx.artifacts.discard(me, discarded.id);
  assert.throws(() => send([ok.id, discarded.id]), (e) => e.code === 'invalid');
  // Malformed lists: empty, duplicated, too many; an unknown version is not_found for the platform owner.
  assert.throws(() => send([]), (e) => e.code === 'invalid');
  assert.throws(() => send([ok.id, ok.id]), (e) => e.code === 'invalid');
  assert.throws(() => send(Array.from({ length: 21 }, (_, i) => `v${i}`)), (e) => e.code === 'invalid');
  assert.throws(() => send(['nope']), (e) => e.code === 'not_found');
  // The project named by the caller must be the sending participation's stored project.
  assert.throws(() => nx.handoffs.send(me, { projectId: 'p-invoice', fromParticipationId: sde.id, toParticipationId: qa.id, versionIds: [ok.id], title: 't' }),
    (e) => e.code === 'invalid');
  assert.equal(count(db, 'handoffs'), 0);
  done(s, db);
});

test('H3 to = from is invalid; a withdrawn receiving participation is participation_inactive; another project is invalid', () => {
  const { s, db, nx, me } = setup();
  const qa = nx.workspaces.attach(me, 'p-ledger', 'qa'); const sde = nx.workspaces.primaryOf(me, 'p-ledger');
  const v = readyVersion(nx, me, 'p-ledger', 'sde', 'x');
  const send = (to, from = sde.id) => nx.handoffs.send(me, { projectId: 'p-ledger', fromParticipationId: from, toParticipationId: to, versionIds: [v.id], title: 't' });
  assert.throws(() => send(sde.id), (e) => e.code === 'invalid');
  const invoiceQa = nx.workspaces.attach(me, 'p-invoice', 'qa');
  assert.throws(() => send(invoiceQa.id), (e) => e.code === 'invalid');
  assert.throws(() => send('pw-unknown'), (e) => e.code === 'not_found');
  assert.throws(() => send(qa.id, 'pw-unknown'), (e) => e.code === 'not_found');
  nx.workspaces.withdraw(me, qa.id);
  assert.throws(() => send(qa.id), (e) => e.code === 'participation_inactive');
  // A withdrawn sender is participation_inactive too.
  assert.throws(() => send(sde.id, qa.id), (e) => e.code === 'participation_inactive');
  assert.equal(count(db, 'handoffs'), 0);
  done(s, db);
});

test('H4 a secret-shaped title or note is invalid, and so are an empty or overlong title', () => {
  const { s, db, nx, me } = setup();
  const qa = nx.workspaces.attach(me, 'p-ledger', 'qa'); const sde = nx.workspaces.primaryOf(me, 'p-ledger');
  const v = readyVersion(nx, me, 'p-ledger', 'sde', 'x');
  const SK = `sk-ant-api03-${'A1b2C3d4'.repeat(8)}`;
  const base = { projectId: 'p-ledger', fromParticipationId: sde.id, toParticipationId: qa.id, versionIds: [v.id], title: 'ok' };
  const isSecret = (e) => e.code === 'invalid' && e.detail?.reason === 'secret_in_metadata';
  const a0 = count(db, 'activity');
  assert.throws(() => nx.handoffs.send(me, { ...base, title: `key ${SK}` }), isSecret);
  assert.throws(() => nx.handoffs.send(me, { ...base, note: `use ${SK}` }), isSecret);
  assert.throws(() => nx.handoffs.send(me, { ...base, title: '' }), (e) => e.code === 'invalid');
  assert.throws(() => nx.handoffs.send(me, { ...base, title: 'x'.repeat(201) }), (e) => e.code === 'invalid');
  assert.throws(() => nx.handoffs.send(me, { ...base, note: 'x'.repeat(2001) }), (e) => e.code === 'invalid');
  assert.deepEqual([count(db, 'handoffs'), count(db, 'activity')], [0, a0]);
  // A secret-shaped decline note is refused the same way.
  const { handoff } = nx.handoffs.send(me, base);
  assert.throws(() => nx.handoffs.decline(me, handoff.id, `see ${SK}`), isSecret);
  assert.equal(nx.handoffs.get(me, handoff.id).status, 'sent');
  done(s, db);
});

test('H5 accept writes the receipt, edges and status in one transaction; subjects are referenced, never copied', () => {
  const { s, db, nx, me } = setup();
  const qa = nx.workspaces.attach(me, 'p-ledger', 'qa'); const sde = nx.workspaces.primaryOf(me, 'p-ledger');
  const v = readyVersion(nx, me, 'p-ledger', 'sde', 'some text');
  const { handoff } = nx.handoffs.send(me, { projectId: 'p-ledger', fromParticipationId: sde.id, toParticipationId: qa.id, versionIds: [v.id], title: 'Check the parser' });
  const seq0 = db.prepare('SELECT MAX(seq) AS m FROM activity').get().m;
  const a = nx.handoffs.accept(me, handoff.id);
  assert.equal(a.status, 'accepted');
  assert.deepEqual([a.respondedBy, a.respondedAt, a.responseNote], [me.id, h.NOW, null]);
  const r = db.prepare('SELECT v.storage_ref_json, v.status, v.inputs_json, v.produced_by_action, a.kind, a.name, a.owner_participation_id, a.current_version_id FROM artifact_versions v JOIN artifacts a ON a.id = v.artifact_id WHERE v.id = ?').get(a.receiptVersionId);
  assert.deepEqual([r.kind, r.owner_participation_id, r.status], ['handoff_receipt', qa.id, 'active']);
  assert.deepEqual([r.name, r.current_version_id, r.produced_by_action], ['Check the parser', a.receiptVersionId, 'user.accept_handoff']);
  assert.deepEqual(JSON.parse(r.storage_ref_json).json.subjects, [{ versionId: v.id, contentHash: v.contentHash }]);
  assert.equal(JSON.parse(r.storage_ref_json).json.handoffId, handoff.id);
  assert.deepEqual(JSON.parse(r.inputs_json), [{ versionId: v.id, role: 'received' }]);
  assert.ok(!r.storage_ref_json.includes('some text'), 'no subject content in the receipt');
  assert.deepEqual(db.prepare('SELECT relation, source FROM artifact_edges WHERE from_version_id = ? AND to_version_id = ?').get(a.receiptVersionId, v.id),
    { relation: 'depends_on', source: 'handoff_convert' });
  // The rows of the one transaction, in order; finalize is the system acting for the user.
  const rows = db.prepare('SELECT action, actor_kind, on_behalf_of, workspace_id, details_json FROM activity WHERE seq > ? ORDER BY seq').all(seq0);
  assert.deepEqual(rows.map((x) => x.action),
    ['artifact.create', 'version.register', 'version.finalize', 'version.promote', 'lineage.write', 'handoff.accept']);
  assert.ok(rows.every((x) => x.workspace_id === 'qa'));
  const fin = rows[2];
  assert.deepEqual([fin.actor_kind, fin.on_behalf_of, JSON.parse(fin.details_json).via], ['system', me.id, 'accept_handoff']);
  assert.deepEqual(JSON.parse(rows[5].details_json), { receiptVersionId: a.receiptVersionId, subjects: 1 });
  // The subject itself is untouched.
  assert.equal(nx.artifacts.getVersion(me, v.id).status, 'candidate');
  assert.throws(() => nx.handoffs.accept(me, handoff.id), (e) => e.code === 'illegal_transition' && e.detail?.handoffId === handoff.id);
  assert.deepEqual(db.pragma('foreign_key_check'), []);
  done(s, db);
});

test('H6 accepting twice, or declining or withdrawing after accept, is illegal_transition', () => {
  const { s, db, nx, me, h: ho } = sentHandoff();
  nx.handoffs.accept(me, ho.id);
  const a0 = count(db, 'activity');
  assert.throws(() => nx.handoffs.accept(me, ho.id), (e) => e.code === 'illegal_transition');
  assert.throws(() => nx.handoffs.decline(me, ho.id), (e) => e.code === 'illegal_transition');
  assert.equal(count(db, "artifacts WHERE kind = 'handoff_receipt'"), 1);
  assert.equal(count(db, 'activity'), a0);
  done(s, db);
});

test('H7 a failure late in accept rolls everything back', () => {
  const { s, db, nx, me, h: ho } = sentHandoff();
  const before = [count(db, 'artifacts'), count(db, 'artifact_versions'), count(db, 'artifact_edges'), count(db, 'activity')];
  db.exec("CREATE TEMP TRIGGER fail_e BEFORE INSERT ON artifact_edges BEGIN SELECT RAISE(ABORT, 'injected'); END;");
  assert.throws(() => nx.handoffs.accept(me, ho.id));
  assert.equal(db.prepare("SELECT COUNT(*) n FROM artifacts WHERE kind = 'handoff_receipt'").get().n, 0);
  assert.equal(db.prepare('SELECT status FROM handoffs WHERE id = ?').get(ho.id).status, 'sent');
  assert.deepEqual([count(db, 'artifacts'), count(db, 'artifact_versions'), count(db, 'artifact_edges'), count(db, 'activity')], before);
  db.exec('DROP TRIGGER temp.fail_e');
  // A failure at the very last step (the handoff's own activity row) rolls back too.
  db.exec("CREATE TEMP TRIGGER fail_a BEFORE INSERT ON activity WHEN NEW.action = 'handoff.accept' BEGIN SELECT RAISE(ABORT, 'injected'); END;");
  assert.throws(() => nx.handoffs.accept(me, ho.id));
  assert.deepEqual([count(db, 'artifacts'), count(db, 'artifact_versions'), count(db, 'artifact_edges'), count(db, 'activity')], before);
  assert.equal(db.prepare('SELECT status FROM handoffs WHERE id = ?').get(ho.id).status, 'sent');
  db.exec('DROP TRIGGER temp.fail_a');
  assert.equal(nx.handoffs.accept(me, ho.id).status, 'accepted');
  done(s, db);
});

test('H8 withdraw then accept, and accept then withdraw, are both illegal_transition', () => {
  const ctx = sentHandoff();
  const { s, db, nx, me, sde, qa, h: first } = ctx;
  const w = nx.handoffs.withdraw(me, first.id);
  assert.deepEqual([w.status, w.respondedBy, w.respondedAt, w.responseNote], ['withdrawn', null, null, null]);
  assert.deepEqual(JSON.parse(db.prepare("SELECT details_json FROM activity WHERE action = 'handoff.withdraw'").get().details_json), {});
  assert.throws(() => nx.handoffs.accept(me, first.id), (e) => e.code === 'illegal_transition');
  assert.throws(() => nx.handoffs.withdraw(me, first.id), (e) => e.code === 'illegal_transition');
  const v2 = readyVersion(nx, me, 'p-ledger', 'sde', 'second');
  const { handoff: second } = nx.handoffs.send(me, { projectId: 'p-ledger', fromParticipationId: sde.id, toParticipationId: qa.id, versionIds: [v2.id], title: 'Second' });
  nx.handoffs.accept(me, second.id);
  assert.throws(() => nx.handoffs.withdraw(me, second.id), (e) => e.code === 'illegal_transition');
  assert.equal(count(db, "artifacts WHERE kind = 'handoff_receipt'"), 1);
  done(s, db);
});

test('H9 decline with a note writes no artifact and no edge', () => {
  const { s, db, nx, me, h: ho } = sentHandoff();
  const before = [count(db, 'artifacts'), count(db, 'artifact_versions'), count(db, 'artifact_edges'), count(db, 'activity')];
  const d = nx.handoffs.decline(me, ho.id, 'not this sprint');
  assert.deepEqual([d.status, d.respondedBy, d.respondedAt, d.responseNote, d.receiptVersionId], ['declined', me.id, h.NOW, 'not this sprint', null]);
  assert.deepEqual([count(db, 'artifacts'), count(db, 'artifact_versions'), count(db, 'artifact_edges'), count(db, 'activity')],
    [before[0], before[1], before[2], before[3] + 1]);
  const row = db.prepare("SELECT workspace_id, details_json FROM activity WHERE action = 'handoff.decline'").get();
  assert.equal(row.workspace_id, 'qa');
  assert.ok(!row.details_json.includes('not this sprint'), 'the note itself is not copied into the activity log');
  assert.throws(() => nx.handoffs.accept(me, ho.id), (e) => e.code === 'illegal_transition');
  done(s, db);
});

test('H10 withdrawing qa while a handoff is sent is a conflict (openHandoffs: 1); after a decline it succeeds', () => {
  const { s, db, nx, me, qa, sde, h: ho } = sentHandoff();
  assert.equal(nx.handoffs.openCountFor(qa.id), 1); assert.equal(nx.handoffs.openCountFor(sde.id), 1);
  assert.throws(() => nx.workspaces.withdraw(me, qa.id), (e) => e.code === 'conflict' && e.detail?.openHandoffs === 1);
  assert.equal(db.prepare('SELECT status FROM project_workspaces WHERE id = ?').get(qa.id).status, 'active');
  nx.handoffs.decline(me, ho.id);
  assert.equal(nx.handoffs.openCountFor(qa.id), 0);
  assert.equal(nx.workspaces.withdraw(me, qa.id).status, 'withdrawn');
  done(s, db);
});

test('H11 LineageService.record with source handoff_convert is still invalid', () => {
  const { s, db, nx, me } = setup();
  const a = readyVersion(nx, me, 'p-ledger', 'sde', 'a'); const b = readyVersion(nx, me, 'p-ledger', 'sde', 'b');
  const e0 = count(db, 'artifact_edges');
  assert.throws(() => nx.lineage.record(me, { fromVersionId: a.id, toVersionId: b.id, relation: 'depends_on', source: 'handoff_convert' }),
    (e) => e.code === 'invalid');
  assert.throws(() => nx.lineage.record(nx.principals.system(), { fromVersionId: a.id, toVersionId: b.id, relation: 'depends_on', source: 'handoff_convert' }),
    (e) => e.code === 'invalid');
  assert.equal(count(db, 'artifact_edges'), e0);
  done(s, db);
});

test('H12 a subject discarded later stays referenced; get reports its current status and newer versions', () => {
  const { s, db, nx, me, v, h: ho } = sentHandoff();
  const a = nx.handoffs.accept(me, ho.id);
  nx.artifacts.discard(me, v.id);
  const g = nx.handoffs.get(me, ho.id);
  assert.deepEqual(g.subjects.map((x) => [x.versionId, x.status, x.versionNo, x.artifactName, x.kind, x.newerVersionNo]),
    [[v.id, 'deprecated', 1, 'some text', 'text_file', null]]);
  nx.artifacts.saveUserVersion(me, textSave('p-ledger', 'sde', { artifactId: v.artifactId }, 'v2'));
  nx.artifacts.saveUserVersion(me, textSave('p-ledger', 'sde', { artifactId: v.artifactId }, 'v3'));
  assert.equal(nx.handoffs.get(me, ho.id).subjects[0].newerVersionNo, 3);
  assert.equal(count(db, 'artifact_edges WHERE from_version_id = ? AND to_version_id = ?', a.receiptVersionId, v.id), 1);
  // Subjects are immutable, and handoffs are never deleted.
  assert.throws(() => db.prepare('DELETE FROM handoff_subjects WHERE handoff_id = ?').run(ho.id), /immutable/);
  assert.throws(() => db.prepare('DELETE FROM handoffs WHERE id = ?').run(ho.id), /never deleted/);
  done(s, db);
});

test('H13 a viewer is denied send and accept, with one denied row each', () => {
  const { s, db, nx, me, qa, sde, v, h: ho } = sentHandoff();
  const viewer = addViewer(db);
  const denied = () => count(db, "activity WHERE status = 'denied' AND actor_id = 'user:viewer'");
  assert.throws(() => nx.handoffs.send(viewer, { projectId: 'p-ledger', fromParticipationId: sde.id, toParticipationId: qa.id, versionIds: [v.id], title: 'x' }),
    (e) => e.code === 'denied');
  assert.equal(denied(), 1);
  assert.equal(count(db, "activity WHERE status = 'denied' AND actor_id = 'user:viewer' AND action = 'handoff.send' AND workspace_id = 'sde'"), 1);
  assert.throws(() => nx.handoffs.accept(viewer, ho.id), (e) => e.code === 'denied');
  assert.equal(denied(), 2);
  assert.equal(count(db, "activity WHERE status = 'denied' AND actor_id = 'user:viewer' AND action = 'handoff.respond' AND workspace_id = 'qa'"), 1);
  assert.throws(() => nx.handoffs.decline(viewer, ho.id), (e) => e.code === 'denied');
  assert.throws(() => nx.handoffs.withdraw(viewer, ho.id), (e) => e.code === 'denied');
  assert.equal(denied(), 4);
  // A viewer may read; an unknown id is denied (not not_found) for anyone not authorized platform-wide.
  assert.equal(nx.handoffs.get(viewer, ho.id).id, ho.id);
  assert.throws(() => nx.handoffs.get(viewer, 'h-unknown'), (e) => e.code === 'denied');
  assert.throws(() => nx.handoffs.get(me, 'h-unknown'), (e) => e.code === 'not_found');
  assert.equal(nx.handoffs.get(me, ho.id).status, 'sent');
  assert.equal(count(db, "artifacts WHERE kind = 'handoff_receipt'"), 0);
  done(s, db);
});

test('H14 with handoffs: false, nx.handoffs is null and withdraw skips the guard; a service on v7 refuses every method', () => {
  // A v8 database with an open handoff, then a platform composed without handoffs.
  const { s, db, nx: on, qa, h: ho } = sentHandoff();
  assert.equal(on.handoffsAvailable, true);
  const logs = [];
  const off = createNexusPlatform(db, { now: () => h.NOW, handoffs: false, log: (l) => logs.push(l) });
  assert.equal(off.handoffs, null); assert.equal(off.handoffsAvailable, false);
  assert.deepEqual(logs.filter((l) => l.includes('handoffs unavailable')), ['[nexus] handoffs unavailable: schema v8 not in place']);
  const me = off.principals.localUser();
  assert.equal(off.workspaces.withdraw(me, qa.id).status, 'withdrawn');
  assert.equal(db.prepare('SELECT status FROM handoffs WHERE id = ?').get(ho.id).status, 'sent');
  s.close();
  // v8 held: the store stays at v7, the default composition has no handoffs, and a service built anyway refuses.
  const v7 = setup({ holdV8: true });
  assert.equal(v7.nx.handoffs, null); assert.equal(v7.nx.handoffsAvailable, false);
  assert.equal(v7.logs.filter((l) => l.includes('handoffs unavailable')).length, 1);
  assert.equal(v7.db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'handoffs'").get(), undefined);
  const svc = new HandoffService(v7.db, { auth: v7.nx.auth, principals: v7.nx.principals, artifacts: v7.nx.artifacts, now: () => h.NOW });
  const off2 = (e) => e.code === 'platform_unavailable' && e.detail?.reason === 'handoffs_unavailable' && e.detail?.subReason === 'shape';
  const sde = v7.nx.workspaces.primaryOf(v7.me, 'p-ledger');
  assert.throws(() => svc.send(v7.me, { projectId: 'p-ledger', fromParticipationId: sde.id, toParticipationId: sde.id, versionIds: ['x'], title: 't' }), off2);
  for (const call of [() => svc.accept(v7.me, 'x'), () => svc.decline(v7.me, 'x'), () => svc.withdraw(v7.me, 'x'), () => svc.get(v7.me, 'x'),
    () => svc.list(v7.me, {}), () => svc.openCountFor(sde.id)]) assert.throws(call, off2);
  const held = new HandoffService(v7.db, { auth: v7.nx.auth, principals: v7.nx.principals, artifacts: v7.nx.artifacts, now: () => h.NOW, unavailableReason: 'held' });
  assert.throws(() => held.list(v7.me, {}), (e) => e.code === 'platform_unavailable' && e.detail?.subReason === 'held');
  // Withdraw works at v7 without any guard.
  const qa7 = v7.nx.workspaces.attach(v7.me, 'p-ledger', 'qa');
  assert.equal(v7.nx.workspaces.withdraw(v7.me, qa7.id).status, 'withdrawn');
  done(v7.s, v7.db);
});

test('H15 list by box (inbox, sent) per workspace and by status; rows of unreadable workspaces never leak', () => {
  const { s, db, nx, me } = setup();
  const qa = nx.workspaces.attach(me, 'p-ledger', 'qa'); const sde = nx.workspaces.primaryOf(me, 'p-ledger');
  const a = readyVersion(nx, me, 'p-ledger', 'sde', 'a'); const b = readyVersion(nx, me, 'p-ledger', 'sde', 'b');
  const q = readyVersion(nx, me, 'p-ledger', 'qa', 'q');
  const toQa1 = nx.handoffs.send(me, { projectId: 'p-ledger', fromParticipationId: sde.id, toParticipationId: qa.id, versionIds: [a.id], title: 'one' }).handoff;
  const toQa2 = nx.handoffs.send(me, { projectId: 'p-ledger', fromParticipationId: sde.id, toParticipationId: qa.id, versionIds: [b.id], title: 'two' }).handoff;
  const toSde = nx.handoffs.send(me, { projectId: 'p-ledger', fromParticipationId: qa.id, toParticipationId: sde.id, versionIds: [q.id], title: 'back' }).handoff;
  nx.handoffs.decline(me, toQa2.id);
  const ids = (rows) => rows.map((r) => r.id).sort();
  assert.deepEqual(ids(nx.handoffs.list(me, { workspaceId: 'qa', box: 'inbox' })), [toQa1.id, toQa2.id].sort());
  assert.deepEqual(ids(nx.handoffs.list(me, { workspaceId: 'qa', box: 'sent' })), [toSde.id]);
  assert.deepEqual(ids(nx.handoffs.list(me, { workspaceId: 'qa', box: 'all' })), [toQa1.id, toQa2.id, toSde.id].sort());
  assert.deepEqual(ids(nx.handoffs.list(me, { workspaceId: 'sde', box: 'inbox', status: 'sent' })), [toSde.id]);
  assert.deepEqual(ids(nx.handoffs.list(me, { status: 'declined' })), [toQa2.id]);
  assert.deepEqual(ids(nx.handoffs.list(me, { projectId: 'p-invoice' })), []);
  assert.equal(nx.handoffs.list(me, { projectId: 'p-ledger' }).length, 3);
  // Open first.
  assert.equal(nx.handoffs.list(me, {}).at(-1).id, toQa2.id);
  assert.equal(nx.handoffs.list(me, { limit: 1 }).length, 1);
  for (const bad of [{ box: 'outbox' }, { status: 'open' }, { limit: 0 }, { limit: 1001 }, { projectId: '' }, { workspaceId: 7 }]) {
    assert.throws(() => nx.handoffs.list(me, bad), (e) => e.code === 'invalid', JSON.stringify(bad));
  }
  // A member holding only a qa workspace grant sees the handoffs with a qa side, and nothing of another project.
  db.prepare("INSERT INTO principals VALUES ('user:qa','user','qa',NULL,?)").run(h.NOW);
  db.prepare("INSERT INTO memberships VALUES ('user:qa','workspace','qa','member',?)").run(h.NOW);
  const qaMember = { id: 'user:qa', kind: 'user', displayName: 'qa' };
  const d0 = count(db, "activity WHERE status = 'denied'");
  assert.deepEqual(ids(nx.handoffs.list(qaMember, {})), [toQa1.id, toQa2.id, toSde.id].sort());
  assert.deepEqual(ids(nx.handoffs.list(qaMember, { box: 'inbox' })), [toQa1.id, toQa2.id].sort());
  assert.equal(count(db, "activity WHERE status = 'denied'"), d0, 'the global list writes no audit rows');
  // A stranger sees nothing, and a project filter it may not read is denied (audited once).
  db.prepare("INSERT INTO principals VALUES ('user:none','user','none',NULL,?)").run(h.NOW);
  const none = { id: 'user:none', kind: 'user', displayName: 'none' };
  assert.deepEqual(nx.handoffs.list(none, {}), []);
  assert.throws(() => nx.handoffs.list(none, { projectId: 'p-ledger' }), (e) => e.code === 'denied');
  assert.equal(count(db, "activity WHERE status = 'denied' AND actor_id = 'user:none'"), 1);
  assert.throws(() => nx.handoffs.get(none, toQa1.id), (e) => e.code === 'denied');
  done(s, db);
});

test('H16 a mixed flow keeps foreign keys and the activity chain intact; the startup report is unchanged', () => {
  const { s, db, nx, me, qa, sde, h: ho } = sentHandoff();
  nx.handoffs.accept(me, ho.id);
  const v2 = readyVersion(nx, me, 'p-ledger', 'sde', 'two');
  const d = nx.handoffs.send(me, { projectId: 'p-ledger', fromParticipationId: sde.id, toParticipationId: qa.id, versionIds: [v2.id], title: 'd' }).handoff;
  nx.handoffs.decline(me, d.id, 'later');
  const v3 = readyVersion(nx, me, 'p-ledger', 'sde', 'three');
  const w = nx.handoffs.send(me, { projectId: 'p-ledger', fromParticipationId: sde.id, toParticipationId: qa.id, versionIds: [v3.id], title: 'w' }).handoff;
  nx.handoffs.withdraw(me, w.id);
  nx.workspaces.withdraw(me, qa.id);
  assert.deepEqual(Object.keys(nx.startup()).sort(), ['catalogAdded', 'jobs', 'primaries', 'sessions']);
  done(s, db);
});
