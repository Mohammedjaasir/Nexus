/**
 * Codex Remote's managed app-server daemon (macOS/Linux) runs the agent loop, so
 * its hooks carry the env the daemon was STARTED with — including the agent's
 * HIVE_HOOK_TOKEN (task 13, O.9 #13). Every spawn issues a new token, and a main
 * restart forgets every old one, so a daemon left running from before would send
 * a dead token and the agent would go dark. The daemon is therefore restarted
 * (`app-server daemon stop`, then `start`) whenever the token it holds is not the
 * current one. A fingerprint of the token it was started with is kept next to the
 * agent's CODEX_HOME (never the token itself).
 *
 * Pure decision logic; index.ts runs the commands.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const MARKER = '.nexus-daemon-token';

/** A short, one-way fingerprint of a hook token ('' when there is none). */
export function tokenFingerprint(token: string | undefined | null): string {
  if (!token) return '';
  return createHash('sha256').update(token).digest('hex').slice(0, 32);
}

/** The fingerprint the running daemon was started with, or null when Nexus has
 *  never started one for this home. */
export function readDaemonFingerprint(codexHome: string): string | null {
  const p = join(codexHome, MARKER);
  if (!existsSync(p)) return null;
  try { return readFileSync(p, 'utf8').trim(); } catch { return null; }
}

export function writeDaemonFingerprint(codexHome: string, fingerprint: string): void {
  try { writeFileSync(join(codexHome, MARKER), fingerprint, { encoding: 'utf8', mode: 0o600 }); } catch { /* best-effort */ }
}

export type DaemonPlan =
  /** Start; a stop failure does not matter (nothing of ours is known to run). */
  | { stop: 'best-effort'; start: true }
  /** The daemon holds an old token: it must stop before the new one starts. */
  | { stop: 'required'; start: true }
  /** Already running with this exact token. */
  | { stop: 'none'; start: true };

/**
 * - no record: a daemon from before this build (or none) may run. Stop it if it
 *   does, but a failed stop just means none was running.
 * - a different token: stop is required; if it fails the daemon would keep the
 *   dead token, so the caller must not connect to it.
 * - the same token: start is idempotent.
 */
export function planDaemonRestart(previous: string | null, next: string): DaemonPlan {
  if (previous === null) return { stop: 'best-effort', start: true };
  if (previous !== next) return { stop: 'required', start: true };
  return { stop: 'none', start: true };
}

/** What the agent shows when the daemon could not be restarted with its token. */
export function daemonRestartError(detail: string): string {
  return `Codex Remote needs your attention: its daemon could not be restarted with this agent's new token (${detail}). The agent runs as a local terminal instead, so its status stays live.`;
}

/** Output of `codex app-server daemon stop` that means "nothing was running". */
const NOT_RUNNING = /not running|no (?:running )?daemon|isn'?t running|not started|no such (?:process|file)|ENOENT|ECONNREFUSED/i;

/**
 * Whether a `daemon stop` left no daemon running. A failed stop still counts
 * when the control socket is absent (no daemon can be serving it) or when the
 * output says nothing was running: after a reboot or a daemon crash the marker
 * keeps an old fingerprint, and treating that as a real failure would keep Codex
 * Remote off for the agent forever.
 */
export function stopLeftNothingRunning(stop: { ok: boolean; error?: string }, socketExists: boolean): boolean {
  if (stop.ok) return true;
  if (!socketExists) return true;
  return NOT_RUNNING.test(stop.error ?? '');
}

/**
 * Stop (when the plan says so) and start the daemon with this spawn's token, and
 * record the token's fingerprint once it runs. `run` executes one
 * `codex app-server daemon <cmd>`. Returns:
 *  - `{ ok: true }` when the daemon runs with the new token;
 *  - `{ ok: false, attention }` when a daemon holding an old token could not be
 *    stopped (the agent must run locally and say why);
 *  - `{ ok: false }` when start failed (local terminal, as before).
 */
export async function restartDaemonWithToken(opts: {
  codexHome: string;
  fingerprint: string;
  socketExists: () => boolean;
  run: (cmd: 'stop' | 'start') => Promise<{ ok: boolean; error?: string }>;
}): Promise<{ ok: true } | { ok: false; attention?: string; error?: string }> {
  const plan = planDaemonRestart(readDaemonFingerprint(opts.codexHome), opts.fingerprint);
  if (plan.stop !== 'none') {
    const stopped = await opts.run('stop');
    if (plan.stop === 'required' && !stopLeftNothingRunning(stopped, opts.socketExists())) {
      return { ok: false, attention: daemonRestartError(stopped.error ?? 'stop failed') };
    }
  }
  const started = await opts.run('start');
  if (!started.ok) return { ok: false, error: started.error ?? 'start failed' };
  writeDaemonFingerprint(opts.codexHome, opts.fingerprint);
  return { ok: true };
}
