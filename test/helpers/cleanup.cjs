'use strict';
// B2a test cleanup (Task 10 fix round 3): every database a test opens is tracked here, and one `after` hook per test
// file closes them all, then removes that file's temp dirs (`fs.rmSync(dir, { recursive: true, force: true })` through
// sqlite.cjs's registry, `cleanupAll`). Without it a test that fails before its own close() leaves its SQLite files open,
// and on Windows the exit-time removal in sqlite.cjs then fails on the open files and leaks the whole temp dir.
// Closing is idempotent: a store or handle the test already closed is closed again harmlessly.
const { after } = require('node:test');
const h = require('./sqlite.cjs');

const open = new Set();
let hooked = false;

/** Track anything with a close() (a PersistStore, a raw better-sqlite3 handle); returns it unchanged. */
function track(closeable) {
  if (closeable && typeof closeable.close === 'function') open.add(closeable);
  return closeable;
}

/** Close every tracked store and handle (best effort, each once). */
function closeAll() {
  for (const c of [...open]) {
    open.delete(c);
    try { c.close(); } catch { /* already closed, or closing anyway */ }
  }
}

/** Registers the file's one `after` hook: close what is open, then remove the temp dirs. Safe to call more than once. */
function cleanupAfterAll() {
  if (hooked) return;
  hooked = true;
  after(() => { closeAll(); h.cleanupAll(); });
}

/** h.openRaw, tracked. */
const openRaw = (file) => track(h.openRaw(file));

module.exports = { track, closeAll, cleanupAfterAll, openRaw };
