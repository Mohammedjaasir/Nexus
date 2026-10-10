'use strict';
// B2a Task 12: the sandbox on REAL Docker (K1-K11, constraint 7), deterministic by construction: kernel values read inside
// the container (cgroup files, /proc), fixed sizes against fixed limits, and Docker's own inspect. A RunnerCore in this
// process (test/helpers/execReal.cjs runnerHarness) takes plans from main's own plan builder (the real recipe specs:
// limits, mounts, network, user, flags) with a probe command run by the Nexus entry in place of the recipe argv.
// Runs only behind the test:exec gate; anywhere else it prints the skip banner.
const test = require('node:test');
const assert = require('node:assert/strict');
const { realDockerOrSkip } = require('./helpers/execGate.cjs');

if (realDockerOrSkip()) {
  const { runnerHarness, realWorld, docker, dockerJson, hostServer, lanAddress, httpGet, sleep } = require('./helpers/execReal.cjs');
  const { jobEnds } = require('./helpers/recipeFlows.cjs');
  const { faultyCreate } = require('./helpers/createFaults.cjs');
  const { exitFailure } = require('./load-ts.cjs')('src/main/nexus/exec/recovery.ts');
  const { getRecipe } = require('./load-ts.cjs')('src/shared/nexus/recipes.ts');
  const { fixtureRepo } = require('./helpers/execFakeWorld.cjs');
  const LONG = { timeout: 10 * 60_000 };
  let t = null;
  const harness = async () => { if (!t) t = await runnerHarness(); return t; };
  test.after(async () => { if (t) await t.close(); });

  /** Runs `script` with `sh -c` in a real sde.test.node container; returns the exit report and the container's output. */
  async function probe(script, x = {}) {
    const h = x.harness ?? await harness();
    const plan = h.start(h.plan(x.recipe ?? 'sde.test.node', ['sh', '-c', script], x));
    const prov = await h.provisioned(plan);
    const exited = await h.exited(plan, x.ms ?? 180_000);
    const out = h.output(plan);
    h.release(plan);
    return { plan, prov, exited, out };
  }

  test('K1 CPU limit: inspect NanoCpus = 2e9 and cpu.max inside the container = "200000 100000"', LONG, async () => {
    const r = await probe('cat /sys/fs/cgroup/cpu.max');
    assert.equal(r.prov.preflight.ok, true);
    assert.equal(r.prov.preflight.observed.nanoCpus, 2e9);
    assert.match(r.out, /^200000 100000$/m);
    assert.equal(r.exited.exit.code, 0);
  });

  test('K2 memory limit: inspect equals (no swap); allocating 2 x the limit is OOM-killed and main fails it `oom` (main\'s own job outcome, not only the pure rule)', LONG, async () => {
    const r = await probe("node -e \"const a=[];for(;;)a.push(Buffer.alloc(64*1024*1024,1))\"");
    assert.equal(r.prov.preflight.observed.memory, 2048 * 2 ** 20);
    assert.equal(r.prov.preflight.observed.memorySwap, 2048 * 2 ** 20);
    assert.equal(r.exited.exit.oomKilled, true, 'the kernel killed it for memory');
    assert.equal(exitFailure(getRecipe('sde.build.node'), r.exited.exit, [], [], null).outcome, 'oom');
    // Fix round 1, item 13: the same allocation as a real job through main (the wiring, the runner child, ingest): the
    // job and its attempt end `failed` / `oom` in main's own rows.
    const x = await realWorld();
    try {
      const pkg = JSON.parse(x.fixtureFile('node-test-app', 'package.json'));
      await x.useFixture('node-test-app', { 'package.json': JSON.stringify({ ...pkg, scripts: { build: 'node -e "const a=[];for(;;)a.push(Buffer.alloc(64*1024*1024,1))"' } }, null, 2),
        'src/handler.js': x.fixtureFile('node-test-app', 'src/handler.js').replace('hello from node-test-app', 'hello (K2 oom)') });
      const repo = (await x.snapshot()).versionId;
      const j = x.start('sde.build.run', { inputs: [{ versionId: repo, slot: 'repository' }] });
      const ended = await jobEnds(x, j.id, 5 * 60_000);
      assert.deepEqual([ended.state, ended.outcome], ['failed', 'oom'], `main's job outcome (${ended.error_json})`);
      const att = x.attemptsOf(j.id).pop();
      assert.deepEqual([att.state, att.outcome, att.oom_killed], ['failed', 'oom', 1], 'the attempt row records the OOM kill');
      assert.match(JSON.parse(ended.error_json).message, /OOMKilled true/);
    } finally { await x.close(); }
  });

  test('K3 process limit: pids.max = 512; spawning until EAGAIN reports refusals and the container survives', LONG, async () => {
    const script = "cat /sys/fs/cgroup/pids.max; node -e \"const {spawn}=require('child_process');let ok=0,refused=0,n=0;"
      + "const next=()=>{if(n++>=700){console.log('spawns ok='+ok+' refused='+refused);process.exit(0)}"
      + "const c=spawn('sleep',['60']);c.on('error',e=>{if(e.code==='EAGAIN')refused++;next()});c.on('spawn',()=>{ok++;next()})};next()\"";
    const r = await probe(script);
    assert.match(r.out, /^512$/m);
    const m = /spawns ok=(\d+) refused=(\d+)/.exec(r.out);
    assert.ok(m, r.out.slice(-500));
    assert.ok(Number(m[2]) > 0, 'some spawns were refused by the pids limit');
    assert.ok(Number(m[1]) < 512, 'never more processes than the limit');
    assert.equal(r.exited.exit.code, 0, 'the container survived and exited on its own');
  });

  test('K4 disk: /usr is read-only (EROFS); 600 MiB into the 512 MiB /tmp is ENOSPC; 2 x outputMaxBytes into /out is output_too_large; past the workspace guard is workspace_too_large', LONG, async () => {
    const ro = await probe('touch /usr/nexus-probe 2>&1; echo "rc=$?"; dd if=/dev/zero of=/tmp/fill bs=1M count=600 2>&1; echo done');
    assert.match(ro.out, /Read-only file system/);
    assert.match(ro.out, /No space left on device/);
    const out = await probe('dd if=/dev/zero of=/out/big bs=1M count=140 2>/dev/null; sleep 60');
    assert.equal(out.exited.outputError, 'output_too_large', 'the size guard killed it (64 MiB output limit)');
    const ws = await runnerHarness({ limits: { workspaceMaxBytes: 32 * 2 ** 20 } });
    try {
      const big = await probe('dd if=/dev/zero of=/workspace/big bs=1M count=64 2>/dev/null; sleep 60', { harness: ws });
      assert.equal(big.exited.outputError, 'workspace_too_large', 'the workspace guard killed it');
    } finally { await ws.close(); }
  });

  test('K5 privileges: id -u = 10001, CapEff 0, NoNewPrivs 1', LONG, async () => {
    const r = await probe('id -u; grep -E "^(CapEff|NoNewPrivs):" /proc/self/status');
    assert.match(r.out, /^10001$/m);
    assert.match(r.out, /^CapEff:\s+0000000000000000$/m);
    assert.match(r.out, /^NoNewPrivs:\s+1$/m);
  });

  test('K6 mounts: /proc/mounts holds exactly the spec\'s mounts (plus the runtime\'s own) and no docker.sock', LONG, async () => {
    const r = await probe('cat /proc/mounts');
    assert.doesNotMatch(r.out, /docker\.sock/);
    const points = r.out.split('\n').map((l) => l.split(' ')[1]).filter(Boolean);
    const runtime = (p) => p === '/' || /^\/(proc|sys|dev)(\/|$)/.test(p) || ['/etc/resolv.conf', '/etc/hostname', '/etc/hosts'].includes(p);
    assert.deepEqual([...new Set(points.filter((p) => !runtime(p)))].sort(), ['/home/nexus', '/in', '/out', '/tmp', '/workspace']);
  });

  test('K7 network none: TCP to the host test server fails, DNS fails, only lo exists', LONG, async () => {
    const srv = await hostServer();
    try {
      const script = `ls /sys/class/net; node -e "const n=require('net'),d=require('dns');`
        + `d.lookup('host.docker.internal',(e)=>{console.log('dns '+(e?'fail':'ok'));`
        + `const s=n.connect({host:'host.docker.internal',port:${srv.port},timeout:3000},()=>{console.log('connect ok');process.exit(0)});`
        + `s.on('error',()=>{console.log('connect fail');process.exit(0)});s.on('timeout',()=>{console.log('connect fail');process.exit(0)})})"`;
      const r = await probe(script);
      assert.deepEqual(r.out.split('\n').filter((l) => /^[a-z0-9]+$/.test(l) && !['dns', 'connect'].includes(l)), ['lo']);
      assert.match(r.out, /^dns fail$/m);
      assert.match(r.out, /^connect fail$/m);
      assert.equal(r.prov.preflight.observed.networkMode, 'none');
    } finally { await srv.close(); }
  });

  test('K8 egress-approved (the plan carries the approval this attempt consumed): the same connect reaches the host server', LONG, async () => {
    const srv = await hostServer();
    try {
      const script = `node -e "const h=require('http');h.get({host:'host.docker.internal',port:${srv.port},path:'/',timeout:5000},(r)=>{let b='';`
        + `r.on('data',(c)=>b+=c);r.on('end',()=>{console.log('egress '+b);process.exit(0)})}).on('error',(e)=>{console.log('egress fail '+e.code);process.exit(0)})"`;
      const r = await probe(script, { recipe: 'sde.deps.node', approval: '01K7A0APPROVA1F0RK8TEST000' });
      assert.match(r.prov.preflight.observed.networkMode, /^nexus-egress-/);
      assert.match(r.out, /^egress host-ok$/m, r.out.slice(-300));
    } finally { await srv.close(); }
  });

  test('K9 dev deployment: the app cannot reach the host; the forwarder binds 127.0.0.1 only; the host reaches the app through it, the LAN address does not', LONG, async () => {
    const h = await harness();
    const srv = await hostServer();
    try {
      const repo = fixtureRepo('node-test-app');
      const recipe = getRecipe('sde.preview.start');
      const appProfile = h.images.profiles.find((p) => p.id === 'sde-node');
      const fwd = h.images.profiles.find((p) => p.id === 'nexus-fwd');
      const { buildPlan } = require('./load-ts.cjs')('src/main/nexus/exec/planBuilder.ts');
      const { newId } = require('./load-ts.cjs')('src/main/nexus/db/ids.ts');
      const jobId = newId(Date.now()); const attemptId = newId(Date.now());
      const appScript = `const n=require('net');n.connect({host:'host.docker.internal',port:${srv.port},timeout:3000},()=>console.log('app reached host')).on('error',()=>console.log('app cannot reach host')).on('timeout',function(){this.destroy();console.log('app cannot reach host')});require('./src/server.js')`;
      const plan = buildPlan({ job: { id: jobId, projectId: 'p-exec-k' }, attempt: { id: attemptId, n: 1 }, bootId: h.bootId, recipe, profile: appProfile,
        imageId: h.imageOf('sde-node'), dataHomeRoot: h.root, workRel: `work/${jobId}/1`, logRel: `logs/jobs/${jobId}/1.log`, repoPath: repo.dir,
        inputs: [{ versionId: 'V', slot: 'build', contentHash: 'x', storage: { kind: 'tree' }, metadata: { commit: repo.commit } }],
        service: { deploymentId: newId(Date.now()), manifest: { profile: 'sde-node', run: ['node', '-e', appScript], port: 3000, healthPath: '/health' },
          forwarder: fwd, forwarderImageId: h.imageOf('nexus-fwd'), files: [], lifetimeMs: 10 * 60_000 } });
      h.start(plan);
      const prov = await h.provisioned(plan);
      assert.equal(prov.preflight.ok, true, JSON.stringify(prov.preflight.problems));
      const port = prov.hostPort;
      await h.until(() => h.of('service.health', plan.attemptId).some((m) => m.status === 200), 'a 200 probe', 120_000);
      assert.equal(await httpGet('127.0.0.1', port, '/health'), 200, 'the host reaches the app through the forwarder');
      const lan = lanAddress();
      if (lan) assert.equal(await httpGet(lan, port, '/health', 3_000), null, 'the LAN address does not answer');
      const fwdId = docker(['ps', '-q', '--no-trunc', '--filter', `label=nexus.attempt=${plan.attemptId}`, '--filter', 'label=nexus.kind=forwarder']).stdout.trim();
      const rec = dockerJson(['inspect', fwdId])[0];
      const bindings = Object.values(rec.HostConfig.PortBindings).flat();
      assert.deepEqual(bindings.map((b) => b.HostIp), ['127.0.0.1'], 'bound to 127.0.0.1 only');
      await sleep(4000);
      assert.match(h.output(plan), /app cannot reach host/);
      assert.doesNotMatch(h.output(plan), /app reached host/);
      h.release(plan);
    } finally { await srv.close(); }
  });

  test('K10 fault injection: --network bridge (and, separately, no --pids-limit) added to create -> preflight refuses, the container is removed and never started', LONG, async () => {
    for (const fault of ['network-bridge', 'drop-pids']) {
      const starts = [];
      const h = await runnerHarness({ wrap: (cli) => ({ binary: () => cli.binary(), run: (argv, o) => { if (argv[0] === 'start') starts.push(argv[1]); return cli.run(faultyCreate(argv, fault), o); } }) });
      try {
        const plan = h.start(h.plan('sde.test.node', ['sleep', '30']));
        const prov = await h.provisioned(plan);
        assert.equal(prov.preflight.ok, false, fault);
        assert.ok(prov.preflight.problems.some((p) => (fault === 'network-bridge' ? /network/ : /pids/i).test(p)), `${fault}: ${prov.preflight.problems.join('; ')}`);
        assert.deepEqual(starts, [], `${fault}: never started`);
        await h.until(() => docker(['inspect', prov.containerId]).code !== 0, 'the refused container is removed', 30_000);
        h.release(plan);
      } finally { await h.close(); }
    }
  });

  test('K11 an injected docker.sock mount -> preflight refuses, nothing starts', LONG, async () => {
    const starts = [];
    const h = await runnerHarness({ wrap: (cli) => ({ binary: () => cli.binary(), run: (argv, o) => { if (argv[0] === 'start') starts.push(argv[1]); return cli.run(faultyCreate(argv, 'docker-sock'), o); } }) });
    try {
      const plan = h.start(h.plan('sde.test.node', ['sleep', '30']));
      const prov = await h.provisioned(plan);
      assert.equal(prov.preflight.ok, false);
      assert.ok(prov.preflight.problems.some((p) => /docker\.sock|unexpected mount|exposes/.test(p)), prov.preflight.problems.join('; '));
      assert.deepEqual(starts, []);
      h.release(plan);
    } finally { await h.close(); }
  });
}
