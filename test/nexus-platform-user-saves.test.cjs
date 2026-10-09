'use strict';
// B1 Task 5: user saves. A project commit or a small text file becomes an artifact version, read and verified in
// main through injected ports. Real SQLite, real temp git repos made here (the posture ratchet scans src/main only).
const h = require('./helpers/sqlite.cjs');
if (!h.realSqliteOrSkip()) return;
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const loadTs = require('./load-ts.cjs');
const { PersistStore } = loadTs('src/main/db.ts');
const { createNexusPlatform } = loadTs('src/main/nexus/platform.ts');
const { UserSaves, TEXT_FILE_MAX_BYTES, SENSITIVE_NAMES } = loadTs('src/main/nexus/commands/userSaves.ts');
const { createSourcePorts, relSegments } = loadTs('src/main/nexusIpc/sources.ts');
const { resolveAllowedRoot } = loadTs('src/main/fsRoots.ts');
const { canonicalJson } = loadTs('src/main/nexus/db/canonical.ts');
const { verifyActivityChain } = loadTs('src/main/nexus/activity/writer.ts');

const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', ...args],
  { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

/** A v8 store whose p-ledger root is a fresh temp git repo with one commit; real ports over it. */
async function setupRepo(opts = {}) {
  const { file } = h.v6Fixture(); const s = new PersistStore(file);
  s.open({ log: () => {}, backupDir: path.join(path.dirname(file), 'b'), now: () => h.NOW });
  const db = s.platformDatabase(); const nx = createNexusPlatform(db, { now: () => h.NOW });
  const root = h.tmpDir('nx-repo-');
  if (opts.git !== false) {
    git(root, 'init', '-q');
    fs.writeFileSync(path.join(root, 'README.md'), '# readme\n');
    git(root, 'add', 'README.md');
    git(root, 'commit', '-q', '-m', opts.subject ?? 'First commit');
  }
  db.prepare('UPDATE projects SET root_path = ? WHERE id = ?').run(root, 'p-ledger');
  const getProject = (id) => { const r = db.prepare('SELECT root_path FROM projects WHERE id = ?').get(id); return r ? { rootPath: r.root_path } : null; };
  const acceptFsRoot = (r) => resolveAllowedRoot(r, [root], fs.realpathSync.native);
  const ports = createSourcePorts({ acceptFsRoot, getProject });
  const saves = new UserSaves(nx, opts.wrap ? opts.wrap(ports) : ports);
  const head = opts.git !== false ? git(root, 'rev-parse', 'HEAD') : null;
  return { s, db, nx, me: nx.principals.localUser(), saves, ports, root, head };
}
function done(s, db) { assert.equal(verifyActivityChain(db).ok, true, 'activity chain verifies'); s.close(); }
const count = (db, sql, ...args) => db.prepare(`SELECT COUNT(*) AS n FROM ${sql}`).get(...args).n;
const reasonOf = async (pr) => { const e = await pr.then(() => null, (x) => x); assert.ok(e, 'expected a refusal'); return [e.code, e.detail?.reason]; };
const fileSave = (relPath, target = { name: 'x' }, workspaceId = 'sde') => ({ projectId: 'p-ledger', workspaceId, relPath, target });
/** Ports that count every call. */
const spy = (calls) => (ports) => ({
  projectRoot: (...a) => { calls.push('projectRoot'); return ports.projectRoot(...a); },
  readFile: (...a) => { calls.push('readFile'); return ports.readFile(...a); },
  resolveCommit: (...a) => { calls.push('resolveCommit'); return ports.resolveCommit(...a); }
});

test('U1 a text file round-trips: the stored text is equal and contentHash is the sha256 of the canonical JSON', async () => {
  const { s, db, me, saves, root } = await setupRepo();
  fs.mkdirSync(path.join(root, 'docs'));
  const text = 'Line one\nUnicode: \u00e9\u00e8 \u2713\n';
  fs.writeFileSync(path.join(root, 'docs', 'notes.md'), text, 'utf8');
  const r = await saves.saveTextFile(me, fileSave('docs\\notes.md', { name: 'Notes' }));
  assert.deepEqual([r.created, r.artifact.kind, r.version.versionNo, r.version.status], [true, 'text_file', 1, 'draft']);
  assert.deepEqual(r.version.storage, { kind: 'inline', json: { path: 'docs/notes.md', text } });
  const expected = crypto.createHash('sha256').update(canonicalJson({ path: 'docs/notes.md', text }), 'utf8').digest('hex');
  assert.equal(r.version.contentHash, expected);
  assert.deepEqual(r.version.metadata, { source: 'project_file', path: 'docs/notes.md', bytes: Buffer.byteLength(text, 'utf8') });
  assert.equal(r.version.producedByAction, 'user.save_file');
  const stored = JSON.parse(db.prepare('SELECT storage_ref_json FROM artifact_versions WHERE id = ?').get(r.version.id).storage_ref_json);
  assert.equal(stored.json.text, text);
  // The service records the activity (two rows, one transaction); the command adds none.
  assert.deepEqual(db.prepare('SELECT action FROM activity WHERE artifact_id = ? ORDER BY seq').all(r.artifact.id).map((x) => x.action),
    ['artifact.create', 'version.register']);
  // A resend of the same file is deduped by the service.
  const again = await saves.saveTextFile(me, fileSave('./docs/notes.md', { name: 'Notes' }));
  assert.deepEqual([again.created, again.version.id], [false, r.version.id]);
  done(s, db);
});

test('U2 65,537 bytes is too_large; 40,000 double quotes (escaping overflow) is too_large with limit', async () => {
  const { s, db, me, saves, root } = await setupRepo();
  fs.writeFileSync(path.join(root, 'big.txt'), 'x'.repeat(TEXT_FILE_MAX_BYTES + 1));
  const e1 = await saves.saveTextFile(me, fileSave('big.txt')).catch((x) => x);
  assert.deepEqual([e1.code, e1.detail.reason, e1.detail.limit], ['invalid', 'too_large', 65536]);
  fs.writeFileSync(path.join(root, 'exact.txt'), 'word '.repeat((TEXT_FILE_MAX_BYTES - 100) / 5));
  assert.equal((await saves.saveTextFile(me, fileSave('exact.txt', { name: 'exact' }))).created, true, 'a file under the cap saves');
  fs.writeFileSync(path.join(root, 'quotes.txt'), '"'.repeat(40000));
  const e2 = await saves.saveTextFile(me, fileSave('quotes.txt', { name: 'q' })).catch((x) => x);
  assert.deepEqual([e2.code, e2.detail.reason, e2.detail.limit], ['invalid', 'too_large', 65536]);
  assert.match(e2.message, /stored file record/);
  // The port never reads more than maxBytes + 1.
  const r = await createSourcePorts({ acceptFsRoot: () => root, getProject: () => null }).readFile(root, 'big.txt', 10);
  assert.deepEqual(r, { error: 'too_large' });
  assert.equal(count(db, "artifacts WHERE name IN ('x', 'q')"), 0);
  done(s, db);
});

test('U3 a path that leaves the project through a junction is refused; nothing is written', async () => {
  const { s, me, saves, root, db } = await setupRepo();
  const outside = h.tmpDir('nx-out-'); fs.writeFileSync(path.join(outside, 'x.txt'), 'hi');
  fs.symlinkSync(outside, path.join(root, 'link'), 'junction');
  const e = await saves.saveTextFile(me, { projectId: 'p-ledger', workspaceId: 'sde', relPath: 'link/x.txt', target: { name: 'x' } }).catch((x) => x);
  assert.deepEqual([e.code, e.detail.reason], ['invalid', 'path_refused']);
  // A missing file behind the junction is refused too, not reported missing (no probing outside the project).
  assert.deepEqual(await reasonOf(saves.saveTextFile(me, fileSave('link/nope.txt'))), ['invalid', 'path_refused']);
  for (const bad of ['../x.txt', `${outside}${path.sep}x.txt`, path.join(outside, 'x.txt').replace(/\\/g, '/'), 'C:\\Windows\\win.ini',
    '\\\\server\\share\\x.txt', '/etc/passwd', 'docs/../../x.txt', 'a\0b', '.', '', '..', ...(process.platform === 'win32' ? ['README.md:stream'] : [])]) {
    assert.deepEqual(await reasonOf(saves.saveTextFile(me, fileSave(bad))), ['invalid', 'path_refused'], JSON.stringify(bad));
  }
  assert.deepEqual(await reasonOf(saves.saveTextFile(me, fileSave('missing.txt'))), ['invalid', 'file_not_found']);
  fs.mkdirSync(path.join(root, 'dir'));
  assert.deepEqual(await reasonOf(saves.saveTextFile(me, fileSave('dir'))), ['invalid', 'file_not_found']);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM artifacts').get().n, 0);
  // The pure segment check, on both platforms' rules.
  assert.deepEqual(relSegments('a\\b/./c'), ['a', 'b', 'c']);
  assert.equal(relSegments('a/../b'), null); assert.equal(relSegments('C:x'), null); assert.equal(relSegments('a:b', 'win32'), null);
  assert.deepEqual(relSegments('ab:c', 'linux'), ['ab:c']);
  done(s, db);
});

test('U4 invalid UTF-8, or a NUL, is not_text', async () => {
  const { s, db, me, saves, root } = await setupRepo();
  fs.writeFileSync(path.join(root, 'bin.txt'), Buffer.from([0x41, 0xff, 0xfe, 0x42]));
  fs.writeFileSync(path.join(root, 'zero.txt'), 'a\0b');
  fs.writeFileSync(path.join(root, 'half.txt'), Buffer.from([0x41, 0xe2, 0x82]));   // a truncated 3-byte sequence
  for (const f of ['bin.txt', 'zero.txt', 'half.txt']) assert.deepEqual(await reasonOf(saves.saveTextFile(me, fileSave(f))), ['invalid', 'not_text'], f);
  assert.equal(count(db, 'artifacts'), 0);
  done(s, db);
});

test('U5 a private-key header is secret_in_content; .env and deploy.pem are sensitive_name, refused before any read', async () => {
  const calls = [];
  const { s, db, me, saves, root } = await setupRepo({ wrap: spy(calls) });
  fs.writeFileSync(path.join(root, 'key.txt'), 'notes\n-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\n-----END RSA PRIVATE KEY-----\n');
  fs.writeFileSync(path.join(root, 'cfg.txt'), 'url = https://admin:hunter2hunter2@db.example.invalid/x\n');
  fs.writeFileSync(path.join(root, 'tok.txt'), 'ANTHROPIC=sk-ant-abcdefghijklmnopqrstuvwxyz0123\n');
  for (const f of ['key.txt', 'cfg.txt', 'tok.txt']) assert.deepEqual(await reasonOf(saves.saveTextFile(me, fileSave(f))), ['invalid', 'secret_in_content'], f);
  fs.writeFileSync(path.join(root, '.env'), 'A=1\n'); fs.writeFileSync(path.join(root, 'deploy.pem'), 'x');
  calls.length = 0;
  for (const f of ['.env', 'deploy.pem', 'sub/.env.local', 'id_rsa', 'id_ed25519.pub', 'server.KEY', 'cert.p12', 'c.pfx', '.npmrc', '.pypirc',
    '.netrc', 'credentials.json', 'vault.kdbx', 'sub\\.ENV']) {
    assert.deepEqual(await reasonOf(saves.saveTextFile(me, fileSave(f))), ['invalid', 'sensitive_name'], f);
  }
  assert.deepEqual(calls.filter((c) => c === 'readFile'), [], 'a sensitive name is refused before the file is read');
  assert.ok(SENSITIVE_NAMES.length >= 13);
  // Ordinary names that only look close are fine.
  for (const ok of ['environment.md', 'keys.md', 'pem-notes.txt']) {
    fs.writeFileSync(path.join(root, ok), 'plain\n');
    assert.equal((await saves.saveTextFile(me, fileSave(ok, { name: ok }))).created, true, ok);
  }
  assert.equal(count(db, "artifacts WHERE name = 'x'"), 0);
  done(s, db);
});

test('U6 a sha that is not a commit of this repo is refused; a real one is stored as git:<sha>', async () => {
  const { s, db, me, saves, head } = await setupRepo();
  const bad = await saves.saveCommit(me, { projectId: 'p-ledger', workspaceId: 'sde', commit: 'f'.repeat(40), target: { name: 'r' } }).catch((x) => x);
  assert.equal(bad.detail.reason, 'not_a_commit');
  const ok = await saves.saveCommit(me, { projectId: 'p-ledger', workspaceId: 'sde', commit: head, target: { name: 'r' } });
  assert.equal(ok.version.contentHash, `git:${head}`);
  assert.deepEqual(ok.version.storage, { kind: 'git', commit: head });
  assert.deepEqual([ok.artifact.kind, ok.version.producedByAction], ['git_commit', 'user.save_commit']);
  assert.equal(ok.version.metadata.source, 'git_commit'); assert.equal(ok.version.metadata.subject, 'First commit');
  assert.ok(Number.isSafeInteger(ok.version.metadata.committedAt) && ok.version.metadata.committedAt > 1e12, 'commit time in ms');
  // Only a full lowercase sha is accepted from the caller; option- or range-shaped text never reaches git.
  for (const c of [head.slice(0, 7), head.toUpperCase(), 'HEAD', '--all', `${head}..HEAD`, `${head}^`, '']) {
    assert.deepEqual(await reasonOf(saves.saveCommit(me, { projectId: 'p-ledger', workspaceId: 'sde', commit: c, target: { name: 'r2' } })), ['invalid', 'not_a_commit'], c);
  }
  assert.equal(count(db, "artifacts WHERE name = 'r2'"), 0);
  done(s, db);
});

test('U6b a tree sha is not a commit; a secret-shaped subject is dropped from the metadata, never fatal', async () => {
  const { s, db, me, saves, root } = await setupRepo({ subject: 'deploy with token sk-ant-abcdefghijklmnopqrstuvwxyz0123' });
  const tree = git(root, 'rev-parse', 'HEAD^{tree}');
  assert.deepEqual(await reasonOf(saves.saveCommit(me, { projectId: 'p-ledger', workspaceId: 'sde', commit: tree, target: { name: 't' } })), ['invalid', 'not_a_commit']);
  const head = git(root, 'rev-parse', 'HEAD');
  const ok = await saves.saveCommit(me, { projectId: 'p-ledger', workspaceId: 'sde', commit: head, target: { name: 'r' } });
  assert.equal(ok.created, true);
  assert.equal('subject' in ok.version.metadata, false, 'the subject is dropped');
  assert.doesNotMatch(db.prepare('SELECT metadata_json FROM artifact_versions WHERE id = ?').get(ok.version.id).metadata_json, /sk-ant/);
  done(s, db);
});

test('U7 a folder that is not a repository is not_a_repository', async () => {
  const { s, db, me, saves } = await setupRepo({ git: false });
  assert.deepEqual(await reasonOf(saves.saveCommit(me, { projectId: 'p-ledger', workspaceId: 'sde', commit: 'a'.repeat(40), target: { name: 'r' } })),
    ['invalid', 'not_a_repository']);
  assert.equal(count(db, 'artifacts'), 0);
  done(s, db);
});

test('U8 a deleted project folder, or one acceptFsRoot refuses, is project_folder_unavailable', async () => {
  const { s, db, me, saves, root, head, nx } = await setupRepo();
  fs.rmSync(root, { recursive: true, force: true });
  assert.deepEqual(await reasonOf(saves.saveCommit(me, { projectId: 'p-ledger', workspaceId: 'sde', commit: head, target: { name: 'r' } })),
    ['invalid', 'project_folder_unavailable']);
  assert.deepEqual(await reasonOf(saves.saveTextFile(me, fileSave('README.md'))), ['invalid', 'project_folder_unavailable']);
  // The folder comes from the stored row only, accepted by acceptFsRoot: a refusing acceptFsRoot gives the same answer.
  const refusing = new UserSaves(nx, createSourcePorts({ acceptFsRoot: () => null, getProject: () => ({ rootPath: h.tmpDir('nx-x-') }) }));
  assert.deepEqual(await reasonOf(refusing.saveTextFile(me, fileSave('README.md'))), ['invalid', 'project_folder_unavailable']);
  const noRow = new UserSaves(nx, createSourcePorts({ acceptFsRoot: (r) => r, getProject: () => null }));
  assert.deepEqual(await reasonOf(noRow.saveTextFile(me, fileSave('README.md'))), ['invalid', 'project_folder_unavailable']);
  assert.equal(count(db, 'artifacts'), 0);
  done(s, db);
});

test('U9 a denied principal gets denied before any port call', async () => {
  const calls = [];
  const { s, db, saves, head, root } = await setupRepo({ wrap: spy(calls) });
  fs.writeFileSync(path.join(root, 'n.txt'), 'hello\n');
  db.prepare("INSERT INTO principals VALUES ('user:stranger','user','stranger',NULL,?)").run(h.NOW);
  const stranger = { id: 'user:stranger', kind: 'user', displayName: 'stranger' };
  const denied0 = count(db, "activity WHERE status = 'denied'");
  assert.equal((await reasonOf(saves.saveTextFile(stranger, fileSave('n.txt'))))[0], 'denied');
  assert.equal((await reasonOf(saves.saveTextFile(stranger, fileSave('.env'))))[0], 'denied', 'denied before the name check too');
  assert.equal((await reasonOf(saves.saveCommit(stranger, { projectId: 'p-ledger', workspaceId: 'sde', commit: head, target: { name: 'r' } })))[0], 'denied');
  assert.equal((await reasonOf(saves.saveCommit(stranger, { projectId: 'p-nope', workspaceId: 'sde', commit: head, target: { name: 'r' } })))[0], 'denied');
  assert.equal(calls.length, 0, 'no port was called');
  assert.equal(count(db, "activity WHERE status = 'denied'"), denied0 + 4);
  assert.equal(count(db, 'artifacts'), 0);
  done(s, db);
});

test('U10 appending to a text_file artifact gives v2; appending a text file to a git_commit artifact is kind_mismatch', async () => {
  const { s, db, me, saves, root, head } = await setupRepo();
  fs.writeFileSync(path.join(root, 'n.txt'), 'one\n');
  const v1 = await saves.saveTextFile(me, fileSave('n.txt', { name: 'Notes' }));
  fs.writeFileSync(path.join(root, 'n.txt'), 'two\n');
  const v2 = await saves.saveTextFile(me, fileSave('n.txt', { artifactId: v1.artifact.id }));
  assert.deepEqual([v2.created, v2.version.versionNo, v2.artifact.id, v2.version.storage.json.text], [true, 2, v1.artifact.id, 'two\n']);
  const c = await saves.saveCommit(me, { projectId: 'p-ledger', workspaceId: 'sde', commit: head, target: { name: 'Release' } });
  assert.deepEqual(await reasonOf(saves.saveTextFile(me, fileSave('n.txt', { artifactId: c.artifact.id }))), ['invalid', 'kind_mismatch']);
  assert.equal(count(db, 'artifact_versions WHERE artifact_id = ?', c.artifact.id), 1);
  // A malformed target is invalid before any I/O.
  assert.equal((await reasonOf(saves.saveTextFile(me, fileSave('n.txt', { name: 'a', artifactId: c.artifact.id }))))[0], 'invalid');
  done(s, db);
});

test('U11 a participation withdrawn while the port is awaiting gives not_participating, and nothing is written', async () => {
  let release; const gate = new Promise((r) => { release = r; });
  let entered; const reached = new Promise((r) => { entered = r; });
  const wrap = (ports) => ({ ...ports, readFile: async (...a) => { entered(); await gate; return ports.readFile(...a); },
    resolveCommit: async (...a) => { entered(); await gate; return ports.resolveCommit(...a); } });
  const { s, db, nx, me, saves, root } = await setupRepo({ wrap });
  fs.writeFileSync(path.join(root, 'n.txt'), 'hello\n');
  const qa = nx.workspaces.attach(me, 'p-ledger', 'qa');
  const a0 = count(db, 'artifacts'); const act0 = count(db, 'activity');
  const pending = saves.saveTextFile(me, fileSave('n.txt', { name: 'QA notes' }, 'qa')).then(() => null, (x) => x);
  await reached;
  nx.workspaces.withdraw(me, qa.id);
  const act1 = count(db, 'activity');
  release();
  const e = await pending;
  assert.ok(e, 'the save is refused');
  assert.equal(e.code, 'not_participating');
  assert.equal(count(db, 'artifacts'), a0);
  assert.equal(count(db, 'activity'), act1, 'the refused save writes no activity row');
  assert.ok(act1 > act0);
  done(s, db);
});

test('U11b an artifact frozen while the port is awaiting refuses the append with participation_inactive', async () => {
  let release = () => {}; let gate = Promise.resolve();
  const wrap = (ports) => ({ ...ports, resolveCommit: async (...a) => { await gate; return ports.resolveCommit(...a); } });
  const { s, db, nx, me, saves, root, head } = await setupRepo({ wrap });
  const qa = nx.workspaces.attach(me, 'p-ledger', 'qa');
  const first = await saves.saveCommit(me, { projectId: 'p-ledger', workspaceId: 'qa', commit: head, target: { name: 'QA build' } });
  fs.writeFileSync(path.join(root, 'b.txt'), 'b'); git(root, 'add', 'b.txt'); git(root, 'commit', '-q', '-m', 'second');
  const second = git(root, 'rev-parse', 'HEAD');
  gate = new Promise((r) => { release = r; });
  const pending = saves.saveCommit(me, { projectId: 'p-ledger', workspaceId: 'qa', commit: second, target: { artifactId: first.artifact.id } }).then(() => null, (x) => x);
  await new Promise((r) => setImmediate(r));
  nx.workspaces.withdraw(me, qa.id);
  release();
  const e = await pending;
  assert.equal(e?.code, 'participation_inactive');
  assert.equal(count(db, 'artifact_versions WHERE artifact_id = ?', first.artifact.id), 1);
  done(s, db);
});

test('U12 git.ts and sources.ts make no synchronous call; userSaves.ts imports no fs, child_process or electron', () => {
  const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
  for (const f of ['src/main/git.ts', 'src/main/nexusIpc/sources.ts']) assert.doesNotMatch(read(f), /Sync\(/, f);
  const core = read('src/main/nexus/commands/userSaves.ts');
  assert.doesNotMatch(core, /from ['"](node:)?(fs|fs\/promises|child_process|path)['"]|\brequire\(['"]|from ['"]electron['"]/);
  assert.doesNotMatch(core, /ipcMain|webContents/);
});

// ---------- Fix round 1 ----------
const { containsSecret, redactSecretText, hasLongToken } = loadTs('src/main/nexus/activity/redact.ts');
const { resolveCommit } = loadTs('src/main/git.ts');
/** 64 KiB of 'x-' (one run with 32,768 separators) and of runs with 127 separators each (just under the bound of 128). */
const XDASH = 'x-'.repeat(32768);
const runsOf = (unit, runLen, total) => { let s = ''; while (s.length < total) s += unit.repeat(runLen / unit.length) + ' '; return s.slice(0, total); };
const RUNS = runsOf('a-', 254, 65536);
const timed = (f) => { const t = process.hrtime.bigint(); const r = f(); return [r, Number(process.hrtime.bigint() - t) / 1e6]; };
const timedAsync = async (f) => { const t = process.hrtime.bigint(); const r = await f(); return [r, Number(process.hrtime.bigint() - t) / 1e6]; };

test('U13 ReDoS: a 64 KiB token-shaped input is answered in under 1 s by containsSecret, the user save, a job failure and a job create', async () => {
  // (b) containsSecret: a run with 128+ separators is secret-shaped at once; runs just under the bound are scanned, still fast.
  for (const [s, want] of [[XDASH, true], ['x-'.repeat(32760) + 'tok', true], ['a.'.repeat(32768), true], ['A+'.repeat(32768), true], [RUNS, false]]) {
    const [r, ms] = timed(() => containsSecret(s));
    assert.equal(r, want); assert.ok(ms < 1000, `containsSecret took ${ms} ms on ${JSON.stringify(s.slice(0, 12))} len ${s.length}`);
  }
  const [k, kms] = timed(() => containsSecret({ [XDASH.slice(0, 4096)]: 1 }));
  assert.equal(k, true, 'a long key is secret-shaped too'); assert.ok(kms < 1000);
  assert.equal(hasLongToken('-'.repeat(5000)), false, 'punctuation alone is not a token');
  assert.equal(hasLongToken(`b ${'a.'.repeat(127)}`), false); assert.equal(hasLongToken(`b ${'a.'.repeat(128)}`), true);
  assert.equal(hasLongToken('y'.repeat(65536)), false, 'a long run without separators is linear and stays allowed (B0b pins it)');
  const [yr, yms] = timed(() => containsSecret('y'.repeat(65536))); assert.equal(yr, false); assert.ok(yms < 1000);
  // redactSecretText redacts the long token before its regex passes.
  const [red, rms] = timed(() => redactSecretText(`failed: ${XDASH} end`));
  assert.equal(red, 'failed: [redacted] end'); assert.ok(rms < 1000);

  const { s, db, nx, me, saves, root } = await setupRepo();
  // (a) the user save: a 65,400-byte 'x-' file fits the record and is refused as secret-shaped, quickly.
  fs.writeFileSync(path.join(root, 'x.txt'), 'x-'.repeat(32700));
  const [e1, ms1] = await timedAsync(() => reasonOf(saves.saveTextFile(me, fileSave('x.txt'))));
  assert.deepEqual(e1, ['invalid', 'secret_in_content']); assert.ok(ms1 < 1000, `saveTextFile took ${ms1} ms`);
  fs.writeFileSync(path.join(root, 'runs.txt'), RUNS.slice(0, 65000));
  const [ok, ms2] = await timedAsync(() => saves.saveTextFile(me, fileSave('runs.txt', { name: 'runs' })));
  assert.equal(ok.created, true); assert.ok(ms2 < 1000, `saveTextFile took ${ms2} ms`);
  // (c) a job failure with a 64 KiB message: stored redacted, quickly.
  const sys = nx.principals.system();
  const j = nx.jobs.create(me, { kind: 'tool.run', projectId: 'p-ledger', workspaceId: 'sde', idempotencyKey: 'redos-1' }).job;
  nx.jobs.transition(sys, j.id, 'leased'); nx.jobs.transition(sys, j.id, 'running');
  const [failed, ms3] = timed(() => nx.jobs.transition(sys, j.id, 'failed', { error: { code: 'tool_error', message: XDASH } }));
  assert.equal(failed.state, 'failed'); assert.ok(ms3 < 1000, `transition took ${ms3} ms`);
  assert.equal(JSON.parse(db.prepare('SELECT error_json FROM jobs WHERE id = ?').get(j.id).error_json).message, '[redacted]');
  // (d) a job create with a 64 KiB-class params string: refused as secret-shaped, quickly; long runs pass.
  const createWith = (key, note) => () => {
    try { return nx.jobs.create(me, { kind: 'tool.run', projectId: 'p-ledger', workspaceId: 'sde', idempotencyKey: key, params: { note } }); } catch (x) { return x; }
  };
  const [pe, ms4] = timed(createWith('redos-2', 'x-'.repeat(32700)));
  assert.equal(pe?.detail?.reason, 'secret_in_params'); assert.ok(ms4 < 1000, `create took ${ms4} ms`);
  const [pc, ms5] = timed(createWith('redos-3', RUNS.slice(0, 65000)));
  assert.equal(pc.created, true); assert.ok(ms5 < 1000, `create took ${ms5} ms`);
  done(s, db);
});

test('U14 a hard link is refused as path_refused', async () => {
  const { s, db, me, saves, root } = await setupRepo();
  const outside = h.tmpDir('nx-hl-'); fs.writeFileSync(path.join(outside, 'secret.txt'), 'outside\n');
  fs.linkSync(path.join(outside, 'secret.txt'), path.join(root, 'linked.txt'));
  assert.deepEqual(await reasonOf(saves.saveTextFile(me, fileSave('linked.txt'))), ['invalid', 'path_refused']);
  // Two names inside the project are refused too: either may carry a sensitive name.
  fs.writeFileSync(path.join(root, 'a.txt'), 'a\n'); fs.linkSync(path.join(root, 'a.txt'), path.join(root, 'b.txt'));
  assert.deepEqual(await reasonOf(saves.saveTextFile(me, fileSave('b.txt'))), ['invalid', 'path_refused']);
  assert.equal(count(db, 'artifacts'), 0);
  done(s, db);
});

test('U15 C7: more key and credential names, any .git segment, and private-key or PuTTY content are refused', async () => {
  const calls = [];
  const { s, db, me, saves, root } = await setupRepo({ wrap: spy(calls) });
  for (const f of ['id_ecdsa', 'id_dsa.pub', 'ID_RSA', 'me.ppk', '.git-credentials', 'store.jks', 'app.keystore', 'c.P12', 'c.pfx', '.htpasswd',
    '.git/config', '.git/HEAD', 'sub/.git/config', '.GIT/config', '.git', 'a/.Git./x']) {
    assert.deepEqual(await reasonOf(saves.saveTextFile(me, fileSave(f))), ['invalid', 'sensitive_name'], f);
  }
  assert.deepEqual(calls.filter((c) => c === 'readFile'), []);
  const bodies = {
    'pgp.txt': '-----BEGIN PGP PRIVATE KEY BLOCK-----\nlQ\n',
    'ossh.txt': 'x\n-----BEGIN OPENSSH PRIVATE KEY-----\nb3Bl\n',
    'plain.txt': '-----BEGIN PRIVATE KEY-----\n',
    'putty.txt': 'PuTTY-User-Key-File-3: ssh-ed25519\nEncryption: none\n'
  };
  for (const [f, body] of Object.entries(bodies)) {
    fs.writeFileSync(path.join(root, f), body);
    assert.deepEqual(await reasonOf(saves.saveTextFile(me, fileSave(f))), ['invalid', 'secret_in_content'], f);
  }
  // A public key, and names that only mention git, are fine.
  fs.writeFileSync(path.join(root, 'pub.txt'), '-----BEGIN PUBLIC KEY-----\nMFkw\n-----END PUBLIC KEY-----\n');
  fs.writeFileSync(path.join(root, 'my.gitignore.md'), 'notes\n');
  fs.writeFileSync(path.join(root, '.gitignore'), 'node_modules\n');
  for (const f of ['pub.txt', 'my.gitignore.md', '.gitignore']) {
    assert.equal((await saves.saveTextFile(me, fileSave(f, { name: f }))).created, true, f);
  }
  assert.equal(count(db, "artifacts WHERE name = 'x'"), 0);
  done(s, db);
});

test('U16 a byte-order mark is stored faithfully; C0 controls other than tab, LF, FF and CR, and DEL, are not_text', async () => {
  const { s, db, me, saves, root } = await setupRepo();
  const bom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('hello\n')]);
  fs.writeFileSync(path.join(root, 'bom.txt'), bom);
  const r = await saves.saveTextFile(me, fileSave('bom.txt', { name: 'bom' }));
  assert.equal(r.version.storage.json.text.charCodeAt(0), 0xfeff);
  assert.ok(Buffer.from(r.version.storage.json.text, 'utf8').equals(bom), 'the stored text re-encodes to the file bytes');
  fs.writeFileSync(path.join(root, 'ws.txt'), 'a\tb\nc\r\nd\fe\n');
  assert.equal((await saves.saveTextFile(me, fileSave('ws.txt', { name: 'ws' }))).created, true);
  const controls = [0x01, 0x07, 0x08, 0x0b, 0x0e, 0x1b, 0x1f, 0x7f];
  for (const c of controls) {
    const f = `ctl${c}.txt`; fs.writeFileSync(path.join(root, f), Buffer.from([0x6f, 0x6b, c, 0x6f, 0x6b]));
    assert.deepEqual(await reasonOf(saves.saveTextFile(me, fileSave(f))), ['invalid', 'not_text'], String(c));
  }
  assert.equal(count(db, "artifacts WHERE name = 'x'"), 0);
  done(s, db);
});

test('U17 an annotated tag sha is peeled to its commit; same-name dedup; resolveCommit refuses option-shaped input directly', async () => {
  const { s, db, me, saves, root, head } = await setupRepo();
  git(root, 'tag', '-a', 'v1', '-m', 'release one');
  const tagSha = git(root, 'rev-parse', 'v1');
  assert.notEqual(tagSha, head);
  const r = await saves.saveCommit(me, { projectId: 'p-ledger', workspaceId: 'sde', commit: tagSha, target: { name: 'tagged' } });
  assert.deepEqual(r.version.storage, { kind: 'git', commit: head });
  assert.equal(r.version.contentHash, `git:${head}`);
  // Dedup: the same commit saved again under the same name returns the stored version.
  const again = await saves.saveCommit(me, { projectId: 'p-ledger', workspaceId: 'sde', commit: head, target: { name: 'tagged' } });
  assert.deepEqual([again.created, again.version.id, again.artifact.id], [false, r.version.id, r.artifact.id]);
  assert.equal(count(db, "artifacts WHERE name = 'tagged'"), 1);
  // Direct: option-, ref- and range-shaped input never reaches git as an option and is not a commit.
  const before = fs.readdirSync(root).sort();
  for (const bad of ['--output=pwned.txt', '-h', '--all', 'HEAD', 'v1', `${head}..HEAD`, `${head}^`, '', 'abc', `${head} --all`, '-'.repeat(8), 'g'.repeat(40)]) {
    assert.deepEqual(await resolveCommit(root, bad), { error: 'not_a_commit' }, JSON.stringify(bad));
  }
  assert.deepEqual(fs.readdirSync(root).sort(), before, 'nothing was written in the repository');
  const full = await resolveCommit(root, head);
  assert.deepEqual(await resolveCommit(root, head.slice(0, 12)), full);
  assert.equal(full.commit, head);
  done(s, db);
});

test('U18 a file symlink to a sensitive name inside the project is sensitive_name (by its real name)', async () => {
  const { s, db, me, saves, root, nx } = await setupRepo();
  fs.writeFileSync(path.join(root, '.env.local'), 'A=1\n');
  let linked = true;
  try { fs.symlinkSync(path.join(root, '.env.local'), path.join(root, 'innocent.txt'), 'file'); } catch (e) {
    if (process.platform !== 'win32' || e.code !== 'EPERM') throw e;
    linked = false;   // Windows without the symlink privilege: the port-level check below still runs.
  }
  if (linked) assert.deepEqual(await reasonOf(saves.saveTextFile(me, fileSave('innocent.txt'))), ['invalid', 'sensitive_name']);
  // The command checks the REAL name the port reports, whatever the requested name was.
  const fake = { projectRoot: async () => root, resolveCommit: async () => ({ error: 'not_a_commit' }),
    readFile: async () => ({ bytes: Buffer.from('A=1\n'), normalisedRel: 'cfg/.env.local' }) };
  assert.deepEqual(await reasonOf(new UserSaves(nx, fake).saveTextFile(me, fileSave('innocent.txt'))), ['invalid', 'sensitive_name']);
  const viaGit = { ...fake, readFile: async () => ({ bytes: Buffer.from('x\n'), normalisedRel: '.git/config' }) };
  assert.deepEqual(await reasonOf(new UserSaves(nx, viaGit).saveTextFile(me, fileSave('innocent.txt'))), ['invalid', 'sensitive_name']);
  assert.equal(count(db, 'artifacts'), 0);
  done(s, db);
});

test('U19 Windows aliases: trailing dots and spaces, long-path and device-namespace prefixes, and device names are refused', async () => {
  const { s, db, me, saves, root } = await setupRepo();
  fs.writeFileSync(path.join(root, 'notes.txt'), 'hello\n');
  // On every platform: device-namespace and long-path prefixes are absolute.
  const BS = '\\';
  for (const bad of [`${BS}${BS}?${BS}C:${BS}Windows${BS}win.ini`, `${BS}${BS}.${BS}C:${BS}Windows${BS}win.ini`, `${BS}${BS}.${BS}PhysicalDrive0`,
    '//?/C:/x', `${BS}${BS}?${BS}UNC${BS}server${BS}share${BS}x`]) {
    assert.deepEqual(await reasonOf(saves.saveTextFile(me, fileSave(bad))), ['invalid', 'path_refused'], bad);
  }
  // The win32 rules, checked on the pure segment function on any platform.
  for (const bad of ['notes.txt.', 'notes.txt ', 'notes.txt. .', 'sub./x', 'CON', 'nul', 'NUL.txt', 'aux.md', 'com1', 'LPT9.log', 'a/CON/b', 'conin$', 'COM\u00b9', 'con .txt', 'nul .txt', 'CON  .log', 'a/aux .md']) {
    assert.equal(relSegments(bad, 'win32'), null, JSON.stringify(bad));
  }
  assert.deepEqual(relSegments('console.txt', 'win32'), ['console.txt']);
  assert.deepEqual(relSegments('notes.txt.', 'linux'), ['notes.txt.']);
  // Through the real port on this platform: on win32 each alias is refused before the disk is touched.
  if (process.platform === 'win32') {
    for (const bad of ['notes.txt.', 'notes.txt ', 'NUL', 'con.txt']) {
      assert.deepEqual(await reasonOf(saves.saveTextFile(me, fileSave(bad))), ['invalid', 'path_refused'], JSON.stringify(bad));
    }
    fs.writeFileSync(path.join(root, '.env'), 'A=1\n');
    for (const bad of ['.env.', '.env ', '.ENV. ']) {
      assert.deepEqual(await reasonOf(saves.saveTextFile(me, fileSave(bad))), ['invalid', 'sensitive_name'], JSON.stringify(bad));
    }
  }
  assert.equal(count(db, 'artifacts'), 0);
  done(s, db);
});

test('U20 a huge sparse file is refused as too_large without being read', async () => {
  const { s, db, me, saves, root, ports } = await setupRepo();
  const big = path.join(root, 'huge.log');
  const fd = fs.openSync(big, 'w'); fs.ftruncateSync(fd, 4 * 1024 ** 3); fs.closeSync(fd);
  const mem0 = process.memoryUsage().arrayBuffers;
  const [r, ms] = await timedAsync(() => reasonOf(saves.saveTextFile(me, fileSave('huge.log'))));
  assert.deepEqual(r, ['invalid', 'too_large']); assert.ok(ms < 1000, `took ${ms} ms`);
  const [p, pms] = await timedAsync(() => ports.readFile(root, 'huge.log', TEXT_FILE_MAX_BYTES));
  assert.deepEqual(p, { error: 'too_large' }); assert.ok(pms < 1000);
  assert.ok(process.memoryUsage().arrayBuffers - mem0 < 16 * 1024 * 1024, 'no large buffer was allocated');
  fs.rmSync(big, { force: true });
  assert.equal(count(db, 'artifacts'), 0);
  done(s, db);
});
