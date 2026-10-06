'use strict';
/**
 * O.9 #9: the Claude bypass-warning keys ride in each agent's OWN --settings
 * file (under harnessHome, Nexus data), only while auto mode is on. Nothing is
 * written to the user's ~/.claude any more.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const { HiveManager } = loadTs('src/main/hive.ts');
const KEYS = ['skipDangerousModePermissionPrompt', 'skipAutoPermissionPrompt'];

async function settingsFor(t, opts) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nx-hive-settings-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const hive = new HiveManager(() => home);
  const inj = await hive.ensureAgent({ id: 'dev-1', name: 'Dev', provider: 'claude', cwd: home }, opts);
  const i = inj.args.indexOf('--settings');
  assert.ok(i >= 0, 'claude agents get a per-agent --settings file');
  const file = inj.args[i + 1];
  assert.ok(path.resolve(file).startsWith(path.resolve(home)), 'the settings file lives under harnessHome');
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

test('auto mode on: the per-agent settings pre-accept the bypass warning', async (t) => {
  const s = await settingsFor(t, { autoMode: true });
  for (const k of KEYS) assert.equal(s[k], true, k);
  assert.ok(s.hooks && s.hooks.Stop, 'hooks are still there');
});

test('auto mode off (or unset): the keys are absent', async (t) => {
  for (const opts of [{ autoMode: false }, {}]) {
    const s = await settingsFor(t, opts);
    for (const k of KEYS) assert.equal(k in s, false, `${k} with ${JSON.stringify(opts)}`);
  }
});

test('the spawn path passes the floor auto mode and no longer touches ~/.claude', () => {
  const idx = fs.readFileSync(path.join(__dirname, '..', 'src/main/index.ts'), 'utf8');
  assert.match(idx, /autoMode: readConfig\(\)\.autoMode === true,/);
  assert.doesNotMatch(idx, /ensureClaudePermissionsAccepted/);
  const cfg = fs.readFileSync(path.join(__dirname, '..', 'src/main/config.ts'), 'utf8');
  assert.doesNotMatch(cfg, /homedir\(\)/);
  assert.doesNotMatch(cfg, /hasTrustDialogAccepted\s*=/);
});
