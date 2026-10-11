'use strict';
// B2a Task 12: the job lifecycle on REAL Docker (L1-L12, constraint 7): cancel and timeout, cleanup, abnormal termination,
// concurrency, Docker unavailable, resource exhaustion, a responsive main, and the user's own containers untouched. Main
// runs with the real execution wiring and the runner in a child process (test/helpers/execReal.cjs realWorld); the jobs
// are real builds of a fixture whose build script waits, so a container is reliably running when the test acts.
// Runs only behind the test:exec gate; anywhere else it prints the skip banner.
const test = require('node:test');
const assert = require('node:assert/strict');
const { realDockerOrSkip } = require('./helpers/execGate.cjs');

if (realDockerOrSkip()) {
  const { performance, monitorEventLoopDelay } = require('node:perf_hooks');
  const { realWorld, runnerHarness, docker, labelled, sleep, dockerSampler } = require('./helpers/execReal.cjs');
  const { jobEnds, terminal } = require('./helpers/recipeFlows.cjs');
  const loadTs = require('./load-ts.cjs');
  const { leaseGuard, DEFAULT_CAPS } = loadTs('src/main/nexus/exec/scheduler.ts');
  const { getRecipe } = loadTs('src/shared/nexus/recipes.ts');
  const LONG = { timeout: 15 * 60_000 };
  const MIN = 60_000;

  // L12: every container that is not this suite's, before anything runs.
  const others = () => docker(['ps', '-a', '--no-trunc', '--format', '{{.ID}} {{.State}} {{.Label "nexus.home"}}']).stdout.split(/\r?\n/)
    .filter(Boolean).map((l) => l.split(' ')).filter(([, , home]) => !home).map(([id, state]) => `${id} ${state}`).sort();
  const before = others();
  // Final review B6: when the suite started (Docker's event log is read from here by L12).
  const suiteStart = Math.floor(Date.now() / 1000);

  let w = null;
  const world = async () => { if (!w) w = await realWorld(); return w; };
  test.after(async () => { if (w) await w.close(); });
  const attemptIds = [];

  /** A snapshot of the node-test-app fixture whose build waits `seconds` first (or fails, with `fail`). */
  async function buildable(x, seconds, o = {}) {
    const pkg = JSON.parse(x.fixtureFile('node-test-app', 'package.json'));
    const build = o.fail ? 'node -e "process.exit(3)"' : `node -e "setTimeout(() => require('./build.js'), ${seconds * 1000})"`;
    await x.useFixture('node-test-app', { 'package.json': JSON.stringify({ ...pkg, scripts: { build } }, null, 2),
      'src/handler.js': x.fixtureFile('node-test-app', 'src/handler.js').replace('hello from node-test-app', `hello (${seconds}s${o.fail ? ', fails' : ''}, ${o.tag ?? ''})`) });
    return (await x.snapshot()).versionId;
  }
  const startBuild = (x, repo) => x.start('sde.build.run', { inputs: [{ versionId: repo, slot: 'repository' }] });
  const liveAttempt = (x, jobId) => x.db.prepare("SELECT * FROM job_attempts WHERE job_id = ? AND state IN ('starting','running')").get(jobId);
  const gone = (x, attemptId) => { const l = labelled(x.home, { 'nexus.attempt': attemptId }); return l.containers.length + l.networks.length + l.volumes.length === 0; };

  test('L1 cancel while queued or running (a 10-minute build) -> the job is cancelled and its container removed within 15 s; a cancel caught while leased (best effort) ends the same way', LONG, async () => {
    const x = await world();
    const repo = await buildable(x, 600, { tag: 'L1' });
    // Queued: cancelled before any lease.
    const q = startBuild(x, repo);
    assert.equal(x.exec.cancel(x.me, q.id).state, 'cancelled');
    // Running: cancelled while its container runs.
    const r = startBuild(x, repo);
    await x.until(() => x.job(r.id).state === 'running' && !!liveAttempt(x, r.id)?.container_id, 'the build runs', 3 * MIN);
    const a = liveAttempt(x, r.id); attemptIds.push(a.id);
    const t0 = Date.now();
    x.exec.cancel(x.me, r.id);
    await x.until(() => gone(x, a.id), 'the cancelled container is removed', 30_000);
    assert.ok(Date.now() - t0 <= 15_000, `removed in ${Date.now() - t0} ms`);
    assert.equal(x.job(r.id).state, 'cancelled');
    // Leased (best effort: caught between the lease and the provisioned report; else it is running, already covered).
    const l = startBuild(x, repo);
    await x.until(() => ['leased', 'running'].includes(x.job(l.id).state), 'leased', MIN);
    const caught = x.job(l.id).state;
    const la = liveAttempt(x, l.id);
    x.exec.cancel(x.me, l.id);
    await jobEnds(x, l.id, MIN);
    assert.equal(x.job(l.id).state, 'cancelled', `cancelled from ${caught}`);
    if (la) { attemptIds.push(la.id); await x.until(() => gone(x, la.id), 'removed', 30_000); }
  });

  test('L2 wall clock 3 s -> timed_out, the container removed', LONG, async () => {
    const x = await world();
    const repo = await buildable(x, 600, { tag: 'L2' });
    const j = startBuild(x, repo);
    // The 3 s wall clock is set once the container RUNS (B2a stabilization): it counts from the lease, and on a loaded
    // machine provisioning alone can outlast 3 s; a wall clock that runs out while the job is still `leased` ends it
    // `failed` with outcome timed_out by design (the job state table has no leased -> timed_out). This test is about a
    // running container's timeout.
    await x.until(() => x.job(j.id).state === 'running' && !!x.attemptsOf(j.id).pop()?.container_id, 'the build runs', 3 * MIN);
    // A test-only wall clock of 3 s for this job (main's timeout reads the job's limits).
    const lim = JSON.parse(x.job(j.id).limits_json);
    x.db.prepare('UPDATE jobs SET limits_json = ? WHERE id = ?').run(JSON.stringify({ ...lim, wallClockMs: 3000 }), j.id);
    const ended = await jobEnds(x, j.id, 3 * MIN);
    assert.equal(ended.state, 'timed_out', `${ended.outcome} ${ended.error_json}`);
    const a = x.attemptsOf(j.id).pop(); attemptIds.push(a.id);
    await x.until(() => gone(x, a.id), 'the timed-out container is removed', 60_000);
  });

  test('L3 the runner is gone: the container ends itself at its wall clock plus 10 s (the Nexus entry\'s own timeout)', LONG, async () => {
    const h = await runnerHarness();
    try {
      const plan = h.plan('sde.build.node', ['sleep', '600']);
      plan.container.env.NEXUS_WALL_SECONDS = '5';
      h.start(plan);
      const prov = await h.provisioned(plan);
      await h.core.shutdown();          // tool containers keep running when the runner goes away
      const t0 = Date.now();
      let state = null;
      for (;;) {
        const r = JSON.parse(docker(['inspect', prov.containerId]).stdout || '[]')[0];
        state = r ? r.State : null;
        if (!state || state.Status === 'exited' || Date.now() - t0 > 40_000) break;
        await sleep(500);
      }
      assert.equal(state && state.Status, 'exited', 'it ended itself');
      assert.ok(Date.now() - t0 <= 5_000 + 10_000 + 10_000, 'within the wall clock plus the kill grace');
      assert.ok([124, 137, 143].includes(state.ExitCode), `timeout's exit (${state.ExitCode})`);
    } finally { await h.close(); }
  });

  test('L4 after success, failure, cancel and timeout: no container, volume or network with the attempt label', LONG, async () => {
    const x = await world();
    // Verification: `buildable` points the project at a NEW fixture repository (useFixture), so the second one is made only
    // after the first job has ended; made earlier, the queued first job's commit is no longer in the project's folder and
    // the runner rightly refuses it (bad_plan: "the commit is not in this repository").
    const ok = startBuild(x, await buildable(x, 1, { tag: 'L4 ok' }));
    assert.equal((await jobEnds(x, ok.id, 5 * MIN)).state, 'completed');
    const bad = startBuild(x, await buildable(x, 1, { fail: true, tag: 'L4 bad' }));
    assert.equal((await jobEnds(x, bad.id, 5 * MIN)).state, 'failed');
    for (const j of [ok, bad]) attemptIds.push(x.attemptsOf(j.id).pop().id);
    for (const id of attemptIds) await x.until(() => gone(x, id), `attempt ${id} cleaned up`, 60_000);
  });

  test('L5 docker kill from outside -> failed with exit 137 and oomKilled false (recorded as nonzero_exit, never oom; the job error says "exit 137 (SIGKILL), OOMKilled false")', LONG, async () => {
    const x = await world();
    const j = startBuild(x, await buildable(x, 600, { tag: 'L5' }));
    await x.until(() => !!liveAttempt(x, j.id)?.container_id && x.job(j.id).state === 'running', 'running', 3 * MIN);
    const a = liveAttempt(x, j.id);
    docker(['kill', a.container_id]);
    const ended = await jobEnds(x, j.id, 3 * MIN);
    const done = x.attemptsOf(j.id).pop();
    assert.equal(ended.state, 'failed');
    assert.equal(done.exit_code, 137); assert.equal(done.oom_killed, 0);
    assert.notEqual(done.outcome, 'oom');
    assert.equal(done.outcome, 'nonzero_exit');
    // Fix round 1, item 15: the reason stays observable in the job error (the signal and the OOM flag).
    assert.equal(JSON.parse(ended.error_json).message, 'exit 137 (SIGKILL), OOMKilled false');
  });

  test('L6 docker rm -f mid-run -> container_vanished', LONG, async () => {
    const x = await world();
    const j = startBuild(x, await buildable(x, 600, { tag: 'L6' }));
    await x.until(() => !!liveAttempt(x, j.id)?.container_id && x.job(j.id).state === 'running', 'running', 3 * MIN);
    docker(['rm', '-f', liveAttempt(x, j.id).container_id]);
    await jobEnds(x, j.id, 3 * MIN);
    assert.equal(x.attemptsOf(j.id).pop().outcome, 'container_vanished');
  });

  test('L7 five jobs, a cap of three: never more than 3 RUNNING labelled containers (sampled every 200 ms by a separate process) nor live attempt rows, all five complete, attempts and leases consistent; L11 main stays responsive', LONG, async () => {
    const x = await world();
    const repo = await buildable(x, 15, { tag: 'L7' });
    // Fix round 1, item 4: Docker is sampled by its own process (no synchronous docker call ever runs on this loop), and
    // it counts only RUNNING containers (exited ones still listed by `ps -a` are not live). Main's own count is the live
    // attempt rows. The lag is measured on this process's loop (main's) only while nothing but main's own work and the
    // sampler's messages run here.
    const sampler = dockerSampler(x.home, { 'nexus.kind': 'tool' }, 200);
    await sampler.ready();
    const jobs = [];
    for (let i = 0; i < 5; i++) jobs.push(x.start('sde.build.run', { inputs: [{ versionId: repo, slot: 'repository' }] }));
    const ids = jobs.map((j) => j.id);
    const liveRows = () => x.db.prepare(`SELECT COUNT(*) AS n FROM job_attempts WHERE state IN ('starting','running') AND job_id IN (${ids.map(() => '?').join(',')})`).get(...ids).n;
    const lag = monitorEventLoopDelay({ resolution: 10 }); lag.enable();
    let peakRows = 0; const calls = [];
    while (!jobs.every((j) => terminal(x.job(j.id).state))) {
      peakRows = Math.max(peakRows, liveRows());
      const t0 = performance.now(); x.exec.list(x.me, { projectId: x.projectId }); x.exec.get(x.me, jobs[0].id); calls.push(performance.now() - t0);
      await sleep(200);
    }
    lag.disable();
    await sampler.stop();
    const seen = sampler.samples.filter((m) => m.running >= 0);
    assert.ok(seen.length >= 5, `the sampler read Docker (${seen.length} samples)`);
    const peak = Math.max(...seen.map((m) => m.running));
    assert.ok(peak > 0, 'the sampler saw the builds run');
    assert.ok(peak <= DEFAULT_CAPS.jobContainers, `peak ${peak} running labelled containers`);
    assert.ok(peakRows <= DEFAULT_CAPS.jobContainers, `peak ${peakRows} live attempt rows`);
    for (const j of jobs) {
      assert.equal(x.job(j.id).state, 'completed', j.id);
      const atts = x.attemptsOf(j.id);
      assert.deepEqual(atts.map((a) => a.n), [1], 'one attempt each');
      assert.equal(atts[0].state, 'succeeded');
    }
    // Final review B6: the 99th percentile under 100 ms (main stays responsive), and no single stall of half a second or more
    // (a one-off GC or OS hiccup of a loaded test machine is not a responsiveness failure; a blocked loop still is).
    assert.ok(lag.percentile(99) / 1e6 < 100, `L11: event-loop lag p99 ${(lag.percentile(99) / 1e6).toFixed(1)} ms`);
    assert.ok(lag.max / 1e6 < 500, `L11: event-loop lag max ${(lag.max / 1e6).toFixed(1)} ms`);
    assert.ok(Math.max(...calls) < 50, `L11: exec.list + exec.get max ${Math.max(...calls).toFixed(1)} ms`);
  });

  test('L8 Docker unavailable (a pipe that does not exist): the probe says stopped, a job waits waiting:docker, the action is unavailable with its setup reason', LONG, async () => {
    const x = await realWorld({ dockerDown: true, env: { DOCKER_HOST: `npipe:////./pipe/nexus_no_docker_${process.pid}_${Date.now()}` } });
    try {
      assert.notEqual(x.exec.health().docker.state, 'running');
      await x.useFixture('node-test-app');
      const repo = (await x.snapshot()).versionId;
      const j = x.start('sde.build.run', { inputs: [{ versionId: repo, slot: 'repository' }] });
      await x.until(() => x.job(j.id).phase === 'waiting:docker', 'waiting:docker', MIN);
      assert.equal(x.job(j.id).state, 'queued');
      const s = x.exec.setupAvailability({ actionId: 'sde.build.run' });
      assert.equal(s.available, false); assert.match(s.reason, /^setup:docker_(stopped|missing)$/);
    } finally { await x.close(); }
  });

  test('L9 resource exhaustion: the scheduler keeps a job over the memory budget waiting:memory; a 4 MiB memory limit (below Docker\'s minimum) fails docker create -> infra_error docker_resources, nothing leaked', LONG, async () => {
    const x0 = await world();
    const probeMem = x0.exec.health().docker.memoryBytes;
    assert.ok(probeMem > 0, 'Docker reports its memory');
    const big = { ...getRecipe('sde.build.node'), limits: { ...getRecipe('sde.build.node').limits, memoryMb: Math.ceil(probeMem / 2 ** 20) } };
    const cache = { probe: { docker: 'running', memoryBytes: probeMem, gpu: { detected: false, usableInContainers: false } },
      images: [{ profile: 'sde-node', present: true, digestMatches: true, imageId: `sha256:${'1'.repeat(64)}` }], freeBytes: 100 * 2 ** 30, at: Date.now() };
    assert.equal(leaseGuard({ recipe: big, profile: 'sde-node', memoryMb: big.limits.memoryMb }, true, cache, { jobContainers: 0, serviceContainers: 0, reservedMemoryMb: 0 }, DEFAULT_CAPS), 'waiting:memory');
    const x = await realWorld({ env: { NEXUS_TEST_CREATE_FAULT: 'memory-4m' } });
    try {
      await x.useFixture('node-test-app');
      const j = x.start('sde.build.run', { inputs: [{ versionId: (await x.snapshot()).versionId, slot: 'repository' }] });
      const ended = await jobEnds(x, j.id, 3 * MIN);
      assert.deepEqual([ended.state, ended.outcome], ['failed', 'infra_error']);
      assert.equal(JSON.parse(x.attemptsOf(j.id).pop().error_json).code, 'docker_resources');
      await x.until(() => gone(x, x.attemptsOf(j.id).pop().id), 'nothing leaked', 60_000);
    } finally { await x.close(); }
  });

  test('L10 the disk floor: free space below the lease floor -> no lease, the job waits waiting:disk', LONG, async () => {
    const x = await realWorld({ env: { NEXUS_TEST_FREE_BYTES: String(2 ** 30) } });
    try {
      await x.useFixture('node-test-app');
      const j = x.start('sde.build.run', { inputs: [{ versionId: (await x.snapshot()).versionId, slot: 'repository' }] });
      await x.until(() => x.job(j.id).phase === 'waiting:disk', 'waiting:disk', MIN);
      assert.equal(x.attemptsOf(j.id).length, 0, 'no attempt was leased');
    } finally { await x.close(); }
  });

  test('L12 the user\'s own containers: Nexus never stopped, killed or removed a container that is not its own (every one still exists, and Docker logged no stop, kill or destroy of it during the suite)', LONG, async () => {
    if (w) { await w.close(); w = null; }
    // Final review B6: a user's container may exit on its own while the suite runs; what Nexus must never do is stop or
    // remove one. So: every container of `before` still exists, and Docker's event log since the suite started holds no
    // stop, kill or destroy of any of them.
    const now = others().map((x) => x.split(' ')[0]);
    const ids = before.map((x) => x.split(' ')[0]);
    for (const id of ids) assert.ok(now.includes(id), `${id.slice(0, 12)} still exists`);
    if (ids.length > 0) {
      const ev = docker(['events', '--since', String(suiteStart), '--until', String(Math.floor(Date.now() / 1000) + 1), '--filter', 'type=container',
        '--filter', 'event=stop', '--filter', 'event=kill', '--filter', 'event=destroy', '--format', '{{.Actor.ID}} {{.Action}}']);
      assert.equal(ev.code, 0, ev.stderr);
      const hit = ev.stdout.split(/\r?\n/).filter(Boolean).filter((l) => ids.includes(l.split(' ')[0]));
      assert.deepEqual(hit, [], 'no stop, kill or destroy of a container that is not Nexus\'s');
    }
  });
}
