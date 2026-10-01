'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');
const { parseHash, formatRoute, routeTitle } = loadTs('src/renderer/src/nexus/router/routes.ts');

test('parseHash: every route', () => {
  assert.deepEqual(parseHash(''), { name: 'home' });
  assert.deepEqual(parseHash('#'), { name: 'home' });
  assert.deepEqual(parseHash('#/'), { name: 'home' });
  assert.deepEqual(parseHash('#/workspaces'), { name: 'workspaces' });
  assert.deepEqual(parseHash('#/w/ml'), { name: 'workspace', id: 'ml' });
  assert.deepEqual(parseHash('#/projects'), { name: 'projects' });
  assert.deepEqual(parseHash('#/p/proj-1'), { name: 'project', id: 'proj-1' });
  assert.deepEqual(parseHash('#/artifacts'), { name: 'artifacts' });
  assert.deepEqual(parseHash('#/handoffs'), { name: 'handoffs' });
  assert.deepEqual(parseHash('#/deployments'), { name: 'deployments' });
  assert.deepEqual(parseHash('#/agents'), { name: 'agents' });
});

test('parseHash: tolerant of trailing slashes and missing leading slash', () => {
  assert.deepEqual(parseHash('#/projects/'), { name: 'projects' });
  assert.deepEqual(parseHash('#projects'), { name: 'projects' });
});

test('parseHash: bad input is not-found, never a throw', () => {
  assert.deepEqual(parseHash('#/w/unknown'), { name: 'not-found', path: '/w/unknown' });
  assert.deepEqual(parseHash('#/p/'), { name: 'not-found', path: '/p' });
  assert.deepEqual(parseHash('#/nope/x'), { name: 'not-found', path: '/nope/x' });
  assert.deepEqual(parseHash('#/p/%E0%A4%A'), { name: 'not-found', path: '/p/%E0%A4%A' }); // malformed escape
});

test('ids are URL-decoded and round-trip through formatRoute', () => {
  assert.deepEqual(parseHash('#/p/a%2Fb%20c'), { name: 'project', id: 'a/b c' });
  const routes = [
    { name: 'home' }, { name: 'workspaces' }, { name: 'workspace', id: 'uiux' }, { name: 'projects' },
    { name: 'project', id: 'a/b c' }, { name: 'artifacts' }, { name: 'handoffs' }, { name: 'deployments' }, { name: 'agents' }
  ];
  for (const r of routes) assert.deepEqual(parseHash(formatRoute(r)), r);
  assert.equal(formatRoute({ name: 'home' }), '#/');
});

test('routeTitle gives a human page label', () => {
  assert.equal(routeTitle({ name: 'home' }), 'Home');
  assert.equal(routeTitle({ name: 'workspace', id: 'ml' }), 'ML workspace');
  assert.equal(routeTitle({ name: 'agents' }), 'Agents');
});
