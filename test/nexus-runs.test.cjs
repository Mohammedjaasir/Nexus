'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');
const { leadAgentRun } = loadTs('src/renderer/src/nexus/runs/runModel.ts');
const req = { id: 'r1', text: 'Run the tests and fix failures', sentAt: 1 };
const states = (r) => Object.fromEntries(r.stages.map((s) => [s.id, s.state]));

test('queued request: context done, execute pending, the rest unreported', () => {
  const r = leadAgentRun({ request: req, queued: true, agentPresent: true, agentStatus: 'idle', blocked: false });
  assert.deepEqual(states(r), { context: 'done', plan: 'unreported', execute: 'pending', output: 'unreported', review: 'unreported' });
  assert.equal(r.headline, 'Queued for the lead agent');
});

test('delivered and working: execute active', () => {
  const r = leadAgentRun({ request: req, queued: false, agentPresent: true, agentStatus: 'working', blocked: false });
  assert.equal(states(r).execute, 'active');
  assert.equal(r.headline, 'The lead agent is working');
});

test('waiting for input in the terminal', () => {
  const r = leadAgentRun({ request: req, queued: false, agentPresent: true, agentStatus: 'waiting', blocked: true });
  assert.equal(states(r).execute, 'waiting');
  assert.equal(r.needsInput, true);
  assert.equal(r.headline, 'Waiting for you in its terminal');
});

test('delivered and idle: no claim that the work finished', () => {
  const r = leadAgentRun({ request: req, queued: false, agentPresent: true, agentStatus: 'idle', blocked: false });
  assert.equal(states(r).execute, 'unreported');
  assert.equal(r.headline, 'Delivered. See the lead agent’s terminal for the result');
});

test('agent offline: still queued, never working', () => {
  const r = leadAgentRun({ request: req, queued: true, agentPresent: false, agentStatus: null, blocked: false });
  assert.equal(r.agentOffline, true);
  assert.equal(states(r).execute, 'pending');
  assert.equal(r.headline, 'Queued. The lead agent is not running');
});

test('title is the request text, trimmed to 80 characters', () => {
  const r = leadAgentRun({ request: { ...req, text: 'x'.repeat(120) }, queued: true, agentPresent: true, agentStatus: 'idle', blocked: false });
  assert.equal(r.title.length, 80);
});

test('agent gone and message no longer queued: not tracked, not queued', () => {
  const r = leadAgentRun({ request: req, queued: false, agentPresent: false, agentStatus: null, blocked: false });
  assert.equal(states(r).execute, 'unreported');
  assert.equal(r.agentOffline, true);
  assert.equal(r.headline, 'Not tracked. The lead agent it was sent to is no longer running');
});

test('runsFor: queued vs delivered from the real queue; only the newest delivered request is live', () => {
  const { runsFor, isRunLive } = loadTs('src/renderer/src/nexus/runs/runModel.ts');
  const reqs = [
    { id: 'a', agentId: 'g', queuedMessageId: 'q1', text: 'old', sentAt: 1 },
    { id: 'b', agentId: 'g', queuedMessageId: 'q2', text: 'new', sentAt: 2 },
    { id: 'c', agentId: 'g', queuedMessageId: 'q3', text: 'waiting', sentAt: 3 }
  ];
  const agents = [{ id: 'g', status: 'working', running: true, blocked: false }];
  const [a, b, c] = runsFor(reqs, agents, { g: [{ id: 'q3' }] });
  assert.equal(states(c).execute, 'pending');
  assert.equal(states(b).execute, 'active');
  assert.equal(states(a).execute, 'unreported');
  assert.deepEqual([a, b, c].map(isRunLive), [false, true, true]);
  const [, blocked] = runsFor(reqs.slice(0, 2), [{ id: 'g', status: 'blocked', running: true, blocked: true }], {});
  assert.equal(blocked.needsInput, true);
});
