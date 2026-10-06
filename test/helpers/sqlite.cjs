'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const loadTs = require('../load-ts.cjs');

const ELECTRON = Boolean(process.versions.electron) && process.env.ELECTRON_RUN_AS_NODE === '1';
const NOW = 1_780_000_000_000;
const LEGACY_TABLES = ['kv', 'command_history', 'projects', 'project_graph_nodes', 'project_graph_edges',
  'project_plans', 'project_gaps', 'project_goals'];

function realSqliteOrSkip() {
  if (ELECTRON) return true;
  test('real SQLite suite: run with npm run test:db', { skip: 'needs Electron as node (better-sqlite3 is built for Electron)' }, () => {});
  return false;
}
const tmpDir = (prefix = 'nx-db-') => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
function openRaw(file) {
  const Database = require('better-sqlite3');
  const db = new Database(file);
  db.pragma('journal_mode = WAL'); db.pragma('busy_timeout = 5000'); db.pragma('foreign_keys = ON');
  return db;
}
function buildV6(file) {
  const { MIGRATIONS } = loadTs('src/main/db.ts');
  const db = openRaw(file);
  for (let i = 0; i < 6; i++) db.transaction(() => { MIGRATIONS[i](db, null); db.pragma(`user_version = ${i + 1}`); })();
  return db;
}
function seedRealistic(db) {
  const meta = (o = {}) => JSON.stringify({ secondaryDomains: [], detectedLanguages: [], frameworks: [], dependencies: [],
    entryPoints: [], importantFiles: [], testSuites: [], documentationFiles: [], ...o });
  const health = JSON.stringify({ healthScore: 72, hasTests: true, hasDocumentation: false, hasEntryPoints: true,
    hasGit: true, gitClean: true, dependencyCount: 4 });
  const p = db.prepare(`INSERT INTO projects (id,name,root_path,domain_id,project_type,description,metadata_json,
    health_json,created_at,updated_at,last_analyzed_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
  [
    ['p-ledger', 'ledger-api', 'C:/work/ledger-api', 'software-engineering', 'service', 'Billing ledger service',
      meta({ secondaryDomains: ['devops-cloud'], gitInfo: { isRepo: true, branch: 'main', isClean: true } })],
    ['p-invoice', 'invoice-ocr', 'C:/work/invoice-ocr', 'computer-vision', 'application', null, meta({ secondaryDomains: ['ai-ml'] })],
    ['p-sales', 'sales-insights', 'C:/work/sales-insights', 'data-science', 'notebook_pipeline', null, meta()],
    ['p-audit', 'audit-scanner', 'C:/work/audit-scanner', 'cybersecurity', 'cli', null, meta()],
    ['p-old', 'old-notes', 'C:/work/old-notes', 'retired-domain', 'unknown', null, meta()]
  ].forEach((r, i) => p.run(...r, health, NOW - 5000 + i, NOW - 1000 + i, NOW - 900 + i));
  const n = db.prepare('INSERT INTO project_graph_nodes (id,project_id,kind,name,path,metadata_json) VALUES (?,?,?,?,?,?)');
  n.run('n-api', 'p-ledger', 'module', 'api', 'src/api', '{}');
  n.run('n-db', 'p-ledger', 'module', 'db', 'src/db', '{}');
  n.run('n-test', 'p-ledger', 'test_suite', 'api.test', 'test/api.test.ts', '{"cases":4}');
  const e = db.prepare('INSERT INTO project_graph_edges (id,project_id,source_id,target_id,kind,metadata_json) VALUES (?,?,?,?,?,?)');
  e.run('e-1', 'p-ledger', 'n-api', 'n-db', 'imports', '{}');
  e.run('e-2', 'p-ledger', 'n-test', 'n-api', 'tests', '{}');
  const plan = (id) => JSON.stringify({ projectId: id, milestones: [{ id: 'm1', title: 'First release', tasks: [] }] });
  db.prepare('INSERT INTO project_plans VALUES (?,?,?)').run('p-ledger', plan('p-ledger'), NOW - 400);
  db.prepare('INSERT INTO project_plans VALUES (?,?,?)').run('p-gone', plan('p-gone'), NOW - 9000);        // orphan, kept
  db.prepare('INSERT INTO project_gaps VALUES (?,?,?)').run('p-ledger', JSON.stringify({ projectId: 'p-ledger', gaps: [] }), NOW - 300);
  db.prepare('INSERT INTO project_gaps VALUES (?,?,?)').run('p-gone', JSON.stringify({ projectId: 'p-gone', gaps: [] }), NOW - 9000); // orphan
  db.prepare('INSERT INTO project_goals VALUES (?,?,?)').run('p-invoice', JSON.stringify({ projectId: 'p-invoice', title: 'Read invoice totals' }), NOW - 200);
  const kv = db.prepare('INSERT INTO kv (key,value,updated_at) VALUES (?,?,?)');
  kv.run('window_bounds', JSON.stringify({ x: 10, y: 20, width: 1200, height: 800 }), NOW - 100);
  kv.run('active_project_id', JSON.stringify('p-ledger'), NOW - 100);
  kv.run('nx.theme', JSON.stringify('dark'), NOW - 100);
  const h = db.prepare('INSERT INTO command_history (agent_id,cwd,text,ts) VALUES (?,?,?,?)');
  h.run('agent-1', 'C:/work/ledger-api', 'run the unit tests', NOW - 100);
  h.run('agent-2', null, 'summarise the open changes', NOW - 50);
}
const legacySnapshot = (db) => Object.fromEntries(LEGACY_TABLES.map((t) => [t, db.prepare(`SELECT * FROM "${t}" ORDER BY rowid`).all()]));
const schemaObjects = (db) => db.prepare("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name").all();
const userTables = (db) => db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((r) => r.name);
const allRows = (db) => Object.fromEntries(userTables(db).map((t) => [t, db.prepare(`SELECT * FROM "${t}" ORDER BY rowid`).all()]));
const count = (db, t) => db.prepare(`SELECT COUNT(*) AS n FROM "${t}"`).get().n;
function v6Fixture() {
  const dir = tmpDir(); const file = path.join(dir, 'harness.db');
  const db = buildV6(file); seedRealistic(db); const snap = legacySnapshot(db); db.close();
  return { dir, file, snap };
}
module.exports = { realSqliteOrSkip, tmpDir, openRaw, buildV6, seedRealistic, v6Fixture, legacySnapshot,
  schemaObjects, allRows, count, LEGACY_TABLES, NOW, ELECTRON };
