'use strict';
const h = require('./helpers/sqlite.cjs');
if (h.realSqliteOrSkip()) {
  const test = require('node:test');
  const assert = require('node:assert/strict');

  test('runs in Electron with the Electron-built better-sqlite3 and JSON1', () => {
    assert.ok(process.versions.electron);
    const Database = require('better-sqlite3');
    const db = new Database(':memory:');
    assert.match(db.prepare('SELECT sqlite_version() AS v').get().v, /^3\.\d+/);
    assert.equal(db.prepare("SELECT json_valid('{}') AS ok").get().ok, 1);
    db.close();
  });

  test('the v6 fixture is built by the real legacy migrations and is realistic', () => {
    const { file } = h.v6Fixture();
    const db = h.openRaw(file);
    assert.equal(db.pragma('user_version', { simple: true }), 6);
    for (const t of h.LEGACY_TABLES) assert.ok(h.count(db, t) > 0, t);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM project_plans WHERE project_id NOT IN (SELECT id FROM projects)').get().n, 1);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM project_gaps WHERE project_id NOT IN (SELECT id FROM projects)').get().n, 1);
    db.close();
  });
}
