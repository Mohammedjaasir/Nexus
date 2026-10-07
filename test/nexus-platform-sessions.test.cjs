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
let k = 0; const key = () => `session-intent-${++k}`;
const open = (nx, me, extra = {}) => nx.sessions.open(me, { projectId: 'p-ledger', workspaceId: 'sde', idempotencyKey: key(), ...extra }).session;
const candidate = (nx, me, sys, projectId = 'p-ledger', workspaceId = 'sde') => {
  const a = nx.artifacts.create(me, { projectId, workspaceId, kind: 'report', name: `ctx-${Math.random()}` });
  const v = nx.artifacts.registerVersion(me, { artifactId: a.id, storage: { kind: 'inline', json: { a: a.id } } }).version;
  nx.artifacts.finalize(sys, v.id, 'candidate'); return v;
};
const PATH_TO = { open: [], running: ['running'], awaiting_approval: ['running', 'awaiting_approval'] };

test('open: own row, starts open, principal and participation resolved in main, idempotent', () => {
  const { s, db, nx, me } = setup();
  const a = nx.sessions.open(me, { projectId: 'p-ledger', workspaceId: 'sde', idempotencyKey: 'same', runtime: { kind: 'claude-cli' } });
  const b = nx.sessions.open(me, { projectId: 'p-ledger', workspaceId: 'sde', idempotencyKey: 'same' });
  assert.equal(a.created, true); assert.equal(b.created, false); assert.equal(a.session.id, b.session.id);
  assert.equal(a.session.status, 'open'); assert.equal(a.session.principalId, 'user:local'); assert.equal(a.session.runtimeKind, 'claude-cli');
  assert.equal(a.session.participationId, nx.workspaces.primaryOf(me, 'p-ledger').id);
  assert.equal(a.session.contextVersionId, null);
  assert.equal(h.count(db, 'agent_sessions'), 1); assert.equal(h.count(db, 'jobs'), 0);
  assert.throws(() => open(nx, me, { workspaceId: 'qa' }), (e) => e.code === 'not_participating');
  s.close();
});
test('a withdrawn participation cannot open sessions (service and database)', () => {
  const { s, db, nx, me } = setup();
  const qa = nx.workspaces.attach(me, 'p-ledger', 'qa'); nx.workspaces.withdraw(me, qa.id);
  assert.throws(() => open(nx, me, { workspaceId: 'qa' }), (e) => e.code === 'participation_inactive');
  assert.throws(() => db.prepare(`INSERT INTO agent_sessions (id,project_id,workspace_id,participation_id,principal_id,idempotency_key,created_at,updated_at,status_changed_at)
    VALUES ('sx','p-ledger','qa',?,'user:local','kx',1,1,1)`).run(qa.id), /session participation/);
  s.close();
});
test('artifact context: nullable, must be a candidate/active version of the same project', () => {
  const { s, db, nx, me, sys } = setup();
  const a = nx.artifacts.create(me, { projectId: 'p-ledger', workspaceId: 'sde', kind: 'report', name: 'draft-ctx' });
  const draft = nx.artifacts.registerVersion(me, { artifactId: a.id, storage: { kind: 'inline', json: {} } }).version;
  assert.throws(() => open(nx, me, { contextVersionId: draft.id }), (e) => e.code === 'invalid');
  const other = candidate(nx, me, sys, 'p-invoice', 'dl');
  assert.throws(() => open(nx, me, { contextVersionId: other.id }), (e) => e.code === 'invalid');
  const pw = nx.workspaces.primaryOf(me, 'p-ledger').id;
  assert.throws(() => db.prepare(`INSERT INTO agent_sessions (id,project_id,workspace_id,participation_id,context_version_id,principal_id,idempotency_key,created_at,updated_at,status_changed_at)
    VALUES ('sy','p-ledger','sde',?,?,'user:local','ky',1,1,1)`).run(pw, other.id), /session context/);
  const ok = candidate(nx, me, sys);
  assert.equal(open(nx, me, { contextVersionId: ok.id }).contextVersionId, ok.id);
  s.close();
});
test('every pair of session states: legal transitions persist, illegal ones are refused by service and database', () => {
  const { s, db, nx, me, sys } = setup();
  const states = seed.V7_SESSION_STATES.map((x) => x.state);
  const legal = new Set(seed.V7_SESSION_TRANSITIONS.map(([a, b]) => `${a}>${b}`));
  for (const from of Object.keys(PATH_TO)) for (const to of states) {
    if (from === to) continue;
    const x = open(nx, me); PATH_TO[from].forEach((st) => nx.sessions.transition(sys, x.id, st));
    if (legal.has(`${from}>${to}`)) assert.equal(nx.sessions.transition(sys, x.id, to).status, to, `${from}>${to}`);
    else {
      assert.throws(() => nx.sessions.transition(sys, x.id, to), (e) => e.code === 'illegal_transition', `${from}>${to}`);
      assert.throws(() => db.prepare('UPDATE agent_sessions SET status=? WHERE id=?').run(to, x.id), /illegal session state transition/, `${from}>${to} db`);
    }
  }
  s.close();
});
test('terminal states set ended_at and are final; users cannot drive status', () => {
  const { s, nx, me, sys } = setup();
  for (const t of ['completed', 'failed', 'cancelled', 'timed_out', 'interrupted']) {
    const x = open(nx, me); nx.sessions.transition(sys, x.id, 'running'); nx.sessions.transition(sys, x.id, t);
    assert.ok(nx.sessions.get(me, x.id).endedAt, t);
    assert.throws(() => nx.sessions.transition(sys, x.id, 'running'), (e) => e.code === 'illegal_transition', t);
  }
  assert.throws(() => nx.sessions.transition(me, open(nx, me).id, 'running'), (e) => e.code === 'denied');
  s.close();
});
test('jobs link to their session; agent.run jobs need a live session in the same project and workspace', () => {
  const { s, db, nx, me, sys } = setup();
  const x = open(nx, me);
  const j = nx.jobs.create(me, { kind: 'agent.run', projectId: 'p-ledger', workspaceId: 'sde', sessionId: x.id, idempotencyKey: key() }).job;
  assert.equal(j.sessionId, x.id);
  assert.deepEqual(nx.sessions.jobsOf(me, x.id).map((r) => r.id), [j.id]);
  nx.workspaces.attach(me, 'p-ledger', 'qa');
  assert.throws(() => nx.jobs.create(me, { kind: 'agent.run', projectId: 'p-ledger', workspaceId: 'qa', sessionId: x.id, idempotencyKey: key() }), (e) => e.code === 'invalid');
  const qaPw = nx.workspaces.participations(me, 'p-ledger').find((p) => p.workspaceId === 'qa').id;
  assert.throws(() => db.prepare(`INSERT INTO jobs (id,kind,project_id,workspace_id,participation_id,session_id,idempotency_key,requested_by,on_behalf_of,created_at,updated_at,state_changed_at)
    VALUES ('jq','agent.run','p-ledger','qa',?,?,'kq','user:local','user:local',1,1,1)`).run(qaPw, x.id), /job session must belong/);
  const done = open(nx, me); nx.sessions.transition(sys, done.id, 'running'); nx.sessions.transition(sys, done.id, 'completed');
  assert.throws(() => nx.jobs.create(me, { kind: 'agent.run', projectId: 'p-ledger', workspaceId: 'sde', sessionId: done.id, idempotencyKey: key() }), (e) => e.code === 'conflict');   // ended session: 'conflict' everywhere
  s.close();
});
test('cancel records who and when, cancels live jobs of the session first, and leaves finished jobs alone', () => {
  const { s, nx, me, sys } = setup();
  const x = open(nx, me); nx.sessions.transition(sys, x.id, 'running');
  const live = nx.jobs.create(me, { kind: 'agent.run', projectId: 'p-ledger', workspaceId: 'sde', sessionId: x.id, idempotencyKey: key() }).job;
  const done = nx.jobs.create(me, { kind: 'tool.run', projectId: 'p-ledger', workspaceId: 'sde', sessionId: x.id, idempotencyKey: key() }).job;
  ['leased', 'running', 'completed'].forEach((st) => nx.jobs.transition(sys, done.id, st));
  const c = nx.sessions.cancel(me, x.id);
  assert.equal(c.status, 'cancelled'); assert.equal(c.cancelRequestedBy, 'user:local'); assert.ok(c.cancelRequestedAt && c.endedAt);
  assert.equal(nx.jobs.get(me, live.id).state, 'cancelled');
  assert.equal(nx.jobs.get(me, done.id).state, 'completed');
  assert.equal(nx.sessions.cancel(me, x.id).status, 'cancelled');                       // idempotent on a terminal session
  s.close();
});
test('a version records the session that produced it; a session from another project is refused', () => {
  const { s, db, nx, me } = setup();
  const x = open(nx, me);
  const a = nx.artifacts.create(me, { projectId: 'p-ledger', workspaceId: 'sde', kind: 'report', name: 'by-session' });
  const v = nx.artifacts.registerVersion(me, { artifactId: a.id, storage: { kind: 'inline', json: {} }, producedBySessionId: x.id }).version;
  assert.equal(v.producedBySessionId, x.id);
  const y = nx.sessions.open(me, { projectId: 'p-invoice', workspaceId: 'dl', idempotencyKey: key() }).session;
  assert.throws(() => nx.artifacts.registerVersion(me, { artifactId: a.id, storage: { kind: 'inline', json: { n: 2 } }, producedBySessionId: y.id }), (e) => e.code === 'invalid');
  const row = db.prepare('SELECT * FROM artifact_versions WHERE id=?').get(v.id);
  assert.throws(() => db.prepare(`INSERT INTO artifact_versions (id,artifact_id,version_no,project_id,participation_id,status,storage_kind,storage_ref_json,
    content_hash,actor_id,on_behalf_of,created_at,status_changed_at,produced_by_session_id) VALUES ('vz',?,9,'p-ledger',?,'draft','inline','{}','h','user:local','user:local',1,1,?)`)
    .run(a.id, row.participation_id, y.id), /another project/);
  s.close();
});
test('activity is queryable by session and carries the session id', () => {
  const { s, nx, me, sys } = setup();
  const x = open(nx, me); nx.sessions.transition(sys, x.id, 'running'); nx.sessions.cancel(me, x.id);
  const rows = nx.activity.list(me, { sessionId: x.id });
  assert.deepEqual(rows.map((r) => r.action).reverse(), ['session.open', 'session.transition', 'session.cancel']);
  assert.ok(rows.every((r) => r.sessionId === x.id));
  s.close();
});
test('restart recovery: running and awaiting_approval sessions become interrupted; open ones stay', () => {
  const { s, nx, me, sys, file } = setup();
  const o = open(nx, me); const r = open(nx, me); const w = open(nx, me);
  nx.sessions.transition(sys, r.id, 'running'); ['running', 'awaiting_approval'].forEach((st) => nx.sessions.transition(sys, w.id, st));
  s.close();
  const again = setup(file);
  assert.deepEqual(again.nx.sessions.recoverAfterRestart(again.sys), { interrupted: 2 });
  assert.equal(again.nx.sessions.get(again.me, o.id).status, 'open');
  assert.equal(again.nx.sessions.get(again.me, w.id).status, 'interrupted');
  again.s.close();
});
test('errors are redacted; identity is immutable; sessions are never deleted', () => {
  const { s, db, nx, me, sys } = setup();
  const x = open(nx, me); nx.sessions.transition(sys, x.id, 'running');
  const f = nx.sessions.transition(sys, x.id, 'failed', { error: { code: 'runtime_error', message: 'token=abcdefghijk rejected' } });
  assert.doesNotMatch(f.error.message, /abcdefghijk/);
  assert.throws(() => db.prepare("UPDATE agent_sessions SET principal_id='system' WHERE id=?").run(x.id), /identity is immutable/);
  assert.throws(() => db.prepare('DELETE FROM agent_sessions WHERE id=?').run(x.id), /never deleted/);
  s.close();
});
test('project and status reads use their indexes', () => {
  const { s, db } = setup();
  // Brief fix: better-sqlite3 refuses unbound parameters, so the plan queries bind values.
  const plan = (q, ...args) => db.prepare(`EXPLAIN QUERY PLAN ${q}`).all(...args).map((r) => r.detail).join(' ');
  assert.match(plan('SELECT * FROM agent_sessions WHERE project_id=? ORDER BY created_at DESC LIMIT 50', 'p-ledger'), /ix_sessions_project/);
  assert.match(plan("SELECT id FROM agent_sessions WHERE status IN ('running','awaiting_approval')"), /ix_sessions_status/);
  s.close();
});
