#!/usr/bin/env node
'use strict';
/**
 * Restore the harness database from a verified pre-migration backup.
 *
 *   node tools/nexus-db-restore.cjs --db <harness.db> --backup <backup.db> --sha256 <hex> [--apply | --dry-run]
 *
 * Exit codes: 0 restored (or, for a dry run, the plan printed); 2 the backup's
 * sha256 does not match; 3 the target is locked or in use (quit the app first);
 * 4 bad arguments (including a missing backup, or a backup that is the target
 * itself); 1 anything else. Without --apply nothing is changed (--dry-run is the default).
 *
 * Plain node, fs and crypto only: it runs without the app, Electron or SQLite.
 *
 * What --apply does, in order:
 *   1. checks the arguments and that the backup is a file, distinct from the target
 *      and its -wal/-shm/-journal side files;
 *   2. verifies the backup's sha256 BEFORE touching anything (mismatch: exit 2);
 *   3. MOVES (never deletes) the current harness.db, then -wal, -shm and -journal
 *      when present, to <name>.pre-restore-<UTC stamp>[-wal|-shm|-journal]. The main
 *      file goes first and doubles as the lock probe: on Windows an open SQLite file
 *      cannot be renamed (EBUSY/EPERM), so a running app stops the restore before
 *      anything moved (exit 3). Removing the stale -wal is essential: SQLite would
 *      otherwise replay the newer pages onto the restored file. A failed move puts
 *      the files already moved back where they were;
 *   4. copies the backup to <name>.restoring-<stamp> (never over an existing file),
 *      re-hashes the copy, and only then renames it to harness.db.
 * Nothing is ever deleted and the backup itself is left in place. On platforms
 * other than Windows an open file can be renamed, so quitting the app first is the
 * only protection there.
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const EXIT = Object.freeze({ ok: 0, error: 1, sha_mismatch: 2, locked: 3, bad_arguments: 4 });
/** The SQLite side files that belong to a database file, in the order they are moved. */
const SIDE_SUFFIXES = Object.freeze(['', '-wal', '-shm', '-journal']);
const HEX64 = /^[0-9a-f]{64}$/i;
const USAGE = 'usage: node tools/nexus-db-restore.cjs --db <harness.db> --backup <backup.db> --sha256 <hex> [--apply | --dry-run]';

class RestoreError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'RestoreError';
    this.code = code;
    this.exitCode = EXIT[code] ?? EXIT.error;
  }
}

/** UTC stamp such as 20261006T120000Z (the same shape as the backup file names). */
function stamp(ms) {
  return new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

/** sha256 of a file read in 1 MiB chunks (constant memory). */
function sha256File(file) {
  const hash = crypto.createHash('sha256');
  const buf = Buffer.allocUnsafe(1024 * 1024);
  const fd = fs.openSync(file, 'r');
  try {
    for (;;) {
      const n = fs.readSync(fd, buf, 0, buf.length, null);
      if (n === 0) break;
      hash.update(buf.subarray(0, n));
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

const statOrNull = (f) => { try { return fs.statSync(f, { bigint: true }); } catch { return null; } };
const comparable = (f) => {
  let p = path.resolve(f);
  try { p = fs.realpathSync.native(p); } catch { /* not there: compare the resolved path */ }
  return process.platform === 'win32' ? p.toLowerCase() : p;
};
/** Same path (after resolving), or the same file under another name (device + inode). */
function sameFile(a, b) {
  if (comparable(a) === comparable(b)) return true;
  const sa = statOrNull(a); const sb = statOrNull(b);
  return Boolean(sa && sb && sa.ino !== 0n && sa.dev === sb.dev && sa.ino === sb.ino);
}

/** Validates the options and resolves the paths; throws RestoreError('bad_arguments'). */
function checkOptions(opts) {
  if (!opts || typeof opts !== 'object') throw new RestoreError('bad_arguments', 'options are required');
  const { db, backup, sha256 } = opts;
  if (typeof db !== 'string' || db.length === 0) throw new RestoreError('bad_arguments', '--db is required');
  if (typeof backup !== 'string' || backup.length === 0) throw new RestoreError('bad_arguments', '--backup is required');
  if (typeof sha256 !== 'string' || !HEX64.test(sha256)) throw new RestoreError('bad_arguments', '--sha256 must be 64 hex characters');
  const dbPath = path.resolve(db);
  const backupPath = path.resolve(backup);
  for (const suffix of SIDE_SUFFIXES) {
    if (sameFile(backupPath, dbPath + suffix)) {
      throw new RestoreError('bad_arguments', `the backup and the target are the same file (${path.basename(dbPath + suffix)})`);
    }
  }
  const b = statOrNull(backupPath);
  if (!b) throw new RestoreError('bad_arguments', `backup not found: ${backupPath}`);
  if (!b.isFile()) throw new RestoreError('bad_arguments', `the backup is not a file: ${backupPath}`);
  const dir = statOrNull(path.dirname(dbPath));
  if (!dir || !dir.isDirectory()) throw new RestoreError('bad_arguments', `the target's folder does not exist: ${path.dirname(dbPath)}`);
  const d = statOrNull(dbPath);
  if (d && !d.isFile()) throw new RestoreError('bad_arguments', `the target is not a file: ${dbPath}`);
  return { db: dbPath, backup: backupPath, sha256: sha256.toLowerCase() };
}

/**
 * Everything --apply would do, worked out without changing anything: the backup is
 * hashed (a mismatch throws RestoreError('sha_mismatch')) and each move target is a
 * name that does not exist yet (the stamp gains -2, -3, ... when needed).
 */
function prepare(opts, now) {
  const o = checkOptions(opts);
  const actual = sha256File(o.backup);
  if (actual !== o.sha256) {
    throw new RestoreError('sha_mismatch', `sha256 mismatch: the backup hashes to ${actual}, expected ${o.sha256}; nothing was changed`);
  }
  const present = SIDE_SUFFIXES.filter((s) => fs.existsSync(o.db + s));
  const base = stamp(now);
  for (let n = 1; ; n++) {
    const tag = n === 1 ? base : `${base}-${n}`;
    const moves = present.map((s) => ({ from: o.db + s, to: `${o.db}.pre-restore-${tag}${s}` }));
    const temp = `${o.db}.restoring-${tag}`;
    if (!moves.some((m) => fs.existsSync(m.to)) && !fs.existsSync(temp)) return { ...o, moves, temp };
  }
}

/** The steps --apply would take, in order: { op, describe, from?, to? }. Changes nothing. */
function planRestore(opts, now = Date.now()) {
  const p = prepare(opts, now);
  return [
    { op: 'verify', from: p.backup, describe: `verify sha256 of ${p.backup} is ${p.sha256} (ok)` },
    ...p.moves.map((m) => ({ op: 'move', from: m.from, to: m.to, describe: `move ${m.from} -> ${m.to}` })),
    { op: 'copy', from: p.backup, to: p.temp, describe: `copy ${p.backup} -> ${p.temp}` },
    { op: 'verify', from: p.temp, describe: `verify sha256 of ${p.temp} is ${p.sha256}` },
    { op: 'install', from: p.temp, to: p.db, describe: `rename ${p.temp} -> ${p.db}` }
  ];
}

const isLockError = (e) => e && (e.code === 'EBUSY' || e.code === 'EPERM');

/** Puts already-moved files back; returns the ones that could not be put back. */
function moveBack(moved) {
  const stuck = [];
  for (const m of [...moved].reverse()) {
    try { fs.renameSync(m.to, m.from); } catch { stuck.push(m.to); }
  }
  return stuck;
}
const stuckNote = (stuck) => (stuck.length ? `; could not move back: ${stuck.join(', ')}` : '');

/** Restores the backup over the database. Returns the moved-aside files and the restored path. */
function applyRestore(opts, now = Date.now()) {
  const p = prepare(opts, now);
  const moved = [];
  for (const m of p.moves) {
    try {
      fs.renameSync(m.from, m.to);
      moved.push(m);
    } catch (e) {
      const stuck = moveBack(moved);
      if (isLockError(e)) {
        throw new RestoreError('locked', `${path.basename(m.from)} is locked or in use (${e.code}): quit the app first${stuckNote(stuck)}`);
      }
      throw new RestoreError('error', `could not move ${m.from} aside (${e.code || e.message})${stuckNote(stuck)}`);
    }
  }
  try {
    fs.copyFileSync(p.backup, p.temp, fs.constants.COPYFILE_EXCL);
    const copied = sha256File(p.temp);
    if (copied !== p.sha256) {
      throw new RestoreError('sha_mismatch', `sha256 of the copy ${p.temp} is ${copied}, expected ${p.sha256} (copy kept for inspection)`);
    }
    if (fs.existsSync(p.db)) throw new RestoreError('locked', `${p.db} reappeared during the restore: is the app running? (copy kept at ${p.temp})`);
    fs.renameSync(p.temp, p.db);
  } catch (e) {
    const stuck = fs.existsSync(p.db) ? moved.map((m) => m.to) : moveBack(moved);
    const note = stuckNote(stuck);
    if (e instanceof RestoreError) { e.message += note; throw e; }
    throw new RestoreError(isLockError(e) ? 'locked' : 'error', `could not install the backup (${e.code || e.message})${note}`);
  }
  return { movedAside: moved.map((m) => m.to), restored: p.db };
}

/** --flag value and --flag=value; every flag at most once. */
function parseArgs(argv) {
  const out = { mode: null };
  const take = (name, value) => {
    if (out[name] !== undefined) throw new RestoreError('bad_arguments', `--${name} given twice`);
    if (value === undefined || value === '' || value.startsWith('--')) throw new RestoreError('bad_arguments', `--${name} needs a value`);
    out[name] = value;
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const eq = arg.indexOf('=');
    const flag = eq > 0 ? arg.slice(0, eq) : arg;
    if (flag === '--apply' || flag === '--dry-run') {
      if (eq > 0) throw new RestoreError('bad_arguments', `${flag} takes no value`);
      if (out.mode !== null) throw new RestoreError('bad_arguments', 'give at most one of --apply and --dry-run');
      out.mode = flag === '--apply' ? 'apply' : 'dry-run';
    } else if (flag === '--db' || flag === '--backup' || flag === '--sha256') {
      take(flag.slice(2), eq > 0 ? arg.slice(eq + 1) : argv[++i]);
    } else {
      throw new RestoreError('bad_arguments', `unknown argument ${arg}`);
    }
  }
  for (const name of ['db', 'backup', 'sha256']) if (out[name] === undefined) throw new RestoreError('bad_arguments', `--${name} is required`);
  if (!HEX64.test(out.sha256)) throw new RestoreError('bad_arguments', '--sha256 must be 64 hex characters');
  return { db: out.db, backup: out.backup, sha256: out.sha256, mode: out.mode ?? 'dry-run' };
}

function main(argv) {
  try {
    const a = parseArgs(argv);
    const opts = { db: a.db, backup: a.backup, sha256: a.sha256 };
    if (a.mode === 'dry-run') {
      const steps = planRestore(opts);
      console.log('nexus-db-restore: dry run, nothing was changed. With --apply it would:');
      steps.forEach((s, i) => console.log(`  ${i + 1}. ${s.describe}`));
      console.log('Quit the app first, then run again with --apply.');
      return EXIT.ok;
    }
    const r = applyRestore(opts);
    console.log(`nexus-db-restore: restored ${r.restored} from ${path.resolve(a.backup)} (sha256 ${a.sha256.toLowerCase()} verified)`);
    console.log('Moved aside (kept, never deleted):');
    for (const f of r.movedAside) console.log(`  ${f}`);
    console.log('Next: launch with NEXUS_DB_HOLD_V7=1 to stay on schema v6, or launch normally to migrate again (a new backup is taken first).');
    return EXIT.ok;
  } catch (e) {
    if (e instanceof RestoreError) {
      console.error(`nexus-db-restore: ${e.message}`);
      if (e.code === 'bad_arguments') console.error(USAGE);
      return e.exitCode;
    }
    console.error(`nexus-db-restore: unexpected error: ${e && e.message ? e.message : String(e)}`);
    return EXIT.error;
  }
}

module.exports = { planRestore, applyRestore, RestoreError, EXIT };

if (require.main === module) process.exitCode = main(process.argv.slice(2));
