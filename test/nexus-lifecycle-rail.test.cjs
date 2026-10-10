// test/nexus-lifecycle-rail.test.cjs
// B2a Task 15: every domain's lifecycle as a rail in its own words (workspaces/lifecycleModel.ts through
// load-ts), states derived from records only (shared/nexus/stepState.ts), and source pins on the rail,
// the workspace page and the Spine (no jsdom).
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const L = loadTs('src/renderer/src/nexus/workspaces/lifecycleModel.ts');
const { DOMAINS } = loadTs('src/shared/nexus/domains/index.ts');
const NEXUS = path.join(__dirname, '..', 'src', 'renderer', 'src', 'nexus');
const src = (p) => fs.readFileSync(path.join(NEXUS, p), 'utf8');
const views = L.bundledDomainViews();
const view = (id) => views.find((v) => v.id === id);
const rail = (id, records = null) => L.railFor(view(id), records);

test('the bundled projection is exactly what main sends over #22 (dto.ts domainView)', () => {
  const { domainView } = loadTs('src/main/nexusIpc/dto.ts');
  for (const d of DOMAINS) assert.deepEqual(L.domainViewOf(d), domainView(d), d.id);
});

test('LR1 SDE at B2a: nine steps in this release, three not ("Not in this release: arrives with AI-assisted changes")', () => {
  const r = rail('sde');
  assert.equal(r.steps.length, 12);
  const now = r.steps.filter((s) => !s.future);
  const later = r.steps.filter((s) => s.future);
  assert.equal(now.length, 9);
  assert.ok(now.every((s) => s.status === 'REAL' && s.word === 'In this release'));
  assert.deepEqual(later.map((s) => s.id), ['ai-implementation', 'review', 'iteration']);
  for (const s of later) {
    assert.equal(s.note, 'Not in this release: arrives with AI-assisted changes');
    assert.equal(s.word, 'Not in this release');
    assert.equal(s.subPhase, 'B2b');
  }
  assert.equal(r.availability, null);
  assert.equal(r.supported, true);
});

test('LR1 QA, DA, DS, ML and DL show their full lifecycles, FUTURE steps marked with their real sub-phase', () => {
  const PHASE = { qa: 'B2c', data: 'B3', 'data-scientist': 'B4', ml: 'B5', dl: 'B6' };
  for (const [id, phase] of Object.entries(PHASE)) {
    const r = rail(id);
    const spec = DOMAINS.find((d) => d.id === id);
    assert.deepEqual(r.steps.map((s) => [s.id, s.label, s.status, s.subPhase]), spec.lifecycle.map((s) => [s.id, s.label, s.status, s.subPhase]), id);
    for (const s of r.steps.filter((x) => x.future)) {
      assert.equal(s.subPhase, phase, `${id}/${s.id}`);
      assert.ok(s.note.startsWith('Not in this release: arrives with ') && s.note.includes(`(${phase})`), `${id}/${s.id}: ${s.note}`);
    }
  }
});

test('LR1 problem statements are in this release for DA, ML and DL; DS cannot be added to a project until B4 (registry ruling)', () => {
  for (const [id, step] of [['data', 'business-question'], ['ml', 'problem'], ['dl', 'problem']]) {
    const s = rail(id).steps.find((x) => x.id === step);
    assert.deepEqual([s.status, s.future, s.word], ['REAL', false, 'In this release'], id);
    assert.ok(s.note && /You write it in Nexus/.test(s.note), `${id}: the honest scope note`);
    assert.equal(rail(id).availability, null);
  }
  const ds = rail('data-scientist');
  assert.equal(ds.availability, 'Available from B4; it cannot be added to a project yet');
  const bp = ds.steps.find((x) => x.id === 'business-problem');
  assert.deepEqual([bp.status, bp.future, bp.subPhase], ['FUTURE', true, 'B4']);
  assert.ok(ds.steps.every((s) => s.future), 'none of its steps runs');
  assert.ok(ds.modules.every((m) => !m.delivered));
  // Even with records, a domain a project cannot take part in claims no state.
  assert.ok(L.railFor(view('data-scientist'), { versions: [], liveActions: [], participation: true, deploymentHealthy: false }).steps.every((s) => s.state === null));
});

test('LR1 registry-only domains say "Not yet a supported workflow"', () => {
  for (const id of ['research', 'uiux', 'devops']) {
    const r = rail(id);
    assert.deepEqual([r.supported, r.availability, r.steps.length, r.modules.length], [false, 'Not yet a supported workflow', 0, 0], id);
  }
});

test('LR1 modules in the domain\'s words: delivered now, or the sub-phase they arrive in', () => {
  const da = rail('data');
  assert.deepEqual(da.modules.find((m) => m.id === 'questions'), { id: 'questions', label: 'Questions', delivered: true, note: null });
  assert.equal(da.modules.find((m) => m.id === 'queries').note, 'arrives in B3');
  assert.equal(rail('sde').modules.find((m) => m.id === 'changes').note, 'arrives in B2b');
});

// ---------- LR2 ----------

const rec = (o = {}) => ({ versions: [], liveActions: [], participation: true, deploymentHealthy: false, ...o });
const stepOf = (id, step, records) => L.railFor(view(id), records).steps.find((s) => s.id === step);
const PASSED = { 'suite.discovered': 'passed', 'sde.tests_pass': 'passed' };

test('LR2 step states come from records only: a finished job without a candidate version is not done', () => {
  // The run finished (no live job) and left nothing usable: the step is not done.
  const repo = { kind: 'repository', status: 'active', validators: { 'git.head_resolves': 'passed' } };
  assert.equal(stepOf('sde', 'tests', rec({ versions: [repo] })).state, 'ready');
  assert.equal(stepOf('sde', 'tests', rec()).state, 'blocked', 'no repository snapshot yet');
  assert.equal(stepOf('sde', 'tests', rec({ versions: [repo], liveActions: ['sde.tests.run'] })).state, 'in_progress');
  // A draft suite whose checks have not finished is still being checked, never done.
  assert.equal(stepOf('sde', 'tests', rec({ versions: [repo, { kind: 'test_suite', status: 'draft', validators: { 'suite.discovered': 'passed' } }] })).state, 'in_progress');
});

test('LR2 a candidate test suite with its checks passed (suite.discovered and sde.tests_pass) is done; a failed one needs attention', () => {
  const done = stepOf('sde', 'tests', rec({ versions: [{ kind: 'test_suite', status: 'candidate', validators: PASSED }] }));
  assert.deepEqual([done.state, done.word], ['done', 'Done']);
  const failed = stepOf('sde', 'tests', rec({ versions: [{ kind: 'test_suite', status: 'candidate', validators: { 'suite.discovered': 'passed', 'sde.tests_pass': 'failed' } }] }));
  assert.deepEqual([failed.state, failed.word], ['failed', 'Needs attention']);
  // Record steps: the participation, a healthy dev deployment.
  assert.equal(stepOf('sde', 'project', rec()).state, 'done');
  assert.equal(stepOf('sde', 'dev-deployment', rec({ versions: [{ kind: 'application', status: 'candidate', validators: {} }] })).state, 'ready');
  assert.equal(stepOf('sde', 'dev-deployment', rec({ deploymentHealthy: true })).state, 'done');
  // A FUTURE step is unavailable whatever the records say.
  assert.equal(stepOf('sde', 'ai-implementation', rec({ versions: [{ kind: 'change_set', status: 'active', validators: {} }] })).state, 'unavailable');
  // Without records (a workspace page, or checks that could not be read): no state is claimed.
  assert.ok(rail('sde').steps.every((s) => s.state === null));
});

test('LR2 the compact summary counts only the rail\'s own steps', () => {
  const r = L.railFor(view('sde'), rec({ versions: [{ kind: 'test_suite', status: 'candidate', validators: PASSED }] }));
  assert.equal(L.railSummary(r), '2 of 9 steps in this release done; 3 not in this release');
  assert.equal(L.railSummary(rail('data-scientist')), 'Available from B4; it cannot be added to a project yet');
  // Steps that need attention or are moving are counted too (fix round 1).
  const busy = L.railFor(view('sde'), rec({ versions: [{ kind: 'test_suite', status: 'candidate', validators: { 'suite.discovered': 'passed', 'sde.tests_pass': 'failed' } },
    { kind: 'repository', status: 'active', validators: { 'git.head_resolves': 'passed' } }], liveActions: ['sde.build.run'] }));
  assert.equal(L.railSummary(busy), '2 of 9 steps in this release done; 1 needs attention; 1 in progress; 3 not in this release');
  assert.deepEqual(rail('sde').steps.map((s) => s.n), Array.from({ length: 12 }, (_, i) => i + 1));
  assert.deepEqual(L.liveActionsOf([{ state: 'running', actionId: 'a' }, { state: 'completed', actionId: 'b' }, { state: 'queued', actionId: null }]), ['a']);
});

// ---------- pins ----------

test('pin: the rail draws FUTURE steps hatched and never as a control; the workspace page and the Spine draw it', () => {
  const r = src('workspaces/LifecycleRail.tsx');
  assert.match(r, /data-future=\{s\.future \? 'true' : undefined\}/);
  assert.doesNotMatch(r, /<button|onClick|tabIndex/, 'nothing in the rail is a control');
  assert.match(r, /<span className="nx-lrail__word">\{s\.word\}<\/span>/, 'state is always a word');
  assert.match(src('styles/project.css'), /\.nx-lrail__step\[data-future="true"\]::before \{ border-style: dashed; background: repeating-linear-gradient/);
  assert.match(r, /<span className="nx-lrail__n nx-id" aria-hidden="true">\{s\.n\}<\/span>/, 'the step number');
  const page = src('pages/WorkspacePage.tsx');
  assert.match(page, /\{rail && <LifecycleRail rail=\{rail\} \/>\}/);
  assert.match(page, /useDomains\(\)\.list\.find\(\(d\) => d\.id === id\)/);
  assert.ok(page.indexOf('<LifecycleRail') < page.indexOf('id="ws-panel-projects"'), 'above the project list');
  assert.match(src('project/Spine.tsx'), /\{!g\.muted && rails\?\.get\(g\.workspaceId\) && <LifecycleRail rail=\{rails\.get\(g\.workspaceId\)!\} compact \/>\}/);
  assert.match(src('project/ProjectBench.tsx'), /railRecordsFor\(\{ workspaceId: g\.workspaceId, artifacts, checks, liveActions, deploymentHealthy: healthy, participating: true \}\)/);
});

test('pin (fix round 1): the full rail is an ordered ruled line, not a grid of cards or tiles', () => {
  const css = src('styles/execution.css') + src('styles/project.css');
  assert.doesNotMatch(css, /repeat\(auto-fill/, 'no auto-fill tile grid');
  const rules = [...css.matchAll(/(\.nx-lrail__step[^{]*)\{([^}]*)\}/g)];
  assert.ok(rules.length > 0);
  for (const [, sel, body] of rules) {
    if (sel.includes('::before')) continue; // the marker dot may be round
    assert.doesNotMatch(body, /border-radius/, `${sel} is not a rounded tile`);
    assert.doesNotMatch(body, /background\s*:/, `${sel} is not a filled tile`);
    assert.doesNotMatch(body, /border\s*:\s*1px solid/, `${sel} has no tile border (only the left rule)`);
  }
  const step = rules.find(([, sel]) => sel.trim() === '.nx-lrail__step')[2];
  assert.match(step, /border-left: 1px solid var\(--nx-line-strong\)/, 'one rule down the left, as the version timeline');
  assert.match(css, /\.nx-lrail__step::before \{ content: ""; position: absolute;/, 'a marker per step');
  assert.match(css, /\.nx-lrail__step\[data-state="failed"\]::before/);
  assert.match(css, /\.nx-lrail__bar li\[data-state="failed"\]/, 'a failed step is marked in the compact rail too');
});
