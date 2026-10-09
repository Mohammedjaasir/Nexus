/**
 * `sde.tests_pass` v1 (test_suite, candidate, blocking; run by a recipe child job). Pure. Main re-checks
 * the runner's normalized JUnit and never trusts its parse or the exit code alone:
 * - JUnit missing (no report, or no parse of it)          -> failed `junit_missing`
 * - a bad shape                                          -> error  `parser_contract`
 * - counts that disagree (the `tests` attribute included) -> failed `counts_mismatch`
 * - nothing executed                                     -> failed `no_tests`
 * - the suite's stored list was cut                      -> failed `discovery_truncated` (a subset never passes)
 * - an executed test the discovery did not list          -> failed `undiscovered_ids`: a case naming a file the
 *   discovery never listed, or, when the discovery lists test ids (not only files), a case whose id or name is
 *   not among them; a framework that attributes no file is judged by id only, and only against such a list
 * - a discovered file with no case in the report         -> failed `discovered_not_run` (when the framework
 *   attributes files: the run covered a subset)
 * - exit 0 with failures, or non-zero with all passing   -> failed `exit_inconsistent`
 * - any failure or error                                 -> failed `tests_failed`
 * Lookups are by Set: the check stays linear in cases + discovered names.
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
  /** The suite's stored discovery; `truncated` when the stored list is not the whole list. */
  discovery: { ids: string[]; files: string[]; truncated?: boolean };
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
  if (f.discovery.truncated === true) return failed('discovery_truncated', 'The stored discovered list is incomplete; a subset never passes.', evidence);
  const files = new Set(f.discovery.files);
  const ids = new Set(f.discovery.ids);
  // An id-level discovery lists tests, not only files (pytest node ids, vitest names); a file-level one lists files.
  const idLevel = f.discovery.ids.some((id) => !files.has(id));
  const idNames = new Set<string>(); const idFiles = new Set<string>();
  for (const id of f.discovery.ids) {
    const first = id.indexOf('::');
    if (first < 0) { idNames.add(id); continue; }          // a bare test name
    idFiles.add(id.slice(0, first));                       // `file::...::name`
    idNames.add(id.slice(id.lastIndexOf('::') + 2));
  }
  const undiscovered = r.cases.filter((c) => {
    if (c.outcome === 'skipped' || ids.has(c.id)) return false;
    if (c.file !== null && !files.has(c.file) && !idFiles.has(c.file)) return true;   // a file the discovery never listed
    return idLevel && !idNames.has(c.name);                                           // a test an id-level discovery never listed
  });
  if (undiscovered.length > 0) return failed('undiscovered_ids', `${undiscovered.length} executed test(s) were not in the discovered list.`, evidence);
  if (r.cases.some((c) => c.file !== null)) {
    // A framework that attributes files: every discovered file must appear in the report (a skip is the framework's
    // own word that it loaded the file); a file with no case at all was not run.
    const reported = new Set(r.cases.map((c) => c.file).filter((x): x is string => x !== null));
    const notRun = f.discovery.files.filter((x) => !reported.has(x));
    if (notRun.length > 0) return failed('discovered_not_run', `${notRun.length} discovered test file(s) have no test in the report.`, evidence);
  }
  const bad = r.failed + r.errored;
  if ((bad > 0 && f.exit.code === 0) || (bad === 0 && f.exit.code !== 0)) {
    return failed('exit_inconsistent', `The exit code (${f.exit.code}) disagrees with the test results.`, evidence);
  }
  if (bad > 0) return failed('tests_failed', `${bad} of ${executed} executed test(s) failed.`, evidence);
  return passed(`${executed} test${executed === 1 ? '' : 's'} passed.`, evidence);
}
