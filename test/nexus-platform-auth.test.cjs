'use strict';
const h = require('./helpers/sqlite.cjs');
if (!h.realSqliteOrSkip()) return;
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');
const { PersistStore } = loadTs('src/main/db.ts');
const { createNexusPlatform } = loadTs('src/main/nexus/platform.ts');
function setup() {
  const { file } = h.v6Fixture(); const s = new PersistStore(file);
  s.open({ log: () => {}, backupDir: path.join(path.dirname(file), 'b'), now: () => h.NOW });
  const db = s.platformDatabase(); return { s, db, nx: createNexusPlatform(db, { now: () => h.NOW }) };
}
const proj = (projectId) => ({ type: 'project', projectId });

test('the seeded local owner is authorized; identity comes from main', () => {
  const { s, nx } = setup(); const me = nx.principals.localUser();
  assert.deepEqual(me, { id: 'user:local', kind: 'user', displayName: 'Local owner' });
  assert.equal(nx.auth.require(me, 'artifact.create', proj('p-ledger')), 'owner');
  s.close();
});
test('an unknown principal is denied and the denial is audited in its own transaction', () => {
  const { s, db, nx } = setup();
  assert.throws(() => nx.auth.require({ id: 'user:guest', kind: 'user', displayName: 'guest' }, 'artifact.create', proj('p-ledger')),
    (e) => e.code === 'denied');
  const row = db.prepare("SELECT * FROM activity WHERE status='denied' ORDER BY seq DESC").get();
  assert.equal(row.actor_id, 'user:guest'); assert.equal(row.action, 'artifact.create'); assert.equal(row.project_id, 'p-ledger');
  assert.match(row.details_json, /unknown_principal/);
  s.close();
});
test('project-scoped membership narrows a non-owner; nothing leaks across projects', () => {
  const { s, db, nx } = setup();
  db.prepare("INSERT INTO principals VALUES ('user:guest','user','guest',NULL,?)").run(h.NOW);
  db.prepare("INSERT INTO memberships VALUES ('user:guest','project','p-ledger','viewer',?)").run(h.NOW);
  const guest = nx.principals.get('user:guest');
  assert.equal(nx.auth.authorize(guest, 'artifact.read', proj('p-ledger')).allowed, true);
  assert.equal(nx.auth.authorize(guest, 'artifact.create', proj('p-ledger')).reason, 'role');
  assert.equal(nx.auth.authorize(guest, 'artifact.read', proj('p-invoice')).reason, 'no_membership');
  s.close();
});
test('a disabled principal is denied', () => {
  const { s, db, nx } = setup();
  db.prepare("UPDATE principals SET disabled_at=? WHERE id='user:local'").run(h.NOW);
  assert.equal(nx.auth.authorize(nx.principals.localUser(), 'artifact.read', proj('p-ledger')).reason, 'disabled_principal');
  s.close();
});
test('activity reads are authorized, newest first, by project and by job', () => {
  const { s, nx } = setup(); const me = nx.principals.localUser();
  const rows = nx.activity.list(me, { limit: 10 });
  assert.equal(rows[0].action, 'db.migrated');
  assert.deepEqual(nx.activity.list(me, { projectId: 'p-none' }), []);
  assert.deepEqual(nx.activity.verifyChain(me), { ok: true, rows: rows.length });
  s.close();
});

// ----- additional coverage: scopes, agents, identity, denial audit, activity reads -----
const ws = (workspaceId) => ({ type: 'workspace', workspaceId });
const deniedRows = (db) => db.prepare("SELECT * FROM activity WHERE status='denied' ORDER BY seq").all();
function addPrincipal(db, id, kind = 'user') { db.prepare('INSERT INTO principals VALUES (?,?,?,NULL,?)').run(id, kind, id, h.NOW); }
function addMembership(db, id, type, scopeId, role) { db.prepare('INSERT INTO memberships VALUES (?,?,?,?,?)').run(id, type, scopeId, role, h.NOW); }

test('scope matching: platform rows apply everywhere; workspace rows apply to that workspace and to projects actively participating in it', () => {
  const { s, db, nx } = setup();
  addPrincipal(db, 'user:guest');
  addMembership(db, 'user:guest', 'workspace', 'sde', 'member');
  addMembership(db, 'user:guest', 'project', 'p-ledger', 'viewer');
  assert.deepEqual(nx.auth.rolesFor('user:local', { type: 'platform' }), ['owner']);
  assert.deepEqual(nx.auth.rolesFor('user:local', proj('p-ledger')), ['owner']);
  assert.deepEqual(nx.auth.rolesFor('user:guest', { type: 'platform' }), []);
  assert.deepEqual(nx.auth.rolesFor('user:guest', ws('sde')), ['member']);
  assert.deepEqual(nx.auth.rolesFor('user:guest', ws('ml')), []);
  assert.deepEqual(nx.auth.rolesFor('user:guest', proj('p-ledger')), ['viewer']);
  assert.deepEqual(nx.auth.rolesFor('user:guest', { type: 'project', projectId: 'p-ledger', workspaceId: 'sde' }).sort(), ['member', 'viewer']);
  assert.deepEqual(nx.auth.rolesFor('user:guest', { type: 'project', projectId: 'p-invoice', workspaceId: 'sde' }), []);
  const guest = nx.principals.get('user:guest');
  assert.equal(nx.auth.authorize(guest, 'job.create', ws('sde')).allowed, true);
  assert.deepEqual(nx.auth.authorize(guest, 'job.create', ws('ml')), { allowed: false, reason: 'no_membership' });
  assert.equal(nx.auth.authorize(guest, 'job.create', { type: 'project', projectId: 'p-ledger', workspaceId: 'sde' }).allowed, true);
  assert.deepEqual(nx.auth.authorize(guest, 'job.create', proj('p-ledger')), { allowed: false, reason: 'role', needed: 'member' });
  assert.deepEqual(nx.auth.authorize(guest, 'activity.read', { type: 'platform' }), { allowed: false, reason: 'no_membership' });
  assert.equal(nx.auth.authorize(nx.principals.localUser(), 'artifact.archive', ws('sde')).allowed, true);
  assert.deepEqual(nx.auth.authorize(nx.principals.localUser(), 'artifact.read', { type: 'galaxy' }), { allowed: false, reason: 'no_membership' });
  s.close();
});
test('a role-denied action throws denied and writes exactly one redacted denied row with reason and needed', () => {
  const { s, db, nx } = setup();
  addPrincipal(db, 'user:guest');
  addMembership(db, 'user:guest', 'project', 'p-ledger', 'viewer');
  const before = deniedRows(db).length;
  assert.throws(() => nx.auth.require(nx.principals.get('user:guest'), 'artifact.create', { type: 'project', projectId: 'p-ledger', workspaceId: 'sde' },
    { entityType: 'artifact', entityId: 'a-1', details: { name: 'model card', apiKey: 'sk-should-not-appear' } }),
  (e) => e.code === 'denied' && e.name === 'PlatformError');
  const rows = deniedRows(db); assert.equal(rows.length, before + 1);
  const row = rows[rows.length - 1];
  assert.equal(row.actor_kind, 'user'); assert.equal(row.actor_id, 'user:guest');
  assert.equal(row.project_id, 'p-ledger'); assert.equal(row.workspace_id, 'sde');
  assert.equal(row.entity_type, 'artifact'); assert.equal(row.entity_id, 'a-1'); assert.equal(row.ts, h.NOW);
  const details = JSON.parse(row.details_json);
  assert.equal(details.reason, 'role'); assert.equal(details.needed, 'member');
  assert.doesNotMatch(row.details_json, /sk-should-not-appear/);
  assert.equal(nx.activity.verifyChain(nx.principals.localUser()).ok, true);
  s.close();
});
test('the audit hint cannot rewrite the actor, action, status or reason of a denial', () => {
  const { s, db, nx } = setup();
  assert.throws(() => nx.auth.require({ id: 'user:guest', kind: 'user', displayName: 'guest' }, 'job.create', proj('p-ledger'),
    { actorId: 'user:local', actorKind: 'system', action: 'job.read', status: 'succeeded', details: { reason: 'fine' } }), (e) => e.code === 'denied');
  const row = deniedRows(db).pop();
  assert.equal(row.actor_id, 'user:guest'); assert.equal(row.actor_kind, 'user'); assert.equal(row.action, 'job.create'); assert.equal(row.status, 'denied');
  assert.equal(JSON.parse(row.details_json).reason, 'unknown_principal');
  s.close();
});
test('agent principals are denied, even with an owner membership, and the denial is audited', () => {
  const { s, db, nx } = setup();
  addPrincipal(db, 'agent:j1', 'agent');
  addMembership(db, 'agent:j1', 'platform', '*', 'owner');
  const agent = nx.principals.get('agent:j1');
  assert.equal(agent.kind, 'agent');
  assert.deepEqual(nx.auth.authorize(agent, 'artifact.read', proj('p-ledger')), { allowed: false, reason: 'agent_requires_token' });
  assert.throws(() => nx.auth.require(agent, 'artifact.read', proj('p-ledger')), (e) => e.code === 'denied');
  const row = deniedRows(db).pop();
  assert.equal(row.actor_kind, 'agent'); assert.equal(row.actor_id, 'agent:j1');
  assert.match(row.details_json, /agent_requires_token/);
  s.close();
});
test('identity comes from the database: a caller cannot claim another kind for a known id', () => {
  const { s, db, nx } = setup();
  const forged = { id: 'user:local', kind: 'system', displayName: 'Local owner' };
  assert.deepEqual(nx.auth.authorize(forged, 'system.reconcile', { type: 'platform' }), { allowed: false, reason: 'unknown_principal' });
  assert.throws(() => nx.auth.require(forged, 'system.reconcile', { type: 'platform' }), (e) => e.code === 'denied' && e.detail.audited === true);
  const forgedRow = deniedRows(db).pop();
  assert.equal(forgedRow.actor_kind, 'user'); assert.equal(forgedRow.actor_id, 'user:local'); assert.equal(forgedRow.action, 'system.reconcile');
  const forgedDetails = JSON.parse(forgedRow.details_json);
  assert.equal(forgedDetails.reason, 'unknown_principal'); assert.equal(forgedDetails.claimedKind, 'system');
  assert.deepEqual(nx.auth.authorize(nx.principals.localUser(), 'system.reconcile', { type: 'platform' }), { allowed: false, reason: 'system_only' });
  assert.equal(nx.auth.require(nx.principals.system(), 'system.reconcile', { type: 'platform' }), 'system');
  assert.equal(nx.auth.require(nx.principals.system(), 'artifact.archive', proj('p-ledger')), 'admin');
  assert.deepEqual(nx.principals.system(), { id: 'system', kind: 'system', displayName: 'Nexus platform' });
  assert.equal(nx.principals.get('user:nobody'), null);
  assert.equal(nx.principals.get('user:local').disabledAt, null);
  s.close();
});
test('an allowed require writes no activity row', () => {
  const { s, db, nx } = setup(); const n = h.count(db, 'activity');
  assert.equal(nx.auth.require(nx.principals.localUser(), 'activity.read', { type: 'platform' }), 'owner');
  assert.equal(h.count(db, 'activity'), n);
  s.close();
});
test('activity list filters by project, session and job, pages by seq, caps the limit, and audits a denied read', () => {
  const { s, db, nx } = setup(); const me = nx.principals.localUser();
  const { appendActivityRow } = loadTs('src/main/nexus/activity/writer.ts');
  const base = { actorKind: 'user', actorId: 'user:local', entityType: 'artifact', action: 'artifact.create', status: 'succeeded' };
  for (let i = 0; i < 5; i++) appendActivityRow(db, { ...base, projectId: 'p-ledger', sessionId: i < 2 ? 's-1' : null, jobId: i === 4 ? 'j-1' : null }, h.NOW + i);
  appendActivityRow(db, { ...base, projectId: 'p-invoice' }, h.NOW + 9);
  const ledger = nx.activity.list(me, { projectId: 'p-ledger' });
  assert.equal(ledger.length, 5); assert.ok(ledger.every((r) => r.projectId === 'p-ledger'));
  assert.ok(ledger[0].seq > ledger[1].seq);
  assert.equal(nx.activity.list(me, { sessionId: 's-1' }).length, 2);
  assert.equal(nx.activity.list(me, { jobId: 'j-1' }).length, 1);
  assert.equal(nx.activity.list(me, { projectId: 'p-invoice', sessionId: 's-1' }).length, 0);
  const page = nx.activity.list(me, { projectId: 'p-ledger', beforeSeq: ledger[1].seq, limit: 2 });
  assert.deepEqual(page.map((r) => r.seq), [ledger[2].seq, ledger[3].seq]);
  for (let i = 0; i < 210; i++) appendActivityRow(db, { ...base, projectId: 'p-bulk' }, h.NOW + 100 + i);
  assert.equal(nx.activity.list(me, { projectId: 'p-bulk', limit: 1000 }).length, 200);
  assert.equal(nx.activity.list(me, { projectId: 'p-bulk', limit: 0 }).length, 1);
  addPrincipal(db, 'user:guest');
  addMembership(db, 'user:guest', 'project', 'p-ledger', 'viewer');
  const guest = nx.principals.get('user:guest');
  assert.equal(nx.activity.list(guest, { projectId: 'p-ledger' }).length, 5);
  assert.throws(() => nx.activity.list(guest, {}), (e) => e.code === 'denied');
  assert.throws(() => nx.activity.verifyChain(guest), (e) => e.code === 'denied');
  const row = deniedRows(db).pop(); assert.equal(row.action, 'activity.read'); assert.equal(row.actor_id, 'user:guest');
  assert.equal(nx.activity.verifyChain(me).ok, true);
  s.close();
});
test('startup confirms the seeded principals and is repeatable', () => {
  const { s, nx } = setup();
  nx.startup(); nx.startup();
  s.close();
});

// ----- fix round 1 -----
test('a workspace grant reaches a project only while the project actively participates in that workspace', () => {
  const { s, db, nx } = setup();
  addPrincipal(db, 'user:ws-admin');
  addMembership(db, 'user:ws-admin', 'workspace', 'sde', 'admin');
  const admin = nx.principals.get('user:ws-admin');
  // active participation (p-ledger is backfilled into sde): allowed
  assert.deepEqual(nx.auth.authorize(admin, 'artifact.archive', { type: 'project', projectId: 'p-ledger', workspaceId: 'sde' }), { allowed: true, role: 'admin' });
  // not participating (p-invoice is in dl only): the workspace grant does not apply
  assert.deepEqual(nx.auth.authorize(admin, 'artifact.read', { type: 'project', projectId: 'p-invoice', workspaceId: 'sde' }), { allowed: false, reason: 'no_membership' });
  assert.throws(() => nx.auth.require(admin, 'artifact.read', { type: 'project', projectId: 'p-invoice', workspaceId: 'sde' }), (e) => e.code === 'denied');
  // withdrawn participation: denied again
  db.prepare("UPDATE project_workspaces SET status='withdrawn', is_primary=0 WHERE project_id='p-ledger' AND workspace_id='sde'").run();
  assert.deepEqual(nx.auth.authorize(admin, 'artifact.read', { type: 'project', projectId: 'p-ledger', workspaceId: 'sde' }), { allowed: false, reason: 'no_membership' });
  // a project row still applies on its own
  addMembership(db, 'user:ws-admin', 'project', 'p-ledger', 'viewer');
  assert.deepEqual(nx.auth.authorize(admin, 'artifact.archive', { type: 'project', projectId: 'p-ledger', workspaceId: 'sde' }), { allowed: false, reason: 'role', needed: 'admin' });
  s.close();
});
test('a denial inside a caller transaction is audited after that transaction rolls back, exactly once', async () => {
  const lines = [];
  const { s, db } = setup();
  const nx = createNexusPlatform(db, { now: () => h.NOW, log: (l) => lines.push(l) });
  const action = 'job.cancel';
  const before = db.prepare("SELECT COUNT(*) AS n FROM activity WHERE status='denied' AND action=?").get(action).n;
  let err = null;
  assert.throws(() => db.transaction(() => {
    try { nx.auth.require({ id: 'user:guest', kind: 'user', displayName: 'guest' }, action, proj('p-ledger')); } catch (e) { err = e; }
    throw new Error('caller rolls back');
  }).immediate(), /caller rolls back/);
  assert.equal(err.code, 'denied'); assert.equal(err.detail.audited, 'deferred');
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM activity WHERE status='denied' AND action=?").get(action).n, before);
  await new Promise((r) => setImmediate(r));
  const rows = db.prepare("SELECT * FROM activity WHERE status='denied' AND action=?").all(action);
  assert.equal(rows.length, before + 1);
  assert.equal(rows[rows.length - 1].actor_id, 'user:guest'); assert.match(rows[rows.length - 1].details_json, /unknown_principal/);
  assert.ok(lines.some((l) => /deferred/.test(l) && !/user:guest/.test(l)));
  assert.equal(nx.activity.verifyChain(nx.principals.localUser()).ok, true);
  s.close();
});
test('audit id fields from the hint and the caller id are truncated to 128 characters', () => {
  const { s, db, nx } = setup();
  const long = 'x'.repeat(5000);
  assert.throws(() => nx.auth.require({ id: `user:${long}`, kind: 'user', displayName: 'guest' }, 'job.create', proj('p-ledger'),
    { onBehalfOf: long, sessionId: long, jobId: long, entityId: long }), (e) => e.code === 'denied' && e.detail.audited === true);
  const row = deniedRows(db).pop();
  for (const c of ['actor_id', 'on_behalf_of', 'session_id', 'job_id', 'entity_id']) assert.equal(row[c].length, 128, c);
  assert.ok(row.actor_id.startsWith('user:x'));
  s.close();
});
test('when the audit insert fails the denial still throws, with audited false', () => {
  const { s, db, nx } = setup();
  const n = h.count(db, 'activity');
  db.exec("CREATE TEMP TRIGGER t_fail_activity BEFORE INSERT ON main.activity BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END;");
  assert.throws(() => nx.auth.require({ id: 'user:guest', kind: 'user', displayName: 'guest' }, 'job.create', proj('p-ledger')),
    (e) => e.code === 'denied' && e.detail.audited === false);
  db.exec('DROP TRIGGER temp.t_fail_activity');
  assert.equal(h.count(db, 'activity'), n);
  s.close();
});
