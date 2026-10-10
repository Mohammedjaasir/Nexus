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
