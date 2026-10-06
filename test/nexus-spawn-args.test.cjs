'use strict';
// Task 11 fix round 1: renderer args, cmd.exe fallback, forbidden engines,
// git-derived roots and the voice provider map.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');
const s = loadTs('src/main/spawnPolicy.ts');
const { cmdFallbackUnsafeArg, CMD_FALLBACK_UNSAFE } = loadTs('src/main/pty.ts');
const { derivedRootListsFolder } = loadTs('src/main/fsRoots.ts');
const { AGENT_PROVIDER_PRESETS, providerPreset } = loadTs('src/shared/agentProvider.ts');

const req = (args) => ({ id: 'p1', cwd: 'C:\\x', command: 'claude', args });

// ── 1. cmd.exe injection ──────────────────────────────────────────────────
test('sanitize rejects a renderer arg containing " % ! CR LF or NUL', () => {
  for (const ch of ['"', '%', '!', '\r', '\n', '\0']) {
    const r = s.sanitizeSpawnRequest(req(['--model', `m${ch}x`]));
    assert.equal(r.ok, false, JSON.stringify(ch));
    assert.match(r.error, /not allowed/);
  }
  assert.equal(s.sanitizeSpawnRequest(req(['--model', 'Gemini 3.1 Pro (High)'])).ok, true);
});

test('the cmd.exe fallback refuses every cmd metacharacter in an argument', () => {
  for (const ch of ['&', '|', '<', '>', '^', '(', ')', '"', '%', '!', '\r', '\n', '\0']) {
    assert.equal(cmdFallbackUnsafeArg(['ok', `a${ch}b`]), `a${ch}b`, JSON.stringify(ch));
    assert.match(`x${ch}`, CMD_FALLBACK_UNSAFE);
  }
  assert.equal(cmdFallbackUnsafeArg(['--model', 'claude-fable-5', '--verbose']), null);
  assert.equal(cmdFallbackUnsafeArg([]), null);
});

test('pty.spawn refuses the cmd.exe route before building its command line', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src/main/pty.ts'), 'utf8');
  const i = src.indexOf('cmdFallbackUnsafeArg(opts.args ?? [])');
  const j = src.indexOf('buildCmdCommandLine(resolved, opts.args ?? [])');
  assert.ok(i > 0 && j > i, 'the refusal must come before the cmd.exe line is built');
  assert.match(src.slice(i, j), /return \{\s*ok: false,/);
});

// ── 2. preset flag allow-lists ────────────────────────────────────────────
test('allowed preset args spawn without a dialog', () => {
  const cfg = { defaultCommand: 'claude', autoMode: true };
  assert.deepEqual(s.classifySpawn('claude', ['--model', 'claude-fable-5', '--permission-mode', 'bypassPermissions'], cfg), { ok: true, source: 'preset' });
  assert.deepEqual(s.classifySpawn('claude', ['--model=claude-fable-5', '--max-turns', '40', '--verbose', '--output-format', 'json'], cfg), { ok: true, source: 'preset' });
  assert.deepEqual(s.classifySpawn('codex', ['--model', 'gpt-5.5', '--dangerously-bypass-approvals-and-sandbox'], cfg), { ok: true, source: 'preset' });
  assert.deepEqual(s.classifySpawn('agy', ['--model', 'Gemini 3.1 Pro (High)', '--dangerously-skip-permissions'], cfg), { ok: true, source: 'preset' });
  assert.deepEqual(s.classifySpawn('copilot', ['--model', 'auto', '-s', '--allow-all-tools', '--no-ask-user'], cfg), { ok: true, source: 'preset' });
  assert.deepEqual(s.classifySpawn('claude', ['--resume', 'abc-123'], cfg), { ok: true, source: 'preset' });
  // Every preset's own buildSpawnCommand output (model + auto flag) passes.
  for (const p of AGENT_PROVIDER_PRESETS.filter((x) => x.defaultCommand)) {
    const args = [];
    if (p.modelFlag) args.push(p.modelFlag, 'some-model');
    if (p.autoFlag) args.push(...p.autoFlag.trim().split(/\s+/));
    assert.deepEqual(s.classifySpawn(p.defaultCommand, args, cfg), { ok: true, source: 'preset' }, p.id);
  }
});

test('bypass flags are allowed only while auto mode is on', () => {
  const args = ['--permission-mode', 'bypassPermissions'];
  assert.deepEqual(s.classifySpawn('claude', args, { autoMode: false }), { ok: false, reason: 'needs-confirmation' });
  assert.deepEqual(s.classifySpawn('claude', ['--permission-mode', 'plan'], { autoMode: true }), { ok: false, reason: 'needs-confirmation' });
});

test('--settings and other config/hook injectors trigger the dialog', () => {
  const cfg = { defaultCommand: 'claude', autoMode: true };
  for (const args of [
    ['--settings', '{hooks:{}}'], ['--settings={}'], ['--mcp-config', 'x.json'], ['--append-system-prompt', 'x'],
    ['-c', 'model_providers.x.base_url=http://evil'], ['--add-dir', 'C:\\'], ['--model', 'm', 'positional'],
    ['--model'], ['--max-turns', 'lots'], ['--output-format', 'yaml']
  ]) {
    assert.deepEqual(s.classifySpawn('claude', args, cfg), { ok: false, reason: 'needs-confirmation' }, JSON.stringify(args));
    assert.deepEqual(s.classifySpawn('codex', args, cfg), { ok: false, reason: 'needs-confirmation' }, JSON.stringify(args));
  }
  // The configured command does not widen the list either.
  assert.deepEqual(s.classifySpawn('C:\\tools\\claude.cmd', ['--verbose', '--settings', '{}'], { defaultCommand: 'C:\\tools\\claude.cmd --verbose' }),
    { ok: false, reason: 'needs-confirmation' });
});

test('no preset allow-list contains a config, hook, prompt or directory flag', () => {
  const never = ['--settings', '--mcp-config', '--append-system-prompt', '--system-prompt', '-c', '--config', '--add-dir',
    '--plugin-dir', '--profile', '--provider', '--base-url', '--cd', '-C', '--sandbox', '--dangerously-skip-permissions-for-real'];
  for (const p of AGENT_PROVIDER_PRESETS) {
    for (const auto of [true, false]) {
      const rules = s.presetFlagAllowList(p.id, { autoMode: auto });
      for (const f of never) assert.equal(rules.has(f), false, `${p.id} ${f}`);
    }
  }
  assert.equal(s.presetFlagAllowList('custom', { autoMode: true }).size, 0);
});

test('approval is remembered per exact command line, never per binary', () => {
  const line = s.commandLineKey('claude', ['--settings', '{}']);
  assert.equal(line, 'claude --settings {}');
  const cfg = { trustedEngineCommands: [line] };
  assert.deepEqual(s.classifySpawn('claude', ['--settings', '{}'], cfg), { ok: true, source: 'trusted' });
  assert.deepEqual(s.classifySpawn('claude', ['--settings', '{"x":1}'], cfg), { ok: false, reason: 'needs-confirmation' });
  assert.deepEqual(s.classifySpawn('claude', ['--settings', '{}', '--verbose'], cfg), { ok: false, reason: 'needs-confirmation' });
  // A custom engine allowed with no args is not allowed with args.
  const aider = { trustedEngineCommands: [s.commandLineKey('aider', [])] };
  assert.deepEqual(s.classifySpawn('aider', [], aider), { ok: true, source: 'trusted' });
  assert.deepEqual(s.classifySpawn('aider', ['--yes'], aider), { ok: false, reason: 'needs-confirmation' });
  // Quoting keeps the key unambiguous.
  assert.notEqual(s.commandLineKey('a', ['b c']), s.commandLineKey('a', ['b', 'c']));
  assert.equal(s.commandLineKey('C:\\Program Files\\x.exe', ['--m', 'a b']), '"C:\\Program Files\\x.exe" --m "a b"');
});

test('the dialog shows the full command line', () => {
  assert.equal(s.engineConfirmText(s.commandLineKey('claude', ['--settings', '{}']), 'C:\\w').message,
    'Run “claude --settings {}” as an agent engine?');
  const idx = fs.readFileSync(path.join(__dirname, '..', 'src/main/index.ts'), 'utf8');
  assert.match(idx, /const line = commandLineKey\(command\.trim\(\), args\)/);
  assert.match(idx, /engineConfirmText\(line, /);
  assert.match(idx, /addTrustedEngine\(readConfig\(\)\.trustedEngineCommands, line\)/);
  assert.match(idx, /ensureAllowedEngine\(sanitized\.opts\.command, sanitized\.opts\.args, /);
});

// ── 3. shells and interpreters ────────────────────────────────────────────
test('shells and interpreters are never engines, with or without extension or path', () => {
  const names = ['cmd', 'powershell', 'pwsh', 'bash', 'sh', 'zsh', 'wscript', 'cscript', 'mshta', 'node', 'python', 'py', 'deno', 'bun'];
  for (const n of names) {
    for (const c of [n, n.toUpperCase(), `${n}.exe`, `C:\\Windows\\System32\\${n}.exe`, `/usr/bin/${n}`, `${n}.cmd`]) {
      const cfg = { defaultCommand: c, trustedEngineCommands: [c, s.commandLineKey(c, [])] };
      assert.deepEqual(s.classifySpawn(c, [], cfg), { ok: false, reason: 'forbidden' }, c);
    }
  }
  assert.match(s.ENGINE_FORBIDDEN, /cannot run as an agent engine/);
  // Preset CLIs whose launcher is a node script stay presets (pty.ts decodes the shim).
  for (const c of ['claude', 'claude.cmd', 'codex', 'opencode', 'qwen']) assert.equal(s.classifySpawn(c, [], {}).ok, true, c);
  assert.equal(s.isForbiddenEngine('nodemon'), false);
  assert.equal(s.isForbiddenEngine('shellcheck'), false);
});

// ── 4. git-derived roots ──────────────────────────────────────────────────
test('a derived git root is kept only when it lists the folder or its toplevel', () => {
  const wts = ['C:/repo', 'C:/Users/me/Hive/worktrees/dev1'];
  assert.equal(derivedRootListsFolder(wts, ['C:\\Users\\me\\Hive\\worktrees\\dev1'], 'win32'), true);
  assert.equal(derivedRootListsFolder(wts, ['c:\\REPO'], 'win32'), true);
  assert.equal(derivedRootListsFolder(wts, ['C:\\repo\\sub', 'C:/repo'], 'win32'), true); // sub-folder project, toplevel listed
  assert.equal(derivedRootListsFolder(wts, ['C:\\repo\\sub'], 'win32'), false);           // the folder itself is not a worktree
  assert.equal(derivedRootListsFolder(wts, ['C:\\other'], 'win32'), false);
  assert.equal(derivedRootListsFolder([], ['C:\\repo'], 'win32'), false);
  assert.equal(derivedRootListsFolder(wts, [null, undefined, ''], 'win32'), false);
  assert.equal(derivedRootListsFolder(['/home/u/repo'], ['/home/u/repo'], 'linux'), true);
  assert.equal(derivedRootListsFolder(['/home/u/repo'], ['/home/u/Repo'], 'linux'), false);
  const idx = fs.readFileSync(path.join(__dirname, '..', 'src/main/index.ts'), 'utf8');
  const h = idx.slice(idx.indexOf("ipcMain.handle('git:mainRepo'"), idx.indexOf("ipcMain.handle('git:branch'"));
  assert.match(h, /listWorktrees\(root\)/);
  assert.match(h, /if \(!derivedRootListsFolder\(paths, \[expandTilde\(cwd\), real, top\]\)\) return root;/);
});

// ── 5. voice provider map ─────────────────────────────────────────────────
test('voice spawns map spoken names to supported presets', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src/main/realtimeActions.ts'), 'utf8');
  const map = src.slice(src.indexOf('export const PROVIDER_COMMAND'), src.indexOf('};', src.indexOf('export const PROVIDER_COMMAND')));
  const entries = Object.fromEntries([...map.matchAll(/(\w+): '([^']+)'/g)].map((m) => [m[1], m[2]]));
  for (const [id, bin] of Object.entries(entries)) assert.equal(bin, providerPreset(id).defaultCommand, id);
  for (const id of ['grok', 'kimi', 'antigravity']) assert.ok(entries[id], id);
  assert.equal(entries.gemini, undefined);
  assert.match(src, /PROVIDER_ALIAS: Record<string, string> = \{ gemini: 'antigravity', agy: 'antigravity' \}/);
  assert.match(src, /const provider = PROVIDER_ALIAS\[spoken\] \?\? spoken;/);
});
