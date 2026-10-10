'use strict';
// B2a final fix (backend): the main-core findings of the final whole-branch review and the carried items that live in
// the execution core. Real SQLite (Electron-as-node, `npm run test:db`), the execution core driven through FakeRunners
// (no Docker, no runner process). Every case fails on the code before the fix.
// - P1/P1b/P1c (final review A1): a lease never fails forever on a record the store refuses.
// - P2/P2a/P2b/P2c (A2): dev deployment windows across a restart (adopt / finalize) and a stall of main.
// - P3 (A3): collecting is out of the wall clock and has its own deadline (ingest_error), with GC holding the store.
// - P4 (carry 3): a job waiting for git is not leased while main finds no git.
// - P5 (C2): the disk gate: 30 GiB gates image preparation; jobs lease above the lease floor.
// - P6 (C3): `requestProbe` and #23 `{ probe: true }`, rate-limited, never waiting.
// - P7 (carry 10): the GC failure filter.  P8 (carry 12): the B1 build's delete guard on an approval-only project.
const h = require('./helpers/sqlite.cjs');
if (!h.realSqliteOrSkip()) return;
const C = require('./helpers/cleanup.cjs'); C.cleanupAfterAll();
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const crypto = require('node:crypto');
const loadTs = require('./load-ts.cjs');
const { execWorld, passingPreflight, PROFILES, FWD_PROFILE, GIB } = require('./helpers/execWorld.cjs');
const { FakeRunner } = require('./helpers/fakeRunner.cjs');
const { ipcOver } = require('./helpers/ipcExec.cjs');
const { createNexusPlatform } = loadTs('src/main/nexus/platform.ts');
const { PlatformError } = loadTs('src/main/nexus/errors.ts');
const { MAX_SANDBOX_JSON_CHARS } = loadTs('src/main/nexus/exec/attempts.ts');
const { COLLECT_DEADLINE_MS, GIT_RECHECK_MS, PROBE_REQUEST_MIN_MS } = loadTs('src/main/nexus/exec/executionService.ts');
const { RECORD_MAX_CHARS } = loadTs('src/main/nexus/exec/planBuilder.ts');
const { REQUIRED_FREE_BYTES, leaseFloorBytes } = loadTs('src/shared/nexus/resourceGate.ts');

const MIN = 60_000;
const MANIFEST = { version: 1, profile: 'sde-node', run: ['node', 'dist/server.js'], port: 3000, healthPath: '/health', env: [] };
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

// ---------- helpers (as the Task 9 / Task 10 tests build them) ----------

/** A restart: a new platform on the same database, its startup (phase A), a fresh runner attached with the new boot id. */
function restart(w, o = {}) {
  const nx = createNexusPlatform(w.db, { now: () => w.now(), log: () => {}, execution: true, dataHome: w.dataHome,
    profiles: o.fwd ? [...PROFILES, FWD_PROFILE] : PROFILES, acceptFsRoot: (r) => r, approvals: null });
  const sys = nx.principals.system();
  const report = nx.startup();
  const runner = new FakeRunner();
  nx.exec.attachRunner(runner, nx.bootId); runner.report(w.probeMsg());
  return { nx, exec: nx.exec, sys, report, runner };
}
const rec = (attempts = []) => ({ docker: 'running', attempts, labelled: [] });
function entry(w, attemptId, container, extra = {}) {
  const a = w.attempt(attemptId);
  return { attemptId, container, ...(a.container_id ? { containerId: a.container_id } : {}), ...extra };
}
async function appDraft(w) {
  const b = await w.runBuild({ files: [{ path: 'server.js', content: 'server a' }], exit: 0 });
  w.answerVerifies(w.attach(), true); await w.settle();
  const runner = w.attach();
  const job = w.exec.start(w.me, w.req('sde.app.assemble', { inputs: [{ versionId: b.buildVersionId, slot: 'build' }] })).job;
  w.exec.tick(w.now()); w.provisionEngine(runner, job.id);
  w.exitWith(runner, job.id, { code: 0, parsed: [{ parser: 'app-manifest', sourceSha256: 'd'.repeat(64), normalized: { manifest: MANIFEST } }] });
  await w.settle();
  return w.db.prepare('SELECT id FROM artifact_versions WHERE produced_by_job_id = ?').get(job.id).id;
}
const dep = (w, jobId) => w.db.prepare('SELECT * FROM deployments WHERE job_id = ?').get(jobId);
const serviceWorld = () => execWorld({ realIngest: true, fwd: true, dockerMemoryBytes: 64 * GIB });
/** A dev deployment whose containers started (provisioned at `w.now()`), still `starting` (no 200 yet). */
async function starting(w) {
  const app = await appDraft(w);
  const r = w.attach();
  const j = w.exec.start(w.me, w.req('sde.preview.start', { inputs: [{ versionId: app, slot: 'application' }] })).job;
  w.exec.tick(w.now());
  const a = w.liveAttempt(j.id);
  r.report({ op: 'attempt.provisioned', attemptId: a.id, containerId: 'e'.repeat(64), imageDigest: w.IMAGE['sde-node'], preflight: passingPreflight(), hostPort: 49300 });
  assert.equal(dep(w, j.id).status, 'starting');
  return { app, job: j, attempt: w.attempt(a.id), runner: r };
}
/** One probe 5 s later with a heartbeat and the scheduler's tick, on the given runner and core. */
function probe(w, runner, exec, attemptId, status) {
  w.advance(5_000);
  runner.report({ op: 'attempt.heartbeat', attemptId, at: w.now(), logBytes: 0, outBytes: 0, container: 'running' });
  if (status !== undefined) runner.report({ op: 'service.health', attemptId, at: w.now(), status, ms: status === null ? null : 4, container: 'running' });
  exec.tick(w.now());
}
/** The app.preview_health rows of a version as [status, reason] (a non-passed row's reason ends its summary). */
const previewChecks = (w, versionId) => w.db.prepare("SELECT status, summary FROM validations WHERE version_id = ? AND validator_id = 'app.preview_health' ORDER BY rowid")
  .all(versionId).map((x) => ({ status: x.status, reason: (/\(([a-z_]+)\)$/.exec(x.summary) ?? [])[1] ?? null }));

/** A candidate test suite of `n` discovered files of exactly `len` characters each. */
function longSuite(w, n, len) {
  const name = (i) => { const tail = `/${String(i).padStart(4, '0')}.test.js`; return `test/${'p'.repeat(len - 5 - tail.length)}${tail}`; };
  const files = Array.from({ length: n }, (_, i) => name(i));
  assert.ok(files.every((f) => f.length === len));
  const a = w.nx.artifacts.create(w.me, { projectId: 'p-ledger', workspaceId: 'sde', kind: 'test_suite', name: `long ${n}x${len}` });
  const v = w.nx.artifacts.registerVersion(w.me, { artifactId: a.id, storage: { kind: 'git', commit: w.COMMIT },
    metadata: { profile: 'sde-node', framework: 'node-test', files } }).version.id;
  w.nx.artifacts.finalize(w.sys, v, 'candidate');
  return { v, files };
}

// ---------- A1 ----------

for (const [label, n, len] of [['P1', 120, 289], ['P1b', 200, 173]]) {
  test(`${label} (final review A1) a test run of ${n} discovered files of ${len} characters leases and runs: its sandbox record fits (argv items capped, else argvCount and argvSha256 only), never a lease that fails on every tick`, () => {
    const w = execWorld(); const r = w.attach();
    const { v, files } = longSuite(w, n, len);
    const { job } = w.exec.start(w.me, w.req('sde.tests.run', { inputs: [{ versionId: v, slot: 'suite' }] }));
    w.exec.tick(w.now());
    assert.equal(w.jobState(job.id), 'leased', 'leased on the first tick');
    const a = w.liveAttempt(job.id);
    const plan = r.lastStart().plan;
    assert.deepEqual(plan.perFileJunit.files, files, 'the plan itself runs every file');
    const sb = JSON.parse(a.sandbox_json);
    assert.ok(a.sandbox_json.length <= RECORD_MAX_CHARS && a.sandbox_json.length <= MAX_SANDBOX_JSON_CHARS, `${a.sandbox_json.length} characters`);
    assert.equal(sb.argvCount, plan.container.argv.length);
    assert.equal(sb.argvSha256, sha(JSON.stringify(plan.container.argv)), 'the record still names exactly what runs');
    if (sb.argv) assert.ok(sb.argv.every((x) => x.length <= 200));
    else assert.equal(sb.argvOmitted, true);
    w.provision(r, job.id);
    assert.equal(w.jobState(job.id), 'running');
    const ran = w.attempt(a.id);
    assert.equal(ran.state, 'running');
    assert.ok(ran.sandbox_json.length <= MAX_SANDBOX_JSON_CHARS);
    assert.equal(JSON.parse(ran.sandbox_json).preflight.ok, true);
    w.close();
  });
}

test('P1c (final review A1) a deterministic invalid refusal inside the lease transaction fails the job bad_plan in a transaction of its own: no lease loop, one attempt; any other throw still waits for the next tick', () => {
  const w = execWorld(); const r = w.attach();
  let once = true;
  w.exec.deps.hooks = { afterLeaseTransition: () => { if (once) { once = false; throw new PlatformError('invalid', 'sandbox_json exceeds 32768 characters', { field: 'sandbox_json' }); } } };
  const { job } = w.exec.start(w.me, w.req('sde.build.run'));
  w.exec.tick(w.now());
  assert.equal(w.jobState(job.id), 'failed');
  const atts = w.attempts(job.id);
  assert.equal(atts.length, 1);
  assert.deepEqual([atts[0].state, atts[0].outcome, JSON.parse(atts[0].error_json).code], ['failed', 'bad_plan', 'bad_plan']);
  assert.equal(w.job(job.id).outcome, 'infra_error');
  assert.equal(r.sentOf('attempt.start').length, 0, 'nothing was sent');
  for (let i = 0; i < 5; i++) { w.advance(1000); w.exec.tick(w.now()); }
  assert.equal(w.attempts(job.id).length, 1, 'never leased again');
  // A transient throw (not `invalid`): rolled back, the job stays queued and the next tick leases it.
  let twice = true;
  w.exec.deps.hooks = { afterLeaseTransition: () => { if (twice) { twice = false; throw new Error('busy'); } } };
  const j2 = w.exec.start(w.me, w.req('sde.build.run')).job;
  w.exec.tick(w.now());
  assert.equal(w.jobState(j2.id), 'queued'); assert.equal(w.attempts(j2.id).length, 0);
  w.advance(1000); w.exec.tick(w.now());
  assert.equal(w.jobState(j2.id), 'leased');
  w.close();
});

// ---------- A2 ----------

test('P2 (final review A2) a restart while a dev deployment is starting: the start window counts from the adoption, so a 200 soon after it makes the deployment healthy and the draft a candidate (never a blocking failure for time main was closed)', async () => {
  const w = serviceWorld();
  const { app, job, attempt } = await starting(w);
  w.advance(20_000);
  // Main is closed for 5 minutes; the app container keeps running.
  w.advance(5 * MIN);
  const t = restart(w, { fwd: true });
  // Ticks before phase B never judge an attempt another boot still owns.
  t.exec.tick(w.now());
  assert.equal(dep(w, job.id).status, 'starting');
  const b = t.exec.recoverPhaseB(t.sys, t.nx.bootId, rec([entry(w, attempt.id, 'running')]));
  assert.equal(b.adopted, 1);
  probe(w, t.runner, t.exec, attempt.id);
  probe(w, t.runner, t.exec, attempt.id, 200);
  assert.equal(dep(w, job.id).status, 'healthy');
  assert.deepEqual(previewChecks(w, app).map((x) => x.status), ['passed']);
  assert.equal(w.version(app).status, 'candidate');
  w.close();
});

test('P2a (final review A2) adopted, but no 200 within 60 s of the adoption: the check could not be observed (errored start_window_unobserved), never failed; the draft is not failed; the job fails start_window_unobserved', async () => {
  const w = serviceWorld();
  const { app, job, attempt } = await starting(w);
  w.advance(5 * MIN);
  const t = restart(w, { fwd: true });
  t.exec.recoverPhaseB(t.sys, t.nx.bootId, rec([entry(w, attempt.id, 'running')]));
  for (let i = 0; i < 10; i++) probe(w, t.runner, t.exec, attempt.id, 503);
  for (let i = 0; i < 4; i++) probe(w, t.runner, t.exec, attempt.id);
  const d = dep(w, job.id);
  assert.deepEqual([d.status, d.stop_reason], ['failed', 'start_timeout']);
  assert.deepEqual(previewChecks(w, app).map((x) => [x.status, x.reason]), [['error', 'start_window_unobserved']]);
  assert.notEqual(w.version(app).status, 'failed', 'the draft is not failed for a window nobody observed');
  assert.deepEqual([w.jobState(job.id), w.job(job.id).outcome], ['failed', 'start_window_unobserved']);
  assert.ok(t.runner.sentOf('attempt.cancel').some((m) => m.attemptId === attempt.id));
  w.close();
});

test('P2b (final review A2) a stopped deployment waiting for its exit, then a restart: finalized, it waits for the re-reported exit (never exit_not_reported first) and completes stopped', async () => {
  const w = serviceWorld();
  const { job, attempt } = await starting(w);
  probe(w, w.attach(), w.exec, attempt.id, 200);
  assert.equal(dep(w, job.id).status, 'healthy');
  w.nx.deployments.stop(w.me, dep(w, job.id).id);
  assert.equal(w.job(job.id).phase, 'stopping');
  w.advance(10 * MIN);                       // closed far longer than the stopping wait
  const t = restart(w, { fwd: true });
  t.exec.tick(w.now());
  const b = t.exec.recoverPhaseB(t.sys, t.nx.bootId, rec([entry(w, attempt.id, 'exited', { exit: { code: 0, oomKilled: false, finishedAt: w.now() } })]));
  assert.equal(b.finalized, 1);
  for (let i = 0; i < 6; i++) { w.advance(5_000); t.exec.tick(w.now()); }
  assert.equal(w.jobState(job.id), 'running', 'still waiting for the re-reported exit');
  t.runner.report({ op: 'attempt.exited', attemptId: attempt.id, exit: { code: 0, oomKilled: false, finishedAt: w.now() }, outputs: [], parsed: [], logBytes: 10 });
  assert.deepEqual([w.jobState(job.id), w.job(job.id).outcome], ['completed', 'stopped']);
  // Without the re-reported exit the wait is still bounded (never completed).
  const w2 = serviceWorld();
  const s2 = await starting(w2);
  probe(w2, w2.attach(), w2.exec, s2.attempt.id, 200);
  w2.nx.deployments.stop(w2.me, dep(w2, s2.job.id).id);
  w2.advance(10 * MIN);
  const t2 = restart(w2, { fwd: true });
  t2.exec.recoverPhaseB(t2.sys, t2.nx.bootId, rec([entry(w2, s2.attempt.id, 'exited', { exit: { code: 0, oomKilled: false, finishedAt: w2.now() } })]));
  for (let i = 0; i < 40 && w2.jobState(s2.job.id) === 'running'; i++) { w2.advance(5_000); t2.exec.tick(w2.now()); }
  assert.equal(w2.jobState(s2.job.id), 'failed');
  w.close(); w2.close();
});

test('P2c (final review A2) a stall of main of 5 minutes or more during the start window: errored start_window_unobserved, never probe_failed', async () => {
  const w = serviceWorld();
  const { app, job, attempt } = await starting(w);
  const r = w.attach();
  probe(w, r, w.exec, attempt.id, 503);
  w.advance(6 * MIN);                        // the scheduler did not run for six minutes (sleep, a blocked loop)
  r.report({ op: 'attempt.heartbeat', attemptId: attempt.id, at: w.now(), logBytes: 0, outBytes: 0, container: 'running' });
  w.exec.tick(w.now());
  const d = dep(w, job.id);
  assert.deepEqual([d.status, d.stop_reason], ['failed', 'start_timeout']);
  assert.deepEqual(previewChecks(w, app).map((x) => [x.status, x.reason]), [['error', 'start_window_unobserved']]);
  assert.equal(w.job(job.id).outcome, 'start_window_unobserved');
  w.close();
});

// ---------- A3 ----------

test('P3 (final review A3) collecting is out of the wall clock: with blob GC holding the store past the build\'s wall clock the attempt is not timed out; past COLLECT_DEADLINE_MS it fails ingest_error and a late commit ingests nothing', async () => {
  const w = execWorld({ realIngest: true }); const r = w.attach();
  const { job } = w.exec.start(w.me, w.req('sde.build.run'));
  w.exec.tick(w.now());
  const a = w.provision(r, job.id, { c: 'd' });
  w.run(r, 14 * MIN);                        // just inside the 15-minute wall clock
  const hold = w.nx.blobs.lock.tryExclusive();
  assert.ok(hold, 'GC holds the blob store');
  w.exitWith(r, job.id, { code: 0, outputs: [w.file('dist/index.html', '<p>ok</p>')] });
  assert.equal(w.job(job.id).phase, 'collecting');
  for (let i = 0; i < 24; i++) { w.advance(15_000); w.exec.tick(w.now()); }   // 6 more minutes: past the wall clock
  assert.equal(w.attempt(a.id).state, 'running', 'not timed out while collecting');
  assert.equal(w.jobState(job.id), 'running');
  for (let i = 0; i < 20; i++) { w.advance(15_000); w.exec.tick(w.now()); }   // past the collecting deadline
  assert.ok(w.now() - w.events(job.id, 'attempt.output')[0].ts > COLLECT_DEADLINE_MS);
  const at = w.attempt(a.id);
  assert.deepEqual([at.state, at.outcome, JSON.parse(at.error_json).code], ['failed', 'ingest_error', 'ingest_error']);
  assert.equal(w.jobState(job.id), 'failed');
  hold();
  await w.settle();
  assert.equal(w.db.prepare('SELECT COUNT(*) AS n FROM artifact_versions WHERE produced_by_job_id = ?').get(job.id).n, 0, 'nothing was ingested late');
  assert.equal(w.attempt(a.id).state, 'failed');
  w.close();
});

// ---------- carry 3 ----------

test('P4 (final batch item 3) a job the runner sent back waiting:git is not leased again while main finds no git (no abandoned attempt per backoff step); once git is found it leases', async () => {
  let gitPath = null;
  const w = execWorld({ findGit: async () => gitPath }); const r = w.attach();
  const { job } = w.exec.start(w.me, w.req('sde.build.run')); w.exec.tick(w.now());
  const a = w.liveAttempt(job.id);
  r.report({ op: 'attempt.refused', attemptId: a.id, reason: 'git_missing', detail: 'git is not installed' });
  assert.equal(w.job(job.id).phase, 'waiting:git');
  await w.exec.gitLookSettled();
  for (let i = 0; i < 30; i++) { w.advance(2_000); w.exec.tick(w.now()); await w.exec.gitLookSettled(); }
  assert.equal(w.attempts(job.id).length, 1, 'one attempt in a minute, not one per backoff step');
  assert.equal(w.jobState(job.id), 'queued'); assert.equal(w.job(job.id).phase, 'waiting:git');
  gitPath = process.platform === 'win32' ? 'C:\\Program Files\\Git\\cmd\\git.exe' : '/usr/bin/git';
  w.advance(GIT_RECHECK_MS); w.exec.tick(w.now()); await w.exec.gitLookSettled();
  w.advance(1_000); w.exec.tick(w.now());
  assert.equal(w.liveAttempt(job.id).n, 2, 'git found: leased again');
  w.close();
});

// ---------- C2 ----------

test('P5 (final review C2, ruled) between the lease floor and 30 GiB free: jobs still lease and actions are available; only image preparation is gated (setup:disk_low); health says disk_low with the exact numbers', () => {
  const free = 20 * GIB;
  assert.ok(free > leaseFloorBytes(256 * 2 ** 20) && free < REQUIRED_FREE_BYTES);
  const w = execWorld({ freeBytes: free }); const r = w.attach();
  assert.deepEqual(w.exec.setupAvailability({ actionId: 'sde.build.run' }), { available: true, reason: null });
  assert.deepEqual(w.exec.setupAvailability({ imagePreparation: true }), { available: false, reason: 'setup:disk_low' });
  const hs = w.exec.health();
  assert.equal(hs.disk.freeBytes, free); assert.equal(hs.disk.leaseFloorBytes, leaseFloorBytes(0));
  assert.ok(hs.gate.problems.some((p) => p.id === 'disk_low' && p.requiredBytes === REQUIRED_FREE_BYTES && p.freeBytes === free));
  const { job } = w.exec.start(w.me, w.req('sde.build.run'));
  w.exec.tick(w.now());
  assert.equal(w.jobState(job.id), 'leased', 'a job leases above the lease floor');
  assert.equal(r.sentOf('attempt.start').length, 1);
  // Below the lease floor it waits.
  const w2 = execWorld({ freeBytes: 2 * GIB }); w2.attach();
  const j2 = w2.exec.start(w2.me, w2.req('sde.build.run')).job;
  w2.exec.tick(w2.now());
  assert.deepEqual([w2.jobState(j2.id), w2.job(j2.id).phase], ['queued', 'waiting:disk']);
  assert.deepEqual(w2.exec.setupAvailability({ actionId: 'sde.build.run' }), { available: false, reason: 'setup:disk_low' });
  w.close(); w2.close();
});

// ---------- C3 ----------

test('P6 (final review C3) requestProbe asks the runner for a fresh probe without waiting, at most once per 5 s; #23 with { probe: true } does it and still answers from the cache; anything else is a bad request', async () => {
  const w = execWorld(); const r = w.attach();
  const probes = () => r.sentOf('probe').length;
  const p0 = probes();
  assert.deepEqual(w.exec.requestProbe(), { requested: true });
  assert.equal(probes(), p0 + 1);
  assert.deepEqual(w.exec.requestProbe(), { requested: false }, 'rate-limited');
  w.advance(PROBE_REQUEST_MIN_MS - 1);
  assert.deepEqual(w.exec.requestProbe(), { requested: false });
  w.advance(1);
  assert.deepEqual(w.exec.requestProbe(), { requested: true });
  assert.equal(probes(), p0 + 2);
  const x = ipcOver(w);
  w.advance(PROBE_REQUEST_MIN_MS);
  const before = probes();
  const v = await x.ok('nexus:platform:health', { probe: true });
  assert.equal(probes(), before + 1, '#23 { probe: true } asked for a probe');
  assert.equal(typeof v.checkedAt, 'number', 'the answer is the cache (the "Checked at" line)');
  await x.ok('nexus:platform:health');
  assert.equal(probes(), before + 1, 'a plain read never probes');
  for (const bad of [{ probe: false }, { probe: 1 }, { other: true }, 'probe', [true]]) {
    const res = await x.call('nexus:platform:health', bad);
    assert.deepEqual([res.ok, res.code, res.reason], [false, 'invalid', 'bad_request'], JSON.stringify(bad));
  }
  // No runner: nothing is sent and nothing throws.
  const w2 = execWorld();
  assert.deepEqual(w2.exec.requestProbe(), { requested: false });
  w.close(); w2.close();
});

// ---------- carry 10 ----------

test('P7 (final batch item 10) GC reports exactly the objects whose file delete failed (a Set, any number of them)', async () => {
  const w = execWorld();
  const blobs = w.nx.blobs;
  const now = w.now();
  const shas = Array.from({ length: 300 }, (_, i) => sha(`orphan ${i}`)).sort();
  const ins = w.db.prepare('INSERT INTO blobs (sha256, bytes, media_type, created_at, last_referenced_at) VALUES (?, 10, ?, ?, ?)');
  for (const s of shas) ins.run(s, 'application/octet-stream', now - 3 * 24 * 3600_000, now - 3 * 24 * 3600_000);
  const dry = blobs.gcDryRun(w.me);
  const failing = new Set(shas.filter((_, i) => i % 7 === 0));
  const r = await blobs.gcApply(w.me, dry.candidatesHash, async (list) => ({ failed: list.filter((s) => failing.has(s)) }));
  assert.deepEqual(new Set(r.removedShas), new Set(shas));
  assert.deepEqual([...r.fileDeleteFailed].sort(), [...failing].sort());
  w.close();
});

// ---------- carry 12 ----------

test('P8 (final batch item 12, optional F4) the B1 build d7abc87b on a v9 file whose project has only an approval: its guard does not know approvals, so the delete is attempted, and ON DELETE RESTRICT keeps the project and the approval; the current build refuses it outright', () => {
  const { PersistStore } = loadTs('src/main/db.ts');
  const { materializeRev } = require('./helpers/materialize-rev.cjs');
  const { file, dir } = h.v6Fixture();
  const cur = C.track(new PersistStore(file)); cur.open({ log: () => {}, backupDir: path.join(dir, 'b'), now: () => h.NOW, enableV9: true });
  const pdb = cur.platformDatabase();
  assert.equal(cur.hasPlatformRecords('p-sales'), false, 'p-sales starts without platform records');
  pdb.prepare(`INSERT INTO approvals (id, project_id, job_id, reason, summary, request_json, request_sha256, status, requested_by, on_behalf_of,
      requested_at, expires_at, status_changed_at) VALUES ('ap-only', 'p-sales', NULL, 'repo.write_refs', 'Write refs', '{}', ?, 'pending', 'system', 'user:local', ?, ?, ?)`)
    .run('e'.repeat(64), h.NOW, h.NOW + 15 * MIN, h.NOW);
  assert.equal(cur.hasPlatformRecords('p-sales'), true, 'the current guard counts approvals');
  assert.equal(cur.deleteProject('p-sales'), false, 'the current build refuses');
  cur.close();
  const oldDb = materializeRev('d7abc87b', h.tmpDir('nx-rev-'));
  const { PersistStore: OldStore } = loadTs.loadAbsolute(oldDb);
  const o = C.track(new OldStore(file)); o.open({ log: () => {}, backupDir: path.join(dir, 'b'), now: () => h.NOW });
  assert.equal(o.lastMigration.reason, 'newer_schema');
  assert.equal(o.hasPlatformRecords('p-sales'), false, 'the B1 guard does not know the v9 approvals table');
  o.deleteProject('p-sales');
  assert.ok(o.getProject('p-sales'), 'ON DELETE RESTRICT kept the project');
  o.close();
  const raw = h.openRaw(file);
  assert.equal(raw.prepare("SELECT COUNT(*) AS n FROM approvals WHERE id = 'ap-only'").get().n, 1, 'the approval is kept');
  assert.equal(raw.prepare("SELECT COUNT(*) AS n FROM projects WHERE id = 'p-sales'").get().n, 1);
  assert.deepEqual(raw.pragma('foreign_key_check'), []);
  assert.equal(raw.pragma('user_version', { simple: true }), 9);
  raw.close();
});
