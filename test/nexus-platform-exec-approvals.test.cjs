'use strict';
// B2a Task 9: once-only approvals for dependency egress (A1) and image preparation (A2), image build records, local dev
// deployments with health probes, and repository snapshot rules. Real SQLite (Electron-as-node, `npm run test:db`), the
// execution core driven through a FakeRunner (no Docker, no runner process). Authorization is never mocked.
// A1-A10 approvals and images; D1-D8 dev deployments (N9's deployment part in D1b); R1-R3 snapshots; then the network and
// approval bypasses (constraint 11), secrets (constraint 6) and state rebuilt from SQLite alone (constraint 9). Every flow
// ends with O1-O17 at 0, an empty foreign_key_check and a verified activity chain.
const h = require('./helpers/sqlite.cjs');
if (!h.realSqliteOrSkip()) return;
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const loadTs = require('./load-ts.cjs');
const { execWorld, passingPreflight, PROFILES, GIB } = require('./helpers/execWorld.cjs');
const { FakeRunner } = require('./helpers/fakeRunner.cjs');
const { ALL_ZERO, execOrphanRows } = require('./helpers/orphans.cjs');
const { verifyActivityChain } = loadTs('src/main/nexus/activity/writer.ts');
const { buildPlan } = loadTs('src/main/nexus/exec/planBuilder.ts');
const { getRecipe } = loadTs('src/shared/nexus/recipes.ts');
const { newId } = loadTs('src/main/nexus/db/ids.ts');
const { canonicalJson } = loadTs('src/main/nexus/db/canonical.ts');
const { parseRunnerMessage } = loadTs('src/shared/nexus/runnerProtocol.ts');
const { checkoutNote, snapshotFacts } = loadTs('src/shared/nexus/repoSnapshot.ts');
const { requestHoldsSecret } = loadTs('src/main/nexus/approvals/approvalService.ts');
const { acceptManifestReport, APP_MANIFEST_MAX_BYTES } = loadTs('src/main/nexus/repo/repoService.ts');
const { trailing } = loadTs('src/main/nexus/deployments/deploymentService.ts');
const { createNexusPlatform } = loadTs('src/main/nexus/platform.ts');

const code = (c, reason) => (e) => e.code === c && (reason === undefined || e.detail?.reason === reason);
const MIN = 60_000;
const LOCK = '3f'.repeat(32);
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const MANIFEST = { version: 1, profile: 'sde-node', run: ['node', 'dist/server.js'], port: 3000, healthPath: '/health', env: [] };
const CTX = { contextSha256: 'c4'.repeat(32), baseDigest: 'sha256:' + 'b5'.repeat(32), estimatedBytes: 3 * GIB };
const count = (w, sql, ...a) => w.db.prepare(`SELECT COUNT(*) AS n FROM ${sql}`).get(...a).n;
const approvalOf = (w, jobId) => w.db.prepare('SELECT * FROM approvals WHERE job_id = ? ORDER BY requested_at DESC, rowid DESC').get(jobId);

function healthy(w) {
  assert.deepEqual(w.orphans(), ALL_ZERO, JSON.stringify(execOrphanRows(w.db)));
  assert.deepEqual(w.db.prepare('PRAGMA foreign_key_check').all(), []);
  assert.equal(verifyActivityChain(w.db).ok, true);
}

/** A world whose egress port is the platform's own ApprovalService, with a locked repository snapshot. */
function egressWorld(o = {}) {
  const w = execWorld({ approvals: 'real', repoMeta: { lockfile: { sha256: LOCK } }, dockerMemoryBytes: 64 * GIB, ...o });
  const r = w.attach();
  return { w, r };
}

/** Starts a dependency install and leases it (it waits for approval). */
function depsJob(w) {
  const d = w.exec.start(w.me, w.req('sde.deps.install')).job;
  w.exec.tick(w.now());
  return d;
}

// ---------- A: approvals ----------

test('A1 a dependency install waits in awaiting_approval with one pending approval naming the registries and the lockfile hash; nothing starts', () => {
  const { w, r } = egressWorld();
  const d = depsJob(w);
  assert.equal(w.jobState(d.id), 'awaiting_approval');
  assert.equal(w.liveAttempt(d.id).state, 'starting');
  const aps = w.db.prepare('SELECT * FROM approvals WHERE job_id = ?').all(d.id);
  assert.equal(aps.length, 1);
  const ap = aps[0];
  assert.equal(ap.status, 'pending'); assert.equal(ap.reason, 'egress.deps'); assert.equal(ap.project_id, 'p-ledger');
  const req = JSON.parse(ap.request_json);
  assert.deepEqual(req, { recipeId: 'sde.deps.node', recipeVersion: '1', jobId: d.id, lockfileSha256: LOCK, profile: 'sde-node',
    registries: ['registry.npmjs.org'] });
  assert.equal(ap.request_sha256, sha(canonicalJson({ recipeId: 'sde.deps.node', recipeVersion: '1', jobId: d.id, lockfileSha256: LOCK, profile: 'sde-node' })));
  assert.equal(ap.expires_at - ap.requested_at, 15 * MIN);
  assert.equal(ap.requested_by, 'system'); assert.equal(ap.on_behalf_of, w.me.id);
  assert.equal(r.sentOf('attempt.start').length, 0, 'the runner received no start');
  // leased -> running (phase approval) -> awaiting_approval, with the approval, in ONE transaction (one timestamp).
  const moves = w.events(d.id, 'job.transition').map((e) => ({ ...JSON.parse(e.data_json), ts: e.ts }));
  assert.deepEqual(moves.slice(-3).map((m) => `${m.from}>${m.to}`), ['queued>leased', 'leased>running', 'running>awaiting_approval']);
  assert.equal(new Set([...moves.slice(-3).map((m) => m.ts), ap.requested_at]).size, 1);
  assert.equal(w.exec.list(w.me, { projectId: 'p-ledger' }).jobs.find((j) => j.id === d.id).headline, 'waiting_for_approval');
  // Observability: who asked (the system), for whom (the user), why (egress.deps), and the event of the wait.
  const ev = w.db.prepare("SELECT * FROM job_events WHERE approval_id = ? AND type = 'approval'").all(ap.id);
  assert.equal(ev.length, 1); assert.equal(ev[0].job_id, d.id); assert.equal(ev[0].attempt_n, 1);
  // No activity action the renderer cannot phrase yet (nexus-activity-model AC1): the approval row is the record.
  assert.equal(count(w, "activity WHERE action LIKE 'approval.%' AND status <> 'denied'"), 0);
  // The view names no principal and shows the request's known fields.
  const view = w.nx.approvals.list(w.me, { projectId: 'p-ledger' }).approvals[0];
  assert.equal(view.id, ap.id); assert.deepEqual(view.request.registries, ['registry.npmjs.org']); assert.equal(view.request.lockfileSha256, LOCK);
  assert.ok(!JSON.stringify(view).includes('user:local') && !JSON.stringify(view).includes('"system"'));
  healthy(w); w.close();
});

test('A1b a Python install names its two registries; a snapshot without a lockfile hash fails at lease and asks nothing', () => {
  const { w } = egressWorld({ profile: 'sde-python' });
  const d = depsJob(w);
  assert.deepEqual(JSON.parse(approvalOf(w, d.id).request_json).registries, ['pypi.org', 'files.pythonhosted.org']);
  assert.equal(JSON.parse(approvalOf(w, d.id).request_json).recipeId, 'sde.deps.python');
  w.close();
  const w2 = execWorld({ approvals: 'real' }); const r2 = w2.attach();
  const d2 = depsJob(w2);
  assert.equal(w2.jobState(d2.id), 'failed');
  assert.equal(JSON.parse(w2.job(d2.id).error_json).code, 'lockfile_missing');
  assert.equal(count(w2, 'approvals'), 0); assert.equal(r2.sentOf('attempt.start').length, 0);
  assert.equal(w2.attempts(d2.id)[0].state, 'failed');
  healthy(w2); w2.close();
});

test('A2 once: approved, consumed by the current attempt, the job running and the plan egress-approved with this approval, in one transaction', () => {
  const { w, r } = egressWorld();
  const d = depsJob(w); const ap = approvalOf(w, d.id); const a = w.liveAttempt(d.id);
  w.advance(1000);
  const v = w.nx.approvals.respond(w.me, ap.id, 'once');
  assert.equal(v.status, 'approved'); assert.equal(v.decision, 'once');
  const row = approvalOf(w, d.id);
  assert.equal(row.decided_by, w.me.id); assert.equal(row.consumed_at, w.now()); assert.equal(row.consumed_by_job_id, d.id);
  assert.equal(row.consumed_by_attempt_n, a.n);
  assert.equal(w.jobState(d.id), 'running');
  assert.equal(w.job(d.id).state_changed_at, row.consumed_at, 'the job moved in the approval transaction');
  const starts = r.sentOf('attempt.start');
  assert.equal(starts.length, 1);
  assert.equal(starts[0].attemptId, a.id);
  assert.deepEqual(starts[0].plan.container.network, { mode: 'egress-approved', approvalId: ap.id, purpose: 'deps' });
  assert.equal(JSON.parse(w.attempt(a.id).sandbox_json).network.approvalId, ap.id);
  const ev = w.db.prepare("SELECT * FROM job_events WHERE approval_id = ? AND type = 'approval' ORDER BY seq").all(ap.id).map((e) => JSON.parse(e.data_json));
  assert.equal(ev.length, 2); assert.equal(ev[0].approvalId, ap.id); assert.equal(ev[1].status, 'approved');
  assert.ok(!JSON.stringify(w.exec.eventsSince(w.me, { sinceSeq: 0, projectId: 'p-ledger' })).includes('user:local'), 'events name no principal');
  // The install runs and reports; dependency installs are ingested in Task 12 (no rule yet): never completed here.
  w.provision(r, d.id);
  assert.equal(w.jobState(d.id), 'running');
  healthy(w); w.close();
});

test('A2b once while the caps refuse: the approval is consumed, the job waits (phase waiting:slots), and the scheduler starts it later', () => {
  const { w, r } = egressWorld();
  const d = depsJob(w); const ap = approvalOf(w, d.id);
  const builds = [0, 1, 2].map(() => w.exec.start(w.me, w.req('sde.build.run')).job); w.exec.tick(w.now());
  assert.ok(builds.every((b) => w.jobState(b.id) === 'leased'));
  const v = w.nx.approvals.respond(w.me, ap.id, 'once');
  assert.equal(v.status, 'approved'); assert.notEqual(v.consumedAt, null);
  assert.equal(w.jobState(d.id), 'awaiting_approval'); assert.equal(w.job(d.id).phase, 'waiting:slots');
  assert.equal(r.sentOf('attempt.start').filter((m) => m.plan.jobId === d.id).length, 0);
  w.exec.tick(w.now());
  assert.equal(w.jobState(d.id), 'awaiting_approval', 'still no slot');
  w.exec.cancel(w.me, builds[0].id);
  w.exec.tick(w.now());
  assert.equal(w.jobState(d.id), 'running');
  assert.equal(r.lastStart().plan.container.network.approvalId, ap.id);
  healthy(w); w.close();
});

test('A3 deny: the approval is denied, the job fails denied, no plan is sent', () => {
  const { w, r } = egressWorld();
  const d = depsJob(w); const ap = approvalOf(w, d.id); const a = w.liveAttempt(d.id);
  const v = w.nx.approvals.respond(w.me, ap.id, 'deny');
  assert.equal(v.status, 'denied'); assert.equal(v.decision, 'deny'); assert.equal(v.consumedAt, null);
  assert.equal(w.jobState(d.id), 'failed'); assert.equal(w.job(d.id).outcome, 'denied');
  assert.equal(JSON.parse(w.job(d.id).error_json).code, 'approval_denied');
  assert.equal(w.attempt(a.id).state, 'failed'); assert.equal(w.attempt(a.id).outcome, 'denied');
  assert.equal(r.sentOf('attempt.start').length, 0);
  w.run(r, 2 * MIN);
  assert.equal(w.jobState(d.id), 'failed', 'never retried'); assert.equal(r.sentOf('attempt.start').length, 0);
  healthy(w); w.close();
});

test('A4 expiry: unanswered for 15 minutes the approval expires and the job fails denied; an answer after that is refused', () => {
  const { w, r } = egressWorld();
  const d = depsJob(w); const ap = approvalOf(w, d.id);
  w.run(r, 14 * MIN);
  assert.equal(approvalOf(w, d.id).status, 'pending'); assert.equal(w.jobState(d.id), 'awaiting_approval');
  w.run(r, 90_000);
  assert.equal(approvalOf(w, d.id).status, 'expired');
  assert.equal(w.jobState(d.id), 'failed'); assert.equal(w.job(d.id).outcome, 'denied');
  assert.equal(JSON.parse(w.job(d.id).error_json).code, 'approval_expired');
  assert.throws(() => w.nx.approvals.respond(w.me, ap.id, 'once'), code('illegal_transition'));
  assert.equal(r.sentOf('attempt.start').length, 0);
  // An answer that arrives after expires_at but before the sweep expires it and is refused.
  const d2 = depsJob(w); const ap2 = approvalOf(w, d2.id);
  w.advance(15 * MIN + 1);
  assert.throws(() => w.nx.approvals.respond(w.me, ap2.id, 'once'), code('illegal_transition', 'expired'));
  assert.equal(approvalOf(w, d2.id).status, 'expired'); assert.equal(w.jobState(d2.id), 'failed');
  assert.equal(r.sentOf('attempt.start').length, 0);
  healthy(w); w.close();
});

test('A5 a second answer is illegal_transition (after once and after deny)', () => {
  const { w } = egressWorld();
  const d1 = depsJob(w); const a1 = approvalOf(w, d1.id);
  w.nx.approvals.respond(w.me, a1.id, 'once');
  assert.throws(() => w.nx.approvals.respond(w.me, a1.id, 'once'), code('illegal_transition'));
  assert.throws(() => w.nx.approvals.respond(w.me, a1.id, 'deny'), code('illegal_transition'));
  const d2 = depsJob(w); const a2 = approvalOf(w, d2.id);
  w.nx.approvals.respond(w.me, a2.id, 'deny');
  assert.throws(() => w.nx.approvals.respond(w.me, a2.id, 'once'), code('illegal_transition'));
  assert.equal(approvalOf(w, d2.id).status, 'denied');
  // No "always" or "for the session": only once or deny.
  const d3 = depsJob(w); const a3 = approvalOf(w, d3.id);
  for (const bad of ['always', 'session', 'ONCE', '', null]) assert.throws(() => w.nx.approvals.respond(w.me, a3.id, bad), code('invalid', 'bad_decision'));
  assert.equal(approvalOf(w, d3.id).status, 'pending');
  healthy(w); w.close();
});

test('A6 an approval of job A never starts job B: the plan builder refuses it, the database refuses it, the runner\'s refusal fails the job', () => {
  const { w, r } = egressWorld();
  const A = depsJob(w); const B = depsJob(w);
  const apA = approvalOf(w, A.id); const apB = approvalOf(w, B.id);
  w.nx.approvals.respond(w.me, apA.id, 'once');
  assert.equal(w.jobState(A.id), 'running'); assert.equal(w.jobState(B.id), 'awaiting_approval');
  assert.equal(r.sentOf('attempt.start').filter((m) => m.plan.jobId === B.id).length, 0);
  // The plan builder: A's consumed approval in B's plan.
  const rowA = w.db.prepare('SELECT id, job_id, status, consumed_at, consumed_by_job_id, consumed_by_attempt_n FROM approvals WHERE id = ?').get(apA.id);
  const bA = w.liveAttempt(B.id);
  const base = { job: { id: B.id, projectId: 'p-ledger' }, attempt: { id: bA.id, n: bA.n }, bootId: w.bootId, recipe: getRecipe('sde.deps.node'),
    profile: PROFILES[0], imageId: w.IMAGE['sde-node'], dataHomeRoot: w.dataHome.root, workRel: 'work/b/1', logRel: 'logs/jobs/b/1.log', inputs: [] };
  assert.throws(() => buildPlan({ ...base, approval: rowA }), code('invalid', 'network_not_approved'));
  // The core: resuming B with only A's approval in the database is refused, and nothing is sent for B.
  assert.throws(() => w.exec.resumeApproved(B.id), code('invalid', 'network_not_approved'));
  assert.equal(w.jobState(B.id), 'awaiting_approval');
  w.exec.tick(w.now());
  assert.equal(r.sentOf('attempt.start').filter((m) => m.plan.jobId === B.id).length, 0);
  // The database: B's approval cannot be consumed for another job (CHECK consumed_by_job_id IS job_id).
  assert.throws(() => w.db.prepare(`UPDATE approvals SET status = 'approved', decided_by = 'user:local', decided_at = ?, decision = 'once',
    consumed_at = ?, consumed_by_job_id = ?, consumed_by_attempt_n = 1, status_changed_at = ? WHERE id = ?`).run(w.now(), w.now(), A.id, w.now(), apB.id), /CHECK/);
  assert.equal(approvalOf(w, B.id).status, 'pending');
  // The runner refuses a plan whose approval id does not match: the job fails (not requeued, not retried).
  const aA = w.liveAttempt(A.id);
  r.report({ op: 'attempt.refused', attemptId: aA.id, reason: 'network_not_approved', detail: 'approval id mismatch' });
  assert.equal(w.jobState(A.id), 'failed'); assert.equal(w.attempt(aA.id).outcome, 'network_not_approved');
  w.run(r, 2 * MIN);
  assert.equal(w.jobState(A.id), 'failed');
  healthy(w); w.close();
});

test('A6b an approval consumed by attempt 1 never serves attempt 2 of the same job', () => {
  const { w, r } = egressWorld();
  const d = depsJob(w); const ap1 = approvalOf(w, d.id);
  w.nx.approvals.respond(w.me, ap1.id, 'once');
  const a1 = w.provision(r, d.id);
  // The container vanishes: an idempotent install is retried with attempt 2.
  r.report({ op: 'attempt.heartbeat', attemptId: a1.id, at: w.now(), logBytes: 0, outBytes: 0, container: 'missing' });
  assert.equal(w.jobState(d.id), 'retry_scheduled');
  w.run(r, 15_000);
  assert.equal(w.jobState(d.id), 'awaiting_approval'); assert.equal(w.liveAttempt(d.id).n, 2);
  const ap2 = approvalOf(w, d.id);
  assert.notEqual(ap2.id, ap1.id); assert.equal(ap2.status, 'pending');
  const startsBefore = r.sentOf('attempt.start').length;
  assert.throws(() => w.exec.resumeApproved(d.id), code('invalid', 'network_not_approved'));
  w.run(r, 30_000);
  assert.equal(r.sentOf('attempt.start').length, startsBefore, 'attempt 1\'s approval starts nothing');
  w.nx.approvals.respond(w.me, ap2.id, 'once');
  assert.equal(r.lastStart().plan.container.network.approvalId, ap2.id); assert.equal(r.lastStart().plan.attemptN, 2);
  healthy(w); w.close();
});

test('A7 cancel while waiting withdraws the pending approval; a withdrawn approval starts nothing', () => {
  const { w, r } = egressWorld();
  const d = depsJob(w); const ap = approvalOf(w, d.id);
  w.exec.cancel(w.me, d.id);
  assert.equal(approvalOf(w, d.id).status, 'withdrawn'); assert.equal(w.jobState(d.id), 'cancelled');
  assert.equal(w.db.prepare("SELECT COUNT(*) AS n FROM activity WHERE action = 'approval.withdraw' AND entity_id = ?").get(ap.id).n, 1);
  assert.throws(() => w.nx.approvals.respond(w.me, ap.id, 'once'), code('illegal_transition'));
  assert.throws(() => w.exec.resumeApproved(d.id), code('illegal_transition'));
  w.run(r, MIN);
  assert.equal(r.sentOf('attempt.start').length, 0);
  healthy(w); w.close();
});

test('A8 only a user answers: the system principal, an agent or a non-owner is denied (audited); the database refuses a non-user decision (T11)', () => {
  const { w, r } = egressWorld();
  const d = depsJob(w); const ap = approvalOf(w, d.id);
  assert.throws(() => w.nx.approvals.respond(w.sys, ap.id, 'once'), code('denied', 'user_only'));
  assert.equal(w.db.prepare("SELECT COUNT(*) AS n FROM activity WHERE status = 'denied' AND actor_id = 'system' AND action = 'approval.respond'").get().n, 1);
  w.db.prepare("INSERT INTO principals VALUES ('agent:bot', 'agent', 'bot', NULL, ?)").run(h.NOW);
  assert.throws(() => w.nx.approvals.respond({ id: 'agent:bot', kind: 'agent', displayName: 'bot' }, ap.id, 'once'), code('denied', 'user_only'));
  assert.throws(() => w.nx.approvals.respond({ id: 'system', kind: 'user', displayName: 'forged' }, ap.id, 'once'), code('denied', 'user_only'));
  const member = w.addUser('user:member', 'project', 'p-ledger', 'member');
  assert.throws(() => w.nx.approvals.respond(member, ap.id, 'once'), code('denied'));
  assert.equal(approvalOf(w, d.id).status, 'pending'); assert.equal(w.jobState(d.id), 'awaiting_approval');
  // T11: the trigger refuses an approval decided by the system, whatever the service says.
  assert.throws(() => w.db.prepare(`UPDATE approvals SET status = 'approved', decided_by = 'system', decided_at = ?, decision = 'once',
    status_changed_at = ? WHERE id = ?`).run(w.now(), w.now(), ap.id), /only a user approves or denies/);
  assert.throws(() => w.db.prepare(`UPDATE approvals SET status = 'denied', decided_by = 'agent:bot', decided_at = ?, decision = 'deny',
    status_changed_at = ? WHERE id = ?`).run(w.now(), w.now(), ap.id), /only a user approves or denies/);
  assert.equal(approvalOf(w, d.id).status, 'pending');
  assert.equal(r.sentOf('attempt.start').length, 0);
  healthy(w); w.close();
});

// ---------- A9-A10: image preparation and image builds ----------

function imageWorld(o = {}) {
  const w = execWorld({ approvals: 'real', imageContexts: (id) => (id === 'sde-node' || id === 'nexus-fwd' ? CTX : null), ...o });
  const r = w.attach();
  return { w, r };
}

test('A9 image preparation: below 30 GiB free nothing is written; then an approval with sizes, once -> a running build, done -> succeeded', () => {
  const { w, r } = imageWorld({ freeBytes: 20 * GIB });
  assert.throws(() => w.nx.approvals.requestImage(w.me, 'sde-node', 'img-1'), code('unavailable', 'setup:disk_low'));
  assert.equal(count(w, 'approvals'), 0);
  w.setProbe({ freeBytes: 45 * GIB });
  const { approval, created } = w.nx.approvals.requestImage(w.me, 'sde-node', 'img-1');
  assert.equal(created, true); assert.equal(approval.status, 'pending'); assert.equal(approval.reason, 'image.prepare');
  assert.deepEqual(approval.request, { profileId: 'sde-node', contextSha256: CTX.contextSha256, baseDigest: CTX.baseDigest,
    estimatedBytes: 3 * GIB, freeBytesNow: 45 * GIB });
  assert.equal(approval.projectId, null); assert.equal(approval.jobId, null);
  const row = w.db.prepare('SELECT * FROM approvals WHERE id = ?').get(approval.id);
  assert.equal(row.request_sha256, sha(canonicalJson({ profileId: 'sde-node', contextSha256: CTX.contextSha256, baseDigest: CTX.baseDigest, estimatedBytes: 3 * GIB })));
  // A second request while one is pending returns it.
  assert.equal(w.nx.approvals.requestImage(w.me, 'sde-node', 'img-2').approval.id, approval.id);
  assert.equal(w.nx.approvals.requestImage(w.me, 'sde-node', 'img-2').created, false);
  const v = w.nx.approvals.respond(w.me, approval.id, 'once');
  assert.equal(v.status, 'approved'); assert.equal(v.imageBuild.status, 'running');
  const b = w.db.prepare('SELECT * FROM image_builds WHERE approval_id = ?').get(approval.id);
  assert.equal(b.status, 'running'); assert.equal(b.profile_id, 'sde-node'); assert.equal(b.context_sha256, CTX.contextSha256);
  assert.equal(b.requested_by, w.me.id); assert.equal(b.started_at, w.db.prepare('SELECT consumed_at FROM approvals WHERE id = ?').get(approval.id).consumed_at);
  assert.deepEqual(r.sentOf('image.build.start'), [{ op: 'image.build.start', buildId: b.id, profile: 'sde-node', approvalId: approval.id, contextSha256: CTX.contextSha256 }]);
  // A second request while the build runs: conflict.
  assert.throws(() => w.nx.approvals.requestImage(w.me, 'sde-node', 'img-3'), code('conflict', 'build_running'));
  r.report({ op: 'image.build.progress', buildId: b.id, at: w.now(), phase: 'pulling base', bytes: 100 });
  r.report({ op: 'image.build.progress', buildId: b.id, at: w.now(), phase: 'pulling base', bytes: 200 });
  assert.equal(count(w, "job_events WHERE image_build_id = ? AND type = 'image_build' AND summary LIKE '%pulling base%'", b.id), 1, 'one event per phase');
  r.report({ op: 'image.build.done', buildId: b.id, outcome: 'succeeded', imageId: 'sha256:' + 'e6'.repeat(32), sizeBytes: 2 * GIB });
  const done = w.db.prepare('SELECT * FROM image_builds WHERE id = ?').get(b.id);
  assert.equal(done.status, 'succeeded'); assert.equal(done.image_id, 'sha256:' + 'e6'.repeat(32)); assert.equal(done.size_bytes, 2 * GIB);
  assert.ok(r.sentOf('probe').length >= 2, 'a fresh probe is asked for');
  assert.equal(w.nx.approvals.imageBuilds(w.me)[0].status, 'succeeded');
  // A late report for a finished build changes nothing.
  r.report({ op: 'image.build.done', buildId: b.id, outcome: 'failed', error: 'late' });
  assert.equal(w.db.prepare('SELECT status FROM image_builds WHERE id = ?').get(b.id).status, 'succeeded');
  healthy(w); w.close();
});

test('A9b a failed build stores its error redacted; Docker stopped or an unknown profile is refused before any row; deny writes no build', () => {
  const { w, r } = imageWorld({ freeBytes: 45 * GIB });
  const token = 'ghp_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8';
  const { approval } = w.nx.approvals.requestImage(w.me, 'nexus-fwd', 'f-1');
  w.nx.approvals.respond(w.me, approval.id, 'once');
  const b = w.db.prepare('SELECT * FROM image_builds WHERE approval_id = ?').get(approval.id);
  r.report({ op: 'image.build.done', buildId: b.id, outcome: 'failed', error: `step 3 failed: pip said token=${token}` });
  const failed = w.db.prepare('SELECT * FROM image_builds WHERE id = ?').get(b.id);
  assert.equal(failed.status, 'failed'); assert.equal(JSON.parse(failed.error_json).code, 'build_failed');
  for (const t of ['image_builds', 'approvals', 'job_events', 'activity']) {
    assert.equal(w.db.prepare(`SELECT COUNT(*) AS n FROM ${t} WHERE CAST(${t === 'image_builds' ? 'error_json' : t === 'approvals' ? 'request_json' : t === 'job_events' ? 'data_json' : 'details_json'} AS TEXT) LIKE ?`).get(`%${token}%`).n, 0, t);
  }
  // After a failure a new request is allowed.
  const again = w.nx.approvals.requestImage(w.me, 'nexus-fwd', 'f-2').approval;
  assert.equal(w.nx.approvals.respond(w.me, again.id, 'deny').status, 'denied');
  assert.equal(count(w, 'image_builds WHERE approval_id = ?', again.id), 0);
  assert.throws(() => w.nx.approvals.requestImage(w.me, 'qa-web', 'q-1'), code('invalid', 'unknown_profile'));
  assert.throws(() => w.nx.approvals.requestImage(w.me, 'sde-python', 'p-1'), code('invalid', 'unknown_profile'), 'no build context for it');
  const before = count(w, 'approvals');
  w.setProbe({ docker: 'stopped' });
  assert.throws(() => w.nx.approvals.requestImage(w.me, 'sde-node', 'n-1'), code('unavailable', 'setup:docker_stopped'));
  assert.equal(count(w, 'approvals'), before);
  // Only a user (owner) asks.
  assert.throws(() => w.nx.approvals.requestImage(w.sys, 'sde-node', 'n-2'), code('denied', 'user_only'));
  const viewer = w.addUser('user:viewer', 'platform', '*', 'viewer');
  assert.throws(() => w.nx.approvals.requestImage(viewer, 'sde-node', 'n-3'), code('denied'));
  healthy(w); w.close();
});

test('A10 health: an image whose context label differs from the latest succeeded build is image_mismatch', () => {
  const { w, r } = imageWorld({ freeBytes: 45 * GIB });
  const { approval } = w.nx.approvals.requestImage(w.me, 'sde-node', 'i-1');
  w.nx.approvals.respond(w.me, approval.id, 'once');
  const b = w.db.prepare('SELECT * FROM image_builds WHERE approval_id = ?').get(approval.id);
  r.report({ op: 'image.build.done', buildId: b.id, outcome: 'succeeded', imageId: w.IMAGE['sde-node'], sizeBytes: GIB });
  const img = (ctx) => [{ profile: 'sde-node', present: true, digestMatches: true, imageId: w.IMAGE['sde-node'], contextSha256: ctx },
    { profile: 'sde-python', present: true, digestMatches: true, imageId: w.IMAGE['sde-python'] }];
  w.setProbe({ images: img('d7'.repeat(32)) });
  const node = () => w.exec.health().images.find((i) => i.profile === 'sde-node');
  assert.equal(node().present, true); assert.equal(node().matches, false);
  assert.ok(w.exec.health().gate.problems.some((p) => p.id === 'image_mismatch' && p.profile === 'sde-node'));
  assert.deepEqual(w.exec.setupAvailability({ actionId: 'sde.build.run' }), { available: false, reason: 'setup:image_mismatch' });
  const j = w.exec.start(w.me, w.req('sde.build.run')).job; w.exec.tick(w.now());
  assert.equal(w.jobState(j.id), 'queued'); assert.equal(w.job(j.id).phase, 'waiting:image');
  // A python image with no build of its own is judged by its digest only.
  assert.equal(w.exec.health().images.find((i) => i.profile === 'sde-python').matches, true);
  // The image built from this context matches again.
  w.setProbe({ images: img(CTX.contextSha256) });
  assert.equal(node().matches, true);
  w.exec.tick(w.now());
  assert.equal(w.jobState(j.id), 'leased');
  healthy(w); w.close();
});

// ---------- D: local dev deployments ----------

/** A candidate build and a draft application assembled from it (manifest_schema passed, waiting for its deployment). */
async function appDraft(w, manifest = MANIFEST, tag = 'a') {
  const b = await w.runBuild({ files: [{ path: 'server.js', content: `server ${tag}` }], exit: 0 });
  w.answerVerifies(w.attach(), true); await w.settle();
  assert.equal(w.version(b.buildVersionId).status, 'candidate');
  const runner = w.attach();
  const job = w.exec.start(w.me, w.req('sde.app.assemble', { inputs: [{ versionId: b.buildVersionId, slot: 'build' }] })).job;
  w.exec.tick(w.now()); w.provisionEngine(runner, job.id);
  w.exitWith(runner, job.id, { code: 0, parsed: [{ parser: 'app-manifest', sourceSha256: 'd'.repeat(64), normalized: { manifest } }] });
  await w.settle();
  const app = w.db.prepare('SELECT id FROM artifact_versions WHERE produced_by_job_id = ?').get(job.id).id;
  assert.equal(w.version(app).status, 'draft');
  return { app, build: b.buildVersionId };
}

async function deployWorld(o = {}) {
  const w = execWorld({ realIngest: true, fwd: true, dockerMemoryBytes: 64 * GIB, ...o });
  const { app, build } = await appDraft(w, o.manifest);
  return { w, r: w.attach(), app, build };
}

const preview = (w, app) => w.exec.start(w.me, w.req('sde.preview.start', { inputs: [{ versionId: app, slot: 'application' }] })).job;
const dep = (w, jobId) => w.db.prepare('SELECT * FROM deployments WHERE job_id = ?').get(jobId);
function provisionService(w, r, jobId, port, c = 'e') {
  const a = w.liveAttempt(jobId);
  r.report({ op: 'attempt.provisioned', attemptId: a.id, containerId: c.repeat(64), imageDigest: w.IMAGE['sde-node'], preflight: passingPreflight(), hostPort: port });
  return a;
}
/** One probe 5 s later (main's clock), with the scheduler's tick and a heartbeat, as a live runner sends them. */
function probe(w, r, a, status, container = 'running') {
  w.advance(5_000);
  r.report({ op: 'attempt.heartbeat', attemptId: a.id, at: w.now(), logBytes: 0, outBytes: 0, container: container === 'running' ? 'running' : 'exited' });
  r.report({ op: 'service.health', attemptId: a.id, at: w.now(), status, ms: status === null ? null : 4, container });
  w.exec.tick(w.now());
}

test('D1 preview of a draft application: the job runs the build, the deployment previews the draft; a 200 makes it healthy and the draft a candidate', async () => {
  const { w, r, app, build } = await deployWorld();
  const j = preview(w, app);
  assert.deepEqual(w.db.prepare('SELECT version_id, role FROM job_inputs WHERE job_id = ?').all(j.id), [{ version_id: build, role: 'build' }]);
  w.exec.tick(w.now());
  const d0 = dep(w, j.id);
  assert.equal(d0.status, 'starting'); assert.equal(d0.subject_version_id, app); assert.equal(d0.bind_address, '127.0.0.1');
  assert.equal(d0.host_port, null); assert.equal(d0.environment, 'local-preview');
  const plan = r.lastStart().plan;
  assert.equal(plan.kind, 'service'); assert.equal(plan.deploymentId, d0.id);
  assert.deepEqual(plan.app.argv, MANIFEST.run); assert.deepEqual(plan.app.network, { mode: 'service-internal', network: `nexus-svc-${j.id.toLowerCase()}` });
  assert.deepEqual(plan.app.service, { containerPort: 3000, healthPath: '/health' });
  assert.deepEqual(plan.forwarder.publish, { hostIp: '127.0.0.1', hostPort: 0, containerPort: 8080 });
  assert.deepEqual(plan.forwarder.argv, ['socat', 'TCP-LISTEN:8080,fork,reuseaddr', 'TCP:app:3000']);
  assert.deepEqual(plan.networks, { internal: `nexus-svc-${j.id.toLowerCase()}`, publish: `nexus-pub-${j.id.toLowerCase()}` });
  assert.equal(plan.staging.blobs.length, 1); assert.equal(plan.staging.blobs[0].relPath, 'dist/server.js');
  assert.equal(plan.idleTtlMs, 2 * 60 * MIN);
  const a = provisionService(w, r, j.id, 49200);
  assert.equal(w.jobState(j.id), 'running'); assert.equal(dep(w, j.id).host_port, 49200);
  probe(w, r, a, null); probe(w, r, a, 503);
  assert.equal(dep(w, j.id).status, 'starting'); assert.equal(w.version(app).status, 'draft');
  probe(w, r, a, 200);
  assert.equal(dep(w, j.id).status, 'healthy');
  const v = w.latest(app, 'app.preview_health');
  assert.equal(v.status, 'passed'); assert.equal(v.job_id, j.id); assert.equal(v.attempt_n, a.n); assert.equal(v.blocking, 1);
  assert.equal(w.version(app).status, 'candidate');
  assert.equal(JSON.parse(dep(w, j.id).health_json).length, 3);
  const view = w.nx.deployments.list(w.me, { projectId: 'p-ledger' }).deployments[0];
  assert.equal(view.url, 'http://127.0.0.1:49200/health'); assert.equal(view.status, 'healthy'); assert.equal(view.lifetimeMs, 2 * 60 * MIN);
  assert.equal(view.endsAt, view.startedAt + 2 * 60 * MIN);
  assert.equal(w.exec.list(w.me, { projectId: 'p-ledger' }).jobs.find((x) => x.id === j.id).headline, 'running');
  healthy(w); w.close();
});

test('D1b (N9) no 200 within 60 s: the deployment fails probe_failed, app.preview_health fails and the draft fails; the job fails', async () => {
  const { w, r, app } = await deployWorld();
  const j = preview(w, app); w.exec.tick(w.now());
  const a = provisionService(w, r, j.id, 49201);
  for (let i = 0; i < 12; i++) probe(w, r, a, i < 4 ? null : 503);
  assert.equal(dep(w, j.id).status, 'starting');
  probe(w, r, a, 503);
  const d = dep(w, j.id);
  assert.equal(d.status, 'failed'); assert.equal(d.stop_reason, 'probe_failed'); assert.equal(d.stopped_by, null);
  const v = w.latest(app, 'app.preview_health');
  assert.equal(v.status, 'failed'); assert.match(v.summary, /no_health/);
  assert.equal(w.version(app).status, 'failed');
  assert.equal(w.jobState(j.id), 'failed'); assert.equal(w.job(j.id).outcome, 'probe_failed');
  assert.ok(r.sentOf('attempt.cancel').some((m) => m.attemptId === a.id));
  // A container that never started within the window: start_timeout, the check could not run (the draft stays a draft).
  const w2 = await deployWorld();
  const j2 = preview(w2.w, w2.app); w2.w.exec.tick(w2.w.now());
  w2.w.run(w2.r, 65_000);
  assert.equal(dep(w2.w, j2.id).stop_reason, 'start_timeout');
  assert.equal(w2.w.latest(w2.app, 'app.preview_health').status, 'error');
  assert.equal(w2.w.version(w2.app).status, 'draft');
  assert.equal(w2.w.jobState(j2.id), 'failed');
  healthy(w); healthy(w2.w); w.close(); w2.w.close();
});

test('D2 three failed probes make a healthy deployment unhealthy; two good ones make it healthy again', async () => {
  const { w, r, app } = await deployWorld();
  const j = preview(w, app); w.exec.tick(w.now());
  const a = provisionService(w, r, j.id, 49202);
  probe(w, r, a, 200);
  assert.equal(dep(w, j.id).status, 'healthy');
  probe(w, r, a, 500); probe(w, r, a, null);
  assert.equal(dep(w, j.id).status, 'healthy', 'two failures');
  probe(w, r, a, 502);
  assert.equal(dep(w, j.id).status, 'unhealthy');
  probe(w, r, a, 200);
  assert.equal(dep(w, j.id).status, 'unhealthy', 'one success');
  probe(w, r, a, 200);
  assert.equal(dep(w, j.id).status, 'healthy');
  const moves = w.db.prepare("SELECT data_json FROM job_events WHERE deployment_id = ? AND type = 'deployment' ORDER BY seq").all(dep(w, j.id).id)
    .map((e) => JSON.parse(e.data_json)).filter((x) => x.to && x.from).map((x) => `${x.from}>${x.to}`);
  assert.deepEqual(moves, ['starting>healthy', 'healthy>unhealthy', 'unhealthy>healthy']);
  // health_json keeps the last 50 probes.
  for (let i = 0; i < 60; i++) probe(w, r, a, 200);
  assert.equal(JSON.parse(dep(w, j.id).health_json).length, 50);
  assert.equal(trailing([{ status: 200 }, { status: 500 }, { status: null }], (p) => p.status !== 200), 2);
  healthy(w); w.close();
});

test('D3 the container exits: the deployment fails (exited); the job completes stopped only if it had been healthy', async () => {
  const { w, r, app } = await deployWorld();
  // (a) healthy, then the container exits.
  const j = preview(w, app); w.exec.tick(w.now());
  const a = provisionService(w, r, j.id, 49203);
  probe(w, r, a, 200);
  probe(w, r, a, null, 'exited');
  assert.equal(dep(w, j.id).status, 'failed'); assert.equal(dep(w, j.id).stop_reason, 'exited');
  assert.equal(w.jobState(j.id), 'running', 'it waits for the exit report'); assert.equal(w.job(j.id).phase, 'stopping');
  r.report({ op: 'attempt.exited', attemptId: a.id, exit: { code: 137, oomKilled: false, finishedAt: w.now() }, outputs: [], parsed: [], logBytes: 10 });
  assert.equal(w.jobState(j.id), 'completed'); assert.equal(w.job(j.id).outcome, 'stopped');
  assert.equal(w.attempt(a.id).state, 'succeeded'); assert.equal(w.attempt(a.id).exit_code, 137);
  assert.ok(r.sentOf('attempt.release').some((m) => m.attemptId === a.id));
  assert.equal(w.exec.list(w.me, { projectId: 'p-ledger' }).jobs.find((x) => x.id === j.id).headline, 'checks_passed');
  // (b) never healthy: the exit fails the deployment, the check and the job (a second application draft).
  const { app: app2 } = await appDraft(w, MANIFEST, 'b');
  const j2 = preview(w, app2); w.exec.tick(w.now());
  const a2 = provisionService(w, r, j2.id, 49204, 'f');
  probe(w, r, a2, 503);
  r.report({ op: 'attempt.exited', attemptId: a2.id, exit: { code: 1, oomKilled: false, finishedAt: w.now() }, outputs: [], parsed: [], logBytes: 10 });
  assert.equal(dep(w, j2.id).status, 'failed'); assert.equal(dep(w, j2.id).stop_reason, 'exited');
  assert.equal(w.jobState(j2.id), 'failed'); assert.equal(w.job(j2.id).outcome, 'exited');
  assert.equal(w.latest(app2, 'app.preview_health').status, 'failed'); assert.match(w.latest(app2, 'app.preview_health').summary, /container_exited/);
  assert.equal(w.version(app2).status, 'failed');
  healthy(w); w.close();
});

test('D4 a user stop: stopped (user); the runner is told; the job completes stopped; a stop of a stopped deployment is illegal_transition', async () => {
  const { w, r, app } = await deployWorld();
  const j = preview(w, app); w.exec.tick(w.now());
  const a = provisionService(w, r, j.id, 49205);
  probe(w, r, a, 200);
  const d = dep(w, j.id);
  const viewer = w.addUser('user:viewer', 'project', 'p-ledger', 'viewer');
  assert.throws(() => w.nx.deployments.stop(viewer, d.id), code('denied'));
  const v = w.nx.deployments.stop(w.me, d.id);
  assert.equal(v.status, 'stopped'); assert.equal(v.stopReason, 'user'); assert.equal(v.url, null);
  assert.equal(dep(w, j.id).stopped_by, w.me.id);
  assert.ok(r.sentOf('attempt.cancel').some((m) => m.attemptId === a.id && m.reason === 'user'));
  const stopEv = w.db.prepare("SELECT data_json FROM job_events WHERE deployment_id = ? AND type = 'deployment' ORDER BY seq DESC LIMIT 1").get(d.id);
  assert.deepEqual(JSON.parse(stopEv.data_json), { from: 'healthy', to: 'stopped', reason: 'user', hostPort: 49205, by: 'user' });
  assert.throws(() => w.nx.deployments.stop(w.me, d.id), code('illegal_transition'));
  assert.equal(w.jobState(j.id), 'running'); assert.equal(w.job(j.id).phase, 'stopping');
  r.report({ op: 'attempt.exited', attemptId: a.id, exit: { code: 0, oomKilled: false, finishedAt: w.now() }, outputs: [], parsed: [], logBytes: 10 });
  assert.equal(w.jobState(j.id), 'completed'); assert.equal(w.job(j.id).outcome, 'stopped');
  // A deployment stopped before its health check ends its job cancelled at once.
  const j2 = preview(w, app); w.exec.tick(w.now());
  const a2 = provisionService(w, r, j2.id, 49206, 'f');
  w.nx.deployments.stop(w.me, dep(w, j2.id).id);
  assert.equal(w.jobState(j2.id), 'cancelled'); assert.equal(w.attempt(a2.id).state, 'cancelled');
  assert.throws(() => w.nx.deployments.stop(w.me, 'nope'), code('not_found'));
  healthy(w); w.close();
});

test('D5 the service cap is 2: a third preview waits waiting:slots and starts when a slot frees', async () => {
  const { w, r, app } = await deployWorld();
  const jobs = [0, 1, 2].map(() => preview(w, app)); w.exec.tick(w.now());
  assert.equal(w.jobState(jobs[0].id), 'leased'); assert.equal(w.jobState(jobs[1].id), 'leased');
  assert.equal(w.jobState(jobs[2].id), 'queued'); assert.equal(w.job(jobs[2].id).phase, 'waiting:slots');
  assert.equal(dep(w, jobs[2].id), undefined, 'no deployment row before its lease');
  w.nx.deployments.stop(w.me, dep(w, jobs[0].id).id);
  w.exec.tick(w.now());
  assert.equal(w.jobState(jobs[2].id), 'leased'); assert.equal(dep(w, jobs[2].id).status, 'starting');
  healthy(w); w.close();
});

test('D6 two live deployments never share a port: the core refuses a held port and the unique index is the backstop', async () => {
  const { w, r, app } = await deployWorld();
  const j1 = preview(w, app); const j2 = preview(w, app); w.exec.tick(w.now());
  provisionService(w, r, j1.id, 49207);
  const a2 = provisionService(w, r, j2.id, 49207, 'f');
  assert.equal(dep(w, j1.id).host_port, 49207); assert.equal(dep(w, j2.id).host_port, null);
  assert.equal(w.attempt(a2.id).outcome, 'limits_not_applied'); assert.equal(w.jobState(j2.id), 'failed');
  assert.equal(dep(w, j2.id).status, 'failed'); assert.equal(dep(w, j2.id).stop_reason, 'start_timeout');
  assert.ok(r.sentOf('attempt.release').some((m) => m.attemptId === a2.id));
  // The index: a live deployment cannot take a port another live one holds; a finished one frees it.
  const j3 = preview(w, app); w.exec.tick(w.now());
  assert.throws(() => w.db.prepare('UPDATE deployments SET host_port = 49207 WHERE job_id = ?').run(j3.id), /UNIQUE/);
  w.nx.deployments.stop(w.me, dep(w, j1.id).id);
  provisionService(w, r, j3.id, 49207, 'a');
  assert.equal(dep(w, j3.id).host_port, 49207);
  // A port is stored once; a tool container may never report one.
  assert.throws(() => w.db.prepare('UPDATE deployments SET host_port = 49299 WHERE job_id = ?').run(j3.id), /immutable/);
  const b = w.exec.start(w.me, w.req('sde.build.run')).job; w.exec.tick(w.now());
  const ba = w.liveAttempt(b.id);
  r.report({ op: 'attempt.provisioned', attemptId: ba.id, containerId: 'b'.repeat(64), imageDigest: w.IMAGE['sde-node'], preflight: passingPreflight(), hostPort: 40000 });
  assert.equal(w.jobState(b.id), 'failed'); assert.match(JSON.parse(w.job(b.id).error_json).message, /published port/);
  // The protocol carries a port only with a container, in 1024-65535.
  assert.equal(parseRunnerMessage({ op: 'attempt.provisioned', attemptId: ba.id, hostPort: 40000 }), null);
  assert.equal(parseRunnerMessage({ op: 'attempt.provisioned', attemptId: ba.id, containerId: 'b'.repeat(64), preflight: passingPreflight(), hostPort: 80 }), null);
  healthy(w); w.close();
});

test('D7 a manifest that names environment variables cannot start: secrets for dev deployments are not supported yet (no job)', async () => {
  const { w, app } = await deployWorld({ manifest: { ...MANIFEST, env: ['DATABASE_URL'] } });
  const before = count(w, 'jobs');
  assert.throws(() => preview(w, app), (e) => e.code === 'unavailable' && e.detail?.reason === 'secrets_not_supported'
    && /This app needs DATABASE_URL; secrets for dev deployments are not supported yet/.test(e.message));
  assert.equal(count(w, 'jobs'), before); assert.equal(count(w, 'deployments'), 0);
  healthy(w); w.close();
});

test('D8 app quit stops every live deployment (app_quit) in one bounded pass and tells the runner', async () => {
  const { w, r, app } = await deployWorld();
  const j1 = preview(w, app); const j2 = preview(w, app); w.exec.tick(w.now());
  const a1 = provisionService(w, r, j1.id, 49210); probe(w, r, a1, 200);
  const a2 = w.liveAttempt(j2.id);
  const t = performance.now();
  assert.equal(w.nx.deployments.stopAllForQuit(), 2);
  assert.ok(performance.now() - t < 200, 'bounded');
  for (const j of [j1, j2]) { const d = dep(w, j.id); assert.equal(d.status, 'stopped'); assert.equal(d.stop_reason, 'app_quit'); assert.equal(d.stopped_by, 'system'); }
  for (const a of [a1, a2]) assert.ok(r.sentOf('attempt.cancel').some((m) => m.attemptId === a.id && m.reason === 'shutdown'));
  assert.equal(w.nx.deployments.stopAllForQuit(), 0);
  healthy(w); w.close();
});

test('D9 the fixed 2 h lifetime stops a healthy deployment (idle); a cancelled preview job stops its deployment (cancel)', async () => {
  const { w, r, app } = await deployWorld();
  const j = preview(w, app); w.exec.tick(w.now());
  const a = provisionService(w, r, j.id, 49211); probe(w, r, a, 200);
  for (let i = 0; i < 24 * 5; i++) probe(w, r, a, 200);       // 10 min of probes
  w.run(r, 2 * 60 * MIN - 11 * MIN);
  assert.equal(dep(w, j.id).status, 'healthy');
  w.run(r, 2 * MIN);
  assert.equal(dep(w, j.id).status, 'stopped'); assert.equal(dep(w, j.id).stop_reason, 'idle');
  assert.equal(w.job(j.id).phase, 'stopping');
  const j2 = preview(w, app); w.exec.tick(w.now());
  w.exec.cancel(w.me, j2.id);
  assert.equal(dep(w, j2.id).status, 'stopped'); assert.equal(dep(w, j2.id).stop_reason, 'cancel'); assert.equal(dep(w, j2.id).stopped_by, w.me.id);
  healthy(w); w.close();
});

test('D10 a dev deployment is never requeued: a runner refusal or an unsent plan fails its job and ends the deployment', async () => {
  const { w, r, app } = await deployWorld();
  const j = preview(w, app); w.exec.tick(w.now());
  const a = w.liveAttempt(j.id);
  r.report({ op: 'attempt.refused', attemptId: a.id, reason: 'busy' });
  assert.equal(w.jobState(j.id), 'failed'); assert.equal(w.attempts(j.id).length, 1);
  assert.equal(dep(w, j.id).status, 'failed'); assert.equal(dep(w, j.id).stop_reason, 'start_timeout');
  assert.equal(w.latest(app, 'app.preview_health').status, 'error', 'the check could not run; the draft stays a draft');
  assert.equal(w.version(app).status, 'draft');
  w.run(r, MIN);
  assert.equal(w.jobState(j.id), 'failed', 'not requeued');
  r.o.failSend = (m) => m.op === 'attempt.start';
  const j2 = preview(w, app); w.exec.tick(w.now());
  assert.equal(w.jobState(j2.id), 'failed'); assert.equal(dep(w, j2.id).status, 'failed');
  r.o.failSend = null;
  // A preview of a version that is not an application, or of a failed application, is refused before any job.
  assert.throws(() => w.exec.start(w.me, w.req('sde.preview.start', { inputs: [{ versionId: w.repoV, slot: 'application' }] })), code('invalid', 'input_not_allowed'));
  healthy(w); w.close();
});

// ---------- R: repository snapshots ----------

test('R1 a snapshot of a folder that is not a git repository is invalid: not_a_repository, and no job is created', async () => {
  const seen = [];
  const w = execWorld({ isRepository: async (root) => { seen.push(root); return false; } });
  w.attach();
  const before = count(w, 'jobs');
  await assert.rejects(w.nx.repo.requestSnapshot(w.me, { projectId: 'p-ledger', workspaceId: 'sde', intentId: 'snap-1' }), code('invalid', 'not_a_repository'));
  assert.equal(count(w, 'jobs'), before); assert.deepEqual(seen, ['C:/work/ledger-api']);
  // A folder main refuses never reaches git; no repository check in this build: unavailable.
  const w2 = execWorld({ acceptFsRoot: () => null, isRepository: async () => true });
  await assert.rejects(w2.nx.repo.requestSnapshot(w2.me, { projectId: 'p-ledger', workspaceId: 'sde', intentId: 's' }), code('invalid', 'project_folder_unavailable'));
  const w3 = execWorld();
  await assert.rejects(w3.nx.repo.requestSnapshot(w3.me, { projectId: 'p-ledger', workspaceId: 'sde', intentId: 's' }), code('unavailable', 'setup:git_missing'));
  // Authorization comes first.
  const viewer = w.addUser('user:viewer', 'project', 'p-ledger', 'viewer');
  await assert.rejects(w.nx.repo.requestSnapshot(viewer, { projectId: 'p-ledger', workspaceId: 'sde', intentId: 's2' }), code('denied'));
  assert.equal(seen.length, 1);
  healthy(w); w.close(); w2.close(); w3.close();
});

test('R2 two snapshot requests at once leave one live job: the second returns it (created: false)', async () => {
  const w = execWorld({ isRepository: () => new Promise((res) => setImmediate(() => res(true))) });
  w.attach();
  const req = (k) => w.nx.repo.requestSnapshot(w.me, { projectId: 'p-ledger', workspaceId: 'sde', intentId: k });
  const [x, y] = await Promise.all([req('s-1'), req('s-2')]);
  assert.equal(x.job.id, y.job.id);
  assert.deepEqual([x.created, y.created].sort(), [false, true]);
  assert.equal(count(w, "jobs WHERE recipe_id = 'repo.snapshot'"), 1);
  // While it is live, a later request returns it too, also through the core's own start; once it ended, a new one is created.
  const z = await req('s-3');
  assert.equal(z.created, false); assert.equal(z.job.id, x.job.id);
  const direct = w.exec.start(w.me, w.req('sde.repository.snapshot'));
  assert.equal(direct.created, false); assert.equal(direct.job.id, x.job.id);
  assert.equal(count(w, "jobs WHERE recipe_id = 'repo.snapshot'"), 1);
  w.exec.cancel(w.me, x.job.id);
  const n = await req('s-4');
  assert.equal(n.created, true); assert.notEqual(n.job.id, x.job.id);
  healthy(w); w.close();
});

test('R3 a dirty tree is recorded on the snapshot (dirty: true) and drives the note "uncommitted changes are not included"', async () => {
  const resolveCommit = async (_root, c) => ({ commit: c, subject: 's', committedAt: 1 });
  const w = execWorld({ realIngest: true, resolveCommit });
  const C1 = 'a1b2c3'.padEnd(40, '0'); const C2 = 'b2c3d4'.padEnd(40, '0');
  const j1 = await w.snapshot({ commit: C1, branch: 'main', dirty: true, tree: 'e'.repeat(40) });
  const v1 = w.db.prepare("SELECT * FROM artifact_versions WHERE produced_by_job_id = ? AND output_path = 'facts'").get(j1);
  assert.equal(JSON.parse(v1.metadata_json).dirty, true);
  const view = w.nx.repo.snapshotView(w.me, v1.id);
  assert.equal(view.dirty, true); assert.equal(view.commit, C1);
  assert.equal(view.note, 'Tests run on commit a1b2c30; uncommitted changes are not included.');
  const j2 = await w.snapshot({ commit: C2, branch: 'main', dirty: false, tree: 'f'.repeat(40) });
  const v2 = w.db.prepare("SELECT id FROM artifact_versions WHERE produced_by_job_id = ? AND output_path = 'facts'").get(j2).id;
  assert.equal(w.nx.repo.snapshotView(w.me, v2).note, 'Tests run on commit b2c3d40.');
  assert.equal(checkoutNote(snapshotFacts({ kind: 'git', commit: C1 }, { dirty: true })), 'Tests run on commit a1b2c30; uncommitted changes are not included.');
  assert.equal(snapshotFacts({ kind: 'inline', json: {} }, {}), null);
  assert.throws(() => w.nx.repo.snapshotView(w.me, w.suiteV), code('invalid', 'not_a_snapshot'));
  healthy(w); w.close();
});

test('R4 the app manifest reader contract: a plain object of at most 16 KiB, nothing secret-shaped', () => {
  assert.deepEqual(acceptManifestReport({ manifest: MANIFEST }), { ok: true, manifest: MANIFEST });
  assert.deepEqual(acceptManifestReport({ manifest: [] }), { ok: false, reason: 'parser_contract' });
  assert.deepEqual(acceptManifestReport(null), { ok: false, reason: 'parser_contract' });
  assert.deepEqual(acceptManifestReport({ manifest: { ...MANIFEST, run: ['x'.repeat(APP_MANIFEST_MAX_BYTES)] } }), { ok: false, reason: 'manifest_too_large' });
  assert.deepEqual(acceptManifestReport({ manifest: { ...MANIFEST, run: ['node', '--key=sk-abcdefghijklmnopqrstuvwx1234'] } }), { ok: false, reason: 'secret_in_output' });
});

// ---------- security: network and approval bypasses (constraint 11) ----------

test('S1 no network escape: only a consumed once approval of this job and attempt opens egress; tampered rows and params never do', () => {
  const { w, r } = egressWorld();
  // Params cannot name a network, an image or an approval.
  for (const params of [{ network: 'host' }, { approvalId: 'x' }, { egress: true }]) {
    assert.throws(() => w.exec.start(w.me, w.req('sde.deps.install', { params })), code('invalid', 'bad_params'));
  }
  const d = depsJob(w); const ap = approvalOf(w, d.id);
  // A row set to approved without a user decision is refused (T11); one approved without consumption starts nothing.
  assert.throws(() => w.db.prepare("UPDATE approvals SET status = 'approved', status_changed_at = ? WHERE id = ?").run(w.now(), ap.id), /only a user/);
  w.db.prepare(`UPDATE approvals SET status = 'approved', decided_by = 'user:local', decided_at = ?, decision = 'once', status_changed_at = ? WHERE id = ?`)
    .run(w.now(), w.now(), ap.id);
  assert.throws(() => w.exec.resumeApproved(d.id), code('invalid', 'network_not_approved'));
  w.run(r, MIN);
  assert.equal(r.sentOf('attempt.start').length, 0, 'an unconsumed approval starts nothing');
  // Consumption names an existing attempt of the approval's own job.
  assert.throws(() => w.db.prepare('UPDATE approvals SET consumed_at = ?, consumed_by_job_id = ?, consumed_by_attempt_n = 9 WHERE id = ?')
    .run(w.now(), d.id, ap.id), /FOREIGN KEY|constraint/i);
  w.exec.cancel(w.me, d.id);
  // A properly answered approval: its consumption is recorded once and can never be moved to another attempt.
  const d2 = depsJob(w); const ap2 = approvalOf(w, d2.id);
  w.nx.approvals.respond(w.me, ap2.id, 'once');
  assert.throws(() => w.db.prepare('UPDATE approvals SET consumed_by_attempt_n = 2 WHERE id = ?').run(ap2.id), /recorded once/);
  assert.throws(() => w.db.prepare("UPDATE approvals SET status = 'pending' WHERE id = ?").run(ap2.id), /illegal approval transition|recorded once/);
  // A non-egress recipe never gets egress, whatever approval exists.
  const b = w.exec.start(w.me, w.req('sde.build.run')).job; w.exec.tick(w.now());
  assert.deepEqual(r.lastStart().plan.container.network, { mode: 'none' }); assert.equal(r.lastStart().plan.jobId, b.id);
  assert.equal(r.sentOf('attempt.start').filter((m) => m.plan.jobId === d.id).length, 0);
  healthy(w); w.close();
});

test('S2 secrets: approval requests, deployment rows, events and activity hold no secret-shaped value', () => {
  assert.equal(requestHoldsSecret({ recipeId: 'sde.deps.node', jobId: newId(), lockfileSha256: LOCK, profile: 'sde-node', registries: ['registry.npmjs.org'] }), false);
  assert.equal(requestHoldsSecret({ profileId: 'sde-node', contextSha256: CTX.contextSha256, baseDigest: CTX.baseDigest, estimatedBytes: 1 }), false);
  assert.equal(requestHoldsSecret({ profile: 'sde-node', lockfileSha256: 'sk-' + 'a'.repeat(40) }), true, 'a malformed digest is refused');
  assert.equal(requestHoldsSecret({ profile: 'token=ghp_' + 'a1'.repeat(20) }), true);
  assert.equal(requestHoldsSecret({ registries: ['https://user:pass@registry.example'] }), true);
  // An app manifest argument that is secret-shaped never reaches a plan.
  const { checkRunArgv } = loadTs('src/main/nexus/exec/planBuilder.ts');
  assert.throws(() => checkRunArgv(['node', '--token=ghp_' + 'Ab1'.repeat(14)]), code('invalid', 'secret_in_argv'));
  assert.throws(() => checkRunArgv([]), code('invalid', 'bad_input'));
  assert.throws(() => checkRunArgv(['a\0b']), code('invalid', 'bad_input'));
  assert.deepEqual(checkRunArgv(['node', 'dist/server.js']), ['node', 'dist/server.js']);
});

test('S3 state is rebuilt from SQLite alone: a second platform on the same database expires, judges and lists exactly what the first left', async () => {
  const { w, r, app } = await deployWorld({ approvals: 'real', repoMeta: { lockfile: { sha256: LOCK } } });
  const d = depsJob(w);
  const j = preview(w, app); w.exec.tick(w.now());
  const a = provisionService(w, r, j.id, 49220);
  probe(w, r, a, 200); probe(w, r, a, 500); probe(w, r, a, 500);
  assert.equal(dep(w, j.id).status, 'healthy');
  // A fresh composition over the same rows (no memory of the first).
  const nx2 = createNexusPlatform(w.db, { now: () => w.now(), execution: true, profiles: PROFILES, acceptFsRoot: (x) => x, dataHome: w.dataHome });
  nx2.deployments.onHealth(dep(w, j.id).id, { status: 503, ms: 3, container: 'running' });
  assert.equal(dep(w, j.id).status, 'unhealthy', 'the third failure in a row, counted from health_json');
  assert.equal(nx2.deployments.healthyEver(j.id, a.n), true);
  assert.equal(nx2.approvals.list(w.me, { projectId: 'p-ledger', status: 'pending' }).approvals[0].jobId, d.id);
  w.advance(16 * MIN);
  assert.equal(nx2.approvals.expireDue(w.now()), 1);
  assert.equal(approvalOf(w, d.id).status, 'expired'); assert.equal(w.jobState(d.id), 'failed');
  healthy(w); w.close();
});
