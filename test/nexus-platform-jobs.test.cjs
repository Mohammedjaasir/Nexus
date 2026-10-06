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
test('params are exact JSON, stored redacted; the activity row carries no params', () => {
  const { s, db, nx, me } = setup();
  assert.throws(() => job(nx, me, { params: { n: NaN } }), (e) => e.code === 'invalid');
  assert.throws(() => job(nx, me, { params: [1] }), (e) => e.code === 'invalid');
  const j = job(nx, me, { params: { apiKey: 'sk-ant-abcdefghijklmnopqrstuv', path: 'src/a.ts' } });
  assert.deepEqual(j.params, { apiKey: '[redacted]', path: 'src/a.ts' });
  assert.doesNotMatch(db.prepare('SELECT params_json FROM jobs WHERE id=?').get(j.id).params_json, /sk-ant/);
  assert.doesNotMatch(JSON.stringify(nx.activity.list(me, { jobId: j.id })), /src\/a\.ts|sk-ant/);
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
