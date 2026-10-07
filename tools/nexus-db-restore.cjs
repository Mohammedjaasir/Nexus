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
 * itself); 5 the restore failed AND the rollback could not put every file back
 * (the message lists the exact renames to do by hand); 1 anything else. Without
 * --apply nothing is changed (--dry-run is the default).
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
 *      otherwise replay the newer pages onto the restored file;
 *   4. copies the backup to <name>.restoring-<stamp> (never over an existing file),
 *      re-hashes the copy, and only then renames it to harness.db.
 *
 * Rollback. If a move, the copy, the re-hash or the final rename fails, the files
 * already moved are put back, MAIN FILE FIRST. If the main file cannot be put back,
 * the rollback STOPS there: its -wal/-shm/-journal stay aside, because a stale WAL
 * beside a missing (or different) harness.db must never be replayed. The tool then
 * exits 5 and prints, for every file still aside, the exact `rename "<to>" "<from>"`
 * to do by hand, plus, when a verified copy of the backup exists, the alternative of
 * renaming that copy to harness.db. A .restoring-<stamp> copy that is left behind is
 * kept for inspection and is safe to delete by hand.
 * Nothing is ever deleted and the backup itself is left in place. On platforms
 * other than Windows an open file can be renamed, so quitting the app first is the
 * only protection there.
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const EXIT = Object.freeze({ ok: 0, error: 1, sha_mismatch: 2, locked: 3, bad_arguments: 4, rollback_failed: 5 });
/** The SQLite side files that belong to a database file, in the order they are moved. */
const SIDE_SUFFIXES = Object.freeze(['', '-wal', '-shm', '-journal']);
const HEX64 = /^[0-9a-f]{64}$/i;
const USAGE = 'usage: node tools/nexus-db-restore.cjs --db <harness.db> --backup <backup.db> --sha256 <hex> [--apply | --dry-run]';

class RestoreError extends Error {
  /** `extra.cause`: the code the failure had before a failed rollback turned it into rollback_failed. */
  constructor(code, message, extra = {}) {
    super(message);
    this.name = 'RestoreError';
    this.code = code;
    this.exitCode = EXIT[code] ?? EXIT.error;
    /** Files still moved aside after a failed rollback: { from, to } (rename `to` back to `from`). */
    this.stuck = extra.stuck ?? [];
    this.cause = extra.cause ?? null;
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
const LOCK_HINT = 'quit the app first (on Windows an antivirus or indexer holding the file can also cause this)';

/**
 * Puts already-moved files back, MAIN FILE FIRST. Never overwrites: a name that
 * exists again is not renamed onto. If the main file cannot go back, nothing else is
 * tried: its side files stay aside, so a stale WAL never sits beside a missing or
 * different harness.db. Returns the moves still aside, each with the reason.
 */
function rollback(moved, db) {
  const ordered = [...moved.filter((m) => m.from === db), ...moved.filter((m) => m.from !== db)];
  const stuck = [];
  for (const m of ordered) {
    if (stuck.some((x) => x.from === db)) { stuck.push({ ...m, reason: 'left aside because harness.db is not back' }); continue; }
    if (fs.existsSync(m.from)) { stuck.push({ ...m, reason: `${path.basename(m.from)} exists again` }); continue; }
    try { fs.renameSync(m.to, m.from); } catch (e) { stuck.push({ ...m, reason: e.code || e.message }); }
  }
  return stuck;
}

/**
 * Rolls back and throws. With a complete rollback: RestoreError(code, message). Otherwise
 * RestoreError('rollback_failed') (exit 5) whose message gives the exact manual steps.
 */
function failAndRollBack(code, message, moved, p, state) {
  const stuck = rollback(moved, p.db);
  const tempLeft = !state.installed && fs.existsSync(p.temp);
  if (stuck.length === 0) {
    const kept = tempLeft ? `; the copy ${p.temp} is kept for inspection and is safe to delete by hand` : '';
    const back = moved.length ? '; every moved file was put back' : '';
    throw new RestoreError(code, `${message}${back}${kept}`);
  }
  const mainStuck = stuck.some((m) => m.from === p.db);
  const lines = [message, `ROLLBACK INCOMPLETE: ${stuck.length} file(s) could not be put back.`];
  if (mainStuck) {
    lines.push(`${path.basename(p.db)} is NOT in place. Its side files were left aside on purpose: never put a -wal/-shm back beside a missing or different ${path.basename(p.db)}.`);
  } else {
    lines.push(`${path.basename(p.db)} is back in place, but some of its side files are still aside: put them back before launching the app.`);
  }
  lines.push('With the app closed, put the original files back by hand, in this order:');
  for (const m of stuck) lines.push(`  rename "${m.to}" "${m.from}"    (${m.reason})`);
  if (mainStuck && tempLeft && state.verified) {
    lines.push(`Or finish the restore instead: a verified copy of the backup is at ${p.temp}; rename it to ${path.basename(p.db)} ("${p.db}") and leave the side files aside.`);
  } else if (tempLeft) {
    lines.push(`The copy ${p.temp} is kept for inspection${state.verified ? '' : ' (it did NOT verify: do not use it)'} and is safe to delete by hand.`);
  }
  throw new RestoreError('rollback_failed', lines.join('\n'), { stuck: stuck.map(({ from, to }) => ({ from, to })), cause: code });
}

/** Restores the backup over the database. Returns the moved-aside files and the restored path. */
function applyRestore(opts, now = Date.now()) {
  const p = prepare(opts, now);
  const moved = [];
  const state = { verified: false, installed: false };
  for (const m of p.moves) {
    try {
      fs.renameSync(m.from, m.to);
      moved.push(m);
    } catch (e) {
      if (isLockError(e)) failAndRollBack('locked', `${path.basename(m.from)} is locked or in use (${e.code}): ${LOCK_HINT}`, moved, p, state);
      failAndRollBack('error', `could not move ${m.from} aside (${e.code || e.message})`, moved, p, state);
    }
  }
  try {
    fs.copyFileSync(p.backup, p.temp, fs.constants.COPYFILE_EXCL);
  } catch (e) {
    failAndRollBack('error', `could not copy the backup to ${p.temp} (${e.code || e.message})`, moved, p, state);
  }
  const copied = sha256File(p.temp);
  if (copied !== p.sha256) {
    failAndRollBack('sha_mismatch', `sha256 of the copy ${p.temp} is ${copied}, expected ${p.sha256}`, moved, p, state);
  }
  state.verified = true;
  if (fs.existsSync(p.db)) {
    failAndRollBack('locked', `${p.db} reappeared during the restore: is the app running? ${LOCK_HINT}`, moved, p, state);
  }
  try {
    fs.renameSync(p.temp, p.db);
    state.installed = true;
  } catch (e) {
    const why = isLockError(e) ? `: ${LOCK_HINT}` : '';
    failAndRollBack(isLockError(e) ? 'locked' : 'error', `could not rename the verified copy ${p.temp} to ${p.db} (${e.code || e.message})${why}`, moved, p, state);
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
