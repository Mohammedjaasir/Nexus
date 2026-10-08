/**
 * Pure rules for local dev deployments. No I/O; the database enforces the same table in
 * `deployment_transitions` (seeded from V9_DEPLOYMENT_TRANSITIONS) and `tr_deployments_transition`,
 * and the two must stay identical (test/nexus-core-states.test.cjs compares them).
 */
import type { DeploymentStatus } from '../../../shared/nexus/platform';

const to = (...states: DeploymentStatus[]): readonly DeploymentStatus[] => Object.freeze(states);

/** Mirrors the v9 seed exactly, including starting -> stopped (a user may stop a preview that is still starting). */
export const DEPLOYMENT_TRANSITIONS: Readonly<Record<DeploymentStatus, readonly DeploymentStatus[]>> = Object.freeze({
  starting: to('healthy', 'failed', 'stopped'),
  healthy: to('unhealthy', 'stopped', 'failed'),
  unhealthy: to('healthy', 'stopped', 'failed'),
  stopped: to(),
  failed: to()
});

export const DEPLOYMENT_STATUSES: readonly DeploymentStatus[] = Object.freeze(
  ['starting', 'healthy', 'unhealthy', 'stopped', 'failed'] as DeploymentStatus[]);
/** The states in which a deployment holds its port (the `ux_deployments_port_live` predicate). */
export const LIVE_DEPLOYMENT_STATUSES: readonly DeploymentStatus[] = Object.freeze(['starting', 'healthy', 'unhealthy'] as DeploymentStatus[]);
export const TERMINAL_DEPLOYMENT_STATUSES: readonly DeploymentStatus[] = Object.freeze(['stopped', 'failed'] as DeploymentStatus[]);

export function canTransitionDeployment(from: DeploymentStatus, to: DeploymentStatus): boolean {
  const next = Object.prototype.hasOwnProperty.call(DEPLOYMENT_TRANSITIONS, from) ? DEPLOYMENT_TRANSITIONS[from] : undefined;
  return Array.isArray(next) && next.includes(to);
}
