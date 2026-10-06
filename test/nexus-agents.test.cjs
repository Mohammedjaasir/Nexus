// test/nexus-agents.test.cjs
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');
const { agentRows } = loadTs('src/renderer/src/nexus/agents/agentList.ts');

test('the lead agent is titled by role, first, never by persona name', () => {
  const rows = agentRows([{ id: 'w', name: 'Ryan', status: 'idle', provider: 'codex', ptyId: 'p2' }, { id: 'g', name: 'Michael', isGod: true, status: 'working', provider: 'claude', ptyId: 'p1' }], { g: [{}, {}] });
  assert.equal(rows[0].id, 'g');
  assert.equal(rows[0].title, 'Lead agent');
  assert.equal(rows[0].queued, 2);
  assert.ok(!rows.some((r) => r.title === 'Michael'));
});

test('archived agents are excluded; a missing pty means no terminal', () => {
  const rows = agentRows([{ id: 'a', name: 'Builder', status: 'idle', archived: true }, { id: 'b', name: 'Builder 2', status: 'idle', ptyId: null }], {});
  assert.deepEqual(rows.map((r) => [r.id, r.hasTerminal]), [['b', false]]);
});

test('agent rows use the display model: seeds hidden, duplicate lead labelled', () => {
  const rows = agentRows([
    { id: 'god', name: 'Michael', isGod: true, status: 'idle', ptyId: 'p1' },
    { id: 'agent-god', name: 'MICHAEL', isGod: true, status: 'idle', ptyId: null },
    { id: 'c', name: 'Creed', status: 'idle', ptyId: 'p2', cwd: 'C:\\x\\Downloads' }
  ], {});
  assert.deepEqual(rows.map((r) => r.title), ['Lead agent', 'Agent · Downloads']);
});
