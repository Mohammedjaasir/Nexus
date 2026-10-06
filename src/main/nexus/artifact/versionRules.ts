/**
 * Pure rules for artifact versions: the F.7 status machine, storage validation and
 * the content hash. No I/O; the database enforces the same table in
 * `tr_versions_status` (schema v7), and the two must stay identical.
 */
import { createHash } from 'node:crypto';
import type { StorageRef, VersionStatus } from '../../../shared/nexus/platform';
import { canonicalJson } from '../db/canonical';
import { PlatformError } from '../errors';

/** F.7. Mirrors tr_versions_status exactly. */
export const VERSION_TRANSITIONS: Readonly<Record<VersionStatus, readonly VersionStatus[]>> = Object.freeze({
  draft: Object.freeze(['candidate', 'failed', 'deprecated'] as VersionStatus[]),
  candidate: Object.freeze(['active', 'deprecated'] as VersionStatus[]),
  active: Object.freeze(['deprecated'] as VersionStatus[]),
  failed: Object.freeze([] as VersionStatus[]),
  deprecated: Object.freeze(['active'] as VersionStatus[])
});

export function canTransitionVersion(from: VersionStatus, to: VersionStatus): boolean {
  const next = Object.prototype.hasOwnProperty.call(VERSION_TRANSITIONS, from) ? VERSION_TRANSITIONS[from] : undefined;
  return Array.isArray(next) && next.includes(to);
}

/** Storage kinds B0b can register. blob, tree and external wait for the blob store. */
export const B0B_STORAGE_KINDS: readonly StorageRef['kind'][] = Object.freeze(['inline', 'git'] as StorageRef['kind'][]);
const ALL_STORAGE_KINDS: readonly string[] = ['git', 'blob', 'tree', 'external', 'inline'];

/** Largest inline payload, measured as UTF-8 bytes of its canonical JSON. */
export const INLINE_MAX_BYTES = 65536;
const MAX_GIT_REF_CHARS = 256;
const MAX_GIT_PATHS = 1000;
const MAX_GIT_PATH_CHARS = 1024;

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** Deepest nesting accepted in caller JSON (bounds the walk below). */
export const MAX_JSON_DEPTH = 64;

/**
 * Throws PlatformError 'invalid' unless `v` survives JSON.stringify -> JSON.parse
 * EXACTLY: only null, booleans, finite numbers (not -0), strings, arrays without
 * holes or undefined, and plain objects (prototype Object or null) whose members
 * are all exact JSON. Functions, symbols, bigint, undefined, NaN/Infinity, class
 * instances (Date, Map, anything with toJSON), symbol keys and cycles are refused,
 * never coerced.
 */
export function assertExactJson(v: unknown, what = 'value'): void {
  const stack = new Set<object>();
  const walk = (x: unknown, depth: number): void => {
    if (depth > MAX_JSON_DEPTH) throw new PlatformError('invalid', `${what} is nested too deeply`);
    if (x === null || typeof x === 'string' || typeof x === 'boolean') return;
    if (typeof x === 'number') {
      if (!Number.isFinite(x) || Object.is(x, -0)) throw new PlatformError('invalid', `${what} holds a number JSON cannot keep exactly`);
      return;
    }
    if (typeof x !== 'object') throw new PlatformError('invalid', `${what} holds a ${typeof x}, which is not JSON`);
    if (stack.has(x)) throw new PlatformError('invalid', `${what} is cyclic`);
    if (Object.getOwnPropertySymbols(x).length > 0) throw new PlatformError('invalid', `${what} has symbol keys`);
    stack.add(x);
    if (Array.isArray(x)) {
      for (let i = 0; i < x.length; i++) {
        if (!(i in x) || x[i] === undefined) throw new PlatformError('invalid', `${what} has a hole or undefined in an array`);
        walk(x[i], depth + 1);
      }
    } else {
      const proto = Object.getPrototypeOf(x);
      if (proto !== Object.prototype && proto !== null) throw new PlatformError('invalid', `${what} holds a non-plain object`);
      for (const key of Object.keys(x)) {
        const member = (x as Record<string, unknown>)[key];
        if (member === undefined) throw new PlatformError('invalid', `${what} has an undefined member`);
        walk(member, depth + 1);
      }
    }
    stack.delete(x);
  };
  walk(v, 0);
}

/**
 * Returns a normalised copy of a B0b storage reference.
 * Throws PlatformError 'invalid' for a malformed reference or an unknown kind, and
 * 'storage_unavailable' for a known kind that needs the (not yet built) blob store.
 */
export function validateStorage(s: unknown): StorageRef {
  if (!isPlainObject(s) || typeof s.kind !== 'string') throw new PlatformError('invalid', 'storage must be an object with a kind');
  if (!ALL_STORAGE_KINDS.includes(s.kind)) throw new PlatformError('invalid', 'unknown storage kind');
  if (!(B0B_STORAGE_KINDS as readonly string[]).includes(s.kind)) {
    throw new PlatformError('storage_unavailable', `storage kind ${s.kind} needs the blob store, which does not exist yet`);
  }
  if (s.kind === 'inline') {
    if (!('json' in s) || s.json === undefined) throw new PlatformError('invalid', 'inline storage needs json');
    assertExactJson(s.json, 'inline json');
    const text = canonicalJson(s.json);
    if (Buffer.byteLength(text, 'utf8') > INLINE_MAX_BYTES) {
      throw new PlatformError('invalid', `inline json exceeds ${INLINE_MAX_BYTES} bytes`);
    }
    // Store the JSON round-trip, so what is kept is exactly what was hashed.
    return { kind: 'inline', json: JSON.parse(text) as unknown };
  }
  // git
  if (typeof s.commit !== 'string' || !/^[0-9a-f]{40}$/.test(s.commit)) {
    throw new PlatformError('invalid', 'git storage needs a 40-character lowercase hex commit');
  }
  const out: { kind: 'git'; commit: string; ref?: string; paths?: string[] } = { kind: 'git', commit: s.commit };
  if (s.ref !== undefined) {
    if (typeof s.ref !== 'string' || s.ref.length === 0 || s.ref.length > MAX_GIT_REF_CHARS) throw new PlatformError('invalid', 'git ref must be a short string');
    out.ref = s.ref;
  }
  if (s.paths !== undefined) {
    if (!Array.isArray(s.paths) || s.paths.length > MAX_GIT_PATHS
      || !s.paths.every((p) => typeof p === 'string' && p.length > 0 && p.length <= MAX_GIT_PATH_CHARS)) {
      throw new PlatformError('invalid', 'git paths must be a list of non-empty strings');
    }
    out.paths = [...s.paths] as string[];
  }
  return out;
}

/** inline: sha256 of the canonical JSON (hex); git: 'git:' + the commit. Other kinds are not hashed in B0b. */
export function contentHashOf(s: StorageRef): string {
  if (s.kind === 'inline') return createHash('sha256').update(canonicalJson(s.json), 'utf8').digest('hex');
  if (s.kind === 'git') return `git:${s.commit}`;
  throw new PlatformError('storage_unavailable', `storage kind ${(s as { kind: string }).kind} is not hashed in B0b`);
}
