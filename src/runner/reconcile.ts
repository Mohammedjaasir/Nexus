/**
 * The runner's side of restart recovery (B2a Task 11; RUNNER_RECOVERY_CONTRACT in src/main/nexus/exec/recovery.ts).
 *
 * - `reconcileAnswer`: the `reconcile.result` for main's `reconcile.list`. Docker not running: every attempt is reported
 *   `missing` and nothing is listed. Otherwise the containers, volumes and networks labelled with this install's
 *   `nexus.home` AND a `nexus.attempt` (the driver always filters by label; an unlabelled resource is never listed) are
 *   `labelled` (their `nexus.*` labels only); each asked attempt reports the container found under its labels (the
 *   recorded id, else the one of its kind), its state, its exit from inspect, and, for an exited tool container whose
 *   `/out` re-hashes cleanly, the COMPLETE staged list (omitted otherwise, never truncated); a per-file node:test run's
 *   reports are merged first, exactly as the live collect merges them (junitMerge.ts).
 * - `removeResources` (`reconcile.remove`): each listed resource is inspected first and removed only when its labels carry
 *   this install's `nexus.home` and a `nexus.attempt` (containers stopped with -t 10, then removed; then networks; then
 *   volumes; a dependency cache volume never).
 * - `releaseByLabels`: `attempt.release` of an attempt this runner process does not hold (it restarted): its labelled
 *   containers, workspace volume and networks are removed. The work folder, the log and the deps cache stay.
 * - `findAttemptDir`: an attempt's `work/<jobId>/<n>` from its `plan.json` (the job id comes from the container label).
 */
import * as path from 'node:path';
import type { StagedOutput, ToolPlan } from '../shared/nexus/execution';
import { MAX_ARRAY_ITEMS, type LabelledResource, type ReconciledAttempt, type RunnerToMain } from '../shared/nexus/runnerProtocol';
import { discardUnmergedReport, mergePerFileJunit } from './junitMerge';
import { collectOut } from './outputs';
import type { ObjectStore } from './objectStore';
import { errCode, type HomePaths } from './paths';
import type { ResourceFacts, ResourceKind, RunnerDriver, RunnerFs } from './types';

const ID_RE = /^[0-9A-Za-z_-]{1,64}$/;
const LABEL_KEY_RE = /^[a-z0-9][a-z0-9._-]{0,127}$/;

/** A resource's `nexus.*` labels only (the protocol's label shape; image labels never travel). */
export function nexusLabels(labels: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(labels)) {
    if (k.startsWith('nexus.') && LABEL_KEY_RE.test(k) && typeof v === 'string' && v.length <= 1024 && !v.includes('\0')) out[k] = v;
  }
  return out;
}

/** Whether a resource is this install's and names an attempt (the only resources the runner ever removes). */
export function ownedByHome(labels: Record<string, string>, home: string): boolean {
  return home.length > 0 && labels['nexus.home'] === home && typeof labels['nexus.attempt'] === 'string' && labels['nexus.attempt'].length > 0;
}

/** A dependency cache volume is shared by later attempts: never removed by the runner. */
export function isDepsVolume(r: { kind: ResourceKind; id: string; labels: Record<string, string> }): boolean {
  return r.kind === 'volume' && (r.id.startsWith('nexus-deps-') || r.labels['nexus.kind'] === 'deps');
}

export interface PlanRecord { plan: ToolPlan | Record<string, unknown>; startedAt?: number; hostPort?: number; containerIds?: string[] }

/** `work/<jobId>/<n>` of an attempt, found through its `plan.json`; null when none matches. */
export async function findAttemptDir(fs: RunnerFs, paths: HomePaths, jobId: string, attemptId: string): Promise<{ dir: string; n: number; record: PlanRecord } | null> {
  if (!ID_RE.test(jobId)) return null;
  const jobDir = path.join(paths.workRoot, jobId);
  let names: string[];
  try { names = await fs.readdir(jobDir); } catch { return null; }
  for (const name of names.filter((x) => /^[1-9][0-9]{0,6}$/.test(x)).slice(0, 1000)) {
    const dir = path.join(jobDir, name);
    const rec = await readPlanRecord(fs, dir);
    if (rec && (rec.plan as { attemptId?: unknown }).attemptId === attemptId) return { dir, n: Number(name), record: rec };
  }
  return null;
}

export async function readPlanRecord(fs: RunnerFs, dir: string): Promise<PlanRecord | null> {
  try {
    const st = await fs.lstat(path.join(dir, 'plan.json'));
    if (!st.isFile() || st.size > 4 * 2 ** 20) return null;
    const v = JSON.parse(await fs.readFile(path.join(dir, 'plan.json'), 'utf8')) as unknown;
    return typeof v === 'object' && v !== null && typeof (v as PlanRecord).plan === 'object' ? v as PlanRecord : null;
  } catch (e) { if (errCode(e) !== 'ENOENT') return null; return null; }
}

/** The `reconcile.result` answer (see the module header). */
export async function reconcileAnswer(ctx: { driver: RunnerDriver; fs: RunnerFs; paths: HomePaths; store: ObjectStore; home: string },
  asked: readonly { attemptId: string; containerId: string; kind: 'tool' | 'service' }[]): Promise<Extract<RunnerToMain, { op: 'reconcile.result' }>> {
  const probe = await ctx.driver.probe().catch(() => ({ docker: 'stopped' as const }));
  const list = Array.isArray(asked) ? asked.slice(0, MAX_ARRAY_ITEMS) : [];
  if (probe.docker !== 'running') {
    return { op: 'reconcile.result', docker: probe.docker, attempts: list.map((a) => ({ attemptId: a.attemptId, container: 'missing' as const })), labelled: [] };
  }
  const all: ResourceFacts[] = ctx.home ? await ctx.driver.listResources({ 'nexus.home': ctx.home }) : [];
  const mine = all.filter((r) => ownedByHome(r.labels, ctx.home));
  const labelled: LabelledResource[] = mine.slice(0, MAX_ARRAY_ITEMS).map((r) => ({ kind: r.kind, id: r.id, labels: nexusLabels(r.labels) }));
  const attempts: ReconciledAttempt[] = [];
  for (const a of list) {
    const found = mine.filter((r) => r.kind === 'container' && r.labels['nexus.attempt'] === a.attemptId);
    const c = found.find((r) => r.id === a.containerId)
      ?? found.find((r) => r.labels['nexus.kind'] === (a.kind === 'service' ? 'service' : 'tool')) ?? found[0];
    if (!c || !c.state || c.state === 'missing') { attempts.push({ attemptId: a.attemptId, container: 'missing' }); continue; }
    const entry: ReconciledAttempt = { attemptId: a.attemptId, container: c.state, containerId: c.id };
    if (c.state === 'exited' && c.exit) entry.exit = c.exit;
    if (c.state === 'exited' && a.kind === 'tool') {
      const staged = await stagedOf(ctx, c.labels['nexus.job'] ?? '', a.attemptId);
      if (staged) entry.staged = staged;
    }
    attempts.push(entry);
  }
  return { op: 'reconcile.result', docker: 'running', attempts, labelled };
}

/** An exited attempt's `/out`, re-hashed in full; null when it cannot be (no folder, a refusal, too many entries). */
async function stagedOf(ctx: { fs: RunnerFs; paths: HomePaths; store: ObjectStore }, jobId: string, attemptId: string): Promise<StagedOutput[] | null> {
  const found = await findAttemptDir(ctx.fs, ctx.paths, jobId, attemptId);
  if (!found) return null;
  const plan = found.record.plan as Partial<ToolPlan>;
  const maxBytes = typeof plan.container?.limits?.outputMaxBytes === 'number' ? plan.container.limits.outputMaxBytes : 0;
  const maxFiles = typeof plan.outputContract?.maxFiles === 'number' ? Math.min(plan.outputContract.maxFiles, MAX_ARRAY_ITEMS) : MAX_ARRAY_ITEMS;
  if (maxBytes <= 0) return null;
  try {
    // A per-file node:test run that ended while the runner was gone: its reports are merged now exactly as the live
    // collect would (fix round 1, with item 6), so main judges what finalization will produce, never the container's
    // own junit.xml (removed when nothing merges). The container has exited: nothing can change under the merge.
    const pf = plan.perFileJunit;
    if (pf && pf.dir === 'junit' && Array.isArray(pf.files) && pf.files.every((f) => typeof f === 'string')) {
      const outDir = path.join(found.dir, 'out');
      let merged = false;
      try { merged = (await mergePerFileJunit(ctx.fs, ctx.paths.root, outDir, pf.files, found.dir)).merged; } catch { merged = false; }
      if (!merged) await discardUnmergedReport(ctx.fs, ctx.paths.root, outDir);
    }
    const r = await collectOut(ctx.fs, ctx.store, path.join(found.dir, 'out'), { maxFiles, maxBytes });
    return r.ok && r.outputs.length <= MAX_ARRAY_ITEMS ? r.outputs : null;
  } catch { return null; }
}

const ORDER: Record<ResourceKind, number> = { container: 0, network: 1, volume: 2 };

/** `reconcile.remove` (see the module header). Returns what was removed and what was refused. */
export async function removeResources(ctx: { driver: RunnerDriver; home: string; live: ReadonlySet<string>; log: (l: string) => void },
  resources: readonly { kind: ResourceKind; id: string }[]): Promise<{ removed: number; refused: number }> {
  let removed = 0; let refused = 0;
  const given: readonly { kind: ResourceKind; id: string }[] = Array.isArray(resources) ? resources : [];
  const list = [...given].filter((r) => r && (r.kind === 'container' || r.kind === 'volume' || r.kind === 'network'))
    .sort((a, b) => ORDER[a.kind] - ORDER[b.kind]).slice(0, MAX_ARRAY_ITEMS);
  for (const r of list) {
    let fact: ResourceFacts | null = null;
    try { fact = await ctx.driver.inspectResource(r.kind, r.id); } catch { fact = null; }
    if (!fact) continue;                                    // already gone
    if (!ownedByHome(fact.labels, ctx.home) || isDepsVolume(fact) || ctx.live.has(fact.labels['nexus.attempt'])) { refused++; continue; }
    try {
      if (r.kind === 'container') { await ctx.driver.stop(fact.id, 10_000); await ctx.driver.remove(fact.id); }
      else if (r.kind === 'network') await ctx.driver.removeNetwork(fact.id);
      else await ctx.driver.removeVolume(fact.id);
      removed++;
    } catch (e) {
      ctx.log(`[runner] a leftover ${r.kind} was not removed: ${(e as Error)?.name ?? 'error'}`);
    }
  }
  return { removed, refused };
}

/** `attempt.release` of an attempt this runner does not hold: remove its labelled containers, networks and workspace volume. */
export async function releaseByLabels(ctx: { driver: RunnerDriver; home: string; log: (l: string) => void }, attemptId: string): Promise<number> {
  if (!ctx.home) return 0;
  let found: ResourceFacts[];
  try { found = await ctx.driver.listResources({ 'nexus.home': ctx.home, 'nexus.attempt': attemptId }); } catch { return 0; }
  const list = found.filter((r) => ownedByHome(r.labels, ctx.home) && r.labels['nexus.attempt'] === attemptId && !isDepsVolume(r))
    .sort((a, b) => ORDER[a.kind] - ORDER[b.kind]);
  let n = 0;
  for (const r of list) {
    try {
      if (r.kind === 'container') await ctx.driver.remove(r.id);
      else if (r.kind === 'network') await ctx.driver.removeNetwork(r.id);
      else await ctx.driver.removeVolume(r.id);
      n++;
    } catch (e) { ctx.log(`[runner] a released ${r.kind} was not removed: ${(e as Error)?.name ?? 'error'}`); }
  }
  return n;
}
