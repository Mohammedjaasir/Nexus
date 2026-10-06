'use strict';
// B0a final review, finding 3: voice speaks the screen's labels, never stored
// names; ids stay ids in tool arguments.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');
const { voiceNamer, voiceRowsFromRegistry } = loadTs('src/renderer/src/realtime/voiceNames.ts');
const { displayAgents } = loadTs('src/shared/agentDisplay.ts');

const rows = [
  { id: 'god', name: 'Michael', isGod: true, cwd: 'C:\\h' },
  { id: 'w1', name: 'Dwight', cwd: 'C:\\repos\\api' },
  { id: 'w2', name: 'Builder', cwd: 'C:\\repos\\web' },
  { id: 'asst', name: 'Pam', isAssistant: true, cwd: 'C:\\h' },
  { id: 'old', name: 'Jim', cwd: 'C:\\repos\\old', archived: true }
];

test('voice uses the same labels as the screen', () => {
  const nameOf = voiceNamer(rows, 'god');
  const screen = displayAgents(rows, { godId: 'god', registryIds: new Set(rows.map((r) => r.id)) });
  for (const r of rows) assert.equal(nameOf(r.id), screen.get(r.id).label, r.id);
  assert.equal(nameOf('god'), 'Lead agent');
  assert.equal(nameOf('w1'), 'Agent · api');
  assert.equal(nameOf('w2'), 'Builder');
  assert.equal(nameOf('asst'), 'Assistant');
  assert.equal(nameOf('old'), 'Agent · old');
  // Ids outside the roster: system senders and unknown ids.
  assert.equal(nameOf('human'), 'You');
  assert.equal(nameOf('michael-voice'), 'Voice');
  assert.equal(nameOf('x-unknown'), 'x-unknown');
  assert.equal(nameOf(''), '');
});

test('registry rows convert for the namer', () => {
  const reg = { god: { name: 'Michael', isGod: true }, w1: { name: 'Dwight', cwd: 'C:\\r\\api', archived: true } };
  const nameOf = voiceNamer(voiceRowsFromRegistry(reg), 'god');
  assert.equal(nameOf('god'), 'Lead agent');
  assert.equal(nameOf('w1'), 'Agent · api');
  assert.deepEqual(voiceRowsFromRegistry(null), []);
});

test('voice tools speak labels, not stored names, and keep ids as arguments', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src/renderer/src/realtime/tools.ts'), 'utf8');
  // No stored name is spoken directly.
  assert.doesNotMatch(src, /\$\{e\.name\}/);
  assert.doesNotMatch(src, /str\(m\.name\) \|\|/);
  assert.doesNotMatch(src, /str\(a\.name\) \|\| str\(a\.id\)/);
  assert.doesNotMatch(src, /str\(o\.name\)/);
  assert.doesNotMatch(src, /\$\{str\(m\.from\)\}|\$\{str\(m\.from\) \|\|/);
  assert.ok((src.match(/voiceNamer\(/g) || []).length >= 8);
  // Tool arguments stay ids.
  assert.match(src, /agentId: \{ type: 'string'/);
  assert.match(src, /id: str\(a\.id\),\s*name: nameOf\(str\(a\.id\)\)/);
});
