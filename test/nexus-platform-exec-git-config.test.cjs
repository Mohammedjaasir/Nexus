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
