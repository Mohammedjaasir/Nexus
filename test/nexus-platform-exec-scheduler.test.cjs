'use strict';
// B2a Task 7: the execution core in main (attempts, the capped scheduler, leases and heartbeats, cancel,
// timeout, retry, job events) on a real v9 database, driven through a FakeRunner. No Docker.
const h = require('./helpers/sqlite.cjs');
if (!h.realSqliteOrSkip()) return;
const test = require('node:test');
const assert = require('node:assert/strict');
const { performance } = require('node:perf_hooks');
const loadTs = require('./load-ts.cjs');
const { execWorld, passingPreflight, GIB } = require('./helpers/execWorld.cjs');
const { FakeRunner } = require('./helpers/fakeRunner.cjs');
const { verifyActivityChain } = loadTs('src/main/nexus/activity/writer.ts');
const { buildPlan, ALLOWED_ENV_NAMES } = loadTs('src/main/nexus/exec/planBuilder.ts');
const { getRecipe } = loadTs('src/shared/nexus/recipes.ts');
const { newId } = loadTs('src/main/nexus/db/ids.ts');
const { containsSecret } = loadTs('src/main/nexus/activity/redact.ts');

const MIN = 60_000;
const code = (c, reason) => (e) => e.code === c && (reason === undefined || e.detail?.reason === reason);

test('C1 a started job leases one attempt in one transaction and runs only after a passing provisioned report', () => {
  const w = execWorld(); const runner = new FakeRunner(); w.exec.attachRunner(runner, w.bootId);
  const { job } = w.exec.start(w.me, w.req('sde.build.run', { inputs: [{ versionId: w.repoV, slot: 'repository' }] }));
  assert.equal(job.state, 'queued');
  w.exec.tick(w.now());
  const a = w.db.prepare('SELECT * FROM job_attempts WHERE job_id = ?').get(job.id);
  assert.equal(a.state, 'starting'); assert.equal(a.n, 1); assert.equal(a.lease_owner, w.bootId);
  assert.equal(w.jobState(job.id), 'leased');
  const start = runner.sent.find((m) => m.op === 'attempt.start');
  assert.deepEqual(start.plan.container.network, { mode: 'none' });
  assert.equal(start.plan.container.readOnlyRootfs, true); assert.deepEqual(start.plan.container.capDrop, ['ALL']);
  runner.report({ op: 'attempt.provisioned', attemptId: a.id, containerId: 'c'.repeat(64), imageDigest: 'sha256:' + 'a'.repeat(64),
    preflight: { ok: false, observed: {}, problems: ['network is bridge, expected none'] } });
  assert.equal(w.jobState(job.id), 'failed'); assert.equal(w.job(job.id).outcome, 'infra_error');
  assert.equal(w.attempt(a.id).outcome, 'limits_not_applied');
  assert.ok(runner.sent.some((m) => m.op === 'attempt.release' && m.attemptId === a.id), 'the refused container is removed');
  assert.equal(w.events(job.id, 'preflight').length, 1);
  assert.match(JSON.parse(w.events(job.id, 'preflight')[0].data_json).problems[0], /bridge/);
  w.close();
});

test('C1b a passing preflight runs the attempt and records the sandbox and environment; a missing report never runs it', () => {
  const w = execWorld(); const runner = new FakeRunner(); w.exec.attachRunner(runner, w.bootId);
  const { job } = w.exec.start(w.me, w.req('sde.build.run'));
  w.exec.tick(w.now());
  const a = w.provision(runner, job.id);
  assert.equal(w.jobState(job.id), 'running'); assert.equal(w.attempt(a.id).state, 'running');
  const at = w.attempt(a.id);
  const sb = JSON.parse(at.sandbox_json); const env = JSON.parse(at.environment_json);
  assert.equal(sb.preflight.ok, true); assert.deepEqual(sb.network, { mode: 'none' }); assert.equal(sb.containerId, 'c'.repeat(64));
  assert.ok(!JSON.stringify(sb).includes(w.dataHome.root), 'no host path in sandbox_json');
  assert.equal(env.recipeId, 'sde.build.node'); assert.equal(env.imageId, w.IMAGE['sde-node']); assert.equal(env.runnerBootId, w.bootId);
  // A second job: a provisioned report without a container and preflight is refused for a container recipe.
  const b = w.exec.start(w.me, w.req('sde.tests.discover')).job;
  w.exec.tick(w.now());
  const ab = w.liveAttempt(b.id);
  runner.report({ op: 'attempt.provisioned', attemptId: ab.id });
  assert.equal(w.jobState(b.id), 'failed'); assert.equal(w.attempt(ab.id).outcome, 'limits_not_applied');
  w.close();
});

test('C2 start is idempotent by intent; the same intent with other inputs is a conflict', () => {
  const w = execWorld();
  const r = w.req('sde.build.run');
  const a = w.exec.start(w.me, r); const b = w.exec.start(w.me, r);
  assert.equal(a.created, true); assert.equal(b.created, false); assert.equal(a.job.id, b.job.id);
  const other = w.nx.artifacts.registerVersion(w.me, { artifactId: w.db.prepare('SELECT artifact_id FROM artifact_versions WHERE id = ?').get(w.repoV).artifact_id,
    storage: { kind: 'git', commit: 'b'.repeat(40) }, metadata: { profile: 'sde-node' } }).version.id;
  w.nx.artifacts.finalize(w.sys, other, 'candidate');
  assert.throws(() => w.exec.start(w.me, { ...r, inputs: [{ versionId: other, slot: 'repository' }] }), code('conflict'));
  assert.equal(h.count(w.db, 'jobs'), 1);
  w.close();
});

test('C3 unknown, foreign-domain and non-job actions, bad inputs and bad params are invalid with a reason', () => {
  const w = execWorld();
  assert.throws(() => w.exec.start(w.me, w.req('sde.change.propose')), code('invalid', 'unknown_action'));
  assert.throws(() => w.exec.start(w.me, w.req('sde.requirement.write')), code('invalid', 'unknown_action'));
  assert.throws(() => w.exec.start(w.me, { ...w.req('sde.build.run'), workspaceId: 'qa' }), code('not_participating'), 'authorization first');
  w.nx.workspaces.attach(w.me, 'p-ledger', 'qa');
  assert.throws(() => w.exec.start(w.me, { ...w.req('sde.build.run'), workspaceId: 'qa' }), code('invalid', 'action_not_in_domain'));
  // A draft input, and a version of another project.
  const a = w.nx.artifacts.create(w.me, { projectId: 'p-ledger', workspaceId: 'sde', kind: 'test_suite', name: 'draft' });
  const draft = w.nx.artifacts.registerVersion(w.me, { artifactId: a.id, storage: { kind: 'git', commit: w.COMMIT } }).version.id;
  assert.throws(() => w.exec.start(w.me, w.req('sde.tests.run', { inputs: [{ versionId: draft, slot: 'suite' }] })), code('invalid', 'input_not_allowed'));
  const fa = w.nx.artifacts.create(w.me, { projectId: 'p-invoice', workspaceId: 'dl', kind: 'test_suite', name: 'foreign' });
  const fv = w.nx.artifacts.registerVersion(w.me, { artifactId: fa.id, storage: { kind: 'git', commit: w.COMMIT } }).version.id;
  w.nx.artifacts.finalize(w.sys, fv, 'candidate');
  assert.throws(() => w.exec.start(w.me, w.req('sde.tests.run', { inputs: [{ versionId: fv, slot: 'suite' }] })), code('invalid', 'input_not_allowed'));
  // The wrong kind for the slot, a missing input, an unknown slot.
  assert.throws(() => w.exec.start(w.me, w.req('sde.tests.run', { inputs: [{ versionId: w.repoV, slot: 'suite' }] })), code('invalid', 'input_not_allowed'));
  assert.throws(() => w.exec.start(w.me, w.req('sde.build.run', { inputs: [] })), code('invalid', 'input_not_allowed'));
  assert.throws(() => w.exec.start(w.me, w.req('sde.build.run', { inputs: [{ versionId: w.repoV, slot: 'other' }] })), code('invalid', 'input_not_allowed'));
  // Params: an extra key, a path, `..`, a NUL, and a secret (diagnose has a schema; build has none).
  assert.throws(() => w.exec.start(w.me, w.req('sde.build.run', { params: { extra: 1 } })), code('invalid', 'bad_params'));
  for (const targetId of ['a/b', '..', 'a\0b', 'C:\\x'])
    assert.throws(() => w.exec.start(w.me, w.req('sde.diagnose', { params: { target: 'job', targetId } })), code('invalid', 'bad_params'), JSON.stringify(targetId));
  assert.throws(() => w.exec.start(w.me, w.req('sde.diagnose', { params: { target: 'job', targetId: 'ghp_' + 'A1b2'.repeat(9) } })),
    (e) => e.code === 'invalid' && ['secret_in_params', 'bad_params'].includes(e.detail?.reason));
  assert.equal(h.count(w.db, 'jobs'), 0);
  assert.equal(h.count(w.db, 'job_events'), 0);
  w.close();
});

test('C4 a viewer is denied with one audit row and nothing written; a non-participating workspace is not_participating', async () => {
  const w = execWorld();
  const viewer = w.addUser('user:viewer', 'project', 'p-ledger', 'viewer');
  const before = { jobs: h.count(w.db, 'jobs'), events: h.count(w.db, 'job_events'), activity: h.count(w.db, 'activity') };
  assert.throws(() => w.exec.start(viewer, w.req('sde.build.run')), code('denied'));
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(h.count(w.db, 'jobs'), before.jobs); assert.equal(h.count(w.db, 'job_events'), before.events);
  assert.equal(w.db.prepare("SELECT COUNT(*) AS n FROM activity WHERE status = 'denied' AND actor_id = 'user:viewer'").get().n, 1);
  assert.equal(h.count(w.db, 'activity'), before.activity + 1);
  assert.throws(() => w.exec.start(w.me, { ...w.req('sde.build.run'), projectId: 'p-sales' }), code('not_participating'));
  w.close();
});

test('C5 cancel in every live state: attempts end first, approvals are withdrawn, children go first, drafts are flagged, cancel wins over exit', () => {
  const w = execWorld({ approvals: true }); const runner = new FakeRunner(); w.exec.attachRunner(runner, w.bootId);
  // queued
  const q = w.exec.start(w.me, w.req('sde.build.run')).job;
  assert.equal(w.exec.cancel(w.me, q.id).state, 'cancelled'); assert.equal(w.attempts(q.id).length, 0);
  // leased
  const l = w.exec.start(w.me, w.req('sde.build.run')).job; w.exec.tick(w.now());
  const la = w.liveAttempt(l.id);
  assert.equal(w.exec.cancel(w.me, l.id).state, 'cancelled');
  assert.equal(w.attempt(la.id).state, 'cancelled');
  assert.ok(runner.sent.some((m) => m.op === 'attempt.cancel' && m.attemptId === la.id && m.reason === 'user'));
  // running, with a draft the job registered; a later exit is dropped
  const r = w.exec.start(w.me, w.req('sde.build.run')).job; w.exec.tick(w.now()); const ra = w.provision(runner, r.id);
  const buildA = w.nx.artifacts.create(w.me, { projectId: 'p-ledger', workspaceId: 'sde', kind: 'build', name: 'b' });
  const dv = w.nx.artifacts.registerVersion(w.sys, { artifactId: buildA.id, storage: { kind: 'inline', json: { x: 1 } }, producedByJobId: r.id }).version.id;
  w.exec.cancel(w.me, r.id);
  assert.equal(w.jobState(r.id), 'cancelled'); assert.equal(w.attempt(ra.id).state, 'cancelled');
  assert.equal(w.db.prepare('SELECT draft_flag FROM artifact_versions WHERE id = ?').get(dv).draft_flag, 'cancelled_partial');
  const evBefore = h.count(w.db, 'job_events');
  w.exit(runner, r.id, { attempt: ra, outputs: ['dist/app.js'] });
  assert.equal(w.jobState(r.id), 'cancelled'); assert.equal(w.attempt(ra.id).state, 'cancelled');
  assert.equal(h.count(w.db, 'job_events'), evBefore, 'the late exit writes nothing');
  // awaiting_approval (an egress recipe)
  const d = w.exec.start(w.me, w.req('sde.deps.install')).job; w.exec.tick(w.now());
  assert.equal(w.jobState(d.id), 'awaiting_approval');
  const ap = w.db.prepare('SELECT * FROM approvals WHERE job_id = ?').get(d.id);
  assert.equal(ap.status, 'pending');
  assert.equal(runner.sent.filter((m) => m.op === 'attempt.start' && m.plan.jobId === d.id).length, 0, 'no plan before approval');
  w.exec.cancel(w.me, d.id);
  assert.equal(w.db.prepare('SELECT status FROM approvals WHERE id = ?').get(ap.id).status, 'withdrawn');
  assert.equal(w.jobState(d.id), 'cancelled');
  // retry_scheduled
  const t = w.exec.start(w.me, w.req('sde.tests.discover')).job; w.exec.tick(w.now());
  runner.report({ op: 'fault', message: 'Error response from daemon: no space left on device', attemptId: w.liveAttempt(t.id).id, failureClass: 'disk_full' });
  assert.equal(w.jobState(t.id), 'retry_scheduled');
  assert.equal(w.exec.cancel(w.me, t.id).state, 'cancelled');
  // a parent cancel cascades to its children first
  const parent = w.exec.start(w.me, w.req('sde.build.run')).job;
  const child = w.nx.jobs.create(w.sys, { kind: 'validate', projectId: 'p-ledger', workspaceId: 'sde', idempotencyKey: 'child-1', parentJobId: parent.id }).job;
  w.exec.cancel(w.me, parent.id);
  assert.equal(w.jobState(child.id), 'cancelled'); assert.equal(w.jobState(parent.id), 'cancelled');
  const order = w.db.prepare("SELECT job_id FROM job_events WHERE type = 'job.transition' AND job_id IN (?, ?) AND data_json LIKE '%\"to\":\"cancelled\"%' ORDER BY seq")
    .all(parent.id, child.id).map((x) => x.job_id);
  assert.deepEqual(order, [child.id, parent.id]);
  // a terminal job cannot be cancelled
  assert.throws(() => w.exec.cancel(w.me, parent.id), code('illegal_transition'));
  assert.equal(w.liveCount(), 0);
  w.close();
});

test('C6 timeout: the wall clock ends a running attempt; time in awaiting_approval is excluded', () => {
  const w = execWorld({ approvals: true }); const runner = new FakeRunner(); w.exec.attachRunner(runner, w.bootId);
  const { job } = w.exec.start(w.me, w.req('sde.build.run')); w.exec.tick(w.now()); const a = w.provision(runner, job.id);
  // A live runner heartbeats; the clock moves in steps shorter than the 60 s lease.
  const run = (ms) => w.run(runner, ms);
  run(14 * MIN);
  assert.equal(w.jobState(job.id), 'running');
  run(2 * MIN);
  assert.equal(w.jobState(job.id), 'timed_out'); assert.equal(w.attempt(a.id).state, 'timed_out');
  assert.ok(runner.sent.some((m) => m.op === 'attempt.cancel' && m.attemptId === a.id && m.reason === 'timeout'));
  // An egress job waits 20 min for approval (more than its 15 min wall clock) and does not time out.
  const d = w.exec.start(w.me, w.req('sde.deps.install')).job; w.exec.tick(w.now());
  assert.equal(w.jobState(d.id), 'awaiting_approval');
  w.run(runner, 20 * MIN);
  assert.equal(w.jobState(d.id), 'awaiting_approval');
  const da = w.liveAttempt(d.id);
  // The user's `once` (Task 9 records it; written directly here), then the core resumes the job with the consumed approval.
  w.db.prepare(`UPDATE approvals SET status = 'approved', decided_by = 'user:local', decided_at = ?, decision = 'once', consumed_at = ?,
    consumed_by_job_id = ?, consumed_by_attempt_n = ?, status_changed_at = ? WHERE job_id = ?`).run(w.now(), w.now(), d.id, da.n, w.now(), d.id);
  w.exec.resumeApproved(d.id)();
  const plan = runner.lastStart().plan;
  assert.equal(plan.jobId, d.id); assert.equal(plan.container.network.mode, 'egress-approved');
  w.provision(runner, d.id);
  run(10 * MIN);
  assert.equal(w.jobState(d.id), 'running', '30 min since lease, 20 of them waiting: 10 min counted');
  run(6 * MIN);
  assert.equal(w.jobState(d.id), 'timed_out');
  w.close();
});

test('C7 retry: an idempotent infra failure is retried with backoff and n = 2; a non-idempotent one stays failed; retry() makes a new job', () => {
  const w = execWorld(); const runner = new FakeRunner(); w.exec.attachRunner(runner, w.bootId);
  const { job } = w.exec.start(w.me, w.req('sde.tests.discover')); w.exec.tick(w.now());
  const a1 = w.liveAttempt(job.id);
  runner.report({ op: 'fault', message: 'Error response from daemon: cannot allocate memory', attemptId: a1.id, failureClass: 'docker_resources' });
  assert.equal(w.jobState(job.id), 'retry_scheduled');
  assert.equal(w.job(job.id).next_attempt_at, w.now() + 10_000);
  w.advance(5_000); w.exec.tick(w.now()); assert.equal(w.jobState(job.id), 'retry_scheduled');
  w.advance(5_000); w.exec.tick(w.now());
  assert.equal(w.jobState(job.id), 'leased');
  assert.equal(w.liveAttempt(job.id).n, 2);
  // Non-idempotent: a build failing the same way stays failed.
  const b = w.exec.start(w.me, w.req('sde.build.run')).job; w.exec.tick(w.now());
  // the discover attempt holds a slot; the build still fits (3 slots)
  runner.report({ op: 'fault', message: 'Minimum memory limit allowed is 6MB', attemptId: w.liveAttempt(b.id).id, failureClass: 'docker_resources' });
  assert.equal(w.jobState(b.id), 'failed'); assert.equal(w.job(b.id).outcome, 'infra_error');
  // nexus:job:retry -> a new job with retry_of
  const again = w.exec.retry(w.me, b.id, 'retry-intent-1').job;
  assert.notEqual(again.id, b.id); assert.equal(again.retryOf, b.id); assert.equal(again.state, 'queued'); assert.equal(again.recipeId, 'sde.build.node');
  assert.throws(() => w.exec.retry(w.me, again.id, 'retry-intent-2'), code('illegal_transition'));
  // Refused once the participation is withdrawn.
  w.exec.cancel(w.me, again.id);
  w.db.prepare("UPDATE project_workspaces SET status = 'withdrawn', is_primary = 0 WHERE id = ?").run(w.pw.id);
  assert.throws(() => w.exec.retry(w.me, b.id, 'retry-intent-3'), code('participation_inactive'));
  w.close();
});

test('C8 slot cap 3: five jobs, three leased, two waiting:slots; never four live; each exit lets the next one lease', () => {
  const w = execWorld({ dockerMemoryBytes: 64 * GIB }); const runner = new FakeRunner(); w.exec.attachRunner(runner, w.bootId);
  const jobs = []; for (let i = 0; i < 5; i++) jobs.push(w.exec.start(w.me, w.req('sde.build.run')).job);
  w.exec.tick(w.now());
  assert.equal(w.liveCount(), 3);
  assert.deepEqual(jobs.map((j) => w.job(j.id).phase), ['provisioning', 'provisioning', 'provisioning', 'waiting:slots', 'waiting:slots']);
  for (let round = 0; round < 5; round++) {
    const live = jobs.find((j) => w.liveAttempt(j.id));
    if (!live) break;
    const a = w.liveAttempt(live.id);
    if (a.state === 'starting') w.provision(runner, live.id);
    w.exit(runner, live.id, { code: 0, outputs: ['dist/app.js'] });
    w.exec.tick(w.now());
    assert.ok(w.liveCount() <= 3, 'never four live');
  }
  assert.equal(jobs.filter((j) => w.attempts(j.id).length === 1).length, 5, 'every job got its attempt');
  // Without an ingest port the exits are honest failures, never completed.
  assert.ok(jobs.every((j) => w.jobState(j.id) !== 'completed'));
  assert.equal(w.job(jobs[0].id).outcome, 'ingest_unavailable');
  w.close();
});

test('C9 the memory budget keeps a job queued with a visible reason, never leased', () => {
  const w = execWorld({ dockerMemoryBytes: 3 * 2 ** 30 }); const runner = new FakeRunner(); w.exec.attachRunner(runner, w.bootId);
  const a = w.exec.start(w.me, w.req('sde.tests.run')).job; const b = w.exec.start(w.me, w.req('sde.build.run')).job;
  w.exec.tick(w.now());
  assert.equal(w.jobState(a.id), 'leased'); assert.equal(w.jobState(b.id), 'queued'); assert.equal(w.job(b.id).phase, 'waiting:memory');
  assert.equal(w.exec.list(w.me, { projectId: 'p-ledger' }).jobs.find((j) => j.id === b.id).headline, 'waiting:memory');
  w.close();
});

test('C10 Docker stopped in the cached probe: no lease, waiting:docker; Docker back: leases resume', () => {
  const w = execWorld({ docker: 'stopped' }); const runner = new FakeRunner(); w.exec.attachRunner(runner, w.bootId);
  const { job } = w.exec.start(w.me, w.req('sde.build.run'));
  w.exec.tick(w.now());
  assert.equal(w.jobState(job.id), 'queued'); assert.equal(w.job(job.id).phase, 'waiting:docker');
  assert.equal(w.exec.health().docker.state, 'stopped');
  w.setProbe({ docker: 'running' }); w.exec.tick(w.now());
  assert.equal(w.jobState(job.id), 'leased');
  w.close();
});

test('C11 a missing or mismatched image: waiting:image, and the action is unavailable setup:image_missing / image_mismatch', () => {
  const w = execWorld({ images: [{ profile: 'sde-node', present: false, digestMatches: false }, { profile: 'sde-python', present: true, digestMatches: false, imageId: 'sha256:' + '2'.repeat(64) }] });
  const runner = new FakeRunner(); w.exec.attachRunner(runner, w.bootId);
  const { job } = w.exec.start(w.me, w.req('sde.build.run'));
  w.exec.tick(w.now());
  assert.equal(w.jobState(job.id), 'queued'); assert.equal(w.job(job.id).phase, 'waiting:image');
  assert.deepEqual(w.exec.setupAvailability({ actionId: 'sde.build.run' }), { available: false, reason: 'setup:image_missing' });
  w.setProbe({ images: [{ profile: 'sde-node', present: true, digestMatches: false, imageId: 'sha256:' + '1'.repeat(64) },
    { profile: 'sde-python', present: true, digestMatches: true, imageId: 'sha256:' + '2'.repeat(64) }] });
  w.exec.tick(w.now());
  assert.equal(w.job(job.id).phase, 'waiting:image');
  assert.deepEqual(w.exec.setupAvailability({ actionId: 'sde.build.run' }), { available: false, reason: 'setup:image_mismatch' });
  w.close();
});

test('C12 disk below the lease floor: waiting:disk; image preparation below 30 GiB: setup:disk_low', () => {
  const w = execWorld({ freeBytes: 4 * GIB }); const runner = new FakeRunner(); w.exec.attachRunner(runner, w.bootId);
  const { job } = w.exec.start(w.me, w.req('sde.build.run'));
  w.exec.tick(w.now());
  assert.equal(w.job(job.id).phase, 'waiting:disk');
  w.setProbe({ freeBytes: 20 * GIB }); w.exec.tick(w.now());
  assert.equal(w.jobState(job.id), 'leased', 'above the 5 GiB lease floor');
  assert.deepEqual(w.exec.setupAvailability({ imagePreparation: true }), { available: false, reason: 'setup:disk_low' });
  w.setProbe({ freeBytes: 31 * GIB });
  assert.deepEqual(w.exec.setupAvailability({ imagePreparation: true }), { available: true, reason: null });
  w.close();
});

test('C13 unknown attempt, another boot, a repeated or lower seq, and malformed reports are dropped with one log line and no write', () => {
  const w = execWorld(); const runner = new FakeRunner(); w.exec.attachRunner(runner, w.bootId);
  const { job } = w.exec.start(w.me, w.req('sde.build.run')); w.exec.tick(w.now()); const a = w.provision(runner, job.id);
  runner.report({ op: 'attempt.event', attemptId: a.id, seq: 5, event: { t: 'phase', phase: 'running', at: w.now() } });
  const snap = () => ({ ev: h.count(w.db, 'job_events'), act: h.count(w.db, 'activity'), at: JSON.stringify(w.attempt(a.id)), job: JSON.stringify(w.job(job.id)) });
  const before = snap(); const logs0 = w.logs.length;
  runner.report({ op: 'attempt.heartbeat', attemptId: newId(w.now()), at: w.now(), logBytes: 1, outBytes: 1 });
  // A second, foreign boot: an attempt row of this database leased by another boot id.
  const other = newId(w.now() + 1);
  const b = w.exec.start(w.me, w.req('sde.build.run')).job; w.exec.tick(w.now());
  const ba = w.liveAttempt(b.id);
  w.db.prepare('UPDATE job_attempts SET lease_owner = ? WHERE id = ?').run(other, ba.id);
  const before2 = { ...snap(), b: JSON.stringify(w.attempt(ba.id)) }; const logs1 = w.logs.length;
  runner.report({ op: 'attempt.provisioned', attemptId: ba.id, containerId: 'd'.repeat(64), preflight: passingPreflight() });
  runner.report({ op: 'attempt.event', attemptId: a.id, seq: 5, event: { t: 'phase', phase: 'collecting', at: w.now() } });
  runner.report({ op: 'attempt.event', attemptId: a.id, seq: 4, event: { t: 'phase', phase: 'collecting', at: w.now() } });
  runner.report({ op: 'attempt.exited', attemptId: a.id });
  runner.report({ op: 'attempt.heartbeat', attemptId: 'not-an-id', at: 1, logBytes: 0, outBytes: 0 });
  runner.report(null);
  assert.equal(w.logs.length - logs1, 6, w.logs.slice(logs1).join('\n'));
  assert.ok(w.logs.slice(logs0).every((l) => /dropped runner message/.test(l)));
  assert.deepEqual({ ...snap(), b: JSON.stringify(w.attempt(ba.id)) }, before2);
  assert.equal(before.ev <= before2.ev, true);
  w.close();
});

test('C14 a heartbeat extends the lease and sets heartbeat_at only; a 45 s gap writes one heartbeat_gap event', () => {
  const w = execWorld(); const runner = new FakeRunner(); w.exec.attachRunner(runner, w.bootId);
  const { job } = w.exec.start(w.me, w.req('sde.build.run')); w.exec.tick(w.now()); const a = w.provision(runner, job.id);
  const act0 = h.count(w.db, 'activity'); const ev0 = h.count(w.db, 'job_events');
  w.advance(10_000);
  runner.report({ op: 'attempt.heartbeat', attemptId: a.id, at: w.now(), logBytes: 50, outBytes: 7, container: 'running' });
  assert.equal(w.attempt(a.id).heartbeat_at, null, 'the message path does no heartbeat I/O');
  w.exec.tick(w.now());
  const r = w.attempt(a.id);
  assert.equal(r.heartbeat_at, w.now()); assert.equal(r.lease_expires_at, w.now() + 60_000); assert.equal(r.log_bytes, 50); assert.equal(r.out_bytes, 7);
  assert.equal(h.count(w.db, 'activity'), act0); assert.equal(h.count(w.db, 'job_events'), ev0);
  w.run(null, 46_000); w.exec.tick(w.now());
  assert.equal(w.events(job.id, 'attempt.heartbeat_gap').length, 1);
  runner.report({ op: 'attempt.heartbeat', attemptId: a.id, at: w.now(), logBytes: 60, outBytes: 7, container: 'running' });
  w.exec.tick(w.now()); w.run(null, 46_000);
  assert.equal(w.events(job.id, 'attempt.heartbeat_gap').length, 2, 'a new gap after a heartbeat is a new event');
  w.close();
});

test('C15 the per-project queue cap: the 21st waiting job is invalid queue_full', () => {
  const w = execWorld();
  for (let i = 0; i < 20; i++) w.exec.start(w.me, w.req('sde.build.run'));
  assert.throws(() => w.exec.start(w.me, w.req('sde.build.run')), code('invalid', 'queue_full'));
  w.close();
});

test('C16 attempt.refused before start: the attempt is abandoned, the job waits again, and the next lease is n = 2', () => {
  const w = execWorld(); const runner = new FakeRunner(); w.exec.attachRunner(runner, w.bootId);
  const { job } = w.exec.start(w.me, w.req('sde.build.run')); w.exec.tick(w.now());
  const a = w.liveAttempt(job.id);
  runner.report({ op: 'attempt.refused', attemptId: a.id, reason: 'docker_stopped' });
  assert.equal(w.attempt(a.id).state, 'abandoned'); assert.equal(w.jobState(job.id), 'queued'); assert.equal(w.job(job.id).phase, 'waiting:docker');
  assert.equal(w.job(job.id).attempts, 1);
  w.exec.tick(w.now());
  assert.equal(w.liveAttempt(job.id), undefined, 'a 2 s backoff before the next lease');
  w.advance(2_000); w.exec.tick(w.now());
  assert.equal(w.liveAttempt(job.id).n, 2);
  w.close();
});

test('C17 a docker create resources fault fails the job infra_error with its reason; retried only when idempotent', () => {
  const w = execWorld(); const runner = new FakeRunner(); w.exec.attachRunner(runner, w.bootId);
  const b = w.exec.start(w.me, w.req('sde.build.run')).job; w.exec.tick(w.now());
  const ba = w.liveAttempt(b.id);
  runner.report({ op: 'fault', message: 'write /var/lib/docker: no space left on device', attemptId: ba.id, failureClass: 'disk_full' });
  assert.equal(w.jobState(b.id), 'failed'); assert.equal(w.job(b.id).outcome, 'infra_error');
  assert.equal(JSON.parse(w.job(b.id).error_json).code, 'disk_full'); assert.equal(w.attempt(ba.id).outcome, 'disk_full');
  const d = w.exec.start(w.me, w.req('sde.tests.discover')).job; w.exec.tick(w.now());
  runner.report({ op: 'fault', message: 'Minimum memory limit allowed is 6MB', attemptId: w.liveAttempt(d.id).id, failureClass: 'docker_resources' });
  assert.equal(w.jobState(d.id), 'retry_scheduled');
  assert.equal(JSON.parse(w.events(d.id, 'job.transition').find((e) => JSON.parse(e.data_json).to === 'failed').data_json).error, 'docker_resources');
  // A fault not naming a starting attempt of this boot is counted, never attributed.
  runner.report({ op: 'fault', message: 'docker daemon restarted' });
  assert.equal(w.exec.health().runner.faults, 1);
  w.close();
});

test('C18 -> leased and the attempt insert are atomic: a throw between them leaves the job queued and no attempt', () => {
  const w = execWorld(); const runner = new FakeRunner();
  let fail = true;
  w.nx.exec.deps.hooks = { afterLeaseTransition: () => { if (fail) throw new Error('injected'); } };
  w.exec.attachRunner(runner, w.bootId);
  const { job } = w.exec.start(w.me, w.req('sde.build.run'));
  w.exec.tick(w.now());
  assert.equal(w.jobState(job.id), 'queued'); assert.equal(w.job(job.id).attempts, 0); assert.equal(w.attempts(job.id).length, 0);
  assert.equal(runner.sentOf('attempt.start').length, 0);
  fail = false; w.exec.tick(w.now());
  assert.equal(w.jobState(job.id), 'leased'); assert.equal(w.liveAttempt(job.id).n, 1);
  w.close();
});

test('C19 every job transition writes one activity row and one job_events row; the activity chain verifies', () => {
  const w = execWorld(); const runner = new FakeRunner(); w.exec.attachRunner(runner, w.bootId);
  const { job } = w.exec.start(w.me, w.req('sde.build.run')); w.exec.tick(w.now()); w.provision(runner, job.id);
  w.exit(runner, job.id, { code: 2 });
  assert.equal(w.jobState(job.id), 'failed'); assert.equal(w.job(job.id).outcome, 'nonzero_exit');
  const acts = w.activity(job.id, 'job.transition');
  const evs = w.events(job.id, 'job.transition').filter((e) => JSON.parse(e.data_json).from !== null);
  assert.equal(acts.length, 3); assert.equal(evs.length, 3);
  assert.deepEqual(evs.map((e) => JSON.parse(e.data_json).to), ['leased', 'running', 'failed']);
  assert.deepEqual(acts.map((a) => JSON.parse(a.details_json).to), ['leased', 'running', 'failed']);
  assert.equal(verifyActivityChain(w.db).ok, true);
  w.close();
});

test('C20 a hung runner never blocks main: 1000 reports, each its own task, keep the loop and every read within budget', async () => {
  const w = execWorld(); const runner = new FakeRunner({ neverAnswers: true }); w.exec.attachRunner(runner, w.bootId);
  const { job } = w.exec.start(w.me, w.req('sde.build.run')); w.exec.tick(w.now()); w.provision(runner, job.id);
  const id = w.liveAttempt(job.id).id;
  const lags = []; let last = performance.now();
  const timer = setInterval(() => { const t = performance.now(); lags.push(t - last - 5); last = t; }, 5);
  for (let i = 0; i < 1000; i++) {
    // A MessagePort delivers each message as its own task; a burst within one second is coalesced to one write.
    await new Promise((r) => setImmediate(r));
    runner.report({ op: 'attempt.heartbeat', attemptId: id, at: w.now(), logBytes: i, outBytes: 0, container: 'running' });
  }
  const t0 = performance.now(); w.exec.list(w.me, { projectId: w.projectId }); w.exec.get(w.me, job.id);
  assert.ok(performance.now() - t0 < 50, 'reads answer within 50 ms');
  await new Promise((r) => setTimeout(r, 50)); clearInterval(timer);
  assert.ok(Math.max(...lags) < 100, `event loop lag ${Math.max(...lags)} ms`);
  w.exec.tick(w.now());
  assert.equal(w.attempt(id).log_bytes, 999, 'the coalesced heartbeats were written by the tick');
  w.close();
});

test('C20b while the clock advances every heartbeat is a real write (by the tick), and the handler p99 stays within a few ms', async () => {
  const w = execWorld(); const runner = new FakeRunner({ neverAnswers: true }); w.exec.attachRunner(runner, w.bootId);
  const { job } = w.exec.start(w.me, w.req('sde.build.run')); w.exec.tick(w.now()); w.provision(runner, job.id);
  const id = w.liveAttempt(job.id).id;
  const handler = []; const ticks = [];
  for (let i = 0; i < 1000; i++) {
    await new Promise((r) => setImmediate(r));
    w.advance(500);                        // 500 s in all: inside the 15 min wall clock
    const t = performance.now();
    runner.report({ op: 'attempt.heartbeat', attemptId: id, at: w.now(), logBytes: i, outBytes: 0, container: 'running' });
    handler.push(performance.now() - t);
    await new Promise((r) => setImmediate(r));
    const t1 = performance.now(); w.exec.tick(w.now()); ticks.push(performance.now() - t1);   // the tick writes it: a real write per heartbeat
    if (i % 100 === 0) assert.equal(w.attempt(id).heartbeat_at, w.now());
  }
  assert.equal(w.attempt(id).heartbeat_at, w.now()); assert.equal(w.attempt(id).log_bytes, 999);
  const pct = (xs, q) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length * q)];
  assert.ok(pct(handler, 0.99) < 5, `heartbeat handler p99 ${pct(handler, 0.99).toFixed(2)} ms`);
  assert.ok(pct(ticks, 0.5) < 5, `tick (with its heartbeat write) median ${pct(ticks, 0.5).toFixed(2)} ms`);
  assert.ok(pct(ticks, 0.99) < 50, `tick (with its heartbeat write) p99 ${pct(ticks, 0.99).toFixed(2)} ms`);
  console.log(`# C20b handler p50 ${pct(handler, 0.5).toFixed(3)} p99 ${pct(handler, 0.99).toFixed(3)} ms; tick p50 ${pct(ticks, 0.5).toFixed(3)} p99 ${pct(ticks, 0.99).toFixed(3)} ms`);
  w.close();
});

test('C21 the engine plan for repo.snapshot carries the project folder from the projects row through acceptFsRoot, never from params', () => {
  const w = execWorld(); const runner = new FakeRunner(); w.exec.attachRunner(runner, w.bootId);
  assert.throws(() => w.exec.start(w.me, w.req('sde.repository.snapshot', { params: { repoPath: 'C:/elsewhere' } })), code('invalid', 'bad_params'));
  const { job } = w.exec.start(w.me, w.req('sde.repository.snapshot'));
  w.exec.tick(w.now());
  const plan = runner.lastStart().plan;
  assert.equal(plan.kind, 'engine'); assert.deepEqual(plan.task, { engine: 'repo.snapshot', repoPath: 'C:/work/ledger-api' });
  assert.deepEqual(w.fsRootCalls, ['C:/work/ledger-api']);
  // An engine attempt runs on a container-less provisioned report and records its sandbox and environment.
  const a = w.liveAttempt(job.id);
  runner.report({ op: 'attempt.provisioned', attemptId: a.id });
  assert.equal(w.jobState(job.id), 'running'); assert.equal(JSON.parse(w.attempt(a.id).sandbox_json).executor, 'engine');
  // A folder main refuses: the attempt never starts.
  const w2 = execWorld({ acceptFsRoot: () => null }); const r2 = new FakeRunner(); w2.exec.attachRunner(r2, w2.bootId);
  const j2 = w2.exec.start(w2.me, w2.req('sde.repository.snapshot')).job; w2.exec.tick(w2.now());
  assert.equal(w2.jobState(j2.id), 'failed'); assert.equal(JSON.parse(w2.job(j2.id).error_json).code, 'project_folder_unavailable');
  assert.equal(r2.sentOf('attempt.start').length, 0);
  w.close(); w2.close();
});

test('C22 egress never appears in a plan without a consumed approval of this job (plan builder and start)', () => {
  const recipe = getRecipe('sde.deps.node');
  const base = { job: { id: newId(), projectId: 'p' }, attempt: { id: newId(), n: 1 }, bootId: newId(), recipe,
    profile: require('./helpers/execWorld.cjs').PROFILES[0], imageId: 'sha256:' + '1'.repeat(64), dataHomeRoot: h.tmpDir('nx-plan-'),
    workRel: 'work/j/1', logRel: 'logs/jobs/j/1.log', inputs: [] };
  const ok = { id: 'ap1', job_id: base.job.id, status: 'approved', consumed_at: 1, consumed_by_job_id: base.job.id, consumed_by_attempt_n: 1 };
  for (const bad of [null, { ...ok, job_id: 'other' }, { ...ok, status: 'pending', consumed_at: null, consumed_by_job_id: null, consumed_by_attempt_n: null },
    { ...ok, consumed_at: null }, { ...ok, consumed_by_attempt_n: 2 }, { ...ok, consumed_by_job_id: 'other' }]) {
    assert.throws(() => buildPlan({ ...base, approval: bad }), code('invalid', 'network_not_approved'), JSON.stringify(bad));
  }
  assert.deepEqual(buildPlan({ ...base, approval: ok }).container.network, { mode: 'egress-approved', approvalId: 'ap1', purpose: 'deps' });
  // A non-egress recipe never gets egress, even with an approval in hand.
  assert.deepEqual(buildPlan({ ...base, recipe: getRecipe('sde.build.node'), approval: ok }).container.network, { mode: 'none' });
  // Through start: no approval path in the build -> refused; with one, nothing is sent until the approval is consumed.
  const w = execWorld();
  assert.throws(() => w.exec.start(w.me, w.req('sde.deps.install')), code('invalid', 'approvals_unavailable'));
  const w2 = execWorld({ approvals: true }); const r2 = new FakeRunner(); w2.exec.attachRunner(r2, w2.bootId);
  w2.exec.start(w2.me, w2.req('sde.deps.install')); w2.exec.tick(w2.now());
  assert.equal(r2.sentOf('attempt.start').length, 0);
  w.close(); w2.close();
});

test('C23 a completed tests job whose suite failed sde.tests_pass has the headline checks_failed, never completed', () => {
  let seen = null;
  const ingest = { ingestTx(ctx) {
    seen = ctx;
    // Task 8 records evidence here; the test records one failed blocking result for the suite, bound to the job and attempt.
    w.db.prepare(`INSERT INTO validations (id, version_id, validator_id, validator_version, stage, status, blocking, advisory, summary, evidence_json,
        job_id, attempt_n, created_by, started_at, finished_at) VALUES (?, ?, 'sde.tests_pass', '1', 'candidate', 'failed', 1, 0, 'no tests were executed', '[]', ?, ?, 'system', ?, ?)`)
      .run(newId(), w.suiteV, ctx.job.id, ctx.attempt.n, w.now(), w.now());
    return { ok: true };
  } };
  const w = execWorld({ ingest }); const runner = new FakeRunner(); w.exec.attachRunner(runner, w.bootId);
  const { job } = w.exec.start(w.me, w.req('sde.tests.run')); w.exec.tick(w.now()); w.provision(runner, job.id);
  w.exit(runner, job.id, { code: 1, outputs: ['junit.xml'] });
  assert.equal(w.jobState(job.id), 'completed'); assert.equal(seen.recipe.id, 'sde.test.node');
  assert.equal(w.attempts(job.id)[0].state, 'succeeded');
  assert.equal(w.exec.get(w.me, job.id).headline, 'checks_failed');
  // A tests exit without its junit.xml never reaches ingest.
  const j2 = w.exec.start(w.me, w.req('sde.tests.run')).job; w.exec.tick(w.now()); w.provision(runner, j2.id, { c: 'e' });
  seen = null; w.exit(runner, j2.id, { code: 0, outputs: [] });
  assert.equal(seen, null); assert.equal(w.jobState(j2.id), 'failed'); assert.equal(w.job(j2.id).outcome, 'invalid_output');
  assert.equal(w.exec.get(w.me, j2.id).headline, 'failed');
  w.close();
});

test('C24 container env in every plan holds only allow-listed names, never a host variable or a secret-shaped value', () => {
  const w = execWorld({ dockerMemoryBytes: 64 * GIB }); const runner = new FakeRunner(); w.exec.attachRunner(runner, w.bootId);
  process.env.NEXUS_TEST_HOST_SECRET = 'sk-' + 'x'.repeat(30);
  for (const a of ['sde.build.run', 'sde.tests.discover', 'sde.tests.run']) w.exec.start(w.me, w.req(a));
  w.exec.tick(w.now());
  const starts = runner.sentOf('attempt.start');
  assert.equal(starts.length, 3);
  for (const s of starts) {
    for (const [k, v] of Object.entries(s.plan.container.env)) {
      assert.ok(ALLOWED_ENV_NAMES.includes(k), k);
      assert.equal(containsSecret({ [k]: v }), false, k);
      assert.ok(!Object.values(process.env).includes(v) || ['true', '1', 'test', 'production'].includes(v), `${k} is not a host value`);
    }
    assert.ok(Array.isArray(s.plan.container.argv) && s.plan.container.argv.every((x) => typeof x === 'string'));
    for (const m of s.plan.container.mounts) {
      if (m.kind === 'input' || m.kind === 'out') assert.ok(m.hostPath.startsWith(w.dataHome.root), m.hostPath);
      else assert.match(m.hostPath, /^nexus-(ws|deps)-/);
    }
  }
  delete process.env.NEXUS_TEST_HOST_SECRET;
  assert.throws(() => loadTs('src/main/nexus/exec/planBuilder.ts').checkEnv({ PATH: '/usr/bin' }), code('invalid', 'env_not_allowed'));
  assert.throws(() => loadTs('src/main/nexus/exec/planBuilder.ts').checkEnv({ HOME: 'ghp_' + 'A1b2'.repeat(9) }), code('invalid', 'secret_in_env'));
  w.close();
});

test('GC: while blob GC holds its exclusive lock no attempt is leased or started; the next tick after release leases', () => {
  const w = execWorld(); const runner = new FakeRunner(); w.exec.attachRunner(runner, w.bootId);
  assert.ok(w.nx.blobs, 'one BlobIndex is composed with execution');
  const { job } = w.exec.start(w.me, w.req('sde.build.run'));
  const release = w.nx.blobs.lock.tryExclusive();
  assert.ok(release);
  w.exec.tick(w.now());
  assert.equal(w.jobState(job.id), 'queued'); assert.equal(w.attempts(job.id).length, 0); assert.equal(runner.sentOf('attempt.start').length, 0);
  release();
  w.exec.tick(w.now());
  assert.equal(w.jobState(job.id), 'leased'); assert.equal(runner.sentOf('attempt.start').length, 1);
  w.close();
});

test('availability: with execution off every service refuses platform_unavailable (not_enabled / sub-reason) and no v9 table is touched', () => {
  const w = execWorld({ execution: false });
  assert.equal(w.nx.executionAvailable, false); assert.equal(w.nx.blobs, null);
  const counts = () => ['job_attempts', 'job_events', 'approvals', 'jobs'].map((t) => h.count(w.db, t));
  const before = counts();
  for (const f of [() => w.exec.start(w.me, w.req('sde.build.run')), () => w.exec.list(w.me, {}), () => w.exec.get(w.me, 'x'),
    () => w.exec.cancel(w.me, 'x'), () => w.exec.retry(w.me, 'x', 'i'), () => w.exec.eventsSince(w.me, { sinceSeq: 0 })]) {
    assert.throws(f, code('platform_unavailable', 'not_enabled'));
  }
  const runner = new FakeRunner(); w.exec.attachRunner(runner, w.bootId);
  assert.equal(runner.sent.length, 0);
  w.exec.tick(w.now()); w.exec.onRunnerMessage({ op: 'fault', message: 'x' });
  assert.deepEqual(counts(), before);
  assert.deepEqual(w.exec.health().execution, { available: false, reason: 'not_enabled' });
  w.close();
  const held = execWorld({ execution: false, unavailableReason: 'held' });
  assert.throws(() => held.exec.list(held.me, {}), code('platform_unavailable', 'held'));
  held.close();
});

test('reads: list, get and eventsSince authorize, page and carry the headline', () => {
  const w = execWorld(); const runner = new FakeRunner(); w.exec.attachRunner(runner, w.bootId);
  const a = w.exec.start(w.me, w.req('sde.build.run')).job; w.exec.start(w.me, w.req('sde.build.run'));
  w.exec.tick(w.now()); w.provision(runner, a.id);
  const l = w.exec.list(w.me, { projectId: 'p-ledger', limit: 1 });
  assert.equal(l.jobs.length, 1); assert.equal(l.truncated, true);
  const d = w.exec.get(w.me, a.id);
  assert.equal(d.headline, 'running'); assert.equal(d.attemptHistory.length, 1); assert.equal(d.attemptHistory[0].network, 'none');
  assert.equal(d.attemptHistory[0].preflight.ok, true);
  const ev = w.exec.eventsSince(w.me, { sinceSeq: 0, projectId: 'p-ledger', limit: 3 });
  assert.equal(ev.events.length, 3); assert.equal(ev.lastSeq, ev.events[2].seq);
  const more = w.exec.eventsSince(w.me, { sinceSeq: ev.lastSeq, projectId: 'p-ledger' });
  assert.ok(more.events.every((e) => e.seq > ev.lastSeq));
  const stranger = w.addUser('user:qa', 'workspace', 'qa', 'owner');
  assert.throws(() => w.exec.get(stranger, a.id), code('denied'));
  assert.throws(() => w.exec.eventsSince(stranger, { sinceSeq: 0, projectId: 'p-ledger' }), code('denied'));
  assert.throws(() => w.exec.list(w.me, { limit: 501 }), code('invalid'));
  w.close();
});

// ---------- fix round 1 ----------

test('F1 an ingest that throws never loses the exit: attempt and job fail ingest_error (retryable), the container is released', () => {
  const ingest = { ingestTx() { throw new Error('disk went away'); } };
  const w = execWorld({ ingest }); const runner = new FakeRunner(); w.exec.attachRunner(runner, w.bootId);
  const { job } = w.exec.start(w.me, w.req('sde.tests.discover')); w.exec.tick(w.now()); const a = w.provision(runner, job.id);
  w.exit(runner, job.id, { code: 0, outputs: ['ids.txt'] });
  assert.equal(w.attempt(a.id).state, 'failed'); assert.equal(w.attempt(a.id).outcome, 'ingest_error');
  assert.equal(w.jobState(job.id), 'retry_scheduled', 'idempotent: retried');
  assert.equal(JSON.parse(w.events(job.id, 'job.transition').find((e) => JSON.parse(e.data_json).to === 'failed').data_json).error, 'ingest_error');
  assert.ok(runner.sentOf('attempt.release').some((m) => m.attemptId === a.id));
  w.close();
});

test('F2 a plan that does not reach the runner: the attempt is abandoned and the job waits again; the next lease is n = 2', () => {
  const w = execWorld(); const runner = new FakeRunner({ failSend: (m) => m.op === 'attempt.start' }); w.exec.attachRunner(runner, w.bootId);
  const { job } = w.exec.start(w.me, w.req('sde.build.run')); w.exec.tick(w.now());
  const [a1] = w.attempts(job.id);
  assert.equal(a1.state, 'abandoned'); assert.equal(a1.outcome, 'not_sent');
  assert.equal(w.jobState(job.id), 'queued'); assert.equal(w.job(job.id).phase, 'waiting:runner');
  runner.o.failSend = null; w.advance(2_000); w.exec.tick(w.now());
  assert.equal(w.liveAttempt(job.id).n, 2);
  w.close();
});

test('F3 a lease that runs out without a heartbeat fails the attempt runner_lost (retryable); an approval wait holds no lease', () => {
  const w = execWorld({ approvals: true }); const runner = new FakeRunner(); w.exec.attachRunner(runner, w.bootId);
  const s = w.exec.start(w.me, w.req('sde.tests.discover')).job; const r = w.exec.start(w.me, w.req('sde.build.run')).job;
  const d = w.exec.start(w.me, w.req('sde.deps.install')).job;
  w.exec.tick(w.now()); w.provision(runner, r.id);
  w.run(null, 65_000);                     // normal 5 s ticking, no heartbeat
  assert.equal(w.attempts(s.id)[0].outcome, 'runner_lost'); assert.equal(w.jobState(s.id), 'retry_scheduled', 'starting attempt, idempotent');
  assert.equal(w.attempts(r.id)[0].outcome, 'runner_lost'); assert.equal(w.jobState(r.id), 'failed', 'running attempt, not idempotent');
  assert.equal(JSON.parse(w.job(r.id).error_json).code, 'runner_lost');
  assert.equal(w.jobState(d.id), 'awaiting_approval'); assert.equal(w.liveAttempt(d.id).state, 'starting');
  w.close();
});

test('F4 the single container above the memory share is allowed only up to 85 % of Docker memory', () => {
  const w = execWorld({ dockerMemoryBytes: 2 * GIB }); const runner = new FakeRunner(); w.exec.attachRunner(runner, w.bootId);
  const { job } = w.exec.start(w.me, w.req('sde.build.run'));
  w.exec.tick(w.now());
  assert.equal(w.jobState(job.id), 'queued'); assert.equal(w.job(job.id).phase, 'waiting:memory', '2048 MiB > 85 % of 2 GiB');
  assert.deepEqual(w.exec.setupAvailability({ actionId: 'sde.build.run' }), { available: false, reason: 'setup:docker_memory_low' });
  w.setProbe({ memoryBytes: 3 * GIB }); w.exec.tick(w.now());
  assert.equal(w.jobState(job.id), 'leased', '2048 MiB <= 85 % of 3 GiB');
  w.close();
});

test('F5 a job waiting for approval holds no slot; the caps are checked again when it resumes', () => {
  const w = execWorld({ approvals: true, dockerMemoryBytes: 64 * GIB }); const runner = new FakeRunner(); w.exec.attachRunner(runner, w.bootId);
  const d = w.exec.start(w.me, w.req('sde.deps.install')).job; w.exec.tick(w.now());
  assert.equal(w.jobState(d.id), 'awaiting_approval');
  const builds = [0, 1, 2].map(() => w.exec.start(w.me, w.req('sde.build.run')).job); w.exec.tick(w.now());
  assert.ok(builds.every((b) => w.jobState(b.id) === 'leased'), 'three slots free while the deps job waits');
  const da = w.liveAttempt(d.id);
  w.db.prepare(`UPDATE approvals SET status = 'approved', decided_by = 'user:local', decided_at = ?, decision = 'once', consumed_at = ?,
    consumed_by_job_id = ?, consumed_by_attempt_n = ?, status_changed_at = ? WHERE job_id = ?`).run(w.now(), w.now(), d.id, da.n, w.now(), d.id);
  assert.throws(() => w.exec.resumeApproved(d.id), code('conflict', 'waiting:slots'));
  assert.equal(w.jobState(d.id), 'awaiting_approval');
  w.exec.cancel(w.me, builds[0].id);
  w.exec.resumeApproved(d.id)();
  assert.equal(w.jobState(d.id), 'running'); assert.equal(runner.lastStart().plan.jobId, d.id);
  w.close();
});

test('F6 a passing provisioned report for an attempt cancelled while provisioning releases the container', () => {
  const w = execWorld(); const runner = new FakeRunner(); w.exec.attachRunner(runner, w.bootId);
  const { job } = w.exec.start(w.me, w.req('sde.build.run')); w.exec.tick(w.now());
  const a = w.liveAttempt(job.id);
  w.exec.cancel(w.me, job.id);
  runner.report({ op: 'attempt.provisioned', attemptId: a.id, containerId: 'c'.repeat(64), imageDigest: w.IMAGE['sde-node'], preflight: passingPreflight() });
  assert.equal(w.attempt(a.id).state, 'cancelled'); assert.equal(w.attempt(a.id).container_id, null);
  assert.ok(runner.sentOf('attempt.release').some((m) => m.attemptId === a.id));
  w.close();
});

test('F7 an ingest that says ok but binds no evidence to the attempt completes nothing (no_evidence)', () => {
  const w = execWorld({ ingest: { ingestTx: () => ({ ok: true }) } }); const runner = new FakeRunner(); w.exec.attachRunner(runner, w.bootId);
  const { job } = w.exec.start(w.me, w.req('sde.tests.run')); w.exec.tick(w.now()); w.provision(runner, job.id);
  w.exit(runner, job.id, { code: 0, outputs: ['junit.xml'] });
  assert.equal(w.jobState(job.id), 'failed'); assert.equal(w.job(job.id).outcome, 'no_evidence');
  assert.equal(w.attempts(job.id)[0].state, 'failed');
  w.close();
});

test('F8 a discovered test file name may not start with "-" (never an option to node --test)', () => {
  const recipe = getRecipe('sde.test.node');
  const base = { job: { id: newId(), projectId: 'p' }, attempt: { id: newId(), n: 1 }, bootId: newId(), recipe,
    profile: require('./helpers/execWorld.cjs').PROFILES[0], imageId: 'sha256:' + '1'.repeat(64), dataHomeRoot: h.tmpDir('nx-plan-'),
    workRel: 'work/j/1', logRel: 'logs/jobs/j/1.log' };
  const input = (files) => [{ versionId: 'v', slot: 'suite', contentHash: 'h', storage: { kind: 'inline' }, metadata: { framework: 'node-test', files } }];
  for (const bad of ['--require=x.js', '-e', '../a.test.js', './a.test.js', '/abs.test.js', 'a/../b.js'])
    assert.throws(() => buildPlan({ ...base, inputs: input([bad]) }), code('invalid', 'bad_input'), bad);
  assert.deepEqual(buildPlan({ ...base, inputs: input(['test/a-b.test.js']) }).container.argv.slice(-1), ['test/a-b.test.js']);
});

test('F9 observability: environment records the Nexus version and lockfile hash; sandbox keeps argv, its count and hash; nexus.kind label', () => {
  const lock = 'ab'.repeat(32);
  const w = execWorld({ repoMeta: { lockfile: { path: 'package-lock.json', sha256: lock } }, appVersion: '0.4.4' }); const runner = new FakeRunner(); w.exec.attachRunner(runner, w.bootId);
  const { job } = w.exec.start(w.me, w.req('sde.build.run')); w.exec.tick(w.now());
  const a = w.liveAttempt(job.id);
  const env = JSON.parse(a.environment_json); const sb = JSON.parse(a.sandbox_json);
  assert.equal(env.nexusVersion, '0.4.4'); assert.equal(env.lockfileSha256, lock);
  const plan = runner.lastStart().plan;
  assert.equal(plan.container.labels['nexus.kind'], 'tool');
  assert.equal(sb.argvCount, plan.container.argv.length); assert.deepEqual(sb.argv, plan.container.argv);
  assert.equal(sb.argvSha256, require('node:crypto').createHash('sha256').update(JSON.stringify(plan.container.argv)).digest('hex'));
  w.close();
});

test('F10 start authorizes first: a viewer with bad params and bad inputs is denied, with one audit row', async () => {
  const w = execWorld();
  const viewer = w.addUser('user:viewer2', 'project', 'p-ledger', 'viewer');
  assert.throws(() => w.exec.start(viewer, w.req('sde.diagnose', { params: { target: 'job', targetId: '../x', extra: 1 }, inputs: [{ versionId: 'nope', slot: 'x' }] })), code('denied'));
  assert.throws(() => w.exec.start(viewer, { ...w.req('sde.build.run'), actionId: 'no.such.action' }), code('denied'));
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(w.db.prepare("SELECT COUNT(*) AS n FROM activity WHERE status = 'denied' AND actor_id = 'user:viewer2'").get().n, 2);
  w.close();
});

// ---------- fix round 2 ----------

test('N1 a port that throws on send never loops: backoff per job, then the runner counts as not ready until it reports again', () => {
  const w = execWorld(); const runner = new FakeRunner({ failSend: (m) => m.op === 'attempt.start' }); w.exec.attachRunner(runner, w.bootId);
  const { job } = w.exec.start(w.me, w.req('sde.build.run'));
  const ev0 = h.count(w.db, 'job_events'); const act0 = h.count(w.db, 'activity');
  for (let i = 0; i < 20; i++) { w.exec.tick(w.now()); w.advance(1_000); }
  const n = w.attempts(job.id).length;
  assert.ok(n <= 3, `attempts stay bounded: ${n}`);
  assert.ok(h.count(w.db, 'job_events') - ev0 < 25 && h.count(w.db, 'activity') - act0 < 10, 'events and activity stay bounded');
  assert.equal(w.jobState(job.id), 'queued'); assert.equal(w.job(job.id).phase, 'waiting:runner');
  // A fresh probe result: the runner is ready again; once the backoff ends the job leases and starts.
  runner.o.failSend = null; w.setProbe({});
  w.advance(60_000); w.exec.tick(w.now());
  assert.equal(w.jobState(job.id), 'leased'); assert.equal(runner.lastStart().plan.jobId, job.id);
  w.close();
});

test('N1b a runner that refuses with a waiting reason while the probe says ready is retried with a growing delay, not every tick', () => {
  const w = execWorld(); const runner = new FakeRunner(); w.exec.attachRunner(runner, w.bootId);
  const { job } = w.exec.start(w.me, w.req('sde.build.run'));
  for (let i = 0; i < 20; i++) {
    w.exec.tick(w.now());
    const a = w.liveAttempt(job.id);
    if (a) runner.report({ op: 'attempt.refused', attemptId: a.id, reason: 'docker_stopped' });
    w.advance(1_000);
  }
  const n = w.attempts(job.id).length;
  assert.ok(n <= 5, `attempts stay bounded: ${n}`);
  const delays = w.attempts(job.id).map((a) => a.created_at).map((t, i, xs) => (i ? t - xs[i - 1] : 0)).slice(1);
  assert.ok(delays.every((d, i) => i === 0 || d >= delays[i - 1]), `the delay grows: ${delays}`);
  w.close();
});

test('N2 a stall of main longer than a lease does not fail a healthy attempt; a silent one still expires after normal ticking', () => {
  const w = execWorld(); const runner = new FakeRunner(); w.exec.attachRunner(runner, w.bootId);
  const a = w.exec.start(w.me, w.req('sde.build.run')).job; const b = w.exec.start(w.me, w.req('sde.build.run')).job;
  w.exec.tick(w.now()); w.provision(runner, a.id); w.provision(runner, b.id, { c: 'd' });
  w.heartbeatAll(runner); w.exec.tick(w.now());
  // Pc1: the machine sleeps 90 s; the first tick after it runs before the queued heartbeats arrive.
  const probes = runner.sentOf('probe').length;
  w.advance(90_000); w.exec.tick(w.now());
  assert.equal(w.jobState(a.id), 'running'); assert.equal(w.jobState(b.id), 'running');
  assert.equal(runner.sentOf('probe').length, probes + 1, 'the runner is probed after a stall');
  // a's heartbeats resume; b stays silent: b expires only after a full lease of normal ticking.
  for (let t = 0; t < 55_000; t += 5_000) { w.advance(5_000); runner.report({ op: 'attempt.heartbeat', attemptId: w.liveAttempt(a.id).id, at: w.now(), logBytes: 1, outBytes: 0, container: 'running' }); w.exec.tick(w.now()); }
  assert.equal(w.jobState(b.id), 'running', 'not yet a full lease since the stall');
  for (let t = 0; t < 10_000; t += 5_000) { w.advance(5_000); runner.report({ op: 'attempt.heartbeat', attemptId: w.liveAttempt(a.id).id, at: w.now(), logBytes: 1, outBytes: 0, container: 'running' }); w.exec.tick(w.now()); }
  assert.equal(w.jobState(a.id), 'running');
  assert.equal(w.attempts(b.id)[0].outcome, 'runner_lost');
  w.close();
});

test('N2b the wall clock excludes a stall: an attempt is not timed out by time main spent stalled', () => {
  const w = execWorld(); const runner = new FakeRunner(); w.exec.attachRunner(runner, w.bootId);
  const { job } = w.exec.start(w.me, w.req('sde.build.run')); w.exec.tick(w.now()); w.provision(runner, job.id);
  w.run(runner, 10 * MIN);
  w.advance(10 * MIN); w.exec.tick(w.now());            // a 10 min stall: 20 min since lease, 10 counted
  w.heartbeatAll(runner); w.exec.tick(w.now());
  assert.equal(w.jobState(job.id), 'running');
  w.run(runner, 6 * MIN);
  assert.equal(w.jobState(job.id), 'timed_out', '16 counted minutes > 15');
  w.close();
});

test('N3 a consumed approval that could not start is resumed by the scheduler once a slot frees', () => {
  const w = execWorld({ approvals: true, dockerMemoryBytes: 64 * GIB }); const runner = new FakeRunner(); w.exec.attachRunner(runner, w.bootId);
  const d = w.exec.start(w.me, w.req('sde.deps.install')).job; w.exec.tick(w.now());
  const builds = [0, 1, 2].map(() => w.exec.start(w.me, w.req('sde.build.run')).job); w.exec.tick(w.now());
  const da = w.liveAttempt(d.id);
  w.db.prepare(`UPDATE approvals SET status = 'approved', decided_by = 'user:local', decided_at = ?, decision = 'once', consumed_at = ?,
    consumed_by_job_id = ?, consumed_by_attempt_n = ?, status_changed_at = ? WHERE job_id = ?`).run(w.now(), w.now(), d.id, da.n, w.now(), d.id);
  assert.throws(() => w.exec.resumeApproved(d.id), code('conflict', 'waiting:slots'));
  w.exec.tick(w.now());
  assert.equal(w.jobState(d.id), 'awaiting_approval'); assert.equal(w.job(d.id).phase, 'waiting:slots');
  w.exec.cancel(w.me, builds[1].id);
  w.exec.tick(w.now());
  assert.equal(w.jobState(d.id), 'running');
  const plan = runner.lastStart().plan;
  assert.equal(plan.jobId, d.id); assert.equal(plan.container.network.mode, 'egress-approved');
  w.close();
});
