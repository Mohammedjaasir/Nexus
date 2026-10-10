'use strict';
// B2a Task 13: the end-to-end flows through the nexus:* handlers. F1-F2 run in the fake recipe world (test/helpers/
// execFakeWorld.cjs: real main, a real RunnerCore with real git staging, hashing and parsers, the fake sandbox driver
// playing RECORDED container outputs); F3-F8 in the fake-runner world (test/helpers/execWorld.cjs). Every step is driven
// and read through the handlers a renderer calls (ids only), and after each flow the store is sound: O1-O22 = 0,
// foreign_key_check empty, integrity_check ok, the activity chain verifies. F-OBS answers the nine observability
// questions of user constraint 13, one query each. Real SQLite (test:db); no Docker.
const h = require('./helpers/sqlite.cjs');
if (!h.realSqliteOrSkip()) return;
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');
const { fakeWorld } = require('./helpers/execFakeWorld.cjs');
const { execWorld, GIB } = require('./helpers/execWorld.cjs');
const { ipcOver, noLeak, intent } = require('./helpers/ipcExec.cjs');
const { allOrphans, ALL_ZERO, execOrphanRows, t13OrphanRows } = require('./helpers/orphans.cjs');
const { verifyActivityChain } = loadTs('src/main/nexus/activity/writer.ts');

const MIN = 60_000;
const LOCK = '3f'.repeat(32);
const terminal = (s) => ['completed', 'partial', 'failed', 'cancelled', 'timed_out', 'interrupted'].includes(s);

/** After every flow: no orphan of any kind (O1-O22), foreign keys, integrity, the activity chain. */
function sound(w, name, sweptAt) {
  const o = allOrphans(w.db, sweptAt === undefined ? {} : { sweptAt });
  assert.deepEqual(o, ALL_ZERO, `${name}: orphans ${JSON.stringify({ ...execOrphanRows(w.db), ...t13OrphanRows(w.db, { sweptAt }) })}`);
  assert.deepEqual(w.db.prepare('PRAGMA foreign_key_check').all(), [], `${name}: foreign keys`);
  assert.equal(w.db.pragma('integrity_check', { simple: true }), 'ok', `${name}: integrity`);
  assert.equal(verifyActivityChain(w.db).ok, true, `${name}: activity chain`);
}
const reasons = (list) => Object.fromEntries(list.map((a) => [a.actionId, a.reason]));
const startArgs = (actionId, o = {}) => ({ projectId: 'p-ledger', workspaceId: 'sde', actionId, inputs: o.inputs ?? [], params: o.params ?? {}, intentId: intent() });

// ---------------------------------------------------------------- the fake recipe world (F1, F2, F-OBS)

let fw = null;
const ctx = {};
const fake = async () => { if (!fw) { fw = await fakeWorld(); fw.x = ipcOver(fw); } return fw; };
async function jobEnds(w, jobId, ms = 10 * MIN) {
  await w.until(() => terminal(w.job(jobId).state), `job ${jobId} ends`, ms);
  return (await w.x.ok('nexus:job:get', jobId));
}
/** The version a job's output became (its own, or the one its evidence is bound to after a deduplicated output). */
function outputOf(w, jobId, outputPath) {
  const own = w.db.prepare('SELECT id FROM artifact_versions WHERE produced_by_job_id = ? AND output_path = ? ORDER BY rowid DESC LIMIT 1').get(jobId, outputPath);
  if (own) return own.id;
  const bound = w.db.prepare('SELECT version_id FROM validations WHERE job_id = ? ORDER BY rowid DESC LIMIT 1').get(jobId);
  return bound ? bound.version_id : null;
}
const statusOf = async (w, versionId) => (await w.x.ok('nexus:artifacts:byProject', 'p-ledger'))
  .flatMap((s) => (s.latest && s.latest.id === versionId ? [s.latest.status] : []))[0] ?? w.version(versionId).status;

test('F1 snapshot -> tests pass -> build -> assemble -> preview healthy -> diagnose, every step through the handlers: e2e.sde.repository e2e.sde.tests e2e.sde.build e2e.sde.application e2e.sde.dev-deployment e2e.sde.diagnostics', async () => {
  const w = await fake();
  const x = w.x;
  await w.useFixture('node-test-app');
  const domains0 = (await x.ok('nexus:domains:list')).map((d) => ({ id: d.id, steps: d.lifecycle.map((s) => `${s.id}:${s.status}`) }));
  const act = async () => reasons(await x.ok('nexus:actions:available', { projectId: 'p-ledger', workspaceId: 'sde' }));
  let a = await act();
  assert.equal(a['sde.repository.snapshot'], null);
  assert.equal(a['sde.tests.discover'], 'blocked_by_step:repository');
  assert.equal(a['sde.build.run'], 'blocked_by_step:repository');
  assert.equal(a['sde.app.assemble'], 'blocked_by_step:build');
  assert.equal(a['sde.preview.start'], 'blocked_by_step:application');
  assert.equal(a['sde.preview.stop'], 'not_applicable');

  // Repository: the snapshot (RepoService checks the folder first), then the repository version.
  const snap = await x.ok('nexus:job:start', startArgs('sde.repository.snapshot'));
  assert.equal(snap.created, true);
  const sj = await jobEnds(w, snap.job.id, 2 * MIN);
  assert.deepEqual([sj.state, sj.headline], ['completed', 'checks_passed']);
  const repo = sj.outputs[0]?.versionId ?? outputOf(w, snap.job.id, 'facts');
  assert.ok(repo);
  assert.equal((await x.ok('nexus:version:validations', repo)).find((v) => v.validatorId === 'git.head_resolves').status, 'passed');
  assert.equal(w.stepState('sde', 'repository'), 'done');
  a = await act();
  assert.equal(a['sde.tests.discover'], null, 'discovery is offered once the repository step is done');
  assert.equal(a['sde.build.run'], null);

  // Tests: discovery -> the suite -> its sde.tests_pass child check.
  const disc = await x.ok('nexus:job:start', startArgs('sde.tests.discover', { inputs: [{ versionId: repo, slot: 'repository' }] }));
  const dj = await jobEnds(w, disc.job.id);
  assert.equal(dj.state, 'completed');
  const suite = outputOf(w, disc.job.id, 'ids.txt');
  await w.until(() => w.version(suite).status !== 'draft', 'the suite leaves draft', 15 * MIN);
  assert.equal(await statusOf(w, suite), 'candidate');
  const checks = await x.ok('nexus:version:validations', suite);
  for (const id of ['suite.discovered', 'sde.tests_pass']) {
    const c = checks.find((v) => v.validatorId === id);
    assert.deepEqual([c.status, c.blocking], ['passed', true], id);
  }
  assert.ok(checks.find((v) => v.validatorId === 'sde.tests_pass').evidence.some((e) => e.type === 'junit' && /4\/4 passed/.test(String(e.value))));
  assert.equal((await x.ok('nexus:job:get', disc.job.id)).headline, 'checks_passed');
  const discovered = await x.ok('nexus:version:preview', suite, { part: 'discovery', maxBytes: 65536 });
  assert.deepEqual(discovered.rows.map((r) => r.name), ['test/math.test.js', 'test/server.test.js']);
  const junit = await x.ok('nexus:version:preview', suite, { part: 'junit_summary', maxBytes: 65536 });
  assert.deepEqual(junit.rows.slice(0, 2).map((r) => r.name), ['failed', 'errored'], 'failures first');
  assert.equal(junit.rows.find((r) => r.name === 'passed').outcome, '4');
  assert.equal(w.stepState('sde', 'tests'), 'done');
  ctx.discoveryJob = disc.job.id;

  // Build -> candidate with its manifest.
  const b = await x.ok('nexus:job:start', startArgs('sde.build.run', { inputs: [{ versionId: repo, slot: 'repository' }] }));
  const bj = await jobEnds(w, b.job.id);
  assert.equal(bj.state, 'completed');
  const build = outputOf(w, b.job.id, 'dist');
  await w.until(() => w.version(build).status !== 'draft', 'the build leaves draft', 5 * MIN);
  assert.equal(await statusOf(w, build), 'candidate');
  const manifest = await x.ok('nexus:version:preview', build, { part: 'manifest', maxBytes: 65536 });
  assert.deepEqual(manifest.rows.map((r) => r.name), ['app.js', 'index.html']);
  for (const r of manifest.rows) assert.match(r.detail, /^sha256:[0-9a-f]{12}$/);
  assert.equal(w.stepState('sde', 'build'), 'done');
  ctx.buildJob = b.job.id;
  a = await act();
  assert.equal(a['sde.app.assemble'], null, 'assembly is offered once a build is a candidate');

  // Assemble -> an application draft (a candidate only after its dev deployment's health check).
  const asm = await x.ok('nexus:job:start', startArgs('sde.app.assemble', { inputs: [{ versionId: build, slot: 'build' }] }));
  assert.equal((await jobEnds(w, asm.job.id)).state, 'completed');
  const app = outputOf(w, asm.job.id, 'manifest');
  assert.equal((await x.ok('nexus:version:validations', app)).find((v) => v.validatorId === 'app.manifest_schema').status, 'passed');
  assert.equal(w.version(app).status, 'draft');
  const appPreview = await x.ok('nexus:version:preview', app, { part: 'content', maxBytes: 65536 });
  assert.match(appPreview.text, /"healthPath": "\/health"/);
  a = await act();
  assert.equal(a['sde.preview.start'], null, 'a draft application may be previewed');

  // Dev deployment -> healthy on 127.0.0.1 -> the application becomes a candidate.
  const pv = await x.ok('nexus:job:start', startArgs('sde.preview.start', { inputs: [{ versionId: app, slot: 'application' }] }));
  await w.until(() => { const d = w.deploymentOf(pv.job.id); return !!d && d.status !== 'starting'; }, 'the deployment leaves starting', 3 * MIN);
  const deps = await x.ok('nexus:deployments:list', { projectId: 'p-ledger' });
  const dep = deps.find((d) => d.jobId === pv.job.id);
  assert.equal(dep.status, 'healthy');
  assert.match(dep.url, /^http:\/\/127\.0\.0\.1:\d+\/health$/);
  assert.equal(dep.bindAddress, '127.0.0.1');
  await w.until(() => w.version(app).status === 'candidate', 'the application becomes a candidate', MIN);
  assert.equal(w.stepState('sde', 'dev-deployment'), 'done');
  const pvDetail = await x.ok('nexus:job:get', pv.job.id);
  assert.deepEqual(pvDetail.deployment, { id: dep.id, status: 'healthy' });
  // The forwarder publishes on 127.0.0.1 only; the app's network is internal (the plan as recorded).
  const sb = JSON.parse(w.db.prepare('SELECT sandbox_json FROM job_attempts WHERE job_id = ? ORDER BY n DESC LIMIT 1').get(pv.job.id).sandbox_json);
  assert.equal(sb.forwarder.publish.hostIp, '127.0.0.1');
  a = await act();
  assert.equal(a['sde.preview.stop'], null, 'Stop is offered while a deployment is live');

  // Diagnose the running deployment -> a diagnostic report candidate.
  await w.until(() => JSON.parse(w.deploymentRow(dep.id).health_json).length >= 1, 'a probe is recorded', MIN);
  const dg = await x.ok('nexus:job:start', startArgs('sde.diagnose', { params: { target: 'deployment', targetId: dep.id } }));
  assert.equal((await jobEnds(w, dg.job.id, 3 * MIN)).state, 'completed');
  const rep = outputOf(w, dg.job.id, 'report');
  await w.until(() => w.version(rep).status !== 'draft', 'the report leaves draft', MIN);
  assert.equal(w.version(rep).status, 'candidate');
  assert.equal((await x.ok('nexus:version:validations', rep)).find((v) => v.validatorId === 'diag.schema').status, 'passed');
  assert.equal(w.stepState('sde', 'diagnostics'), 'done');

  // Stop through the handler: the deployment stops, its job completes `stopped`, the containers go.
  const stopped = await x.ok('nexus:deployment:stop', dep.id);
  assert.ok(['stopped', 'healthy'].includes(stopped.status));
  const pj = await jobEnds(w, pv.job.id, 3 * MIN);
  assert.deepEqual([pj.state, pj.outcome], ['completed', 'stopped']);
  await w.until(() => w.liveLabelled(pv.job.id) === 0, 'the deployment\'s resources are removed', 2 * MIN);
  assert.equal((await x.ok('nexus:deployments:list', {})).find((d) => d.id === dep.id).status, 'stopped');

  // The events and the logs a renderer pulls after a hint.
  const ev = await x.ok('nexus:events:since', { sinceSeq: 0, projectId: 'p-ledger', limit: 500 });
  assert.ok(ev.events.length > 10); assert.equal(ev.lastSeq, ev.events.at(-1).seq);
  const more = await x.ok('nexus:events:since', { sinceSeq: ev.lastSeq });
  assert.deepEqual(more.events, []);
  const log = await x.ok('nexus:job:logs', b.job.id, { attempt: 1, fromOffset: 0, maxBytes: 262144 });
  assert.equal(typeof log.text, 'string'); assert.equal(log.eof, true);
  // The domains' statuses never changed: steps are REAL / PARTIAL / FUTURE by the build, never by records.
  assert.deepEqual((await x.ok('nexus:domains:list')).map((d) => ({ id: d.id, steps: d.lifecycle.map((s) => `${s.id}:${s.status}`) })), domains0);
  // Nothing a renderer received names a host path or a principal id.
  for (const v of [await x.ok('nexus:jobs:list', { projectId: 'p-ledger', limit: 500 }), await x.ok('nexus:job:get', pv.job.id), deps, ev,
    await x.ok('nexus:approvals:list', {}), await x.ok('nexus:platform:health'), await x.ok('nexus:actions:available', { projectId: 'p-ledger', workspaceId: 'sde' })]) noLeak(v);
  ctx.repo = repo; ctx.app = app;
  sound(w, 'F1');
});

test('F2 a failing test fixture: the suite fails (tests_failed), the discovery job reads checks_failed, the step stays done from F1', async () => {
  const w = await fake();
  const x = w.x;
  await w.useFixture('node-test-failing');
  const snap = await x.ok('nexus:job:start', startArgs('sde.repository.snapshot'));
  const sj = await jobEnds(w, snap.job.id, 2 * MIN);
  const repo = sj.outputs[0]?.versionId ?? outputOf(w, snap.job.id, 'facts');
  const disc = await x.ok('nexus:job:start', startArgs('sde.tests.discover', { inputs: [{ versionId: repo, slot: 'repository' }] }));
  await jobEnds(w, disc.job.id);
  const suite = outputOf(w, disc.job.id, 'ids.txt');
  await w.until(() => w.version(suite).status !== 'draft', 'the suite leaves draft', 15 * MIN);
  assert.equal(w.version(suite).status, 'failed');
  const tp = (await x.ok('nexus:version:validations', suite)).find((v) => v.validatorId === 'sde.tests_pass');
  assert.deepEqual([tp.status, tp.blocking], ['failed', true]);
  assert.match(tp.summary, /tests_failed/);
  assert.equal((await x.ok('nexus:job:get', disc.job.id)).headline, 'checks_failed', 'never a bare completed');
  const junit = await x.ok('nexus:version:preview', suite, { part: 'junit_summary', maxBytes: 65536 });
  assert.equal(junit.rows[0].name, 'failed'); assert.equal(junit.rows[0].outcome, '1');
  assert.equal(w.stepState('sde', 'tests'), 'done', 'F1\'s passing suite still proves the step');
  sound(w, 'F2');
});

test('F-OBS the nine observability questions, one query each, for a finished job (who, domain and project, inputs, allowed tools, environment, what ran, evidence, why, the result)', async () => {
  const w = await fake();
  const id = ctx.buildJob;
  assert.ok(id, 'F1 ran');
  const q = (sql) => w.db.prepare(sql).get(id);
  const who = q('SELECT requested_by, on_behalf_of FROM jobs WHERE id = ?');
  assert.ok(who.requested_by && who.on_behalf_of);
  const where = q('SELECT project_id, workspace_id FROM jobs WHERE id = ?');
  assert.deepEqual([where.project_id, where.workspace_id], ['p-ledger', 'sde']);
  const inputs = q("SELECT json_group_array(json_object('version', version_id, 'slot', role, 'hash', content_hash)) AS i FROM job_inputs WHERE job_id = ?");
  assert.equal(JSON.parse(inputs.i)[0].slot, 'repository');
  const tools = q('SELECT capabilities_json, limits_json FROM jobs WHERE id = ?');
  assert.deepEqual(Object.keys(JSON.parse(tools.capabilities_json)[0]).sort(), ['action', 'executor', 'network', 'profile', 'recipe', 'recipeVersion']);
  assert.equal(JSON.parse(tools.capabilities_json)[0].network, 'none');
  const env = q('SELECT environment_json FROM job_attempts WHERE job_id = ? ORDER BY n DESC LIMIT 1');
  assert.match(JSON.parse(env.environment_json).imageId, /^sha256:[0-9a-f]{64}$/);
  const ran = q('SELECT sandbox_json FROM job_attempts WHERE job_id = ? ORDER BY n DESC LIMIT 1');
  const sb = JSON.parse(ran.sandbox_json);
  assert.ok(Array.isArray(sb.argv) && sb.argv.length > 0); assert.match(sb.argvSha256, /^[0-9a-f]{64}$/); assert.equal(sb.network.mode, 'none');
  const evidence = q('SELECT COUNT(*) AS n FROM validations WHERE job_id = ? OR version_id IN (SELECT id FROM artifact_versions WHERE produced_by_job_id = ?)'.replace('?)', `'${id}')`));
  assert.ok(evidence.n >= 4);
  const why = q('SELECT j.state, j.outcome, a.exit_code, a.outcome AS attempt_outcome FROM jobs j JOIN job_attempts a ON a.job_id = j.id WHERE j.id = ? ORDER BY a.n DESC LIMIT 1');
  assert.deepEqual([why.state, why.exit_code], ['completed', 0]);
  const result = q("SELECT v.id, v.status, v.output_path FROM artifact_versions v WHERE v.produced_by_job_id = ? AND v.output_path = 'dist'");
  assert.deepEqual([result.status, result.output_path], ['candidate', 'dist']);
  sound(w, 'F-OBS');
});

// ---------------------------------------------------------------- the fake-runner world (F3-F8)

const egressWorld = () => execWorld({ approvals: 'real', realIngest: true, repoMeta: { lockfile: { sha256: LOCK } }, dockerMemoryBytes: 64 * GIB });

test('F3 dependency install with approval once: waiting -> approved once -> the plan carries that approval -> it runs; with no evidence rule in B2a it never completes on its exit', async () => {
  const w = egressWorld(); const r = w.attach(); const x = ipcOver(w);
  const a = (await x.ok('nexus:actions:available', { projectId: 'p-ledger', workspaceId: 'sde' })).find((y) => y.actionId === 'sde.deps.install');
  assert.deepEqual([a.available, a.needsApproval], [true, true]);
  const s = await x.ok('nexus:job:start', startArgs('sde.deps.install', { inputs: [{ versionId: w.repoV, slot: 'repository' }] }));
  w.exec.tick(w.now());
  assert.equal((await x.ok('nexus:job:get', s.job.id)).headline, 'waiting_for_approval');
  const ap = (await x.ok('nexus:approvals:list', { projectId: 'p-ledger', status: 'pending' }))[0];
  assert.deepEqual([ap.jobId, ap.reason, ap.request.lockfileSha256, ap.request.registries], [s.job.id, 'egress.deps', LOCK, ['registry.npmjs.org']]);
  assert.equal(r.sentOf('attempt.start').length, 0);
  const answered = await x.ok('nexus:approval:respond', ap.id, 'once');
  assert.deepEqual([answered.status, answered.decision], ['approved', 'once']);
  const plan = r.lastStart().plan;
  assert.deepEqual(plan.container.network, { mode: 'egress-approved', approvalId: ap.id, purpose: 'deps' });
  w.provision(r, s.job.id);
  assert.equal((await x.ok('nexus:job:get', s.job.id)).headline, 'running');
  w.exitWith(r, s.job.id, { code: 0, outputs: [w.file('lock.sha256', LOCK)] });
  await w.settle();
  const d = await x.ok('nexus:job:get', s.job.id);
  assert.deepEqual([d.state, d.outcome, d.error.code], ['failed', 'ingest_unavailable', 'no_ingest_rule'], 'an exit alone completes nothing');
  assert.equal(d.attemptHistory[0].network, 'egress-approved');
  assert.deepEqual(d.approvals.map((y) => y.status), ['approved']);
  w.nx.approvals.expireDue(w.now());
  sound(w, 'F3', w.now());
  w.close();
});

test('F4 deny: the job fails denied, no plan is ever sent, the approval is denied', async () => {
  const w = egressWorld(); const r = w.attach(); const x = ipcOver(w);
  const s = await x.ok('nexus:job:start', startArgs('sde.deps.install', { inputs: [{ versionId: w.repoV, slot: 'repository' }] }));
  w.exec.tick(w.now());
  const ap = (await x.ok('nexus:approvals:list', { status: 'pending' }))[0];
  const answered = await x.ok('nexus:approval:respond', ap.id, 'deny');
  assert.deepEqual([answered.status, answered.decision], ['denied', 'deny']);
  const d = await x.ok('nexus:job:get', s.job.id);
  assert.deepEqual([d.state, d.headline], ['failed', 'failed']);
  assert.equal(d.error.code, 'approval_denied');
  assert.equal(r.sentOf('attempt.start').length, 0);
  w.nx.approvals.expireDue(w.now());
  sound(w, 'F4', w.now());
  w.close();
});

test('F5 cancel mid-run: the running attempt is cancelled, the runner is told, the job reads cancelled; a second cancel is illegal', async () => {
  const w = execWorld({ realIngest: true }); const r = w.attach(); const x = ipcOver(w);
  const s = await x.ok('nexus:job:start', startArgs('sde.tests.discover', { inputs: [{ versionId: w.repoV, slot: 'repository' }] }));
  w.exec.tick(w.now());
  const a = w.provision(r, s.job.id);
  r.report({ op: 'attempt.event', attemptId: a.id, seq: 1, phase: 'running', at: w.now() });
  const c = await x.ok('nexus:job:cancel', s.job.id);
  assert.deepEqual([c.state, c.headline, c.cancelRequested], ['cancelled', 'cancelled', true]);
  assert.deepEqual(r.sentOf('attempt.cancel').map((m) => m.attemptId), [a.id]);
  assert.equal(w.attempt(a.id).state, 'cancelled');
  await x.refused('nexus:job:cancel', [s.job.id], 'illegal_transition');
  sound(w, 'F5');
  w.close();
});

test('F6 retry after infra_error: a build failed by a Docker resource fault is retried as a new job (retry_of), once per intent', async () => {
  const w = execWorld({ realIngest: true }); const r = w.attach(); const x = ipcOver(w);
  const s = await x.ok('nexus:job:start', startArgs('sde.build.run', { inputs: [{ versionId: w.repoV, slot: 'repository' }] }));
  w.exec.tick(w.now());
  r.report({ op: 'fault', message: 'Minimum memory limit allowed is 6MB', attemptId: w.liveAttempt(s.job.id).id, failureClass: 'docker_resources' });
  const f = await x.ok('nexus:job:get', s.job.id);
  assert.deepEqual([f.state, f.outcome], ['failed', 'infra_error']);
  const i = intent();
  const again = await x.ok('nexus:job:retry', s.job.id, i);
  assert.deepEqual([again.job.retryOf, again.job.state, again.job.recipeId], [s.job.id, 'queued', 'sde.build.node']);
  const same = await x.ok('nexus:job:retry', s.job.id, i);
  assert.equal(same.job.id, again.job.id, 'the same intent never makes a second job');
  await x.refused('nexus:job:retry', [again.job.id, intent()], 'illegal_transition');
  await x.ok('nexus:job:cancel', again.job.id);
  sound(w, 'F6');
  w.close();
});

test('F7 revalidate after a validator error: blob.integrity could not run, the draft is offered Revalidate, new checks pass, the old error row stays', async () => {
  const w = execWorld({ realIngest: true }); const x = ipcOver(w);
  const b = await w.runBuild({ files: ['app.js'] });
  const runner = w.attach();
  runner.report({ op: 'fault', message: 'the docker daemon went away' });
  await w.settle();
  const before = (await x.ok('nexus:version:validations', b.buildVersionId)).find((v) => v.validatorId === 'blob.integrity');
  assert.equal(before.status, 'error');
  assert.equal((await x.ok('nexus:job:get', b.buildJobId)).headline, 'checks_could_not_run');
  const rv = await x.ok('nexus:version:revalidate', b.buildVersionId, intent());
  assert.equal(rv.jobs.length, 4);
  for (const j of rv.jobs) { assert.equal(j.kind, 'validate'); assert.equal(j.requestedByKind, 'user'); }
  w.answerVerifies(runner, true); await w.settle();
  const after = (await x.ok('nexus:version:validations', b.buildVersionId)).find((v) => v.validatorId === 'blob.integrity');
  assert.equal(after.status, 'passed');
  assert.ok(after.history >= 2, 'the error row stays in the history');
  assert.equal(w.version(b.buildVersionId).status, 'candidate');
  await x.refused('nexus:version:revalidate', [b.buildVersionId, intent()], 'illegal_transition');
  sound(w, 'F7');
  w.close();
});

test('F8 requirement -> Mark ready -> candidate through the handlers; the Requirement step is done: e2e.sde.requirement', async () => {
  const w = execWorld({ realIngest: true }); const x = ipcOver(w);
  const content = { title: 'Ledger export', body: 'Export the ledger as CSV.', criteria: [{ id: 'AC1', text: 'A CSV file downloads' }, { id: 'AC2', text: 'Totals match' }] };
  const s = await x.ok('nexus:artifact:saveInline', { projectId: 'p-ledger', workspaceId: 'sde', kind: 'requirement', target: { name: 'Export' }, content });
  assert.deepEqual([s.created, s.version.status, s.artifact.kind], [true, 'draft', 'requirement']);
  const again = await x.ok('nexus:artifact:saveInline', { projectId: 'p-ledger', workspaceId: 'sde', kind: 'requirement', target: { name: 'Export' }, content });
  assert.equal(again.version.id, s.version.id, 'the same content is the same version');
  const v = (await x.ok('nexus:version:validations', s.version.id)).find((y) => y.validatorId === 'req.schema');
  assert.deepEqual([v.status, v.blocking], ['passed', true]);
  assert.notEqual(w.stepState('sde', 'requirement'), 'done');
  const ready = await x.ok('nexus:version:markReady', s.version.id);
  assert.equal(ready.status, 'candidate');
  assert.equal(w.stepState('sde', 'requirement'), 'done');
  const preview = await x.ok('nexus:version:preview', s.version.id, { part: 'content', maxBytes: 4096 });
  assert.match(preview.text, /Totals match/);
  // A problem statement is not a SDE kind: refused by the service, nothing saved.
  await x.refused('nexus:artifact:saveInline', [{ projectId: 'p-ledger', workspaceId: 'sde', kind: 'problem_statement', target: { name: 'Q' },
    content: { question: 'Why?' } }], 'invalid', { reason: 'kind_not_in_domain' });
  sound(w, 'F8');
  w.close();
});

test('F9 advisory rows never set a version status: a later run on a candidate shows as a run result; the status stays the latest blocking row', async () => {
  const w = execWorld({ realIngest: true }); const x = ipcOver(w);
  const { junit } = require('./helpers/execWorld.cjs');
  const r = await w.runTests({ junit: junit([{ name: 'adds' }, { name: 'subtracts' }]) });
  assert.equal(w.version(r.suiteVersionId).status, 'candidate');
  const v0 = (await x.ok('nexus:version:validations', r.suiteVersionId)).find((y) => y.validatorId === 'sde.tests_pass');
  assert.deepEqual([v0.status, v0.blocking, v0.latestRun], ['passed', true, null]);
  // A later run of the candidate (the system records it; on a candidate it is advisory): a failed run result.
  w.nx.validation.recordOutcomeTx(r.suiteVersionId, 'sde.tests_pass', { status: 'failed', reason: 'tests_failed', summary: 'A later run failed.', evidence: [] });
  const v1 = (await x.ok('nexus:version:validations', r.suiteVersionId)).find((y) => y.validatorId === 'sde.tests_pass');
  assert.deepEqual([v1.status, v1.blocking], ['passed', true], 'the status is the latest BLOCKING row');
  assert.equal(v1.latestRun.status, 'failed', 'the advisory row is shown as a run result');
  assert.equal(v1.history, v0.history + 1);
  // A version with advisory rows only has no status at all.
  w.nx.validation.recordOutcomeTx(w.suiteV, 'sde.tests_pass', { status: 'passed', reason: null, summary: 'A run passed.', evidence: [] });
  const v2 = (await x.ok('nexus:version:validations', w.suiteV)).find((y) => y.validatorId === 'sde.tests_pass');
  assert.deepEqual([v2.status, v2.blocking, v2.latestRun.status], [null, false, 'passed']);
  assert.equal(w.version(r.suiteVersionId).status, 'candidate');
  sound(w, 'F9');
  w.close();
});

test('F-index the flow titles name the end-to-end ids of the REAL steps they prove', () => {
  const me = fs.readFileSync(path.join(__dirname, 'nexus-platform-b2a-flows.test.cjs'), 'utf8');
  for (const id of ['e2e.sde.repository', 'e2e.sde.tests', 'e2e.sde.build', 'e2e.sde.application', 'e2e.sde.dev-deployment', 'e2e.sde.diagnostics', 'e2e.sde.requirement']) {
    assert.ok(me.split('\n').some((l) => /^test\('F/.test(l) && l.includes(` ${id}`)), id);
  }
});
