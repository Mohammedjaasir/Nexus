/**
 * `sde.tests_pass` v1 (test_suite, candidate, blocking; run by a recipe child job). Pure. Main re-checks
 * the runner's normalized JUnit and never trusts its parse or the exit code alone:
 * - JUnit missing (no report, or no parse of it)          -> failed `junit_missing`
 * - a bad shape                                          -> error  `parser_contract`
 * - counts that disagree (the `tests` attribute included) -> failed `counts_mismatch`
 * - nothing executed                                     -> failed `no_tests`
 * - an executed file not in the discovery                -> failed `undiscovered_ids` (when the framework attributes files)
 * - exit 0 with failures, or non-zero with all passing   -> failed `exit_inconsistent`
 * - any failure or error                                 -> failed `tests_failed`
 */
import type { Evidence } from '../../../../shared/nexus/evidence';
import { checkJunit, errored, failed, junitCountsAgree, passed, SHA256_RE, type ValidatorOutcome } from '../normalized';

export const ID = 'sde.tests_pass';
export const VERSION = '1';

export interface TestsPassFacts {
  junit: unknown;
  /** The hash of the staged `junit.xml` (null when the attempt staged none). */
  junitSha256: string | null;
  exit: { code: number | null; signal?: string; oomKilled: boolean };
  discovery: { ids: string[]; files: string[] };
  imageId: string | null;
  lockfileSha256: string | null;
}

const hex = (s: string | null): string | null => {
  if (typeof s !== 'string') return null;
  const h = s.startsWith('sha256:') ? s.slice(7) : s;
  return SHA256_RE.test(h) ? h : null;
};

export function run(f: TestsPassFacts): ValidatorOutcome {
  const exitEv: Evidence = { type: 'exit', code: f.exit.code, ...(f.exit.signal ? { signal: f.exit.signal } : {}), oomKilled: f.exit.oomKilled };
  const discovered = Math.max(f.discovery.ids.length, f.discovery.files.length);
  const base: Evidence[] = [exitEv];
  const image = hex(f.imageId); const lock = hex(f.lockfileSha256);
  if (image) base.push({ type: 'hash', label: 'image', sha256: image });
  if (lock) base.push({ type: 'hash', label: 'lockfile', sha256: lock });
  const staged = hex(f.junitSha256);
  if (f.junit === null || f.junit === undefined || staged === null) return failed('junit_missing', 'The JUnit report is missing or could not be read.', base);
  const j = checkJunit(f.junit);
  if (!j.ok) return errored('parser_contract', 'Checks could not run: the JUnit result was not usable.', base);
  const r = j.value;
  const executed = r.total - r.skipped;
  const evidence: Evidence[] = [
    ...base,
    { type: 'junit', sha256: r.sha256, total: r.total, passed: r.passed, failed: r.failed, errored: r.errored, skipped: r.skipped },
    { type: 'hash', label: 'junit', sha256: staged },
    { type: 'number', name: 'executed', value: Math.max(executed, 0), bound: { op: '>=', value: 1 }, source: { blobSha256: staged, pointer: '/total' } },
    { type: 'number', name: 'discovered', value: discovered, source: { blobSha256: staged, pointer: '/discovered' } }
  ];
  if (r.sha256 !== staged) return failed('junit_missing', 'The JUnit result does not belong to the staged report.', evidence);
  if (!junitCountsAgree(r)) return failed('counts_mismatch', 'The JUnit counts disagree with the test rows.', evidence);
  if (executed <= 0) return failed('no_tests', 'No tests were executed.', evidence);
  const files = new Set(f.discovery.files);
  const undiscovered = r.cases.filter((c) => c.outcome !== 'skipped' && c.file !== null && !files.has(c.file)
    && !f.discovery.ids.some((id) => id === c.id || id.startsWith(`${c.file}::`)));
  if (undiscovered.length > 0) return failed('undiscovered_ids', `${undiscovered.length} executed test(s) were not in the discovered list.`, evidence);
  const bad = r.failed + r.errored;
  if ((bad > 0 && f.exit.code === 0) || (bad === 0 && f.exit.code !== 0)) {
    return failed('exit_inconsistent', `The exit code (${f.exit.code}) disagrees with the test results.`, evidence);
  }
  if (bad > 0) return failed('tests_failed', `${bad} of ${executed} executed test(s) failed.`, evidence);
  return passed(`${executed} test${executed === 1 ? '' : 's'} passed.`, evidence);
}
