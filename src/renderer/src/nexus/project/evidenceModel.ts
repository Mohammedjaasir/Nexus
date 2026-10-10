// Pure: a version's checks (ValidationResultView[], #32) as the Folio's evidence
// page. Every fact names where it came from: the framework's JUnit counts, a
// hash, an HTTP probe, a git check, an exit code, a docker inspect field, a log
// range. Nothing is summarised into a number the records do not hold.
import type { ValidationResultView, VersionView } from '@shared/nexus/ipc';
import { getValidator } from '@shared/nexus/validators';

export type CheckStatus = ValidationResultView['status'];
export type ChecksHeadline = 'Checks passed' | 'Checks failed' | 'Checks could not run' | 'Checking…' | 'No checks recorded';

export interface EvidenceFact { kind: string; label: string; value: string; source: string }
export interface EvidenceRow {
  validatorId: string;
  label: string;
  /** Always a word: "Passed", "Failed", "Could not run", "Skipped", "Not run yet". */
  word: string;
  status: CheckStatus;
  blocking: boolean;
  /** The check's own sentence; for a check that could not run, "Checks could not run: <reason>". */
  summary: string | null;
  facts: EvidenceFact[];
  /** The newest run result of an advisory row (never the status). */
  latestRun: { word: string; summary: string } | null;
  history: number;
}
export interface EvidenceView { headline: ChecksHeadline; rows: EvidenceRow[]; revalidate: boolean }

export const STATUS_WORD: Readonly<Record<string, string>> = Object.freeze({
  passed: 'Passed', failed: 'Failed', error: 'Could not run', skipped: 'Skipped'
});
export const statusWord = (s: CheckStatus): string => (s ? STATUS_WORD[s] ?? s : 'Not run yet');

const VALIDATOR_LABEL: Readonly<Record<string, string>> = Object.freeze({
  'git.head_resolves': 'The commit resolves in the repository',
  'req.schema': 'The requirement has a title and acceptance criteria',
  'problem.schema': 'The problem statement is complete',
  'suite.discovered': 'Tests were discovered',
  'sde.tests_pass': 'The tests pass',
  'build.exit_zero': 'The build exited cleanly',
  'build.manifest_present': 'The build produced files',
  'build.output_hashed': 'Every output file is stored',
  'blob.integrity': 'Stored files hash the same again',
  'app.manifest_schema': 'The application manifest is valid',
  'app.preview_health': 'The dev deployment answers its health check',
  'diag.schema': 'Every fact of the report names its source',
  'sde.deps.lock_matches': 'The installed dependencies match the lockfile'
});
export const validatorLabel = (id: string): string => VALIDATOR_LABEL[id] ?? (getValidator(id) ? id : `Check ${id}`);

/** A hash as 12 hex characters (`sha256:` kept when present); anything else unchanged. */
export function shortHash(v: string): string {
  const m = /^(sha256:)?([0-9a-f]{12,64})$/.exec(v);
  return m ? `${m[1] ?? ''}${m[2].slice(0, 12)}` : v;
}

const str = (v: unknown): string => (v === null || v === undefined ? '' : String(v));

/** One evidence item of the view as a sourced fact; null for an item that carries nothing to show. */
export function factOf(e: ValidationResultView['evidence'][number], validatorId: string): EvidenceFact | null {
  const name = e.name ?? '';
  const value = e.value;
  switch (e.type) {
    case 'junit': return value === null ? null : { kind: 'junit', label: 'Test counts', value: str(value), source: 'Reported by the framework' };
    case 'hash': return value === null ? null : { kind: 'hash', label: name || 'Hash', value: shortHash(str(value)), source: 'Hashed by Nexus' };
    case 'http': return { kind: 'http', label: name ? `GET ${name}` : 'Health probe', value: value === null ? 'No answer' : `Answered ${str(value)}`, source: 'Probed by Nexus' };
    case 'git': return value === null ? null : { kind: 'git', label: 'Commit', value: shortHash(str(value)), source: 'Checked with git' };
    case 'exit': return { kind: 'exit', label: 'Exit code', value: value === null ? 'None (stopped by a signal)' : str(value), source: 'Reported by the container' };
    case 'inspect': return value === null ? null : { kind: 'inspect', label: name || 'Container field', value: str(value), source: 'Read with docker inspect' };
    case 'file': return { kind: 'file', label: name || 'File', value: value === null ? 'Recorded' : shortHash(str(value)), source: 'Hashed by Nexus' };
    case 'number': return value === null ? null : { kind: 'number', label: name || 'Count', value: str(value), source: `Recorded by ${validatorId}` };
    case 'schema': return { kind: 'schema', label: name || 'Schema', value: 'Checked', source: `Checked by ${validatorId}` };
    case 'log': return value === null ? null : { kind: 'log', label: 'Log range', value: shortHash(str(value)), source: 'Hashed from the run log' };
    case 'user': return { kind: 'user', label: 'Confirmed by you', value: name || 'Yes', source: 'Your action' };
    default: return value === null ? null : { kind: e.type, label: name || e.type, value: str(value), source: `Recorded by ${validatorId}` };
  }
}

/** The evidence page of one version. Revalidate is offered only for a draft whose blocking checks could not run. */
export function evidenceView(results: readonly ValidationResultView[], version: Pick<VersionView, 'status'> | null): EvidenceView {
  const rows: EvidenceRow[] = results.map((r) => ({
    validatorId: r.validatorId, label: validatorLabel(r.validatorId), word: statusWord(r.status), status: r.status, blocking: r.blocking,
    summary: r.status === 'error' ? `Checks could not run: ${(r.summary ?? 'no reason was recorded').replace(/\.+$/, '')}.` : r.summary,
    facts: r.evidence.map((e) => factOf(e, r.validatorId)).filter((f): f is EvidenceFact => f !== null),
    latestRun: r.latestRun ? { word: statusWord(r.latestRun.status), summary: r.latestRun.summary } : null,
    history: r.history
  }));
  const blocking = results.filter((r) => r.blocking);
  let headline: ChecksHeadline;
  if (results.length === 0) headline = version?.status === 'draft' ? 'Checking…' : 'No checks recorded';
  else if (blocking.some((r) => r.status === 'failed')) headline = 'Checks failed';
  else if (blocking.some((r) => r.status === 'error')) headline = 'Checks could not run';
  else if (blocking.length > 0 && blocking.every((r) => r.status === 'passed' || r.status === 'skipped')) headline = 'Checks passed';
  else if (blocking.length === 0) headline = results.some((r) => r.latestRun?.status === 'failed') ? 'Checks failed' : 'Checks passed';
  else headline = 'Checking…';
  const revalidate = version?.status === 'draft' && blocking.some((r) => r.status === 'error');
  return { headline, rows, revalidate };
}

/** The word a Spine node and a version row show for a version's validation state. */
export function checksWord(state: VersionView['validationState'] | null | undefined, status?: VersionView['status'] | null): string | null {
  // "pending" means "being checked" only for a draft; a version that left draft without a check never reads "Checking…".
  if (state === 'pending' && status && status !== 'draft') return null;
  switch (state) {
    case 'passed': return 'Checks passed';
    case 'failed': return 'Checks failed';
    case 'error': return 'Checks could not run';
    case 'pending': return 'Checking…';
    default: return null;
  }
}

// ---------- log ranges (a diagnostic report's facts point at exact log bytes) ----------

/** A range of an attempt log: open it in the log reader at `offset` for `length` bytes. */
export interface LogRange { jobId: string; attempt: number | null; offset: number; length: number; sha256: string; label: string }

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const nonNegInt = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;

/**
 * The log ranges a diagnostic report's fields cite, for the job whose logs they are (`jobId`). The report names an
 * attempt by an id the views do not carry, so the attempt is known only when the job has exactly one
 * (`attempts === 1`); otherwise `attempt` is null and the reader asks which attempt to open.
 */
export function logRangesOf(report: unknown, jobId: string, attempts: number): LogRange[] {
  if (!isObj(report) || !Array.isArray(report.fields)) return [];
  const seen = new Set<string>();
  const out: LogRange[] = [];
  for (const f of report.fields as unknown[]) {
    if (!isObj(f) || !isObj(f.source) || f.source.type !== 'log') continue;
    const s = f.source;
    if (!nonNegInt(s.offset) || !nonNegInt(s.length) || typeof s.sha256 !== 'string') continue;
    const key = `${s.offset}:${s.length}:${s.sha256}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ jobId, attempt: attempts === 1 ? 1 : null, offset: s.offset, length: s.length, sha256: shortHash(s.sha256),
      label: `Bytes ${s.offset} to ${s.offset + s.length} of the run log` });
  }
  return out;
}

/** A diagnostic report's facts with their sources, for the report viewer. */
export function reportFacts(report: unknown): { name: string; value: string; source: string }[] {
  if (!isObj(report) || !Array.isArray(report.fields)) return [];
  const out: { name: string; value: string; source: string }[] = [];
  for (const f of report.fields as unknown[]) {
    if (!isObj(f) || typeof f.name !== 'string') continue;
    const v = f.value;
    const value = v === null || v === undefined ? 'Not observed' : isObj(v) && typeof v.sha256 === 'string' ? shortHash(v.sha256) : String(v);
    const s = isObj(f.source) ? f.source : {};
    const source = s.type === 'inspect' ? `docker inspect ${typeof s.field === 'string' ? s.field : ''}`.trim()
      : s.type === 'http' ? `health probe ${typeof s.path === 'string' ? s.path : ''}`.trim()
      : s.type === 'log' ? 'run log range'
      : s.type === 'unobserved' ? 'not observed' : 'unknown source';
    out.push({ name: f.name, value, source });
  }
  return out;
}
