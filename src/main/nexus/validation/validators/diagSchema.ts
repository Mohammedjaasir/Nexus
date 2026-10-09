/**
 * `diag.schema` v1 (diagnostic_report, register, blocking). Pure. A report is `{ fields: [{ name, value, source }] }`
 * and every field names where it came from: `inspect` (docker inspect), `http` (a probe) or `log` (a hashed log range).
 */
import { failed, passed, type ValidatorOutcome } from '../normalized';

export const ID = 'diag.schema';
export const VERSION = '1';
export const SCHEMA_ID = 'diagnostic_report.v1';
const SOURCES = ['inspect', 'http', 'log'];
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export function run(report: unknown): ValidatorOutcome {
  const errors: { path: string; message: string }[] = [];
  if (!isObj(report) || !Array.isArray(report.fields) || report.fields.length === 0 || report.fields.length > 500) {
    errors.push({ path: '/fields', message: 'a report lists 1 to 500 fields' });
  } else {
    report.fields.forEach((x: unknown, i: number) => {
      if (!isObj(x) || typeof x.name !== 'string' || x.name.length === 0 || x.name.length > 100) errors.push({ path: `/fields/${i}/name`, message: 'each field has a name' });
      const src = isObj(x) ? x.source : undefined;
      if (!isObj(src) || typeof src.type !== 'string' || !SOURCES.includes(src.type)) {
        errors.push({ path: `/fields/${i}/source`, message: 'each field names an inspect, http or log source' });
      }
    });
  }
  const evidence = [{ type: 'schema' as const, schemaId: SCHEMA_ID, errors: errors.slice(0, 50) }];
  if (errors.length > 0) return failed('schema', `The diagnostic report breaks its schema (${errors.length} problem(s)).`, evidence);
  return passed('Every field of the report names its source.', evidence);
}
