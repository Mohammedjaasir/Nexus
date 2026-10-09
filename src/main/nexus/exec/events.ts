/**
 * Job events (schema v9 `job_events`): append-only, redacted execution facts, read by the
 * renderer through `eventsSince` (a cursor on `seq`). Heartbeats are never events.
 *
 * - `appendJobEventTx` runs INSIDE the caller's IMMEDIATE transaction, so an event commits
 *   or rolls back with the change it records.
 * - `data_json` is `redactDetails(data)` (the activity redactor: secret keys and values,
 *   long strings and binaries never stored) and is capped at 4 KiB, the DDL bound. A larger
 *   payload is replaced by `{ omitted: '[event data too large: <n> bytes]' }`, never cut
 *   mid-JSON.
 * - `summary` is redacted with `redactText`, collapsed to one line and cut to 200 characters.
 * - The project of a job event is the job's (tr_job_events_insert checks it); callers pass it.
 */
import type Database from 'better-sqlite3';
import { redactDetails, redactText } from '../activity/redact';
import { PlatformError } from '../errors';

export const MAX_EVENT_DATA_BYTES = 4096;
export const MAX_EVENT_SUMMARY_CHARS = 200;

export type JobEventType =
  | 'job.transition' | 'attempt.transition' | 'attempt.provisioned' | 'attempt.progress' | 'attempt.output'
  | 'attempt.heartbeat_gap' | 'approval' | 'deployment' | 'validation' | 'image_build' | 'recovery' | 'preflight';

export interface NewJobEvent {
  type: JobEventType;
  summary: string;
  projectId: string | null;
  jobId?: string | null;
  attemptN?: number | null;
  approvalId?: string | null;
  deploymentId?: string | null;
  imageBuildId?: string | null;
  data?: unknown;
}

/** A stored event, as `eventsSince` returns it. */
export interface JobEvent {
  seq: number; ts: number; projectId: string | null; jobId: string | null; attemptN: number | null;
  imageBuildId: string | null; approvalId: string | null; deploymentId: string | null;
  type: JobEventType; summary: string; data: Record<string, unknown>;
}

export interface JobEventRow {
  seq: number; ts: number; project_id: string | null; job_id: string | null; attempt_n: number | null;
  image_build_id: string | null; approval_id: string | null; deployment_id: string | null;
  type: JobEventType; summary: string; data_json: string;
}

export function eventDataJson(data: unknown): string {
  const text = JSON.stringify(redactDetails(data ?? {}));
  const bytes = Buffer.byteLength(text, 'utf8');
  return bytes <= MAX_EVENT_DATA_BYTES ? text : JSON.stringify({ omitted: `[event data too large: ${bytes} bytes]` });
}

export function eventSummary(s: string): string {
  const one = redactText(String(s ?? '')).replace(/[\r\n\t]+/g, ' ').trim();
  const cut = one.length > MAX_EVENT_SUMMARY_CHARS ? `${one.slice(0, MAX_EVENT_SUMMARY_CHARS - 1)}…` : one;
  return cut.length > 0 ? cut : 'event';
}

/** Inside the caller's transaction: one `job_events` row. Returns its `seq`. */
export function appendJobEventTx(db: Database.Database, e: NewJobEvent, now: number): number {
  if (!db.inTransaction) throw new PlatformError('platform_unavailable', 'appendJobEventTx needs an open transaction');
  const r = db.prepare(`INSERT INTO job_events (ts, project_id, job_id, attempt_n, image_build_id, approval_id, deployment_id, type,
      summary, data_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(now, e.projectId, e.jobId ?? null, e.attemptN ?? null,
    e.imageBuildId ?? null, e.approvalId ?? null, e.deploymentId ?? null, e.type, eventSummary(e.summary), eventDataJson(e.data));
  return Number(r.lastInsertRowid);
}

export function toJobEvent(r: JobEventRow): JobEvent {
  let data: Record<string, unknown> = {};
  try {
    const v = JSON.parse(r.data_json) as unknown;
    if (v && typeof v === 'object' && !Array.isArray(v)) data = v as Record<string, unknown>;
  } catch { /* json_valid CHECK makes this unreachable */ }
  return { seq: r.seq, ts: r.ts, projectId: r.project_id, jobId: r.job_id, attemptN: r.attempt_n, imageBuildId: r.image_build_id,
    approvalId: r.approval_id, deploymentId: r.deployment_id, type: r.type, summary: r.summary, data };
}
