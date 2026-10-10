'use strict';
// B2a Task 16: docs/nexus/platform-core.md Part III names the v9 objects exactly as the code does. The name list in
// section 32.6 equals V9_EXPECTED (same names, same order), the DDL block in section 32.2 equals V9_DDL, and the trigger
// and index tables of sections 32.3 and 32.4 name every v9 trigger and index and nothing else with a v9-style name.
// Plain node: schemaV9.ts loads through load-ts without opening a database.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const ROOT = path.resolve(__dirname, '..');
const DOC = fs.readFileSync(path.join(ROOT, 'docs/nexus/platform-core.md'), 'utf8').replace(/\r\n/g, '\n');
const { V9_EXPECTED, V9_DDL } = loadTs('src/main/nexus/db/schemaV9.ts');

/** The text from the heading line that starts with `start` up to the next heading line that starts with `end`. */
function between(start, end) {
  const lines = DOC.split('\n');
  const from = lines.findIndex((l) => l.startsWith(start));
  assert.ok(from >= 0, `heading "${start}" not found`);
  const rel = lines.slice(from + 1).findIndex((l) => l.startsWith(end));
  assert.ok(rel >= 0, `heading "${end}" not found after "${start}"`);
  return lines.slice(from + 1, from + 1 + rel).join('\n');
}
/** The body of the first fenced block of `lang` in `text`. */
function fenced(text, lang) {
  const m = new RegExp('```' + lang + '\\n([\\s\\S]*?)\\n```').exec(text);
  assert.ok(m, `no \`\`\`${lang} block`);
  return m[1];
}
const listOf = (block, key) => {
  const line = block.split('\n').find((l) => l.startsWith(`${key}: `));
  assert.ok(line, `no "${key}:" line in the name list`);
  return line.slice(key.length + 2).split(',').map((s) => s.trim()).filter(Boolean);
};

test('Part III exists and section 32.6 lists exactly V9_EXPECTED, in order', () => {
  assert.ok(DOC.includes('\n# Part III: Schema v9 and B2a\n'));
  const block = fenced(between('### 32.6 ', '## 33. '), 'text');
  assert.deepEqual(listOf(block, 'tables'), Object.keys(V9_EXPECTED.tables));
  assert.deepEqual(listOf(block, 'indexes'), V9_EXPECTED.indexes);
  assert.deepEqual(listOf(block, 'triggers'), V9_EXPECTED.triggers);
  assert.equal(Object.keys(V9_EXPECTED.tables).length, 15);
  assert.equal(V9_EXPECTED.indexes.length, 23);
  assert.equal(V9_EXPECTED.triggers.length, 33);
});

test('section 32.2 holds V9_DDL verbatim', () => {
  const sql = fenced(between('### 32.2 ', '### 32.3 '), 'sql');
  assert.equal(sql, V9_DDL.replace(/^\n/, '').replace(/\n$/, ''));
});

test('sections 32.3 and 32.4 name every v9 trigger and index, and no other ix_, ux_ or tr_ name', () => {
  const triggers = between('### 32.3 ', '### 32.4 ');
  const indexes = between('### 32.4 ', '### 32.5 ');
  const named = (text, re) => [...new Set([...text.matchAll(re)].map((m) => m[1]))];
  const trNames = named(triggers, /`(tr_[a-z0-9_]+)`/g);
  const ixNames = named(indexes, /`((?:ix|ux)_[a-z0-9_]+)`/g);
  assert.deepEqual([...trNames].sort(), [...V9_EXPECTED.triggers].sort());
  assert.deepEqual([...ixNames].sort(), [...V9_EXPECTED.indexes].sort());
  // A v7 or v8 name in these two sections would be a copy error: every ix_/ux_/tr_ name there is a v9 one.
  for (const n of named(triggers + indexes, /`((?:ix|ux|tr)_[a-z0-9_]+)`/g)) {
    assert.ok(V9_EXPECTED.indexes.includes(n) || V9_EXPECTED.triggers.includes(n), `${n} is not a v9 name`);
  }
});

test('section 32.1 names every v9 table', () => {
  const tables = between('### 32.1 ', '### 32.2 ');
  for (const t of Object.keys(V9_EXPECTED.tables)) assert.ok(tables.includes(`\`${t}\``), `${t} missing from section 32.1`);
});
