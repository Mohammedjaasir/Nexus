'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');
const { displayAgents, visibleAgents, leadAgentId, displayNameForId, displayDescription, folderName } = loadTs('src/shared/agentDisplay.ts');

const ROSTER = [
  { id: 'god', name: 'Michael', isGod: true, ptyId: 'pty-god', cwd: 'C:\\Users\\pc\\HarnessAgents', description: 'god — runs the floor, triages requests, escalates only critical calls to you' },
  { id: 'agent-god', name: 'MICHAEL', isGod: true, ptyId: null, description: 'running tests' },
  { id: 'agent-ryan', name: 'RYAN', ptyId: null, cwd: 'C:\\Users\\pc\\Downloads', description: 'reading SPEC.md' },
  { id: 'creed-mt866gth', name: 'Creed', ptyId: 'p3', cwd: 'C:\\Users\\pc\\Downloads', description: 'waiting on god' },
  { id: 'jim-1', name: 'Jim', ptyId: 'p4', cwd: 'C:\\Users\\pc\\Downloads\\' },
  { id: 'b1', name: 'Builder', ptyId: 'p5', cwd: '/home/u/api' }
];

test('the two dead legacy seeds are hidden; the lead is the god id', () => {
  assert.deepEqual(visibleAgents(ROSTER).map((a) => a.id), ['god', 'creed-mt866gth', 'jim-1', 'b1']);
  assert.equal(leadAgentId(ROSTER), 'god');
});

test('a seed id with a live pty or a registry entry is kept', () => {
  assert.equal(visibleAgents([{ id: 'agent-ryan', name: 'RYAN', ptyId: 'p9' }]).length, 1);
  assert.equal(visibleAgents([{ id: 'agent-ryan', name: 'RYAN' }], { registryIds: new Set(['agent-ryan']) }).length, 1);
});

test('old cast names render as Agent · folder, deduplicated; user names are kept', () => {
  const d = displayAgents(ROSTER);
  assert.equal(d.get('god').label, 'Lead agent');
  assert.equal(d.get('god').role, 'Coordinates the other agents');
  assert.equal(d.get('creed-mt866gth').label, 'Agent · Downloads');
  assert.equal(d.get('jim-1').label, 'Agent · Downloads (2)');
  assert.equal(d.get('b1').label, 'Builder');
  assert.equal(d.has('agent-god'), false);
  assert.equal(displayAgents([{ id: 'r', name: 'Ryan' }]).get('r').label, 'Agent');
});

test('a second isGod record is never the lead', () => {
  const agents = [{ id: 'x', name: 'A', isGod: true, ptyId: 'p' }, { id: 'god', name: 'Michael', isGod: true, ptyId: 'q' }];
  const d = displayAgents(agents);
  assert.equal(leadAgentId(agents), 'god');
  assert.equal(d.get('god').label, 'Lead agent');
  assert.equal(d.get('x').label, 'Lead agent (duplicate record)');
  assert.equal(d.get('x').isLead, false);
  assert.equal(leadAgentId([{ id: 'only', isGod: true }]), 'only');
  assert.equal(leadAgentId([{ id: 'a' }], { godId: 'zzz' }), null);
});

test('ids resolve to neutral names', () => {
  assert.equal(displayNameForId('god', ROSTER), 'Lead agent');
  assert.equal(displayNameForId('michael-voice', ROSTER), 'Voice');
  assert.equal(displayNameForId('human', ROSTER), 'You');
  assert.equal(displayNameForId('creed-mt866gth', ROSTER), 'Agent · Downloads');
  assert.equal(displayNameForId('unknown-7', ROSTER), 'unknown-7');
  assert.equal(displayNameForId(undefined, ROSTER), '');
});

test('descriptions never say god', () => {
  assert.equal(displayDescription(ROSTER[0], true), 'Coordinates the other agents');
  assert.equal(displayDescription(ROSTER[3], false), 'Waiting for the lead agent');
  assert.equal(displayDescription({ id: 'z', description: 'ask god for direction' }, false), 'ask the lead agent for direction');
});

test('folderName handles both separators and trailing slashes', () => {
  assert.equal(folderName('C:\\Users\\pc\\Downloads\\'), 'Downloads');
  assert.equal(folderName('/home/u/api'), 'api');
  assert.equal(folderName(undefined), '');
});
