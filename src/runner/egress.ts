/**
 * The runner's side of the Nexus egress policy (B2a stabilization, user constraint 5; src/shared/nexus/egressPolicy.ts).
 *
 * An approved install runs as TWO containers: the install, on the job's `--internal` network only (no route out), and
 * the egress proxy (the pinned sde-node image, fixed command), on that network (alias `nexus-egress-proxy`) and the
 * job's outbound bridge. The runner holds no authority, but it re-checks main's plan here before anything is made
 * (`egressTopologyProblem`: a refusal is `network_not_approved`), preflights both containers before either starts, starts
 * the proxy first and waits for it to listen, and turns each of the proxy's decision lines into an `attempt.event`
 * (`egress`; at most EGRESS_EVENT_MAX per attempt) and an attempt-log line. Nothing the proxy prints is trusted beyond
 * the strict line parser (`parseEgressLine`).
 */
import type { PreflightReport, ToolPlan } from '../shared/nexus/execution';
import {
  EGRESS_PROXY_ARGV, EGRESS_PROXY_PROFILE, egressAllowFor, egressClientEnv, egressInternalNetwork, egressOutboundNetwork, formatAllow,
  parseEgressLine, isEgressReadyLine, type EgressDecision
} from '../shared/nexus/egressPolicy';

/** How long the runner waits for the proxy to listen before it gives up on the attempt (a `docker_error` fault). */
export const PROXY_READY_MS = 30_000;
/** The most proxy output lines (other than decisions) copied into the attempt log. */
export const PROXY_LOG_LINES_MAX = 200;

const sameList = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((x, i) => x === b[i]);

/**
 * Why a tool plan's egress topology is not the one main is allowed to plan, or null:
 * - a tool plan WITHOUT egress carries no proxy;
 * - an egress plan carries exactly the job's proxy: the sde-node profile, the fixed command, no mount, no published port,
 *   the egress-proxy network naming the same approval, the job's internal and outbound networks, and the recipe's
 *   allow-list exactly (so no test-only pinned entry and no extra host ever reaches a real run);
 * - the install has exactly the proxy settings main's constants give it.
 */
export function egressTopologyProblem(plan: ToolPlan): string | null {
  const c = plan.container;
  const px = plan.egressProxy;
  if (c.network.mode !== 'egress-approved') return px === undefined ? null : 'a plan without egress carries an egress proxy';
  if (!px || typeof px !== 'object' || !px.container || !px.networks) return 'egress without the Nexus egress proxy';
  const p = px.container;
  if (px.networks.internal !== egressInternalNetwork(plan.jobId) || px.networks.outbound !== egressOutboundNetwork(plan.jobId)) {
    return 'the egress networks are not the job\'s';
  }
  if (p.network?.mode !== 'egress-proxy' || p.network.approvalId !== c.network.approvalId) return 'the egress proxy is not on the approved egress network';
  if (p.profile !== EGRESS_PROXY_PROFILE || !Array.isArray(p.argv) || !sameList(p.argv, EGRESS_PROXY_ARGV)) return 'the egress proxy is not the Nexus proxy';
  if (!Array.isArray(p.mounts) || p.mounts.length > 0 || p.publish !== undefined || p.service !== undefined) return 'the egress proxy has a mount or a port';
  const allow = egressAllowFor(plan.recipe?.id ?? '');
  if (!allow || p.env?.NEXUS_EGRESS_ALLOW !== formatAllow(allow)) return 'the egress allow-list is not the recipe\'s';
  const want = egressClientEnv(c.profile);
  for (const [k, v] of Object.entries(want)) if (c.env?.[k] !== v) return 'the install does not carry the proxy settings';
  if (c.publish !== undefined) return 'an install publishes no port';
  return null;
}

/** The install's report with the proxy's problems added (prefixed); observed values are the install's. */
export function mergeProxyPreflight(install: PreflightReport, proxy: PreflightReport): PreflightReport {
  const problems = [...install.problems, ...proxy.problems.map((p) => `egress proxy: ${p}`)].slice(0, 64);
  return { ok: problems.length === 0, observed: install.observed, problems };
}

/** Splits a stream into lines (a partial line waits for its end); `flush` returns what is left. */
export class LineSplitter {
  private rest = '';
  push(chunk: string): string[] {
    const text = this.rest + chunk;
    const lines = text.split(/\r?\n/);
    this.rest = lines.pop() ?? '';
    // A single line longer than 4 KiB is cut: the proxy never prints one, so it is noise.
    if (this.rest.length > 4096) { lines.push(this.rest.slice(0, 4096)); this.rest = ''; }
    return lines;
  }
  flush(): string[] { const r = this.rest; this.rest = ''; return r ? [r] : []; }
}

/** One proxy output line, classified. */
export type ProxyLine = { kind: 'ready' } | { kind: 'decision'; decision: EgressDecision } | { kind: 'other'; text: string } | { kind: 'blank' };
export function classifyProxyLine(line: string): ProxyLine {
  const t = line.trim();
  if (!t) return { kind: 'blank' };
  if (isEgressReadyLine(t)) return { kind: 'ready' };
  const d = parseEgressLine(t);
  return d ? { kind: 'decision', decision: d } : { kind: 'other', text: t.slice(0, 300) };
}
