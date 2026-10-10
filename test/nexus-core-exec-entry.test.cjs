'use strict';
// B2a Task 12: the Nexus entry (infra/images/common/nexus-entry) run by a POSIX sh on this host, against a temp folder
// standing for the container's /in, /out and /workspace (NEXUS_ENTRY_ROOT, which no container can set: main's environment
// allow-list and preflight's image-environment check refuse it). It proves the argv contract the plan builder relies on:
// steps joined by --nexus-then, the Nexus helpers, no job value ever evaluated as shell text (X12's rule), the wall clock,
// and node:test's per-file reports merged and attributed by the runner (A5). Plain node; needs a POSIX sh (Git's on
// Windows) and node on PATH; skipped with its reason when there is no sh.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const loadTs = require('./load-ts.cjs');

const ROOT = path.resolve(__dirname, '..');
const ENTRY = path.join(ROOT, 'infra', 'images', 'common', 'nexus-entry');
const { ARGV_TEMPLATES, STEP_SEPARATOR } = loadTs('src/main/nexus/exec/planBuilder.ts');
const { mergePerFileJunit } = loadTs('src/runner/junitMerge.ts');
const { parseJunit } = loadTs('src/runner/parsers/junit.ts');

function findSh() {
  if (process.platform !== 'win32') return fs.existsSync('/bin/sh') ? '/bin/sh' : null;
  for (const base of [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], 'C:\\Program Files']) {
    if (!base) continue;
    const p = path.join(base, 'Git', 'bin', 'sh.exe');
    if (fs.existsSync(p)) return p;
  }
  return null;
}
const SH = findSh();
/** A host path as the sh sees it (Git's sh on Windows: /c/...). */
const shPath = (p) => (process.platform === 'win32' ? p.replace(/^([A-Za-z]):/, (_m, d) => `/${d.toLowerCase()}`).split('\\').join('/') : p);

const made = [];
test.after(() => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }); });
function box() {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'nx-entry-'));
  made.push(r);
  for (const d of ['in', 'out', 'workspace']) fs.mkdirSync(path.join(r, d));
  return r;
}
const put = (root, rel, text) => { const p = path.join(root, ...rel.split('/')); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text); };
function entry(root, argv, env = { NEXUS_WALL_SECONDS: '60' }, timeoutMs = 60_000) {
  const base = { ...process.env };
  delete base.NEXUS_WALL_SECONDS;
  // This file runs under node --test, which marks its environment as a test child; the node the entry starts must not
  // inherit that (it would report to this runner instead of writing its own results), as no container ever does.
  delete base.NODE_TEST_CONTEXT;
  // Git's sh expands wildcards in the argv it is given by a Windows parent unless told not to (MSYS=noglob); a Linux
  // container's execve passes argv verbatim, as here.
  const r = spawnSync(SH, [shPath(ENTRY), ...argv], { encoding: 'utf8', timeout: timeoutMs, windowsHide: true, cwd: root,
    env: { ...base, ...env, NEXUS_ENTRY_ROOT: shPath(root), MSYS: 'noglob' } });
  return { code: r.status, out: r.stdout, err: r.stderr };
}
const skip = SH ? false : 'no POSIX sh on this host (Git for Windows provides one)';

test('E1 steps joined by --nexus-then; nexus-glob lists the node:test templates\' files (sorted, node_modules and .git skipped); nexus-capture writes stdout', { skip }, () => {
  const r = box();
  for (const f of ['test/a.test.js', 'test/b.test.js', 'src/x.test.mjs', 'test/helper.cjs', 'node_modules/pkg/y.test.js', 'notes.md', 'src/app.js']) put(path.join(r, 'workspace'), f, '//\n');
  const argv = [...ARGV_TEMPLATES['node-test.glob'], STEP_SEPARATOR, 'nexus-capture', '--out', '/out/echo.txt', '--', 'printf', '%s\\n', 'second step'];
  const x = entry(r, argv);
  assert.equal(x.code, 0, x.err);
  assert.equal(fs.readFileSync(path.join(r, 'out', 'ids.txt'), 'utf8'), 'src/x.test.mjs\ntest/a.test.js\ntest/b.test.js\ntest/helper.cjs\n');
  assert.equal(fs.readFileSync(path.join(r, 'out', 'echo.txt'), 'utf8'), 'second step\n');
  // A failing step stops the chain with its own code.
  const stop = entry(r, ['sh', '-c', 'exit 7', STEP_SEPARATOR, 'nexus-capture', '--out', '/out/never.txt', '--', 'true']);
  assert.equal(stop.code, 7);
  assert.equal(fs.existsSync(path.join(r, 'out', 'never.txt')), false);
});

test('E2 X12: a job value is one argv element and is never evaluated as shell text (";", $(...), backticks, spaces), on the last step and on a chained one', { skip }, () => {
  const r = box();
  const evil = ['; touch /out/pwned', '$(touch /out/pwned2)', '`touch /out/pwned3`', 'a b', "'; touch /out/pwned4; '"];
  const last = entry(r, ['printf', '%s\\n', ...evil]);
  assert.equal(last.code, 0, last.err);
  assert.deepEqual(last.out.split('\n').slice(0, -1), evil);
  const chained = entry(r, ['printf', '%s\\n', ...evil, STEP_SEPARATOR, 'true']);
  assert.equal(chained.code, 0, chained.err);
  assert.deepEqual(chained.out.split('\n').slice(0, -1), evil);
  assert.deepEqual(fs.readdirSync(path.join(r, 'out')), [], 'no file was created by any of them');
});

test('E3 the wall clock: NEXUS_WALL_SECONDS is required, whole and in range; the steps end at it (timeout 124)', { skip }, () => {
  const r = box();
  for (const bad of [undefined, '', '1x', '0', '9999999', '-5']) {
    const x = entry(r, ['true'], bad === undefined ? {} : { NEXUS_WALL_SECONDS: bad });
    assert.equal(x.code, 64, `NEXUS_WALL_SECONDS=${bad}`);
    assert.match(x.err, /NEXUS_WALL_SECONDS/);
  }
  const t0 = Date.now();
  const slow = entry(r, ['sleep', '30'], { NEXUS_WALL_SECONDS: '1' });
  assert.equal(slow.code, 124);
  assert.ok(Date.now() - t0 < 15_000, `ended at its wall clock (${Date.now() - t0} ms)`);
  assert.equal(entry(r, []).code, 64, 'no command');
  assert.equal(entry(r, ['true', STEP_SEPARATOR]).code, 64, 'a separator ends the command');
  assert.equal(entry(r, [STEP_SEPARATOR, 'true']).code, 64, 'an empty step');
});

test('E4 nexus-collect copies the build folder under /out; a path outside /out, a `..` or absolute source, a missing folder are refused', { skip }, () => {
  const r = box();
  put(path.join(r, 'workspace'), 'dist/a.txt', 'A\n');
  put(path.join(r, 'workspace'), 'dist/sub/b.txt', 'B\n');
  const ok = entry(r, ['true', STEP_SEPARATOR, ...ARGV_TEMPLATES['entry.collect-output']]);
  assert.equal(ok.code, 0, ok.err);
  assert.equal(fs.readFileSync(path.join(r, 'out', 'dist', 'a.txt'), 'utf8'), 'A\n');
  assert.equal(fs.readFileSync(path.join(r, 'out', 'dist', 'sub', 'b.txt'), 'utf8'), 'B\n');
  assert.equal(entry(r, ['nexus-collect', '--from', '../dist', '--to', '/out/x']).code, 64);
  assert.equal(entry(r, ['nexus-collect', '--from', '/etc', '--to', '/out/x']).code, 64);
  assert.equal(entry(r, ['nexus-collect', '--from', 'dist', '--to', '/tmp/x']).code, 64);
  assert.equal(entry(r, ['nexus-collect', '--from', 'dist', '--to', '/out/../x']).code, 64);
  assert.equal(entry(r, ['nexus-collect', '--from', 'nothere', '--to', '/out/x']).code, 66);
  assert.equal(entry(r, ['nexus-glob', '--out', '/elsewhere/ids.txt', '**/*.js']).code, 64);
  assert.equal(entry(r, ['nexus-glob', '--out', '/out/ids.txt', '../**/*.js']).code, 64);
});

test('E5 nexus-node-test runs node --test once per file, each with its own JUnit report; the runner merges them with every case attributed (A5)', { skip }, async () => {
  const r = box();
  put(path.join(r, 'workspace'), 'test/one.test.js', "const t=require('node:test');t('one passes',()=>{});t('one also',()=>{});\n");
  put(path.join(r, 'workspace'), 'test/two.test.js', "const t=require('node:test');const a=require('node:assert');t('two fails',()=>{a.equal(1,2)});\n");
  put(path.join(r, 'workspace'), 'test/none.test.js', '// no tests\n');
  const files = ['test/none.test.js', 'test/one.test.js', 'test/two.test.js'];
  const x = entry(r, [...ARGV_TEMPLATES['node-test.junit'], ...files], undefined, 120_000);
  assert.equal(x.code, 1, 'the first failing file\'s code');
  assert.deepEqual(fs.readdirSync(path.join(r, 'out', 'junit')).sort(), ['0001.xml', '0002.xml', '0003.xml']);
  const m = await mergePerFileJunit(fsp, r, path.join(r, 'out'), files);
  assert.equal(m.merged, true);
  assert.ok(m.notes.includes('test/none.test.js declares no test'), m.notes.join('; '));
  const j = parseJunit(fs.readFileSync(path.join(r, 'out', 'junit.xml')));
  assert.ok(j.ok);
  assert.deepEqual(j.value.cases.map((c) => [c.file, c.name, c.outcome]),
    [['test/one.test.js', 'one passes', 'passed'], ['test/one.test.js', 'one also', 'passed'], ['test/two.test.js', 'two fails', 'failed']]);
  assert.equal(j.value.countsMismatch, false);
  assert.equal(j.value.declaredTotal, 3);
  // A file that is not a plain relative path is refused before anything runs.
  assert.equal(entry(r, [...ARGV_TEMPLATES['node-test.junit'], '--require=evil.js']).code, 64);
  assert.equal(entry(r, [...ARGV_TEMPLATES['node-test.junit'], '/etc/passwd']).code, 64);
});

test('E6 /in/src.tar is extracted into /workspace and /in/dist staged as /workspace/dist before the command runs there', { skip }, () => {
  const r = box();
  const src = fs.mkdtempSync(path.join(os.tmpdir(), 'nx-entry-src-')); made.push(src);
  put(src, 'package.json', '{}\n'); put(src, 'src/app.js', '//\n');
  const tar = spawnSync(SH, ['-c', `tar -cf "${shPath(path.join(r, 'in', 'src.tar'))}" -C "${shPath(src)}" .`], { encoding: 'utf8' });
  assert.equal(tar.status, 0, tar.stderr);
  put(path.join(r, 'in'), 'dist/index.html', '<p>built</p>\n');
  const x = entry(r, ['nexus-capture', '--out', '/out/ls.txt', '--', 'find', '.', '-type', 'f']);
  assert.equal(x.code, 0, x.err);
  assert.deepEqual(fs.readFileSync(path.join(r, 'out', 'ls.txt'), 'utf8').split('\n').filter(Boolean).sort(), ['./dist/index.html', './package.json', './src/app.js']);
});
