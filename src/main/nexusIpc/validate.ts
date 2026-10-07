/**
 * The one request validator every nexus:* handler uses. The renderer sends ids and
 * small values only; each is checked here against a fixed shape before any service
 * runs. A refusal is a RequestError (field + why), which the envelope turns into
 * { ok: false, code: 'invalid', reason: 'bad_request', field }.
 *
 * - Objects are plain objects with an exact key set: an unknown key is refused, and
 *   so is an own `__proto__`, `constructor` or `prototype` key. No schema has a key
 *   for a principal, an actor, a role or a folder; the only path-like field is
 *   `relPath`, which the source port confines again with realpath.
 * - Strings have length caps and patterns; numbers are finite integers in range;
 *   arrays hold unique entries within their bounds.
 * Pure: no I/O and no service access.
 */

export class RequestError extends Error {
  constructor(readonly field: string, readonly why: string) {
    super(`${field} ${why}`);
    this.name = 'RequestError';
  }
}

/** The ULID shape newId produces (Crockford base32, upper case). */
const PLATFORM_ID = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const PROJECT_ID = /^[A-Za-z0-9_-]{1,64}$/;
const WORKSPACE_ID = /^[a-z][a-z0-9-]{1,31}$/;
const COMMIT = /^[0-9a-f]{40}$/;
/** The artifact kind registry's identifier shape (an artifact kind, never a principal kind). */
const ARTIFACT_KIND = /^[a-z][a-z0-9_.-]{1,39}$/;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\x00-\x1F\x7F]/;
const MAX_REL_PATH = 1024;
const MAX_TITLE = 200;
const MAX_NOTE = 2000;
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

const isPlain = (x: unknown): x is Record<string, unknown> => {
  if (typeof x !== 'object' || x === null || Array.isArray(x)) return false;
  const proto = Object.getPrototypeOf(x);
  return proto === Object.prototype || proto === null;
};

function str(x: unknown, f: string): string {
  if (typeof x !== 'string') throw new RequestError(f, 'must be a string');
  return x;
}
function pattern(x: unknown, f: string, re: RegExp, max: number): string {
  const s = str(x, f);
  if (s.length === 0 || s.length > max || !re.test(s)) throw new RequestError(f, 'is not a valid id');
  return s;
}

export const V = {
  /** An artifact, version, participation or handoff id. */
  platformId(x: unknown, f: string): string { return pattern(x, f, PLATFORM_ID, 26); },
  projectId(x: unknown): string { return pattern(x, 'projectId', PROJECT_ID, 64); },
  workspaceId(x: unknown): string { return pattern(x, 'workspaceId', WORKSPACE_ID, 32); },
  commit(x: unknown): string {
    const s = str(x, 'commit');
    if (!COMMIT.test(s)) throw new RequestError('commit', 'must be a full 40-character commit id');
    return s;
  },
  /** An artifact kind filter. */
  artifactKind(x: unknown, f: string): string {
    const s = str(x, f);
    if (!ARTIFACT_KIND.test(s)) throw new RequestError(f, 'is not a valid artifact kind');
    return s;
  },
  /**
   * A path relative to the project folder. Rejected: empty, too long, NUL, absolute (POSIX, drive letter or UNC),
   * any '..' segment. Backslashes become '/'. The source port confines it again with realpath.
   */
  relPath(x: unknown): string {
    const s = str(x, 'relPath');
    if (s.length === 0 || s.length > MAX_REL_PATH) throw new RequestError('relPath', `must be 1 to ${MAX_REL_PATH} characters`);
    if (s.includes('\0')) throw new RequestError('relPath', 'must not contain NUL');
    const n = s.replace(/\\/g, '/');
    if (n.startsWith('/') || /^[A-Za-z]:/.test(n)) throw new RequestError('relPath', 'must be relative to the project folder');
    if (n.split('/').some((seg) => seg === '..')) throw new RequestError('relPath', 'must stay inside the project folder');
    return n;
  },
  /** A title or a name: trimmed, 1 to 200 characters, no control characters. */
  title(x: unknown, f: string): string {
    const s = str(x, f).trim();
    if (s.length === 0 || s.length > MAX_TITLE) throw new RequestError(f, `must be 1 to ${MAX_TITLE} characters`);
    if (CONTROL.test(s)) throw new RequestError(f, 'must not contain control characters');
    return s;
  },
  /** An optional note: 0 to 2000 characters, no NUL. */
  note(x: unknown): string | undefined {
    if (x === undefined) return undefined;
    const s = str(x, 'note');
    if (s.length > MAX_NOTE) throw new RequestError('note', `must be at most ${MAX_NOTE} characters`);
    if (s.includes('\0')) throw new RequestError('note', 'must not contain NUL');
    return s;
  },
  /** 1..max unique platform ids. */
  idList(x: unknown, f: string, max: number): string[] {
    if (!Array.isArray(x) || x.length < 1 || x.length > max) throw new RequestError(f, `must list 1 to ${max} ids`);
    const out = x.map((v, i) => V.platformId(v, `${f}[${i}]`));
    if (new Set(out).size !== out.length) throw new RequestError(f, 'must not repeat an id');
    return out;
  },
  /**
   * A plain object with exactly these keys: every key not in `optional` is required, and an unknown key
   * is refused. Returns a null-prototype copy holding only the declared keys.
   */
  object<K extends string>(x: unknown, keys: readonly K[], optional: readonly K[] = []): Record<K, unknown> {
    if (!isPlain(x)) throw new RequestError('request', 'must be an object');
    const own = Reflect.ownKeys(x);
    for (const k of own) {
      if (typeof k !== 'string' || FORBIDDEN_KEYS.has(k)) throw new RequestError('request', 'has a forbidden key');
      // An unknown key is named back only when it is a plain identifier, so nothing hostile is echoed.
      if (!(keys as readonly string[]).includes(k)) throw new RequestError(/^[A-Za-z][A-Za-z0-9_]{0,39}$/.test(k) ? k : 'request', 'is not an accepted field');
    }
    const out = Object.create(null) as Record<K, unknown>;
    for (const k of keys) {
      const has = Object.prototype.hasOwnProperty.call(x, k);
      const v = has ? (x as Record<string, unknown>)[k] : undefined;
      if (v === undefined && !optional.includes(k)) throw new RequestError(k, 'is required');
      out[k] = v;
    }
    return out;
  },
  enumOf<T extends string>(x: unknown, f: string, values: readonly T[]): T {
    if (typeof x !== 'string' || !(values as readonly string[]).includes(x)) throw new RequestError(f, `must be one of ${values.join(', ')}`);
    return x as T;
  },
  int(x: unknown, f: string, min: number, max: number): number {
    if (typeof x !== 'number' || !Number.isSafeInteger(x) || x < min || x > max) throw new RequestError(f, `must be an integer from ${min} to ${max}`);
    return x;
  },
  /** The positional arguments of a channel: at most `n`; trailing undefined arguments are ignored. */
  arity(args: readonly unknown[], n: number): void {
    for (let i = n; i < args.length; i++) if (args[i] !== undefined) throw new RequestError('arguments', `takes at most ${n}`);
  }
};
