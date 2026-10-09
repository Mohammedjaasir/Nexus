/**
 * JUnit XML → the normalized result main re-validates (src/main/nexus/validation/normalized.ts `checkJunit`):
 * `{ sha256, total, passed, failed, errored, skipped, cases: [{ id, file, classname, name, outcome, ms }], declaredTotal,
 * countsMismatch }`. Constraint 4: parsing happens here, in the runner, never in main.
 *
 * Safety (B2a plan, Evidence):
 * - at most 16 MiB of input, refused before anything else;
 * - `<!DOCTYPE` and `<!ENTITY` refused before parsing (no DTD, no entity expansion: billion laughs cannot start);
 * - `fast-xml-parser` with `processEntities: false`, `allowBooleanAttributes: false`, `ignoreDeclaration: true`; the
 *   five predefined XML entities and numeric character references are decoded by hand afterwards (they never expand);
 * - at most 20,000 test cases;
 * - names, classes and files bounded (main's 1,024-character fact bound); a missing attribute defaults safely.
 *
 * Counting: every `<testcase>` in the tree is one row, counted once, however deep its suites nest. `declaredTotal` is the
 * `tests` attribute of the root `<testsuites>`, or the sum over the top-level `<testsuite>` elements (never nested ones);
 * `countsMismatch` is true when it differs from the rows (main's validator then fails `counts_mismatch`). An outcome is
 * `errored` (an `<error>`), else `failed` (a `<failure>`), else `skipped` (`<skipped>`), else `passed`.
 * Ids are stable: `file::classname::name`.
 */
import { createHash } from 'node:crypto';
import { XMLParser, XMLValidator } from 'fast-xml-parser';

export const JUNIT_MAX_BYTES = 16 * 2 ** 20;
export const JUNIT_MAX_CASES = 20_000;
export const MAX_NAME_CHARS = 1000;
export const MAX_ID_CHARS = 1024;

export type CaseOutcome = 'passed' | 'failed' | 'errored' | 'skipped';
export interface JunitCase { id: string; file: string | null; classname: string; name: string; outcome: CaseOutcome; ms: number }
export interface NormalizedJunit {
  sha256: string; total: number; passed: number; failed: number; errored: number; skipped: number;
  cases: JunitCase[]; declaredTotal: number | null; countsMismatch: boolean;
}
export type JunitResult = { ok: true; value: NormalizedJunit } | { ok: false; reason: 'too_large' | 'doctype' | 'too_many_cases' | 'unparsable' | 'not_junit' };

const PARSER_OPTIONS = {
  processEntities: false,
  allowBooleanAttributes: false,
  ignoreDeclaration: true,
  ignorePiTags: true,
  ignoreAttributes: false,
  attributeNamePrefix: '',
  parseAttributeValue: false,
  parseTagValue: false,
  trimValues: true,
  htmlEntities: false,
  isArray: (name: string) => ['testsuite', 'testcase', 'failure', 'error', 'skipped', 'testsuites'].includes(name)
} as const;

const PREDEFINED: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };
/** Decodes the five predefined entities and numeric character references; anything else stays as written. */
export function decodeXmlText(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]{1,6}|#[0-9]{1,7}|lt|gt|amp|quot|apos);/g, (m, e: string) => {
    if (e.startsWith('#x') || e.startsWith('#')) {
      const cp = e.startsWith('#x') ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      if (!Number.isFinite(cp) || cp === 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return m;
      return String.fromCodePoint(cp);
    }
    return PREDEFINED[e] ?? m;
  });
}

type Node = Record<string, unknown>;
const isNode = (v: unknown): v is Node => typeof v === 'object' && v !== null && !Array.isArray(v);
const attr = (n: Node, k: string): string | null => {
  const v = n[k];
  if (typeof v !== 'string' && typeof v !== 'number') return null;
  return decodeXmlText(String(v)).replace(/\0/g, '');
};
const clip = (s: string, max: number): string => (s.length > max ? s.slice(0, max) : s);
const children = (n: Node, k: string): Node[] => {
  const v = n[k];
  if (Array.isArray(v)) return v.map((x) => (isNode(x) ? x : {}));
  if (v === undefined) return [];
  return [isNode(v) ? v : {}];
};
const count = (v: string | null): number | null => {
  if (v === null || !/^\s*\d{1,9}\s*$/.test(v)) return null;
  return Number(v.trim());
};
const millis = (v: string | null): number => {
  if (v === null) return 0;
  const t = Number(v.replace(/,/g, ''));
  return Number.isFinite(t) && t >= 0 ? Math.round(t * 1000) : 0;
};

/** Parses one JUnit report (the bytes of `/out/junit.xml`). */
export function parseJunit(input: Buffer | string): JunitResult {
  const buf = typeof input === 'string' ? Buffer.from(input, 'utf8') : input;
  if (buf.length > JUNIT_MAX_BYTES) return { ok: false, reason: 'too_large' };
  const text = buf.toString('utf8');
  if (/<!DOCTYPE/i.test(text) || /<!ENTITY/i.test(text)) return { ok: false, reason: 'doctype' };
  // A cheap upper bound before the parser builds anything: more opening testcase tags than the cap is refused.
  const opens = text.match(/<testcase[\s/>]/g)?.length ?? 0;
  if (opens > JUNIT_MAX_CASES) return { ok: false, reason: 'too_many_cases' };
  let doc: unknown;
  try {
    if (XMLValidator.validate(text, { allowBooleanAttributes: false }) !== true) return { ok: false, reason: 'unparsable' };
    doc = new XMLParser(PARSER_OPTIONS).parse(text);
  } catch {
    return { ok: false, reason: 'unparsable' };
  }
  if (!isNode(doc)) return { ok: false, reason: 'not_junit' };
  const roots = children(doc, 'testsuites');
  const topSuites = roots.length > 0 ? roots.flatMap((r) => children(r, 'testsuite')) : children(doc, 'testsuite');
  if (roots.length === 0 && topSuites.length === 0) return { ok: false, reason: 'not_junit' };

  const cases: JunitCase[] = [];
  let tooMany = false;
  const visitSuite = (s: Node, inheritedFile: string | null): void => {
    const file = attr(s, 'file') ?? inheritedFile;
    for (const c of children(s, 'testcase')) {
      if (cases.length >= JUNIT_MAX_CASES) { tooMany = true; return; }
      const name = clip(attr(c, 'name') ?? '', MAX_NAME_CHARS);
      const classname = clip(attr(c, 'classname') ?? '', MAX_NAME_CHARS);
      const caseFile = attr(c, 'file') ?? file;
      const f = caseFile === null || caseFile === '' ? null : clip(caseFile, MAX_NAME_CHARS);
      const outcome: CaseOutcome = children(c, 'error').length > 0 ? 'errored' : children(c, 'failure').length > 0 ? 'failed'
        : children(c, 'skipped').length > 0 ? 'skipped' : 'passed';
      cases.push({ id: clip(`${f ?? ''}::${classname}::${name}`, MAX_ID_CHARS), file: f, classname, name, outcome, ms: millis(attr(c, 'time')) });
    }
    for (const sub of children(s, 'testsuite')) { if (tooMany) return; visitSuite(sub, file); }
  };
  // Cases directly under <testsuites> (node:test writes top-level tests there) count too.
  for (const r of roots) {
    visitSuite({ testcase: r.testcase }, null);
    for (const s of children(r, 'testsuite')) visitSuite(s, null);
  }
  if (roots.length === 0) for (const s of topSuites) visitSuite(s, null);
  if (tooMany) return { ok: false, reason: 'too_many_cases' };

  // The declared total: the root's `tests`; else node:test's `<!-- tests N -->` summary comment; else the top-level
  // suites' `tests` summed, but only when no case sits directly under the root (their sum would leave it out).
  let declared: number | null = null;
  const rootTests = roots.map((r) => count(attr(r, 'tests')));
  const directRootCases = roots.some((r) => children(r, 'testcase').length > 0);
  const nodeSummary = /<!--\s*tests\s+(\d{1,9})\s*-->/.exec(text);
  if (roots.length > 0 && rootTests.every((x) => x !== null)) declared = rootTests.reduce<number>((a, b) => a + (b as number), 0);
  else if (nodeSummary) declared = Number(nodeSummary[1]);
  else if (!directRootCases) {
    const suiteTests = topSuites.map((s) => count(attr(s, 'tests')));
    if (suiteTests.length > 0 && suiteTests.every((x) => x !== null)) declared = suiteTests.reduce<number>((a, b) => a + (b as number), 0);
  }
  const by = (o: CaseOutcome): number => cases.filter((c) => c.outcome === o).length;
  const value: NormalizedJunit = {
    sha256: createHash('sha256').update(buf).digest('hex'),
    total: cases.length, passed: by('passed'), failed: by('failed'), errored: by('errored'), skipped: by('skipped'),
    cases, declaredTotal: declared, countsMismatch: declared !== null && declared !== cases.length
  };
  return { ok: true, value };
}
