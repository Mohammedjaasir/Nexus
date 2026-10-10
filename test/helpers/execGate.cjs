'use strict';
// The gate of the real-Docker files (test/nexus-exec-*.test.cjs, B2a Task 12). They run only under
// `node tools/run-exec-tests.cjs` (npm run test:exec): Electron-as-node (better-sqlite3 is built for Electron) AND the
// runner's resource preflight passed (it sets NEXUS_TEST_EXEC=1). Anywhere else they print a skip banner (the
// convention of the real-SQLite files) and load nothing heavy: plain `node --test test/` skips them, and the test:exec
// runner fails a file that prints either banner, so they are never skipped silently there.
const test = require('node:test');

const ELECTRON = Boolean(process.versions.electron) && process.env.ELECTRON_RUN_AS_NODE === '1';

function realDockerOrSkip() {
  if (!ELECTRON) {
    test('real Docker suite: run with npm run test:exec', { skip: 'needs Electron as node (better-sqlite3 is built for Electron)' }, () => {});
    return false;
  }
  if (process.env.NEXUS_TEST_EXEC !== '1') {
    test('real Docker suite: run with npm run test:exec', { skip: 'needs the test:exec gate (node tools/run-exec-tests.cjs runs the resource preflight first)' }, () => {});
    return false;
  }
  return true;
}

module.exports = { realDockerOrSkip, ELECTRON };
