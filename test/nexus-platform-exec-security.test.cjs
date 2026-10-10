'use strict';
// B2a Task 13: the security sweep (user constraint 11). Every case goes through the nexus:* handlers or the services they
// call, with the real AuthService; where a principal matters, a restricted test principal is the test's local user (the
// wrapper resolves it exactly as main resolves the local user). No permission check is bypassed: nothing is mocked in
// authorization, and the database's own CHECKs and triggers are exercised with raw SQL only to show they refuse.
// Groups: S1 unauthorized job execution, S2 unauthorized file access, S3 path traversal, S4 access outside the workspace,
// S5 invalid artifact or job references, S6 secret exposure, S7 approval bypass, S8 network policy bypass, S9 malformed
// tool requests. The cases proven elsewhere (real Docker K4/K6/K7/K9/K10 behind the test:exec gate, the runner's D8/D11/D17,
// the schema's T8/T15, the JUnit J6-J11, the protocol RP1-RP6) are re-run here where they are cheap and indexed by title.
// Real SQLite (test:db); a fake runner; no Docker.
const h = require('./helpers/sqlite.cjs');
if (!h.realSqliteOrSkip()) return;
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const loadTs = require('./load-ts.cjs');
const { execWorld, GIB } = require('./helpers/execWorld.cjs');
const { ipcOver, asLocalUser, noLeak, intent } = require('./helpers/ipcExec.cjs');
const { allOrphans, ALL_ZERO } = require('./helpers/orphans.cjs');
const { verifyActivityChain } = loadTs('src/main/nexus/activity/writer.ts');
const { ALLOWED_ENV_NAMES } = loadTs('src/main/nexus/exec/planBuilder.ts');
const { parseRunnerMessage, RUNNER_OPS } = loadTs('src/shared/nexus/runnerProtocol.ts');
const { parseJunit } = loadTs('src/runner/parsers/junit.ts');
const appManifest = loadTs('src/main/nexus/validation/validators/appManifestSchema.ts');
const { canonicalJson } = loadTs('src/main/nexus/db/canonical.ts');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const UNKNOWN = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
const LOCK = '3f'.repeat(32);
const TOKEN = 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789';
const MANIFEST = { version: 1, profile: 'sde-node', run: ['node', 'dist/server.js'], port: 3000, healthPath: '/health', env: [] };
const start = (w, patch = {}) => ({ projectId: 'p-ledger', workspaceId: 'sde', actionId: 'sde.tests.discover',
  inputs: [{ versionId: w.repoV, slot: 'repository' }], params: {}, intentId: intent(), ...patch });
const denials = (w) => w.db.prepare("SELECT COUNT(*) n FROM activity WHERE status = 'denied'").get().n;
const counts = (w) => ['jobs', 'job_attempts', 'approvals', 'deployments', 'artifacts', 'artifact_versions', 'validations', 'image_builds']
  .map((t) => w.db.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n);
function healthy(w, o = {}) {
  assert.deepEqual(allOrphans(w.db, o), ALL_ZERO);
  assert.deepEqual(w.db.prepare('PRAGMA foreign_key_check').all(), []);
  assert.equal(w.db.pragma('integrity_check', { simple: true }), 'ok');
  assert.equal(verifyActivityChain(w.db).ok, true);
}
/** A job leased to the fake runner: its attempt 1 exists with its stored log path. */
function leasedJob(w, x) {
  const r = w.attach();
  const j = w.exec.start(w.me, w.req('sde.tests.discover')).job;
  w.exec.tick(w.now());
  return { r, j, a: w.liveAttempt(j.id) };
}
const egressWorld = () => execWorld({ approvals: 'real', repoMeta: { lockfile: { sha256: LOCK } }, dockerMemoryBytes: 64 * GIB });

// =====================================================================================================================
// S1 unauthorized job execution
// =====================================================================================================================

test('S1a a viewer cannot start, cancel or retry a job: denied with exactly one audit row each, nothing created', async () => {
  const w = execWorld();
  const x = ipcOver(w);
  const { j } = leasedJob(w);
  const viewer = w.addUser('u-viewer', 'project', 'p-ledger', 'viewer');
  const restore = asLocalUser(w.nx, viewer);
  const before = counts(w);
  for (const [ch, args] of [['nexus:job:start', [start(w)]], ['nexus:job:cancel', [j.id]], ['nexus:job:retry', [j.id, intent()]]]) {
    const d0 = denials(w);
    await x.refused(ch, args, 'denied');
    assert.equal(denials(w) - d0, 1, `${ch}: one audit row`);
  }
  // A viewer may read (job.read), so the job list answers.
  assert.equal((await x.ok('nexus:jobs:list', { projectId: 'p-ledger' })).length >= 1, true);
  restore();
  assert.deepEqual(counts(w), before);
  assert.equal(w.jobState(j.id), 'leased', 'the viewer\'s cancel changed nothing');
  w.close();
});

test('S1b a workspace the project does not take part in is not_participating; a withdrawn participation is participation_inactive', async () => {
  const w = execWorld();
  const x = ipcOver(w);
  await x.refused('nexus:job:start', [start(w, { workspaceId: 'ml' })], 'not_participating');
  const pw = w.nx.workspaces.attach(w.me, 'p-ledger', 'qa');
  w.nx.workspaces.withdraw(w.me, pw.id);
  await x.refused('nexus:job:start', [start(w, { workspaceId: 'qa' })], 'participation_inactive');
  assert.equal(w.db.prepare('SELECT COUNT(*) n FROM jobs').get().n, 0);
  w.close();
});

test('S1c an action of a FUTURE step, of another domain, an inline or control action, or a system job kind is refused invalid; nothing runs', async () => {
  const w = execWorld();
  const x = ipcOver(w);
  w.nx.workspaces.attach(w.me, 'p-ledger', 'data');
  // No FUTURE step has an action (an id that would name one is unknown); validate and ingest are not actions.
  for (const actionId of ['sde.change.propose', 'sde.ai.implement', 'validate', 'ingest', 'sde.requirement.write', 'ml.problem.write']) {
    await x.refused('nexus:job:start', [start(w, { actionId, inputs: [] })], 'invalid', { reason: 'unknown_action' });
  }
  // A control action is not a job, even with its own params.
  await x.refused('nexus:job:start', [start(w, { actionId: 'sde.preview.stop', inputs: [], params: { deploymentId: UNKNOWN } })], 'invalid', { reason: 'unknown_action' });
  await x.refused('nexus:job:start', [start(w, { workspaceId: 'data' })], 'invalid', { reason: 'action_not_in_domain' });
  assert.equal(w.db.prepare('SELECT COUNT(*) n FROM jobs').get().n, 0);
  // The jobs filter reads validate jobs; nothing in the IPC layer creates one (checked by name in I-P4).
  assert.deepEqual(await x.ok('nexus:jobs:list', { jobKind: 'validate' }), []);
  w.close();
});

test('S1d the runner cannot create jobs or attempts (no such op), and a report for an unknown attempt is dropped', () => {
  const w = execWorld();
  const r = w.attach();
  for (const op of RUNNER_OPS) assert.doesNotMatch(op, /^(job|attempt)\.(create|start|insert|new)$/, op);
  const before = counts(w);
  for (const m of [{ op: 'job.create', projectId: 'p-ledger' }, { op: 'attempt.create', jobId: UNKNOWN },
    { op: 'attempt.exited', attemptId: UNKNOWN, exit: { code: 0, oomKilled: false, finishedAt: w.now() }, outputs: [], parsed: [], logBytes: 0 },
    { op: 'attempt.provisioned', attemptId: UNKNOWN }]) {
    assert.doesNotThrow(() => r.report(m));
  }
  assert.deepEqual(counts(w), before);
  assert.ok(w.logs.some((l) => /dropped runner message attempt\.(exited|provisioned)/.test(l)), w.logs.slice(-5).join('\n'));
  w.close();
});

test('S1e blob GC (#41) takes the full authorization path: a project owner who is not a platform admin is denied (audited) for the dry run and the apply; the admin\'s apply needs the dry run\'s hash', async () => {
  const w = execWorld();
  const x = ipcOver(w);
  const owner = w.addUser('u-proj-owner', 'project', 'p-ledger', 'owner');
  const restore = asLocalUser(w.nx, owner);
  for (const q of [{ apply: false }, { apply: true, expectedCandidatesHash: 'a'.repeat(64) }]) {
    const d0 = denials(w);
    await x.refused('nexus:blobs:gc', [q], 'denied');
    assert.equal(denials(w) - d0, 1, JSON.stringify(q));
  }
  restore();
  const dry = await x.ok('nexus:blobs:gc', { apply: false });
  assert.match(dry.candidatesHash, /^[0-9a-f]{64}$/); assert.equal(dry.removed, 0);
  await x.refused('nexus:blobs:gc', [{ apply: true, expectedCandidatesHash: 'b'.repeat(64) }], 'conflict', { reason: 'stale' });
  const applied = await x.ok('nexus:blobs:gc', { apply: true, expectedCandidatesHash: dry.candidatesHash });
  assert.deepEqual([applied.candidates, applied.fileDeleteFailed], [dry.candidates, 0]);
  w.close();
});

// =====================================================================================================================
// S2 unauthorized file access
// =====================================================================================================================

test('S2a job:logs reads only the stored log of a readable job, redacted again; a stranger is denied; no request names a location', async () => {
  const w = execWorld();
  const x = ipcOver(w);
  const { j, a } = leasedJob(w);
  assert.match(a.log_path, /^logs\/jobs\/[0-9A-Z]{26}\/1\.log$/);
  const abs = path.join(w.dataHome.root, a.log_path);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, `${JSON.stringify({ ts: 1, stream: 'stdout', text: 'hello' })}\n${JSON.stringify({ ts: 2, stream: 'stdout', text: `key ${TOKEN}` })}\n`);
  const page = await x.ok('nexus:job:logs', j.id, { attempt: 1, fromOffset: 0, maxBytes: 262144 });
  assert.match(page.text, /hello/); assert.doesNotMatch(page.text, /sk-ant-api03/); assert.equal(page.eof, true);
  await x.refused('nexus:job:logs', [j.id, { attempt: 2, fromOffset: 0, maxBytes: 10 }], 'not_found');
  // No schema takes a location: a path-like key is a bad request.
  for (const k of ['path', 'logPath', 'file', 'dir', 'root']) {
    await x.refused('nexus:job:logs', [j.id, { attempt: 1, fromOffset: 0, maxBytes: 10, [k]: '../x' }], 'invalid', { reason: 'bad_request', field: k });
  }
  const stranger = w.addUser('u-stranger', 'project', 'p-invoice', 'owner');
  const restore = asLocalUser(w.nx, stranger);
  const d0 = denials(w);
  await x.refused('nexus:job:logs', [j.id, { attempt: 1, fromOffset: 0, maxBytes: 10 }], 'denied');
  assert.equal(denials(w) - d0, 1);
  restore();
  w.close();
});

test('S2b a raw log_path of ../../x is refused by the CHECK; a junction placed in the data home pointing outside is refused at read', async () => {
  const w = execWorld();
  const x = ipcOver(w);
  const { j, a } = leasedJob(w);
  // The stored path is immutable once set (a trigger); a new row with a traversal is refused by the CHECK itself.
  assert.throws(() => w.db.prepare('UPDATE job_attempts SET log_path = ? WHERE id = ?').run('../../x', a.id), /immutable once set/);
  for (const bad of ['../../x', 'logs/../../x', '/etc/passwd', 'C:\\x.log', 'logs\\jobs\\x']) {
    assert.throws(() => w.db.prepare(`INSERT INTO job_attempts (id, job_id, n, state, boot_id, lease_owner, lease_expires_at, log_path, created_at, updated_at)
      VALUES (?, ?, 1, 'starting', ?, ?, ?, ?, ?, ?)`).run('att-bad', j.id, w.bootId, w.bootId, w.now() + 1000, bad, w.now(), w.now()), /CHECK constraint failed/, bad);
  }
  const outside = h.tmpDir('nx-outside-');
  fs.writeFileSync(path.join(outside, '1.log'), `${JSON.stringify({ ts: 1, stream: 'stdout', text: 'OUTSIDE-THE-HOME' })}\n`);
  const jobsDir = path.join(w.dataHome.root, 'logs', 'jobs');
  fs.mkdirSync(jobsDir, { recursive: true });
  fs.symlinkSync(outside, path.join(jobsDir, j.id), process.platform === 'win32' ? 'junction' : 'dir');
  assert.ok(fs.existsSync(path.join(jobsDir, j.id, '1.log')), 'the junction resolves on this machine');
  const r = await x.refused('nexus:job:logs', [j.id, { attempt: 1, fromOffset: 0, maxBytes: 4096 }], 'storage_unavailable', { reason: 'log_refused' });
  assert.doesNotMatch(JSON.stringify(r), /OUTSIDE-THE-HOME/);
  w.close();
});

test('S2c version:preview reads only the version\'s own stored content after artifact.read; a stranger is denied with one audit row', async () => {
  const w = execWorld();
  const x = ipcOver(w);
  const s = w.nx.artifacts.saveInline(w.me, { projectId: 'p-ledger', workspaceId: 'sde', kind: 'requirement', target: { name: 'Export' },
    content: { title: 'Ledger export', body: 'Export the ledger as CSV.', criteria: [{ id: 'AC1', text: 'A CSV file downloads' }] } });
  const page = await x.ok('nexus:version:preview', s.version.id, { part: 'content', maxBytes: 4096 });
  assert.match(page.text, /Ledger export/); assert.equal(page.nextPage, null);
  const small = await x.ok('nexus:version:preview', s.version.id, { part: 'content', maxBytes: 10 });
  assert.equal(small.nextPage, 1, 'paged');
  await x.refused('nexus:version:preview', [s.version.id, { part: 'manifest', maxBytes: 10 }], 'invalid', { reason: 'no_such_part' });
  const stranger = w.addUser('u-stranger', 'project', 'p-invoice', 'owner');
  const restore = asLocalUser(w.nx, stranger);
  const d0 = denials(w);
  await x.refused('nexus:version:preview', [s.version.id, { part: 'content', maxBytes: 10 }], 'denied');
  assert.equal(denials(w) - d0, 1);
  restore();
  w.close();
});

// =====================================================================================================================
// S3 path traversal
// =====================================================================================================================

test('S3a params with .., an absolute path, a drive, a UNC path, NUL, an ADS name or a trailing dot are bad_params; a subdir or outputDir parameter does not exist', async () => {
  const w = execWorld();
  const x = ipcOver(w);
  for (const v of ['..', '../x', '/etc', 'C:\\x', 'C:', '\\\\server\\share', 'a\u0000b', 'a:b', 'job.', 'a/b', 'a\\b']) {
    await x.refused('nexus:job:start', [start(w, { actionId: 'sde.diagnose', inputs: [], params: { target: 'job', targetId: v } })], 'invalid',
      { reason: 'bad_params' });
    for (const k of ['subdir', 'outputDir']) {
      await x.refused('nexus:job:start', [start(w, { params: { [k]: v } })], 'invalid', { reason: 'bad_params' });
    }
  }
  assert.equal(w.db.prepare('SELECT COUNT(*) n FROM jobs').get().n, 0);
  w.close();
});

test('S3b nexus.app.json with build.outputDir "../.." (or an env value) fails app.manifest_schema; version_blobs.path refuses a traversal (T8)', () => {
  for (const bad of [{ ...MANIFEST, build: { outputDir: '../..' } }, { ...MANIFEST, build: { outputDir: '/abs' } }, { ...MANIFEST, env: [{ name: 'TOKEN', value: TOKEN }] },
    { ...MANIFEST, env: { API_KEY: 'x' } }]) {
    const o = appManifest.run(bad);
    assert.equal(o.status, 'failed', JSON.stringify(bad));
  }
  assert.equal(appManifest.run(MANIFEST).status, 'passed');
  const w = execWorld();
  const draft = w.nx.artifacts.registerVersion(w.me, { artifactId: w.version(w.repoV).artifact_id, storage: { kind: 'git', commit: 'd'.repeat(40) }, metadata: {} }).version.id;
  w.db.prepare('INSERT INTO blobs (sha256, bytes, media_type, created_at, last_referenced_at) VALUES (?, 1, ?, ?, ?)').run('a'.repeat(64), 'text/plain', w.now(), w.now());
  for (const bad of ['../x', 'a/../b', '/abs', 'a\\b', '..', 'a/..']) {
    assert.throws(() => w.db.prepare("INSERT INTO version_blobs (version_id, sha256, role, path) VALUES (?, ?, 'file', ?)").run(draft, 'a'.repeat(64), bad),
      /CHECK constraint failed/, bad);
  }
  w.close();
});

// =====================================================================================================================
// S4 access outside the workspace
// =====================================================================================================================

test('S4a every container mount is a bind under the data home or a named Nexus volume; the project folder comes only from the projects row (acceptFsRoot)', async () => {
  const w = execWorld({ isRepository: async () => true });
  const x = ipcOver(w);
  const { r } = leasedJob(w);
  const plan = r.lastStart().plan;
  const home = path.resolve(w.dataHome.root);
  assert.ok(plan.container.mounts.length > 0);
  for (const m of plan.container.mounts) {
    if (path.isAbsolute(m.hostPath)) assert.ok(path.resolve(m.hostPath).startsWith(home + path.sep), `${m.kind} ${m.hostPath} not under ${home}`);
    else assert.match(m.hostPath, /^nexus-(ws|deps)-[A-Za-z0-9_.-]+$/, m.kind);
    assert.ok(!/docker\.sock/.test(m.hostPath));
  }
  // The snapshot's folder: the stored row through acceptFsRoot, never a request field.
  const root = w.db.prepare("SELECT root_path FROM projects WHERE id = 'p-ledger'").get().root_path;
  await x.refused('nexus:job:start', [{ ...start(w), root: 'C:\\Windows' }], 'invalid', { reason: 'bad_request', field: 'root' });
  await x.refused('nexus:job:start', [{ ...start(w), cwd: '/' }], 'invalid', { reason: 'bad_request', field: 'cwd' });
  const snap = await x.ok('nexus:job:start', start(w, { actionId: 'sde.repository.snapshot', inputs: [] }));
  w.exec.tick(w.now());
  const snapStart = r.sentOf('attempt.start').find((m) => m.jobId === snap.job.id || m.plan?.jobId === snap.job.id) ?? r.lastStart();
  assert.equal(snapStart.plan.task.repoPath, root, 'the plan carries the stored folder, as acceptFsRoot accepted it');
  assert.ok(w.fsRootCalls.includes(root));
  // The real-Docker proofs of the same constraint (writes to /, /etc, /usr fail; only the spec's mounts) run behind the test:exec gate.
  const sandbox = read('test/nexus-exec-sandbox.test.cjs');
  assert.match(sandbox, /test\('K4 disk: \/usr is read-only/); assert.match(sandbox, /test\('K6 mounts:/);
  w.close();
});

// =====================================================================================================================
// S5 invalid artifact or job references
// =====================================================================================================================

test('S5a unknown ids are not_found for the owner, malformed ids bad_request, and for a stranger every id is denied (no existence leak)', async () => {
  const w = execWorld();
  const x = ipcOver(w);
  const { j } = leasedJob(w);
  const idChannels = (id) => [['nexus:job:get', [id]], ['nexus:job:logs', [id, { attempt: 1, fromOffset: 0, maxBytes: 10 }]], ['nexus:job:cancel', [id]],
    ['nexus:job:retry', [id, intent()]], ['nexus:version:validations', [id]], ['nexus:version:revalidate', [id, intent()]],
    ['nexus:version:preview', [id, { part: 'content', maxBytes: 10 }]], ['nexus:deployment:stop', [id]], ['nexus:approval:respond', [id, 'deny']],
    ['nexus:actions:available', [{ projectId: 'p-ledger', workspaceId: 'sde', versionId: id }]]];
  for (const [ch, args] of idChannels(UNKNOWN)) await x.refused(ch, args, 'not_found');
  for (const bad of ['v-1', '', '01arz3ndektsv4rrffq69g5fav', `${UNKNOWN}0`, 42]) {
    for (const [ch, args] of idChannels(bad)) await x.refused(ch, args, 'invalid', { reason: 'bad_request' });
  }
  const stranger = w.addUser('u-stranger', 'project', 'p-invoice', 'owner');
  const restore = asLocalUser(w.nx, stranger);
  // The same answer for a real job of another project and for an id that does not exist: denied, audited once each.
  for (const id of [j.id, UNKNOWN]) {
    const d0 = denials(w);
    const r = await x.refused('nexus:job:get', [id], 'denied');
    assert.equal(denials(w) - d0, 1, `one audit row for ${id === UNKNOWN ? 'the unknown id' : 'the foreign job'}`);
    assert.doesNotMatch(JSON.stringify(r), new RegExp(j.id));
  }
  for (const [ch, args] of idChannels(w.repoV)) {
    if (ch === 'nexus:actions:available') continue;          // the project itself is denied first (below)
    await x.refused(ch, args, ch.startsWith('nexus:job') || ch === 'nexus:deployment:stop' || ch === 'nexus:approval:respond' ? 'denied' : 'denied');
  }
  await x.refused('nexus:actions:available', [{ projectId: 'p-ledger', workspaceId: 'sde' }], 'denied');
  restore();
  w.close();
});

test('S5b a draft input, a version of another project and a version of the wrong kind are invalid (input_not_allowed); nothing is created', async () => {
  const w = execWorld();
  const x = ipcOver(w);
  const draft = w.nx.artifacts.registerVersion(w.me, { artifactId: w.version(w.repoV).artifact_id, storage: { kind: 'git', commit: 'e'.repeat(40) }, metadata: {} }).version.id;
  const otherPw = w.nx.workspaces.primaryOf(w.me, 'p-invoice');
  const foreign = w.nx.artifacts.saveUserVersion(w.me, { projectId: 'p-invoice', workspaceId: otherPw.workspaceId, kind: 'text_file', target: { name: 'Notes' },
    storage: { kind: 'inline', json: { path: 'docs/notes.md', text: 'hi' } }, metadata: { source: 'project_file', path: 'docs/notes.md', bytes: 2 },
    action: 'user.save_file' }).version.id;
  for (const versionId of [draft, foreign, w.suiteV]) {
    await x.refused('nexus:job:start', [start(w, { inputs: [{ versionId, slot: 'repository' }] })], 'invalid', { reason: 'input_not_allowed' });
  }
  await x.refused('nexus:job:start', [start(w, { inputs: [{ versionId: w.repoV, slot: 'build' }] })], 'invalid', { reason: 'input_not_allowed' });
  assert.equal(w.db.prepare('SELECT COUNT(*) n FROM jobs').get().n, 0);
  // A version of another project in the actions query is refused, never described.
  await x.refused('nexus:actions:available', [{ projectId: 'p-ledger', workspaceId: 'sde', versionId: foreign }], 'invalid', { reason: 'other_project' });
  w.close();
});

// =====================================================================================================================
// S6 secret exposure
// =====================================================================================================================

test('S6a a secret in params or in inline content is refused before anything is stored; the refusal never echoes it', async () => {
  const w = execWorld();
  const x = ipcOver(w);
  const r1 = await x.refused('nexus:job:start', [start(w, { actionId: 'sde.diagnose', inputs: [], params: { target: 'job', targetId: TOKEN.replace(/[^A-Za-z0-9_-]/g, '') } })], 'invalid');
  assert.ok(['secret_in_params', 'bad_params'].includes(r1.reason), r1.reason);
  const r2 = await x.refused('nexus:artifact:saveInline', [{ projectId: 'p-ledger', workspaceId: 'sde', kind: 'requirement', target: { name: 'Export' },
    content: { title: 'Export', body: `use ${TOKEN}`, criteria: [{ id: 'AC1', text: 'x' }] } }], 'invalid', { reason: 'secret_in_metadata' });
  for (const r of [r1, r2]) assert.doesNotMatch(JSON.stringify(r), /sk-ant/);
  assert.equal(w.db.prepare("SELECT COUNT(*) n FROM artifacts WHERE kind = 'requirement'").get().n, 0);
  w.close();
});

test('S6b container env holds only allow-listed names and no secret value; an error text with a token is stored and shown redacted; no view holds a host path or a principal id', async () => {
  const w = execWorld();
  const x = ipcOver(w);
  const { r, j, a } = leasedJob(w);
  const env = r.lastStart().plan.container.env;
  for (const [k, v] of Object.entries(env)) {
    assert.ok(ALLOWED_ENV_NAMES.includes(k), k);
    assert.doesNotMatch(String(v), /sk-|ghp_|AKIA|BEGIN .*PRIVATE/);
  }
  // The runner refuses an /out entry whose name carries a token: main records the failure redacted.
  w.provision(r, j.id);
  r.report({ op: 'attempt.exited', attemptId: a.id, exit: { code: 0, oomKilled: false, finishedAt: w.now() }, outputs: [], parsed: [], logBytes: 0,
    outputError: 'unsafe_entry', outputErrorEntry: `out/${TOKEN}` });
  const raw = w.db.prepare('SELECT error_json FROM jobs WHERE id = ?').get(j.id).error_json ?? '';
  assert.doesNotMatch(raw, /sk-ant-api03-abcdef/, 'stored redacted');
  for (const tbl of ['activity', 'job_events']) {
    for (const row of w.db.prepare(`SELECT * FROM ${tbl}`).all()) assert.doesNotMatch(JSON.stringify(row), /sk-ant-api03-abcdef/, tbl);
  }
  const views = [await x.ok('nexus:job:get', j.id), await x.ok('nexus:jobs:list', {}), await x.ok('nexus:events:since', { sinceSeq: 0 }),
    await x.ok('nexus:activity:byProject', 'p-ledger'), await x.ok('nexus:platform:health'), await x.ok('nexus:actions:available', { projectId: 'p-ledger', workspaceId: 'sde' }),
    await x.ok('nexus:version:validations', w.suiteV), await x.ok('nexus:approvals:list', {}), await x.ok('nexus:deployments:list', {})];
  for (const v of views) {
    noLeak(v);
    assert.doesNotMatch(JSON.stringify(v), /sk-ant|ledger-api|C:\/work|"requestedBy"|"onBehalfOf"|"params"|"sandbox|"environment|log_?[pP]ath|"env"/);
  }
  w.close();
});

// =====================================================================================================================
// S7 approval bypass
// =====================================================================================================================

test('S7a an egress job never approved never receives a plan; job A\'s approval runs job A only; the system principal is denied; a second answer and an expired one are illegal; always is a bad request', async () => {
  const w = egressWorld();
  const r = w.attach();
  const x = ipcOver(w);
  const a = await x.ok('nexus:job:start', start(w, { actionId: 'sde.deps.install' }));
  const b = await x.ok('nexus:job:start', start(w, { actionId: 'sde.deps.install' }));
  w.exec.tick(w.now());
  assert.equal(w.jobState(a.job.id), 'awaiting_approval'); assert.equal(w.jobState(b.job.id), 'awaiting_approval');
  assert.equal(r.sentOf('attempt.start').length, 0, 'no plan before an approval');
  const pending = await x.ok('nexus:approvals:list', { status: 'pending' });
  const apA = pending.find((p) => p.jobId === a.job.id); const apB = pending.find((p) => p.jobId === b.job.id);
  assert.ok(apA && apB);
  assert.deepEqual([apA.request.recipeId, apA.request.lockfileSha256], ['sde.deps.node', LOCK]);
  await x.refused('nexus:approval:respond', [apA.id, 'always'], 'invalid', { reason: 'bad_request', field: 'decision' });
  // The system principal cannot answer for the user.
  const restore = asLocalUser(w.nx, w.sys);
  await x.refused('nexus:approval:respond', [apA.id, 'once'], 'denied');
  restore();
  // A's approval: A starts, B does not.
  const answered = await x.ok('nexus:approval:respond', apA.id, 'once');
  assert.deepEqual([answered.status, answered.decision], ['approved', 'once']);
  const starts = r.sentOf('attempt.start');
  assert.equal(starts.length, 1);
  assert.equal(starts[0].plan.container.network.approvalId, apA.id);
  assert.equal(w.liveAttempt(a.job.id).id, starts[0].attemptId);
  assert.equal(w.jobState(b.job.id), 'awaiting_approval');
  await x.refused('nexus:approval:respond', [apA.id, 'once'], 'illegal_transition');
  await x.refused('nexus:approval:respond', [apA.id, 'deny'], 'illegal_transition');
  // B's approval expires unanswered: the answer is illegal, B fails denied, B never got a plan.
  w.advance(16 * 60_000);
  await x.refused('nexus:approval:respond', [apB.id, 'once'], 'illegal_transition');
  assert.equal(w.jobState(b.job.id), 'failed');
  assert.equal(r.sentOf('attempt.start').filter((m) => m.plan?.container?.network?.approvalId === apB.id).length, 0);
  w.nx.approvals.expireDue(w.now());
  assert.deepEqual(allOrphans(w.db, { sweptAt: w.now() }).O21, 0, 'no pending approval past expiry after a sweep');
  w.close();
});

test('S7b an image build row without an approved, consumed approval is refused by the trigger (T15); prepareImage asks, it never builds', async () => {
  const w = execWorld();
  const now = w.now();
  const id = 'ap-image-1';
  w.db.prepare(`INSERT INTO approvals (id, project_id, job_id, session_id, reason, summary, request_json, request_sha256, status, requested_by, on_behalf_of,
      requested_at, expires_at, status_changed_at) VALUES (?, NULL, NULL, NULL, 'image.prepare', 's', ?, ?, 'pending', 'user:local', 'user:local', ?, ?, ?)`)
    .run(id, JSON.stringify({ profileId: 'sde-node', contextSha256: 'c'.repeat(64), baseDigest: 'sha256:' + 'b'.repeat(64), estimatedBytes: 1 }),
      crypto.createHash('sha256').update(canonicalJson({ profileId: 'sde-node' })).digest('hex'), now, now + 900_000, now);
  assert.throws(() => w.db.prepare(`INSERT INTO image_builds (id, profile_id, approval_id, status, context_sha256, base_digest, log_path, requested_by, started_at)
    VALUES ('ib-1', 'sde-node', ?, 'running', ?, ?, 'logs/images/ib-1.log', 'user:local', ?)`).run(id, 'c'.repeat(64), 'sha256:' + 'b'.repeat(64), now),
  /an image build needs an approved, consumed image.prepare approval/);
  assert.match(read('test/nexus-db-v9-schema.test.cjs'), /test\('T15: an image build needs an approved, consumed image\.prepare approval/);
  // Without an image context the request is refused before any row.
  const x = ipcOver(w);
  await x.refused('nexus:setup:prepareImage', ['sde-node', intent()], 'invalid', { reason: 'unknown_profile' });
  assert.equal(w.db.prepare('SELECT COUNT(*) n FROM image_builds').get().n, 0);
  w.close();
});

// =====================================================================================================================
// S8 network policy bypass
// =====================================================================================================================

test('S8a params naming a network, ports, an image, an argv or an env are bad requests; a none recipe always plans none (C22)', async () => {
  const w = execWorld();
  const x = ipcOver(w);
  for (const params of [{ network: 'bridge' }, { ports: '8080:80' }, { image: 'alpine' }, { argv: 'sh' }, { env: 'A=1' }, { egress: true }, { host: '0.0.0.0' }]) {
    await x.refused('nexus:job:start', [start(w, { params })], 'invalid', { reason: 'bad_request', field: 'params' });
  }
  const { r } = leasedJob(w);
  assert.deepEqual(r.lastStart().plan.container.network, { mode: 'none' });
  assert.match(read('test/nexus-platform-exec-scheduler.test.cjs'), /test\('C22 egress never appears in a plan without a consumed approval of this job/);
  w.close();
});

test('S8b the runner refuses an egress spec without the approval id (D17); preflight refuses an observed network other than the spec (PF2, K10); none cannot connect (K7); internal networks, forwarder on 127.0.0.1 (K9)', () => {
  // The runner's own check, run where it lives (src/runner/core.ts: network_not_approved before any container).
  const core = read('src/runner/core.ts');
  assert.match(core, /return this\.refuse\(a, 'network_not_approved', net\)/);
  const runnerTests = read('test/nexus-core-runner.test.cjs');
  assert.match(runnerTests, /test\('D17 egress-approved without an approval id, or with one main did not consume for this attempt, is /);
  // A plan without the approval id does not even parse as a main -> runner start for egress (C22 builds none; D17 refuses one).
  const preflightTests = fs.readdirSync(path.join(ROOT, 'test')).filter((f) => f.endsWith('.cjs')).map((f) => read(`test/${f}`)).join('\n');
  assert.match(preflightTests, /PF2/);
  const sandbox = read('test/nexus-exec-sandbox.test.cjs');
  for (const id of ['K7 network none: TCP to the host test server fails', 'K9 dev deployment: the app cannot reach the host; the forwarder binds 127.0.0.1 only',
    'K10 fault injection: --network bridge']) assert.ok(sandbox.includes(`test('${id}`), id);
  // The plan builder's forwarder publishes on 127.0.0.1 only and the app network is internal.
  const pb = read('src/main/nexus/exec/planBuilder.ts');
  assert.match(pb, /hostIp: '127\.0\.0\.1'/);
});

// =====================================================================================================================
// S9 malformed tool requests
// =====================================================================================================================

test('S9a the runner protocol refuses malformed reports (RP1-RP6, C13): unknown ops, extra keys, bad ids, oversized strings, accessors; main drops them', () => {
  const w = execWorld();
  const r = w.attach();
  // (An accessor cannot arrive: the port structured-clones every message into plain data; RP6 covers the parser's side.)
  const bad = [null, 42, 'x', [], { op: 'nope' }, { op: 'attempt.exited', attemptId: 'x' }, { op: 'attempt.heartbeat', attemptId: UNKNOWN, at: 1, logBytes: -1, outBytes: 0, container: 'running' },
    { op: 'fault', code: 'x'.repeat(10000), message: 'm' }, { op: 'ready', bootId: UNKNOWN, extra: 1 }];
  for (const m of bad) {
    assert.equal(parseRunnerMessage(m), null, JSON.stringify(m)?.slice(0, 80));
    assert.doesNotThrow(() => r.report(m));
  }
  assert.equal(w.db.prepare('SELECT COUNT(*) n FROM jobs').get().n, 0);
  const contracts = read('test/nexus-core-exec-contracts.test.cjs');
  for (const id of ['RP1', 'RP2', 'RP3', 'RP4', 'RP5', 'RP6']) assert.match(contracts, new RegExp(`test\\('${id} `), id);
  assert.match(read('test/nexus-platform-exec-scheduler.test.cjs'), /test\('C13 unknown attempt, another boot/);
  w.close();
});

test('S9b malformed JUnit is refused before parsing (J6-J11): a DOCTYPE, an ENTITY, oversize, not JUnit', () => {
  assert.equal(parseJunit('<?xml version="1.0"?><!DOCTYPE x [<!ENTITY a "b">]><testsuite tests="1"><testcase name="a"/></testsuite>').ok, false);
  assert.equal(parseJunit('<html><body>no</body></html>').ok, false);
  assert.equal(parseJunit(Buffer.alloc(16 * 2 ** 20 + 1, 0x20)).ok, false);
  assert.equal(parseJunit('<testsuite tests="1"><testcase name="a" classname="c"/></testsuite>').ok, true);
  const junit = read('test/nexus-core-junit.test.cjs');
  for (const id of ['J6', 'J7', 'J8', 'J9', 'J10', 'J11']) assert.match(junit, new RegExp(`test\\('${id} `), id);
});

test('S9c argv injection text stays one element (D11, X12); a malformed job:start body is a bad request and runs nothing', async () => {
  const runnerTests = read('test/nexus-core-runner.test.cjs');
  assert.match(runnerTests, /test\('D11 staging: git archive argv exact/);
  assert.match(read('test/nexus-platform-exec-recipes.test.cjs'), /test\('X12 a manifest argument "; touch \/out\/pwned" stays one argv element/);
  const w = execWorld();
  const x = ipcOver(w);
  for (const body of [{}, { ...start(w), params: '; rm -rf /' }, { ...start(w), inputs: '; touch /out/pwned' }, { ...start(w), actionId: 'sde.tests.discover; ls' },
    { ...start(w), inputs: [{ versionId: w.repoV, slot: 'repository; ls' }] }]) {
    await x.refused('nexus:job:start', [body], 'invalid', { reason: 'bad_request' });
  }
  assert.equal(w.db.prepare('SELECT COUNT(*) n FROM jobs').get().n, 0);
  healthy(w);
  w.close();
});

test('S-index every constraint-11 group has its cases here (by title prefix)', () => {
  const me = read('test/nexus-platform-exec-security.test.cjs');
  for (const g of ['S1a', 'S1b', 'S1c', 'S1d', 'S1e', 'S2a', 'S2b', 'S2c', 'S3a', 'S3b', 'S4a', 'S5a', 'S5b', 'S6a', 'S6b', 'S7a', 'S7b', 'S8a', 'S8b', 'S9a', 'S9b', 'S9c']) {
    assert.equal((me.match(new RegExp(`^test\\('${g} `, 'gm')) || []).length, 1, g);
  }
  void os;
});
