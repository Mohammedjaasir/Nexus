'use strict';
// B2a Task 11: the runner host (supervision, the fake fork) and the execution wiring (recovery hand-off, scheduler start,
// hints, log reads, quit). Real SQLite (test:db); the runner is either a scripted fake child or a real RunnerCore in this
// process over a MessageChannel with the fake sandbox driver. No Docker, no utilityProcess, no real userData.
const h = require('./helpers/sqlite.cjs');
if (!h.realSqliteOrSkip()) return;
const C = require('./helpers/cleanup.cjs'); C.cleanupAfterAll();
const test = require('node:test');
const { after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { MessageChannel } = require('node:worker_threads');
const loadTs = require('./load-ts.cjs');
const { execWorld, passingPreflight, PROFILES } = require('./helpers/execWorld.cjs');
const { FakeSandboxDriver } = require('./helpers/fakeSandboxDriver.cjs');
const { createNexusPlatform } = loadTs('src/main/nexus/platform.ts');
const { startRunnerHost, RESTART_DELAYS_MS, MAX_RESTARTS, STOP_TIMEOUT_MS, UNAVAILABLE_MESSAGE } = loadTs('src/main/nexusExec/runnerHost.ts');
const { startExecution, hintCoalescer, HINT_MIN_INTERVAL_MS, STARTUP_RECONCILE_WAIT_MS } = loadTs('src/main/nexusExec/execWiring.ts');
const { RunnerCore } = loadTs('src/runner/core.ts');
const { homeLabel } = loadTs('src/shared/nexus/homeLabel.ts');

const PORTS = [];
after(() => { for (const p of PORTS) { try { p.close(); } catch { /* closed */ } } });

class FakeClock {
  constructor(t) { this.now = t; this.q = []; this.n = 0; }
  setTimeout(fn, ms) { const x = { id: ++this.n, at: this.now + ms, fn, every: 0 }; this.q.push(x); return x; }
  setInterval(fn, ms) { const x = { id: ++this.n, at: this.now + ms, fn, every: ms }; this.q.push(x); return x; }
  clearTimeout(x) { this.q = this.q.filter((y) => y !== x); }
  clearInterval(x) { this.clearTimeout(x); }
  advance(ms) {
    const end = this.now + ms;
    for (;;) {
      const due = this.q.filter((x) => x.at <= end).sort((a, b) => a.at - b.at || a.id - b.id)[0];
      if (!due) break;
      this.now = due.at;
      if (due.every) due.at += due.every; else this.q = this.q.filter((x) => x !== due);
      due.fn();
    }
    this.now = end;
  }
}
const flush = async (n = 10) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };
async function until(pred, what, ms = 5000) {
  const t0 = Date.now();
  for (;;) { if (pred()) return; if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`); await new Promise((r) => setTimeout(r, 2)); }
}

/** A scripted runner process: records what main posts; answers hello with ready (unless told not to). */
function scriptedFork(o = {}) {
  const children = [];
  const fork = () => {
    const c = {
      posted: [], msgFn: null, exitFn: null, killed: false, dead: false,
      post(m) { if (c.dead) throw new Error('closed'); c.posted.push(m); if (m.op === 'hello' && o.ready !== false) setImmediate(() => c.msgFn?.({ op: 'ready', bootId: m.bootId })); if (m.op === 'shutdown' && o.exitOnShutdown) setImmediate(() => c.die(0)); },
      onMessage(f) { c.msgFn = f; }, onExit(f) { c.exitFn = f; },
      kill() { c.killed = true; c.die(null); },
      die(code) { if (c.dead) return; c.dead = true; c.exitFn?.(code); },
      say(m) { c.msgFn?.(m); }
    };
    if (o.failFork && children.length >= (o.failAfter ?? 0)) { children.push(c); throw new Error('cannot fork'); }
    children.push(c);
    return c;
  };
  return { fork, children };
}

/** A real RunnerCore in this process, over a MessageChannel, with the fake sandbox driver: the runner as main sees it. */
function coreFork(makeDriver) {
  const children = [];
  const fork = () => {
    const { port1, port2 } = new MessageChannel();
    PORTS.push(port1);
    let msgFn = null; let exitFn = null; let dead = false;
    port1.on('message', (m) => msgFn?.(m));
    const driver = makeDriver();
    const clock = new FakeClock(1_780_000_000_000);
    const core = new RunnerCore(port2, { driver, now: () => clock.now, fs: fsp, timers: clock, log: () => {}, freeBytes: async () => 100 * 2 ** 30, sleep: async () => {} });
    const c = {
      core, driver, clock,
      post(m) { if (dead) throw new Error('closed'); port1.postMessage(m); },
      onMessage(f) { msgFn = f; }, onExit(f) { exitFn = f; },
      kill() { if (dead) return; dead = true; port1.close(); exitFn?.(null); }
    };
    children.push(c);
    return c;
  };
  return { fork, children };
}

// ---------- the runner host ----------

test('H1 supervision: restarts after 1 s, 5 s, then 30 s; at most 5 restarts in 10 minutes, then unavailable; the last hello is replayed first; listeners survive', async () => {
  const clock = new FakeClock(1_000_000);
  const { fork, children } = scriptedFork();
  const logs = [];
  const host = startRunnerHost({ fork, log: (l) => logs.push(l), timers: clock, now: () => clock.now });
  const seen = [];
  host.port.onMessage((m) => seen.push(m.op));
  assert.equal(host.state(), 'starting');
  const hello = { op: 'hello', bootId: '01JABCDEFGHJKMNPQRSTVWXYZ0', dataHome: 'C:\\x\\nexus', home: '0123456789abcdef', profiles: [] };
  host.port.send(hello);
  await flush();
  assert.equal(host.state(), 'ready');
  assert.deepEqual(seen, ['ready']);
  const delays = [];
  for (let i = 0; i < MAX_RESTARTS; i++) {
    const n = children.length;
    children[n - 1].die(1);
    assert.equal(host.state(), 'crashed');
    assert.throws(() => host.port.send({ op: 'probe' }), /crashed/);
    const t0 = clock.now;
    while (children.length === n) clock.advance(500);
    delays.push(clock.now - t0);
    assert.deepEqual(children[children.length - 1].posted[0], hello, 'the hello is replayed first');
    await flush();
    assert.equal(host.state(), 'ready');
  }
  assert.deepEqual(delays, [1000, 5000, 30000, 30000, 30000].map((d) => Math.ceil(d / 500) * 500));
  assert.equal(RESTART_DELAYS_MS.join(','), '1000,5000,30000');
  assert.equal(seen.filter((x) => x === 'ready').length, MAX_RESTARTS + 1, 'listeners survive restarts');
  children[children.length - 1].die(1);
  clock.advance(10 * 60_000);
  assert.equal(host.state(), 'unavailable');
  assert.equal(children.length, MAX_RESTARTS + 1, 'no sixth restart');
  assert.ok(logs.some((l) => l.includes(UNAVAILABLE_MESSAGE)));
  assert.equal(host.restarts(), MAX_RESTARTS);
  assert.throws(() => host.port.send({ op: 'probe' }), /unavailable/);
});

test('H2 the restart window: crashes older than 10 minutes do not count; the delay starts over at 1 s', async () => {
  const clock = new FakeClock(1_000_000);
  const { fork, children } = scriptedFork();
  const host = startRunnerHost({ fork, log: () => {}, timers: clock, now: () => clock.now });
  children[0].die(1); clock.advance(1000); assert.equal(children.length, 2);
  children[1].die(1); clock.advance(5000); assert.equal(children.length, 3);
  clock.advance(11 * 60_000);
  children[2].die(1); clock.advance(1000);
  assert.equal(children.length, 4, 'one second again');
  await flush(); assert.notEqual(host.state(), 'unavailable');
});

test('H3 stop() sends shutdown and is bounded at 5 s: a runner that does not exit is killed', async () => {
  const clock = new FakeClock(1_000_000);
  const slow = scriptedFork();
  const host = startRunnerHost({ fork: slow.fork, log: () => {}, timers: clock, now: () => clock.now });
  const done = host.stop();
  assert.deepEqual(slow.children[0].posted.at(-1), { op: 'shutdown' });
  clock.advance(STOP_TIMEOUT_MS - 1); await flush();
  assert.equal(slow.children[0].killed, false);
  clock.advance(1); await done;
  assert.equal(slow.children[0].killed, true); assert.equal(host.state(), 'unavailable');
  clock.advance(60_000); assert.equal(slow.children.length, 1, 'never restarted after stop');
  const quick = scriptedFork({ exitOnShutdown: true });
  const host2 = startRunnerHost({ fork: quick.fork, log: () => {}, timers: clock, now: () => clock.now });
  await host2.stop();
  assert.equal(quick.children[0].killed, false, 'it exited on its own');
});

test('W1 the hint coalescer: at most one { lastSeq } per 250 ms, the newest one, and only when it changed', () => {
  const clock = new FakeClock(0);
  let seq = 0; const sent = [];
  const c = hintCoalescer({ lastSeq: () => seq, emit: (x) => sent.push(x.lastSeq), now: () => clock.now, timers: clock });
  for (let i = 0; i < 1000; i++) { seq++; c.poke(); clock.advance(1); }
  assert.ok(sent.length <= Math.ceil(1000 / HINT_MIN_INTERVAL_MS) + 1, `${sent.length} hints in 1 s`);
  clock.advance(1000);
  assert.equal(sent.at(-1), 1000);
  const n = sent.length;
  c.poke(); clock.advance(1000);
  assert.equal(sent.length, n, 'unchanged: no hint');
});

// ---------- the wiring, with the platform ----------

/** A new platform on the world's database (a new process: a new execution core and boot id), after its phase A. */
function platformOn(w) {
  const logs = [];
  const nx = createNexusPlatform(w.db, { now: () => w.now(), log: (l) => logs.push(l), execution: true, dataHome: w.dataHome, profiles: PROFILES,
    acceptFsRoot: (r) => r, approvals: null, ingest: undefined });
  nx.startup();
  return { nx, logs };
}
const userDataOf = (w) => path.dirname(w.dataHome.root);

test('W2 at every runner ready: reconcile.list exactly when reconcileList() is called; the answer goes to recoverPhaseB (never onRunnerMessage); the removal list goes to the runner and is recorded; the blob store pass runs once, after phase B, before the first tick', async () => {
  const w = execWorld();
  const { nx } = platformOn(w);
  const exec = nx.exec;
  const order = [];
  const spy = (name) => { const orig = exec[name].bind(exec); exec[name] = (...a) => { order.push(name); return orig(...a); }; };
  for (const n of ['reconcileList', 'recoverBlobStore', 'tick']) spy(n);
  const phaseB = [];
  const origB = exec.recoverPhaseB.bind(exec);
  exec.recoverPhaseB = (sys, boot, r) => { order.push('recoverPhaseB'); phaseB.push(boot); const out = origB(sys, boot, r); return { ...out, remove: [{ kind: 'volume', id: 'nexus-ws-x', reason: 'attempt_ended' }] }; };
  const seenByCore = [];
  const origM = exec.onRunnerMessage.bind(exec);
  exec.onRunnerMessage = (raw) => { seenByCore.push(raw?.op); return origM(raw); };
  const clock = new FakeClock(w.now());
  const { fork, children } = scriptedFork();
  const handle = await startExecution({ platform: nx, userData: userDataOf(w), log: () => {}, fork, timers: clock, now: () => w.now() });
  const child = children[0];
  assert.equal(child.posted[0].op, 'hello');
  assert.equal(child.posted[0].bootId, nx.bootId, 'attached with platform.bootId');
  assert.equal(child.posted[0].home, homeLabel(w.dataHome.root));
  await until(() => child.posted.some((m) => m.op === 'reconcile.list'), 'reconcile.list');
  assert.equal(order.filter((x) => x === 'reconcileList').length, child.posted.filter((m) => m.op === 'reconcile.list').length);
  clock.advance(5_000);
  assert.ok(!order.includes('tick'), 'no tick before phase B');
  child.say({ op: 'reconcile.result', docker: 'running', attempts: [], labelled: [] });
  await until(() => handle.ticking(), 'the scheduler starts');
  assert.deepEqual(phaseB, [nx.bootId]);
  assert.deepEqual(child.posted.filter((m) => m.op === 'reconcile.remove'), [{ op: 'reconcile.remove', resources: [{ kind: 'volume', id: 'nexus-ws-x' }] }]);
  assert.equal(w.db.prepare("SELECT COUNT(*) AS n FROM activity WHERE action = 'exec.orphan_removed'").get().n, 1);
  assert.ok(!seenByCore.includes('reconcile.result'), 'the core never sees the reconcile answer');
  clock.advance(1_000);
  assert.ok(order.indexOf('recoverPhaseB') < order.indexOf('recoverBlobStore') && order.indexOf('recoverBlobStore') < order.indexOf('tick'), order.join(' '));
  // A mid-session runner restart: hello again, ready, reconcile again; never the blob store pass again.
  child.die(1);
  clock.advance(RESTART_DELAYS_MS[0]);
  const child2 = children[1];
  assert.equal(child2.posted[0].op, 'hello'); assert.equal(child2.posted[0].bootId, nx.bootId);
  await until(() => child2.posted.some((m) => m.op === 'reconcile.list'), 'reconcile.list again');
  child2.say({ op: 'reconcile.result', docker: 'running', attempts: [], labelled: [] });
  await until(() => phaseB.length === 2, 'phase B again');
  await flush();
  assert.equal(order.filter((x) => x === 'recoverBlobStore').length, 1, 'once per app start');
  assert.equal(order.filter((x) => x === 'reconcileList').length, children.flatMap((c) => c.posted).filter((m) => m.op === 'reconcile.list').length);
  const stopping = handle.stop(); clock.advance(STOP_TIMEOUT_MS); await stopping;
  w.close();
});

test('W3 a runner that never reconciles: the scheduler starts when the host is unavailable, or after 2 minutes, without the blob store pass', async () => {
  const w = execWorld();
  const { nx } = platformOn(w);
  let blob = 0; const origBlob = nx.exec.recoverBlobStore.bind(nx.exec); nx.exec.recoverBlobStore = (...a) => { blob++; return origBlob(...a); };
  const clock = new FakeClock(w.now());
  const dead = scriptedFork({ ready: false });
  const handle = await startExecution({ platform: nx, userData: userDataOf(w), log: () => {}, fork: dead.fork, timers: clock, now: () => clock.now });
  // 1 + 5 + 30 + 30 + 30 s of restarts: unavailable well before the 2-minute wait.
  for (const d of [...RESTART_DELAYS_MS, 30_000, 30_000]) { dead.children.at(-1).die(1); clock.advance(d); }
  assert.equal(handle.ticking(), false);
  dead.children.at(-1).die(1);
  assert.equal(handle.host.state(), 'unavailable');
  clock.advance(1_000);
  assert.equal(handle.ticking(), true); assert.equal(blob, 0);
  const s1 = handle.stop(); clock.advance(STOP_TIMEOUT_MS); await s1;
  const { nx: nx2 } = platformOn(w);
  const hung = scriptedFork({ ready: false });
  const h2 = await startExecution({ platform: nx2, userData: userDataOf(w), log: () => {}, fork: hung.fork, timers: clock, now: () => clock.now });
  clock.advance(STARTUP_RECONCILE_WAIT_MS - 1_000); assert.equal(h2.ticking(), false);
  clock.advance(1_000); assert.equal(h2.ticking(), true);
  // Fix round 1 (4): the slow runner answers after the fallback started the scheduler: phase B runs, the blob store
  // pass does NOT (it would hold the exclusive lock while leases and ingests run).
  let blob2 = 0; const origBlob2 = nx2.exec.recoverBlobStore.bind(nx2.exec); nx2.exec.recoverBlobStore = (...a) => { blob2++; return origBlob2(...a); };
  let phaseB2 = 0; const origB2 = nx2.exec.recoverPhaseB.bind(nx2.exec); nx2.exec.recoverPhaseB = (...a) => { phaseB2++; return origB2(...a); };
  hung.children.at(-1).say({ op: 'ready', bootId: nx2.bootId });
  await until(() => hung.children.at(-1).posted.some((m) => m.op === 'reconcile.list'), 'reconcile.list');
  hung.children.at(-1).say({ op: 'reconcile.result', docker: 'running', attempts: [], labelled: [] });
  await until(() => phaseB2 === 1, 'phase B');
  await flush();
  assert.equal(blob2, 0, 'no blob store pass once the scheduler ticks');
  clock.advance(1_000); assert.equal(h2.ticking(), true);
  const s2 = h2.stop(); clock.advance(STOP_TIMEOUT_MS); await s2;
  w.close();
});

test('W4 integration: a container that exited while the app was closed is reconciled by a real RunnerCore, adopted for finalization, re-hashed from the data home and ingested; quit stops services and the runner within 5 s', async () => {
  const w = execWorld({ realIngest: true });
  const r = w.attach();
  const job = w.exec.start(w.me, w.req('sde.tests.discover')).job;
  w.exec.tick(w.now());
  const plan = r.lastStart().plan;
  const a = w.liveAttempt(job.id);
  const cid = 'a'.repeat(64);
  r.report({ op: 'attempt.provisioned', attemptId: a.id, containerId: cid, imageDigest: w.IMAGE['sde-node'], preflight: passingPreflight() });
  assert.equal(w.attempt(a.id).state, 'running');
  // What the first runner process left: plan.json beside in/out, and /out written by the container.
  const work = path.join(w.dataHome.root, 'work', job.id, '1');
  fs.mkdirSync(path.join(work, 'out'), { recursive: true });
  fs.writeFileSync(path.join(work, 'plan.json'), JSON.stringify({ plan, startedAt: w.now() }));
  fs.writeFileSync(path.join(work, 'out', 'ids.txt'), 'test/a.test.js\ntest/b.test.js\n');
  // The app restarts: a new platform (phase A leaves the attempt for phase B), and the wiring with a real runner.
  w.advance(60_000);
  const { nx } = platformOn(w);
  const label = homeLabel(w.dataHome.root);
  const { fork, children } = coreFork(() => {
    const d = new FakeSandboxDriver();
    d.containers.set(cid, { id: cid, name: plan.container.name, spec: plan.container, labels: { ...plan.container.labels }, state: 'exited',
      exit: { code: 0, oomKilled: false, finishedAt: w.now() - 1000 }, waiters: [], logs: [], logEnd: [] });
    d.volumes.set(`nexus-ws-${a.id}`, { ...plan.resourceLabels });
    d.volumes.set('nexus-deps-sde-node-aaaaaaaaaaaa', { ...plan.resourceLabels, 'nexus.kind': 'deps' });
    return d;
  });
  const clock = new FakeClock(w.now());
  let stoppedForQuit = 0;
  const origQuit = nx.deployments.stopAllForQuit.bind(nx.deployments);
  nx.deployments.stopAllForQuit = () => { stoppedForQuit++; return origQuit(); };
  const handle = await startExecution({ platform: nx, userData: userDataOf(w), log: () => {}, fork, timers: clock, now: () => w.now() });
  await until(() => w.jobState(job.id) === 'completed', 'the finalized exit is ingested', 8000);
  const runner = children[0];
  assert.equal(plan.container.labels['nexus.home'], label);
  assert.ok(runner.driver.filters.every((f) => f.includes('label=nexus.attempt') && f.includes(`label=nexus.home=${label}`)));
  assert.ok(!runner.driver.ops().includes('create') && !runner.driver.ops().includes('start'), 'nothing ran again');
  const exitRec = JSON.parse(fs.readFileSync(path.join(work, 'exit.json'), 'utf8'));
  assert.equal(exitRec.exit.code, 0);
  const suite = w.db.prepare("SELECT * FROM artifact_versions WHERE produced_by_job_id = ? AND output_path = 'ids.txt'").get(job.id);
  assert.deepEqual(JSON.parse(suite.metadata_json).files, ['test/a.test.js', 'test/b.test.js']);
  assert.equal(w.attempt(a.id).lease_owner, nx.bootId);
  await until(() => handle.ticking(), 'ticking');
  // The released attempt: its container and workspace volume go (found by label: this process did not make them); the work folder stays.
  await until(() => runner.driver.ops().includes('remove') && !runner.driver.volumes.has(`nexus-ws-${a.id}`), 'release');
  assert.ok(!runner.driver.containers.has(cid));
  assert.ok(runner.driver.volumes.has('nexus-deps-sde-node-aaaaaaaaaaaa'), 'a deps cache is never removed');
  assert.ok(fs.existsSync(work) && fs.existsSync(path.join(work, 'out', 'ids.txt')), 'the work folder stays');
  // Log reads are confined to the data home and redacted again.
  const logRel = w.attempt(a.id).log_path;
  fs.mkdirSync(path.dirname(path.join(w.dataHome.root, logRel)), { recursive: true });
  fs.writeFileSync(path.join(w.dataHome.root, logRel), `${JSON.stringify({ ts: 1, stream: 'stdout', text: 'a' })}\n${JSON.stringify({ ts: 2, stream: 'stdout', text: 'key sk-ant-api03-abcdefghijklmnopqrstuvwx' })}\n{"ts":3,"stream":"nexus","text":"x","truncatedMiddle":true}\n`);
  const page = await handle.readLog(logRel, { fromOffset: 0, maxBytes: 40 });
  assert.equal(page.eof, false); assert.ok(page.text.endsWith('\n'), 'whole frames only');
  const all = await handle.readLog(logRel, { fromOffset: 0, maxBytes: 262144 });
  assert.equal(all.eof, true); assert.equal(all.truncatedMiddle, true); assert.doesNotMatch(all.text, /sk-ant-api03/);
  assert.equal(await handle.readLog('../outside.log', { fromOffset: 0, maxBytes: 10 }), null);
  assert.equal(await handle.readLog('logs/jobs/../../x.log', { fromOffset: 0, maxBytes: 10 }), null);
  // Quit: services stopped first, then the runner is told to shut down; bounded.
  const stopping = handle.stop();
  clock.advance(STOP_TIMEOUT_MS);
  await stopping;
  assert.equal(stoppedForQuit, 1);
  assert.equal(handle.host.state(), 'unavailable');
  w.close();
});

test('W5 startExecution does nothing when execution is not available', async () => {
  const w = execWorld({ execution: false });
  const { fork, children } = scriptedFork();
  const logs = [];
  const handle = await startExecution({ platform: w.nx, userData: userDataOf(w), log: (l) => logs.push(l), fork });
  assert.equal(handle, null); assert.equal(children.length, 0);
  assert.ok(logs.some((l) => /not available/.test(l)));
  w.close();
});

// ---------- Fix round 1 (review of 0e7b8ce9) ----------

test('W6 (16) the reconcile request is recorded only after reconcile.list was sent: a failed send records nothing', async () => {
  const w = execWorld();
  const { nx } = platformOn(w);
  let recorded = 0; const orig = nx.exec.reconcileList.bind(nx.exec); nx.exec.reconcileList = () => { recorded++; return orig(); };
  const clock = new FakeClock(w.now());
  const s = scriptedFork();
  const handle = await startExecution({ platform: nx, userData: userDataOf(w), log: () => {}, fork: s.fork, timers: clock, now: () => w.now() });
  const child = s.children[0];
  await until(() => child.posted.some((m) => m.op === 'reconcile.list'), 'the first reconcile.list');
  assert.equal(recorded, 1, 'recorded once, after the send');
  // The next send fails: nothing is recorded.
  const post = child.post;
  child.post = (m) => { if (m.op === 'reconcile.list') throw new Error('closed'); post(m); };
  child.say({ op: 'ready', bootId: nx.bootId });
  await flush();
  assert.equal(recorded, 1, 'a request that never left is never recorded');
  const st = handle.stop(); clock.advance(STOP_TIMEOUT_MS); await st;
  w.close();
});

test('W7 (5) a container that vanished: main fails the attempt container_vanished AND releases it (the runner keeps its resources until then)', () => {
  const w = execWorld();
  const r = w.attach();
  const job = w.exec.start(w.me, w.req('sde.tests.discover')).job;
  w.exec.tick(w.now());
  const a = w.provision(r, job.id);
  assert.equal(r.sentOf('attempt.release').length, 0);
  r.report({ op: 'attempt.heartbeat', attemptId: a.id, at: w.now(), logBytes: 0, outBytes: 0, container: 'missing' });
  assert.equal(w.attempt(a.id).outcome, 'container_vanished');
  assert.deepEqual(r.sentOf('attempt.release').map((m) => m.attemptId), [a.id]);
  w.close();
});

test('W8 (Task 11 review round 2) a running container whose exit Docker cannot report: the runner\'s docker_error fault fails the attempt docker_error (retryable, never container_vanished) AND releases it', () => {
  const w = execWorld();
  const r = w.attach();
  const job = w.exec.start(w.me, w.req('sde.tests.discover')).job;
  w.exec.tick(w.now());
  const a = w.provision(r, job.id);
  assert.equal(w.attempt(a.id).state, 'running');
  // Another class for a running attempt is not attributed (only a create/start failure names one).
  r.report({ op: 'fault', attemptId: a.id, failureClass: 'disk_full', message: 'no space left on device' });
  assert.equal(w.attempt(a.id).state, 'running');
  r.report({ op: 'fault', attemptId: a.id, failureClass: 'docker_error', message: 'docker wait failed: the exit could not be read' });
  const at = w.attempt(a.id);
  assert.equal(at.state, 'failed'); assert.equal(at.outcome, 'docker_error');
  assert.match(at.error_json, /exit could not be read/);
  assert.equal(w.jobState(job.id), 'retry_scheduled', 'an infrastructure failure: retried');
  assert.deepEqual(r.sentOf('attempt.release').map((m) => m.attemptId), [a.id]);
  w.close();
});

// ---------- B2a close: a runner restart holds lease expiry (user decision 2026-10-21) ----------

const R = loadTs('src/main/nexus/exec/recovery.ts');
const { LEASE_MS } = loadTs('src/main/nexus/exec/attempts.ts');

/**
 * The wiring over a new platform on the world's database, with a scripted runner that says `ready` only when told, and
 * one clock for the world, the platform and the wiring's timers. The first runner is brought up (ready, probe, an
 * empty reconcile) until the scheduler ticks.
 */
async function restartWorld(o = {}) {
  const w = execWorld({ realIngest: true, ...o });
  const { nx, logs } = platformOn(w);
  const clock = new FakeClock(w.now());
  const s = scriptedFork({ ready: false });
  const handle = await startExecution({ platform: nx, userData: userDataOf(w), log: () => {}, fork: s.fork, timers: clock, now: () => w.now() });
  /** `ms` of time in 1 s steps: the world's clock and the wiring's timers (its 1 s scheduler tick) move together. */
  const step = (ms) => { for (let t = 0; t < ms; t += 1_000) { w.advance(1_000); clock.advance(1_000); } };
  const child = () => s.children.at(-1);
  const att = (id) => w.db.prepare('SELECT * FROM job_attempts WHERE id = ?').get(id);
  const ready = async (c) => {
    const before = c.posted.filter((m) => m.op === 'reconcile.list').length;
    c.say({ op: 'ready', bootId: nx.bootId });
    await until(() => c.posted.filter((m) => m.op === 'reconcile.list').length > before, 'reconcile.list');
    c.say(w.probeMsg());
  };
  const answer = async (c, attempts) => {
    const before = c.posted.length;
    c.say({ op: 'reconcile.result', docker: 'running', attempts, labelled: [] });
    await flush();
    return c.posted.slice(before);
  };
  const settleNx = async () => {
    for (let i = 0; i < 20; i++) {
      await nx.exec.settled(); if (nx.validation) await nx.validation.settled();
      await new Promise((res) => setImmediate(res)); if (nx.validation) nx.validation.runPending(w.now());
    }
  };
  await ready(child());
  await answer(child(), []);
  await until(() => handle.ticking(), 'the scheduler ticks');
  /** A build leased and (unless `provision` is false) provisioned by runner `c`, with one heartbeat. */
  const build = (c, provision = 'a') => {
    const job = nx.exec.start(w.me, w.req('sde.build.run')).job;
    step(1_000);
    const a = w.db.prepare("SELECT * FROM job_attempts WHERE job_id = ? AND state IN ('starting','running')").get(job.id);
    assert.ok(a, 'leased');
    if (provision) {
      c.say({ op: 'attempt.provisioned', attemptId: a.id, containerId: provision.repeat(64), imageDigest: w.IMAGE['sde-node'], preflight: passingPreflight() });
      c.say({ op: 'attempt.heartbeat', attemptId: a.id, at: w.now(), logBytes: 0, outBytes: 0, container: 'running' });
    }
    return { job, attempt: att(a.id) };
  };
  const stop = async () => { const st = handle.stop(); clock.advance(STOP_TIMEOUT_MS); await st; w.close(); };
  return { w, nx, logs, handle, step, child, att, ready, answer, settleNx, build, stop };
}

test('W9 (B2a close) a runner restart that takes 90 s keeps a healthy attempt: its lease is held, it is adopted at the reconcile and completes with one attempt', async () => {
  const x = await restartWorld();
  const { w, step, att } = x;
  const c1 = x.child();
  const { job, attempt: a } = x.build(c1);
  assert.equal(a.state, 'running');
  step(10_000);                                                    // 10 s after the last heartbeat, the runner dies
  const crashAt = w.now();
  c1.die(1);
  step(90_000);                                                    // restarted after 1 s, but slow: no ready for 90 s
  const c2 = x.child();
  assert.notEqual(c2, c1, 'the host restarted the runner');
  assert.ok(att(a.id).lease_expires_at < w.now(), 'its lease ran out during the restart');
  assert.equal(att(a.id).state, 'running', 'held: not runner_lost while the runner restarts');
  assert.equal(w.jobState(job.id), 'running');
  await x.ready(c2);                                               // ready: reconcile.list sent; the answer is slow too
  assert.deepEqual(c2.posted.find((m) => m.op === 'reconcile.list').attempts.map((m) => m.attemptId), [a.id]);
  step(5_000);
  assert.equal(att(a.id).state, 'running', 'held while the reconcile is outstanding');
  const sent = await x.answer(c2, [{ attemptId: a.id, container: 'running', containerId: a.container_id }]);
  assert.ok(sent.some((m) => m.op === 'attempt.adopt' && m.attemptId === a.id), 'adopted');
  assert.equal(att(a.id).lease_expires_at, w.now() + LEASE_MS, 'exactly one fresh lease at the adoption');
  assert.ok(x.logs.some((l) => /the runner is back after \d+ s \(reconciled\); 1 held lease/.test(l)), x.logs.join('\n'));
  for (let i = 0; i < 4; i++) {                                    // the new runner heartbeats, then the build exits
    c2.say({ op: 'attempt.heartbeat', attemptId: a.id, at: w.now(), logBytes: 0, outBytes: 0, container: 'running' }); step(15_000);
  }
  c2.say({ op: 'attempt.exited', attemptId: a.id, exit: { code: 0, oomKilled: false, finishedAt: w.now() }, outputs: [w.file('dist/app.js', 'x')], parsed: [], logBytes: 100 });
  await x.settleNx(); step(1_000); await x.settleNx();
  assert.equal(w.jobState(job.id), 'completed');
  const atts = w.db.prepare('SELECT * FROM job_attempts WHERE job_id = ? ORDER BY n').all(job.id);
  assert.equal(atts.length, 1, 'one attempt'); assert.equal(atts[0].state, 'succeeded');
  assert.ok(w.now() - crashAt > LEASE_MS, 'the restart outlasted a lease');
  await x.stop();
});

test('W10 (B2a close) a runner that never comes back: the held attempt ends runner_lost at the bound (no request: 10 min; an unanswered request: first request + 15 min); an unavailable runner ends the hold at once', async () => {
  const MIN = 60_000;
  // (a) Restarted but never ready: no reconcile request; the bound is 10 minutes from when the runner was last seen live.
  {
    const x = await restartWorld();
    const { w, step, att } = x;
    const { attempt: a } = x.build(x.child());
    const crashAt = w.now();
    x.child().die(1);
    let failedAt = null;
    while (failedAt === null && w.now() - crashAt < 20 * MIN) { step(1_000); if (att(a.id).state !== 'running') failedAt = w.now(); }
    assert.ok(failedAt !== null, 'ended');
    assert.equal(att(a.id).state, 'failed'); assert.equal(att(a.id).outcome, 'runner_lost');
    assert.ok(failedAt - crashAt >= R.RECONCILE_BOUND_MS - 1_000 && failedAt - crashAt <= R.RECONCILE_BOUND_MS + 2_000,
      `at the bound (${(failedAt - crashAt) / 1000} s after the crash)`);
    assert.ok(x.logs.some((l) => /lease hold ended \(the runner did not reconcile within the bound\)/.test(l)));
    await x.stop();
  }
  // (b) Ready, reconcile.list sent, never answered: the bound waits for the answer, at most the first request + 15 minutes.
  // The build's own 15-minute wall clock would end it first, so this one is given an hour: the bound is what ends it.
  {
    const x = await restartWorld();
    const { w, step, att } = x;
    const { job, attempt: a } = x.build(x.child());
    w.db.prepare("UPDATE jobs SET limits_json = json_set(limits_json, '$.wallClockMs', ?) WHERE id = ?").run(60 * MIN, job.id);
    x.child().die(1);
    step(30_000);
    const c2 = x.child();
    await x.ready(c2);
    const requestedAt = w.now();
    let failedAt = null;
    while (failedAt === null && w.now() - requestedAt < 20 * MIN) {
      step(1_000);
      if (w.now() - requestedAt === 12 * MIN) await x.ready(c2);   // a later ready asks again: it never moves the bound
      if (att(a.id).state !== 'running') failedAt = w.now();
    }
    assert.ok(failedAt !== null, 'ended');
    assert.equal(att(a.id).outcome, 'runner_lost');
    const bound = R.RECONCILE_BOUND_MS + R.RECONCILE_WAIT_CAP_MS;
    assert.ok(failedAt - requestedAt >= bound && failedAt - requestedAt <= bound + 2_000, `at the first request + 15 minutes (${(failedAt - requestedAt) / 1000} s)`);
    await x.stop();
  }
  // (c) Supervision gives up (unavailable): nothing is coming back, so the held lease runs out at once.
  {
    const x = await restartWorld();
    const { w, step, att } = x;
    const { attempt: a } = x.build(x.child());
    const crashAt = w.now();
    for (let i = 0; i < 6 && x.handle.host.state() !== 'unavailable'; i++) { x.child().die(1); step(31_000); }
    assert.equal(x.handle.host.state(), 'unavailable');
    step(LEASE_MS);
    assert.equal(att(a.id).outcome, 'runner_lost');
    assert.ok(w.now() - crashAt < 5 * MIN, 'long before the bound');
    assert.ok(x.logs.some((l) => /lease hold ended \(the runner is unavailable\)/.test(l)));
    await x.stop();
  }
});

test('W11 (B2a close) after the reconcile nothing stays held: a container reported missing is decided at the answer, an adopted one that vanishes fails at once, a start the runner never recorded runs out within its remaining lease', async () => {
  const MIN = 60_000;
  const x = await restartWorld({ dockerMemoryBytes: 64 * 2 ** 30 });   // room for three builds at once
  const { w, step, att } = x;
  const c1 = x.child();
  const gone = x.build(c1, 'a');
  const vanish = x.build(c1, 'b');
  const unrecorded = x.build(c1, false);                           // leased, attempt.start sent, never provisioned
  assert.equal(unrecorded.attempt.state, 'starting');
  step(5_000);
  c1.die(1);
  step(90_000);
  for (const a of [gone.attempt, vanish.attempt, unrecorded.attempt]) assert.ok(['starting', 'running'].includes(att(a.id).state), 'held during the restart');
  const c2 = x.child();
  await x.ready(c2);
  const answeredAt = w.now();
  const sent = await x.answer(c2, [{ attemptId: gone.attempt.id, container: 'missing' },
    { attemptId: vanish.attempt.id, container: 'running', containerId: vanish.attempt.container_id }]);
  // Missing at the reconcile: abandoned at the answer, never completed.
  assert.equal(att(gone.attempt.id).state, 'abandoned');
  assert.ok(!['running', 'leased', 'completed'].includes(w.jobState(gone.job.id)), w.jobState(gone.job.id));
  // Adopted, then its container goes: container_vanished on the heartbeat that says so, at once.
  assert.ok(sent.some((m) => m.op === 'attempt.adopt' && m.attemptId === vanish.attempt.id));
  c2.say({ op: 'attempt.heartbeat', attemptId: vanish.attempt.id, at: w.now(), logBytes: 0, outBytes: 0, container: 'missing' });
  assert.equal(att(vanish.attempt.id).outcome, 'container_vanished');
  // Not reconciled (no container recorded): it keeps only the lease it had left, then fails runner_lost.
  let lostAt = null;
  while (lostAt === null && w.now() - answeredAt < 5 * MIN) { step(1_000); if (att(unrecorded.attempt.id).state !== 'starting') lostAt = w.now(); }
  assert.equal(att(unrecorded.attempt.id).outcome, 'runner_lost');
  assert.ok(lostAt - answeredAt <= LEASE_MS, `within its remaining lease after the answer (${(lostAt - answeredAt) / 1000} s), not at the bound`);
  await x.stop();
});
