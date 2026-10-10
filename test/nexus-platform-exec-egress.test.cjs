'use strict';
// B2a stabilization, workstream C (user constraint 5: "any network-enabled operation goes through an explicit
// Nexus-controlled policy and approval path; no unrestricted escape"). The egress policy without Docker:
//  EG1-EG4  the plan and the container specs main builds (internal network only for the install, the proxy's two networks
//           and alias, the proxy settings, the allow-list per recipe, refusals) and the exact `docker create` argv;
//  EG5-EG6  the preflight comparator over the new topology (endpoints, aliases, DNS and host entries, pinned settings);
//  EG7      the runner's own topology check (a test-only pinned entry or any other host never reaches a real run);
//  EG8-EG13 the proxy's allow / deny logic as pure functions (addresses v4 and v6, host names, ports, CONNECT versus plain
//           HTTP, malformed requests, DNS answers with a private address, the TLS name);
//  EG14     the proxy server end to end on loopback (a pinned test-only entry; fake DNS answers; nothing leaves this machine);
//  EG15     the decision events over the runner protocol.
// No Docker, no database, no network beyond 127.0.0.1. The real-Docker proofs are K8 and K12-K14 (test/nexus-exec-sandbox.test.cjs).
const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const tls = require('node:tls');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const ROOT = path.resolve(__dirname, '..');
const proxy = require(path.join(ROOT, 'infra', 'images', 'sde-node', 'egress-proxy.js'));
const policy = loadTs('src/shared/nexus/egressPolicy.ts');
const { buildPlan, sandboxRecord, ALLOWED_ENV_NAMES } = loadTs('src/main/nexus/exec/planBuilder.ts');
const { getRecipe } = loadTs('src/shared/nexus/recipes.ts');
const { newId } = loadTs('src/main/nexus/db/ids.ts');
const { comparePreflight, expectedEndpoints, expectedNetworkName } = loadTs('src/shared/nexus/preflightCheck.ts');
const { createArgv } = loadTs('src/runner/sandbox/dockerDriver.ts');
const { egressTopologyProblem, classifyProxyLine, LineSplitter } = loadTs('src/runner/egress.ts');
const { parseRunnerMessage, EGRESS_EVENT_MAX } = loadTs('src/shared/nexus/runnerProtocol.ts');
const { inspectFor } = require('./helpers/fakeSandboxDriver.cjs');

const NOW = 1_780_000_000_000;
const IMAGE = 'sha256:' + '1'.repeat(64);
const PY_IMAGE = 'sha256:' + '2'.repeat(64);
const NODE = { id: 'sde-node', image: { repository: 'nexus/sde-node', digest: `sha256:${'7'.repeat(64)}`, source: 'built' }, user: { uid: 10001, gid: 10001 },
  entrypoint: ['/opt/nexus/nexus-entry'], imageEnv: ['NODE_VERSION', 'PATH', 'YARN_VERSION'] };
const PY = { id: 'sde-python', image: { repository: 'nexus/sde-python', digest: `sha256:${'8'.repeat(64)}`, source: 'built' }, user: { uid: 10001, gid: 10001 },
  entrypoint: ['/opt/nexus/nexus-entry'], imageEnv: ['LANG', 'PATH', 'PYTHON_VERSION'] };
const HOME = process.platform === 'win32' ? 'C:\\nexus-test-home' : '/nexus-test-home';

function plan(recipeId = 'sde.deps.node', o = {}) {
  const jobId = newId(NOW); const attemptId = newId(NOW + 1);
  const profile = recipeId === 'sde.deps.python' ? PY : NODE;
  return buildPlan({ job: { id: jobId, projectId: 'p-egress' }, attempt: { id: attemptId, n: 1 }, bootId: newId(NOW + 2), recipe: getRecipe(recipeId),
    profile, imageId: profile === PY ? PY_IMAGE : IMAGE, dataHomeRoot: HOME, workRel: `work/${jobId}/1`, logRel: `logs/jobs/${jobId}/1.log`,
    inputs: [], repoPath: null,
    approval: o.noApproval ? null : { id: 'AP1', job_id: jobId, status: 'approved', consumed_at: NOW, consumed_by_job_id: jobId, consumed_by_attempt_n: 1 },
    egressProxy: 'egressProxy' in o ? o.egressProxy : { profile: NODE, imageId: IMAGE } });
}
const refusal = (fn) => { try { fn(); } catch (e) { return e.detail?.reason ?? e.message; } return null; };
const flag = (argv, f) => argv.filter((_, i) => argv[i - 1] === f);

// ---------------------------------------------------------------- the plan and the specs

test('EG1 an approved npm install: the install is on the job\'s INTERNAL egress network only, with the proxy settings; the plan carries the proxy', () => {
  const p = plan('sde.deps.node');
  const c = p.container;
  assert.deepEqual(c.network, { mode: 'egress-approved', approvalId: 'AP1', purpose: 'deps' });
  assert.equal(expectedNetworkName(c), `nexus-egress-in-${p.jobId}`);
  assert.deepEqual(expectedEndpoints(c), [`nexus-egress-in-${p.jobId}`], 'no direct egress network on the install container');
  const url = 'http://nexus-egress-proxy:3128';
  for (const k of ['HTTPS_PROXY', 'HTTP_PROXY', 'https_proxy', 'http_proxy', 'npm_config_proxy', 'npm_config_https_proxy']) assert.equal(c.env[k], url, k);
  assert.equal(c.env.PIP_PROXY, undefined);
  for (const k of Object.keys(c.env)) assert.ok(ALLOWED_ENV_NAMES.includes(k), k);
  // The proxy: the pinned sde-node image, the fixed command, the recipe's allow-list, no mount, its two networks.
  const px = p.egressProxy;
  assert.deepEqual(px.networks, { internal: `nexus-egress-in-${p.jobId}`, outbound: `nexus-egress-out-${p.jobId}` });
  const s = px.container;
  assert.equal(s.profile, 'sde-node'); assert.deepEqual(s.image, { ref: IMAGE, id: IMAGE });
  assert.deepEqual(s.entrypoint, ['/opt/nexus/nexus-entry']); assert.deepEqual(s.argv, ['node', '/opt/nexus/egress-proxy.js']);
  assert.deepEqual(s.env, { HOME: '/home/nexus', NEXUS_WALL_SECONDS: String(2 * 15 * 60), NEXUS_EGRESS_ALLOW: 'registry.npmjs.org:443' });
  assert.deepEqual(s.mounts, []); assert.equal(s.publish, undefined);
  assert.deepEqual(s.network, { mode: 'egress-proxy', approvalId: 'AP1' });
  assert.deepEqual(expectedEndpoints(s), [`nexus-egress-in-${p.jobId}`, `nexus-egress-out-${p.jobId}`]);
  assert.equal(s.labels['nexus.kind'], 'egress-proxy'); assert.equal(s.labels['nexus.attempt'], p.attemptId);
  assert.deepEqual([s.limits.cpus, s.limits.memoryMb, s.limits.pids, s.limits.tmpfsMb], [0.5, 256, 512, 16]);
  assert.deepEqual([s.readOnlyRootfs, s.capDrop, s.noNewPrivileges], [true, ['ALL'], true]);
  // What actually executed is recorded: the proxy, its allow-list and both networks.
  const rec = sandboxRecord(p);
  assert.deepEqual(rec.egressProxy.allow, ['registry.npmjs.org:443']);
  assert.deepEqual(rec.egressProxy.networks, px.networks);
  assert.deepEqual(rec.egressProxy.argv, ['node', '/opt/nexus/egress-proxy.js']);
  assert.equal(egressTopologyProblem(p), null);
});

test('EG2 an approved pip install: pypi.org and files.pythonhosted.org on 443 only; PIP_PROXY; the proxy still runs in the sde-node image', () => {
  const p = plan('sde.deps.python');
  assert.equal(p.container.env.PIP_PROXY, 'http://nexus-egress-proxy:3128');
  assert.equal(p.container.env.npm_config_proxy, undefined);
  assert.equal(p.egressProxy.container.env.NEXUS_EGRESS_ALLOW, 'pypi.org:443,files.pythonhosted.org:443');
  assert.equal(p.egressProxy.container.profile, 'sde-node');
  assert.deepEqual(policy.egressAllowFor('sde.deps.python').map((e) => `${e.host}:${e.port}`), ['pypi.org:443', 'files.pythonhosted.org:443']);
  assert.equal(egressTopologyProblem(p), null);
});

test('EG3 refusals: no approval -> network_not_approved; no proxy image -> image_missing; a recipe without egress never gets a proxy', () => {
  assert.equal(refusal(() => plan('sde.deps.node', { noApproval: true })), 'network_not_approved');
  assert.equal(refusal(() => plan('sde.deps.node', { egressProxy: null })), 'image_missing');
  assert.equal(refusal(() => plan('sde.deps.node', { egressProxy: { profile: NODE, imageId: null } })), 'image_missing');
  assert.equal(refusal(() => plan('sde.deps.node', { egressProxy: { profile: PY, imageId: IMAGE } })), 'image_missing');
  const t = plan('sde.test.node');
  assert.deepEqual(t.container.network, { mode: 'none' });
  assert.equal(t.egressProxy, undefined);
  assert.equal(t.container.env.HTTPS_PROXY, undefined);
  for (const id of ['sde.test.node', 'sde.build.node', 'sde.test.discover', 'repo.snapshot']) assert.equal(policy.egressAllowFor(id), null, id);
});

test('EG4 docker create argv: the install joins ONE network (internal) with no alias; the proxy joins internal (alias nexus-egress-proxy) then outbound', () => {
  const p = plan('sde.deps.node');
  const a = createArgv(p.container);
  assert.deepEqual(flag(a, '--network'), [`nexus-egress-in-${p.jobId}`]);
  assert.deepEqual(flag(a, '--network-alias'), []);
  assert.ok(!a.includes('-p'));
  const b = createArgv(p.egressProxy.container);
  assert.deepEqual(flag(b, '--network'), [`nexus-egress-in-${p.jobId}`, `nexus-egress-out-${p.jobId}`]);
  assert.deepEqual(flag(b, '--network-alias'), ['nexus-egress-proxy']);
  assert.ok(b.indexOf('--network-alias') === b.indexOf('--network') + 2, 'the alias belongs to the first (internal) network');
  assert.ok(!b.includes('-p'));
  assert.deepEqual(flag(b, '--env').sort(), ['HOME=/home/nexus', 'NEXUS_EGRESS_ALLOW=registry.npmjs.org:443', 'NEXUS_WALL_SECONDS=1800']);
  assert.throws(() => createArgv(p.egressProxy.container, { alias: 'app' }), /own alias/);
});

// ---------------------------------------------------------------- preflight

test('EG5 preflight passes the planned topology (inspect shaped as Docker 29.7.2 reports it) and refuses every drift', () => {
  const p = plan('sde.deps.node');
  const inst = p.container; const px = p.egressProxy.container;
  assert.deepEqual(comparePreflight(inst, inspectFor(inst, 'c'.repeat(64), inst.name)).problems, []);
  assert.deepEqual(comparePreflight(px, inspectFor(px, 'd'.repeat(64), px.name)).problems, []);
  const probs = (spec, mut) => { const r = inspectFor(spec, 'e'.repeat(64), spec.name); mut(r[0]); return comparePreflight(spec, r).problems.join('; '); };
  const out = `nexus-egress-out-${p.jobId}`; const inn = `nexus-egress-in-${p.jobId}`;
  // The install on the outbound bridge too (a direct route out), or on it instead of the internal network.
  assert.match(probs(inst, (r) => { r.NetworkSettings.Networks[out] = { Aliases: null }; }), /endpoint nexus-egress-out-.* is attached, expected only nexus-egress-in-/);
  assert.match(probs(inst, (r) => { r.HostConfig.NetworkMode = 'bridge'; }), /network is bridge, expected nexus-egress-in-/);
  // Nothing may impersonate the proxy: the install with the proxy's alias.
  assert.match(probs(inst, (r) => { r.NetworkSettings.Networks[inn].Aliases = ['nexus-egress-proxy']; }), /aliases are \["nexus-egress-proxy"\], expected \[\]/);
  // The proxy without its alias, with it on the outbound bridge, without the outbound bridge.
  assert.match(probs(px, (r) => { r.NetworkSettings.Networks[inn].Aliases = null; }), /aliases are null, expected \["nexus-egress-proxy"\]/);
  assert.match(probs(px, (r) => { r.NetworkSettings.Networks[out].Aliases = ['nexus-egress-proxy']; }), /nexus-egress-out-.* aliases/);
  assert.match(probs(px, (r) => { delete r.NetworkSettings.Networks[out]; }), /endpoint nexus-egress-out-.* is not attached/);
  // The proxy's settings are pinned: another allow-list, another command, another image.
  assert.match(probs(px, (r) => { r.Config.Env = r.Config.Env.map((e) => (e.startsWith('NEXUS_EGRESS_ALLOW=') ? 'NEXUS_EGRESS_ALLOW=evil.example:443' : e)); }),
    /env NEXUS_EGRESS_ALLOW does not have the spec's value/);
  assert.match(probs(px, (r) => { r.Config.Cmd = ['node', '-e', 'x']; }), /command is/);
  assert.match(probs(px, (r) => { r.Image = 'sha256:' + '9'.repeat(64); }), /image is/);
});

test('EG6 preflight refuses added host entries, DNS servers, links and fixed endpoint addresses on any container', () => {
  const p = plan('sde.deps.node');
  const inst = p.container; const inn = `nexus-egress-in-${p.jobId}`;
  const probs = (mut) => { const r = inspectFor(inst, 'e'.repeat(64), inst.name); mut(r[0]); return comparePreflight(inst, r).problems.join('; '); };
  assert.match(probs((r) => { r.HostConfig.ExtraHosts = ['registry.npmjs.org:10.0.0.5']; }), /ExtraHosts is .* expected none/);
  assert.match(probs((r) => { r.HostConfig.Dns = ['10.0.0.53']; }), /Dns is .* expected none/);
  assert.match(probs((r) => { r.HostConfig.DnsSearch = ['corp']; }), /DnsSearch is/);
  assert.match(probs((r) => { r.HostConfig.Links = ['/x:/y']; }), /Links is/);
  assert.match(probs((r) => { r.NetworkSettings.Networks[inn].IPAMConfig = { IPv4Address: '172.30.0.9' }; }), /IPAMConfig/);
  assert.deepEqual(probs(() => {}), '');
});

// ---------------------------------------------------------------- the runner's own check

test('EG7 the runner refuses an egress plan whose proxy is not exactly the Nexus proxy with the recipe\'s allow-list (no pinned or extra entry reaches a real run)', () => {
  const base = () => plan('sde.deps.node');
  const bad = [
    ['a pinned test entry', (p) => { p.egressProxy.container.env.NEXUS_EGRESS_ALLOW = 'registry.npmjs.org:443=10.0.0.5'; }],
    ['an extra host', (p) => { p.egressProxy.container.env.NEXUS_EGRESS_ALLOW = 'registry.npmjs.org:443,evil.example:443'; }],
    ['another port', (p) => { p.egressProxy.container.env.NEXUS_EGRESS_ALLOW = 'registry.npmjs.org:80'; }],
    ['another command', (p) => { p.egressProxy.container.argv = ['node', '-e', 'require("net")']; }],
    ['another profile', (p) => { p.egressProxy.container.profile = 'sde-python'; }],
    ['a mount', (p) => { p.egressProxy.container.mounts = [{ kind: 'out', hostPath: 'C:\\x', containerPath: '/out', readOnly: false }]; }],
    ['a published port', (p) => { p.egressProxy.container.publish = { hostIp: '127.0.0.1', hostPort: 50000, containerPort: 3128 }; }],
    ['another job\'s networks', (p) => { p.egressProxy.networks.outbound = 'nexus-egress-out-OTHER'; }],
    ['another approval', (p) => { p.egressProxy.container.network = { mode: 'egress-proxy', approvalId: 'AP2' }; }],
    ['no proxy', (p) => { delete p.egressProxy; }],
    ['the install without the proxy settings', (p) => { delete p.container.env.HTTPS_PROXY; }],
    ['the install pointed elsewhere', (p) => { p.container.env.npm_config_https_proxy = 'http://10.0.0.5:3128'; }]
  ];
  for (const [what, mut] of bad) { const p = base(); mut(p); assert.ok(egressTopologyProblem(p), what); }
  const t = plan('sde.test.node'); t.egressProxy = base().egressProxy;
  assert.match(egressTopologyProblem(t), /without egress carries an egress proxy/);
  assert.equal(egressTopologyProblem(base()), null);
});

// ---------------------------------------------------------------- the proxy, pure

test('EG8 addresses: loopback, private, link-local, CGNAT, metadata, multicast, reserved and documentation ranges are refused; public addresses pass', () => {
  const refused = ['127.0.0.1', '127.255.255.254', '0.0.0.0', '10.0.0.1', '10.255.255.255', '172.16.0.1', '172.31.255.255', '192.168.0.1',
    '192.168.65.254', '169.254.0.1', '169.254.169.254', '169.254.170.2', '100.64.0.1', '100.127.255.255', '100.100.100.200', '168.63.129.16',
    '224.0.0.1', '239.255.255.250', '240.0.0.1', '255.255.255.255', '192.0.2.1', '198.51.100.1', '203.0.113.1', '198.18.0.1', '192.0.0.8'];
  for (const a of refused) assert.ok(proxy.addressBlocked(a), `${a} is refused`);
  assert.equal(proxy.addressBlocked('169.254.169.254'), 'metadata');
  assert.equal(proxy.addressBlocked('192.168.65.254'), 'private', 'Docker Desktop\'s host.docker.internal');
  for (const a of ['8.8.8.8', '1.1.1.1', '104.16.0.35', '151.101.0.223', '172.32.0.1', '172.15.255.255', '100.128.0.1', '11.0.0.1']) {
    assert.equal(proxy.addressBlocked(a), null, `${a} is public`);
  }
});

test('EG9 IPv6: ::1, ::, link-local, unique-local (and AWS fd00:ec2::254), multicast, v4-mapped and NAT64 / 6to4 of private IPv4 are refused', () => {
  const refused = ['::1', '::', '0:0:0:0:0:0:0:1', 'fe80::1', 'febf::1', 'fc00::1', 'fdff::1', 'fd00:ec2::254', 'ff02::1', '::ffff:127.0.0.1',
    '::ffff:8.8.8.8', '::ffff:7f00:1', '::127.0.0.1', '64:ff9b::10.0.0.1', '64:ff9b::a9fe:a9fe', '64:ff9b:1::1', '2002:c0a8:0101::1', '2002:7f00:1::',
    '2001:db8::1', '2001::1', '100::1', 'fec0::1', '3fff::1'];
  for (const a of refused) assert.ok(proxy.addressBlocked(a), `${a} is refused`);
  assert.equal(proxy.addressBlocked('fd00:ec2::254'), 'metadata');
  for (const a of ['2606:4700::6810:84e5', '2a04:4e42::223', '64:ff9b::8.8.8.8', '2002:808:808::1', '2001:4860:4860::8888']) {
    assert.equal(proxy.addressBlocked(a), null, `${a} is public`);
  }
  assert.equal(proxy.addressBlocked('fe80::1%eth0'), 'unparsable', 'a zone id is refused');
  assert.equal(proxy.addressBlocked('not-an-ip'), 'unparsable');
});

test('EG10 requests: only CONNECT host:port HTTP/1.x; plain HTTP is refused and logged by host only; malformed lines are refused', () => {
  const head = (l) => proxy.parseHead(Buffer.from(`${l}\r\nHost: x\r\n\r\n`, 'latin1'));
  assert.deepEqual(head('CONNECT registry.npmjs.org:443 HTTP/1.1'), { kind: 'connect', host: 'registry.npmjs.org', port: 443, literal: false });
  assert.deepEqual(head('CONNECT [::1]:443 HTTP/1.1'), { kind: 'connect', host: '[::1]', port: 443, literal: true });
  assert.deepEqual(head('CONNECT 169.254.169.254:80 HTTP/1.0'), { kind: 'connect', host: '169.254.169.254', port: 80, literal: true });
  const plain = head('GET http://registry.npmjs.org/pkg?token=s3cr3t HTTP/1.1');
  assert.deepEqual(plain, { kind: 'plain', method: 'GET', host: 'registry.npmjs.org' });
  assert.doesNotMatch(proxy.decisionLine({ reason: 'plain_http', host: plain.host, port: 0 }), /s3cr3t|pkg|\?/);
  assert.deepEqual(head('POST /x HTTP/1.1'), { kind: 'plain', method: 'POST', host: '' });
  for (const l of ['connect registry.npmjs.org:443 HTTP/1.1', 'CONNECT registry.npmjs.org:443', 'CONNECT  registry.npmjs.org:443 HTTP/1.1',
    'CONNECT registry.npmjs.org HTTP/1.1', 'CONNECT registry.npmjs.org:0 HTTP/1.1', 'CONNECT registry.npmjs.org:65536 HTTP/1.1',
    'CONNECT registry.npmjs.org:0443 HTTP/1.1', 'CONNECT user@registry.npmjs.org:443 HTTP/1.1', 'CONNECT registry.npmjs.org:443 HTTP/2.0',
    'CONNECT registry.npmjs.org:443/x HTTP/1.1', '']) {
    assert.equal(head(l).kind, 'malformed', JSON.stringify(l));
  }
  assert.equal(proxy.parseHead(Buffer.from('no line end')).kind, 'malformed');
});

test('EG11 the allow-list: exact names (case and one trailing dot folded), exact ports; IP literals, suffix and prefix tricks and host.docker.internal are refused', () => {
  const allow = proxy.parseAllow('registry.npmjs.org:443');
  const decide = (l) => proxy.decideRequest(proxy.parseHead(Buffer.from(`${l}\r\n\r\n`)), allow);
  assert.deepEqual(decide('CONNECT registry.npmjs.org:443 HTTP/1.1'), { ok: true, entry: { host: 'registry.npmjs.org', port: 443, pin: null } });
  assert.equal(decide('CONNECT REGISTRY.NPMJS.ORG.:443 HTTP/1.1').ok, true);
  const reason = (l) => decide(l).reason;
  assert.equal(reason('CONNECT registry.npmjs.org:80 HTTP/1.1'), 'port_not_allowed');
  assert.equal(reason('CONNECT registry.npmjs.org:22 HTTP/1.1'), 'port_not_allowed');
  for (const h of ['registry.npmjs.org.evil.example', 'evil-registry.npmjs.org', 'xregistry.npmjs.org', 'npmjs.org', 'host.docker.internal',
    'localhost', 'gateway.docker.internal', 'metadata.google.internal', 'registry.npmjs.org..']) {
    assert.equal(reason(`CONNECT ${h}:443 HTTP/1.1`), 'host_not_allowed', h);
  }
  for (const h of ['127.0.0.1', '10.0.0.5', '192.168.65.254', '169.254.169.254', '[::1]', '[fe80::1]', '[::ffff:127.0.0.1]']) {
    assert.equal(reason(`CONNECT ${h}:443 HTTP/1.1`), 'ip_literal', h);
  }
  assert.equal(reason('GET http://registry.npmjs.org/ HTTP/1.1'), 'plain_http');
  assert.equal(reason('BREW coffee HTTP/1.1'), 'plain_http');
  assert.equal(proxy.decideRequest({ kind: 'malformed' }, allow).reason, 'malformed');
  // Numeric host forms getaddrinfo would read as addresses are never names.
  for (const h of ['2130706433', '0x7f000001', '0x7f.1', '127.1']) assert.equal(proxy.normalizeHost(h), null, h);
  // The allow-list parser is strict; a pin is the test-only form.
  assert.deepEqual(proxy.parseAllow('pypi.org:443,files.pythonhosted.org:443').map((e) => e.host), ['pypi.org', 'files.pythonhosted.org']);
  assert.deepEqual(proxy.parseAllow('nexus-test.registry.invalid:8443=172.30.0.5'), [{ host: 'nexus-test.registry.invalid', port: 8443, pin: '172.30.0.5' }]);
  for (const bad of ['', 'registry.npmjs.org', '*.npmjs.org:443', 'REGISTRY.npmjs.org:443', 'registry.npmjs.org:443/x', '10.0.0.1:443',
    'a.b:0', 'a.b:443=::1', 'a.b:443=not-ip', 'a.b:443 ,c.d:443']) {
    assert.throws(() => proxy.parseAllow(bad), JSON.stringify(bad));
  }
});

test('EG12 resolved addresses: refused when ANY address is private (DNS rebinding cannot mix one in); empty answers are dns_failed; only a pinned test entry skips the rule', () => {
  const entry = { host: 'registry.npmjs.org', port: 443, pin: null };
  assert.deepEqual(proxy.decideAddresses(entry, ['104.16.0.35', '2606:4700::6810:84e5']), { ok: true, addresses: ['104.16.0.35', '2606:4700::6810:84e5'] });
  assert.deepEqual(proxy.decideAddresses(entry, ['104.16.0.35', '127.0.0.1']),
    { ok: false, reason: 'private_address', address: '127.0.0.1', why: 'loopback' });
  assert.equal(proxy.decideAddresses(entry, ['192.168.65.254']).reason, 'private_address');
  assert.equal(proxy.decideAddresses(entry, ['169.254.169.254']).why, 'metadata');
  assert.equal(proxy.decideAddresses(entry, ['::ffff:10.0.0.1']).reason, 'private_address');
  assert.equal(proxy.decideAddresses(entry, ['fd00::1']).reason, 'private_address');
  assert.equal(proxy.decideAddresses(entry, []).reason, 'dns_failed');
  assert.deepEqual(proxy.decideAddresses({ ...entry, pin: '172.30.0.5' }, ['8.8.8.8']), { ok: true, addresses: ['172.30.0.5'] });
});

/** A real TLS ClientHello from node's own TLS client, captured on loopback. */
function clientHello(servername) {
  return new Promise((resolve, reject) => {
    const srv = net.createServer((s) => { s.once('data', (d) => { resolve(Buffer.from(d)); s.destroy(); srv.close(); }); });
    srv.listen(0, '127.0.0.1', () => {
      const t = tls.connect({ host: '127.0.0.1', port: srv.address().port, servername, rejectUnauthorized: false });
      t.on('error', () => {}); setTimeout(() => t.destroy(), 2000).unref();
    });
    srv.on('error', reject);
  });
}

test('EG13 the TLS name: the tunnel\'s ClientHello must name the CONNECT host (another name, no name or not TLS is refused before anything is resolved)', async () => {
  const entry = { host: 'registry.npmjs.org', port: 443, pin: null };
  const good = await clientHello('registry.npmjs.org');
  assert.equal(proxy.clientHelloSni(good).sni, 'registry.npmjs.org');
  assert.deepEqual(proxy.decideSni(entry, good), { ok: true });
  assert.deepEqual(proxy.decideSni(entry, await clientHello('evil.example')), { ok: false, reason: 'sni_mismatch' });
  assert.deepEqual(proxy.decideSni(entry, Buffer.from('GET / HTTP/1.1\r\n\r\n')), { ok: false, reason: 'not_tls' });
  assert.deepEqual(proxy.decideSni(entry, good.subarray(0, 20)), { need: true });
  assert.deepEqual(proxy.decideSni(entry, good.subarray(0, 3)), { need: true });
  const broken = Buffer.from(good); broken[5] = 0x02;
  assert.deepEqual(proxy.decideSni(entry, broken), { ok: false, reason: 'not_tls' });
});

// ---------------------------------------------------------------- the proxy server on loopback

test('EG14 the proxy server (loopback only): a pinned test entry tunnels to a local test server; private DNS answers, other names, plain HTTP, a wrong TLS name and garbage are refused, each decision logged without a path', async () => {
  const seen = [];
  const target = net.createServer((s) => { s.once('data', (d) => { seen.push(d.length); s.end('registry-ok\n'); }); });
  await new Promise((r) => target.listen(0, '127.0.0.1', r));
  const tport = target.address().port;
  const lines = [];
  const lookups = [];
  const answers = { 'registry.npmjs.org': ['104.16.0.35', '10.0.0.5'], 'pypi.org': ['127.0.0.1'] };
  const allow = proxy.parseAllow(`nexus-test.registry.invalid:${tport}=127.0.0.1,registry.npmjs.org:443,pypi.org:443`);
  const server = proxy.serve(allow, { log: (l) => lines.push(l), lookup: (h, cb) => { lookups.push(h); cb(null, answers[h] ?? []); } });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const ask = (head, after) => new Promise((resolve) => {
    const s = net.connect({ host: '127.0.0.1', port });
    let got = Buffer.alloc(0);
    s.on('data', (d) => { got = Buffer.concat([got, d]); if (after && got.includes('200 Connection Established\r\n\r\n') && !s.sent) { s.sent = true; s.write(after); } });
    s.on('close', () => resolve(got.toString('latin1')));
    s.on('error', () => resolve(got.toString('latin1')));
    s.write(head);
    setTimeout(() => s.destroy(), 4000).unref();
  });
  try {
    const hello = await clientHello('nexus-test.registry.invalid');
    const ok = await ask(`CONNECT nexus-test.registry.invalid:${tport} HTTP/1.1\r\nHost: x\r\n\r\n`, hello);
    assert.match(ok, /^HTTP\/1\.1 200 Connection Established\r\n\r\nregistry-ok\n$/);
    assert.deepEqual(seen, [hello.length], 'the test server received exactly the ClientHello');
    assert.deepEqual(lookups, [], 'a pinned entry is never resolved');
    // registry.npmjs.org resolves to a public AND a private address: refused, and nothing is connected.
    const npmHello = await clientHello('registry.npmjs.org');
    const r1 = await ask('CONNECT registry.npmjs.org:443 HTTP/1.1\r\n\r\n', npmHello);
    assert.match(r1, /^HTTP\/1\.1 200 Connection Established\r\n\r\n$/, 'the tunnel closes without a byte');
    const r2 = await ask('CONNECT pypi.org:443 HTTP/1.1\r\n\r\n', await clientHello('pypi.org'));
    assert.match(r2, /^HTTP\/1\.1 200 Connection Established\r\n\r\n$/);
    const r3 = await ask('CONNECT host.docker.internal:443 HTTP/1.1\r\n\r\n');
    assert.match(r3, /^HTTP\/1\.1 403 Forbidden\r\nX-Nexus-Egress: host_not_allowed\r\n/);
    const r4 = await ask('GET http://registry.npmjs.org/secret-path?token=abc HTTP/1.1\r\nHost: registry.npmjs.org\r\n\r\n');
    assert.match(r4, /^HTTP\/1\.1 403 Forbidden\r\nX-Nexus-Egress: plain_http\r\n/);
    const r5 = await ask('CONNECT registry.npmjs.org:443 HTTP/1.1\r\n\r\n', await clientHello('evil.example'));
    assert.match(r5, /^HTTP\/1\.1 200 Connection Established\r\n\r\n$/);
    const r6 = await ask('\x16\x03\x01garbage\r\n\r\n');
    assert.match(r6, /^HTTP\/1\.1 400 Bad Request\r\nX-Nexus-Egress: malformed\r\n/);
    const r7 = await ask('CONNECT 127.0.0.1:443 HTTP/1.1\r\n\r\n');
    assert.match(r7, /X-Nexus-Egress: ip_literal/);
    assert.deepEqual(seen.length, 1, 'only the allowed tunnel reached a server');
    assert.deepEqual(lookups, ['registry.npmjs.org', 'pypi.org'], 'names are resolved only after the TLS name matched');
    const decisions = lines.map((l) => policy.parseEgressLine(l));
    assert.ok(decisions.every(Boolean), lines.join('\n'));
    assert.deepEqual(decisions.map((d) => [d.decision, d.host, d.reason]), [
      ['allowed', 'nexus-test.registry.invalid', 'allowed'], ['refused', 'registry.npmjs.org', 'private_address'], ['refused', 'pypi.org', 'private_address'],
      ['refused', 'host.docker.internal', 'host_not_allowed'], ['refused', 'registry.npmjs.org', 'plain_http'], ['refused', 'registry.npmjs.org', 'sni_mismatch'],
      ['refused', '', 'malformed'], ['refused', '127.0.0.1', 'ip_literal']]);
    for (const l of lines) assert.doesNotMatch(l, /secret-path|token|abc/);
  } finally {
    server.close(); target.close();
  }
});

// ---------------------------------------------------------------- the decision events

test('EG15 decision lines and events: the runner parses only exact proxy records; main accepts an egress event only in its strict shape', () => {
  const ok = 'nexus-egress {"decision":"refused","host":"host.docker.internal","port":443,"reason":"host_not_allowed"}';
  assert.deepEqual(policy.parseEgressLine(ok), { decision: 'refused', host: 'host.docker.internal', port: 443, reason: 'host_not_allowed' });
  for (const bad of ['nexus-egress {"decision":"allowed","host":"x","port":443,"reason":"host_not_allowed"}',
    'nexus-egress {"decision":"refused","host":"a b","port":443,"reason":"malformed"}', 'nexus-egress {"decision":"refused","host":"x","port":70000,"reason":"busy"}',
    'nexus-egress {"decision":"refused","host":"x","port":1,"reason":"other"}', 'nexus-egress not json', 'something else']) {
    assert.equal(policy.parseEgressLine(bad), null, bad);
  }
  assert.deepEqual(classifyProxyLine('nexus-egress-ready {"port":3128}'), { kind: 'ready' });
  assert.equal(classifyProxyLine(ok).kind, 'decision');
  assert.equal(classifyProxyLine('node: warning').kind, 'other');
  const sp = new LineSplitter();
  assert.deepEqual(sp.push('a\nb'), ['a']); assert.deepEqual(sp.push('c\r\nd'), ['bc']); assert.deepEqual(sp.flush(), ['d']);
  const ev = (e) => parseRunnerMessage({ op: 'attempt.event', attemptId: newId(NOW), seq: 1, event: { t: 'egress', at: NOW, ...e } });
  assert.ok(ev({ decision: 'refused', host: '169.254.169.254', port: 80, reason: 'ip_literal' }));
  assert.ok(ev({ decision: 'allowed', host: 'registry.npmjs.org', port: 443, reason: 'allowed' }));
  assert.equal(ev({ decision: 'allowed', host: 'registry.npmjs.org', port: 443, reason: 'private_address' }), null);
  assert.equal(ev({ decision: 'refused', host: 'a/b?q=1', port: 443, reason: 'plain_http' }), null);
  assert.equal(ev({ decision: 'refused', host: 'x', port: 443, reason: 'plain_http', path: '/x' }), null);
  assert.equal(EGRESS_EVENT_MAX, 200);
});
