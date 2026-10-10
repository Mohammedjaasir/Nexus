'use strict';
// B2a Task 11: the runner's parsers (JUnit, discovery, manifests). Plain node; every result is also checked with main's
// own re-validation (src/main/nexus/validation/normalized.ts), since main never trusts the runner's parse.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const loadTs = require('./load-ts.cjs');
const { parseJunit, decodeXmlText, JUNIT_MAX_BYTES, JUNIT_MAX_CASES } = loadTs('src/runner/parsers/junit.ts');
const { parseDiscovery, discoveryFrameworkOf } = loadTs('src/runner/parsers/discovery.ts');
const { treeManifest, parseAppManifest } = loadTs('src/runner/parsers/manifest.ts');
const { checkJunit, junitCountsAgree, checkDiscovery } = loadTs('src/main/nexus/validation/normalized.ts');
const { manifestSha256 } = loadTs('src/main/nexus/validation/validators/buildChecks.ts');
const { ARGV_TEMPLATES } = loadTs('src/main/nexus/exec/planBuilder.ts');

const FIX = path.join(__dirname, 'fixtures', 'exec', 'junit');
const read = (f) => fs.readFileSync(path.join(FIX, f));
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

/** The runner's result, then main's re-validation of it: both must accept it. */
function parsedOk(file) {
  const bytes = read(file);
  const r = parseJunit(bytes);
  assert.equal(r.ok, true, `${file}: ${r.reason}`);
  const back = checkJunit(r.value);
  assert.equal(back.ok, true, `${file}: main refuses the shape: ${back.message}`);
  assert.equal(r.value.sha256, sha(bytes));
  return r.value;
}

const FRAMEWORKS = [
  ['J1 node:test', 'node-test.xml', ['::test::adds', '::test::subtracts', '::test::divides', '::test::skips']],
  ['J2 jest-junit', 'jest-junit.xml', ['test/math.test.js::math adds::math adds', 'test/math.test.js::math subtracts::math subtracts',
    'test/math.test.js::math divides::math divides', 'test/math.test.js::math skips::math skips']],
  ['J3 vitest', 'vitest.xml', ['::test/math.test.ts::math > adds', '::test/math.test.ts::math > subtracts', '::test/math.test.ts::math > divides',
    '::test/math.test.ts::math > skips']],
  ['J4 mocha-junit-reporter', 'mocha-junit.xml', ['/workspace/test/math.test.js::adds::math adds', '/workspace/test/math.test.js::subtracts::math subtracts',
    '/workspace/test/math.test.js::divides::math divides', '/workspace/test/math.test.js::skips::math skips']],
  ['J5 pytest', 'pytest.xml', ['::tests.test_math::test_adds', '::tests.test_math::test_subtracts', '::tests.test_math::test_divides', '::tests.test_math::test_skips']]
];
for (const [title, file, ids] of FRAMEWORKS) {
  test(`${title}: normalizes to the common shape with the right counts and stable file::classname::name ids`, () => {
    const v = parsedOk(file);
    assert.deepEqual(Object.keys(v).sort(), ['cases', 'countsMismatch', 'declaredTotal', 'errored', 'failed', 'passed', 'sha256', 'skipped', 'total']);
    assert.deepEqual({ total: v.total, passed: v.passed, failed: v.failed, errored: v.errored, skipped: v.skipped }, { total: 4, passed: 2, failed: 1, errored: 0, skipped: 1 });
    assert.equal(v.declaredTotal, 4); assert.equal(v.countsMismatch, false);
    assert.deepEqual(v.cases.map((c) => c.id), ids);
    assert.deepEqual(v.cases.map((c) => c.outcome), ['passed', 'passed', 'failed', 'skipped']);
    for (const c of v.cases) { assert.ok(Number.isInteger(c.ms) && c.ms >= 0); assert.deepEqual(Object.keys(c).sort(), ['classname', 'file', 'id', 'ms', 'name', 'outcome']); }
    assert.equal(junitCountsAgree(checkJunit(v).value), true);
    // Stable: the same bytes give the same result.
    assert.deepEqual(parseJunit(read(file)).value, v);
  });
}

test('J6 a <!DOCTYPE is refused before any parsing', () => {
  assert.deepEqual(parseJunit(read('doctype.xml')), { ok: false, reason: 'doctype' });
  assert.deepEqual(parseJunit('<?xml version="1.0"?><!doctype x><testsuites/>'), { ok: false, reason: 'doctype' });
});

test('J7 entity expansion never happens: an <!ENTITY is refused, an undeclared reference stays as written', () => {
  const t0 = Date.now();
  assert.deepEqual(parseJunit(read('billion-laughs.xml')), { ok: false, reason: 'doctype' });
  assert.deepEqual(parseJunit('<testsuites><!ENTITY x "y"><testsuite/></testsuites>'), { ok: false, reason: 'doctype' });
  assert.ok(Date.now() - t0 < 1000);
  const r = parseJunit('<testsuites tests="1"><testsuite name="s" tests="1"><testcase classname="c" name="&lol9; &amp; &#65;"/></testsuite></testsuites>');
  assert.equal(r.ok, true);
  assert.equal(r.value.cases[0].name, '&lol9; & A', 'an undeclared entity is kept as written, never expanded');
  assert.equal(decodeXmlText('&lt;&gt;&amp;&quot;&apos;&#x41;&#66;&custom;&#0;'), '<>&"\'AB&custom;&#0;');
});

test('J8 a report over 16 MiB is refused', () => {
  const big = Buffer.alloc(JUNIT_MAX_BYTES + 1, 0x20);
  assert.deepEqual(parseJunit(big), { ok: false, reason: 'too_large' });
});

test('J9 more than 20,000 test cases are refused', () => {
  const xml = `<testsuites><testsuite name="s">${'<testcase classname="c" name="n"/>'.repeat(JUNIT_MAX_CASES + 1)}</testsuite></testsuites>`;
  assert.deepEqual(parseJunit(xml), { ok: false, reason: 'too_many_cases' });
  const ok = parseJunit(`<testsuites><testsuite name="s">${'<testcase classname="c" name="n"/>'.repeat(JUNIT_MAX_CASES)}</testsuite></testsuites>`);
  assert.equal(ok.ok, true); assert.equal(ok.value.total, JUNIT_MAX_CASES);
});

test('J10 nested suites: every case counted once, the declared total read from the top level only', () => {
  const v = parsedOk('nested-suites.xml');
  assert.deepEqual({ total: v.total, passed: v.passed, failed: v.failed, errored: v.errored }, { total: 3, passed: 1, failed: 1, errored: 1 });
  assert.equal(v.declaredTotal, 3);
  assert.equal(v.countsMismatch, false);
  assert.deepEqual(v.cases.map((c) => c.id), ['test/outer.test.js::outer::direct', 'test/outer.test.js::outer.inner::fails', 'test/outer.test.js::outer.inner::breaks']);
  assert.deepEqual(v.cases.map((c) => c.ms), [500, 250, 125]);
});

test('J11 a tests attribute that differs from the rows is reported countsMismatch (main fails the validator)', () => {
  const v = parsedOk('counts-mismatch.xml');
  assert.equal(v.total, 3); assert.equal(v.declaredTotal, 5); assert.equal(v.countsMismatch, true);
  assert.equal(junitCountsAgree(checkJunit(v).value), false);
});

test('J12 missing attributes default safely; long names are bounded; a non-JUnit or broken document is refused', () => {
  const v = parsedOk('huge-attrs.xml');
  assert.equal(v.total, 2);
  assert.equal(v.cases[0].name.length, 1000); assert.equal(v.cases[0].classname.length, 1000); assert.ok(v.cases[0].id.length <= 1024);
  assert.deepEqual(v.cases[1], { id: '::::', file: null, classname: '', name: '', outcome: 'passed', ms: 0 });
  const bare = parseJunit('<testsuite><testcase time="nonsense"/><testcase time="-3"/></testsuite>');
  assert.equal(bare.ok, true); assert.deepEqual(bare.value.cases.map((c) => c.ms), [0, 0]); assert.equal(bare.value.declaredTotal, null);
  assert.equal(checkJunit(bare.value).ok, true);
  assert.deepEqual(parseJunit('<html><body/></html>'), { ok: false, reason: 'not_junit' });
  assert.deepEqual(parseJunit('<testsuites><testsuite></testsuites>'), { ok: false, reason: 'unparsable' });
  assert.deepEqual(parseJunit(''), { ok: false, reason: 'unparsable' });
});

test('J13 discovery parsers: node-test glob, jest --listTests --json, vitest list --json, mocha dry-run JSON, pytest -q ids', () => {
  const check = (fw, text, ids, files) => {
    const r = parseDiscovery(fw, text);
    assert.equal(r.ok, true, `${fw}: ${r.reason}`);
    assert.deepEqual(r.value, { framework: fw, ids, files });
    assert.equal(checkDiscovery(r.value).ok, true, fw);
  };
  check('node-test', 'test/a.test.js\r\ntest/b.test.mjs\n\n/etc/passwd\n../up.test.js\ntest/a.test.js\n', ['test/a.test.js', 'test/b.test.mjs'], ['test/a.test.js', 'test/b.test.mjs']);
  check('jest', JSON.stringify(['/workspace/src/a.test.js', '/workspace/src/b.test.js', '/elsewhere/c.test.js']), ['src/a.test.js', 'src/b.test.js'], ['src/a.test.js', 'src/b.test.js']);
  check('vitest', JSON.stringify([{ name: 'math > adds', file: '/workspace/test/math.test.ts' }, { name: 'math > subtracts', file: '/workspace/test/math.test.ts' }]),
    ['test/math.test.ts::math > adds', 'test/math.test.ts::math > subtracts'], ['test/math.test.ts']);
  check('mocha', JSON.stringify({ stats: { tests: 2 }, tests: [{ title: 'adds', fullTitle: 'math adds', file: '/workspace/test/math.js' },
    { title: 'subs', fullTitle: 'math subs', file: '/workspace/test/math.js' }], pending: [], failures: [], passes: [] }),
  ['test/math.js::math adds', 'test/math.js::math subs'], ['test/math.js']);
  check('pytest', 'tests/test_math.py::test_adds\ntests/test_math.py::TestX::test_y[1-2]\n\n2 tests collected in 0.01s\n',
    ['tests/test_math.py::test_adds', 'tests/test_math.py::TestX::test_y[1-2]'], ['tests/test_math.py']);
  assert.deepEqual(parseDiscovery('jest', 'not json'), { ok: false, reason: 'unparsable' });
  assert.deepEqual(parseDiscovery('mocha', '[]'), { ok: false, reason: 'unparsable' });
  // The framework of a discovery plan comes from main's fixed argv templates.
  assert.equal(discoveryFrameworkOf(ARGV_TEMPLATES['node-test.glob']), 'node-test');
  assert.equal(discoveryFrameworkOf(ARGV_TEMPLATES['jest.list-tests']), 'jest');
  assert.equal(discoveryFrameworkOf(ARGV_TEMPLATES['vitest.list']), 'vitest');
  assert.equal(discoveryFrameworkOf(ARGV_TEMPLATES['mocha.dry-run']), 'mocha');
  assert.equal(discoveryFrameworkOf(ARGV_TEMPLATES['pytest.collect-only']), 'pytest');
});

test('J14 the manifest parser: a canonical per-file list of /out/dist and its hash, equal to main\'s manifestSha256', () => {
  const s = (c) => sha(Buffer.from(c));
  const outputs = [
    { relPath: 'dist/z.js', sha256: s('z'), bytes: 1, mediaType: 'text/javascript' },
    { relPath: 'junit.xml', sha256: s('j'), bytes: 9, mediaType: 'application/xml' },
    { relPath: 'dist/a/b.css', sha256: s('b'), bytes: 3, mediaType: 'text/css' },
    { relPath: 'dist/a.js', sha256: s('a'), bytes: 2, mediaType: 'text/javascript' }
  ];
  const m = treeManifest(outputs);
  assert.deepEqual(m.files.map((f) => f.path), ['a.js', 'a/b.css', 'z.js']);
  assert.equal(m.bytes, 6);
  assert.equal(m.manifestSha256, manifestSha256(m.files));
  assert.equal(treeManifest([...outputs].reverse()).manifestSha256, m.manifestSha256, 'order-free');
  assert.notEqual(treeManifest(outputs.map((o) => (o.relPath === 'dist/a.js' ? { ...o, bytes: 3 } : o))).manifestSha256, m.manifestSha256);
  const app = parseAppManifest(JSON.stringify({ version: 1, profile: 'sde-node', run: ['node', 'server.js'], port: 3000, healthPath: '/health' }));
  assert.equal(app.ok, true); assert.equal(app.manifest.port, 3000);
  assert.deepEqual(parseAppManifest('x'.repeat(16 * 1024 + 1)), { ok: false, reason: 'too_large' });
  assert.deepEqual(parseAppManifest('[1]'), { ok: false, reason: 'not_object' });
  assert.deepEqual(parseAppManifest('{'), { ok: false, reason: 'not_json' });
});

// ---------- Fix round 1 (review of 0e7b8ce9) ----------

test('FR8 an absurd test time (1e308, 1e400, negative) is clamped to a safe integer of milliseconds, never Infinity', () => {
  const r = parseJunit('<testsuites><testsuite><testcase name="a" time="1e308"/><testcase name="b" time="1e400"/><testcase name="c" time="-1"/><testcase name="d" time="9007199254740.993"/></testsuite></testsuites>');
  assert.equal(r.ok, true);
  assert.deepEqual(r.value.cases.map((c) => c.ms), [Number.MAX_SAFE_INTEGER, 0, 0, Number.MAX_SAFE_INTEGER]);
  for (const c of r.value.cases) assert.ok(Number.isSafeInteger(c.ms));
  assert.equal(checkJunit(r.value).ok, true);
});
