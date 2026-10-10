'use strict';
// The SDE recipe flows X1-X12 (B2a Task 12), written ONCE over a "recipe world" and run twice:
// - test/nexus-platform-exec-recipes.test.cjs: the fake world (test/helpers/execFakeWorld.cjs): real main (SQLite,
//   ExecutionService, ingest, validation, deployments, RepoService), a real RunnerCore with real git, real staging, real
//   hashing, real parsers and the per-file JUnit merge, and the fake sandbox driver playing RECORDED container outputs
//   (node 20.20.2's own JUnit reports of the fixtures). Runs now, under test:db.
// - test/nexus-exec-recipes.test.cjs: the real world (test/helpers/execReal.cjs): the same main, RunnerCore in a child
//   process with the real Docker driver and the pinned images. Runs only behind the test:exec resource gate.
// Nothing here knows which world it runs in, except `w.kind` where a check can only be made against real Docker.
//
// A world provides: kind, nx, exec, db, me, projectId, workspaceId, useFixture(name, overlay) -> { dir, commit },
// setLanguages(list), snapshot() -> { jobId, versionId }, start(actionId, { inputs, params }) -> job, until(pred, what, ms),
// version(id), job(id), latest(versionId, validatorId), stepState(domainId, stepId), deploymentOf(jobId), outDir(jobId),
// liveLabelled(jobId) -> number of labelled containers/volumes/networks the job still has.
const assert = require('node:assert/strict');

const MIN = 60_000;
const terminal = (s) => ['completed', 'partial', 'failed', 'cancelled', 'timed_out', 'interrupted'].includes(s);

/**
 * The version a job's output became: the one it produced at the output path, or (ingest deduplicates equal content into
 * the existing version and binds this job's evidence to it) the version its validation rows are bound to.
 */
function produced(w, jobId, outputPath) {
  const own = w.db.prepare('SELECT * FROM artifact_versions WHERE produced_by_job_id = ? AND output_path = ? ORDER BY rowid DESC LIMIT 1').get(jobId, outputPath);
  if (own) return own;
  const bound = w.db.prepare('SELECT version_id FROM validations WHERE job_id = ? ORDER BY rowid DESC LIMIT 1').get(jobId);
  return bound ? w.version(bound.version_id) : null;
}
async function jobEnds(w, jobId, ms = 10 * MIN) {
  await w.until(() => terminal(w.job(jobId).state), `job ${jobId} ends`, ms);
  return w.job(jobId);
}
/** A version leaves draft (its checks, run by child jobs, all recorded). */
async function versionSettles(w, versionId, ms = 15 * MIN) {
  await w.until(() => w.version(versionId).status !== 'draft', `version ${versionId} leaves draft`, ms);
  return w.version(versionId);
}
const evidenceOf = (row) => JSON.parse(row.evidence_json ?? '[]');
const envOf = (row) => JSON.parse(row.environment_json ?? 'null');
/** A validation row's machine reason (stored at the end of its summary, `... (<reason>)`), or null. */
const reasonOf = (row) => (/\(([a-z_]+)\)$/.exec(row?.summary ?? '') ?? [])[1] ?? null;

/** Snapshot of the current fixture: the repository version (X1's rule, used by the others too). */
async function snapshot(w) {
  const s = await w.snapshot();
  assert.equal(w.version(s.versionId).status, 'active', 'a repository snapshot is promoted to active by the system');
  return s;
}

/** Discovery, then the suite's sde.tests_pass child job: the suite version once it left draft. */
async function discoverAndRun(w, repositoryVersionId) {
  const d = w.start('sde.tests.discover', { inputs: [{ versionId: repositoryVersionId, slot: 'repository' }] });
  const dj = await jobEnds(w, d.id);
  assert.equal(dj.state, 'completed', `discovery completed (${dj.outcome} ${dj.error_json})`);
  const suite = produced(w, d.id, 'ids.txt');
  assert.ok(suite, 'discovery produced a test suite version');
  assert.equal(w.latest(suite.id, 'suite.discovered').status, 'passed');
  const settled = await versionSettles(w, suite.id);
  const check = w.db.prepare("SELECT * FROM jobs WHERE kind = 'validate' AND validator_id = 'sde.tests_pass' AND parent_job_id = ? ORDER BY rowid DESC LIMIT 1").get(d.id);
  return { discoveryJob: dj, suite: settled, check };
}

async function build(w, repositoryVersionId) {
  const b = w.start('sde.build.run', { inputs: [{ versionId: repositoryVersionId, slot: 'repository' }] });
  const bj = await jobEnds(w, b.id);
  assert.equal(bj.state, 'completed', `build completed (${bj.outcome} ${bj.error_json})`);
  const v = produced(w, b.id, 'dist');
  assert.ok(v, 'the build produced a tree version');
  return { job: bj, version: await versionSettles(w, v.id) };
}

async function assemble(w, buildVersionId) {
  const a = w.start('sde.app.assemble', { inputs: [{ versionId: buildVersionId, slot: 'build' }] });
  const aj = await jobEnds(w, a.id);
  assert.equal(aj.state, 'completed', `assembly completed (${aj.outcome} ${aj.error_json})`);
  const v = produced(w, a.id, 'manifest');
  assert.ok(v, 'assembly produced an application version');
  return { job: aj, version: w.version(v.id) };
}

/** Starts a dev deployment of an application version and waits for it to leave `starting`. */
async function deploy(w, applicationVersionId) {
  const j = w.start('sde.preview.start', { inputs: [{ versionId: applicationVersionId, slot: 'application' }] });
  await w.until(() => { const d = w.deploymentOf(j.id); return !!d && d.status !== 'starting'; }, 'the deployment leaves starting', 3 * MIN);
  return { jobId: j.id, deployment: w.deploymentOf(j.id) };
}

async function stop(w, deploymentId, jobId) {
  w.nx.deployments.stop(w.me, deploymentId);
  const j = await jobEnds(w, jobId, 3 * MIN);
  await w.until(() => w.liveLabelled(jobId) === 0, 'the deployment\'s containers, networks and volumes are removed', 2 * MIN);
  return j;
}

// ---------------------------------------------------------------- the flows

const flows = {
  /** X1: snapshot -> repository active, git.head_resolves passed; the step is done. */
  async X1(w, ctx) {
    const fx = await w.useFixture('node-test-app');
    const s = await snapshot(w);
    const v = w.version(s.versionId);
    assert.equal(JSON.parse(v.storage_ref_json).commit, fx.commit, 'the snapshot stores the fixture commit');
    assert.equal(w.latest(s.versionId, 'git.head_resolves').status, 'passed');
    assert.equal(w.stepState('sde', 'repository'), 'done');
    ctx.repo = s.versionId; ctx.commit = fx.commit;
  },

  /** X2: node:test app: discover -> suite draft -> sde.tests_pass passed -> candidate; JUnit counts equal discovery; every case attributed. */
  async X2(w, ctx) {
    const r = await discoverAndRun(w, ctx.repo);
    assert.equal(r.suite.status, 'candidate', 'the suite is a candidate');
    const meta = JSON.parse(r.suite.metadata_json);
    assert.equal(meta.framework, 'node-test');
    assert.deepEqual(meta.files, ['test/math.test.js', 'test/server.test.js'], 'two discovered files (A5: a multi-file suite)');
    const pass = w.latest(r.suite.id, 'sde.tests_pass');
    assert.equal(pass.status, 'passed', `sde.tests_pass passed (${pass.summary})`);
    const ev = evidenceOf(pass);
    const junit = ev.find((e) => e.type === 'junit');
    assert.deepEqual([junit.total, junit.passed, junit.failed, junit.errored, junit.skipped], [4, 4, 0, 0, 0], 'four tests ran and passed');
    assert.equal(ev.find((e) => e.type === 'number' && e.name === 'discovered').value, 2, 'the counts are judged against the two discovered files');
    assert.equal(r.check.state, 'completed');
    // The per-file reports were merged with every case attributed to its file (not an unattributed_report error).
    assert.equal(reasonOf(pass), null, 'no reason: not an unattributed_report error');
    const env = envOf(w.db.prepare('SELECT environment_json FROM job_attempts WHERE job_id = ? ORDER BY n DESC LIMIT 1').get(r.check.id));
    assert.equal(env.profile, 'sde-node'); assert.match(env.imageId, /^sha256:[0-9a-f]{64}$/); assert.match(env.baseDigest, /^sha256:[0-9a-f]{64}$/);
    assert.match(String(env.imageVersions), /^node=20\.\d+\.\d+ jest-junit=/, 'the image records its node version');
    assert.equal(w.stepState('sde', 'tests'), 'done');
    ctx.suite = r.suite.id;
  },

  /** X3: a failing test -> suite failed (sde.tests_pass failed: tests_failed), the discovery job's headline checks_failed. */
  async X3(w) {
    await w.useFixture('node-test-failing');
    const s = await snapshot(w);
    const r = await discoverAndRun(w, s.versionId);
    assert.equal(r.suite.status, 'failed');
    const pass = w.latest(r.suite.id, 'sde.tests_pass');
    assert.deepEqual([pass.status, reasonOf(pass)], ['failed', 'tests_failed']);
    assert.equal(evidenceOf(pass).find((e) => e.type === 'junit').failed, 1);
    assert.equal(w.exec.list(w.me, { projectId: w.projectId }).jobs.find((x) => x.id === r.discoveryJob.id).headline, 'checks_failed');
    // The step stays done from X2's passing suite: a failed later suite never undoes validated evidence, and never adds to it.
    assert.equal(w.db.prepare("SELECT COUNT(*) AS n FROM artifact_versions WHERE id = ? AND status = 'failed'").get(r.suite.id).n, 1);
  },

  /** X4: a test file that declares no test -> no_tests (node's synthetic "file ran" case is not a passing test). */
  async X4(w) {
    await w.useFixture('node-test-empty');
    const s = await snapshot(w);
    const r = await discoverAndRun(w, s.versionId);
    const pass = w.latest(r.suite.id, 'sde.tests_pass');
    assert.deepEqual([pass.status, reasonOf(pass)], ['failed', 'no_tests'], `${pass.summary}`);
    assert.equal(r.suite.status, 'failed');
  },

  /** X5: build -> candidate, manifest hashed, blob.integrity passed. */
  async X5(w, ctx) {
    await w.useFixture('node-test-app');
    const s = await snapshot(w);
    ctx.repo = s.versionId;
    const b = await build(w, s.versionId);
    assert.equal(b.version.status, 'candidate');
    const st = JSON.parse(b.version.storage_ref_json);
    assert.equal(st.kind, 'tree'); assert.equal(st.files, 2); assert.match(st.manifestSha256, /^[0-9a-f]{64}$/);
    for (const id of ['build.exit_zero', 'build.manifest_present', 'build.output_hashed', 'blob.integrity']) assert.equal(w.latest(b.version.id, id).status, 'passed', id);
    const files = w.db.prepare("SELECT path FROM version_blobs WHERE version_id = ? AND role = 'file' ORDER BY path").all(b.version.id).map((x) => x.path);
    assert.deepEqual(files, ['app.js', 'index.html']);
    assert.equal(w.stepState('sde', 'build'), 'done');
    ctx.build = b.version.id;
  },

  /** X6: assemble -> application draft, app.manifest_schema passed (a candidate only after its dev deployment's health check). */
  async X6(w, ctx) {
    const a = await assemble(w, ctx.build);
    assert.equal(a.version.status, 'draft');
    assert.equal(w.latest(a.version.id, 'app.manifest_schema').status, 'passed');
    assert.equal(JSON.parse(a.version.storage_ref_json).json.healthPath, '/health');
    assert.notEqual(w.stepState('sde', 'application'), 'done', 'not done before its health check');
    ctx.app = a.version.id;
  },

  /** X7: dev deployment -> healthy on 127.0.0.1, app.preview_health passed, application candidate; Stop -> stopped, cleaned up. */
  async X7(w, ctx) {
    const d = await deploy(w, ctx.app);
    assert.equal(d.deployment.status, 'healthy', `the deployment is healthy (${d.deployment.stop_reason ?? ''})`);
    assert.equal(d.deployment.bind_address, '127.0.0.1');
    assert.ok(d.deployment.host_port >= 49152 && d.deployment.host_port <= 65535);
    assert.equal(w.latest(ctx.app, 'app.preview_health').status, 'passed');
    await w.until(() => w.version(ctx.app).status === 'candidate', 'the application becomes a candidate', MIN);
    assert.equal(w.stepState('sde', 'application'), 'done');
    assert.equal(w.stepState('sde', 'dev-deployment'), 'done');
    if (w.kind === 'real') assert.equal(await w.httpGet(d.deployment.host_port, '/health'), 200, 'the host reaches the app through the loopback forwarder');
    const j = await stop(w, d.deployment.id, d.jobId);
    assert.equal(w.deploymentOf(d.jobId).status, 'stopped');
    assert.deepEqual([j.state, j.outcome], ['completed', 'stopped']);
  },

  /** X8: diagnose a running deployment -> diagnostic_report candidate whose fields come from inspect, http and log sources. */
  async X8(w, ctx) {
    const d = await deploy(w, ctx.app);
    assert.equal(d.deployment.status, 'healthy');
    // At least one probe is recorded in main's table before the diagnosis (its http fields come from there).
    await w.until(() => JSON.parse(w.deploymentRow(d.deployment.id).health_json).length >= 1, 'a probe is recorded', MIN);
    const diag = w.start('sde.diagnose', { params: { target: 'deployment', targetId: d.deployment.id } });
    const dj = await jobEnds(w, diag.id, 3 * MIN);
    assert.equal(dj.state, 'completed', `the diagnosis completed (${dj.outcome} ${dj.error_json})`);
    const rep = produced(w, diag.id, 'report');
    assert.ok(rep, 'a diagnostic report version');
    assert.equal(rep.status, 'candidate');
    assert.equal(w.latest(rep.id, 'diag.schema').status, 'passed');
    const report = JSON.parse(rep.storage_ref_json).json;
    const types = new Set(report.fields.map((f) => f.source.type));
    assert.deepEqual([...types].sort(), ['http', 'inspect', 'log']);
    const field = (n) => report.fields.find((f) => f.name === n);
    assert.equal(field('container.state').value, 'running');
    assert.equal(field('container.limits.pids').value, 512);
    assert.equal(field('container.user').value, '10001:10001');
    assert.equal(field('health.lastStatus').value, 200);
    assert.match(field('log.frames').source.sha256, /^[0-9a-f]{64}$/);
    assert.equal(report.subject.id, d.deployment.id);
    // Lineage: the report derives from the previewed application.
    assert.ok(w.db.prepare("SELECT 1 FROM artifact_edges WHERE from_version_id = ? AND to_version_id = ?").get(rep.id, ctx.app));
    assert.equal(w.stepState('sde', 'diagnostics'), 'done');
    await stop(w, d.deployment.id, d.jobId);
  },

  /** X9: a health path the app does not serve -> app.preview_health failed, the application failed. */
  async X9(w) {
    await w.useFixture('node-test-badhealth');
    const s = await snapshot(w);
    const b = await build(w, s.versionId);
    const a = await assemble(w, b.version.id);
    const d = await deploy(w, a.version.id);
    assert.equal(d.deployment.status, 'failed');
    assert.equal(d.deployment.stop_reason, 'probe_failed');
    const h = w.latest(a.version.id, 'app.preview_health');
    assert.deepEqual([h.status, reasonOf(h)], ['failed', 'no_health']);
    assert.equal(w.version(a.version.id).status, 'failed');
    await jobEnds(w, d.jobId, 3 * MIN);
    await w.until(() => w.liveLabelled(d.jobId) === 0, 'cleanup', 2 * MIN);
  },

  /** X10: pytest app (sde-python) -> candidate; the environment records the python image's base digest, context hash and nexus.versions. */
  async X10(w, ctx) {
    await w.useFixture('pytest-app');
    w.setLanguages(['python']);
    const s = await snapshot(w);
    ctx.pyRepo = s.versionId;
    const r = await discoverAndRun(w, s.versionId);
    assert.equal(r.suite.status, 'candidate');
    const meta = JSON.parse(r.suite.metadata_json);
    assert.deepEqual([meta.framework, meta.profile], ['pytest', 'sde-python']);
    const pass = w.latest(r.suite.id, 'sde.tests_pass');
    assert.equal(pass.status, 'passed', pass.summary);
    assert.equal(evidenceOf(pass).find((e) => e.type === 'junit').total, 3);
    const env = envOf(w.db.prepare('SELECT environment_json FROM job_attempts WHERE job_id = ? ORDER BY n DESC LIMIT 1').get(r.check.id));
    assert.equal(env.profile, 'sde-python');
    assert.equal(env.baseDigest, w.lock.profiles['sde-python'].base.digest, 'the pinned python base digest');
    assert.equal(env.contextSha256, w.lock.profiles['sde-python'].contextSha256, 'the context hash of the built image');
    const v = w.lock.profiles['sde-python'].versions;
    assert.equal(env.imageVersions, `python=${v.python} pytest=${v.pytest} build=${v.build} wheel=${v.wheel} setuptools=${v.setuptools}`);
    assert.deepEqual(envOf(r.suite).profile, 'sde-python', 'the suite version copies the environment');
  },

  /** X11: Python wheel build -> candidate. */
  async X11(w, ctx) {
    const b = await build(w, ctx.pyRepo);
    assert.equal(b.version.status, 'candidate');
    const files = w.db.prepare("SELECT path FROM version_blobs WHERE version_id = ? AND role = 'file'").all(b.version.id).map((x) => x.path);
    assert.equal(files.length, 1); assert.match(files[0], /^pytest_app-0\.1\.0-py3-none-any\.whl$/);
    assert.equal(w.latest(b.version.id, 'blob.integrity').status, 'passed');
    w.setLanguages(['javascript']);
  },

  /** X12: a manifest argument `; touch /out/pwned` stays ONE argv element and creates no file. */
  async X12(w) {
    const evil = '; touch /out/pwned';
    const app = JSON.parse(w.fixtureFile('node-test-app', 'nexus.app.json'));
    // The home page changes too, so the build output differs from X5's (equal trees deduplicate into one build version).
    const handler = w.fixtureFile('node-test-app', 'src/handler.js').replace('hello from node-test-app', 'hello from node-test-app (X12)');
    await w.useFixture('node-test-app', { 'nexus.app.json': JSON.stringify({ ...app, run: [...app.run, evil] }, null, 2), 'src/handler.js': handler });
    const s = await snapshot(w);
    const b = await build(w, s.versionId);
    const a = await assemble(w, b.version.id);
    assert.deepEqual(JSON.parse(a.version.storage_ref_json).json.run, ['node', 'src/server.js', evil]);
    const d = await deploy(w, a.version.id);
    assert.equal(d.deployment.status, 'healthy', 'the argument reached the app as data, and the app still serves');
    const sandbox = JSON.parse(w.db.prepare('SELECT sandbox_json FROM job_attempts WHERE job_id = ? ORDER BY n DESC LIMIT 1').get(d.jobId).sandbox_json);
    assert.deepEqual(sandbox.app.argv, ['node', 'src/server.js', evil], 'one element, exactly as written');
    const argv = await w.containerArgv(d.jobId);
    assert.equal(argv[argv.length - 1], evil, 'the container\'s command ends with the one untouched element');
    // Whether the Nexus entry evaluated the element can only be seen where the entry runs: in the real world (the app
    // container's /out is the attempt's out folder, so an evaluated `touch /out/pwned` would leave the file there). The
    // fake driver runs no entry, so the check would be vacuous there (fix round 1, item 13); the entry's own rule is
    // proven on a POSIX sh by test/nexus-core-exec-entry.test.cjs E2.
    if (w.kind === 'real') assert.equal(w.outExists(d.jobId, 'pwned'), false, 'no /out/pwned was created');
    await stop(w, d.deployment.id, d.jobId);
    if (w.kind === 'real') assert.equal(w.outExists(d.jobId, 'pwned'), false);
  }
};

module.exports = { reasonOf, flows, produced, jobEnds, versionSettles, snapshot, discoverAndRun, build, assemble, deploy, stop, evidenceOf, terminal };
