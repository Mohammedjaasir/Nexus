/**
 * The diagnostic report (B2a Task 12, amendment A1): main composes it from the runner's diagnosis (re-validated by
 * `checkDiagnosis`) and its OWN probe table (the deployment's stored `health_json`, which main recorded from the
 * runner's `service.health` reports). Pure. Every field names its source and points at its evidence (`diag.schema`):
 * - `inspect`: `{ type, container: { sha256 }, field }`, the inspected container and the `docker inspect` field;
 * - `http`: `{ type, method: 'GET', path, at }`, the probe that observed it;
 * - `log`: `{ type, attemptId, offset, length, sha256 }`, the exact hashed byte range of the attempt log.
 * A container that was not inspected (missing, not this install's, Docker not answering) gives one `container.status`
 * field and nothing else; a log range that could not be read gives no field (there is no hash to point at). Nothing
 * here is inferred: a report that observed nothing has no field and fails its schema check (honestly empty).
 */
import type { NormalizedDiagnosis } from '../validation/normalized';

export interface ReportField { name: string; value: string | number | boolean | null | { sha256: string }; source: Record<string, unknown> }
export interface DiagnosticReport {
  version: 1;
  subject: { target: 'deployment' | 'job'; id: string };
  fields: ReportField[];
}
/** Main's own probe table of a dev deployment (its health path and the stored probes, oldest first). */
export interface ProbeTable { path: string; probes: { at: number; status: number | null; ms: number | null }[] }

export function buildDiagnosticReport(d: NormalizedDiagnosis, subjectId: string, probes: ProbeTable | null): DiagnosticReport {
  const fields: ReportField[] = [];
  const many = d.containers.length > 1;
  d.containers.forEach((c, i) => {
    const pre = many ? `container.${i + 1}` : 'container';
    const src = (field: string): Record<string, unknown> => ({ type: 'inspect', container: { sha256: c.container.sha256 }, field });
    if (c.status !== 'inspected' || !c.facts) { fields.push({ name: `${pre}.status`, value: c.status, source: src('State') }); return; }
    const f = c.facts;
    fields.push(
      { name: `${pre}.state`, value: f.state, source: src('State.Status') },
      { name: `${pre}.exitCode`, value: f.exitCode, source: src('State.ExitCode') },
      { name: `${pre}.oomKilled`, value: f.oomKilled, source: src('State.OOMKilled') },
      { name: `${pre}.restartCount`, value: f.restartCount, source: src('RestartCount') },
      { name: `${pre}.startedAt`, value: f.startedAt, source: src('State.StartedAt') },
      { name: `${pre}.finishedAt`, value: f.finishedAt, source: src('State.FinishedAt') },
      { name: `${pre}.image`, value: f.image, source: src('Image') },
      { name: `${pre}.limits.cpus`, value: f.nanoCpus === null ? null : f.nanoCpus / 1e9, source: src('HostConfig.NanoCpus') },
      { name: `${pre}.limits.memoryBytes`, value: f.memoryBytes, source: src('HostConfig.Memory') },
      { name: `${pre}.limits.pids`, value: f.pidsLimit, source: src('HostConfig.PidsLimit') },
      { name: `${pre}.network`, value: f.networkMode, source: src('HostConfig.NetworkMode') },
      { name: `${pre}.readOnlyRoot`, value: f.readonlyRootfs, source: src('HostConfig.ReadonlyRootfs') },
      { name: `${pre}.user`, value: f.user, source: src('Config.User') },
      { name: `${pre}.publishedPorts`, value: f.publishedPorts.join(', ') || null, source: src('HostConfig.PortBindings') }
    );
  });
  if (probes && probes.probes.length > 0) {
    const last = probes.probes[probes.probes.length - 1];
    const src = { type: 'http', method: 'GET', path: probes.path, at: last.at };
    const ok = probes.probes.filter((p) => p.status === 200).length;
    fields.push(
      { name: 'health.lastStatus', value: last.status, source: src },
      { name: 'health.lastLatencyMs', value: last.ms, source: src },
      { name: 'health.probes', value: probes.probes.length, source: src },
      { name: 'health.answered200', value: ok, source: src }
    );
  }
  const readable = d.logs.filter((l) => l.status === 'read' && l.sha256 !== null);
  readable.forEach((l, i) => {
    if (l.sha256 === null) return;
    const pre = readable.length > 1 ? `log.${i + 1}` : 'log';
    const src = { type: 'log', attemptId: l.attemptId, offset: l.offset, length: l.length, sha256: l.sha256 };
    fields.push(
      { name: `${pre}.frames`, value: l.frames, source: src },
      { name: `${pre}.errorFrames`, value: l.errorFrames, source: src },
      { name: `${pre}.lastLine`, value: l.lastText, source: src }
    );
  });
  return { version: 1, subject: { target: d.target, id: subjectId }, fields };
}
