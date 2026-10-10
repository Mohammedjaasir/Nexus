'use strict';
// The gate of the real-Docker files (test/nexus-exec-*.test.cjs, B2a Task 12; fix round 1, item 2).
//
// - Under plain node (`node --test test/`) a file prints its skip banner and loads nothing heavy: better-sqlite3 is built
//   for Electron, so these files cannot run there at all (the convention of the real-SQLite files). This is not a
//   resource decision and no environment variable is involved in it.
// - Under Electron-as-node, EVERY time a file calls `realDockerOrSkip()`, the resource preflight of
//   tools/run-exec-tests.cjs runs again, in this process, with the real probes (disk at the Docker volume and the temp
//   data home, Docker reachable and Linux, Docker memory and CPUs, the pinned images, the environment). When it is not
//   ok the file FAILS (one failing test whose message holds every NOT RUN line, also printed to stdout); it never skips.
//   No environment variable can skip or pass any check: NEXUS_TEST_EXEC (set by the test:exec runner) is not read here.
// The test:exec runner also fails a file that prints either banner, so these files are never skipped silently there.
const test = require('node:test');
const assert = require('node:assert/strict');

const ELECTRON = Boolean(process.versions.electron) && process.env.ELECTRON_RUN_AS_NODE === '1';
const BANNER = 'needs Electron as node (better-sqlite3 is built for Electron)';

/**
 * The gate itself, injectable for its own test (test/nexus-core-exec-preflight-runner.test.cjs P8): `electron` (the
 * runtime check), `probes` (the preflight's probes; the real ones by default), `log` (where the NOT RUN lines go).
 * Returns true only when the heavy tests may run.
 */
function gate(o = {}) {
  const electron = o.electron ?? ELECTRON;
  if (!electron) {
    test('real Docker suite: run with npm run test:exec', { skip: BANNER }, () => {});
    return false;
  }
  const { runPreflight, REAL_PROBES } = require('../../tools/run-exec-tests.cjs');
  const log = o.log ?? ((l) => console.log(l));
  let pre;
  try { pre = runPreflight(o.probes ?? REAL_PROBES); } catch (e) {
    pre = { ok: false, checks: [{ id: 'preflight', ok: false, notRun: `the resource preflight could not run (${e && e.message}).`, action: 'Fix the preflight, then run again.' }], warnings: [] };
  }
  for (const w of pre.warnings ?? []) log(`[test:exec] warning: ${w}`);
  if (pre.ok) return true;
  const lines = pre.checks.filter((c) => !c.ok).map((c) => `[test:exec] NOT RUN: ${c.notRun} ${c.action}`);
  for (const l of lines) log(l);
  test('real Docker suite: the resource preflight', () => {
    assert.fail(`the resource preflight did not pass; nothing heavy ran:\n${lines.join('\n')}`);
  });
  return false;
}

/** What every real-Docker file calls, with no argument (a static check in P8 holds them to it). */
function realDockerOrSkip() { return gate(); }

module.exports = { realDockerOrSkip, gate, ELECTRON, BANNER };
