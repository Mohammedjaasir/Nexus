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
