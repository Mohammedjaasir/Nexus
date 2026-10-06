// test/nexus-window-policy.test.cjs
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');
const p = loadTs('src/main/windowPolicy.ts');

test('permissions are denied unless listed (O.9 #2)', () => {
  for (const perm of ['geolocation', 'notifications', 'midi', 'midiSysex', 'pointerLock', 'fullscreen', 'openExternal', 'clipboard-read', 'display-capture', 'hid', 'serial', 'usb', 'unknown'])
    assert.equal(p.decidePermission({ permission: perm, micLive: true }), false, perm);
  assert.equal(p.decidePermission({ permission: 'clipboard-sanitized-write', micLive: false }), true);
  assert.equal(p.decidePermission({ permission: 'media', mediaTypes: ['audio'], micLive: true }), true);
  assert.equal(p.decidePermission({ permission: 'media', micLive: true }), true);
  assert.equal(p.decidePermission({ permission: 'media', mediaTypes: ['audio'], micLive: false }), false);
  assert.equal(p.decidePermission({ permission: 'media', mediaTypes: ['video'], micLive: true }), false);
  assert.equal(p.decidePermission({ permission: 'media', mediaTypes: ['audio', 'video'], micLive: true }), false);
  assert.equal(p.decidePermissionCheck('media', true), true);
  assert.equal(p.decidePermissionCheck('media', false), false);
  assert.equal(p.decidePermissionCheck('clipboard-sanitized-write', false), true);
  assert.equal(p.decidePermissionCheck('geolocation', true), false);
});

test('external URLs: https and macOS settings only (O.9 #3)', () => {
  assert.equal(p.isAllowedExternalUrl('https://github.com/x'), true);
  assert.equal(p.isAllowedExternalUrl('x-apple.systempreferences:com.apple.preference.security'), true);
  for (const u of ['http://example.com', 'file:///C:/Windows/System32/calc.exe', 'javascript:alert(1)', 'ms-settings:privacy', 'smb://host/share', 'ftp://x', '\\\\host\\share', ''])
    assert.equal(p.isAllowedExternalUrl(u), false, u);
});

test('in-app navigation only to the app itself (O.9 #3)', () => {
  assert.equal(p.isInAppNavigation('http://localhost:5173/#/agents', 'http://localhost:5173/'), true);
  assert.equal(p.isInAppNavigation('file:///C:/app/out/renderer/index.html#/p/1', 'file:///C:/app/out/renderer/index.html'), true);
  assert.equal(p.isInAppNavigation('file:///C:/Windows/win.ini', 'file:///C:/app/out/renderer/index.html'), false);
  assert.equal(p.isInAppNavigation('javascript:alert(1)', 'http://localhost:5173/'), false);
  assert.equal(p.isInAppNavigation('https://evil.example/', 'http://localhost:5173/'), false);
  assert.equal(p.isInAppNavigation('http://localhost:5174/', 'http://localhost:5173/'), false);
});

test('the window is sandboxed and the preload has no runtime import besides electron (O.9 #1)', () => {
  const idx = fs.readFileSync(path.join(__dirname, '..', 'src/main/index.ts'), 'utf8');
  assert.match(idx, /sandbox:\s*true/);
  assert.doesNotMatch(idx, /sandbox:\s*false/);
  assert.match(idx, /'will-navigate'/);
  const pre = fs.readFileSync(path.join(__dirname, '..', 'src/preload/index.ts'), 'utf8');
  const runtime = [...pre.matchAll(/^import\s+(?!type\b)[^'"]*from\s+'([^']+)'/gm)].map((m) => m[1]);
  assert.deepEqual([...new Set(runtime)], ['electron']);
  assert.doesNotMatch(pre, /\brequire\(/);
});

test('permission edge cases: empty media list, unknown and clipboard-read checks', () => {
  assert.equal(p.decidePermission({ permission: 'media', mediaTypes: [], micLive: true }), true);
  assert.equal(p.decidePermission({ permission: 'media', mediaTypes: [], micLive: false }), false);
  assert.equal(p.decidePermissionCheck('clipboard-read', true), false);
  assert.equal(p.decidePermissionCheck('notifications', true), false);
});

test('in-app navigation: file: URLs ignore query, drive-letter case and encoding; other files and hosts refused', () => {
  const app = 'file:///C:/Program%20Files/Nexus/resources/app.asar/out/renderer/index.html';
  assert.equal(p.isInAppNavigation('file:///c:/Program Files/Nexus/resources/app.asar/out/renderer/index.html?x=1#/a', app), true);
  assert.equal(p.isInAppNavigation('file:///C:/Program%20Files/Nexus/resources/app.asar/out/renderer/other.html', app), false);
  assert.equal(p.isInAppNavigation('file://evilhost/C:/Program%20Files/Nexus/resources/app.asar/out/renderer/index.html', app), false);
  assert.equal(p.isInAppNavigation('http://localhost:5173/', app), false);
  assert.equal(p.isInAppNavigation('file:///C:/app/out/renderer/index.html', 'http://localhost:5173/'), false);
  assert.equal(p.isInAppNavigation('not a url', 'http://localhost:5173/'), false);
  assert.equal(p.isInAppNavigation('http://localhost:5173/x', 'garbage'), false);
});

test('index.ts routes window.open and app:openExternal through the shared allow-list', () => {
  const idx = fs.readFileSync(path.join(__dirname, '..', 'src/main/index.ts'), 'utf8');
  assert.match(idx, /setWindowOpenHandler\(\(\{ url \}\) => \{\s*if \(isAllowedExternalUrl\(url\)\)/);
  assert.match(idx, /'app:openExternal'[\s\S]{0,200}isAllowedExternalUrl\(url\)/);
  assert.match(idx, /isInAppNavigation\(url, currentAppUrl\(\)\)/);
  assert.match(idx, /decidePermission\(\{ permission, mediaTypes, micLive: micFeatureLive\(\) \}\)/);
  assert.doesNotMatch(idx, /callback\(true\)/);
});

test('fix round 1: http only to loopback, no userinfo, https kept (O.9 #3)', () => {
  for (const u of ['http://localhost:3000', 'http://127.0.0.1:5173/x', 'http://[::1]:8080', 'https://github.com/x', 'x-apple.systempreferences:com.apple.preference.security'])
    assert.equal(p.isAllowedExternalUrl(u), true, u);
  for (const u of ['http://example.com', 'http://localhost@evil.com', 'http://localhost.evil.com', 'file:///C:/x', 'javascript:alert(1)',
    'https://user:pw@github.com/', 'https://user@github.com/', 'http://user@localhost:3000', 'http://127.0.0.2/', 'http://0.0.0.0/', 'ws://localhost/', 'https:github.com'])
    assert.equal(p.isAllowedExternalUrl(u), false, u);
});

test('fix round 1: speaker-selection and media check details follow the mic gate (O.9 #2)', () => {
  assert.equal(p.decidePermission({ permission: 'speaker-selection', micLive: true }), true);
  assert.equal(p.decidePermission({ permission: 'speaker-selection', micLive: false }), false);
  assert.equal(p.decidePermissionCheck('speaker-selection', true), true);
  assert.equal(p.decidePermissionCheck('speaker-selection', false), false);
  assert.equal(p.decidePermissionCheck('media', true, 'audio'), true);
  assert.equal(p.decidePermissionCheck('media', true, 'unknown'), true);
  assert.equal(p.decidePermissionCheck('media', true, 'video'), false);
  assert.equal(p.decidePermissionCheck('media', false, 'audio'), false);
});

test('fix round 1: redirects use the navigation guard; check handler passes mediaType; fs roots are cached', () => {
  const idx = fs.readFileSync(path.join(__dirname, '..', 'src/main/index.ts'), 'utf8');
  assert.match(idx, /'will-navigate', \(e, url\) => guardNavigation\(e, url\)/);
  assert.match(idx, /'will-redirect', \(e, url\) => guardNavigation\(e, url\)/);
  assert.match(idx, /decidePermissionCheck\(permission, micFeatureLive\(\), details\?\.mediaType\)/);
  assert.match(idx, /const FS_ROOT_TTL_MS = 5000;/);
  assert.match(idx, /realAllowedRoots\(allowedFsRoots\(\)\)/);
});
