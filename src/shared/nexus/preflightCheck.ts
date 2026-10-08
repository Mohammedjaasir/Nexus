// The preflight comparator (pure). Every container is created, inspected and
// only then started; this function compares the `docker inspect` record with
// the spec main built. Any problem means the container is removed and the
// attempt fails `limits_not_applied`. The inspect JSON is untrusted and read
// defensively: a missing or odd-shaped field is a problem, never a pass.

import {
  HOME_TMPFS_MB, HOME_TMPFS_PATH, SANDBOX_UID, SANDBOX_USER, TMP_TMPFS_PATH,
  type ContainerSpec, type PreflightObserved, type PreflightReport
} from './execution';

const MAX_TEXT = 512;
const MAX_ITEMS = 64;

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v);
const clip = (s: string): string => (s.length > MAX_TEXT ? `${s.slice(0, MAX_TEXT - 1)}…` : s);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
/** `null`, absent and `[]` all mean empty; a non-array is `null` (malformed). */
const strList = (v: unknown): string[] | null =>
  v === null || v === undefined ? [] : Array.isArray(v) ? v.map((x) => (typeof x === 'string' ? x : JSON.stringify(x) ?? String(x))) : null;
const show = (v: unknown): string => (v === undefined ? 'unset' : clip(JSON.stringify(v) ?? String(v)));
const mib = (mb: number): number => mb * 2 ** 20;

function emptyObserved(): PreflightObserved {
  return { nanoCpus: 0, memory: 0, memorySwap: 0, pidsLimit: 0, networkMode: '', readonlyRootfs: false, capDrop: [], capAdd: [],
    privileged: false, user: '', securityOpt: [], mounts: [], portBindings: [], tmpfs: [], devices: [] };
}

function finish(observed: PreflightObserved, problems: string[]): PreflightReport {
  const cut = <T>(xs: T[]): T[] => xs.slice(0, MAX_ITEMS);
  const out: PreflightObserved = {
    ...observed,
    networkMode: clip(observed.networkMode), user: clip(observed.user),
    capDrop: cut(observed.capDrop).map(clip), capAdd: cut(observed.capAdd).map(clip), securityOpt: cut(observed.securityOpt).map(clip),
    mounts: cut(observed.mounts).map((m) => ({ dst: clip(m.dst), rw: m.rw, type: clip(m.type) })),
    portBindings: cut(observed.portBindings).map(clip), tmpfs: cut(observed.tmpfs).map(clip), devices: cut(observed.devices).map(clip)
  };
  const list = problems.length > MAX_ITEMS
    ? [...problems.slice(0, MAX_ITEMS - 1), `and ${problems.length - (MAX_ITEMS - 1)} more problems`]
    : problems;
  return { ok: list.length === 0, observed: out, problems: list.map(clip) };
}

/** The Docker network name a spec's network mode must produce. */
export function expectedNetworkName(spec: ContainerSpec): string {
  const n = spec.network;
  if (n.mode === 'none') return 'none';
  if (n.mode === 'egress-approved') return `nexus-egress-${spec.labels['nexus.job']}`;
  return n.network;
}

const isHostPath = (p: string): boolean => /^[A-Za-z]:[\\/]/.test(p) || p.startsWith('/') || p.startsWith('\\\\');

function tmpfsOptions(spec: ContainerSpec): Record<string, string[]> {
  return {
    [TMP_TMPFS_PATH]: ['rw', 'noexec', 'nosuid', `size=${spec.limits.tmpfsMb}m`, `uid=${SANDBOX_UID}`],
    [HOME_TMPFS_PATH]: ['rw', 'nosuid', `size=${HOME_TMPFS_MB}m`, `uid=${SANDBOX_UID}`]
  };
}
const sameSet = (a: string[], b: string[]): boolean => {
  const sa = new Set(a); const sb = new Set(b);
  return sa.size === a.length && sa.size === sb.size && [...sa].every((x) => sb.has(x));
};

/** Compares a `docker inspect` record (an object, or the one-element array the CLI prints) with the spec. */
export function comparePreflight(spec: ContainerSpec, inspect: unknown): PreflightReport {
  const observed = emptyObserved();
  const problems: string[] = [];
  const record = Array.isArray(inspect) ? (inspect.length === 1 ? inspect[0] : undefined) : inspect;
  if (!isRec(record)) {
    problems.push(Array.isArray(inspect) && inspect.length !== 1
      ? `docker inspect returned ${inspect.length} records, expected 1`
      : 'docker inspect returned no container record');
    return finish(observed, problems);
  }
  const config = record.Config;
  const host = record.HostConfig;
  if (!isRec(config)) problems.push('docker inspect has no Config section');
  if (!isRec(host)) problems.push('docker inspect has no HostConfig section');
  const cfg: Rec = isRec(config) ? config : {};
  const hc: Rec = isRec(host) ? host : {};

  // CPU
  const nanoCpus = num(hc.NanoCpus);
  observed.nanoCpus = nanoCpus ?? 0;
  const wantNano = Math.round(spec.limits.cpus * 1e9);
  if (nanoCpus !== wantNano) problems.push(`cpus limit is ${nanoCpus ? nanoCpus / 1e9 : 'unset'}, expected ${spec.limits.cpus}`);

  // Memory: memory and memory+swap both equal the limit (no swap)
  const wantMem = mib(spec.limits.memoryMb);
  const memory = num(hc.Memory); const swap = num(hc.MemorySwap);
  observed.memory = memory ?? 0; observed.memorySwap = swap ?? 0;
  if (memory !== wantMem) problems.push(`memory limit is ${show(hc.Memory)} bytes, expected ${wantMem}`);
  if (swap !== wantMem) problems.push(`memory swap limit is ${show(hc.MemorySwap)} bytes, expected ${wantMem} (no swap)`);

  // PIDs
  const pids = num(hc.PidsLimit);
  observed.pidsLimit = pids ?? 0;
  if (pids !== spec.limits.pids) problems.push(`pids limit is ${show(hc.PidsLimit)}, expected ${spec.limits.pids}`);

  // Root filesystem
  observed.readonlyRootfs = hc.ReadonlyRootfs === true;
  if (hc.ReadonlyRootfs !== true) problems.push('the read-only root filesystem is not applied');

  // Capabilities and privileges
  const capDrop = strList(hc.CapDrop); const capAdd = strList(hc.CapAdd);
  observed.capDrop = capDrop ?? []; observed.capAdd = capAdd ?? [];
  if (capDrop === null || capDrop.length !== 1 || capDrop[0].toUpperCase() !== 'ALL') problems.push(`capabilities dropped are ${show(hc.CapDrop)}, expected ["ALL"]`);
  if (capAdd === null || capAdd.length > 0) problems.push(`capabilities added: ${show(hc.CapAdd)}, expected none`);
  observed.privileged = hc.Privileged === true;
  if (hc.Privileged !== false) problems.push(hc.Privileged === true ? 'the container is privileged' : `privileged flag is ${show(hc.Privileged)}, expected false`);
  const secOpt = strList(hc.SecurityOpt);
  observed.securityOpt = secOpt ?? [];
  const nnp = (secOpt ?? []).some((o) => /^no-new-privileges(?:[:=]true)?$/.test(o));
  if (!nnp) problems.push('no-new-privileges is not set');
  for (const o of secOpt ?? []) {
    if (/unconfined|label[:=]disable|no-new-privileges[:=]false/i.test(o)) problems.push(`security option ${clip(o)} weakens the sandbox`);
  }
  for (const key of ['PidMode', 'IpcMode', 'UTSMode', 'UsernsMode', 'CgroupnsMode'] as const) {
    if (hc[key] === 'host') problems.push(`${key} shares the host namespace`);
  }

  // User
  const user = str(cfg.User);
  observed.user = user ?? '';
  if (user !== SANDBOX_USER) problems.push(`user is ${user ? clip(user) : 'root (unset)'}, expected ${SANDBOX_USER}`);

  // Network
  const wantNet = expectedNetworkName(spec);
  const netMode = str(hc.NetworkMode);
  observed.networkMode = netMode ?? '';
  if (netMode !== wantNet) problems.push(`network is ${netMode ?? 'unset'}, expected ${wantNet}`);
  const settings = record.NetworkSettings;
  const networks = isRec(settings) && isRec(settings.Networks) ? Object.keys(settings.Networks)
    : isRec(settings) && (settings.Networks === null || settings.Networks === undefined) ? [] : null;
  if (networks === null) problems.push('network settings are unreadable');
  else for (const n of networks) if (n !== wantNet) problems.push(`network endpoint ${clip(n)} is attached, expected only ${wantNet}`);

  // Mounts: exactly the spec's set (destination, RW flag, type)
  const mounts = Array.isArray(record.Mounts) ? record.Mounts : record.Mounts === null || record.Mounts === undefined ? [] : null;
  if (mounts === null) problems.push('mounts are unreadable');
  const seen = new Map<string, { rw: boolean; type: string }>();
  for (const m of mounts ?? []) {
    const dst = isRec(m) ? str(m.Destination) : null;
    if (!isRec(m) || dst === null) { problems.push('a mount has no destination'); continue; }
    const rw = m.RW === true; const type = str(m.Type) ?? '';
    observed.mounts.push({ dst, rw, type });
    if (seen.has(dst)) problems.push(`mount ${clip(dst)} appears twice`);
    seen.set(dst, { rw, type });
  }
  const wanted = new Set<string>();
  for (const w of spec.mounts) {
    wanted.add(w.containerPath);
    const got = seen.get(w.containerPath);
    const wantType = isHostPath(w.hostPath) ? 'bind' : 'volume';
    if (!got) { problems.push(`mount ${clip(w.containerPath)} is missing`); continue; }
    if (got.rw === w.readOnly) problems.push(`mount ${clip(w.containerPath)} is ${got.rw ? 'read-write' : 'read-only'}, expected ${w.readOnly ? 'read-only' : 'read-write'}`);
    if (got.type !== wantType) problems.push(`mount ${clip(w.containerPath)} is a ${got.type || 'unknown'} mount, expected ${wantType}`);
  }
  for (const dst of seen.keys()) if (!wanted.has(dst)) problems.push(`unexpected mount ${clip(dst)}`);
  const volumesFrom = strList(hc.VolumesFrom);
  if (volumesFrom === null || volumesFrom.length > 0) problems.push('mounts from other containers are present');

  // Published ports: none, except the forwarder's single loopback binding
  const bindings: { port: string; ip: string; hostPort: string }[] = [];
  const pb = hc.PortBindings;
  if (isRec(pb)) {
    for (const [port, list] of Object.entries(pb)) {
      if (list === null) continue;
      if (!Array.isArray(list)) { problems.push(`port ${clip(port)} binding is unreadable`); continue; }
      for (const b of list) {
        const ip = isRec(b) ? str(b.HostIp) ?? '' : ''; const hostPort = isRec(b) ? str(b.HostPort) ?? '' : '';
        bindings.push({ port, ip, hostPort });
      }
    }
  } else if (pb !== null && pb !== undefined) problems.push('port bindings are unreadable');
  observed.portBindings = bindings.map((b) => `${b.ip || '0.0.0.0'}:${b.hostPort}->${b.port}`);
  const pub = spec.publish;
  for (const b of bindings) {
    const allowed = pub && b.ip === pub.hostIp && b.hostPort === String(pub.hostPort) && b.port === `${pub.containerPort}/tcp`;
    if (!allowed) problems.push(`port ${clip(b.port)} is published on ${b.ip || '0.0.0.0'}:${clip(b.hostPort)}, which the spec does not allow`);
  }
  if (pub && !bindings.some((b) => b.ip === pub.hostIp && b.hostPort === String(pub.hostPort) && b.port === `${pub.containerPort}/tcp`)) {
    problems.push(`port ${pub.containerPort}/tcp is not published on ${pub.hostIp}:${pub.hostPort}`);
  }
  if (hc.PublishAllPorts === true) problems.push('all exposed ports are published');

  // tmpfs: exactly /tmp and /home/nexus with exact options
  const want = tmpfsOptions(spec);
  const tmpfs = hc.Tmpfs;
  const tm: Rec = isRec(tmpfs) ? tmpfs : {};
  if (!isRec(tmpfs)) problems.push(`tmpfs mounts are ${tmpfs === null || tmpfs === undefined ? 'missing' : 'unreadable'}`);
  for (const [path, opts] of Object.entries(tm)) {
    observed.tmpfs.push(`${path}:${typeof opts === 'string' ? opts : show(opts)}`);
    if (!(path in want)) problems.push(`unexpected tmpfs ${clip(path)}`);
  }
  if (isRec(tmpfs)) {
    for (const [path, opts] of Object.entries(want)) {
      const got = tm[path];
      if (typeof got !== 'string') { problems.push(`tmpfs ${path} is missing`); continue; }
      const parts = got.split(',').map((s) => s.trim()).filter(Boolean);
      if (!sameSet(parts, opts)) problems.push(`tmpfs ${path} options are "${clip(got)}", expected "${opts.join(',')}"`);
    }
  }

  // Devices
  const devices = hc.Devices;
  if (Array.isArray(devices)) {
    for (const d of devices) {
      const p = isRec(d) ? str(d.PathOnHost) ?? show(d) : show(d);
      observed.devices.push(p);
      problems.push(`device ${clip(p)} is passed into the container`);
    }
  } else if (devices !== null && devices !== undefined) problems.push('the device list is unreadable');
  const requests = hc.DeviceRequests;
  if (Array.isArray(requests) ? requests.length > 0 : requests !== null && requests !== undefined) problems.push('device requests (such as GPUs) are present');
  const rules = hc.DeviceCgroupRules;
  if (Array.isArray(rules) ? rules.length > 0 : rules !== null && rules !== undefined) problems.push('device cgroup rules are present');

  // Labels: every spec label present with its exact value (image labels may add others)
  const labels = isRec(cfg.Labels) ? cfg.Labels : null;
  if (labels === null) problems.push('the container has no labels');
  for (const [key, value] of Object.entries(spec.labels)) {
    if (labels === null) break;
    if (!Object.prototype.hasOwnProperty.call(labels, key)) problems.push(`label ${key} is missing`);
    else if (labels[key] !== value) problems.push(`label ${key} is ${show(labels[key])}, expected ${show(value)}`);
  }

  return finish(observed, problems);
}
