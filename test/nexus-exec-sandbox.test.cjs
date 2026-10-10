'use strict';
// B2a Task 12: the sandbox on REAL Docker (K1-K11, constraint 7), deterministic by construction: kernel values read inside
// the container (cgroup files, /proc), fixed sizes against fixed limits, and Docker's own inspect. A RunnerCore in this
// process (test/helpers/execReal.cjs runnerHarness) takes plans from main's own plan builder (the real recipe specs:
// limits, mounts, network, user, flags) with a probe command run by the Nexus entry in place of the recipe argv.
// Runs only behind the test:exec gate; anywhere else it prints the skip banner.
// B2a stabilization (constraint 5): K8 now asserts the Nexus egress policy (it used to document that an approved install
// reached the host); K12 proves the allowed path through the real proxy image with a TEST-ONLY pinned entry to a local test
// server. Nothing here reaches the real internet: the real registry path (registry.npmjs.org, pypi.org) is NOT exercised.
const test = require('node:test');
const assert = require('node:assert/strict');
const { realDockerOrSkip } = require('./helpers/execGate.cjs');

if (realDockerOrSkip()) {
  const { runnerHarness, realWorld, docker, dockerJson, hostServer, lanAddress, httpGet, sleep } = require('./helpers/execReal.cjs');
  const http = require('node:http');
  const fsx = require('node:fs');
  const pathx = require('node:path');
  const fspx = require('node:fs/promises');
  const { DockerDriver } = require('./load-ts.cjs')('src/runner/sandbox/dockerDriver.ts');
  const { dockerCli } = require('./load-ts.cjs')('src/runner/sandbox/dockerCli.ts');
  const { parseEgressLine } = require('./load-ts.cjs')('src/shared/nexus/egressPolicy.ts');
  // A script fixture is stored as `<name>.tpl` (like the app fixtures execFakeWorld copies) so a plain `node --test test/`
  // never runs it as a test file; it is read here by its real name.
  const fixture = (name) => { const p = pathx.join(__dirname, 'fixtures', 'exec', name); return fsx.readFileSync(fsx.existsSync(p) ? p : `${p}.tpl`, 'utf8'); };
  /** A loopback HTTP server on the host that counts every connection and request it receives (K8: it must receive none). */
  async function countingServer() {
    let hits = 0;
    const server = http.createServer((_req, res) => { hits++; res.writeHead(200); res.end('host-ok'); });
    server.on('connection', () => { hits++; });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    return { port: server.address().port, hits: () => hits, close: () => new Promise((r) => server.close(r)) };
  }
  /** `name: result` lines of a probe's output. */
  const resultOf = (out) => (k) => (new RegExp(`^${k.replace(/[.[\]]/g, (c) => `\\${c}`)}: (.*)$`, 'm').exec(out) ?? [])[1] ?? 'missing';
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

  test('K7 network none: TCP to the host test server fails, DNS fails; only lo has an address or a route, and every other interface is down', LONG, async () => {
    const srv = await hostServer();
    try {
      // Final review B2: Docker Desktop kernels show their fallback tunnel devices (tunl0, sit0, ip6tnl0, ...) in EVERY
      // namespace, so the test no longer asks that lo be the only device: it asks that lo be the only one with an address
      // or a route, and that every other device be down (nothing can carry a packet out).
      const script = 'for i in /sys/class/net/*; do echo "if ${i##*/} $(cat "$i/operstate")"; done; '
        + 'while read -r a _; do [ "$a" = Iface ] || echo "route4 $a"; done < /proc/net/route; '
        + '[ -r /proc/net/ipv6_route ] && while read -r _ _ _ _ _ _ _ _ _ i; do echo "route6 $i"; done < /proc/net/ipv6_route; '
        + `node -e "const n=require('net'),d=require('dns'),o=require('os');`
        + `for(const [k,v] of Object.entries(o.networkInterfaces()))if(v&&v.length)console.log('addr '+k);`
        + `d.lookup('host.docker.internal',(e)=>{console.log('dns '+(e?'fail':'ok'));`
        + `const s=n.connect({host:'host.docker.internal',port:${srv.port},timeout:3000},()=>{console.log('connect ok');process.exit(0)});`
        + `s.on('error',()=>{console.log('connect fail');process.exit(0)});s.on('timeout',()=>{console.log('connect fail');process.exit(0)})})"`;
      const r = await probe(script);
      const lines = r.out.split('\n').map((l) => l.trim());
      const ifs = lines.filter((l) => l.startsWith('if ')).map((l) => l.split(' ').slice(1));
      assert.ok(ifs.some(([n]) => n === 'lo'), r.out);
      for (const [n, state] of ifs) if (n !== 'lo') assert.equal(state, 'down', `${n} is down (${r.out})`);
      assert.deepEqual([...new Set(lines.filter((l) => l.startsWith('addr ')).map((l) => l.slice(5)))], ['lo'], 'only lo has an address');
      for (const l of lines.filter((x) => /^route[46] /.test(x))) assert.equal(l.split(' ')[1], 'lo', `only lo has a route: ${l}`);
      assert.match(r.out, /^dns fail$/m);
      assert.match(r.out, /^connect fail$/m);
      assert.equal(r.prov.preflight.observed.networkMode, 'none');
    } finally { await srv.close(); }
  });

  test('K8 egress-approved (the plan carries the approval this attempt consumed): the install has NO route out; through the Nexus proxy the host, its 127.0.0.1 server, metadata and private ranges are refused, and the host server receives nothing', LONG, async () => {
    // B2a stabilization (constraint 5), an intended product change: before this round K8 documented that an approved
    // install reached the host's 127.0.0.1 through host.docker.internal (no allow-list). It now asserts the policy.
    const srv = await countingServer();
    const h = await harness();
    try {
      const js = fixture('egress-k8-probe.js').replace(/__PORT__/g, String(srv.port));
      const plan = h.start(h.plan('sde.deps.node', ['node', '-e', js], { approval: '01K7A0APPROVA1F0RK8TEST000' }));
      const prov = await h.provisioned(plan);
      assert.equal(prov.preflight.ok, true, prov.preflight.problems.join('; '));
      // The topology Docker really built: the install on the INTERNAL network only; the proxy on it (alias) and the outbound bridge.
      const inNet = `nexus-egress-in-${plan.jobId}`; const outNet = `nexus-egress-out-${plan.jobId}`;
      assert.equal(prov.preflight.observed.networkMode, inNet);
      assert.equal(dockerJson(['network', 'inspect', inNet])[0].Internal, true, 'the install network has no route out');
      assert.equal(dockerJson(['network', 'inspect', outNet])[0].Internal, false);
      const inst = dockerJson(['inspect', prov.containerId])[0];
      assert.deepEqual(Object.keys(inst.NetworkSettings.Networks), [inNet], 'no direct egress network on the install container');
      const pxId = docker(['ps', '-aq', '--no-trunc', '--filter', `label=nexus.attempt=${plan.attemptId}`, '--filter', 'label=nexus.kind=egress-proxy']).stdout.trim();
      const px = dockerJson(['inspect', pxId])[0];
      assert.deepEqual(Object.keys(px.NetworkSettings.Networks).sort(), [inNet, outNet].sort());
      assert.ok(px.NetworkSettings.Networks[inNet].Aliases.includes('nexus-egress-proxy'));
      assert.deepEqual(px.Config.Cmd, ['node', '/opt/nexus/egress-proxy.js']);
      assert.ok(px.Config.Env.includes('NEXUS_EGRESS_ALLOW=registry.npmjs.org:443'));
      const exited = await h.exited(plan, 180_000);
      const out = h.output(plan);
      assert.equal(exited.exit.code, 0, out.slice(-800));
      const line = resultOf(out);
      for (const k of ['direct host.docker.internal', 'direct host address', 'direct metadata', 'direct ten', 'direct lan', 'direct elsewhere']) {
        assert.match(line(k), /^fail /, `${k}: ${line(k)}`);
      }
      const want = { 'proxy host.docker.internal': 'host_not_allowed', 'proxy host address': 'ip_literal', 'proxy metadata': 'ip_literal', 'proxy ten': 'ip_literal',
        'proxy lan': 'ip_literal', 'proxy loopback v6': 'ip_literal', 'proxy localhost': 'host_not_allowed', 'proxy plain http': 'plain_http',
        'proxy registry port 80': 'port_not_allowed' };
      for (const [k, reason] of Object.entries(want)) assert.equal(line(k), `HTTP/1.1 403 Forbidden | ${reason}`, k);
      assert.match(line('dns host.docker.internal'), /^fail /, 'the internal network does not even resolve the host');
      assert.equal(srv.hits(), 0, 'the host\'s 127.0.0.1 server received nothing');
      // Each proxy decision is a job event from the runner (and a line in the attempt log), without a path or query.
      const ev = h.of('attempt.event', plan.attemptId).filter((m) => m.event.t === 'egress').map((m) => m.event);
      assert.equal(ev.length, Object.keys(want).length, JSON.stringify(ev));
      assert.ok(ev.every((e) => e.decision === 'refused'));
      assert.ok(h.nexusLines(plan).some((l) => /^egress refused host\.docker\.internal:\d+ \(host_not_allowed\)$/.test(l)), h.nexusLines(plan).join('\n'));
      assert.doesNotMatch(JSON.stringify(ev) + h.nexusLines(plan).join('\n'), /q=1|\/x\?/);
      h.release(plan);
    } finally { await srv.close(); }
  });

  test('K12 the allowed path through the REAL proxy image: a TEST-ONLY pinned entry reaches a local test server; a name resolving to a private address, a wrong TLS name and a direct connect are refused; the runner refuses the pinned entry in a plan', LONG, async () => {
    // What is and is not proven: the proxy and the topology on real Docker, with a test server on the job's outbound
    // bridge. The REAL registries (registry.npmjs.org, pypi.org, files.pythonhosted.org) are NOT contacted: the real
    // registry path is not exercised by any automated test.
    const h = await harness();
    const drv = new DockerDriver(dockerCli(fspx), { now: Date.now });
    const plan = h.plan('sde.deps.node', ['true'], { approval: '01K7A0APPROVA1F0RK12TEST00' });
    const { internal, outbound } = plan.egressProxy.networks;
    const made = [];
    try {
      await drv.createNetwork(internal, { ...plan.resourceLabels }, { internal: true });
      await drv.createNetwork(outbound, { ...plan.resourceLabels }, { internal: false });
      // The test server: the pinned sde-node image, on the OUTBOUND bridge only, also answering (through Docker's own DNS)
      // to a name the proxy would resolve to its private address.
      const serverJs = "require('net').createServer((s)=>s.once('data',(d)=>s.end('registry-ok '+d.length))).listen(8443)";
      const run = docker(['run', '-d', '--label', `nexus.home=${h.home}`, '--label', `nexus.attempt=${plan.attemptId}`, '--label', `nexus.job=${plan.jobId}`,
        '--network', outbound, '--network-alias', 'nexus-k12-private.invalid', '--name', `nexus-${plan.attemptId.toLowerCase()}-k12reg`, '--user', '10001:10001',
        '--read-only', '--cap-drop', 'ALL', '--pull', 'never', '--entrypoint', 'node', h.imageOf('sde-node'), '-e', serverJs]);
      assert.equal(run.code, 0, run.stderr);
      const serverId = run.stdout.trim(); made.push(serverId);
      const ip = dockerJson(['inspect', serverId])[0].NetworkSettings.Networks[outbound].IPAddress;
      assert.match(ip, /^\d+\.\d+\.\d+\.\d+$/);
      // The proxy exactly as planned except its allow-list: a pinned test entry, and a name Docker resolves to a private address.
      const proxySpec = { ...plan.egressProxy.container, env: { ...plan.egressProxy.container.env,
        NEXUS_EGRESS_ALLOW: `nexus-test-registry.invalid:8443=${ip},nexus-k12-private.invalid:8443` } };
      const { containerId: pid } = await drv.create(proxySpec); made.push(pid);
      const pre = await drv.preflight(pid, proxySpec);
      assert.equal(pre.ok, true, pre.problems.join('; '));
      await drv.start(pid);
      const t0 = Date.now();
      while (!/nexus-egress-ready/.test(docker(['logs', pid]).stdout)) { if (Date.now() - t0 > 30_000) assert.fail('the proxy did not listen'); await sleep(250); }
      // The install container as planned (internal network only, the proxy settings), running the client program.
      for (const d of ['in', 'out']) fsx.mkdirSync(pathx.join(plan.workDir, d), { recursive: true });
      await drv.createVolume(`nexus-ws-${plan.attemptId}`, { ...plan.resourceLabels });
      const inst = { ...plan.container, argv: ['node', '-e', fixture('egress-k12-client.js').replace(/__IP__/g, ip)] };
      const { containerId: cid } = await drv.create(inst); made.push(cid);
      const pre2 = await drv.preflight(cid, inst);
      assert.equal(pre2.ok, true, pre2.problems.join('; '));
      await drv.start(cid);
      const exit = await drv.wait(cid, new AbortController().signal);
      const out = docker(['logs', cid]).stdout;
      assert.equal(exit.code, 0, out);
      const line = resultOf(out);
      assert.match(line('allowed'), /^HTTP\/1\.1 200 Connection Established \/ registry-ok \d+$/, out);
      assert.equal(line('private'), 'HTTP/1.1 200 Connection Established', 'the tunnel closed: the name resolved to a private address');
      assert.equal(line('sni'), 'HTTP/1.1 200 Connection Established', 'the tunnel closed: the TLS name was not the CONNECT host');
      assert.match(line('bypass address'), /^fail /, 'no direct route to the outbound bridge');
      assert.match(line('bypass name'), /^fail /);
      const decisions = docker(['logs', pid]).stdout.split('\n').map((l) => parseEgressLine(l.trim())).filter(Boolean);
      assert.deepEqual(decisions.map((d) => [d.decision, d.host, d.reason]), [['allowed', 'nexus-test-registry.invalid', 'allowed'],
        ['refused', 'nexus-k12-private.invalid', 'private_address'], ['refused', 'nexus-test-registry.invalid', 'sni_mismatch']]);
      // The same test-only entry in a plan is refused by the runner before Docker is asked for anything.
      const bad = h.plan('sde.deps.node', ['true'], { approval: '01K7A0APPROVA1F0RK12TEST01' });
      bad.egressProxy.container.env.NEXUS_EGRESS_ALLOW = `registry.npmjs.org:443=${ip}`;
      h.start(bad);
      await h.until(() => h.of('attempt.refused', bad.attemptId).length > 0, 'refused', 60_000);
      assert.equal(h.of('attempt.refused', bad.attemptId)[0].reason, 'network_not_approved');
      assert.equal(docker(['ps', '-aq', '--filter', `label=nexus.attempt=${bad.attemptId}`]).stdout.trim(), '', 'nothing created');
    } finally {
      for (const id of made) docker(['rm', '-f', id]);
      docker(['volume', 'rm', '-f', `nexus-ws-${plan.attemptId}`]);
      docker(['network', 'rm', internal, outbound]);
    }
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
