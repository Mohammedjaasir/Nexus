/**
 * Redaction for activity details. Every `details_json` written to the activity
 * log is the output of `redactDetails`, so the log never stores secrets or
 * contents:
 * - keys that name a secret (token, password, api key, cookie, ...) lose their value;
 * - every string goes through the crash-log redactor (`redactForLog`), which strips
 *   secret-shaped values (provider keys, bearer tokens, URL credentials, long hex);
 * - long strings and binaries become size markers, never the bytes themselves;
 * - depth, array length and key count are capped, so the output is bounded and
 *   always JSON-serialisable (cycles end at the depth cap).
 *
 * Integrity hashes are evidence, not secrets: a pure hex value under one of the
 * known hash keys (`HASH_KEYS`) is kept as is. Under any other key the same hex
 * is redacted, and a non-hex value under a hash key is redacted as usual.
 */
import { redactForLog } from '../../crashLog';

export const REDACTED = '[redacted]';
export const MAX_STRING = 512; export const MAX_DEPTH = 4; export const MAX_ARRAY = 50; export const MAX_KEYS = 50;

const TRUNCATED = '[truncated]';
const SECRET_KEY = /secret|token|passw|api[-_]?key|authorization|cookie|credential|private[-_]?key|session[-_]?key/i;
/** Known non-secret integrity hash fields (controller ruling, Task 5). */
const HASH_KEYS: ReadonlySet<string> = new Set(['backupSha256', 'sha256', 'contentHash', 'content_hash']);
const HEX_DIGEST = /^[0-9a-f]{16,128}$/i;
const DROP = Symbol('drop');
type Out = unknown | typeof DROP;

function redactString(s: string): string {
  if (s.length > MAX_STRING) return `[omitted: ${s.length} chars]`;
  return redactForLog(s);
}

function isBinary(v: object): number | null {
  if (typeof Buffer !== 'undefined' && Buffer.isBuffer(v)) return v.length;
  if (ArrayBuffer.isView(v)) return v.byteLength;
  if (v instanceof ArrayBuffer) return v.byteLength;
  return null;
}

function walk(v: unknown, depth: number): Out {
  switch (typeof v) {
    case 'string': return redactString(v);
    case 'number': return Number.isFinite(v) ? v : null;
    case 'boolean': return v;
    case 'bigint': return redactString(String(v));
    case 'undefined': case 'function': case 'symbol': return DROP;
    default: break;
  }
  if (v === null) return null;
  const obj = v as object;
  const bytes = isBinary(obj);
  if (bytes !== null) return `[binary: ${bytes} bytes]`;
  if (obj instanceof Date) return Number.isNaN(obj.getTime()) ? null : obj.toISOString();
  if (depth >= MAX_DEPTH) return TRUNCATED;
  if (Array.isArray(obj)) return walkArray(obj, depth);
  if (obj instanceof Error) return { name: redactString(String(obj.name)), message: redactString(String(obj.message)) };
  return walkObject(obj as Record<string, unknown>, depth);
}

function walkArray(arr: unknown[], depth: number): unknown[] {
  const out: unknown[] = [];
  const n = Math.min(arr.length, MAX_ARRAY);
  for (let i = 0; i < n; i++) {
    let item: Out;
    try { item = walk(arr[i], depth + 1); } catch { item = REDACTED; }
    out.push(item === DROP ? null : item);
  }
  if (arr.length > MAX_ARRAY) out.push(TRUNCATED);
  return out;
}

function walkObject(obj: Record<string, unknown>, depth: number): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const keys = Object.keys(obj);
  for (const key of keys.slice(0, MAX_KEYS)) {
    const safeKey = redactForLog(key);
    if (SECRET_KEY.test(key)) { out[safeKey] = REDACTED; continue; }
    let item: Out;
    try {
      const raw = obj[key];
      item = HASH_KEYS.has(key) && typeof raw === 'string' && HEX_DIGEST.test(raw) ? raw : walk(raw, depth + 1);
    } catch {
      item = REDACTED;
    }
    if (item !== DROP) out[safeKey] = item;
  }
  if (keys.length > MAX_KEYS) out.__truncated = TRUNCATED;
  return out;
}

/** The only shape that may be stored in `activity.details_json`. Never throws. */
export function redactDetails(value: unknown): Record<string, unknown> {
  try {
    if (value === null || value === undefined) return {};
    if (typeof value === 'object' && !Array.isArray(value) && isBinary(value) === null && !(value instanceof Date)) {
      return walk(value, 0) as Record<string, unknown>;
    }
    const v = walk(value, 1);
    return v === DROP ? {} : { value: v };
  } catch {
    return { value: '[unredactable details omitted]' };
  }
}
