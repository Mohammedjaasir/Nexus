'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const { detectEnvironment, IDEAS, buildStartRequest, START_STEPS } = loadTs('src/renderer/src/nexus/start/startModel.ts');
const { parseHash, formatRoute } = loadTs('src/renderer/src/nexus/router/routes.ts');
const { WORKSPACES } = loadTs('src/renderer/src/nexus/workspaces/registry.ts');

const id = (text) => detectEnvironment(text).id;

test('detect: common requests land in the right environment', () => {
  assert.equal(id('build a web app for invoices'), 'sde');
  assert.equal(id('Create a REST API'), 'sde');
  assert.equal(id('train a model to classify emails'), 'ml');
  assert.equal(id('fine-tune a CNN on my images'), 'dl');
  assert.equal(id('analyze sales data and build a dashboard'), 'data');
  assert.equal(id('write a literature review paper'), 'research');
  assert.equal(id('write end-to-end tests for checkout'), 'qa');
  assert.equal(id('design a landing page prototype'), 'uiux');
  assert.equal(id('deploy to kubernetes with a CI pipeline'), 'devops');
});

test('detect: reports confidence and the words that matched', () => {
  const d = detectEnvironment('train a model on the latest dataset');
  assert.equal(d.id, 'ml');
  assert.equal(d.confidence, 'strong');
  assert.ok(d.matched.includes('model') && d.matched.includes('dataset'));
  const weak = detectEnvironment('make something with a model');
  assert.equal(weak.confidence, 'weak');
});

test('detect: nothing recognisable returns none, never a guess', () => {
  assert.deepEqual(detectEnvironment('hello there'), { id: null, confidence: 'none', matched: [] });
  assert.deepEqual(detectEnvironment('   '), { id: null, confidence: 'none', matched: [] });
});

test('detect: only ever returns a workspace that exists', () => {
  for (const s of ['web app', 'model', 'dashboard', 'pipeline', 'prototype', 'tests', 'paper', 'neural network']) {
    const r = detectEnvironment(s);
    assert.ok(r.id === null || WORKSPACES.some((w) => w.id === r.id), `${s} → ${r.id}`);
  }
});

test('ideas: each chip fills a request that detects to its own environment', () => {
  assert.ok(IDEAS.length >= 5);
  for (const idea of IDEAS) assert.equal(id(idea.prompt), idea.expect, idea.label);
});

test('request: the context header names environment and project; the text is unchanged', () => {
  const r = buildStartRequest({ text: '  build a web app  ', workspaceLabel: 'SDE', project: { name: 'shop', rootPath: 'C:\\code\\shop' } });
  assert.equal(r.text, 'build a web app');
  assert.match(r.contextHeader, /workspace SDE/);
  assert.match(r.contextHeader, /project shop \(C:\\code\\shop\)/);
  assert.match(r.contextHeader, /page Start/);
});

test('steps: three steps in order', () => {
  assert.deepEqual(START_STEPS.map((s) => s.id), ['describe', 'confirm', 'start']);
});

test('routes: #/browse is the environment picker and round-trips', () => {
  assert.deepEqual(parseHash('#/browse'), { name: 'browse' });
  assert.equal(formatRoute({ name: 'browse' }), '#/browse');
  assert.deepEqual(parseHash('#/'), { name: 'home' });
});
