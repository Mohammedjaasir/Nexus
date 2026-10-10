'use strict';
// B2a Task 12: restart recovery on REAL Docker (L13-L16, constraint 10): the runner child is killed mid-work (a crashed
// utilityProcess: the host restarts it after 1 s and main reconciles at its ready), and main itself is "crashed" (its
// wiring dropped without the quit path, the store reopened by a new platform with a new boot id). Nothing is ever marked
// completed by recovery alone: a job completes only through its ingest and its version only through its checks.
// Runs only behind the test:exec gate; anywhere else it prints the skip banner.
const test = require('node:test');
const assert = require('node:assert/strict');
const { realDockerOrSkip } = require('./helpers/execGate.cjs');

if (realDockerOrSkip()) {
  const { realWorld, docker, labelled, sleep, hardKill } = require('./helpers/execReal.cjs');
  const { jobEnds, versionSettles, produced, build, assemble, deploy, stop } = require('./helpers/recipeFlows.cjs');
  const loadTs = require('./load-ts.cjs');
  const { newId } = loadTs('src/main/nexus/db/ids.ts');
  const LONG = { timeout: 15 * 60_000 };
  const MIN = 60_000;
  const live = (x, jobId) => x.db.prepare("SELECT * FROM job_attempts WHERE job_id = ? AND state IN ('starting','running')").get(jobId);

  async function slowRepo(x, seconds, tag) {
    const pkg = JSON.parse(x.fixtureFile('node-test-app', 'package.json'));
    await x.useFixture('node-test-app', { 'package.json': JSON.stringify({ ...pkg, scripts: { build: `node -e "setTimeout(() => require('./build.js'), ${seconds * 1000})"` } }, null, 2),
      'src/handler.js': x.fixtureFile('node-test-app', 'src/handler.js').replace('hello from node-test-app', `hello (${tag})`) });
    return (await x.snapshot()).versionId;
  }
  const running = (x, jobId) => x.until(() => x.job(jobId).state === 'running' && !!live(x, jobId)?.container_id, 'the build runs', 3 * MIN);

  test('L13 the runner is killed mid-build -> restarted, the running container adopted -> the build completes and validates (one attempt)', LONG, async () => {
    const x = await realWorld();
    try {
      const repo = await slowRepo(x, 25, 'L13');
      const j = x.start('sde.build.run', { inputs: [{ versionId: repo, slot: 'repository' }] });
      await running(x, j.id);
      const before = x.handle.host.restarts();
      x.killRunner();
      await x.until(() => x.handle.host.restarts() > before && x.handle.host.state() === 'ready', 'the runner restarted', MIN);
      const ended = await jobEnds(x, j.id, 5 * MIN);
      assert.equal(ended.state, 'completed', `${ended.outcome} ${ended.error_json}`);
      assert.deepEqual(x.attemptsOf(j.id).map((a) => [a.n, a.state]), [[1, 'succeeded']], 'adopted, never retried');
      assert.ok(x.db.prepare("SELECT 1 FROM job_events WHERE job_id = ? AND type = 'recovery'").get(j.id), 'the adoption is recorded');
      const v = await versionSettles(x, produced(x, j.id, 'dist').id);
      assert.equal(v.status, 'candidate');
    } finally { await x.close(); }
  });

  test('L14 the runner is killed mid-deployment -> adopted, still healthy (probes resume); then stopped and cleaned up', LONG, async () => {
    const x = await realWorld();
    try {
      await x.useFixture('node-test-app');
      const repo = (await x.snapshot()).versionId;
      const b = await build(x, repo);
      const a = await assemble(x, b.version.id);
      const d = await deploy(x, a.version.id);
      assert.equal(d.deployment.status, 'healthy');
      const probes = JSON.parse(x.deploymentRow(d.deployment.id).health_json).length;
      x.killRunner();
      await x.until(() => x.handle.host.state() === 'ready' && JSON.parse(x.deploymentRow(d.deployment.id).health_json).length > probes + 1,
        'probes resume after the restart', 2 * MIN);
      assert.equal(x.deploymentRow(d.deployment.id).status, 'healthy');
      assert.equal(x.job(d.jobId).state, 'running');
      assert.equal(await x.httpGet(d.deployment.host_port, '/health'), 200);
      await stop(x, d.deployment.id, d.jobId);
    } finally { await x.close(); }
  });

  test('L15 the runner is killed and the container removed before it restarts -> the attempt is abandoned: retry_scheduled or interrupted, never completed', LONG, async () => {
    const x = await realWorld();
    try {
      const repo = await slowRepo(x, 300, 'L15');
      const j = x.start('sde.build.run', { inputs: [{ versionId: repo, slot: 'repository' }] });
      await running(x, j.id);
      const cid = live(x, j.id).container_id;
      x.killRunner();
      docker(['rm', '-f', cid]);
      await x.until(() => ['retry_scheduled', 'interrupted', 'failed'].includes(x.job(j.id).state), 'recovery decides', 3 * MIN);
      assert.ok(['retry_scheduled', 'interrupted'].includes(x.job(j.id).state), x.job(j.id).state);
      assert.equal(x.attemptsOf(j.id)[0].state, 'abandoned');
      assert.equal(produced(x, j.id, 'dist'), null, 'nothing was produced');
      if (x.job(j.id).state === 'retry_scheduled') x.exec.cancel(x.me, j.id);
    } finally { await x.close(); }
  });

  test('L16 main crashes mid-build: a new platform and boot on the same database adopts the running container; an old labelled orphan of a known attempt is removed; an unlabelled nexus-x container is untouched', LONG, async () => {
    const a = await realWorld();
    let b = null;
    const strangers = [];
    try {
      // A finished attempt of this database whose container lingers (an old boot's leftover), and a stranger's container.
      const repoFast = await slowRepo(a, 1, 'L16 first');
      const first = a.start('sde.build.run', { inputs: [{ versionId: repoFast, slot: 'repository' }] });
      await jobEnds(a, first.id, 5 * MIN);
      const oldAttempt = a.attemptsOf(first.id).pop();
      const imageId = JSON.parse(docker(['image', 'ls', '--no-trunc', '--filter', 'label=nexus.profile=sde-node', '--format', '{{json .ID}}']).stdout.split('\n')[0]);
      const orphan = docker(['create', '--label', `nexus.home=${a.home}`, '--label', `nexus.attempt=${oldAttempt.id}`, '--label', `nexus.job=${first.id}`,
        '--label', `nexus.boot=${newId(Date.now() - 3_600_000)}`, '--label', 'nexus.kind=tool', '--name', `nexus-orphan-${oldAttempt.id.toLowerCase()}`,
        '--network', 'none', '--entrypoint', 'sleep', imageId, '600']).stdout.trim();
      const stranger = docker(['create', '--name', `nexus-x-${Date.now()}`, '--network', 'none', '--entrypoint', 'sleep', imageId, '600']).stdout.trim();
      strangers.push(stranger);
      // The build that is running when main crashes.
      const repo = await slowRepo(a, 30, 'L16');
      const j = a.start('sde.build.run', { inputs: [{ versionId: repo, slot: 'repository' }] });
      await running(a, j.id);
      const cid = live(a, j.id).container_id;
      // The crash: the runner dies with main; main's wiring is dropped without the quit path (no shutdown reaches a runner).
      hardKill(a.runner());
      await a.handle.stop();
      a.store.close();
      // A new main on the same database and data home.
      b = await realWorld({ reopen: { file: a.file, userData: a.userData, roots: a.roots } });
      const ended = await jobEnds(b, j.id, 5 * MIN);
      assert.equal(ended.state, 'completed', `${ended.outcome} ${ended.error_json}`);
      assert.deepEqual(b.attemptsOf(j.id).map((x) => x.state), ['succeeded'], 'adopted by the new boot');
      assert.equal(JSON.parse(docker(['inspect', cid]).stdout || '[]').length, 0, 'released and removed after ingest');
      await b.until(() => docker(['inspect', orphan]).code !== 0, 'the old labelled orphan is removed', 2 * MIN);
      assert.equal(docker(['inspect', stranger]).code, 0, 'the unlabelled nexus-x container is untouched');
      assert.equal(labelled(b.home, { 'nexus.attempt': oldAttempt.id }).containers.length, 0);
    } finally {
      for (const s of strangers) docker(['rm', '-f', s]);
      if (b) await b.close();
      await a.close();
      await sleep(10);
    }
  });
}
