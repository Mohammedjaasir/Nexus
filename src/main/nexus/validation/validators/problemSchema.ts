/**
 * `problem.schema` v1 (problem_statement, register, blocking). Pure. A problem statement is
 * `{ question, context?, audience?, successCriteria?: string[], constraints?: string[] }`: a question,
 * bounded optional fields, no unknown field, at most 32 KiB, nothing secret-shaped.
 */
import { createHash } from 'node:crypto';
import { containsSecret } from '../../activity/redact';
import { canonicalJson } from '../../db/canonical';
import { failed, passed, type ValidatorOutcome } from '../normalized';

export const ID = 'problem.schema';
export const VERSION = '1';
export const SCHEMA_ID = 'problem_statement.v1';
export const MAX_BYTES = 32 * 1024;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const strList = (v: unknown): boolean => Array.isArray(v) && v.length <= 20
  && v.every((s: unknown) => typeof s === 'string' && s.trim().length > 0 && s.length <= 500);

export function problemErrors(x: unknown): { errors: { path: string; message: string }[]; secret: boolean } {
  const errors: { path: string; message: string }[] = [];
  if (!isObj(x)) return { errors: [{ path: '', message: 'a problem statement is an object' }], secret: false };
  for (const k of Object.keys(x)) {
    if (!['question', 'context', 'audience', 'successCriteria', 'constraints'].includes(k)) errors.push({ path: `/${k.slice(0, 64)}`, message: 'unknown field' });
  }
  if (typeof x.question !== 'string' || x.question.trim().length === 0 || x.question.length > 2000) errors.push({ path: '/question', message: 'a question of 1 to 2000 characters is required' });
  if (x.context !== undefined && (typeof x.context !== 'string' || x.context.length > 16_000)) errors.push({ path: '/context', message: 'the context is text of at most 16,000 characters' });
  if (x.audience !== undefined && (typeof x.audience !== 'string' || x.audience.length > 200)) errors.push({ path: '/audience', message: 'the audience is text of at most 200 characters' });
  if (x.successCriteria !== undefined && !strList(x.successCriteria)) errors.push({ path: '/successCriteria', message: 'at most 20 criteria of 1 to 500 characters' });
  if (x.constraints !== undefined && !strList(x.constraints)) errors.push({ path: '/constraints', message: 'at most 20 constraints of 1 to 500 characters' });
  let bytes = Infinity;
  try { bytes = Buffer.byteLength(canonicalJson(x), 'utf8'); } catch { /* not JSON */ }
  if (bytes > MAX_BYTES) errors.push({ path: '', message: 'a problem statement is at most 32 KiB' });
  return { errors, secret: containsSecret(x) };
}

export function run(content: unknown): ValidatorOutcome {
  const { errors, secret } = problemErrors(content);
  const all = secret ? [...errors, { path: '', message: 'holds a secret-shaped value' }] : errors;
  let sha = '0'.repeat(64);
  try { sha = createHash('sha256').update(canonicalJson(content)).digest('hex'); } catch { /* not JSON */ }
  const evidence = [{ type: 'schema' as const, schemaId: SCHEMA_ID, errors: all.slice(0, 50) }, { type: 'hash' as const, label: 'content', sha256: sha }];
  if (all.length > 0) return failed(secret ? 'secret' : 'schema', `The problem statement breaks its schema (${all.length} problem(s)).`, evidence);
  return passed('The problem statement has a question and valid fields.', evidence);
}
