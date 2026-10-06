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
test('O.9 #21: no execSync on main; spawnSync and execFileSync limited to the reviewed sites', () => {
  const root = path.join(__dirname, '..', 'src', 'main');
  const sync = {};
  const fileSync = {};
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { walk(full); continue; }
      if (!/\.(ts|cjs|js|mjs)$/.test(e.name)) continue;
      const rel = path.relative(root, full).split(path.sep).join('/');
      const src = fs.readFileSync(full, 'utf8');
      assert.doesNotMatch(src, /\bexecSync\(/, rel);
      const n = (src.match(/\bspawnSync\(/g) || []).length;
      if (n) sync[rel] = n;
      const m = (src.match(/\bexecFileSync\(/g) || []).length;
      if (m) fileSync[rel] = m;
    }
  };
  walk(root);
  // Reviewed spawnSync: hive git plumbing; kg pdftotext; mempalace probe (2); macOS login-shell capture + where; pty where.
  // procKill.ts has none: ensureKilled and hardKillTree (win32) use the async taskkill.
  assert.deepEqual(sync, { 'hive.ts': 1, 'kg-core.cjs': 1, 'memory.ts': 2, 'pty.ts': 1, 'shellEnv.ts': 2 });
  // Reviewed execFileSync: node --version probe in nodeInstall.
  assert.deepEqual(fileSync, { 'nodeInstall.ts': 1 });
});
test('O.9 #20: JSON keys, URL userinfo, short values and webhook URLs are redacted', () => {
  const cases = [
    ['{"token":"abcdefghijk"}', 'abcdefghijk'],
    ['{"password": "hunter2hunter2"}', 'hunter2hunter2'],
    ["{'api_key': 'zzzzzzzz'}", 'zzzzzzzz'],
    ['postgres://admin:s3cretpw@db.local:5432/x', 's3cretpw'],
    ['https://user:p%40ss@example.com/a', 'p%40ss'],
    ['Bearer abc', 'abc'],
    ['api_key: abc', 'abc'],
    ['token=xy', 'xy'],
    ['https://hooks.slack.com/services/T000/B000/XXXXSECRET', 'XXXXSECRET'],
    ['https://discord.com/api/webhooks/123456/AbCdEfSecret', 'AbCdEfSecret'],
    ['https://api.telegram.org/bot123456:ABCsecret/sendMessage', 'ABCsecret']
  ];
  for (const [input, secret] of cases) {
    const out = redactForLog(input);
    assert.ok(!out.includes(secret), `${input} -> ${out}`);
    assert.match(out, /redacted/, input);
  }
  assert.match(redactForLog('{"token":"abcdefghijk"}'), /^\{"token":"\[redacted\]"\}$/);
  assert.match(redactForLog('postgres://admin:s3cretpw@db.local/x'), /^postgres:\/\/\[redacted\]@db\.local\/x$/);
});
test('O.9 #20: quoted values with spaces or escaped quotes are fully redacted', () => {
  const cases = [
    ['{"token": "abc def"}', ['abc', 'def']],
    ['{"secret": "has space inside"}', ['has', 'space', 'inside']],
    ["password='p@ss w0rd'", ['p@ss', 'w0rd']],
    ['{"token":"a\\"b"}', ['a\\', 'b"']]
  ];
  for (const [input, leaks] of cases) {
    const out = redactForLog(input);
    for (const l of leaks) assert.ok(!out.includes(l), `${input} -> ${out}`);
    assert.match(out, /\[redacted\]/, input);
  }
  assert.equal(redactForLog('{"token": "abc def"}'), '{"token": "[redacted]"}');
  assert.equal(redactForLog('{"token":"a\\"b"} tail'), '{"token":"[redacted]"} tail');
  assert.equal(redactForLog('mask-input and task-list'), 'mask-input and task-list');
});
test('O.9 #20: ordinary log text is left unchanged', () => {
  for (const t of [
    'Error: ENOENT: no such file or directory, open /home/x/file.txt',
    '    at Object.<anonymous> (/app/out/main/index.js:12:5)',
    'https://example.com/path?a=1 failed with status 500 at 2026-10-06T10:00:00.000Z',
    'agent claude-1 exited with code 1 after 3 retries (commit a1b2c3d)'
  ]) assert.equal(redactForLog(t), t);
});
test('O.9 #21: ensureKilled sweeps with the async taskkill', () => {
  const s = read('src/main/procKill.ts');
  assert.match(s, /export function hardKillTreeAsync/);
  assert.match(s, /void hardKillTreeAsync\(pid\)/);
});
