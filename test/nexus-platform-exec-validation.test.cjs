'use strict';
// B2a Task 8: the validation framework, ingest of runner outputs, evidence and the B2a validators. Real SQLite
// (Electron-as-node, `npm run test:db`), the execution core driven through a FakeRunner (no Docker, no runner process).
// N1-N12 are the negative evidence tests (completion never rests on an exit code, a file, a README or a folder);
// E1-E14 the framework rules; then the ingest contract (exit durable first, the shared ingest lock, deduplicated
// evidence) and the execution orphan queries. Every flow ends with O1-O17 at 0, an empty foreign_key_check and a
// verified activity chain.
const h = require('./helpers/sqlite.cjs');
if (!h.realSqliteOrSkip()) return;
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');
const { execWorld, junit } = require('./helpers/execWorld.cjs');
const { ALL_ZERO, EXEC_ZERO, execOrphans, execOrphanRows } = require('./helpers/orphans.cjs');
const { verifyActivityChain } = loadTs('src/main/nexus/activity/writer.ts');
const { PersistStore } = loadTs('src/main/db.ts');
const { createNexusPlatform } = loadTs('src/main/nexus/platform.ts');
const preview = loadTs('src/main/nexus/validation/validators/appPreviewHealth.ts');
const testsPass = loadTs('src/main/nexus/validation/validators/testsPass.ts');
const N = loadTs('src/main/nexus/validation/normalized.ts');

const code = (c, reason) => (e) => e.code === c && (reason === undefined || e.detail?.reason === reason);
const NEWC = 'a1b2c3'.padEnd(40, '0');
const NEWC2 = 'b2c3d4'.padEnd(40, '0');
const NEWC3 = 'c3d4e5'.padEnd(40, '0');
const TREE = 'e'.repeat(40);
const GOOD_REQ = { title: 'Ledger export', body: 'Export the ledger as CSV.', criteria: [{ id: 'AC1', text: 'A CSV file downloads' }, { id: 'AC2', text: 'Totals match' }] };
const MANIFEST = { version: 1, profile: 'sde-node', run: ['node', 'dist/server.js'], port: 3000, healthPath: '/health', env: [] };
const count = (w, sql, ...a) => w.db.prepare(`SELECT COUNT(*) AS n FROM ${sql}`).get(...a).n;

function healthy(w) {
  assert.deepEqual(w.orphans(), ALL_ZERO, JSON.stringify(execOrphanRows(w.db)));
  assert.deepEqual(w.db.prepare('PRAGMA foreign_key_check').all(), []);
  assert.equal(verifyActivityChain(w.db).ok, true);
}

/** A resolver that answers like src/main/git.ts resolveCommit: a known commit resolves to `map[sha]` (itself by default). */
function resolver(map = {}) {
  const calls = [];
  const fn = async (root, sha) => {
    calls.push({ root, sha });
    const to = Object.prototype.hasOwnProperty.call(map, sha) ? map[sha] : sha;
    return to === null ? { error: 'not_a_commit' } : { commit: to, subject: 's', committedAt: 1 };
  };
  fn.calls = calls;
  return fn;
}

// ---------- N1-N12: never complete on a bare exit, a file, a README or a folder ----------

test('N1 exit 0 and no junit.xml: invalid_output, no version beyond the discovery draft, never candidate', async () => {
  const w = execWorld({ realIngest: true });
  const before = count(w, 'artifact_versions');
  const r = await w.runTests({ discovery: ['test/a.test.js'], junit: null, exit: 0 });
  assert.equal(w.jobState(r.testJobId), 'failed'); assert.equal(w.job(r.testJobId).outcome, 'invalid_output');
  assert.notEqual(w.version(r.suiteVersionId).status, 'candidate');
  assert.equal(count(w, 'artifact_versions'), before + 1, 'only the discovery draft');
  assert.equal(count(w, 'artifact_versions WHERE produced_by_job_id = ?', r.testJobId), 0);
  // The check that could not find its report is recorded as failed (junit_missing), bound to the failed attempt.
  const tp = w.latest(r.suiteVersionId, 'sde.tests_pass');
  assert.equal(tp.status, 'failed'); assert.match(tp.summary, /junit_missing/); assert.equal(tp.job_id, r.testJobId); assert.equal(tp.attempt_n, 1);
  assert.equal(w.version(r.suiteVersionId).status, 'failed');
  healthy(w); w.close();
});

test('N2 exit 0 with a JUnit of zero testcases: the job completes, the suite fails, the step is not done', async () => {
  const w = execWorld({ realIngest: true }); const r = await w.runTests({ discovery: ['test/a.test.js'], junit: junit([]), exit: 0 });
  assert.equal(w.jobState(r.testJobId), 'completed');
  const v = w.version(r.suiteVersionId);
  assert.equal(v.status, 'failed');
  const tp = w.latest(r.suiteVersionId, 'sde.tests_pass');
  assert.equal(tp.status, 'failed'); assert.match(tp.summary, /no tests were executed/i);
  assert.equal(w.stepState('sde', 'tests'), 'failed');
  assert.equal(w.exec.get(w.me, r.parentJobId).headline, 'checks_failed');
  assert.equal(w.exec.get(w.me, r.testJobId).headline, 'checks_failed');
  assert.deepEqual(w.orphans().O16, 0);
  healthy(w); w.close();
});

test('N3 a JUnit row naming a file absent from discovery (an attributing framework) fails undiscovered_ids', async () => {
  const w = execWorld({ realIngest: true });
  const r = await w.runTests({ discovery: ['test/a.test.js'], junit: junit([{ name: 'ok' }, { name: 'sneaky', file: 'test/b.test.js' }]), exit: 0 });
  const tp = w.latest(r.suiteVersionId, 'sde.tests_pass');
  assert.equal(tp.status, 'failed'); assert.match(tp.summary, /undiscovered_ids/);
  assert.equal(w.version(r.suiteVersionId).status, 'failed');
  // A framework that does not attribute files (no `file`) is not judged on it.
  const w2 = execWorld({ realIngest: true });
  const r2 = await w2.runTests({ discovery: ['test/a.test.js'], junit: junit([{ name: 'ok', file: null, classname: 'Suite' }]), exit: 0 });
  assert.equal(w2.latest(r2.suiteVersionId, 'sde.tests_pass').status, 'passed');
  assert.equal(w2.version(r2.suiteVersionId).status, 'candidate');
  healthy(w); healthy(w2); w.close(); w2.close();
});

test('N4 tests="5" with 3 testcases fails counts_mismatch (and the runner\'s own flag is honoured)', async () => {
  const w = execWorld({ realIngest: true });
  const r = await w.runTests({ junit: junit([{ name: 'a' }, { name: 'b' }, { name: 'c' }], { declaredTotal: 5 }), exit: 0 });
  const tp = w.latest(r.suiteVersionId, 'sde.tests_pass');
  assert.equal(tp.status, 'failed'); assert.match(tp.summary, /counts_mismatch/);
  assert.equal(w.version(r.suiteVersionId).status, 'failed');
  const w2 = execWorld({ realIngest: true });
  const r2 = await w2.runTests({ junit: junit([{ name: 'a' }], { countsMismatch: true }), exit: 0 });
  assert.match(w2.latest(r2.suiteVersionId, 'sde.tests_pass').summary, /counts_mismatch/);
  const w3 = execWorld({ realIngest: true });
  const r3 = await w3.runTests({ junit: junit([{ name: 'a' }, { name: 'b' }], { passed: 1, failed: 1 }), exit: 0 });
  assert.match(w3.latest(r3.suiteVersionId, 'sde.tests_pass').summary, /counts_mismatch/, 'counts that disagree with the rows');
  healthy(w); healthy(w2); healthy(w3); w.close(); w2.close(); w3.close();
});

test('N5 the exit code must agree with the results: exit 1 with all passing, exit 0 with a failing case -> exit_inconsistent', async () => {
  const w = execWorld({ realIngest: true });
  const r = await w.runTests({ junit: junit([{ name: 'a' }, { name: 'b' }]), exit: 1 });
  assert.equal(w.jobState(r.testJobId), 'completed', 'a test recipe with a parsable JUnit completes; the product failure is in the check');
  assert.match(w.latest(r.suiteVersionId, 'sde.tests_pass').summary, /exit_inconsistent/);
  const w2 = execWorld({ realIngest: true });
  const r2 = await w2.runTests({ junit: junit([{ name: 'a' }, { name: 'b', outcome: 'failed' }]), exit: 0 });
  assert.match(w2.latest(r2.suiteVersionId, 'sde.tests_pass').summary, /exit_inconsistent/);
  // Consistent: exit 1 with a failing case fails as tests_failed; exit 0 with all passing passes.
  const w3 = execWorld({ realIngest: true });
  const r3 = await w3.runTests({ junit: junit([{ name: 'a' }, { name: 'b', outcome: 'failed' }]), exit: 1 });
  assert.match(w3.latest(r3.suiteVersionId, 'sde.tests_pass').summary, /tests_failed/);
  assert.equal(w3.version(r3.suiteVersionId).status, 'failed');
  for (const x of [w, w2, w3]) { assert.equal(x.version((x === w ? r : x === w2 ? r2 : r3).suiteVersionId).status, 'failed'); healthy(x); x.close(); }
});

test('N6 an empty dist/ directory and a README never make a build', async () => {
  const w = execWorld({ realIngest: true }); const r = await w.runBuild({ files: [], extraFiles: ['README.md'], exit: 0 });
  assert.equal(w.latest(r.buildVersionId, 'build.manifest_present').status, 'failed');
  assert.equal(w.version(r.buildVersionId).status, 'failed');
  assert.equal(w.jobState(r.buildJobId), 'completed');
  assert.equal(w.exec.get(w.me, r.buildJobId).headline, 'checks_failed');
  assert.equal(count(w, "version_blobs WHERE version_id = ?", r.buildVersionId), 0, 'the README is not part of the build');
  assert.equal(w.stepState('sde', 'build'), 'failed');
  healthy(w); w.close();
});

test('N7 /out/dist holding only an empty directory (or only empty files) fails build.manifest_present', async () => {
  const w = execWorld({ realIngest: true }); const r = await w.runBuild({ files: [], exit: 0 });
  assert.equal(w.latest(r.buildVersionId, 'build.manifest_present').status, 'failed');
  assert.match(w.latest(r.buildVersionId, 'build.manifest_present').summary, /empty_tree/);
  assert.equal(w.version(r.buildVersionId).status, 'failed');
  const w2 = execWorld({ realIngest: true }); const r2 = await w2.runBuild({ files: [{ path: 'empty.js', content: '' }], exit: 0 });
  assert.equal(w2.latest(r2.buildVersionId, 'build.manifest_present').status, 'failed');
  assert.equal(w2.version(r2.buildVersionId).status, 'failed');
  healthy(w); healthy(w2); w.close(); w2.close();
});

test('N8 a blob altered on disk after ingest: blob.integrity fails and the build fails', async () => {
  const w = execWorld({ realIngest: true }); const r = await w.runBuild({ files: ['app.js', 'lib/util.js'], exit: 0 });
  for (const v of ['build.exit_zero', 'build.manifest_present', 'build.output_hashed']) assert.equal(w.latest(r.buildVersionId, v).status, 'passed', v);
  assert.equal(w.version(r.buildVersionId).status, 'draft', 'still waiting for the re-hash');
  const runner = w.attach();
  assert.equal(runner.sentOf('blob.verify').length, 2);
  const bad = r.outputs[1].sha256;
  w.answerVerifies(runner, (sha) => sha !== bad);
  await w.settle();
  const bi = w.latest(r.buildVersionId, 'blob.integrity');
  assert.equal(bi.status, 'failed'); assert.match(bi.summary, /rehash_failed/);
  assert.equal(w.version(r.buildVersionId).status, 'failed');
  healthy(w); w.close();
});

test('N9 an application whose probe never answers 200 within 60 s fails app.preview_health; the version fails', async () => {
  const w = execWorld({ realIngest: true });
  const b = await w.runBuild({ files: ['server.js'], exit: 0 });
  w.answerVerifies(w.attach(), true); await w.settle();
  assert.equal(w.version(b.buildVersionId).status, 'candidate');
  const runner = w.attach();
  const job = w.exec.start(w.me, w.req('sde.app.assemble', { inputs: [{ versionId: b.buildVersionId, slot: 'build' }] })).job;
  w.exec.tick(w.now()); w.provisionEngine(runner, job.id);
  w.exitWith(runner, job.id, { code: 0, parsed: [{ parser: 'app-manifest', sourceSha256: 'd'.repeat(64), normalized: { manifest: MANIFEST } }] });
  await w.settle();
  assert.equal(w.jobState(job.id), 'completed');
  const app = w.db.prepare("SELECT id FROM artifact_versions WHERE produced_by_job_id = ?").get(job.id).id;
  assert.equal(w.latest(app, 'app.manifest_schema').status, 'passed');
  assert.equal(w.version(app).status, 'draft', 'waits for its dev deployment');
  assert.equal(count(w, "artifact_edges WHERE from_version_id = ? AND to_version_id = ? AND relation = 'assembled_from' AND source = 'job_input'", app, b.buildVersionId), 1);
  // The deployment's observed facts (Task 9 records them): probes for 61 s, never a 200.
  const start = w.now();
  const facts = { path: '/health', startedAt: start, container: 'running', bindAddress: '127.0.0.1',
    probes: Array.from({ length: 13 }, (_, i) => ({ at: start + i * 5000, status: i < 6 ? null : 503, ms: i < 6 ? null : 12 })) };
  const outcome = preview.run(facts);
  assert.equal(outcome.status, 'failed'); assert.equal(outcome.reason, 'no_health');
  w.db.transaction(() => {
    w.nx.validation.recordOutcomeTx(app, 'app.preview_health', outcome);
    assert.equal(w.nx.validation.finalizeIfReady(w.sys, app), 'failed');
  }).immediate();
  assert.equal(w.version(app).status, 'failed');
  // A 200 after the 60 s window does not count; bound elsewhere or an exited container fail too.
  assert.equal(preview.run({ ...facts, probes: [{ at: start + 61_000, status: 200, ms: 3 }] }).status, 'failed');
  assert.equal(preview.run({ ...facts, bindAddress: '0.0.0.0', probes: [{ at: start + 1000, status: 200, ms: 3 }] }).reason, 'bound_elsewhere');
  assert.equal(preview.run({ ...facts, container: 'exited', probes: [{ at: start + 1000, status: 200, ms: 3 }] }).reason, 'container_exited');
  assert.equal(preview.run({ ...facts, probes: [{ at: start + 1000, status: 200, ms: 3 }] }).status, 'passed');
  healthy(w); w.close();
});

test('N10 Mark ready on an execution-made draft is invalid: produced_by_job (the B1 rule, re-asserted)', async () => {
  const w = execWorld({ realIngest: true }); const r = await w.runTests({ skipTests: true });
  assert.equal(w.version(r.suiteVersionId).status, 'draft');
  assert.throws(() => w.nx.artifacts.markReady(w.me, r.suiteVersionId), code('invalid', 'produced_by_job'));
  assert.equal(w.version(r.suiteVersionId).status, 'draft');
  w.close();
});

test('N11 a completed job without a candidate version leaves the step in_progress or failed, never done', async () => {
  const w = execWorld({ realIngest: true }); const r = await w.runTests({ skipTests: true });
  assert.equal(w.jobState(r.discoveryJobId), 'completed');
  assert.equal(w.stepState('sde', 'tests'), 'in_progress', 'the tests check is queued');
  // The check never runs: still not done, whatever the completed discovery says.
  w.exec.cancel(w.me, w.validateJobs(r.suiteVersionId, 'sde.tests_pass')[0].id);
  assert.notEqual(w.stepState('sde', 'tests'), 'done');
  // A build whose re-hash is still out: completed job, draft version, not done.
  const b = await w.runBuild({ files: ['a.js'] });
  assert.equal(w.jobState(b.buildJobId), 'completed');
  assert.equal(w.stepState('sde', 'build'), 'in_progress');
  w.answerVerifies(w.attach(), true); await w.settle();
  assert.equal(w.stepState('sde', 'build'), 'done', 'done only once every blocking check passed on a candidate');
  healthy(w); w.close();
});

test('N12 a runner fault during blob.verify: blob.integrity is error, the version stays draft, Revalidate is offered; never passed', async () => {
  const w = execWorld({ realIngest: true }); const r = await w.runBuild({ files: ['app.js'] });
  const runner = w.attach();
  runner.report({ op: 'fault', message: 'the docker daemon went away' });
  await w.settle();
  const bi = w.latest(r.buildVersionId, 'blob.integrity');
  assert.equal(bi.status, 'error'); assert.match(bi.summary, /could not run/i);
  assert.equal(w.version(r.buildVersionId).status, 'draft');
  assert.equal(w.version(r.buildVersionId).validation_state, 'error');
  assert.equal(w.exec.get(w.me, r.buildJobId).headline, 'checks_could_not_run');
  // Revalidate: new checks, the old rows kept; this time the runner answers and the build becomes a candidate.
  const before = w.validations(r.buildVersionId).length;
  const { jobs } = w.nx.validation.revalidate(w.me, r.buildVersionId);
  assert.equal(jobs.length, 4);
  w.answerVerifies(runner, true); await w.settle();
  assert.ok(w.validations(r.buildVersionId).length >= before + 4);
  assert.equal(w.validations(r.buildVersionId).filter((x) => x.validator_id === 'blob.integrity' && x.status === 'error').length, 1, 'the error row stays');
  assert.equal(w.version(r.buildVersionId).status, 'candidate');
  // No answer within 60 s is error too, never passed.
  const r2 = await w.runBuild({ files: ['other.js'] });
  w.advance(61_000); w.exec.tick(w.now()); await w.settle();
  assert.equal(w.latest(r2.buildVersionId, 'blob.integrity').status, 'error');
  assert.equal(w.version(r2.buildVersionId).status, 'draft');
  healthy(w); w.close();
});

// ---------- E1-E14: the framework ----------

test('E1 register validators run inside ingest: a failing one rejects the output version with the reason', async () => {
  const w = execWorld({ realIngest: true });
  const r = await w.runTests({ discovery: [] });
  const v = w.version(r.suiteVersionId);
  assert.equal(v.status, 'failed');
  const sd = w.latest(r.suiteVersionId, 'suite.discovered');
  assert.equal(sd.status, 'failed'); assert.match(sd.summary, /no_tests_discovered/);
  assert.equal(sd.job_id, r.discoveryJobId); assert.equal(sd.attempt_n, 1);
  assert.equal(r.testJobId, null); assert.equal(w.validateJobs(r.suiteVersionId).length, 0, 'no candidate check for a rejected output');
  // A list whose parser hash is not the stored ids.txt fails too (hash_mismatch).
  const r2 = await w.runTests({ discovery: ['test/a.test.js'], listSha: 'f'.repeat(64) });
  assert.match(w.latest(r2.suiteVersionId, 'suite.discovered').summary, /hash_mismatch/);
  // A bad shape is error (parser_contract), not passed: the version stays draft.
  const r3 = await w.runTests({ discovery: ['test/c.test.js'], discoveryNormalized: { framework: 'node-test', ids: 'nope', files: [] } });
  assert.equal(w.latest(r3.suiteVersionId, 'suite.discovered').status, 'error');
  assert.equal(w.version(r3.suiteVersionId).status, 'draft');
  healthy(w); w.close();
});

test('E2 finalize needs every blocking register and candidate validator passed; advisories never gate', async () => {
  const w = execWorld({ realIngest: true }); const r = await w.runBuild({ files: ['app.js'] });
  assert.equal(w.version(r.buildVersionId).status, 'draft');
  // An advisory failure changes nothing.
  w.db.transaction(() => {
    w.nx.validation.recordResultTx(w.sys, { versionId: r.buildVersionId, validatorId: 'build.size_note', status: 'failed', blocking: false, advisory: true,
      summary: 'The build is larger than last time', evidence: [] });
    assert.equal(w.nx.validation.finalizeIfReady(w.sys, r.buildVersionId), 'draft');
  }).immediate();
  assert.equal(w.latest(r.buildVersionId, 'build.size_note').advisory, 1);
  w.answerVerifies(w.attach(), true); await w.settle();
  assert.equal(w.version(r.buildVersionId).status, 'candidate');
  assert.equal(w.version(r.buildVersionId).validation_state, 'passed');
  const fin = w.db.prepare("SELECT * FROM activity WHERE action = 'version.finalize' AND version_id = ?").get(r.buildVersionId);
  assert.equal(fin.actor_kind, 'system'); assert.equal(fin.on_behalf_of, 'user:local');
  healthy(w); w.close();
});

test('E3 revalidate writes new rows and keeps the old ones; it is refused on a non-draft', async () => {
  const w = execWorld({ realIngest: true });
  const { version } = w.nx.artifacts.saveInline(w.me, { projectId: 'p-ledger', workspaceId: 'sde', kind: 'requirement', target: { name: 'Export' }, content: GOOD_REQ });
  assert.equal(w.validations(version.id).length, 1);
  const first = w.validations(version.id)[0];
  w.advance(1000);
  const { jobs } = w.nx.validation.revalidate(w.me, version.id);
  assert.equal(jobs.length, 1);
  const rows = w.validations(version.id);
  assert.equal(rows.length, 2); assert.equal(rows[0].id, first.id); assert.deepEqual(rows[0], first, 'the old row is unchanged');
  assert.equal(rows[1].status, 'passed'); assert.equal(rows[1].job_id, jobs[0]); assert.equal(rows[1].attempt_n, 1);
  assert.equal(w.jobState(jobs[0]), 'completed'); assert.equal(w.job(jobs[0]).on_behalf_of, 'user:local');
  assert.equal(w.version(version.id).status, 'draft', "a user's own draft is made ready by the user");
  w.nx.artifacts.markReady(w.me, version.id);
  assert.throws(() => w.nx.validation.revalidate(w.me, version.id), code('illegal_transition'));
  const viewer = w.addUser('user:viewer', 'project', 'p-ledger', 'viewer');
  assert.throws(() => w.nx.validation.revalidate(viewer, version.id), code('denied'));
  healthy(w); w.close();
});

test('E4 a validator upgrade: a v2 row beside the v1 row; the latest per (version, validator) counts', async () => {
  const w = execWorld({ realIngest: true }); const r = await w.runTests({ skipTests: true });
  const v1 = w.latest(r.suiteVersionId, 'suite.discovered');
  assert.equal(v1.validator_version, '1'); assert.equal(v1.status, 'passed');
  w.advance(1000);
  w.db.transaction(() => {
    w.nx.validation.recordResultTx(w.sys, { versionId: r.suiteVersionId, validatorId: 'suite.discovered', validatorVersion: '2', stage: 'register',
      status: 'failed', blocking: true, summary: 'v2 needs two tests', evidence: [{ type: 'number', name: 'discovered', value: 1, source: { blobSha256: 'a'.repeat(64), pointer: '/ids' } }] });
  }).immediate();
  const latest = w.nx.validation.latestForVersion(w.me, r.suiteVersionId).find((x) => x.validatorId === 'suite.discovered');
  assert.equal(latest.validatorVersion, '2'); assert.equal(latest.status, 'failed');
  assert.equal(w.validations(r.suiteVersionId).filter((x) => x.validator_id === 'suite.discovered').length, 2);
  w.db.transaction(() => assert.equal(w.nx.validation.finalizeIfReady(w.sys, r.suiteVersionId), 'failed')).immediate();
  w.close();
});

test('E5 evidence holding a secret-shaped value: the validation is error (secret_in_evidence) and the evidence is not stored', () => {
  const w = execWorld({ realIngest: true });
  const { version } = w.nx.artifacts.saveInline(w.me, { projectId: 'p-ledger', workspaceId: 'sde', kind: 'requirement', target: { name: 'R' }, content: GOOD_REQ });
  const secret = 'sk-' + 'q'.repeat(40);
  const res = w.db.transaction(() => w.nx.validation.recordResultTx(w.sys, { versionId: version.id, validatorId: 'req.schema', status: 'passed',
    summary: 'fine', evidence: [{ type: 'schema', schemaId: 'requirement.v1', errors: [{ path: '', message: `token ${secret}` }] }] })).immediate();
  assert.equal(res.status, 'error'); assert.match(res.summary, /secret_in_evidence/);
  const row = w.db.prepare('SELECT * FROM validations WHERE id = ?').get(res.id);
  assert.equal(row.evidence_json, '[]'); assert.doesNotMatch(JSON.stringify(row), new RegExp(secret));
  // Integrity digests in their typed fields are not secrets.
  const ok = w.db.transaction(() => w.nx.validation.recordResultTx(w.sys, { versionId: version.id, validatorId: 'req.schema', status: 'passed',
    summary: 'fine', evidence: [{ type: 'number', name: 'n', value: 1, source: { blobSha256: 'b'.repeat(64), pointer: '/x' } }, { type: 'hash', label: 'x', sha256: 'c'.repeat(64) }] })).immediate();
  assert.equal(ok.status, 'passed');
  w.close();
});

test('E6 a user principal cannot write a blocking passed result: the service denies (audited) and the trigger refuses', () => {
  const w = execWorld({ realIngest: true });
  const { version } = w.nx.artifacts.saveInline(w.me, { projectId: 'p-ledger', workspaceId: 'sde', kind: 'requirement', target: { name: 'R' }, content: GOOD_REQ });
  const denied = count(w, "activity WHERE status = 'denied'");
  assert.throws(() => w.nx.validation.recordResultTx(w.me, { versionId: version.id, validatorId: 'req.schema', status: 'passed',
    summary: 'I say so', evidence: [] }), code('denied'));
  assert.equal(count(w, "activity WHERE status = 'denied'"), denied + 1);
  assert.throws(() => w.db.prepare(`INSERT INTO validations (id, version_id, validator_id, validator_version, stage, status, blocking, advisory, summary,
      evidence_json, job_id, attempt_n, created_by, started_at, finished_at) VALUES ('v-forged', ?, 'req.schema', '1', 'register', 'passed', 1, 0, 'x', '[]',
      NULL, NULL, 'user:local', 1, 1)`).run(version.id), /recorded only by the system/);
  // The other system-only paths: the finalize rule and the ingest insert.
  assert.throws(() => w.nx.validation.finalizeIfReady(w.me, version.id), code('denied'));
  assert.throws(() => w.db.transaction(() => w.nx.artifacts.insertSystemVersionTx(w.me, { artifactId: version.artifactId, storage: { kind: 'inline', json: {} },
    contentHash: 'x', metadata: {}, environment: null, jobId: 'nope', outputPath: null, action: null, onBehalfOf: 'user:local', inputs: [], now: w.now() })).immediate(),
  code('invalid'));
  w.close();
});

test('E7 a repository snapshot: git.head_resolves uses main\'s own resolveCommit; promoted active by the system on the user\'s behalf', async () => {
  const resolveCommit = resolver({ [NEWC2]: NEWC });
  const w = execWorld({ realIngest: true, resolveCommit });
  const runner = w.attach();
  const j = w.exec.start(w.me, w.req('sde.repository.snapshot')).job;
  w.exec.tick(w.now()); w.provisionEngine(runner, j.id);
  w.exitWith(runner, j.id, { parsed: [{ parser: 'repo-snapshot', sourceSha256: 'e'.repeat(64), normalized: { commit: NEWC, branch: 'main', dirty: false, tree: TREE } }] });
  // The exit is durable before the asynchronous git check: collecting, no version yet.
  assert.equal(w.job(j.id).phase, 'collecting'); assert.equal(w.liveAttempt(j.id).state, 'running');
  assert.equal(w.events(j.id, 'attempt.output').length, 1);
  assert.equal(count(w, 'artifact_versions WHERE produced_by_job_id = ?', j.id), 0);
  await w.settle();
  assert.equal(resolveCommit.calls.length, 1); assert.equal(resolveCommit.calls[0].sha, NEWC);
  assert.equal(resolveCommit.calls[0].root, w.fsRootCalls[w.fsRootCalls.length - 1]);
  assert.equal(w.jobState(j.id), 'completed'); assert.equal(w.job(j.id).phase, null);
  const v = w.db.prepare('SELECT * FROM artifact_versions WHERE produced_by_job_id = ?').get(j.id);
  assert.equal(v.status, 'active'); assert.equal(JSON.parse(v.storage_ref_json).commit, NEWC);
  assert.equal(w.latest(v.id, 'git.head_resolves').status, 'passed');
  assert.equal(w.db.prepare('SELECT current_version_id AS c FROM artifacts WHERE id = ?').get(v.artifact_id).c, v.id);
  for (const action of ['version.finalize', 'version.promote']) {
    const row = w.db.prepare('SELECT * FROM activity WHERE action = ? AND version_id = ?').get(action, v.id);
    assert.ok(row, action); assert.equal(row.actor_kind, 'system'); assert.equal(row.on_behalf_of, 'user:local');
  }
  assert.equal(w.stepState('sde', 'repository'), 'done');
  // The runner reports a %H that resolves to another commit: the check fails and the version fails.
  const j2 = await w.snapshot({ commit: NEWC2, branch: 'main', dirty: true, tree: TREE });
  const v2 = w.db.prepare('SELECT * FROM artifact_versions WHERE produced_by_job_id = ?').get(j2);
  assert.match(w.latest(v2.id, 'git.head_resolves').summary, /hash_differs/);
  assert.equal(v2.status, 'failed');
  // A commit that does not resolve at all fails too.
  const w3 = execWorld({ realIngest: true, resolveCommit: resolver({ [NEWC3]: null }) });
  const j3 = await w3.snapshot({ commit: NEWC3, branch: null, dirty: false, tree: TREE });
  const v3 = w3.db.prepare('SELECT * FROM artifact_versions WHERE produced_by_job_id = ?').get(j3);
  assert.match(w3.latest(v3.id, 'git.head_resolves').summary, /does_not_resolve/); assert.equal(v3.status, 'failed');
  // Without main's resolver the check could not run: error, the version stays draft.
  const w4 = execWorld({ realIngest: true });
  const j4 = await w4.snapshot({ commit: NEWC, branch: 'main', dirty: false, tree: TREE });
  const v4 = w4.db.prepare('SELECT * FROM artifact_versions WHERE produced_by_job_id = ?').get(j4);
  assert.equal(w4.latest(v4.id, 'git.head_resolves').status, 'error'); assert.equal(v4.status, 'draft');
  for (const x of [w, w3, w4]) { healthy(x); x.close(); }
});

test('E8 the same commit snapshotted twice is one version (its check still binds the second attempt); a new commit derives from the previous', async () => {
  const w = execWorld({ realIngest: true, resolveCommit: resolver() });
  const j1 = await w.snapshot({ commit: NEWC, branch: 'main', dirty: false, tree: TREE });
  const v1 = w.db.prepare('SELECT * FROM artifact_versions WHERE produced_by_job_id = ?').get(j1);
  const before = count(w, 'artifact_versions');
  const j2 = await w.snapshot({ commit: NEWC, branch: 'main', dirty: false, tree: TREE });
  assert.equal(count(w, 'artifact_versions'), before, 'one version');
  // Decision 3: the deduplicated output still counts as evidence of attempt 1 of job 2 (no no_evidence failure).
  assert.equal(w.jobState(j2), 'completed');
  assert.equal(count(w, 'version_attempts WHERE job_id = ?', j2), 0);
  const bound = w.db.prepare('SELECT * FROM validations WHERE job_id = ? AND attempt_n = 1').all(j2);
  assert.equal(bound.length, 1); assert.equal(bound[0].version_id, v1.id); assert.equal(bound[0].validator_id, 'git.head_resolves'); assert.equal(bound[0].status, 'passed');
  const j3 = await w.snapshot({ commit: NEWC2, branch: 'main', dirty: false, tree: TREE });
  const v3 = w.db.prepare('SELECT * FROM artifact_versions WHERE produced_by_job_id = ?').get(j3);
  assert.equal(v3.status, 'active'); assert.equal(w.version(v1.id).status, 'deprecated');
  const edge = w.db.prepare("SELECT * FROM artifact_edges WHERE from_version_id = ? AND to_version_id = ? AND relation = 'derived_from'").get(v3.id, v1.id);
  assert.ok(edge); assert.equal(edge.source, 'ingest'); assert.equal(edge.job_id, j3);
  // The same discovery list on the same commit is one suite version too.
  const t1 = await w.runTests({ skipTests: true });
  const t2 = await w.runTests({ skipTests: true });
  assert.equal(t2.suiteVersionId, null, 'no new version for the same list');
  assert.equal(w.jobState(t2.discoveryJobId), 'completed');
  assert.equal(w.db.prepare('SELECT version_id FROM validations WHERE job_id = ?').get(t2.discoveryJobId).version_id, t1.suiteVersionId);
  healthy(w); w.close();
});

test('E9 ingest is idempotent: replaying the same attempt.exited makes no new version', async () => {
  const w = execWorld({ realIngest: true }); const r = await w.runBuild({ files: ['app.js'] });
  const a = w.attempts(r.buildJobId)[0];
  const before = { versions: count(w, 'artifact_versions'), blobs: count(w, 'version_blobs'), validations: count(w, 'validations') };
  const runner = w.attach();
  w.exitWith(runner, r.buildJobId, { attempt: a, code: 0, outputs: r.outputs });
  await w.settle();
  assert.deepEqual({ versions: count(w, 'artifact_versions'), blobs: count(w, 'version_blobs'), validations: count(w, 'validations') }, before);
  assert.ok(runner.sentOf('attempt.release').filter((m) => m.attemptId === a.id).length >= 2, 'the replay only releases the container');
  // A replay while an asynchronous ingest is still running is dropped as well.
  const w2 = execWorld({ realIngest: true, resolveCommit: resolver() });
  const r2 = w2.attach();
  const j = w2.exec.start(w2.me, w2.req('sde.repository.snapshot')).job;
  w2.exec.tick(w2.now()); const att = w2.provisionEngine(r2, j.id);
  const msg = { parsed: [{ parser: 'repo-snapshot', sourceSha256: 'e'.repeat(64), normalized: { commit: NEWC, branch: 'main', dirty: false, tree: TREE } }] };
  w2.exitWith(r2, j.id, msg); w2.exitWith(r2, j.id, { ...msg, attempt: att });
  await w2.settle();
  assert.equal(count(w2, 'artifact_versions WHERE produced_by_job_id = ?', j.id), 1);
  assert.equal(w2.jobState(j.id), 'completed');
  healthy(w); healthy(w2); w.close(); w2.close();
});

test('E10 an ingest crash rolls back everything; the retry ingests once', async () => {
  let throws = 1;
  const w = execWorld({ realIngest: true, ingestFaults: { afterRows: (recipe) => { if (recipe === 'sde.test.discover' && throws-- > 0) throw new Error('crash'); } } });
  const runner = w.attach();
  const tables = ['artifacts', 'artifact_versions', 'version_blobs', 'blobs', 'validations', 'version_attempts', 'artifact_edges'];
  const snap = () => Object.fromEntries(tables.map((t) => [t, count(w, t)]));
  const before = snap();
  const d = w.exec.start(w.me, w.req('sde.tests.discover')).job;
  w.exec.tick(w.now()); w.provision(runner, d.id);
  const ids = w.file('ids.txt', 'test/a.test.js');
  const exit = { outputs: [ids], parsed: [{ parser: 'discovery', sourceSha256: ids.sha256, normalized: { framework: 'node-test', ids: ['test/a.test.js'], files: ['test/a.test.js'] } }] };
  w.exitWith(runner, d.id, exit);
  await w.settle();
  assert.deepEqual(snap(), before, 'nothing of the crashed ingest remains');
  assert.equal(w.attempts(d.id)[0].outcome, 'ingest_error'); assert.equal(w.jobState(d.id), 'retry_scheduled');
  // Replaying attempt 1's exit changes nothing; attempt 2 ingests exactly once.
  w.exitWith(runner, d.id, { ...exit, attempt: w.attempts(d.id)[0] });
  w.run(runner, 15_000);
  w.provision(runner, d.id, { c: 'b' });
  w.exitWith(runner, d.id, exit);
  await w.settle();
  assert.equal(w.jobState(d.id), 'completed'); assert.equal(w.attempts(d.id).length, 2);
  assert.equal(count(w, 'artifact_versions WHERE produced_by_job_id = ?', d.id), 1);
  assert.equal(w.db.prepare('SELECT attempt_n FROM version_attempts WHERE job_id = ?').get(d.id).attempt_n, 2);
  w.exitWith(runner, d.id, { ...exit, attempt: w.attempts(d.id)[1] }); await w.settle();
  assert.equal(count(w, 'artifact_versions WHERE produced_by_job_id = ?', d.id), 1);
  healthy(w); w.close();
});

test('E11 cancelled_partial drafts never finalize on their own; revalidate can finalize them', async () => {
  const w = execWorld({ realIngest: true }); const runner = w.attach();
  const job = w.exec.start(w.me, w.req('sde.build.run')).job; w.exec.tick(w.now()); w.provision(runner, job.id);
  const reqA = w.nx.artifacts.create(w.me, { projectId: 'p-ledger', workspaceId: 'sde', kind: 'requirement', name: 'Drafted by a job' });
  const v = w.nx.artifacts.registerVersion(w.sys, { artifactId: reqA.id, storage: { kind: 'inline', json: GOOD_REQ }, producedByJobId: job.id }).version.id;
  w.exec.cancel(w.me, job.id);
  assert.equal(w.version(v).draft_flag, 'cancelled_partial');
  w.db.transaction(() => {
    w.nx.validation.runRegisterTx(w.sys, v, { 'req.schema': GOOD_REQ });
    assert.equal(w.nx.validation.finalizeIfReady(w.sys, v), 'draft', 'never on its own');
  }).immediate();
  assert.equal(w.latest(v, 'req.schema').status, 'passed'); assert.equal(w.version(v).status, 'draft');
  w.nx.validation.revalidate(w.me, v); await w.settle();
  assert.equal(w.version(v).status, 'candidate');
  healthy(w); w.close();
});

test('E12 every output version\'s environment_json equals its attempt\'s (image, base digest, context, lockfile, recipe version)', async () => {
  const w = execWorld({ realIngest: true, repoMeta: { lockfile: { sha256: '9'.repeat(64) } } });
  const t = await w.runTests({ skipTests: true });
  const b = await w.runBuild({ files: ['app.js'] });
  for (const [versionId, jobId] of [[t.suiteVersionId, t.discoveryJobId], [b.buildVersionId, b.buildJobId]]) {
    const v = w.version(versionId);
    const a = w.attempts(jobId)[0];
    assert.equal(v.environment_json, a.environment_json);
    const env = JSON.parse(v.environment_json);
    for (const k of ['imageId', 'baseDigest', 'contextSha256', 'lockfileSha256', 'recipeVersion']) assert.ok(k in env, k);
    assert.equal(env.lockfileSha256, '9'.repeat(64));
    assert.equal(env.imageId, w.IMAGE['sde-node']);
  }
  w.close();
});

test('E13 saveInline: a valid requirement is a draft with req.schema passed and Mark ready makes it a candidate; bad content is refused', () => {
  const w = execWorld({ realIngest: true });
  const s = w.nx.artifacts.saveInline(w.me, { projectId: 'p-ledger', workspaceId: 'sde', kind: 'requirement', target: { name: 'Export' }, content: GOOD_REQ });
  assert.equal(s.created, true); assert.equal(s.version.status, 'draft'); assert.equal(s.version.storage.kind, 'inline');
  const rq = w.latest(s.version.id, 'req.schema');
  assert.equal(rq.status, 'passed'); assert.equal(rq.created_by, 'system'); assert.equal(rq.stage, 'register');
  assert.equal(w.nx.artifacts.saveInline(w.me, { projectId: 'p-ledger', workspaceId: 'sde', kind: 'requirement', target: { name: 'Export' }, content: GOOD_REQ }).created, false, 'deduplicated');
  assert.equal(w.nx.artifacts.markReady(w.me, s.version.id).status, 'candidate');
  assert.equal(w.stepState('sde', 'requirement'), 'done');
  const save = (o) => () => w.nx.artifacts.saveInline(w.me, { projectId: 'p-ledger', workspaceId: 'sde', kind: 'requirement', target: { name: 'X' }, content: GOOD_REQ, ...o });
  assert.throws(save({ content: { title: 'T', criteria: [{ text: 'no id' }] } }), code('invalid', 'bad_content'));
  assert.throws(save({ content: { title: 'T', criteria: [] } }), code('invalid', 'bad_content'));
  assert.throws(save({ content: { title: 'T', criteria: [{ id: 'A', text: 'x' }, { id: 'A', text: 'y' }] } }), code('invalid', 'bad_content'));
  assert.throws(save({ content: { ...GOOD_REQ, body: `the key is sk-${'z'.repeat(40)}` } }), code('invalid', 'secret_in_metadata'));
  assert.throws(save({ workspaceId: 'qa' }), code('invalid', 'kind_not_in_domain'));
  assert.throws(save({ kind: 'build' }), code('invalid', 'kind_not_authorable'));
  // A problem statement in the Data Analyst workspace is allowed.
  w.nx.workspaces.attach(w.me, 'p-ledger', 'data');
  const p = w.nx.artifacts.saveInline(w.me, { projectId: 'p-ledger', workspaceId: 'data', kind: 'problem_statement', target: { name: 'Churn' },
    content: { question: 'Why do customers leave?', successCriteria: ['A ranked list of reasons'] } });
  assert.equal(p.version.status, 'draft'); assert.equal(w.latest(p.version.id, 'problem.schema').status, 'passed');
  assert.throws(() => w.nx.artifacts.saveInline(w.me, { projectId: 'p-ledger', workspaceId: 'data', kind: 'problem_statement', target: { name: 'Bad' },
    content: { question: '' } }), code('invalid', 'bad_content'));
  const viewer = w.addUser('user:viewer', 'project', 'p-ledger', 'viewer');
  assert.throws(() => w.nx.artifacts.saveInline(viewer, { projectId: 'p-ledger', workspaceId: 'sde', kind: 'requirement', target: { name: 'V' }, content: GOOD_REQ }), code('denied'));
  healthy(w); w.close();
});

test('E14 inputs are a subset of the job\'s inputs: an output claiming an input the job was not granted is input_not_granted', () => {
  const w = execWorld({ realIngest: true }); const runner = w.attach();
  const job = w.exec.start(w.me, w.req('sde.build.run')).job; w.exec.tick(w.now()); w.provision(runner, job.id);
  const buildA = w.nx.artifacts.create(w.me, { projectId: 'p-ledger', workspaceId: 'sde', kind: 'build', name: 'b' });
  // The B0b rule on the public path: the suite was never granted to this build job.
  assert.throws(() => w.nx.artifacts.registerVersion(w.sys, { artifactId: buildA.id, storage: { kind: 'inline', json: { x: 1 } }, producedByJobId: job.id,
    inputs: [{ versionId: w.suiteV, role: 'suite' }] }), code('input_not_granted'));
  // The same rule on the ingest path.
  assert.throws(() => w.db.transaction(() => w.nx.artifacts.insertSystemVersionTx(w.sys, { artifactId: buildA.id,
    storage: { kind: 'tree', manifestSha256: 'a'.repeat(64), files: 0, bytes: 0 }, contentHash: 'tree:x', metadata: {}, environment: null, jobId: job.id,
    outputPath: 'dist', action: 'exec.build', onBehalfOf: 'user:local', now: w.now(),
    inputs: [{ versionId: w.suiteV, role: 'suite', relation: 'derived_from', source: 'job_input' }] })).immediate(), code('input_not_granted'));
  // Granted, it is accepted (and blob/tree storage is open to the ingest path only).
  const v = w.db.transaction(() => w.nx.artifacts.insertSystemVersionTx(w.sys, { artifactId: buildA.id,
    storage: { kind: 'tree', manifestSha256: 'a'.repeat(64), files: 0, bytes: 0 }, contentHash: 'tree:x', metadata: {}, environment: null, jobId: job.id,
    outputPath: 'dist', action: 'exec.build', onBehalfOf: 'user:local', now: w.now(),
    inputs: [{ versionId: w.repoV, role: 'repository', relation: 'built_from', source: 'job_input' }] })).immediate();
  assert.equal(v.status, 'draft'); assert.equal(v.storage.kind, 'tree');
  assert.throws(() => w.nx.artifacts.registerVersion(w.me, { artifactId: buildA.id, storage: { kind: 'tree', manifestSha256: 'a'.repeat(64), files: 0, bytes: 0 } }),
    code('storage_unavailable'));
  assert.throws(() => w.nx.artifacts.create(w.me, { projectId: 'p-ledger', workspaceId: 'sde', kind: 'repository', name: 'r' }), code('invalid'));
  w.close();
});

// ---------- the ingest contract ----------

test('ingest never runs while blob GC holds the store: the exit is durable (collecting), ingest waits, then completes', async () => {
  const w = execWorld({ realIngest: true }); const runner = w.attach();
  const job = w.exec.start(w.me, w.req('sde.build.run')).job; w.exec.tick(w.now()); w.provision(runner, job.id);
  const release = w.nx.blobs.lock.tryExclusive();
  assert.ok(release);
  w.exitWith(runner, job.id, { outputs: [w.file('dist/app.js', 'x')] });
  await new Promise((res) => setImmediate(res));
  assert.equal(w.job(job.id).phase, 'collecting'); assert.equal(w.jobState(job.id), 'running');
  assert.equal(count(w, 'artifact_versions WHERE produced_by_job_id = ?', job.id), 0);
  assert.equal(count(w, 'blobs'), 0);
  const ev = w.events(job.id, 'attempt.output');
  assert.equal(ev.length, 1); assert.equal(JSON.parse(ev[0].data_json).exit, 0);
  release();
  await w.settle();
  assert.equal(w.jobState(job.id), 'completed');
  assert.equal(count(w, 'artifact_versions WHERE produced_by_job_id = ?', job.id), 1);
  assert.ok(runner.sentOf('attempt.release').some((m) => m.attemptId === w.attempts(job.id)[0].id));
  healthy(w); w.close();
});

test('a candidate test suite with sde.tests_pass passed makes the tests step done; validate jobs never use job_inputs', async () => {
  const w = execWorld({ realIngest: true });
  const r = await w.runTests({ discovery: ['test/a.test.js', 'test/b.test.js'],
    junit: junit([{ name: 'a1' }, { name: 'b1', file: 'test/b.test.js' }, { name: 'b2', file: 'test/b.test.js', outcome: 'skipped' }]), exit: 0 });
  assert.equal(w.version(r.suiteVersionId).status, 'candidate');
  assert.equal(w.latest(r.suiteVersionId, 'sde.tests_pass').status, 'passed');
  assert.equal(w.stepState('sde', 'tests'), 'done');
  assert.equal(w.exec.get(w.me, r.discoveryJobId).headline, 'checks_passed');
  const tj = w.job(r.testJobId);
  assert.equal(tj.kind, 'validate'); assert.equal(tj.parent_job_id, r.discoveryJobId); assert.equal(JSON.parse(tj.params_json).versionId, r.suiteVersionId);
  assert.equal(count(w, 'job_inputs WHERE job_id = ?', r.testJobId), 0);
  // The plan ran the discovered files of the draft suite (read from params.versionId by the system).
  const start = w.attach().sentOf('attempt.start').find((m) => m.attemptId === w.attempts(r.testJobId)[0].id);
  assert.ok(start.plan.container.argv.includes('test/b.test.js'));
  // The JUnit bytes stay with the suite they judged; the ids.txt list too.
  assert.deepEqual(w.db.prepare('SELECT role FROM version_blobs WHERE version_id = ? ORDER BY role').all(r.suiteVersionId).map((x) => x.role), ['discovery', 'junit']);
  assert.equal(count(w, "artifact_edges WHERE from_version_id = ? AND to_version_id = ? AND source = 'job_input'", r.suiteVersionId, w.repoV), 1);
  healthy(w); w.close();
});

test('the normalized re-validation refuses bad shapes (parser_contract) and the tests check never trusts a mismatched report', () => {
  assert.equal(N.checkJunit({ sha256: 'x' }).ok, false);
  assert.equal(N.checkJunit({ sha256: 'a'.repeat(64), total: 1, passed: 1, failed: 0, errored: 0, skipped: 0, cases: [{ id: 'a', classname: 'c', name: 'n', outcome: 'won', ms: 1 }] }).ok, false);
  assert.equal(N.checkDiscovery({ framework: 'cargo', ids: [], files: [] }).ok, false);
  assert.equal(N.checkDiscovery({ framework: 'jest', ids: ['a', 'a'], files: [] }).ok, false);
  assert.equal(N.checkGitFacts({ commit: 'abc', branch: 'main', dirty: false, tree: TREE }).ok, false);
  assert.ok(N.appManifestErrors({ ...MANIFEST, env: ['TOKEN=x'] }).some((e) => e.path === '/env'));
  assert.deepEqual(N.appManifestErrors(MANIFEST), []);
  const base = { junitSha256: 'a'.repeat(64), exit: { code: 0, oomKilled: false }, discovery: { ids: ['t'], files: ['t'] }, imageId: null, lockfileSha256: null };
  const good = { sha256: 'a'.repeat(64), total: 1, passed: 1, failed: 0, errored: 0, skipped: 0, cases: [{ id: 'x', classname: 'c', name: 'n', outcome: 'passed', ms: 1 }] };
  assert.equal(testsPass.run({ ...base, junit: good }).status, 'passed');
  assert.equal(testsPass.run({ ...base, junit: { ...good, sha256: 'b'.repeat(64) } }).reason, 'junit_missing', 'a parse of another report');
  assert.equal(testsPass.run({ ...base, junit: { ...good, total: 'one' } }).status, 'error');
  assert.equal(testsPass.run({ ...base, junit: good, junitSha256: null }).reason, 'junit_missing');
});

// ---------- the execution orphan queries ----------

test('O10-O17 count 0 on a database without the v9 tables', () => {
  const { file } = h.v6Fixture();
  const s = new PersistStore(file);
  s.open({ log: () => {}, backupDir: path.join(path.dirname(file), 'b'), now: () => h.NOW });
  assert.deepEqual(execOrphans(s.platformDatabase()), EXEC_ZERO);
  s.close();
});

test('O10-O17 find what they name (negative controls with the guards dropped)', async () => {
  const w = execWorld({ realIngest: true }); const r = await w.runTests({ skipTests: true });
  const b = await w.runBuild({ files: ['app.js'] });
  healthy(w);
  const db = w.db;
  db.pragma('foreign_keys = OFF');
  for (const t of db.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger'").all()) db.exec(`DROP TRIGGER "${t.name}"`);
  db.exec('DROP INDEX ux_attempts_live');
  const a = w.attempts(r.discoveryJobId)[0];
  db.prepare("UPDATE job_attempts SET n = 9 WHERE id = ?").run(a.id);                                                         // O10
  db.pragma('ignore_check_constraints = ON');
  db.prepare("UPDATE job_attempts SET exit_code = NULL WHERE job_id = ?").run(b.buildJobId);                                     // O13
  const tj = w.validateJobs(r.suiteVersionId, 'sde.tests_pass')[0];
  db.prepare("UPDATE jobs SET state = 'completed' WHERE id = ?").run(tj.id);                                                     // O17 (no attempt)
  db.prepare("INSERT INTO job_attempts (id, job_id, n, state, boot_id, lease_owner, lease_expires_at, created_at, updated_at) VALUES ('att-1', ?, 5, 'running', ?, ?, 1, 1, 1)")
    .run(tj.id, w.bootId, w.bootId);                                                                                              // O12
  db.prepare("INSERT INTO job_attempts (id, job_id, n, state, boot_id, lease_owner, lease_expires_at, created_at, updated_at) VALUES ('att-2', ?, 6, 'starting', ?, ?, 1, 1, 1)")
    .run(tj.id, w.bootId, w.bootId);                                                                                              // O11 (+O10)
  db.prepare("INSERT INTO version_blobs (version_id, sha256, role, path) VALUES (?, ?, 'file', 'ghost.js')").run(b.buildVersionId, 'd'.repeat(64)); // O14
  db.prepare("UPDATE validations SET job_id = 'job-gone' WHERE version_id = ? AND validator_id = 'suite.discovered'").run(r.suiteVersionId); // O15
  db.prepare("UPDATE artifact_versions SET status = 'candidate' WHERE id = ?").run(b.buildVersionId);                           // O16
  const n = execOrphans(db);
  for (const id of Object.keys(EXEC_ZERO)) assert.ok(n[id] >= 1, `${id} found nothing: ${JSON.stringify(n)}`);
  w.close();
});

// ---------- fix round 1 (review of f603fe06): one test per finding, R1-R15 ----------
const { PlatformError } = loadTs('src/main/nexus/errors.ts');
const { stepStateFrom } = loadTs('src/shared/nexus/stepState.ts');
const { getDomain } = loadTs('src/shared/nexus/domains/index.ts');
const { checkEvidence } = loadTs('src/main/nexus/validation/evidenceShape.ts');
const { FakeRunner } = require('./helpers/fakeRunner.cjs');
const { MAX_TREE_FILES } = loadTs('src/main/nexus/exec/ingest.ts');
const { MAX_DISCOVERED_FILES } = loadTs('src/main/nexus/exec/planBuilder.ts');
const { FULL_PASS_MS } = loadTs('src/main/nexus/validation/checkRunner.ts');
const { BLOB_GC_MIN_AGE_MS } = loadTs('src/main/nexus/blobs/blobIndex.ts');

/** Every text cell of the tables a secret must never reach, joined (for a doesNotMatch). */
function storedText(w) {
  const q = (sql) => w.db.prepare(sql).all().map((r) => Object.values(r).join(' ')).join('\n');
  return [q('SELECT storage_ref_json, metadata_json FROM artifact_versions'), q('SELECT error_json, params_json FROM jobs'),
    q('SELECT summary, data_json FROM job_events'), q('SELECT details_json FROM activity'), q('SELECT summary, evidence_json FROM validations'),
    q('SELECT error_json FROM job_attempts')].join('\n');
}
/** A discovery through the fake runner with this list (no test check run). */
function discover(w, files, x = {}) {
  const r = w.attach();
  const d = w.exec.start(w.me, w.req('sde.tests.discover')).job;
  w.exec.tick(w.now()); w.provision(r, d.id, { c: x.c ?? 'a' });
  const ids = w.file('ids.txt', files.join('\n'));
  w.exitWith(r, d.id, { code: 0, outputs: [ids], parsed: [{ parser: 'discovery', sourceSha256: ids.sha256, normalized: { framework: 'node-test', ids: x.ids ?? files, files } }] });
  return d;
}
/** Run the queued sde.tests_pass check of a suite with this JUnit (through the scheduler and the fake runner). */
async function runCheck(w, suiteVersionId, jr, exit = 0) {
  const r = w.attach();
  const tj = w.validateJobs(suiteVersionId, 'sde.tests_pass').find((j) => j.state === 'queued');
  w.exec.tick(w.now()); w.provision(r, tj.id, { c: 'b' });
  const start = r.sentOf('attempt.start').find((m) => m.attemptId === w.liveAttempt(tj.id).id);
  const jf = w.file('junit.xml', JSON.stringify(jr));
  w.exitWith(r, tj.id, { code: exit, outputs: [jf], parsed: [{ parser: 'junit', sourceSha256: jf.sha256, normalized: { sha256: jf.sha256, ...jr } }] });
  await w.settle();
  return { tj, start };
}

test('R1 the validation pass runs only when work is due: queued checks, an ended check job, a waiting re-hash or the periodic pass (C20b)', async () => {
  const w = execWorld({ realIngest: true }); w.attach();
  const runner = w.nx.validation.runner;
  let passes = 0; const orig = runner.runPending.bind(runner);
  runner.runPending = (now) => { passes++; return orig(now); };
  w.exec.tick(w.now());                                   // the first pass after start scans once (a restart may have left checks)
  const first = passes;
  assert.ok(first >= 1);
  for (let i = 0; i < 20; i++) { w.advance(500); w.exec.tick(w.now()); }
  assert.equal(passes, first, 'no pass while nothing is due');
  // New checks queued by an ingest: one pass.
  const b = await w.runBuild({ files: ['a.js'] });
  passes = 0; w.advance(500); w.exec.tick(w.now());
  assert.ok(passes <= 1);
  passes = 0; for (let i = 0; i < 5; i++) { w.advance(500); w.exec.tick(w.now()); }
  assert.equal(passes, 0, 'a waiting re-hash is timed out in memory, without a pass');
  w.answerVerifies(w.attach(), true); await w.settle();
  assert.equal(w.version(b.buildVersionId).status, 'candidate', 'the answers completed the check without a scheduler pass');
  // A recipe check that ends without its report: the job-end event, not every tick, brings the pass that records it.
  const r = await w.runTests({ skipTests: true });
  const tj = w.validateJobs(r.suiteVersionId, 'sde.tests_pass')[0];
  w.exec.tick(w.now()); w.provision(w.attach(), tj.id, { c: 'b' });
  runner.runPending = (now) => { passes++; }; passes = 0;   // nothing records it but the gated tick
  w.exitWith(w.attach(), tj.id, { code: 0, outputs: [], parsed: [] });
  assert.equal(w.jobState(tj.id), 'failed'); assert.equal(w.latest(r.suiteVersionId, 'sde.tests_pass'), undefined);
  runner.runPending = (now) => { passes++; return orig(now); }; passes = 0;
  w.advance(500); w.exec.tick(w.now());
  assert.equal(passes, 1, 'one pass on the job-end event');
  assert.equal(w.latest(r.suiteVersionId, 'sde.tests_pass').status, 'failed');
  // The periodic safety pass.
  passes = 0; w.advance(FULL_PASS_MS); w.exec.tick(w.now());
  assert.equal(passes, 1);
  healthy(w); w.close();
});

test('R2 validate and ingest jobs are the system\'s: the public create refuses them; a bad check job fails once, never completes', async () => {
  const w = execWorld({ realIngest: true });
  for (const kind of ['validate', 'ingest']) {
    assert.throws(() => w.nx.jobs.create(w.me, { kind, projectId: 'p-ledger', workspaceId: 'sde', idempotencyKey: `k-${kind}`, validatorId: 'req.schema',
      params: { versionId: w.suiteV } }), code('invalid', 'system_job_kind'));
  }
  // P12: a member cannot carry revalidate:true onto a cancelled_partial draft through the public create.
  const member = w.addUser('user:member', 'project', 'p-ledger', 'member');
  assert.throws(() => w.nx.jobs.create(member, { kind: 'validate', projectId: 'p-ledger', workspaceId: 'sde', idempotencyKey: 'k-m',
    validatorId: 'req.schema', params: { versionId: w.suiteV, revalidate: true } }), code('invalid', 'system_job_kind'));
  assert.equal(count(w, "jobs WHERE kind = 'validate'"), 0);
  // P1b: a system validate job naming no known validator, or no version: failed invalid_check, never completed (O17 stays 0).
  const mk = (key, extra) => w.nx.jobs.create(w.sys, { kind: 'validate', projectId: 'p-ledger', workspaceId: 'sde', idempotencyKey: key, ...extra }).job.id;
  const unknown = mk('k1', { validatorId: 'nope', params: { versionId: w.suiteV } });
  const noVersion = mk('k2', { validatorId: 'suite.discovered', params: {} });
  const gone = mk('k3', { validatorId: 'suite.discovered', params: { versionId: 'no-such-version' } });
  const wrongKind = mk('k4', { validatorId: 'req.schema', params: { versionId: w.suiteV } });
  const noRecipe = mk('k5', { validatorId: 'sde.tests_pass', params: { versionId: w.suiteV } });
  // P11: a validate job in another project aimed at p-ledger's suite: refused once, not retried on every tick.
  const pwInv = w.nx.workspaces.primaryOf(w.me, 'p-invoice');
  const cross = w.nx.jobs.create(w.sys, { kind: 'validate', projectId: 'p-invoice', workspaceId: pwInv.workspaceId, idempotencyKey: 'k6',
    validatorId: 'suite.discovered', params: { versionId: w.suiteV } }).job.id;
  w.nx.validation.runPending(w.now());
  const expect = { [unknown]: 'unknown_validator', [noVersion]: 'version_missing', [gone]: 'version_missing', [wrongKind]: 'kind_mismatch',
    [noRecipe]: 'not_runnable', [cross]: 'version_mismatch' };
  for (const [id, why] of Object.entries(expect)) {
    const j = w.job(id);
    assert.equal(j.state, 'failed', why); assert.equal(j.outcome, 'invalid_check'); assert.equal(JSON.parse(j.error_json).code, why);
    const [a] = w.attempts(id);
    assert.equal(a.state, 'failed'); assert.equal(a.outcome, 'invalid_check');
    assert.equal(count(w, 'validations WHERE job_id = ?', id), 0);
  }
  const before = w.logs.length;
  for (let i = 0; i < 5; i++) { w.advance(5000); w.exec.tick(w.now()); }
  assert.equal(w.logs.slice(before).filter((l) => /validation/.test(l)).length, 0, 'no poison job: nothing is retried on the next ticks');
  assert.equal(w.orphans().O17, 0);
  // The framework's own path still creates a user's revalidation (E3), on the user's behalf.
  const { version } = w.nx.artifacts.saveInline(w.me, { projectId: 'p-ledger', workspaceId: 'sde', kind: 'requirement', target: { name: 'R2' }, content: GOOD_REQ });
  const { jobs } = w.nx.validation.revalidate(w.me, version.id);
  assert.equal(w.job(jobs[0]).requested_by, 'user:local'); assert.equal(w.jobState(jobs[0]), 'completed');
  healthy(w); w.close();
});

test('R3 secret-shaped runner facts never reach a version: ingest refuses invalid_output secret_in_output, once, not retried', async () => {
  const w = execWorld({ realIngest: true, resolveCommit: resolver() });
  const tok = 'ghp_' + 'A1b2C3d4E5'.repeat(4);
  const key = 'sk-' + 'q'.repeat(40);
  // A branch named like a token (the snapshot recipe is retryable: still failed, not retry_scheduled).
  const j = await w.snapshot({ commit: NEWC, branch: tok, dirty: false, tree: TREE });
  assert.equal(w.jobState(j), 'failed'); assert.equal(w.job(j).outcome, 'invalid_output');
  assert.equal(JSON.parse(w.job(j).error_json).code, 'secret_in_output');
  assert.equal(count(w, 'artifact_versions WHERE produced_by_job_id = ?', j), 0);
  // A discovered test file named after a key (discovery is retryable too).
  const d = discover(w, [`test/${key}.test.js`]); await w.settle();
  assert.equal(w.jobState(d.id), 'failed'); assert.equal(JSON.parse(w.job(d.id).error_json).code, 'secret_in_output');
  assert.equal(count(w, 'artifact_versions WHERE produced_by_job_id = ?', d.id), 0);
  // A manifest argument carrying a key.
  const b = await w.runBuild({ files: ['server.js'] }); w.answerVerifies(w.attach(), true); await w.settle();
  const job = w.exec.start(w.me, w.req('sde.app.assemble', { inputs: [{ versionId: b.buildVersionId, slot: 'build' }] })).job;
  w.exec.tick(w.now()); w.provisionEngine(w.attach(), job.id);
  w.exitWith(w.attach(), job.id, { code: 0, parsed: [{ parser: 'app-manifest', sourceSha256: 'd'.repeat(64),
    normalized: { manifest: { ...MANIFEST, run: ['node', 'dist/server.js', `--key=${key}`] } } }] });
  await w.settle();
  assert.equal(w.jobState(job.id), 'failed'); assert.equal(JSON.parse(w.job(job.id).error_json).code, 'secret_in_output');
  const text = storedText(w);
  assert.doesNotMatch(text, new RegExp(tok)); assert.doesNotMatch(text, new RegExp(key));
  // The system insert itself refuses them (metadata, inline content, git ref): defence in depth.
  const runner = w.attach();
  const bj = w.exec.start(w.me, w.req('sde.build.run')).job; w.exec.tick(w.now()); w.provision(runner, bj.id, { c: 'f' });
  const art = w.version(b.buildVersionId).artifact_id;
  const ins = (o) => () => w.db.transaction(() => w.nx.artifacts.insertSystemVersionTx(w.sys, { artifactId: art, contentHash: 'x', metadata: {},
    storage: { kind: 'inline', json: {} }, environment: null, jobId: bj.id, outputPath: null, action: null, onBehalfOf: 'user:local', inputs: [], now: w.now(), ...o })).immediate();
  assert.throws(ins({ metadata: { note: key } }), code('invalid', 'secret_in_metadata'));
  assert.throws(ins({ storage: { kind: 'inline', json: { run: [key] } } }), code('invalid', 'secret_in_metadata'));
  assert.throws(ins({ storage: { kind: 'git', commit: NEWC, ref: tok } }), code('invalid', 'secret_in_metadata'));
  w.exec.cancel(w.me, bj.id);
  healthy(w); w.close();
});

test('R4 a suite never passes on a subset: the whole discovered list is stored and run; a file with no case fails; over-limit lists are refused', async () => {
  // P13: 1,500 files are all kept and all run.
  const files = Array.from({ length: 1500 }, (_, i) => `test/t${String(i).padStart(4, '0')}.test.js`);
  const w = execWorld({ realIngest: true });
  discover(w, files); await w.settle();
  const suite = w.db.prepare("SELECT * FROM artifact_versions WHERE output_path = 'ids.txt'").get();
  const meta = JSON.parse(suite.metadata_json);
  assert.equal(meta.files.length, 1500); assert.equal(meta.discovery.truncated, false); assert.equal(meta.discovery.filesCount, 1500);
  // The runner ran only 1,000 of them: discovered_not_run, the suite fails.
  const ran = files.slice(0, 1000);
  const { start } = await runCheck(w, suite.id, junit(ran.map((f) => ({ name: 'ok', file: f }))));
  assert.equal(start.plan.container.argv.filter((a) => /^test\/t\d+\.test\.js$/.test(a)).length, 1500, 'the plan runs the whole list');
  const tp = w.latest(suite.id, 'sde.tests_pass');
  assert.equal(tp.status, 'failed'); assert.match(tp.summary, /discovered_not_run/);
  assert.equal(w.version(suite.id).status, 'failed');
  // The whole list ran: it passes.
  const w2 = execWorld({ realIngest: true });
  discover(w2, files); await w2.settle();
  const s2 = w2.db.prepare("SELECT id FROM artifact_versions WHERE output_path = 'ids.txt'").get().id;
  await runCheck(w2, s2, junit(files.map((f) => ({ name: 'ok', file: f }))));
  assert.equal(w2.latest(s2, 'sde.tests_pass').status, 'passed'); assert.equal(w2.version(s2).status, 'candidate');
  // More files than a test run takes: refused at ingest, deterministic (discovery is retryable, yet it is not retried).
  const w3 = execWorld({ realIngest: true });
  const many = Array.from({ length: MAX_DISCOVERED_FILES + 1 }, (_, i) => `test/m${i}.test.js`);
  const d3 = discover(w3, many); await w3.settle();
  assert.equal(w3.jobState(d3.id), 'failed'); assert.equal(JSON.parse(w3.job(d3.id).error_json).code, 'discovery_too_large');
  assert.equal(count(w3, 'artifact_versions WHERE produced_by_job_id = ?', d3.id), 0);
  // A stored list marked truncated (an older version) never passes.
  const base = { junitSha256: 'a'.repeat(64), exit: { code: 0, oomKilled: false }, imageId: null, lockfileSha256: null };
  const good = { sha256: 'a'.repeat(64), total: 1, passed: 1, failed: 0, errored: 0, skipped: 0, cases: [{ id: 't::c::n', file: 't', classname: 'c', name: 'n', outcome: 'passed', ms: 1 }] };
  assert.equal(testsPass.run({ ...base, junit: good, discovery: { ids: ['t'], files: ['t'] } }).status, 'passed');
  assert.equal(testsPass.run({ ...base, junit: good, discovery: { ids: ['t'], files: ['t'], truncated: true } }).reason, 'discovery_truncated');
  healthy(w); healthy(w2); healthy(w3); w.close(); w2.close(); w3.close();
});

test('R5 the main thread stays responsive at the largest tree: bounded slices, one query per check, O(1) answers; oversized trees refused', async () => {
  const w = execWorld({ realIngest: true }); const runner = w.attach();
  const b = w.exec.start(w.me, w.req('sde.build.run')).job; w.exec.tick(w.now()); w.provision(runner, b.id, { c: 'd' });
  const outputs = Array.from({ length: MAX_TREE_FILES }, (_, i) => w.file(`dist/sub${i % 50}/f${i}.js`, `content ${i}`));
  const ms = (t) => Number(process.hrtime.bigint() - t) / 1e6;
  const slices = { commit: [], pass: [] };
  const commit = w.exec.commitIngest.bind(w.exec);
  w.exec.commitIngest = (...a) => { const t = process.hrtime.bigint(); try { return commit(...a); } finally { slices.commit.push(ms(t)); } };
  const cr = w.nx.validation.runner; const pass = cr.runPending.bind(cr);
  let prepares = 0; const prep = w.db.prepare.bind(w.db);
  cr.runPending = (now) => { const t = process.hrtime.bigint(); try { return pass(now); } finally { slices.pass.push(ms(t)); } };
  let t = process.hrtime.bigint();
  w.exitWith(runner, b.id, { code: 0, outputs });
  const exitMs = ms(t);
  // The exit is durable and the handler returned: the large commit runs on a later turn.
  assert.equal(w.job(b.id).phase, 'collecting'); assert.equal(count(w, 'artifact_versions WHERE produced_by_job_id = ?', b.id), 0);
  w.db.prepare = (sql) => { prepares++; return prep(sql); };
  await w.settle();
  w.db.prepare = prep;
  assert.equal(w.jobState(b.id), 'completed');
  assert.ok(prepares < 400, `the build checks prepare ${prepares} statements for ${MAX_TREE_FILES} files (one query per check, not one per file)`);
  const sent = runner.sentOf('blob.verify');
  assert.equal(sent.length, MAX_TREE_FILES);
  t = process.hrtime.bigint();
  for (const m of sent) runner.report({ op: 'blob.verified', sha256: m.sha256, ok: true });
  const answersMs = ms(t);
  await w.settle();
  const v = w.db.prepare("SELECT id, status FROM artifact_versions WHERE produced_by_job_id = ?").get(b.id);
  assert.equal(v.status, 'candidate');
  console.log(`# R5 ${MAX_TREE_FILES} files: exit handler ${exitMs.toFixed(1)} ms; commit ${slices.commit.map((x) => x.toFixed(1)).join(', ')} ms; `
    + `longest pass ${Math.max(...slices.pass).toFixed(1)} ms; ${sent.length} answers ${answersMs.toFixed(1)} ms`);
  assert.ok(exitMs < 500, `exit handler ${exitMs} ms`);
  assert.ok(Math.max(...slices.commit) < 2000, `ingest commit ${slices.commit} ms`);
  assert.ok(Math.max(...slices.pass) < 1500, `longest validation pass ${Math.max(...slices.pass)} ms`);
  assert.ok(answersMs < 2000, `${sent.length} re-hash answers took ${answersMs} ms (linear, not quadratic)`);
  // One file more than a tree may hold: refused (invalid_output tree_too_large); nothing stored.
  const w2 = execWorld({ realIngest: true }); const r2 = w2.attach();
  const b2 = w2.exec.start(w2.me, w2.req('sde.build.run')).job; w2.exec.tick(w2.now()); w2.provision(r2, b2.id, { c: 'd' });
  w2.exitWith(r2, b2.id, { code: 0, outputs: Array.from({ length: MAX_TREE_FILES + 1 }, (_, i) => w2.file(`dist/f${i}.js`, `c ${i}`)) });
  await w2.settle();
  assert.equal(w2.jobState(b2.id), 'failed'); assert.equal(w2.job(b2.id).outcome, 'invalid_output');
  assert.equal(JSON.parse(w2.job(b2.id).error_json).code, 'tree_too_large');
  assert.equal(count(w2, 'blobs'), 0);
  healthy(w); healthy(w2); w.close(); w2.close();
});

test('R6 a version that is no longer a draft takes no blocking row: dedupe and user runs are advisory evidence; O16 reads the latest row', async () => {
  // P2: the same commit snapshotted again after the folder moved: the second check fails, the active version is untouched.
  let n = 0;
  const w = execWorld({ realIngest: true, resolveCommit: async (root, sha) => (++n === 1 ? { commit: sha } : { error: 'bad object' }) });
  const j1 = await w.snapshot({ commit: NEWC, branch: 'main', dirty: false, tree: TREE });
  const v1 = w.db.prepare('SELECT * FROM artifact_versions WHERE produced_by_job_id = ?').get(j1);
  assert.equal(v1.status, 'active');
  const j2 = await w.snapshot({ commit: NEWC, branch: 'main', dirty: false, tree: TREE });
  assert.equal(w.jobState(j2), 'completed', 'the deduplicated output is still the attempt\'s evidence');
  const row = w.db.prepare('SELECT * FROM validations WHERE job_id = ? AND attempt_n = 1').get(j2);
  assert.equal(row.version_id, v1.id); assert.equal(row.status, 'failed'); assert.equal(row.blocking, 0); assert.equal(row.advisory, 1);
  assert.equal(w.version(v1.id).status, 'active');
  assert.equal(w.db.prepare("SELECT status FROM validations WHERE version_id = ? AND blocking = 1 ORDER BY finished_at DESC, rowid DESC").get(v1.id).status, 'passed');
  assert.equal(w.stepState('sde', 'repository'), 'done');
  assert.equal(w.exec.get(w.me, j2).headline, 'checks_failed', 'the job reports its own result');
  // P5: a user's run on the candidate suite that fails: advisory on the suite, which stays a candidate.
  const r0 = await w.runTests({ discovery: ['test/a.test.js'], junit: junit([{ name: 'a' }]), exit: 0 });
  assert.equal(w.version(r0.suiteVersionId).status, 'candidate');
  const runner = w.attach();
  const uj = w.exec.start(w.me, w.req('sde.tests.run', { inputs: [{ versionId: r0.suiteVersionId, slot: 'suite' }] })).job;
  w.exec.tick(w.now()); w.provision(runner, uj.id, { c: 'e' });
  const jr = junit([{ name: 'a', outcome: 'failed' }]); const jf = w.file('junit.xml', JSON.stringify(jr));
  w.exitWith(runner, uj.id, { code: 1, outputs: [jf], parsed: [{ parser: 'junit', sourceSha256: jf.sha256, normalized: { sha256: jf.sha256, ...jr } }] });
  await w.settle();
  assert.equal(w.jobState(uj.id), 'completed'); assert.equal(w.exec.get(w.me, uj.id).headline, 'checks_failed');
  const ur = w.db.prepare('SELECT * FROM validations WHERE job_id = ?').get(uj.id);
  assert.equal(ur.status, 'failed'); assert.equal(ur.blocking, 0); assert.equal(ur.advisory, 1);
  assert.equal(w.version(r0.suiteVersionId).status, 'candidate');
  assert.equal(w.stepState('sde', 'tests'), 'done');
  healthy(w);
  // O16 reads the latest blocking row: a newer blocking failure on a candidate is found (a passed row in history is not enough).
  w.db.prepare(`INSERT INTO validations (id, version_id, validator_id, validator_version, stage, status, blocking, advisory, summary, evidence_json,
      job_id, attempt_n, created_by, started_at, finished_at) VALUES ('v-late', ?, 'sde.tests_pass', '1', 'candidate', 'failed', 1, 0, 'x', '[]', NULL, NULL, 'system', ?, ?)`)
    .run(r0.suiteVersionId, w.now() + 10, w.now() + 10);
  assert.equal(w.orphans().O16, 1);
  w.close();
});

test('R7 revalidate is bounded: while a check of the (version, validator) is live it is returned, never a second one', async () => {
  const w = execWorld({ realIngest: true });
  const r = await w.runTests({ skipTests: true });
  const live = w.validateJobs(r.suiteVersionId, 'sde.tests_pass')[0].id;
  for (let i = 0; i < 60; i++) assert.deepEqual(w.nx.validation.revalidate(w.me, r.suiteVersionId).jobs.includes(live), true);
  assert.equal(count(w, "jobs WHERE kind = 'validate' AND validator_id = 'sde.tests_pass' AND state IN ('queued','leased','running')"), 1);
  // Once it ended, a revalidation queues a new one.
  w.exec.cancel(w.me, live);
  const again = w.nx.validation.revalidate(w.me, r.suiteVersionId).jobs;
  assert.equal(again.length, 2); assert.ok(!again.includes(live));
  w.close();
});

test('R8 output deduplicated onto a draft finalizes it: a snapshot whose first check could not run becomes active on the second', async () => {
  const gate = { ok: true };
  const w = execWorld({ realIngest: true, resolveCommit: async (root, sha) => ({ commit: sha }), acceptFsRoot: (root) => (gate.ok ? root : null) });
  /** A snapshot whose plan had the folder (the lease), and whose ingest may not (`rootAtExit`). */
  const snap = async (rootAtExit) => {
    const r = w.attach();
    const j = w.exec.start(w.me, w.req('sde.repository.snapshot')).job;
    w.exec.tick(w.now()); w.provisionEngine(r, j.id);
    gate.ok = rootAtExit;
    w.exitWith(r, j.id, { code: 0, parsed: [{ parser: 'repo-snapshot', sourceSha256: 'e'.repeat(64), normalized: { commit: NEWC, branch: 'main', dirty: false, tree: TREE } }] });
    await w.settle();
    gate.ok = true;
    return j.id;
  };
  const j1 = await snap(false);
  const v1 = w.db.prepare('SELECT * FROM artifact_versions WHERE produced_by_job_id = ?').get(j1);
  assert.equal(v1.status, 'draft'); assert.equal(w.latest(v1.id, 'git.head_resolves').status, 'error');
  const j2 = await snap(true);
  assert.equal(count(w, 'artifact_versions WHERE produced_by_job_id = ?', j2), 0, 'one version');
  assert.equal(w.latest(v1.id, 'git.head_resolves').status, 'passed'); assert.equal(w.latest(v1.id, 'git.head_resolves').blocking, 1);
  assert.equal(w.version(v1.id).status, 'active');
  // A build deduplicated onto a draft whose re-hash was lost queues its checks again and completes.
  const b1 = await w.runBuild({ files: ['a.js'] });
  w.attach().report({ op: 'fault', message: 'the docker daemon went away' }); await w.settle();
  assert.equal(w.latest(b1.buildVersionId, 'blob.integrity').status, 'error');
  const b2 = await w.runBuild({ files: ['a.js'] });
  assert.equal(b2.buildVersionId, null, 'the same tree is the same version');
  w.answerVerifies(w.attach(), true); await w.settle();
  assert.equal(w.version(b1.buildVersionId).status, 'candidate');
  healthy(w); w.close();
});

test('R9 only a runner-wide fault errors outstanding re-hashes: a fault about one attempt does not; a port that leaves ready or is replaced does', async () => {
  const w = execWorld({ realIngest: true });
  const b = await w.runBuild({ files: ['a.js'] });
  const runner = w.attach();
  const d = w.exec.start(w.me, w.req('sde.tests.discover')).job; w.exec.tick(w.now()); const a = w.provision(runner, d.id, { c: 'e' });
  runner.report({ op: 'fault', attemptId: a.id, message: 'log write failed for that attempt' });
  runner.report({ op: 'fault', attemptId: a.id, failureClass: 'docker_error', message: 'a later hiccup on that attempt' });
  w.answerVerifies(runner, true); await w.settle();
  assert.equal(w.latest(b.buildVersionId, 'blob.integrity').status, 'passed');
  assert.equal(w.version(b.buildVersionId).status, 'candidate');
  // The port leaves ready while a re-hash is out: error (Revalidate offered), never passed.
  const b2 = await w.runBuild({ files: ['b.js'] });
  runner.setState('crashed'); w.exec.tick(w.now()); await w.settle();
  assert.equal(w.latest(b2.buildVersionId, 'blob.integrity').status, 'error');
  // A replaced port: the old one's re-hashes are error.
  runner.setState('ready'); w.exec.tick(w.now());
  w.nx.validation.revalidate(w.me, b2.buildVersionId); await w.settle();
  assert.ok(runner.sentOf('blob.verify').length >= 3);
  const before = w.validations(b2.buildVersionId).filter((x) => x.validator_id === 'blob.integrity').length;
  w.exec.attachRunner(new FakeRunner(), w.bootId); await w.settle();
  const rows = w.validations(b2.buildVersionId).filter((x) => x.validator_id === 'blob.integrity');
  assert.equal(rows.length, before + 1); assert.equal(rows[rows.length - 1].status, 'error');
  healthy(w); w.close();
});

test('R10 evidence is validated against the Evidence union; only its typed digest positions are exempt from the secret check', () => {
  const w = execWorld({ realIngest: true });
  const { version } = w.nx.artifacts.saveInline(w.me, { projectId: 'p-ledger', workspaceId: 'sde', kind: 'requirement', target: { name: 'R10' }, content: GOOD_REQ });
  const hexSecret = 'deadbeef'.repeat(8);
  const rec = (evidence) => w.db.transaction(() => w.nx.validation.recordResultTx(w.sys, { versionId: version.id, validatorId: 'req.schema',
    status: 'passed', summary: 'fine', evidence })).immediate();
  // P9: a digest-named key inside a free-form member, an unknown type, an extra field: not the union (bad_evidence).
  for (const ev of [[{ type: 'schema', schemaId: 's', errors: [{ path: '', message: 'm', blobSha256: hexSecret }] }],
    [{ type: 'x', note: { manifestSha256: hexSecret } }], [{ type: 'hash', label: 'x', sha256: 'c'.repeat(64), extra: 1 }],
    [{ type: 'number', name: 'n', value: 1 }], [{ type: 'git', commit: 'abc', check: 'resolves', detail: '' }], 'not a list']) {
    const r = rec(ev);
    assert.equal(r.status, 'error', JSON.stringify(ev)); assert.match(r.summary, /bad_evidence/); assert.deepEqual(r.evidence, []);
  }
  // A long hex anywhere but a typed digest position is secret-shaped.
  const s = rec([{ type: 'schema', schemaId: 's', errors: [{ path: '', message: `m ${hexSecret}` }] }]);
  assert.equal(s.status, 'error'); assert.match(s.summary, /secret_in_evidence/);
  // Every typed digest position takes a digest.
  const digest = 'f'.repeat(64);
  const typed = [{ type: 'hash', label: 'x', sha256: digest }, { type: 'number', name: 'n', value: 1, source: { blobSha256: digest, pointer: '/x' } },
    { type: 'junit', sha256: digest, total: 1, passed: 1, failed: 0, errored: 0, skipped: 0 }, { type: 'file', path: 'a', sha256: digest, bytes: 1 },
    { type: 'http', method: 'GET', path: '/h', status: 200, ms: 1, bodySha256: digest }, { type: 'git', commit: NEWC, check: 'resolves', detail: 'ok' },
    { type: 'log', attemptId: 'a1', stream: 'stdout', offset: 0, length: 1, sha256: digest }];
  const ok = rec(typed);
  assert.equal(ok.status, 'passed'); assert.deepEqual(ok.evidence, typed);
  assert.equal(checkEvidence(typed).ok, true);
  w.close();
});

test('R11 deterministic ingest refusals fail invalid_output with the reason and are never retried; a crash still retries', async () => {
  const ids = (w) => w.file('ids.txt', 'test/a.test.js');
  const exitOf = (w) => { const f = ids(w); return { outputs: [f], parsed: [{ parser: 'discovery', sourceSha256: f.sha256, normalized: { framework: 'node-test', ids: ['test/a.test.js'], files: ['test/a.test.js'] } }] }; };
  const cases = [
    ['input_not_granted', () => { throw new PlatformError('input_not_granted', 'an input is not granted to the job as that version and role'); }],
    ['constraint', () => { throw Object.assign(new Error('UNIQUE constraint failed: artifacts.project_id'), { code: 'SQLITE_CONSTRAINT_UNIQUE' }); }],
    ['ingest_error', () => { throw new Error('crash'); }]
  ];
  for (const [want, fault] of cases) {
    const w = execWorld({ realIngest: true, ingestFaults: { afterRows: (recipe) => { if (recipe === 'sde.test.discover') fault(); } } });
    const runner = w.attach();
    const d = w.exec.start(w.me, w.req('sde.tests.discover')).job; w.exec.tick(w.now()); w.provision(runner, d.id);
    w.exitWith(runner, d.id, exitOf(w)); await w.settle();
    const a = w.attempts(d.id)[0];
    if (want === 'ingest_error') {
      assert.equal(a.outcome, 'ingest_error'); assert.equal(w.jobState(d.id), 'retry_scheduled', 'a crash is infrastructure: retried');
    } else {
      assert.equal(a.outcome, 'invalid_output', want); assert.equal(JSON.parse(a.error_json).code, want);
      assert.equal(w.jobState(d.id), 'failed', `${want} is not retried`); assert.equal(w.job(d.id).outcome, 'invalid_output');
    }
    assert.equal(count(w, 'artifact_versions WHERE produced_by_job_id = ?', d.id), 0);
    healthy(w); w.close();
  }
  // P14: the project's repository was archived: a snapshot cannot add a second one (ux_repository_per_project); refused, not retried.
  const w = execWorld({ realIngest: true, resolveCommit: resolver() });
  w.db.prepare("UPDATE artifacts SET status = 'archived' WHERE kind = 'repository' AND project_id = 'p-ledger'").run();
  const j = await w.snapshot({ commit: NEWC, branch: 'main', dirty: false, tree: TREE });
  assert.equal(w.jobState(j), 'failed'); assert.equal(JSON.parse(w.job(j).error_json).code, 'repository_archived');
  assert.equal(w.attempts(j).length, 1);
  w.close();
});

test('R12 the production snapshot path: a project with no repository gets a project-owned one, promoted by the system on the user\'s behalf', async () => {
  const w = execWorld({ realIngest: true, resolveCommit: resolver() });
  w.nx.workspaces.attach(w.me, 'p-invoice', 'sde');
  assert.equal(count(w, "artifacts WHERE project_id = 'p-invoice' AND kind = 'repository'"), 0);
  const r = w.attach();
  const snap = async (commit) => {
    const j = w.exec.start(w.me, w.req('sde.repository.snapshot', { projectId: 'p-invoice' })).job;
    w.exec.tick(w.now()); w.provisionEngine(r, j.id);
    w.exitWith(r, j.id, { code: 0, parsed: [{ parser: 'repo-snapshot', sourceSha256: 'e'.repeat(64), normalized: { commit, branch: 'main', dirty: false, tree: TREE } }] });
    await w.settle();
    return j.id;
  };
  const j1 = await snap(NEWC);
  assert.equal(w.jobState(j1), 'completed');
  const v1 = w.db.prepare(`SELECT v.*, a.owner_scope, a.owner_participation_id, a.current_version_id FROM artifact_versions v JOIN artifacts a ON a.id = v.artifact_id
    WHERE v.produced_by_job_id = ?`).get(j1);
  assert.equal(v1.owner_scope, 'project'); assert.equal(v1.owner_participation_id, null); assert.equal(v1.participation_id, null);
  assert.equal(v1.status, 'active'); assert.equal(v1.current_version_id, v1.id);
  for (const action of ['artifact.create', 'version.register', 'version.finalize', 'version.promote']) {
    const row = w.db.prepare('SELECT * FROM activity WHERE action = ? AND (version_id = ? OR entity_id = ?)').get(action, v1.id, v1.artifact_id);
    assert.ok(row, action); assert.equal(row.actor_kind, 'system'); assert.equal(row.on_behalf_of, 'user:local');
  }
  const j2 = await snap(NEWC2);
  const v2 = w.db.prepare('SELECT * FROM artifact_versions WHERE produced_by_job_id = ?').get(j2);
  assert.equal(v2.status, 'active'); assert.equal(w.version(v1.id).status, 'deprecated'); assert.equal(v2.artifact_id, v1.artifact_id);
  assert.ok(w.db.prepare("SELECT 1 FROM artifact_edges WHERE from_version_id = ? AND to_version_id = ? AND relation = 'derived_from' AND source = 'ingest'").get(v2.id, v1.id));
  assert.equal(w.nx.artifacts.getVersion(w.me, v2.id).status, 'active');
  // The project-owned repository is a usable input.
  const d = w.exec.start(w.me, w.req('sde.tests.discover', { projectId: 'p-invoice', inputs: [{ versionId: v2.id, slot: 'repository' }] })).job;
  w.exec.tick(w.now()); w.provision(r, d.id, { c: 'e' });
  const f = w.file('ids.txt', 'test/a.test.js');
  w.exitWith(r, d.id, { code: 0, outputs: [f], parsed: [{ parser: 'discovery', sourceSha256: f.sha256, normalized: { framework: 'node-test', ids: ['test/a.test.js'], files: ['test/a.test.js'] } }] });
  await w.settle();
  assert.equal(w.jobState(d.id), 'completed');
  healthy(w); w.close();
});

test('R13 a draft whose check could not run and that nothing works on reads failed (needs attention), not in progress forever', async () => {
  const w = execWorld({ realIngest: true });
  const b = await w.runBuild({ files: ['a.js'] });
  assert.equal(w.stepState('sde', 'build'), 'in_progress', 'the re-hash is still out');
  w.attach().report({ op: 'fault', message: 'the docker daemon went away' }); await w.settle();
  assert.equal(w.version(b.buildVersionId).status, 'draft'); assert.equal(w.latest(b.buildVersionId, 'blob.integrity').status, 'error');
  assert.equal(w.stepState('sde', 'build'), 'failed');
  w.nx.validation.revalidate(w.me, b.buildVersionId);
  assert.equal(w.stepState('sde', 'build'), 'in_progress');
  w.answerVerifies(w.attach(), true); await w.settle();
  assert.equal(w.stepState('sde', 'build'), 'done');
  // The pure rule.
  const step = getDomain('sde').lifecycle.find((s) => s.id === 'build');
  const draft = (validators) => ({ status: 'draft', validators });
  assert.equal(stepStateFrom(step, { versions: [draft({ 'blob.integrity': 'error' })], liveJobs: 0, inputsAvailable: true }), 'failed');
  assert.equal(stepStateFrom(step, { versions: [draft({ 'blob.integrity': 'error' })], liveJobs: 1, inputsAvailable: true }), 'in_progress');
  assert.equal(stepStateFrom(step, { versions: [draft({ 'build.exit_zero': 'passed' })], liveJobs: 0, inputsAvailable: true }), 'in_progress');
  healthy(w); w.close();
});

test('R14 a user\'s test run on a candidate suite keeps its JUnit bytes as a blob that its evidence names (not attached; never a GC candidate)', async () => {
  const w = execWorld({ realIngest: true });
  const r0 = await w.runTests({ discovery: ['test/a.test.js'], junit: junit([{ name: 'a' }]), exit: 0 });
  const attached = count(w, 'version_blobs WHERE version_id = ?', r0.suiteVersionId);
  const runner = w.attach();
  const uj = w.exec.start(w.me, w.req('sde.tests.run', { inputs: [{ versionId: r0.suiteVersionId, slot: 'suite' }] })).job;
  w.exec.tick(w.now()); w.provision(runner, uj.id, { c: 'e' });
  const jr = junit([{ name: 'a' }, { name: 'a2' }]); const jf = w.file('junit.xml', JSON.stringify(jr));
  w.exitWith(runner, uj.id, { code: 0, outputs: [jf], parsed: [{ parser: 'junit', sourceSha256: jf.sha256, normalized: { sha256: jf.sha256, ...jr } }] });
  await w.settle();
  assert.equal(w.jobState(uj.id), 'completed');
  assert.ok(w.db.prepare('SELECT 1 FROM blobs WHERE sha256 = ?').get(jf.sha256), 'the report is a stored blob');
  assert.equal(count(w, 'version_blobs WHERE version_id = ?', r0.suiteVersionId), attached, 'the candidate suite is unchanged');
  const ev = JSON.parse(w.db.prepare('SELECT evidence_json FROM validations WHERE job_id = ?').get(uj.id).evidence_json);
  assert.ok(ev.some((e) => e.type === 'hash' && e.label === 'junit' && e.sha256 === jf.sha256));
  w.advance(BLOB_GC_MIN_AGE_MS + 60_000);
  assert.ok(!w.nx.blobs.gcCandidates().candidates.some((c) => c.sha256 === jf.sha256), 'evidence keeps the report');
  healthy(w); w.close();
});

test('R15 undiscovered_ids: a file OR an id absent from the discovery; a framework that attributes no file is judged by id against an id-level list', () => {
  const base = { junitSha256: 'a'.repeat(64), exit: { code: 0, oomKilled: false }, imageId: null, lockfileSha256: null };
  const report = (cases) => ({ sha256: 'a'.repeat(64), total: cases.length, passed: cases.length, failed: 0, errored: 0, skipped: 0,
    cases: cases.map((c) => ({ id: `${c.file ?? ''}::${c.classname}::${c.name}`, ...(c.file ? { file: c.file } : {}), classname: c.classname, name: c.name, outcome: 'passed', ms: 1 })) });
  const pytest = { files: ['tests/test_a.py'], ids: ['tests/test_a.py::test_x', 'tests/test_a.py::test_y'] };
  // pytest xunit2 attributes no file: judged by id (name) against the node ids.
  assert.equal(testsPass.run({ ...base, discovery: pytest, junit: report([{ classname: 'tests.test_a', name: 'test_x' }, { classname: 'tests.test_a', name: 'test_y' }]) }).status, 'passed');
  const extra = testsPass.run({ ...base, discovery: pytest, junit: report([{ classname: 'tests.test_a', name: 'test_x' }, { classname: 'tests.test_a', name: 'test_z' }]) });
  assert.equal(extra.reason, 'undiscovered_ids');
  // An attributing case in a discovered file whose test the id-level list never named.
  assert.equal(testsPass.run({ ...base, discovery: pytest, junit: report([{ file: 'tests/test_a.py', classname: 'c', name: 'test_x' },
    { file: 'tests/test_a.py', classname: 'c', name: 'test_q' }]) }).reason, 'undiscovered_ids');
  // A file-level discovery (node-test lists files): a case attributing no file is not judged by id (N3).
  assert.equal(testsPass.run({ ...base, discovery: { files: ['test/a.test.js'], ids: ['test/a.test.js'] }, junit: report([{ classname: 'Suite', name: 'ok' }]) }).status, 'passed');
  // A file absent from the discovery.
  assert.equal(testsPass.run({ ...base, discovery: { files: ['test/a.test.js'], ids: ['test/a.test.js'] },
    junit: report([{ file: 'test/a.test.js', classname: 'c', name: 'a' }, { file: 'test/b.test.js', classname: 'c', name: 'b' }]) }).reason, 'undiscovered_ids');
  // Linear: 20,000 cases against 5,000 discovered files.
  const files = Array.from({ length: 5000 }, (_, i) => `test/t${i}.test.js`);
  const big = report(Array.from({ length: 20000 }, (_, i) => ({ file: files[i % 5000], classname: 'c', name: `n${i}` })));
  const t = process.hrtime.bigint();
  assert.equal(testsPass.run({ ...base, discovery: { files, ids: files }, junit: big }).status, 'passed');
  assert.ok(Number(process.hrtime.bigint() - t) / 1e6 < 1000);
});

// ---------- fix round 2 (re-review of 9fa0a4cb): S1-S4 ----------

test('S1 GC: an evidence item without a sha256 never keeps every blob; a report a test run\'s evidence names is still kept', async () => {
  const w = execWorld({ realIngest: true });
  const loose = w.file('loose.bin', 'loose bytes');
  await w.nx.blobs.withIngestLock((t) => { w.nx.blobs.recordBlobsTx(t, [{ sha256: loose.sha256, bytes: loose.bytes, mediaType: loose.mediaType }]); });
  w.advance(BLOB_GC_MIN_AGE_MS + 60_000);
  const candidate = () => w.nx.blobs.gcCandidates().candidates.some((c) => c.sha256 === loose.sha256);
  assert.ok(candidate());
  const ins = w.db.prepare(`INSERT INTO validations (id, version_id, validator_id, validator_version, stage, status, blocking, advisory, summary, evidence_json,
      job_id, attempt_n, created_by, started_at, finished_at) VALUES (?, ?, ?, '1', 'candidate', 'failed', 0, 1, 'raw', ?, NULL, NULL, 'system', ?, ?)`);
  // Raw rows (the service would refuse them): a junit hash item with no sha256, or a null one.
  ins.run('v-null-1', w.suiteV, 'sde.tests_pass', JSON.stringify([{ type: 'hash', label: 'junit' }]), w.now(), w.now());
  ins.run('v-null-2', w.suiteV, 'sde.tests_pass', JSON.stringify([{ type: 'hash', label: 'junit', sha256: null }]), w.now(), w.now());
  ins.run('v-null-3', w.suiteV, 'build.exit_zero', JSON.stringify([{ type: 'hash', label: 'junit' }]), w.now(), w.now());
  assert.ok(candidate(), 'a missing sha256 does not stop GC from collecting');
  // Only a test run's advisory row keeps a report.
  ins.run('v-other', w.suiteV, 'build.exit_zero', JSON.stringify([{ type: 'hash', label: 'junit', sha256: loose.sha256 }]), w.now(), w.now());
  assert.ok(candidate());
  ins.run('v-keep', w.suiteV, 'sde.tests_pass', JSON.stringify([{ type: 'hash', label: 'junit', sha256: loose.sha256 }]), w.now(), w.now());
  assert.ok(!candidate(), 'named by a test run\'s evidence: kept');
  w.close();
});

test('S2 a provider-key shape in a build output file name is refused (secret_in_output); a long hex chunk name is accepted', async () => {
  const w = execWorld({ realIngest: true });
  const key = 'sk-' + 'q'.repeat(40);
  const names = [`${key}.js`, `cfg/ghp_${'a1'.repeat(18)}.json`, `AKIA${'A'.repeat(16)}.txt`, `xoxb-${'1'.repeat(12)}.js`,
    'eyJhbGciOiJIUzI1.eyJzdWIiOiIxMjM0.c2lnbmF0dXJlMTI.js'];
  for (const name of names) {
    const r = await w.runBuild({ files: ['app.js', name] });
    assert.equal(r.buildVersionId, null, name); assert.equal(w.jobState(r.buildJobId), 'failed');
    assert.equal(w.job(r.buildJobId).outcome, 'invalid_output'); assert.equal(JSON.parse(w.job(r.buildJobId).error_json).code, 'secret_in_output');
  }
  assert.equal(count(w, 'blobs'), 0);
  const text = storedText(w);
  for (const name of names) assert.ok(!text.includes(name), name);
  // A content hash in a chunk name (64 hex, as some bundlers write) is not a secret.
  const chunk = `assets/index.${'0123456789abcdef'.repeat(4)}.js`;
  const ok = await w.runBuild({ files: [chunk, 'app.js'] });
  assert.ok(ok.buildVersionId); assert.equal(w.jobState(ok.buildJobId), 'completed');
  assert.ok(w.db.prepare('SELECT 1 FROM version_blobs WHERE version_id = ? AND path = ?').get(ok.buildVersionId, chunk));
  healthy(w); w.close();
});

test('S3 a recipe check the scheduler can never lease (no capability) fails invalid_check once; revalidate never returns it as live', async () => {
  const w = execWorld({ realIngest: true });
  const r = await w.runTests({ skipTests: true });
  w.exec.cancel(w.me, w.validateJobs(r.suiteVersionId, 'sde.tests_pass')[0].id);
  const stuck = (key) => w.nx.jobs.create(w.sys, { kind: 'validate', projectId: 'p-ledger', workspaceId: 'sde', idempotencyKey: key,
    validatorId: 'sde.tests_pass', recipeId: 'sde.test.node', params: { versionId: r.suiteVersionId } }).job.id;
  const s1 = stuck('k-stuck-1');
  const { jobs } = w.nx.validation.revalidate(w.me, r.suiteVersionId);
  assert.ok(!jobs.includes(s1), 'not taken as the live check');
  assert.equal(w.jobState(s1), 'failed'); assert.equal(w.job(s1).outcome, 'invalid_check'); assert.equal(JSON.parse(w.job(s1).error_json).code, 'no_capability');
  assert.equal(w.attempts(s1)[0].state, 'failed');
  // One made after every pass is found by the scheduler's own pass (here the periodic one), never left queued.
  const s2 = stuck('k-stuck-2');
  for (let i = 0; i < 3; i++) { w.advance(5000); w.exec.tick(w.now()); }
  w.advance(FULL_PASS_MS); w.exec.tick(w.now());
  assert.equal(w.jobState(s2), 'failed'); assert.equal(JSON.parse(w.job(s2).error_json).code, 'no_capability');
  // The revalidation's own check (with its capability) is not touched.
  const real = jobs.find((id) => w.job(id).validator_id === 'sde.tests_pass');
  assert.notEqual(w.jobState(real), 'failed');
  assert.equal(w.orphans().O17, 0);
  w.close();
});

test('S4 a report must cover the discovery: an unattributed report on a file-level list is never a pass; an id-level subset fails', async () => {
  // P13b: two discovered files, a report that names no file and covers one of them.
  const w = execWorld({ realIngest: true });
  const r = await w.runTests({ discovery: ['test/a.test.js', 'test/b.test.js'], junit: junit([{ name: 'a1', file: null, classname: 'A' }]), exit: 0 });
  const tp = w.latest(r.suiteVersionId, 'sde.tests_pass');
  assert.equal(tp.status, 'error'); assert.match(tp.summary, /unattributed_report/);
  assert.equal(w.version(r.suiteVersionId).status, 'draft'); assert.equal(w.version(r.suiteVersionId).validation_state, 'error');
  assert.equal(w.stepState('sde', 'tests'), 'failed', 'needs attention, never done');
  // An id-level list (test ids, not only files): a report missing one of them fails.
  const w2 = execWorld({ realIngest: true });
  const ids = ['tests/test_a.py::test_x', 'tests/test_a.py::test_y'];
  const r2 = await w2.runTests({ discovery: ['tests/test_a.py'], ids, junit: junit([{ name: 'test_x', file: null, classname: 'tests.test_a' }]), exit: 0 });
  assert.match(w2.latest(r2.suiteVersionId, 'sde.tests_pass').summary, /discovered_not_run/);
  assert.equal(w2.version(r2.suiteVersionId).status, 'failed');
  // The pure rule.
  const base = { junitSha256: 'a'.repeat(64), exit: { code: 0, oomKilled: false }, imageId: null, lockfileSha256: null };
  const report = (cases) => ({ sha256: 'a'.repeat(64), total: cases.length, passed: cases.filter((c) => (c.outcome ?? 'passed') === 'passed').length,
    failed: cases.filter((c) => c.outcome === 'failed').length, errored: 0, skipped: 0,
    cases: cases.map((c) => ({ id: `${c.file ?? ''}::${c.classname}::${c.name}`, ...(c.file ? { file: c.file } : {}), classname: c.classname, name: c.name,
      outcome: c.outcome ?? 'passed', ms: 1 })) });
  const two = { files: ['test/a.test.js', 'test/b.test.js'], ids: ['test/a.test.js', 'test/b.test.js'] };
  assert.equal(testsPass.run({ ...base, discovery: two, junit: report([{ classname: 'A', name: 'a' }, { classname: 'B', name: 'b' }]) }).reason, 'unattributed_report');
  // Failures are definitive whatever the attribution.
  assert.equal(testsPass.run({ ...base, exit: { code: 1, oomKilled: false }, discovery: two, junit: report([{ classname: 'A', name: 'a', outcome: 'failed' }]) }).reason, 'tests_failed');
  // A full attributed run still passes; an id-level list fully reported passes; an id-level subset fails.
  assert.equal(testsPass.run({ ...base, discovery: two, junit: report([{ file: 'test/a.test.js', classname: 'A', name: 'a' },
    { file: 'test/b.test.js', classname: 'B', name: 'b' }]) }).status, 'passed');
  const pyIds = { files: ['tests/test_a.py'], ids };
  assert.equal(testsPass.run({ ...base, discovery: pyIds, junit: report([{ classname: 'tests.test_a', name: 'test_x' }, { classname: 'tests.test_a', name: 'test_y' }]) }).status, 'passed');
  assert.equal(testsPass.run({ ...base, discovery: pyIds, junit: report([{ classname: 'tests.test_a', name: 'test_y' }]) }).reason, 'discovered_not_run');
  healthy(w); healthy(w2); w.close(); w2.close();
});

test('S5 one version\'s checks run in one pass even on a slow machine: the slice budget only cuts a backlog', async () => {
  const w = execWorld({ realIngest: true }); const runner = w.attach();
  const b = await w.runBuild({ files: ['a.js'] });
  runner.report({ op: 'fault', message: 'the docker daemon went away' }); await w.settle();
  // Every recorded result costs 60 ms (a loaded machine): the four checks take far longer than one slice.
  const cr = w.nx.validation.runner; const record = cr.h.recordOutcomeTx;
  cr.h.recordOutcomeTx = (...a) => { const until = Date.now() + 60; while (Date.now() < until) { /* busy */ } return record(...a); };
  const sent = runner.sentOf('blob.verify').length;
  w.nx.validation.revalidate(w.me, b.buildVersionId);
  assert.equal(runner.sentOf('blob.verify').length, sent + 1, 'the re-hash was asked in the same pass');
  cr.h.recordOutcomeTx = record;
  w.answerVerifies(runner, true); await w.settle();
  assert.equal(w.version(b.buildVersionId).status, 'candidate');
  healthy(w); w.close();
});
