'use strict';
// B2a Task 11 posture pins for the runner (src/runner) and the execution wiring (src/main/nexusExec). Static scans
// over the source text; plain node.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const ROOT = path.resolve(__dirname, '..');
const walk = (d) => !fs.existsSync(d) ? [] : fs.readdirSync(d, { withFileTypes: true })
  .flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
const ts = (dir) => walk(path.join(ROOT, dir)).filter((f) => f.endsWith('.ts'));
const rel = (f) => path.relative(ROOT, f).split(path.sep).join('/');
const read = (f) => fs.readFileSync(f, 'utf8');
/** The source without comments (a comment may name what the code must not do). */
const code = (f) => read(f).replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');

const RUNNER = ts('src/runner');
const WIRING = ts('src/main/nexusExec');

test('the runner and the wiring exist', () => {
  for (const f of ['src/runner/index.ts', 'src/runner/core.ts', 'src/runner/proc.ts', 'src/runner/sandbox/dockerCli.ts', 'src/runner/sandbox/dockerDriver.ts',
    'src/main/nexusExec/runnerHost.ts', 'src/main/nexusExec/execWiring.ts']) assert.ok(fs.existsSync(path.join(ROOT, f)), f);
});

test('no execSync, spawnSync, execFileSync or shell: true under src/runner and src/main/nexusExec', () => {
  for (const f of [...RUNNER, ...WIRING]) {
    const s = code(f);
    assert.doesNotMatch(s, /\b(execSync|spawnSync|execFileSync)\s*\(/, rel(f));
    assert.doesNotMatch(s, /shell\s*:\s*true/, rel(f));
    assert.doesNotMatch(s, /\bexec\s*\(\s*['"`]/, `${rel(f)}: no command string`);
  }
});

/** Relative and package imports of a TS file (static, dynamic and require). */
function importsOf(f) {
  const s = code(f);
  const out = [];
  for (const m of s.matchAll(/\bfrom\s+['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)|\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)|^\s*import\s+['"]([^'"]+)['"]/gm)) {
    out.push(m[1] ?? m[2] ?? m[3] ?? m[4]);
  }
  return out;
}
function resolveRel(from, spec) {
  const base = path.resolve(path.dirname(from), spec);
  for (const c of [base, `${base}.ts`, path.join(base, 'index.ts')]) if (fs.existsSync(c) && fs.statSync(c).isFile()) return c;
  return null;
}

test('src/runner reaches no database, no Electron and no main service: better-sqlite3, electron and src/main/nexus/{db,exec,...} are never imported', () => {
  const FORBIDDEN = ['db', 'exec', 'artifact', 'jobs', 'auth', 'workspace', 'lineage', 'handoff', 'validation', 'approvals', 'deployments', 'repo', 'blobs']
    .map((d) => path.join(ROOT, 'src', 'main', 'nexus', d) + path.sep);
  const seen = new Set();
  const stack = [path.join(ROOT, 'src', 'runner', 'index.ts'), ...RUNNER];
  while (stack.length) {
    const f = stack.pop();
    if (seen.has(f)) continue;
    seen.add(f);
    for (const spec of importsOf(f)) {
      assert.notEqual(spec, 'better-sqlite3', `${rel(f)} imports better-sqlite3`);
      assert.ok(spec !== 'electron' && !spec.startsWith('electron/'), `${rel(f)} imports electron`);
      if (!spec.startsWith('.')) continue;
      const r = resolveRel(f, spec);
      assert.ok(r, `${rel(f)}: ${spec} resolves`);
      assert.ok(!FORBIDDEN.some((d) => r.startsWith(d)), `${rel(f)} reaches ${rel(r)}`);
      stack.push(r);
    }
  }
  assert.ok(seen.size >= RUNNER.length);
  // The entry uses Electron's process.parentPort only (no import); no other runner file names it.
  assert.match(read(path.join(ROOT, 'src/runner/index.ts')), /process[^;]*parentPort/);
  for (const f of RUNNER.filter((x) => !x.endsWith(`runner${path.sep}index.ts`))) assert.doesNotMatch(code(f), /parentPort|utilityProcess|MessageChannelMain/, rel(f));
});

test('nothing under src/main or src/runner spawns python, py, pip, uv or pytest', () => {
  const BAD = /\b(spawn|spawnSync|execFile|execFileSync|exec|execSync|fork)\s*\(\s*['"`](python3?|py|pip3?|uv|pytest)(\.exe)?['"`]/;
  for (const f of [...ts('src/main'), ...RUNNER]) assert.doesNotMatch(code(f), BAD, rel(f));
});

test('the only programs spawned under src/runner and src/main/nexusExec are docker and git (spawn( first arguments)', () => {
  const sites = [];
  for (const f of [...RUNNER, ...WIRING]) {
    for (const m of code(f).matchAll(/\b(spawn|execFile|fork)\s*\(\s*([^,)]+)/g)) sites.push({ file: rel(f), fn: m[1], first: m[2].trim() });
  }
  // Besides docker and git: the runner itself (utilityProcess.fork of out/main/runner.js, pinned exactly below).
  assert.deepEqual(sites.map((s) => `${s.file} ${s.fn}(${s.first}`).sort(),
    ['src/runner/proc.ts spawn(\'git\'', 'src/runner/proc.ts spawn(dockerBin', 'src/main/nexusExec/runnerHost.ts fork(join(__dirname'].sort());
  // The docker site launches only a path whose file name is docker / docker.exe.
  const { isDockerBinary, runDocker } = loadTs('src/runner/proc.ts');
  assert.equal(isDockerBinary('C:\\Program Files\\Docker\\Docker\\resources\\bin\\docker.exe'), true);
  assert.equal(isDockerBinary('/usr/bin/docker'), true);
  for (const bad of ['docker', 'C:\\Windows\\System32\\cmd.exe', '/bin/sh', '/usr/bin/python3', 'C:\\x\\docker.exe.bat', '']) assert.equal(isDockerBinary(bad), false, bad);
  return assert.rejects(runDocker('/bin/sh', ['-c', 'echo'], { env: {}, timeoutMs: 1000, maxStdout: 10, maxStderr: 10 }), /only the resolved docker binary/);
});

test('utilityProcess and MessageChannelMain appear only in src/main/nexusExec/runnerHost.ts', () => {
  for (const f of [...ts('src/main'), ...RUNNER]) {
    if (rel(f) === 'src/main/nexusExec/runnerHost.ts') continue;
    assert.doesNotMatch(code(f), /\butilityProcess\b|\bMessageChannelMain\b/, rel(f));
  }
  assert.match(read(path.join(ROOT, 'src/main/nexusExec/runnerHost.ts')), /utilityProcess\.fork\(join\(__dirname, 'runner\.js'\), \[\], \{ serviceName: 'Nexus runner', stdio: 'pipe' \}\)/);
});

test('the runner\'s processes get a filtered environment: DOCKER_HOST only when set, no other host variable', () => {
  const { toolEnv } = loadTs('src/runner/proc.ts');
  const env = toolEnv({ PATH: '/bin', DOCKER_HOST: 'npipe:////./pipe/x', ANTHROPIC_API_KEY: 'sk-ant-xxx', GITHUB_TOKEN: 'ghp_x', HOME: '/h' });
  assert.equal(env.DOCKER_HOST, 'npipe:////./pipe/x');
  assert.equal(env.ANTHROPIC_API_KEY, undefined); assert.equal(env.GITHUB_TOKEN, undefined);
  assert.equal(toolEnv({ PATH: '/bin' }).DOCKER_HOST, undefined);
  assert.equal(env.GIT_TERMINAL_PROMPT, '0');
});
