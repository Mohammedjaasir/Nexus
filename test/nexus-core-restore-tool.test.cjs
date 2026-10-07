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

// ---- install-phase failures and the rollback (fix round 1) ----

const errno = (code) => Object.assign(new Error(`${code}: simulated`), { code });
/** Patches functions on the shared node:fs object (the tool's fs) for the duration of fn. */
function withFs(patches, fn) {
  const orig = {};
  for (const [k, make] of Object.entries(patches)) { orig[k] = fs[k]; fs[k] = make(orig[k]); }
  try { return fn(); } finally { Object.assign(fs, orig); }
}
const withoutTemp = (snap) => Object.fromEntries(Object.entries(snap).filter(([k]) => !k.includes('.restoring-')));
const failures = {
  copy: { code: 'error', exit: 1, temp: false,
    patch: (db) => ({ copyFileSync: () => () => { throw errno('ENOSPC'); } }) },
  rehash: { code: 'sha_mismatch', exit: 2, temp: 'unverified',
    patch: (db) => ({ copyFileSync: (real) => (src, dest, mode) => { real(src, dest, mode); fs.writeFileSync(dest, 'corrupted copy'); } }) },
  rename: { code: 'locked', exit: 3, temp: 'verified',
    patch: (db) => ({ renameSync: (real) => (src, dest) => { if (dest === db && src.includes('.restoring-')) throw errno('EPERM'); return real(src, dest); } }) }
};
/** Also make the rollback of `which` (the main file, or its -wal) fail. */
const failRollbackOf = (db, which, inner) => (real) => {
  const base = inner ? inner(real) : real;
  return (src, dest) => {
    if (dest === which && src.includes('.pre-restore-')) throw errno('EPERM');
    return base(src, dest);
  };
};

for (const [name, f] of Object.entries(failures)) {
  test(`install failure (${name}): every file is put back byte for byte, exit ${f.exit}`, () => {
    const { dir, db, backup, hash } = scene();
    const before = snapshot(dir);
    let err;
    withFs(f.patch(db), () => { try { applyRestore({ db, backup, sha256: hash }, Date.UTC(2026, 9, 7, 9)); } catch (e) { err = e; } });
    assert.ok(err, 'the restore must fail');
    assert.equal(err.code, f.code); assert.equal(err.exitCode, f.exit);
    assert.match(err.message, /every moved file was put back/);
    assert.deepEqual(withoutTemp(snapshot(dir)), before, 'harness.db, -wal and -shm are back exactly');
    const temps = fs.readdirSync(dir).filter((x) => x.includes('.restoring-'));
    if (f.temp) {
      assert.equal(temps.length, 1, 'the .restoring- copy is kept for inspection');
      assert.match(err.message, /kept for inspection and is safe to delete by hand/);
    } else {
      assert.equal(temps.length, 0);
    }
    if (name === 'rename') { assert.match(err.message, /quit the app first/); assert.match(err.message, /antivirus/); }
  });

  for (const platform of ['win32', 'linux']) test(`install failure (${name}) AND the main file cannot be put back (${platform}): exit 5, side files stay aside, exact manual steps`, () => {
    const { dir, db, backup, hash } = scene();
    const cmd = platform === 'win32' ? 'move' : 'mv';
    let err;
    const patches = f.patch(db);
    patches.renameSync = failRollbackOf(db, db, patches.renameSync);
    withFs(patches, () => { try { applyRestore({ db, backup, sha256: hash, platform }, Date.UTC(2026, 9, 7, 9)); } catch (e) { err = e; } });
    assert.ok(err, 'the restore must fail');
    assert.equal(err.code, 'rollback_failed'); assert.equal(err.exitCode, 5); assert.equal(err.cause, f.code);
    assert.ok(!fs.existsSync(db), 'harness.db is not in place');
    assert.ok(!fs.existsSync(`${db}-wal`) && !fs.existsSync(`${db}-shm`), 'no stale WAL/SHM beside a missing harness.db');
    assert.deepEqual(err.stuck.map((m) => path.basename(m.from)).sort(), ['harness.db', 'harness.db-shm', 'harness.db-wal']);
    assert.equal(err.stuck[0].from, db, 'the main file is listed first');
    for (const m of err.stuck) {
      assert.match(fs.readFileSync(m.to, 'utf8'), /^v7 /, 'the moved file is intact');
      assert.ok(err.message.includes(`  ${cmd} "${m.to}" "${m.from}"`), `manual step for ${path.basename(m.from)}`);
    }
    assert.match(err.message, /ROLLBACK INCOMPLETE/); assert.match(err.message, /harness\.db is NOT in place/);
    assert.doesNotMatch(err.message, /\brename "/, 'no cmd-incompatible rename form');
    assert.doesNotMatch(err.message, platform === 'win32' ? /^\s*mv "/m : /^\s*move "/m);
    const temp = fs.readdirSync(dir).find((x) => x.includes('.restoring-'));
    if (f.temp === 'verified') {
      assert.ok(err.message.includes(`a verified copy of the backup is at ${path.join(dir, temp)}; move it to harness.db`));
      assert.ok(err.message.includes(`${cmd} "${path.join(dir, temp)}" "${db}"`));
    } else if (f.temp === 'unverified') {
      assert.match(err.message, /did NOT verify/); assert.doesNotMatch(err.message, /a verified copy/);
    } else {
      assert.equal(temp, undefined);
    }
  });
}

test('the main file goes back but its -wal cannot: exit 5, harness.db in place, the -wal step is given', () => {
  const { dir, db, backup, hash } = scene();
  let err;
  const patches = failures.rename.patch(db);
  patches.renameSync = failRollbackOf(db, `${db}-wal`, patches.renameSync);
  withFs(patches, () => { try { applyRestore({ db, backup, sha256: hash, platform: 'win32' }, Date.UTC(2026, 9, 7, 9)); } catch (e) { err = e; } });
  assert.equal(err.code, 'rollback_failed'); assert.equal(err.exitCode, 5); assert.equal(err.cause, 'locked');
  assert.equal(fs.readFileSync(db, 'utf8'), 'v7 main'); assert.equal(fs.readFileSync(`${db}-shm`, 'utf8'), 'v7 shm');
  assert.deepEqual(err.stuck.map((m) => m.from), [`${db}-wal`]);
  assert.match(err.message, /harness\.db is back in place/);
  assert.ok(err.message.includes(`move "${err.stuck[0].to}" "${db}-wal"`));
  assert.ok(fs.readdirSync(dir).some((x) => x.includes('.restoring-')));
});

test('the CLI exits 5 with the manual steps when the install and the rollback both fail', () => {
  const { dir, db, backup, hash } = scene();
  const preload = path.join(dir, 'fail-renames.cjs');
  fs.writeFileSync(preload, `'use strict';
const fs = require('node:fs'); const real = fs.renameSync; const db = process.env.NX_TEST_DB;
fs.renameSync = (src, dest) => {
  if (dest === db && (src.includes('.restoring-') || src.includes('.pre-restore-'))) throw Object.assign(new Error('EPERM: simulated'), { code: 'EPERM' });
  return real(src, dest);
};`);
  const r = spawnSync(process.execPath, ['--require', preload, TOOL, '--db', db, '--backup', backup, '--sha256', hash, '--apply'],
    { encoding: 'utf8', env: { ...process.env, NX_TEST_DB: db } });
  assert.equal(r.status, 5, r.stderr);
  assert.match(r.stderr, /ROLLBACK INCOMPLETE/);
  const cmd = process.platform === 'win32' ? 'move' : 'mv';
  assert.match(r.stderr, new RegExp(`^  ${cmd} ".*harness\\.db\\.pre-restore-[^"]*" ".*harness\\.db"`, 'm'));
  assert.match(r.stderr, new RegExp(`a verified copy of the backup is at .*\\.restoring-.*; move it to harness\\.db .*: ${cmd} "`));
  assert.ok(!fs.existsSync(db) && !fs.existsSync(`${db}-wal`));
});

// ---- fix round 2: re-hash read failures, a new harness.db appearing ----

/** Makes every open of the .restoring- copy fail (the re-hash read). */
const failRehashRead = () => ({ openSync: (real) => (file, ...rest) => {
  if (String(file).includes('.restoring-')) throw errno('EIO');
  return real(file, ...rest);
} });

test('the re-hash read fails (EIO): every file is put back, exit 1, the copy is kept', () => {
  const { dir, db, backup, hash } = scene();
  const before = snapshot(dir);
  let err;
  withFs(failRehashRead(), () => { try { applyRestore({ db, backup, sha256: hash }, Date.UTC(2026, 9, 7, 10)); } catch (e) { err = e; } });
  assert.ok(err, 'the restore must fail');
  assert.equal(err.code, 'error'); assert.equal(err.exitCode, 1);
  assert.match(err.message, /could not re-hash the copy .*\(EIO\)/); assert.match(err.message, /every moved file was put back/);
  assert.deepEqual(withoutTemp(snapshot(dir)), before);
  assert.equal(fs.readdirSync(dir).filter((x) => x.includes('.restoring-')).length, 1);
});

test('the re-hash read fails AND the main file cannot be put back: exit 5 with the steps, the unverified copy is not offered', () => {
  const { db, backup, hash } = scene();
  let err;
  const patches = failRehashRead();
  patches.renameSync = failRollbackOf(db, db);
  withFs(patches, () => { try { applyRestore({ db, backup, sha256: hash, platform: 'win32' }, Date.UTC(2026, 9, 7, 10)); } catch (e) { err = e; } });
  assert.equal(err.code, 'rollback_failed'); assert.equal(err.exitCode, 5); assert.equal(err.cause, 'error');
  assert.ok(!fs.existsSync(db) && !fs.existsSync(`${db}-wal`) && !fs.existsSync(`${db}-shm`));
  for (const m of err.stuck) assert.ok(err.message.includes(`  move "${m.to}" "${m.from}"`));
  assert.match(err.message, /did NOT verify/); assert.doesNotMatch(err.message, /a verified copy/);
});

test('an unexpected throw after the moves (not an errno) still rolls back', () => {
  const { dir, db, backup, hash } = scene();
  const before = snapshot(dir);
  let err;
  withFs({ copyFileSync: () => () => { throw 'not an Error object'; } }, () => {
    try { applyRestore({ db, backup, sha256: hash }, Date.UTC(2026, 9, 7, 10)); } catch (e) { err = e; }
  });
  assert.equal(err.code, 'error'); assert.equal(err.exitCode, 1);
  assert.deepEqual(snapshot(dir), before);
});

for (const platform of ['win32', 'linux']) test(`a NEW harness.db appears during the restore (${platform}): exit 5, it is untouched, the message says to quit and move it aside first`, () => {
  const { dir, db, backup, hash } = scene();
  const cmd = platform === 'win32' ? 'move' : 'mv';
  let err;
  // The app starts mid-restore and creates a fresh harness.db before the install.
  withFs({ copyFileSync: (real) => (src, dest, mode) => { real(src, dest, mode); fs.writeFileSync(db, 'new file from a running app'); } }, () => {
    try { applyRestore({ db, backup, sha256: hash, platform }, Date.UTC(2026, 9, 7, 11)); } catch (e) { err = e; }
  });
  assert.equal(err.code, 'rollback_failed'); assert.equal(err.exitCode, 5); assert.equal(err.cause, 'locked');
  assert.equal(fs.readFileSync(db, 'utf8'), 'new file from a running app', 'the new file is never overwritten');
  assert.ok(!fs.existsSync(`${db}-wal`), 'no stale WAL is put beside it');
  assert.match(err.message, /A NEW harness\.db appeared at .* during the restore, most likely because the app is running/);
  assert.match(err.message, /Quit the app, then move that new file aside first/);
  assert.ok(err.message.includes(`${cmd} "${db}" "${db}.unexpected-`));
  const mainStep = err.message.indexOf(`  ${cmd} "${err.stuck[0].to}" "${db}"`);
  assert.ok(mainStep > err.message.indexOf('A NEW harness.db'), 'the new-file instruction comes before the listed steps');
  for (const m of err.stuck) assert.match(fs.readFileSync(m.to, 'utf8'), /^v7 /);
  assert.ok(fs.readdirSync(dir).some((x) => x.includes('.restoring-')));
});

// ---- B1 Task 14: the hold switch that matches the backup's own schema ----

const { readUserVersion, holdHint } = require('../tools/nexus-db-restore.cjs');
/** A file that starts with a real 100-byte SQLite header (magic + user_version at 60, big-endian), plus a page tail. */
function sqliteLike(userVersion, tail = 'page data') {
  const header = Buffer.alloc(100);
  header.write('SQLite format 3\0', 0, 'latin1');
  header.writeUInt16BE(4096, 16);
  header.writeInt32BE(userVersion, 60);
  return Buffer.concat([header, Buffer.from(tail)]);
}
/** A restore scene whose backup carries a SQLite header at `userVersion`. */
function versionScene(userVersion) {
  const s = scene();
  const backup = path.join(s.dir, 'backups', `harness-v${userVersion}-20261007T120000Z.db`);
  const bytes = sqliteLike(userVersion);
  fs.writeFileSync(backup, bytes);
  return { ...s, backup, bytes, hash: sha(bytes) };
}

test('the backup\'s user_version is read from its SQLite header (bytes 60-63, big-endian)', () => {
  const { dir } = scene();
  const at = (name, bytes) => { const f = path.join(dir, name); fs.writeFileSync(f, bytes); return f; };
  assert.equal(readUserVersion(at('v6.db', sqliteLike(6))), 6);
  assert.equal(readUserVersion(at('v7.db', sqliteLike(7))), 7);
  assert.equal(readUserVersion(at('big.db', sqliteLike(0x01020304))), 0x01020304, 'big-endian, all four bytes');
  // Little-endian bytes at 60 would read as a different number: 7 is 00 00 00 07.
  assert.deepEqual([...sqliteLike(7).subarray(60, 64)], [0, 0, 0, 7]);
  assert.equal(readUserVersion(at('text.db', 'v6 copy')), null, 'no SQLite magic');
  assert.equal(readUserVersion(at('short.db', sqliteLike(7).subarray(0, 64))), null, 'shorter than the 100-byte header');
  const wrongMagic = sqliteLike(7); wrongMagic[0] = 0x73;
  assert.equal(readUserVersion(at('magic.db', wrongMagic)), null);
  assert.equal(readUserVersion(path.join(dir, 'missing.db')), null, 'an unreadable file never throws');
});

test('the hint names the matching hold switch: v7 -> NEXUS_DB_HOLD_V8, v6 -> NEXUS_DB_HOLD_V7', () => {
  assert.match(holdHint(7), /NEXUS_DB_HOLD_V8=1 to stay on schema v7/);
  assert.doesNotMatch(holdHint(7), /HOLD_V7/);
  assert.match(holdHint(6), /NEXUS_DB_HOLD_V7=1 to stay on schema v6/);
  assert.doesNotMatch(holdHint(6), /HOLD_V8/);
  for (const v of [0, 5, 8, 9]) {
    assert.doesNotMatch(holdHint(v), /NEXUS_DB_HOLD_V\d=1 to stay/, `no switch claimed for v${v}`);
    assert.match(holdHint(v), new RegExp(`schema v${v}[,;. ]`));
  }
  assert.match(holdHint(null), /could not be read/);
});

for (const [v, want, other] of [[7, 'NEXUS_DB_HOLD_V8', 'NEXUS_DB_HOLD_V7'], [6, 'NEXUS_DB_HOLD_V7', 'NEXUS_DB_HOLD_V8']]) {
  test(`the CLI restores a v${v} backup and prints ${want}=1 (dry run and apply)`, () => {
    const { dir, db, backup, bytes, hash } = versionScene(v);
    const before = snapshot(dir);
    const dry = cli('--db', db, '--backup', backup, '--sha256', hash);
    assert.equal(dry.status, 0, dry.stderr);
    assert.ok(dry.stdout.includes(`${want}=1 to stay on schema v${v}`), dry.stdout);
    assert.ok(!dry.stdout.includes(other), 'the other switch is not named');
    assert.deepEqual(snapshot(dir), before, 'the dry run changes nothing');
    const ok = cli('--db', db, '--backup', backup, '--sha256', hash, '--apply');
    assert.equal(ok.status, 0, ok.stderr);
    assert.ok(ok.stdout.includes(`Next: launch with ${want}=1 to stay on schema v${v}`), ok.stdout);
    assert.ok(!ok.stdout.includes(other));
    assert.deepEqual(fs.readFileSync(db), bytes, 'the backup bytes are installed');
    const r = applyRestore({ db, backup, sha256: hash }, Date.UTC(2026, 9, 7, 15));
    assert.equal(r.userVersion, v);
  });
}

test('a backup without a SQLite header still restores; the hint names both switches and claims no version', () => {
  const { db, backup, hash } = scene();
  const ok = cli('--db', db, '--backup', backup, '--sha256', hash, '--apply');
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(fs.readFileSync(db, 'utf8'), 'v6 copy');
  assert.match(ok.stdout, /could not be read from its header/);
  assert.match(ok.stdout, /NEXUS_DB_HOLD_V7=1 for a v6 backup or NEXUS_DB_HOLD_V8=1 for a v7 backup/);
});
