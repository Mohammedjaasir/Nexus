// test/nexus-workspaces-section.test.cjs
// The project page's Workspaces section (Task 9): the pure model (rows, attach
// options, pending and failure state) through load-ts, plus source pins on the
// .tsx files (no jsdom).
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const S = loadTs('src/renderer/src/nexus/project/workspacesSectionModel.ts');
const M = loadTs('src/renderer/src/nexus/workspaces/participation.ts');
const { errorCopy } = loadTs('src/renderer/src/nexus/data/errorCopy.ts');

const NEXUS = path.join(__dirname, '..', 'src', 'renderer', 'src', 'nexus');
const src = (p) => fs.readFileSync(path.join(NEXUS, p), 'utf8');
const row = (id, projectId, workspaceId, isPrimary, status = 'active') => ({ id, projectId, workspaceId, status, isPrimary, source: 'user' });
const fail = (code, extra = {}) => ({ ok: false, code, message: 'm', ...extra });

const DB = M.fromRows([row('p1', 'a', 'sde', true), row('p2', 'a', 'qa', false), row('p3', 'a', 'dl', false, 'withdrawn'), row('p4', 'a', 'ml', false, 'complete')]);

test('rows: active participations, primary first; Withdraw is never offered on the primary', () => {
  const rows = S.sectionRows(DB, 'a', true);
  assert.deepEqual(rows.map((r) => [r.workspaceId, r.isPrimary, r.canWithdraw]), [['sde', true, false], ['qa', false, true]]);
  assert.equal(rows[1].label, 'QA');
  assert.equal(rows[1].participationId, 'p2');
});

test('rows: with writes off, or on the legacy index, nothing can be withdrawn', () => {
  assert.ok(S.sectionRows(DB, 'a', false).every((r) => !r.canWithdraw));
  const legacy = M.legacyIndex([{ id: 'a', domainId: 'web-app-dev' }]);
  const rows = S.sectionRows(legacy, 'a', true);
  assert.deepEqual(rows.map((r) => [r.workspaceId, r.isPrimary, r.canWithdraw]), [['sde', true, false]]);
});

test('attach options: catalogue workspaces the project is not actively in; none while writes are off', () => {
  const ids = S.attachOptions(DB, 'a', true).map((o) => o.workspaceId);
  for (const gone of ['sde', 'qa', 'ml']) assert.equal(ids.includes(gone), false, gone);
  assert.equal(ids.includes('dl'), true, 'withdrawn can be attached again');
  assert.deepEqual(S.attachOptions(DB, 'a', false), []);
  assert.deepEqual(S.attachOptions(M.legacyIndex([{ id: 'a', domainId: 'web-app-dev' }]), 'a', true), []);
});

test('pending: begin blocks a second action until the first settles', () => {
  const s1 = S.begin(S.IDLE, { kind: 'attach', workspaceId: 'qa' });
  assert.deepEqual(s1.pending, { kind: 'attach', workspaceId: 'qa' });
  assert.equal(S.begin(s1, { kind: 'attach', workspaceId: 'qa' }), null);
  assert.equal(S.begin(s1, { kind: 'withdraw', participationId: 'p2' }), null);
  // Confirming is ignored while something runs.
  assert.equal(S.askConfirm(s1, 'p2'), s1);
  const ok = S.succeeded(s1, S.addedMessage('QA'));
  assert.deepEqual(ok, { pending: null, confirming: null, error: null, announce: 'Added to QA' });
  assert.notEqual(S.begin(ok, { kind: 'attach', workspaceId: 'dl' }), null);
});

test('withdraw: confirm first, then pending keeps the confirmation open; failure closes it and sets the error', () => {
  const asked = S.askConfirm(S.IDLE, 'p2');
  assert.equal(asked.confirming, 'p2');
  assert.equal(S.cancelConfirm(asked).confirming, null);
  const running = S.begin(asked, { kind: 'withdraw', participationId: 'p2' });
  assert.equal(running.confirming, 'p2');
  assert.equal(S.cancelConfirm(running), running, 'cannot cancel mid-flight');
  const bad = S.failed(running, 'x');
  assert.deepEqual(bad, { pending: null, confirming: null, error: 'x', announce: null });
  // A new attempt clears the old error.
  assert.equal(S.begin(bad, { kind: 'attach', workspaceId: 'dl' }).error, null);
});

test('copy: the brief\'s exact sentences', () => {
  assert.equal(S.addedMessage('QA'), 'Added to QA');
  assert.equal(S.withdrawnMessage('QA'), 'Withdrawn from QA');
  assert.equal(S.confirmQuestion('QA'), 'Withdraw from QA? Its artifacts stay readable and stop taking new versions.');
});

test('withdraw failures say plainly what blocks it', () => {
  assert.equal(S.withdrawFailureText(fail('conflict', { detail: { participationId: 'p2', openHandoffs: 2 } })), 'Answer or withdraw its open handoffs first.');
  assert.equal(S.withdrawFailureText(fail('conflict', { detail: { liveJobs: 1, liveSessions: 0 } })), S.LIVE_WORK_TEXT);
  assert.equal(S.withdrawFailureText(fail('conflict', { detail: { liveJobs: 0, liveSessions: 3 } })), S.LIVE_WORK_TEXT);
  assert.equal(S.withdrawFailureText(fail('invalid')), S.PRIMARY_TEXT);
  assert.equal(S.withdrawFailureText(fail('invalid', { reason: 'bad_request', field: 'participationId' })), errorCopy('invalid', 'bad_request').text);
  assert.equal(S.withdrawFailureText(fail('conflict')), errorCopy('conflict').text);
  for (const c of ['denied', 'not_found', 'internal']) assert.equal(S.withdrawFailureText(fail(c)), errorCopy(c).text, c);
  assert.equal(S.withdrawFailureText(fail('platform_unavailable', { reason: 'busy' })), errorCopy('platform_unavailable', 'busy').text);
});

test('attach failures use the errorCopy sentence, never a raw code', () => {
  for (const [code, reason] of [['invalid', undefined], ['conflict', undefined], ['denied', undefined], ['not_found', undefined], ['internal', undefined], ['platform_unavailable', 'held'], ['platform_unavailable', 'busy']]) {
    const text = S.attachFailureText(fail(code, reason ? { reason } : {}));
    assert.equal(text, errorCopy(code, reason).text);
    assert.doesNotMatch(text, /platform_unavailable|not_found|\binternal\b/);
  }
});

test('reload after a failure only when the shown participations may be stale', () => {
  assert.equal(S.shouldReload(fail('not_found')), true);
  assert.equal(S.shouldReload(fail('conflict')), true);
  assert.equal(S.shouldReload(fail('platform_unavailable', { reason: 'held' })), true);
  assert.equal(S.shouldReload(fail('conflict', { detail: { openHandoffs: 1 } })), false);
  assert.equal(S.shouldReload(fail('platform_unavailable', { reason: 'busy' })), false);
  assert.equal(S.shouldReload(fail('denied')), false);
  assert.equal(S.shouldReload(fail('internal')), false);
});

// ---------- source pins (.tsx) ----------

const section = src('project/WorkspacesSection.tsx');

test('pin: Withdraw is rendered only behind canWithdraw, which is false on the primary row', () => {
  const withdrawButtons = section.match(/>Withdraw</g) || [];
  assert.ok(withdrawButtons.length >= 1);
  // Every Withdraw control sits inside an `r.canWithdraw &&` branch.
  const blocks = section.split(/\{r\.canWithdraw && /).slice(1).join('');
  assert.equal((blocks.match(/>Withdraw</g) || []).length, withdrawButtons.length);
  assert.doesNotMatch(section, /isPrimary\s*\?[^:]*Withdraw/);
  assert.match(src('project/workspacesSectionModel.ts'), /canWithdraw: writable && !row\.isPrimary/);
});

test('pin: both actions go through nexusClient and bump rev on success', () => {
  assert.match(section, /nexusClient\.participationAttach\(projectId, workspaceId\)/);
  assert.match(section, /nexusClient\.participationWithdraw\(participationId\)/);
  assert.doesNotMatch(section, /window\.cth/);
  assert.match(section, /if \(r\.ok\) \{\s*setState\(\(s\) => succeeded\(s, okText\)\);\s*bumpRev\(\);/);
});

test('pin: every failure path sets the role="alert" line', () => {
  assert.match(section, /\} else \{\s*setState\(\(s\) => failed\(s, failText\(r\)\)\);/);
  assert.match(section, /\{state\.error && <p className="nx-passport__note" role="alert">\{state\.error\}<\/p>\}/);
  assert.match(section, /attachFailureText\);/);
  assert.match(section, /withdrawFailureText\);/);
  // The one runner is the only place a result is handled.
  assert.equal((section.match(/await call\(\)/g) || []).length, 1);
});

test('pin: writes render only with selectCanWrite; a double submit is blocked; legacy shows the notice', () => {
  assert.match(section, /usePlatform\(selectCanWrite\)/);
  assert.match(section, /\{canWrite && options\.length > 0 && \(/);
  assert.match(section, /if \(running\.current\) return;/);
  assert.match(section, /const next = begin\(state, p\);\s*if \(!next\) return;/);
  assert.match(section, /<Popover kind="listbox"/);
  assert.match(section, /<PlatformNotice \/>/);
  assert.match(section, /'Adding…'|>Adding…</);
  assert.match(section, /'Withdrawing…'/);
});

test('pin: the Passport mounts the section on the source node', () => {
  const panel = src('project/PassportPanel.tsx');
  assert.match(panel, /\{node\.kind === 'source' && <WorkspacesSection key=\{project\.id\} projectId=\{project\.id\} \/>\}/);
});

test('pin: the workspace page says a project can be added from its own page only while writes are on', () => {
  const page = src('pages/WorkspacePage.tsx');
  assert.match(page, /usePlatform\(selectCanWrite\)/);
  assert.match(page, /const addHint = canWrite \? ` A project can also be added to \$\{ws\.label\} from its own page\.` : '';/);
});

test('pin: the section styles live in platform.css and use only existing tokens', () => {
  const css = fs.readFileSync(path.join(NEXUS, 'styles', 'platform.css'), 'utf8');
  assert.match(css, /\.nx-wsx__row/);
  const tokens = fs.readFileSync(path.join(NEXUS, 'styles', 'tokens.css'), 'utf8');
  for (const v of new Set(css.match(/var\(--nx-[a-z0-9-]+\)/g) || [])) {
    const name = v.slice(4, -1);
    assert.ok(tokens.includes(`${name}:`), `${name} is an existing token`);
  }
});
