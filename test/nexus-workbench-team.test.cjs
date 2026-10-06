'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');
const t = loadTs('src/renderer/src/nexus/agents/workbench/teamModel.ts');
const m = loadTs('src/renderer/src/nexus/agents/workbench/workbenchModel.ts');
const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

test('token formatting is unchanged from the legacy roster', () => {
  assert.equal(t.fmtTokens(999), '999');
  assert.equal(t.fmtTokens(1234), '1.2K');
  assert.equal(t.fmtTokens(1_500_000), '1.5M');
  assert.equal(t.fmtTokens(2_340_000_000), '2.34B');
});

test('token meter: agent limit, then total budget, then the default', () => {
  assert.deepEqual(t.tokenMeter(250_000, { agentCap: 500_000 }), { fraction: 0.5, capLabel: 'of 500K (agent limit)' });
  assert.deepEqual(t.tokenMeter(250_000, { totalCap: 1_000_000 }), { fraction: 0.25, capLabel: 'of 1M (total budget)' });
  assert.deepEqual(t.tokenMeter(3_000_000, {}), { fraction: 1, capLabel: 'of 1M (default; set a total token budget in Settings)' });
});

test('activity lines use display names, never raw ids or stored personas', () => {
  const name = (id) => ({ god: 'Lead agent', b1: 'Builder' }[id] ?? id);
  assert.equal(t.activityLine({ kind: 'spawn', agentId: 'god', name: 'Michael' }, name), 'Started Lead agent');
  assert.equal(t.activityLine({ kind: 'message', from: 'god', to: 'b1', subject: 'Fix login' }, name), 'Lead agent → Builder: Fix login');
  assert.equal(t.activityLine({ kind: 'drain', agentId: 'b1', count: 2 }, name), 'Builder read 2 messages');
  assert.equal(t.activityLine({ kind: 'escalate', subject: 'Need a key' }, name), 'Asked you: Need a key');
  assert.equal(t.activityLine({ kind: 'approval', approve: false }, name), 'Approval denied');
  assert.equal(t.activityLine({ kind: 'weird', secret: 'x' }, name), 'weird event');
});

test('requests go to the lead agent with an optional suggestion', () => {
  assert.equal(t.requestBody('  Fix CI  '), 'Fix CI');
  assert.equal(t.requestBody('Fix CI', { id: 'b1', label: 'Builder' }), 'Fix CI\n\n(The human suggests Builder (b1) for this — your call as the lead agent.)');
});

test('task columns', () => {
  const c = t.columnsFor([{ status: 'todo' }, { status: 'doing' }, { status: 'done' }, { status: 'blocked' }, { status: 'odd' }]);
  assert.deepEqual(Object.fromEntries(Object.entries(c).map(([k, v]) => [k, v.length])), { todo: 2, doing: 1, blocked: 1, done: 1 });
});

test('the lead now has Requests; "floor" requests open it', () => {
  assert.equal(m.sectionForRequest('floor'), 'requests');
  assert.ok(m.sectionsFor({ isLead: true, showHistory: false }).some((s) => s.id === 'requests'));
});

test('restartWithModel kept its resume, kill-tolerance and terminal-generation logic', () => {
  const src = read('src/renderer/src/nexus/agents/workbench/useRestartAgent.ts');
  for (const re of [/inferAgentProvider\(a\.command, a\.provider\)/, /registry\.agents\[a\.id\]\?\.sessionId/, /resolveSessionCwd\(/,
    /\/\^no pty:\/\.test/, /disposeTerminal\(a\.ptyId\);\s*acquireTerminal\(a\.ptyId\);/, /terminalGeneration: \(a\.terminalGeneration \?\? 0\) \+ 1/,
    /resetTerminal\(a\.ptyId\)/, /tokenizeCommand\(command\.trim\(\)\)/, /requireResume: resume/])
    assert.match(src, re);
});

test('the Command Center and its temporary host are gone', () => {
  for (const f of ['src/renderer/src/components/CommandCenterPanel.tsx', 'src/renderer/src/components/AskMeTab.tsx',
    'src/renderer/src/nexus/agents/workbench/LegacyLeadSections.tsx', 'src/renderer/src/components/SidebarTabs.tsx'])
    assert.ok(!fs.existsSync(path.join(__dirname, '..', f)), f);
});

test('operator controls sit in the frame, above the sections, for every live agent', () => {
  const frame = read('src/renderer/src/nexus/agents/workbench/AgentWorkbench.tsx');
  assert.match(frame, /<AgentControlStrip/);
  assert.ok(frame.indexOf('<AgentControlStrip') > frame.indexOf('<WorkbenchHeader'));
  assert.ok(frame.indexOf('<AgentControlStrip') < frame.indexOf('role="tablist"'));
  assert.doesNotMatch(read('src/renderer/src/nexus/agents/workbench/WorkbenchTerminal.tsx'), /AgentControlStrip/);
});

test('requests and setup land on the lead agent', () => {
  const helper = read('src/renderer/src/nexus/agents/workbench/openLeadSection.ts');
  assert.ok(helper.indexOf('select(') < helper.indexOf('requestCommandCenterTab('), 'select clears tab requests, so it goes first');
  assert.match(read('src/renderer/src/components/SetupPanel.tsx'), /openLeadSection\('requests'/);
  assert.match(read('src/renderer/src/components/TaskDetailOverlay.tsx'), /openLeadSection\('requests'/);
  assert.match(read('src/renderer/src/nexus/agents/workbench/RequestsSection.tsx'), /to: 'god', act: 'request'/);
});
