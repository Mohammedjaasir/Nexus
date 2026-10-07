'use strict';
// Task 10 review carry-over (Task 11): caller-path validation for handlers that
// take a filesystem path, and normalised URLs for shell.openExternal.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');
const skills = loadTs('src/main/skills.ts');
const wp = loadTs('src/main/windowPolicy.ts');

const idx = fs.readFileSync(path.join(__dirname, '..', 'src/main/index.ts'), 'utf8');
const handler = (channel) => {
  const start = idx.indexOf(`ipcMain.handle('${channel}'`);
  assert.ok(start >= 0, channel);
  const next = idx.indexOf('ipcMain.handle(', start + 10);
  return idx.slice(start, next < 0 ? undefined : next);
};

test('externalUrlForShell hands the shell the normalised href of allowed URLs only', () => {
  assert.equal(wp.externalUrlForShell('https://github.com/a b'), 'https://github.com/a%20b');
  assert.equal(wp.externalUrlForShell('HTTPS://GitHub.com/x'), 'https://github.com/x');
  assert.equal(wp.externalUrlForShell('http://localhost:3000'), 'http://localhost:3000/');
  assert.equal(wp.externalUrlForShell('x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone'),
    'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone');
  for (const u of ['http://example.com', 'file:///C:/x', 'javascript:alert(1)', 'https://user@github.com/', '', null, 3])
    assert.equal(wp.externalUrlForShell(u), null, String(u));
});

test('index.ts never hands the shell a raw URL string', () => {
  assert.doesNotMatch(idx, /shell\.openExternal\(url\)/);
  assert.match(idx, /function openExternalNormalised[\s\S]{0,200}externalUrlForShell\(url\)[\s\S]{0,80}shell\.openExternal\(href\)/);
  assert.match(handler('app:openExternal'), /externalUrlForShell\(url\)[\s\S]*shell\.openExternal\(href\)/);
});

test('every git handler checks its cwd against the known roots', () => {
  const channels = ['git:isRepo', 'git:mainRepo', 'git:branch', 'git:status', 'git:log', 'git:branches', 'git:aheadBehind', 'git:diff',
    'git:logGraph', 'git:commitFiles', 'git:showFile', 'git:compareRefs', 'git:worktrees', 'git:checkout'];
  for (const c of channels) assert.match(handler(c), /acceptGitCwd\(cwd\)/, c);
  assert.match(handler('git:mainRepo'), /gitDerivedRoots\.add\(root\)/);
  const gitHandlers = idx.match(/ipcMain\.handle\('git:[A-Za-z]+'/g) ?? [];
  assert.equal(gitHandlers.length, channels.length, 'a new git handler must be validated too');
});

test('fs:statAbs, kg:ingestFiles, hive:agentUsage and github:* check their paths', () => {
  assert.match(handler('fs:statAbs'), /acceptFsRoot\(target\)[\s\S]*error: FS_ROOT_REFUSED/);
  assert.match(handler('kg:ingestFiles'), /acceptFsRoot\(srcPath\)[\s\S]*error: FS_ROOT_REFUSED/);
  assert.match(handler('hive:agentUsage'), /acceptFsRoot\(cwd\)/);
  assert.match(handler('github:issues'), /acceptFsRoot\(cwd\)[\s\S]*FS_ROOT_REFUSED/);
  assert.match(handler('github:ciRuns'), /acceptFsRoot\(cwd\)[\s\S]*FS_ROOT_REFUSED/);
  assert.match(handler('skills:local'), /acceptFsRoot\(own\)/);
  assert.match(handler('skills:uninstall'), /uninstallSkill\(path, \{ cwds: allowedFsRoots\(\) \}\)/);
  assert.match(handler('skills:reveal'), /isManagedSkillPath\(target, allowedFsRoots\(\)/);
});

test('user-chosen folders stay unrestricted by design, with a comment saying so', () => {
  assert.match(handler('pty:spawn'), /cwd is deliberately NOT restricted/);
  assert.match(handler('terminal:openAtFolder'), /Deliberately not restricted to known roots/);
  assert.match(handler('project:import'), /Deliberately not restricted to known roots/);
});

test('the terminal opens the preview for a refused path so the error is shown', () => {
  const pool = fs.readFileSync(path.join(__dirname, '..', 'src/renderer/src/components/terminalPool.ts'), 'utf8');
  assert.match(pool, /if \(res\.error && res\.path\) \{\s*storeApi\?\.getState\(\)\.setFullscreenFile\(res\.path, 'preview'\)/);
});

test('managedSkillRoots: user homes plus the skill folders of each known root', () => {
  const home = path.resolve('/home/u');
  const roots = skills.managedSkillRoots([path.resolve('/w/proj'), '', null], home);
  assert.deepEqual(roots, [
    path.join(home, '.claude', 'skills'),
    path.join(home, '.config', 'opencode', 'plugin'),
    path.join(home, '.codex', 'plugins'),
    path.resolve('/w/proj/.claude/skills'),
    path.resolve('/w/proj/.opencode/plugin')
  ]);
});

test('isManagedSkillPath: entries inside a skills root only, never the root or outside', () => {
  const home = path.resolve('/home/u');
  const proj = path.resolve('/w/proj');
  const bundled = path.resolve('/app/resources/skills');
  const yes = [
    path.join(home, '.claude', 'skills', 'docx'),
    path.join(home, '.codex', 'plugins', 'p.js'),
    path.join(proj, '.claude', 'skills', 'demo'),
    path.join(proj, '.opencode', 'plugin', 'x.js'),
    path.join(bundled, 'capabilities')
  ];
  for (const t of yes) assert.equal(skills.isManagedSkillPath(t, [proj], [bundled], home), true, t);
  const no = [
    path.join(home, '.claude', 'skills'),
    path.join(home, '.claude', 'settings.json'),
    path.join(home, '.config', 'opencode', 'opencode.json'),
    path.join(proj, 'src', 'index.ts'),
    path.join(proj, '.claude', 'skills', '..', '..', 'src'),
    path.resolve('/w/other/.claude/skills/demo'),
    '',
    'a\0b'
  ];
  for (const t of no) assert.equal(skills.isManagedSkillPath(t, [proj], [bundled], home), false, JSON.stringify(t));
  if (process.platform === 'win32') {
    assert.equal(skills.isManagedSkillPath(path.join(proj.toUpperCase(), '.CLAUDE', 'SKILLS', 'demo'), [proj], [], home), true);
  }
});

test('uninstallSkill: a project skill under a junction that leads outside is refused', (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'md-skill-junction-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const proj = path.join(tmp, 'proj');
  const outside = path.join(tmp, 'outside');
  const victim = path.join(outside, 'victim');
  fs.mkdirSync(path.join(proj, '.claude', 'skills'), { recursive: true });
  fs.mkdirSync(victim, { recursive: true });
  fs.writeFileSync(path.join(victim, 'SKILL.md'), '---\nname: v\n---\n');
  const link = path.join(proj, '.claude', 'skills', 'evil');
  try { fs.symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch { t.skip('cannot create a junction here'); return; }
  const res = skills.uninstallSkill(path.join(link, 'victim'), { cwds: [proj] });
  assert.equal(res.ok, false);
  assert.ok(fs.existsSync(path.join(victim, 'SKILL.md')), 'the outside folder must survive');
});

// B1 Task 6: the nexus:* IPC layer never takes a folder from the renderer.
test('nexus sources take a project root only from the stored project row, through acceptFsRoot', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src/main/nexusIpc/sources.ts'), 'utf8');
  // One lookup of the stored row, its rootPath, and that path through acceptFsRoot: the only source of a root.
  assert.equal((src.match(/deps\.getProject\(/g) || []).length, 1);
  assert.equal((src.match(/deps\.acceptFsRoot\(/g) || []).length, 1);
  assert.match(src, /row = deps\.getProject\(projectId\);[\s\S]{0,80}const rootPath = row\?\.rootPath;[\s\S]{0,200}accepted = deps\.acceptFsRoot\(rootPath\)/);
  assert.match(idx, /createSourcePorts\(\{ acceptFsRoot, getProject: \(id\) => projectManager\.getProject\(id\) \}\)/);
});

test('no nexus:* request schema has a folder field (only relPath)', () => {
  const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
  const mod = read('src/main/nexusIpc/registerNexusIpc.ts');
  const validate = read('src/main/nexusIpc/validate.ts');
  // Every object schema: the key list passed to V.object(...) or optionalObject(...).
  const lists = [...mod.matchAll(/(?:V\.object|optionalObject)\([^,]+,\s*\[([^\]]*)\]/g)].map((m) => m[1]);
  assert.ok(lists.length >= 4, 'the schemas were found');
  const keys = lists.flatMap((l) => [...l.matchAll(/['"`]([^'"`]+)['"`]/g)].map((m) => m[1]));
  for (const k of keys) assert.ok(k === 'relPath' || !/^(root|rootPath|cwd|path|dir|folder)$|Path$|Root$|Dir$/i.test(k), k);
  for (const text of [mod, validate]) assert.doesNotMatch(text, /['"`](root|rootPath|cwd|path|folder)['"`]/);
  // A parsed request never names a root or a cwd field either.
  assert.doesNotMatch(mod, /\.(root|rootPath|cwd)\b/);
});
