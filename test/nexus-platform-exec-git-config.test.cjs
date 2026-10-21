'use strict';
// B2a stabilization, workstream C, part 2 (security review of git on the B2a path). A repository's OWN config can name
// programs git runs. The B2a path neutralised core.fsmonitor and filter drivers before this round; this review found three
// more ways, each proven live by a control (plain git DOES run the repository's program) and then shown closed:
//  GC1 the runner's `git archive` (staging): an export-subst `$Format:%G?$` placeholder verifies a signed commit by running
//      the repository's gpg.program -> every signature program is now the resolved git binary itself (inertSignatureArgs);
//  GC2 the runner's snapshot `git status`: a SUBMODULE's own config can name a filter driver the superproject's
//      neutralisation never saw -> status runs with --ignore-submodules=all;
//  GC3 main's resolveCommit (repo.snapshot ingest, git.head_resolves, user saves): `log.showSignature=true` in the
//      repository's config makes `git show` run its gpg.program -> --no-show-signature.
//  GC4 reachability guard (documented risks 34): the B2a code never imports src/main/hive.ts, and imports from the legacy
//      src/main/git.ts only repositoryCheck and resolveCommit (neither produces a diff, so textconv and external diff
//      drivers cannot run on the B2a path).
// Real git in temporary repositories only; the "programs" are marker scripts that write a file. No network.
const test = require('node:test');
const { after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const loadTs = require('./load-ts.cjs');

const ROOT = path.resolve(__dirname, '..');
const { GitRunner } = loadTs('src/runner/git.ts');
const { resolveCommit } = loadTs('src/main/git.ts');

const MADE = [];
after(() => { for (const d of MADE) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } } });
function tmp(prefix) { const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); MADE.push(d); return d; }

const git = (cwd, args, o = {}) => {
  const r = cp.spawnSync('git', ['-c', 'core.autocrlf=false', '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false',
    '-c', 'protocol.file.allow=always', ...args], { cwd, encoding: 'utf8', windowsHide: true, input: o.input });
  if (o.check !== false) assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r;
};

/** A marker "program": a shell script git can run (Git for Windows runs #! scripts too) that records it ran. */
function marker(dir, name) {
  const log = path.join(dir, `${name}.ran`);
  const file = path.join(dir, `${name}.sh`);
  fs.writeFileSync(file, `#!/bin/sh\necho "$0 $*" >> '${log.replace(/\\/g, '/')}'\ncat >/dev/null 2>&1\nexit 1\n`, { mode: 0o755 });
  return { file: file.replace(/\\/g, '/'), ran: () => fs.existsSync(log), reset: () => fs.rmSync(log, { force: true }) };
}

/** A repository whose HEAD is a commit carrying a (fake) signature header, so any signature check runs gpg.program. */
function signedRepo(dir, files) {
  git(dir, ['init', '-q']);
  for (const [f, c] of Object.entries(files)) fs.writeFileSync(path.join(dir, f), c);
  git(dir, ['add', '-A']);
  const tree = git(dir, ['write-tree']).stdout.trim();
  const body = `tree ${tree}\nauthor t <t@example.invalid> 1700000000 +0000\ncommitter t <t@example.invalid> 1700000000 +0000\n`
    + 'gpgsig -----BEGIN PGP SIGNATURE-----\n \n iQEzBAABCAAdFiEEnexustestnotarealsignature\n -----END PGP SIGNATURE-----\n\nsigned\n';
  const sha = git(dir, ['hash-object', '-t', 'commit', '-w', '--stdin'], { input: body }).stdout.trim();
  git(dir, ['update-ref', 'HEAD', sha]);
  return sha;
}

test('GC1 the runner\'s archive runs no signature program of the repository\'s (export-subst %G? placeholder): plain git does, the runner\'s staging does not', async () => {
  const dir = tmp('nx-gc1-'); const repo = path.join(dir, 'repo'); fs.mkdirSync(repo);
  const gpg = marker(dir, 'gpg'); const ssh = marker(dir, 'sshsig'); const x509 = marker(dir, 'x509');
  const commit = signedRepo(repo, { '.gitattributes': 'sub.txt export-subst\n', 'sub.txt': 'sig=$Format:%G?$\n' });
  git(repo, ['config', 'gpg.program', gpg.file]); git(repo, ['config', 'gpg.ssh.program', ssh.file]); git(repo, ['config', 'gpg.x509.program', x509.file]);
  // Control: plain git archive runs the repository's gpg.program.
  git(repo, ['archive', '--format=tar', commit], { check: false });
  assert.equal(gpg.ran(), true, 'the control: plain git archive runs gpg.program from the repository config');
  gpg.reset();
  // The runner's staging archive.
  const home = tmp('nx-gc1-home-');
  const runner = new GitRunner({ cwd: home });
  const dest = path.join(home, 'src.tar');
  const r = await runner.archiveTo(fsp, repo, commit, dest, { maxBytes: 16 * 2 ** 20 });
  assert.ok(r.bytes > 0);
  assert.equal(gpg.ran() || ssh.ran() || x509.ran(), false, 'no signature program of the repository ran');
  const tar = fs.readFileSync(dest, 'latin1');
  assert.match(tar, /sig=N\n/, 'the placeholder expands without a verification');
});

test('GC2 the snapshot\'s status runs no filter driver from a submodule\'s own config: plain git status does, the runner\'s snapshot does not', async () => {
  const dir = tmp('nx-gc2-');
  const clean = marker(dir, 'clean');
  const sub = path.join(dir, 'sub'); fs.mkdirSync(sub);
  git(sub, ['init', '-q']);
  fs.writeFileSync(path.join(sub, '.gitattributes'), '*.txt filter=evil\n'); fs.writeFileSync(path.join(sub, 'f.txt'), 'a\n');
  git(sub, ['add', '-A']); git(sub, ['commit', '-qm', 's']);
  const sup = path.join(dir, 'sup'); fs.mkdirSync(sup);
  git(sup, ['init', '-q']);
  git(sup, ['submodule', 'add', '-q', sub.replace(/\\/g, '/'), 'sub']);
  git(sup, ['commit', '-qm', 'sup']);
  const inner = path.join(sup, 'sub');
  git(inner, ['config', 'filter.evil.clean', clean.file]);
  // A same-size change with the index's own mtime: git must read the content (through the clean filter) to compare it.
  const racy = () => {
    fs.writeFileSync(path.join(inner, 'f.txt'), 'b\n');
    const idx = git(inner, ['rev-parse', '--git-path', 'index']).stdout.trim();
    const st = fs.statSync(path.isAbsolute(idx) ? idx : path.join(inner, idx));
    fs.utimesSync(path.join(inner, 'f.txt'), st.atime, st.mtime);
  };
  racy();
  git(sup, ['status', '--porcelain=v1', '-z'], { check: false });
  assert.equal(clean.ran(), true, 'the control: plain git status in the superproject runs the submodule\'s filter driver');
  clean.reset(); racy();
  const home = tmp('nx-gc2-home-');
  const facts = await new GitRunner({ cwd: home }).snapshot(sup);
  assert.match(facts.commit, /^[0-9a-f]{40}$/);
  assert.equal(clean.ran(), false, 'the runner\'s snapshot ran no submodule filter driver');
});

test('GC3 main\'s resolveCommit runs no gpg.program of the repository\'s under log.showSignature=true: plain git show does, resolveCommit does not', async () => {
  const dir = tmp('nx-gc3-'); const repo = path.join(dir, 'repo'); fs.mkdirSync(repo);
  const gpg = marker(dir, 'gpg');
  const commit = signedRepo(repo, { 'a.txt': 'a\n' });
  git(repo, ['config', 'log.showSignature', 'true']); git(repo, ['config', 'gpg.program', gpg.file]);
  git(repo, ['show', '-s', '--format=%H', commit], { check: false });
  assert.equal(gpg.ran(), true, 'the control: plain git show runs gpg.program from the repository config');
  gpg.reset();
  const r = await resolveCommit(repo, commit.slice(0, 12));
  assert.equal(r.commit, commit);
  assert.equal(r.subject, 'signed');
  assert.equal(gpg.ran(), false, 'resolveCommit ran no gpg.program');
});

test('GC4 reachability (documented risks 34): no B2a module imports hive.ts; from the legacy git.ts B2a imports only repositoryCheck and resolveCommit (no diff)', () => {
  const dirs = ['src/main/nexus', 'src/main/nexusExec', 'src/main/nexusIpc', 'src/runner', 'src/shared/nexus'];
  const files = [];
  const walk = (d) => { for (const e of fs.readdirSync(path.join(ROOT, d), { withFileTypes: true })) { const p = `${d}/${e.name}`; if (e.isDirectory()) walk(p); else if (/\.tsx?$/.test(e.name)) files.push(p); } };
  for (const d of dirs) walk(d);
  assert.ok(files.length > 50);
  const names = new Set();
  for (const f of files) {
    const text = fs.readFileSync(path.join(ROOT, f), 'utf8');
    assert.doesNotMatch(text, /from\s+['"][./]*(?:main\/)?hive['"]|require\(['"][./]*hive['"]\)/, `${f} imports hive.ts`);
    for (const m of text.matchAll(/import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+['"]((?:\.\.\/)+git|\.\/git)['"]/g)) {
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(f), m[2]));
      if (target !== 'src/main/git') continue;
      for (const n of m[1].split(',').map((x) => x.trim().replace(/^type\s+/, '')).filter(Boolean)) names.add(n);
    }
  }
  assert.deepEqual([...names].sort(), ['resolveCommit'], 'B2a modules import only resolveCommit from src/main/git.ts (repositoryCheck is injected by index.ts)');
  // index.ts hands the platform exactly these two (the rest of git.ts serves the legacy git:* channels and worker worktrees).
  const index = fs.readFileSync(path.join(ROOT, 'src/main/index.ts'), 'utf8');
  assert.match(index, /isRepository: repositoryCheck,\s*\r?\n\s*resolveCommit,/);
  const gitTs = fs.readFileSync(path.join(ROOT, 'src/main/git.ts'), 'utf8');
  const fn = (name) => gitTs.slice(gitTs.indexOf(`export async function ${name}(`), gitTs.indexOf('\n}\n', gitTs.indexOf(`export async function ${name}(`)));
  for (const name of ['repositoryCheck', 'resolveCommit']) {
    const body = fn(name);
    assert.ok(body.length > 50, name);
    assert.doesNotMatch(body, /'diff'|'diff-tree'|'log'|ext-diff|textconv/, `${name} produces no diff`);
  }
});

// ---------- B2a close (user decision 2026-10-21): the legacy git:* path of src/main/git.ts ----------
// The Nexus renderer calls the legacy channels on the project folder (getLog / getLogGraph / getStatus when a project
// opens, diffs in the review and IDE views). Each test proves the planted program runs under plain git (the control),
// then that the legacy function runs none of it and still answers what it answered before.
const legacy = loadTs('src/main/git.ts');

test('GC5 getLog and getLogGraph run no signature program of the repository\'s under log.showSignature=true: plain git log does; the commits still parse', async () => {
  const dir = tmp('nx-gc5-'); const repo = path.join(dir, 'repo'); fs.mkdirSync(repo);
  const gpg = marker(dir, 'gpg'); const ssh = marker(dir, 'sshsig'); const x509 = marker(dir, 'x509');
  const commit = signedRepo(repo, { 'a.txt': 'a\n' });
  git(repo, ['config', 'log.showSignature', 'true']);
  git(repo, ['config', 'gpg.program', gpg.file]); git(repo, ['config', 'gpg.ssh.program', ssh.file]); git(repo, ['config', 'gpg.x509.program', x509.file]);
  git(repo, ['log', '--all', '--max-count=5', '--format=%H'], { check: false });
  assert.equal(gpg.ran(), true, 'the control: plain git log runs gpg.program from the repository config');
  gpg.reset();
  const log = await legacy.getLog(repo, 50);
  const graph = await legacy.getLogGraph(repo, 50);
  assert.equal(gpg.ran() || ssh.ran() || x509.ran(), false, 'no signature program of the repository ran');
  for (const out of [log, graph]) {
    assert.ok(Array.isArray(out), JSON.stringify(out));
    assert.equal(out.length, 1);
    assert.equal(out[0].sha, commit); assert.equal(out[0].subject, 'signed'); assert.equal(out[0].author, 't');
    assert.deepEqual(out[0].parents, []);
  }
});

test('GC6 getStatus runs no filter driver from a submodule\'s own config (--ignore-submodules=dirty): plain git status does; a submodule commit change still shows', async () => {
  const dir = tmp('nx-gc6-');
  const clean = marker(dir, 'clean');
  const sub = path.join(dir, 'sub'); fs.mkdirSync(sub);
  git(sub, ['init', '-q']);
  fs.writeFileSync(path.join(sub, '.gitattributes'), '*.txt filter=evil\n'); fs.writeFileSync(path.join(sub, 'f.txt'), 'a\n');
  git(sub, ['add', '-A']); git(sub, ['commit', '-qm', 's']);
  const sup = path.join(dir, 'sup'); fs.mkdirSync(sup);
  git(sup, ['init', '-q']);
  git(sup, ['submodule', 'add', '-q', sub.replace(/\\/g, '/'), 'sub']);
  git(sup, ['commit', '-qm', 'sup']);
  fs.writeFileSync(path.join(sup, 'top.txt'), 'untracked\n');
  const inner = path.join(sup, 'sub');
  git(inner, ['config', 'filter.evil.clean', clean.file]);
  const racy = () => {
    fs.writeFileSync(path.join(inner, 'f.txt'), 'b\n');
    const idx = git(inner, ['rev-parse', '--git-path', 'index']).stdout.trim();
    const st = fs.statSync(path.isAbsolute(idx) ? idx : path.join(inner, idx));
    fs.utimesSync(path.join(inner, 'f.txt'), st.atime, st.mtime);
  };
  racy();
  git(sup, ['status', '--porcelain=v1', '-z'], { check: false });
  assert.equal(clean.ran(), true, 'the control: plain git status in the superproject runs the submodule\'s filter driver');
  clean.reset(); racy();
  const st = await legacy.getStatus(sup);
  assert.equal(clean.ran(), false, 'getStatus ran no submodule filter driver');
  assert.deepEqual(st.untracked, ['top.txt'], 'the superproject\'s own status is unchanged');
  assert.deepEqual(st.unstaged, [], 'a dirty submodule work tree is not read');
  // A commit in the submodule (its recorded commit changes) still shows as a change of `sub`.
  git(inner, ['-c', 'filter.evil.clean=', 'commit', '-qam', 'moved']);
  clean.reset();
  const moved = await legacy.getStatus(sup);
  assert.equal(clean.ran(), false);
  assert.deepEqual(moved.unstaged.map((e) => e.path), ['sub']);
});

test('GC7 the legacy diffs run no external diff driver and no textconv of the repository\'s (getDiff, getFileAtRev, getCommitFiles, compareRefs, worktreeIsGcSafe): plain git diff does; the answers are unchanged', async () => {
  const dir = tmp('nx-gc7-'); const repo = path.join(dir, 'repo'); fs.mkdirSync(repo);
  const ext = marker(dir, 'external'); const cmd = marker(dir, 'drvcmd'); const conv = marker(dir, 'textconv');
  git(repo, ['init', '-q', '-b', 'main']);
  fs.writeFileSync(path.join(repo, '.gitattributes'), '*.txt diff=evil\n');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'one\n'); fs.writeFileSync(path.join(repo, 'b.md'), 'one\n');
  git(repo, ['add', '-A']); git(repo, ['commit', '-qm', 'first']);
  fs.writeFileSync(path.join(repo, 'a.txt'), 'two\n'); fs.writeFileSync(path.join(repo, 'b.md'), 'two\n');
  git(repo, ['commit', '-qam', 'second']);
  const head = git(repo, ['rev-parse', 'HEAD']).stdout.trim();
  git(repo, ['config', 'diff.external', ext.file]);
  git(repo, ['config', 'diff.evil.command', cmd.file]);
  git(repo, ['config', 'diff.evil.textconv', conv.file]);
  // Controls: plain git runs each one.
  git(repo, ['diff', 'HEAD~1', 'HEAD', '--', 'a.txt'], { check: false });
  assert.equal(cmd.ran(), true, 'the control: the diff driver\'s command runs');
  git(repo, ['diff', 'HEAD~1', 'HEAD', '--', 'b.md'], { check: false });
  assert.equal(ext.ran(), true, 'the control: diff.external runs');
  git(repo, ['diff', '--no-ext-diff', 'HEAD~1', 'HEAD', '--', 'a.txt'], { check: false });
  assert.equal(conv.ran(), true, 'the control: textconv runs');
  for (const m of [ext, cmd, conv]) m.reset();
  fs.writeFileSync(path.join(repo, 'a.txt'), 'three\n');
  const d = await legacy.getDiff(repo, 'a.txt');
  assert.equal(d.ok, true); assert.equal(d.head, 'two\n'); assert.equal(d.working, 'three\n');
  const at = await legacy.getFileAtRev(repo, 'HEAD~1', 'a.txt');
  assert.deepEqual(at, { ok: true, exists: true, isBinary: false, content: 'one\n' });
  assert.deepEqual(await legacy.getCommitFiles(repo, head), [{ path: 'a.txt', status: 'M' }, { path: 'b.md', status: 'M' }]);
  for (const mode of ['two', 'three']) {
    const c = await legacy.compareRefs(repo, 'HEAD~1', 'HEAD', mode);
    assert.deepEqual(c.files, [{ path: 'a.txt', status: 'M' }, { path: 'b.md', status: 'M' }], mode);
    assert.equal(c.ahead, 1); assert.equal(c.behind, 0);
  }
  git(repo, ['checkout', '-q', '--', 'a.txt']);
  git(repo, ['branch', 'other', 'HEAD~1']);
  assert.equal((await legacy.worktreeIsGcSafe(repo, 'main')).gc, true, 'clean and 0 ahead of itself');
  git(repo, ['checkout', '-q', 'other']);
  assert.equal((await legacy.worktreeIsGcSafe(repo, 'main')).gc, true, 'other is reachable from main');
  git(repo, ['checkout', '-q', 'main']);
  assert.deepEqual((await legacy.worktreeIsGcSafe(repo, 'other')).gc, false, 'main is ahead of other and its tree differs');
  assert.equal(ext.ran() || cmd.ran() || conv.ran(), false, 'no external diff driver and no textconv ran');
});

test('GC8 every legacy git call carries the inert signature config (command-scope config in its environment); legacy hive.ts resolves git through gitBinary.ts (never `git` by name)', () => {
  const { inertSignatureConfig, configEnv, NO_DIFF_DRIVERS, gitBinaryCandidates, resolveGitBinary } = loadTs('src/main/gitBinary.ts');
  const bin = 'C:\\Program Files\\Git\\cmd\\git.exe';
  assert.deepEqual(inertSignatureConfig(bin), [['log.showSignature', 'false'], ['gpg.program', bin], ['gpg.ssh.program', bin], ['gpg.x509.program', bin]]);
  assert.deepEqual(configEnv([['a.b', '1'], ['c.d', '2']], {}), { GIT_CONFIG_KEY_0: 'a.b', GIT_CONFIG_VALUE_0: '1', GIT_CONFIG_KEY_1: 'c.d', GIT_CONFIG_VALUE_1: '2', GIT_CONFIG_COUNT: '2' });
  assert.deepEqual(configEnv([['a.b', '1']], { GIT_CONFIG_COUNT: '2' }), { GIT_CONFIG_KEY_2: 'a.b', GIT_CONFIG_VALUE_2: '1', GIT_CONFIG_COUNT: '3' }, 'a caller\'s own entries are kept');
  assert.deepEqual([...NO_DIFF_DRIVERS], ['--no-ext-diff', '--no-textconv']);
  const gitTs = fs.readFileSync(path.join(ROOT, 'src/main/git.ts'), 'utf8');
  assert.match(gitTs, /let env: NodeJS\.ProcessEnv = \{ \.\.\.process\.env, \.\.\.configEnv\(inertSignatureConfig\(bin\)\) \};/, 'runGit gives it to every call');
  assert.match(gitTs, /env = \{ \.\.\.env, \.\.\.FILTER_SAFE_ENV \};/, 'a filtering call keeps it');
  assert.match(gitTs, /shell: false, env \}\);/);
  for (const m of gitTs.matchAll(/runGit\([^,]+, \[\s*'(diff|diff-tree|show)'([^\]]*)\]/g)) {
    if (m[1] === 'show' && /'-s'/.test(m[2])) continue;                  // resolveCommit: `show -s` produces no diff
    assert.match(m[2], /^, \.\.\.NO_DIFF_DRIVERS/, `${m[1]}${m[2]}`);
  }
  assert.equal((gitTs.match(/'log', '--no-show-signature'/g) || []).length, 2, 'getLog and getLogGraph also say so in their argv');
  // hive.ts: one synchronous git spawn, by the binary gitBinary.ts's candidates resolve to.
  const hive = fs.readFileSync(path.join(ROOT, 'src/main/hive.ts'), 'utf8');
  assert.doesNotMatch(hive, /spawn(Sync)?\(\s*['"`]git(\.exe)?['"`]/);
  assert.match(hive, /import \{ gitBinaryCandidates \} from '\.\/gitBinary';/);
  assert.match(hive, /spawnSync\(bin, \['-c', 'commit\.gpgsign=false'/);
  // The candidate list is resolveGitBinary's own order (one rule for both).
  const env = { PATH: 'C:\\Tools;relative;C:\\Program Files\\Git\\cmd', ProgramFiles: 'C:\\Program Files', LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' };
  const cands = gitBinaryCandidates({ env, platform: 'win32' });
  assert.deepEqual(cands.slice(0, 2), ['C:\\Tools\\git.exe', 'C:\\Program Files\\Git\\cmd\\git.exe']);
  return (async () => {
    const seen = [];
    await resolveGitBinary({ stat: async (p) => { seen.push(p); throw new Error('absent'); } }, { env, platform: 'win32' });
    assert.deepEqual(seen, cands);
  })();
});
