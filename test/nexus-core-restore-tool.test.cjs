'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { applyRestore, planRestore } = require('../tools/nexus-db-restore.cjs');
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const made = [];
process.on('exit', () => { for (const d of made) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } } });
function scene() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nx-restore-'));
  made.push(dir);
  const db = path.join(dir, 'harness.db'); const backup = path.join(dir, 'backups', 'harness-v6-20261006T120000Z.db');
  fs.mkdirSync(path.dirname(backup));
  fs.writeFileSync(db, 'v7 main'); fs.writeFileSync(`${db}-wal`, 'v7 wal'); fs.writeFileSync(`${db}-shm`, 'v7 shm');
  fs.writeFileSync(backup, 'v6 copy');
  return { dir, db, backup, hash: sha(Buffer.from('v6 copy')) };
}
test('restore moves the current files aside (never deletes) and installs the verified backup', () => {
  const { dir, db, backup, hash } = scene();
  const r = applyRestore({ db, backup, sha256: hash }, Date.UTC(2026, 9, 6, 12));
  assert.equal(fs.readFileSync(db, 'utf8'), 'v6 copy');
  assert.ok(!fs.existsSync(`${db}-wal`) && !fs.existsSync(`${db}-shm`), 'stale WAL must not be replayed');
  assert.equal(r.movedAside.length, 3);
  for (const f of r.movedAside) assert.match(fs.readFileSync(f, 'utf8'), /^v7 /);
  assert.equal(fs.readFileSync(backup, 'utf8'), 'v6 copy', 'the backup itself is kept');
  assert.ok(fs.readdirSync(dir).some((f) => f.startsWith('harness.db.pre-restore-')));
});
test('a hash mismatch refuses and touches nothing', () => {
  const { db, backup } = scene();
  assert.throws(() => applyRestore({ db, backup, sha256: '0'.repeat(64) }), /sha256/);
  assert.equal(fs.readFileSync(db, 'utf8'), 'v7 main'); assert.ok(fs.existsSync(`${db}-wal`));
});
test('dry run lists the steps and changes nothing', () => {
  const { db, backup, hash } = scene();
  const steps = planRestore({ db, backup, sha256: hash });
  assert.ok(steps.some((s) => /move .*harness\.db-wal/.test(s.describe)));
  assert.equal(fs.readFileSync(db, 'utf8'), 'v7 main');
});

// ---- beyond the brief ----

const TOOL = path.join(__dirname, '..', 'tools', 'nexus-db-restore.cjs');
const cli = (...args) => spawnSync(process.execPath, [TOOL, ...args], { encoding: 'utf8' });
/** Every file under dir with its content, so "nothing changed" is checked exactly. */
function snapshot(dir) {
  const out = {};
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const f = path.join(d, e.name);
    if (e.isDirectory()) walk(f); else out[path.relative(dir, f)] = fs.readFileSync(f, 'utf8');
  } };
  walk(dir);
  return out;
}

test('bad arguments exit 4 through the CLI and change nothing', () => {
  const { dir, db, backup, hash } = scene();
  const before = snapshot(dir);
  const cases = [
    [],
    ['--db', db, '--backup', backup],                                                // no --sha256
    ['--db', db, '--backup', backup, '--sha256', 'abc'],                             // not 64 hex characters
    ['--db', db, '--backup', backup, '--sha256', hash, '--apply', '--dry-run'],      // both modes
    ['--db', db, '--backup', backup, '--sha256', hash, '--force'],                   // unknown flag
    ['--db', db, '--backup', '--sha256', hash],                                      // flag without a value
    ['--db', db, '--db', db, '--backup', backup, '--sha256', hash]                   // repeated flag
  ];
  for (const args of cases) {
    const r = cli(...args);
    assert.equal(r.status, 4, `expected exit 4 for ${JSON.stringify(args)}; stderr: ${r.stderr}`);
    assert.match(r.stderr, /usage/i);
  }
  assert.deepEqual(snapshot(dir), before);
});

test('the CLI: dry run (the default) exits 0 and changes nothing; a mismatch exits 2; apply exits 0', () => {
  const { dir, db, backup, hash } = scene();
  const before = snapshot(dir);
  const dry = cli('--db', db, '--backup', backup, '--sha256', hash);
  assert.equal(dry.status, 0, dry.stderr);
  assert.match(dry.stdout, /dry run/i); assert.match(dry.stdout, /move .*harness\.db-wal/);
  assert.equal(cli('--db', db, '--backup', backup, '--sha256', hash, '--dry-run').status, 0);
  assert.deepEqual(snapshot(dir), before);
  const bad = cli('--db', db, '--backup', backup, '--sha256', 'f'.repeat(64), '--apply');
  assert.equal(bad.status, 2); assert.match(bad.stderr, /sha256/);
  assert.deepEqual(snapshot(dir), before);
  const ok = cli(`--db=${db}`, `--backup=${backup}`, `--sha256=${hash.toUpperCase()}`, '--apply');
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(fs.readFileSync(db, 'utf8'), 'v6 copy');
  assert.match(ok.stdout, /restored/i);
});

test('a backup that is the target database (or one of its side files) is refused', () => {
  const { dir, db, hash } = scene();
  const before = snapshot(dir);
  assert.throws(() => applyRestore({ db, backup: db, sha256: sha(Buffer.from('v7 main')) }), /same file/);
  assert.throws(() => planRestore({ db, backup: path.join(dir, '.', 'harness.db'), sha256: hash }), /same file/);
  assert.throws(() => applyRestore({ db, backup: `${db}-wal`, sha256: sha(Buffer.from('v7 wal')) }), /same file/);
  assert.deepEqual(snapshot(dir), before);
  const r = cli('--db', db, '--backup', db, '--sha256', sha(Buffer.from('v7 main')), '--apply');
  assert.equal(r.status, 4);
  assert.deepEqual(snapshot(dir), before);
});

test('a missing backup is refused and nothing is touched', () => {
  const { dir, db, hash } = scene();
  const before = snapshot(dir);
  const missing = path.join(dir, 'backups', 'harness-v6-19990101T000000Z.db');
  assert.throws(() => applyRestore({ db, backup: missing, sha256: hash }), /backup .*not found|does not exist/i);
  assert.throws(() => planRestore({ db, backup: path.join(dir, 'backups'), sha256: hash }), /not a file/i);
  assert.equal(cli('--db', db, '--backup', missing, '--sha256', hash, '--apply').status, 4);
  assert.deepEqual(snapshot(dir), before);
});

test('a second restore in the same second never overwrites the first set of moved-aside files', () => {
  const { dir, db, backup, hash } = scene();
  const at = Date.UTC(2026, 9, 6, 12);
  const first = applyRestore({ db, backup, sha256: hash }, at);
  fs.writeFileSync(`${db}-wal`, 'v6 wal after relaunch');
  const second = applyRestore({ db, backup, sha256: hash }, at);
  assert.equal(second.movedAside.length, 2);
  for (const f of first.movedAside) assert.match(fs.readFileSync(f, 'utf8'), /^v7 /, 'the first restore\'s files are intact');
  for (const f of second.movedAside) assert.ok(!first.movedAside.includes(f));
  assert.equal(fs.readFileSync(second.movedAside.find((f) => f.endsWith('-wal')), 'utf8'), 'v6 wal after relaunch');
  assert.equal(fs.readFileSync(db, 'utf8'), 'v6 copy');
  assert.equal(fs.readdirSync(dir).filter((f) => f.includes('.restoring-')).length, 0, 'no temporary copy is left behind');
});

for (const held of ['harness.db', 'harness.db-wal']) test(`${held} held open without delete sharing (as SQLite holds it on Windows) exits 3 and leaves every file in place`,
  { skip: process.platform !== 'win32' && 'the lock probe is Windows-only' }, async () => {
    const { spawn } = require('node:child_process');
    const { dir, db, backup, hash } = scene();
    const before = snapshot(dir);
    // SQLite on Windows opens its files with read/write sharing but no delete sharing, so a rename fails.
    // Holding only the -wal makes the main file move first and then be moved back.
    const target = path.join(dir, held);
    const script = `$f = [System.IO.File]::Open('${target.replace(/'/g, "''")}', 'Open', 'ReadWrite', 'ReadWrite'); `
      + "[Console]::Out.WriteLine('ready'); [void][Console]::In.ReadLine(); $f.Close()";
    const holder = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { stdio: ['pipe', 'pipe', 'inherit'] });
    try {
      await new Promise((resolve, reject) => {
        let out = '';
        holder.stdout.on('data', (d) => { out += d; if (out.includes('ready')) resolve(); });
        holder.on('error', reject);
        holder.on('exit', (code) => reject(new Error(`lock holder exited early (${code})`)));
      });
      const r = cli('--db', db, '--backup', backup, '--sha256', hash, '--apply');
      assert.equal(r.status, 3, r.stderr);
      assert.match(r.stderr, /locked or in use/);
      assert.throws(() => applyRestore({ db, backup, sha256: hash }), (e) => e.code === 'locked' && e.exitCode === 3);
      assert.deepEqual(snapshot(dir), before, 'nothing was moved or copied');
    } finally {
      await new Promise((resolve) => { holder.once('close', resolve); holder.stdin.end('\n'); });
    }
  });

test('a stale rollback journal is moved aside too, and a missing database file is not an error', () => {
  const { dir, db, backup, hash } = scene();
  fs.writeFileSync(`${db}-journal`, 'v7 journal');
  const steps = planRestore({ db, backup, sha256: hash });
  assert.ok(steps.some((s) => /move .*harness\.db-journal/.test(s.describe)));
  const r = applyRestore({ db, backup, sha256: hash }, Date.UTC(2026, 9, 6, 13));
  assert.equal(r.movedAside.length, 4);
  assert.ok(!fs.existsSync(`${db}-journal`));
  // The database itself already gone: the backup is installed, the remaining side files moved.
  fs.renameSync(db, path.join(dir, 'gone.db')); fs.writeFileSync(`${db}-shm`, 'stray shm');
  const again = applyRestore({ db, backup, sha256: hash }, Date.UTC(2026, 9, 6, 14));
  assert.equal(again.movedAside.length, 1);
  assert.equal(fs.readFileSync(db, 'utf8'), 'v6 copy');
});
