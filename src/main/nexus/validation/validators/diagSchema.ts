/**
 * `diag.schema` v1 (diagnostic_report, register, blocking). Pure. A report is `{ fields: [{ name, value, source }] }`
 * and every field names where it came from: `inspect` (docker inspect), `http` (a probe) or `log` (a hashed log range).
 *
 * B2a Task 12: a source must also point at its evidence, so a field cannot merely claim a source type:
 * - `inspect`: `container.sha256` (the container id) and the inspected `field`;
 * - `http`: the probed `path` (a plain absolute path) and the probe's time `at`;
 * - `log`: the `attemptId`, the range read (`offset`, `length`) and the `sha256` of exactly those bytes.
 * A value is a scalar (text up to 1,024 characters, a finite number, a boolean, null) or a digest `{ sha256 }`.
 */
import { failed, passed, type ValidatorOutcome } from '../normalized';

export const ID = 'diag.schema';
export const VERSION = '1';
export const SCHEMA_ID = 'diagnostic_report.v1';
const SOURCES = ['inspect', 'http', 'log'];
const HEX = /^[0-9a-f]{64}$/;
const PATH_RE = /^\/[A-Za-z0-9/_.-]{0,200}$/;
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isCount = (v: unknown): boolean => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;

function valueOk(v: unknown): boolean {
  if (v === null || typeof v === 'boolean') return true;
  if (typeof v === 'number') return Number.isFinite(v);
  if (typeof v === 'string') return v.length <= 1024 && !v.includes('\0');
  return isObj(v) && Object.keys(v).length === 1 && typeof v.sha256 === 'string' && HEX.test(v.sha256);
}

/** Why a source does not point at its evidence, or null. */
function sourceProblem(src: Record<string, unknown>): string | null {
  if (src.type === 'inspect') {
    const c = src.container;
    if (!isObj(c) || typeof c.sha256 !== 'string' || !HEX.test(c.sha256)) return 'an inspect source names its container';
    if (typeof src.field !== 'string' || src.field.length === 0 || src.field.length > 100) return 'an inspect source names the inspected field';
    return null;
  }
  if (src.type === 'http') {
    if (typeof src.path !== 'string' || !PATH_RE.test(src.path)) return 'an http source names the probed path';
    if (!isCount(src.at)) return 'an http source names the probe time';
    return null;
  }
  if (typeof src.attemptId !== 'string' || src.attemptId.length === 0 || src.attemptId.length > 64) return 'a log source names its attempt';
  if (!isCount(src.offset) || !isCount(src.length)) return 'a log source names the range read';
  if (typeof src.sha256 !== 'string' || !HEX.test(src.sha256)) return 'a log source names the hash of the bytes read';
  return null;
}

export function run(report: unknown): ValidatorOutcome {
  const errors: { path: string; message: string }[] = [];
  if (!isObj(report) || !Array.isArray(report.fields) || report.fields.length === 0 || report.fields.length > 500) {
    errors.push({ path: '/fields', message: 'a report lists 1 to 500 fields' });
  } else {
    report.fields.forEach((x: unknown, i: number) => {
      if (!isObj(x) || typeof x.name !== 'string' || x.name.length === 0 || x.name.length > 100) errors.push({ path: `/fields/${i}/name`, message: 'each field has a name' });
      if (!isObj(x) || !valueOk(x.value)) errors.push({ path: `/fields/${i}/value`, message: 'a value is a scalar or a digest' });
      const src = isObj(x) ? x.source : undefined;
      if (!isObj(src) || typeof src.type !== 'string' || !SOURCES.includes(src.type)) {
        errors.push({ path: `/fields/${i}/source`, message: 'each field names an inspect, http or log source' });
      } else {
        const p = sourceProblem(src);
        if (p) errors.push({ path: `/fields/${i}/source`, message: p });
      }
    });
  }
  const evidence = [{ type: 'schema' as const, schemaId: SCHEMA_ID, errors: errors.slice(0, 50) }];
  if (errors.length > 0) return failed('schema', `The diagnostic report breaks its schema (${errors.length} problem(s)).`, evidence);
  return passed('Every field of the report names its source.', evidence);
}
