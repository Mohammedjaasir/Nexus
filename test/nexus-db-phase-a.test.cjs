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
function v7() { const f = h.v6Fixture(); const s = new PersistStore(f.file); s.open({ log: () => {}, backupDir: path.join(f.dir, 'b'), now: () => h.NOW }); return { ...f, s }; }

test('writes submitted before open are flushed after the migration', () => {
  const { file, dir } = h.v6Fixture(); const s = new PersistStore(file);
  s.setKv('early', { a: 1 }); s.addHistory({ agentId: 'agent-1', text: 'queued before open' });
  s.open({ log: () => {}, backupDir: path.join(dir, 'b') });
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
  const n = new PersistStore(file); n.open({ log: () => {} });
  assert.equal(n.lastMigration.state, 'not_needed'); n.close();
});
