/**
 * `sde.diagnose` in the runner (B2a Task 12, amendment A1): an engine task, no container. It reads what Docker says
 * about the subject's containers and hashes byte ranges of the subject's attempt logs; main adds its own probe table
 * (the deployment's `health_json`) and stores the report (ingest.ts), and `diag.schema` checks that every field names
 * an `inspect`, `http` or `log` source.
 *
 * - Containers: a container is inspected only when its labels say it is this install's (`nexus.home`) and an attempt's
 *   (`nexus.attempt`); any other container (the user's own) is reported `not_owned` with no facts, and nothing of it is
 *   read beyond its labels: the driver reads the labels alone first and fetches the full record only for an owned one. A container Docker does not know is `missing`; Docker not answering is `unavailable`.
 * - Facts: the fixed set `containerFacts` extracts (state, exit, OOM, restarts, times, the image id, the applied
 *   limits, the network mode, the user, the published ports). Never the environment, the command or a host path.
 * - Logs: each range names an attempt log under the data home (`logs/jobs/<jobId>/<n>.log`, re-derived here; a link at
 *   any step is refused). The bytes of `[offset, offset + length)`, clamped to the file, are hashed; the report carries
 *   the range actually read, its sha256, its frame count, how many frames look like errors, and the last output line
 *   (redacted, at most 200 characters). The bytes themselves stay in the log (the log reader serves them by offset).
 * - Ids are kept under `sha256` keys (`container.sha256`, `image.sha256`): the redactor reads a hex digest as an
 *   integrity hash only there, so the report is never withheld as secret-shaped.
 */
import { createHash } from 'node:crypto';
import {
  DIAGNOSE_LAST_TEXT_MAX, DIAGNOSE_MAX_CONTAINERS, DIAGNOSE_MAX_RANGES, DIAGNOSE_RANGE_MAX_BYTES,
  type DiagnoseLogRange, type DiagnoseResult, type EngineTask
} from '../shared/nexus/execution';
import { ULID_RE } from '../shared/nexus/runnerProtocol';
import { containsSecret, redactSecretText } from '../main/nexus/activity/redact';
import { errCode, noLinkUnder, type HomePaths } from './paths';
import type { RunnerDriver, RunnerFs } from './types';

const CONTAINER_RE = /^[0-9a-f]{64}$/;
/** A frame whose text looks like a failure (counted, never interpreted further). */
export const ERROR_FRAME_RE = /\b(error|exception|fatal|panic|traceback|unhandled|segmentation fault|out of memory)\b/i;
export const LAST_TEXT_MAX = DIAGNOSE_LAST_TEXT_MAX;

type DiagnoseTask = Extract<EngineTask, { engine: 'sde.diagnose' }>;

/** Why a diagnosis plan is not exactly what main derives, or null. */
export function diagnoseTaskProblem(t: DiagnoseTask): string | null {
  if (t.target !== 'deployment' && t.target !== 'job') return 'the diagnosis target is unknown';
  if (!Array.isArray(t.containerIds) || t.containerIds.length > DIAGNOSE_MAX_CONTAINERS
    || !t.containerIds.every((c) => typeof c === 'string' && CONTAINER_RE.test(c))) return 'the diagnosed containers are not container ids';
  if (!Array.isArray(t.logRanges) || t.logRanges.length > DIAGNOSE_MAX_RANGES) return 'too many log ranges';
  for (const r of t.logRanges) {
    if (!r || typeof r.attemptId !== 'string' || !ULID_RE.test(r.attemptId) || typeof r.logPath !== 'string' || typeof r.tail !== 'boolean') return 'a log range is malformed';
    if (!Number.isSafeInteger(r.offset) || r.offset < 0 || !Number.isSafeInteger(r.length) || r.length < 0 || r.length > DIAGNOSE_RANGE_MAX_BYTES) {
      return 'a log range is out of bounds';
    }
  }
  if (t.containerIds.length === 0 && t.logRanges.length === 0) return 'the diagnosis names nothing to read';
  return null;
}

interface Deps { driver: RunnerDriver; fs: RunnerFs; paths: HomePaths; home: string }

async function readRange(d: Deps, r: DiagnoseLogRange): Promise<DiagnoseResult['logs'][number]> {
  const none = (status: 'missing' | 'refused'): DiagnoseResult['logs'][number] =>
    ({ attemptId: r.attemptId, status, offset: r.offset, length: 0, sha256: null, frames: 0, errorFrames: 0, lastText: null });
  const loc = d.paths.parseLogPath(r.logPath);
  if (!loc) return none('refused');
  const abs = d.paths.logPath(loc.jobId, loc.n);
  if (!(await noLinkUnder(d.fs, d.paths.root, abs))) return none('refused');
  let fh: Awaited<ReturnType<RunnerFs['open']>> | null = null;
  try {
    fh = await d.fs.open(abs, 'r');
    const st = await fh.stat();
    if (!st.isFile()) return none('refused');
    const start = r.tail ? Math.max(0, st.size - r.length) : Math.min(r.offset, st.size);
    const len = Math.min(r.length, st.size - start);
    const buf = Buffer.alloc(len);
    let got = 0;
    while (got < len) {
      const { bytesRead } = await fh.read(buf, got, len - got, start + got);
      if (bytesRead === 0) break;
      got += bytesRead;
    }
    const bytes = buf.subarray(0, got);
    const lines = bytes.toString('utf8').split('\n');
    if (start > 0) lines.shift();                       // a frame cut by the range start is not counted
    if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
    let frames = 0; let errorFrames = 0; let lastText: string | null = null;
    for (const line of lines) {
      let f: { stream?: unknown; text?: unknown } | null = null;
      try { f = JSON.parse(line) as { stream?: unknown; text?: unknown }; } catch { f = null; }
      if (!f || typeof f.text !== 'string') continue;
      frames++;
      if (ERROR_FRAME_RE.test(f.text)) errorFrames++;
      if (f.stream === 'stdout' || f.stream === 'stderr') {
        const t = redactSecretText(f.text).replace(/[\r\n\t\0]+/g, ' ').trim();
        // A line the stricter check still flags is left out (the report is never withheld for one line).
        if (t.length > 0) lastText = containsSecret(t.slice(0, LAST_TEXT_MAX)) ? '[a line was left out: it looked like a secret]' : t.slice(0, LAST_TEXT_MAX);
      }
    }
    return { attemptId: r.attemptId, status: 'read', offset: start, length: got, sha256: createHash('sha256').update(bytes).digest('hex'),
      frames, errorFrames, lastText };
  } catch (e) {
    return none(errCode(e) === 'ENOENT' ? 'missing' : 'refused');
  } finally {
    if (fh) { try { await fh.close(); } catch { /* closed */ } }
  }
}

/** Runs one diagnosis (the caller checked the task with diagnoseTaskProblem). */
export async function diagnose(d: Deps, t: DiagnoseTask, signal: AbortSignal): Promise<DiagnoseResult> {
  const containers: DiagnoseResult['containers'] = [];
  for (const id of t.containerIds) {
    if (signal.aborted) throw new Error('the diagnosis was stopped');
    try {
      // The driver checks ownership from the labels BEFORE it reads anything else of the container.
      const r = d.home ? await d.driver.inspectFacts(id, d.home) : { owned: false as const };
      if (!r) containers.push({ container: { sha256: id }, status: 'missing', facts: null });
      else if (!r.owned) containers.push({ container: { sha256: id }, status: 'not_owned', facts: null });
      else containers.push({ container: { sha256: id }, status: 'inspected', facts: r.facts });
    } catch {
      containers.push({ container: { sha256: id }, status: 'unavailable', facts: null });
    }
  }
  const logs: DiagnoseResult['logs'] = [];
  for (const r of t.logRanges) {
    if (signal.aborted) throw new Error('the diagnosis was stopped');
    logs.push(await readRange(d, r));
  }
  return { target: t.target, containers, logs };
}
