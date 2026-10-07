'use strict';
const h = require('./helpers/sqlite.cjs');
if (!h.realSqliteOrSkip()) return;
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');
const { PersistStore } = loadTs('src/main/db.ts');
const { createNexusPlatform } = loadTs('src/main/nexus/platform.ts');
const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

test('the platform runs on the store connection and startup is idempotent', () => {
  const { file } = h.v6Fixture(); const s = new PersistStore(file);
  s.open({ log: () => {}, backupDir: path.join(path.dirname(file), 'b'), now: () => h.NOW });
  const nx = createNexusPlatform(s.platformDatabase(), { now: () => h.NOW });
  assert.deepEqual(nx.startup(), { catalogAdded: 0, primaries: { set: 0, cleared: 0 }, sessions: { interrupted: 0 }, jobs: { interrupted: 0, requeued: 0 } });
  assert.deepEqual(nx.startup(), { catalogAdded: 0, primaries: { set: 0, cleared: 0 }, sessions: { interrupted: 0 }, jobs: { interrupted: 0, requeued: 0 } });
  s.close();
});
test('no platform below v7: platformDatabase is null and Phase A keeps working', () => {
  const { file } = h.v6Fixture(); const s = new PersistStore(file);
  s.open({ log: () => {}, holdV7: true });
  assert.equal(s.platformAvailable, false); assert.equal(s.platformDatabase(), null);
  assert.equal(s.listProjects().length, 5); assert.equal(s.hasPlatformRecords('p-ledger'), false);
  s.setKv('x', 1); assert.equal(s.getKv('x'), 1);
  s.close();
});
test('main wiring: no new IPC channel, no preload change, the principal never comes from the renderer', () => {
  const idx = read('src/main/index.ts');
  assert.match(idx, /createNexusPlatform\(/);
  // 'session:resolveCwd' is the pre-Nexus agent-transcript channel (already at e1fd80f); it is the one
  // exemption, pinned to exactly one handler and one preload call so nothing else hides behind it.
  const preload = read('src/preload/index.ts');
  // Every quote style and every registration form counts, so a second handler cannot hide behind another spelling.
  assert.equal((idx.match(/ipcMain\.(handle|handleOnce|on|once)\(\s*['"`]session:resolveCwd['"`]/g) || []).length, 1);
  assert.equal((idx.match(/['"`]session:resolveCwd['"`]/g) || []).length, 1);
  assert.equal((preload.match(/['"`]session:resolveCwd['"`]/g) || []).length, 1);
  assert.doesNotMatch(idx, /ipcMain\.(handle|handleOnce|on|once)\(\s*['"`](nexus|platform|artifact|lineage|job|session(?!:resolveCwd['"`])|activity)[:.]/);
  assert.doesNotMatch(preload, /nexus:|platform:|artifact:|lineage:|session:(?!resolveCwd['"`])/);
  for (const f of fs.readdirSync(path.join(__dirname, '..', 'src/main/nexus'), { recursive: true }).filter((x) => String(x).endsWith('.ts')))
    assert.doesNotMatch(read(path.join('src/main/nexus', String(f))), /ipcMain|ipcRenderer|webContents/, String(f));
});
test('NEXUS_DB_HOLD_V7 is honoured by main', () => assert.match(read('src/main/index.ts'), /NEXUS_DB_HOLD_V7/));
test('a second instance that lost the single-instance lock never opens the store', () => {
  const idx = read('src/main/index.ts');
  assert.match(idx, /const gotInstanceLock = app\.requestSingleInstanceLock\(\);/);
  // The very first line of the whenReady callback returns when the lock was not obtained ...
  const m = idx.match(/app\.whenReady\(\)\.then\(\(\) => \{\r?\n([^\r\n]*)/);
  assert.ok(m, 'whenReady callback not found');
  assert.match(m[1], /^\s*if \(!gotInstanceLock\) return;/);
  assert.equal((idx.match(/app\.whenReady\(/g) || []).length, 1);
  // ... and that return comes before the store is opened.
  const ready = idx.indexOf('app.whenReady().then(');
  assert.ok(idx.indexOf('if (!gotInstanceLock) return;', ready) < idx.indexOf('persist.open(', ready));
});
