// test/nexus-ui-exec-models.test.cjs
// B2a Task 14: the renderer's execution models (through load-ts) and source pins on the
// components (no jsdom). Named nexus-ui-* (not nexus-exec-*): test:exec runs every
// test/nexus-exec-*.test.cjs under real Docker, and its P6 pin lists exactly four files.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const R = loadTs('src/renderer/src/nexus/runs/jobRunModel.ts');
const EV = loadTs('src/renderer/src/nexus/project/evidenceModel.ts');
const AM = loadTs('src/renderer/src/nexus/project/actionModel.ts');
const X = loadTs('src/renderer/src/nexus/data/executionModel.ts');
const E = loadTs('src/renderer/src/nexus/data/errorCopy.ts');
const C = loadTs('src/renderer/src/nexus/data/nexusClient.ts');

const ROOT = path.join(__dirname, '..');
const NEXUS = path.join(ROOT, 'src', 'renderer', 'src', 'nexus');
const src = (p) => fs.readFileSync(path.join(NEXUS, p), 'utf8');
const GIB = 2 ** 30;
const NOW = 1_800_000_000_000;

const job = (o = {}) => ({
  id: 'J1', kind: 'tool.run', projectId: 'p', workspaceId: 'sde', actionId: 'sde.tests.run', recipeId: 'sde.test.node', state: 'queued', phase: null,
  headline: 'queued', outcome: null, error: null, attempts: 0, retryOf: null, parentJobId: null, requestedByKind: 'user', inputs: [],
  createdAt: NOW, updatedAt: NOW, startedAt: null, finishedAt: null, nextAttemptAt: null, cancelRequested: false, ...o
});
const HEADLINES = ['queued', 'waiting:runner', 'waiting:docker', 'waiting:image', 'waiting:disk', 'waiting:slots', 'waiting:memory', 'waiting:git',
  'waiting:retry', 'provisioning', 'running', 'waiting_for_approval', 'collecting', 'validating', 'checks_passed', 'checks_failed',
  'checks_could_not_run', 'failed', 'cancelled', 'timed_out', 'interrupted'];
const STATE_OF = { checks_passed: 'completed', checks_failed: 'completed', checks_could_not_run: 'completed', failed: 'failed', cancelled: 'cancelled',
  timed_out: 'timed_out', interrupted: 'interrupted', provisioning: 'leased', running: 'running', waiting_for_approval: 'awaiting_approval',
  collecting: 'running', validating: 'completed', 'waiting:retry': 'retry_scheduled' };

// ---------- U-R1, U-R2 ----------

test('U-R1 every headline maps to a stage strip and one plain sentence; the brief sentences exactly', () => {
  for (const h of HEADLINES) {
    const v = R.jobRun(job({ headline: h, state: STATE_OF[h] ?? 'queued', startedAt: NOW }));
    assert.equal(v.stages.length, 6, h);
    assert.ok(v.stages.every((s) => typeof s.label === 'string' && s.label && R.STAGE_STATE_TEXT[s.state]), h);
    assert.ok(v.headline.length > 3 && !/\n/.test(v.headline), h);
    assert.ok(v.word.length > 0, `${h} has a status word`);
    assert.doesNotMatch(`${v.headline} ${v.word}`, /complet/i, `${h}: never "Completed"`);
    assert.doesNotMatch(`${v.headline} ${v.word}`, /\d\s*%|percent/i, `${h}: no percentage`);
  }
  assert.equal(R.jobRun(job({ headline: 'checks_failed', state: 'completed' }), { reason: 'No tests were executed.' }).headline,
    'Tests ran; checks failed: no tests were executed');
  assert.equal(R.jobRun(job({ actionId: 'sde.deps.install', recipeId: 'sde.deps.node', headline: 'waiting_for_approval', state: 'awaiting_approval' })).headline,
    'Waiting for your approval to download dependencies');
  assert.equal(R.jobRun(job({ headline: 'waiting:memory' })).headline, 'Waiting: Docker memory is in use by other containers');
});

test('U-R1 a job whose outputs failed their checks never reads completed or passed; stages follow the headline', () => {
  const v = R.jobRun(job({ headline: 'checks_failed', state: 'completed' }));
  assert.equal(v.result, 'failed');
  assert.equal(v.word, 'Checks failed');
  assert.equal(v.stages.find((s) => s.id === 'result').state, 'stopped');
  const ok = R.jobRun(job({ headline: 'checks_passed', state: 'completed' }));
  assert.ok(ok.stages.every((s) => s.state === 'done'));
  assert.equal(ok.headline, 'Tests ran; checks passed');
  const val = R.jobRun(job({ headline: 'validating', state: 'completed' }));
  assert.equal(val.stages.find((s) => s.id === 'validating').state, 'active');
  assert.equal(R.jobRun(job({ headline: 'waiting_for_approval', state: 'awaiting_approval' })).stages.find((s) => s.id === 'running').state, 'waiting');
  // No percentage source exists: the model has no progress input at all.
  assert.doesNotMatch(src('runs/jobRunModel.ts'), /progress\.|\$\{[^}]*\}%/);
});

test('U-R2 Cancel only for live states; Retry only for failed, timed_out, cancelled, interrupted', () => {
  const LIVE = ['queued', 'leased', 'running', 'awaiting_approval', 'retry_scheduled'];
  const ALL = [...LIVE, 'completed', 'partial', 'failed', 'cancelled', 'timed_out', 'interrupted'];
  for (const s of ALL) {
    assert.equal(R.canCancelJob({ state: s, cancelRequested: false }), LIVE.includes(s), s);
    assert.equal(R.canRetryJob({ state: s }), ['failed', 'timed_out', 'cancelled', 'interrupted'].includes(s), s);
  }
  assert.equal(R.canCancelJob({ state: 'running', cancelRequested: true }), false, 'already asked to stop');
  assert.equal(R.jobRun(job({ headline: 'checks_failed', state: 'completed' })).canRetry, false);
});

// ---------- U-E1 ----------

const val = (o = {}) => ({ validatorId: 'sde.tests_pass', blocking: true, status: 'passed', summary: 'All 3 tests passed.', finishedAt: NOW, evidence: [], latestRun: null, history: 1, ...o });

test('U-E1 evidence rows: JUnit counts reported by the framework, 12-character hashes, HTTP probes, git checks, exit facts', () => {
  const v = EV.evidenceView([val({ evidence: [
    { type: 'junit', name: null, value: '3/5 passed, 1 failed, 1 errored' },
    { type: 'hash', name: 'junit.xml', value: 'sha256:0123456789ab' },
    { type: 'exit', name: null, value: 1 }
  ] }), val({ validatorId: 'app.preview_health', evidence: [{ type: 'http', name: '/health', value: 200 }] }),
  val({ validatorId: 'git.head_resolves', evidence: [{ type: 'git', name: null, value: 'a'.repeat(40) }] })], { status: 'candidate' });
  const facts = v.rows.flatMap((r) => r.facts);
  const junit = facts.find((f) => f.kind === 'junit');
  assert.deepEqual([junit.label, junit.value, junit.source], ['Test counts', '3/5 passed, 1 failed, 1 errored', 'Reported by the framework']);
  assert.equal(facts.find((f) => f.kind === 'hash').value, 'sha256:0123456789ab');
  assert.equal(EV.shortHash('f'.repeat(64)), 'f'.repeat(12));
  assert.equal(EV.shortHash(`sha256:${'e'.repeat(64)}`), `sha256:${'e'.repeat(12)}`);
  assert.deepEqual([facts.find((f) => f.kind === 'http').label, facts.find((f) => f.kind === 'http').value], ['GET /health', 'Answered 200']);
  assert.equal(facts.find((f) => f.kind === 'git').value, 'a'.repeat(12));
  assert.equal(facts.find((f) => f.kind === 'exit').value, '1');
  for (const f of facts) assert.ok(f.source.length > 0, `${f.kind} names its source`);
  assert.equal(v.headline, 'Checks passed');
});

test('U-E1 log ranges carry {jobId, offset, length}; the attempt only when the job has one', () => {
  const report = { version: 1, subject: { target: 'job', id: 'J9' }, fields: [
    { name: 'log.frames', value: 12, source: { type: 'log', attemptId: 'A1', offset: 100, length: 50, sha256: 'b'.repeat(64) } },
    { name: 'log.lastLine', value: 'x', source: { type: 'log', attemptId: 'A1', offset: 100, length: 50, sha256: 'b'.repeat(64) } },
    { name: 'container.exitCode', value: 0, source: { type: 'inspect', container: { sha256: 'c'.repeat(64) }, field: 'State.ExitCode' } },
    { name: 'bad', value: 1, source: { type: 'log', offset: -1, length: 5, sha256: 'x' } }
  ] };
  const one = EV.logRangesOf(report, 'J9', 1);
  assert.equal(one.length, 1, 'duplicates and malformed ranges are dropped');
  assert.deepEqual({ jobId: one[0].jobId, offset: one[0].offset, length: one[0].length, attempt: one[0].attempt }, { jobId: 'J9', offset: 100, length: 50, attempt: 1 });
  assert.equal(one[0].sha256, 'b'.repeat(12));
  assert.equal(EV.logRangesOf(report, 'J9', 2)[0].attempt, null);
  assert.deepEqual(EV.logRangesOf(null, 'J9', 1), []);
  const facts = EV.reportFacts(report);
  assert.equal(facts.find((f) => f.name === 'container.exitCode').source, 'docker inspect State.ExitCode');
  assert.equal(facts.find((f) => f.name === 'log.frames').source, 'run log range');
});

test('U-E1 a check that could not run reads "Checks could not run: <reason>" and offers Revalidate on a draft only', () => {
  const rows = [val({ status: 'error', summary: 'The runner was not available.' })];
  const draft = EV.evidenceView(rows, { status: 'draft' });
  assert.equal(draft.headline, 'Checks could not run');
  assert.equal(draft.rows[0].summary, 'Checks could not run: The runner was not available.');
  assert.equal(draft.rows[0].word, 'Could not run');
  assert.equal(draft.revalidate, true);
  assert.equal(EV.evidenceView(rows, { status: 'candidate' }).revalidate, false);
  assert.equal(EV.evidenceView([val({ status: 'failed' })], { status: 'draft' }).headline, 'Checks failed');
  assert.equal(EV.evidenceView([], { status: 'draft' }).headline, 'Checking…');
  assert.equal(EV.evidenceView([], { status: 'active' }).headline, 'No checks recorded');
  // An advisory row is a run result, never the status.
  const adv = EV.evidenceView([val({ validatorId: 'sde.deps.lock_matches', blocking: false, status: null, latestRun: { status: 'passed', summary: 'ok', finishedAt: NOW } })], { status: 'active' });
  assert.equal(adv.rows[0].word, 'Not run yet');
  assert.equal(adv.rows[0].latestRun.word, 'Passed');
  // "Checking…" on a non-draft is never shown (the B1 default validation state is "pending").
  assert.equal(EV.checksWord('pending', 'active'), null);
  assert.equal(EV.checksWord('pending', 'draft'), 'Checking…');
  assert.equal(EV.checksWord('failed', 'failed'), 'Checks failed');
});

// ---------- U-A1 ----------

const READY = { kind: 'ready', advisories: [] };
const SETUP = { kind: 'setup', problems: ['docker_stopped'], profiles: [], text: 't' };
const act = (id, o = {}) => ({ actionId: id, label: id, stepId: null, available: true, reason: null, inputs: [], needsApproval: false, ...o });

test('U-A1 available actions are buttons; unavailable ones are sentences with the setup link; FUTURE actions are absent', () => {
  const list = [
    act('sde.requirement.write', { label: 'Write a requirement', stepId: 'requirement' }),
    act('sde.repository.snapshot', { label: 'Take a repository snapshot', stepId: 'repository', available: false, reason: 'setup:git_missing' }),
    act('sde.build.run', { label: 'Build', stepId: 'build', available: false, reason: 'blocked_by_step:repository', inputs: [{ slot: 'repository', kinds: ['repository'], min: 1, max: 1 }] }),
    act('sde.future.thing', { label: 'Later', available: false, reason: 'future' }),
    act('sde.preview.stop', { label: 'Stop' })
  ];
  const v = AM.actionBar(list, { workspaceId: 'sde', availability: READY, version: null, usableKinds: new Set() });
  assert.deepEqual(v.buttons.map((b) => [b.actionId, b.inline]), [['sde.requirement.write', true]]);
  assert.deepEqual(v.sentences.map((s) => [s.actionId, s.setup]), [['sde.repository.snapshot', true], ['sde.build.run', false]]);
  assert.equal(v.sentences[0].text, 'Take a repository snapshot: Git is not installed, so this cannot run on this computer yet.');
  assert.equal(v.sentences[1].text, 'Build: needs a ready version from the Repository step first.');
  const all = JSON.stringify(v);
  assert.doesNotMatch(all, /Later|sde\.future/, 'a FUTURE action is not present at all');
});

test('U-A1 a button needs the machine ready, a usable input and a step in this release (defence in depth)', () => {
  const tests = act('sde.tests.run', { label: 'Run tests on a commit', stepId: 'tests', inputs: [{ slot: 'suite', kinds: ['test_suite'], min: 1, max: 1 }] });
  // While the setup fails, a Docker action that main still listed as available is a sentence.
  const off = AM.actionBar([tests], { workspaceId: 'sde', availability: SETUP, version: { kind: 'test_suite', status: 'candidate' }, usableKinds: new Set(['test_suite']) });
  assert.equal(off.buttons.length, 0);
  assert.equal(off.sentences[0].setup, true);
  const on = AM.actionBar([tests], { workspaceId: 'sde', availability: READY, version: { kind: 'test_suite', status: 'candidate' }, usableKinds: new Set(['test_suite']) });
  assert.deepEqual(on.buttons.map((b) => [b.actionId, b.slot]), [['sde.tests.run', 'suite']]);
  const draft = AM.actionBar([tests], { workspaceId: 'sde', availability: READY, version: { kind: 'test_suite', status: 'draft' }, usableKinds: new Set() });
  assert.equal(draft.buttons.length, 0, 'a draft is not an input');
  const other = AM.actionBar([tests], { workspaceId: 'sde', availability: READY, version: { kind: 'build', status: 'candidate' }, usableKinds: new Set() });
  assert.deepEqual([other.buttons.length, other.sentences.length], [0, 0], 'not an action on this version');
  // A step marked FUTURE in the registry never gives a button, whatever the answer says.
  const fut = AM.actionBar([act('sde.requirement.write', { stepId: 'ai-implementation' })], { workspaceId: 'sde', availability: READY, version: null, usableKinds: new Set() });
  assert.equal(fut.buttons.length + fut.sentences.length, 0);
});

// ---------- U-AP1 ----------

const approval = (o = {}) => ({
  id: 'AP1', projectId: 'p', jobId: 'J1', reason: 'egress.deps', summary: 'Download the npm packages named in package-lock.json once.', status: 'pending',
  request: { recipeId: 'sde.deps.node', profile: 'sde-node', registries: ['registry.npmjs.org'], lockfileSha256: 'd'.repeat(64), estimatedBytes: 300 * 2 ** 20 },
  requestedAt: NOW - 60_000, expiresAt: NOW + 14 * 60_000, decidedAt: null, decision: null, consumedAt: null, imageBuild: null, ...o
});

test('U-AP1 approval rows show what is reached or downloaded, the size and the expiry, and only "Approve once" / "Deny"', () => {
  const fmt = () => '14:32';
  const v = AM.approvalRow(approval(), NOW, fmt);
  assert.equal(v.title, 'Download dependencies');
  assert.equal(v.summary, 'Download the npm packages named in package-lock.json once.', 'the DTO wording, unchanged');
  assert.deepEqual(v.facts.find((f) => f.label === 'Reaches'), { label: 'Reaches', value: 'registry.npmjs.org' });
  assert.equal(v.facts.find((f) => f.label === 'Download size').value, 'about 0.2 GB');
  assert.equal(v.facts.find((f) => f.label === 'Lockfile').value, `sha256:${'d'.repeat(12)}`);
  assert.equal(v.expires, 'Expires at 14:32 (in 14 min)');
  assert.deepEqual(v.answers, ['Approve once', 'Deny']);
  for (const s of ['approved', 'denied', 'expired', 'withdrawn']) assert.deepEqual(AM.approvalRow(approval({ status: s, decidedAt: NOW }), NOW, fmt).answers, [], s);
  assert.deepEqual(AM.approvalRow(approval({ expiresAt: NOW - 1 }), NOW, fmt).answers, [], 'a lapsed request offers nothing');
  const img = AM.approvalRow(approval({ reason: 'image.prepare', request: { profile: 'sde-python', estimatedBytes: 600 * 2 ** 20, contextSha256: 'e'.repeat(64) } }), NOW, fmt);
  assert.equal(img.title, 'Prepare the sde-python image');
  // No "always", no "for this session" anywhere in the approval UI.
  const ui = src('project/ApprovalsSection.tsx');
  assert.doesNotMatch(ui, /always|for (the|this) session/i);
  assert.match(ui, /nexusClient\.approvalRespond\(id, decision\)/);
  assert.match(ui, /answer\(a\.id, 'once'\)/);
  assert.match(ui, /answer\(a\.id, 'deny'\)/);
});

// ---------- U-H1 to U-H5 ----------

const health = (o = {}) => ({
  db: { version: 9, platform: true, handoffs: true, execution: true }, registry: { valid: true, problems: 0 },
  runner: { state: 'ready', attached: true, restarts: 0 },
  docker: { state: 'running', version: '29.1.3', cpus: 8, memoryBytes: 8 * GIB },
  images: [{ profile: 'sde-node', present: true, matches: true, sizeBytes: GIB, imageIdShort: 'sha256:0123456789ab' }],
  disk: { dataHomeFreeBytes: 52 * GIB, requiredBytes: 30 * GIB, recommendedBytes: 40 * GIB, leaseFloorBytes: 5 * GIB, gate: 'ok' },
  problems: [], gpu: { detected: false, supported: false }, checkedAt: NOW, ...o
});
const rowOf = (h, id, ctx) => X.setupSheet(h, ctx).find((r) => r.id === id);

test('U-H1 disk below the gate: the exact numbers and what to do', () => {
  const h = health({ disk: { dataHomeFreeBytes: 18 * GIB, requiredBytes: 30 * GIB, recommendedBytes: 40 * GIB, leaseFloorBytes: 5 * GIB, gate: 'below_required' }, problems: ['disk_low'] });
  const r = rowOf(h, 'disk');
  assert.equal(r.text, 'Free disk is 18 GB; execution needs 30 GB (40 GB recommended)');
  assert.equal(r.state, 'problem');
  assert.match(r.action, /Free up space/);
  assert.equal(r.word, 'Needs attention');
  const a = X.availabilityFrom({ unavailable: null }, { ok: true, data: h });
  assert.equal(a.kind, 'setup');
  assert.deepEqual(a.problems, ['disk_low']);
  // 35 GB: it runs, below the recommendation (never stated as a problem).
  const mid = rowOf(health({ disk: { ...h.disk, dataHomeFreeBytes: 35 * GIB, gate: 'below_recommended' } }), 'disk');
  assert.deepEqual([mid.state, mid.text], ['advisory', 'Free disk is 35 GB; execution needs 30 GB (40 GB recommended)']);
  assert.equal(X.gb(18.96 * GIB), '18.9 GB', 'free space is never rounded up');
});

test('U-H2 Docker stopped: a problem with the action, and no image can be prepared', () => {
  const h = health({ docker: { state: 'stopped' }, images: [{ profile: 'sde-node', present: false, matches: false }], problems: ['docker_stopped'] });
  const d = rowOf(h, 'docker');
  assert.deepEqual([d.state, d.text, d.action], ['problem', 'Docker is not running.', 'Start Docker Desktop, then check again.']);
  assert.equal(rowOf(h, 'image:sde-node').prepare, null);
  assert.equal(X.availabilityFrom({ unavailable: null }, { ok: true, data: h }).kind, 'setup');
  assert.equal(rowOf(health({ docker: { state: 'missing' } }), 'docker').text, 'Docker is not installed.');
});

test('U-H3 Docker memory low: the numbers and where to change it', () => {
  const r = rowOf(health({ docker: { state: 'running', cpus: 4, memoryBytes: 2 * GIB }, problems: ['docker_memory_low'] }), 'memory');
  assert.deepEqual([r.state, r.text], ['problem', 'Docker has 2 GB of memory; execution needs 4 GB.']);
  assert.match(r.action, /Docker Desktop settings/);
});

test('U-H4 image missing: "Prepare image (≈ <size>)" only with a stated size, and only when it can be asked', () => {
  const h = health({ images: [{ profile: 'sde-python', present: false, matches: false }], problems: ['image_missing:sde-python'] });
  assert.deepEqual(rowOf(h, 'image:sde-python').prepare, { profile: 'sde-python', label: 'Prepare image' }, 'no size without a source');
  const sized = rowOf(h, 'image:sde-python', { estimates: new Map([['sde-python', 0.6 * GIB]]) });
  assert.equal(sized.prepare.label, 'Prepare image (≈ 0.6 GB)');
  assert.equal(rowOf(h, 'image:sde-python', { pending: new Set(['sde-python']) }).prepare, null, 'an open request is answered instead');
  const a = X.availabilityFrom({ unavailable: null }, { ok: true, data: h });
  assert.deepEqual([a.kind, a.problems, a.profiles], ['setup', ['image_missing'], ['sde-python']]);
  assert.equal(X.prepareLabel(GIB, true), 'Prepare image again (≈ 1 GB)');
});

test('U-H5 the GPU line, exactly', () => {
  assert.equal(X.gpuLine({ detected: true, model: 'RTX 3050 Laptop', supported: false }), 'GPU detected (RTX 3050 Laptop), not supported in this release');
  assert.equal(X.gpuLine({ detected: false, supported: false }), 'No GPU detected');
  assert.equal(rowOf(health({ gpu: { detected: true, model: 'RTX 3050 Laptop', supported: false } }), 'gpu').text, 'GPU detected (RTX 3050 Laptop), not supported in this release');
  assert.equal(rowOf(health(), 'gpu').prepare, null);
});

test('availability: platform off, execution off for every sub-reason (including a channel main never registered), ready', () => {
  assert.equal(X.availabilityFrom({ unavailable: { reason: 'held' } }, null).kind, 'platform_off');
  assert.equal(X.availabilityFrom({ unavailable: null }, null).kind, 'unknown');
  for (const sub of ['held', 'auto_held', 'backup_failed', 'failed', 'shape', 'not_enabled', 'v8_unavailable', 'registry_invalid', 'not_started', 'unreachable']) {
    const a = X.availabilityFrom({ unavailable: null }, { ok: false, code: 'platform_unavailable', reason: 'execution_unavailable', subReason: sub, message: 'm' });
    assert.equal(a.kind, 'execution_off', sub);
    assert.equal(a.text, E.executionNotice(sub));
    assert.doesNotMatch(a.text, /\b[a-z]+_[a-z_]+\b/, `${sub}: no raw reason`);
  }
  assert.equal(X.availabilityFrom({ unavailable: null }, { ok: true, data: health({ db: { version: 9, platform: true, handoffs: true, execution: false, subReason: 'held' } }) }).subReason, 'held');
  assert.equal(X.availabilityFrom({ unavailable: null }, { ok: true, data: health({ registry: { valid: false, problems: 2 } }) }).subReason, 'registry_invalid');
  assert.equal(X.availabilityFrom({ unavailable: null }, { ok: true, data: health() }).kind, 'ready');
  assert.equal(X.noticeFor({ kind: 'ready', advisories: [] }), null);
  assert.deepEqual(X.noticeFor({ kind: 'execution_off', subReason: 'unreachable', text: 'x' }), { text: 'x', setup: false });
});

test('a rejected or unregistered execution call answers "execution unreachable", never a throw', async () => {
  global.window = { cth: { nexusJobsList: () => Promise.reject(new Error("No handler registered for 'nexus:jobs:list'")) } };
  try {
    const r = await C.nexusClient.jobsList({ projectId: 'p' });
    assert.deepEqual([r.ok, r.code, r.reason, r.subReason], [false, 'platform_unavailable', 'execution_unavailable', 'unreachable']);
    const missing = await C.nexusClient.platformHealth();
    assert.equal(missing.subReason, 'unreachable', 'a method the preload lacks');
    assert.equal(typeof C.nexusClient.onHint(() => {}), 'function', 'no push channel: a no-op unsubscribe');
    assert.equal(E.errorCopy('platform_unavailable', 'execution_unavailable', 'unreachable').kind, 'execution_unavailable');
  } finally { delete global.window; }
  assert.match(C.newIntentId(), /^[0-9A-HJKMNP-TV-Z]{26}$/);
});

test('the setup sentences are main\'s, word for word', () => {
  const { SETUP_MESSAGES } = loadTs('src/main/nexusIpc/envelope.ts');
  assert.deepEqual({ ...E.SETUP_TEXT }, { ...SETUP_MESSAGES });
  assert.equal(E.execFailText({ code: 'unavailable', reason: 'setup:docker_stopped' }), SETUP_MESSAGES.docker_stopped);
  // errorCopy itself keeps the generic sentence for `unavailable` (AR2 in nexus-platform-exec-approvals pins it).
  assert.equal(E.errorCopy('unavailable', 'setup:disk_low').text, 'That cannot run on this computer right now. Check the setup notes for what it needs.');
  assert.equal(E.errorCopy('invalid', 'queue_full').text, E.EXEC_REASON_TEXT.queue_full);
});

// ---------- U-D1 ----------

const dep = (o = {}) => ({ id: 'D1', projectId: 'p', subjectVersionId: 'V1', jobId: 'J1', status: 'healthy', stopReason: null, url: 'http://127.0.0.1:49152/health',
  bindAddress: '127.0.0.1', hostPort: 49152, healthPath: '/health', lastProbe: { at: NOW, status: 200, ms: 12 }, probes: 4, startedAt: NOW, stoppedAt: null, endsAt: NOW + 7_200_000, ...o });

test('U-D1 deployment rows: a URL only while healthy or unhealthy, always http://127.0.0.1:<port>; status words', () => {
  const fmt = () => '10:00';
  for (const [status, word] of [['starting', 'Starting'], ['healthy', 'Healthy'], ['unhealthy', 'Not answering its health check'], ['stopped', 'Stopped'], ['failed', 'Failed']]) {
    const v = AM.deploymentRow(dep({ status }), fmt);
    assert.equal(v.word, word, status);
    assert.equal(v.url, status === 'healthy' || status === 'unhealthy' ? 'http://127.0.0.1:49152' : null, status);
    assert.equal(v.canStop, ['starting', 'healthy', 'unhealthy'].includes(status), status);
  }
  // Never another host, whatever the view says.
  assert.equal(AM.deploymentRow(dep({ url: 'http://0.0.0.0:80/', hostPort: 80 })).url, 'http://127.0.0.1:80');
  assert.equal(AM.deploymentRow(dep({ hostPort: null })).url, null);
  assert.equal(AM.deploymentRow(dep({ hostPort: 70000 })).url, null);
  assert.match(AM.deploymentRow(dep(), fmt).facts[0].value, /answered 200 in 12 ms at 10:00 \(\/health\)/);
});

// ---------- hints: coalesced, only the affected lists ----------

test('a page of events re-reads only the lists it touches', () => {
  const t = (type, summary = 'x') => ({ type, summary });
  assert.deepEqual([...X.affectedLists([t('approval')])].sort(), ['approvals', 'jobs']);
  assert.deepEqual([...X.affectedLists([t('attempt.progress'), t('attempt.output')])], ['jobs']);
  assert.deepEqual([...X.affectedLists([t('job.transition', 'job running -> completed')])].sort(), ['artifacts', 'jobs', 'validations']);
  assert.deepEqual([...X.affectedLists([t('job.transition', 'job queued -> leased')])], ['jobs']);
  assert.deepEqual([...X.affectedLists([t('deployment')])].sort(), ['artifacts', 'deployments']);
  const hook = src('data/useExecution.ts');
  assert.match(hook, /export const HINT_COALESCE_MS = 300;/);
  assert.match(hook, /if \(!timer && !pulling\) timer = setTimeout/, 'one pull at a time, coalesced');
  assert.equal((hook.match(/nexusClient\.onHint\(/g) || []).length, 1, 'one subscription shared by every hook');
});

// ---------- writing sheet content ----------

test('a requirement and a problem statement are built to the schemas main checks', () => {
  assert.deepEqual(AM.requirementContent({ title: ' T ', body: '', criteria: [{ id: 'C1', text: ' a ' }, { id: 'C2', text: '' }] }),
    { content: { title: 'T', criteria: [{ id: 'C1', text: 'a' }] } });
  assert.equal(AM.requirementContent({ title: 'T', body: '', criteria: [{ id: 'C1', text: '' }] }).problem, 'Add at least one acceptance criterion.');
  assert.equal(AM.nextCriterionId([{ id: 'C1' }, { id: 'C3' }]), 'C4');
  assert.deepEqual(AM.problemContent({ question: 'Why?', context: '', audience: '', successCriteria: ['a', ' '], constraints: [] }),
    { content: { question: 'Why?', successCriteria: ['a'] } });
});

// ---------- pins ----------

const NEW_FILES = ['data/useExecution.ts', 'data/executionModel.ts', 'runs/jobRunModel.ts', 'runs/JobLogSheet.tsx', 'project/evidenceModel.ts',
  'project/EvidenceSection.tsx', 'project/kindViewers.tsx', 'project/ActionBar.tsx', 'project/ApprovalsSection.tsx', 'project/DeploymentsSection.tsx',
  'project/RequirementSheet.tsx', 'project/actionModel.ts', 'project/execContext.ts', 'components/ExecutionSetupSheet.tsx', 'components/ExecutionNotice.tsx',
  'styles/execution.css'];

test('pin: ProjectRuns still renders the session requests (useRuns) under the persisted Jobs', () => {
  const runs = src('runs/ProjectRuns.tsx');
  assert.match(runs, /useRuns\(\)\.filter\(\(e\) => e\.request\.projectId === projectId\)\.reverse\(\)/);
  assert.match(runs, /<RunStrip/);
  assert.ok(runs.indexOf('<JobsSection') < runs.indexOf('<RunStrip'), 'Jobs above the requests');
  assert.match(runs, /nexusClient\.jobCancel\(job\.id\)/);
  assert.match(runs, /nexusClient\.jobRetry\(job\.id, id\)/);
});

test('pin: no new file holds card, dashboard, gradient, percentage text, office words or persona names; no peer imports', () => {
  const { copyItems, scanText } = require('./helpers/identityGuard.cjs');
  for (const f of NEW_FILES) {
    const s = src(f);
    assert.doesNotMatch(s, /\bcards?\b|-card\b|Card\b|dashboard|gradient/i, f);
    assert.doesNotMatch(s, /routes\/RouteView|WelcomePage|hairline|from '\.\.\/state\/uiStore'/, `${f}: no peer import`);
    if (f.endsWith('.css')) continue;
    // Shown text only (string literals and JSX text), with the identity guard's own rules.
    for (const it of copyItems(path.join(NEXUS, f))) {
      assert.deepEqual(scanText(it.text, true), [], `${f}: ${it.text}`);
      assert.doesNotMatch(it.text, /\d\s*%|^%|percent/i, `${f}: no percentage text: ${it.text}`);
    }
  }
});

test('pin: status is always a word in the models (never a colour-only state)', () => {
  for (const h of HEADLINES) assert.ok(R.jobRun(job({ headline: h })).word, h);
  for (const r of X.setupSheet(health({ docker: { state: 'stopped' } }))) assert.ok(r.word && r.text, r.id);
  for (const s of ['passed', 'failed', 'error', 'skipped', null]) assert.ok(EV.statusWord(s), String(s));
  // The CSS keys a state only on rows that also print their word.
  assert.match(src('components/ExecutionSetupSheet.tsx'), /data-state=\{r\.state\}>[\s\S]*?<span className="nx-xs__word">\{r\.word\}<\/span>/);
});

test('pin: execution.css is imported and uses only existing tokens', () => {
  assert.match(src('styles/index.css'), /@import '\.\/execution\.css';/);
  const css = src('styles/execution.css');
  const tokens = src('styles/tokens.css');
  for (const v of new Set(css.match(/var\(--nx-[a-z0-9-]+\)/g) || [])) assert.ok(tokens.includes(`${v.slice(4, -1)}:`), v);
});

test('pin: the bench lends the Folio its sheets and mounts the notice and the approvals', () => {
  const bench = src('project/ProjectBench.tsx');
  assert.match(bench, /<ExecutionUiContext\.Provider value=\{execUi\}>/);
  assert.match(bench, /<ExecutionNotice availability=\{availability\} onSetup=\{execUi\.openSetup\} \/>/);
  assert.match(bench, /<ApprovalsSection projectId=\{project\.id\} \/>/);
  const passport = src('project/ArtifactPassport.tsx');
  for (const c of ['<KindViewer', '<EvidenceSection', '<ActionBar', '<DeploymentsSection']) assert.ok(passport.includes(c), c);
});
