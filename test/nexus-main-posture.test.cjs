'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');
const { isSafeCommandName } = loadTs('src/main/commandName.ts');
const { formatCrash, appendCrashLog, redactForLog } = loadTs('src/main/crashLog.ts');
const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

test('O.9 #17: only bare program names reach where.exe', () => {
  for (const ok of ['claude', 'codex', 'node', 'claude-code', 'pi', 'a.b_c+d']) assert.equal(isSafeCommandName(ok), true, ok);
  for (const bad of ['claude & calc', 'a|b', 'a>b', '%PATH%', '!x!', 'a^b', '"a"', 'a b', '', 'a\nb', '(a)', 'a;b', '$(x)'])
    assert.equal(isSafeCommandName(bad), false, JSON.stringify(bad));
});
test('O.9 #17: where never runs through a shell', () => {
  for (const f of ['src/main/pty.ts', 'src/main/shellEnv.ts', 'src/main/memory.ts'])
    assert.doesNotMatch(read(f), /spawnSync\(\s*'where'[^)]*shell:\s*true/, f);
  for (const f of ['src/main/pty.ts', 'src/main/shellEnv.ts']) {
    assert.match(read(f), /isSafeCommandName\(command\)/, f);
    assert.doesNotMatch(read(f), /shell:\s*true/, f);
  }
});
test('O.9 #20: a crash is written to a log file with its stack', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nx-log-'));
  appendCrashLog(dir, formatCrash('uncaughtException', new Error('boom'), new Date('2026-10-06T10:00:00Z')));
  const text = fs.readFileSync(path.join(dir, 'main.log'), 'utf8');
  assert.match(text, /2026-10-06T10:00:00\.000Z uncaughtException Error: boom/);
  assert.match(text, /\n\s+at /);
  assert.match(formatCrash('unhandledRejection', 'plain reason', new Date(0)), /unhandledRejection plain reason/);
  assert.match(read('src/main/index.ts'), /appendCrashLog\(/);
});
test('O.9 #20: the log rotates and keeps three files', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nx-log-'));
  for (let i = 0; i < 40; i++) appendCrashLog(dir, `line ${i} ${'x'.repeat(40)}`, { maxBytes: 200, keep: 3 });
  assert.deepEqual(fs.readdirSync(dir).sort(), ['main.1.log', 'main.2.log', 'main.log']);
});
test('O.9 #20: secrets are redacted from crash entries', () => {
  const hex = 'a1'.repeat(32);
  const samples = [
    'xoxb-1234567890-abcdefghij', 'gsk_abcdefghijklmnop1234', 'sk-ant-abcdefghijklmnopqrstuv',
    'Bearer abcdefghijklmnop12345', hex, 'password=hunter2hunter2', 'Authorization: Basic dXNlcjpwYXNz'
  ];
  for (const s of samples) {
    const out = formatCrash('uncaughtException', new Error(`failed with ${s} in call`), new Date(0));
    assert.doesNotMatch(out, /xoxb-123|gsk_abc|sk-ant-abc|abcdefghijklmnop12345|hunter2|dXNlcjpwYXNz/, s);
    assert.ok(!out.includes(hex), s);
    assert.match(out, /redacted/, s);
  }
  assert.equal(redactForLog('plain text stays'), 'plain text stays');
  assert.match(redactForLog('abc123def4567'), /abc123def4567/);
});
test('O.9 #20: the crash log never throws', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nx-log-'));
  const blocker = path.join(dir, 'file');
  fs.writeFileSync(blocker, 'x');
  assert.doesNotThrow(() => appendCrashLog(path.join(blocker, 'sub'), 'x'));
  const cyc = {}; cyc.self = cyc;
  assert.doesNotThrow(() => formatCrash('unhandledRejection', cyc, new Date(0)));
  assert.doesNotThrow(() => formatCrash('unhandledRejection', undefined, new Date(NaN)));
});
test('O.9 #21: no execSync on main; spawnSync limited to the reviewed sites', () => {
  const dir = path.join(__dirname, '..', 'src', 'main');
  const counts = {};
  for (const f of fs.readdirSync(dir).filter((f) => /\.(ts|cjs)$/.test(f))) {
    const s = fs.readFileSync(path.join(dir, f), 'utf8');
    assert.doesNotMatch(s, /\bexecSync\(/, f);
    const n = (s.match(/\bspawnSync\(/g) || []).length;
    if (n) counts[f] = n;
  }
  // Reviewed: quit-path taskkill; hive git plumbing; kg pdftotext; mempalace probe (2); macOS login-shell capture + where; pty where.
  assert.deepEqual(counts, { 'hive.ts': 1, 'kg-core.cjs': 1, 'memory.ts': 2, 'procKill.ts': 1, 'pty.ts': 1, 'shellEnv.ts': 2 });
});
test('O.9 #21: ensureKilled sweeps with the async taskkill', () => {
  const s = read('src/main/procKill.ts');
  assert.match(s, /export function hardKillTreeAsync/);
  assert.match(s, /void hardKillTreeAsync\(pid\)/);
});
