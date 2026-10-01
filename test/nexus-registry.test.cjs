'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const { WORKSPACES, LAUNCHER_SHORTCUTS, UNMAPPED_DOMAINS, getWorkspace, WORKSPACE_IDS } =
  loadTs('src/renderer/src/nexus/workspaces/registry.ts');
const { workspaceForDomain, projectsForWorkspace, countsByWorkspace } =
  loadTs('src/renderer/src/nexus/workspaces/mapping.ts');
const { NEXUS_ICON_NAMES, HUES } = loadTs('src/renderer/src/nexus/iconNames.ts');
const { listDomainDefinitions } = loadTs('src/shared/domain.ts');

const ALL_DOMAINS = listDomainDefinitions().map((d) => d.id);

test('registry: phase A workspaces, in order, with unique ids', () => {
  assert.deepEqual(WORKSPACES.map((w) => w.id), ['sde', 'ml', 'dl', 'data', 'research', 'qa', 'uiux', 'devops']);
  assert.equal(new Set(WORKSPACES.map((w) => w.id)).size, WORKSPACES.length);
  assert.deepEqual([...WORKSPACE_IDS].sort(), WORKSPACES.map((w) => w.id).sort());
});

test('registry: every DomainId is mapped to exactly one workspace or explicitly unmapped', () => {
  for (const d of ALL_DOMAINS) {
    const owners = WORKSPACES.filter((w) => w.domainIds.includes(d));
    const unmapped = UNMAPPED_DOMAINS.includes(d);
    assert.ok(owners.length + (unmapped ? 1 : 0) === 1, `${d}: owners=${owners.map((w) => w.id)} unmapped=${unmapped}`);
  }
  for (const w of WORKSPACES) for (const d of w.domainIds) assert.ok(ALL_DOMAINS.includes(d), `${w.id} lists unknown domain ${d}`);
});

test('registry: defaultDomainId is one of the workspace domains', () => {
  for (const w of WORKSPACES) if (w.defaultDomainId) assert.ok(w.domainIds.includes(w.defaultDomainId), w.id);
});

test('registry: icons and hues are known; copy fields are non-empty', () => {
  for (const w of WORKSPACES) {
    assert.ok(NEXUS_ICON_NAMES.includes(w.icon), `${w.id} icon ${w.icon}`);
    assert.ok(HUES.includes(w.hue), `${w.id} hue ${w.hue}`);
    for (const k of ['label', 'name', 'tagline', 'description']) assert.ok(w[k] && w[k].trim(), `${w.id}.${k}`);
  }
  for (const s of LAUNCHER_SHORTCUTS) assert.ok(NEXUS_ICON_NAMES.includes(s.icon), s.id);
});

test('registry: island points are inside the safe area and not crowded', () => {
  const pts = [...WORKSPACES.map((w) => ({ id: w.id, ...w.island })), ...LAUNCHER_SHORTCUTS.map((s) => ({ id: s.id, ...s.island }))];
  for (const p of pts) {
    assert.ok(p.x >= 10 && p.x <= 90 && p.y >= 10 && p.y <= 90, `${p.id} at ${p.x},${p.y}`);
  }
  for (let i = 0; i < pts.length; i++) for (let j = i + 1; j < pts.length; j++) {
    const d = Math.hypot(pts[i].x - pts[j].x, pts[i].y - pts[j].y);
    assert.ok(d >= 15, `${pts[i].id} and ${pts[j].id} only ${d.toFixed(1)} apart`);
  }
});

test('getWorkspace: known id → config, unknown → null', () => {
  assert.equal(getWorkspace('ml').label, 'ML');
  assert.equal(getWorkspace('nope'), null);
  assert.equal(getWorkspace(''), null);
});

test('workspaceForDomain: mapped, unmapped and unknown domains', () => {
  assert.equal(workspaceForDomain('ai-ml').id, 'ml');
  assert.equal(workspaceForDomain('web-app-dev').id, 'sde');
  assert.equal(workspaceForDomain('cybersecurity'), null);
  assert.equal(workspaceForDomain('nope'), null);
  assert.equal(workspaceForDomain(undefined), null);
});

test('projectsForWorkspace / countsByWorkspace use only real projects', () => {
  const projects = [
    { id: 'a', domainId: 'ai-ml' }, { id: 'b', domainId: 'ai-ml' },
    { id: 'c', domainId: 'web-app-dev' }, { id: 'd', domainId: 'cybersecurity' }, { id: 'e', domainId: 'zzz' }
  ];
  assert.deepEqual(projectsForWorkspace(projects, 'ml').map((p) => p.id), ['a', 'b']);
  assert.deepEqual(projectsForWorkspace(projects, 'qa'), []);
  const counts = countsByWorkspace(projects);
  assert.equal(counts.ml, 2);
  assert.equal(counts.sde, 1);
  assert.equal(counts.qa, 0);
  assert.equal(Object.keys(counts).length, WORKSPACES.length);
});
