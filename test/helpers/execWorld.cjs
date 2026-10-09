'use strict';
// A v9 database (the v6 fixture migrated with enableV9) with the execution core composed by the
// platform, a temp data home, two pinned test profiles, a candidate repository version and a
// candidate test suite version in p-ledger's sde participation, and helpers to drive jobs through a
// FakeRunner. No Docker, no runner process, no real userData. Authorization is never mocked: the
// world's principals are the seeded local owner and the system, plus restricted users the test adds.
const path = require('node:path');
const h = require('./sqlite.cjs');
const loadTs = require('../load-ts.cjs');
const { PersistStore } = loadTs('src/main/db.ts');
const { createNexusPlatform } = loadTs('src/main/nexus/platform.ts');
const { newId } = loadTs('src/main/nexus/db/ids.ts');
const { resolveDataHome } = loadTs('src/main/nexusExec/dataHome.ts');

const GIB = 2 ** 30;
const COMMIT = 'c0ffee'.padEnd(40, '0');
const IMAGE = { 'sde-node': 'sha256:' + '1'.repeat(64), 'sde-python': 'sha256:' + '2'.repeat(64) };
const PROFILES = ['sde-node', 'sde-python'].map((id, i) => ({
  id, image: { repository: `nexus/${id}`, digest: `sha256:${String(i + 7).repeat(64)}` }, user: { uid: 10001, gid: 10001 },
  defaults: { cpus: 1, memoryMb: 1024, pids: 512, wallClockMs: 60000, outputMaxBytes: 2 ** 20, tmpfsMb: 512 },
  entrypoint: ['/opt/nexus/entry'], imageEnv: ['PATH', 'HOME', 'LANG']
}));
const DEFAULT_INPUTS = { 'sde.build.run': 'repository', 'sde.tests.discover': 'repository', 'sde.deps.install': 'repository', 'sde.tests.run': 'suite' };

/** A preflight report that passes, with every observed field present. */
function passingPreflight() {
  return { ok: true, problems: [], observed: { nanoCpus: 2e9, memory: 2048 * 2 ** 20, memorySwap: 2048 * 2 ** 20, pidsLimit: 512,
    networkMode: 'none', readonlyRootfs: true, capDrop: ['ALL'], capAdd: [], privileged: false, user: '10001:10001',
    securityOpt: ['no-new-privileges'], mounts: [], portBindings: [], tmpfs: ['/tmp', '/home/nexus'], devices: [] } };
}

function execWorld(o = {}) {
  const { file } = h.v6Fixture();
  const s = new PersistStore(file);
  s.open({ log: () => {}, backupDir: path.join(path.dirname(file), 'b'), now: () => h.NOW, enableV9: true });
  const db = s.platformDatabase();
  const clock = { t: h.NOW + 1000 };
  const logs = [];
  const fsRootCalls = [];
  const acceptFsRoot = o.acceptFsRoot ?? ((root) => { fsRootCalls.push(root); return typeof root === 'string' && root.length > 0 ? root : null; });
  const dataHome = resolveDataHome(h.tmpDir('nx-home-'));
  const approvals = o.approvals === false || o.approvals === undefined ? null : {
    requestEgressTx(job, attempt, recipe, now) {
      const id = newId(now);
      db.prepare(`INSERT INTO approvals (id, project_id, job_id, reason, summary, request_json, request_sha256, status, requested_by,
          on_behalf_of, requested_at, expires_at, status_changed_at) VALUES (?, ?, ?, 'egress.deps', ?, ?, ?, 'pending', 'system', ?, ?, ?, ?)`)
        .run(id, job.projectId, job.id, 'Download dependencies', JSON.stringify({ recipeId: recipe.id, jobId: job.id }), 'e'.repeat(64),
          job.onBehalfOf, now, now + 15 * 60_000, now);
      return id;
    }
  };
  const nx = createNexusPlatform(db, { now: () => clock.t, log: (l) => logs.push(l), execution: o.execution ?? true,
    dataHome, profiles: PROFILES, acceptFsRoot, approvals, ingest: o.ingest ?? null, executionUnavailableReason: o.unavailableReason, appVersion: o.appVersion ?? null });
  const me = nx.principals.localUser(); const sys = nx.principals.system();
  const bootId = newId(clock.t);
  const probe = {
    docker: o.docker ?? 'running', memoryBytes: o.dockerMemoryBytes ?? 8 * GIB, cpus: 4, freeBytes: o.freeBytes ?? 100 * GIB,
    images: o.images ?? [{ profile: 'sde-node', present: true, digestMatches: true, imageId: IMAGE['sde-node'] },
      { profile: 'sde-python', present: true, digestMatches: true, imageId: IMAGE['sde-python'] }]
  };
  const probeMsg = () => ({ op: 'probe.result', probe: { docker: probe.docker, version: '27.0.0', cpus: probe.cpus, memoryBytes: probe.memoryBytes,
    gpu: { detected: false, usableInContainers: false } }, images: probe.images.map((x) => ({ ...x })), freeBytes: probe.freeBytes, runtimes: [] });
  let runner = null;
  const real = nx.exec;
  const attach = real.attachRunner.bind(real);
  real.attachRunner = (port, boot) => { attach(port, boot); runner = port; if (port) port.report(probeMsg()); };

  const pw = nx.workspaces.primaryOf(me, 'p-ledger');
  // A repository artifact is project data the snapshot ingest (Task 8/9) writes; the fixture inserts the artifact row
  // directly (the public create refuses `repository`) and registers its version through the service.
  const repoArtifact = newId(clock.t);
  db.prepare(`INSERT INTO artifacts (id, project_id, kind, name, description, owner_scope, owner_participation_id, owner_workspace_id,
      created_by, status, current_version_id, metadata_json, created_at, updated_at)
    VALUES (?, 'p-ledger', 'repository', 'ledger-api', NULL, 'participation', ?, ?, 'user:local', 'active', NULL, '{}', ?, ?)`)
    .run(repoArtifact, pw.id, pw.workspaceId, clock.t, clock.t);
  const repoMeta = { profile: o.profile ?? 'sde-node', ...(o.repoMeta ?? {}) };
  const repoV = nx.artifacts.registerVersion(me, { artifactId: repoArtifact, storage: { kind: 'git', commit: COMMIT }, metadata: repoMeta }).version.id;
  nx.artifacts.finalize(sys, repoV, 'candidate');
  const suiteA = nx.artifacts.create(me, { projectId: 'p-ledger', workspaceId: 'sde', kind: 'test_suite', name: 'suite' });
  const suiteV = nx.artifacts.registerVersion(me, { artifactId: suiteA.id, storage: { kind: 'git', commit: COMMIT },
    metadata: { profile: o.profile ?? 'sde-node', framework: 'node-test', files: ['test/a.test.js'] } }).version.id;
  nx.artifacts.finalize(sys, suiteV, 'candidate');

  let k = 0;
  const liveStmt = db.prepare("SELECT * FROM job_attempts WHERE job_id = ? AND state IN ('starting','running')");
  const w = {
    s, db, nx, exec: real, clock, logs, fsRootCalls, dataHome, me, sys, bootId, projectId: 'p-ledger', pw, repoV, suiteV, probe, COMMIT, IMAGE,
    now: () => clock.t,
    probeMsg,
    advance(ms) { clock.t += ms; return clock.t; },
    req(actionId, extra = {}) {
      const slot = DEFAULT_INPUTS[actionId];
      const inputs = slot === undefined ? [] : [{ versionId: slot === 'suite' ? suiteV : repoV, slot }];
      return { projectId: 'p-ledger', workspaceId: 'sde', actionId, inputs, params: {}, intentId: `intent-${++k}-${Math.random()}`, ...extra };
    },
    /** Push a changed probe through the attached runner (as the runner's next probe.result). */
    setProbe(patch) { Object.assign(probe, patch); if (runner) runner.report(probeMsg()); },
    job: (id) => db.prepare('SELECT * FROM jobs WHERE id = ?').get(id),
    jobState: (id) => db.prepare('SELECT state FROM jobs WHERE id = ?').get(id).state,
    attempt: (id) => db.prepare('SELECT * FROM job_attempts WHERE id = ?').get(id),
    attempts: (jobId) => db.prepare('SELECT * FROM job_attempts WHERE job_id = ? ORDER BY n').all(jobId),
    liveAttempt: (jobId) => liveStmt.get(jobId),
    liveCount: () => db.prepare("SELECT COUNT(*) AS n FROM job_attempts WHERE state IN ('starting','running')").get().n,
    events: (jobId, type) => db.prepare(`SELECT * FROM job_events WHERE job_id = ?${type ? ' AND type = ?' : ''} ORDER BY seq`).all(...(type ? [jobId, type] : [jobId])),
    activity: (jobId, action) => db.prepare(`SELECT * FROM activity WHERE job_id = ?${action ? ' AND action = ?' : ''} ORDER BY seq`).all(...(action ? [jobId, action] : [jobId])),
    /** Report a passing provisioned for the job's live attempt. */
    provision(r, jobId, extra = {}) {
      const a = w.liveAttempt(jobId);
      r.report({ op: 'attempt.provisioned', attemptId: a.id, containerId: (extra.c ?? 'c').repeat(64), imageDigest: extra.imageDigest ?? IMAGE['sde-node'],
        preflight: passingPreflight() });
      return a;
    },
    /** Let `ms` pass at the scheduler's cadence (a tick every 5 s); a runner, when given, heartbeats every 30 s. */
    run(r, ms, step = 5_000) {
      for (let t = step; t <= ms; t += step) {
        clock.t += step;
        if (r && t % 30_000 === 0) w.heartbeatAll(r);
        real.tick(clock.t);
      }
    },
    /** A heartbeat for every live attempt (as a live runner sends them). */
    heartbeatAll(r) {
      for (const a of db.prepare("SELECT id FROM job_attempts WHERE state IN ('starting','running')").all()) {
        r.report({ op: 'attempt.heartbeat', attemptId: a.id, at: clock.t, logBytes: 0, outBytes: 0, container: 'running' });
      }
    },
    /** Report an exit for the job's live attempt (outputs by relPath). */
    exit(r, jobId, x = {}) {
      const a = w.liveAttempt(jobId) ?? x.attempt;
      r.report({ op: 'attempt.exited', attemptId: a.id, exit: { code: x.code ?? 0, oomKilled: x.oom ?? false, finishedAt: clock.t },
        outputs: (x.outputs ?? []).map((p) => ({ relPath: p, sha256: 'f'.repeat(64), bytes: 10, mediaType: 'application/octet-stream' })),
        parsed: x.parsed ?? [], logBytes: 100, ...(x.outputError ? { outputError: x.outputError } : {}) });
      return a;
    },
    /** A user with one role at one scope (no mocking of authorization). */
    addUser(id, scopeType, scopeId, role) {
      db.prepare('INSERT INTO principals VALUES (?,?,?,NULL,?)').run(id, 'user', id, h.NOW);
      db.prepare('INSERT INTO memberships VALUES (?,?,?,?,?)').run(id, scopeType, scopeId, role, h.NOW);
      return { id, kind: 'user', displayName: id };
    },
    close() { s.close(); }
  };
  return w;
}

module.exports = { execWorld, passingPreflight, PROFILES, GIB };
