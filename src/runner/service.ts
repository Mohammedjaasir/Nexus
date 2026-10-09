/**
 * Dev deployments (B2a Task 11; the plan's Networks table). A `ServicePlan` runs two containers:
 * - the app, on the internal network `nexus-svc-<jobId>` only (`docker network create --internal`: no route out), where
 *   it answers as `app`;
 * - the forwarder (`nexus-fwd`, fixed argv `socat TCP-LISTEN:8080,fork,reuseaddr TCP:app:<port>`), on that internal
 *   network AND the publish network `nexus-pub-<jobId>`, publishing `127.0.0.1:<hostPort>:8080` and nothing else.
 * Both networks carry the plan's resource labels. The runner picks `hostPort` from the ephemeral range 49152-65535,
 * and retries once with another port when Docker says the port is taken. Both containers pass preflight before either
 * starts; the report main gets merges both (the forwarder's problems are prefixed). The probe loop GETs the health path
 * on 127.0.0.1:<hostPort> and reports `service.health`.
 */
import { randomInt } from 'node:crypto';
import type { ContainerSpec, PreflightReport, ServicePlan } from '../shared/nexus/execution';
import { EPHEMERAL_PORT_MAX, EPHEMERAL_PORT_MIN } from '../shared/nexus/runnerProtocol';
import { publishNetworkName } from '../shared/nexus/preflightCheck';

/** A port from the ephemeral range, not one in `taken`. */
export function pickPort(taken: ReadonlySet<number>, rand: (lo: number, hi: number) => number = randomInt): number {
  for (let i = 0; i < 64; i++) {
    const p = rand(EPHEMERAL_PORT_MIN, EPHEMERAL_PORT_MAX + 1);
    if (!taken.has(p)) return p;
  }
  return rand(EPHEMERAL_PORT_MIN, EPHEMERAL_PORT_MAX + 1);
}

/** The forwarder's spec with its loopback port filled in. */
export function forwarderWithPort(plan: ServicePlan, port: number): ContainerSpec {
  const f = plan.forwarder;
  return { ...f, publish: { hostIp: '127.0.0.1', hostPort: port, containerPort: f.publish?.containerPort ?? 8080 } };
}

/** The app's report with the forwarder's problems added (prefixed); observed values are the app's. */
export function mergePreflight(app: PreflightReport, fwd: PreflightReport | null): PreflightReport {
  const problems = [...app.problems, ...(fwd ? fwd.problems.map((p) => `forwarder: ${p}`) : [])].slice(0, 64);
  return { ok: problems.length === 0, observed: app.observed, problems };
}

/** Why a service plan's networks are not the ones main is allowed to plan, or null. */
export function serviceNetworkProblem(plan: ServicePlan): string | null {
  const { internal, publish } = plan.networks;
  if (plan.app.network.mode !== 'service-internal' || plan.app.network.network !== internal) return 'the app is not on its internal network';
  if (plan.forwarder.network.mode !== 'service-internal' || plan.forwarder.network.network !== internal) return 'the forwarder is not on the internal network';
  if (!plan.forwarder.publish || plan.app.publish) return 'only the forwarder publishes a port';
  if (publishNetworkName(plan.forwarder) !== publish) return 'the publish network is not the job\'s';
  if (!/^nexus-svc-[a-z0-9]{1,64}$/.test(internal) || !/^nexus-pub-[a-z0-9]{1,64}$/.test(publish)) return 'the network names are not nexus names';
  return null;
}
