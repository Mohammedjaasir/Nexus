/**
 * The Docker sandbox driver (B2a Task 11): the shared `SandboxDriver` over the Docker CLI (dockerCli.ts), plus the
 * runner's own operations (types.ts `RunnerDriver`).
 *
 * `create` builds the whole `docker create` argv from a `ContainerSpec` (`createArgv`, pure):
 * - `--pull never` (a missing image is an error, never a download), `--runtime runc`, `--restart no`, never `--rm`
 *   (an exited container and its `/out` survive until main releases them);
 * - `--mount` for every mount (never `-v`), exactly the spec's mounts;
 * - `--user 10001:10001`, `--cpus`, `--memory` = `--memory-swap` (no swap), `--pids-limit`, `--read-only`, the two
 *   tmpfs mounts, `--cap-drop ALL`, `--security-opt no-new-privileges`, `--ipc private`, `--cgroupns private`;
 * - `--network` from the spec (`none`, the job's egress bridge, a service's internal network; the forwarder also joins
 *   its publish network), `-p 127.0.0.1:<port>:<port>/tcp` only for the forwarder;
 * - `--env` exactly the spec's pairs (the image's own ENV names are checked against `imageEnv` by preflight);
 * - every spec label (`nexus.*`, including `nexus.attempt`, `nexus.boot` and `nexus.home`);
 * - the image by its digest-pinned reference; preflight then checks the local image id (sha256).
 * There is NO memory ceiling check here: main's scheduler budget is the gate (a `--memory` above what Docker has is
 * Docker's to refuse, and `docker create` does not check it).
 * `preflight` = `docker inspect` + `comparePreflight` (pure, src/shared/nexus/preflightCheck.ts).
 * `listByLabels` / `listResources` always pass `--filter label=nexus.attempt` (and the given labels): an unlabelled
 * resource is never listed.
 */
import { StringDecoder } from 'node:string_decoder';
import {
  HOME_TMPFS_MB, HOME_TMPFS_PATH, SANDBOX_UID, SANDBOX_USER, TMP_TMPFS_PATH,
  type ContainerLabels, type ContainerSpec, type ExitInfo, type PreflightReport, type SandboxProbe, type SandboxProfileId
} from '../../shared/nexus/execution';
import { comparePreflight, expectedNetworkName, publishNetworkName } from '../../shared/nexus/preflightCheck';
import { redactSecretText } from '../../main/nexus/activity/redact';
import type { RunResult } from '../proc';
import type { CreateOptions, ImageInfo, ResourceFacts, ResourceKind, RunnerDriver } from '../types';
import type { DockerRunner } from './dockerCli';

export type DockerErrorKind = 'disk_full' | 'docker_resources' | 'image_missing' | 'name_conflict' | 'port_conflict' | 'not_found' | 'docker_error';

/** Docker's answer, classified (the runner maps it to a refusal or a fault class). */
export function classifyDockerError(stderr: string): DockerErrorKind {
  const s = String(stderr);
  if (/no space left on device/i.test(s)) return 'disk_full';
  if (/cannot allocate memory|minimum memory limit|out of memory|memory limit .*(?:too|less)/i.test(s)) return 'docker_resources';
  if (/no such image|pull access denied|manifest unknown|image .* not found|unable to find image/i.test(s)) return 'image_missing';
  if (/container name .* is already in use|conflict\. the container name/i.test(s)) return 'name_conflict';
  if (/port is already allocated|address already in use|ports are not available|bind: /i.test(s)) return 'port_conflict';
  if (/no such container|no such volume|no such network|not found/i.test(s)) return 'not_found';
  return 'docker_error';
}

export class DockerError extends Error {
  readonly kind: DockerErrorKind;
  constructor(op: string, stderr: string) {
    // Docker's own words, redacted and bounded (they never carry a secret onward).
    const text = redactSecretText(String(stderr).replace(/\s+/g, ' ').trim()).slice(0, 600);
    super(`docker ${op} failed${text ? `: ${text}` : ''}`);
    this.name = 'DockerError';
    this.kind = classifyDockerError(stderr);
  }
}

const NAME_RE = /^nexus-[A-Za-z0-9][A-Za-z0-9_.-]{0,200}$/;
const LABEL_KEY_RE = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const CONTAINER_ID_RE = /^[0-9a-f]{64}$/;
const RESOURCE_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,254}$/;

class SpecError extends Error { constructor(m: string) { super(m); this.name = 'SpecError'; } }

/** One `--mount` field, CSV-quoted when it holds a comma or a quote (Docker parses `--mount` as CSV). */
function csvField(f: string): string {
  if (/[\r\n\0]/.test(f)) throw new SpecError('a mount field holds a line break');
  return /[",]/.test(f) ? `"${f.replace(/"/g, '""')}"` : f;
}

/** The labels as `--label k=v` pairs, in key order. */
export function labelArgs(labels: Record<string, string>): string[] {
  const out: string[] = [];
  for (const k of Object.keys(labels).sort()) {
    const v = labels[k];
    if (!LABEL_KEY_RE.test(k) || typeof v !== 'string' || /[\r\n\0]/.test(v)) throw new SpecError(`label ${k.slice(0, 40)} is not allowed`);
    out.push('--label', `${k}=${v}`);
  }
  return out;
}

/** The full `docker create` argv for a spec (pure; throws SpecError for a spec it cannot express exactly). */
export function createArgv(spec: ContainerSpec, o: CreateOptions = {}): string[] {
  const name = o.name ?? spec.name;
  if (!NAME_RE.test(name)) throw new SpecError('the container name is not a nexus name');
  const l = spec.limits;
  if (!(l.cpus > 0) || !Number.isSafeInteger(l.memoryMb) || l.memoryMb < 1 || !Number.isSafeInteger(l.pids) || l.pids < 1
    || !Number.isSafeInteger(l.tmpfsMb) || l.tmpfsMb < 1) throw new SpecError('the limits are incomplete');
  if (spec.readOnlyRootfs !== true || spec.noNewPrivileges !== true || spec.capDrop?.[0] !== 'ALL') throw new SpecError('the sandbox flags are incomplete');
  if (typeof spec.image?.ref !== 'string' || !/@?sha256:[0-9a-f]{64}$/.test(spec.image.ref)) throw new SpecError('the image is not digest-pinned');
  const argv = ['create', '--pull', 'never', '--name', name, ...labelArgs(spec.labels as unknown as Record<string, string>),
    '--user', SANDBOX_USER, '--cpus', String(l.cpus), '--memory', `${l.memoryMb}m`, '--memory-swap', `${l.memoryMb}m`,
    '--pids-limit', String(l.pids), '--read-only',
    '--tmpfs', `${TMP_TMPFS_PATH}:rw,noexec,nosuid,size=${l.tmpfsMb}m,uid=${SANDBOX_UID}`,
    '--tmpfs', `${HOME_TMPFS_PATH}:rw,nosuid,size=${HOME_TMPFS_MB}m,uid=${SANDBOX_UID}`,
    '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--runtime', 'runc', '--restart', 'no',
    '--ipc', 'private', '--cgroupns', 'private', '--log-driver', 'json-file', '--log-opt', 'max-size=32m', '--log-opt', 'max-file=2'];
  // Network: the spec's mode; a dev deployment's app answers as `app`; the forwarder also joins its publish network.
  argv.push('--network', expectedNetworkName(spec));
  if (o.alias) {
    if (!/^[a-z][a-z0-9-]{0,30}$/.test(o.alias) || spec.network.mode !== 'service-internal') throw new SpecError('an alias needs a service network');
    argv.push('--network-alias', o.alias);
  }
  const pubNet = publishNetworkName(spec);
  if (pubNet) argv.push('--network', pubNet);
  for (const m of spec.mounts) {
    if (typeof m.containerPath !== 'string' || !m.containerPath.startsWith('/') || m.containerPath.includes('..')) throw new SpecError('a mount target is not absolute');
    const bind = /^[A-Za-z]:[\\/]/.test(m.hostPath) || m.hostPath.startsWith('/');
    if (!bind && !NAME_RE.test(m.hostPath)) throw new SpecError('a volume mount is not a nexus volume');
    const fields = [`type=${bind ? 'bind' : 'volume'}`, `src=${m.hostPath}`, `dst=${m.containerPath}`];
    if (m.readOnly) fields.push('readonly');
    argv.push('--mount', fields.map(csvField).join(','));
  }
  if (spec.publish) {
    const p = spec.publish;
    if (p.hostIp !== '127.0.0.1' || !Number.isInteger(p.hostPort) || p.hostPort < 1 || p.hostPort > 65535
      || !Number.isInteger(p.containerPort) || p.containerPort < 1 || p.containerPort > 65535) throw new SpecError('the published port is not a loopback port');
    argv.push('-p', `127.0.0.1:${p.hostPort}:${p.containerPort}/tcp`);
  }
  for (const k of Object.keys(spec.env ?? {}).sort()) {
    const v = spec.env[k];
    if (!ENV_NAME_RE.test(k) || typeof v !== 'string' || /[\r\n\0]/.test(v)) throw new SpecError(`env ${k.slice(0, 40)} is not allowed`);
    argv.push('--env', `${k}=${v}`);
  }
  // The CLI sets a one-element entrypoint; a longer one must be the image's own (preflight compares it exactly).
  if (spec.entrypoint.length === 1) argv.push('--entrypoint', spec.entrypoint[0]);
  else if (spec.entrypoint.length === 0) argv.push('--entrypoint', '');
  argv.push(spec.image.ref, ...spec.argv);
  return argv;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
function parseJsonOut(text: string): unknown { try { return JSON.parse(text); } catch { return null; } }
function labelsOf(v: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!isObj(v)) return out;
  for (const [k, x] of Object.entries(v)) if (typeof x === 'string') out[k] = x;
  return out;
}

export class DockerDriver implements RunnerDriver {
  constructor(private readonly cli: DockerRunner, private readonly o: { now: () => number }) {}

  private async call(op: string, argv: readonly string[], opts: { timeoutMs?: number; maxStdout?: number; signal?: AbortSignal } = {}): Promise<RunResult> {
    const r = await this.cli.run(argv, opts);
    if (r.error === 'ENOENT') throw new DockerError(op, 'the docker command is not installed');
    return r;
  }
  private async ok(op: string, argv: readonly string[], opts: { timeoutMs?: number; ignore?: DockerErrorKind[]; signal?: AbortSignal } = {}): Promise<RunResult> {
    const r = await this.call(op, argv, opts);
    if (r.code !== 0) {
      const kind = classifyDockerError(r.stderr);
      if (opts.ignore?.includes(kind)) return r;
      throw new DockerError(op, r.timedOut ? 'timed out' : r.stderr);
    }
    return r;
  }

  async probe(): Promise<SandboxProbe> {
    const gpu = { detected: false, usableInContainers: false as const };
    if (!(await this.cli.binary())) return { docker: 'missing', gpu };
    const v = await this.cli.run(['version', '--format', '{{json .}}'], { timeoutMs: 15_000 });
    const ver = parseJsonOut(v.stdout);
    const server = isObj(ver) && isObj(ver.Server) ? ver.Server : null;
    if (v.error === 'ENOENT') return { docker: 'missing', gpu };
    if (v.code !== 0 || !server) return { docker: 'stopped', gpu };
    const i = await this.cli.run(['info', '--format', '{{json .}}'], { timeoutMs: 15_000 });
    const info = parseJsonOut(i.stdout);
    const out: SandboxProbe = { docker: 'running', gpu };
    if (typeof server.Version === 'string') out.version = server.Version.slice(0, 64);
    if (isObj(info)) {
      if (typeof info.OperatingSystem === 'string') out.os = info.OperatingSystem.slice(0, 128);
      if (typeof info.KernelVersion === 'string') out.wsl2 = /WSL2|microsoft-standard/i.test(info.KernelVersion);
      if (Number.isSafeInteger(info.NCPU) && (info.NCPU as number) >= 0) out.cpus = info.NCPU as number;
      if (Number.isSafeInteger(info.MemTotal) && (info.MemTotal as number) >= 0) out.memoryBytes = info.MemTotal as number;
      if (isObj(info.Runtimes) && Object.keys(info.Runtimes).some((k) => /nvidia/i.test(k))) out.gpu = { detected: true, usableInContainers: false };
    }
    return out;
  }

  async imageInfo(profile: SandboxProfileId): Promise<ImageInfo> {
    const none: ImageInfo = { present: false, digestMatches: false };
    if (!(await this.cli.binary())) return none;
    const ls = await this.cli.run(['image', 'ls', '--no-trunc', '--filter', `label=nexus.profile=${profile}`, '--format', '{{.ID}}'], { timeoutMs: 15_000 });
    const id = ls.code === 0 ? ls.stdout.split(/\r?\n/).map((x) => x.trim()).find((x) => /^sha256:[0-9a-f]{64}$/.test(x)) : undefined;
    if (!id) return none;
    const ins = await this.cli.run(['image', 'inspect', id], { timeoutMs: 15_000 });
    const rec = parseJsonOut(ins.stdout);
    const img = Array.isArray(rec) && isObj(rec[0]) ? rec[0] : null;
    if (!img) return none;
    const labels = labelsOf(isObj(img.Config) ? img.Config.Labels : null);
    const ctx = labels['nexus.context-sha256'];
    return { present: true, digestMatches: true, imageId: id,
      ...(Number.isSafeInteger(img.Size) ? { sizeBytes: img.Size as number } : {}),
      ...(typeof ctx === 'string' && /^[0-9a-f]{64}$/.test(ctx) ? { contextSha256: ctx } : {}) };
  }

  async imageStatus(profile: SandboxProfileId): Promise<{ present: boolean; digestMatches: boolean; sizeBytes?: number }> {
    const i = await this.imageInfo(profile);
    return { present: i.present, digestMatches: i.digestMatches, ...(i.sizeBytes !== undefined ? { sizeBytes: i.sizeBytes } : {}) };
  }

  // eslint-disable-next-line require-yield
  async *prepareImage(): AsyncIterable<{ phase: string; bytes?: number }> {
    throw new Error('image builds run through the image builder');
  }

  async create(spec: ContainerSpec, o: CreateOptions = {}): Promise<{ containerId: string }> {
    const r = await this.ok('create', createArgv(spec, o), { timeoutMs: 120_000 });
    const id = r.stdout.trim().split(/\s+/).pop() ?? '';
    if (!CONTAINER_ID_RE.test(id)) throw new DockerError('create', 'no container id was printed');
    return { containerId: id };
  }

  private async inspectRaw(id: string): Promise<Record<string, unknown> | null> {
    const r = await this.call('inspect', ['inspect', '--type', 'container', id], { timeoutMs: 30_000 });
    if (r.code !== 0) {
      if (classifyDockerError(r.stderr) === 'not_found') return null;
      throw new DockerError('inspect', r.stderr);
    }
    const v = parseJsonOut(r.stdout);
    return Array.isArray(v) && v.length === 1 && isObj(v[0]) ? v[0] : null;
  }

  async preflight(containerId: string, spec: ContainerSpec): Promise<PreflightReport> {
    const r = await this.call('inspect', ['inspect', '--type', 'container', containerId], { timeoutMs: 30_000 });
    return comparePreflight(spec, r.code === 0 ? parseJsonOut(r.stdout) : null);
  }

  async start(containerId: string): Promise<void> { await this.ok('start', ['start', containerId], { timeoutMs: 120_000 }); }

  async exec(containerId: string, argv: string[], o: { timeoutMs: number; signal: AbortSignal; maxOutputBytes: number }):
    Promise<{ exit: ExitInfo; stdout: string; stderr: string; truncated: boolean }> {
    const r = await this.call('exec', ['exec', containerId, ...argv], { timeoutMs: o.timeoutMs, maxStdout: o.maxOutputBytes, signal: o.signal });
    return { exit: { code: r.code, oomKilled: false, finishedAt: this.o.now() }, stdout: r.stdout, stderr: r.stderr.slice(0, o.maxOutputBytes), truncated: r.truncated };
  }

  private exitOf(state: Record<string, unknown>): ExitInfo {
    const code = Number.isSafeInteger(state.ExitCode) ? state.ExitCode as number : null;
    const t = typeof state.FinishedAt === 'string' ? Date.parse(state.FinishedAt) : NaN;
    return { code, oomKilled: state.OOMKilled === true, finishedAt: Number.isFinite(t) && t > 0 ? t : this.o.now() };
  }

  async wait(containerId: string, signal: AbortSignal): Promise<ExitInfo> {
    const r = await this.call('wait', ['wait', containerId], { timeoutMs: 0, signal });
    if (r.aborted) throw new DockerError('wait', 'stopped waiting');
    const rec = await this.inspectRaw(containerId);
    if (!rec || !isObj(rec.State)) {
      const code = Number(r.stdout.trim());
      return { code: Number.isSafeInteger(code) ? code : null, oomKilled: false, finishedAt: this.o.now() };
    }
    return this.exitOf(rec.State);
  }

  async inspect(containerId: string): Promise<{ state: 'created' | 'running' | 'exited' | 'missing'; exit?: ExitInfo; restartCount: number }> {
    const rec = await this.inspectRaw(containerId);
    if (!rec || !isObj(rec.State)) return { state: 'missing', restartCount: 0 };
    const st = String(rec.State.Status ?? '');
    const restartCount = Number.isSafeInteger(rec.RestartCount) ? rec.RestartCount as number : 0;
    if (st === 'created') return { state: 'created', restartCount };
    if (st === 'exited' || st === 'dead') return { state: 'exited', exit: this.exitOf(rec.State), restartCount };
    return { state: 'running', restartCount };
  }

  async stop(containerId: string, graceMs: number): Promise<void> {
    const s = Math.max(0, Math.ceil(graceMs / 1000));
    await this.ok('stop', ['stop', '-t', String(s), containerId], { timeoutMs: (s + 30) * 1000, ignore: ['not_found'] });
  }

  async kill(containerId: string): Promise<void> {
    const r = await this.call('kill', ['kill', containerId], { timeoutMs: 30_000 });
    if (r.code !== 0 && !/is not running|no such container/i.test(r.stderr)) throw new DockerError('kill', r.stderr);
  }

  async remove(containerId: string): Promise<void> { await this.ok('rm', ['rm', '-f', containerId], { timeoutMs: 60_000, ignore: ['not_found'] }); }

  async createVolume(name: string, labels: Record<string, string>): Promise<void> {
    if (!NAME_RE.test(name)) throw new SpecError('not a nexus volume name');
    const ins = await this.call('volume inspect', ['volume', 'inspect', name], { timeoutMs: 30_000 });
    if (ins.code === 0) return;
    await this.ok('volume create', ['volume', 'create', ...labelArgs(labels), name], { timeoutMs: 60_000 });
  }

  async removeVolume(name: string): Promise<void> {
    if (!RESOURCE_RE.test(name)) return;
    await this.ok('volume rm', ['volume', 'rm', name], { timeoutMs: 60_000, ignore: ['not_found'] });
  }

  async createNetwork(name: string, labels: Record<string, string>, o: { internal: boolean }): Promise<void> {
    if (!NAME_RE.test(name)) throw new SpecError('not a nexus network name');
    const ins = await this.call('network inspect', ['network', 'inspect', name], { timeoutMs: 30_000 });
    if (ins.code === 0) return;
    await this.ok('network create', ['network', 'create', '--driver', 'bridge', ...(o.internal ? ['--internal'] : []), ...labelArgs(labels), name],
      { timeoutMs: 60_000 });
  }

  async removeNetwork(name: string): Promise<void> {
    if (!RESOURCE_RE.test(name)) return;
    await this.ok('network rm', ['network', 'rm', name], { timeoutMs: 60_000, ignore: ['not_found'] });
  }

  private filters(labels: Record<string, string>): string[] {
    const out = ['--filter', 'label=nexus.attempt'];
    for (const k of Object.keys(labels).sort()) {
      if (!LABEL_KEY_RE.test(k) || /[\r\n\0=]/.test(labels[k])) throw new SpecError('a label filter is not allowed');
      out.push('--filter', `label=${k}=${labels[k]}`);
    }
    return out;
  }

  async listByLabels(labels: Partial<ContainerLabels>): Promise<{ containerId: string; labels: Record<string, string>; state: string }[]> {
    const facts = await this.listKind('container', labels as Record<string, string>);
    return facts.map((f) => ({ containerId: f.id, labels: f.labels, state: f.state ?? 'missing' }));
  }

  private async listKind(kind: ResourceKind, labels: Record<string, string>): Promise<ResourceFacts[]> {
    const f = this.filters(labels);
    const argv = kind === 'container' ? ['ps', '-a', '-q', '--no-trunc', ...f]
      : kind === 'volume' ? ['volume', 'ls', '-q', ...f] : ['network', 'ls', '-q', '--no-trunc', ...f];
    const r = await this.ok(`${kind} list`, argv, { timeoutMs: 30_000 });
    const ids = r.stdout.split(/\r?\n/).map((x) => x.trim()).filter((x) => RESOURCE_RE.test(x));
    const out: ResourceFacts[] = [];
    for (const id of ids) {
      const fact = await this.inspectResource(kind, id);
      // Belt and braces: only resources that really carry every requested label and an attempt label.
      if (fact && fact.labels['nexus.attempt'] && Object.entries(labels).every(([k, v]) => fact.labels[k] === v)) out.push(fact);
    }
    return out;
  }

  async listResources(labels: Record<string, string>): Promise<ResourceFacts[]> {
    return [...await this.listKind('container', labels), ...await this.listKind('volume', labels), ...await this.listKind('network', labels)];
  }

  async inspectResource(kind: ResourceKind, id: string): Promise<ResourceFacts | null> {
    if (!RESOURCE_RE.test(id)) return null;
    if (kind === 'container') {
      const rec = await this.inspectRaw(id);
      if (!rec) return null;
      const st = isObj(rec.State) ? rec.State : {};
      const status = String(st.Status ?? '');
      const state = status === 'created' ? 'created' : status === 'exited' || status === 'dead' ? 'exited' : 'running';
      return { kind, id: String(rec.Id ?? id), name: String(rec.Name ?? '').replace(/^\//, ''), labels: labelsOf(isObj(rec.Config) ? rec.Config.Labels : null),
        state, ...(state === 'exited' ? { exit: this.exitOf(st) } : {}) };
    }
    const r = await this.call(`${kind} inspect`, [kind, 'inspect', id], { timeoutMs: 30_000 });
    if (r.code !== 0) return null;
    const v = parseJsonOut(r.stdout);
    const rec = Array.isArray(v) && isObj(v[0]) ? v[0] : null;
    if (!rec) return null;
    const name = String(rec.Name ?? id);
    return { kind, id: name, name, labels: labelsOf(rec.Labels) };
  }

  async streamLogs(containerId: string, onChunk: (stream: 'stdout' | 'stderr', chunk: string) => void, signal: AbortSignal, sinceMs?: number): Promise<void> {
    const dOut = new StringDecoder('utf8'); const dErr = new StringDecoder('utf8');
    const since = sinceMs !== undefined && Number.isFinite(sinceMs) ? ['--since', new Date(sinceMs).toISOString()] : [];
    await this.cli.run(['logs', '--follow', ...since, containerId], { timeoutMs: 0, maxStdout: 0, signal,
      onStdout: (b) => onChunk('stdout', dOut.write(b)), onStderr: (b) => onChunk('stderr', dErr.write(b)) });
    const a = dOut.end(); const b = dErr.end();
    if (a) onChunk('stdout', a);
    if (b) onChunk('stderr', b);
  }
}

export { SpecError };
