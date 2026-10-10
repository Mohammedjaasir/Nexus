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
const { EXPIRY_SWEEP_MS } = loadTs('src/main/nexus/approvals/approvalService.ts');

const MIN = 60_000;
const LOCK = '3f'.repeat(32);
const terminal = (s) => ['completed', 'partial', 'failed', 'cancelled', 'timed_out', 'interrupted'].includes(s);

/**
 * After every flow: no orphan of any kind (O1-O22), foreign keys, integrity, the activity chain. O21 counts against the
 * scheduler's OWN last expiry sweep (fix round 2: `exec.lastExpirySweepAt`, read-only); this check never sweeps. A caller
 * may give `sweptAt` instead.
 */
function sound(w, name, sweptAt) {
  if (sweptAt === undefined) sweptAt = w.exec.lastExpirySweepAt;
  if (sweptAt === null) {
    // This world's scheduler has never swept (its approvals port has no expiry sweep): O21 then holds only when no
    // approval is pending at all, so every pending approval counts.
    assert.equal(w.db.prepare("SELECT COUNT(*) n FROM approvals WHERE status = 'pending'").get().n, 0, `${name}: pending approvals, never swept`);
    sweptAt = Number.MAX_SAFE_INTEGER;
  }
  assert.ok(Number.isSafeInteger(sweptAt), `${name}: a sweep time`);
  const o = allOrphans(w.db, { sweptAt });
  assert.deepEqual(o, ALL_ZERO, `${name}: orphans ${JSON.stringify({ ...execOrphanRows(w.db), ...t13OrphanRows(w.db, { sweptAt }) })}`);
  assert.deepEqual(w.db.prepare('PRAGMA foreign_key_check').all(), [], `${name}: foreign keys`);
  assert.equal(w.db.pragma('integrity_check', { simple: true }), 'ok', `${name}: integrity`);
  assert.equal(verifyActivityChain(w.db).ok, true, `${name}: activity chain`);
}
/** The scheduler's own pass once its expiry cadence is due (fix round 2): the time of the sweep IT ran, for sound(). */
function schedulerSweep(w) {
  w.advance(EXPIRY_SWEEP_MS);
  w.exec.tick(w.now());
  assert.equal(w.exec.lastExpirySweepAt, w.now(), 'the scheduler swept');
  return w.exec.lastExpirySweepAt;
}
const reasons =(list) => Object.fromEntries(list.map((a) => [a.actionId, a.reason]));
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

/** An install through the handlers up to its running attempt: started, approved once, provisioned. */
async function runningInstall(w, r, x) {
  const s = await x.ok('nexus:job:start', startArgs('sde.deps.install', { inputs: [{ versionId: w.repoV, slot: 'repository' }] }));
  w.exec.tick(w.now());
  const ap = (await x.ok('nexus:approvals:list', { projectId: 'p-ledger', status: 'pending' })).find((y) => y.jobId === s.job.id);
  await x.ok('nexus:approval:respond', ap.id, 'once');
  w.provision(r, s.job.id);
  return { jobId: s.job.id, approvalId: ap.id };
}
const lockRows = (w) => w.db.prepare("SELECT * FROM validations WHERE validator_id = 'sde.deps.lock_matches' ORDER BY rowid").all();
const sha256Hex = (s) => require('node:crypto').createHash('sha256').update(Buffer.from(s)).digest('hex');

test('F3 dependency install with approval once: waiting -> approved once -> the plan carries that approval -> it runs; it completes only on the stored lock.sha256 matching the repository and the approval (sde.deps.lock_matches evidence)', async () => {
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
  const out = w.stored('lock.sha256', `${LOCK}\n`);
  w.exitWith(r, s.job.id, { code: 0, outputs: [out] });
  await w.settle();
  const d = await x.ok('nexus:job:get', s.job.id);
  // Fix round 1 (the ruled defect): validated evidence completes it, never the exit alone.
  assert.deepEqual([d.state, d.outcome, d.headline, d.error], ['completed', 'completed', 'checks_passed', null]);
  assert.equal(d.attemptHistory[0].network, 'egress-approved');
  assert.deepEqual(d.approvals.map((y) => y.status), ['approved']);
  // The evidence row: on the repository version, ADVISORY, bound to (job, 1), with typed evidence.
  const rows = lockRows(w);
  assert.equal(rows.length, 1);
  assert.deepEqual([rows[0].version_id, rows[0].job_id, rows[0].attempt_n, rows[0].status, rows[0].blocking, rows[0].advisory, rows[0].stage],
    [w.repoV, s.job.id, 1, 'passed', 0, 1, 'candidate']);
  assert.deepEqual(JSON.parse(rows[0].evidence_json), [{ type: 'exit', code: 0, oomKilled: false },
    { type: 'hash', label: 'lock.sha256', sha256: out.sha256 }, { type: 'hash', label: 'lockfile', sha256: LOCK }]);
  // Shown on the repository version as a run result, never its status (advisory rows never gate).
  const v = (await x.ok('nexus:version:validations', w.repoV)).find((y) => y.validatorId === 'sde.deps.lock_matches');
  assert.deepEqual([v.status, v.blocking, v.latestRun.status], [null, false, 'passed']);
  assert.equal(w.version(w.repoV).status, 'candidate', 'the repository version is unchanged');
  // The attempt's environment records the dependency cache the install wrote.
  assert.equal(JSON.parse(w.attempts(s.job.id)[0].environment_json).depsVolume, `nexus-deps-sde-node-${LOCK.slice(0, 12)}`);
  sound(w, 'F3', schedulerSweep(w));
  w.close();
});

test('F3b an install whose exit 0 is not backed by its lock.sha256 is refused and stores nothing: a missing file, non-hex content, an extra output, a non-zero exit, a secret-shaped value, a hash of another lockfile', async () => {
  const OTHER = 'ab'.repeat(32);
  const cases = [
    // A missing lock.sha256 never reaches ingest: the core's contract rule refuses the exit (the rule's own refusal, missing_output, is F3d).
    { name: 'missing file', outputs: () => [], want: ['invalid_output', 'outputs_missing'] },
    { name: 'non-hex content', outputs: (w) => [w.stored('lock.sha256', 'not a lockfile hash\n')], want: ['invalid_output', 'not_hex'] },
    { name: 'an extra output', outputs: (w) => [w.stored('lock.sha256', LOCK), w.stored('node_modules.txt', 'x')], want: ['invalid_output', 'extra_output'] },
    { name: 'a non-zero exit', outputs: (w) => [w.stored('lock.sha256', LOCK)], code: 1, want: ['nonzero_exit', 'nonzero_exit'] },
    { name: 'a secret-shaped value', outputs: (w) => [w.stored('lock.sha256', 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz012345\n')], want: ['invalid_output', 'secret_in_output'] },
    { name: 'another lockfile', outputs: (w) => [w.stored('lock.sha256', OTHER)], want: ['invalid_output', 'repository_mismatch'] }
  ];
  for (const c of cases) {
    const w = egressWorld(); const r = w.attach(); const x = ipcOver(w);
    const { jobId } = await runningInstall(w, r, x);
    const versions0 = w.db.prepare('SELECT COUNT(*) n FROM artifact_versions').get().n;
    w.exitWith(r, jobId, { code: c.code ?? 0, outputs: c.outputs(w) });
    await w.settle();
    const d = await x.ok('nexus:job:get', jobId);
    assert.deepEqual([d.state, d.outcome, d.error.code], ['failed', ...c.want], c.name);
    assert.equal(d.attempts, 1, `${c.name}: never retried`);
    assert.deepEqual(lockRows(w), [], `${c.name}: no evidence row`);
    assert.equal(w.db.prepare('SELECT COUNT(*) n FROM validations WHERE job_id = ?').get(jobId).n, 0, `${c.name}: nothing bound to the attempt`);
    assert.equal(w.db.prepare('SELECT COUNT(*) n FROM artifact_versions').get().n, versions0, `${c.name}: no version`);
    noLeak(d, c.name);
    assert.doesNotMatch(JSON.stringify(d), /sk-ant/, `${c.name}: never echoed`);
    for (const t of ['jobs', 'job_attempts', 'job_events', 'activity']) {
      assert.doesNotMatch(JSON.stringify(w.db.prepare(`SELECT * FROM ${t}`).all()), /sk-ant-api03-abcdef/, `${c.name}: ${t}`);
    }
    sound(w, `F3b ${c.name}`, schedulerSweep(w));
    w.close();
  }
});

test('F3c a retried install (attempt 2) needs its own consumed approval: attempt 1\'s approval never completes attempt 2; with its own, it completes on its evidence bound to (job, 2)', async () => {
  const w = egressWorld(); const r = w.attach(); const x = ipcOver(w);
  const { jobId, approvalId: first } = await runningInstall(w, r, x);
  // Attempt 1 is lost to a retryable Docker fault after its approval was consumed: the job is retried (idempotent, 2 attempts).
  r.report({ op: 'fault', message: 'the docker daemon went away', attemptId: w.liveAttempt(jobId).id, failureClass: 'docker_error' });
  assert.equal(w.jobState(jobId), 'retry_scheduled');
  w.advance(10 * MIN); w.exec.tick(w.now()); w.exec.tick(w.now());
  // Attempt 2 asks again: a NEW pending approval; the first stays consumed by attempt 1. No plan before the answer.
  assert.equal(w.jobState(jobId), 'awaiting_approval');
  const starts0 = r.sentOf('attempt.start').length;
  const pending = (await x.ok('nexus:approvals:list', { status: 'pending' })).filter((y) => y.jobId === jobId);
  assert.equal(pending.length, 1); assert.notEqual(pending[0].id, first);
  const a1 = w.db.prepare('SELECT consumed_by_job_id AS j, consumed_by_attempt_n AS n FROM approvals WHERE id = ?').get(first);
  assert.deepEqual([a1.j, a1.n], [jobId, 1]);
  assert.equal(r.sentOf('attempt.start').length, starts0, 'attempt 2 gets no plan on attempt 1\'s approval');
  await x.ok('nexus:approval:respond', pending[0].id, 'once');
  assert.equal(r.lastStart().plan.container.network.approvalId, pending[0].id, 'the plan carries attempt 2\'s own approval');
  w.provision(r, jobId);
  w.exitWith(r, jobId, { code: 0, outputs: [w.stored('lock.sha256', LOCK)] });
  await w.settle();
  const d = await x.ok('nexus:job:get', jobId);
  assert.deepEqual([d.state, d.headline, d.attempts], ['completed', 'checks_passed', 2]);
  const rows = lockRows(w);
  assert.deepEqual(rows.map((x2) => [x2.job_id, x2.attempt_n, x2.status]), [[jobId, 2, 'passed']]);
  const a2 = w.db.prepare('SELECT consumed_by_attempt_n AS n FROM approvals WHERE id = ?').get(pending[0].id);
  assert.equal(a2.n, 2);
  sound(w, 'F3c', schedulerSweep(w));
  w.close();
});

test('F3d the deps rule itself: attempt n without an approval consumed by n is refused (approval_missing), a missing file is missing_output, each hash mismatch alone is refused, and a refusal writes nothing', async () => {
  const { IngestService } = loadTs('src/main/nexus/exec/ingest.ts');
  const depsLock = loadTs('src/main/nexus/validation/validators/depsLockMatches.ts');
  const { getRecipe } = loadTs('src/shared/nexus/recipes.ts');
  const w = egressWorld(); const r = w.attach(); const x = ipcOver(w);
  const { jobId } = await runningInstall(w, r, x);
  const out = w.stored('lock.sha256', LOCK);
  const ing = new IngestService(w.db, { artifacts: w.nx.artifacts, validation: w.nx.validation, blobs: w.nx.blobs, now: () => w.now(),
    objects: { readObjectBytes: async (sha, max) => w.dataHome.readObjectBytes(sha, max) } });
  const exited = (outputs) => ({ exit: { code: 0, oomKilled: false }, outputs, parsed: [], logBytes: 0 });
  const ctxOf = (attemptPatch, outputs) => ({ system: w.sys, job: w.job(jobId), attempt: { ...w.liveAttempt(jobId), ...attemptPatch },
    recipe: getRecipe('sde.deps.node'), exited: exited(outputs), token: null });
  const decide = async (attemptPatch, outputs) => {
    const ctx = ctxOf(attemptPatch, outputs);
    ctx.facts = await ing.prepare(ctx);
    const before = w.db.prepare('SELECT COUNT(*) n FROM validations').get().n;
    const res = w.db.transaction(() => ing.ingestTx(ctx)).immediate();
    return { res, wrote: w.db.prepare('SELECT COUNT(*) n FROM validations').get().n - before, facts: ctx.facts };
  };
  // The stored bytes are read back and re-hashed (never the report's word).
  assert.deepEqual(await ing.prepare(ctxOf({}, [out])), { lock: { text: LOCK } });
  // Attempt 2 of this job has no approval of its own: attempt 1's consumed approval does not count.
  const two = await decide({ n: 2 }, [out]);
  assert.deepEqual([two.res.ok, two.res.outcome, two.res.error.code, two.wrote], [false, 'invalid_output', 'approval_missing', 0]);
  // A missing lock.sha256 is missing_output (the rule's own refusal; end to end the core's contract rule refuses first).
  const none = await decide({}, [w.stored('other.txt', 'x')]);
  assert.deepEqual([none.res.ok, none.res.outcome, none.res.error.code, none.wrote], [false, 'missing_output', 'missing_output', 0]);
  // A stored object that is gone or altered is never trusted.
  const gone = w.file('lock.sha256', 'cd'.repeat(32));
  assert.deepEqual((await decide({}, [gone])).res.error.code, 'lock_unreadable');
  // Each hash mismatch alone (the validator, pure): the repository's, the approval's, and no approval at all.
  const base = { exit: { code: 0, oomKilled: false }, outputs: [{ relPath: 'lock.sha256', sha256: out.sha256, bytes: 64 }], read: { text: LOCK },
    repositoryLock: LOCK, approvalLock: LOCK };
  assert.equal(depsLock.run(base).status, 'passed');
  assert.equal(depsLock.run({ ...base, repositoryLock: 'ab'.repeat(32) }).reason, 'repository_mismatch');
  assert.equal(depsLock.run({ ...base, approvalLock: 'ab'.repeat(32) }).reason, 'approval_mismatch');
  assert.equal(depsLock.run({ ...base, approvalLock: null }).reason, 'approval_missing');
  assert.equal(depsLock.run({ ...base, exit: { code: 0, oomKilled: true } }).reason, 'nonzero_exit');
  assert.equal(depsLock.run({ ...base, read: { text: `${LOCK.slice(0, 63)}g` } }).reason, 'not_hex');
  // Upper-case hex is not the contract (64 LOWERCASE hex) and a long hex run is secret-shaped to the redactor: refused.
  assert.equal(depsLock.run({ ...base, read: { text: LOCK.toUpperCase() } }).reason, 'secret_in_output');
  assert.equal(depsLock.run({ ...base, outputs: [{ relPath: 'lock.sha256', sha256: out.sha256, bytes: 4096 }] }).reason, 'not_hex');
  assert.equal(depsLock.run({ ...base, read: { error: 'hash_mismatch' } }).reason, 'lock_unreadable');
  for (const f of [base, { ...base, approvalLock: null }]) for (const e of depsLock.run(f).evidence) assert.ok(['exit', 'hash'].includes(e.type));
  // Nothing above wrote a row; the attempt still runs and completes on its own approval.
  assert.deepEqual(lockRows(w), []);
  w.exitWith(r, jobId, { code: 0, outputs: [out] });
  await w.settle();
  assert.equal(w.jobState(jobId), 'completed');
  sound(w, 'F3d', schedulerSweep(w));
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
  sound(w, 'F4', schedulerSweep(w));
  w.close();
});

test('F4b O21 is never tautological: a scheduler whose expiry sweep does nothing leaves O21 = 1 at its own sweep time; the check itself never sweeps', async () => {
  const w = egressWorld(); w.attach(); const x = ipcOver(w);
  const s = await x.ok('nexus:job:start', startArgs('sde.deps.install', { inputs: [{ versionId: w.repoV, slot: 'repository' }] }));
  w.exec.tick(w.now());
  const ap = (await x.ok('nexus:approvals:list', { status: 'pending' }))[0];
  assert.equal(ap.jobId, s.job.id);
  // The scheduler's sweep is broken: it runs on its cadence and records its time, but expires nothing.
  const realSweep = w.nx.approvals.expireDue;
  let calls = 0;
  w.nx.approvals.expireDue = () => { calls++; return 0; };
  w.advance(16 * MIN);
  w.exec.tick(w.now());
  assert.ok(calls >= 1, 'the scheduler ran its (broken) sweep');
  assert.equal(w.exec.lastExpirySweepAt, w.now());
  const pending = () => w.db.prepare("SELECT status FROM approvals WHERE id = ?").get(ap.id).status;
  assert.equal(pending(), 'pending');
  assert.equal(allOrphans(w.db, { sweptAt: w.exec.lastExpirySweepAt }).O21, 1, 'the unswept approval counts');
  assert.throws(() => sound(w, 'F4b broken sweep'), /orphans/, 'sound() reports it');
  assert.equal(pending(), 'pending', 'and sound() did not sweep it');
  // A working sweep on the scheduler's next pass: the approval expires, the job fails, O21 = 0.
  w.nx.approvals.expireDue = realSweep;
  sound(w, 'F4b', schedulerSweep(w));
  assert.equal(pending(), 'expired');
  assert.equal(w.jobState(s.job.id), 'failed');
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

test('F10 a failing suite\'s JUnit table (#34): the counts, then the failed cases, then the errored ones; names redacted and capped; every row once through the row cursor; #32 never lists the cases; bounded', async () => {
  const { junit } = require('./helpers/execWorld.cjs');
  const TOKEN = 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789';
  const w = execWorld({ realIngest: true }); const x = ipcOver(w);
  const r = await w.runTests({ exit: 1, junit: junit([{ name: 'passes' }, { name: 'errors out', outcome: 'errored' }, { name: 'adds', outcome: 'failed' },
    { name: `leaks ${TOKEN}`, outcome: 'failed' }, { name: 'y'.repeat(300), outcome: 'errored' }, { name: 'subtracts', outcome: 'failed' }]) });
  assert.equal(w.version(r.suiteVersionId).status, 'failed');
  const page = await x.ok('nexus:version:preview', r.suiteVersionId, { part: 'junit_summary', maxBytes: 65536 });
  assert.deepEqual(page.rows.slice(0, 5).map((y) => [y.name, y.outcome]), [['failed', '3'], ['errored', '2'], ['passed', '1'], ['skipped', '0'], ['total', '6']]);
  const cases = page.rows.slice(5);
  assert.deepEqual(cases.map((y) => y.outcome), ['failed', 'failed', 'failed', 'errored', 'errored'], 'failures first, then errors');
  assert.deepEqual(cases.slice(0, 3).map((y) => y.name), ['adds', 'leaks [redacted]', 'subtracts']);
  assert.deepEqual(cases.map((y) => y.detail), Array(5).fill('test/a.test.js'));
  assert.equal(cases[4].name.length, 200, 'a long name is capped');
  assert.equal(page.totalRows, 10); assert.equal(page.nextRow, null);
  noLeak(page); assert.doesNotMatch(JSON.stringify(page), /sk-ant/);
  // The row cursor: small pages, every row exactly once, in order.
  const seen = []; let from = 0; let pages = 0;
  for (;;) {
    const p = await x.ok('nexus:version:preview', r.suiteVersionId, { part: 'junit_summary', fromRow: from, maxBytes: 120 });
    seen.push(...p.rows.map((y) => y.name)); pages++;
    if (p.nextRow === null) break;
    assert.equal(p.nextRow, from + p.rows.length); from = p.nextRow;
  }
  assert.deepEqual(seen, page.rows.map((y) => y.name)); assert.ok(pages > 2);
  // The cases are kept as typed `case` evidence with the result; #32 lists the evidence without them.
  const ev = JSON.parse(w.latest(r.suiteVersionId, 'sde.tests_pass').evidence_json);
  assert.equal(ev.filter((e) => e.type === 'case').length, 5);
  const v = (await x.ok('nexus:version:validations', r.suiteVersionId)).find((y) => y.validatorId === 'sde.tests_pass');
  assert.ok(v.evidence.length > 0); assert.ok(v.evidence.every((e) => e.type !== 'case'));
  sound(w, 'F10');
  w.close();
  // Bounded: 450 failing cases keep at most MAX_LISTED_CASES within CASE_EVIDENCE_BUDGET; the result is still `failed`, never `error`.
  const { MAX_LISTED_CASES, CASE_EVIDENCE_BUDGET } = loadTs('src/main/nexus/exec/ingest.ts');
  const w2 = execWorld({ realIngest: true });
  const many = await w2.runTests({ exit: 1, junit: junit(Array.from({ length: 450 }, (_, i) => ({ name: `case number ${i}`, outcome: 'failed' }))) });
  const row = w2.latest(many.suiteVersionId, 'sde.tests_pass');
  const listed = JSON.parse(row.evidence_json).filter((e) => e.type === 'case');
  assert.equal(row.status, 'failed');
  assert.ok(listed.length > 0 && listed.length <= MAX_LISTED_CASES, String(listed.length));
  assert.ok(JSON.stringify(listed).length <= CASE_EVIDENCE_BUDGET + listed.length);
  assert.deepEqual(listed.slice(0, 2).map((e) => e.name), ['case number 0', 'case number 1']);
  sound(w2, 'F10 bounded');
  w2.close();
});

test('F-index the flow titles name the end-to-end ids of the REAL steps they prove', () => {
  const me = fs.readFileSync(path.join(__dirname, 'nexus-platform-b2a-flows.test.cjs'), 'utf8');
  for (const id of ['e2e.sde.repository', 'e2e.sde.tests', 'e2e.sde.build', 'e2e.sde.application', 'e2e.sde.dev-deployment', 'e2e.sde.diagnostics', 'e2e.sde.requirement']) {
    assert.ok(me.split('\n').some((l) => /^test\('F/.test(l) && l.includes(` ${id}`)), id);
  }
});
