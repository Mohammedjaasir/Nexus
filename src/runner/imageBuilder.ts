/**
 * Image builds (B2a Task 11, approval A2). `docker build` with a fixed argv: the profile's Dockerfile under
 * `<profile>/`, a context holding EXACTLY `<profile>/` and `common/` of `infra/images` (copied into
 * `work/.image-context/<buildId>` under the data home and hashed there, then removed), and two labels,
 * `nexus.profile=<profile>` and `nexus.context-sha256=<sha>`. The context hash is recomputed here first
 * (`contextSha256`, the one definition: sha256 of the canonical JSON of the sorted `[path, sha256]` list of every file
 * under `<profile>/` and `common/`); a context that differs from the approved one is refused, nothing is built.
 * Progress is reported from the CLI's plain progress lines (redacted, bounded, at most one per second). At most one
 * build per profile runs; `image.build.cancel` kills the CLI and reports `cancelled`. The build log is written to
 * `logs/images/<buildId>.log`, redacted.
 */
import { createHash } from 'node:crypto';
import * as path from 'node:path';
import { SANDBOX_PROFILE_IDS, type SandboxProfileId } from '../shared/nexus/execution';
import { ULID_RE, type RunnerToMain } from '../shared/nexus/runnerProtocol';
import { redactSecretText } from '../main/nexus/activity/redact';
import { LogWriter } from './logs';
import { hashFile } from './objectStore';
import type { HomePaths } from './paths';
import type { DockerRunner } from './sandbox/dockerCli';
import type { RunnerFs } from './types';

export const BUILD_MAX_MS = 4 * 60 * 60_000;
export const PROGRESS_EVERY_MS = 1_000;
const SHA_RE = /^[0-9a-f]{64}$/;

/** The files of a profile's build context (`<profile>/**` and `common/**`), relative, sorted; links are refused. */
async function contextFiles(fs: RunnerFs, imagesDir: string, profile: SandboxProfileId): Promise<string[] | null> {
  const out: string[] = [];
  const walk = async (rel: string): Promise<boolean> => {
    const abs = path.join(imagesDir, ...rel.split('/'));
    let st;
    try { st = await fs.lstat(abs); } catch { return rel === 'common'; }
    if (st.isSymbolicLink()) return false;
    if (st.isFile()) { out.push(rel); return true; }
    if (!st.isDirectory()) return false;
    for (const n of (await fs.readdir(abs)).sort()) if (!(await walk(`${rel}/${n}`))) return false;
    return true;
  };
  try { if (!(await fs.lstat(path.join(imagesDir, profile))).isDirectory()) return null; } catch { return null; }
  if (!(await walk(profile)) || !(await walk('common'))) return null;
  return out.sort();
}

/** The context hash of a profile (null when its folder is missing or holds a link). */
export async function contextSha256(fs: RunnerFs, imagesDir: string, profile: SandboxProfileId): Promise<string | null> {
  const files = await contextFiles(fs, imagesDir, profile);
  if (!files) return null;
  const list: [string, string][] = [];
  for (const f of files) list.push([f, (await hashFile(fs, path.join(imagesDir, ...f.split('/')))).sha256]);
  return createHash('sha256').update(JSON.stringify(list)).digest('hex');
}

/**
 * Copies a profile's context (`<profile>/**`, `common/**`, the same file list `contextSha256` hashes; links refused)
 * into `dest`, a fresh folder. False when the context is missing or holds a link.
 */
export async function copyContext(fs: RunnerFs, imagesDir: string, profile: SandboxProfileId, dest: string): Promise<boolean> {
  const files = await contextFiles(fs, imagesDir, profile);
  if (!files) return false;
  await fs.rm(dest, { recursive: true, force: true });
  for (const f of files) {
    const to = path.join(dest, ...f.split('/'));
    await fs.mkdir(path.dirname(to), { recursive: true });
    await fs.copyFile(path.join(imagesDir, ...f.split('/')), to);
  }
  return true;
}

export function buildArgv(imagesDir: string, profile: SandboxProfileId, contextSha: string): string[] {
  if (!SANDBOX_PROFILE_IDS.includes(profile) || !SHA_RE.test(contextSha)) throw new Error('bad build request');
  return ['build', '--progress=plain', '--label', `nexus.profile=${profile}`, '--label', `nexus.context-sha256=${contextSha}`,
    '--tag', `nexus-local/${profile}:${contextSha.slice(0, 12)}`, '--file', path.join(imagesDir, profile, 'Dockerfile'), imagesDir];
}

interface Running { buildId: string; profile: SandboxProfileId; abort: AbortController; cancelled: boolean }

export class ImageBuilder {
  private readonly running = new Map<string, Running>();

  constructor(private readonly cli: DockerRunner, private readonly o: {
    fs: RunnerFs; imagesDir: string; paths: () => HomePaths | null; now: () => number; post: (m: RunnerToMain) => void; log: (line: string) => void;
  }) {}

  /** For tests: builds in flight by profile. */
  activeProfiles(): SandboxProfileId[] { return [...this.running.values()].map((r) => r.profile); }

  start(m: { buildId: string; profile: SandboxProfileId; approvalId: string; contextSha256: string }): Promise<void> {
    const fail = (error: string): void => this.o.post({ op: 'image.build.done', buildId: m.buildId, outcome: 'failed', error });
    if (typeof m.buildId !== 'string' || !ULID_RE.test(m.buildId)) { this.o.log('[runner] image build refused: bad build id'); return Promise.resolve(); }
    if (!SANDBOX_PROFILE_IDS.includes(m.profile) || typeof m.contextSha256 !== 'string' || !SHA_RE.test(m.contextSha256)
      || typeof m.approvalId !== 'string' || m.approvalId.length === 0) { fail('the build request is malformed'); return Promise.resolve(); }
    // A start re-sent for a build that runs is idempotent (checked before the one-build-per-profile rule).
    if (this.running.has(m.buildId)) return Promise.resolve();
    if ([...this.running.values()].some((r) => r.profile === m.profile)) { fail(`a build of ${m.profile} is already running`); return Promise.resolve(); }
    const r: Running = { buildId: m.buildId, profile: m.profile, abort: new AbortController(), cancelled: false };
    this.running.set(m.buildId, r);
    return this.run(r, m.contextSha256).finally(() => this.running.delete(m.buildId));
  }

  cancel(buildId: string): void {
    const r = this.running.get(buildId);
    if (!r) return;
    r.cancelled = true;
    r.abort.abort();
  }

  /** Stops every build (shutdown): the killed CLI cancels the build in the daemon. */
  cancelAll(): void { for (const id of [...this.running.keys()]) this.cancel(id); }

  private async run(r: Running, approvedSha: string): Promise<void> {
    const { buildId, profile } = r;
    const post = this.o.post;
    // The final answer is sent only after the assembled context is removed (main may start the next build at once).
    let final: RunnerToMain | null = null;
    const done = (m: RunnerToMain): void => { final = m; };
    const paths = this.o.paths();
    let ctxDir: string | null = null;
    let log: LogWriter | null = null;
    if (paths) {
      try { log = new LogWriter(this.o.fs, paths.root, paths.imageLogPath(buildId), { now: this.o.now }); await log.open(); } catch { log = null; }
    }
    try {
      post({ op: 'image.build.progress', buildId, at: this.o.now(), phase: 'checking the build context' });
      // The context sent is EXACTLY the hashed one: `<profile>/` and `common/` copied into a folder of their own under
      // the data home (no root .dockerignore or other file of infra/images can change the build), hashed there.
      if (!paths) { done({ op: 'image.build.done', buildId, outcome: 'failed', error: 'the runner has no data home' }); return; }
      ctxDir = path.join(paths.workRoot, '.image-context', buildId);
      let sha: string | null = null;
      try {
        if (await copyContext(this.o.fs, this.o.imagesDir, profile, ctxDir)) sha = await contextSha256(this.o.fs, ctxDir, profile);
      } catch { sha = null; }
      if (r.cancelled) { done({ op: 'image.build.done', buildId, outcome: 'cancelled' }); return; }
      if (sha === null) { done({ op: 'image.build.done', buildId, outcome: 'failed', error: `the build context of ${profile} is not in this build` }); return; }
      if (sha !== approvedSha) { done({ op: 'image.build.done', buildId, outcome: 'failed', error: 'the build context changed since it was approved' }); return; }
      let lastProgress = 0; let pendingLine = ''; let tail = '';
      const onErr = (b: Buffer): void => {
        const text = b.toString('utf8');
        tail = (tail + text).slice(-4000);
        log?.write('stderr', text);
        const lines = (pendingLine + text).split(/\r?\n/);
        pendingLine = lines.pop() ?? '';
        const now = this.o.now();
        const last = [...lines].reverse().find((l) => /^#\d+ /.test(l.trim()));
        if (last && now - lastProgress >= PROGRESS_EVERY_MS) {
          lastProgress = now;
          const phase = redactSecretText(last.trim()).slice(0, 200);
          if (phase.length > 0) post({ op: 'image.build.progress', buildId, at: now, phase });
        }
      };
      const res = await this.cli.run(buildArgv(ctxDir, profile, approvedSha), { timeoutMs: BUILD_MAX_MS, maxStdout: 64 * 1024,
        signal: r.abort.signal, onStderr: onErr, onStdout: (b) => { log?.write('stdout', b.toString('utf8')); } });
      if (r.cancelled || res.aborted) { done({ op: 'image.build.done', buildId, outcome: 'cancelled' }); return; }
      if (res.error === 'ENOENT') { done({ op: 'image.build.done', buildId, outcome: 'failed', error: 'Docker is not installed' }); return; }
      if (res.code !== 0) {
        const why = redactSecretText((tail || res.stderr).replace(/\s+/g, ' ').trim()).slice(-500) || 'docker build failed';
        done({ op: 'image.build.done', buildId, outcome: 'failed', error: res.timedOut ? 'the build ran past its time limit' : why });
        return;
      }
      const ins = await this.cli.run(['image', 'inspect', `nexus-local/${profile}:${approvedSha.slice(0, 12)}`], { timeoutMs: 30_000 });
      let rec: unknown = null;
      try { rec = JSON.parse(ins.stdout); } catch { rec = null; }
      const img = Array.isArray(rec) && rec[0] && typeof rec[0] === 'object' ? rec[0] as Record<string, unknown> : null;
      const id = img && typeof img.Id === 'string' && /^sha256:[0-9a-f]{64}$/.test(img.Id) ? img.Id : null;
      const size = img && Number.isSafeInteger(img.Size) ? img.Size as number : null;
      if (!id || size === null) { done({ op: 'image.build.done', buildId, outcome: 'failed', error: 'the built image could not be read back' }); return; }
      done({ op: 'image.build.done', buildId, outcome: 'succeeded', imageId: id, sizeBytes: size });
    } catch (e) {
      done({ op: 'image.build.done', buildId, outcome: r.cancelled ? 'cancelled' : 'failed',
        ...(r.cancelled ? {} : { error: redactSecretText(String((e as Error)?.message ?? 'the build failed')).slice(0, 500) || 'the build failed' }) } as RunnerToMain);
    } finally {
      await log?.close();
      if (ctxDir) { try { await this.o.fs.rm(ctxDir, { recursive: true, force: true }); } catch { /* best effort */ } }
      if (final) post(final);
    }
  }
}
