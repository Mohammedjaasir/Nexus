'use strict';
const h = require('./helpers/sqlite.cjs');
if (!h.realSqliteOrSkip()) return;
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');
const { PersistStore } = loadTs('src/main/db.ts');
const { createNexusPlatform } = loadTs('src/main/nexus/platform.ts');
const { __testing: lineageTesting, MAX_LINEAGE_NODES } = loadTs('src/main/nexus/lineage/lineageService.ts');
function setup() {
  const { file } = h.v6Fixture(); const s = new PersistStore(file);
  s.open({ log: () => {}, backupDir: path.join(path.dirname(file), 'b'), now: () => h.NOW });
  const db = s.platformDatabase(); const nx = createNexusPlatform(db, { now: () => h.NOW });
  const me = nx.principals.localUser(); const sys = nx.principals.system();
  const mk = (projectId = 'p-ledger', ws = 'sde') => {
    const a = nx.artifacts.create(me, { projectId, workspaceId: ws, kind: 'report', name: `r${Math.random()}` });
    const v = nx.artifacts.registerVersion(me, { artifactId: a.id, storage: { kind: 'inline', json: { a: a.id } } }).version;
    nx.artifacts.finalize(sys, v.id, 'candidate'); return v;
  };
  return { s, db, nx, me, sys, mk };
}

test('records a typed user edge and reads it both ways', () => {
  const { s, nx, me, mk } = setup(); const src = mk(); const out = mk();
  const e = nx.lineage.record(me, { fromVersionId: out.id, toVersionId: src.id, relation: 'derived_from', source: 'user_action' });
  assert.equal(e.createdBy, 'user:local');
  assert.deepEqual(nx.lineage.upstream(me, out.id).nodes.map((n) => [n.versionId, n.relation, n.depth]), [[src.id, 'derived_from', 1]]);
  assert.deepEqual(nx.lineage.downstream(me, src.id).nodes.map((n) => n.versionId), [out.id]);
  assert.equal(nx.lineage.record(me, { fromVersionId: out.id, toVersionId: src.id, relation: 'derived_from', source: 'user_action' }).id, e.id);   // idempotent
  s.close();
});
test('only the vocabulary is accepted (service and database)', () => {
  const { s, db, nx, me, mk } = setup(); const a = mk(); const b = mk();
  assert.throws(() => nx.lineage.record(me, { fromVersionId: a.id, toVersionId: b.id, relation: 'mentions', source: 'user_action' }), (e) => e.code === 'invalid');
  assert.throws(() => db.prepare(`INSERT INTO artifact_edges (id,from_version_id,to_version_id,relation,source,created_by,created_at)
    VALUES ('e','${a.id}','${b.id}','mentions','user_action','user:local',1)`).run(), /FOREIGN KEY/);
  s.close();
});
test('cycles are rejected, direct and deeper than the architecture cap of 64', () => {
  const { s, db, nx, me, mk } = setup();
  const vs = Array.from({ length: 80 }, () => mk());
  for (let i = 1; i < vs.length; i++) nx.lineage.record(me, { fromVersionId: vs[i].id, toVersionId: vs[i - 1].id, relation: 'derived_from', source: 'user_action' });
  const n = h.count(db, 'artifact_edges');
  assert.throws(() => nx.lineage.record(me, { fromVersionId: vs[0].id, toVersionId: vs[79].id, relation: 'depends_on', source: 'user_action' }), (e) => e.code === 'cycle');
  assert.throws(() => nx.lineage.record(me, { fromVersionId: vs[0].id, toVersionId: vs[1].id, relation: 'derived_from', source: 'user_action' }), (e) => e.code === 'cycle');
  assert.equal(h.count(db, 'artifact_edges'), n);
  assert.throws(() => nx.lineage.record(me, { fromVersionId: vs[0].id, toVersionId: vs[0].id, relation: 'derived_from', source: 'user_action' }), (e) => e.code === 'cycle');
  s.close();
});
test('edges never cross projects and are append-only', () => {
  const { s, db, nx, me, mk } = setup(); const a = mk('p-ledger', 'sde'); const b = mk('p-invoice', 'dl');
  assert.throws(() => db.prepare(`INSERT INTO artifact_edges (id,from_version_id,to_version_id,relation,source,created_by,created_at)
    VALUES ('e','${a.id}','${b.id}','depends_on','user_action','user:local',1)`).run(), /inside one project/);
  const c = mk(); const e = nx.lineage.record(me, { fromVersionId: c.id, toVersionId: a.id, relation: 'depends_on', source: 'user_action' });
  assert.throws(() => db.prepare("UPDATE artifact_edges SET relation='serves' WHERE id=?").run(e.id), /append-only/);
  assert.throws(() => db.prepare('DELETE FROM artifact_edges WHERE id=?').run(e.id), /append-only/);
  s.close();
});
test('job edges need the job record: the target must be a declared job input', () => {
  const { s, db, nx, me, sys, mk } = setup(); const input = mk(); const other = mk();
  const job = nx.jobs.create(me, { kind: 'tool.run', projectId: 'p-ledger', workspaceId: 'sde', idempotencyKey: 'k-lin', inputs: [{ versionId: input.id, role: 'source' }] }).job;
  const a = nx.artifacts.create(me, { projectId: 'p-ledger', workspaceId: 'sde', kind: 'report', name: 'out' });
  const out = nx.artifacts.registerVersion(me, { artifactId: a.id, storage: { kind: 'inline', json: {} }, producedByJobId: job.id, clientKey: 'c1' }).version;
  assert.equal(nx.lineage.record(sys, { fromVersionId: out.id, toVersionId: input.id, relation: 'derived_from', source: 'job_input', jobId: job.id }).source, 'job_input');
  assert.throws(() => nx.lineage.record(sys, { fromVersionId: out.id, toVersionId: other.id, relation: 'derived_from', source: 'job_input', jobId: job.id }), (e) => e.code === 'input_not_granted');
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM activity WHERE status='denied' AND action='lineage.write'").get().n, 1);
  assert.throws(() => nx.lineage.record(sys, { fromVersionId: out.id, toVersionId: other.id, relation: 'derived_from', source: 'user_action' }), (e) => e.code === 'invalid');
  s.close();
});
// T9 covers the same source rules below with job rows inserted directly.
test('registerVersion writes edges for declared inputs in the same transaction', () => {
  const { s, nx, me, mk } = setup(); const src = mk();
  const a = nx.artifacts.create(me, { projectId: 'p-ledger', workspaceId: 'sde', kind: 'report', name: 'derived' });
  const v = nx.artifacts.registerVersion(me, { artifactId: a.id, storage: { kind: 'inline', json: {} }, inputs: [{ versionId: src.id, role: 'source', relation: 'derived_from' }] }).version;
  assert.deepEqual(nx.lineage.upstream(me, v.id).nodes.map((n) => n.versionId), [src.id]);
  s.close();
});
test('lineage walks use the edge indexes', () => {
  const { s, db } = setup();
  // Brief fix: better-sqlite3 refuses unbound parameters, so the plan query binds a value.
  const plan = (q) => db.prepare(`EXPLAIN QUERY PLAN ${q}`).all('x').map((r) => r.detail).join(' ');
  assert.match(plan('SELECT * FROM artifact_edges WHERE to_version_id=?'), /ix_edges_to/);
  assert.match(plan('SELECT * FROM artifact_edges WHERE from_version_id=?'), /sqlite_autoindex_artifact_edges/);
  s.close();
});

// ---------- job and ingest sources (raw job rows; JobService arrives in T10) ----------
function insertJob(db, nx, me, id, projectId = 'p-ledger', workspaceId = 'sde') {
  const pw = nx.workspaces.primaryOf(me, projectId).id;
  db.prepare(`INSERT INTO jobs (id,kind,project_id,workspace_id,participation_id,idempotency_key,requested_by,on_behalf_of,created_at,updated_at,state_changed_at)
    VALUES (?,'tool.run',?,?,?,?,'user:local','user:local',1,1,1)`).run(id, projectId, workspaceId, pw, `key-${id}`);
}
const grant = (db, jobId, v, role = 'source') =>
  db.prepare('INSERT INTO job_inputs (job_id,version_id,role,content_hash) VALUES (?,?,?,?)').run(jobId, v.id, role, v.contentHash);
const deniedLineage = (db) => db.prepare("SELECT COUNT(*) AS n FROM activity WHERE status='denied' AND action='lineage.write'").get().n;
function jobOutput(nx, me, jobId, name = 'out') {
  const a = nx.artifacts.create(me, { projectId: 'p-ledger', workspaceId: 'sde', kind: 'report', name });
  return nx.artifacts.registerVersion(me, { artifactId: a.id, storage: { kind: 'inline', json: {} }, producedByJobId: jobId, clientKey: 'c1' }).version;
}

test('job_input edges: the target must be a declared input of the job; a refusal writes one denied row', () => {
  const { s, db, nx, me, sys, mk } = setup(); const input = mk(); const other = mk();
  insertJob(db, nx, me, 'j-lin'); grant(db, 'j-lin', input);
  const out = jobOutput(nx, me, 'j-lin');
  const e = nx.lineage.record(sys, { fromVersionId: out.id, toVersionId: input.id, relation: 'derived_from', source: 'job_input', jobId: 'j-lin' });
  assert.equal(e.source, 'job_input'); assert.equal(e.jobId, 'j-lin'); assert.equal(e.createdBy, 'system');
  const edges = h.count(db, 'artifact_edges');
  assert.throws(() => nx.lineage.record(sys, { fromVersionId: out.id, toVersionId: other.id, relation: 'derived_from', source: 'job_input', jobId: 'j-lin' }),
    (err) => err.code === 'input_not_granted');
  assert.equal(deniedLineage(db), 1);
  assert.equal(h.count(db, 'artifact_edges'), edges);
  assert.throws(() => nx.lineage.record(sys, { fromVersionId: out.id, toVersionId: other.id, relation: 'derived_from', source: 'user_action' }), (err) => err.code === 'invalid');
  assert.throws(() => nx.lineage.record(sys, { fromVersionId: out.id, toVersionId: input.id, relation: 'derived_from', source: 'job_input' }), (err) => err.code === 'invalid');
  assert.equal(deniedLineage(db), 1);
  s.close();
});
test('job_input edges: the consumer must have been produced by that job, and the job must exist in the project', () => {
  const { s, db, nx, me, sys, mk } = setup(); const input = mk(); const notByJob = mk();
  insertJob(db, nx, me, 'j-a'); grant(db, 'j-a', input);
  insertJob(db, nx, me, 'j-inv', 'p-invoice', 'dl');
  assert.throws(() => nx.lineage.record(sys, { fromVersionId: notByJob.id, toVersionId: input.id, relation: 'derived_from', source: 'job_input', jobId: 'j-a' }),
    (e) => e.code === 'invalid');
  assert.throws(() => nx.lineage.record(sys, { fromVersionId: notByJob.id, toVersionId: input.id, relation: 'derived_from', source: 'job_input', jobId: 'j-none' }),
    (e) => e.code === 'not_found');
  assert.throws(() => nx.lineage.record(sys, { fromVersionId: notByJob.id, toVersionId: input.id, relation: 'derived_from', source: 'job_input', jobId: 'j-inv' }),
    (e) => e.code === 'invalid');
  assert.equal(h.count(db, 'artifact_edges'), 0); assert.equal(deniedLineage(db), 0);
  s.close();
});
test('ingest edges need the system principal and the producing job; handoff_convert is refused', () => {
  const { s, db, nx, me, sys, mk } = setup(); const src = mk(); const other = mk();
  insertJob(db, nx, me, 'j-ing');
  const out = jobOutput(nx, me, 'j-ing');
  assert.throws(() => nx.lineage.record(me, { fromVersionId: out.id, toVersionId: src.id, relation: 'extracted_from', source: 'ingest', jobId: 'j-ing' }),
    (e) => e.code === 'denied');
  assert.equal(deniedLineage(db), 1);
  assert.throws(() => nx.lineage.record(sys, { fromVersionId: other.id, toVersionId: src.id, relation: 'extracted_from', source: 'ingest', jobId: 'j-ing' }),
    (e) => e.code === 'invalid');
  assert.throws(() => nx.lineage.record(sys, { fromVersionId: out.id, toVersionId: src.id, relation: 'extracted_from', source: 'ingest' }), (e) => e.code === 'invalid');
  const e = nx.lineage.record(sys, { fromVersionId: out.id, toVersionId: src.id, relation: 'extracted_from', source: 'ingest', jobId: 'j-ing' });
  assert.equal(e.source, 'ingest'); assert.equal(e.jobId, 'j-ing');
  assert.throws(() => nx.lineage.record(me, { fromVersionId: other.id, toVersionId: src.id, relation: 'derived_from', source: 'handoff_convert' }), (x) => x.code === 'invalid');
  assert.throws(() => nx.lineage.record(me, { fromVersionId: other.id, toVersionId: src.id, relation: 'derived_from', source: 'chat_message' }), (x) => x.code === 'invalid');
  assert.throws(() => nx.lineage.record(me, { fromVersionId: other.id, toVersionId: src.id, relation: 'derived_from', source: 'user_action', jobId: 'j-ing' }), (x) => x.code === 'invalid');
  s.close();
});
test('a re-sent edge with another source or job is a conflict; a new edge writes one activity row', () => {
  const { s, db, nx, me, sys, mk } = setup(); const input = mk();
  insertJob(db, nx, me, 'j-c'); grant(db, 'j-c', input);
  const out = jobOutput(nx, me, 'j-c');
  const before = h.count(db, 'activity');
  const e = nx.lineage.record(sys, { fromVersionId: out.id, toVersionId: input.id, relation: 'derived_from', source: 'job_input', jobId: 'j-c' });
  assert.equal(h.count(db, 'activity'), before + 1);
  const row = db.prepare("SELECT * FROM activity WHERE action='lineage.write' AND status='succeeded'").get();
  assert.equal(row.entity_id, e.id); assert.equal(row.version_id, out.id); assert.equal(row.job_id, 'j-c'); assert.equal(row.workspace_id, 'sde');
  assert.equal(nx.lineage.record(sys, { fromVersionId: out.id, toVersionId: input.id, relation: 'derived_from', source: 'job_input', jobId: 'j-c' }).id, e.id);
  assert.equal(h.count(db, 'activity'), before + 1);                                         // an identical re-send writes nothing
  assert.throws(() => nx.lineage.record(me, { fromVersionId: out.id, toVersionId: input.id, relation: 'derived_from', source: 'user_action' }),
    (x) => x.code === 'conflict');
  s.close();
});

// ---------- endpoints, authority, walks ----------
test('endpoints: both versions exist, one project, and the source is not a draft', () => {
  const { s, db, nx, me, mk } = setup(); const a = mk(); const b = mk('p-invoice', 'dl');
  assert.throws(() => nx.lineage.record(me, { fromVersionId: a.id, toVersionId: b.id, relation: 'depends_on', source: 'user_action' }), (e) => e.code === 'invalid');
  assert.throws(() => nx.lineage.record(me, { fromVersionId: a.id, toVersionId: 'nope', relation: 'depends_on', source: 'user_action' }), (e) => e.code === 'not_found');
  assert.throws(() => nx.lineage.record(me, { fromVersionId: 'nope', toVersionId: a.id, relation: 'depends_on', source: 'user_action' }), (e) => e.code === 'not_found');
  const art = nx.artifacts.create(me, { projectId: 'p-ledger', workspaceId: 'sde', kind: 'report', name: 'draft' });
  const draft = nx.artifacts.registerVersion(me, { artifactId: art.id, storage: { kind: 'inline', json: { d: 1 } } }).version;
  assert.throws(() => nx.lineage.record(me, { fromVersionId: a.id, toVersionId: draft.id, relation: 'depends_on', source: 'user_action' }), (e) => e.code === 'invalid');
  assert.equal(nx.lineage.record(me, { fromVersionId: draft.id, toVersionId: a.id, relation: 'depends_on', source: 'user_action' }).fromVersionId, draft.id);
  assert.equal(h.count(db, 'artifact_edges'), 1);
  s.close();
});
test('authority: a stranger is denied (audited) and learns nothing; a viewer reads but cannot write', () => {
  const { s, db, nx, me, mk } = setup(); const a = mk(); const b = mk();
  nx.lineage.record(me, { fromVersionId: b.id, toVersionId: a.id, relation: 'depends_on', source: 'user_action' });
  db.prepare("INSERT INTO principals VALUES ('user:guest','user','guest',NULL,?)").run(h.NOW);
  const guest = nx.principals.get('user:guest');
  assert.throws(() => nx.lineage.upstream(guest, b.id), (e) => e.code === 'denied');
  assert.throws(() => nx.lineage.upstream(guest, 'nope'), (e) => e.code === 'denied');
  assert.throws(() => nx.lineage.record(guest, { fromVersionId: a.id, toVersionId: b.id, relation: 'cites', source: 'user_action' }), (e) => e.code === 'denied');
  db.prepare("INSERT INTO memberships VALUES ('user:guest','project','p-ledger','viewer',?)").run(h.NOW);
  assert.deepEqual(nx.lineage.upstream(guest, b.id).nodes.map((n) => n.versionId), [a.id]);
  assert.throws(() => nx.lineage.record(guest, { fromVersionId: a.id, toVersionId: b.id, relation: 'cites', source: 'user_action' }), (e) => e.code === 'denied');
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM activity WHERE status='denied' AND actor_id='user:guest'").get().n, 4);
  // A forged kind is not the stored principal.
  assert.throws(() => nx.lineage.record({ id: 'system', kind: 'user', displayName: 'x' }, { fromVersionId: a.id, toVersionId: b.id, relation: 'cites', source: 'user_action' }),
    (e) => e.code === 'denied');
  s.close();
});
test('walks: depth defaults to 6 and is clamped to 1..32; a node reached twice appears once, at its minimum depth', () => {
  const { s, nx, me, mk } = setup();
  const vs = Array.from({ length: 40 }, () => mk());
  for (let i = 1; i < vs.length; i++) nx.lineage.record(me, { fromVersionId: vs[i].id, toVersionId: vs[i - 1].id, relation: 'derived_from', source: 'user_action' });
  const top = vs[39];
  assert.equal(nx.lineage.upstream(me, top.id).nodes.length, 6);
  assert.deepEqual(nx.lineage.upstream(me, top.id).nodes.map((n) => n.depth), [1, 2, 3, 4, 5, 6]);
  assert.equal(nx.lineage.upstream(me, top.id, { depth: 0 }).nodes.length, 1);
  assert.equal(nx.lineage.upstream(me, top.id, { depth: 100 }).nodes.length, 32);
  assert.equal(nx.lineage.downstream(me, vs[0].id, { depth: 3 }).nodes.map((n) => n.versionId).join(), [vs[1], vs[2], vs[3]].map((v) => v.id).join());
  assert.throws(() => nx.lineage.upstream(me, top.id, { depth: 'deep' }), (e) => e.code === 'invalid');
  assert.throws(() => nx.lineage.upstream(me, top.id, { depth: Infinity }), (e) => e.code === 'invalid');
  assert.throws(() => nx.lineage.upstream(me, top.id, { depth: [3] }), (e) => e.code === 'invalid');
  assert.equal(nx.lineage.upstream(me, top.id, { depth: 100 }).truncated, false);
  // Diamond plus a shortcut: d -> b -> a, d -> c -> a, d -> a. 'a' appears once at depth 1.
  const [a, b, c, d] = [mk(), mk(), mk(), mk()];
  const rec = (f, t, relation) => nx.lineage.record(me, { fromVersionId: f.id, toVersionId: t.id, relation, source: 'user_action' });
  rec(b, a, 'derived_from'); rec(c, a, 'cites'); rec(d, b, 'based_on'); rec(d, c, 'summarizes'); rec(d, a, 'depends_on');
  const up = nx.lineage.upstream(me, d.id).nodes;
  assert.deepEqual(up.map((n) => [n.versionId, n.depth]), [[a.id, 1], [b.id, 1], [c.id, 1]].sort((x, y) => (x[0] < y[0] ? -1 : 1)));
  assert.equal(up.find((n) => n.versionId === a.id).relation, 'depends_on');
  const down = nx.lineage.downstream(me, a.id).nodes;
  assert.deepEqual(down.map((n) => n.versionId), [b.id, c.id, d.id].sort());
  assert.ok(down.every((n) => n.depth === 1));
  assert.equal(up[0].kind, 'report'); assert.equal(up[0].status, 'candidate'); assert.equal(up[0].versionNo, 1);
  s.close();
});
test('the lineage service takes ids and a vocabulary relation only: no free-text entry point', () => {
  const { s, nx } = setup();
  const proto = Object.getPrototypeOf(nx.lineage);
  assert.deepEqual(Object.getOwnPropertyNames(proto).filter((k) => k !== 'constructor' && typeof proto[k] === 'function' && !['walk', 'loadEndpoint', 'checkJobSource'].includes(k)).sort(),
    ['downstream', 'linkSources', 'record', 'upstream']);   // B1 Task 3: linkSources takes version ids only
  s.close();
});

// ---------- fix round 1 ----------
function guestWithSdeViewer(db, nx) {
  db.prepare("INSERT INTO principals VALUES ('user:g','user','g',NULL,?)").run(h.NOW);
  db.prepare("INSERT INTO memberships VALUES ('user:g','workspace','sde','viewer',?)").run(h.NOW);
  return nx.principals.get('user:g');
}
test('fix 1: a walk drops versions from workspaces the caller cannot read, without audit rows', () => {
  const { s, db, nx, me, mk } = setup();
  nx.workspaces.attach(me, 'p-ledger', 'dl');
  const x = mk('p-ledger', 'sde'); const y = mk('p-ledger', 'dl');
  nx.lineage.record(me, { fromVersionId: x.id, toVersionId: y.id, relation: 'depends_on', source: 'user_action' });
  const g = guestWithSdeViewer(db, nx);
  const denied = db.prepare("SELECT COUNT(*) AS n FROM activity WHERE status='denied'").get().n;
  const walk = nx.lineage.upstream(g, x.id);
  assert.deepEqual(walk, { nodes: [], truncated: false });
  assert.doesNotMatch(JSON.stringify(walk), new RegExp(y.id));
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM activity WHERE status='denied'").get().n, denied);   // read-only filter
  assert.deepEqual(nx.lineage.upstream(me, x.id).nodes.map((n) => n.versionId), [y.id]);                    // the owner still sees it
  s.close();
});
test('fix 1: a readable version that lies only beyond an unreadable one is not revealed', () => {
  const { s, db, nx, me, mk } = setup();
  nx.workspaces.attach(me, 'p-ledger', 'dl');
  const x = mk('p-ledger', 'sde'); const y = mk('p-ledger', 'dl'); const z = mk('p-ledger', 'sde');
  nx.lineage.record(me, { fromVersionId: x.id, toVersionId: y.id, relation: 'depends_on', source: 'user_action' });
  nx.lineage.record(me, { fromVersionId: y.id, toVersionId: z.id, relation: 'depends_on', source: 'user_action' });
  const g = guestWithSdeViewer(db, nx);
  assert.deepEqual(nx.lineage.upstream(g, x.id).nodes, []);
  assert.deepEqual(nx.lineage.downstream(g, z.id).nodes, []);
  assert.deepEqual(nx.lineage.upstream(me, x.id).nodes.map((n) => [n.versionId, n.depth]), [[y.id, 1], [z.id, 2]]);
  // A second, readable path to z makes it visible at that path's depth.
  const w = mk('p-ledger', 'sde');
  nx.lineage.record(me, { fromVersionId: x.id, toVersionId: w.id, relation: 'depends_on', source: 'user_action' });
  nx.lineage.record(me, { fromVersionId: w.id, toVersionId: z.id, relation: 'cites', source: 'user_action' });
  assert.deepEqual(nx.lineage.upstream(g, x.id).nodes.map((n) => [n.versionId, n.depth, n.relation]), [[w.id, 1, 'depends_on'], [z.id, 2, 'cites']]);
  s.close();
});
test('fix 2: a walk stops at the node cap and reports the truncation', () => {
  const { s, nx, me, mk } = setup();
  assert.equal(MAX_LINEAGE_NODES, 5000);
  for (const bad of [0, -1, 2.5, MAX_LINEAGE_NODES + 1, Infinity, NaN, '3']) assert.throws(() => lineageTesting.withNodeCap(bad, () => 0), RangeError);
  const hub = mk(); const leaves = Array.from({ length: 5 }, () => mk());
  for (const l of leaves) nx.lineage.record(me, { fromVersionId: hub.id, toVersionId: l.id, relation: 'depends_on', source: 'user_action' });
  const sorted = leaves.map((l) => l.id).sort();
  const capped = lineageTesting.withNodeCap(3, () => nx.lineage.upstream(me, hub.id));
  assert.equal(capped.truncated, true);
  assert.deepEqual(capped.nodes.map((n) => n.versionId), sorted.slice(0, 3));
  assert.equal(lineageTesting.withNodeCap(5, () => nx.lineage.upstream(me, hub.id)).truncated, false);   // exactly at the cap: nothing dropped
  assert.deepEqual(nx.lineage.upstream(me, hub.id), { nodes: nx.lineage.upstream(me, hub.id).nodes, truncated: false });
  assert.equal(nx.lineage.upstream(me, hub.id).nodes.length, 5);
  s.close();
});
test('fix 4: an edge registerVersion writes that would close a cycle is refused and nothing is written', () => {
  const { s, db, nx, me, mk } = setup(); const src = mk();
  const a = nx.artifacts.create(me, { projectId: 'p-ledger', workspaceId: 'sde', kind: 'report', name: 'loop' });
  // A temp trigger plants src -> NEW inside registerVersion's own transaction, so its edge NEW -> src closes a cycle.
  db.exec(`CREATE TEMP TRIGGER tr_plant AFTER INSERT ON main.artifact_versions WHEN NEW.artifact_id = '${a.id}'
    BEGIN INSERT INTO artifact_edges (id,from_version_id,to_version_id,relation,source,created_by,created_at)
      VALUES ('planted','${src.id}',NEW.id,'cites','user_action','user:local',1); END`);
  const before = { v: h.count(db, 'artifact_versions'), e: h.count(db, 'artifact_edges'), act: h.count(db, 'activity') };
  assert.throws(() => nx.artifacts.registerVersion(me, { artifactId: a.id, storage: { kind: 'inline', json: {} },
    inputs: [{ versionId: src.id, role: 'source', relation: 'derived_from' }] }), (e) => e.code === 'cycle');
  assert.deepEqual({ v: h.count(db, 'artifact_versions'), e: h.count(db, 'artifact_edges'), act: h.count(db, 'activity') }, before);
  db.exec('DROP TRIGGER temp.tr_plant');
  s.close();
});
