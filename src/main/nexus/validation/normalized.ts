/**
 * Re-validation of what the runner's parsers report (constraint 4: main never trusts the runner's
 * parse). Every function here is pure: it takes the `normalized` value of a `ParsedOutput` (already
 * bounded by `parseRunnerMessage`) and returns a fresh, typed copy, or the reason it is refused.
 *
 * - A bad SHAPE (a wrong type, a missing field, a value out of bounds) is `parser_contract`: the
 *   validator that reads it records `error` (the check could not run on trustworthy facts).
 * - A well-shaped report whose numbers disagree (JUnit counts) is NOT refused here: the validator
 *   decides that it FAILS (`counts_mismatch`). Shape and meaning are judged separately.
 * - Nothing here reads a file, a clock or the database.
 *
 * The validator outcome type and its small builders live here too, so the validators share one shape.
 */
import type { Evidence, ValidationStatus } from '../../../shared/nexus/evidence';

/** What one validator decided, before the service stamps ids, times and bindings on it. */
export interface ValidatorOutcome {
  status: ValidationStatus;
  /** A short machine reason (`no_tests`, `counts_mismatch`, `parser_contract`, ...); null when passed. */
  reason: string | null;
  summary: string;
  evidence: Evidence[];
}
export const passed = (summary: string, evidence: Evidence[] = []): ValidatorOutcome => ({ status: 'passed', reason: null, summary, evidence });
export const failed = (reason: string, summary: string, evidence: Evidence[] = []): ValidatorOutcome => ({ status: 'failed', reason, summary, evidence });
/** The check could not run: never a pass. */
export const errored = (reason: string, summary: string, evidence: Evidence[] = []): ValidatorOutcome => ({ status: 'error', reason, summary, evidence });

export type Checked<T> = { ok: true; value: T } | { ok: false; reason: 'parser_contract'; message: string };
const bad = (message: string): { ok: false; reason: 'parser_contract'; message: string } => ({ ok: false, reason: 'parser_contract', message });

export const SHA256_RE = /^[0-9a-f]{64}$/;
export const COMMIT_RE = /^[0-9a-f]{40}$/;
export const MAX_CASES = 20_000;
export const MAX_DISCOVERED = 20_000;
export const MAX_FACT_STRING = 1024;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const isText = (v: unknown, max = MAX_FACT_STRING): v is string => typeof v === 'string' && v.length <= max && !v.includes('\0');

// ---------- JUnit ----------

export type CaseOutcome = 'passed' | 'failed' | 'errored' | 'skipped';
export const CASE_OUTCOMES: readonly CaseOutcome[] = ['passed', 'failed', 'errored', 'skipped'];
export interface JunitCase { id: string; file: string | null; classname: string; name: string; outcome: CaseOutcome; ms: number }
export interface NormalizedJunit {
  sha256: string; total: number; passed: number; failed: number; errored: number; skipped: number;
  cases: JunitCase[];
  /** The `tests` attributes of the report, summed (null when the report had none). */
  declaredTotal: number | null;
  /** The runner's own flag that the attributes disagree with the rows. */
  countsMismatch: boolean;
}

/** The runner's normalized JUnit: `{ sha256, total, passed, failed, errored, skipped, cases: [{ id, file?, classname, name, outcome, ms }] }`. */
export function checkJunit(x: unknown): Checked<NormalizedJunit> {
  if (!isObj(x)) return bad('the JUnit result is not an object');
  if (typeof x.sha256 !== 'string' || !SHA256_RE.test(x.sha256)) return bad('the JUnit result has no sha256');
  for (const k of ['total', 'passed', 'failed', 'errored', 'skipped'] as const) if (!isCount(x[k])) return bad(`the JUnit count ${k} is not a count`);
  if (!Array.isArray(x.cases) || x.cases.length > MAX_CASES) return bad('the JUnit cases are not a bounded list');
  const cases: JunitCase[] = [];
  for (const c of x.cases as unknown[]) {
    if (!isObj(c)) return bad('a JUnit case is not an object');
    if (!isText(c.id) || c.id.length === 0 || !isText(c.classname) || !isText(c.name)) return bad('a JUnit case has a bad id, class or name');
    if (c.file !== undefined && c.file !== null && !isText(c.file)) return bad('a JUnit case has a bad file');
    if (typeof c.outcome !== 'string' || !(CASE_OUTCOMES as readonly string[]).includes(c.outcome)) return bad('a JUnit case has an unknown outcome');
    if (typeof c.ms !== 'number' || !Number.isFinite(c.ms) || c.ms < 0) return bad('a JUnit case has a bad duration');
    cases.push({ id: c.id, file: typeof c.file === 'string' && c.file.length > 0 ? c.file : null, classname: c.classname, name: c.name,
      outcome: c.outcome as CaseOutcome, ms: c.ms });
  }
  if (x.declaredTotal !== undefined && x.declaredTotal !== null && !isCount(x.declaredTotal)) return bad('the declared total is not a count');
  if (x.countsMismatch !== undefined && typeof x.countsMismatch !== 'boolean') return bad('countsMismatch is not a boolean');
  return { ok: true, value: {
    sha256: x.sha256, total: x.total as number, passed: x.passed as number, failed: x.failed as number, errored: x.errored as number,
    skipped: x.skipped as number, cases, declaredTotal: typeof x.declaredTotal === 'number' ? x.declaredTotal : null,
    countsMismatch: x.countsMismatch === true
  } };
}

/** Whether the counts agree with each other and with the rows (the validator fails `counts_mismatch` otherwise). */
export function junitCountsAgree(j: NormalizedJunit): boolean {
  if (j.countsMismatch) return false;
  if (j.total !== j.cases.length) return false;
  if (j.declaredTotal !== null && j.declaredTotal !== j.cases.length) return false;
  if (j.passed + j.failed + j.errored + j.skipped !== j.total) return false;
  const by = (o: CaseOutcome): number => j.cases.filter((c) => c.outcome === o).length;
  return by('passed') === j.passed && by('failed') === j.failed && by('errored') === j.errored && by('skipped') === j.skipped;
}

// ---------- discovery ----------

export const TEST_FRAMEWORKS = ['node-test', 'jest', 'vitest', 'mocha', 'pytest'] as const;
export type DiscoveryFramework = (typeof TEST_FRAMEWORKS)[number];
export interface NormalizedDiscovery { framework: DiscoveryFramework; ids: string[]; files: string[] }

/** The runner's normalized discovery: `{ framework, ids: string[], files: string[] }`. */
export function checkDiscovery(x: unknown): Checked<NormalizedDiscovery> {
  if (!isObj(x)) return bad('the discovery result is not an object');
  if (typeof x.framework !== 'string' || !(TEST_FRAMEWORKS as readonly string[]).includes(x.framework)) return bad('the discovery framework is unknown');
  const list = (v: unknown): string[] | null => {
    if (!Array.isArray(v) || v.length > MAX_DISCOVERED) return null;
    const out: string[] = [];
    for (const s of v) { if (!isText(s, 512) || s.length === 0) return null; out.push(s); }
    return new Set(out).size === out.length ? out : null;
  };
  const ids = list(x.ids); const files = list(x.files);
  if (!ids || !files) return bad('the discovered ids or files are not a bounded list of distinct names');
  return { ok: true, value: { framework: x.framework as DiscoveryFramework, ids, files } };
}

// ---------- repository facts ----------

export interface GitFacts { commit: string; branch: string | null; dirty: boolean; tree: string }

/** The runner's snapshot facts: `{ commit, branch, dirty, tree }` (full hashes, a short branch name or null). */
export function checkGitFacts(x: unknown): Checked<GitFacts> {
  if (!isObj(x)) return bad('the snapshot facts are not an object');
  if (typeof x.commit !== 'string' || !COMMIT_RE.test(x.commit)) return bad('the commit is not a full hash');
  if (typeof x.tree !== 'string' || !COMMIT_RE.test(x.tree)) return bad('the tree is not a full hash');
  if (typeof x.dirty !== 'boolean') return bad('the dirty flag is not a boolean');
  if (x.branch !== null && (!isText(x.branch, 255) || x.branch.length === 0)) return bad('the branch is not a short name');
  return { ok: true, value: { commit: x.commit, branch: x.branch as string | null, dirty: x.dirty, tree: x.tree } };
}

// ---------- application manifest (nexus.app.json) ----------

export interface AppManifest {
  version: 1; profile: 'sde-node' | 'sde-python'; run: string[]; port: number; healthPath: string; env: string[];
  build?: { outputDir: string };
}
const ENV_NAME_RE = /^[A-Z_][A-Z0-9_]{0,63}$/;
const HEALTH_RE = /^\/[A-Za-z0-9/_.-]{0,200}$/;

/** Every way a manifest breaks the `nexus.app.json` schema (empty when it is valid). */
export function appManifestErrors(x: unknown): { path: string; message: string }[] {
  const e: { path: string; message: string }[] = [];
  if (!isObj(x)) return [{ path: '', message: 'the manifest is not an object' }];
  for (const k of Object.keys(x)) if (!['version', 'profile', 'run', 'port', 'healthPath', 'env', 'build'].includes(k)) e.push({ path: `/${k.slice(0, 64)}`, message: 'unknown field' });
  if (x.version !== 1) e.push({ path: '/version', message: 'must be 1' });
  if (x.profile !== 'sde-node' && x.profile !== 'sde-python') e.push({ path: '/profile', message: 'must be sde-node or sde-python' });
  if (!Array.isArray(x.run) || x.run.length < 1 || x.run.length > 32
    || !x.run.every((a) => typeof a === 'string' && a.length > 0 && a.length <= 512 && !a.includes('\0'))) {
    e.push({ path: '/run', message: 'must be 1 to 32 arguments of at most 512 characters' });
  }
  if (typeof x.port !== 'number' || !Number.isInteger(x.port) || x.port < 1024 || x.port > 65535) e.push({ path: '/port', message: 'must be 1024 to 65535' });
  if (typeof x.healthPath !== 'string' || !HEALTH_RE.test(x.healthPath)) e.push({ path: '/healthPath', message: 'must be a plain absolute path' });
  if (x.env !== undefined) {
    if (!Array.isArray(x.env) || x.env.length > 64 || !x.env.every((n) => typeof n === 'string' && ENV_NAME_RE.test(n))) {
      e.push({ path: '/env', message: 'must be a list of environment variable names (values are never accepted)' });
    }
  }
  if (x.build !== undefined) {
    const b = x.build;
    if (!isObj(b) || Object.keys(b).some((k) => k !== 'outputDir') || typeof b.outputDir !== 'string' || b.outputDir.length === 0
      || b.outputDir.length > 200 || b.outputDir.startsWith('/') || b.outputDir.includes('\\') || b.outputDir.split('/').some((s) => s === '..' || s === '')) {
      e.push({ path: '/build', message: 'must be { outputDir: a relative path }' });
    }
  }
  return e;
}

// ---------- dev deployment health facts ----------

export interface HealthProbe { at: number; status: number | null; ms: number | null }
export interface HealthFacts {
  path: string; startedAt: number; probes: HealthProbe[];
  container: 'running' | 'exited' | 'missing'; bindAddress: string;
}

/** The deployment's observed facts: `{ path, startedAt, probes: [{ at, status, ms }], container, bindAddress }`. */
export function checkHealthFacts(x: unknown): Checked<HealthFacts> {
  if (!isObj(x)) return bad('the health facts are not an object');
  if (typeof x.path !== 'string' || !HEALTH_RE.test(x.path)) return bad('the health path is not a plain path');
  if (typeof x.startedAt !== 'number' || !Number.isFinite(x.startedAt)) return bad('the start time is not a time');
  if (!Array.isArray(x.probes) || x.probes.length > 10_000) return bad('the probes are not a bounded list');
  const probes: HealthProbe[] = [];
  for (const p of x.probes as unknown[]) {
    if (!isObj(p) || typeof p.at !== 'number' || !Number.isFinite(p.at)) return bad('a probe has no time');
    if (p.status !== null && (typeof p.status !== 'number' || !Number.isInteger(p.status) || p.status < 100 || p.status > 599)) return bad('a probe has a bad status');
    if (p.ms !== null && (typeof p.ms !== 'number' || !Number.isFinite(p.ms) || p.ms < 0)) return bad('a probe has a bad latency');
    probes.push({ at: p.at, status: p.status as number | null, ms: p.ms as number | null });
  }
  if (x.container !== 'running' && x.container !== 'exited' && x.container !== 'missing') return bad('the container state is unknown');
  if (!isText(x.bindAddress, 64)) return bad('the bind address is not text');
  return { ok: true, value: { path: x.path, startedAt: x.startedAt, probes, container: x.container, bindAddress: x.bindAddress } };
}

// ---------- diagnosis (sde.diagnose, B2a Task 12) ----------

export const DIAG_FACT_STATES = ['created', 'running', 'exited', 'restarting', 'paused', 'dead', 'removing', 'unknown'] as const;
export interface DiagFacts {
  state: (typeof DIAG_FACT_STATES)[number]; exitCode: number | null; oomKilled: boolean; restartCount: number;
  startedAt: string | null; finishedAt: string | null; image: { sha256: string } | null;
  nanoCpus: number | null; memoryBytes: number | null; pidsLimit: number | null;
  networkMode: string | null; readonlyRootfs: boolean | null; user: string | null; publishedPorts: string[];
}
export interface NormalizedDiagnosis {
  target: 'deployment' | 'job';
  containers: { container: { sha256: string }; status: 'inspected' | 'missing' | 'not_owned' | 'unavailable'; facts: DiagFacts | null }[];
  logs: { attemptId: string; status: 'read' | 'missing' | 'refused'; offset: number; length: number; sha256: string | null;
    frames: number; errorFrames: number; lastText: string | null }[];
}
const DIAG_MAX_CONTAINERS = 4;
const DIAG_MAX_RANGES = 4;
const DIAG_RANGE_MAX = 256 * 1024;
const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v);
const optText = (v: unknown, max: number): boolean => v === null || isText(v, max);

/**
 * The runner's diagnosis: `{ target, containers: [{ container: { sha256 }, status, facts }], logs: [{ attemptId, status,
 * offset, length, sha256, frames, errorFrames, lastText }] }`, every bound re-checked (a fresh copy is returned).
 */
export function checkDiagnosis(x: unknown): Checked<NormalizedDiagnosis> {
  if (!isObj(x)) return bad('the diagnosis is not an object');
  if (x.target !== 'deployment' && x.target !== 'job') return bad('the diagnosis target is unknown');
  if (!Array.isArray(x.containers) || x.containers.length > DIAG_MAX_CONTAINERS) return bad('the diagnosed containers are not a bounded list');
  if (!Array.isArray(x.logs) || x.logs.length > DIAG_MAX_RANGES) return bad('the log ranges are not a bounded list');
  const containers: NormalizedDiagnosis['containers'] = [];
  for (const c of x.containers as unknown[]) {
    if (!isObj(c) || !isObj(c.container) || typeof c.container.sha256 !== 'string' || !SHA256_RE.test(c.container.sha256)) return bad('a container has no id');
    if (!['inspected', 'missing', 'not_owned', 'unavailable'].includes(String(c.status))) return bad('a container status is unknown');
    let facts: DiagFacts | null = null;
    if (c.status === 'inspected') {
      const f = c.facts;
      if (!isObj(f) || !(DIAG_FACT_STATES as readonly string[]).includes(String(f.state))) return bad('inspected facts are missing');
      if (!(f.exitCode === null || isInt(f.exitCode)) || typeof f.oomKilled !== 'boolean' || !isCount(f.restartCount)) return bad('the exit facts are malformed');
      if (!optText(f.startedAt, 64) || !optText(f.finishedAt, 64) || !optText(f.networkMode, 128) || !optText(f.user, 64)) return bad('a text fact is malformed');
      if (!(f.image === null || (isObj(f.image) && typeof f.image.sha256 === 'string' && SHA256_RE.test(f.image.sha256)))) return bad('the image fact is malformed');
      for (const k of ['nanoCpus', 'memoryBytes', 'pidsLimit'] as const) if (!(f[k] === null || isInt(f[k]))) return bad(`the ${k} fact is malformed`);
      if (!(f.readonlyRootfs === null || typeof f.readonlyRootfs === 'boolean')) return bad('the read-only fact is malformed');
      if (!Array.isArray(f.publishedPorts) || f.publishedPorts.length > 8 || !f.publishedPorts.every((p) => isText(p, 80))) return bad('the published ports are malformed');
      facts = { state: f.state as DiagFacts['state'], exitCode: f.exitCode as number | null, oomKilled: f.oomKilled, restartCount: f.restartCount as number,
        startedAt: f.startedAt as string | null, finishedAt: f.finishedAt as string | null,
        image: f.image === null ? null : { sha256: (f.image as { sha256: string }).sha256 },
        nanoCpus: f.nanoCpus as number | null, memoryBytes: f.memoryBytes as number | null, pidsLimit: f.pidsLimit as number | null,
        networkMode: f.networkMode as string | null, readonlyRootfs: f.readonlyRootfs as boolean | null, user: f.user as string | null,
        publishedPorts: [...(f.publishedPorts as string[])] };
    } else if (c.facts !== null) return bad('only an inspected container carries facts');
    containers.push({ container: { sha256: c.container.sha256 }, status: c.status as NormalizedDiagnosis['containers'][number]['status'], facts });
  }
  const logs: NormalizedDiagnosis['logs'] = [];
  for (const l of x.logs as unknown[]) {
    if (!isObj(l) || !isText(l.attemptId, 64) || l.attemptId.length === 0) return bad('a log range names no attempt');
    if (!['read', 'missing', 'refused'].includes(String(l.status))) return bad('a log range status is unknown');
    if (!isCount(l.offset) || !isCount(l.length) || (l.length as number) > DIAG_RANGE_MAX) return bad('a log range is out of bounds');
    if (!isCount(l.frames) || !isCount(l.errorFrames) || (l.errorFrames as number) > (l.frames as number)) return bad('the frame counts are malformed');
    if (l.status === 'read' ? (typeof l.sha256 !== 'string' || !SHA256_RE.test(l.sha256)) : l.sha256 !== null) return bad('a log range hash is malformed');
    if (!optText(l.lastText, 200)) return bad('the last line is malformed');
    logs.push({ attemptId: l.attemptId, status: l.status as NormalizedDiagnosis['logs'][number]['status'], offset: l.offset as number, length: l.length as number,
      sha256: l.sha256 as string | null, frames: l.frames as number, errorFrames: l.errorFrames as number, lastText: l.lastText as string | null });
  }
  return { ok: true, value: { target: x.target, containers, logs } };
}
