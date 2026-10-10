/**
 * Execution wiring (B2a Task 11): starts the runner host and connects it to the execution core, in main.
 *
 * - The runner is attached with the platform's own boot id (`platform.bootId`, the one phase A re-owned for).
 * - At every runner `ready` (app start and every runner restart) main sends `reconcile.list` (built from
 *   `exec.reconcileCandidates()`, which records nothing) and calls `exec.reconcileList()` only once the send succeeded
 *   (that call records the request for the reconcile bound: a request that never left is never waited for).
 * - The runner's `reconcile.result` goes to `exec.recoverPhaseB(system, platform.bootId, result)` (the core's own
 *   `onRunnerMessage` never sees it). Phase B's removal list is handed to the runner (`reconcile.remove`; it removes
 *   only resources labelled with this install's `nexus.home` and a `nexus.attempt`) and recorded once
 *   (`exec.orphan_removed`). Resources of this install naming an unknown attempt are logged and left in place.
 * - Once per app start, after the first phase B and before the scheduler's first tick: `exec.recoverBlobStore(system)`.
 *   A mid-session runner restart runs phase B again, never the blob store pass. When the scheduler already ticks (it
 *   started without a reconcile: the runner was unavailable or 2 minutes passed), the pass is skipped for this app start:
 *   it holds the blob store's exclusive lock, and leases and ingests must not wait for it.
 * - The scheduler: `exec.tick` every 1 s once started (it also runs the 30 s approval expiry sweep and the 60 s probe
 *   refresh). It starts after that first phase B, or, when the runner never reconciles (it is unavailable, or 2 minutes
 *   pass), without it (the reconcile bound then ends what phase A left).
 * - The renderer hint push (the hint channel, Task 13): `{ lastSeq }` after runner messages and ticks, coalesced to at most 4 per second, only when
 *   the newest event changed (Task 13 sends it to the renderer).
 * - Log and object reads for the IPC layer: async `fs/promises`, confined to the data home.
 * - Quit (`stop`, bounded at 5 s): live dev deployments are stopped (`stopAllForQuit`), then the runner is told to shut
 *   down (it stops services and leaves tool containers running, so the next start adopts them).
 */
import { open } from 'node:fs/promises';
import type { NexusPlatform } from '../nexus/platform';
import type { RunnerPort } from '../nexus/exec/runnerPort';
import { redactSecretText } from '../nexus/activity/redact';
import { resolveDataHome, satisfiesLogPathCheck, type DataHome } from './dataHome';
import { startRunnerHost, type ForkRunner, type HostTimers, type RunnerHost } from './runnerHost';

export const TICK_MS = 1_000;
export const HINT_MIN_INTERVAL_MS = 250;
export const STARTUP_RECONCILE_WAIT_MS = 2 * 60_000;
export const STOP_BUDGET_MS = 5_000;
export const MAX_LOG_PAGE = 262_144;
export const MAX_OBJECT_PAGE = 2 ** 20;

export interface WiringTimers extends HostTimers {
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(h: unknown): void;
}
const REAL: WiringTimers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (h) => clearTimeout(h as NodeJS.Timeout),
  setInterval: (fn, ms) => setInterval(fn, ms), clearInterval: (h) => clearInterval(h as NodeJS.Timeout)
};

export interface LogPage { text: string; nextOffset: number; eof: boolean; truncatedMiddle: boolean }

export interface ExecutionHandle {
  readonly host: RunnerHost;
  readonly dataHome: DataHome;
  /** True once the scheduler ticks. */
  ticking(): boolean;
  /** The renderer hint payloads, at most 4 per second. */
  onHint(fn: (h: { lastSeq: number }) => void): () => void;
  /** A page of an attempt log (`logs/jobs/<jobId>/<n>.log`, as stored), redacted again; whole frames only. */
  readLog(logRel: string, q: { fromOffset: number; maxBytes: number }): Promise<LogPage | null>;
  /** A page of a stored object's bytes (previews), or null when it is not there. */
  readObject(sha256: string, q: { offset: number; maxBytes: number }): Promise<{ bytes: Buffer; nextOffset: number; eof: boolean } | null>;
  /** App quit, bounded at 5 s. */
  stop(): Promise<void>;
}

/** At most one hint per HINT_MIN_INTERVAL_MS, carrying the newest seq, and only when it changed. */
export function hintCoalescer(o: { lastSeq: () => number; emit: (h: { lastSeq: number }) => void; now: () => number; timers: HostTimers }): { poke(): void; cancel(): void } {
  let pending: unknown = null;
  let lastEmitAt = -Infinity;
  let lastSent: number | null = null;
  const fire = (): void => {
    pending = null;
    let seq: number;
    try { seq = o.lastSeq(); } catch { return; }
    if (seq === lastSent) return;
    lastSent = seq; lastEmitAt = o.now();
    try { o.emit({ lastSeq: seq }); } catch { /* a listener's problem */ }
  };
  return {
    poke(): void {
      if (pending !== null) return;
      const wait = Math.max(0, HINT_MIN_INTERVAL_MS - (o.now() - lastEmitAt));
      pending = o.timers.setTimeout(fire, wait);
    },
    cancel(): void { if (pending !== null) { o.timers.clearTimeout(pending); pending = null; } }
  };
}

const isReconcileResult = (raw: unknown): boolean => (raw as { op?: unknown } | null)?.op === 'reconcile.result';

export async function startExecution(o: { platform: NexusPlatform; userData: string; log: (line: string) => void;
  fork?: ForkRunner; timers?: WiringTimers; now?: () => number }): Promise<ExecutionHandle | null> {
  const p = o.platform;
  const log = o.log;
  if (!p.executionAvailable) { log('[nexus] execution not started: execution is not available on this database'); return null; }
  const timers = o.timers ?? REAL;
  const now = o.now ?? Date.now;
  const dataHome = resolveDataHome(o.userData);
  await dataHome.ensure();
  const exec = p.exec;
  const system = p.principals.system();
  const host = startRunnerHost({ fork: o.fork, log, timers, now });
  const hintListeners = new Set<(h: { lastSeq: number }) => void>();
  const hint = hintCoalescer({ lastSeq: () => exec.lastEventSeq(), now, timers,
    emit: (h) => { for (const f of [...hintListeners]) { try { f(h); } catch { /* listener */ } } } });
  const startedAt = now();
  let firstPhaseB = true;
  let ticking = false;
  let stopped = false;

  const startTicking = (why: string): void => {
    if (ticking || stopped) return;
    ticking = true;
    log(`[nexus] execution scheduler started (${why})`);
  };

  const onReconcile = async (raw: unknown): Promise<void> => {
    const r = raw as { docker?: unknown; attempts?: unknown; labelled?: unknown };
    let report: ReturnType<typeof exec.recoverPhaseB> | null = null;
    try {
      report = exec.recoverPhaseB(system, p.bootId, { docker: r.docker as 'running', attempts: r.attempts as never, labelled: r.labelled as never });
    } catch (e) {
      log(`[nexus] execution recovery at runner ready was not applied: ${(e as { code?: string })?.code ?? (e as Error)?.name ?? 'error'}`);
    }
    if (report && report.remove.length > 0) {
      try {
        host.port.send({ op: 'reconcile.remove', resources: report.remove.map((x) => ({ kind: x.kind, id: x.id })) });
        exec.recordOrphanRemoval(system, report.remove);
      } catch (e) { log(`[nexus] leftover sandbox resources were not handed to the runner (${(e as Error)?.name ?? 'error'})`); }
    }
    if (report && report.unknown.length > 0) log(`[nexus] ${report.unknown.length} labelled sandbox resource(s) name an attempt this database does not know; left in place`);
    if (firstPhaseB && !stopped) {
      firstPhaseB = false;
      if (ticking) {
        // The scheduler already ticks (it started without a reconcile): no blob store pass this app start.
        log('[nexus] blob store hygiene skipped: the scheduler started before the first reconcile');
      } else {
        // Once per app start, after phase B and before the first tick.
        try { await exec.recoverBlobStore(system); } catch (e) { log(`[nexus] blob store hygiene did not run (${(e as Error)?.name ?? 'error'})`); }
        startTicking('after restart recovery');
      }
    }
    hint.poke();
  };

  host.port.onMessage((raw) => {
    if (stopped) return;
    const op = (raw as { op?: unknown } | null)?.op;
    if (op === 'ready') {
      // The request is recorded (reconcileList) only once it was sent.
      let sent = false;
      try { host.port.send({ op: 'reconcile.list', attempts: exec.reconcileCandidates() }); sent = true; } catch (e) {
        log(`[nexus] reconcile request not sent (${(e as Error)?.name ?? 'error'})`);
      }
      if (sent) exec.reconcileList();
    } else if (op === 'reconcile.result') {
      void onReconcile(raw);
      return;
    }
    hint.poke();
  });

  // The core's port: every runner message except the reconcile answer (routed above).
  const execPort: RunnerPort = {
    state: () => host.port.state(),
    send: (m) => host.port.send(m),
    onMessage: (fn) => host.port.onMessage((raw) => { if (!isReconcileResult(raw)) fn(raw); })
  };
  exec.attachRunner(execPort, p.bootId);

  const interval = timers.setInterval(() => {
    if (stopped) return;
    if (!ticking) {
      if (host.state() === 'unavailable') startTicking('the runner is unavailable');
      else if (now() - startedAt >= STARTUP_RECONCILE_WAIT_MS) startTicking('the runner did not reconcile in time');
      if (!ticking) return;
    }
    exec.tick(now());
    hint.poke();
  }, TICK_MS);

  return {
    host, dataHome,
    ticking: () => ticking,
    onHint(fn) { hintListeners.add(fn); return () => { hintListeners.delete(fn); }; },
    async readLog(logRel, q) {
      if (typeof logRel !== 'string' || !logRel.startsWith('logs/jobs/') || !satisfiesLogPathCheck(logRel)) return null;
      const from = Number.isSafeInteger(q?.fromOffset) && q.fromOffset >= 0 ? q.fromOffset : 0;
      const max = Number.isSafeInteger(q?.maxBytes) && q.maxBytes > 0 ? Math.min(q.maxBytes, MAX_LOG_PAGE) : MAX_LOG_PAGE;
      const abs = await dataHome.confineToDataHome(logRel);
      if (!abs) return null;
      let fh;
      try { fh = await open(abs, 'r'); } catch { return null; }
      try {
        const size = (await fh.stat()).size;
        if (from >= size) return { text: '', nextOffset: size, eof: true, truncatedMiddle: false };
        const buf = Buffer.alloc(Math.min(max, size - from));
        const { bytesRead } = await fh.read(buf, 0, buf.length, from);
        let chunk = buf.subarray(0, bytesRead);
        // Whole frames only (a frame longer than a page comes whole on its own page... cut at the page).
        const nl = chunk.lastIndexOf(0x0a);
        if (nl >= 0 && from + bytesRead < size) chunk = chunk.subarray(0, nl + 1);
        const text = chunk.toString('utf8');
        const next = from + chunk.length;
        return { text: redactSecretText(text), nextOffset: next, eof: next >= size, truncatedMiddle: text.includes('"truncatedMiddle":true') };
      } finally { await fh.close(); }
    },
    async readObject(sha256, q) {
      if (typeof sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(sha256)) return null;
      const abs = await dataHome.objectPath(sha256);
      if (!abs) return null;
      const off = Number.isSafeInteger(q?.offset) && q.offset >= 0 ? q.offset : 0;
      const max = Number.isSafeInteger(q?.maxBytes) && q.maxBytes > 0 ? Math.min(q.maxBytes, MAX_OBJECT_PAGE) : MAX_OBJECT_PAGE;
      let fh;
      try { fh = await open(abs, 'r'); } catch { return null; }
      try {
        const size = (await fh.stat()).size;
        if (off >= size) return { bytes: Buffer.alloc(0), nextOffset: size, eof: true };
        const buf = Buffer.alloc(Math.min(max, size - off));
        const { bytesRead } = await fh.read(buf, 0, buf.length, off);
        return { bytes: buf.subarray(0, bytesRead), nextOffset: off + bytesRead, eof: off + bytesRead >= size };
      } finally { await fh.close(); }
    },
    async stop() {
      if (stopped) return;
      stopped = true;
      timers.clearInterval(interval);
      hint.cancel();
      try { p.deployments?.stopAllForQuit(); } catch (e) { log(`[nexus] dev deployments were not stopped for quit (${(e as Error)?.name ?? 'error'})`); }
      // host.stop is bounded at STOP_BUDGET_MS (it kills the runner after that).
      await host.stop();
    }
  };
}
