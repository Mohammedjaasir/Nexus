'use strict';
/**
 * O.9 #8 end to end against the real config.ts + integrations.ts, with electron
 * replaced by a temp userData dir and a FAKE safeStorage (reversible, but never
 * the plaintext on disk). Never touches the user's real config.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'nx-userdata-'));
const fake = { available: true };
const handlers = {};
const electronPath = require.resolve('electron');
require.cache[electronPath] = {
  id: electronPath,
  filename: electronPath,
  loaded: true,
  exports: {
    app: { getPath: () => userData },
    safeStorage: {
      isEncryptionAvailable: () => fake.available,
      encryptString: (s) => Buffer.from(`fake:${Buffer.from(s, 'utf8').toString('hex').split('').reverse().join('')}`),
      decryptString: (b) => {
        const t = b.toString('utf8');
        if (!t.startsWith('fake:')) throw new Error('bad cipher');
        return Buffer.from(t.slice(5).split('').reverse().join(''), 'hex').toString('utf8');
      }
    },
    ipcMain: { handle: (name, fn) => { handlers[name] = fn; } },
    Notification: class { show() {} static isSupported() { return false; } }
  }
};

const config = loadTs('src/main/config.ts');
const integrations = loadTs('src/main/integrations.ts');
const { migrateConfigSecrets, redactConfig } = loadTs('src/main/configSecrets.ts');

const cfgFile = path.join(userData, 'config.json');
const blobFile = path.join(userData, 'integration-secrets.json');
const PLAIN = {
  onboardingComplete: true, harnessHome: null, slackEnabled: true,
  slackSigningSecret: 'SIGN-aaa111', slackBotToken: 'xoxb-bbb222', groqApiKey: 'gsk_ccc333', webhookSecret: 'WH-ddd444',
  webhookTriggers: [{ id: 'legacy', name: 'Default webhook', secret: 'WH-ddd444', enabled: true, mode: 'strict', schema: '{}', createdAt: 1 },
    { id: 'wh-2', name: 'two', secret: 'WH-eee555', enabled: false, mode: 'strict', schema: '{}', createdAt: 2 }],
  orgTrigger: { apiKey: 'ORG-fff666', enabled: false, mode: 'strict' },
  triggersMigratedV1: true
};
const VALUES = ['SIGN-aaa111', 'xoxb-bbb222', 'gsk_ccc333', 'WH-ddd444', 'WH-eee555', 'ORG-fff666'];

function deps() {
  return {
    encryptionAvailable: () => integrations.encryptionAvailable(),
    backup: () => { const dst = path.join(userData, 'config.pre-secrets-20261006120000.json'); fs.copyFileSync(cfgFile, dst); return dst; },
    setSecret: (r, v) => integrations.setSecret(r, v),
    getSecret: (r) => integrations.getSecret(r),
    write: (next) => { config.persistConfig(next); }
  };
}

function reset() {
  for (const f of fs.readdirSync(userData)) fs.rmSync(path.join(userData, f), { force: true, recursive: true });
  fs.writeFileSync(cfgFile, JSON.stringify(PLAIN, null, 2));
}

test('before the migration every reader falls back to the plaintext', () => {
  reset();
  const s = config.readConfigSecrets();
  assert.equal(s.slackSigningSecret, 'SIGN-aaa111');
  assert.equal(s.groqApiKey, 'gsk_ccc333');
  assert.equal(s.webhookSecrets['wh-2'], 'WH-eee555');
  assert.equal(config.readConfigSecret('slackBotToken'), 'xoxb-bbb222');
});

test('without secure storage nothing moves, nothing is backed up, and the app keeps working', () => {
  reset();
  fake.available = false;
  try {
    const before = fs.readFileSync(cfgFile, 'utf8');
    assert.equal(migrateConfigSecrets(config.readConfig(), deps()).status, 'encryption-unavailable');
    assert.equal(fs.readFileSync(cfgFile, 'utf8'), before);
    assert.ok(!fs.existsSync(path.join(userData, 'config.pre-secrets-20261006120000.json')));
    assert.equal(config.readConfigSecret('slackSigningSecret'), 'SIGN-aaa111');
    // Saving a new secret without secure storage refuses to encrypt; the caller keeps plaintext.
    assert.equal(integrations.setSecret('config:groqApiKey', 'gsk_new').ok, false);
  } finally {
    fake.available = true;
  }
});

test('the migration backs up, stores every secret encrypted, verifies, then strips config.json', () => {
  reset();
  const r = migrateConfigSecrets(config.readConfig(), deps());
  assert.equal(r.status, 'migrated');
  const backup = fs.readFileSync(r.backup, 'utf8');
  for (const v of VALUES) assert.ok(backup.includes(v), `backup keeps ${v}`);
  const onDisk = fs.readFileSync(cfgFile, 'utf8');
  for (const v of VALUES) assert.ok(!onDisk.includes(v), `config.json no longer has ${v}`);
  const blob = fs.readFileSync(blobFile, 'utf8');
  for (const v of VALUES) assert.ok(!blob.includes(v), `the store is not plaintext: ${v}`);
  assert.equal(JSON.parse(onDisk).secretsMigratedV1, true);
  // Every reader gets the same values back, now from the store.
  const s = config.readConfigSecrets();
  assert.deepEqual(
    [s.slackSigningSecret, s.slackBotToken, s.groqApiKey, s.webhookSecret, s.orgApiKey, s.webhookSecrets.legacy, s.webhookSecrets['wh-2']],
    ['SIGN-aaa111', 'xoxb-bbb222', 'gsk_ccc333', 'WH-ddd444', 'ORG-fff666', 'WH-ddd444', 'WH-eee555']
  );
  // Running again finds nothing to do.
  assert.equal(migrateConfigSecrets(config.readConfig(), deps()).status, 'nothing');
  // What config:get would send: presence only.
  const red = redactConfig(config.readConfig(), integrations.hasSecret);
  for (const v of VALUES) assert.ok(!JSON.stringify(red).includes(v), v);
  assert.equal(red.secretsPresent.slackSigningSecret, true);
  assert.equal(red.webhookTriggers.find((t) => t.id === 'wh-2').hasSecret, true);
  assert.equal(red.orgTrigger.hasApiKey, true);
});

test('a store that cannot read a secret back leaves config.json exactly as it was', () => {
  reset();
  const before = fs.readFileSync(cfgFile, 'utf8');
  const r = migrateConfigSecrets(config.readConfig(), { ...deps(), getSecret: () => undefined });
  assert.equal(r.status, 'verify-failed');
  assert.equal(fs.readFileSync(cfgFile, 'utf8'), before);
  for (const v of VALUES) assert.ok(fs.readFileSync(cfgFile, 'utf8').includes(v), `still in config.json: ${v}`);
  assert.ok(fs.existsSync(r.backup));
});

test('reset drops the config-owned secrets and only those', () => {
  reset();
  migrateConfigSecrets(config.readConfig(), deps());
  integrations.setSecret('apikey:openai', 'sk-keep');
  config.deleteConfigSecrets();
  assert.equal(config.readConfigSecret('slackSigningSecret'), undefined);
  assert.equal(integrations.getSecret('apikey:openai'), 'sk-keep');
});

test('config writes are atomic and leave no temp files behind', () => {
  reset();
  config.writeConfig({ notifications: true });
  config.writeConfig({ notifications: false });
  assert.equal(JSON.parse(fs.readFileSync(cfgFile, 'utf8')).notifications, false);
  assert.deepEqual(fs.readdirSync(userData).filter((f) => f.endsWith('.tmp')), []);
});

test('voice can turn auto mode and Free Flow off, never on', async () => {
  const { registerRealtimeActionIpc } = loadTs('src/main/realtimeActions.ts');
  const patched = [];
  const values = { autoMode: false, freeflowEnabled: false, notifications: false };
  registerRealtimeActionIpc({
    hiveEnabled: () => true,
    hiveRegistry: () => ({ agents: {} }),
    hiveSend: () => ({}),
    getConfigValue: (k) => values[k],
    patchConfig: (p) => { patched.push(p); Object.assign(values, p); return true; },
    hiveLog: () => {}
  });
  const act = (key, value) => handlers['realtime:action'](null, { verb: 'update_setting', key, value });
  const on = await act('autoMode', true);
  assert.deepEqual(on, { ok: false, spoken: 'Turning auto mode on needs a confirmation in Settings.' });
  assert.equal((await act('freeflowEnabled', true)).ok, false);
  assert.deepEqual(patched, []);
  values.autoMode = true;
  const off = await act('autoMode', false);
  assert.equal(off.needsConfirm, true);
  const done = await handlers['realtime:action:confirm'](null, { phrase: 'confirm' });
  assert.equal(done.ok, true);
  assert.deepEqual(patched, [{ autoMode: false }]);
});

test('auto mode default: new installs off, an onboarded config that never stored it keeps the old on', () => {
  for (const f of fs.readdirSync(userData)) fs.rmSync(path.join(userData, f), { force: true, recursive: true });
  assert.equal(config.readConfig().autoMode, false, 'no config.json = a new install');
  fs.writeFileSync(cfgFile, JSON.stringify({ onboardingComplete: true, triggersMigratedV1: true }));
  assert.equal(config.readConfig().autoMode, true, 'legacy implicit default is kept, then reviewed by the banner');
  fs.writeFileSync(cfgFile, JSON.stringify({ onboardingComplete: true, autoMode: false, triggersMigratedV1: true }));
  assert.equal(config.readConfig().autoMode, false);
  fs.writeFileSync(cfgFile, JSON.stringify({ onboardingComplete: false, triggersMigratedV1: true }));
  assert.equal(config.readConfig().autoMode, false);
});

// ─── Fix round 1 ────────────────────────────────────────────────────────────

test('Free Flow default: new installs off, an onboarded config that never stored it stays on', () => {
  for (const f of fs.readdirSync(userData)) fs.rmSync(path.join(userData, f), { force: true, recursive: true });
  assert.equal(config.readConfig().freeflowEnabled, false, 'no config.json = a new install');
  fs.writeFileSync(cfgFile, JSON.stringify({ onboardingComplete: false, triggersMigratedV1: true }));
  assert.equal(config.readConfig().freeflowEnabled, false, 'still onboarding = new install');
  fs.writeFileSync(cfgFile, JSON.stringify({ onboardingComplete: true, triggersMigratedV1: true }));
  assert.equal(config.readConfig().freeflowEnabled, true, 'existing install keeps the old default');
  fs.writeFileSync(cfgFile, JSON.stringify({ onboardingComplete: true, freeflowEnabled: false, triggersMigratedV1: true }));
  assert.equal(config.readConfig().freeflowEnabled, false, 'an explicit choice wins');
});

test('an unreadable secrets file is set aside before any write, never overwritten', () => {
  reset();
  fs.writeFileSync(blobFile, '{ this is not json');
  assert.equal(integrations.getSecret('config:groqApiKey'), undefined, 'reads see nothing');
  assert.ok(fs.existsSync(blobFile), 'a read does not move or rewrite it');
  assert.deepEqual(integrations.corruptSecretFiles(), []);
  const warnings = [];
  const warn = console.warn;
  console.warn = (...a) => warnings.push(a.join(' '));
  try {
    assert.equal(integrations.setSecret('config:groqApiKey', 'gsk_new').ok, true);
  } finally {
    console.warn = warn;
  }
  const aside = integrations.corruptSecretFiles();
  assert.equal(aside.length, 1);
  assert.match(path.basename(aside[0]), /^integration-secrets\.corrupt-\d{14}\.json$/);
  assert.equal(fs.readFileSync(aside[0], 'utf8'), '{ this is not json', 'the original bytes are kept');
  assert.equal(integrations.getSecret('config:groqApiKey'), 'gsk_new');
  assert.ok(warnings.some((w) => w.includes('set aside')), 'a warning is surfaced');
  // A JSON value that is not an object counts as unreadable too.
  fs.writeFileSync(blobFile, '[1,2]');
  integrations.setSecret('config:slackBotToken', 'xoxb-x');
  assert.equal(integrations.corruptSecretFiles().length, 2);
});
