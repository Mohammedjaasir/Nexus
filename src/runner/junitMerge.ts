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
 * - written atomically and never through a link (fix round 1): the merged report is written to a new temporary file
 *   in the attempt's work folder (beside `in/` and `out/`, never inside the container-writable `/out`), created
 *   exclusively, then renamed onto `out/junit.xml`; a `junit.xml` that is a symlink, a junction, a second hard link or not
 *   a regular file refuses the merge (never written through, never replaced), and so does a `junit/` folder that is a link;
 * - every per-file report is read only through `readPlainFile` (lstat, then an O_NOFOLLOW open re-checked on its
 *   handle): a link, a hard link or a special file in `junit/` contributes no case (and `/out`'s collection refuses it too).
 * The per-file reports stay in `/out` and are hashed as outputs too. Without a plain `junit/` folder nothing is merged, and
 * the runner never takes the container's own `junit.xml` for a per-file plan (core.ts parses none: `discardUnmergedReport`).
 * Nothing is deleted before release (final review B5): a plain `junit.xml` the container wrote is MOVED to the attempt's
 * work folder (`container-junit.xml`, outside `/out`, removed with the rest at release), never unlinked or overwritten.
 */
import { randomBytes } from 'node:crypto';
import * as path from 'node:path';
import { JUNIT_MAX_BYTES, parseJunit, type JunitCase } from './parsers/junit';
import { errCode, noLinkUnder, plainFileOrAbsent, readPlainFile } from './paths';
import type { RunnerFs } from './types';

export const PER_FILE_DIR = 'junit';
export const MERGED_NAME = 'junit.xml';
/** Where the container's own `junit.xml` of a per-file plan is kept (in the work folder, beside `in/` and `out/`). */
export const KEPT_NAME = 'container-junit.xml';

/**
 * Moves a plain `junit.xml` out of `/out` into `<keepDir>/container-junit.xml` (a rename: nothing is deleted). When that
 * name is already taken, the original was kept by an earlier pass (a finalize after a restart) and `junit.xml` is this
 * runner's own merge; it is left where it is. Returns whether `/out/junit.xml` is now free to be replaced.
 */
async function keepContainerReport(fs: RunnerFs, root: string, dest: string, keepDir: string): Promise<boolean> {
  const keep = path.join(keepDir, KEPT_NAME);
  if (!(await noLinkUnder(fs, root, keep))) return false;
  if ((await plainFileOrAbsent(fs, keep)) !== 'absent') return true;
  await fs.rename(dest, keep);
  return true;
}

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

/** Whether `child` is `parent` or inside it (case-insensitive on Windows). */
function within(child: string, parent: string): boolean {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * Merges `<outDir>/junit/<NNNN>.xml` into `<outDir>/junit.xml` (see the module header). `root`: the data home;
 * `tmpDir`: where the merged report is written before its rename, OUTSIDE `outDir` (the attempt's work folder, which
 * holds `out/`; by default `outDir`'s parent). Throws on an I/O error (the caller logs it and parses no report).
 */
export async function mergePerFileJunit(fs: RunnerFs, root: string, outDir: string, files: readonly string[], tmpDir: string = path.dirname(outDir)): Promise<MergeResult> {
  const notes: string[] = [];
  if (within(tmpDir, outDir)) throw new Error('the temporary folder of the merge is inside /out');
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
    // Never read through a link: lstat, then an O_NOFOLLOW open whose handle must still be the lstat's file.
    const read = await readPlainFile(fs, p, JUNIT_MAX_BYTES);
    if (!read.ok) {
      notes.push(read.why === 'missing' ? `${file}: no report was written` : read.why === 'too_large' ? `${file}: its report is over 16 MiB`
        : `${file}: its report is not a plain file`);
    } else {
      const r = parseJunit(read.bytes);
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
  // A junit.xml already there is replaced only when it is a plain, single-link regular file (a hard link would make the
  // rename leave a second name; a link or a junction is never written through or replaced).
  const there = await plainFileOrAbsent(fs, dest);
  if (there === 'other') return { merged: false, notes: [...notes, 'junit.xml is not a plain file; nothing was merged'], cases: tests };
  if (!(await noLinkUnder(fs, root, path.join(tmpDir, 'x')))) return { merged: false, notes: [...notes, 'the work folder is not a plain folder; nothing was merged'], cases: tests };
  // The container's own junit.xml is kept, not overwritten (final review B5): moved to the work folder first.
  if (there === 'plain' && !(await keepContainerReport(fs, root, dest, tmpDir))) {
    return { merged: false, notes: [...notes, 'the container\'s junit.xml could not be kept; nothing was merged'], cases: tests };
  }
  // Written outside /out (a container could have planted anything there), exclusively (an existing name is never opened).
  const tmp = path.join(tmpDir, `.junit-merge.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
  try {
    const fh = await fs.open(tmp, 'wx');
    try { await fh.writeFile(xml, 'utf8'); } finally { await fh.close(); }
    if ((await plainFileOrAbsent(fs, dest)) === 'other') throw new Error('junit.xml changed into a link while the merge ran');
    await fs.rename(tmp, dest);
  } catch (e) {
    try { await fs.unlink(tmp); } catch { /* not there */ }
    throw e;
  }
  return { merged: true, notes, cases: tests };
}

/**
 * A per-file plan whose reports were not merged (no plain `junit/` folder, a refused `junit.xml`, an I/O error): the
 * container's own `junit.xml` is never taken as written. A plain regular file there is MOVED out of `/out` to the work
 * folder (`container-junit.xml`; final review B5: nothing is deleted before release); a link, a junction, a hard link or
 * a folder is left for the collection of `/out` to refuse. The caller parses no report either way. Returns a note for
 * the attempt log, or null when nothing was there. `keepDir`: the attempt's work folder (default: `outDir`'s parent).
 */
export async function discardUnmergedReport(fs: RunnerFs, root: string, outDir: string, keepDir: string = path.dirname(outDir)): Promise<string | null> {
  const dest = path.join(outDir, MERGED_NAME);
  if (!(await noLinkUnder(fs, root, dest))) return 'junit.xml is a link; it is not taken (the outputs are refused)';
  const there = await plainFileOrAbsent(fs, dest);
  if (there === 'absent') return null;
  if (there === 'other') return 'junit.xml is not a plain file; it is not taken';
  if (within(keepDir, outDir)) return 'the junit.xml of the container could not be set aside; it is not taken';
  try {
    if (!(await keepContainerReport(fs, root, dest, keepDir))) return 'the junit.xml of the container could not be set aside; it is not taken';
  } catch (e) {
    if (errCode(e) !== 'ENOENT') return 'the junit.xml of the container could not be set aside; it is not taken';
  }
  if ((await plainFileOrAbsent(fs, dest)) !== 'absent') return 'the junit.xml of the container is still in /out; it is not taken';
  return 'the junit.xml the container wrote was set aside (kept outside /out): a per-file run is judged only on the merged per-file reports';
}
