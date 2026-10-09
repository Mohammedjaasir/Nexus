/** `app.manifest_schema` v1 (application, register, blocking). Pure over the manifest the runner read (re-validated here). */
import { createHash } from 'node:crypto';
import { canonicalJson } from '../../db/canonical';
import { appManifestErrors, failed, passed, type ValidatorOutcome } from '../normalized';

export const ID = 'app.manifest_schema';
export const VERSION = '1';
export const SCHEMA_ID = 'nexus.app.json.v1';

export function run(manifest: unknown): ValidatorOutcome {
  const errors = appManifestErrors(manifest);
  let sha = '0'.repeat(64);
  try { sha = createHash('sha256').update(canonicalJson(manifest)).digest('hex'); } catch { /* not JSON */ }
  const evidence = [{ type: 'schema' as const, schemaId: SCHEMA_ID, errors: errors.slice(0, 50) }, { type: 'hash' as const, label: 'manifest', sha256: sha }];
  if (errors.length > 0) return failed('schema', `The nexus.app.json manifest breaks its schema (${errors.length} problem(s)).`, evidence);
  return passed('The nexus.app.json manifest is valid.', evidence);
}
