// test/nexus-fs-roots.test.cjs
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');
const { confineToRoot, resolveAllowedRoot, isUnderRoot } = loadTs('src/main/fsRoots.ts');
const rp = fs.realpathSync.native;
const ex = fs.existsSync;
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'nx-fs-'));
const root = path.join(base, 'proj');
const outside = path.join(base, 'secret');
fs.mkdirSync(path.join(root, 'src'), { recursive: true });
fs.mkdirSync(outside);
fs.writeFileSync(path.join(outside, 'k.txt'), 'x');
fs.writeFileSync(path.join(root, 'src', 'a.ts'), 'a');
fs.symlinkSync(outside, path.join(root, 'link'), 'junction');   // a junction needs no admin rights on Windows

test('.. and absolute paths cannot leave the root', () => {
  assert.equal(confineToRoot(root, '../secret/k.txt', rp, ex), null);
  assert.equal(confineToRoot(root, path.join(outside, 'k.txt'), rp, ex), null);
  assert.equal(confineToRoot(root, 'src/../../secret/k.txt', rp, ex), null);
});
test('a junction or symlink that points outside the root is refused', () => {
  assert.equal(confineToRoot(root, 'link/k.txt', rp, ex), null);
  assert.equal(confineToRoot(root, 'link', rp, ex), null);
});
test('files inside the root, existing or new, are allowed', () => {
  assert.equal(confineToRoot(root, 'src/a.ts', rp, ex), path.join(rp(root), 'src', 'a.ts'));
  assert.equal(confineToRoot(root, 'src/new/b.ts', rp, ex), path.join(rp(root), 'src', 'new', 'b.ts'));
});
test('only roots main knows about are accepted', () => {
  assert.equal(resolveAllowedRoot(root, [root], rp), rp(root));
  assert.equal(resolveAllowedRoot(path.join(root, 'src'), [root], rp), rp(path.join(root, 'src')));
  assert.equal(resolveAllowedRoot(outside, [root], rp), null);
  assert.equal(resolveAllowedRoot(path.join(base, 'missing'), [root], rp), null);
});
test('root comparison ignores case on Windows only', () => {
  assert.equal(isUnderRoot('C:\\Proj', 'c:\\proj\\a', 'win32'), true);
  assert.equal(isUnderRoot('/proj', '/Proj/a', 'linux'), false);
});

test('Windows root comparison: drive letters, UNC, separators and ..', () => {
  assert.equal(isUnderRoot('C:\\Proj', 'C:\\Proj', 'win32'), true);
  assert.equal(isUnderRoot('C:\\Proj', 'C:/proj/src/a.ts', 'win32'), true);
  assert.equal(isUnderRoot('C:\\Proj', 'D:\\Proj\\a', 'win32'), false);
  assert.equal(isUnderRoot('C:\\Proj', 'C:\\Project\\a', 'win32'), false);
  assert.equal(isUnderRoot('C:\\Proj', 'C:\\Proj\\..\\secret', 'win32'), false);
  assert.equal(isUnderRoot('C:\\Proj', 'C:\\Proj\\src\\..\\a', 'win32'), true);
  assert.equal(isUnderRoot('C:\\Proj', 'C:\\Proj\\..foo', 'win32'), true);
  assert.equal(isUnderRoot('\\\\server\\share\\proj', '\\\\SERVER\\Share\\proj\\a.txt', 'win32'), true);
  assert.equal(isUnderRoot('\\\\server\\share\\proj', '\\\\server\\other\\proj\\a.txt', 'win32'), false);
  assert.equal(isUnderRoot('\\\\server\\share\\proj', 'C:\\proj\\a.txt', 'win32'), false);
  assert.equal(isUnderRoot('C:\\', 'C:\\anything', 'win32'), true);
  assert.equal(isUnderRoot('', 'C:\\a', 'win32'), false);
});
test('POSIX root comparison', () => {
  assert.equal(isUnderRoot('/proj', '/proj/a/b', 'linux'), true);
  assert.equal(isUnderRoot('/proj', '/project/a', 'linux'), false);
  assert.equal(isUnderRoot('/proj', '/proj/../etc/passwd', 'linux'), false);
  assert.equal(isUnderRoot('/proj', '/proj', 'darwin'), true);
});
test('resolveAllowedRoot refuses relative, empty and NUL roots, and skips bad allowed entries', () => {
  assert.equal(resolveAllowedRoot('proj', [root], rp), null);
  assert.equal(resolveAllowedRoot('', [root], rp), null);
  assert.equal(resolveAllowedRoot(root + '\0', [root], rp), null);
  assert.equal(resolveAllowedRoot(root, ['', 'relative', path.join(base, 'missing'), root], rp), rp(root));
  assert.equal(resolveAllowedRoot(path.join(root, '..', 'secret'), [root], rp), null);
  // A junction inside an allowed root that points outside is not a usable root.
  assert.equal(resolveAllowedRoot(path.join(root, 'link'), [root], rp), null);
  // An allowed root reached through a junction resolves to the same real folder.
  assert.equal(resolveAllowedRoot(path.join(root, 'link'), [outside], rp), rp(outside));
});
test('confineToRoot: root itself, NUL bytes, and a root that does not exist', () => {
  assert.equal(confineToRoot(root, '', rp, ex), rp(root));
  assert.equal(confineToRoot(root, '.', rp, ex), rp(root));
  assert.equal(confineToRoot(root, 'src/a.ts\0', rp, ex), null);
  assert.equal(confineToRoot(path.join(base, 'missing'), 'a.ts', rp, ex), null);
});
test('a dangling junction is refused when existence uses lstat', () => {
  const lex = (q) => { try { fs.lstatSync(q); return true; } catch { return false; } };
  const gone = path.join(base, 'gone');
  fs.mkdirSync(gone);
  const dangling = path.join(root, 'dangling');
  fs.symlinkSync(gone, dangling, 'junction');
  fs.rmdirSync(gone);
  assert.equal(confineToRoot(root, 'dangling/new.txt', rp, lex), null);
  assert.equal(confineToRoot(root, 'dangling', rp, lex), null);
});
test('fs.ts uses the real-path guard everywhere and keeps safeJoin exported', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src/main/fs.ts'), 'utf8');
  assert.equal((src.match(/const abs = confined\(root, rel\);/g) || []).length, 4);
  assert.doesNotMatch(src, /const abs = safeJoin\(/);
  const mod = loadTs('src/main/fs.ts');
  assert.equal(typeof mod.safeJoin, 'function');
  assert.equal(mod.safeJoin(root, '../x'), null);
});
test.after(() => { try { fs.rmSync(base, { recursive: true, force: true }); } catch { /* temp */ } });
