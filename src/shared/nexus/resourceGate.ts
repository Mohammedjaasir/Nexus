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
  | { id: 'disk_below_recommended'; freeBytes: number; recommendedBytes: number; advisory: true }
  | { id: 'docker_missing' }
  | { id: 'docker_stopped' }
  | { id: 'docker_memory_low'; memoryBytes: number | null; requiredBytes: number }
  | { id: 'docker_cpus_low'; cpus: number | null; requiredCpus: number }
  | { id: 'image_missing'; profile: ImageStatus['profile'] }
  | { id: 'image_mismatch'; profile: ImageStatus['profile'] }
  | { id: 'images_unreadable' }
  | { id: 'probe_unreadable' };
export type GateProblemId = GateProblem['id'];
export type Gate = 'ok' | 'below_recommended' | 'below_required';
export interface GateResult { gate: Gate; problems: GateProblem[] }
export type GateImage = Pick<ImageStatus, 'profile' | 'present' | 'digestMatches'>;

/** Advisory problems are shown with their numbers but never block. */
export const isAdvisory = (p: GateProblem): boolean => 'advisory' in p && p.advisory === true;

const count = (n: unknown): number | null => (typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : null);
/** An own data property of a plain object; never runs a getter. */
function own(r: unknown, key: string): unknown {
  if (typeof r !== 'object' || r === null) return undefined;
  const d = Object.getOwnPropertyDescriptor(r, key);
  return d && 'value' in d ? d.value : undefined;
}

/**
 * Evaluates the gate. Any blocking problem makes it `below_required`; free
 * space in the 30–40 GiB band adds the advisory `disk_below_recommended` and
 * makes it `below_recommended`. Problems come in a fixed order: disk, Docker,
 * Docker memory, Docker CPUs, then images by profile. Memory, CPUs and images
 * are judged only while Docker is running. An image counts only when `present`
 * and `digestMatches` are exactly `true`. Never throws: unreadable input fails.
 */
export function evaluateGate(probe: SandboxProbe, freeBytes: number, images: readonly GateImage[]): GateResult {
  try {
    return evaluate(probe, freeBytes, images);
  } catch {
    return { gate: 'below_required', problems: [{ id: 'probe_unreadable' }] };
  }
}

function evaluate(probe: SandboxProbe, freeBytes: number, images: readonly GateImage[]): GateResult {
  const problems: GateProblem[] = [];
  const free = count(freeBytes);
  if (free === null || free < REQUIRED_FREE_BYTES) problems.push({ id: 'disk_low', freeBytes: free, requiredBytes: REQUIRED_FREE_BYTES });
  else if (free < RECOMMENDED_FREE_BYTES) {
    problems.push({ id: 'disk_below_recommended', freeBytes: free, recommendedBytes: RECOMMENDED_FREE_BYTES, advisory: true });
  }
  const docker = own(probe, 'docker');
  if (docker === 'running') {
    const memory = count(own(probe, 'memoryBytes'));
    if (memory === null || memory < MIN_DOCKER_MEMORY) problems.push({ id: 'docker_memory_low', memoryBytes: memory, requiredBytes: MIN_DOCKER_MEMORY });
    const cpus = count(own(probe, 'cpus'));
    if (cpus === null || cpus < MIN_DOCKER_CPUS) problems.push({ id: 'docker_cpus_low', cpus, requiredCpus: MIN_DOCKER_CPUS });
    if (!Array.isArray(images)) problems.push({ id: 'images_unreadable' });
    else for (const image of images) {
      const profile = own(image, 'profile') as ImageStatus['profile'];
      if (typeof profile !== 'string') { problems.push({ id: 'images_unreadable' }); continue; }
      if (own(image, 'present') !== true) problems.push({ id: 'image_missing', profile });
      else if (own(image, 'digestMatches') !== true) problems.push({ id: 'image_mismatch', profile });
    }
  } else if (docker === 'stopped') {
    problems.push({ id: 'docker_stopped' });
  } else {
    problems.push({ id: 'docker_missing' });
  }
  const blocking = problems.some((p) => !isAdvisory(p));
  const gate: Gate = blocking ? 'below_required' : problems.length > 0 ? 'below_recommended' : 'ok';
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
