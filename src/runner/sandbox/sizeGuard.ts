/**
 * The runner-side size guard (B2a plan, Sandbox table, Disk row). The storage driver has no disk quota, so every 5 s
 * the runner measures `/out` on the host (an lstat walk that never follows a link, outputs.ts `outBytes`) and
 * `/workspace` inside the container (`du -s -x -k /workspace` through `docker exec`), and kills the container when one
 * is over its limit: `/out` over the recipe's `outputMaxBytes` (`output_too_large`), `/workspace` over
 * WORKSPACE_MAX_BYTES (`workspace_too_large`). The guard's configuration is recorded in the attempt's sandbox record.
 */
export const GUARD_POLL_MS = 5_000;
/** `/workspace` lives in a named volume inside the Docker VM: a checkout, its dependencies and build scratch. */
export const WORKSPACE_MAX_BYTES = 8 * 2 ** 30;
/** By its full path: a `du` earlier on the container's PATH (a repository's own bin folder) is never what runs. */
export const DU_ARGV: readonly string[] = Object.freeze(['/usr/bin/du', '-s', '-x', '-k', '/workspace']);

/** Bytes from `du -s -k` output (`<KiB>\t/workspace`), or null when it is not that. */
export function parseDuKib(stdout: string): number | null {
  const m = /^\s*(\d{1,15})\s+\/workspace\s*$/m.exec(String(stdout));
  if (!m) return null;
  const kib = Number(m[1]);
  return Number.isSafeInteger(kib) ? kib * 1024 : null;
}

export type GuardTrip = { guard: 'output_too_large' | 'workspace_too_large'; bytes: number; limitBytes: number };

/** The guard's decision for one poll. */
export function guardDecision(o: { outBytes: number; outLimit: number; workspaceBytes: number | null; workspaceLimit: number }): GuardTrip | null {
  if (o.outBytes > o.outLimit) return { guard: 'output_too_large', bytes: o.outBytes, limitBytes: o.outLimit };
  if (o.workspaceBytes !== null && o.workspaceBytes > o.workspaceLimit) return { guard: 'workspace_too_large', bytes: o.workspaceBytes, limitBytes: o.workspaceLimit };
  return null;
}
