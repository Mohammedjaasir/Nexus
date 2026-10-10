'use strict';
// B2a final fix (backend), the plain-node half: main's git and the shared filter-driver rule (final review B1), the
// redactor's URL and path cases (final batch items 5 and 6), diag.schema's inspect rule (item 7), the in-container wall
// clock (item 2) and the bounded sandbox record (final review A1). Temp repositories only, removed by the after hook.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');

// A spawn spy, installed before main's git module is loaded.
const SPAWNED = [];
const realSpawn = cp.spawn;
cp.spawn = function spySpawn(cmd, args, opts) { SPAWNED.push({ cmd, args: [...(args ?? [])], env: opts?.env }); return realSpawn.apply(this, arguments); };

const C = require('./helpers/cleanup.cjs');
C.cleanupAfterAll();
const h = require('./helpers/sqlite.cjs');
const loadTs = require('./load-ts.cjs');
const { filterDriverNames, neutralizeFilterArgs, FILTER_CONFIG_ARGV, FILTER_SAFE_ENV, SAFE_GIT_CONFIG } = loadTs('src/main/gitBinary.ts');
const { getStatus, isRepo } = loadTs('src/main/git.ts');
const { scrubHostPaths, redactSecretText } = loadTs('src/main/nexus/activity/redact.ts');
const diag = loadTs('src/main/nexus/validation/validators/diagSchema.ts');
const { wallSeconds, sandboxRecord, buildPlan, boundedRecord, RECORD_MAX_CHARS } = loadTs('src/main/nexus/exec/planBuilder.ts');
const { getRecipe } = loadTs('src/shared/nexus/recipes.ts');

const gitOk = (cwd, args) => {
  const r = cp.spawnSync('git', ['-c', 'core.autocrlf=false', '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', ...args],
    { cwd, encoding: 'utf8', windowsHide: true });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
};

test('FF1 (B1) the filter-driver rule: names from `git config --name-only --get-regexp`, dots kept, deduplicated; a name that cannot be passed back safely refuses the call; every driver gets all four switches', () => {
  assert.deepEqual([...FILTER_CONFIG_ARGV], ['config', '--name-only', '--get-regexp', '^filter\\.']);
  assert.deepEqual(filterDriverNames('filter.lfs.clean\nfilter.lfs.smudge\r\nfilter.lfs.process\nfilter.lfs.required\nfilter.a.b.clean\nfilter.lfs.clean\n'), ['lfs', 'a.b']);
  assert.deepEqual(filterDriverNames(''), []);
  assert.deepEqual(filterDriverNames('filter.clean\n'), [], 'a key with no driver name');
  assert.equal(filterDriverNames('filter.x=y.clean\n'), null, '`=` would end the -c key');
  assert.equal(filterDriverNames('filter.x\u0001.clean\n'), null);
  assert.equal(filterDriverNames('core.editor\n'), null, 'not a filter key: refused');
  assert.deepEqual(neutralizeFilterArgs(['lfs']), ['-c', 'filter.lfs.smudge=', '-c', 'filter.lfs.clean=', '-c', 'filter.lfs.process=', '-c', 'filter.lfs.required=false']);
  assert.deepEqual({ ...FILTER_SAFE_ENV }, { GIT_LFS_SKIP_SMUDGE: '1' });
});

test('FF2 (B1) main\'s git status (src/main/git.ts) runs no planted filter driver: the config is read first, every driver switched off, GIT_LFS_SKIP_SMUDGE=1; the control under plain git does run it', async () => {
  const dir = path.join(h.tmpDir('nx-ff-git-'), 'repo');
  fs.mkdirSync(dir, { recursive: true });
  gitOk(dir, ['init', '-q']);
  fs.writeFileSync(path.join(dir, 'a.txt'), 'committed\n');
  fs.writeFileSync(path.join(dir, '.gitattributes'), '* filter=evil\n');
  gitOk(dir, ['add', '-A']); gitOk(dir, ['commit', '-qm', 'init']);
  const marker = path.join(path.dirname(dir), 'filter-ran.txt');
  const shMarker = marker.split('\\').join('/');
  gitOk(dir, ['config', 'filter.evil.clean', `echo clean >> "${shMarker}"; cat`]);
  gitOk(dir, ['config', 'filter.evil.smudge', `echo smudge >> "${shMarker}"; cat`]);
  fs.writeFileSync(path.join(dir, 'a.txt'), 'changed in the work tree\n');
  const ctl = cp.spawnSync('git', ['status', '--porcelain'], { cwd: dir, encoding: 'utf8', windowsHide: true });
  assert.equal(ctl.status, 0, ctl.stderr);
  assert.ok(fs.existsSync(marker), 'control: plain git runs the planted clean filter');
  fs.rmSync(marker);
  const n0 = SPAWNED.length;
  const st = await getStatus(dir);
  assert.ok(!('error' in st), JSON.stringify(st));
  assert.ok(st.unstaged.some((e) => e.path === 'a.txt'), 'the change is still seen');
  assert.equal(fs.existsSync(marker), false, 'no filter driver ran on the host');
  const calls = SPAWNED.slice(n0);
  assert.deepEqual(calls[0].args.slice(0, 4 + FILTER_CONFIG_ARGV.length), ['-C', dir, ...SAFE_GIT_CONFIG, ...FILTER_CONFIG_ARGV], 'the read-only config query first');
  const status = calls.find((c) => c.args.includes('status'));
  const neutral = status.args.slice(4, status.args.indexOf('status'));
  for (const k of ['smudge=', 'clean=', 'process=', 'required=false']) assert.ok(neutral.includes(`filter.evil.${k}`), k);
  assert.equal(status.env.GIT_LFS_SKIP_SMUDGE, '1');
  // A plain read (rev-parse) is unchanged: no config query, no neutralisers.
  const n1 = SPAWNED.length;
  assert.equal(await isRepo(dir), true);
  assert.deepEqual(SPAWNED.slice(n1).map((c) => c.args.slice(4)), [['rev-parse', '--is-inside-work-tree']]);
});

test('FF3 (items 5 and 6) a one-letter URL scheme keeps no credentials (x://u:p@h is a URL, not a drive path); //Users/<name> and ///home/<name> are cut to their last segment', () => {
  for (const t of ['clone x://alice:hunter2@host/repo failed', 'see "x://alice:hunter2@host"', 'git+ssh://alice:hunter2@host/r']) {
    const once = scrubHostPaths(t);
    assert.doesNotMatch(once, /hunter2|alice/, `scrub alone: ${once}`);
    assert.doesNotMatch(redactSecretText(once), /hunter2/, t);
  }
  assert.equal(scrubHostPaths('x://host/path/file'), 'x://host/path/file', 'a URL without credentials is not a path');
  assert.equal(scrubHostPaths('C:\\Users\\bob\\x.js'), 'x.js', 'drive paths are still cut');
  for (const t of ['//Users/alice/proj/a.txt', 'at ///home/alice/proj/a.txt', 'C://Users/alice/f']) {
    assert.doesNotMatch(scrubHostPaths(t), /alice/, t);
  }
  assert.equal(scrubHostPaths('/workspace/out'), '/workspace/out', 'container paths are kept');
});

test('FF4 (item 7) diag.schema refuses ANY status but inspected under an inspect source (missing, not_owned, unavailable, or a .status field)', () => {
  const src = { type: 'inspect', container: { sha256: 'a'.repeat(64) }, field: 'State.Status' };
  const ok = { name: 'container.0.state', value: 'running', source: src };
  assert.equal(diag.run({ fields: [ok] }).status, 'passed');
  for (const value of ['missing', 'not_owned', 'unavailable']) {
    const r = diag.run({ fields: [ok, { name: 'container.0.status', value, source: src }] });
    assert.equal(r.status, 'failed', value);
    assert.match(JSON.stringify(r.evidence), /never sourced as inspect evidence/, value);
  }
  assert.equal(diag.run({ fields: [ok, { name: 'container.0.status', value: 'exited', source: src }] }).status, 'failed', 'a status field under inspect');
  // The same statuses sourced as what they are (unobserved) are accepted.
  assert.equal(diag.run({ fields: [ok, { name: 'container.1.status', value: 'missing',
    source: { type: 'unobserved', container: { sha256: 'b'.repeat(64) }, why: 'missing' } }] }).status, 'passed');
});

test('FF5 (item 2) the entry\'s own backstop is twice the wall clock (limit + cap): every plan container carries it', () => {
  assert.equal(wallSeconds(60_000), '120');
  assert.equal(wallSeconds(1), '1');
  assert.equal(wallSeconds(15 * 60_000), String(2 * 15 * 60));
  const profile = { id: 'sde-node', image: { repository: 'nexus/sde-node', digest: `sha256:${'7'.repeat(64)}`, source: 'built' }, user: { uid: 10001, gid: 10001 },
    defaults: { cpus: 1, memoryMb: 1024, pids: 512, wallClockMs: 60000, outputMaxBytes: 2 ** 20, tmpfsMb: 512 }, entrypoint: ['/opt/nexus/nexus-entry'], imageEnv: ['PATH'] };
  const plan = buildPlan({ job: { id: '01K7A0J0B000000000000000AA', projectId: 'p' }, attempt: { id: '01K7A0ATTEMPT0000000000AAA', n: 1 }, bootId: 'b',
    recipe: getRecipe('sde.build.node'), profile, imageId: `sha256:${'1'.repeat(64)}`, dataHomeRoot: path.resolve(h.tmpDir('nx-ff-home-')),
    workRel: 'work/01K7A0J0B000000000000000AA/1', logRel: 'logs/jobs/01K7A0J0B000000000000000AA/1.log', inputs: [], repoPath: null });
  assert.equal(plan.container.env.NEXUS_WALL_SECONDS, String((2 * getRecipe('sde.build.node').wallClockMs) / 1000));
  assert.equal(plan.container.limits.wallClockMs, getRecipe('sde.build.node').wallClockMs, 'main\'s wall clock is unchanged');
});

test('FF6 (A1) a sandbox record never exceeds RECORD_MAX_CHARS: argv items capped at 200 characters; above the bound the argv lists give way to argvCount and argvSha256', () => {
  const big = { executor: 'tool', argv: Array.from({ length: 300 }, (_, i) => `x${i}`.padEnd(150, 'y')), argvCount: 300, argvSha256: 'f'.repeat(64),
    nested: { argv: ['a'], argvCount: 1 } };
  const b = boundedRecord(big);
  assert.ok(JSON.stringify(b).length <= RECORD_MAX_CHARS);
  assert.equal(b.argv, undefined); assert.equal(b.argvOmitted, true); assert.equal(b.argvCount, 300); assert.equal(b.argvSha256, 'f'.repeat(64));
  assert.equal(b.nested.argvOmitted, true);
  const small = { executor: 'tool', argv: ['a', 'b'], argvCount: 2 };
  assert.equal(boundedRecord(small), small, 'a record that fits is kept as it is');
  const profile = { id: 'sde-node', image: { repository: 'nexus/sde-node', digest: `sha256:${'7'.repeat(64)}`, source: 'built' }, user: { uid: 10001, gid: 10001 },
    defaults: { cpus: 1, memoryMb: 1024, pids: 512, wallClockMs: 60000, outputMaxBytes: 2 ** 20, tmpfsMb: 512 }, entrypoint: ['/opt/nexus/nexus-entry'], imageEnv: ['PATH'] };
  const files = Array.from({ length: 120 }, (_, i) => `test/${'q'.repeat(270)}/${String(i).padStart(4, '0')}.js`);
  const plan = buildPlan({ job: { id: '01K7A0J0B000000000000000AB', projectId: 'p' }, attempt: { id: '01K7A0ATTEMPT0000000000AAB', n: 1 }, bootId: 'b',
    recipe: getRecipe('sde.test.node'), profile, imageId: `sha256:${'1'.repeat(64)}`, dataHomeRoot: path.resolve(h.tmpDir('nx-ff-home-')),
    workRel: 'work/01K7A0J0B000000000000000AB/1', logRel: 'logs/jobs/01K7A0J0B000000000000000AB/1.log', repoPath: null,
    inputs: [{ versionId: 'V', slot: 'suite', contentHash: 'x', storage: { kind: 'inline' }, metadata: { framework: 'node-test', files } }] });
  const rec = sandboxRecord(plan);
  assert.ok(JSON.stringify(rec).length <= RECORD_MAX_CHARS);
  assert.ok(rec.argv.every((x) => x.length <= 200));
  assert.equal(rec.argvCount, plan.container.argv.length);
});
