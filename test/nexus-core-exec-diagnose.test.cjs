'use strict';
// B2a Task 12: the diagnosis (A1) and node:test's per-file attribution (A5), piece by piece. Plain node: the runner's
// diagnose engine over the fake sandbox driver and real log files, main's re-validation and report, diag.schema, and the
// runner's per-file JUnit merge over real files. (The whole chain runs in nexus-platform-exec-recipes X2, X4 and X8.)
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');
const { FakeSandboxDriver } = require('./helpers/fakeSandboxDriver.cjs');

const { diagnose, diagnoseTaskProblem, ERROR_FRAME_RE } = loadTs('src/runner/diagnose.ts');
const { HomePaths } = loadTs('src/runner/paths.ts');
const { containerFacts } = loadTs('src/runner/sandbox/dockerDriver.ts');
const { checkDiagnosis } = loadTs('src/main/nexus/validation/normalized.ts');
const { buildDiagnosticReport } = loadTs('src/main/nexus/exec/diagnosticReport.ts');
const diag = loadTs('src/main/nexus/validation/validators/diagSchema.ts');
const { mergePerFileJunit, perFileReportName, isSyntheticFileCase } = loadTs('src/runner/junitMerge.ts');
const { parseJunit } = loadTs('src/runner/parsers/junit.ts');
const { containsSecret } = loadTs('src/main/nexus/activity/redact.ts');
const { parseRunnerMessage } = loadTs('src/shared/nexus/runnerProtocol.ts');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'nx-diag-'));
test.after(() => fs.rmSync(TMP, { recursive: true, force: true }));
const HEX = (c) => c.repeat(64);
const JOB = '01K7A0J0B000000000000000AA';
const ATT = '01K7A0ATTEMPT0000000000AAA';

function home() {
  const root = fs.mkdtempSync(path.join(TMP, 'home-'));
  fs.mkdirSync(path.join(root, 'logs', 'jobs', JOB), { recursive: true });
  return new HomePaths(root);
}
const frame = (stream, text) => `${JSON.stringify({ ts: 1, stream, text })}\n`;
const facts = () => containerFacts({ State: { Status: 'running', ExitCode: 0, OOMKilled: false, StartedAt: '2026-10-10T10:00:00Z', FinishedAt: '0001-01-01T00:00:00Z' },
  RestartCount: 0, Image: `sha256:${HEX('a')}`, Config: { User: '10001:10001', Env: ['SECRET=nope'] },
  HostConfig: { NanoCpus: 1e9, Memory: 1024 * 2 ** 20, PidsLimit: 512, NetworkMode: 'nexus-svc-x', ReadonlyRootfs: true,
    PortBindings: { '8080/tcp': [{ HostIp: '127.0.0.1', HostPort: '49200' }] } } });

test('DG1 containerFacts takes the fixed fact set only (never the environment or labels); ids are digests under sha256 keys', () => {
  const f = facts();
  assert.deepEqual(f, { state: 'running', exitCode: 0, oomKilled: false, restartCount: 0, startedAt: '2026-10-10T10:00:00Z', finishedAt: null,
    image: { sha256: HEX('a') }, nanoCpus: 1e9, memoryBytes: 1024 * 2 ** 20, pidsLimit: 512, networkMode: 'nexus-svc-x', readonlyRootfs: true,
    user: '10001:10001', publishedPorts: ['127.0.0.1:49200->8080/tcp'] });
  assert.ok(!JSON.stringify(f).includes('SECRET'));
  assert.equal(containerFacts({ State: { Status: 'weird' } }).state, 'unknown');
});

test('DG2 the runner\'s diagnose: this install\'s container inspected, another\'s not_owned, a missing one missing, Docker down unavailable; log tails hashed with frame counts and a redacted last line', async () => {
  const paths = home();
  const label = 'abcdef0123456789';
  const driver = new FakeSandboxDriver();
  const owned = HEX('1'); const foreign = HEX('2');
  driver.extra.push({ kind: 'container', id: owned, name: 'nexus-a', labels: { 'nexus.home': label, 'nexus.attempt': ATT }, state: 'running' },
    { kind: 'container', id: foreign, name: 'db', labels: { app: 'mine' }, state: 'running' });
  const log = paths.logPath(JOB, 1);
  const body = frame('nexus', 'started') + frame('stdout', 'listening on 3000') + frame('stderr', 'Error: boom') + frame('stdout', 'token sk-ant-api03-' + 'x'.repeat(40));
  fs.writeFileSync(log, body);
  const task = { engine: 'sde.diagnose', target: 'deployment', containerIds: [owned, foreign, HEX('3')],
    logRanges: [{ attemptId: ATT, logPath: log, offset: 0, length: 1 << 16, tail: true }, { attemptId: ATT, logPath: log, offset: 5, length: 1 << 16, tail: false }] };
  assert.equal(diagnoseTaskProblem(task), null);
  const r = await diagnose({ driver, fs: fsp, paths, home: label }, task, new AbortController().signal);
  assert.deepEqual(r.containers.map((c) => c.status), ['inspected', 'not_owned', 'missing']);
  assert.equal(r.containers[0].facts.state, 'running');
  assert.equal(r.containers[1].facts, null);
  const [tail, mid] = r.logs;
  assert.deepEqual([tail.status, tail.offset, tail.length, tail.frames, tail.errorFrames], ['read', 0, Buffer.byteLength(body), 4, 1]);
  assert.equal(tail.sha256, require('node:crypto').createHash('sha256').update(body).digest('hex'));
  assert.ok(!/sk-ant-api03-x/.test(tail.lastText), `redacted: ${tail.lastText}`);
  assert.equal(mid.frames, 3, 'a frame cut by the range start is not counted');
  assert.equal(containsSecret(r), false, 'nothing in the result reads as a secret (ids are under sha256 keys)');
  const down = await diagnose({ driver: new FakeSandboxDriver({ inspectFactsThrows: true }), fs: fsp, paths, home: label }, { ...task, logRanges: [] }, new AbortController().signal);
  assert.deepEqual(down.containers.map((c) => c.status), ['unavailable', 'unavailable', 'unavailable']);
  // Refused: a log outside the data home or not an attempt log; malformed tasks.
  const out = await diagnose({ driver, fs: fsp, paths, home: label }, { ...task, containerIds: [], logRanges: [{ ...task.logRanges[0], logPath: path.join(TMP, 'x.log') }] }, new AbortController().signal);
  assert.equal(out.logs[0].status, 'refused');
  const missing = await diagnose({ driver, fs: fsp, paths, home: label }, { ...task, containerIds: [], logRanges: [{ ...task.logRanges[0], logPath: paths.logPath(JOB, 2) }] }, new AbortController().signal);
  assert.equal(missing.logs[0].status, 'missing');
  assert.match(diagnoseTaskProblem({ ...task, target: 'host' }), /target/);
  assert.match(diagnoseTaskProblem({ ...task, logRanges: [{ ...task.logRanges[0], length: 10 * 2 ** 20 }] }), /out of bounds/);
  assert.match(diagnoseTaskProblem({ ...task, logRanges: [{ ...task.logRanges[0], tail: 'yes' }] }), /malformed/);
  assert.ok(ERROR_FRAME_RE.test('Traceback (most recent call last)'));
});

test('DG3 main re-validates the diagnosis (checkDiagnosis) and refuses any bad shape as parser_contract', () => {
  const good = { target: 'deployment', containers: [{ container: { sha256: HEX('1') }, status: 'inspected', facts: facts() }, { container: { sha256: HEX('2') }, status: 'missing', facts: null }],
    logs: [{ attemptId: ATT, status: 'read', offset: 0, length: 10, sha256: HEX('b'), frames: 2, errorFrames: 1, lastText: 'ok' }, { attemptId: ATT, status: 'missing', offset: 0, length: 0, sha256: null, frames: 0, errorFrames: 0, lastText: null }] };
  assert.equal(checkDiagnosis(good).ok, true);
  const bad = (mut) => { const x = JSON.parse(JSON.stringify(good)); mut(x); return checkDiagnosis(x); };
  for (const [name, mut] of Object.entries({
    target: (x) => { x.target = 'host'; }, id: (x) => { x.containers[0].container.sha256 = 'zz'; }, plainId: (x) => { x.containers[0].container = HEX('1'); },
    factsOnMissing: (x) => { x.containers[1].facts = facts(); }, noFacts: (x) => { x.containers[0].facts = null; }, status: (x) => { x.containers[0].status = 'hidden'; },
    readNoHash: (x) => { x.logs[0].sha256 = null; }, hashOnMissing: (x) => { x.logs[1].sha256 = HEX('c'); }, frames: (x) => { x.logs[0].errorFrames = 3; },
    tooLong: (x) => { x.logs[0].length = 10 * 2 ** 20; }, many: (x) => { x.containers = [...x.containers, ...x.containers, x.containers[0]]; },
    lastText: (x) => { x.logs[0].lastText = 'x'.repeat(201); }, image: (x) => { x.containers[0].facts.image = `sha256:${HEX('a')}`; }
  })) assert.deepEqual([name, bad(mut).ok], [name, false]);
});

test('DG4 the report: every field names its source and points at its evidence; diag.schema passes it and fails a claimed source without its pointer', () => {
  const d = checkDiagnosis({ target: 'deployment', containers: [{ container: { sha256: HEX('1') }, status: 'inspected', facts: facts() }],
    logs: [{ attemptId: ATT, status: 'read', offset: 0, length: 40, sha256: HEX('b'), frames: 3, errorFrames: 1, lastText: 'listening' },
      { attemptId: ATT, status: 'refused', offset: 0, length: 0, sha256: null, frames: 0, errorFrames: 0, lastText: null }] }).value;
  const r = buildDiagnosticReport(d, 'DEP1', { path: '/health', probes: [{ at: 1, status: 503, ms: 9 }, { at: 2, status: 200, ms: 4 }] });
  assert.deepEqual([...new Set(r.fields.map((f) => f.source.type))].sort(), ['http', 'inspect', 'log']);
  const by = Object.fromEntries(r.fields.map((f) => [f.name, f]));
  assert.equal(by['container.state'].value, 'running');
  assert.deepEqual(by['container.state'].source, { type: 'inspect', container: { sha256: HEX('1') }, field: 'State.Status' });
  assert.equal(by['container.limits.cpus'].value, 1);
  assert.deepEqual([by['health.lastStatus'].value, by['health.probes'].value, by['health.answered200'].value], [200, 2, 1]);
  assert.deepEqual(by['log.frames'].source, { type: 'log', attemptId: ATT, offset: 0, length: 40, sha256: HEX('b') }, 'the one readable range has no index');
  assert.equal(r.fields.filter((f) => f.source.type === 'log').length, 3, 'an unreadable range has no field');
  assert.equal(diag.run(r).status, 'passed');
  assert.equal(containsSecret(r), false);
  // A container not inspected gives only its status, sourced as what it is (never inspect evidence). Fix round 1, item 3:
  // a status-only report observed nothing, so it FAILS (it passed before the fix).
  const m = buildDiagnosticReport(checkDiagnosis({ target: 'job', containers: [{ container: { sha256: HEX('1') }, status: 'missing', facts: null }], logs: [] }).value, 'J', null);
  assert.deepEqual(m.fields.map((f) => [f.name, f.value]), [['container.status', 'missing']]);
  assert.deepEqual(m.fields[0].source, { type: 'unobserved', container: { sha256: HEX('1') }, why: 'missing' });
  assert.deepEqual([diag.run(m).status, diag.run(m).reason], ['failed', 'nothing_observed']);
  // The reviewer's case: Docker down, no log read: one `unavailable` status, never sourced as inspect/State; it fails.
  for (const status of ['unavailable', 'not_owned']) {
    const u = buildDiagnosticReport(checkDiagnosis({ target: 'deployment', containers: [{ container: { sha256: HEX('1') }, status, facts: null }],
      logs: [{ attemptId: ATT, status: 'missing', offset: 0, length: 0, sha256: null, frames: 0, errorFrames: 0, lastText: null }] }).value, 'D', { path: '/health', probes: [] });
    assert.deepEqual(u.fields.map((f) => [f.name, f.value, f.source.type]), [['container.status', status, 'unobserved']], status);
    assert.equal(diag.run(u).status, 'failed', status);
    assert.match(diag.run(u).summary, /observed nothing/);
    // Claimed as inspect evidence instead, it still fails.
    const claimed = { fields: [{ name: 'container.status', value: status, source: { type: 'inspect', container: { sha256: HEX('1') }, field: 'State' } }] };
    assert.equal(diag.run(claimed).status, 'failed', `${status} under an inspect source`);
    assert.ok(diag.run(claimed).evidence[0].errors.some((e) => /never sourced as inspect evidence/.test(e.message)));
  }
  // An observed report passes: a status-only container beside a log range that was read, or beside a probe result.
  const withLog = buildDiagnosticReport(checkDiagnosis({ target: 'job', containers: [{ container: { sha256: HEX('1') }, status: 'unavailable', facts: null }],
    logs: [{ attemptId: ATT, status: 'read', offset: 0, length: 40, sha256: HEX('b'), frames: 3, errorFrames: 0, lastText: 'ok' }] }).value, 'J', null);
  assert.equal(diag.run(withLog).status, 'passed');
  const withProbe = buildDiagnosticReport(checkDiagnosis({ target: 'deployment', containers: [{ container: { sha256: HEX('1') }, status: 'missing', facts: null }], logs: [] }).value,
    'D', { path: '/health', probes: [{ at: 5, status: 200, ms: 3 }] });
  assert.equal(diag.run(withProbe).status, 'passed');
  assert.equal(diag.run(r).status, 'passed', 'the inspected report passes');
  // Nothing observed: no field, and the schema fails it (an honestly empty report never passes).
  assert.equal(diag.run(buildDiagnosticReport(checkDiagnosis({ target: 'job', containers: [], logs: [] }).value, 'J', null)).status, 'failed');
  for (const field of [
    { name: 'a', value: 1, source: { type: 'inspect' } }, { name: 'a', value: 1, source: { type: 'inspect', container: { sha256: 'x' }, field: 'F' } },
    { name: 'a', value: 1, source: { type: 'http', at: 1 } }, { name: 'a', value: 1, source: { type: 'log', attemptId: ATT, offset: 0, length: 1 } },
    { name: 'a', value: { other: 1 }, source: { type: 'http', path: '/h', at: 1 } }, { name: 'a', value: 1, source: { type: 'guess' } }
  ]) assert.equal(diag.run({ fields: [field] }).status, 'failed', JSON.stringify(field));
});

test('DG5 the per-file merge (A5): reports attributed by the plan\'s order; a missing or broken report gives no case; node\'s synthetic "file ran" case dropped only when it is the only passing case; counts carried', async () => {
  const out = fs.mkdtempSync(path.join(TMP, 'out-'));
  const root = TMP;
  assert.deepEqual(await mergePerFileJunit(fsp, root, out, ['a.test.js']), { merged: false, notes: [], cases: 0 }, 'no junit folder: nothing merged');
  fs.mkdirSync(path.join(out, 'junit'));
  const files = ['test/a.test.js', 'test/b.test.js', 'test/c.test.js', 'test/d.test.js', 'test/e.test.js'];
  const w = (i, xml) => fs.writeFileSync(path.join(out, 'junit', perFileReportName(i)), xml);
  w(0, '<testsuites><testcase name="a1" classname="test"/><testcase name="a2" classname="test"><failure message="x"/></testcase><!-- tests 2 --></testsuites>');
  w(1, '<testsuites><testcase name="/workspace/test/b.test.js" classname="test"/><!-- tests 1 --></testsuites>');
  w(2, 'not xml at all <');
  // d: missing. e: a load failure is reported as a failing file-named case and is kept.
  w(4, '<testsuites><testcase name="/workspace/test/e.test.js" classname="test"><failure message="SyntaxError"/></testcase><!-- tests 1 --></testsuites>');
  const m = await mergePerFileJunit(fsp, root, out, files);
  assert.equal(m.merged, true);
  assert.deepEqual(m.notes, ['test/b.test.js declares no test', 'test/c.test.js: its report was refused (unparsable)', 'test/d.test.js: no report was written']);
  const j = parseJunit(fs.readFileSync(path.join(out, 'junit.xml')));
  assert.ok(j.ok);
  assert.deepEqual(j.value.cases.map((c) => [c.file, c.name, c.outcome]),
    [['test/a.test.js', 'a1', 'passed'], ['test/a.test.js', 'a2', 'failed'], ['test/e.test.js', '/workspace/test/e.test.js', 'failed']]);
  assert.equal(j.value.countsMismatch, false);
  // A report whose own declared total disagrees with its rows still fails counts after the merge.
  w(0, '<testsuites><testcase name="a1" classname="test"/><!-- tests 5 --></testsuites>');
  await mergePerFileJunit(fsp, root, out, ['test/a.test.js']);
  assert.equal(parseJunit(fs.readFileSync(path.join(out, 'junit.xml'))).value.countsMismatch, true);
  // Escaping: names with markup stay data.
  w(0, '<testsuites><testcase name="&lt;b&gt; &amp; &quot;q&quot;" classname="test"/><!-- tests 1 --></testsuites>');
  await mergePerFileJunit(fsp, root, out, ['test/a "b".test.js']);
  const e = parseJunit(fs.readFileSync(path.join(out, 'junit.xml'))).value.cases[0];
  assert.deepEqual([e.name, e.file], ['<b> & "q"', 'test/a "b".test.js']);
  assert.equal(isSyntheticFileCase({ name: 'C:\\x\\test\\b.test.js', classname: 'test', outcome: 'passed' }, 'test/b.test.js'), true);
  assert.equal(isSyntheticFileCase({ name: 'b.test.js works', classname: 'test', outcome: 'passed' }, 'test/b.test.js'), false);
  // junit.xml as a folder (a container's trick) is never written through.
  fs.rmSync(path.join(out, 'junit.xml')); fs.mkdirSync(path.join(out, 'junit.xml'));
  const refused = await mergePerFileJunit(fsp, root, out, ['test/a.test.js']);
  assert.equal(refused.merged, false);
  assert.ok(refused.notes.some((n) => /not a plain file/.test(n)));
});

test('DG6 a diagnosis result travels the protocol as is (ids under sha256 keys: never withheld as secret-shaped)', () => {
  const result = { target: 'deployment', containers: [{ container: { sha256: HEX('1') }, status: 'inspected', facts: facts() }],
    logs: [{ attemptId: ATT, status: 'read', offset: 0, length: 10, sha256: HEX('b'), frames: 1, errorFrames: 0, lastText: 'ok' }] };
  const msg = { op: 'attempt.exited', attemptId: ATT, exit: { code: 0, oomKilled: false, finishedAt: 1 }, outputs: [],
    parsed: [{ parser: 'diagnostic', sourceSha256: HEX('d'), normalized: result }], logBytes: 0 };
  assert.ok(parseRunnerMessage(msg));
  assert.equal(containsSecret(result), false);
});

// ---------- B2a Task 12 fix round 1 ----------

test('RV10 (item 10) one definition of the diagnosis bounds and vocabularies: main\'s check reads the shared constants (no copies), and they bind', () => {
  const ex = loadTs('src/shared/nexus/execution.ts');
  const norm = loadTs('src/main/nexus/validation/normalized.ts');
  assert.equal(norm.DIAG_FACT_STATES, ex.DIAGNOSE_FACT_STATES, 'the very same array');
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'nexus', 'validation', 'normalized.ts'), 'utf8');
  assert.doesNotMatch(src, /DIAG_MAX_CONTAINERS|DIAG_MAX_RANGES|DIAG_RANGE_MAX|256 \* 1024|'not_owned', 'unavailable'\]|'restarting', 'paused'/, 'no local copy');
  const runnerSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'runner', 'sandbox', 'dockerDriver.ts'), 'utf8');
  assert.doesNotMatch(runnerSrc, /'restarting', 'paused'/, 'the runner reads the shared fact states too');
  const one = { container: { sha256: HEX('1') }, status: 'missing', facts: null };
  const range = (length) => ({ attemptId: ATT, status: 'read', offset: 0, length, sha256: HEX('b'), frames: 0, errorFrames: 0, lastText: null });
  assert.equal(checkDiagnosis({ target: 'job', containers: Array(ex.DIAGNOSE_MAX_CONTAINERS).fill(one), logs: [] }).ok, true);
  assert.equal(checkDiagnosis({ target: 'job', containers: Array(ex.DIAGNOSE_MAX_CONTAINERS + 1).fill(one), logs: [] }).ok, false);
  assert.equal(checkDiagnosis({ target: 'job', containers: [], logs: Array(ex.DIAGNOSE_MAX_RANGES + 1).fill(range(1)) }).ok, false);
  assert.equal(checkDiagnosis({ target: 'job', containers: [], logs: [range(ex.DIAGNOSE_RANGE_MAX_BYTES)] }).ok, true);
  assert.equal(checkDiagnosis({ target: 'job', containers: [], logs: [range(ex.DIAGNOSE_RANGE_MAX_BYTES + 1)] }).ok, false);
  assert.equal(checkDiagnosis({ target: 'job', containers: [], logs: [{ ...range(1), lastText: 'x'.repeat(ex.DIAGNOSE_LAST_TEXT_MAX + 1) }] }).ok, false);
  for (const s of ex.DIAGNOSE_FACT_STATES) {
    const f = { ...facts(), state: s };
    assert.equal(checkDiagnosis({ target: 'job', containers: [{ container: { sha256: HEX('1') }, status: 'inspected', facts: f }], logs: [] }).ok, true, s);
  }
});

test('RV11b (item 11) the Docker driver checks ownership from the labels alone BEFORE any full inspect: another container\'s record (its environment) is never fetched', async () => {
  const label = 'abcdef0123456789';
  const owned = HEX('1'); const foreign = HEX('2'); const gone = HEX('3');
  const calls = [];
  const full = (labels) => JSON.stringify([{ State: { Status: 'running', ExitCode: 0, OOMKilled: false }, Image: `sha256:${HEX('a')}`,
    Config: { User: '10001:10001', Env: ['SECRET=never-read'], Labels: labels }, HostConfig: { PidsLimit: 512 } }]);
  const labelsOf = { [owned]: { 'nexus.home': label, 'nexus.attempt': ATT }, [foreign]: { app: 'mine', 'nexus.home': 'ffffffffffffffff', 'nexus.attempt': ATT } };
  const res = (stdout, code = 0, stderr = '') => ({ code, signal: null, stdout, stderr, stdoutBytes: stdout.length, truncated: false, timedOut: false, aborted: false, error: null });
  const cli = {
    binary: async () => 'docker',
    run: async (argv) => {
      calls.push([...argv]);
      const id = argv[argv.length - 1];
      if (!labelsOf[id]) return res('', 1, `Error: No such container: ${id}`);
      if (argv.includes('--format')) return res(`${JSON.stringify(labelsOf[id])}\n`);
      return res(full(labelsOf[id]));
    }
  };
  const { DockerDriver } = loadTs('src/runner/sandbox/dockerDriver.ts');
  const d = new DockerDriver(cli, { now: () => 1 });
  const a = await d.inspectFacts(owned, label);
  assert.equal(a.owned, true); assert.equal(a.facts.pidsLimit, 512);
  assert.ok(!JSON.stringify(a).includes('never-read'));
  assert.deepEqual(calls.map((c) => c.slice(0, -1)), [['inspect', '--type', 'container', '--format', '{{json .Config.Labels}}'], ['inspect', '--type', 'container']]);
  calls.length = 0;
  assert.deepEqual(await d.inspectFacts(foreign, label), { owned: false });
  assert.deepEqual(calls, [['inspect', '--type', 'container', '--format', '{{json .Config.Labels}}', foreign]], 'only the labels of a foreign container were asked for');
  calls.length = 0;
  assert.equal(await d.inspectFacts(gone, label), null);
  assert.equal(calls.length, 1);
  assert.deepEqual(await d.inspectFacts(owned, ''), { owned: false }, 'no install label: nothing is owned');
  // The runner's diagnose over this driver: the foreign container is not_owned with no facts.
  const paths = home();
  const r = await diagnose({ driver: d, fs: fsp, paths, home: label }, { engine: 'sde.diagnose', target: 'job', containerIds: [owned, foreign, gone], logRanges: [] }, new AbortController().signal);
  assert.deepEqual(r.containers.map((c) => c.status), ['inspected', 'not_owned', 'missing']);
  // Docker not answering is thrown (unavailable), never a guess.
  const down = new DockerDriver({ binary: async () => 'docker', run: async () => res('', 1, 'Cannot connect to the Docker daemon') }, { now: () => 1 });
  await assert.rejects(down.inspectFacts(owned, label));
});

test('RV15 (item 15) an outside kill stays nonzero_exit, and the job error says the signal and the OOM flag: "exit 137 (SIGKILL), OOMKilled false"', () => {
  const { exitFailure, exitDetail } = loadTs('src/main/nexus/exec/recovery.ts');
  const { getRecipe } = loadTs('src/shared/nexus/recipes.ts');
  assert.deepEqual(exitFailure(getRecipe('sde.build.node'), { code: 137, oomKilled: false }, [], [], null),
    { outcome: 'nonzero_exit', error: { code: 'nonzero_exit', message: 'exit 137 (SIGKILL), OOMKilled false' } });
  assert.equal(exitDetail({ code: 143, oomKilled: false }), 'exit 143 (SIGTERM), OOMKilled false');
  assert.equal(exitDetail({ code: 1, oomKilled: false }), 'exit 1, OOMKilled false');
  assert.equal(exitDetail({ code: null, signal: 'SIGKILL', oomKilled: true }), 'no exit code (SIGKILL), OOMKilled true');
  const oom = exitFailure(getRecipe('sde.build.node'), { code: 137, oomKilled: true }, [], [], null);
  assert.deepEqual([oom.outcome, oom.error.message], ['oom', 'the container ran out of memory (exit 137 (SIGKILL), OOMKilled true)']);
  assert.equal(containsSecret(exitDetail({ code: 137, oomKilled: false })), false);
});
