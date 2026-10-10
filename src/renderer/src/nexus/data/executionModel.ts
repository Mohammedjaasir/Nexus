// Pure: whether jobs can run on this computer, and the execution setup sheet, from
// what main last observed (HealthView, #23) and from how the execution channels
// answered. No React, so tests load it directly. Every number shown here comes
// from the HealthView or an approval; nothing is estimated in the renderer.
import type { EventView, HealthView, NexusResult } from '@shared/nexus/ipc';
import { GIB, MIN_DOCKER_CPUS, MIN_DOCKER_MEMORY } from '@shared/nexus/resourceGate';
import { errorCopy, executionNotice, unavailableNotice } from './errorCopy';

/**
 * Sizes in GB as Windows Explorer shows them (binary: 1 GB = 2^30 bytes), which is also how the resource gate
 * counts. Rounded down to one decimal, so free space is never overstated; a whole number has no decimal.
 */
export function gb(bytes: number): string {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) return 'unknown';
  const v = Math.floor((bytes / GIB) * 10) / 10;
  return `${Number.isInteger(v) ? v.toFixed(0) : v.toFixed(1)} GB`;
}

/**
 * A size in the unit that reads best (bytes, KB, MB or GB; binary, as `gb`), with one decimal below 100 when it is
 * not whole: an image of 71.5 MB never reads "0 GB". A size that is not a known non-negative number reads "unknown".
 */
export function sizeLabel(bytes: number | null | undefined): string {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) return 'unknown';
  if (bytes < 1024) return `${Math.round(bytes)} bytes`;
  const [v, unit] = bytes >= GIB ? [bytes / GIB, 'GB'] : bytes >= 2 ** 20 ? [bytes / 2 ** 20, 'MB'] : [bytes / 1024, 'KB'];
  const r = v < 100 ? Math.round(v * 10) / 10 : Math.round(v);
  return `${Number.isInteger(r) ? r.toFixed(0) : r.toFixed(1)} ${unit}`;
}

// ---------- availability ----------

export type SetupProblemId = 'docker_missing' | 'docker_stopped' | 'docker_memory_low' | 'docker_cpus_low' | 'disk_low' | 'image_missing'
  | 'image_mismatch' | 'runner_unavailable' | 'git_missing' | 'probe_unreadable';

/**
 * - unknown: health not read yet (or a passing failure: `retry`);
 * - platform_off: the whole platform is off (its notice already says why);
 * - execution_off: execution itself is off (held migration, not turned on in this build, not connected);
 * - setup: execution is on, but jobs cannot run on this computer (Docker, images, the runner, or free disk below the
 *   lease floor, where no job is started);
 * - ready: jobs can run. An advisory may remain: free disk below 30 GB (only image preparation and the execution
 *   checks need that; jobs still run above the lease floor) or below the recommended 40 GB.
 */
export type ExecAvailability =
  | { kind: 'unknown'; text: string | null; retry: boolean; checking?: boolean }
  | { kind: 'platform_off'; text: string }
  | { kind: 'execution_off'; subReason: string; text: string }
  | { kind: 'setup'; problems: SetupProblemId[]; profiles: string[]; text: string }
  | { kind: 'ready'; advisories: string[] };

const PROBLEM_ORDER: SetupProblemId[] = ['disk_low', 'docker_missing', 'docker_stopped', 'docker_memory_low', 'docker_cpus_low',
  'image_missing', 'image_mismatch', 'runner_unavailable', 'git_missing', 'probe_unreadable'];

const PROBLEM_LINE: Record<SetupProblemId, string> = {
  disk_low: 'there is not enough free disk for the output of a job',
  docker_missing: 'Docker is not installed',
  docker_stopped: 'Docker is not running',
  docker_memory_low: 'Docker has too little memory',
  docker_cpus_low: 'Docker has too few CPUs',
  image_missing: 'a sandbox image is not prepared',
  image_mismatch: 'a sandbox image does not match the pinned version',
  runner_unavailable: 'the execution runner is not running',
  git_missing: 'git is not installed',
  probe_unreadable: 'this computer could not be checked'
};

/** True when free disk is known and below the floor under which main starts no job. */
export function diskBelowFloor(d: HealthView['disk']): boolean {
  return typeof d.dataHomeFreeBytes === 'number' && typeof d.leaseFloorBytes === 'number' && d.dataHomeFreeBytes < d.leaseFloorBytes;
}

/** The advisory below the 30 GB gate: jobs run, but images cannot be prepared and the execution checks cannot run. */
export function diskGateAdvisory(d: HealthView['disk']): string | null {
  if (d.gate !== 'below_required' || typeof d.dataHomeFreeBytes !== 'number') return null;
  return `${diskLine(d)}.`;
}

/** The blocking problems of a HealthView, in the gate's order (advisories are not problems). */
export function setupProblems(h: HealthView): { problems: SetupProblemId[]; profiles: string[] } {
  const found = new Set<SetupProblemId>();
  const profiles: string[] = [];
  for (const p of h.problems ?? []) {
    const [id, profile] = p.split(':');
    if (id === 'images_unreadable') found.add('probe_unreadable');
    else if ((PROBLEM_ORDER as string[]).includes(id)) found.add(id as SetupProblemId);
    if ((id === 'image_missing' || id === 'image_mismatch') && profile && !profiles.includes(profile)) profiles.push(profile);
  }
  if (h.docker.state === 'stopped') found.add('docker_stopped');
  if (h.docker.state === 'missing') found.add('docker_missing');
  // B2a final review C2 (ruled): the 30 GB gate holds image preparation and the execution checks only; jobs run above
  // the lease floor. Main's gate lists `disk_low` below 30 GB, so that id alone is not a blocking problem here: free
  // disk blocks jobs only below the floor (main's #24 then answers `setup:disk_low`, and no job is leased).
  found.delete('disk_low');
  if (diskBelowFloor(h.disk)) found.add('disk_low');
  if (!h.runner.attached) found.add('runner_unavailable');
  return { problems: PROBLEM_ORDER.filter((p) => found.has(p)), profiles };
}

/** Where execution stands, from the platform view and the last #23 answer (null while unread). */
export function availabilityFrom(platform: { unavailable: { reason: string | null } | null }, health: NexusResult<HealthView> | null): ExecAvailability {
  if (platform.unavailable) return { kind: 'platform_off', text: unavailableNotice(platform.unavailable.reason) };
  if (!health) return { kind: 'unknown', text: null, retry: false };
  if (!health.ok) {
    const c = errorCopy(health.code, health.reason, health.subReason);
    if (c.kind === 'execution_unavailable') return { kind: 'execution_off', subReason: health.subReason ?? 'not_enabled', text: c.text };
    if (c.kind === 'unavailable') return { kind: 'platform_off', text: c.text };
    return { kind: 'unknown', text: c.text, retry: c.retry };
  }
  const h = health.data;
  if (!h.db.execution) {
    const sub = h.db.subReason ?? 'not_enabled';
    return { kind: 'execution_off', subReason: sub, text: executionNotice(sub) };
  }
  if (!h.registry.valid) return { kind: 'execution_off', subReason: 'registry_invalid', text: executionNotice('registry_invalid') };
  // Before main's first probe every fact is unknown: nothing may read as ready.
  if (h.checkedAt === null) return { kind: 'unknown', text: NOT_CHECKED, retry: false, checking: true };
  const { problems, profiles } = setupProblems(h);
  if (problems.length > 0) {
    const first = PROBLEM_LINE[problems[0]];
    const more = problems.length > 1 ? ` (and ${problems.length - 1} more)` : '';
    return { kind: 'setup', problems, profiles, text: `Jobs cannot run on this computer yet: ${first}${more}. Open the setup to see what to do.` };
  }
  if (h.docker.state === 'unknown' || h.disk.gate === 'unknown' || h.disk.dataHomeFreeBytes === null) {
    return { kind: 'unknown', text: NOT_CHECKED, retry: false, checking: true };
  }
  const below = diskGateAdvisory(h.disk);
  const advisories = below ? [below]
    : h.disk.gate === 'below_recommended' && h.disk.dataHomeFreeBytes !== null
      ? [`Free disk is ${gb(h.disk.dataHomeFreeBytes)}; ${gb(h.disk.recommendedBytes)} is recommended.`] : [];
  return { kind: 'ready', advisories };
}

export const NOT_CHECKED = 'This computer has not been checked yet, so jobs cannot start. Open the setup to check it.';

/** The one-line notice (ExecutionNotice): null when jobs can run and nothing needs saying. */
export function noticeFor(a: ExecAvailability): { text: string; setup: boolean } | null {
  switch (a.kind) {
    case 'ready': return a.advisories.length ? { text: a.advisories[0], setup: true } : null;
    case 'unknown': return a.text ? { text: a.text, setup: a.checking === true } : null;
    case 'platform_off': return null; // the platform notice already says it
    case 'execution_off': return { text: a.text, setup: a.subReason !== 'unreachable' };
    case 'setup': return { text: a.text, setup: true };
  }
}

// ---------- the setup sheet ----------

export type SetupState = 'ok' | 'problem' | 'advisory' | 'unknown';
/** One row: a label, a status word (never colour alone), the facts, and what to do. */
export interface SetupRow {
  id: string; label: string; state: SetupState; word: string; text: string; action: string | null;
  /** For an image row: the profile a "Prepare image" button would ask for; null when that cannot be offered now. */
  prepare: { profile: string; label: string } | null;
}

const WORD: Record<SetupState, string> = { ok: 'Ready', problem: 'Needs attention', advisory: 'Works, below the recommendation', unknown: 'Not checked' };
const row = (id: string, label: string, state: SetupState, text: string, action: string | null = null,
  prepare: SetupRow['prepare'] = null): SetupRow => ({ id, label, state, word: WORD[state], text, action, prepare });

export const PROFILE_LABEL: Readonly<Record<string, string>> = Object.freeze({
  'sde-node': 'Node sandbox image', 'sde-python': 'Python sandbox image', 'nexus-fwd': 'Dev deployment forwarder image'
});

/** "Prepare image (≈ 0.6 GB)" when an approval stated the size, else "Prepare image". */
export function prepareLabel(estimatedBytes: number | null | undefined, again = false): string {
  const base = again ? 'Prepare image again' : 'Prepare image';
  return typeof estimatedBytes === 'number' && Number.isFinite(estimatedBytes) && estimatedBytes > 0 ? `${base} (≈ ${gb(estimatedBytes)})` : base;
}

/** The GPU line: always said, never offered. */
export function gpuLine(g: HealthView['gpu']): string {
  if (!g.detected) return 'No GPU detected';
  return g.model ? `GPU detected (${g.model}), not supported in this release` : 'GPU detected, not supported in this release';
}

export function diskLine(d: HealthView['disk']): string {
  const need = `preparing images and the execution checks need ${gb(d.requiredBytes)} (${gb(d.recommendedBytes)} recommended)`;
  return d.dataHomeFreeBytes === null ? `Free disk could not be measured; ${need}` : `Free disk is ${gb(d.dataHomeFreeBytes)}; ${need}`;
}

/**
 * The sheet's rows. `estimates` holds the size an image-preparation approval stated per profile (the only source of
 * that number); `pending` the profiles that already wait for an answer (their approval row is shown instead).
 */
export function setupSheet(h: HealthView, ctx: { estimates?: ReadonlyMap<string, number>; pending?: ReadonlySet<string> } = {}): SetupRow[] {
  const rows: SetupRow[] = [];
  const d = h.docker;
  const dockerFacts = [d.version ? `version ${d.version}` : null, typeof d.cpus === 'number' ? `${d.cpus} CPUs` : null,
    typeof d.memoryBytes === 'number' ? `${gb(d.memoryBytes)} memory` : null, d.os ? d.os : null].filter((x) => x !== null).join(', ');
  if (d.state === 'running') rows.push(row('docker', 'Docker', 'ok', dockerFacts ? `Docker is running (${dockerFacts}).` : 'Docker is running.'));
  else if (d.state === 'stopped') rows.push(row('docker', 'Docker', 'problem', 'Docker is not running.', 'Start Docker Desktop, then check again.'));
  else if (d.state === 'missing') rows.push(row('docker', 'Docker', 'problem', 'Docker is not installed.', 'Install Docker Desktop, start it, then check again.'));
  else rows.push(row('docker', 'Docker', 'unknown', 'Docker has not been checked yet.', 'Check again in a moment.'));
  if (d.state === 'running') {
    if (typeof d.memoryBytes !== 'number' || d.memoryBytes < MIN_DOCKER_MEMORY) {
      rows.push(row('memory', 'Docker memory', 'problem', typeof d.memoryBytes === 'number'
        ? `Docker has ${gb(d.memoryBytes)} of memory; execution needs ${gb(MIN_DOCKER_MEMORY)}.` : `Docker memory could not be read; execution needs ${gb(MIN_DOCKER_MEMORY)}.`,
      'Give Docker more memory in Docker Desktop settings, then check again.'));
    } else rows.push(row('memory', 'Docker memory', 'ok', `Docker has ${gb(d.memoryBytes)} of memory; execution needs ${gb(MIN_DOCKER_MEMORY)}.`));
    if (typeof d.cpus !== 'number' || d.cpus < MIN_DOCKER_CPUS) {
      rows.push(row('cpus', 'Docker CPUs', 'problem', typeof d.cpus === 'number' ? `Docker has ${d.cpus} CPU; execution needs ${MIN_DOCKER_CPUS}.`
        : `Docker CPUs could not be read; execution needs ${MIN_DOCKER_CPUS}.`, 'Give Docker more CPUs in Docker Desktop settings, then check again.'));
    } else rows.push(row('cpus', 'Docker CPUs', 'ok', `Docker has ${d.cpus} CPUs; execution needs ${MIN_DOCKER_CPUS}.`));
  }
  const disk = h.disk;
  const FREE_UP = 'Free up space on the drive that holds the app data (Nexus deletes nothing itself), then check again.';
  if (disk.dataHomeFreeBytes === null) {
    rows.push(row('disk', 'Free disk', 'unknown', diskLine(disk), FREE_UP));
  } else if (diskBelowFloor(disk)) {
    rows.push(row('disk', 'Free disk', 'problem', `${diskLine(disk)}; below ${gb(disk.leaseFloorBytes)} no job starts`, FREE_UP));
  } else if (disk.gate === 'below_required') {
    // Ruled (final review C2): an advisory, not a blocker. Jobs run; only image preparation and the execution checks wait.
    rows.push({ ...row('disk', 'Free disk', 'advisory', diskLine(disk),
      `Jobs can run while there is room for their output. ${FREE_UP.replace(', then check again.', ' to prepare images.')}`),
    word: 'Jobs run; images cannot be prepared' });
  } else if (disk.gate === 'below_recommended') {
    rows.push(row('disk', 'Free disk', 'advisory', diskLine(disk), 'Jobs can run. Freeing more space keeps large builds from waiting.'));
  } else rows.push(row('disk', 'Free disk', 'ok', diskLine(disk)));
  // An image can be prepared only while Docker runs and the disk passes the gate (main refuses it otherwise).
  const canPrepare = d.state === 'running' && disk.gate !== 'below_required' && disk.dataHomeFreeBytes !== null;
  for (const img of h.images) {
    const label = PROFILE_LABEL[img.profile] ?? `Sandbox image ${img.profile}`;
    if (img.present && img.matches) {
      const facts = [img.imageIdShort ?? null, typeof img.sizeBytes === 'number' ? sizeLabel(img.sizeBytes) : null].filter((x) => x !== null).join(', ');
      rows.push(row(`image:${img.profile}`, label, 'ok', facts ? `Prepared (${facts}).` : 'Prepared.'));
      continue;
    }
    const again = img.present && !img.matches;
    const text = again ? 'Prepared, but it does not match the pinned version.' : 'Not prepared yet.';
    if (ctx.pending?.has(img.profile)) {
      rows.push(row(`image:${img.profile}`, label, 'problem', text, 'Waiting for your answer below.'));
    } else if (canPrepare) {
      rows.push(row(`image:${img.profile}`, label, 'problem', text, 'Preparing downloads its pinned base once, after you approve it.',
        { profile: img.profile, label: prepareLabel(ctx.estimates?.get(img.profile), again) }));
    } else {
      rows.push(row(`image:${img.profile}`, label, 'problem', text, d.state !== 'running'
        ? 'It can be prepared once Docker is running.'
        : disk.dataHomeFreeBytes === null ? 'It can be prepared once free disk has been measured.'
          : `It can be prepared once the disk has ${gb(disk.requiredBytes)} free.`));
    }
  }
  // HealthView has no git field: git is shown only when main reported it missing (never claimed as ready).
  if ((h.problems ?? []).includes('git_missing')) rows.push(row('git', 'Git', 'problem', 'Git is not installed.', 'Install Git, then restart the app.'));
  rows.push(h.runner.attached
    ? row('runner', 'Execution runner', 'ok', h.runner.restarts > 0 ? `Running (restarted ${h.runner.restarts} times).` : 'Running.')
    : row('runner', 'Execution runner', 'problem', 'Not running.', 'Restart the app; the runner starts with it.'));
  rows.push(row('gpu', 'GPU', 'ok', gpuLine(h.gpu)));
  // The GPU line is a fact, not a requirement: it is never a problem and never offered.
  rows[rows.length - 1].word = h.gpu.detected ? 'Not used' : 'Not needed';
  return rows;
}

/** The sheet's lead line: "Jobs can run" only when execution is ready AND every row is fine. */
export function setupLead(a: ExecAvailability, rows: readonly SetupRow[]): string | null {
  if (a.kind === 'setup') return 'Jobs run only once every row below is ready. Nothing here is changed for you.';
  if (a.kind === 'ready' && rows.length > 0 && rows.every((r) => r.state === 'ok' || r.state === 'advisory')) return 'Jobs can run on this computer.';
  if (a.kind === 'unknown' && a.checking) return NOT_CHECKED;
  return null;
}

/** "Checked at 14:05", or that it was never checked. */
export function checkedLine(checkedAt: number | null, fmt: (t: number) => string = (t) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })): string {
  return checkedAt === null ? 'This computer has not been checked yet.' : `Checked at ${fmt(checkedAt)}.`;
}

// ---------- hints: which lists to read again ----------

export type ExecList = 'jobs' | 'approvals' | 'deployments' | 'validations' | 'health' | 'artifacts';

const FINISHED = /-> (completed|partial|failed|cancelled|timed_out|interrupted)\b/;

/** The lists a page of events touches; every other list is left alone (a hint storm re-reads only these). */
export function affectedLists(events: readonly Pick<EventView, 'type' | 'summary'>[]): Set<ExecList> {
  const out = new Set<ExecList>();
  for (const e of events) {
    switch (e.type) {
      case 'job.transition':
        out.add('jobs');
        // A finished job may have ingested outputs: the artifact list (and the actions that need them) change.
        if (FINISHED.test(e.summary)) { out.add('artifacts'); out.add('validations'); }
        break;
      case 'attempt.transition': case 'attempt.provisioned': case 'attempt.progress': case 'attempt.output':
      case 'attempt.heartbeat_gap':
        out.add('jobs'); break;
      // A preflight or a recovery pass re-probes this computer: the setup facts may have changed too.
      case 'preflight': case 'recovery': out.add('jobs'); out.add('health'); break;
      case 'approval': out.add('approvals'); out.add('jobs'); break;
      case 'image_build': out.add('approvals'); out.add('health'); break;
      case 'deployment': out.add('deployments'); out.add('artifacts'); break;
      case 'validation': out.add('validations'); out.add('artifacts'); break;
      default: out.add('jobs');
    }
  }
  return out;
}
