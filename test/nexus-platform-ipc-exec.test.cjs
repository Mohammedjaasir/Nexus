'use strict';
// B2a Task 13: the twenty execution channels #22-#41 through the one wrapper. Hostile arguments to every channel,
// availability at v8 (execution_unavailable with each sub-reason) while #22/#23 still answer, the startup registry
// check (an invalid registry is a state, never a throw) and B2A_IMPL against main's registered maps, busy, truncation,
// health (I-H1-H4: the gate's exact numbers; never waits on the runner), a hung runner (I-R1: every channel answers in
// 200 ms), and the nexus:hint push. Real SQLite (test:db); a fake runner; nothing launches Electron or touches userData.
const h = require('./helpers/sqlite.cjs');
if (!h.realSqliteOrSkip()) return;
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');
const { execWorld, PROFILES, GIB } = require('./helpers/execWorld.cjs');
const { track } = require('./helpers/cleanup.cjs');
const { ipcOver, asLocalUser, noLeak, intent } = require('./helpers/ipcExec.cjs');
const { PersistStore } = loadTs('src/main/db.ts');
const { createNexusPlatform } = loadTs('src/main/nexus/platform.ts');
const { registerNexusIpc, NEXUS_CHANNELS, NEXUS_EXEC_CHANNELS, NEXUS_ALL_CHANNELS, sendNexusHint, NEXUS_HINT_CHANNEL } =
  loadTs('src/main/nexusIpc/registerNexusIpc.ts');
const { BUSY_MESSAGE, EXECUTION_SUB_REASONS } = loadTs('src/main/nexusIpc/envelope.ts');
const { startExecution, hintCoalescer, HINT_MIN_INTERVAL_MS, execIpcPort } = loadTs('src/main/nexusExec/execWiring.ts');
const { B2A_IMPL, checkRegistry } = loadTs('src/shared/nexus/registryCheck.ts');
const { DOMAINS } = loadTs('src/shared/nexus/domains/index.ts');
const { mainImplementation, implementationProblems, registryProblems } = loadTs('src/main/nexus/registryImpl.ts');
const { REQUIRED_FREE_BYTES, RECOMMENDED_FREE_BYTES } = loadTs('src/shared/nexus/resourceGate.ts');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const UNKNOWN = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
const GATED = NEXUS_EXEC_CHANNELS.filter((c) => c !== 'nexus:domains:list' && c !== 'nexus:platform:health');
const REQ = { title: 'Ledger export', body: 'Export the ledger as CSV.', criteria: [{ id: 'AC1', text: 'A CSV file downloads' }] };

/** A v8 platform (no execution tables): the B1 harness shape. */
function v8Platform() {
  const { file } = h.v6Fixture(); const s = track(new PersistStore(file));
  s.open({ log: () => {}, backupDir: path.join(path.dirname(file), 'b'), now: () => h.NOW });
  const nx = createNexusPlatform(s.platformDatabase(), { now: () => h.NOW });
  return { s, db: s.platformDatabase(), nx };
}

/** Valid-shaped arguments for every channel (the answers may be refusals; the shapes pass validation). */
function validArgs(w, ids = {}) {
  return {
    'nexus:participations:list': [], 'nexus:participation:attach': ['p-ledger', 'qa'], 'nexus:participation:withdraw': [UNKNOWN],
    'nexus:artifacts:list': [{}], 'nexus:artifacts:byProject': ['p-ledger'], 'nexus:artifact:get': [UNKNOWN], 'nexus:version:get': [w.repoV],
    'nexus:lineage:get': [w.repoV, { direction: 'up' }],
    'nexus:artifact:saveCommit': [{ projectId: 'p-ledger', workspaceId: 'sde', commit: 'a'.repeat(40), target: { name: 'C' } }],
    'nexus:artifact:saveTextFile': [{ projectId: 'p-ledger', workspaceId: 'sde', relPath: 'README.md', target: { name: 'T' } }],
    'nexus:version:markReady': [UNKNOWN], 'nexus:version:promote': [UNKNOWN, null], 'nexus:version:discard': [UNKNOWN],
    'nexus:version:linkSources': [UNKNOWN, [w.repoV]], 'nexus:handoffs:list': [{}], 'nexus:handoff:get': [UNKNOWN],
    'nexus:handoff:send': [{ projectId: 'p-ledger', fromParticipationId: UNKNOWN, toParticipationId: UNKNOWN, versionIds: [w.repoV], title: 't' }],
    'nexus:handoff:accept': [UNKNOWN], 'nexus:handoff:decline': [UNKNOWN], 'nexus:handoff:withdraw': [UNKNOWN], 'nexus:activity:byProject': ['p-ledger'],
    'nexus:domains:list': [], 'nexus:platform:health': [],
    'nexus:actions:available': [{ projectId: 'p-ledger', workspaceId: 'sde' }],
    'nexus:job:start': [{ projectId: 'p-ledger', workspaceId: 'sde', actionId: 'sde.tests.discover', inputs: [{ versionId: w.repoV, slot: 'repository' }],
      params: {}, intentId: intent() }],
    'nexus:jobs:list': [{ projectId: 'p-ledger' }], 'nexus:job:get': [ids.job ?? UNKNOWN],
    'nexus:job:logs': [ids.job ?? UNKNOWN, { attempt: 1, fromOffset: 0, maxBytes: 4096 }], 'nexus:job:cancel': [ids.job ?? UNKNOWN],
    'nexus:job:retry': [ids.job ?? UNKNOWN, intent()], 'nexus:events:since': [{ sinceSeq: 0 }],
    'nexus:version:validations': [w.repoV], 'nexus:version:revalidate': [w.repoV, intent()],
    'nexus:version:preview': [w.repoV, { part: 'content', maxBytes: 4096 }],
    'nexus:artifact:saveInline': [{ projectId: 'p-ledger', workspaceId: 'sde', kind: 'requirement', target: { name: 'R' }, content: REQ }],
    'nexus:deployments:list': [{}], 'nexus:deployment:stop': [UNKNOWN], 'nexus:approvals:list': [{}],
    'nexus:approval:respond': [UNKNOWN, 'once'], 'nexus:setup:prepareImage': ['sde-node', intent()], 'nexus:blobs:gc': [{ apply: false }]
  };
}

// ---------- registration ----------

test('I-E1 the twenty execution channels are frozen, distinct, and registered through the one wrapper only with main\'s execution deps (41); B1\'s 21 without', () => {
  assert.equal(NEXUS_EXEC_CHANNELS.length, 20); assert.equal(new Set(NEXUS_EXEC_CHANNELS).size, 20); assert.ok(Object.isFrozen(NEXUS_EXEC_CHANNELS));
  assert.deepEqual([...NEXUS_ALL_CHANNELS], [...NEXUS_CHANNELS, ...NEXUS_EXEC_CHANNELS]); assert.ok(Object.isFrozen(NEXUS_ALL_CHANNELS));
  for (const c of NEXUS_EXEC_CHANNELS) assert.ok(!NEXUS_CHANNELS.includes(c), c);
  const reg = (deps) => { const got = []; registerNexusIpc({ handle: (c) => got.push(c) }, { platform: () => null, unavailableReason: () => 'held',
    sources: {}, log: () => {}, ...deps }); return got; };
  assert.deepEqual(reg({}).sort(), [...NEXUS_CHANNELS].sort());
  assert.deepEqual(reg({ executionUnavailableReason: () => null }).sort(), [...NEXUS_ALL_CHANNELS].sort());
  assert.deepEqual(reg({ exec: () => null }).sort(), [...NEXUS_ALL_CHANNELS].sort());
  assert.equal(NEXUS_HINT_CHANNEL, 'nexus:hint');
});

test('I-E2 with no platform every one of the 41 channels answers platform_unavailable with the store\'s reason', async () => {
  const w = { nx: null, dataHome: null, repoV: UNKNOWN };
  const x = ipcOver(w, { platform: () => null });
  assert.equal(x.handlers.size, 41);
  const args = validArgs(w);
  for (const ch of NEXUS_ALL_CHANNELS) {
    const r = await x.call(ch, ...args[ch]);
    assert.deepEqual([r.ok, r.code, r.reason], [false, 'platform_unavailable', 'held'], ch);
  }
});

// ---------- availability ----------

test('I-E3 at v8 every gated channel answers execution_unavailable with each sub-reason; #22 and #23 still answer; B1 channels are untouched', async () => {
  const p = v8Platform();
  let reason = null;
  const w = { nx: p.nx, dataHome: null, repoV: UNKNOWN };
  const x = ipcOver(w, { executionUnavailableReason: () => reason });
  const args = validArgs(w);
  for (const sub of ['held', 'auto_held', 'backup_failed', 'failed', 'shape']) {
    reason = sub;
    for (const ch of GATED) {
      const r = await x.call(ch, ...args[ch]);
      assert.deepEqual([r.ok, r.code, r.reason, r.subReason], [false, 'platform_unavailable', 'execution_unavailable', sub], `${ch} ${sub}`);
      assert.equal(r.message, 'Running work is not available on this database.');
    }
    const domains = await x.ok('nexus:domains:list');
    assert.equal(domains.length, DOMAINS.length);
    const health = await x.ok('nexus:platform:health');
    assert.deepEqual([health.db.execution, health.db.subReason, health.db.handoffs], [false, sub, true]);
    assert.equal(health.db.version, 8);
  }
  // main says nothing: the platform's own reason (execution was never turned on at v8).
  reason = null;
  const r = await x.call('nexus:jobs:list', {});
  assert.deepEqual([r.reason, r.subReason], ['execution_unavailable', 'not_enabled']);
  // B1's channels answer as before.
  assert.equal((await x.call('nexus:participations:list')).ok, true);
  assert.equal((await x.call('nexus:activity:byProject', 'p-ledger')).ok, true);
  // An unknown sub-reason is never echoed.
  reason = 'C:\\Users\\x';
  assert.equal((await x.call('nexus:jobs:list', {})).subReason, 'not_enabled');
  assert.deepEqual([...EXECUTION_SUB_REASONS].sort(), ['auto_held', 'backup_failed', 'failed', 'held', 'not_enabled', 'not_started', 'registry_invalid', 'shape', 'v8_unavailable']);
});

test('I-E4 an invalid registry at startup is a state: execution stays off (registry_invalid), the channels say so, health shows it, nothing throws', async () => {
  const w = execWorld();
  const logs = [];
  const nx = createNexusPlatform(w.db, { now: () => w.now(), log: (l) => logs.push(l), execution: true, dataHome: w.dataHome, profiles: PROFILES,
    acceptFsRoot: (r) => r, approvals: null, registryProblems: () => ['sde/tests: REAL step has no end-to-end test'] });
  assert.equal(nx.executionAvailable, false);
  assert.equal(nx.exec.unavailableReason, 'registry_invalid');
  assert.deepEqual(nx.registry, { valid: false, problems: 1 });
  assert.ok(logs.some((l) => /domain registry check failed: 1 problem/.test(l)), logs.join('\n'));
  assert.doesNotThrow(() => nx.startup());
  const x = ipcOver({ nx, dataHome: w.dataHome, repoV: w.repoV });
  const args = validArgs(w);
  for (const ch of GATED) {
    const r = await x.call(ch, ...args[ch]);
    assert.deepEqual([r.code, r.reason, r.subReason], ['platform_unavailable', 'execution_unavailable', 'registry_invalid'], ch);
  }
  const health = await x.ok('nexus:platform:health');
  assert.deepEqual(health.registry, { valid: false, problems: 1 });
  assert.deepEqual([health.db.execution, health.db.subReason], [false, 'registry_invalid']);
  // A registry check that throws is a problem too (never a crash).
  const nx2 = createNexusPlatform(w.db, { now: () => w.now(), execution: true, dataHome: w.dataHome, profiles: PROFILES, approvals: null,
    registryProblems: () => { throw new Error('boom'); } });
  assert.equal(nx2.exec.unavailableReason, 'registry_invalid');
  // The real registry is sound and main agrees with it: execution is on.
  assert.deepEqual(registryProblems(), []);
  assert.equal(w.nx.executionAvailable, true); assert.deepEqual(w.nx.registry, { valid: true, problems: 0 });
  w.close();
});

test('I-E5 B2A_IMPL equals main\'s registered recipe, validator and ingest maps exactly (and a drift on either side is a startup problem)', () => {
  const m = mainImplementation();
  const sorted = (xs) => [...xs].sort();
  assert.deepEqual(sorted(m.recipes), sorted(B2A_IMPL.recipes), 'recipes main can plan');
  assert.deepEqual(sorted(m.validators), sorted(B2A_IMPL.validators), 'validators main runs');
  assert.deepEqual(sorted([...m.ingest, ...m.notIngested]), sorted(B2A_IMPL.recipes), 'every recipe is ingested or named as never ingested');
  assert.deepEqual(m.ingest.filter((x) => m.notIngested.includes(x)), [], 'never both');
  assert.deepEqual(sorted(m.notIngested), ['sde.deps.node', 'sde.deps.python', 'sde.preview.start']);
  assert.deepEqual(implementationProblems(), []);
  assert.deepEqual(checkRegistry(DOMAINS, B2A_IMPL), []);
  // Drift either way is found.
  assert.ok(implementationProblems({ ...B2A_IMPL, recipes: B2A_IMPL.recipes.filter((r) => r !== 'sde.diagnose') })
    .some((p) => /main has sde\.diagnose but the registry does not declare it/.test(p)));
  assert.ok(implementationProblems({ ...B2A_IMPL, validators: [...B2A_IMPL.validators, 'sde.lint'] })
    .some((p) => /validator: sde\.lint is declared implemented but main has none/.test(p)));
  assert.ok(implementationProblems({ ...B2A_IMPL, recipes: [...B2A_IMPL.recipes, 'sde.deploy.prod'] }).some((p) => /recipe: sde\.deploy\.prod/.test(p)));
});

// ---------- hostile arguments ----------

test('I-E6 hostile arguments to every execution channel never throw, never leak, never write; each named case answers bad_request or bad_params', async () => {
  const w = execWorld();
  const x = ipcOver(w);
  const counts = () => ['jobs', 'job_attempts', 'approvals', 'deployments', 'artifacts', 'artifact_versions', 'validations', 'image_builds', 'activity']
    .map((t) => w.db.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n);
  const before = counts();
  const getter = {}; Object.defineProperty(getter, 'projectId', { enumerable: true, get() { throw new Error('ran a getter'); } });
  const sym = { [Symbol('x')]: 1 };
  const hostile = [null, 42, '', 'x'.repeat(5000), '../../etc/passwd', 'C:\\Windows\\system32', '\\\\server\\share', JSON.parse('{"__proto__":{"a":1}}'),
    { extra: 1 }, ['a'], getter, sym, NaN, Infinity, { limit: -1 }, 'not-a-ulid', `${UNKNOWN}x`, new Date(0), () => 1, Array(70).fill(UNKNOWN)];
  for (const ch of NEXUS_EXEC_CHANNELS) for (const a of hostile) {
    const r = await x.call(ch, a, a);
    assert.equal(typeof r, 'object', ch);
    assert.equal(r.ok, false, `${ch} accepted ${String(a).slice(0, 40)}: ${JSON.stringify(r).slice(0, 200)}`);
    assert.deepEqual([r.code, r.reason], ['invalid', 'bad_request'], `${ch}: ${JSON.stringify(r)}`);
    noLeak(r, ch);
  }
  assert.deepEqual(counts(), before, 'no hostile call wrote a row');
  assert.deepEqual(x.sources.calls, [], 'no B2a channel touches the B1 file or git ports');
  const start = (patch) => ({ projectId: 'p-ledger', workspaceId: 'sde', actionId: 'sde.tests.discover', inputs: [{ versionId: w.repoV, slot: 'repository' }],
    params: {}, intentId: intent(), ...patch });
  const bad = async (ch, args, field, reason = 'bad_request') => x.refused(ch, args, 'invalid', { reason, field });
  // 'always' is not an answer; there is no third decision.
  await bad('nexus:approval:respond', [UNKNOWN, 'always'], 'decision');
  await bad('nexus:approval:respond', [UNKNOWN, 'ONCE'], 'decision');
  // `role` instead of `slot`: an unknown key, named back.
  await bad('nexus:job:start', [start({ inputs: [{ versionId: w.repoV, role: 'repository' }] })], 'role');
  await bad('nexus:job:start', [start({ inputs: [{ versionId: w.repoV }] })], 'slot');
  await bad('nexus:job:start', [start({ inputs: Array(65).fill(0).map(() => ({ versionId: w.repoV, slot: 'repository' })) })], 'inputs');
  await bad('nexus:job:start', [start({ inputs: [{ versionId: w.repoV, slot: 'repository' }, { versionId: w.repoV, slot: 'repository' }] })], 'inputs');
  await bad('nexus:job:start', [start({ intentId: 'intent-1' })], 'intentId');
  await bad('nexus:job:start', [start({ intentId: UNKNOWN.toLowerCase() })], 'intentId');
  await bad('nexus:job:start', [start({ actionId: 'Sde.Tests' })], 'actionId');
  await bad('nexus:job:start', [{ ...start(), extra: 1 }], 'extra');
  await bad('nexus:job:start', [{ ...start(), principal: 'system' }], 'principal');
  await bad('nexus:job:start', [start({ params: getter })], 'params');
  await bad('nexus:job:start', [start({ params: { a: { b: 1 } } })], 'params');
  await bad('nexus:job:start', [start({ params: Object.fromEntries(Array(40).fill(0).map((_, i) => [`k${i}`, 1])) })], 'params');
  // An execution setting is never a parameter (bad_request); an unknown or ill-shaped parameter is bad_params.
  for (const k of ['network', 'ports', 'image', 'argv', 'env', 'command', 'mounts', 'privileged', 'user', 'token']) {
    await bad('nexus:job:start', [start({ params: { [k]: 'x' } })], 'params');
  }
  await bad('nexus:job:start', [start({ params: { verbose: true } })], 'params', 'bad_params');
  await bad('nexus:job:start', [start({ actionId: 'sde.diagnose', inputs: [], params: { target: 'job' } })], 'params', 'bad_params');
  // Oversize strings and arrays.
  await bad('nexus:jobs:list', [{ states: Array(12).fill('queued') }], 'states');
  await bad('nexus:jobs:list', [{ states: ['queued', 'queued'] }], 'states');
  await bad('nexus:jobs:list', [{ jobKind: 'shell' }], 'jobKind');
  await bad('nexus:jobs:list', [{ kind: 'tool.run' }], 'kind');
  await bad('nexus:job:logs', [UNKNOWN, { attempt: 1, fromOffset: 0, maxBytes: 262145 }], 'maxBytes');
  await bad('nexus:job:logs', [UNKNOWN, { attempt: 0, fromOffset: 0, maxBytes: 1 }], 'attempt');
  await bad('nexus:version:preview', [w.repoV, { part: 'content', maxBytes: 262145 }], 'maxBytes');
  await bad('nexus:version:preview', [w.repoV, { part: 'raw', maxBytes: 1 }], 'part');
  await bad('nexus:artifact:saveInline', [{ projectId: 'p-ledger', workspaceId: 'sde', kind: 'build', target: { name: 'R' }, content: REQ }], 'kind');
  await bad('nexus:artifact:saveInline', [{ projectId: 'p-ledger', workspaceId: 'sde', kind: 'requirement', target: { name: 'R' }, content: { body: 'x'.repeat(40000) } }], 'content');
  const deep = {}; let cur = deep; for (let i = 0; i < 12; i++) { cur.a = {}; cur = cur.a; }
  await bad('nexus:artifact:saveInline', [{ projectId: 'p-ledger', workspaceId: 'sde', kind: 'requirement', target: { name: 'R' }, content: deep }], 'content');
  await bad('nexus:setup:prepareImage', ['sde-ruby', intent()], 'profileId');
  await bad('nexus:blobs:gc', [{ apply: true }], 'expectedCandidatesHash');
  await bad('nexus:blobs:gc', [{ apply: true, expectedCandidatesHash: 'A'.repeat(64) }], 'expectedCandidatesHash');
  await bad('nexus:blobs:gc', [{ apply: 'yes' }], 'apply');
  await bad('nexus:blobs:gc', [{ apply: false, expectedCandidatesHash: 'a'.repeat(64) }], 'expectedCandidatesHash');
  await bad('nexus:events:since', [{ sinceSeq: -1 }], 'sinceSeq');
  await bad('nexus:actions:available', [{ projectId: 'p-ledger', workspaceId: 'sde', versionId: 'v-1' }], 'versionId');
  assert.deepEqual(counts(), before, 'no named refusal wrote a row');
  w.close();
});

// ---------- busy and truncation ----------

test('I-E7 a write lock held by another connection answers busy on job:start and writes nothing; the same intent succeeds once the lock is gone', async () => {
  const w = execWorld();
  const x = ipcOver(w);
  w.db.pragma('busy_timeout = 50');
  const req = { projectId: 'p-ledger', workspaceId: 'sde', actionId: 'sde.tests.discover', inputs: [{ versionId: w.repoV, slot: 'repository' }], params: {}, intentId: intent() };
  const jobs = () => w.db.prepare('SELECT COUNT(*) n FROM jobs').get().n;
  const before = jobs();
  const other = h.openRaw(w.db.name); other.pragma('busy_timeout = 0');
  other.prepare('BEGIN IMMEDIATE').run();
  try {
    const r = await x.call('nexus:job:start', req);
    assert.deepEqual(r, { ok: false, code: 'platform_unavailable', message: BUSY_MESSAGE, reason: 'busy' });
  } finally { other.prepare('ROLLBACK').run(); other.close(); }
  assert.equal(jobs(), before);
  const ok = await x.ok('nexus:job:start', req);
  assert.equal(ok.created, true);
  const again = await x.ok('nexus:job:start', req);
  assert.deepEqual([again.created, again.job.id], [false, ok.job.id], 'the same intent never makes a second job');
  w.close();
});

test('I-E8 truncation flags: jobs:list says truncated only when more rows exist than were returned', async () => {
  const w = execWorld();
  const x = ipcOver(w);
  for (let i = 0; i < 3; i++) await x.ok('nexus:job:start', { projectId: 'p-ledger', workspaceId: 'sde', actionId: 'sde.tests.discover',
    inputs: [{ versionId: w.repoV, slot: 'repository' }], params: {}, intentId: intent() });
  const two = await x.call('nexus:jobs:list', { projectId: 'p-ledger', limit: 2 });
  assert.deepEqual([two.data.length, two.truncated], [2, true]);
  const three = await x.call('nexus:jobs:list', { projectId: 'p-ledger', limit: 3 });
  assert.deepEqual([three.data.length, three.truncated], [3, false]);
  const big = await x.call('nexus:jobs:list', { limit: 5000 });
  assert.deepEqual([big.data.length, big.truncated], [3, false], 'a limit above the cap is clamped to 500');
  for (const j of three.data) { assert.equal(j.headline, 'queued'); assert.equal(j.requestedByKind, 'user'); noLeak(j); }
  w.close();
});

// ---------- health ----------

test('I-H1 health: the disk gate with its exact numbers (30 GiB required, 40 GiB recommended) and the free bytes main observed', async () => {
  const w = execWorld({ freeBytes: 100 * GIB });
  w.attach();
  const x = ipcOver(w);
  const v = await x.ok('nexus:platform:health');
  assert.deepEqual(v.disk, { dataHomeFreeBytes: 100 * GIB, requiredBytes: 32212254720, recommendedBytes: 42949672960, leaseFloorBytes: v.disk.leaseFloorBytes, gate: 'ok' });
  assert.equal(REQUIRED_FREE_BYTES, 30 * 2 ** 30); assert.equal(RECOMMENDED_FREE_BYTES, 40 * 2 ** 30);
  assert.ok(v.disk.leaseFloorBytes > 0);
  assert.deepEqual(v.problems, []);
  assert.deepEqual([v.db.version, v.db.platform, v.db.handoffs, v.db.execution], [9, true, true, true]);
  assert.deepEqual(v.registry, { valid: true, problems: 0 });
  assert.equal(v.docker.state, 'running'); assert.equal(v.docker.cpus, 4); assert.equal(v.docker.memoryBytes, 8 * GIB);
  assert.deepEqual(v.gpu, { detected: false, supported: false });
  for (const i of v.images) assert.match(i.imageIdShort, /^sha256:[0-9a-f]{12}$/);
  noLeak(v, 'health');
  w.close();
});

test('I-H2 health: 35 GiB free is below_recommended (advisory), 20 GiB below_required (disk_low), each with the numbers', async () => {
  const w = execWorld({ freeBytes: 35 * GIB });
  w.attach();
  const x = ipcOver(w);
  let v = await x.ok('nexus:platform:health');
  assert.deepEqual([v.disk.gate, v.disk.dataHomeFreeBytes], ['below_recommended', 35 * GIB]);
  assert.ok(v.problems.includes('disk_below_recommended'), v.problems.join());
  w.setProbe({ freeBytes: 20 * GIB });
  v = await x.ok('nexus:platform:health');
  assert.deepEqual([v.disk.gate, v.disk.dataHomeFreeBytes], ['below_required', 20 * GIB]);
  assert.ok(v.problems.includes('disk_low'), v.problems.join());
  w.close();
});

test('I-H3 health: Docker stopped, an image missing, a GPU detected (never supported); every line actionable by id', async () => {
  const w = execWorld({ images: [{ profile: 'sde-node', present: false, digestMatches: false }, { profile: 'sde-python', present: true, digestMatches: false, imageId: 'sha256:' + '2'.repeat(64) }] });
  w.attach();
  w.setProbe({ docker: 'stopped' });
  const x = ipcOver(w);
  const v = await x.ok('nexus:platform:health');
  assert.equal(v.docker.state, 'stopped');
  assert.deepEqual(v.problems, ['docker_stopped']);
  // A setup:* answer on the action itself.
  const acts = await x.ok('nexus:actions:available', { projectId: 'p-ledger', workspaceId: 'sde' });
  assert.equal(acts.find((a) => a.actionId === 'sde.tests.discover').reason, 'setup:docker_stopped');
  // Docker running again: the images are judged.
  w.setProbe({ docker: 'running' });
  const v2 = await x.ok('nexus:platform:health');
  assert.ok(v2.problems.includes('image_missing:sde-node'), v2.problems.join());
  assert.ok(v2.problems.includes('image_mismatch:sde-python'), v2.problems.join());
  assert.equal(v2.images.find((i) => i.profile === 'sde-python').imageIdShort, 'sha256:222222222222');
  assert.equal((await x.ok('nexus:actions:available', { projectId: 'p-ledger', workspaceId: 'sde' })).find((a) => a.actionId === 'sde.tests.discover').reason,
    'setup:image_missing');
  w.close();
});

test('I-H4 health never waits on the runner: with a runner that never answers, #23 answers from the cache within 50 ms', async () => {
  const w = execWorld();
  const silent = { state: () => 'ready', send: () => true, onMessage: () => () => {}, report: () => {} };
  w.exec.attachRunner(silent, w.bootId);
  const x = ipcOver(w);
  await x.ok('nexus:platform:health');                       // warm the module paths
  const t0 = process.hrtime.bigint();
  const v = await x.ok('nexus:platform:health');
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  assert.ok(ms < 50, `${ms} ms`);
  assert.deepEqual([v.docker.state, v.checkedAt, v.disk.gate], ['unknown', null, 'unknown'], 'no probe has arrived: nothing is invented');
  assert.equal(v.runner.state, 'ready');
  // A runner whose state throws reads as unavailable; still no wait, no throw.
  w.exec.attachRunner({ state: () => { throw new Error('gone'); }, send: () => false, onMessage: () => () => {}, report: () => {} }, w.bootId);
  assert.equal((await x.ok('nexus:platform:health')).runner.state, 'unavailable');
  w.close();
});

// ---------- a hung runner ----------

test('I-R1 a hung runner: every one of the 41 channels answers within 200 ms', async () => {
  const w = execWorld();
  const hung = { state: () => 'ready', send: () => true, onMessage: () => () => {}, report: () => {} };
  w.exec.attachRunner(hung, w.bootId);
  const x = ipcOver(w);
  const started = await x.ok('nexus:job:start', { projectId: 'p-ledger', workspaceId: 'sde', actionId: 'sde.tests.discover',
    inputs: [{ versionId: w.repoV, slot: 'repository' }], params: {}, intentId: intent() });
  w.exec.tick(w.now());                                       // leased and sent; the runner never answers
  const args = validArgs(w, { job: started.job.id });
  for (const ch of NEXUS_ALL_CHANNELS) {
    const t0 = process.hrtime.bigint();
    const r = await x.call(ch, ...args[ch]);
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    assert.equal(typeof r.ok, 'boolean', ch);
    assert.ok(ms < 200, `${ch} took ${ms} ms`);
    noLeak(r, ch);
  }
  w.close();
});

// ---------- the nexus:hint push ----------

test('I-P1 nexus:hint carries { lastSeq } only, through sendNexusHint (the one send of the family), never to a destroyed target, never throwing', () => {
  const sent = [];
  const target = { send: (ch, payload) => sent.push([ch, payload]), isDestroyed: () => false };
  assert.equal(sendNexusHint(target, 7), true);
  assert.deepEqual(sent, [['nexus:hint', { lastSeq: 7 }]]);
  for (const bad of [-1, 1.5, NaN, '7', null, Number.MAX_SAFE_INTEGER + 2]) assert.equal(sendNexusHint(target, bad), false, String(bad));
  assert.equal(sendNexusHint({ send: () => { sent.push('x'); }, isDestroyed: () => true }, 8), false);
  assert.equal(sendNexusHint({ send: () => { throw new Error('gone'); } }, 9), false);
  assert.equal(sent.length, 1);
  // The family sends exactly one push: one `.send(` in src/main/nexusIpc, inside sendNexusHint; its literal appears once.
  const files = fs.readdirSync(path.join(ROOT, 'src/main/nexusIpc')).map((f) => read(`src/main/nexusIpc/${f}`));
  // (B1's `handoffs!.send(` is the handoff service's send, not a transport.)
  assert.deepEqual(files.join('\n').match(/[A-Za-z!]+\.send\(/g).sort(), ['handoffs!.send(', 'target.send(']);
  const mod = read('src/main/nexusIpc/registerNexusIpc.ts');
  assert.equal((mod.match(/'nexus:hint'/g) || []).length, 1);
  assert.match(mod, /target\.send\(NEXUS_HINT_CHANNEL, \{ lastSeq \}\)/);
  // main's wiring sends hints only through it, to the targets main names.
  const wiring = read('src/main/nexusExec/execWiring.ts');
  assert.match(wiring, /for \(const t of targets\) if \(t\) sendNexusHint\(t, h\.lastSeq\);/);
  assert.doesNotMatch(wiring, /webContents|\.send\('/);
});

test('I-P2 the hint coalescer: at most 4 hints in any second, each the newest seq, none when it did not change', () => {
  const q = []; let now = 0;
  const timers = { setTimeout: (fn, ms) => { const t = { at: now + ms, fn }; q.push(t); return t; }, clearTimeout: (t) => { const i = q.indexOf(t); if (i >= 0) q.splice(i, 1); } };
  const advance = (ms) => { const end = now + ms; for (;;) { const due = q.filter((t) => t.at <= end).sort((a, b) => a.at - b.at)[0]; if (!due) break; q.splice(q.indexOf(due), 1); now = due.at; due.fn(); } now = end; };
  let seq = 0; const sent = [];
  const c = hintCoalescer({ lastSeq: () => seq, emit: (x) => sent.push({ at: now, ...x }), now: () => now, timers });
  for (let i = 0; i < 3000; i++) { seq++; c.poke(); advance(1); }
  advance(1000);
  assert.equal(HINT_MIN_INTERVAL_MS, 250);
  for (const s of sent) assert.ok(sent.filter((x) => x.at >= s.at && x.at < s.at + 1000).length <= 4, `more than 4 hints in the second from ${s.at}`);
  for (const s of sent) assert.deepEqual(Object.keys(s).sort(), ['at', 'lastSeq']);
  assert.equal(sent.at(-1).lastSeq, 3000, 'the newest seq');
  const n = sent.length; c.poke(); advance(1000);
  assert.equal(sent.length, n, 'unchanged: no hint');
});

test('I-P3 startExecution sends each coalesced hint to every live target main names, { lastSeq } only', async () => {
  const w = execWorld();
  const nx = createNexusPlatform(w.db, { now: () => w.now(), execution: true, dataHome: w.dataHome, profiles: PROFILES, acceptFsRoot: (r) => r, approvals: null });
  nx.startup();
  // A scripted runner process that answers hello with ready and nothing else.
  const fork = () => {
    const c = { msgFn: null, exitFn: null, post(m) { if (m.op === 'hello') setImmediate(() => c.msgFn?.({ op: 'ready', bootId: m.bootId })); },
      onMessage(f) { c.msgFn = f; }, onExit(f) { c.exitFn = f; }, kill() { c.exitFn?.(null); } };
    return c;
  };
  const q = []; let now = w.now();
  const timers = { setTimeout: (fn, ms) => { const t = { at: now + ms, fn, every: 0 }; q.push(t); return t; }, clearTimeout: (t) => { const i = q.indexOf(t); if (i >= 0) q.splice(i, 1); },
    setInterval: (fn, ms) => { const t = { at: now + ms, fn, every: ms }; q.push(t); return t; }, clearInterval: (t) => { const i = q.indexOf(t); if (i >= 0) q.splice(i, 1); } };
  const advance = (ms) => { const end = now + ms; for (;;) { const due = q.filter((t) => t.at <= end).sort((a, b) => a.at - b.at)[0]; if (!due) break; now = due.at; if (due.every) due.at += due.every; else q.splice(q.indexOf(due), 1); due.fn(); } now = end; };
  const got = [];
  const live = { send: (ch, p) => got.push([ch, p]), isDestroyed: () => false };
  const dead = { send: () => got.push(['dead']), isDestroyed: () => true };
  const handle = await startExecution({ platform: nx, userData: path.dirname(w.dataHome.root), log: () => {}, fork, timers, now: () => now,
    hintTargets: () => [live, dead, null] });
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
  nx.exec.start(nx.principals.localUser(), w.req('sde.tests.discover'));   // a job event: the newest seq moves
  advance(3 * 60_000);
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
  assert.ok(got.length >= 1, 'a hint went out');
  for (const g of got) {
    assert.equal(g[0], 'nexus:hint');
    assert.deepEqual(Object.keys(g[1]), ['lastSeq']);
    assert.ok(Number.isSafeInteger(g[1].lastSeq));
  }
  assert.equal(got.at(-1)[1].lastSeq, nx.exec.lastEventSeq());
  const st = handle.stop(); advance(10_000); await st;
  w.close();
});

test('I-P4 no system-only door is mapped to IPC: resumeApproved(Tx), ingest, recovery, finalize, transitions and the runner port never appear in the IPC layer', () => {
  const family = fs.readdirSync(path.join(ROOT, 'src/main/nexusIpc')).map((f) => read(`src/main/nexusIpc/${f}`)).join('\n');
  for (const name of ['resumeApproved', 'resumeApprovedTx', 'endAwaitingTx', 'ingestAttempt', 'ingestTx', 'recoverPhaseA', 'recoverPhaseB',
    'recoverBlobStore', 'reconcileList', 'onRunnerMessage', 'attachRunner', 'sendToRunner', 'createCheckTx', 'createTx', 'transitionTx',
    'finalizeIfReady', 'enqueueCandidate', 'recordResultTx', 'recordOutcomeTx', 'expireDue', 'insertSystemVersionTx', 'setStatusTx', 'stopAllForQuit',
    'gcCandidates', 'tick(']) {
    assert.ok(!family.includes(name), `${name} is reachable from the IPC layer`);
  }
  // The approval answer is #39 (respond) only, with once or deny.
  const mod = read('src/main/nexusIpc/registerNexusIpc.ts');
  assert.equal((mod.match(/\.respond\(/g) || []).length, 1);
  assert.match(mod, /approvalsOf\(nx\)\.respond\(me, q\.approvalId, q\.decision\)/);
  assert.match(read('src/main/nexusIpc/validate.ts'), /decision\(x: unknown\): 'once' \| 'deny' \{ return V\.enumOf\(x, 'decision', \['once', 'deny'\] as const\); \}/);
});

test('I-P5 the execution IPC port reads logs and previews only after the platform authorizes, and answers not_started without main\'s wiring', async () => {
  const w = execWorld();
  const x = ipcOver(w, { exec: () => null });
  for (const [ch, args] of [['nexus:job:logs', [UNKNOWN, { attempt: 1, fromOffset: 0, maxBytes: 10 }]], ['nexus:version:preview', [w.repoV, { part: 'content', maxBytes: 10 }]],
    ['nexus:blobs:gc', [{ apply: false }]]]) {
    const r = await x.call(ch, ...args);
    assert.deepEqual([r.code, r.reason, r.subReason], ['platform_unavailable', 'execution_unavailable', 'not_started'], ch);
  }
  const port = execIpcPort(w.nx, w.dataHome);
  assert.deepEqual(Object.keys(port).sort(), ['blobsGc', 'logs', 'preview']);
  w.close();
});
