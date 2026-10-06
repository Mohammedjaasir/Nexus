'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');
const cat = loadTs('src/shared/nexus/workspaceCatalog.ts');
const seed = loadTs('src/main/nexus/db/v7Seed.ts');
const { WORKSPACES } = loadTs('src/renderer/src/nexus/workspaces/registry.ts');
const { workspaceForDomain } = loadTs('src/renderer/src/nexus/workspaces/mapping.ts');
const { listDomainDefinitions } = loadTs('src/shared/domain.ts');
const ALL = listDomainDefinitions().map((d) => d.id);

test('catalogue ids equal the Phase A registry ids', () => {
  assert.deepEqual([...cat.PLATFORM_WORKSPACE_IDS].sort(), WORKSPACES.map((w) => w.id).sort());
});
test('every analyser domain, cybersecurity and junk map exactly as the renderer maps them', () => {
  for (const d of [...ALL, 'cybersecurity', 'retired-domain', '', null, undefined])
    assert.equal(cat.workspaceForLegacyDomain(d), workspaceForDomain(d)?.id ?? null, String(d));
});
test('the frozen v7 seed equals the live catalogue at ship time', () => {
  assert.deepEqual([...seed.V7_WORKSPACE_IDS], [...cat.PLATFORM_WORKSPACE_IDS]);
  assert.deepEqual({ ...seed.V7_DOMAIN_TO_WORKSPACE }, { ...cat.LEGACY_DOMAIN_TO_WORKSPACE });
});
test('job vocabulary: the brief nine plus leased and retry_scheduled; only failed/timed_out leave a terminal state, to retry', () => {
  const states = new Map(seed.V7_JOB_STATES.map((s) => [s.state, s.terminal]));
  assert.deepEqual([...states.keys()].sort(), ['awaiting_approval', 'cancelled', 'completed', 'failed', 'interrupted',
    'leased', 'partial', 'queued', 'retry_scheduled', 'running', 'timed_out']);
  assert.deepEqual([...states].filter(([, t]) => t === 0).map(([s]) => s).sort(),
    ['awaiting_approval', 'leased', 'queued', 'retry_scheduled', 'running']);
  assert.equal(seed.V7_JOB_TRANSITIONS.length, 23);
  const has = (a, b) => seed.V7_JOB_TRANSITIONS.some(([x, y]) => x === a && y === b);
  for (const [a, b] of [['queued', 'leased'], ['leased', 'running'], ['failed', 'retry_scheduled'], ['timed_out', 'retry_scheduled'], ['retry_scheduled', 'queued']])
    assert.ok(has(a, b), `${a}>${b}`);
  assert.ok(!has('queued', 'running'), 'a job is leased before it runs');
  assert.ok(!seed.V7_JOB_STATES.some((s) => s.state === 'succeeded'), 'succeeded maps to completed');
  for (const [a, b] of seed.V7_JOB_TRANSITIONS) {
    assert.ok(states.has(a) && states.has(b));
    if (states.get(a) === 1) assert.ok(['failed', 'timed_out'].includes(a) && b === 'retry_scheduled', `${a}>${b}`);
  }
});
test('session vocabulary: eight states, terminals have no exits', () => {
  const states = new Map(seed.V7_SESSION_STATES.map((s) => [s.state, s.terminal]));
  assert.deepEqual([...states.keys()].sort(), ['awaiting_approval', 'cancelled', 'completed', 'failed', 'interrupted', 'open', 'running', 'timed_out']);
  assert.equal(seed.V7_SESSION_TRANSITIONS.length, 14);
  for (const [a, b] of seed.V7_SESSION_TRANSITIONS) { assert.ok(states.has(b)); assert.equal(states.get(a), 0, a); }
});
test('lineage vocabulary is the union of the brief list and architecture L.1, with a planned phase each', () => {
  const names = seed.V7_LINEAGE_RELATIONS.map((r) => r.relation);
  assert.equal(names.length, 32); assert.equal(new Set(names).size, 32);
  assert.deepEqual([...seed.BRIEF_LINEAGE_RELATIONS].sort(), ['built_from', 'depends_on', 'deployed_as',
    'derived_from', 'evaluated_on', 'implements', 'serves', 'trained_on']);
  for (const r of seed.BRIEF_LINEAGE_RELATIONS) assert.ok(names.includes(r), r);
  for (const r of ['contains', 'extracted_from', 'queried_from', 'visualizes', 'cites', 'analyzes', 'tested_on', 'run_of',
    'produced_by', 'resumed_from', 'selected_from', 'evaluates', 'packages', 'exported_from', 'fixes', 'assembled_from',
    'tests', 'executes', 'found_in', 'evidenced_by', 'verified_by', 'summarizes', 'recommends', 'based_on']) assert.ok(names.includes(r), r);
  for (const r of seed.V7_LINEAGE_RELATIONS) assert.ok(r.plannedPhase && r.description, r.relation);
  assert.match(seed.V7_LINEAGE_RELATIONS.find((r) => r.relation === 'deployed_as').plannedPhase, /^B6/);
});
test('shared catalogue imports nothing from the renderer or shared/domain', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src/shared/nexus/workspaceCatalog.ts'), 'utf8');
  assert.doesNotMatch(src, /from\s+['"][^'"]*(renderer|\/domain)['"]/);
});

const expand = (o) => Object.entries(o).flatMap(([a, bs]) => bs.map((b) => `${a}>${b}`));
const pairsOf = (t) => t.map(([a, b]) => `${a}>${b}`);

test('the full legacy domain mapping equals the one derived from the Phase A registry', () => {
  const derived = {};
  for (const w of WORKSPACES) for (const d of w.domainIds) derived[d] = w.id;
  assert.deepEqual({ ...cat.LEGACY_DOMAIN_TO_WORKSPACE }, derived);
});
test('job transitions equal the plan set exactly', () => {
  assert.deepEqual(pairsOf(seed.V7_JOB_TRANSITIONS), expand({
    queued: ['leased', 'cancelled'],
    leased: ['running', 'queued', 'failed', 'cancelled', 'interrupted'],
    running: ['awaiting_approval', 'completed', 'partial', 'failed', 'cancelled', 'timed_out', 'interrupted'],
    awaiting_approval: ['running', 'failed', 'cancelled', 'timed_out', 'interrupted'],
    failed: ['retry_scheduled'], timed_out: ['retry_scheduled'], retry_scheduled: ['queued', 'cancelled']
  }));
});
test('session transitions equal the plan set exactly', () => {
  assert.deepEqual(pairsOf(seed.V7_SESSION_TRANSITIONS), expand({
    open: ['running', 'failed', 'cancelled'],
    running: ['awaiting_approval', 'completed', 'failed', 'cancelled', 'timed_out', 'interrupted'],
    awaiting_approval: ['running', 'failed', 'cancelled', 'timed_out', 'interrupted']
  }));
});
test('principals and memberships equal the plan seed exactly', () => {
  assert.deepEqual(seed.V7_PRINCIPALS.map((p) => ({ ...p })), [
    { id: 'user:local', kind: 'user', displayName: 'Local owner' },
    { id: 'system', kind: 'system', displayName: 'Nexus platform' }
  ]);
  assert.deepEqual(seed.V7_MEMBERSHIPS.map((m) => ({ ...m })), [
    { principalId: 'user:local', role: 'owner' },
    { principalId: 'system', role: 'admin' }
  ]);
});
test('relation to planned phase map equals the plan table exactly', () => {
  const phases = Object.fromEntries(seed.V7_LINEAGE_RELATIONS.map((r) => [r.relation, r.plannedPhase]));
  assert.deepEqual(phases, {
    derived_from: 'B1', contains: 'B1', extracted_from: 'B1', built_from: 'B1', assembled_from: 'B1',
    fixes: 'B2', tests: 'B2', executes: 'B2', found_in: 'B2', evidenced_by: 'B2', verified_by: 'B2',
    summarizes: 'B2', recommends: 'B2', based_on: 'B2', depends_on: 'B2',
    queried_from: 'B3a', visualizes: 'B3a', cites: 'B3a', analyzes: 'B3a',
    tested_on: 'B3b', evaluates: 'B3b', evaluated_on: 'B3b',
    run_of: 'B4', trained_on: 'B4', produced_by: 'B4', packages: 'B4', serves: 'B4',
    resumed_from: 'B5', selected_from: 'B5', exported_from: 'B5',
    deployed_as: 'B6', implements: 'unassigned'
  });
  const d = (r) => seed.V7_LINEAGE_RELATIONS.find((x) => x.relation === r).description;
  assert.equal(d('serves'), 'A change set that serves a serving package or model export version.');
  assert.equal(d('run_of'), 'A training run that belongs to an experiment.');
  assert.equal(d('produced_by'), 'A model or checkpoint produced by a training run.');
  assert.match(d('deployed_as'), /Deployment records arrive in B6; vocabulary only until then\.$/);
});
