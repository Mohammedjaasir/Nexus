'use strict';
const h = require('./helpers/sqlite.cjs');
if (!h.realSqliteOrSkip()) return;
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');
const { PersistStore } = loadTs('src/main/db.ts');
const { createNexusPlatform } = loadTs('src/main/nexus/platform.ts');
const { workspaceForDomain } = loadTs('src/renderer/src/nexus/workspaces/mapping.ts');
function setup() {
  const { file } = h.v6Fixture(); const logs = []; const s = new PersistStore(file);
  s.open({ log: (l) => logs.push(l), backupDir: path.join(path.dirname(file), 'b'), now: () => h.NOW });
  const db = s.platformDatabase(); const nx = createNexusPlatform(db, { now: () => h.NOW });
  return { s, db, nx, me: nx.principals.localUser(), sys: nx.principals.system(), logs };
}

test('backfilled primaries equal what the renderer shows for every project', () => {
  const { s, nx, me } = setup();
  for (const p of s.listProjects())
    assert.equal(nx.workspaces.primaryOf(me, p.id)?.workspaceId ?? null, workspaceForDomain(p.domainId)?.id ?? null, p.id);
  s.close();
});
test('backfill and the live reconcile agree (reconcile is a no-op right after migration)', () => {
  const { s, nx, sys } = setup();
  assert.deepEqual(nx.workspaces.reconcileLegacyPrimaries(sys), { set: 0, cleared: 0 });
  s.close();
});
test('one project takes part in several workspaces without being duplicated', () => {
  const { s, db, nx, me } = setup();
  for (const w of ['ml', 'sde', 'qa']) nx.workspaces.attach(me, 'p-invoice', w);
  const list = nx.workspaces.participations(me, 'p-invoice');
  assert.deepEqual(list.map((x) => [x.workspaceId, x.isPrimary]), [['dl', true], ['ml', false], ['qa', false], ['sde', false]]);
  assert.equal(h.count(db, 'projects'), 5);
  assert.equal(nx.workspaces.attach(me, 'p-invoice', 'qa').id, list.find((x) => x.workspaceId === 'qa').id);   // idempotent
  assert.throws(() => db.prepare("UPDATE project_workspaces SET is_primary=1 WHERE project_id='p-invoice' AND workspace_id='qa'").run(), /UNIQUE/);
  assert.throws(() => nx.workspaces.attach(me, 'p-invoice', 'nope'), (e) => e.code === 'invalid');
  assert.throws(() => nx.workspaces.attach(me, 'p-missing', 'qa'), (e) => e.code === 'not_found');
  s.close();
});
test('withdraw keeps the row and refuses the primary', () => {
  const { s, nx, me } = setup();
  const qa = nx.workspaces.attach(me, 'p-ledger', 'qa');
  assert.equal(nx.workspaces.withdraw(me, qa.id).status, 'withdrawn');
  assert.throws(() => nx.workspaces.withdraw(me, nx.workspaces.primaryOf(me, 'p-ledger').id), (e) => e.code === 'invalid');
  assert.equal(nx.workspaces.attach(me, 'p-ledger', 'qa').status, 'active');      // re-activates
  s.close();
});
test('a legacy domain change moves the primary in the same save; old rows are kept', () => {
  const { s, db, nx, me } = setup();
  s.updateProject('p-ledger', { domainId: 'ai-ml' });
  assert.equal(nx.workspaces.primaryOf(me, 'p-ledger').workspaceId, 'ml');
  assert.deepEqual(nx.workspaces.participations(me, 'p-ledger').map((x) => [x.workspaceId, x.isPrimary, x.status]),
    [['ml', true, 'active'], ['sde', false, 'active']]);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM activity WHERE action='project_workspace.primary_synced' AND project_id='p-ledger'").get().n, 1);
  s.updateProject('p-ledger', { domainId: 'cybersecurity' });
  assert.equal(nx.workspaces.primaryOf(me, 'p-ledger'), null);                     // Unassigned, as the renderer shows
  assert.equal(nx.workspaces.participations(me, 'p-ledger').length, 2);
  s.close();
});
test('a project created after v7 gets its primary in the same transaction', () => {
  const { s, nx, me } = setup();
  const base = s.getProject('p-ledger');
  s.saveProject({ ...base, id: 'p-new', name: 'new-service', domainId: 'web-app-dev', createdAt: h.NOW, updatedAt: h.NOW });
  assert.equal(nx.workspaces.primaryOf(me, 'p-new').workspaceId, 'sde');
  s.close();
});
test('a failing sync never blocks the legacy project save; startup reconcile repairs it', () => {
  const { s, db, nx, me, sys, logs } = setup();
  db.exec("CREATE TEMP TRIGGER t_fail BEFORE INSERT ON main.project_workspaces BEGIN SELECT RAISE(ABORT, 'forced'); END");
  const base = s.getProject('p-ledger');
  s.saveProject({ ...base, id: 'p-later', domainId: 'ai-ml' });
  assert.equal(s.getProject('p-later').domainId, 'ai-ml');
  assert.equal(nx.workspaces.primaryOf(me, 'p-later'), null);
  assert.ok(logs.some((l) => /primary sync failed project=p-later/.test(l)));
  assert.equal(s.pendingWrites, 0, 'the legacy write was not queued for retry');
  db.exec('DROP TRIGGER temp.t_fail');
  assert.deepEqual(nx.workspaces.reconcileLegacyPrimaries(sys), { set: 1, cleared: 0 });
  assert.equal(nx.workspaces.primaryOf(me, 'p-later').workspaceId, 'ml');
  s.close();
});
test('deleting a project cascades its participations and keeps its activity', () => {
  const { s, db } = setup();
  assert.equal(s.deleteProject('p-sales'), true);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM project_workspaces WHERE project_id='p-sales'").get().n, 0);
  assert.ok(h.count(db, 'activity') >= 1);
  s.close();
});
test('a project with platform records is not deleted, and its graph is kept (ProjectManager path)', () => {
  const { s, db } = setup();
  const pw = db.prepare("SELECT id FROM project_workspaces WHERE project_id='p-ledger'").get().id;
  db.prepare(`INSERT INTO artifacts (id,project_id,kind,name,owner_participation_id,owner_workspace_id,created_by,created_at,updated_at)
    VALUES ('a-1','p-ledger','report','notes',?,'sde','user:local',?,?)`).run(pw, h.NOW, h.NOW);
  const { ProjectManager } = loadTs('src/main/project/projectManager.ts');
  const pm = new ProjectManager(s);
  assert.equal(pm.deleteProject('p-ledger'), false);
  assert.ok(s.getProject('p-ledger'));
  assert.equal(s.getProjectGraphStats('p-ledger').nodeCount, 3);
  assert.equal(s.pendingWrites, 0);
  s.close();
});
test('older-build writes are repaired by reconcile', () => {
  const { s, db, nx, me, sys } = setup();
  db.prepare(`INSERT INTO projects (id,name,root_path,domain_id,project_type,metadata_json,health_json,created_at,updated_at,last_analyzed_at)
    VALUES ('p-raw','raw','C:/work/raw','data-analytics','script','{}','{}',1,1,1)`).run();
  assert.deepEqual(nx.workspaces.reconcileLegacyPrimaries(sys), { set: 1, cleared: 0 });
  assert.equal(nx.workspaces.primaryOf(me, 'p-raw').workspaceId, 'data');
  s.close();
});
test('workspace membership reads use ix_pw_workspace', () => {
  const { s, db } = setup();
  const plan = db.prepare("EXPLAIN QUERY PLAN SELECT project_id FROM project_workspaces WHERE workspace_id=? AND status='active'").all('sde').map((r) => r.detail).join(' ');
  assert.match(plan, /ix_pw_workspace/);
  s.close();
});
test('authority comes from stored participation rows, never from the caller-named workspace', () => {
  const { s, db, nx, me } = setup();
  db.prepare("INSERT INTO principals VALUES ('user:guest','user','guest',NULL,?)").run(h.NOW);
  db.prepare("INSERT INTO memberships VALUES ('user:guest','workspace','qa','member',?)").run(h.NOW);
  const guest = nx.principals.get('user:guest');
  // attach authorizes at project scope: a qa grant does not let the guest put a project into qa.
  assert.throws(() => nx.workspaces.attach(guest, 'p-ledger', 'qa'), (e) => e.code === 'denied');
  const qa = nx.workspaces.attach(me, 'p-ledger', 'qa');
  const ml = nx.workspaces.attach(me, 'p-ledger', 'ml');
  assert.equal(nx.workspaces.withdraw(guest, qa.id).status, 'withdrawn');        // the stored row is in qa
  assert.throws(() => nx.workspaces.withdraw(guest, ml.id), (e) => e.code === 'denied');
  assert.deepEqual(nx.workspaces.projectIdsIn(guest, 'qa'), []);
  nx.workspaces.attach(me, 'p-ledger', 'qa');
  assert.deepEqual(nx.workspaces.projectIdsIn(guest, 'qa'), ['p-ledger']);
  assert.throws(() => nx.workspaces.participations(guest, 'p-invoice'), (e) => e.code === 'denied');
  s.close();
});
test('reconcile and the catalogue are system-only; the catalogue is idempotent; writes are audited', () => {
  const { s, db, nx, me, sys } = setup();
  assert.throws(() => nx.workspaces.reconcileLegacyPrimaries(me), (e) => e.code === 'denied');
  assert.throws(() => nx.workspaces.ensureCatalog(me), (e) => e.code === 'denied');
  assert.equal(nx.workspaces.ensureCatalog(sys), 0);
  assert.deepEqual(nx.workspaces.list(me).map((w) => w.id), ['sde', 'ml', 'dl', 'data', 'research', 'qa', 'uiux', 'devops']);
  const qa = nx.workspaces.attach(me, 'p-ledger', 'qa', { objective: 'regression suite' });
  assert.equal(qa.objective, 'regression suite'); assert.equal(qa.source, 'user'); assert.equal(qa.createdBy, 'user:local');
  nx.workspaces.withdraw(me, qa.id);
  const acts = db.prepare("SELECT action FROM activity WHERE project_id='p-ledger' AND status='succeeded' ORDER BY seq").all().map((r) => r.action);
  assert.deepEqual(acts, ['participation.attach', 'participation.withdraw']);
  assert.throws(() => nx.workspaces.withdraw(me, 'missing'), (e) => e.code === 'not_found');
  nx.startup();
  assert.deepEqual(nx.workspaces.reconcileLegacyPrimaries(sys), { set: 0, cleared: 0 });
  s.close();
});

// Fix round 1
test('a sync that aborts the whole transaction still saves the project once, unqueued; reconcile repairs it', () => {
  const { s, db, nx, me, sys, logs } = setup();
  db.exec("CREATE TEMP TRIGGER t_rb BEFORE INSERT ON main.project_workspaces BEGIN SELECT RAISE(ROLLBACK, 'forced'); END");
  const base = s.getProject('p-ledger');
  s.saveProject({ ...base, id: 'p-rb', domainId: 'ai-ml' });
  assert.equal(db.inTransaction, false);
  assert.equal(s.getProject('p-rb').domainId, 'ai-ml');
  assert.equal(s.pendingWrites, 0);
  assert.ok(logs.some((l) => /\[nexus\] primary sync aborted the transaction; saved without sync/.test(l)));
  assert.equal(nx.workspaces.primaryOf(me, 'p-rb'), null);
  db.exec('DROP TRIGGER temp.t_rb');
  assert.deepEqual(nx.workspaces.reconcileLegacyPrimaries(sys), { set: 1, cleared: 0 });
  assert.equal(nx.workspaces.primaryOf(me, 'p-rb').workspaceId, 'ml');
  s.close();
});
test('the sync never changes a complete participation; the project is left without a primary', () => {
  const { s, db, nx, me, sys, logs } = setup();
  const ml = nx.workspaces.attach(me, 'p-ledger', 'ml');
  db.prepare("UPDATE project_workspaces SET status='complete', completion_json='{\"ok\":true}', completion_hash='h1', completion_at=5 WHERE id=?").run(ml.id);
  const before = db.prepare('SELECT * FROM project_workspaces WHERE id=?').get(ml.id);
  s.updateProject('p-ledger', { domainId: 'ai-ml' });
  assert.deepEqual(db.prepare('SELECT * FROM project_workspaces WHERE id=?').get(ml.id), before);
  assert.equal(nx.workspaces.primaryOf(me, 'p-ledger'), null);                       // sde was cleared, ml stays complete
  assert.ok(logs.some((l) => /participation is complete; left without a primary/.test(l)));
  const { syncPrimaryFromLegacyDomain } = loadTs('src/main/nexus/workspace/legacyPrimary.ts');
  assert.equal(db.transaction(() => syncPrimaryFromLegacyDomain(db, 'p-ledger', 'ai-ml', h.NOW))(), 'complete_target');
  assert.deepEqual(nx.workspaces.reconcileLegacyPrimaries(sys), { set: 0, cleared: 0 });
  assert.deepEqual(db.prepare('SELECT * FROM project_workspaces WHERE id=?').get(ml.id), before);
  s.close();
});
test('a queued delete re-checks platform records when it runs, and refuses without a retry loop', () => {
  const { s, db } = setup();
  s.pauseWrites();
  s.deleteProject('p-ledger');                                                        // queued: no records yet
  assert.equal(s.pendingWrites, 1);
  const pw = db.prepare("SELECT id FROM project_workspaces WHERE project_id='p-ledger'").get().id;
  db.prepare(`INSERT INTO artifacts (id,project_id,kind,name,owner_participation_id,owner_workspace_id,created_by,created_at,updated_at)
    VALUES ('a-q','p-ledger','report','notes',?,'sde','user:local',?,?)`).run(pw, h.NOW, h.NOW);
  s.resumeWrites();
  assert.ok(s.getProject('p-ledger'));
  assert.equal(s.pendingWrites, 0);
  s.close();
});
test('a missing platform table counts as no records; any other error fails closed', () => {
  const { s, db } = setup();
  db.exec('DROP TABLE agent_sessions');
  assert.equal(s.hasPlatformRecords('p-sales'), false);
  assert.equal(s.deleteProject('p-sales'), true);
  const prepare = db.prepare;
  db.prepare = function (sql) { if (/FROM artifacts WHERE project_id/.test(sql)) throw new Error('disk I/O error'); return prepare.call(this, sql); };
  try {
    assert.equal(s.hasPlatformRecords('p-invoice'), true);
    assert.equal(s.deleteProject('p-invoice'), false);
  } finally { db.prepare = prepare; }
  assert.ok(s.getProject('p-invoice'));
  s.close();
});
test('withdraw does not reveal whether a participation id exists', () => {
  const { s, db, nx, me } = setup();
  db.prepare("INSERT INTO principals VALUES ('user:guest','user','guest',NULL,?)").run(h.NOW);
  db.prepare("INSERT INTO memberships VALUES ('user:guest','project','p-ledger','member',?)").run(h.NOW);
  const guest = nx.principals.get('user:guest');
  const other = nx.workspaces.attach(me, 'p-invoice', 'qa');
  assert.throws(() => nx.workspaces.withdraw(guest, 'missing'), (e) => e.code === 'denied');
  assert.throws(() => nx.workspaces.withdraw(guest, other.id), (e) => e.code === 'denied');
  assert.throws(() => nx.workspaces.withdraw(me, 'missing'), (e) => e.code === 'not_found');
  const mine = nx.workspaces.attach(me, 'p-ledger', 'qa');
  assert.equal(nx.workspaces.withdraw(guest, mine.id).status, 'withdrawn');
  s.close();
});
test('a failed activity write rolls back the participation change; the project save commits', () => {
  const { s, db, nx, me, logs } = setup();
  db.exec("CREATE TEMP TRIGGER t_act BEFORE INSERT ON main.activity BEGIN SELECT RAISE(ABORT, 'forced'); END");
  s.updateProject('p-ledger', { domainId: 'ai-ml' });
  db.exec('DROP TRIGGER temp.t_act');
  assert.equal(s.getProject('p-ledger').domainId, 'ai-ml');
  assert.equal(s.pendingWrites, 0);
  assert.equal(nx.workspaces.primaryOf(me, 'p-ledger').workspaceId, 'sde');
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM project_workspaces WHERE project_id='p-ledger' AND workspace_id='ml'").get().n, 0);
  assert.ok(logs.some((l) => /primary sync failed project=p-ledger/.test(l)));
  s.close();
});
test('on a held v6 database, save and delete behave exactly as before', () => {
  const { file } = h.v6Fixture(); const logs = []; const s = new PersistStore(file);
  s.open({ log: (l) => logs.push(l), backupDir: path.join(path.dirname(file), 'b'), now: () => h.NOW, holdV7: true });
  assert.equal(s.schemaVersion, 6); assert.equal(s.platformAvailable, false); assert.equal(s.platformDatabase(), null);
  const base = s.getProject('p-ledger');
  s.saveProject({ ...base, id: 'p-v6', domainId: 'ai-ml' });
  assert.equal(s.getProject('p-v6').domainId, 'ai-ml');
  assert.equal(s.hasPlatformRecords('p-v6'), false);
  assert.equal(s.deleteProject('p-v6'), true);
  assert.equal(s.getProject('p-v6'), null);
  assert.equal(s.pendingWrites, 0);
  assert.ok(!logs.some((l) => /\[nexus\]/.test(l)));
  s.close();
});
test('saveProject inside an open caller transaction survives a forced sync failure', () => {
  const { s, db, nx, me, logs } = setup();
  db.exec("CREATE TEMP TRIGGER t_fail2 BEFORE INSERT ON main.project_workspaces BEGIN SELECT RAISE(ABORT, 'forced'); END");
  const base = s.getProject('p-ledger');
  db.transaction(() => {
    s.saveProject({ ...base, id: 'p-tx', domainId: 'ai-ml' });
    db.prepare("INSERT INTO kv (key,value,updated_at) VALUES ('tx.marker','1',1)").run();
  }).immediate();
  db.exec('DROP TRIGGER temp.t_fail2');
  assert.equal(s.getProject('p-tx').domainId, 'ai-ml');
  assert.equal(s.getKv('tx.marker'), 1);
  assert.equal(s.pendingWrites, 0);
  assert.equal(nx.workspaces.primaryOf(me, 'p-tx'), null);
  assert.ok(logs.some((l) => /primary sync failed project=p-tx/.test(l)));
  s.close();
});
