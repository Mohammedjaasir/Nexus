'use strict';
const h = require('./helpers/sqlite.cjs');
if (!h.realSqliteOrSkip()) return;
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');
const { PersistStore } = loadTs('src/main/db.ts');
const { createNexusPlatform } = loadTs('src/main/nexus/platform.ts');
const seed = loadTs('src/main/nexus/db/v7Seed.ts');
function setup(file = h.v6Fixture().file) {
  const s = new PersistStore(file); s.open({ log: () => {}, backupDir: path.join(path.dirname(file), 'b'), now: () => h.NOW });
  const db = s.platformDatabase(); const nx = createNexusPlatform(db, { now: () => h.NOW });
  return { s, db, nx, file, me: nx.principals.localUser(), sys: nx.principals.system() };
}
let k = 0; const key = () => `intent-${++k}`;
const RETRY = { idempotent: true, maxAttempts: 3, backoffMs: [10] };
const job = (nx, me, extra = {}) => nx.jobs.create(me, { kind: 'tool.run', projectId: 'p-ledger', workspaceId: 'sde', idempotencyKey: key(), retry: RETRY, ...extra }).job;
const drive = (nx, sys, id, steps) => steps.forEach((st) => nx.jobs.transition(sys, id, st));
const PATH_TO = {
  queued: [], leased: ['leased'], running: ['leased', 'running'], awaiting_approval: ['leased', 'running', 'awaiting_approval'],
  failed: ['leased', 'running', 'failed'], timed_out: ['leased', 'running', 'timed_out'],
  retry_scheduled: ['leased', 'running', 'failed', 'retry_scheduled']
};

test('create is idempotent by intent key, starts queued, and resolves the participation in main', () => {
  const { s, nx, me } = setup();
  const a = nx.jobs.create(me, { kind: 'tool.run', projectId: 'p-ledger', workspaceId: 'sde', idempotencyKey: 'same' });
  const b = nx.jobs.create(me, { kind: 'tool.run', projectId: 'p-ledger', workspaceId: 'sde', idempotencyKey: 'same' });
  assert.equal(a.created, true); assert.equal(b.created, false); assert.equal(a.job.id, b.job.id);
  assert.equal(a.job.state, 'queued'); assert.equal(a.job.attempts, 0);
  assert.equal(a.job.participationId, nx.workspaces.primaryOf(me, 'p-ledger').id);
  assert.throws(() => nx.jobs.create(me, { kind: 'tool.run', projectId: 'p-ledger', workspaceId: 'qa', idempotencyKey: key() }), (e) => e.code === 'not_participating');
  s.close();
});
test('an agent.run job needs a session (service and database)', () => {
  const { s, db, nx, me } = setup();
  assert.throws(() => nx.jobs.create(me, { kind: 'agent.run', projectId: 'p-ledger', workspaceId: 'sde', idempotencyKey: key() }), (e) => e.code === 'invalid');
  const pw = nx.workspaces.primaryOf(me, 'p-ledger').id;
  assert.throws(() => db.prepare(`INSERT INTO jobs (id,kind,project_id,workspace_id,participation_id,idempotency_key,requested_by,on_behalf_of,created_at,updated_at,state_changed_at)
    VALUES ('jx','agent.run','p-ledger','sde',?,'kx','user:local','user:local',1,1,1)`).run(pw), /CHECK/);
  s.close();
});
test('every pair of states: legal transitions persist, illegal ones are refused by service and database', () => {
  const { s, db, nx, me, sys } = setup();
  const states = seed.V7_JOB_STATES.map((x) => x.state);
  const legal = new Set(seed.V7_JOB_TRANSITIONS.map(([a, b]) => `${a}>${b}`));
  for (const from of Object.keys(PATH_TO)) for (const to of states) {
    if (from === to) continue;
    const j = job(nx, me); drive(nx, sys, j.id, PATH_TO[from]);
    if (legal.has(`${from}>${to}`)) assert.equal(nx.jobs.transition(sys, j.id, to).state, to, `${from}>${to}`);
    else {
      assert.throws(() => nx.jobs.transition(sys, j.id, to), (e) => e.code === 'illegal_transition', `${from}>${to}`);
      assert.throws(() => db.prepare('UPDATE jobs SET state=? WHERE id=?').run(to, j.id), /illegal job state transition/, `${from}>${to} db`);
    }
  }
  s.close();
});
test('queued -> leased -> running: attempts count leases, started_at is set once', () => {
  const { s, nx, me, sys } = setup(); const j = job(nx, me);
  drive(nx, sys, j.id, ['leased']); assert.equal(nx.jobs.get(me, j.id).attempts, 1);
  drive(nx, sys, j.id, ['queued', 'leased', 'running']);           // lease lost, then leased again
  const r = nx.jobs.get(me, j.id); assert.equal(r.attempts, 2); assert.ok(r.startedAt); assert.equal(r.finishedAt, null);
  s.close();
});
test('failed -> retry_scheduled -> queued for a retryable job; refused otherwise', () => {
  const { s, nx, me, sys } = setup();
  const j = job(nx, me); drive(nx, sys, j.id, ['leased', 'running', 'failed']);
  assert.ok(nx.jobs.get(me, j.id).finishedAt);
  drive(nx, sys, j.id, ['retry_scheduled', 'queued']);
  assert.equal(nx.jobs.get(me, j.id).finishedAt, null);
  drive(nx, sys, j.id, ['leased', 'running', 'timed_out', 'retry_scheduled', 'queued', 'leased', 'running', 'failed']);
  assert.equal(nx.jobs.get(me, j.id).attempts, 3);
  assert.throws(() => nx.jobs.transition(sys, j.id, 'retry_scheduled'), (e) => e.code === 'illegal_transition' && e.detail.reason === 'not_retryable');
  const once = job(nx, me, { retry: undefined }); drive(nx, sys, once.id, ['leased', 'running', 'failed']);
  assert.throws(() => nx.jobs.transition(sys, once.id, 'retry_scheduled'), (e) => e.detail?.reason === 'not_retryable');
  s.close();
});
test('completed, partial, cancelled and interrupted are final', () => {
  const { s, nx, me, sys } = setup();
  for (const t of ['completed', 'partial', 'cancelled', 'interrupted']) {
    const j = job(nx, me); drive(nx, sys, j.id, ['leased', 'running', t]);
    assert.ok(nx.jobs.get(me, j.id).finishedAt);
    for (const to of ['running', 'retry_scheduled', 'queued'])
      assert.throws(() => nx.jobs.transition(sys, j.id, to), (e) => e.code === 'illegal_transition', `${t}>${to}`);
  }
  s.close();
});
test('users cannot drive execution states; they can cancel from any live state', () => {
  const { s, nx, me, sys } = setup();
  const j = job(nx, me);
  assert.throws(() => nx.jobs.transition(me, j.id, 'leased'), (e) => e.code === 'denied');
  for (const from of ['queued', 'leased', 'running', 'awaiting_approval', 'retry_scheduled']) {
    const x = job(nx, me); drive(nx, sys, x.id, PATH_TO[from]);
    const c = nx.jobs.requestCancel(me, x.id);
    assert.equal(c.state, 'cancelled', from); assert.ok(c.cancelRequestedAt);
  }
  s.close();
});
test('restart recovery: running/awaiting_approval -> interrupted, leased -> queued, queued stays; durable across reopen', () => {
  const { s, nx, me, sys, file } = setup();
  const q = job(nx, me); const l = job(nx, me); const r = job(nx, me); const w = job(nx, me);
  drive(nx, sys, l.id, ['leased']); drive(nx, sys, r.id, PATH_TO.running); drive(nx, sys, w.id, PATH_TO.awaiting_approval);
  s.close();
  const again = setup(file);
  assert.deepEqual(again.nx.jobs.recoverAfterRestart(again.sys), { interrupted: 2, requeued: 1 });
  assert.equal(again.nx.jobs.get(again.me, q.id).state, 'queued');
  assert.equal(again.nx.jobs.get(again.me, l.id).state, 'queued');
  assert.equal(again.nx.jobs.get(again.me, r.id).state, 'interrupted');
  assert.equal(again.nx.jobs.get(again.me, w.id).outcome, 'interrupted');
  assert.deepEqual(again.nx.jobs.recoverAfterRestart(again.sys), { interrupted: 0, requeued: 0 });
  again.s.close();
});
test('errors are stored redacted', () => {
  const { s, nx, me, sys } = setup(); const j = job(nx, me); drive(nx, sys, j.id, PATH_TO.running);
  const f = nx.jobs.transition(sys, j.id, 'failed', { outcome: 'runtime_error', error: { code: 'runtime_error', message: 'auth failed for sk-ant-abcdefghijklmnopqrstuv' } });
  assert.doesNotMatch(f.error.message, /sk-ant-abc/);
  s.close();
});
test('jobs cannot be deleted or re-identified', () => {
  const { s, db, nx, me } = setup(); const j = job(nx, me);
  assert.throws(() => db.prepare('DELETE FROM jobs WHERE id=?').run(j.id), /never deleted/);
  assert.throws(() => db.prepare("UPDATE jobs SET project_id='p-invoice' WHERE id=?").run(j.id), /identity is immutable/);
  s.close();
});
test('status, project and session reads use their indexes', () => {
  const { s, db } = setup();
  // Brief fix: better-sqlite3 refuses unbound parameters, so the plan queries bind values.
  const plan = (q, ...args) => db.prepare(`EXPLAIN QUERY PLAN ${q}`).all(...args).map((r) => r.detail).join(' ');
  assert.match(plan("SELECT id FROM jobs WHERE state IN ('leased','running','awaiting_approval')"), /ix_jobs_state/);
  assert.match(plan('SELECT * FROM jobs WHERE project_id=? ORDER BY created_at DESC LIMIT 50', 'p-ledger'), /ix_jobs_project/);
  assert.match(plan('SELECT * FROM jobs WHERE session_id=? ORDER BY created_at', 'x'), /ix_jobs_session/);
  s.close();
});

// ---------- controller rulings and service rules beyond the brief ----------
test('ruling 3: withdraw refuses while the participation has a live job or agent session', () => {
  const { s, nx, me, sys } = setup();
  const qa = nx.workspaces.attach(me, 'p-ledger', 'qa');
  const j = job(nx, me, { workspaceId: 'qa' }); drive(nx, sys, j.id, PATH_TO.running);
  assert.throws(() => nx.workspaces.withdraw(me, qa.id), (e) => e.code === 'conflict' && e.detail.liveJobs === 1);
  nx.jobs.requestCancel(me, j.id);
  const x = nx.sessions.open(me, { projectId: 'p-ledger', workspaceId: 'qa', idempotencyKey: key() }).session;
  assert.throws(() => nx.workspaces.withdraw(me, qa.id), (e) => e.code === 'conflict' && e.detail.liveSessions === 1);
  nx.sessions.cancel(me, x.id);
  assert.equal(nx.workspaces.withdraw(me, qa.id).status, 'withdrawn');
  assert.throws(() => job(nx, me, { workspaceId: 'qa' }), (e) => e.code === 'participation_inactive');
  s.close();
});
test('a re-sent key naming different work is a conflict; inputs copy the content hash and must be candidate/active', () => {
  const { s, nx, me, sys } = setup();
  nx.jobs.create(me, { kind: 'tool.run', projectId: 'p-ledger', workspaceId: 'sde', idempotencyKey: 'dup' });
  assert.throws(() => nx.jobs.create(me, { kind: 'validate', projectId: 'p-ledger', workspaceId: 'sde', idempotencyKey: 'dup' }), (e) => e.code === 'conflict');
  const a = nx.artifacts.create(me, { projectId: 'p-ledger', workspaceId: 'sde', kind: 'report', name: 'in' });
  const draft = nx.artifacts.registerVersion(me, { artifactId: a.id, storage: { kind: 'inline', json: { d: 1 } } }).version;
  assert.throws(() => job(nx, me, { inputs: [{ versionId: draft.id, role: 'source' }] }), (e) => e.code === 'invalid');
  const v = nx.artifacts.finalize(sys, draft.id, 'candidate');
  const j = job(nx, me, { inputs: [{ versionId: v.id, role: 'source' }] });
  assert.deepEqual(j.inputs, [{ versionId: v.id, role: 'source', contentHash: v.contentHash }]);
  s.close();
});
test('params are exact JSON and stored exactly; secret-shaped params are refused; the activity row carries no params', () => {
  const { s, db, nx, me } = setup();
  assert.throws(() => job(nx, me, { params: { n: NaN } }), (e) => e.code === 'invalid');
  assert.throws(() => job(nx, me, { params: [1] }), (e) => e.code === 'invalid');
  const n = h.count(db, 'jobs');
  for (const params of [{ apiKey: 'x' }, { nested: { deep: { deeper: { deepest: { v: 'sk-ant-abcdefghijklmnopqrstuv' } } } } },
    { url: 'https://user:pw@example.com/x' }, { tokenizer: 'bpe' }, { list: Array.from({ length: 80 }, (_, i) => (i === 79 ? 'Bearer abcdefghijklmnopqrstuvwxyz0123' : 'ok')) }]) {
    assert.throws(() => job(nx, me, { params }), (e) => e.code === 'invalid' && e.detail.reason === 'secret_in_params', JSON.stringify(params).slice(0, 60));
  }
  assert.equal(h.count(db, 'jobs'), n);
  const long = 'x'.repeat(2000);
  const exact = { path: 'src/a.ts', long, deep: { a: { b: { c: { d: { e: 1 } } } } }, many: Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`k${i}`, i])), tokensUsed: 5 };
  const j = job(nx, me, { params: exact });
  assert.deepEqual(j.params, exact);
  assert.deepEqual(JSON.parse(db.prepare('SELECT params_json FROM jobs WHERE id=?').get(j.id).params_json), exact);
  assert.doesNotMatch(JSON.stringify(nx.activity.list(me, { jobId: j.id })), /src\/a\.ts/);
  s.close();
});
test('session cancel: children before parents, one row per change, all with the session id; a stranger is denied', () => {
  const { s, db, nx, me, sys } = setup();
  const x = nx.sessions.open(me, { projectId: 'p-ledger', workspaceId: 'sde', idempotencyKey: key() }).session;
  const parent = job(nx, me, { kind: 'agent.run', sessionId: x.id, retry: undefined });
  const child = job(nx, me, { sessionId: x.id, parentJobId: parent.id });
  drive(nx, sys, parent.id, PATH_TO.running);
  const guest = { id: 'user:guest', kind: 'user', displayName: 'g' };
  assert.throws(() => nx.sessions.cancel(guest, x.id), (e) => e.code === 'denied');
  const before = h.count(db, 'activity');
  nx.sessions.cancel(me, x.id);
  const rows = db.prepare('SELECT action, job_id, session_id FROM activity WHERE seq > (SELECT MAX(seq) FROM activity) - 3 ORDER BY seq').all();
  assert.equal(h.count(db, 'activity'), before + 3);
  assert.deepEqual(rows.map((r) => [r.action, r.job_id]), [['job.cancel', child.id], ['job.cancel', parent.id], ['session.cancel', null]]);
  assert.ok(rows.every((r) => r.session_id === x.id));
  assert.equal(nx.jobs.requestCancel(me, child.id).state, 'cancelled');            // terminal: unchanged
  assert.equal(h.count(db, 'activity'), before + 3);
  s.close();
});
test('recovery and transition are system-only; startup runs both recoveries', () => {
  const { s, nx, me, sys } = setup();
  assert.throws(() => nx.jobs.recoverAfterRestart(me), (e) => e.code === 'denied');
  assert.throws(() => nx.sessions.recoverAfterRestart(me), (e) => e.code === 'denied');
  const j = job(nx, me); drive(nx, sys, j.id, PATH_TO.running);
  const x = nx.sessions.open(me, { projectId: 'p-ledger', workspaceId: 'sde', idempotencyKey: key() }).session;
  nx.sessions.transition(sys, x.id, 'running');
  nx.startup();
  assert.equal(nx.jobs.get(me, j.id).state, 'interrupted');
  assert.equal(nx.sessions.get(me, x.id).status, 'interrupted');
  s.close();
});

// ---------- fix round 1 ----------
function addUser(db, id, scopeType, scopeId, role = 'member') {
  db.prepare('INSERT INTO principals VALUES (?,?,?,NULL,?)').run(id, 'user', id, h.NOW);
  db.prepare('INSERT INTO memberships VALUES (?,?,?,?,?)').run(id, scopeType, scopeId, role, h.NOW);
  return { id, kind: 'user', displayName: id };
}
const denied = (db) => db.prepare("SELECT COUNT(*) AS n FROM activity WHERE status='denied'").get().n;
function sdeCandidate(nx, me, sys) {
  const a = nx.artifacts.create(me, { projectId: 'p-ledger', workspaceId: 'sde', kind: 'report', name: `sde-${Math.random()}` });
  const v = nx.artifacts.registerVersion(me, { artifactId: a.id, storage: { kind: 'inline', json: { a: a.id } } }).version;
  return nx.artifacts.finalize(sys, v.id, 'candidate');
}

test('fix 1: a qa-only member cannot consume an sde version: job input, session context and version input are denied (one row each)', () => {
  const { s, db, nx, me, sys } = setup();
  nx.workspaces.attach(me, 'p-ledger', 'qa');
  const qa = addUser(db, 'user:qa', 'workspace', 'qa');
  const sdeV = sdeCandidate(nx, me, sys);
  const jobs = h.count(db, 'jobs');
  let d = denied(db);
  assert.throws(() => nx.jobs.create(qa, { kind: 'tool.run', projectId: 'p-ledger', workspaceId: 'qa', idempotencyKey: key(),
    inputs: [{ versionId: sdeV.id, role: 'source' }] }), (e) => e.code === 'denied');
  assert.equal(denied(db), d + 1); assert.equal(h.count(db, 'jobs'), jobs);
  d = denied(db);
  assert.throws(() => nx.sessions.open(qa, { projectId: 'p-ledger', workspaceId: 'qa', idempotencyKey: key(), contextVersionId: sdeV.id }),
    (e) => e.code === 'denied');
  assert.equal(denied(db), d + 1); assert.equal(h.count(db, 'agent_sessions'), 0);
  const qaArt = nx.artifacts.create(qa, { projectId: 'p-ledger', workspaceId: 'qa', kind: 'report', name: 'qa-out' });
  d = denied(db);
  assert.throws(() => nx.artifacts.registerVersion(qa, { artifactId: qaArt.id, storage: { kind: 'inline', json: {} },
    inputs: [{ versionId: sdeV.id, role: 'source' }] }), (e) => e.code === 'denied');
  assert.equal(denied(db), d + 1);
  // The same member may use a qa version it can read.
  const qv = nx.artifacts.registerVersion(qa, { artifactId: qaArt.id, storage: { kind: 'inline', json: { q: 1 } } }).version;
  nx.artifacts.finalize(sys, qv.id, 'candidate');
  assert.equal(nx.jobs.create(qa, { kind: 'tool.run', projectId: 'p-ledger', workspaceId: 'qa', idempotencyKey: key(),
    inputs: [{ versionId: qv.id, role: 'source' }] }).job.inputs.length, 1);
  assert.equal(nx.sessions.open(qa, { projectId: 'p-ledger', workspaceId: 'qa', idempotencyKey: key(), contextVersionId: qv.id }).session.contextVersionId, qv.id);
  s.close();
});
test('fix 2: a secret-shaped runtime ref is refused on job create, session open and both transitions', () => {
  const { s, nx, me, sys } = setup();
  const secret = 'sk-ant-abcdefghijklmnopqrstuv';
  const isSecretRef = (e) => e.code === 'invalid' && e.detail?.reason === 'secret_in_ref';
  assert.throws(() => job(nx, me, { runtime: { kind: 'claude-cli', ref: secret } }), isSecretRef);
  assert.throws(() => nx.sessions.open(me, { projectId: 'p-ledger', workspaceId: 'sde', idempotencyKey: key(), runtime: { kind: 'claude-cli', ref: secret } }), isSecretRef);
  const j = job(nx, me);
  assert.throws(() => nx.jobs.transition(sys, j.id, 'leased', { runtimeRef: secret }), isSecretRef);
  assert.equal(nx.jobs.get(me, j.id).state, 'queued');
  const x = nx.sessions.open(me, { projectId: 'p-ledger', workspaceId: 'sde', idempotencyKey: key(), runtime: { kind: 'claude-cli', ref: 'run-42' } }).session;
  assert.equal(x.runtimeRef, 'run-42');
  assert.throws(() => nx.sessions.transition(sys, x.id, 'running', { runtimeRef: secret }), isSecretRef);
  assert.equal(nx.sessions.transition(sys, x.id, 'running', { runtimeRef: 'run-43' }).runtimeRef, 'run-43');
  s.close();
});
test('fix 3: no resurrection: a retry after the session ended or the participation was withdrawn is refused', () => {
  const { s, nx, me, sys } = setup();
  const x = nx.sessions.open(me, { projectId: 'p-ledger', workspaceId: 'sde', idempotencyKey: key() }).session;
  const inSession = job(nx, me, { sessionId: x.id }); drive(nx, sys, inSession.id, PATH_TO.failed);
  nx.sessions.cancel(me, x.id);
  assert.equal(nx.jobs.get(me, inSession.id).state, 'failed');                    // terminal jobs are left alone by cancel
  assert.throws(() => nx.jobs.transition(sys, inSession.id, 'retry_scheduled'),
    (e) => e.code === 'illegal_transition' && e.detail.reason === 'session_ended');
  const qa = nx.workspaces.attach(me, 'p-ledger', 'qa');
  const inQa = job(nx, me, { workspaceId: 'qa' }); drive(nx, sys, inQa.id, PATH_TO.failed);
  assert.equal(nx.workspaces.withdraw(me, qa.id).status, 'withdrawn');             // the failed job is terminal
  assert.throws(() => nx.jobs.transition(sys, inQa.id, 'retry_scheduled'),
    (e) => e.code === 'illegal_transition' && e.detail.reason === 'participation_inactive');
  s.close();
});
test('fix 3: startup interrupts a leased agent.run job whose session recovery interrupted, instead of requeueing it', () => {
  const { s, nx, me, sys, file } = setup();
  const x = nx.sessions.open(me, { projectId: 'p-ledger', workspaceId: 'sde', idempotencyKey: key() }).session;
  nx.sessions.transition(sys, x.id, 'running');
  const run = job(nx, me, { kind: 'agent.run', sessionId: x.id, retry: undefined }); drive(nx, sys, run.id, PATH_TO.leased);
  const plain = job(nx, me); drive(nx, sys, plain.id, PATH_TO.leased);
  s.close();
  const again = setup(file);
  assert.deepEqual(again.nx.sessions.recoverAfterRestart(again.sys), { interrupted: 1 });
  assert.deepEqual(again.nx.jobs.recoverAfterRestart(again.sys), { interrupted: 1, requeued: 1 });
  assert.equal(again.nx.jobs.get(again.me, run.id).state, 'interrupted');
  assert.equal(again.nx.jobs.get(again.me, plain.id).state, 'queued');
  assert.deepEqual(again.nx.jobs.recoverAfterRestart(again.sys), { interrupted: 0, requeued: 0 });
  again.s.close();
});
test('fix 4: a parent job shares the participation and the session of its children', () => {
  const { s, nx, me } = setup();
  const x = nx.sessions.open(me, { projectId: 'p-ledger', workspaceId: 'sde', idempotencyKey: key() }).session;
  const y = nx.sessions.open(me, { projectId: 'p-ledger', workspaceId: 'sde', idempotencyKey: key() }).session;
  const noSession = job(nx, me);
  const inX = job(nx, me, { sessionId: x.id });
  assert.throws(() => job(nx, me, { sessionId: x.id, parentJobId: noSession.id }), (e) => e.code === 'invalid');
  assert.throws(() => job(nx, me, { parentJobId: inX.id }), (e) => e.code === 'invalid');
  assert.throws(() => job(nx, me, { sessionId: y.id, parentJobId: inX.id }), (e) => e.code === 'invalid');
  nx.workspaces.attach(me, 'p-ledger', 'qa');
  assert.throws(() => job(nx, me, { workspaceId: 'qa', parentJobId: noSession.id }), (e) => e.code === 'invalid');
  assert.equal(job(nx, me, { sessionId: x.id, parentJobId: inX.id }).parentJobId, inX.id);
  assert.equal(job(nx, me, { parentJobId: noSession.id }).parentJobId, noSession.id);
  s.close();
});
test('fix 5: only the session principal (or the system) adds jobs to a session; the refusal is one denied row', () => {
  const { s, db, nx, me, sys } = setup();
  const other = addUser(db, 'user:other', 'platform', '*');
  const x = nx.sessions.open(me, { projectId: 'p-ledger', workspaceId: 'sde', idempotencyKey: key() }).session;
  const d = denied(db); const n = h.count(db, 'jobs');
  assert.throws(() => nx.jobs.create(other, { kind: 'agent.run', projectId: 'p-ledger', workspaceId: 'sde', sessionId: x.id, idempotencyKey: key() }),
    (e) => e.code === 'denied' && e.detail.reason === 'not_session_principal');
  assert.equal(denied(db), d + 1); assert.equal(h.count(db, 'jobs'), n);
  assert.equal(db.prepare("SELECT session_id FROM activity WHERE status='denied' ORDER BY seq DESC LIMIT 1").get().session_id, x.id);
  assert.equal(nx.jobs.create(sys, { kind: 'agent.run', projectId: 'p-ledger', workspaceId: 'sde', sessionId: x.id, idempotencyKey: key() }).job.requestedBy, 'system');
  s.close();
});
test('fix 6: a re-sent job or session key must match every supplied field', () => {
  const { s, nx, me, sys } = setup();
  const v = sdeCandidate(nx, me, sys); const w = sdeCandidate(nx, me, sys);
  const base = { kind: 'tool.run', projectId: 'p-ledger', workspaceId: 'sde', idempotencyKey: 'same-job', priority: 2, recipeId: 'lint',
    params: { a: 1 }, inputs: [{ versionId: v.id, role: 'source' }], retry: RETRY, runtime: { kind: 'claude-cli', ref: 'r1' } };
  const first = nx.jobs.create(me, base).job;
  assert.equal(nx.jobs.create(me, base).job.id, first.id);
  assert.equal(nx.jobs.create(me, { kind: 'tool.run', projectId: 'p-ledger', workspaceId: 'sde', idempotencyKey: 'same-job' }).created, false);
  for (const change of [{ priority: 0 }, { recipeId: 'build' }, { validatorId: 'schema' }, { params: { a: 2 } }, { inputs: [{ versionId: w.id, role: 'source' }] },
    { inputs: [] }, { retry: { ...RETRY, maxAttempts: 2 } }, { runtime: { kind: 'other-cli' } }, { runtime: { kind: 'claude-cli', ref: 'r2' } }]) {
    assert.throws(() => nx.jobs.create(me, { ...base, ...change }), (e) => e.code === 'conflict', JSON.stringify(change));
  }
  const ctx = sdeCandidate(nx, me, sys);
  const o = { projectId: 'p-ledger', workspaceId: 'sde', idempotencyKey: 'same-session', contextVersionId: ctx.id, runtime: { kind: 'claude-cli', ref: 'r1' } };
  const sess = nx.sessions.open(me, o).session;
  assert.equal(nx.sessions.open(me, o).session.id, sess.id);
  for (const change of [{ contextVersionId: v.id }, { runtime: { kind: 'other-cli' } }, { runtime: { kind: 'claude-cli', ref: 'r2' } }]) {
    assert.throws(() => nx.sessions.open(me, { ...o, ...change }), (e) => e.code === 'conflict', JSON.stringify(change));
  }
  s.close();
});
test('fix 8: error messages keep their length (up to 4096 chars) and lose only their secrets', () => {
  const { s, nx, me, sys } = setup(); const j = job(nx, me); drive(nx, sys, j.id, PATH_TO.running);
  const message = `${'context '.repeat(100)} key sk-ant-abcdefghijklmnopqrstuv ${'tail '.repeat(1000)}`;
  const f = nx.jobs.transition(sys, j.id, 'failed', { error: { code: 'runtime_error', message } });
  assert.doesNotMatch(f.error.message, /sk-ant-abc|omitted/);
  assert.equal(f.error.message.length > 3000, true); assert.ok(f.error.message.length <= 4096);
  assert.match(f.error.message, /^context context/);
  s.close();
});
test('gap: session cancel reaches leased and retry_scheduled jobs; job recovery leaves retry_scheduled alone', () => {
  const { s, nx, me, sys } = setup();
  const x = nx.sessions.open(me, { projectId: 'p-ledger', workspaceId: 'sde', idempotencyKey: key() }).session;
  const leased = job(nx, me, { sessionId: x.id }); drive(nx, sys, leased.id, PATH_TO.leased);
  const retry = job(nx, me, { sessionId: x.id }); drive(nx, sys, retry.id, PATH_TO.retry_scheduled);
  const outside = job(nx, me); drive(nx, sys, outside.id, PATH_TO.retry_scheduled);
  assert.deepEqual(nx.jobs.recoverAfterRestart(sys), { interrupted: 0, requeued: 1 });
  assert.equal(nx.jobs.get(me, retry.id).state, 'retry_scheduled');
  assert.equal(nx.jobs.get(me, outside.id).state, 'retry_scheduled');
  drive(nx, sys, leased.id, PATH_TO.leased);                                        // requeued by recovery; lease it again
  nx.sessions.cancel(me, x.id);
  assert.equal(nx.jobs.get(me, leased.id).state, 'cancelled');
  assert.equal(nx.jobs.get(me, retry.id).state, 'cancelled');
  assert.equal(nx.jobs.get(me, outside.id).state, 'retry_scheduled');
  s.close();
});
test('gap: session cancel is atomic: a lock held past busy_timeout, or a failure at the last step, changes nothing', () => {
  const { s, db, nx, me, sys, file } = setup();
  const x = nx.sessions.open(me, { projectId: 'p-ledger', workspaceId: 'sde', idempotencyKey: key() }).session;
  const a = job(nx, me, { sessionId: x.id }); const b = job(nx, me, { sessionId: x.id }); drive(nx, sys, b.id, PATH_TO.running);
  const snapshot = () => ({ jobs: db.prepare('SELECT id, state, cancel_requested_at FROM jobs ORDER BY id').all(),
    session: db.prepare('SELECT status, cancel_requested_at FROM agent_sessions WHERE id=?').get(x.id), activity: h.count(db, 'activity') });
  const before = snapshot();
  const other = h.openRaw(file); other.prepare('BEGIN IMMEDIATE').run(); db.pragma('busy_timeout = 50');
  try {
    assert.throws(() => nx.sessions.cancel(me, x.id), (e) => e.code === 'platform_unavailable');
  } finally { other.prepare('ROLLBACK').run(); other.close(); }
  assert.deepEqual(snapshot(), before);
  db.prepare(`CREATE TEMP TRIGGER fail_session_cancel BEFORE UPDATE OF status ON main.agent_sessions WHEN NEW.status = 'cancelled'
    BEGIN SELECT RAISE(ABORT, 'injected failure'); END`).run();
  assert.throws(() => nx.sessions.cancel(me, x.id), /injected failure/);
  assert.deepEqual(snapshot(), before);
  db.prepare('DROP TRIGGER temp.fail_session_cancel').run();
  assert.equal(nx.sessions.cancel(me, x.id).status, 'cancelled');
  assert.deepEqual([a, b].map((j) => nx.jobs.get(me, j.id).state), ['cancelled', 'cancelled']);
  s.close();
});
test('gap: session recovery is idempotent', () => {
  const { s, nx, me, sys } = setup();
  const x = nx.sessions.open(me, { projectId: 'p-ledger', workspaceId: 'sde', idempotencyKey: key() }).session;
  nx.sessions.transition(sys, x.id, 'running');
  assert.deepEqual(nx.sessions.recoverAfterRestart(sys), { interrupted: 1 });
  assert.deepEqual(nx.sessions.recoverAfterRestart(sys), { interrupted: 0 });
  assert.equal(nx.sessions.get(me, x.id).status, 'interrupted');
  s.close();
});
test('gap: workspace grants are isolated for get, listBySession and jobsOf', () => {
  const { s, db, nx, me } = setup();
  nx.workspaces.attach(me, 'p-ledger', 'qa');
  const qa = addUser(db, 'user:qa', 'workspace', 'qa');
  const sdeSession = nx.sessions.open(me, { projectId: 'p-ledger', workspaceId: 'sde', idempotencyKey: key() }).session;
  const sdeJob = job(nx, me, { sessionId: sdeSession.id });
  const qaSession = nx.sessions.open(qa, { projectId: 'p-ledger', workspaceId: 'qa', idempotencyKey: key() }).session;
  const qaJob = nx.jobs.create(qa, { kind: 'tool.run', projectId: 'p-ledger', workspaceId: 'qa', sessionId: qaSession.id, idempotencyKey: key() }).job;
  const d = denied(db);
  assert.throws(() => nx.jobs.get(qa, sdeJob.id), (e) => e.code === 'denied');
  assert.throws(() => nx.jobs.listBySession(qa, sdeSession.id), (e) => e.code === 'denied');
  assert.throws(() => nx.sessions.jobsOf(qa, sdeSession.id), (e) => e.code === 'denied');
  assert.throws(() => nx.sessions.get(qa, sdeSession.id), (e) => e.code === 'denied');
  assert.equal(denied(db), d + 4);
  assert.equal(nx.jobs.get(qa, qaJob.id).id, qaJob.id);
  assert.deepEqual(nx.jobs.listBySession(qa, qaSession.id).map((j) => j.id), [qaJob.id]);
  assert.deepEqual(nx.sessions.jobsOf(qa, qaSession.id).map((j) => j.id), [qaJob.id]);
  // A withdrawn participation no longer lends its workspace grant.
  nx.jobs.requestCancel(qa, qaJob.id); nx.sessions.cancel(qa, qaSession.id);
  nx.workspaces.withdraw(me, nx.workspaces.participations(me, 'p-ledger').find((p) => p.workspaceId === 'qa').id);
  assert.throws(() => nx.jobs.get(qa, qaJob.id), (e) => e.code === 'denied');
  s.close();
});

// ---------- fix round 2 ----------
const PEM = `-----BEGIN RSA PRIVATE KEY-----\n${'MIIEpAIBAAKCAQEA7bq'.repeat(80)}\n-----END RSA PRIVATE KEY-----`;
const KEY_BODY = /MIIEpAIBAAKCAQEA7bq/;
test('N1: a private key straddling the 4096-character cut is redacted (job and session errors)', () => {
  const { s, db, nx, me, sys } = setup();
  const message = `${'x'.repeat(3000)} ${PEM} after`;
  assert.ok(message.indexOf('-----END') > 4096 && message.indexOf('-----BEGIN') < 4096);
  const j = job(nx, me); drive(nx, sys, j.id, PATH_TO.running);
  const f = nx.jobs.transition(sys, j.id, 'failed', { error: { code: 'runtime_error', message } });
  assert.doesNotMatch(f.error.message, KEY_BODY); assert.match(f.error.message, /\[redacted\]/);
  assert.ok(f.error.message.length <= 4096);
  const x = nx.sessions.open(me, { projectId: 'p-ledger', workspaceId: 'sde', idempotencyKey: key() }).session;
  nx.sessions.transition(sys, x.id, 'running');
  const sf = nx.sessions.transition(sys, x.id, 'failed', { error: { code: 'runtime_error', message } });
  assert.doesNotMatch(sf.error.message, KEY_BODY);
  assert.doesNotMatch(JSON.stringify(db.prepare('SELECT error_json FROM jobs UNION ALL SELECT error_json FROM agent_sessions').all()), KEY_BODY);
  s.close();
});
test('N1: an unterminated private key in an error is redacted to the end; an over-long message is bounded first', () => {
  const { s, nx, me, sys } = setup();
  const j = job(nx, me); drive(nx, sys, j.id, PATH_TO.running);
  const f = nx.jobs.transition(sys, j.id, 'failed', { error: { code: 'runtime_error',
    message: `boom -----BEGIN PRIVATE KEY-----\n${'MIIEpAIBAAKCAQEA7bq'.repeat(10)}` } });
  assert.equal(f.error.message, 'boom [redacted]');
  const k = job(nx, me); drive(nx, sys, k.id, PATH_TO.running);
  const g = nx.jobs.transition(sys, k.id, 'failed', { error: { code: 'runtime_error', message: `${'y'.repeat(65000)}-----BEGIN EC PRIVATE KEY-----\n${'Q'.repeat(2000)}\n-----END EC PRIVATE KEY-----` } });
  assert.equal(g.error.message.length, 4096); assert.match(g.error.message, /^y+$/);
  s.close();
});
test('N2: params holding a private key, terminated or not, are refused', () => {
  const { s, nx, me } = setup();
  for (const pem of [PEM, '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA']) {
    assert.throws(() => job(nx, me, { params: { note: pem } }), (e) => e.code === 'invalid' && e.detail.reason === 'secret_in_params');
  }
  s.close();
});
test('N3: a caller who cannot read an input version is denied before learning its status', () => {
  const { s, db, nx, me } = setup();
  nx.workspaces.attach(me, 'p-ledger', 'qa');
  const qa = addUser(db, 'user:qa', 'workspace', 'qa');
  const sdeArt = nx.artifacts.create(me, { projectId: 'p-ledger', workspaceId: 'sde', kind: 'report', name: 'sde-draft' });
  const sdeDraft = nx.artifacts.registerVersion(me, { artifactId: sdeArt.id, storage: { kind: 'inline', json: { d: 1 } } }).version;
  const qaArt = nx.artifacts.create(qa, { projectId: 'p-ledger', workspaceId: 'qa', kind: 'report', name: 'qa-out' });
  const d = denied(db);
  assert.throws(() => nx.artifacts.registerVersion(qa, { artifactId: qaArt.id, storage: { kind: 'inline', json: {} },
    inputs: [{ versionId: sdeDraft.id, role: 'source' }] }), (e) => e.code === 'denied');
  assert.equal(denied(db), d + 1);
  assert.throws(() => nx.artifacts.registerVersion(me, { artifactId: qaArt.id, storage: { kind: 'inline', json: {} },
    inputs: [{ versionId: sdeDraft.id, role: 'source' }] }), (e) => e.code === 'invalid');   // a reader still gets the draft rule
  s.close();
});
