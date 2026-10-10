'use strict';
// A RunnerDriver for tests (B2a Task 11): no Docker, no process. It records every call in order, keeps containers,
// volumes and networks in memory, answers preflight by building a Docker 29-shaped `inspect` record for the spec and
// running the real comparator over it (so a test can break one field), and lets a test drive containers: exit them,
// write their output, or inject Docker's error text into create/start (fault injection).
const loadTs = require('../load-ts.cjs');
const { comparePreflight, expectedNetworkName, expectedEndpoints, dockerDesktopHostPath } = loadTs('src/shared/nexus/preflightCheck.ts');
const { DockerError, containerFacts } = loadTs('src/runner/sandbox/dockerDriver.ts');

const GIB = 2 ** 30;
let seq = 0;
const hex64 = () => { seq++; return (seq.toString(16).padStart(8, '0') + 'ab'.repeat(28)).slice(0, 64); };

/** The `docker inspect` record a correctly created container of `spec` has (Docker Desktop 29.7.2 shapes). */
function inspectFor(spec, id, name) {
  const nets = {};
  for (const n of expectedEndpoints(spec)) nets[n] = { IPAMConfig: null, Links: null, Aliases: null, NetworkID: '', EndpointID: '', Gateway: '', IPAddress: '' };
  const bindings = spec.publish ? { [`${spec.publish.containerPort}/tcp`]: [{ HostIp: spec.publish.hostIp, HostPort: String(spec.publish.hostPort) }] } : {};
  return [{
    Id: id, Name: `/${name}`, Image: spec.image.id, RestartCount: 0,
    State: { Status: 'created', ExitCode: 0, OOMKilled: false, FinishedAt: '0001-01-01T00:00:00Z' },
    Config: { User: '10001:10001', Labels: { ...spec.labels, 'org.opencontainers.image.source': 'fixture' }, Image: spec.image.ref,
      Entrypoint: spec.entrypoint.length ? [...spec.entrypoint] : null, Cmd: [...spec.argv],
      Env: [...Object.entries(spec.env).map(([k, v]) => `${k}=${v}`), ...spec.imageEnv.filter((n) => !(n in spec.env)).map((n) => `${n}=/usr/local/bin`)] },
    HostConfig: {
      NanoCpus: Math.round(spec.limits.cpus * 1e9), Memory: spec.limits.memoryMb * 2 ** 20, MemorySwap: spec.limits.memoryMb * 2 ** 20,
      PidsLimit: spec.limits.pids, NetworkMode: expectedNetworkName(spec), ReadonlyRootfs: true, CapDrop: ['ALL'], CapAdd: null, Privileged: false,
      SecurityOpt: ['no-new-privileges'], Tmpfs: { '/tmp': `rw,noexec,nosuid,size=${spec.limits.tmpfsMb}m,uid=10001`, '/home/nexus': 'rw,nosuid,size=256m,uid=10001' },
      PortBindings: bindings, Devices: [], PidMode: '', UTSMode: '', UsernsMode: '', IpcMode: 'private', CgroupnsMode: 'private',
      RestartPolicy: { Name: 'no', MaximumRetryCount: 0 }, AutoRemove: false, Runtime: 'runc', CgroupParent: '', OomKillDisable: false,
      PublishAllPorts: false, Binds: null, GroupAdd: null, Sysctls: null, Ulimits: null, VolumesFrom: null, DeviceRequests: null, DeviceCgroupRules: null
    },
    Mounts: spec.mounts.map((m) => {
      const host = dockerDesktopHostPath(m.hostPath);
      return host !== null
        ? { Type: 'bind', Source: host, Destination: m.containerPath, Mode: '', RW: !m.readOnly, Propagation: 'rprivate' }
        : { Type: 'volume', Name: m.hostPath, Source: `/var/lib/docker/volumes/${m.hostPath}/_data`, Destination: m.containerPath, Driver: 'local', Mode: 'z', RW: !m.readOnly, Propagation: '' };
    }),
    NetworkSettings: { Networks: nets }
  }];
}

class FakeSandboxDriver {
  constructor(o = {}) {
    this.o = o;
    this.calls = [];
    this.filters = [];
    this.containers = new Map();
    this.volumes = new Map();
    this.networks = new Map();
    this.docker = o.docker ?? 'running';
    this.memoryBytes = o.memoryBytes ?? 8 * GIB;
    this.createFaults = [...(o.createFaults ?? [])];
    this.startFaults = [...(o.startFaults ?? [])];
    this.duKib = o.duKib ?? 4;
    this.images = o.images ?? {};
    this.extra = o.extra ?? [];          // resources a test adds (unlabelled, another install's, ...)
    this.gates = new Map();             // op -> promise the op waits on (slow Docker)
    this.mutateInspect = o.mutateInspect ?? null;
  }
  rec(op, ...args) { this.calls.push({ op, args }); }
  ops() { return this.calls.map((c) => c.op); }
  callsOf(op) { return this.calls.filter((c) => c.op === op); }
  /** Make `op` wait until the returned function is called. */
  gate(op) { let open; const p = new Promise((r) => { open = r; }); this.gates.set(op, p); return () => { this.gates.delete(op); open(); }; }
  async wait4(op) { const g = this.gates.get(op); if (g) await g; }

  async probe() {
    this.rec('probe');
    const gpu = { detected: false, usableInContainers: false };
    if (this.docker !== 'running') return { docker: this.docker, gpu };
    return { docker: 'running', version: '29.7.2', os: 'Docker Desktop', wsl2: true, cpus: 16, memoryBytes: this.memoryBytes, gpu };
  }
  async imageInfo(profile) { this.rec('imageInfo', profile); return this.images[profile] ?? { present: false, digestMatches: false }; }
  async imageStatus(profile) { const i = await this.imageInfo(profile); return { present: i.present, digestMatches: i.digestMatches }; }
  async *prepareImage() { throw new Error('not here'); }

  async create(spec, o = {}) {
    this.rec('create', spec, o);
    await this.wait4('create');
    const f = this.createFaults.shift();
    if (f) throw new DockerError('create', f);
    const id = hex64();
    const name = o.name ?? spec.name;
    this.containers.set(id, { id, name, spec, labels: { ...spec.labels }, state: 'created', exit: null, waiters: [], logs: [], logEnd: [], alias: o.alias ?? null });
    return { containerId: id };
  }
  async preflight(id, spec) {
    this.rec('preflight', id, spec);
    await this.wait4('preflight');
    const c = this.containers.get(id);
    let rec = c ? inspectFor(spec, id, c.name) : null;
    if (rec && this.mutateInspect) rec = this.mutateInspect(rec, spec) ?? rec;
    return comparePreflight(spec, rec);
  }
  async start(id) {
    this.rec('start', id);
    const c = this.containers.get(id);
    const f = typeof this.startFaults[0] === 'function' ? this.startFaults.shift()(c) : this.startFaults.shift();
    if (f) throw new DockerError('start', f);
    if (!c) throw new DockerError('start', 'No such container: x');
    c.state = 'running';
    // B2a Task 12: a test may play the container's program (write /out, print, exit) once it runs.
    if (typeof this.o.onStart === 'function') setImmediate(() => { if (c.state === 'running') this.o.onStart(c, this); });
  }
  /** Test helper: the container ends with this exit. */
  exitContainer(id, exit = {}) {
    const c = this.containers.get(id);
    if (!c || c.state === 'exited') return;
    c.state = 'exited';
    c.exit = { code: 0, oomKilled: false, finishedAt: 1_780_000_100_000, ...exit };
    for (const w of c.waiters.splice(0)) w.resolve(c.exit);
    for (const f of c.logEnd.splice(0)) f();
  }
  async wait(id, signal) {
    this.rec('wait', id);
    const c = this.containers.get(id);
    if (!c) throw new DockerError('wait', 'No such container: x');
    if (c.state === 'exited') return c.exit;
    return new Promise((resolve, reject) => {
      const w = { resolve, reject };
      c.waiters.push(w);
      signal?.addEventListener('abort', () => reject(new DockerError('wait', 'stopped waiting')), { once: true });
    });
  }
  async inspect(id) {
    this.rec('inspect', id);
    const c = this.containers.get(id);
    if (!c) return { state: 'missing', restartCount: 0 };
    return { state: c.state, ...(c.state === 'exited' ? { exit: c.exit } : {}), restartCount: 0 };
  }
  /** B2a Task 12: a diagnosis's inspect (the real driver's fact extraction over this container's inspect record). */
  async inspectFacts(id, home) {
    this.rec('inspectFacts', id, home);
    if (this.o.inspectFactsThrows) throw new DockerError('inspect', 'Cannot connect to the Docker daemon');
    const c = this.containers.get(id);
    const owns = (labels) => !!home && labels['nexus.home'] === home && !!labels['nexus.attempt'];
    // As the real driver: the labels first; a container that is not owned is never read further.
    if (!c) {
      const x = this.extra.find((r) => r.kind === 'container' && r.id === id);
      if (!x) return null;
      if (!owns(x.labels)) { this.rec('inspectFacts:labelsOnly', id); return { owned: false }; }
      this.rec('inspectFacts:full', id);
      return { owned: true, facts: containerFacts({ State: { Status: x.state ?? 'running' } }) };
    }
    if (!owns(c.labels)) { this.rec('inspectFacts:labelsOnly', id); return { owned: false }; }
    this.rec('inspectFacts:full', id);
    const rec = inspectFor(c.spec, id, c.name)[0];
    rec.State = { ...rec.State, Status: c.state, ExitCode: c.exit ? c.exit.code : 0, OOMKilled: c.exit ? c.exit.oomKilled : false,
      StartedAt: c.state === 'created' ? '0001-01-01T00:00:00Z' : '2026-10-10T10:00:00.000000000Z', FinishedAt: c.exit ? '2026-10-10T10:05:00.000000000Z' : '0001-01-01T00:00:00Z' };
    return { owned: true, facts: containerFacts(rec) };
  }
  async stop(id, graceMs) { this.rec('stop', id, graceMs); const c = this.containers.get(id); if (c && c.state === 'running') this.exitContainer(id, { code: 143 }); }
  async kill(id) { this.rec('kill', id); const c = this.containers.get(id); if (c && c.state === 'running') this.exitContainer(id, { code: 137 }); }
  async remove(id) {
    this.rec('remove', id);
    const c = this.containers.get(id);
    if (!c) return;
    this.containers.delete(id);
    for (const w of c.waiters.splice(0)) w.reject(new DockerError('wait', 'No such container: x'));
    for (const f of c.logEnd.splice(0)) f();
  }
  async exec(id, argv, o) {
    this.rec('exec', id, argv, o);
    if (/(^|\/)du$/.test(argv[0])) return { exit: { code: 0, oomKilled: false, finishedAt: 0 }, stdout: `${this.duKib}\t/workspace\n`, stderr: '', truncated: false };
    return { exit: { code: 127, oomKilled: false, finishedAt: 0 }, stdout: '', stderr: 'not found', truncated: false };
  }
  async createVolume(name, labels) { this.rec('createVolume', name, labels); if (!this.volumes.has(name)) this.volumes.set(name, { ...labels }); }
  async removeVolume(name) { this.rec('removeVolume', name); this.volumes.delete(name); }
  async createNetwork(name, labels, o) { this.rec('createNetwork', name, labels, o); if (!this.networks.has(name)) this.networks.set(name, { labels: { ...labels }, internal: o.internal }); }
  async removeNetwork(name) { this.rec('removeNetwork', name); this.networks.delete(name); }
  all() {
    return [
      ...[...this.containers.values()].map((c) => ({ kind: 'container', id: c.id, name: c.name, labels: c.labels, state: c.state, ...(c.exit ? { exit: c.exit } : {}) })),
      ...[...this.volumes.entries()].map(([n, l]) => ({ kind: 'volume', id: n, name: n, labels: l })),
      ...[...this.networks.entries()].map(([n, x]) => ({ kind: 'network', id: n, name: n, labels: x.labels })),
      ...this.extra
    ];
  }
  /** As the real driver: always filtered by `label=nexus.attempt` plus the given labels. */
  async listResources(labels) {
    this.rec('listResources', labels);
    this.filters.push(['label=nexus.attempt', ...Object.entries(labels).map(([k, v]) => `label=${k}=${v}`)]);
    if (this.o.listThrows) throw new Error('docker ps failed');
    return this.all().filter((r) => r.labels && r.labels['nexus.attempt'] && Object.entries(labels).every(([k, v]) => r.labels[k] === v));
  }
  async listByLabels(labels) {
    return (await this.listResources(labels)).filter((r) => r.kind === 'container').map((r) => ({ containerId: r.id, labels: r.labels, state: r.state }));
  }
  async inspectResource(kind, id) { this.rec('inspectResource', kind, id); return this.all().find((r) => r.kind === kind && r.id === id) ?? null; }
  /** Test helper: the container prints. */
  emit(id, stream, text) { const c = this.containers.get(id); if (c && c.sink) c.sink(stream, text); else if (c) c.logs.push([stream, text]); }
  async streamLogs(id, onChunk, signal, sinceMs) {
    this.rec('streamLogs', id, sinceMs);
    const c = this.containers.get(id);
    if (!c) return;
    for (const [s, t] of c.logs.splice(0)) onChunk(s, t);
    c.sink = onChunk;
    if (c.state === 'exited') return;
    await new Promise((resolve) => { c.logEnd.push(resolve); signal.addEventListener('abort', resolve, { once: true }); });
    c.sink = null;
  }
}

module.exports = { FakeSandboxDriver, inspectFor };
