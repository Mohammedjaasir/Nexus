/**
 * `req.schema` v1 (requirement, register, blocking). Pure. A requirement is
 * `{ title, body?, criteria: [{ id, text }] }`: a title, at least one acceptance criterion, unique ids,
 * at most 32 KiB in all, and nothing secret-shaped.
 */
import { createHash } from 'node:crypto';
import { containsSecret } from '../../activity/redact';
import { canonicalJson } from '../../db/canonical';
import { failed, passed, type ValidatorOutcome } from '../normalized';

export const ID = 'req.schema';
export const VERSION = '1';
export const SCHEMA_ID = 'requirement.v1';
export const MAX_BYTES = 32 * 1024;
const CRITERION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,31}$/;

export type SchemaError = { path: string; message: string };
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Every schema error; `secret` is reported apart so a save can refuse it with its own reason. */
export function requirementErrors(x: unknown): { errors: SchemaError[]; secret: boolean } {
  const errors: SchemaError[] = [];
  if (!isObj(x)) return { errors: [{ path: '', message: 'a requirement is an object' }], secret: false };
  for (const k of Object.keys(x)) if (!['title', 'body', 'criteria'].includes(k)) errors.push({ path: `/${k.slice(0, 64)}`, message: 'unknown field' });
  if (typeof x.title !== 'string' || x.title.trim().length === 0 || x.title.length > 200) errors.push({ path: '/title', message: 'a title of 1 to 200 characters is required' });
  if (x.body !== undefined && typeof x.body !== 'string') errors.push({ path: '/body', message: 'the body is text' });
  if (!Array.isArray(x.criteria) || x.criteria.length === 0 || x.criteria.length > 100) {
    errors.push({ path: '/criteria', message: 'at least one acceptance criterion (at most 100) is required' });
  } else {
    const seen = new Set<string>();
    x.criteria.forEach((c: unknown, i: number) => {
      if (!isObj(c) || typeof c.id !== 'string' || !CRITERION_ID_RE.test(c.id)) { errors.push({ path: `/criteria/${i}/id`, message: 'each criterion has a short id' }); return; }
      if (seen.has(c.id)) errors.push({ path: `/criteria/${i}/id`, message: 'criterion ids are unique' });
      seen.add(c.id);
      if (typeof c.text !== 'string' || c.text.trim().length === 0 || c.text.length > 2000) errors.push({ path: `/criteria/${i}/text`, message: 'each criterion has a text of 1 to 2000 characters' });
      if (Object.keys(c).some((k) => k !== 'id' && k !== 'text')) errors.push({ path: `/criteria/${i}`, message: 'unknown field' });
    });
  }
  let bytes = Infinity;
  try { bytes = Buffer.byteLength(canonicalJson(x), 'utf8'); } catch { /* not JSON: reported below */ }
  if (bytes > MAX_BYTES) errors.push({ path: '', message: 'a requirement is at most 32 KiB' });
  return { errors, secret: containsSecret(x) };
}

export function run(content: unknown): ValidatorOutcome {
  const { errors, secret } = requirementErrors(content);
  const all = secret ? [...errors, { path: '', message: 'holds a secret-shaped value' }] : errors;
  let sha = '0'.repeat(64);
  try { sha = createHash('sha256').update(canonicalJson(content)).digest('hex'); } catch { /* not JSON */ }
  const evidence = [{ type: 'schema' as const, schemaId: SCHEMA_ID, errors: all.slice(0, 50) }, { type: 'hash' as const, label: 'content', sha256: sha }];
  if (all.length > 0) return failed(secret ? 'secret' : 'schema', `The requirement breaks its schema (${all.length} problem(s)).`, evidence);
  return passed('The requirement has a title and acceptance criteria.', evidence);
}
