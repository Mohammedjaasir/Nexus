'use strict';
const h = require('./helpers/sqlite.cjs');
if (!h.realSqliteOrSkip()) return;
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const loadTs = require('./load-ts.cjs');
const { backupAndVerify, tableRowCounts, backupStamp, __testing } = loadTs('src/main/nexus/db/backup.ts');
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

const leftovers = (d) => fs.readdirSync(d).filter((f) => /\.partial|-wal$|-shm$|-journal$/.test(f));
test('an unopenable backup fails at verify and leaves nothing behind', () => {
  const { dir, file } = h.v6Fixture(); const db = h.openRaw(file); const out = path.join(dir, 'b');
  assert.throws(() => __testing.backupAndVerifyWithHook(db, { dir: out, fromVersion: 6, rowCounts: tableRowCounts(db), now: () => h.NOW },
    (p) => fs.writeFileSync(p, Buffer.from('this is not a database file at all'.repeat(40)))),
  (e) => e.stage === 'verify');
  assert.deepEqual(fs.readdirSync(out), []);
  db.close();
});
test('a write failure has stage write, leaves no partial and does not touch the source', () => {
  const { dir, file } = h.v6Fixture(); const db = h.openRaw(file);
  db.pragma('wal_checkpoint(TRUNCATE)');
  const before = sha(file);
  const blocker = path.join(dir, 'not-a-dir'); fs.writeFileSync(blocker, 'x');
  assert.throws(() => backupAndVerify(db, { dir: blocker, fromVersion: 6, rowCounts: tableRowCounts(db), now: () => h.NOW }),
    (e) => e.stage === 'write');
  assert.deepEqual(fs.readdirSync(dir).filter((f) => f.includes('.partial')), []);
  assert.equal(sha(file), before);
  db.close();
});
test('odd table names are counted and recorded', () => {
  const { dir, file } = h.v6Fixture(); const db = h.openRaw(file);
  db.exec('CREATE TABLE "odd name" (x)'); db.exec('INSERT INTO "odd name" VALUES (1),(2)');
  db.exec('CREATE TABLE "a""b" (x)'); db.exec('INSERT INTO "a""b" VALUES (1),(2),(3)');
  db.exec('CREATE TABLE sqliteX (x)'); db.exec('INSERT INTO sqliteX VALUES (1)');
  const rec = backupAndVerify(db, { dir: path.join(dir, 'b'), fromVersion: 6, rowCounts: tableRowCounts(db), now: () => h.NOW });
  assert.equal(rec.rowCounts['odd name'], 2); assert.equal(rec.rowCounts['a"b'], 3); assert.equal(rec.rowCounts.sqliteX, 1);
  db.close();
});
test('a target that appears after the initial check is not overwritten', () => {
  const { dir, file } = h.v6Fixture(); const db = h.openRaw(file); const out = path.join(dir, 'b');
  const target = path.join(out, `harness-v6-${backupStamp(h.NOW)}.db`);
  assert.throws(() => __testing.backupAndVerifyWithHook(db, { dir: out, fromVersion: 6, rowCounts: tableRowCounts(db), now: () => h.NOW },
    () => fs.writeFileSync(target, 'precious')), (e) => e.stage === 'exists');
  assert.equal(fs.readFileSync(target, 'utf8'), 'precious');
  assert.deepEqual(leftovers(out), []);
  db.close();
});
// Another module may define its own `__testing` (lineageService does); what matters is backup's hook.
const refsBackupHook = (text) => /afterWrite|backupAndVerifyWithHook/.test(text)
  || (/__testing/.test(text) && /from\s+['"][^'"]*\bbackup['"]|require\(\s*['"][^'"]*\bbackup['"]/.test(text));
test('no source file other than backup.ts references the test hook', () => {
  const root = path.join(__dirname, '..', 'src'); const hits = [];
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const f = path.join(d, e.name);
    if (e.isDirectory()) walk(f);
    else if (/\.(ts|tsx)$/.test(e.name) && !f.endsWith(path.join('nexus', 'db', 'backup.ts')) && refsBackupHook(fs.readFileSync(f, 'utf8'))) hits.push(f);
  } };
  walk(root); assert.deepEqual(hits, []);
});
