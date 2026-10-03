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

const { oklchToSrgb, contrast } = require('./helpers/color.cjs');

function tokens(css, selector) {
  const block = css.split(selector + ' {')[1].split('}')[0];
  const out = {};
  for (const m of block.matchAll(/--(nx-[a-z0-9-]+):\s*oklch\(([\d.]+) ([\d.]+) ([\d.]+)\)/g)) out[m[1]] = [Number(m[2]), Number(m[3]), Number(m[4])];
  return out;
}

test('tokens: text pairs meet WCAG AA in both themes', () => {
  const css = read('src/renderer/src/nexus/styles/tokens.css');
  for (const sel of [':root', ':root[data-cth-theme="dark"]']) {
    const t = tokens(css, sel);
    const pairs = [['nx-ink', 'nx-ground', 4.5], ['nx-text-2', 'nx-surface', 4.5], ['nx-text-3', 'nx-ground', 4.5], ['nx-text-3', 'nx-sunken', 4.5],
      ['nx-on-ink', 'nx-ink', 4.5], ['nx-ok', 'nx-surface', 4.5], ['nx-warn', 'nx-surface', 4.5], ['nx-bad', 'nx-surface', 4.5], ['nx-line-strong', 'nx-surface', 3]];
    for (const [fg, bg, min] of pairs) {
      const r = contrast(oklchToSrgb(...t[fg]), oklchToSrgb(...t[bg]));
      assert.ok(r >= min, `${sel} ${fg} on ${bg}: ${r.toFixed(2)} < ${min}`);
    }
  }
});

test('tokens: no gradient identity token', () => {
  assert.ok(!/--nx-gradient/.test(read('src/renderer/src/nexus/styles/tokens.css')));
});

test('tokens: nexus tokens do not mention Inter', () => {
  assert.ok(!/\bInter\b/.test(read('src/renderer/src/nexus/styles/tokens.css')));
});
