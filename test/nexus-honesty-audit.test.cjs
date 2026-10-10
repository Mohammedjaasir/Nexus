// test/nexus-honesty-audit.test.cjs
// B2a Task 15: the honesty audit. For every domain and every availability state of this computer, even when
// main's action answer claims every action is available, no enabled action maps to a FUTURE step, an unmet
// machine prerequisite or a missing input; no shown number lacks a source; no domain is ever called complete;
// and the registry strings and the new copy pass the identity guard's rules.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const L = loadTs('src/renderer/src/nexus/workspaces/lifecycleModel.ts');
const AM = loadTs('src/renderer/src/nexus/project/actionModel.ts');
const X = loadTs('src/renderer/src/nexus/data/executionModel.ts');
const { DOMAINS } = loadTs('src/shared/nexus/domains/index.ts');
const { USER_ACTIONS } = loadTs('src/shared/nexus/actions.ts');
const { copyItems, scanText } = require('./helpers/identityGuard.cjs');

const GIB = 2 ** 30;
const NEXUS = path.join(__dirname, '..', 'src', 'renderer', 'src', 'nexus');
const health = (o = {}) => ({
  db: { version: 9, platform: true, handoffs: true, execution: true }, registry: { valid: true, problems: 0 },
  runner: { state: 'ready', attached: true, restarts: 0 }, docker: { state: 'running', version: '29', cpus: 8, memoryBytes: 8 * GIB },
  images: ['sde-node', 'sde-python', 'nexus-fwd'].map((profile) => ({ profile, present: true, matches: true })),
  disk: { dataHomeFreeBytes: 52 * GIB, requiredBytes: 30 * GIB, recommendedBytes: 40 * GIB, leaseFloorBytes: 5 * GIB, gate: 'ok' },
  problems: [], gpu: { detected: false, supported: false }, checkedAt: 1, ...o
});
const ok = (h) => ({ ok: true, data: h });
const STATES = {
  'platform off': X.availabilityFrom({ unavailable: { reason: 'held' } }, null),
  'execution held': X.availabilityFrom({ unavailable: null }, { ok: false, code: 'platform_unavailable', reason: 'execution_unavailable', subReason: 'held', message: 'm' }),
  'execution not connected': X.availabilityFrom({ unavailable: null }, { ok: false, code: 'platform_unavailable', reason: 'execution_unavailable', subReason: 'unreachable', message: 'm' }),
  'Docker stopped': X.availabilityFrom({ unavailable: null }, ok(health({ docker: { state: 'stopped' }, problems: ['docker_stopped'] }))),
  'disk below the gate': X.availabilityFrom({ unavailable: null }, ok(health({ disk: { dataHomeFreeBytes: 18 * GIB, requiredBytes: 30 * GIB, recommendedBytes: 40 * GIB, leaseFloorBytes: 5 * GIB, gate: 'below_required' }, problems: ['disk_low'] }))),
  'image missing': X.availabilityFrom({ unavailable: null }, ok(health({ images: [{ profile: 'sde-node', present: false, matches: false }], problems: ['image_missing:sde-node'] }))),
  'all ready': X.availabilityFrom({ unavailable: null }, ok(health()))
};
const MACHINE = /^(docker|disk:|image:)/;
const KINDS = [...new Set(DOMAINS.flatMap((d) => d.kindsProduced))];

/** main's answer at its most generous: every action of the domain "available", with its real input slots. */
const generous = (d) => USER_ACTIONS.filter((a) => d.actions.includes(a.id)).map((a) => ({
  actionId: a.id, label: a.label, available: true, reason: null, needsApproval: false, inputs: a.inputs.map((s) => ({ ...s })),
  stepId: d.lifecycle.find((s) => s.via.some((v) => v.userAction === a.id))?.id ?? null
}));
// Plus actions main never sends today, pointed at every FUTURE step of the domain.
const futureFakes = (d) => d.lifecycle.filter((s) => s.status === 'FUTURE').map((s) => ({
  actionId: d.actions[0] ?? 'sde.requirement.write', label: `fake ${s.id}`, available: true, reason: null, needsApproval: false, inputs: [], stepId: s.id
}));

test('HA1 no enabled action maps to a FUTURE step, an unmet machine prerequisite or a missing input (every domain x every state)', () => {
  let checked = 0;
  for (const d of DOMAINS) {
    for (const [state, availability] of Object.entries(STATES)) {
      const contexts = [{ version: null, usableKinds: new Set() }, { version: null, usableKinds: new Set(KINDS) },
        ...KINDS.flatMap((k) => ['draft', 'candidate', 'active'].map((st) => ({ version: { kind: k, status: st }, usableKinds: new Set() })))];
      for (const c of contexts) {
        const bar = AM.actionBar([...generous(d), ...futureFakes(d)], { workspaceId: d.id, availability, ...c });
        for (const b of bar.buttons) {
          checked++;
          const def = USER_ACTIONS.find((a) => a.id === b.actionId);
          const step = d.lifecycle.find((s) => s.via.some((v) => v.userAction === b.actionId));
          const where = `${d.id} / ${state} / ${b.actionId} / ${c.version ? `${c.version.kind}:${c.version.status}` : 'project'}`;
          assert.ok(!/^fake /.test(b.label), `${where}: a FUTURE step offered`);
          assert.ok(step && step.status !== 'FUTURE', `${where}: its step is in this release`);
          if (def.prerequisites.some((p) => MACHINE.test(p))) assert.equal(availability.kind, 'ready', `${where}: machine prerequisite unmet`);
          for (const slot of def.inputs.filter((s) => s.min >= 1)) {
            const filled = c.version ? slot.kinds.includes(c.version.kind) && (['candidate', 'active'].includes(c.version.status)
              || (b.actionId === 'sde.preview.start' && c.version.status === 'draft')) : slot.kinds.some((k) => c.usableKinds.has(k));
            assert.ok(filled, `${where}: input ${slot.slot} missing`);
          }
        }
      }
    }
  }
  assert.ok(checked > 0, 'some actions were offered (the audit is not vacuous)');
});

test('HA1 a domain a project cannot take part in, or a registry-only one, offers nothing', () => {
  for (const id of ['data-scientist', 'research', 'uiux', 'devops']) {
    const d = DOMAINS.find((x) => x.id === id);
    assert.deepEqual(d.actions, [], id);
    const bar = AM.actionBar([...generous(d), ...futureFakes(d)], { workspaceId: id, availability: STATES['all ready'], version: null, usableKinds: new Set(KINDS) });
    assert.equal(bar.buttons.length, 0, id);
  }
});

/** Every shown string of a rail. */
const railTexts = (r) => [r.label, r.statusNote, r.availability, L.railSummary(r), ...r.steps.flatMap((s) => [s.label, s.word, s.note]),
  ...r.modules.flatMap((m) => [m.label, m.note])].filter((x) => typeof x === 'string');
const RECORDS = [null, { versions: [], liveActions: [], participation: true, deploymentHealthy: false },
  { versions: KINDS.map((kind) => ({ kind, status: 'active', validators: {} })), liveActions: USER_ACTIONS.map((a) => a.id), participation: true, deploymentHealthy: true }];

test('HA1 no domain is ever called complete; FUTURE steps never carry a state', () => {
  for (const v of L.bundledDomainViews()) {
    assert.equal(v.executableEndToEnd, false, `${v.id} is not executable end to end in B2a`);
    for (const records of RECORDS) {
      const r = L.railFor(v, records);
      for (const t of railTexts(r)) assert.doesNotMatch(t, /\bcomplete(d)?\b|finished|end to end/i, `${v.id}: ${t}`);
      for (const s of r.steps.filter((x) => x.future)) {
        assert.ok(s.state === null || s.state === 'unavailable', `${v.id}/${s.id}`);
        assert.equal(s.word, 'Not in this release');
      }
    }
  }
});

test('HA1 no number without a source: rail numbers are sub-phase names or counts of the rail\'s own steps', () => {
  for (const v of L.bundledDomainViews()) {
    for (const records of RECORDS) {
      const r = L.railFor(v, records);
      const summary = L.railSummary(r);
      for (const t of railTexts(r)) {
        // Sub-phase names and the loopback address are names, not measurements.
        const rest = t.replace(/\bB\d[a-c]?\b/g, '').replace(/\b127\.0\.0\.1\b/g, '');
        if (t !== summary) { assert.doesNotMatch(rest, /\d/, `${v.id}: ${t}`); continue; }
        if (r.availability) continue;
        const inRelease = r.steps.filter((s) => !s.future);
        const nums = (rest.match(/\d+/g) || []).map(Number);
        const expected = [inRelease.filter((s) => s.state === 'done').length, inRelease.length];
        if (r.steps.length > inRelease.length) expected.push(r.steps.length - inRelease.length);
        assert.deepEqual(nums, expected, `${v.id}: ${t}`);
      }
    }
  }
  // The setup sheet's numbers come from the health view itself.
  const rows = X.setupSheet(health({ disk: { dataHomeFreeBytes: 18 * GIB, requiredBytes: 30 * GIB, recommendedBytes: 40 * GIB, leaseFloorBytes: 5 * GIB, gate: 'below_required' } }));
  assert.equal(rows.find((r) => r.id === 'disk').text, 'Free disk is 18 GB; execution needs 30 GB (40 GB recommended)');
  assert.equal(rows.find((r) => r.id === 'image:sde-node').prepare, null, 'below the gate nothing can be prepared');
});

// ---------- HA2 ----------

const NEW_COPY = ['workspaces/lifecycleModel.ts', 'workspaces/LifecycleRail.tsx', 'data/useExecution.ts', 'data/executionModel.ts', 'data/errorCopy.ts',
  'runs/jobRunModel.ts', 'runs/JobLogSheet.tsx', 'runs/ProjectRuns.tsx', 'project/evidenceModel.ts', 'project/EvidenceSection.tsx', 'project/kindViewers.tsx',
  'project/ActionBar.tsx', 'project/ApprovalsSection.tsx', 'project/DeploymentsSection.tsx', 'project/RequirementSheet.tsx', 'project/actionModel.ts',
  'components/ExecutionSetupSheet.tsx', 'components/ExecutionNotice.tsx'];

test('HA2 the registry strings and the new copy pass the identity guard rules (no persona, office or lead words)', () => {
  const strings = [];
  const walk = (v) => { if (typeof v === 'string') strings.push(v); else if (Array.isArray(v)) v.forEach(walk); else if (v && typeof v === 'object') Object.values(v).forEach(walk); };
  walk(DOMAINS);
  walk(USER_ACTIONS.map((a) => a.label));
  assert.ok(strings.length > 300, `the registry was walked (${strings.length})`);
  for (const s of strings) assert.deepEqual(scanText(s, true), [], s);
  for (const f of NEW_COPY) for (const it of copyItems(path.join(NEXUS, f))) assert.deepEqual(scanText(it.text, true), [], `${f}: ${it.text}`);
  for (const v of L.bundledDomainViews()) for (const t of railTexts(L.railFor(v))) assert.deepEqual(scanText(t, true), [], t);
});
