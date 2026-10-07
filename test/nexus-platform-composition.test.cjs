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
test('main wiring: no IPC channel outside nexus:*, the nexus:* channels only through registerNexusIpc, the principal never from the renderer', () => {
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
  // B1 Task 6: the preload now carries the nexus:* family (pinned exactly in the next test). Outside its literals the old ban holds.
  const preloadOutsideNexus = preload.replace(/(['"`])nexus:[A-Za-z:]+\1/g, "''");
  assert.doesNotMatch(preloadOutsideNexus, /nexus:|platform:|artifact:|lineage:|session:(?!resolveCwd['"`])/);
  for (const f of fs.readdirSync(path.join(__dirname, '..', 'src/main/nexus'), { recursive: true }).filter((x) => String(x).endsWith('.ts')))
    assert.doesNotMatch(read(path.join('src/main/nexus', String(f))), /ipcMain|ipcRenderer|webContents/, String(f));
});
// B1 Task 6: the nexus:* family. The exact channel list, the exact preload methods, one registration call in main,
// every handler through the one wrapper, and no identity read from request arguments.
const NEXUS_CHANNEL_LIST = [
  'nexus:participations:list', 'nexus:participation:attach', 'nexus:participation:withdraw',
  'nexus:artifacts:list', 'nexus:artifacts:byProject', 'nexus:artifact:get', 'nexus:version:get', 'nexus:lineage:get',
  'nexus:artifact:saveCommit', 'nexus:artifact:saveTextFile', 'nexus:version:markReady', 'nexus:version:promote',
  'nexus:version:discard', 'nexus:version:linkSources',
  'nexus:handoffs:list', 'nexus:handoff:get', 'nexus:handoff:send', 'nexus:handoff:accept', 'nexus:handoff:decline', 'nexus:handoff:withdraw',
  'nexus:activity:byProject'
];
// Task 6 registers and exposes the read channels; Task 7 adds the writes (then both lists equal NEXUS_CHANNEL_LIST).
const NEXUS_REGISTERED = ['nexus:participations:list', 'nexus:artifacts:list', 'nexus:artifacts:byProject', 'nexus:artifact:get',
  'nexus:version:get', 'nexus:lineage:get', 'nexus:handoffs:list', 'nexus:handoff:get', 'nexus:activity:byProject'];
const NEXUS_PRELOAD_METHODS = ['nexusParticipationsList', 'nexusArtifactsList', 'nexusArtifactsByProject', 'nexusArtifactGet',
  'nexusVersionGet', 'nexusLineageGet', 'nexusHandoffsList', 'nexusHandoffGet', 'nexusActivityByProject'];
const literals = (text) => new Set((text.match(/['"`]nexus:[A-Za-z:]+['"`]/g) || []).map((x) => x.slice(1, -1)));
const sorted = (xs) => [...xs].sort();
const walkTs = (dir) => fs.readdirSync(path.join(__dirname, '..', dir), { recursive: true }).map(String).filter((x) => x.endsWith('.ts')).map((x) => path.join(dir, x));

test('nexus:* channels: one module, the exact list, the exact preload surface', () => {
  const idx = read('src/main/index.ts');
  const mod = read('src/main/nexusIpc/registerNexusIpc.ts');
  const preload = read('src/preload/index.ts');
  // index.ts registers no nexus:* handler inline and calls registerNexusIpc exactly once, with ipcMain.
  assert.equal(literals(idx).size, 0, 'no nexus: literal in index.ts');
  assert.equal((idx.match(/registerNexusIpc\(/g) || []).length, 1);
  assert.match(idx, /registerNexusIpc\(ipcMain, \{/);
  assert.match(idx, /unavailableReason: \(\) => nexusUnavailableReason/);
  assert.match(idx, /handoffsUnavailableReason: \(\) => handoffsUnavailableReason/);
  // The module's literals are NEXUS_CHANNELS, which is the literal list here.
  const { NEXUS_CHANNELS, registerNexusIpc } = loadTs('src/main/nexusIpc/registerNexusIpc.ts');
  assert.deepEqual([...NEXUS_CHANNELS], NEXUS_CHANNEL_LIST);
  assert.deepEqual(sorted(literals(mod)), sorted(NEXUS_CHANNEL_LIST));
  // The channels actually registered (a fake registrar) equal the preload's literals and the Task 6 list.
  const registered = [];
  registerNexusIpc({ handle: (c) => registered.push(c) }, { platform: () => null, unavailableReason: () => 'not_open',
    sources: { projectRoot: async () => null, readFile: async () => ({ error: 'not_found' }), resolveCommit: async () => ({ error: 'not_a_commit' }) },
    log: () => {} });
  assert.deepEqual(sorted(registered), sorted(NEXUS_REGISTERED));
  assert.deepEqual(sorted(literals(preload)), sorted(NEXUS_REGISTERED));
  for (const c of registered) assert.ok(NEXUS_CHANNEL_LIST.includes(c), c);
  // The exact preload methods, each invoking its own channel once.
  const methods = (preload.match(/^\s{2}(nexus[A-Z][A-Za-z]*):/gm) || []).map((x) => x.trim().slice(0, -1));
  assert.deepEqual(methods, NEXUS_PRELOAD_METHODS);
  assert.equal((preload.match(/ipcRenderer\.(invoke|send|sendSync|on)\(\s*['"`]nexus:/g) || []).length, NEXUS_REGISTERED.length);
  assert.match(preload, /^import type \{[^}]*NexusResult[^}]*\} from '\.\.\/shared\/nexus\/ipc';/m);
  // No nexus: literal anywhere else under src/main.
  for (const f of walkTs('src/main')) {
    if (f.split(path.sep).join('/') === 'src/main/nexusIpc/registerNexusIpc.ts') continue;
    assert.equal(literals(read(f)).size, 0, f);
  }
});

test('nexusIpc: every registration goes through the one wrapper; no identity from request arguments', () => {
  const mod = read('src/main/nexusIpc/registerNexusIpc.ts');
  // Exactly one registrar.handle call, and it wraps the channel's handler.
  assert.deepEqual(mod.match(/registrar\.handle\([^;]*;/g), ['registrar.handle(channel, handler(channel, parse, run));']);
  assert.equal((mod.match(/\bipcMain\b/g) || []).length, 0, 'the module takes a registrar, never ipcMain itself');
  // The principal is resolved once, in the wrapper, as the local user; no other resolver is used.
  assert.equal((mod.match(/principals\.localUser\(\)/g) || []).length, 1);
  assert.match(mod, /const me = nx\.principals\.localUser\(\);/);
  assert.doesNotMatch(mod, /principals\.(system|get)\(/);
  for (const f of walkTs('src/main/nexusIpc')) {
    const text = read(f);
    // No request field names a principal, an actor or a role ...
    assert.doesNotMatch(text, /['"`](principal|principalId|actor|actorId|actorKind|role|onBehalfOf|createdBy)['"`]/, f);
    assert.doesNotMatch(text, /\b(o|a|q|f|args?\[\d\])\.(principal|principalId|actor|actorId|role|onBehalfOf)\b/, f);
  }
  // ... and 'kind' is read from a request only as the artifact-kind filter of nexus:artifacts:list.
  assert.deepEqual(mod.match(/\bo\.kind\b[^\n]*/g), ["o.kind === undefined ? undefined : V.artifactKind(o.kind, 'kind'),"]);
  assert.equal((mod.match(/['"`]kind['"`]/g) || []).length, 2, "the 'kind' key of the artifacts filter and its field name");
  // The ban on transport inside the platform core keeps its meaning: the IPC layer lives in src/main/nexusIpc.
  for (const f of walkTs('src/main/nexus')) assert.doesNotMatch(read(f), /ipcMain|ipcRenderer|webContents/, f);
});
test('NEXUS_DB_HOLD_V7 is honoured by main', () => assert.match(read('src/main/index.ts'), /NEXUS_DB_HOLD_V7/));
test('NEXUS_DB_HOLD_V8 is honoured by main', () => {
  const idx = read('src/main/index.ts');
  assert.match(idx, /holdV8: process\.env\.NEXUS_DB_HOLD_V8 === '1'/);
  assert.match(idx, /handoffs: persist\.handoffsAvailable/);
  // Inside the one persist.open call, next to the v7 hold.
  const call = idx.slice(idx.indexOf('persist.open({'), idx.indexOf('});', idx.indexOf('persist.open({')));
  assert.match(call, /holdV7: process\.env\.NEXUS_DB_HOLD_V7 === '1'/); assert.match(call, /holdV8: process\.env\.NEXUS_DB_HOLD_V8 === '1'/);
});
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
