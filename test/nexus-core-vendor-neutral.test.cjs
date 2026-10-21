'use strict';
// The execution model is vendor-neutral: agent engines sit behind the AgentRuntime
// interface, and no shared type, schema or job kind is named after one. V1 scans
// every file under src/shared/nexus (runtime.ts through V2) plus the files in
// LATER that exist; the required ones must exist.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const loadTs = require('./load-ts.cjs');

const ROOT = path.resolve(__dirname, '..');
const VENDOR = /claude|anthropic|hermes|sonnet|opus|haiku|openai|gpt-/i;
const REQUIRED = ['src/shared/nexus/execution.ts', 'src/shared/nexus/runnerProtocol.ts', 'src/shared/nexus/evidence.ts',
  'src/shared/nexus/resourceGate.ts', 'src/shared/nexus/preflightCheck.ts', 'src/shared/nexus/secretShape.ts', 'src/shared/nexus/ipc.ts'];
const LATER = ['src/main/nexus/db/schemaV9.ts', 'src/main/nexus/db/schemaV10.ts'];
/** Every file under src/shared/nexus (fix round 1 of B2a Task 2): new contract files are scanned without editing this list. */
const walkShared = (dir, re = /\.(ts|cjs|js)$/) => fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap((e) =>
  e.isDirectory() ? walkShared(dir + '/' + e.name, re) : re.test(e.name) ? [dir + '/' + e.name] : []);
/**
 * B2b Task 1, the named edit (Global Constraints, "Vendor-neutral scan"): the scan also covers the agent, repository and
 * review code of main, the renderer's agent panel (each walked once it exists) and the Nexus-owned skills. The skills
 * are `resources/skills/nexus-*` only: the other folders under resources/skills are the legacy app's bundled skills,
 * which are not Nexus code. Engine names may appear only in src/runner/runtimes/cliAgent/**, the agent harness, the
 * runtime tests, the probe tool and their fixtures.
 */
const B2B_DIRS = ['src/main/nexus/agents', 'src/main/nexus/repo', 'src/main/nexus/review', 'src/renderer/src/nexus/agent'];
const SKILLS_ROOT = 'resources/skills';
const nexusSkills = () => fs.readdirSync(path.join(ROOT, SKILLS_ROOT), { withFileTypes: true })
  .filter((e) => e.isDirectory() && e.name.startsWith('nexus-')).flatMap((e) => walkShared(`${SKILLS_ROOT}/${e.name}`, /./));
const b2bScanned = () => [...B2B_DIRS.filter((d) => fs.existsSync(path.join(ROOT, d))).flatMap((d) => walkShared(d, /\.(ts|tsx|cjs|js)$/)),
  ...nexusSkills()];
const RUNTIME = 'src/shared/nexus/runtime.ts';

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const hits = (text) => text.split(/\r?\n/).map((line, i) => [i + 1, line]).filter(([, l]) => VENDOR.test(l));
/** Source text with every comment removed (via the TypeScript scanner, so strings stay intact). */
function codeOnly(text) {
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, ts.LanguageVariant.Standard, text);
  let out = '';
  for (let k = scanner.scan(); k !== ts.SyntaxKind.EndOfFileToken; k = scanner.scan()) {
    if (k === ts.SyntaxKind.SingleLineCommentTrivia || k === ts.SyntaxKind.MultiLineCommentTrivia) continue;
    out += scanner.getTokenText();
  }
  return out;
}

test('V1 no engine or vendor name anywhere in the shared execution contracts (code or comments)', () => {
  for (const rel of REQUIRED) assert.ok(fs.existsSync(path.join(ROOT, rel)), `${rel} exists`);
  // runtime.ts may name engines in comments only; V2 scans its code. Everything else is scanned whole.
  const shared = walkShared('src/shared/nexus').filter((rel) => rel !== RUNTIME);
  assert.ok(shared.length >= REQUIRED.length + 10, 'the walk sees the shared contracts');
  const scanned = [...new Set([...REQUIRED, ...shared, ...LATER.filter((rel) => fs.existsSync(path.join(ROOT, rel))), ...b2bScanned()])];
  // The widened scan sees the four Nexus skills (B2b Task 1).
  const skills = nexusSkills();
  for (const id of ['nexus-sde-change', 'nexus-sde-tests-first', 'nexus-sde-requirement-draft', 'nexus-sde-app-manifest'])
    assert.ok(skills.includes(`${SKILLS_ROOT}/${id}/SKILL.md`), `the scan covers ${id}`);
  const found = scanned.flatMap((rel) => hits(read(rel)).map(([n, l]) => `${rel}:${n}: ${l.trim()}`));
  assert.deepEqual(found, []);
});

test('V2 runtime.ts names engines only inside comments describing the adapters', () => {
  const text = read(RUNTIME);
  const code = codeOnly(text);
  assert.ok(code.includes('AgentRuntime') && code.includes('RunRequest'), 'the scanner kept the code');
  assert.equal(VENDOR.test(code), false, 'no engine name in a type or value');
  assert.equal(VENDOR.test(codeOnly('// claude\nconst a = 1;')), false, 'comment stripping works');
  assert.equal(VENDOR.test(codeOnly('const a = "claude";')), true, 'strings are kept');
});

test('V3 RuntimeKind is a branded string, not a union of engine literals; RunRequest assumes no provider', () => {
  const sf = ts.createSourceFile('runtime.ts', read(RUNTIME), ts.ScriptTarget.Latest, true);
  const alias = sf.statements.find((s) => ts.isTypeAliasDeclaration(s) && s.name.text === 'RuntimeKind');
  assert.ok(alias, 'RuntimeKind is declared');
  assert.ok(ts.isIntersectionTypeNode(alias.type), 'string & brand');
  assert.ok(alias.type.types.some((t) => t.kind === ts.SyntaxKind.StringKeyword));
  assert.equal(alias.type.types.some((t) => ts.isLiteralTypeNode(t)), false);
  const code = codeOnly(read(RUNTIME)).replace(/\s+/g, '');
  assert.match(code, /model:\{provider:string;model:string\}/);
  assert.match(code, /credential:\{ref:string\}/);
  assert.equal(Object.keys(loadTs(RUNTIME)).length, 0, 'types only: no runtime value');
});

test('V4 the runner protocol accepts any well-formed runtime kind and favours none', () => {
  const { parseRunnerMessage } = loadTs('src/shared/nexus/runnerProtocol.ts');
  const msg = (kind) => ({ op: 'probe.result', freeBytes: null, images: [],
    probe: { docker: 'missing', gpu: { detected: false, usableInContainers: false } },
    runtimes: [{ kind, health: { ok: false, reason: 'not_installed', detail: 'not in this release' } }] });
  for (const kind of ['scripted', 'engine-a', 'x2']) assert.ok(parseRunnerMessage(msg(kind)), kind);
  for (const kind of ['', 'Engine', 'has space', 'a'.repeat(33), 7]) assert.equal(parseRunnerMessage(msg(kind)), null, String(kind));
  const execution = loadTs('src/shared/nexus/execution.ts');
  const values = JSON.stringify(Object.values(execution));
  assert.equal(VENDOR.test(values), false, 'no engine name in a profile, parser or output code');
});
