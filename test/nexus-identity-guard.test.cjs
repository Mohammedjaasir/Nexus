// test/nexus-identity-guard.test.cjs
// Reachable-surface identity guard: can the Nexus UI expose old product identity?
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const guard = require('./helpers/identityGuard.cjs');
const LEAKS = require('./nexus-identity-leaks.json');

test('guard: a reachable legacy identity string fails; an unreachable one is ignored', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nx-guard-'));
  fs.writeFileSync(path.join(dir, 'entry.tsx'), "import { Leaf } from './leaf';\nexport const E = () => <Leaf />;\n");
  fs.writeFileSync(path.join(dir, 'leaf.tsx'), 'export const Leaf = () => <p>Your clone runs the floor with Michael</p>;\n');
  fs.writeFileSync(path.join(dir, 'orphan.tsx'), 'export const O = () => <p>Michael</p>;\n');
  const files = guard.reachableFrom([path.join(dir, 'entry.tsx')]);
  assert.ok(files.has(path.join(dir, 'leaf.tsx')));
  assert.ok(!files.has(path.join(dir, 'orphan.tsx')));
  assert.deepEqual(guard.scanFiles(files, dir).map((l) => l.rule).sort(), ['lead', 'office', 'persona']);
});

test('guard: neutral copy passes', () => {
  for (const s of ['Lead agent', 'Agent · api-server', 'Coordinates the other agents', 'Pause delivery',
    'Clone the repository with git clone', 'Math.floor', 'Archive', 'Needs you'])
    assert.deepEqual(guard.scanText(s), [], s);
});

test('guard: normal punctuation is never banned', () => {
  for (const s of ['Saved — see you tomorrow…', 'Step 1 – step 2', '“quoted” and ‘single’', 'Agent · folder',
    'Stop -> go', '50% done!', 'a/b (c) [d] {e} <f> & g | h ^ i ~ j'])
    assert.deepEqual(guard.scanText(s), [], s);
});

test('guard: personas and brand are detected, case and word-boundary aware', () => {
  assert.deepEqual(guard.scanText('Michael').map((h) => h.rule), ['persona']);
  assert.deepEqual(guard.scanText('Dunder Mifflin').map((h) => h.rule), ['brand']);
  assert.deepEqual(guard.scanText('MUNDER DIFFLIN').map((h) => h.rule), ['brand']);
  assert.deepEqual(guard.scanText('Jimmy and Pamphlet'), []);
});

test('guard: comments, identifiers, type literals and import paths are not copy', () => {
  const src = "// Michael runs the floor\n/* god of the hive */\nimport x from './office/cast';\n" +
    "type T = 'office' | 'floor';\nconst OFFICE_CAST = []; const isGod = true; const to = 'god'; const k = 'hive:send';\n";
  assert.deepEqual(guard.copyStrings('x.ts', src).flatMap(guard.scanText), []);
});

test('guard: the real reachable set starts at main.tsx and covers the App mounts', () => {
  const rel = new Set([...guard.reachableFrom([guard.ENTRY])].map((f) => guard.relName(f)));
  for (const f of ['App.tsx', 'nexus/NexusShell.tsx', 'components/CommandCenterPanel.tsx', 'components/SettingsModal.tsx',
    'components/OnboardingWizard.tsx', 'components/QuitWarningModal.tsx', 'components/AddAgentModal.tsx',
    'components/FullscreenTerminal.tsx'])
    assert.ok(rel.has(f), f);
  assert.ok(!rel.has('scene/office/OfficeFloor.tsx'));
});

test('no old identity on any reachable surface beyond the known-leaks ratchet', () => {
  const leaks = guard.applyAllowlist(guard.scanFiles(guard.reachableFrom([guard.ENTRY])), LEAKS.allowlist);
  assert.deepEqual(guard.groupByFile(leaks), guard.groupByFile(
    Object.entries(LEAKS.knownLeaks).flatMap(([file, xs]) => xs.map((x) => ({ file, ...x })))));
});

test('every allowlist entry has a reason and still matches a reachable string', () => {
  const hits = guard.scanFiles(guard.reachableFrom([guard.ENTRY]));
  for (const a of LEAKS.allowlist) {
    assert.ok(typeof a.reason === 'string' && a.reason.length >= 20, `${a.file}: reason required`);
    const match = (h) => (a.exact ? h.text === a.contains : h.text.includes(a.contains));
    assert.ok(hits.some((h) => h.file === a.file && h.rule === a.rule && match(h)), `stale: ${a.file} ${a.contains}`);
  }
});

test('allowlist never covers user-visible voice persona text or greetings', () => {
  for (const a of LEAKS.allowlist.filter((x) => x.file === 'realtime/session.ts'))
    assert.equal(a.exact, true, 'session.ts allowlist entries must be exact literals');
});

test('guard: single-token JSX text and aria-label/title values are scanned under all rules', () => {
  const src = 'export const X = () => <div title="Floor" aria-label="Hive"><b>BOSS</b><i>Floor</i><u>Hive</u></div>;\n';
  const hits = guard.copyItems('x.tsx', src).flatMap((i) => guard.scanText(i.text, i.copy).map((h) => h.match));
  assert.deepEqual(hits.sort(), ['BOSS', 'Floor', 'Floor', 'Hive', 'Hive']);
  assert.deepEqual(guard.copyStrings('x.ts', "const k = 'floor'; const c = 'hive:send';").flatMap((s) => guard.scanText(s)), []);
});

test('guard: a reachable image or @brand asset import is reported as visual', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nx-guard-'));
  fs.writeFileSync(path.join(dir, 'entry.tsx'), "import logo from './pic.png';\nimport b from '@brand/logo.png';\nexport const E = () => <img src={logo} />;\n");
  const leaks = guard.scanFiles([path.join(dir, 'entry.tsx')], dir);
  assert.deepEqual(leaks.map((l) => [l.rule, l.text]), [['visual', './pic.png'], ['visual', '@brand/logo.png']]);
});
