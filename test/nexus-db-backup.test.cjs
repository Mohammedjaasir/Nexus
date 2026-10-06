'use strict';
const h = require('./helpers/sqlite.cjs');
if (!h.realSqliteOrSkip()) return;
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const loadTs = require('./load-ts.cjs');
const { backupAndVerify, tableRowCounts, backupStamp } = loadTs('src/main/nexus/db/backup.ts');
const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');

test('the backup is a verified, hashed copy at the source version with equal row counts', () => {
  const { dir, file } = h.v6Fixture(); const db = h.openRaw(file);
  const counts = tableRowCounts(db);
  const rec = backupAndVerify(db, { dir: path.join(dir, 'backups'), fromVersion: 6, rowCounts: counts, now: () => h.NOW });
  assert.equal(rec.file, `harness-v6-${backupStamp(h.NOW)}.db`);
  assert.match(rec.file, /^harness-v6-\d{8}T\d{6}Z\.db$/);
  assert.equal(rec.sha256, sha(rec.path));
  assert.equal(rec.bytes, fs.statSync(rec.path).size);
  assert.ok(!fs.existsSync(`${rec.path}.partial`));
  const Database = require('better-sqlite3');
  const copy = new Database(rec.path, { readonly: true, fileMustExist: true });
  assert.equal(copy.pragma('user_version', { simple: true }), 6);
  assert.deepEqual(tableRowCounts(copy), counts);
  assert.deepEqual(h.legacySnapshot(copy), h.legacySnapshot(db));
  copy.close(); db.close();
});
test('rows still in the WAL are in the backup', () => {
  const { dir, file } = h.v6Fixture(); const db = h.openRaw(file);
  db.pragma('wal_autocheckpoint = 0');
  db.prepare('INSERT INTO kv (key,value,updated_at) VALUES (?,?,?)').run('late', '1', h.NOW);
  const rec = backupAndVerify(db, { dir: path.join(dir, 'b'), fromVersion: 6, rowCounts: tableRowCounts(db), now: () => h.NOW });
  const Database = require('better-sqlite3'); const copy = new Database(rec.path, { readonly: true });
  assert.equal(copy.prepare("SELECT value FROM kv WHERE key='late'").get().value, '1');
  copy.close(); db.close();
});
test('the source database is not modified', () => {
  const { dir, file, snap } = h.v6Fixture(); const db = h.openRaw(file);
  const schema = h.schemaObjects(db);
  backupAndVerify(db, { dir: path.join(dir, 'b'), fromVersion: 6, rowCounts: tableRowCounts(db), now: () => h.NOW });
  assert.deepEqual(h.legacySnapshot(db), snap);
  assert.deepEqual(h.schemaObjects(db), schema);
  assert.equal(db.pragma('user_version', { simple: true }), 6);
  db.close();
});
test('a verification mismatch throws and leaves no file behind', () => {
  const { dir, file } = h.v6Fixture(); const db = h.openRaw(file); const out = path.join(dir, 'b');
  assert.throws(() => backupAndVerify(db, { dir: out, fromVersion: 6, rowCounts: { ...tableRowCounts(db), kv: 999 }, now: () => h.NOW }),
    (e) => e.stage === 'verify' && /row count/.test(e.message));
  assert.deepEqual(fs.readdirSync(out), []);
  assert.throws(() => backupAndVerify(db, { dir: out, fromVersion: 5, rowCounts: tableRowCounts(db), now: () => h.NOW }),
    (e) => e.stage === 'verify' && /user_version/.test(e.message));
  db.close();
});
test('an existing backup is never overwritten', () => {
  const { dir, file } = h.v6Fixture(); const db = h.openRaw(file); const o = { dir: path.join(dir, 'b'), fromVersion: 6, rowCounts: tableRowCounts(db), now: () => h.NOW };
  backupAndVerify(db, o);
  assert.throws(() => backupAndVerify(db, o), (e) => e.stage === 'exists');
  db.close();
});
test('tableRowCounts covers every user table and quotes names', () => {
  const { file } = h.v6Fixture(); const db = h.openRaw(file);
  db.exec('CREATE TABLE "odd name" (x)'); db.exec('INSERT INTO "odd name" VALUES (1)');
  const c = tableRowCounts(db);
  assert.equal(c['odd name'], 1); assert.equal(c.projects, 5); assert.ok(!Object.keys(c).some((k) => k.startsWith('sqlite_')));
  db.close();
});
