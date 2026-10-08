// The resource gate (pure). Heavy execution never starts below it: the caller
// shows the problems as actionable states. Sizes are binary (GiB), which is
// stricter than decimal GB; the UI prints both (`formatGateBytes`).

import type { ImageStatus, SandboxProbe } from './execution';

export const GIB = 2 ** 30;
export const GB = 10 ** 9;
/** Free space needed at the data home before heavy execution runs. */
export const REQUIRED_FREE_BYTES = 30 * GIB;
/** Free space below which the gate passes with a warning. */
export const RECOMMENDED_FREE_BYTES = 40 * GIB;
export const MIN_DOCKER_MEMORY = 4 * GIB;
export const MIN_DOCKER_CPUS = 2;

/** No lease while free space at the data home is below this, for an attempt with this output cap. */
export function leaseFloorBytes(outputMaxBytes: number): number {
  const out = Number.isFinite(outputMaxBytes) && outputMaxBytes > 0 ? outputMaxBytes : 0;
  return Math.max(5 * GIB, 2 * out);
}

export type GateProblem =
  | { id: 'disk_low'; freeBytes: number | null; requiredBytes: number }
  | { id: 'docker_missing' }
  | { id: 'docker_stopped' }
  | { id: 'docker_memory_low'; memoryBytes: number | null; requiredBytes: number }
  | { id: 'docker_cpus_low'; cpus: number | null; requiredCpus: number }
  | { id: 'image_missing'; profile: ImageStatus['profile'] }
  | { id: 'image_mismatch'; profile: ImageStatus['profile'] };
export type GateProblemId = GateProblem['id'];
export type Gate = 'ok' | 'below_recommended' | 'below_required';
export interface GateResult { gate: Gate; problems: GateProblem[] }

const count = (n: unknown): number | null => (typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : null);

/**
 * Evaluates the gate. Any problem makes it `below_required`; otherwise free
 * space under the recommendation makes it `below_recommended`. Problems come in
 * a fixed order: disk, Docker, Docker memory, Docker CPUs, then images by profile.
 * Memory, CPUs and images are only judged while Docker is running.
 */
export function evaluateGate(probe: SandboxProbe, freeBytes: number,
  images: readonly Pick<ImageStatus, 'profile' | 'present' | 'digestMatches'>[] = []): GateResult {
  const problems: GateProblem[] = [];
  const free = count(freeBytes);
  if (free === null || free < REQUIRED_FREE_BYTES) problems.push({ id: 'disk_low', freeBytes: free, requiredBytes: REQUIRED_FREE_BYTES });
  const docker = probe?.docker;
  if (docker === 'running') {
    const memory = count(probe.memoryBytes);
    if (memory === null || memory < MIN_DOCKER_MEMORY) problems.push({ id: 'docker_memory_low', memoryBytes: memory, requiredBytes: MIN_DOCKER_MEMORY });
    const cpus = count(probe.cpus);
    if (cpus === null || cpus < MIN_DOCKER_CPUS) problems.push({ id: 'docker_cpus_low', cpus, requiredCpus: MIN_DOCKER_CPUS });
    for (const image of images) {
      if (!image.present) problems.push({ id: 'image_missing', profile: image.profile });
      else if (!image.digestMatches) problems.push({ id: 'image_mismatch', profile: image.profile });
    }
  } else if (docker === 'stopped') {
    problems.push({ id: 'docker_stopped' });
  } else {
    problems.push({ id: 'docker_missing' });
  }
  const gate: Gate = problems.length > 0 ? 'below_required'
    : (free as number) < RECOMMENDED_FREE_BYTES ? 'below_recommended' : 'ok';
  return { gate, problems };
}

const oneDecimal = (n: number): string => {
  const s = (Math.round(n * 10) / 10).toFixed(1);
  return s.endsWith('.0') ? s.slice(0, -2) : s;
};

/** "30 GiB (32.2 GB)": binary first, decimal in brackets, so no reader confuses the two. */
export function formatGateBytes(bytes: number): string {
  return `${oneDecimal(bytes / GIB)} GiB (${oneDecimal(bytes / GB)} GB)`;
}
