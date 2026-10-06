'use strict';
// B0a final review, finding 1: a persisted command line follows the CURRENT
// auto mode on every respawn, and the trust store cannot re-enable bypass.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');
const af = loadTs('src/shared/autoModeFlag.ts');
const s = loadTs('src/main/spawnPolicy.ts');
const cp = loadTs('src/main/configPolicy.ts');
const { AGENT_PROVIDER_PRESETS } = loadTs('src/shared/agentProvider.ts');
const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const split = (line) => { const [bin, ...args] = s.tokenizeCommandLine(line); return { bin, args }; };

const PERSISTED_ON = {
  claude: 'claude --model claude-opus-4-8 --permission-mode bypassPermissions',
  codex: 'codex --model gpt-5 --dangerously-bypass-approvals-and-sandbox',
  grok: 'grok --permission-mode bypassPermissions',
  kimi: 'kimi --auto',
  antigravity: 'agy --model "Gemini 3.1 Pro (High)" --dangerously-skip-permissions',
  qwen: 'qwen --yolo',
  crush: 'crush --yolo',
  pi: 'pi --approve',
  copilot: 'copilot --model gpt-5 -s --allow-all-tools --no-ask-user'
};

test('a line persisted with auto mode on, auto mode now off: no flag, a preset, no dialog', () => {
  for (const [provider, line] of Object.entries(PERSISTED_ON)) {
    const before = split(line);
    // Unnormalised, the old line now needs the dialog (the reported bug).
    assert.equal(s.classifySpawn(before.bin, before.args, { autoMode: false }, provider).ok, false, provider);
    const out = af.normalizeAutoFlagCommand(line, false, provider);
    const { bin, args } = split(out);
    assert.equal(af.argsHaveAutoFlag(args, provider), false, `${provider}: ${out}`);
    assert.deepEqual(s.classifySpawn(bin, args, { autoMode: false }, provider), { ok: true, source: 'preset' }, provider);
  }
  assert.equal(af.normalizeAutoFlagCommand(PERSISTED_ON.claude, false, 'claude'), 'claude --model claude-opus-4-8');
  assert.equal(af.normalizeAutoFlagCommand(PERSISTED_ON.antigravity, false, 'antigravity'), 'agy --model "Gemini 3.1 Pro (High)"');
  assert.equal(af.normalizeAutoFlagCommand('claude --permission-mode=bypassPermissions', false), 'claude');
});

test('the reverse: a line persisted with auto mode off, auto mode now on, gets the flag', () => {
  for (const [provider, onLine] of Object.entries(PERSISTED_ON)) {
    const offLine = af.normalizeAutoFlagCommand(onLine, false, provider);
    const out = af.normalizeAutoFlagCommand(offLine, true, provider);
    const { bin, args } = split(out);
    assert.equal(af.argsHaveAutoFlag(args, provider), true, `${provider}: ${out}`);
    assert.deepEqual(s.classifySpawn(bin, args, { autoMode: true }, provider), { ok: true, source: 'preset' }, provider);
    // Already matching lines are returned byte-identical.
    assert.equal(af.normalizeAutoFlagCommand(onLine, true, provider), onLine, provider);
    assert.equal(af.normalizeAutoFlagCommand(offLine, false, provider), offLine, provider);
  }
  assert.equal(af.normalizeAutoFlagCommand('claude --model x', true, 'claude'), 'claude --model x --permission-mode bypassPermissions');
});

test('providers without an auto flag and unrelated flags are untouched', () => {
  assert.equal(af.normalizeAutoFlagCommand('opencode --model m', true, 'opencode'), 'opencode --model m');
  assert.equal(af.normalizeAutoFlagCommand('aider --yolo', false, 'custom'), 'aider --yolo');
  assert.equal(af.normalizeAutoFlagCommand('claude --permission-mode plan', false, 'claude'), 'claude --permission-mode plan');
  assert.equal(af.normalizeAutoFlagCommand('', false, 'claude'), '');
});

test('trusting a bypass line while auto mode is off is refused', () => {
  const line = 'claude --permission-mode bypassPermissions --settings x';
  assert.deepEqual(s.addTrustedEngine([], line, { autoMode: false }), []);
  assert.deepEqual(s.addTrustedEngine(['a'], 'codex --dangerously-bypass-approvals-and-sandbox', { autoMode: false }), ['a']);
  // With auto mode on, or a line without an auto flag, trust still works.
  assert.deepEqual(s.addTrustedEngine([], line, { autoMode: true }), [line]);
  assert.deepEqual(s.addTrustedEngine([], 'aider --model m', { autoMode: false }), ['aider --model m']);
  // An entry trusted earlier is not honoured while auto mode is off.
  const { bin, args } = split(line);
  assert.deepEqual(s.classifySpawn(bin, args, { autoMode: false, trustedEngineCommands: [line] }), { ok: false, reason: 'needs-confirmation' });
  assert.equal(s.autoFlagBlocked(bin, args, { autoMode: false }), true);
  assert.deepEqual(s.classifySpawn(bin, args, { autoMode: true, trustedEngineCommands: [line] }), { ok: true, source: 'trusted' });
  // Nor as the configured default command.
  const conf = 'claude --permission-mode bypassPermissions';
  assert.deepEqual(s.classifySpawn('claude', ['--permission-mode', 'bypassPermissions'], { autoMode: false, defaultCommand: conf }), { ok: false, reason: 'needs-confirmation' });
  // A custom binary carrying another preset's long-form bypass flag is blocked too.
  assert.equal(s.autoFlagBlocked('C:\\tools\\wrap.exe', ['--dangerously-skip-permissions'], { autoMode: false }), true);
  assert.equal(s.autoFlagBlocked('C:\\tools\\wrap.exe', ['-s'], { autoMode: false }), false);
});

test('main wires the refusal: no dialog for a bypass line with auto mode off', () => {
  const src = read('src/main/index.ts');
  const fn = src.slice(src.indexOf('async function ensureAllowedEngine('), src.indexOf("ipcMain.handle('pty:spawn'"));
  const guard = fn.indexOf('autoFlagBlocked(command, args, cfg, provider)) return { ok: false, error: ENGINE_AUTO_FLAG_OFF }');
  assert.ok(guard > 0 && guard < fn.indexOf('showMessageBox'), 'the refusal comes before the dialog');
  assert.match(fn, /addTrustedEngine\(now\.trustedEngineCommands, line, now, provider\)/);
  assert.match(s.ENGINE_AUTO_FLAG_OFF, /auto mode/);
});

test('defaultCommand cannot carry a bypass flag while auto mode is off', () => {
  assert.equal(typeof cp.classifyConfigPatch, 'function');
  const src = read('src/main/configPolicy.ts');
  assert.match(src, /autoFlagBlocked\(toks\[0\], toks\.slice\(1\), \{ autoMode: current\.autoMode \}\)\) return 'reject'/);
});

test('every respawn path normalises the command to the current auto mode', () => {
  const restore = read('src/renderer/src/hooks/useRestoreTeam.ts');
  assert.match(restore, /normalizeAutoFlagCommand\(saved, autoMode, provider\)/);
  assert.match(restore, /window\.cth\.getConfig\(\)/);
  const hive = read('src/renderer/src/hooks/useHive.ts');
  assert.match(hive, /normalizeAutoFlagCommand\(buildSpawnCommand\(config, godModel, godProvider\), config\.autoMode === true, godProvider\)/);
  assert.match(hive, /normalizeAutoFlagCommand\(\s*\(a\.command \?\? ''\)\.trim\(\) \|\| buildSpawnCommand\(cfg, a\.model, provider\),\s*cfg\.autoMode === true,/);
  const restart = read('src/renderer/src/nexus/agents/workbench/useRestartAgent.ts');
  assert.match(restart, /normalizeAutoFlagCommand\(buildSpawnCommand\(cfg, model, provider\), cfg\.autoMode === true, provider\)/);
});

test('every preset with an auto flag is covered', () => {
  for (const p of AGENT_PROVIDER_PRESETS) {
    if (!p.autoFlag) continue;
    assert.ok(PERSISTED_ON[p.id], `missing case for ${p.id}`);
  }
});
