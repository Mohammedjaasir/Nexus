/**
 * Test discovery output (`/out/ids.txt`) → `{ framework, ids, files }` (main re-validates it: checkDiscovery). One
 * parser per framework, each over the exact text its command writes:
 * - node-test: the Nexus glob writes one relative test file per line (ids are the files);
 * - jest `--listTests --json`: a JSON array of absolute file paths under /workspace;
 * - vitest `list --json`: a JSON array of `{ name, file }`;
 * - mocha `--dry-run --reporter json`: a JSON object whose `tests` are `{ fullTitle, file }`;
 * - pytest `--collect-only -q`: one node id per line (`path::Class::test`), then a summary line.
 * Files are made relative to /workspace; anything outside it, empty, longer than 512 characters, or holding NUL is
 * dropped. Ids and files are distinct (first occurrence kept) and at most 20,000 each.
 */
export type DiscoveryFramework = 'node-test' | 'jest' | 'vitest' | 'mocha' | 'pytest';
export const DISCOVERY_FRAMEWORKS: readonly DiscoveryFramework[] = ['node-test', 'jest', 'vitest', 'mocha', 'pytest'];
export interface NormalizedDiscovery { framework: DiscoveryFramework; ids: string[]; files: string[] }
export const MAX_DISCOVERED = 20_000;
export const MAX_DISCOVERY_BYTES = 8 * 2 ** 20;
const MAX_NAME = 512;

/** The framework a discovery argv runs (the plan's fixed templates), or null. */
export function discoveryFrameworkOf(argv: readonly string[]): DiscoveryFramework | null {
  if (argv.includes('nexus-glob')) return 'node-test';
  if (argv.some((a) => /(^|\/)jest$/.test(a))) return 'jest';
  if (argv.some((a) => /(^|\/)vitest$/.test(a))) return 'vitest';
  if (argv.some((a) => /(^|\/)mocha$/.test(a))) return 'mocha';
  if (argv.includes('pytest')) return 'pytest';
  return null;
}

/** A path as a /workspace-relative file, or null. */
function rel(p: unknown): string | null {
  if (typeof p !== 'string') return null;
  let s = p.replace(/\\/g, '/').trim();
  if (s.startsWith('/workspace/')) s = s.slice('/workspace/'.length);
  else if (s.startsWith('/')) return null;
  s = s.replace(/^\.\//, '');
  if (s.length === 0 || s.length > MAX_NAME || s.includes('\0') || s.split('/').some((x) => x === '..' || x === '')) return null;
  return s;
}
const ok = (x: string): boolean => x.length > 0 && x.length <= MAX_NAME && !x.includes('\0');

function distinct(list: readonly string[]): string[] {
  const seen = new Set<string>(); const out: string[] = [];
  for (const x of list) { if (!seen.has(x)) { seen.add(x); out.push(x); } if (out.length > MAX_DISCOVERED) break; }
  return out;
}

export type DiscoveryResult = { ok: true; value: NormalizedDiscovery } | { ok: false; reason: 'too_large' | 'unparsable' | 'too_many' };

export function parseDiscovery(framework: DiscoveryFramework, input: Buffer | string): DiscoveryResult {
  const buf = typeof input === 'string' ? Buffer.from(input, 'utf8') : input;
  if (buf.length > MAX_DISCOVERY_BYTES) return { ok: false, reason: 'too_large' };
  const text = buf.toString('utf8');
  let ids: string[] = []; let files: string[] = [];
  try {
    if (framework === 'node-test') {
      files = text.split(/\r?\n/).map((l) => rel(l)).filter((x): x is string => x !== null);
      ids = files;
    } else if (framework === 'pytest') {
      for (const line of text.split(/\r?\n/)) {
        const l = line.trim();
        if (!l.includes('::') || /\s/.test(l.split('::')[0])) continue;
        const f = rel(l.split('::')[0]);
        if (!f || !ok(l)) continue;
        ids.push(l); files.push(f);
      }
    } else {
      const j = JSON.parse(text) as unknown;
      if (framework === 'jest') {
        if (!Array.isArray(j)) return { ok: false, reason: 'unparsable' };
        files = j.map((x) => rel(x)).filter((x): x is string => x !== null);
        ids = files;
      } else if (framework === 'vitest') {
        if (!Array.isArray(j)) return { ok: false, reason: 'unparsable' };
        for (const t of j) {
          if (typeof t !== 'object' || t === null) continue;
          const f = rel((t as { file?: unknown }).file);
          const name = (t as { name?: unknown }).name;
          if (!f || typeof name !== 'string') continue;
          const id = `${f}::${name}`;
          if (ok(id)) { ids.push(id); files.push(f); }
        }
      } else {
        const tests = typeof j === 'object' && j !== null ? (j as { tests?: unknown }).tests : undefined;
        if (!Array.isArray(tests)) return { ok: false, reason: 'unparsable' };
        for (const t of tests) {
          if (typeof t !== 'object' || t === null) continue;
          const f = rel((t as { file?: unknown }).file);
          const title = (t as { fullTitle?: unknown }).fullTitle;
          if (!f || typeof title !== 'string') continue;
          const id = `${f}::${title}`;
          if (ok(id)) { ids.push(id); files.push(f); }
        }
      }
    }
  } catch {
    return { ok: false, reason: 'unparsable' };
  }
  ids = distinct(ids); files = distinct(files);
  if (ids.length > MAX_DISCOVERED || files.length > MAX_DISCOVERED) return { ok: false, reason: 'too_many' };
  return { ok: true, value: { framework, ids, files } };
}
