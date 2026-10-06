/**
 * LegacyWriteQueue — makes the legacy SQLite store's writes durable (P.3 step 3).
 *
 * A write that fails (SQLITE_BUSY, a locked file, ...) or arrives while the DB
 * is not open or paused for a migration is QUEUED and retried, never dropped.
 *
 * Guarantees:
 *  - FIFO: once anything is queued, later writes wait behind it, so the DB always
 *    ends up with the latest state. Writes for the same target may carry a
 *    coalesce key: a newer write replaces the queued older one in place, so a
 *    retry never writes a stale snapshot.
 *  - Bounded: retries back off (250ms .. 60s, then 60s) and a write that has failed
 *    MAX_ATTEMPTS times is logged as an error and dropped so it cannot wedge the
 *    rest; the queue holds at most `maxQueued` entries (oldest dropped, logged).
 *  - Nothing blocks: retries run from a timer (unref'd), one flush at a time.
 */
export interface WriteQueueOptions {
  maxQueued?: number;
  retryDelaysMs?: readonly number[];
  log?: (msg: string, err?: unknown) => void;
  schedule?: (fn: () => void, ms: number) => { cancel(): void };
  /** Readiness probe used by timer-driven retries (flush(isReady) overrides it). */
  isReady?: () => boolean;
}

interface Entry { label: string; run: () => void; key?: string; attempts: number }

export const MAX_WRITE_ATTEMPTS = 5;
const DEFAULT_DELAYS: readonly number[] = [250, 1000, 5000, 15000, 60000];

function defaultSchedule(fn: () => void, ms: number): { cancel(): void } {
  const t = setTimeout(fn, ms);
  if (typeof (t as { unref?: () => void }).unref === 'function') (t as { unref: () => void }).unref();
  return { cancel: () => clearTimeout(t) };
}

export class LegacyWriteQueue {
  private entries: Entry[] = [];
  private isPaused = false;
  private flushing = false;
  private timer: { cancel(): void } | null = null;
  private readonly maxQueued: number;
  private readonly delays: readonly number[];
  private readonly log: (msg: string, err?: unknown) => void;
  private readonly schedule: (fn: () => void, ms: number) => { cancel(): void };
  private readonly probe: () => boolean;

  constructor(opts: WriteQueueOptions = {}) {
    this.maxQueued = opts.maxQueued ?? 5000;
    this.delays = opts.retryDelaysMs && opts.retryDelaysMs.length ? opts.retryDelaysMs : DEFAULT_DELAYS;
    this.log = opts.log ?? ((m, e) => console.error(`[legacy-store] ${m}`, e ?? ''));
    this.schedule = opts.schedule ?? defaultSchedule;
    this.probe = opts.isReady ?? (() => true);
  }

  get size(): number { return this.entries.length; }
  get paused(): boolean { return this.isPaused; }

  /** Runs now when ready, not paused and nothing is queued (FIFO is kept); otherwise queues.
   *  A throw queues and schedules a retry. `key` coalesces: a queued write with the same key is replaced. */
  submit(label: string, run: () => void, ready: boolean, key?: string): 'written' | 'queued' {
    if (ready && !this.isPaused && this.entries.length === 0 && !this.flushing) {
      try { run(); return 'written'; }
      catch (err) {
        this.log(`write "${label}" failed (attempt 1/${MAX_WRITE_ATTEMPTS}), will retry: ${msgOf(err)}`, err);
        this.enqueue({ label, run, key, attempts: 1 });
        this.armTimer(1);
        return 'queued';
      }
    }
    this.enqueue({ label, run, key, attempts: 0 });
    if (ready && !this.isPaused) this.armTimer(1);
    return 'queued';
  }

  pause(): void { this.isPaused = true; }

  resume(isReady: () => boolean): { written: number; remaining: number } {
    this.isPaused = false;
    return this.flush(isReady);
  }

  /** Write queued entries in order; stops at the first failure and keeps order. */
  flush(isReady: () => boolean): { written: number; remaining: number } {
    if (this.flushing) return { written: 0, remaining: this.entries.length };
    this.flushing = true;
    let written = 0;
    try {
      if (this.isPaused || !isReady()) return { written, remaining: this.entries.length };
      this.cancelTimer();
      while (this.entries.length > 0) {
        const e = this.entries[0];
        try { e.run(); this.entries.shift(); written++; }
        catch (err) {
          e.attempts++;
          if (e.attempts >= MAX_WRITE_ATTEMPTS) {
            this.entries.shift();
            this.log(`write "${e.label}" failed ${e.attempts} times and was dropped: ${msgOf(err)}`, err);
            continue; // never wedge the rest of the queue
          }
          this.log(`write "${e.label}" failed (attempt ${e.attempts}/${MAX_WRITE_ATTEMPTS}), will retry: ${msgOf(err)}`, err);
          this.armTimer(e.attempts);
          break;
        }
      }
    } finally { this.flushing = false; }
    return { written, remaining: this.entries.length };
  }

  /** Cancel any pending retry timer (shutdown). Entries are kept for the caller to report. */
  dispose(): void { this.cancelTimer(); }

  /** Labels of what is still queued (shutdown report). */
  pendingLabels(): string[] { return this.entries.map((e) => e.label); }

  private enqueue(entry: Entry): void {
    if (entry.key) {
      // Walk back from the tail. An unkeyed entry is a barrier (it may depend on the
      // order of writes around it, e.g. a read-modify-write), so never coalesce across one.
      for (let i = this.entries.length - 1; i >= 0; i--) {
        const e = this.entries[i];
        if (!e.key) break;
        if (e.key === entry.key) { entry.attempts = 0; this.entries[i] = entry; return; }
      }
    }
    this.entries.push(entry);
    while (this.entries.length > this.maxQueued) {
      const dropped = this.entries.shift()!;
      this.log(`queue full (${this.maxQueued}); dropped oldest write "${dropped.label}"`);
    }
  }

  private armTimer(failures: number): void {
    if (this.timer) return;
    const ms = this.delays[Math.min(Math.max(failures, 1) - 1, this.delays.length - 1)];
    this.timer = this.schedule(() => {
      this.timer = null;
      if (this.entries.length === 0) return;
      const r = this.flush(this.probe);
      // Not ready or paused: resume()/open() flush; re-arming would spin.
      void r;
    }, ms);
  }

  private cancelTimer(): void {
    if (this.timer) { this.timer.cancel(); this.timer = null; }
  }
}

function msgOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
