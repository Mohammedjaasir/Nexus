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

const spec = { name: 'nexus-01J', profile: 'sde-node', argv: ['node', '--version'], env: {},
  labels: { 'nexus.job': 'J', 'nexus.attempt': 'A', 'nexus.boot': 'B', 'nexus.project': 'p' },
  mounts: [{ kind: 'out', hostPath: 'C:/x/out', containerPath: '/out', readOnly: false }],
  network: { mode: 'none' }, limits: { cpus: 2, memoryMb: 2048, pids: 512, wallClockMs: 60000, outputMaxBytes: 1 << 20, tmpfsMb: 512 },
  readOnlyRootfs: true, capDrop: ['ALL'], noNewPrivileges: true };
const good = () => ({ Config: { User: '10001:10001', Labels: { ...spec.labels } },
  HostConfig: { NanoCpus: 2e9, Memory: 2048 * 2 ** 20, MemorySwap: 2048 * 2 ** 20, PidsLimit: 512, NetworkMode: 'none',
    ReadonlyRootfs: true, CapDrop: ['ALL'], CapAdd: null, Privileged: false, SecurityOpt: ['no-new-privileges'],
    Tmpfs: { '/tmp': 'rw,noexec,nosuid,size=512m,uid=10001', '/home/nexus': 'rw,nosuid,size=256m,uid=10001' },
    PortBindings: {}, Devices: [] },
  Mounts: [{ Destination: '/out', RW: true, Type: 'bind' }], NetworkSettings: { Networks: { none: {} } } });

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
  ['seccomp unconfined', (i) => { i.HostConfig.SecurityOpt.push('seccomp=unconfined'); }, /weakens/],
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

test('PF4 networks: egress maps to the per-job bridge, service to its internal network; the forwarder may publish only on 127.0.0.1', () => {
  const egress = { ...spec, network: { mode: 'egress-approved', approvalId: 'X', purpose: 'deps' } };
  const i = good(); i.HostConfig.NetworkMode = 'nexus-egress-J'; i.NetworkSettings.Networks = { 'nexus-egress-J': {} };
  assert.deepEqual(comparePreflight(egress, i).problems, []);
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
  const low = evaluateGate(probe, 18 * 10 ** 9);
  assert.equal(low.gate, 'below_required');
  assert.deepEqual(low.problems.find((p) => p.id === 'disk_low'), { id: 'disk_low', freeBytes: 18e9, requiredBytes: REQUIRED_FREE_BYTES });
  assert.equal(evaluateGate(probe, 35 * GIB).gate, 'below_recommended');
  assert.equal(evaluateGate(probe, 41 * GIB).gate, 'ok');
  assert.equal(evaluateGate({ ...probe, docker: 'stopped' }, 41 * GIB).problems[0].id, 'docker_stopped');
  assert.equal(evaluateGate({ ...probe, memoryBytes: 2 * GIB }, 41 * GIB).problems[0].id, 'docker_memory_low');
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
  assert.equal(evaluateGate(probe, 30e9).gate, 'below_required', '30 GB (decimal) is below 30 GiB');
});
test('G4 Docker missing is the only Docker problem; nothing about memory, CPUs or images is guessed', () => {
  const r = evaluateGate({ docker: 'missing', gpu: { detected: false, usableInContainers: false } }, 50 * GIB,
    [{ profile: 'sde-node', present: false, digestMatches: false }]);
  assert.equal(r.gate, 'below_required'); assert.deepEqual(r.problems, [{ id: 'docker_missing' }]);
  assert.deepEqual(evaluateGate({ gpu: { detected: false, usableInContainers: false } }, 50 * GIB).problems, [{ id: 'docker_missing' }]);
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
  assert.deepEqual(evaluateGate({ ...probe, cpus: 1 }, 50 * GIB).problems, [{ id: 'docker_cpus_low', cpus: 1, requiredCpus: 2 }]);
  assert.deepEqual(evaluateGate({ ...probe, memoryBytes: 2 * GIB }, 50 * GIB).problems,
    [{ id: 'docker_memory_low', memoryBytes: 2 * GIB, requiredBytes: 4 * GIB }]);
  const unknown = evaluateGate({ docker: 'running', gpu: { detected: false, usableInContainers: false } }, 50 * GIB);
  assert.deepEqual(unknown.problems.map((p) => p.id), ['docker_memory_low', 'docker_cpus_low']);
  assert.equal(unknown.problems[0].memoryBytes, null); assert.equal(unknown.problems[1].cpus, null);
});
test('G7 an unreadable free-space figure is disk_low with freeBytes null, never a pass', () => {
  for (const bad of [NaN, -1, Infinity, undefined, '50000000000']) {
    const r = evaluateGate(probe, bad);
    assert.equal(r.gate, 'below_required');
    assert.deepEqual(r.problems[0], { id: 'disk_low', freeBytes: null, requiredBytes: REQUIRED_FREE_BYTES });
  }
});
test('G8 boundaries: exactly 30 GiB meets the requirement, exactly 40 GiB is ok; problems come in a fixed order; inputs are not mutated', () => {
  assert.equal(evaluateGate(probe, 30 * GIB).gate, 'below_recommended');
  assert.equal(evaluateGate(probe, 30 * GIB - 1).gate, 'below_required');
  assert.equal(evaluateGate(probe, 40 * GIB).gate, 'ok');
  assert.equal(evaluateGate(probe, 40 * GIB - 1).gate, 'below_recommended');
  const p = { ...probe, cpus: 1, memoryBytes: 1 }; const before = JSON.stringify(p);
  const r = evaluateGate(p, 1, [{ profile: 'sde-node', present: false, digestMatches: false }]);
  assert.deepEqual(r.problems.map((x) => x.id), ['disk_low', 'docker_memory_low', 'docker_cpus_low', 'image_missing']);
  assert.equal(JSON.stringify(p), before);
  assert.deepEqual(evaluateGate(probe, 50 * GIB).problems, []);
});

// ----- the runner protocol parser -----
const SHA = 'a'.repeat(64);
const exit = { code: 0, oomKilled: false, finishedAt: 1700000000000 };
const SAMPLES = {
  'ready': { op: 'ready', bootId: ULID },
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
test('RP2 every RunnerToMain op has a sample that parses, and its exact key set is enforced', () => {
  assert.deepEqual([...proto.RUNNER_OPS].sort(), Object.keys(SAMPLES).sort());
  for (const [op, sample] of Object.entries(SAMPLES)) {
    assert.deepEqual(parseRunnerMessage(clone(sample)), sample, op);
    assert.equal(parseRunnerMessage({ ...clone(sample), extra: 1 }), null, `${op} with an extra key`);
    for (const k of Object.keys(sample)) {
      if (k === 'op') continue;
      const m = clone(sample); delete m[k];
      const optional = { 'attempt.provisioned': ['containerId', 'imageDigest', 'preflight'], 'attempt.heartbeat': ['container'],
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
