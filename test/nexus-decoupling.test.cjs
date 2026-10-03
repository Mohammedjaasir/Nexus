// test/nexus-decoupling.test.cjs
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const dir = path.resolve(__dirname, '..', 'src/renderer/src/nexus');

function files(d) { return fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? files(path.join(d, e.name)) : [path.join(d, e.name)]); }
const src = files(dir).filter((f) => /\.(tsx?|css)$/.test(f)).map((f) => [path.relative(dir, f), fs.readFileSync(f, 'utf8')]);

test('nexus never imports the office scene or pixel components', () => {
  const banned = /scene\/office|components\/Pixel|\bPixel(Panel|Button|Badge)\b|OfficeCharacterName|OFFICE_CAST|SpritePortrait|AgentStrip|AgentCard|MichaelBooting|RealtimeMichael|OfficeThemePicker|themeRegistry/;
  for (const [f, s] of src) assert.ok(!banned.test(s), `${f} imports a retired legacy visual`);
});

test('nexus copy has no personas or old product identity', () => {
  // Legacy identity only. Ordinary punctuation (including dashes) is allowed.
  const banned = /\b(Michael|Dwight|Jim|Pam|Ryan|Creed|Oscar|Kevin|Angela|Stanley)\b|Munder|Dunder|\bBOSS\b|pixel[- ]office/i;
  for (const [f, s] of src) assert.ok(!banned.test(s), `${f} contains banned copy`);
});

const HORIZONTAL_GRADIENT = /(?<!repeating-)linear-gradient\(\s*90deg/;

test('no Inter or gradient identity in nexus styles', () => {
  for (const [f, s] of src.filter(([f]) => f.endsWith('.css'))) {
    assert.ok(!/"Inter"/.test(s), `${f} references Inter`);
    // Repeating gradients are textures (hatching) and are allowed; only plain horizontal gradients are identity.
    assert.ok(!HORIZONTAL_GRADIENT.test(s), `${f} has a horizontal gradient`);
  }
});

test('horizontal-gradient rule flags plain gradients but allows repeating textures', () => {
  assert.ok(HORIZONTAL_GRADIENT.test('background: linear-gradient(90deg, red, blue)'));
  assert.ok(!HORIZONTAL_GRADIENT.test('background: repeating-linear-gradient(90deg, red 0 3px, transparent 3px 6px)'));
});
