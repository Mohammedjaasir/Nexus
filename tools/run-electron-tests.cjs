'use strict';
// Runs real-SQLite test files under Electron-as-node (better-sqlite3 is built for Electron).
// A file fails if it exits non-zero, reports 0 tests, skips anything, or prints the plain-node skip banner.
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const electron = require('electron');                       // path to the binary when required from plain node
const TIMEOUT_MS = 180000;
const testDir = path.join(__dirname, '..', 'test');
const files = (process.argv.slice(2).length ? process.argv.slice(2)
  : fs.readdirSync(testDir).filter((f) => /^nexus-(db|platform)-.+\.test\.cjs$/.test(f)).sort().map((f) => path.join('test', f)));
(async () => {
  let failed = 0;
  for (const f of files) {
    const out = await new Promise((resolve) => {
      const c = spawn(electron, [f], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['ignore', 'pipe', 'inherit'] });
      let text = ''; let settled = false; let timedOut = false;
      const done = (code) => { if (settled) return; settled = true; clearTimeout(timer); resolve({ code, text, timedOut }); };
      const timer = setTimeout(() => {
        timedOut = true;
        console.error(`[test:db] ${f} timed out after ${TIMEOUT_MS / 1000}s, killing`);
        if (process.platform === 'win32' && c.pid) spawn('taskkill', ['/pid', String(c.pid), '/T', '/F'], { stdio: 'ignore' });
        else c.kill('SIGKILL');
        setTimeout(() => done(-1), 2000);
      }, TIMEOUT_MS);
      c.stdout.on('data', (d) => { text += d; process.stdout.write(d); });
      c.on('error', (err) => { console.error(`[test:db] could not run ${f}: ${err.message}`); done(-1); });
      c.on('close', (code) => done(code));
    });
    const tests = Number((out.text.match(/^# tests (\d+)/m) || [])[1] || 0);
    const skipped = Number((out.text.match(/^# skipped (\d+)/m) || [])[1] || 0);
    const todo = Number((out.text.match(/^# todo (\d+)/m) || [])[1] || 0);
    const bad = out.timedOut || out.code !== 0 || todo > 0 || tests === 0 || skipped > 0 || /needs Electron as node/.test(out.text);
    if (bad) { failed++; console.error(`[test:db] FAIL ${f} (exit=${out.code} tests=${tests} skipped=${skipped} todo=${todo}${out.timedOut ? ' timed out' : ''})`); }
  }
  console.log(`[test:db] ${files.length - failed}/${files.length} files passed`);
  process.exit(failed ? 1 : 0);
})();
