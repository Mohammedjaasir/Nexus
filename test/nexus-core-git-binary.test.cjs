'use strict';
// B2a Task 11 fix round 1 (critical): git is resolved once to an absolute path and launched with -C; a git.exe,
// git.cmd or git.bat planted in a repository never runs, in main (src/main/git.ts) as in the runner. Plain node;
// temp repositories only, removed by the after hook.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');

const SPAWNED = [];
const realSpawn = cp.spawn;
cp.spawn = function spySpawn(cmd, args, opts) { SPAWNED.push({ cmd, args: [...(args ?? [])], cwd: opts?.cwd, shell: opts?.shell }); return realSpawn.apply(this, arguments); };

const C = require('./helpers/cleanup.cjs');
C.cleanupAfterAll();
const h = require('./helpers/sqlite.cjs');
const loadTs = require('./load-ts.cjs');
const { resolveGitBinary, insideFolder, isGitBinary, gitInstallCandidates, SAFE_GIT_CONFIG } = loadTs('src/main/gitBinary.ts');
const { resolveCommit, isRepo } = loadTs('src/main/git.ts');

const gitOk = (cwd, args) => {
  const r = cp.spawnSync('git', ['-c', 'core.autocrlf=false', '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', ...args],
    { cwd, encoding: 'utf8', windowsHide: true });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
};
function plantedRepo() {
  const dir = path.join(h.tmpDir('nx-git-'), 'repo');
  fs.mkdirSync(dir, { recursive: true });
  gitOk(dir, ['init', '-q']);
  fs.writeFileSync(path.join(dir, 'a.txt'), 'a');
  gitOk(dir, ['add', '-A']); gitOk(dir, ['commit', '-qm', 'init']);
  const commit = gitOk(dir, ['rev-parse', 'HEAD']);
  if (process.platform === 'win32') {
    fs.copyFileSync(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'whoami.exe'), path.join(dir, 'git.exe'));
    for (const ext of ['cmd', 'bat']) fs.writeFileSync(path.join(dir, `git.${ext}`), '@echo off\r\necho planted> "%~dp0planted-ran.txt"\r\n');
  } else {
    fs.writeFileSync(path.join(dir, 'git'), `#!/bin/sh\necho planted > "${path.join(dir, 'planted-ran.txt')}"\n`, { mode: 0o755 });
  }
  return { dir, commit, marker: path.join(dir, 'planted-ran.txt') };
}

test('GB1 main\'s resolveCommit and isRepo on a repository holding a planted git.exe, git.cmd and git.bat: the real git runs, with -C and core.fsmonitor=false', async () => {
  const r = plantedRepo();
  const n0 = SPAWNED.length;
  const res = await resolveCommit(r.dir, r.commit);
  assert.equal(res.commit, r.commit, JSON.stringify(res));
  assert.equal(await isRepo(r.dir), true);
  const spawned = SPAWNED.slice(n0);
  assert.ok(spawned.length >= 3);
  for (const s of spawned) {
    assert.ok(isGitBinary(s.cmd), s.cmd);
    assert.ok(!insideFolder(s.cmd, r.dir), 'never a git inside the repository');
    assert.deepEqual(s.args.slice(0, 4), ['-C', r.dir, ...SAFE_GIT_CONFIG]);
    assert.equal(path.resolve(s.cwd), path.dirname(s.cmd), 'launched from the git binary\'s own folder, never the repository');
    assert.notEqual(s.shell, true);
  }
  assert.equal(fs.existsSync(r.marker), false, 'no planted program ran');
});

test('GB2 main refuses a folder that is not absolute (git never runs relative to its own working folder)', async () => {
  const n0 = SPAWNED.length;
  assert.equal(await isRepo('relative/folder'), false);
  assert.deepEqual(await resolveCommit('relative', 'a'.repeat(40)), { error: 'not_a_repository' });
  assert.equal(SPAWNED.length, n0);
});

test('GB3 the resolver: absolute PATH folders only, the real executable name only, never inside a forbidden folder; then the install folders', async () => {
  const files = new Set(['C:\\repo\\git.exe', 'C:\\repo\\git.cmd', 'C:\\tools\\git.bat', 'C:\\Program Files\\Git\\cmd\\git.exe', 'D:\\good\\git.exe']);
  const fsFake = { stat: async (p) => { if (files.has(p)) return { isFile: () => true }; throw Object.assign(new Error('x'), { code: 'ENOENT' }); } };
  // '.', a relative entry, a .bat-only folder and the forbidden repository are all skipped; D:\good wins.
  assert.equal(await resolveGitBinary(fsFake, { platform: 'win32', env: { PATH: '.;relative\\bin;C:\\tools;C:\\repo;D:\\good' }, notInside: ['C:\\REPO'] }), 'D:\\good\\git.exe');
  // Without a usable PATH entry: the Git for Windows install folder.
  assert.equal(await resolveGitBinary(fsFake, { platform: 'win32', env: { PATH: 'C:\\repo', ProgramFiles: 'C:\\Program Files' }, notInside: ['c:\\repo'] }),
    'C:\\Program Files\\Git\\cmd\\git.exe');
  assert.equal(await resolveGitBinary({ stat: async () => { throw new Error('none'); } }, { platform: 'win32', env: { PATH: '' } }), null);
  assert.ok(gitInstallCandidates('win32', { ProgramFiles: 'C:\\PF' }).includes('C:\\PF\\Git\\cmd\\git.exe'));
  assert.equal(insideFolder('C:\\Repo\\Sub\\git.exe', 'c:\\repo', 'win32'), true);
  assert.equal(insideFolder('C:\\repository\\git.exe', 'c:\\repo', 'win32'), false);
  assert.equal(insideFolder('/Repo/git', '/repo', 'linux'), false, 'POSIX paths are case-sensitive');
  for (const bad of ['C:\\x\\git.cmd', 'C:\\x\\git.bat', 'git.exe', 'git']) assert.equal(isGitBinary(bad, 'win32'), false, bad);
});

// ---------- Fix round 2 (review of 0b56e6ba) ----------

const fsp = require('node:fs/promises');
const { gitResolver } = loadTs('src/main/gitBinary.ts');
const { GitRunner, GitError } = loadTs('src/runner/git.ts');
const GIT_NAME = process.platform === 'win32' ? 'git.exe' : 'git';

/** Main's src/main/git.ts in a FRESH node process, with its own working folder and environment (git.ts keeps a found binary per process). */
const CHILD = [
  "const cp = require('node:child_process'); const spawned = []; const real = cp.spawn;",
  'cp.spawn = function (cmd, args, opts) { spawned.push({ cmd, cwd: opts && opts.cwd }); return real.apply(this, arguments); };',
  "const g = require(process.argv[1])('src/main/git.ts');",
  '(async () => {',
  "  const repo = process.argv[2] === '-' ? null : process.argv[2];",
  '  const out = { cwd: process.cwd(), bin: await g.gitBinary() };',
  '  if (repo) { out.check = await g.repositoryCheck(repo); out.isRepo = await g.isRepo(repo); }',
  '  out.spawned = spawned; process.stdout.write(JSON.stringify(out));',
  '})().catch((e) => { process.stderr.write(String(e && e.stack)); process.exit(1); });'
].join('\n');
function mainGitIn(cwd, env, repo) {
  const r = cp.spawnSync(process.execPath, ['-e', CHILD, path.join(__dirname, 'load-ts.cjs'), repo ?? '-'], { cwd, env, encoding: 'utf8', windowsHide: true, timeout: 60_000 });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}
const ENV_KEYS = ['PATH', 'ProgramFiles', 'ProgramFiles(x86)', 'LOCALAPPDATA'];
/** process.env without PATH, the Program Files folders and LOCALAPPDATA (in any case), plus `over`. */
function envWith(over) {
  const out = {};
  for (const [k, v] of Object.entries(process.env)) if (!/^(path|programfiles(\(x86\))?|programw6432|localappdata)$/i.test(k)) out[k] = v;
  return { ...out, ...over };
}
/** Runs `fn` in THIS process with `over` as PATH / Program Files / LOCALAPPDATA and `cwd` as the working folder (the runner's view). */
async function withEnv(over, cwd, fn) {
  const prevEnv = ENV_KEYS.map((k) => process.env[k]);
  const prevCwd = process.cwd();
  try {
    for (const k of ENV_KEYS) if (k in over) process.env[k] = over[k];
    process.chdir(cwd);
    return await fn();
  } finally {
    process.chdir(prevCwd);
    ENV_KEYS.forEach((k, i) => { if (prevEnv[i] === undefined) delete process.env[k]; else process.env[k] = prevEnv[i]; });
  }
}
function dataHome() { const d = path.join(h.tmpDir('nx-git-'), 'data home'); fs.mkdirSync(d, { recursive: true }); return d; }

test('GB4 (review round 2) the launch folder is no rule: started from the drive root, from git\'s own install folders or above them, main and the runner both find git and read the repository', async () => {
  const r = plantedRepo();
  const real = await resolveGitBinary(fsp);
  assert.ok(real && isGitBinary(real), 'this machine has git');
  const home = dataHome();
  const folders = [];
  for (let d = path.dirname(real); ; d = path.dirname(d)) { folders.push(d); if (path.dirname(d) === d) break; }
  assert.ok(folders.includes(path.parse(real).root), 'the drive root is among them');
  for (const cwd of folders) {
    const o = mainGitIn(cwd, process.env, r.dir);
    assert.equal(path.resolve(o.cwd), path.resolve(cwd));
    assert.equal(o.bin, real, `main started from ${cwd}`);
    assert.equal(o.check, true, `main's repository check from ${cwd}`); assert.equal(o.isRepo, true);
    assert.ok(o.spawned.length >= 2 && o.spawned.every((s) => s.cmd === real && path.resolve(s.cwd) === path.dirname(real)));
    await withEnv({}, cwd, async () => {
      const gr = new GitRunner({ cwd: home });
      assert.equal(await gr.binary(), real, `the runner started from ${cwd}`);
      assert.equal((await gr.snapshot(r.dir)).commit, r.commit);
    });
  }
  assert.equal(fs.existsSync(r.marker), false, 'no planted program ran');
});

test('GB5 (review round 2) a user-scope git under the home folder (a scoop shim on PATH, the per-user Git for Windows) is found when the app starts from that home folder', async () => {
  const userHome = path.join(h.tmpDir('nx-git-'), 'home');
  const nope = path.join(userHome, 'nope');
  const shim = path.join(userHome, 'scoop', 'shims', GIT_NAME);
  fs.mkdirSync(path.dirname(shim), { recursive: true });
  fs.writeFileSync(shim, '');                               // only looked at (stat), never run
  const scoop = { PATH: path.dirname(shim), ProgramFiles: nope, 'ProgramFiles(x86)': nope, LOCALAPPDATA: nope };
  assert.equal(mainGitIn(userHome, envWith(scoop)).bin, shim, 'main: the scoop shim');
  await withEnv(scoop, userHome, async () => assert.equal(await new GitRunner({ cwd: dataHome() }).binary(), shim, 'the runner: the scoop shim'));
  if (process.platform === 'win32') {
    const local = path.join(userHome, 'AppData', 'Local');
    const perUser = path.join(local, 'Programs', 'Git', 'cmd', 'git.exe');
    fs.mkdirSync(path.dirname(perUser), { recursive: true });
    fs.writeFileSync(perUser, '');
    const perUserEnv = { PATH: nope, ProgramFiles: nope, 'ProgramFiles(x86)': nope, LOCALAPPDATA: local };
    assert.equal(mainGitIn(userHome, envWith(perUserEnv)).bin, perUser, 'main: the per-user Git for Windows');
    await withEnv(perUserEnv, userHome, async () => assert.equal(await new GitRunner({ cwd: dataHome() }).binary(), perUser, 'the runner: the per-user Git for Windows'));
  }
});

test('GB6 (review round 2) a git inside the repository is still refused, even with the repository first on PATH: main never runs it (not a repository, not git_missing), the runner refuses it', async () => {
  const r = plantedRepo();
  const real = await resolveGitBinary(fsp);
  const planted = { PATH: `${r.dir}${path.delimiter}${path.dirname(real)}` };
  const o = mainGitIn(path.dirname(r.dir), envWith(planted), r.dir);
  assert.equal(o.bin, path.join(r.dir, GIT_NAME), 'resolved (PATH order) ...');
  assert.equal(o.check, false, '... but refused for this repository'); assert.equal(o.isRepo, false);
  assert.deepEqual(o.spawned, [], 'nothing launched');
  const n0 = SPAWNED.length;
  await withEnv(planted, path.dirname(r.dir), async () => {
    await assert.rejects(new GitRunner({ cwd: dataHome() }).snapshot(r.dir), (e) => e instanceof GitError && e.kind === 'refused' && /inside the repository/.test(e.message));
  });
  assert.equal(SPAWNED.length, n0, 'the runner launched nothing');
  assert.equal(fs.existsSync(r.marker), false, 'no planted program ran');
});

test('GB7 (review round 2) no git on PATH or in the install folders: main\'s repository check says git_missing (never not_a_repository) and nothing throws; the runner says git_missing; a git installed later is found without a restart', async () => {
  const r = plantedRepo();
  const nope = path.join(path.dirname(r.dir), 'nope');
  if (process.platform === 'win32') {
    const none = { PATH: nope, ProgramFiles: nope, 'ProgramFiles(x86)': nope, LOCALAPPDATA: nope };
    const o = mainGitIn(path.dirname(r.dir), envWith(none), r.dir);
    assert.equal(o.bin, null);
    assert.equal(o.check, 'git_missing'); assert.equal(o.isRepo, false);
    assert.deepEqual(o.spawned, []);
    const n0 = SPAWNED.length;
    await withEnv(none, path.dirname(r.dir), async () => {
      const gr = new GitRunner({ cwd: dataHome() });
      assert.equal(await gr.available(), false);
      await assert.rejects(gr.snapshot(r.dir), (e) => e instanceof GitError && e.kind === 'git_missing');
    });
    assert.equal(SPAWNED.length, n0);
  }
  // The shared keeping rule: a miss is asked again (git installed meanwhile), a found binary is kept, forget() drops it.
  let present = false; let asked = 0;
  const res = gitResolver(async () => { asked++; return present ? 'C:\\Git\\cmd\\git.exe' : null; });
  assert.equal(await res.get(), null);
  present = true;
  assert.equal(await res.get(), 'C:\\Git\\cmd\\git.exe', 'installed meanwhile: found');
  present = false;
  assert.equal(await res.get(), 'C:\\Git\\cmd\\git.exe', 'a found binary is kept');
  res.forget();
  assert.equal(await res.get(), null, 'after forget (it stopped launching): asked again');
  assert.equal(asked, 3);
  assert.equal(await gitResolver(async () => { throw new Error('boom'); }).get(), null, 'a resolver that throws is a miss');
});
