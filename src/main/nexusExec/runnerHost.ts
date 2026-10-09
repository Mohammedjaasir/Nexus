/**
 * The runner host (B2a Task 11): forks the runner utilityProcess (`out/main/runner.js`, no database) and supervises it.
 *
 * - One `MessageChannelMain` per process: port1 stays in main, port2 is transferred to the runner. Main's side is a
 *   `RunnerPort` (src/main/nexus/exec/runnerPort.ts) whose listeners survive restarts; its state is `starting` until the
 *   runner says `ready`, then `ready`; `crashed` between a crash and the restart; `unavailable` once supervision gives up.
 * - Messages main sends while the runner starts go to the port (they wait there until the runner listens). After a
 *   restart the last `hello` main sent is sent again first, so the new process knows its boot id, data home, install
 *   label and profiles (main then reconciles at its `ready`).
 * - Supervision: an unexpected exit restarts it after 1 s, then 5 s, then 30 s; at most 5 restarts in 10 minutes, then
 *   the state is `unavailable` ("Execution is unavailable: the runner stopped repeatedly"). Main and the database keep
 *   serving reads either way.
 * - `stop()` (app quit): sends `shutdown` (the runner stops dev deployments and leaves tool containers running for the
 *   next start to adopt), waits for the exit at most 5 s, then kills it.
 * `utilityProcess` appears in this file only (pinned by nexus-platform-composition); tests inject `fork`.
 */
import { MessageChannelMain, utilityProcess } from 'electron';
import { join } from 'node:path';
import type { MainToRunner } from '../../shared/nexus/runnerProtocol';
import type { RunnerPort, RunnerPortState } from '../nexus/exec/runnerPort';
import { redactSecretText } from '../nexus/activity/redact';

/** One runner process as the host sees it (the real one is utilityProcess + MessageChannelMain; tests fake it). */
export interface RunnerChild {
  /** A message to the runner; throws once the channel is closed. */
  post(msg: unknown): void;
  onMessage(fn: (data: unknown) => void): void;
  /** Called once, when the process has ended. */
  onExit(fn: (code: number | null) => void): void;
  /** Its stdout/stderr, line by line (diagnostics only). */
  onOutput?(fn: (line: string) => void): void;
  kill(): void;
}
export type ForkRunner = () => RunnerChild;

export const RESTART_DELAYS_MS: readonly number[] = Object.freeze([1_000, 5_000, 30_000]);
export const MAX_RESTARTS = 5;
export const RESTART_WINDOW_MS = 10 * 60_000;
export const STOP_TIMEOUT_MS = 5_000;
export const UNAVAILABLE_MESSAGE = 'Execution is unavailable: the runner stopped repeatedly';

export interface HostTimers { setTimeout(fn: () => void, ms: number): unknown; clearTimeout(h: unknown): void }
const REAL: HostTimers = { setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (h) => clearTimeout(h as NodeJS.Timeout) };

export interface RunnerHost {
  /** Main's port to the runner (stable across restarts). */
  readonly port: RunnerPort;
  state(): RunnerPortState;
  /** Restarts so far (all time) and the reason of the last unexpected exit. */
  restarts(): number;
  lastFault(): string | null;
  /** App quit: bounded at STOP_TIMEOUT_MS. */
  stop(): Promise<void>;
}

/** The real fork: `utilityProcess.fork(join(__dirname, 'runner.js'))` with one transferred MessagePort. */
export function electronFork(): RunnerChild {
  const child = utilityProcess.fork(join(__dirname, 'runner.js'), [], { serviceName: 'Nexus runner', stdio: 'pipe' });
  const { port1, port2 } = new MessageChannelMain();
  child.once('spawn', () => { child.postMessage({ op: 'port' }, [port2]); });
  port1.start();
  let onMsg: ((d: unknown) => void) | null = null;
  let onEnd: ((c: number | null) => void) | null = null;
  let onOut: ((l: string) => void) | null = null;
  port1.on('message', (e) => { onMsg?.(e.data); });
  child.once('exit', (code) => { try { port1.close(); } catch { /* closed */ } onEnd?.(typeof code === 'number' ? code : null); });
  const lines = (buf: { text: string }) => (d: Buffer): void => {
    const all = buf.text + d.toString('utf8');
    const parts = all.split(/\r?\n/);
    buf.text = (parts.pop() ?? '').slice(-4096);
    for (const l of parts) if (l.trim()) onOut?.(l);
  };
  child.stdout?.on('data', lines({ text: '' }));
  child.stderr?.on('data', lines({ text: '' }));
  return {
    post: (m) => port1.postMessage(m),
    onMessage: (fn) => { onMsg = fn; },
    onExit: (fn) => { onEnd = fn; },
    onOutput: (fn) => { onOut = fn; },
    kill: () => { try { child.kill(); } catch { /* gone */ } }
  };
}

export function startRunnerHost(o: { fork?: ForkRunner; log: (line: string) => void; onMessage?: (raw: unknown) => void;
  now?: () => number; timers?: HostTimers }): RunnerHost {
  const fork = o.fork ?? electronFork;
  const now = o.now ?? Date.now;
  const timers = o.timers ?? REAL;
  const listeners = new Set<(raw: unknown) => void>();
  let child: RunnerChild | null = null;
  let state: RunnerPortState = 'starting';
  let lastHello: MainToRunner | null = null;
  let restartTimer: unknown = null;
  let stopping = false;
  let restartsTotal = 0;
  let fault: string | null = null;
  const crashes: number[] = [];
  let exitWaiters: (() => void)[] = [];

  const deliver = (raw: unknown): void => {
    const op = (raw as { op?: unknown } | null)?.op;
    if (op === 'ready' && state === 'starting') state = 'ready';
    for (const fn of [...listeners]) { try { fn(raw); } catch (e) { o.log(`[nexus] runner host: a listener threw (${(e as Error)?.name ?? 'error'})`); } }
    try { o.onMessage?.(raw); } catch { /* the hook's own problem */ }
  };

  const spawn = (): void => {
    restartTimer = null;
    state = 'starting';
    let c: RunnerChild;
    try { c = fork(); } catch (e) {
      fault = `the runner could not start (${(e as Error)?.name ?? 'error'})`;
      o.log(`[nexus] runner host: ${fault}`);
      onCrash(null);
      return;
    }
    child = c;
    c.onMessage((d) => { if (child === c) deliver(d); });
    c.onOutput?.((line) => o.log(`[nexus] runner: ${redactSecretText(line).slice(0, 500)}`));
    c.onExit((code) => {
      if (child !== c) return;
      child = null;
      const w = exitWaiters; exitWaiters = [];
      for (const f of w) f();
      if (stopping) { state = 'unavailable'; return; }
      fault = `the runner exited (code ${code ?? 'none'})`;
      o.log(`[nexus] runner host: ${fault}`);
      onCrash(code);
    });
    // A restarted runner first learns who it works for: the last hello main sent.
    if (restartsTotal > 0 && lastHello) { try { c.post(lastHello); } catch { /* the exit handler restarts it */ } }
  };

  const onCrash = (_code: number | null): void => {
    const t = now();
    while (crashes.length > 0 && t - crashes[0] > RESTART_WINDOW_MS) crashes.shift();
    if (crashes.length >= MAX_RESTARTS) {
      state = 'unavailable';
      o.log(`[nexus] ${UNAVAILABLE_MESSAGE}`);
      return;
    }
    const delay = RESTART_DELAYS_MS[Math.min(crashes.length, RESTART_DELAYS_MS.length - 1)];
    crashes.push(t);
    state = 'crashed';
    restartsTotal++;
    restartTimer = timers.setTimeout(spawn, delay);
  };

  const port: RunnerPort = {
    state: () => state,
    send(msg: MainToRunner): void {
      if (msg?.op === 'hello') lastHello = msg;
      if (stopping && msg?.op !== 'shutdown') throw new Error('the runner is stopping');
      if (!child || state === 'crashed' || state === 'unavailable') throw new Error(`the runner is ${state}`);
      child.post(msg);
    },
    onMessage(fn: (raw: unknown) => void): () => void {
      listeners.add(fn);
      return () => { listeners.delete(fn); };
    }
  };

  spawn();

  return {
    port,
    state: () => state,
    restarts: () => restartsTotal,
    lastFault: () => fault,
    stop(): Promise<void> {
      stopping = true;
      if (restartTimer !== null) { timers.clearTimeout(restartTimer); restartTimer = null; }
      const c = child;
      if (!c) { state = 'unavailable'; return Promise.resolve(); }
      return new Promise<void>((resolve) => {
        let done = false;
        const finish = (): void => { if (done) return; done = true; timers.clearTimeout(timer); state = 'unavailable'; resolve(); };
        exitWaiters.push(finish);
        const timer = timers.setTimeout(() => { c.kill(); finish(); }, STOP_TIMEOUT_MS);
        try { c.post({ op: 'shutdown' }); } catch { c.kill(); finish(); }
      });
    }
  };
}
