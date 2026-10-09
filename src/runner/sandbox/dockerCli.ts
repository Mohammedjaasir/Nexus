/**
 * The Docker CLI (B2a Task 11). `docker` / `docker.exe` is resolved ONCE: each `PATH` folder is checked with `fs` (no
 * shell, no `where`/`which`), then the Docker Desktop install folder. A path with spaces is fine: the argv is an array
 * (proc.ts). Each call has a timeout and capped stdout/stderr; the environment is the filtered tool environment,
 * with `DOCKER_HOST` passed through only when it is set. No binary found: every call reports `missing`, nothing throws.
 */
import * as path from 'node:path';
import { runDocker, toolEnv, type RunResult } from '../proc';
import type { RunnerFs } from '../types';

export const DOCKER_TIMEOUT_MS = 60_000;
export const DOCKER_MAX_OUTPUT = 4 * 2 ** 20;

export interface DockerCallOptions {
  timeoutMs?: number;
  maxStdout?: number;
  signal?: AbortSignal;
  onStdout?: (chunk: Buffer) => void;
  onStderr?: (chunk: Buffer) => void;
}

export interface DockerRunner {
  /** The resolved binary, or null when Docker is not installed. */
  binary(): Promise<string | null>;
  run(argv: readonly string[], o?: DockerCallOptions): Promise<RunResult>;
}

/** Candidate install locations of the Docker CLI, after PATH. */
export function installCandidates(platform: string, env: NodeJS.ProcessEnv): string[] {
  if (platform === 'win32') {
    const pf = env.ProgramFiles || env.PROGRAMFILES || 'C:\\Program Files';
    return [path.win32.join(pf, 'Docker', 'Docker', 'resources', 'bin', 'docker.exe')];
  }
  if (platform === 'darwin') return ['/usr/local/bin/docker', '/opt/homebrew/bin/docker', '/Applications/Docker.app/Contents/Resources/bin/docker'];
  return ['/usr/bin/docker', '/usr/local/bin/docker'];
}

/** Finds the Docker CLI: PATH first, then the install folder. Null when absent. */
export async function resolveDockerBinary(fs: Pick<RunnerFs, 'stat'>, env: NodeJS.ProcessEnv = process.env, platform: string = process.platform):
  Promise<string | null> {
  const p = platform === 'win32' ? path.win32 : path.posix;
  const name = platform === 'win32' ? 'docker.exe' : 'docker';
  const dirs = String(env.PATH ?? env.Path ?? '').split(platform === 'win32' ? ';' : ':').map((d) => d.trim().replace(/^"(.*)"$/, '$1'))
    .filter((d) => d.length > 0 && p.isAbsolute(d));
  for (const c of [...dirs.map((d) => p.join(d, name)), ...installCandidates(platform, env)]) {
    try { if ((await fs.stat(c)).isFile()) return c; } catch { /* not there */ }
  }
  return null;
}

/** The real CLI runner; `resolve` is called once (its answer is kept). */
export function dockerCli(fs: Pick<RunnerFs, 'stat'>, env: NodeJS.ProcessEnv = process.env): DockerRunner {
  let resolved: Promise<string | null> | null = null;
  const binary = (): Promise<string | null> => (resolved ??= resolveDockerBinary(fs, env));
  return {
    binary,
    async run(argv, o = {}) {
      const bin = await binary();
      if (!bin) return { code: null, signal: null, stdout: '', stderr: '', stdoutBytes: 0, truncated: false, timedOut: false, aborted: false, error: 'ENOENT' };
      return runDocker(bin, argv, { env: toolEnv(env), timeoutMs: o.timeoutMs ?? DOCKER_TIMEOUT_MS, maxStdout: o.maxStdout ?? DOCKER_MAX_OUTPUT,
        maxStderr: 64 * 1024, signal: o.signal, onStdout: o.onStdout, onStderr: o.onStderr });
    }
  };
}
