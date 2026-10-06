'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');
const s = loadTs('src/main/spawnPolicy.ts');
const { AGENT_PROVIDER_PRESETS, providerPreset } = loadTs('src/shared/agentProvider.ts');

test('every provider preset binary is allowed (O.9 #6)', () => {
  for (const p of AGENT_PROVIDER_PRESETS.filter((p) => p.defaultCommand)) {
    const bin = p.defaultCommand.trim().split(/\s+/)[0];
    assert.deepEqual(s.classifySpawnCommand(bin, {}), { ok: true, source: 'preset' }, p.id);
  }
});
test('the configured default command and confirmed engines are allowed', () => {
  assert.deepEqual(s.classifySpawnCommand('C:\\tools\\claude.cmd', { defaultCommand: 'C:\\tools\\claude.cmd --verbose' }), { ok: true, source: 'configured' });
  assert.deepEqual(s.classifySpawnCommand('aider', { trustedEngineCommands: ['aider'] }), { ok: true, source: 'trusted' });
});
test('anything else needs a main-process confirmation; shell syntax is refused', () => {
  assert.deepEqual(s.classifySpawnCommand('aider', {}), { ok: false, reason: 'needs-confirmation' });
  assert.deepEqual(s.classifySpawnCommand('C:\\x\\agent.exe', {}), { ok: false, reason: 'needs-confirmation' });
  for (const c of ['claude & calc', 'claude;calc', 'claude\ncalc', '$(id)', 'a|b', 'a>b', '%COMSPEC%', '', '   '])
    assert.deepEqual(s.classifySpawnCommand(c, {}), { ok: false, reason: 'invalid' }, JSON.stringify(c));
});
test('renderer spawn requests cannot carry env, a shell script or internal flags', () => {
  const r = s.sanitizeSpawnRequest({ id: 'p1', cwd: 'C:\\x', command: 'claude', args: ['--model', 'm'], provider: 'claude',
    env: { NODE_OPTIONS: '--require evil' }, shellScript: 'calc', noAutoInstall: true });
  assert.equal(r.ok, true);
  for (const k of ['env', 'shellScript', 'noAutoInstall']) assert.equal(k in r.opts, false, k);
  assert.deepEqual(r.opts.args, ['--model', 'm']);
  assert.equal(s.sanitizeSpawnRequest({ id: 'p1', cwd: 'C:\\x', command: 'claude', args: ['ok', 3] }).ok, false);
  assert.equal(s.sanitizeSpawnRequest({ cwd: 'C:\\x', command: 'claude' }).ok, false);
});
test('worker spawn-requests accept provider presets only (O.9 #7)', () => {
  const codex = providerPreset('codex').defaultCommand;
  assert.deepEqual(s.resolveWorkerCommand({ provider: 'codex' }, { defaultCommand: 'claude' }), { ok: true, command: codex, provider: 'codex' });
  assert.deepEqual(s.resolveWorkerCommand({}, { defaultCommand: 'claude' }), { ok: true, command: 'claude' });
  assert.deepEqual(s.resolveWorkerCommand({ command: 'codex' }, { defaultCommand: 'claude' }), { ok: true, command: codex, provider: 'codex' });
  assert.equal(s.resolveWorkerCommand({ command: 'powershell -c iwr evil' }, { defaultCommand: 'claude' }).ok, false);
  assert.equal(s.resolveWorkerCommand({ command: 'C:\\x\\agent.exe' }, { defaultCommand: 'claude' }).ok, false);
  assert.equal(s.resolveWorkerCommand({ provider: 'not-a-provider' }, { defaultCommand: 'claude' }).ok, false);
});
test('no execSync in main and no customCmd anywhere (O.9 #5, re-asserted)', () => {
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]);
  for (const f of walk(path.join(__dirname, '..', 'src', 'main')).filter((f) => /\.(ts|cjs)$/.test(f)))
    assert.doesNotMatch(fs.readFileSync(f, 'utf8'), /\bexecSync\b|customCmd/, f);
});

// ── Additional cases beyond the brief ──────────────────────────────────────

test('classify: paths with spaces only when absolute; parentheses only in paths', () => {
  assert.deepEqual(s.classifySpawnCommand('C:\\Program Files (x86)\\Agent\\agent.exe', {}), { ok: false, reason: 'needs-confirmation' });
  assert.deepEqual(s.classifySpawnCommand('/opt/my agent/bin/agent', {}), { ok: false, reason: 'needs-confirmation' });
  for (const c of ['my agent', 'tools\\my agent.exe', 'calc()', 'a\tb', 'claude\r', 'x`id`', "a'b", 'a"b', 'a^b', 'a!b', 'a*b', 'a?b', null, undefined, 42])
    assert.deepEqual(s.classifySpawnCommand(c, {}), { ok: false, reason: 'invalid' }, JSON.stringify(c));
});

test('classify: a quoted configured path with spaces matches the renderer token', () => {
  const cfg = { defaultCommand: '"C:\\Program Files\\Claude\\claude.cmd" --verbose' };
  assert.deepEqual(s.classifySpawnCommand('C:\\Program Files\\Claude\\claude.cmd', cfg), { ok: true, source: 'configured' });
  // Only the binary counts, never an argument of the configured command.
  assert.deepEqual(s.classifySpawnCommand('--verbose', cfg), { ok: false, reason: 'needs-confirmation' });
  // Shell syntax stays invalid even when configured or trusted.
  assert.deepEqual(s.classifySpawnCommand('claude & calc', { defaultCommand: 'claude & calc', trustedEngineCommands: ['claude & calc'] }), { ok: false, reason: 'invalid' });
});

test('classify: presets win, so the default config never asks', () => {
  assert.deepEqual(s.classifySpawnCommand('claude', { defaultCommand: 'claude' }), { ok: true, source: 'preset' });
  assert.deepEqual(s.classifySpawnCommand('agy', {}), { ok: true, source: 'preset' });
  assert.deepEqual(s.classifySpawnCommand('  codex  ', {}), { ok: true, source: 'preset' });
  assert.deepEqual(s.classifySpawnCommand('aider', { trustedEngineCommands: 'aider' }), { ok: false, reason: 'needs-confirmation' });
});

test('classify: bare PATH spellings of a preset count as the preset; paths do not', () => {
  for (const c of ['claude.cmd', 'Codex.exe', 'CLAUDE', 'antigravity', 'agy.bat'])
    assert.deepEqual(s.classifySpawnCommand(c, {}), { ok: true, source: 'preset' }, c);
  for (const c of ['C:\\x\\claude.exe', '/tmp/claude', '.\\claude.cmd', 'claude.ps1', 'claude.sh'])
    assert.deepEqual(s.classifySpawnCommand(c, {}), { ok: false, reason: 'needs-confirmation' }, c);
});

test('sanitize: keeps the known fields and rebuilds hive metadata', () => {
  const r = s.sanitizeSpawnRequest({
    id: 'pty-a', cwd: '~/x', command: 'codex', cols: 120, rows: 0, provider: 'codex', isolate: true, resume: false,
    requireResume: true, resumeSessionId: 'sid',
    hive: { id: 'a', name: 'A', cwd: '~/x', provider: 'codex', role: 'r', capabilities: ['c', 3], isGod: 'yes', isAssistant: true, extra: 1 }
  });
  assert.equal(r.ok, true);
  assert.deepEqual(r.opts, {
    id: 'pty-a', cwd: '~/x', command: 'codex', args: [], cols: 120, provider: 'codex', isolate: true, resume: false,
    requireResume: true, resumeSessionId: 'sid',
    hive: { id: 'a', name: 'A', cwd: '~/x', provider: 'codex', role: 'r', capabilities: ['c'], isAssistant: true }
  });
  assert.equal(s.sanitizeSpawnRequest({ id: 'p', cwd: 'c', command: 'claude', provider: 'nope' }).opts.provider, undefined);
  assert.equal(s.sanitizeSpawnRequest({ id: 'p', cwd: 'c', command: 'claude', hive: { id: 'a' } }).ok, false);
  assert.equal(s.sanitizeSpawnRequest({ id: 'p', cwd: 'c', command: 'claude', args: 'x' }).ok, false);
  for (const bad of [null, undefined, 'x', [], { id: '', cwd: 'c', command: 'claude' }, { id: 'p', cwd: 3, command: 'claude' }, { id: 'p', cwd: 'c' }])
    assert.equal(s.sanitizeSpawnRequest(bad).ok, false, JSON.stringify(bad));
});

test('worker: preset ids map to preset binaries; custom and mismatches are refused', () => {
  assert.deepEqual(s.resolveWorkerCommand({ provider: 'antigravity' }, {}), { ok: true, command: providerPreset('antigravity').defaultCommand, provider: 'antigravity' });
  assert.deepEqual(s.resolveWorkerCommand({ command: ' claude ' }, {}), { ok: true, command: 'claude', provider: 'claude' });
  assert.deepEqual(s.resolveWorkerCommand({}, {}), { ok: true, command: 'claude' });
  assert.deepEqual(s.resolveWorkerCommand({}, { defaultCommand: 'C:\\tools\\claude.cmd --verbose' }), { ok: true, command: 'C:\\tools\\claude.cmd --verbose' });
  assert.deepEqual(s.resolveWorkerCommand({ command: 'codex', provider: 'codex' }, {}), { ok: true, command: providerPreset('codex').defaultCommand, provider: 'codex' });
  assert.equal(s.resolveWorkerCommand({ command: 'codex', provider: 'claude' }, {}).ok, false);
  assert.equal(s.resolveWorkerCommand({ provider: 'custom' }, {}).ok, false);
  assert.equal(s.resolveWorkerCommand({ command: 'custom' }, {}).ok, false);
  assert.equal(s.resolveWorkerCommand({ command: 7 }, {}).ok, false);
  assert.equal(s.resolveWorkerCommand({ command: 'cmd /c calc' }, {}).error, '"command" must be a provider id (claude, codex, …), not a program path.');
});

test('trusted engines: the renderer can only shrink the list; Allow appends once', () => {
  assert.deepEqual(s.shrinkTrustedEngines(['node'], ['node', 'aider']), ['node']);
  assert.deepEqual(s.shrinkTrustedEngines(['node', 'calc', 'node'], ['node']), ['node']);
  assert.deepEqual(s.shrinkTrustedEngines([], ['node']), []);
  assert.deepEqual(s.shrinkTrustedEngines('calc', ['node']), ['node']);
  assert.deepEqual(s.shrinkTrustedEngines(['calc'], undefined), []);
  assert.deepEqual(s.addTrustedEngine(['node'], 'aider'), ['node', 'aider']);
  assert.deepEqual(s.addTrustedEngine(['node'], 'node'), ['node']);
  assert.deepEqual(s.addTrustedEngine(undefined, 'node'), ['node']);
});

test('confirmation dialog text is the brief wording', () => {
  assert.deepEqual(s.engineConfirmText('node', 'C:\\work'), {
    message: 'Run “node” as an agent engine?',
    detail: 'Nexus only starts known agent CLIs. Allow this program to run as an agent in C:\\work? You can remove it later in Settings → Agents & Models.'
  });
  assert.equal(s.ENGINE_NOT_ALLOWED, 'Not started: this program is not an allowed agent engine.');
});

test('index.ts wires pty:spawn, the worker watcher, voice spawns and config:update through the policy', () => {
  const idx = fs.readFileSync(path.join(__dirname, '..', 'src/main/index.ts'), 'utf8');
  const spawnHandler = idx.slice(idx.indexOf("ipcMain.handle('pty:spawn'"), idx.indexOf('async function spawnAgentCore'));
  assert.match(spawnHandler, /sanitizeSpawnRequest\(raw\)/);
  assert.match(spawnHandler, /ensureAllowedEngine\(/);
  assert.match(spawnHandler, /spawnAgentCore\(\{ \.\.\.sanitized\.opts \}, owner\)/);
  assert.doesNotMatch(spawnHandler, /spawnAgentCore\(opts/);
  assert.match(idx, /resolveWorkerCommand\(raw, readConfig\(\)\)/);
  assert.match(idx, /command\?: string;\s*\/\/ a provider preset id only/);
  // Task 12: config:update runs the key allow-list, where trustedEngineCommands is shrink-only.
  assert.match(idx, /applyRendererConfigPatch\(patch, evt\.sender\)/);
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'src/main/configPolicy.ts'), 'utf8'), /apply\[key\] = shrinkTrustedEngines\(value, have\);/);
  const voice = idx.slice(idx.indexOf('spawnAgent: async (opts)'), idx.indexOf('spawnAgent: async (opts)') + 600);
  assert.match(voice, /ensureAllowedEngine\(/);
});

test('config: trustedEngineCommands defaults to an empty list', () => {
  const cfg = fs.readFileSync(path.join(__dirname, '..', 'src/main/config.ts'), 'utf8');
  assert.match(cfg, /trustedEngineCommands\?: string\[\]/);
  // Task 12 moved the defaults to configDefaults.ts.
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'src/main/configDefaults.ts'), 'utf8'), /trustedEngineCommands: \[\]/);
});
