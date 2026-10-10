#!/usr/bin/env node
'use strict';
/**
 * `npm run test:exec` / `node tools/run-exec-tests.cjs` (B2a Task 12): the real-Docker execution suite, behind the
 * resource preflight (user constraint 1: the heavy tests never run, and never pass silently, when the machine cannot
 * take them).
 *
 * Preflight, every check required (all are evaluated and every failing one is printed, with exact numbers and the
 * action to take):
 *   disk     free space >= 30 GiB at the Docker data volume (C:\ on Windows, where Docker Desktop keeps its disk image)
 *            and at the temp data home (os.tmpdir()); below 40 GiB is a warning
 *   docker   `docker version` answers with a Linux server
 *   memory   Docker has >= 4 GiB and >= 2 CPUs
 *   images   sde-node, sde-python and nexus-fwd present, each labelled with the context hash infra/images/lock.json pins
 *   env      no NEXUS_DB_HOLD_* variable; the temp data home is not inside the app's real userData
 * The report is written to <os.tmpdir()>/nexus-test-exec-preflight.json every time.
 *
 * Then every test/nexus-exec-*.test.cjs runs under Electron-as-node (better-sqlite3 is built for Electron) with the
 * test:db rules: a file fails when it exits non-zero, reports 0 tests, skips or leaves a todo, or prints the plain-node
 * skip banner. Output: `[test:exec] PASS n/n`, `[test:exec] FAIL <file> (...)`, or `[test:exec] NOT RUN: <reason>`.
 * Exit 0 (pass), 1 (a failure), 3 (not run: a preflight check failed).
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const GIB = 2 ** 30;
const GB = 10 ** 9;
const REQUIRED_FREE = 30 * GIB;
const RECOMMENDED_FREE = 40 * GIB;
const MIN_MEMORY = 4 * GIB;
const MIN_CPUS = 2;
const PROFILES = ['sde-node', 'sde-python', 'nexus-fwd'];
const FILE_TIMEOUT_MS = 30 * 60_000;
const EXIT = Object.freeze({ PASS: 0, FAIL: 1, NOT_RUN: 3 });
const REPORT_NAME = 'nexus-test-exec-preflight.json';

const one = (x) => (Math.round(x * 10) / 10).toFixed(1);
const gib = (b) => `${one(b / GIB)} GiB`;
const gb = (b) => `${one(b / GB)} GB`;
const exact = (b) => `${Math.round(b).toLocaleString('en-US')} bytes`;

// ---------------------------------------------------------------- real probes (each injectable for the P tests)

function statfsFree(dir) {
  try { const s = fs.statfsSync(dir); const n = Number(s.bavail) * Number(s.bsize); return Number.isFinite(n) ? n : null; } catch { return null; }
}
/** Where Docker keeps its data: Docker Desktop's disk image lives under %LOCALAPPDATA% (C:\ by default). */
function dockerDataDir() {
  if (process.platform === 'win32') return path.parse(process.env.LOCALAPPDATA || os.homedir()).root || 'C:\\';
  if (process.platform === 'darwin') return os.homedir();
  return fs.existsSync('/var/lib/docker') ? '/var/lib/docker' : '/';
}
function docker(args, timeoutMs = 20_000) {
  const r = spawnSync('docker', args, { encoding: 'utf8', timeout: timeoutMs, windowsHide: true });
  return { code: r.status, stdout: r.stdout || '', stderr: r.stderr || '', error: r.error ? r.error.code || 'error' : null };
}
function readLock() {
  try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'infra', 'images', 'lock.json'), 'utf8')); } catch { return null; }
}

const REAL_PROBES = {
  dockerDataDir,
  tempDir: () => os.tmpdir(),
  freeBytes: statfsFree,
  dockerVersion() {
    const r = docker(['version', '--format', '{{json .}}']);
    if (r.error === 'ENOENT') return { reachable: false, why: 'not installed' };
    let v = null; try { v = JSON.parse(r.stdout); } catch { v = null; }
    if (r.code !== 0 || !v || !v.Server) return { reachable: false, why: 'not running' };
    return { reachable: true, os: String(v.Server.Os || ''), version: String(v.Server.Version || '') };
  },
  dockerInfo() {
    const r = docker(['info', '--format', '{{json .}}']);
    let i = null; try { i = JSON.parse(r.stdout); } catch { i = null; }
    return i ? { memoryBytes: Number(i.MemTotal) || 0, cpus: Number(i.NCPU) || 0 } : null;
  },
  imageLabels(profile) {
    const ls = docker(['image', 'ls', '--no-trunc', '--filter', `label=nexus.profile=${profile}`, '--format', '{{.ID}}']);
    const id = ls.code === 0 ? ls.stdout.split(/\r?\n/).map((x) => x.trim()).find((x) => /^sha256:[0-9a-f]{64}$/.test(x)) : null;
    if (!id) return null;
    const ins = docker(['image', 'inspect', id, '--format', '{{json .Config.Labels}}']);
    let labels = null; try { labels = JSON.parse(ins.stdout); } catch { labels = null; }
    return { id, labels: labels || {} };
  },
  lock: readLock,
  env: () => process.env,
  userDataDirs() {
    const appData = process.env.APPDATA || (process.platform === 'darwin' ? path.join(os.homedir(), 'Library', 'Application Support')
      : path.join(os.homedir(), '.config'));
    return [path.join(appData, 'munder-difflin'), path.join(appData, 'Munder Difflin')];
  }
};

// ---------------------------------------------------------------- the preflight (pure over its probes)

const inside = (child, parent) => {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
};

/**
 * Runs every check. Returns `{ ok, checks: [{ id, ok, notRun?, message?, action?, facts }], warnings }`; `notRun` is the
 * printed line for a failing check. Checks that need Docker are reported as failing with "needs Docker" when Docker is
 * not reachable (never skipped silently).
 */
function runPreflight(probes = REAL_PROBES) {
  const checks = []; const warnings = [];
  // disk: the Docker volume and the temp data home (one check per distinct volume).
  const dirs = [['the Docker data volume', probes.dockerDataDir()], ['the temp data home', probes.tempDir()]];
  const seenRoots = new Set();
  for (const [what, dir] of dirs) {
    const root = path.parse(path.resolve(dir)).root.toLowerCase();
    if (seenRoots.has(root) && process.platform === 'win32') continue;
    seenRoots.add(root);
    const free = probes.freeBytes(dir);
    const facts = { dir, freeBytes: free, requiredBytes: REQUIRED_FREE, recommendedBytes: RECOMMENDED_FREE };
    if (free === null) {
      checks.push({ id: 'disk', ok: false, facts, notRun: `free disk at ${dir} (${what}) could not be measured; the execution tests need 30 GiB (40 GiB recommended).`,
        action: 'Check that the folder exists and is readable, then run again.' });
    } else if (free < REQUIRED_FREE) {
      checks.push({ id: 'disk', ok: false, facts,
        notRun: `free disk ${gib(free)} < 30 GiB at ${dir} (${what}: ${exact(free)} free = ${gb(free)}; the execution tests need 30 GiB = ${gb(REQUIRED_FREE)}, 40 GiB = ${gb(RECOMMENDED_FREE)} recommended).`,
        action: 'Free space (for example `docker builder prune`, remove unused images), then run again.' });
    } else {
      checks.push({ id: 'disk', ok: true, facts });
      if (free < RECOMMENDED_FREE) warnings.push(`free disk ${gib(free)} at ${dir} is below the recommended 40 GiB`);
    }
  }
  // docker
  const v = probes.dockerVersion();
  const reachable = v.reachable === true && /linux/i.test(v.os || '');
  if (!v.reachable) checks.push({ id: 'docker', ok: false, facts: v, notRun: `Docker Desktop is not running (or not installed): docker version says ${v.why || 'no server'}.`, action: 'Start Docker Desktop, then run again.' });
  else if (!reachable) checks.push({ id: 'docker', ok: false, facts: v, notRun: `the Docker server is ${v.os || 'unknown'}, not Linux.`, action: 'Switch Docker Desktop to Linux containers, then run again.' });
  else checks.push({ id: 'docker', ok: true, facts: v });
  // memory / CPUs
  if (!reachable) checks.push({ id: 'memory', ok: false, facts: {}, notRun: 'Docker memory and CPUs were not checked: they need a running Docker.', action: 'Start Docker Desktop, then run again.' });
  else {
    const info = probes.dockerInfo();
    const mem = info ? info.memoryBytes : 0; const cpus = info ? info.cpus : 0;
    const facts = { memoryBytes: mem, cpus, minMemoryBytes: MIN_MEMORY, minCpus: MIN_CPUS };
    if (!info || mem < MIN_MEMORY || cpus < MIN_CPUS) {
      checks.push({ id: 'memory', ok: false, facts, notRun: `Docker has ${gib(mem)} (${exact(mem)}) / ${cpus} CPUs; the tests need 4 GiB / 2 CPUs.`,
        action: 'Docker Desktop -> Settings -> Resources, then run again.' });
    } else checks.push({ id: 'memory', ok: true, facts });
  }
  // images
  const lock = probes.lock();
  for (const p of PROFILES) {
    const pinned = lock && lock.profiles && lock.profiles[p] ? lock.profiles[p] : null;
    const size = pinned ? `~${Math.max(1, Math.round(pinned.estimatedBytes / 2 ** 20))} MiB` : 'size unknown';
    const action = `Run \`node tools/nexus-prepare-images.cjs\` (needs network; ${size}), then run again.`;
    if (!pinned) { checks.push({ id: `image:${p}`, ok: false, facts: {}, notRun: `Image ${p} is not pinned in infra/images/lock.json.`, action: 'Run `node tools/nexus-lock-images.cjs`, then run again.' }); continue; }
    if (!reachable) { checks.push({ id: `image:${p}`, ok: false, facts: { contextSha256: pinned.contextSha256 }, notRun: `Image ${p} was not checked: it needs a running Docker.`, action }); continue; }
    const img = probes.imageLabels(p);
    const label = img && img.labels ? img.labels['nexus.context-sha256'] : null;
    const facts = { imageId: img ? img.id : null, contextLabel: label || null, contextSha256: pinned.contextSha256 };
    if (!img || label !== pinned.contextSha256) {
      checks.push({ id: `image:${p}`, ok: false, facts, notRun: `Image ${p} is ${img ? 'out of date (its context label differs from lock.json)' : 'missing'}.`, action });
    } else checks.push({ id: `image:${p}`, ok: true, facts });
  }
  // env
  const env = probes.env();
  const holds = Object.keys(env).filter((k) => /^NEXUS_DB_HOLD_/.test(k)).sort();
  const tmp = probes.tempDir();
  const onReal = probes.userDataDirs().find((d) => inside(tmp, d)) || null;
  if (holds.length) checks.push({ id: 'env', ok: false, facts: { holds }, notRun: `${holds.join(', ')} ${holds.length === 1 ? 'is' : 'are'} set.`, action: `Unset ${holds.join(', ')} for the execution tests.` });
  else if (onReal) checks.push({ id: 'env', ok: false, facts: { tempDir: tmp, userData: onReal }, notRun: `the temp data home ${tmp} is inside the app's real userData (${onReal}).`, action: 'Point TEMP/TMPDIR at a scratch folder, then run again.' });
  else checks.push({ id: 'env', ok: true, facts: { tempDir: tmp } });
  return { ok: checks.every((c) => c.ok), checks, warnings };
}

// ---------------------------------------------------------------- the suite (the test:db rules)

function listFiles() {
  const dir = path.join(ROOT, 'test');
  return fs.readdirSync(dir).filter((f) => /^nexus-exec-.+\.test\.cjs$/.test(f)).sort().map((f) => path.join('test', f));
}

function spawnFile(file) {
  const electron = require('electron');
  return new Promise((resolve) => {
    const c = spawn(electron, [file], { cwd: ROOT, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', NEXUS_TEST_EXEC: '1' }, stdio: ['ignore', 'pipe', 'inherit'] });
    let text = ''; let settled = false; let timedOut = false;
    const done = (code) => { if (settled) return; settled = true; clearTimeout(timer); resolve({ code, text, timedOut }); };
    const timer = setTimeout(() => {
      timedOut = true;
      if (process.platform === 'win32' && c.pid) spawn('taskkill', ['/pid', String(c.pid), '/T', '/F'], { stdio: 'ignore' });
      else c.kill('SIGKILL');
      setTimeout(() => done(-1), 2000);
    }, FILE_TIMEOUT_MS);
    c.stdout.on('data', (d) => { text += d; process.stdout.write(d); });
    c.on('error', () => done(-1));
    c.on('close', (code) => done(code));
  });
}

/** The test:db verdict of one file's run. */
function verdict(out) {
  const tests = Number((out.text.match(/^# tests (\d+)/m) || [])[1] || 0);
  const skipped = Number((out.text.match(/^# skipped (\d+)/m) || [])[1] || 0);
  const todo = Number((out.text.match(/^# todo (\d+)/m) || [])[1] || 0);
  const bad = out.timedOut || out.code !== 0 || todo > 0 || tests === 0 || skipped > 0 || /needs Electron as node|needs the test:exec gate/.test(out.text);
  return { bad, tests, skipped, todo };
}

/**
 * The whole run. `o` (tests): `probes`, `files`, `spawnFile`, `reportPath`, `log`. Returns the exit code
 * (0 PASS, 1 FAIL, 3 NOT RUN) after writing the preflight report.
 */
async function main(o = {}) {
  const log = o.log || ((l) => console.log(l));
  const reportPath = o.reportPath || path.join(os.tmpdir(), REPORT_NAME);
  const pre = runPreflight(o.probes || REAL_PROBES);
  const report = { at: new Date().toISOString(), ok: pre.ok, checks: pre.checks.map(({ id, ok, facts, notRun, action }) => ({ id, ok, facts, ...(ok ? {} : { notRun, action }) })),
    warnings: pre.warnings, files: [], result: pre.ok ? 'running' : 'not_run', exitCode: null };
  const write = () => { try { fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`); } catch (e) { log(`[test:exec] the preflight report was not written: ${e.message}`); } };
  for (const w of pre.warnings) log(`[test:exec] warning: ${w}`);
  if (!pre.ok) {
    for (const c of pre.checks.filter((x) => !x.ok)) log(`[test:exec] NOT RUN: ${c.notRun} ${c.action}`);
    report.exitCode = EXIT.NOT_RUN;
    write();
    log(`[test:exec] preflight report: ${reportPath}`);
    return EXIT.NOT_RUN;
  }
  const files = o.files || listFiles();
  const run = o.spawnFile || spawnFile;
  let failed = 0;
  for (const f of files) {
    const out = await run(f);
    const v = verdict(out);
    report.files.push({ file: f, exit: out.code, tests: v.tests, skipped: v.skipped, todo: v.todo, timedOut: !!out.timedOut, ok: !v.bad });
    if (v.bad) { failed++; log(`[test:exec] FAIL ${f} (exit=${out.code} tests=${v.tests} skipped=${v.skipped} todo=${v.todo}${out.timedOut ? ' timed out' : ''})`); }
  }
  if (files.length === 0) { failed = 1; log('[test:exec] FAIL no test/nexus-exec-*.test.cjs file was found'); }
  report.result = failed ? 'fail' : 'pass';
  report.exitCode = failed ? EXIT.FAIL : EXIT.PASS;
  write();
  log(failed ? `[test:exec] FAIL ${files.length - failed}/${files.length} files passed` : `[test:exec] PASS ${files.length}/${files.length}`);
  return failed ? EXIT.FAIL : EXIT.PASS;
}

if (require.main === module) {
  main().then((code) => process.exit(code), (e) => { console.error(`[test:exec] FAIL the runner itself failed: ${e && e.message}`); process.exit(EXIT.FAIL); });
}

module.exports = { runPreflight, main, verdict, listFiles, REAL_PROBES, EXIT, REPORT_NAME, REQUIRED_FREE, RECOMMENDED_FREE, MIN_MEMORY, MIN_CPUS, PROFILES };
