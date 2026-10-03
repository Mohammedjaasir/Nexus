'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');
const { workspaceTabs } = loadTs('src/renderer/src/nexus/workspaces/mapping.ts');
const { getWorkspace } = loadTs('src/renderer/src/nexus/workspaces/registry.ts');

test('projects is the only available tab; vocabulary tabs are planned', () => {
  const tabs = workspaceTabs(getWorkspace('ml'));
  assert.deepEqual(tabs[0], { id: 'projects', label: 'Projects', available: true });
  assert.ok(tabs.slice(1).every((t) => t.available === false));
  assert.deepEqual(tabs.slice(1).map((t) => t.label), getWorkspace('ml').plannedModules);
});
