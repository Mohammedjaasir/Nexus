/**
 * The nexus:* result envelope. Every handler answers `ok(data)` or `fail(e)`; nothing
 * a handler throws reaches the renderer as a rejection.
 *
 * - RequestError (validate.ts) -> 'invalid', reason 'bad_request', with the field.
 * - PlatformError -> its code. The message is scrubbed (absolute paths cut to their
 *   basename, secrets redacted, one line, at most 300 characters); a known service
 *   reason (detail.reason) is lifted to `reason` and, for user-facing refusals such as
 *   'path_refused', the message is replaced by a plain sentence. `detail` keeps only
 *   allow-listed keys with scalar values.
 * - PlatformError 'platform_unavailable' -> a fixed message and a reason, never the
 *   service text: 'busy' for a held lock (detail.sqliteCode SQLITE_BUSY* or
 *   SQLITE_LOCKED*), 'handoffs_unavailable' (with its sub-reason) when v8 is off,
 *   otherwise 'startup_failed'.
 * - Anything else -> 'internal' with a fixed message, plus ONE log line naming the
 *   channel, the error's name and its code. No stack, no path, no SQLite text.
 */
import type { NexusErrorCode, NexusErrorDetailKey, NexusFail, NexusOk } from '../../shared/nexus/ipc';
import { redactSecretText } from '../nexus/activity/redact';
import { PlatformError } from '../nexus/errors';
import { RequestError } from './validate';

export const MAX_MESSAGE_CHARS = 300;
export const INTERNAL_MESSAGE = 'The request could not be completed.';
const MAX_SCRUB_INPUT = 4000;
const MAX_DETAIL_STRING = 128;

export const DETAIL_KEYS: readonly NexusErrorDetailKey[] = Object.freeze([
  'currentVersionId', 'handoffId', 'versionId', 'participationId', 'liveJobs', 'liveSessions', 'openHandoffs', 'existingId', 'limit'
] as NexusErrorDetailKey[]);

/** Plain sentences for the service reasons a person can act on. Keyed by detail.reason. */
export const REASON_MESSAGES: Readonly<Record<string, string>> = Object.freeze({
  path_refused: 'That file cannot be saved. Paths outside the project folder are refused, and so are files with several '
    + 'hard links (as pnpm stores and some backup tools create them).',
  file_not_found: 'That file was not found in the project folder.',
  too_large: 'That file is too large to save as an artifact.',
  not_text: 'That file is not plain text, so it cannot be saved as a text artifact.',
  secret_in_content: 'That file looks like it holds a secret, so it was not saved.',
  sensitive_name: 'Files of that kind (keys, credentials, environment files, anything under .git) are never saved.',
  project_folder_unavailable: 'The project folder is not available, so nothing was read.',
  not_a_repository: 'The project folder is not a git repository.',
  not_a_commit: 'That commit was not found in the project repository.',
  kind_mismatch: 'That artifact holds a different kind of content.',
  secret_in_metadata: 'The name or details look like they hold a secret, so nothing was saved.',
  produced_by_job: 'A draft made by a job or an agent session is finished by the engine, not marked ready by hand.'
});

export function ok<T>(data: T, truncated?: boolean): NexusOk<T> {
  return truncated === undefined ? { ok: true, data } : { ok: true, data, truncated };
}

const lastSegment = (p: string): string => {
  const parts = p.split(/[\\/]+/).filter((x) => x.length > 0);
  return parts.length ? parts[parts.length - 1] : '';
};

/**
 * One safe line of text: absolute paths (drive letter, UNC, POSIX) are cut to their basename, secret-shaped
 * values are redacted, whitespace runs (newlines too) become one space, and the result is at most 300 characters.
 */
export function scrubMessage(text: string): string {
  let s = typeof text === 'string' ? text.slice(0, MAX_SCRUB_INPUT) : '';
  s = s.replace(/(?:\b[A-Za-z]:[\\/]|\\\\[^\\/\s]+[\\/])[^\s'"`<>|]*/g, (m) => lastSegment(m.replace(/^[A-Za-z]:/, '')));
  s = s.replace(/(^|[\s'"`(=,;\[])(\/[^\s'"`<>|]+)/g, (_m, pre: string, p: string) => `${pre}${lastSegment(p)}`);
  s = redactSecretText(s);
  s = s.replace(/\s+/g, ' ').trim();
  return s.length > MAX_MESSAGE_CHARS ? `${s.slice(0, MAX_MESSAGE_CHARS - 1)}…` : s;
}

const REASON_RE = /^[a-z][a-z0-9_]{0,39}$/;
/** The SQLite result codes of a held lock (immediateTx's detail.sqliteCode). */
const SQLITE_BUSY_RE = /^SQLITE_(BUSY|LOCKED)(_|$)/;
export const BUSY_MESSAGE = 'The database is busy. Try again in a moment.';

function safeDetail(d: Record<string, unknown> | undefined): NexusFail['detail'] {
  if (!d || typeof d !== 'object') return undefined;
  const out: NonNullable<NexusFail['detail']> = {};
  let n = 0;
  for (const k of DETAIL_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(d, k)) continue;
    const v = d[k];
    if (v === null) out[k] = null;
    else if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
    else if (typeof v === 'string') out[k] = scrubMessage(v).slice(0, MAX_DETAIL_STRING);
    else continue;
    n++;
  }
  return n > 0 ? out : undefined;
}

const safeToken = (v: unknown, fallback: string): string =>
  typeof v === 'string' && /^[A-Za-z0-9_.-]{1,40}$/.test(v) ? v : fallback;

/** The failure answer for anything a handler threw. Never throws itself. */
export function fail(e: unknown, channel: string, log: (l: string) => void): NexusFail {
  try {
    if (e instanceof RequestError) {
      return { ok: false, code: 'invalid', message: scrubMessage(`Invalid request: ${e.field} ${e.why}.`), reason: 'bad_request', field: e.field };
    }
    if (e instanceof PlatformError) {
      const raw = e.detail && typeof e.detail === 'object' ? e.detail : undefined;
      // 'platform_unavailable' from a service never carries its own text (it may name a principal or a table):
      // a fixed message and a reason. Handoffs off keeps its reason and sub-reason; a lock is 'busy'; anything
      // else (a seeded row missing, a shape problem found late) is 'startup_failed'.
      if (e.code === 'platform_unavailable') {
        if (raw && raw.reason === 'handoffs_unavailable') return unavailable('handoffs_unavailable', typeof raw.subReason === 'string' ? raw.subReason : null);
        const busy = raw !== undefined && typeof raw.sqliteCode === 'string' && SQLITE_BUSY_RE.test(raw.sqliteCode);
        return busy
          ? { ok: false, code: 'platform_unavailable', message: BUSY_MESSAGE, reason: 'busy' }
          : unavailable('startup_failed');
      }
      const reason = raw && typeof raw.reason === 'string' && REASON_RE.test(raw.reason) ? raw.reason : undefined;
      const known = reason !== undefined && Object.prototype.hasOwnProperty.call(REASON_MESSAGES, reason) ? REASON_MESSAGES[reason] : undefined;
      const out: NexusFail = { ok: false, code: e.code as NexusErrorCode, message: known ?? (scrubMessage(e.message) || 'The request was refused.') };
      if (reason !== undefined) out.reason = reason;
      const detail = safeDetail(raw);
      if (detail) out.detail = detail;
      return out;
    }
  } catch { /* fall through to internal */ }
  const name = safeToken(e instanceof Error ? e.name : typeof e, 'unknown');
  const code = safeToken(e && typeof e === 'object' ? (e as { code?: unknown }).code : undefined, 'none');
  try { log(`[nexus-ipc] ${channel} failed error=${name} code=${code}`); } catch { /* logging never breaks the answer */ }
  return { ok: false, code: 'internal', message: INTERNAL_MESSAGE };
}

/** The answer of every channel while the platform (or, for handoff channels, v8) is not in place. */
export function unavailable(reason: string, subReason?: string | null): NexusFail {
  const out: NexusFail = reason === 'handoffs_unavailable'
    ? { ok: false, code: 'platform_unavailable', message: 'Handoffs are not available on this database.', reason }
    : { ok: false, code: 'platform_unavailable', message: 'The Nexus platform is not available.', reason };
  if (reason === 'handoffs_unavailable' && typeof subReason === 'string' && REASON_RE.test(subReason)) out.subReason = subReason;
  return out;
}
