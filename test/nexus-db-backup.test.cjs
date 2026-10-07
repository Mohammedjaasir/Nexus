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
// Test hooks: only these files may define `__testing`, each exactly once, on its export line.
const HOOK_OWNERS = ['src/main/nexus/db/backup.ts', 'src/main/nexus/lineage/lineageService.ts'];
const EXT = /\.(?:ts|tsx|js|cjs|mjs)$/;
/** A relative specifier from `fromRel`, as an extension-less module path ('src/main/x'); null for a bare specifier. */
function resolveSpec(fromRel, spec) {
  if (!spec.startsWith('.')) return null;
  return path.posix.normalize(path.posix.join(path.posix.dirname(fromRel), spec)).replace(EXT, '');
}
/** Every `export * [as x] from '...'` and `export { ... } from '...'` of a file: { star, names, spec }. */
function reExports(text) {
  const out = [];
  for (const m of text.matchAll(/export\s+\*\s+(?:as\s+\w+\s+)?from\s+['"`]([^'"`]+)['"`]/g)) out.push({ star: true, names: '', spec: m[1] });
  for (const m of text.matchAll(/export\s+(?:type\s+)?\{([^}]*)\}\s*from\s+['"`]([^'"`]+)['"`]/g)) out.push({ star: false, names: m[1], spec: m[2] });
  return out;
}
/**
 * Modules that expose a hook owner's exports: the owners themselves, plus (to a fixed
 * point) any module that `export *`s one of them, so a chain through a third module is caught.
 */
function hookCarriers(files) {
  const mod = (rel) => rel.replace(EXT, '');
  const carriers = new Set(HOOK_OWNERS.map(mod));
  const has = (m) => m !== null && (carriers.has(m) || carriers.has(`${m}/index`));
  for (let changed = true; changed;) {
    changed = false;
    for (const { rel, text } of files) {
      if (carriers.has(mod(rel))) continue;
      if (reExports(text).some((r) => r.star && has(resolveSpec(rel, r.spec)))) { carriers.add(mod(rel)); changed = true; }
    }
  }
  return { carriers, has };
}
/** files: [{ rel: 'src/...' (forward slashes), text }]. Returns one message per violation. */
function hookViolations(files) {
  const out = [];
  const { has } = hookCarriers(files);
  for (const { rel, text } of files) {
    const n = (text.match(/__testing/g) || []).length;
    if (n > 0 && !HOOK_OWNERS.includes(rel)) out.push(`${rel}: references __testing`);
    if (HOOK_OWNERS.includes(rel)) {
      const lines = text.split(/\r?\n/).filter((l) => l.includes('__testing'));
      if (lines.length !== 1 || !/^export const __testing\b/.test(lines[0])) out.push(`${rel}: __testing outside its export declaration`);
    }
    if (/export\s+\*\s+(?:as\s+\w+\s+)?from\s+['"][^'"]*(?:backup|lineageService)(?:\.ts)?['"]/.test(text)) out.push(`${rel}: export * from a hook owner`);
    for (const r of reExports(text)) {
      const target = resolveSpec(rel, r.spec);
      if (!has(target) || HOOK_OWNERS.some((o) => o.replace(EXT, '') === target)) continue;   // direct owners: the check above
      if (r.star) out.push(`${rel}: export * from a module that re-exports a hook owner`);
      else if (/\b__testing\b/.test(r.names)) out.push(`${rel}: re-exports __testing through a module that re-exports a hook owner`);
    }
    if (rel !== 'src/main/nexus/db/backup.ts' && /afterWrite|backupAndVerifyWithHook/.test(text)) out.push(`${rel}: references backup's hook`);
  }
  return out;
}
function srcFiles() {
  const root = path.join(__dirname, '..'); const files = [];
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const f = path.join(d, e.name);
    if (e.isDirectory()) walk(f);
    else if (/\.(ts|tsx)$/.test(e.name)) files.push({ rel: path.relative(root, f).split(path.sep).join('/'), text: fs.readFileSync(f, 'utf8') });
  } };
  walk(path.join(root, 'src')); return files;
}
test('no source file other than backup.ts references the test hook', () => {
  const files = srcFiles();
  for (const owner of HOOK_OWNERS) assert.ok(files.some((f) => f.rel === owner), owner);
  assert.deepEqual(hookViolations(files), []);
});
test('the hook scan flags each kind of offending source', () => {
  const decl = 'export const __testing = { x: 1 };';
  assert.deepEqual(hookViolations([{ rel: 'src/main/x.ts', text: "import { __testing } from './nexus/db/backup';" }]), ['src/main/x.ts: references __testing']);
  assert.deepEqual(hookViolations([{ rel: 'src/main/nexus/db/backup.ts', text: `${decl}\n__testing.x;` }]),
    ['src/main/nexus/db/backup.ts: __testing outside its export declaration']);
  assert.deepEqual(hookViolations([{ rel: 'src/main/nexus/lineage/lineageService.ts', text: '// __testing\nconst y = 1;' }]),
    ['src/main/nexus/lineage/lineageService.ts: __testing outside its export declaration']);
  assert.deepEqual(hookViolations([{ rel: 'src/main/y.ts', text: "export * from './nexus/lineage/lineageService';" }]), ['src/main/y.ts: export * from a hook owner']);
  assert.deepEqual(hookViolations([{ rel: 'src/main/y.ts', text: "export * as b from '../db/backup.ts';" }]), ['src/main/y.ts: export * from a hook owner']);
  assert.deepEqual(hookViolations([{ rel: 'src/main/z.ts', text: 'opts.afterWrite = f;' }]), ["src/main/z.ts: references backup's hook"]);
  assert.deepEqual(hookViolations([{ rel: 'src/main/nexus/db/backup.ts', text: decl }, { rel: 'src/main/nexus/lineage/lineageService.ts', text: decl }]), []);
});
test('the hook scan follows a re-export chain through a third module (in-memory self-test)', () => {
  const decl = 'export const __testing = { x: 1 };';
  const owner = { rel: 'src/main/nexus/db/backup.ts', text: decl };
  const mid = { rel: 'src/main/nexus/db/mid.ts', text: "export * from './backup';" };              // direct: flagged as before
  const chain = { rel: 'src/main/other.ts', text: 'export * from "./nexus/db/mid";' };           // through mid
  const deep = { rel: 'src/main/deeper/again.ts', text: "export * as ns from '../other.ts';" };   // through other, through mid
  const named = { rel: 'src/main/named.ts', text: "export { __testing as t } from './nexus/db/mid';" };
  const clean = { rel: 'src/main/nexus/db/clean.ts', text: 'export const y = 1;' };
  const fine = { rel: 'src/main/fine.ts', text: "export * from './nexus/db/clean';\nexport { y } from './nexus/db/clean';" };
  const v = hookViolations([owner, mid, chain, deep, named, clean, fine]);
  assert.ok(v.includes('src/main/nexus/db/mid.ts: export * from a hook owner'), v.join('\n'));
  assert.ok(v.includes('src/main/other.ts: export * from a module that re-exports a hook owner'), v.join('\n'));
  assert.ok(v.includes('src/main/deeper/again.ts: export * from a module that re-exports a hook owner'), v.join('\n'));
  assert.ok(v.includes('src/main/named.ts: re-exports __testing through a module that re-exports a hook owner'), v.join('\n'));
  assert.ok(!v.some((x) => x.startsWith('src/main/fine.ts') || x.startsWith('src/main/nexus/db/clean.ts')), v.join('\n'));
  // An index module counts: './nexus/db' resolves to its index.ts.
  const idx = { rel: 'src/main/nexus/db/index.ts', text: "export * from './backup';" };
  const viaIndex = { rel: 'src/main/via.ts', text: "export * from './nexus/db';" };
  assert.ok(hookViolations([owner, idx, viaIndex]).includes('src/main/via.ts: export * from a module that re-exports a hook owner'));
});
