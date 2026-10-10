/**
 * Per-file attribution of node:test results (B2a Task 12, amendment A5). Node's JUnit reporter names no file (checked
 * against node 20: `<testcase name classname="test">` only), and the `sde.tests_pass` rule M4 gives a multi-file suite
 * with an unattributed report `error / unattributed_report`, never `passed`. So the Nexus entry's `nexus-node-test`
 * runs `node --test` once per discovered file, each with its own destination (`/out/junit/<NNNN>.xml` for
 * `files[NNNN - 1]`), and after the exit the runner merges them here into `/out/junit.xml`, every case attributed to
 * its file from the plan's mapping (main derived it from the suite's stored list; nothing the container wrote decides
 * which file a report belongs to).
 *
 * Rules, each keeping the result honest:
 * - a file whose report is missing, not a plain file, over 16 MiB or not JUnit contributes no case: the suite check then
 *   fails `discovered_not_run` (never a pass for a file that did not report);
 * - node reports a file that declares no test as ONE passing case named with the file's own path; that synthetic case
 *   is dropped (a file of no tests is not a passing test), so an all-empty suite is `no_tests`; a file that failed to
 *   load is reported failing and is kept;
 * - counts: the root `tests` is the sum of each report's declared total (less any dropped synthetic case), so a report
 *   whose own counts disagree with its rows still fails `counts_mismatch` after the merge;
 * - written atomically (a temporary file renamed onto `junit.xml`; a link or folder in its place is never written
 *   through); the per-file reports stay in `/out` and are hashed as outputs too.
 * Without a `junit/` folder in `/out` nothing is merged (the report, if any, is taken as written).
 */
import * as path from 'node:path';
import { JUNIT_MAX_BYTES, parseJunit, type JunitCase } from './parsers/junit';
import { errCode, noLinkUnder } from './paths';
import type { RunnerFs } from './types';

export const PER_FILE_DIR = 'junit';
export const MERGED_NAME = 'junit.xml';
const TMP_NAME = '.nexus-junit-merge.tmp';

/** The report name of the i-th (0-based) discovered file: `0001.xml`, `0002.xml`, ... */
export function perFileReportName(i: number): string { return `${String(i + 1).padStart(4, '0')}.xml`; }

/** XML 1.0 attribute text: the five escapes, characters XML cannot hold removed. */
export function xmlAttr(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;')
    .replace(/\r/g, '&#13;').replace(/\n/g, '&#10;').replace(/\t/g, '&#9;');
}

/** Whether a case is node's synthetic "this file ran" case for `file` (named with the file's own path). */
export function isSyntheticFileCase(c: JunitCase, file: string): boolean {
  if (c.outcome !== 'passed' || c.classname !== 'test') return false;
  const n = c.name.replace(/\\/g, '/');
  return n === file || n === `/workspace/${file}` || n.endsWith(`/${file}`);
}

export interface MergeResult { merged: boolean; notes: string[]; cases: number }

/** Merges `<outDir>/junit/<NNNN>.xml` into `<outDir>/junit.xml` (see the module header). `root`: the data home. */
export async function mergePerFileJunit(fs: RunnerFs, root: string, outDir: string, files: readonly string[]): Promise<MergeResult> {
  const notes: string[] = [];
  const dir = path.join(outDir, PER_FILE_DIR);
  try {
    const st = await fs.lstat(dir);
    if (st.isSymbolicLink() || !st.isDirectory()) return { merged: false, notes: ['the per-file report folder is not a plain folder'], cases: 0 };
  } catch (e) {
    if (errCode(e) === 'ENOENT') return { merged: false, notes: [], cases: 0 };
    throw e;
  }
  const suites: string[] = [];
  let tests = 0; let declared = 0; let failures = 0; let errors = 0; let skipped = 0;
  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const p = path.join(dir, perFileReportName(i));
    let cases: JunitCase[] = [];
    let fileDeclared = 0;
    try {
      const st = await fs.lstat(p);
      if (st.isSymbolicLink() || !st.isFile()) notes.push(`${file}: its report is not a plain file`);
      else if (st.size > JUNIT_MAX_BYTES) notes.push(`${file}: its report is over 16 MiB`);
      else {
        const r = parseJunit(await fs.readFile(p));
        if (!r.ok) notes.push(`${file}: its report was refused (${r.reason})`);
        else {
          cases = r.value.cases;
          fileDeclared = r.value.declaredTotal ?? r.value.cases.length;
          if (cases.length === 1 && isSyntheticFileCase(cases[0], file)) {
            notes.push(`${file} declares no test`);
            cases = [];
            fileDeclared = Math.max(0, fileDeclared - 1);
          }
        }
      }
    } catch (e) {
      if (errCode(e) !== 'ENOENT') throw e;
      notes.push(`${file}: no report was written`);
    }
    const f = cases.filter((c) => c.outcome === 'failed').length;
    const er = cases.filter((c) => c.outcome === 'errored').length;
    const sk = cases.filter((c) => c.outcome === 'skipped').length;
    tests += cases.length; declared += fileDeclared; failures += f; errors += er; skipped += sk;
    const rows = cases.map((c) => {
      const attrs = `name="${xmlAttr(c.name)}" classname="${xmlAttr(c.classname)}" file="${xmlAttr(file)}" time="${(c.ms / 1000).toFixed(6)}"`;
      const body = c.outcome === 'errored' ? '<error message="errored"/>' : c.outcome === 'failed' ? '<failure message="failed"/>'
        : c.outcome === 'skipped' ? '<skipped/>' : '';
      return body ? `    <testcase ${attrs}>${body}</testcase>` : `    <testcase ${attrs}/>`;
    });
    suites.push(`  <testsuite name="${xmlAttr(file)}" file="${xmlAttr(file)}" tests="${cases.length}" failures="${f}" errors="${er}" skipped="${sk}">`,
      ...rows, '  </testsuite>');
  }
  const xml = ['<?xml version="1.0" encoding="utf-8"?>',
    `<testsuites name="nexus node:test per-file" tests="${declared}" failures="${failures}" errors="${errors}" skipped="${skipped}">`,
    ...suites, '</testsuites>', ''].join('\n');
  const dest = path.join(outDir, MERGED_NAME);
  if (!(await noLinkUnder(fs, root, dest))) return { merged: false, notes: [...notes, 'junit.xml is a link; nothing was merged'], cases: tests };
  try {
    const st = await fs.lstat(dest);
    if (!st.isFile()) return { merged: false, notes: [...notes, 'junit.xml is not a plain file; nothing was merged'], cases: tests };
  } catch (e) { if (errCode(e) !== 'ENOENT') throw e; }
  const tmp = path.join(outDir, TMP_NAME);
  try {
    await fs.writeFile(tmp, xml, 'utf8');
    await fs.rename(tmp, dest);
  } catch (e) {
    try { await fs.unlink(tmp); } catch { /* not there */ }
    throw e;
  }
  return { merged: true, notes, cases: tests };
}
