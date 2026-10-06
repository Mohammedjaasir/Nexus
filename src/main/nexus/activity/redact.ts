/**
 * Redaction for activity details. Every `details_json` written to the activity
 * log is the output of `redactDetails`, so the log never stores secrets or
 * contents:
 * - keys that name a secret (token, password, api key, dsn, signature, ...) lose their value;
 * - every string goes through the crash-log redactor (`redactForLog`), which strips
 *   secret-shaped values (provider keys, bearer tokens, URL credentials, long hex),
 *   plus two extra passes here: URL user names and `sig=` / `signature=` values;
 * - long strings and binaries become size markers, never the bytes themselves;
 * - depth, array length, key count and total size are capped, so the output is
 *   bounded, fast to produce and always JSON-serialisable (cycles end at the depth cap).
 *
 * Integrity hashes are evidence, not secrets: a hex digest (optionally `git:`-prefixed)
 * under one of the known hash keys (`HASH_KEYS`) is kept as is. Under any other key
 * the same hex is redacted, and a non-digest value under a hash key is redacted as usual.
 */
import { redactForLog } from '../../crashLog';

export const REDACTED = '[redacted]';
export const MAX_STRING = 512; export const MAX_DEPTH = 4; export const MAX_ARRAY = 50; export const MAX_KEYS = 50;
/** Upper bound on the UTF-8 size of the stored details JSON. */
export const MAX_DETAILS_BYTES = 16384;

const TRUNCATED = '[truncated]';
const SECRET_KEY = new RegExp([
  'secret', 'token', 'passw', 'pwd', 'passphrase', 'api[-_ ]?key', 'authorization', 'cookie', 'credential',
  'private[-_ ]?key', 'session[-_ ]?key', 'access[-_ ]?key', 'auth[-_ ]?(?:token|header)', '^auth$', 'signature', 'dsn',
  'conn(?:ection)?[-_ ]?str(?:ing)?'
].join('|'), 'i');
/** Known non-secret integrity hash fields (controller ruling, Task 5). */
const HASH_KEYS: ReadonlySet<string> = new Set(['backupSha256', 'sha256', 'contentHash', 'content_hash']);
const HEX_DIGEST = /^(?:git:)?[0-9a-f]{40,128}$/i;
/** Exact keys whose NUMERIC values are token usage counts (never a credential). */
const TOKEN_COUNT_KEYS: ReadonlySet<string> = new Set([
  'tokensUsed', 'inputTokens', 'outputTokens', 'totalTokens', 'maxTokens',
  'cacheReadTokens', 'cacheCreationTokens', 'tokenCount', 'tokenLimit'
]);
const URL_USER = /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi;
const SIGNATURE_PAIR = /\b((?:[a-z0-9]+[_-])*(?:sig|signature))(["']?)(\s*[:=]\s*)(?:(["'])(?:\\.|(?!\4)[^\\])*\4|[^\s"',}&]+)/gi;
const DROP = Symbol('drop');
type Out = unknown | typeof DROP;

/** Remaining output budget, in (approximate) bytes, for one redactDetails call. */
interface Budget { left: number }

function redactString(s: string): string {
  if (s.length > MAX_STRING) return `[omitted: ${s.length} chars]`;
  return redactForLog(s)
    .replace(URL_USER, '$1[redacted]@')
    .replace(SIGNATURE_PAIR, (_m, k, q, sep, vq) => `${k}${q}${sep}${vq ? `${vq}${REDACTED}${vq}` : REDACTED}`);
}

function isBinary(v: object): number | null {
  if (typeof Buffer !== 'undefined' && Buffer.isBuffer(v)) return v.length;
  if (ArrayBuffer.isView(v)) return v.byteLength;
  if (v instanceof ArrayBuffer) return v.byteLength;
  return null;
}

/** Charge a leaf's size; once the budget is gone every further value is a marker. */
function charge(b: Budget, v: unknown): unknown {
  const size = typeof v === 'string' ? v.length + 3 : 8;
  if (b.left <= 0) return TRUNCATED;
  b.left -= size;
  return v;
}

function walk(v: unknown, depth: number, b: Budget): Out {
  switch (typeof v) {
    case 'string': return charge(b, redactString(v));
    case 'number': return charge(b, Number.isFinite(v) ? v : null);
    case 'boolean': return charge(b, v);
    case 'bigint': return charge(b, redactString(String(v)));
    case 'undefined': case 'function': case 'symbol': return DROP;
    default: break;
  }
  if (v === null) return charge(b, null);
  if (b.left <= 0) return TRUNCATED;
  const obj = v as object;
  const bytes = isBinary(obj);
  if (bytes !== null) return charge(b, `[binary: ${bytes} bytes]`);
  if (obj instanceof Date) return charge(b, Number.isNaN(obj.getTime()) ? null : obj.toISOString());
  if (depth >= MAX_DEPTH) return charge(b, TRUNCATED);
  if (Array.isArray(obj)) return walkArray(obj, depth, b);
  if (obj instanceof Error) {
    return walkObject({ name: String(obj.name), message: String(obj.message) }, depth, b);
  }
  return walkObject(obj as Record<string, unknown>, depth, b);
}

function walkArray(arr: unknown[], depth: number, b: Budget): unknown[] {
  const out: unknown[] = [];
  const n = Math.min(arr.length, MAX_ARRAY);
  b.left -= 2;
  let i = 0;
  for (; i < n && b.left > 0; i++) {
    let item: Out;
    try { item = walk(arr[i], depth + 1, b); } catch { item = REDACTED; }
    out.push(item === DROP ? null : item);
  }
  if (arr.length > i) out.push(TRUNCATED);
  return out;
}

/** Own, enumerable data property, so `__proto__` is kept as a key; colliding names get a suffix. */
function put(out: Record<string, unknown>, key: string, value: unknown): void {
  let name = key;
  for (let n = 2; Object.prototype.hasOwnProperty.call(out, name); n++) name = `${key}~${n}`;
  Object.defineProperty(out, name, { value, enumerable: true, writable: true, configurable: true });
}

function walkObject(obj: Record<string, unknown>, depth: number, b: Budget): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const keys = Object.keys(obj);
  b.left -= 2;
  let seen = 0;
  for (const key of keys.slice(0, MAX_KEYS)) {
    if (b.left <= 0) break;
    seen++;
    const safeKey = key.length > MAX_STRING ? `[omitted key: ${key.length} chars]` : redactForLog(key).replace(URL_USER, '$1[redacted]@');
    // Token COUNTS are audit data, not credentials: keep them only as plain numbers.
    if (TOKEN_COUNT_KEYS.has(key) && typeof obj[key] === 'number' && Number.isFinite(obj[key])) {
      b.left -= safeKey.length + 3 + String(obj[key]).length; put(out, safeKey, obj[key] as number); continue;
    }
    if (SECRET_KEY.test(key)) { b.left -= safeKey.length + 3; put(out, safeKey, charge(b, REDACTED)); continue; }
    let item: Out;
    try {
      const raw = obj[key];
      item = HASH_KEYS.has(key) && typeof raw === 'string' && HEX_DIGEST.test(raw) ? charge(b, raw) : walk(raw, depth + 1, b);
    } catch {
      item = REDACTED;
    }
    if (item !== DROP) { b.left -= safeKey.length + 3; put(out, safeKey, item); }
  }
  if (keys.length > seen) put(out, '__truncated', TRUNCATED);
  return out;
}

function capped(out: Record<string, unknown>): Record<string, unknown> {
  const bytes = Buffer.byteLength(JSON.stringify(out) ?? '{}', 'utf8');
  return bytes > MAX_DETAILS_BYTES ? { omitted: `[details too large: ${bytes} bytes]` } : out;
}

/** The only shape that may be stored in `activity.details_json`. Never throws. */
export function redactDetails(value: unknown): Record<string, unknown> {
  try {
    if (value === null || value === undefined) return {};
    const b: Budget = { left: MAX_DETAILS_BYTES - 1024 };   // margin for markers and JSON punctuation the estimate misses
    if (typeof value === 'object' && !Array.isArray(value) && isBinary(value) === null && !(value instanceof Date)) {
      return capped(walk(value, 0, b) as Record<string, unknown>);
    }
    const v = walk(value, 1, b);
    return v === DROP ? {} : capped({ value: v });
  } catch {
    return { value: '[unredactable details omitted]' };
  }
}
