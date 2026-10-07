'use strict';
const h = require('./helpers/sqlite.cjs');
if (!h.realSqliteOrSkip()) return;
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const loadTs = require('./load-ts.cjs');
const { PersistStore } = loadTs('src/main/db.ts');
function v7() { const f = h.v6Fixture(); const s = new PersistStore(f.file); s.open({ log: () => {}, backupDir: path.join(f.dir, 'b'), now: () => h.NOW, holdV8: true }); return { ...f, s }; }

test('writes submitted before open are flushed after the migration', () => {
  const { file, dir } = h.v6Fixture(); const s = new PersistStore(file);
  s.setKv('early', { a: 1 }); s.addHistory({ agentId: 'agent-1', text: 'queued before open' });
  s.open({ log: () => {}, backupDir: path.join(dir, 'b'), holdV8: true });
  assert.equal(s.schemaVersion, 7); assert.deepEqual(s.getKv('early'), { a: 1 });
  assert.equal(s.searchHistory('queued before open').length, 1); assert.equal(s.pendingWrites, 0);
  s.close();
});
test('project lifecycle through the real ProjectManager on v7: create, list, update, delete', async () => {
  const { s } = v7(); const { ProjectManager } = loadTs('src/main/project/projectManager.ts'); const pm = new ProjectManager(s);
  const root = h.tmpDir('nx-proj-'); fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'demo-svc', dependencies: { express: '4' } }));
  const p = await pm.createProject({ name: 'demo-svc', rootPath: root, domainId: 'software-engineering' });
  assert.ok(pm.listProjects().some((x) => x.id === p.id));
  assert.equal(pm.updateProject(p.id, { description: 'changed' }).description, 'changed');
  pm.setActiveProject(p.id); assert.equal(pm.getActiveProject().id, p.id);
  assert.equal(pm.deleteProject(p.id), true); assert.equal(pm.getProject(p.id), null);
  assert.equal(s.getActiveProjectId(), null);
  s.close();
});
test('graph save, replace, query and delete on v7', () => {
  const { s } = v7();
  s.saveProjectGraph('p-invoice', [{ id: 'g1', projectId: 'p-invoice', kind: 'file', name: 'a.py', path: 'a.py' }], []);
  assert.equal(s.getProjectGraphStats('p-invoice').fileCount, 1);
  s.deleteProjectGraph('p-invoice'); assert.equal(s.getProjectGraphStats('p-invoice').nodeCount, 0);
  assert.equal(s.getProjectGraphStats('p-ledger').nodeCount, 3);
  s.close();
});
test('plans, gaps and goals save, read and delete on v7; orphans untouched', () => {
  const { s, snap, file } = v7();
  s.saveProjectPlan({ projectId: 'p-sales', milestones: [] }); assert.equal(s.getProjectPlan('p-sales').projectId, 'p-sales');
  s.saveProjectGoal({ projectId: 'p-sales', title: 'Weekly revenue view' }); assert.equal(s.getProjectGoal('p-sales').title, 'Weekly revenue view');
  s.deleteProjectGapAnalysis('p-ledger'); assert.equal(s.getProjectGapAnalysis('p-ledger'), null);
  assert.ok(s.getProjectPlan('p-gone')); assert.ok(s.getProjectGapAnalysis('p-gone'));
  s.close();
  const db = h.openRaw(file);
  assert.deepEqual(db.prepare("SELECT * FROM project_plans WHERE project_id='p-gone'").all(), snap.project_plans.filter((r) => r.project_id === 'p-gone'));
  assert.deepEqual(db.prepare("SELECT * FROM project_gaps WHERE project_id='p-gone'").all(), snap.project_gaps.filter((r) => r.project_id === 'p-gone'));
  db.close();
});
test('the HEAD e1fd80f build opens a v7 database, works on legacy tables, and can delete a project', (t) => {
  let oldDb, oldQueue;
  try {
    oldDb = execFileSync('git', ['show', 'e1fd80f:src/main/db.ts'], { cwd: path.join(__dirname, '..'), encoding: 'utf8' });
    oldQueue = execFileSync('git', ['show', 'e1fd80f:src/main/legacyWriteQueue.ts'], { cwd: path.join(__dirname, '..'), encoding: 'utf8' });
  } catch { t.skip('git history not available'); return; }
  const { file, dir, s } = v7(); s.close();
  const old = path.join(dir, 'old', 'src', 'main'); fs.mkdirSync(old, { recursive: true });
  fs.writeFileSync(path.join(old, 'db.ts'), oldDb); fs.writeFileSync(path.join(old, 'legacyWriteQueue.ts'), oldQueue);
  const { PersistStore: OldStore } = loadTs.loadAbsolute(path.join(old, 'db.ts'));   // T11 adds this export to load-ts.cjs
  const o = new OldStore(file); o.open();
  assert.equal(o.listProjects().length, 5);
  o.saveProject({ ...o.getProject('p-ledger'), name: 'ledger-api-2' });
  assert.equal(o.deleteProject('p-sales'), true);                    // participations cascade; no platform records
  o.close();
  const db = h.openRaw(file);
  assert.equal(db.pragma('user_version', { simple: true }), 7);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM project_workspaces WHERE project_id='p-sales'").get().n, 0);
  assert.deepEqual(db.pragma('foreign_key_check'), []);
  db.close();
  const n = new PersistStore(file); n.open({ log: () => {}, holdV8: true });
  assert.equal(n.lastMigration.state, 'not_needed'); n.close();
});
test('the e2fceec build opens a v8 database as newer: legacy list, save and delete work; its delete weakness is pinned', () => {
  const { materializeRev } = require('./helpers/materialize-rev.cjs');
  const { file, dir } = h.v6Fixture();
  const cur = new PersistStore(file); cur.open({ log: () => {}, backupDir: path.join(dir, 'b'), now: () => h.NOW });
  assert.equal(cur.schemaVersion, 8); assert.equal(cur.handoffsAvailable, true);
  // A platform record on p-ledger, so the old build's weakness can be shown on it.
  const pdb = cur.platformDatabase();
  const pw = pdb.prepare("SELECT id, workspace_id FROM project_workspaces WHERE project_id = 'p-ledger' AND is_primary = 1").get();
  pdb.prepare(`INSERT INTO artifacts (id, project_id, kind, name, owner_participation_id, owner_workspace_id, created_by, created_at, updated_at)
    VALUES ('a-down', 'p-ledger', 'report', 'notes', ?, ?, 'user:local', ?, ?)`).run(pw.id, pw.workspace_id, h.NOW, h.NOW);
  cur.close();
  const oldDb = materializeRev('e2fceec', h.tmpDir('nx-rev-'));
  const { PersistStore: OldStore } = loadTs.loadAbsolute(oldDb);
  const logs = [];
  const o = new OldStore(file); o.open({ log: (l) => logs.push(l), backupDir: path.join(dir, 'b'), now: () => h.NOW });
  assert.equal(o.lastMigration.state, 'skipped'); assert.equal(o.lastMigration.reason, 'newer_schema');
  assert.equal(o.platformAvailable, false); assert.equal(o.platformDatabase(), null);
  assert.ok(logs.some((l) => /schema v8 is newer than this build \(v7\)/.test(l)));
  assert.equal(o.listProjects().length, 5);
  o.saveProject({ ...o.getProject('p-invoice'), name: 'invoice-ocr-2' });
  assert.equal(o.getProject('p-invoice').name, 'invoice-ocr-2');
  assert.equal(o.deleteProject('p-sales'), true);                    // no platform records: participations cascade
  assert.equal(o.getProject('p-sales'), null);
  // Known weakness (platform-core 16.2, ruling C19): at v8 the old build's record check answers false, so
  // it attempts the delete; SQLite's ON DELETE RESTRICT refuses it and the project and its artifact stay.
  assert.equal(o.hasPlatformRecords('p-ledger'), false);
  try { o.deleteProject('p-ledger'); } catch { /* the old build may surface the FK error; either way nothing is removed */ }
  assert.ok(o.getProject('p-ledger'), 'the project with a platform record is still there');
  o.close();
  const db = h.openRaw(file);
  assert.equal(db.pragma('user_version', { simple: true }), 8);
  assert.deepEqual(db.pragma('foreign_key_check'), []);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM project_workspaces WHERE project_id='p-sales'").get().n, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM artifacts WHERE id='a-down'").get().n, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM projects WHERE id='p-ledger'").get().n, 1);
  db.close();
  const n = new PersistStore(file); n.open({ log: () => {}, backupDir: path.join(dir, 'b') });
  assert.equal(n.lastMigration.state, 'not_needed'); assert.equal(n.lastMigrationV8.state, 'not_needed');
  assert.equal(n.platformAvailable, true); assert.equal(n.handoffsAvailable, true);
  assert.equal(n.hasPlatformRecords('p-ledger'), true); assert.equal(n.deleteProject('p-ledger'), false);
  n.close();
});
