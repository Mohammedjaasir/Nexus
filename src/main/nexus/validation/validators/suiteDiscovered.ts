/**
 * `suite.discovered` v1 (test_suite, register, blocking). Pure, over the runner's normalized discovery,
 * re-validated here: at least one test is discovered, and the discovered list is the stored list
 * (the parser's source hash equals the hash of the `ids.txt` blob main recorded).
 */
import { checkDiscovery, errored, failed, passed, SHA256_RE, type ValidatorOutcome } from '../normalized';

export const ID = 'suite.discovered';
export const VERSION = '1';

export interface SuiteDiscoveredFacts {
  /** The runner's normalized discovery (re-validated here). */
  discovery: unknown;
  /** The hash the parser says it read. */
  listSha256: string | null;
  /** The hash of the discovered-list blob main recorded for the version. */
  storedSha256: string | null;
}

export function run(f: SuiteDiscoveredFacts): ValidatorOutcome {
  const d = checkDiscovery(f.discovery);
  if (!d.ok) return errored('parser_contract', 'Checks could not run: the discovered list was not usable.');
  const count = Math.max(d.value.ids.length, d.value.files.length);
  const stored = typeof f.storedSha256 === 'string' && SHA256_RE.test(f.storedSha256) ? f.storedSha256 : null;
  const evidence = [
    ...(stored ? [{ type: 'hash' as const, label: 'discovery', sha256: stored }] : []),
    { type: 'number' as const, name: 'discovered', value: count, bound: { op: '>=' as const, value: 1 },
      source: { blobSha256: stored ?? '0'.repeat(64), pointer: '/ids' } }
  ];
  if (count === 0) return failed('no_tests_discovered', 'No test was discovered.', evidence);
  if (stored === null || f.listSha256 !== stored) return failed('hash_mismatch', 'The discovered list does not match the stored list.', evidence);
  return passed(`${count} test${count === 1 ? '' : 's'} discovered.`, evidence);
}
