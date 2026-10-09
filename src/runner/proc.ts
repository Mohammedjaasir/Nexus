/**
 * The runner's only process launches (B2a Task 11). The runner spawns exactly two programs: the Docker CLI (its
 * absolute path, resolved once by dockerCli.ts) and `git`. Every launch is an async `spawn` with an argv array:
 * never a shell (`shell: false`), never a command string, never a synchronous call; `windowsHide` on Windows; a
 * per-call timeout; capped stdout and stderr. The environment is the caller's filtered copy (no host secrets).
 *
 * The two `spawn(` calls below are the only ones under src/runner; nexus-runner-posture pins their first arguments.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import * as path from 'node:path';

export interface RunOptions {
  cwd?: string;
  env: NodeJS.ProcessEnv;
  /** Kill the process after this long (0: no timeout). */
  timeoutMs: number;
  /** Bytes of stdout / stderr kept (the rest is counted, not stored). */
  maxStdout: number;
  maxStderr: number;
  signal?: AbortSignal;
  /** Called with every stdout chunk (also when it is not kept). A returned promise pauses the output until it settles. */
  onStdout?: (chunk: Buffer) => void | Promise<unknown>;
  onStderr?: (chunk: Buffer) => void;
}

export interface RunResult {
  code: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  stdoutBytes: number;
  truncated: boolean;
  timedOut: boolean;
  aborted: boolean;
  /** A launch error (`ENOENT`, `EACCES`, ...), when the process never ran. */
  error: string | null;
}

/** The Docker CLI's file name (docker / docker.exe): the runner launches nothing else under that path. */
export function isDockerBinary(bin: string): boolean {
  if (typeof bin !== 'string' || bin.length === 0 || bin.includes('\0') || !path.isAbsolute(bin)) return false;
  const base = path.basename(bin).toLowerCase();
  return base === 'docker' || base === 'docker.exe';
}

function collect(child: ChildProcess, o: RunOptions): Promise<RunResult> {
  return new Promise((resolve) => {
    const out: Buffer[] = []; const err: Buffer[] = [];
    let outBytes = 0; let errBytes = 0; let truncated = false; let timedOut = false; let aborted = false; let settled = false;
    let launchError: string | null = null;
    const kill = (): void => { try { child.kill('SIGKILL'); } catch { /* already gone */ } };
    const timer = o.timeoutMs > 0 ? setTimeout(() => { timedOut = true; kill(); }, o.timeoutMs) : null;
    const onAbort = (): void => { aborted = true; kill(); };
    if (o.signal) { if (o.signal.aborted) onAbort(); else o.signal.addEventListener('abort', onAbort, { once: true }); }
    child.stdout?.on('data', (d: Buffer) => {
      const pending = o.onStdout?.(d);
      if (pending && typeof (pending as Promise<unknown>).then === 'function') {
        child.stdout?.pause();
        (pending as Promise<unknown>).then(() => child.stdout?.resume(), () => child.stdout?.resume());
      }
      if (outBytes < o.maxStdout) out.push(d.subarray(0, Math.max(0, o.maxStdout - outBytes)));
      if (outBytes + d.length > o.maxStdout) truncated = true;
      outBytes += d.length;
    });
    child.stderr?.on('data', (d: Buffer) => {
      o.onStderr?.(d);
      if (errBytes < o.maxStderr) err.push(d.subarray(0, Math.max(0, o.maxStderr - errBytes)));
      errBytes += d.length;
    });
    const finish = (code: number | null, sig: string | null): void => {
      if (settled) return; settled = true;
      if (timer) clearTimeout(timer);
      o.signal?.removeEventListener('abort', onAbort);
      resolve({ code, signal: sig, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8'),
        stdoutBytes: outBytes, truncated, timedOut, aborted, error: launchError });
    };
    child.on('error', (e: NodeJS.ErrnoException) => { launchError = typeof e?.code === 'string' ? e.code : 'spawn_failed'; finish(null, null); });
    child.on('close', (code, sig) => finish(code, sig));
  });
}

/** Runs the Docker CLI at its resolved absolute path with an argv array. Refuses any other program. */
export function runDocker(dockerBin: string, argv: readonly string[], o: RunOptions): Promise<RunResult> {
  if (!isDockerBinary(dockerBin)) return Promise.reject(new Error('only the resolved docker binary is launched'));
  const child = spawn(dockerBin, [...argv], { cwd: o.cwd, env: o.env, windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
  return collect(child, o);
}

/** Runs `git` with an argv array in a fixed folder (the project folder main accepted). */
export function runGit(argv: readonly string[], o: RunOptions & { cwd: string }): Promise<RunResult> {
  const child = spawn('git', [...argv], { cwd: o.cwd, env: o.env, windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
  return collect(child, o);
}

/** The environment the runner's processes get: only what the tools need (no host secrets); DOCKER_HOST only if set. */
export function toolEnv(src: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const keep = ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'windir', 'ComSpec', 'PATHEXT', 'USERPROFILE', 'HOME', 'APPDATA', 'LOCALAPPDATA',
    'ProgramData', 'ProgramFiles', 'TEMP', 'TMP', 'TMPDIR', 'LANG', 'DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_CONFIG', 'DOCKER_CERT_PATH',
    'DOCKER_TLS_VERIFY'];
  const out: NodeJS.ProcessEnv = {};
  for (const k of keep) if (typeof src[k] === 'string' && src[k] !== '') out[k] = src[k];
  // git: never prompt, never read a pager, never run the user's credential helpers for a read-only plumbing call.
  out.GIT_TERMINAL_PROMPT = '0';
  out.GIT_PAGER = 'cat';
  out.GIT_OPTIONAL_LOCKS = '0';
  return out;
}
