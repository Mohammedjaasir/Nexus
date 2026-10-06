'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');
const { agentDisplayName, notificationTitle } = loadTs('src/main/displayNames.ts');
const reg = { godId: null, agents: { god: { name: 'Michael', isGod: true }, 'creed-1': { name: 'Creed', cwd: 'C:/x/Downloads' }, b: { name: 'Builder' } } };
const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

test('notification titles never show the god id or a persona', () => {
  assert.equal(notificationTitle('god', reg), 'Lead agent');
  assert.equal(notificationTitle('creed-1', reg), 'Agent · Downloads');
  assert.equal(notificationTitle('b', reg), 'Builder');
  assert.equal(notificationTitle(undefined, reg), 'Agent');
  assert.equal(agentDisplayName('god', { godId: 'lead-7', agents: { 'lead-7': { name: 'Michael', isGod: true } } }), 'Lead agent');
});

test('menu, dialogs and inbox texts use neutral words', () => {
  const idx = read('src/main/index.ts');
  for (const banned of ["'New Floor'", "'Nexus — Floor'", "'Close floor'", 'Close this floor?', 'Other floors keep running.',
    "'Import a hire manifest'", "'Hire manifest'", 'ask god for direction', 'send it to god for sign-off', 'hive disabled (no harnessHome)'])
    assert.ok(!idx.includes(banned), banned);
  assert.ok(!read('src/main/closingTime.ts').includes('the god agent'));
  assert.ok(!read('src/main/realtimeActions.ts').includes('Voice ping from Michael'));
  assert.ok(!read('src/main/realtimeActions.ts').includes('Michael (voice orchestrator'));
  assert.ok(!read('src/main/hive.ts').includes('The god agent is the scribe'));
  assert.ok(!read('src/main/webhook.ts').includes('before the hive sees it'));
  assert.ok(!read('src/main/realtimeFloorWatcher.ts').includes('joined the floor'));
  assert.match(read('src/main/hooks.ts'), /notificationTitle\(/);
});

test('round 1: spoken, breaker, control and heartbeat copy stay neutral', () => {
  const bans = [
    ['src/main/realtimeActions.ts', 'god orchestrator is voice-forbidden'],
    ['src/main/realtimeActions.ts', 'The hive is not configured'],
    ['src/main/breaker.ts', 'floor total'],
    ['src/main/control.ts', 'resume from the floor'],
    ['src/main/hooks.ts', 'Halted by the operator from the floor'],
    ['src/main/config.ts', 'Floor heartbeat'],
    ['src/main/index.ts', 'Floor heartbeat'],
    ['src/main/closingTime.ts', 'the floor is just you'],
    ['src/main/closingTime.ts', 'no workers on the floor']
  ];
  for (const [f, s] of bans) assert.ok(!read(f).includes(s), `${f}: ${s}`);
});

test('agent-facing protocol strings in main carry no persona names (B0a final review, finding 5)', () => {
  // Only string content counts: comment lines are dropped first.
  const PERSONA = /\b(Michael|Dwight|Jim|Pam|Ryan|Creed|Oscar|Kevin|Angela|Stanley|Andy|Toby|Meredith|Phyllis|Kelly)\b/;
  const files = ['index.ts', 'hive.ts', 'realtimeActions.ts', 'realtimeFloorWatcher.ts', 'realtimeCompletionWatcher.ts', 'slack.ts', 'webhook.ts', 'closingTime.ts'];
  for (const f of files) {
    const code = read(`src/main/${f}`).split(/\r?\n/).filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).map((l) => l.replace(/\s\/\/ .*$/, ''));
    for (const l of code) assert.doesNotMatch(l, PERSONA, `${f}: ${l.slice(0, 120)}`);
  }
  const idx = read('src/main/index.ts');
  assert.match(idx, /5\. REPORT TO THE LEAD — the agent then tells you \(the lead agent, inbox address "god"\) what it did\./);
  const hive = read('src/main/hive.ts');
  assert.match(hive, /You are the lead agent\\'s PREP ASSISTANT\./);
  assert.match(hive, /with "to":"god", "act":"request"/);
});
