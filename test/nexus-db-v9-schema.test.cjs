'use strict';
const h = require('./helpers/sqlite.cjs');
if (!h.realSqliteOrSkip()) return;
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');
const { PersistStore } = loadTs('src/main/db.ts');
const { applyV9, V9_EXPECTED, v9ShapeProblem } = loadTs('src/main/nexus/db/schemaV9.ts');
const ctx = (over) => ({ now: () => h.NOW, appVersion: 't', fromVersion: 8, preCounts: null, backup: null, ...over });
// Before Task 5 the store stops at v8 on its own; after Task 5, holdV9 keeps it there.
function v8db() {
  const { file } = h.v6Fixture(); const s = new PersistStore(file);
  s.open({ log: () => {}, backupDir: path.join(path.dirname(file), 'b'), now: () => h.NOW, holdV9: true });
  s.close(); return h.openRaw(file);
}
const names = (db, type) => db.prepare("SELECT name FROM sqlite_master WHERE type = ? AND name NOT LIKE 'sqlite_%'").all(type).map((r) => r.name);

test('v9 objects: 15 tables, the parsed index and trigger lists, seeds, clean shape, +4 relations', () => {
  const db = v8db();
  db.transaction(() => applyV9(db, ctx()))();
  assert.equal(Object.keys(V9_EXPECTED.tables).length, 15);
  assert.equal(V9_EXPECTED.indexes.length, 23); assert.equal(V9_EXPECTED.triggers.length, 32);
  for (const t of Object.keys(V9_EXPECTED.tables)) assert.ok(names(db, 'table').includes(t), t);
  for (const i of V9_EXPECTED.indexes) assert.ok(names(db, 'index').includes(i), i);
  for (const t of V9_EXPECTED.triggers) assert.ok(names(db, 'trigger').includes(t), t);
  assert.equal(v9ShapeProblem(db, true), null);
  assert.equal(h.count(db, 'attempt_transitions'), 10); assert.equal(h.count(db, 'approval_transitions'), 4);
  assert.equal(h.count(db, 'deployment_transitions'), 9); assert.equal(h.count(db, 'lineage_relations'), 36);
  assert.deepEqual(db.pragma('foreign_key_check'), []);
});
test('applyV9 refuses a wrong pre-existing object, a database whose v8 shape is not exact, and is a no-op on re-run', () => {
  const bad = v8db(); bad.exec('CREATE TABLE blobs (sha256 TEXT PRIMARY KEY)');
  assert.throws(() => bad.transaction(() => applyV9(bad, ctx()))(), /cannot be applied over an existing object/);
  const v8bad = v8db(); v8bad.exec('DROP TRIGGER tr_handoffs_no_delete');   // temp copy only
  assert.throws(() => v8bad.transaction(() => applyV9(v8bad, ctx()))(), /v8/);
  const db = v8db(); db.transaction(() => applyV9(db, ctx()))();
  const n = h.count(db, 'activity'); db.transaction(() => applyV9(db, ctx()))();
  assert.equal(h.count(db, 'activity'), n);
});

// ---------- extra pins on the module itself ----------

test('the fixture is an exact v8 and the store does not apply v9 on its own in this task', () => {
  const { v8ShapeProblem } = loadTs('src/main/nexus/db/schemaV8.ts');
  const db = v8db();
  assert.equal(db.pragma('user_version', { simple: true }), 8);
  assert.equal(v8ShapeProblem(db, true), null);
  assert.match(v9ShapeProblem(db, true), /missing/);
  assert.equal(v9ShapeProblem(db, false), null);
});
test('the generic parser finds exactly the v9 objects; the DDL is additive and keeps its backslash patterns', () => {
  const { V9_DDL } = loadTs('src/main/nexus/db/schemaV9.ts');
  const v7 = loadTs('src/main/nexus/db/schemaV7.ts');
  const objs = v7.ddlObjects(V9_DDL);
  assert.deepEqual(objs.filter((o) => o.type === 'table').map((o) => o.name), Object.keys(V9_EXPECTED.tables));
  assert.deepEqual(objs.filter((o) => o.type === 'index').map((o) => o.name), V9_EXPECTED.indexes);
  assert.deepEqual(objs.filter((o) => o.type === 'trigger').map((o) => o.name), V9_EXPECTED.triggers);
  const on = (n) => objs.find((o) => o.name === n).table;
  for (const n of ['ix_jobs_sched', 'ix_jobs_retry_due', 'ix_jobs_parent']) assert.equal(on(n), 'jobs', n);
  for (const n of ['ux_versions_job_path', 'ix_versions_job', 'ix_versions_hash']) assert.equal(on(n), 'artifact_versions', n);
  assert.equal(on('ux_repository_per_project'), 'artifacts');
  for (const n of ['tr_jobs_completed_needs_attempt', 'tr_jobs_end_after_attempts']) assert.equal(on(n), 'jobs', n);
  assert.match(objs.find((o) => o.name === 'ux_attempts_live').sql, /WHERE state IN\('starting','running'\)$/);
  assert.match(objs.find((o) => o.name === 'ux_deployments_port_live').sql, /WHERE host_port IS NOT NULL AND status IN\('starting','healthy','unhealthy'\)$/);
  assert.match(objs.find((o) => o.name === 'ux_versions_job_path').sql, /WHERE output_path IS NOT NULL$/);
  for (const o of objs.filter((x) => x.type === 'trigger')) assert.match(o.sql, /END$/, o.name);
  assert.doesNotMatch(V9_DDL, /\b(DROP|ALTER)\b/i);
  assert.doesNotMatch(V9_DDL, /OR\s+REPLACE/i);
  assert.equal((V9_DDL.match(/NOT LIKE '%\\%'/g) || []).length, 3, 'the three backslash LIKE patterns survive the template literal');
  // Every statement is CREATE ... IF NOT EXISTS: no CREATE without it.
  assert.equal((V9_DDL.match(/\bCREATE\b/g) || []).length, (V9_DDL.match(/\bCREATE\s+(?:UNIQUE\s+)?(?:TABLE|INDEX|TRIGGER)\s+IF\s+NOT\s+EXISTS\b/g) || []).length);
});
test('applyV9: return value, migration record, one db.migrated row, columns as declared, v7 and v8 shapes still exact', () => {
  const { v7ShapeProblem } = loadTs('src/main/nexus/db/schemaV7.ts');
  const { v8ShapeProblem } = loadTs('src/main/nexus/db/schemaV8.ts');
  const db = v8db();
  const before = h.count(db, 'activity');
  const pre = { projects: h.count(db, 'projects'), activity: before, lineage_relations: h.count(db, 'lineage_relations'), jobs: h.count(db, 'jobs') };
  const out = db.transaction(() => applyV9(db, ctx({ preCounts: pre })))();
  assert.deepEqual(out, { attemptStates: 7, approvalStates: 5, deploymentStates: 5, relationsAdded: 4 });
  const rec = db.prepare('SELECT * FROM nexus_migrations WHERE version = 9').get();
  assert.equal(rec.from_version, 8); assert.equal(rec.backfill_json, '{}'); assert.equal(rec.applied_at, h.NOW);
  assert.deepEqual(JSON.parse(rec.row_counts_json), pre);
  assert.equal(h.count(db, 'activity'), before + 1);
  const row = db.prepare('SELECT * FROM activity ORDER BY seq DESC LIMIT 1').get();
  assert.equal(row.action, 'db.migrated'); assert.equal(row.entity_id, '9'); assert.equal(row.actor_kind, 'system');
  assert.deepEqual(JSON.parse(row.details_json), { from: 8, to: 9, backupFile: null, backupSha256: null });
  for (const [t, cols] of Object.entries(V9_EXPECTED.tables)) {
    assert.deepEqual(db.prepare(`PRAGMA table_info("${t}")`).all().map((c) => c.name), cols, t);
  }
  assert.equal(v7ShapeProblem(db, true), null);
  assert.equal(v8ShapeProblem(db, true), null);
  const again = db.transaction(() => applyV9(db, ctx()))();
  assert.equal(again.relationsAdded, 0);
});
test('the seeds: every column of every state row, and the four relations with their phases; no v7 relation changed', () => {
  const seed = loadTs('src/main/nexus/db/v9Seed.ts');
  const v7seed = loadTs('src/main/nexus/db/v7Seed.ts');
  const db = v8db(); db.transaction(() => applyV9(db, ctx()))();
  const rows = (t) => db.prepare(`SELECT state, terminal, description FROM ${t} ORDER BY rowid`).all().map((r) => ({ ...r }));
  assert.deepEqual(rows('attempt_states'), seed.V9_ATTEMPT_STATES.map((r) => ({ ...r })));
  assert.deepEqual(rows('approval_states'), seed.V9_APPROVAL_STATES.map((r) => ({ ...r })));
  assert.deepEqual(rows('deployment_states'), seed.V9_DEPLOYMENT_STATES.map((r) => ({ ...r })));
  const moves = (t) => db.prepare(`SELECT from_state || '>' || to_state AS m FROM ${t} ORDER BY m`).all().map((r) => r.m);
  assert.deepEqual(moves('attempt_transitions'), ['running>abandoned', 'running>cancelled', 'running>failed', 'running>succeeded', 'running>timed_out',
    'starting>abandoned', 'starting>cancelled', 'starting>failed', 'starting>running', 'starting>succeeded']);
  assert.deepEqual(moves('approval_transitions'), ['pending>approved', 'pending>denied', 'pending>expired', 'pending>withdrawn']);
  assert.deepEqual(moves('deployment_transitions'), ['healthy>failed', 'healthy>stopped', 'healthy>unhealthy', 'starting>failed', 'starting>healthy',
    'starting>stopped', 'unhealthy>failed', 'unhealthy>healthy', 'unhealthy>stopped']);
  const rel = db.prepare('SELECT relation, description, planned_phase AS plannedPhase FROM lineage_relations ORDER BY rowid').all().map((r) => ({ ...r }));
  assert.deepEqual(rel, [...v7seed.V7_LINEAGE_RELATIONS, ...seed.V9_LINEAGE_RELATIONS].map((r) => ({ ...r })));
  assert.deepEqual(rel.filter((r) => ['covers', 'transformed_by', 'configured_by', 'monitors'].includes(r.relation)).map((r) => `${r.relation}:${r.plannedPhase}`),
    ['covers:B2c', 'transformed_by:B3', 'configured_by:B6', 'monitors:B5']);
  assert.equal(rel.find((r) => r.relation === 'implements').plannedPhase, 'unassigned');
  for (const list of [seed.V9_ATTEMPT_STATES, seed.V9_ATTEMPT_TRANSITIONS, seed.V9_APPROVAL_STATES, seed.V9_APPROVAL_TRANSITIONS,
    seed.V9_DEPLOYMENT_STATES, seed.V9_DEPLOYMENT_TRANSITIONS, seed.V9_LINEAGE_RELATIONS]) {
    assert.ok(Object.isFrozen(list)); for (const x of list) assert.ok(Object.isFrozen(x));
  }
});
test('verifyV9 fails on a pre-count mismatch (including an unexpected lineage count), and the transaction rolls back', () => {
  const db = v8db();
  assert.throws(() => db.transaction(() => applyV9(db, ctx({ preCounts: { projects: 999 } })))(), /projects has \d+ rows, expected 999/);
  assert.equal(names(db, 'table').includes('job_attempts'), false);
  assert.equal(names(db, 'index').includes('ix_jobs_sched'), false);
  assert.equal(h.count(db, 'lineage_relations'), 32);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM nexus_migrations WHERE version = 9').get().n, 0);
  assert.throws(() => db.transaction(() => applyV9(db, ctx({ preCounts: { lineage_relations: 31 } })))(), /lineage_relations has 36 rows/);
  assert.equal(h.count(db, 'lineage_relations'), 32);
  db.transaction(() => applyV9(db, ctx({ preCounts: { lineage_relations: 32 } })))();
});
test('verifyV9 catches a seed row swallowed by INSERT OR IGNORE (a pre-existing row with another description)', () => {
  const db = v8db();
  db.prepare("INSERT INTO lineage_relations (relation, description, planned_phase) VALUES ('covers', 'something else', 'B2c')").run();
  assert.throws(() => db.transaction(() => applyV9(db, ctx()))(), /seed lineage relation covers is missing/);
  assert.equal(names(db, 'table').includes('job_attempts'), false);
});
test('v9ShapeProblem reports a missing object and a changed definition, including an index on a v7 table', () => {
  const db = v8db();
  db.transaction(() => applyV9(db, ctx()))();
  db.exec('DROP INDEX ix_jobs_sched; CREATE INDEX ix_jobs_sched ON jobs(state, priority)');
  assert.match(v9ShapeProblem(db, true), /index ix_jobs_sched has a different definition/);
  db.exec('DROP INDEX ix_jobs_sched');
  assert.match(v9ShapeProblem(db, true), /index ix_jobs_sched is missing/);
  assert.equal(v9ShapeProblem(db, false), null);
});

// ---------- triggers T1-T20, on raw rows in a temp database ----------

const T0 = h.NOW;
const BOOT = 'b'.repeat(26);
const BOOT2 = 'c'.repeat(26);
const HEX = (c) => c.repeat(64);
const CTX = HEX('e');
const DIGEST = `sha256:${HEX('d')}`;
function insert(db, table, row) {
  const cols = Object.keys(row);
  return db.prepare(`INSERT INTO ${table} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`).run(...cols.map((c) => row[c]));
}
function insJob(db, w, id, over = {}) {
  insert(db, 'jobs', { id, kind: 'tool.run', project_id: 'p-ledger', workspace_id: 'sde', participation_id: w.p1, idempotency_key: `k-${id}`,
    requested_by: 'user:local', on_behalf_of: 'user:local', created_at: T0, updated_at: T0, state_changed_at: T0, ...over });
  return id;
}
function insVersion(db, id, artifactId, no, participationId, over = {}) {
  insert(db, 'artifact_versions', { id, artifact_id: artifactId, version_no: no, project_id: 'p-ledger', participation_id: participationId,
    status: 'draft', storage_kind: 'inline', storage_ref_json: '{}', content_hash: `hash-${id}`, actor_id: 'user:local',
    on_behalf_of: 'user:local', created_at: T0, status_changed_at: T0, ...over });
  return id;
}
/** A project, an active SDE participation, a queued job, a draft and a candidate application version (and a few neighbours). */
function seedExecWorld(db) {
  const p1 = db.prepare("SELECT id FROM project_workspaces WHERE project_id = 'p-ledger' AND workspace_id = 'sde'").get().id;
  const other = db.prepare("SELECT id FROM project_workspaces WHERE project_id = 'p-invoice' AND workspace_id = 'dl'").get().id;
  insert(db, 'project_workspaces', { id: 'pw-qa-gone', project_id: 'p-ledger', workspace_id: 'qa', status: 'withdrawn', is_primary: 0,
    source: 'user', created_by: 'user:local', created_at: T0, updated_at: T0 });
  const w = { p1, other };
  insJob(db, w, 'j-1');
  const art = (id, kind, owner, ws, project = 'p-ledger') => insert(db, 'artifacts', { id, project_id: project, kind, name: id,
    owner_participation_id: owner, owner_workspace_id: ws, created_by: 'user:local', created_at: T0, updated_at: T0 });
  art('a-app', 'application', p1, 'sde');
  insVersion(db, 'v-app-draft', 'a-app', 1, p1);
  insVersion(db, 'v-app-cand', 'a-app', 2, p1);
  db.prepare("UPDATE artifact_versions SET status = 'candidate' WHERE id = 'v-app-cand'").run();
  art('a-suite', 'test_suite', p1, 'sde');
  insVersion(db, 'v-suite', 'a-suite', 1, p1);
  art('a-app-other', 'application', other, 'dl', 'p-invoice');
  insVersion(db, 'v-app-other', 'a-app-other', 1, other, { project_id: 'p-invoice' });
  return w;
}
function world() {
  const db = v8db(); db.transaction(() => applyV9(db, ctx()))();
  return { db, ...seedExecWorld(db) };
}
const lease = (db, jobId, n = 1) => db.prepare("UPDATE jobs SET state = 'leased', attempts = ? WHERE id = ?").run(n, jobId);
let seq = 0;
function insAttempt(db, over = {}) {
  const id = over.id ?? `att-${++seq}`;
  insert(db, 'job_attempts', { id, job_id: 'j-1', n: 1, state: 'starting', boot_id: BOOT, lease_owner: BOOT, lease_expires_at: T0 + 60_000,
    created_at: T0, updated_at: T0, ...over });
  return id;
}
const setAttempt = (db, id, sql, ...args) => db.prepare(`UPDATE job_attempts SET ${sql} WHERE id = ?`).run(...args, id);
const SANDBOX = "sandbox_json = '{\"network\":\"none\"}', environment_json = '{\"profile\":\"sde-node\"}'";
/** starting -> running with the facts constraint 4 requires. */
const runAttempt = (db, id) => setAttempt(db, id, `state = 'running', started_at = ?, ${SANDBOX}`, T0 + 1);
/** running -> succeeded with an exit code and an outcome. */
const succeedAttempt = (db, id) => setAttempt(db, id, "state = 'succeeded', finished_at = ?, exit_code = 0, outcome = 'ok'", T0 + 2);
const insEvent = (db, over = {}) => insert(db, 'job_events', { ts: T0, project_id: 'p-ledger', job_id: 'j-1', type: 'job.transition',
  summary: 'queued to leased', ...over });
function insApproval(db, over = {}) {
  const id = over.id ?? `ap-${++seq}`;
  insert(db, 'approvals', { id, project_id: 'p-ledger', job_id: 'j-1', reason: 'egress.deps', summary: 'Install dependencies',
    request_json: '{}', request_sha256: HEX('c'), status: 'pending', requested_by: 'system', on_behalf_of: 'user:local',
    requested_at: T0, expires_at: T0 + 60_000, status_changed_at: T0, ...over });
  return id;
}
const approve = (db, id, by = 'user:local', decision = 'once') => db.prepare(
  "UPDATE approvals SET status = 'approved', decided_by = ?, decided_at = ?, decision = ?, status_changed_at = ? WHERE id = ?")
  .run(by, T0 + 1, decision, T0 + 1, id);
/** Consumption records the consuming attempt (attempt 1 of the approval's job); a jobless approval names none. */
const consume = (db, id, at = T0 + 2, n = 1) => db.prepare(
  'UPDATE approvals SET consumed_at = ?, consumed_by_job_id = job_id, consumed_by_attempt_n = CASE WHEN job_id IS NULL THEN NULL ELSE ? END WHERE id = ?')
  .run(at, n, id);
const prepareApproval = (db, profileId = 'sde-node', contextSha256 = CTX, over = {}) => insApproval(db, { project_id: null, job_id: null,
  reason: 'image.prepare', summary: 'Prepare the image', request_json: JSON.stringify({ profileId, contextSha256 }), ...over });
const insBuild = (db, approvalId, over = {}) => insert(db, 'image_builds', { id: over.id ?? `ib-${++seq}`, profile_id: 'sde-node',
  approval_id: approvalId, status: 'running', context_sha256: CTX, base_digest: DIGEST, requested_by: 'user:local', started_at: T0, ...over });
function insDeployment(db, w, over = {}) {
  const id = over.id ?? `d-${++seq}`;
  insert(db, 'deployments', { id, project_id: 'p-ledger', participation_id: w.p1, subject_version_id: 'v-app-draft', job_id: 'j-1',
    environment: 'local-preview', status: 'starting', created_by: 'user:local', started_at: T0, status_changed_at: T0, updated_at: T0, ...over });
  return id;
}
const stopDeployment = (db, id, reason = 'user', by = 'user:local') => db.prepare(
  "UPDATE deployments SET status = 'stopped', stop_reason = ?, stopped_by = ?, stopped_at = ?, status_changed_at = ?, updated_at = ? WHERE id = ?")
  .run(reason, by, T0 + 1, T0 + 1, T0 + 1, id);
const insValidation = (db, over = {}) => insert(db, 'validations', { id: over.id ?? `val-${++seq}`, version_id: 'v-app-draft',
  validator_id: 'app.manifest', validator_version: '1', stage: 'candidate', status: 'passed', blocking: 1, advisory: 0,
  summary: 'Manifest is valid', evidence_json: '[]', job_id: 'j-1', created_by: 'system', started_at: T0, finished_at: T0 + 1, ...over });

test('T1: an attempt is inserted only under its job lease, with n = jobs.attempts, starting, without a container, owned by its boot', () => {
  const { db } = world();
  assert.throws(() => insAttempt(db), /inserted with the lease of its job/, 'job still queued');
  lease(db, 'j-1', 1);
  assert.throws(() => insAttempt(db, { n: 2 }), /inserted with the lease of its job and carries the job attempt count/);
  assert.throws(() => insAttempt(db, { container_id: HEX('a') }), /starts as starting, unfinished and without a container/);
  assert.throws(() => insAttempt(db, { state: 'running', started_at: T0 }), /starts as starting/);
  assert.throws(() => insAttempt(db, { lease_owner: BOOT2 }), /a new attempt is owned by the boot that created it/);
  insAttempt(db);
  assert.equal(h.count(db, 'job_attempts'), 1);
});
test('T2: a second live attempt for the same job is refused (ux_attempts_live)', () => {
  const { db } = world();
  lease(db, 'j-1', 1); insAttempt(db);
  db.prepare('UPDATE jobs SET attempts = 2 WHERE id = ?').run('j-1');
  assert.throws(() => insAttempt(db, { n: 2 }), /UNIQUE constraint failed: job_attempts\.job_id/);
});
test('T3: attempt transitions follow the seeded table', () => {
  const { db } = world();
  lease(db, 'j-1', 1); const a = insAttempt(db);
  assert.throws(() => setAttempt(db, a, "state = 'timed_out', finished_at = ?", T0 + 1), /illegal attempt transition/);
  assert.throws(() => setAttempt(db, a, `state = 'running', ${SANDBOX}`), /CHECK constraint failed/, 'running needs started_at');
  runAttempt(db, a);
  succeedAttempt(db, a);
  assert.throws(() => setAttempt(db, a, "state = 'running', finished_at = NULL"), /illegal attempt transition|a finished attempt is immutable/);
});
test('T4: container id is set once; boot id never changes', () => {
  const { db } = world();
  lease(db, 'j-1', 1); const a = insAttempt(db);
  const re = /attempt identity, container and log path are immutable once set/;
  assert.throws(() => setAttempt(db, a, 'boot_id = ?', BOOT2), re);
  setAttempt(db, a, 'container_id = ?', HEX('a'));
  assert.throws(() => setAttempt(db, a, 'container_id = ?', HEX('f')), re);
  assert.throws(() => setAttempt(db, a, 'container_id = NULL'), re);
  setAttempt(db, a, 'lease_owner = ?, heartbeat_at = ?', BOOT2, T0 + 5);   // adoption moves the lease owner
  assert.equal(db.prepare('SELECT container_id FROM job_attempts WHERE id = ?').get(a).container_id, HEX('a'));
});
test('T5: a succeeded attempt is frozen and attempts are never deleted', () => {
  const { db } = world();
  lease(db, 'j-1', 1); const a = insAttempt(db);
  runAttempt(db, a);
  succeedAttempt(db, a);
  assert.throws(() => setAttempt(db, a, 'heartbeat_at = ?', T0 + 3), /a finished attempt is immutable/);
  assert.throws(() => setAttempt(db, a, 'log_bytes = 10'), /a finished attempt is immutable/);
  assert.throws(() => db.prepare('DELETE FROM job_attempts WHERE id = ?').run(a), /attempts are never deleted/);
});
test('T6: a job event names its job project; events are append-only', () => {
  const { db } = world();
  assert.throws(() => insEvent(db, { project_id: 'p-invoice' }), /a job event names the project of its job/);
  assert.throws(() => insEvent(db, { project_id: null }), /a job event names the project of its job/);
  insEvent(db);
  const seqNo = db.prepare('SELECT MAX(seq) s FROM job_events').get().s;
  assert.throws(() => db.prepare("UPDATE job_events SET summary = 'x' WHERE seq = ?").run(seqNo), /job events are append-only/);
  assert.throws(() => db.prepare('DELETE FROM job_events WHERE seq = ?').run(seqNo), /job events are append-only/);
});
test('T7: a held blob is never deleted, an unheld one can be (GC path); blob identity is immutable', () => {
  const { db } = world();
  const blob = (sha) => insert(db, 'blobs', { sha256: sha, bytes: 3, media_type: 'text/plain', created_at: T0, last_referenced_at: T0 });
  blob(HEX('a')); blob(HEX('b'));
  insert(db, 'version_blobs', { version_id: 'v-app-draft', sha256: HEX('a'), role: 'file', path: 'src/a.js' });
  assert.throws(() => db.prepare('DELETE FROM blobs WHERE sha256 = ?').run(HEX('a')), /a blob held by a version is never deleted/);
  db.prepare('DELETE FROM blobs WHERE sha256 = ?').run(HEX('b'));
  assert.throws(() => db.prepare('UPDATE blobs SET bytes = 4 WHERE sha256 = ?').run(HEX('a')), /blob identity is immutable/);
  assert.throws(() => db.prepare("UPDATE blobs SET media_type = 'text/html' WHERE sha256 = ?").run(HEX('a')), /blob identity is immutable/);
  db.prepare('UPDATE blobs SET last_referenced_at = ?, verified_at = ? WHERE sha256 = ?').run(T0 + 1, T0 + 1, HEX('a'));
  assert.equal(h.count(db, 'blobs'), 1);
});
test('T8: bytes attach only to a draft version, at a safe relative path; version blobs are immutable', () => {
  const { db } = world();
  insert(db, 'blobs', { sha256: HEX('a'), bytes: 3, media_type: 'text/plain', created_at: T0, last_referenced_at: T0 });
  const vb = (version, p) => insert(db, 'version_blobs', { version_id: version, sha256: HEX('a'), role: 'file', path: p });
  assert.throws(() => vb('v-app-cand', 'src/a.js'), /bytes are attached to a version only while it is a draft/);
  vb('v-app-draft', 'src/a.js');
  vb('v-app-draft', 'src/copy-of-a.js');   // the same bytes at two paths
  for (const bad of ['../x', 'a/../b', '/abs', 'a\\b', '..', 'a/..']) assert.throws(() => vb('v-app-draft', bad), /CHECK constraint failed/, bad);
  assert.throws(() => db.prepare("UPDATE version_blobs SET role = 'log' WHERE path = 'src/a.js'").run(), /version blobs are immutable/);
  assert.throws(() => db.prepare("DELETE FROM version_blobs WHERE path = 'src/a.js'").run(), /version blobs are immutable/);
});
test('T9: a passed or failed blocking validation is written only by the system; advisories never gate; append-only', () => {
  const { db } = world();
  const re = /a passed or failed blocking result is recorded only by the system/;
  assert.throws(() => insValidation(db, { created_by: 'user:local' }), re);
  assert.throws(() => insValidation(db, { created_by: 'user:local', status: 'failed' }), re);
  insValidation(db, { id: 'val-sys' });
  insValidation(db, { created_by: 'user:local', blocking: 0, advisory: 1 });
  assert.throws(() => insValidation(db, { version_id: 'v-app-other' }), /a validation job belongs to the project of the version/);
  assert.throws(() => insValidation(db, { blocking: 1, advisory: 1 }), /CHECK constraint failed/);
  assert.throws(() => db.prepare("UPDATE validations SET status = 'failed' WHERE id = 'val-sys'").run(), /validations are append-only/);
  assert.throws(() => db.prepare("DELETE FROM validations WHERE id = 'val-sys'").run(), /validations are append-only/);
});
test('T10: an approval starts pending; egress needs a job; image preparation has none', () => {
  const { db } = world();
  assert.throws(() => insApproval(db, { status: 'approved' }), /an approval starts pending, undecided and unconsumed/);
  assert.throws(() => insApproval(db, { job_id: null }), /CHECK constraint failed/, 'egress.deps without a job');
  assert.throws(() => insApproval(db, { reason: 'image.prepare' }), /CHECK constraint failed/, 'image.prepare with a job');
  assert.throws(() => insApproval(db, { project_id: 'p-invoice' }), /an approval job belongs to its project/);
  insApproval(db);
  prepareApproval(db);
});
test('T11: only a user approves, with decision once; the decision is recorded once', () => {
  const { db } = world();
  const a = insApproval(db);
  const re = /only a user approves or denies, once, recording who and when/;
  assert.throws(() => approve(db, a, 'system'), re);
  assert.throws(() => approve(db, a, 'user:local', 'deny'), re);
  approve(db, a);
  assert.throws(() => db.prepare("UPDATE approvals SET decided_by = 'system' WHERE id = ?").run(a), /an approval request is immutable/);
  assert.throws(() => db.prepare("UPDATE approvals SET summary = 'other' WHERE id = ?").run(a), /an approval request is immutable/);
});
test('T12: expiry carries no decision; an approved approval cannot be denied', () => {
  const { db } = world();
  const a = insApproval(db);
  assert.throws(() => db.prepare(
    "UPDATE approvals SET status = 'expired', decided_by = 'user:local', decided_at = ?, decision = 'deny' WHERE id = ?").run(T0 + 1, a),
  /expiry and withdrawal are not decisions/);
  db.prepare("UPDATE approvals SET status = 'expired', status_changed_at = ? WHERE id = ?").run(T0 + 1, a);
  const b = insApproval(db);
  approve(db, b);
  assert.throws(() => db.prepare("UPDATE approvals SET status = 'denied', decision = 'deny' WHERE id = ?").run(b),
    /illegal approval transition|an approval request is immutable/);
});
test('T13: consumed_at only on an approved approval, and only once', () => {
  const { db } = world();
  lease(db, 'j-1', 1); insAttempt(db);
  const a = insApproval(db);
  assert.throws(() => consume(db, a), /CHECK constraint failed/);
  approve(db, a);
  consume(db, a, T0 + 2);
  assert.throws(() => consume(db, a, T0 + 3), /an approval request is immutable; its decision and its consumption are recorded once/);
});
test('T14: one pending approval per job', () => {
  const { db } = world();
  const a = insApproval(db);
  assert.throws(() => insApproval(db), /UNIQUE constraint failed: approvals\.job_id/);
  db.prepare("UPDATE approvals SET status = 'withdrawn', status_changed_at = ? WHERE id = ?").run(T0 + 1, a);
  insApproval(db);
});
test('T15: an image build needs an approved, consumed image.prepare approval for its profile and context; a finished build is frozen', () => {
  const { db } = world();
  const re = /an image build needs an approved, consumed image.prepare approval for this profile and context/;
  const pending = prepareApproval(db);
  assert.throws(() => insBuild(db, pending), re, 'pending');
  const unconsumed = prepareApproval(db); approve(db, unconsumed);
  assert.throws(() => insBuild(db, unconsumed), re, 'approved but not consumed');
  const otherProfile = prepareApproval(db, 'sde-python'); approve(db, otherProfile); consume(db, otherProfile);
  assert.throws(() => insBuild(db, otherProfile), re, 'another profile');
  const otherContext = prepareApproval(db, 'sde-node', HEX('9')); approve(db, otherContext); consume(db, otherContext);
  assert.throws(() => insBuild(db, otherContext), re, 'another context');
  lease(db, 'j-1', 1); insAttempt(db);
  const egress = insApproval(db); approve(db, egress); consume(db, egress);
  assert.throws(() => insBuild(db, egress), re, 'not an image.prepare approval');
  const good = prepareApproval(db); approve(db, good); consume(db, good);
  assert.throws(() => insBuild(db, good, { status: 'succeeded', image_id: DIGEST, size_bytes: 1, finished_at: T0 }), /an image build starts running/);
  insBuild(db, good, { id: 'ib-ok' });
  assert.throws(() => insBuild(db, good), /UNIQUE constraint failed: image_builds\.approval_id/);
  assert.throws(() => db.prepare("UPDATE image_builds SET profile_id = 'sde-python' WHERE id = 'ib-ok'").run(), /image build identity is immutable/);
  db.prepare("UPDATE image_builds SET status = 'succeeded', image_id = ?, size_bytes = 10, finished_at = ? WHERE id = 'ib-ok'").run(DIGEST, T0 + 5);
  assert.throws(() => db.prepare('UPDATE image_builds SET size_bytes = 11 WHERE id = ?').run('ib-ok'), /a finished image build is immutable/);
  assert.throws(() => db.prepare("DELETE FROM image_builds WHERE id = 'ib-ok'").run(), /image builds are never deleted/);
  insEvent(db, { project_id: null, job_id: null, image_build_id: 'ib-ok', type: 'image_build', summary: 'image prepared' });
  assert.deepEqual(db.pragma('foreign_key_check'), []);
});
test('T16: a deployment is of an application of this project, by a tool job of an active participation', () => {
  const { db, ...w } = world();
  insert(db, 'agent_sessions', { id: 's-1', project_id: 'p-ledger', workspace_id: 'sde', participation_id: w.p1, principal_id: 'user:local',
    idempotency_key: 'k-s-1', created_at: T0, updated_at: T0, status_changed_at: T0 });
  insJob(db, w, 'j-agent', { kind: 'agent.run', session_id: 's-1' });
  insJob(db, w, 'j-gone', { workspace_id: 'qa', participation_id: 'pw-qa-gone' });
  const subject = /a deployment subject is an application or inference service version of this project/;
  assert.throws(() => insDeployment(db, w, { subject_version_id: 'v-suite' }), subject);
  assert.throws(() => insDeployment(db, w, { subject_version_id: 'v-app-other' }), subject);
  assert.throws(() => insDeployment(db, w, { job_id: 'j-agent' }), /a deployment is run by a tool job of this project and participation/);
  assert.throws(() => insDeployment(db, w, { participation_id: 'pw-qa-gone', job_id: 'j-gone' }), /the deploying participation must be active and in this project/);
  assert.throws(() => insDeployment(db, w, { status: 'healthy' }), /a deployment starts as starting/);
  insDeployment(db, w);
  assert.deepEqual(db.pragma('foreign_key_check'), []);
});
test('T17: deployment transitions follow the seeded table; the bind address is 127.0.0.1', () => {
  const { db, ...w } = world();
  const d = insDeployment(db, w, { host_port: 41000 });
  assert.throws(() => db.prepare("UPDATE deployments SET status = 'unhealthy' WHERE id = ?").run(d), /illegal deployment transition/);
  assert.throws(() => db.prepare('UPDATE deployments SET host_port = 41001 WHERE id = ?').run(d), /deployment identity is immutable/);
  stopDeployment(db, d, 'user');
  assert.throws(() => db.prepare("UPDATE deployments SET status = 'healthy', stop_reason = NULL, stopped_at = NULL WHERE id = ?").run(d),
    /illegal deployment transition|a finished deployment is frozen/);
  insJob(db, w, 'j-bind');
  assert.throws(() => insDeployment(db, w, { job_id: 'j-bind', bind_address: '0.0.0.0' }), /CHECK constraint failed/);
  assert.throws(() => db.prepare('DELETE FROM deployments WHERE id = ?').run(d), /deployments are never deleted/);
});
test('T18: two live deployments never share a host port; a stopped one frees it', () => {
  const { db, ...w } = world();
  insJob(db, w, 'j-2'); insJob(db, w, 'j-3');
  const d1 = insDeployment(db, w, { host_port: 42000 });
  assert.throws(() => insDeployment(db, w, { job_id: 'j-2', host_port: 42000 }), /UNIQUE constraint failed: deployments\.host_port/);
  stopDeployment(db, d1);
  insDeployment(db, w, { job_id: 'j-3', host_port: 42000 });
});
test('T19: one repository artifact per project (ux_repository_per_project)', () => {
  const { db } = world();
  const repo = (id) => insert(db, 'artifacts', { id, project_id: 'p-ledger', kind: 'repository', name: id, owner_scope: 'project',
    owner_participation_id: null, owner_workspace_id: null, created_by: 'system', created_at: T0, updated_at: T0 });
  repo('a-repo-1');
  assert.throws(() => repo('a-repo-2'), /UNIQUE constraint failed: artifacts\.project_id/);
});
test('T20: two versions from one job never share an output path (ux_versions_job_path)', () => {
  const { db, ...w } = world();
  insVersion(db, 'v-out-1', 'a-app', 3, w.p1, { produced_by_job_id: 'j-1', output_path: 'out/app' });
  assert.throws(() => insVersion(db, 'v-out-2', 'a-app', 4, w.p1, { produced_by_job_id: 'j-1', output_path: 'out/app' }),
    /UNIQUE constraint failed: artifact_versions\.produced_by_job_id, artifact_versions\.output_path/);
  insVersion(db, 'v-out-3', 'a-app', 4, w.p1, { produced_by_job_id: 'j-1', output_path: 'out/other' });
  insVersion(db, 'v-out-4', 'a-app', 5, w.p1, { output_path: 'out/app' });   // no producing job: NULLs are distinct
});

// ---------- fix round 1: gaps found in review of the plan's DDL ----------

const insSession = (db, w, id = 's-1') => insert(db, 'agent_sessions', { id, project_id: 'p-ledger', workspace_id: 'sde', participation_id: w.p1,
  principal_id: 'user:local', idempotency_key: `k-${id}`, created_at: T0, updated_at: T0, status_changed_at: T0 });
const jobTo = (db, id, state) => db.prepare('UPDATE jobs SET state = ? WHERE id = ?').run(state, id);

test('F1: decided fields are set exactly on approved or denied approvals', () => {
  const { db } = world();
  const a = insApproval(db);
  assert.throws(() => db.prepare("UPDATE approvals SET decided_by = 'user:local', decided_at = ?, decision = 'once' WHERE id = ?").run(T0 + 1, a),
    /CHECK constraint failed/, 'a decision on a still-pending approval');
  approve(db, a);
  assert.deepEqual({ ...db.prepare('SELECT status, decided_by, decision FROM approvals WHERE id = ?').get(a) },
    { status: 'approved', decided_by: 'user:local', decision: 'once' });
  const d = insApproval(db, { job_id: null, reason: 'repo.write_refs' });
  db.prepare("UPDATE approvals SET status = 'denied', decided_by = 'user:local', decided_at = ?, decision = 'deny' WHERE id = ?").run(T0 + 1, d);
  const x = insApproval(db, { job_id: null, reason: 'repo.write_refs' });
  db.prepare("UPDATE approvals SET status = 'withdrawn', status_changed_at = ? WHERE id = ?").run(T0 + 1, x);
});
test('F2: validations and job events name a real attempt of their job; a NULL attempt_n is allowed', () => {
  const { db } = world();
  assert.throws(() => insValidation(db, { attempt_n: 1 }), /FOREIGN KEY constraint failed/, 'no attempt 1 yet');
  assert.throws(() => insEvent(db, { attempt_n: 1 }), /FOREIGN KEY constraint failed/, 'no attempt 1 yet');
  insValidation(db, { attempt_n: null });
  insEvent(db, { attempt_n: null });
  lease(db, 'j-1', 1); insAttempt(db);
  insValidation(db, { attempt_n: 1 });
  insEvent(db, { attempt_n: 1 });
  assert.throws(() => insValidation(db, { attempt_n: 2 }), /FOREIGN KEY constraint failed/);
  assert.throws(() => insEvent(db, { attempt_n: 2 }), /FOREIGN KEY constraint failed/);
  const ap = insApproval(db);
  assert.throws(() => insEvent(db, { job_id: null, approval_id: ap, attempt_n: 1, type: 'approval' }), /CHECK constraint failed/, 'attempt without a job');
  assert.deepEqual(db.pragma('foreign_key_check'), []);
});
test('F3: a job event names the project of its approval and deployment, and an existing project', () => {
  const { db, ...w } = world();
  const ap = insApproval(db);
  const dep = insDeployment(db, w);
  assert.throws(() => insEvent(db, { job_id: null, approval_id: ap, project_id: 'p-invoice', type: 'approval' }), /a job event names the project of its approval/);
  assert.throws(() => insEvent(db, { job_id: null, approval_id: ap, project_id: null, type: 'approval' }), /a job event names the project of its approval/);
  const other = db.prepare("SELECT id FROM project_workspaces WHERE project_id = 'p-invoice' AND workspace_id = 'dl'").get().id;
  insert(db, 'jobs', { id: 'j-inv', kind: 'tool.run', project_id: 'p-invoice', workspace_id: 'dl', participation_id: other, idempotency_key: 'k-j-inv',
    requested_by: 'user:local', on_behalf_of: 'user:local', created_at: T0, updated_at: T0, state_changed_at: T0 });
  assert.throws(() => insEvent(db, { job_id: 'j-inv', deployment_id: dep, project_id: 'p-invoice', type: 'deployment' }),
    /a job event names the project of its deployment/);
  insEvent(db, { job_id: null, approval_id: ap, type: 'approval', summary: 'approval requested' });
  insEvent(db, { deployment_id: dep, approval_id: ap, type: 'deployment', summary: 'deployment starting' });
  const build = prepareApproval(db);
  assert.throws(() => insEvent(db, { job_id: null, approval_id: build, project_id: 'p-ledger', type: 'approval' }), /a job event names the project of its approval/);
  assert.throws(() => insEvent(db, { job_id: null, approval_id: 'ap-none', project_id: null, type: 'approval' }), /FOREIGN KEY constraint failed/);
  // An image build has no project; a made-up project id is refused by the projects FK.
  approve(db, build); consume(db, build); insBuild(db, build, { id: 'ib-f3' });
  assert.throws(() => insEvent(db, { job_id: null, image_build_id: 'ib-f3', project_id: 'p-nope', type: 'image_build' }), /FOREIGN KEY constraint failed/);
  insEvent(db, { job_id: null, image_build_id: 'ib-f3', project_id: null, type: 'image_build', summary: 'image prepared' });
  assert.deepEqual(db.pragma('foreign_key_check'), []);
});
test('F4: an approval session belongs to the approval project', () => {
  const { db, ...w } = world();
  insSession(db, w);
  assert.throws(() => insApproval(db, { job_id: null, project_id: 'p-invoice', reason: 'repo.write_refs', session_id: 's-1' }),
    /an approval session belongs to its project/);
  assert.throws(() => prepareApproval(db, 'sde-node', CTX, { session_id: 's-1' }), /an approval session belongs to its project/);
  insApproval(db, { session_id: 's-1' });
  insApproval(db, { job_id: null, reason: 'repo.write_refs', session_id: 's-1' });
});
test('F5: an image build refuses a backslash log path and a requester other than the approval names', () => {
  const { db } = world();
  const ap = prepareApproval(db); approve(db, ap); consume(db, ap);
  assert.throws(() => insBuild(db, ap, { requested_by: 'system' }), /an image build is requested by the principal its approval was requested for/);
  insBuild(db, ap, { id: 'ib-f5' });
  assert.throws(() => db.prepare("UPDATE image_builds SET log_path = 'logs\\b.log' WHERE id = 'ib-f5'").run(), /CHECK constraint failed/);
  db.prepare("UPDATE image_builds SET log_path = 'logs/b.log' WHERE id = 'ib-f5'").run();
});
test('F6: each guard alone: approval transitions without tr_approvals_once, no delete, log path once, a stopped deployment frozen', () => {
  const { db, ...w } = world();
  db.exec('DROP TRIGGER tr_approvals_once');   // temp copy only
  const a = insApproval(db); approve(db, a);
  assert.throws(() => db.prepare("UPDATE approvals SET status = 'denied', decision = 'deny' WHERE id = ?").run(a), /illegal approval transition/);
  assert.throws(() => db.prepare('DELETE FROM approvals WHERE id = ?').run(a), /approvals are never deleted/);
  lease(db, 'j-1', 1); const at = insAttempt(db);
  setAttempt(db, at, "log_path = 'logs/j-1-1.log'");
  assert.throws(() => setAttempt(db, at, "log_path = 'logs/other.log'"), /attempt identity, container and log path are immutable once set/);
  const d = insDeployment(db, w); stopDeployment(db, d);
  assert.throws(() => db.prepare("UPDATE deployments SET health_json = '[{\"ok\":true}]' WHERE id = ?").run(d),
    /deployment identity is immutable and a finished deployment is frozen/);
  assert.throws(() => db.prepare('UPDATE deployments SET updated_at = ? WHERE id = ?').run(T0 + 9, d), /a finished deployment is frozen/);
});
test('F7: a succeeded attempt records its exit code and outcome', () => {
  const { db } = world();
  lease(db, 'j-1', 1); const a = insAttempt(db); runAttempt(db, a);
  assert.throws(() => setAttempt(db, a, "state = 'succeeded', finished_at = ?, outcome = 'ok'", T0 + 2), /CHECK constraint failed/, 'no exit code');
  assert.throws(() => setAttempt(db, a, "state = 'succeeded', finished_at = ?, exit_code = 0", T0 + 2), /CHECK constraint failed/, 'no outcome');
  succeedAttempt(db, a);
  // A failed attempt needs neither.
  db.prepare('UPDATE jobs SET attempts = 2 WHERE id = ?').run('j-1');
  const b = insAttempt(db, { n: 2 });
  setAttempt(db, b, "state = 'failed', finished_at = ?", T0 + 3);
});
test('F8: running or succeeded attempts record their sandbox and environment', () => {
  const { db } = world();
  lease(db, 'j-1', 1); const a = insAttempt(db);
  assert.throws(() => setAttempt(db, a, "state = 'running', started_at = ?, environment_json = '{}'", T0 + 1), /CHECK constraint failed/, 'no sandbox');
  assert.throws(() => setAttempt(db, a, "state = 'running', started_at = ?, sandbox_json = '{}'", T0 + 1), /CHECK constraint failed/, 'no environment');
  assert.throws(() => setAttempt(db, a, "state = 'succeeded', finished_at = ?, exit_code = 0, outcome = 'ok'", T0 + 1), /CHECK constraint failed/,
    'an engine recipe finishing in one report still records both');
  setAttempt(db, a, `state = 'succeeded', finished_at = ?, exit_code = 0, outcome = 'ok', ${SANDBOX}`, T0 + 1);
});
test('F9: a tool.run or validate job completes only with a succeeded attempt; agent.run and ingest jobs are unaffected', () => {
  const { db, ...w } = world();
  const re = /a tool or validate job completes only with a succeeded attempt/;
  jobTo(db, 'j-1', 'leased'); jobTo(db, 'j-1', 'running');
  assert.throws(() => jobTo(db, 'j-1', 'completed'), re, 'no attempt');
  insJob(db, w, 'j-ok'); lease(db, 'j-ok', 1);
  const a = insAttempt(db, { job_id: 'j-ok' }); runAttempt(db, a);
  jobTo(db, 'j-ok', 'running');
  setAttempt(db, a, "state = 'failed', finished_at = ?", T0 + 2);
  assert.throws(() => jobTo(db, 'j-ok', 'completed'), re, 'only a failed attempt');
  insJob(db, w, 'j-good'); lease(db, 'j-good', 1);
  const g = insAttempt(db, { job_id: 'j-good' }); runAttempt(db, g); jobTo(db, 'j-good', 'running'); succeedAttempt(db, g);
  jobTo(db, 'j-good', 'completed');
  insJob(db, w, 'j-val', { kind: 'validate' }); jobTo(db, 'j-val', 'leased'); jobTo(db, 'j-val', 'running');
  assert.throws(() => jobTo(db, 'j-val', 'completed'), re, 'validate job without an attempt');
  jobTo(db, 'j-val', 'failed');
  // agent.run and ingest complete without attempts, as in B0b and B1.
  insSession(db, w);
  insJob(db, w, 'j-agent', { kind: 'agent.run', session_id: 's-1' });
  for (const st of ['leased', 'running', 'completed']) jobTo(db, 'j-agent', st);
  insJob(db, w, 'j-ingest', { kind: 'ingest' });
  for (const st of ['leased', 'running', 'completed']) jobTo(db, 'j-ingest', st);
  // a tool job may still end partial, failed or cancelled without a succeeded attempt.
  insJob(db, w, 'j-partial'); for (const st of ['leased', 'running', 'partial']) jobTo(db, 'j-partial', st);
  assert.deepEqual(db.prepare("SELECT id, state FROM jobs WHERE id IN ('j-good','j-agent','j-ingest','j-partial') ORDER BY id").all().map((r) => `${r.id}:${r.state}`),
    ['j-agent:completed', 'j-good:completed', 'j-ingest:completed', 'j-partial:partial']);
});
test('F10: no job reaches a terminal state while one of its attempts is live', () => {
  const { db, ...w } = world();
  const re = /a job ends only after its live attempt has ended/;
  lease(db, 'j-1', 1); const a = insAttempt(db);
  assert.throws(() => jobTo(db, 'j-1', 'cancelled'), re, 'starting attempt');
  assert.throws(() => jobTo(db, 'j-1', 'interrupted'), re, 'starting attempt');
  runAttempt(db, a); jobTo(db, 'j-1', 'running');
  for (const st of ['failed', 'timed_out', 'partial', 'cancelled', 'interrupted']) assert.throws(() => jobTo(db, 'j-1', st), re, st);
  setAttempt(db, a, "state = 'abandoned', finished_at = ?", T0 + 3);
  jobTo(db, 'j-1', 'interrupted');
  // non-terminal moves are not affected
  insJob(db, w, 'j-2'); lease(db, 'j-2', 1); const b = insAttempt(db, { job_id: 'j-2' }); runAttempt(db, b);
  jobTo(db, 'j-2', 'running'); jobTo(db, 'j-2', 'awaiting_approval'); jobTo(db, 'j-2', 'running');
});
test('F11: version_attempts binds a version to an attempt of the job that produced it, and is append-only', () => {
  const { db, ...w } = world();
  lease(db, 'j-1', 1); insAttempt(db);
  insJob(db, w, 'j-2'); lease(db, 'j-2', 1); insAttempt(db, { job_id: 'j-2' });
  insVersion(db, 'v-prod', 'a-app', 3, w.p1, { produced_by_job_id: 'j-1', output_path: 'out/app' });
  const va = (version, job, n) => insert(db, 'version_attempts', { version_id: version, job_id: job, attempt_n: n });
  assert.throws(() => va('v-prod', 'j-2', 1), /a version is bound to an attempt of the job that produced it/);
  assert.throws(() => va('v-app-draft', 'j-1', 1), /a version is bound to an attempt of the job that produced it/, 'no producing job');
  assert.throws(() => va('v-prod', 'j-1', 2), /FOREIGN KEY constraint failed/);
  va('v-prod', 'j-1', 1);
  assert.throws(() => va('v-prod', 'j-1', 1), /UNIQUE constraint failed: version_attempts\.version_id/);
  assert.throws(() => db.prepare("UPDATE version_attempts SET attempt_n = 1 WHERE version_id = 'v-prod'").run(), /version attempts are append-only/);
  assert.throws(() => db.prepare("DELETE FROM version_attempts WHERE version_id = 'v-prod'").run(), /version attempts are append-only/);
  assert.deepEqual(db.pragma('foreign_key_check'), []);
});
test('F12: consumption names an attempt of the approval job (none for a jobless approval), once', () => {
  const { db, ...w } = world();
  lease(db, 'j-1', 1); insAttempt(db);
  insJob(db, w, 'j-2'); lease(db, 'j-2', 1); insAttempt(db, { job_id: 'j-2' });
  const a = insApproval(db); approve(db, a);
  const set = (sql, ...args) => db.prepare(`UPDATE approvals SET ${sql} WHERE id = ?`).run(...args, a);
  assert.throws(() => set('consumed_at = ?', T0 + 2), /CHECK constraint failed/, 'a job approval names its consuming attempt');
  assert.throws(() => set("consumed_at = ?, consumed_by_job_id = 'j-2', consumed_by_attempt_n = 1", T0 + 2), /CHECK constraint failed/, 'another job');
  assert.throws(() => set("consumed_at = ?, consumed_by_job_id = 'j-1'", T0 + 2), /CHECK constraint failed/, 'job without attempt number');
  assert.throws(() => set("consumed_by_job_id = 'j-1', consumed_by_attempt_n = 1"), /CHECK constraint failed/, 'consumer without consumed_at');
  assert.throws(() => set("consumed_at = ?, consumed_by_job_id = 'j-1', consumed_by_attempt_n = 7", T0 + 2), /FOREIGN KEY constraint failed/);
  consume(db, a);
  assert.deepEqual({ ...db.prepare('SELECT consumed_by_job_id j, consumed_by_attempt_n n FROM approvals WHERE id = ?').get(a) }, { j: 'j-1', n: 1 });
  assert.throws(() => set('consumed_by_attempt_n = 2'), /an approval request is immutable; its decision and its consumption are recorded once/);
  const img = prepareApproval(db); approve(db, img);
  assert.throws(() => db.prepare("UPDATE approvals SET consumed_at = ?, consumed_by_job_id = 'j-1', consumed_by_attempt_n = 1 WHERE id = ?").run(T0 + 2, img),
    /CHECK constraint failed/, 'a jobless approval names no attempt');
  consume(db, img);
  assert.deepEqual(db.pragma('foreign_key_check'), []);
});
test('F13: stopped_by is recorded exactly when a deployment is stopped', () => {
  const { db, ...w } = world();
  insJob(db, w, 'j-2');
  const d = insDeployment(db, w);
  assert.throws(() => db.prepare("UPDATE deployments SET status = 'stopped', stop_reason = 'user', stopped_at = ? WHERE id = ?").run(T0 + 1, d),
    /CHECK constraint failed/, 'stopped without who');
  assert.throws(() => insDeployment(db, w, { job_id: 'j-2', stopped_by: 'user:local' }), /CHECK constraint failed/, 'live with a stopper');
  stopDeployment(db, d, 'app_quit', 'system');
  const f = insDeployment(db, w, { job_id: 'j-2' });
  assert.throws(() => db.prepare("UPDATE deployments SET status = 'failed', stop_reason = 'exited', stopped_at = ?, stopped_by = 'system' WHERE id = ?").run(T0 + 1, f),
    /CHECK constraint failed/, 'a failure is not a stop');
  db.prepare("UPDATE deployments SET status = 'failed', stop_reason = 'exited', stopped_at = ? WHERE id = ?").run(T0 + 1, f);
  assert.equal(db.prepare('SELECT stopped_by FROM deployments WHERE id = ?').get(d).stopped_by, 'system');
});
