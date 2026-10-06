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
