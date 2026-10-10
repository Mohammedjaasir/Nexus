'use strict';
// B2a Task 12: the SDE recipes end to end with the FAKE sandbox driver (test/helpers/execFakeWorld.cjs): real main, a
// real RunnerCore (git staging, hashing, parsers, the per-file JUnit merge, diagnose) and recorded container outputs.
// The same flows (test/helpers/recipeFlows.cjs) run against real Docker in test/nexus-exec-recipes.test.cjs, behind the
// test:exec gate. Plus the end-to-end flows of the REAL steps that need no container (requirement, project, code, and
// the DA / ML / DL problem statements). Each test title names the registry's e2e test id of the step it proves.
// Electron-as-node (real SQLite): run by `npm run test:db`.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const h = require('./helpers/sqlite.cjs');

if (h.realSqliteOrSkip()) {
  const loadTs = require('./load-ts.cjs');
  const { fakeWorld, fixtureRepo } = require('./helpers/execFakeWorld.cjs');
  const { flows } = require('./helpers/recipeFlows.cjs');
  const { UserSaves } = loadTs('src/main/nexus/commands/userSaves.ts');
  const { createSourcePorts } = loadTs('src/main/nexusIpc/sources.ts');
  const { allOrphans } = require('./helpers/orphans.cjs');

  let w = null;
  const ctx = {};
  const world = async () => { if (!w) w = await fakeWorld(); return w; };
  const checked = async (name, fn) => {
    const x = await world();
    await fn(x, ctx);
    // After every flow: no orphan of any kind (O1-O17) and the store is sound.
    const o = allOrphans(x.db);
    assert.deepEqual(Object.fromEntries(Object.entries(o).filter(([, n]) => n > 0)), {}, `${name}: orphans`);
    assert.deepEqual(x.db.pragma('foreign_key_check'), [], `${name}: foreign keys`);
  };

  test('X1 e2e.sde.repository snapshot -> repository active, git.head_resolves passed; the Repository step is done (fake driver)', () => checked('X1', flows.X1));
  test('X2 e2e.sde.tests node:test app: discover -> suite draft -> sde.tests_pass passed -> candidate; JUnit counts equal discovery, every case attributed to its file (A5)', () => checked('X2', flows.X2));
  test('X3 failing fixture -> suite failed (tests_failed), the discovery job reads checks_failed', () => checked('X3', flows.X3));
  test('X4 empty fixture -> no_tests (node reports a file without tests as one passing case; Nexus does not count it)', () => checked('X4', flows.X4));
  test('X5 e2e.sde.build build -> candidate, manifest hashed, blob.integrity passed', () => checked('X5', flows.X5));
  test('X6 e2e.sde.application assemble -> application draft, app.manifest_schema passed; a candidate only after its health check', () => checked('X6', flows.X6));
  test('X7 e2e.sde.dev-deployment dev deployment -> healthy on 127.0.0.1, app.preview_health passed, application candidate; Stop -> stopped, cleaned up', () => checked('X7', flows.X7));
  test('X8 e2e.sde.diagnostics diagnose the deployment -> diagnostic_report candidate with inspect, http and log sources (A1)', () => checked('X8', flows.X8));
  test('X9 bad health path -> app.preview_health failed, application failed, the deployment failed probe_failed', () => checked('X9', flows.X9));
  test('X10 pytest app (sde-python) -> candidate; environment_json records the python base digest, context hash and nexus.versions', () => checked('X10', flows.X10));
  test('X11 Python wheel build -> candidate', () => checked('X11', flows.X11));
  test('X12 a manifest argument "; touch /out/pwned" stays one argv element and creates no file', () => checked('X12', flows.X12));

  test('X1b the diagnose engine reports a non-Nexus container as not_owned with no facts, and a log range outside the data home as refused', async () => {
    const x = await world();
    // A deployment is the subject; the user's own container (no nexus.home label) is never inspected through it.
    const foreign = 'b'.repeat(64);
    x.driver.extra.push({ kind: 'container', id: foreign, name: 'my-db', labels: { 'com.example': 'mine' }, state: 'running' });
    const loadTsLocal = require('./load-ts.cjs');
    const { diagnose, diagnoseTaskProblem } = loadTsLocal('src/runner/diagnose.ts');
    const { HomePaths } = loadTsLocal('src/runner/paths.ts');
    const { homeLabel } = loadTsLocal('src/shared/nexus/homeLabel.ts');
    const paths = new HomePaths(x.dataHome.root);
    const outside = path.join(path.dirname(x.dataHome.root), 'elsewhere.log');
    const task = { engine: 'sde.diagnose', target: 'job', containerIds: [foreign, 'c'.repeat(64)],
      logRanges: [{ attemptId: '01K7A0SYNTHET1CATTEMPT0000', logPath: outside, offset: 0, length: 100, tail: false }] };
    assert.equal(diagnoseTaskProblem(task), null);
    const r = await diagnose({ driver: x.driver, fs: require('node:fs/promises'), paths, home: homeLabel(x.dataHome.root) }, task, new AbortController().signal);
    assert.deepEqual(r.containers.map((c) => [c.status, c.facts]), [['not_owned', null], ['missing', null]]);
    assert.equal(r.logs[0].status, 'refused');
    assert.equal(x.driver.callsOf('inspectFacts').filter((c) => c.args[0] === foreign).length, 1, 'only its labels were read');
    assert.equal(diagnoseTaskProblem({ ...task, containerIds: ['x'] }), 'the diagnosed containers are not container ids');
    assert.equal(diagnoseTaskProblem({ ...task, containerIds: [], logRanges: [] }), 'the diagnosis names nothing to read');
  });

  test('F-REQ e2e.sde.requirement write a requirement -> draft with req.schema passed -> Mark ready -> candidate; the Requirement step is done', async () => {
    const x = await world();
    const content = { title: 'Ledger export', body: 'Export the ledger as CSV.', criteria: [{ id: 'AC1', text: 'A CSV file downloads' }, { id: 'AC2', text: 'Totals match' }] };
    const s = x.nx.artifacts.saveInline(x.me, { projectId: x.projectId, workspaceId: 'sde', kind: 'requirement', target: { name: 'Export' }, content });
    assert.equal(s.version.status, 'draft');
    assert.equal(x.latest(s.version.id, 'req.schema').status, 'passed');
    assert.notEqual(x.stepState('sde', 'requirement'), 'done', 'a draft is not done');
    assert.equal(x.nx.artifacts.markReady(x.me, s.version.id).status, 'candidate');
    assert.equal(x.stepState('sde', 'requirement'), 'done');
  });

  test('F-PROJ e2e.sde.project the project takes part in SDE (an active participation) -> the Project step is done', async () => {
    const x = await world();
    assert.ok(x.nx.workspaces.primaryOf(x.me, x.projectId));
    assert.equal(x.stepState('sde', 'project'), 'done');
  });

  test('F-CODE e2e.sde.code save a commit of the project folder -> git_commit draft -> Mark ready -> candidate; the Code step is done', async () => {
    const x = await world();
    const repo = fixtureRepo('node-test-app');
    x.db.prepare('UPDATE projects SET root_path = ? WHERE id = ?').run(repo.dir, x.projectId);
    const getProject = (id) => { const r = x.db.prepare('SELECT root_path FROM projects WHERE id = ?').get(id); return r ? { rootPath: r.root_path } : null; };
    const saves = new UserSaves(x.nx, createSourcePorts({ acceptFsRoot: (r) => (path.resolve(r) === path.resolve(repo.dir) ? path.resolve(r) : null), getProject }));
    const r = await saves.saveCommit(x.me, { projectId: x.projectId, workspaceId: 'sde', commit: repo.commit, target: { name: 'Release' } });
    assert.equal(JSON.parse(x.version(r.version.id).storage_ref_json).commit, repo.commit);
    assert.equal(x.nx.artifacts.markReady(x.me, r.version.id).status, 'candidate');
    assert.equal(x.stepState('sde', 'code'), 'done');
  });

  /** A problem statement written in a domain's participation: draft, problem.schema passed, Mark ready, candidate, done. */
  const problemFlow = async (domain, stepId, question) => {
    const x = await world();
    if (!x.db.prepare("SELECT 1 FROM project_workspaces WHERE project_id = ? AND workspace_id = ? AND status = 'active'").get(x.projectId, domain)) {
      x.nx.workspaces.attach(x.me, x.projectId, domain);
    }
    assert.notEqual(x.stepState(domain, stepId), 'done');
    const s = x.nx.artifacts.saveInline(x.me, { projectId: x.projectId, workspaceId: domain, kind: 'problem_statement', target: { name: 'Question' },
      content: { question, successCriteria: ['A ranked answer with its evidence'] } });
    assert.equal(s.version.status, 'draft');
    assert.equal(x.latest(s.version.id, 'problem.schema').status, 'passed');
    assert.equal(x.nx.artifacts.markReady(x.me, s.version.id).status, 'candidate');
    assert.equal(x.stepState(domain, stepId), 'done');
  };
  test('F-DATA e2e.data.business-question write a business question in Data Analyst -> problem.schema passed -> Mark ready -> candidate; the step is done',
    () => problemFlow('data', 'business-question', 'Why do customers leave in their first month?'));
  test('F-ML e2e.ml.problem write a problem statement in ML -> problem.schema passed -> Mark ready -> candidate; the step is done',
    () => problemFlow('ml', 'problem', 'Can we predict which invoices will be paid late?'));
  test('F-DL e2e.dl.problem write a problem statement in DL -> problem.schema passed -> Mark ready -> candidate; the step is done',
    () => problemFlow('dl', 'problem', 'Can a model read the totals off scanned receipts?'));

  // ---------- B2a Task 12 fix round 1 ----------

  test('RV5 (item 5) an identical build tree from a NEW commit is a new build version with its own commit and built_from edge; assembly reads that commit\'s nexus.app.json; the preview stages that commit', async () => {
    const x = await world();
    const { snapshot, build, assemble, deploy, stop } = require('./helpers/recipeFlows.cjs');
    const app = JSON.parse(x.fixtureFile('node-test-app', 'nexus.app.json'));
    const handler = x.fixtureFile('node-test-app', 'src/handler.js').replace('hello from node-test-app', 'hello from node-test-app (RV5)');
    await x.useFixture('node-test-app', { 'src/handler.js': handler, 'NOTES.md': 'first commit\n' });
    const s1 = await snapshot(x);
    const c1 = JSON.parse(x.version(s1.versionId).storage_ref_json).commit;
    const b1 = await build(x, s1.versionId);
    // A second commit: the same build output, another manifest (one more run argument) and another note.
    await x.useFixture('node-test-app', { 'src/handler.js': handler, 'NOTES.md': 'second commit\n',
      'nexus.app.json': JSON.stringify({ ...app, run: [...app.run, '--second-commit'] }, null, 2) });
    const s2 = await snapshot(x);
    const c2 = JSON.parse(x.version(s2.versionId).storage_ref_json).commit;
    assert.notEqual(c1, c2);
    const b2 = await build(x, s2.versionId);
    assert.equal(JSON.parse(b2.version.storage_ref_json).manifestSha256, JSON.parse(b1.version.storage_ref_json).manifestSha256, 'the very same tree');
    assert.notEqual(b2.version.id, b1.version.id, 'a new build version (never merged into the older commit\'s)');
    assert.deepEqual([JSON.parse(b1.version.metadata_json).commit, JSON.parse(b2.version.metadata_json).commit], [c1, c2]);
    const builtFrom = (v) => x.db.prepare("SELECT to_version_id FROM artifact_edges WHERE from_version_id = ? AND relation = 'built_from'").all(v).map((e) => e.to_version_id);
    assert.deepEqual([builtFrom(b1.version.id), builtFrom(b2.version.id)], [[s1.versionId], [s2.versionId]], 'each build names its own repository version');
    assert.equal(b2.version.status, 'candidate');
    // Blobs still dedupe as blobs: both versions name the same two files.
    const blobs = (v) => x.db.prepare("SELECT sha256 FROM version_blobs WHERE version_id = ? AND role = 'file' ORDER BY path").all(v).map((r) => r.sha256);
    assert.deepEqual(blobs(b2.version.id), blobs(b1.version.id));
    // The same tree from the same commit is still the same version.
    const again = await build(x, s2.versionId);
    assert.equal(again.version.id, b2.version.id);
    const a2 = await assemble(x, b2.version.id);
    assert.deepEqual(JSON.parse(a2.version.storage_ref_json).json.run, [...app.run, '--second-commit'], 'the second commit\'s manifest');
    const d = await deploy(x, a2.version.id);
    assert.equal(d.deployment.status, 'healthy');
    const att = x.attemptsOf(d.jobId).pop();
    const rec = JSON.parse(fs.readFileSync(path.join(x.dataHome.root, 'work', d.jobId, String(att.n), 'plan.json'), 'utf8'));
    assert.equal(rec.plan.staging.source.commit, c2, 'the preview stages the new commit');
    await stop(x, d.deployment.id, d.jobId);
  });

  test('RV11a (item 11) ingest holds a diagnosis to its plan: a report naming a container or an attempt main did not plan is refused (parser_contract), and no report version is made', async () => {
    const x = await world();
    const { snapshot, build, assemble, deploy, stop, jobEnds, produced } = require('./helpers/recipeFlows.cjs');
    await x.useFixture('node-test-app', { 'src/handler.js': x.fixtureFile('node-test-app', 'src/handler.js').replace('hello from node-test-app', 'hello (RV11a)') });
    const s = await snapshot(x);
    const b = await build(x, s.versionId);
    const a = await assemble(x, b.version.id);
    const d = await deploy(x, a.version.id);
    assert.equal(d.deployment.status, 'healthy');
    await x.until(() => JSON.parse(x.deploymentRow(d.deployment.id).health_json).length >= 1, 'a probe is recorded', 60_000);
    const post = x.core.post;
    const tampered = (mut) => (m) => {
      if (m && m.op === 'attempt.exited' && m.parsed?.[0]?.parser === 'diagnostic') {
        const c = structuredClone(m); mut(c.parsed[0].normalized); return post.call(x.core, c);
      }
      return post.call(x.core, m);
    };
    try {
      for (const [what, mut] of [['container', (n) => { n.containers[0].container.sha256 = 'e'.repeat(64); }],
        ['attempt', (n) => { n.logs[0].attemptId = '01K7A0SYNTHET1CATTEMPT0000'; }],
        ['dropped container', (n) => { n.containers = []; }]]) {
        x.core.post = tampered(mut);
        const j = x.start('sde.diagnose', { params: { target: 'deployment', targetId: d.deployment.id } });
        const ended = await jobEnds(x, j.id, 3 * 60_000);
        assert.equal(ended.state, 'failed', what);
        const err = JSON.parse(ended.error_json);
        assert.equal(err.code, 'parser_contract', `${what}: ${ended.error_json}`);
        assert.match(err.message, /did not plan/);
        assert.equal(produced(x, j.id, 'report'), null, `${what}: no report version`);
      }
      // Untampered, the same diagnosis is accepted (the plan's ids are the runner's ids).
      x.core.post = post;
      const ok = x.start('sde.diagnose', { params: { target: 'deployment', targetId: d.deployment.id } });
      assert.equal((await jobEnds(x, ok.id, 3 * 60_000)).state, 'completed');
      const sb = JSON.parse(x.attemptsOf(ok.id).pop().sandbox_json);
      assert.equal(sb.containerIds.length, 1); assert.match(sb.containerIds[0].sha256, /^[0-9a-f]{64}$/);
      assert.ok(sb.logRanges.length >= 1 && sb.logRanges.every((r) => typeof r.attemptId === 'string'));
    } finally {
      x.core.post = post;
      await stop(x, d.deployment.id, d.jobId);
    }
  });

  // B2a stabilization: on a loaded machine X10's snapshot ended `timed_out` (its 60 s wall clock) because the fake clock
  // kept advancing a second per step while the runner's REAL git calls had not answered. The fake world now waits for the
  // runner's real I/O before fake time passes. Here every runner git call takes 1.5 s of real time (a slow machine):
  // without the wait the snapshot ran 62 fake seconds in about 1 real second and timed out.
  test('XH the fake clock waits for the runner\'s real git: a snapshot whose every git call takes 1.5 s still completes, in a few fake seconds', async () => {
    const x = await fakeWorld();
    try {
      await x.useFixture('pytest-app');
      x.core.git = new Proxy(x.core.git, { get(t, k) {
        const v = Reflect.get(t, k, t);
        return typeof v === 'function' ? async (...a) => { await new Promise((r) => setTimeout(r, 1500)); return v.apply(t, a); } : v;
      } });
      const c0 = x.clock.now;
      const r = await x.snapshot();
      assert.ok(r.versionId);
      assert.ok(x.clock.now - c0 < 30_000, `the snapshot took ${(x.clock.now - c0) / 1000} fake seconds`);
    } finally { await x.close(); }
  });

  test('XL the fake world left no labelled container, volume or network behind, and every recorded report it used is in the repository', async () => {
    const x = await world();
    assert.deepEqual(x.driver.all().filter((r) => r.labels && r.labels['nexus.attempt'] && r.labels['nexus.kind'] !== 'deps'), []);
    for (const f of ['node-test-app/0001.xml', 'node-test-app/0002.xml', 'node-test-failing/0001.xml', 'node-test-empty/0001.xml', 'pytest-app/junit.xml'])
      assert.ok(fs.existsSync(path.join(__dirname, 'fixtures', 'exec', 'recorded', f)), f);
  });
}
