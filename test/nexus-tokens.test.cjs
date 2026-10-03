'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

test('fonts: index.html does not load fonts from the network', () => {
  const html = read('src/renderer/index.html');
  assert.ok(!/fonts\.googleapis\.com/.test(html), 'no Google Fonts stylesheet or CSP entry');
  assert.ok(!/fonts\.gstatic\.com/.test(html), 'no gstatic CSP entry');
});

test('fonts: main.tsx imports every Nexus family', () => {
  const main = read('src/renderer/src/main.tsx');
  for (const pkg of ['@fontsource-variable/bricolage-grotesque', '@fontsource-variable/instrument-sans', '@fontsource/martian-mono', '@fontsource/jetbrains-mono']) {
    assert.ok(main.includes(pkg), `main.tsx imports ${pkg}`);
  }
});

test('fonts: legacy UI font is Instrument Sans, not Inter', () => {
  const css = read('src/renderer/src/design/tokens.css');
  assert.match(css, /--cth-font-ui:\s*"Instrument Sans Variable"/);
  assert.ok(!/"Inter"/.test(css));
});
