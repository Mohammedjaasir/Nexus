// test/nexus-artifact-model.test.cjs
// Task 10: the artifact model (labels, the actions the platform would allow, the
// read-only Passport view) and the Save sheet model, through load-ts; plus source
// pins on the .tsx files (no jsdom).
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const A = loadTs('src/renderer/src/nexus/project/artifactModel.ts');
const S = loadTs('src/renderer/src/nexus/project/saveSheetModel.ts');
const P = loadTs('src/renderer/src/nexus/workspaces/participation.ts');
const { errorCopy } = loadTs('src/renderer/src/nexus/data/errorCopy.ts');

const NEXUS = path.join(__dirname, '..', 'src', 'renderer', 'src', 'nexus');
const src = (p) => fs.readFileSync(path.join(NEXUS, p), 'utf8');
const fail = (code, extra = {}) => ({ ok: false, code, message: 'm', ...extra });

const SHA = 'a'.repeat(40);
const ver = (o = {}) => ({ id: 'V1', status: 'draft', producedByEngine: false, promotedAt: null, ...o });
const art = (o = {}) => ({ status: 'active', ownerScope: 'participation', currentVersionId: 'CUR', ...o });

// ---------- actions (AM1–AM4) ----------

test('AM1: a user-made draft offers Mark ready and Discard; a job-made draft offers Discard only', () => {
  assert.deepEqual(A.actionsFor(ver(), art(), true).map((a) => a.kind), ['markReady', 'discard']);
  assert.deepEqual(A.actionsFor(ver({ producedByEngine: true }), art(), true).map((a) => a.kind), ['discard']);
});

test('AM2: candidate → Promote and Discard; active → Hand off; deprecated (once promoted) → Roll back; failed → nothing', () => {
  assert.deepEqual(A.actionsFor(ver({ status: 'candidate' }), art(), true).map((a) => a.kind), ['promote', 'discard']);
  assert.deepEqual(A.actionsFor(ver({ status: 'active' }), art(), true).map((a) => a.kind), ['handoff']);
  assert.deepEqual(A.actionsFor(ver({ status: 'deprecated', promotedAt: 5 }), art(), true).map((a) => a.kind), ['rollback']);
  assert.deepEqual(A.actionsFor(ver({ status: 'deprecated', promotedAt: null }), art(), true), []);
  assert.deepEqual(A.actionsFor(ver({ status: 'failed' }), art(), true), []);
});

test('AM3: a frozen owner, an archived artifact or a project-owned one offers no write action', () => {
  for (const status of ['draft', 'candidate', 'active', 'deprecated']) {
    const v = ver({ status, promotedAt: 1 });
    assert.deepEqual(A.actionsFor(v, art(), false), [], status);
    assert.deepEqual(A.actionsFor(v, art({ status: 'archived' }), true), [], status);
    assert.deepEqual(A.actionsFor(v, art({ ownerScope: 'project' }), true), [], status);
  }
});

test("AM4: Promote and Roll back pass the artifact's currentVersionId as expectedCurrentVersionId", () => {
  const [promote] = A.actionsFor(ver({ id: 'V2', status: 'candidate' }), art({ currentVersionId: 'V1' }), true);
  assert.deepEqual(promote, { kind: 'promote', versionId: 'V2', expectedCurrentVersionId: 'V1' });
  const [first] = A.actionsFor(ver({ id: 'V1', status: 'candidate' }), art({ currentVersionId: null }), true);
  assert.equal(first.expectedCurrentVersionId, null);
  const [rollback] = A.actionsFor(ver({ id: 'V1', status: 'deprecated', promotedAt: 3 }), art({ currentVersionId: 'V2' }), true);
  assert.deepEqual(rollback, { kind: 'rollback', versionId: 'V1', expectedCurrentVersionId: 'V2' });
});

test('labels: kinds and statuses in words', () => {
  assert.equal(A.kindLabel('git_commit'), 'Commit');
  assert.equal(A.kindLabel('text_file'), 'Text file');
  assert.equal(A.kindLabel('handoff_receipt'), 'Received');
  assert.equal(A.kindLabel('change_set'), 'Change set');
  assert.deepEqual(['draft', 'candidate', 'active', 'failed', 'deprecated'].map(A.statusLabel), ['draft', 'ready', 'active', 'failed', 'deprecated']);
  assert.equal(A.relationLabel('derived_from'), 'derived from');
});

// ---------- the project's summaries ----------

test('nextArtifacts: success replaces; unavailable empties quietly; busy keeps the last read with a sentence; not_found empties', () => {
  const s1 = A.nextArtifacts(A.NO_ARTIFACTS, { ok: true, data: [{ artifact: { id: 'x' } }] });
  assert.deepEqual([s1.artifacts.length, s1.loaded, s1.error], [1, true, null]);
  const off = A.nextArtifacts(s1, fail('platform_unavailable', { reason: 'held' }));
  assert.deepEqual(off, { artifacts: [], loaded: true, error: null, retry: false });
  assert.equal(s1.retry, false);
  const busy = A.nextArtifacts(s1, fail('platform_unavailable', { reason: 'busy' }));
  assert.equal(busy.artifacts, s1.artifacts);
  assert.equal(busy.error, errorCopy('platform_unavailable', 'busy').text);
  assert.equal(busy.retry, true);
  const gone = A.nextArtifacts(s1, fail('not_found'));
  assert.deepEqual(gone.artifacts, []);
  assert.equal(gone.error, errorCopy('not_found').text);
  assert.equal(gone.retry, false);
});

// ---------- the Passport view ----------

const versionView = (id, versionNo, status, o = {}) => ({
  id, artifactId: 'A1', versionNo, projectId: 'p', participationId: 'PART-1', status, draftFlag: null, storageKind: 'git', contentHash: 'h',
  validationState: 'passed', producedByEngine: false, producedByAction: 'user.save_commit', createdAt: 1, statusChangedAt: 1, promotedAt: null, ...o
});
const detail = {
  artifact: { id: 'A1', projectId: 'p', kind: 'git_commit', name: 'Release', description: null, ownerScope: 'participation', ownerParticipationId: 'PART-1',
    ownerWorkspaceId: 'sde', status: 'active', currentVersionId: 'V2', createdAt: 1, updatedAt: 2 },
  versions: [versionView('V1', 1, 'deprecated', { promotedAt: 1 }), versionView('V2', 2, 'active', { promotedAt: 2 }), versionView('V3', 3, 'draft')]
};
const OTHER = 'b'.repeat(40);
const input = (o = {}) => ({
  detail, shownVersionId: 'V2', owner: { label: 'SDE', active: true },
  contents: new Map([['V1', { type: 'git', commit: OTHER }], ['V2', { type: 'git', commit: SHA }], ['V3', { type: 'text', path: 'docs/notes.md', text: 'secret-ish body' }]]),
  subjects: new Map([[SHA, 'Ship the release']]),
  names: new Map([['A1', 'Release'], ['N1', 'Notes']]),
  up: { nodes: [], truncated: false },
  down: { nodes: [{ versionId: 'NV1', artifactId: 'N1', kind: 'text_file', versionNo: 1, status: 'candidate', depth: 1, relation: 'derived_from' },
    { versionId: 'RV1', artifactId: 'R9', kind: 'handoff_receipt', versionNo: 1, status: 'active', depth: 1, relation: 'depends_on' }], truncated: true },
  ...o
});

test('passport: the artifact, its versions newest first with statuses, the current one marked', () => {
  const v = A.artifactPassportView(input());
  assert.equal(v.title, 'Release');
  assert.equal(v.kind, 'Commit');
  const rows = Object.fromEntries(v.rows.map((r) => [r.label, r.value]));
  assert.deepEqual(rows, { Kind: 'Commit', Workspace: 'SDE', 'Current version': 'Version 2', Versions: '3' });
  assert.deepEqual(v.versions.map((x) => [x.versionNo, x.status, x.current, x.shown]), [[3, 'draft', false, false], [2, 'active', true, true], [1, 'deprecated', false, false]]);
});

test('passport: git versions show the full SHA; the subject only when the project git log knows the commit', () => {
  const v = A.artifactPassportView(input());
  const byNo = Object.fromEntries(v.versions.map((x) => [x.versionNo, x]));
  assert.equal(byNo[2].content, `Commit ${SHA}`);
  assert.equal(byNo[2].subject, 'Ship the release');
  assert.equal(byNo[1].content, `Commit ${OTHER}`);
  assert.equal(byNo[1].subject, null, 'not in the allow-list: no subject');
  assert.equal(byNo[3].content, 'File docs/notes.md');
  assert.equal(byNo[3].subject, null);
  assert.doesNotMatch(JSON.stringify(v), /secret-ish body/, 'the text body is not shown');
  const none = A.artifactPassportView(input({ contents: new Map() }));
  assert.ok(none.versions.every((x) => x.content === null), 'unknown content is not invented');
  const receipt = A.artifactPassportView(input({ contents: new Map([['V2', { type: 'receipt', handoffId: 'H1' }]]) }));
  assert.equal(receipt.versions[1].content, 'Received through a handoff');
});

test('passport: lineage as sources and uses, with truncated; names only from the summaries', () => {
  const v = A.artifactPassportView(input());
  assert.deepEqual(v.upstream, []);
  assert.equal(v.upstreamTruncated, false);
  assert.deepEqual(v.downstream, [
    { versionId: 'NV1', label: 'Text file Notes, version 1', relation: 'derived from', status: 'ready' },
    { versionId: 'RV1', label: 'Received, version 1', relation: 'depends on', status: 'active' }
  ]);
  assert.equal(v.downstreamTruncated, true);
  const unread = A.artifactPassportView(input({ up: null, down: null }));
  assert.deepEqual([unread.upstream, unread.downstream], [null, null]);
});

test('passport: a withdrawn owner and an archived artifact say so in words; no principal or participation id is shown', () => {
  const archived = { ...detail, artifact: { ...detail.artifact, status: 'archived', currentVersionId: null } };
  const v = A.artifactPassportView(input({ detail: archived, owner: { label: 'QA', active: false } }));
  const rows = Object.fromEntries(v.rows.map((r) => [r.label, r.value]));
  assert.equal(rows.Workspace, 'QA (withdrawn)');
  assert.equal(rows['Current version'], 'None yet');
  assert.equal(rows.Status, 'Archived');
  const text = JSON.stringify(A.artifactPassportView(input()));
  for (const leak of ['PART-1', 'user:', 'participationId', 'createdBy', 'producedByAction', 'user.save_commit']) assert.ok(!text.includes(leak), leak);
});

test('shownVersionOf: current, else latest, else nothing', () => {
  assert.deepEqual(A.shownVersionOf({ current: { id: 'c', versionNo: 2 }, latest: { id: 'l', versionNo: 3, status: 'draft' } }), { id: 'c', versionNo: 2, status: 'active', isCurrent: true });
  assert.deepEqual(A.shownVersionOf({ current: null, latest: { id: 'l', versionNo: 3, status: 'draft' } }), { id: 'l', versionNo: 3, status: 'draft', isCurrent: false });
  assert.equal(A.shownVersionOf({ current: null, latest: null }), null);
});

// ---------- the Save sheet ----------

const prow = (id, workspaceId, isPrimary, status = 'active') => ({ id, projectId: 'p', workspaceId, status, isPrimary, source: 'user' });
const IDX = P.fromRows([prow('P-QA', 'qa', false), prow('P-SDE', 'sde', true), prow('P-DL', 'dl', false, 'withdrawn')]);
const sum = (id, name, kind, part, ws, o = {}) => ({
  artifact: { id, projectId: 'p', kind, name, description: null, ownerScope: 'participation', ownerParticipationId: part, ownerWorkspaceId: ws,
    status: 'active', currentVersionId: null, createdAt: 1, updatedAt: 1, ...o },
  versionCount: 1, latest: { id: `${id}v`, versionNo: 2, status: 'draft' }, current: null
});
const ARTS = [
  sum('A-REL', 'Release', 'git_commit', 'P-SDE', 'sde'),
  sum('A-NOTES', 'notes.md', 'text_file', 'P-SDE', 'sde'),
  sum('A-QA', 'Release', 'git_commit', 'P-QA', 'qa'),
  sum('A-OLD', 'Old', 'git_commit', 'P-SDE', 'sde', { status: 'archived' })
];
const commitSrc = { kind: 'commit', sha: SHA, subject: '  Ship\tthe release  ' };

test('save: the workspace choices are the active participations, primary first; none while writes are off or legacy', () => {
  assert.deepEqual(S.workspaceChoices(IDX, 'p', true).map((c) => [c.workspaceId, c.isPrimary, c.participationId]), [['sde', true, 'P-SDE'], ['qa', false, 'P-QA']]);
  assert.deepEqual(S.workspaceChoices(IDX, 'p', false), []);
  assert.deepEqual(S.workspaceChoices(P.legacyIndex([{ id: 'p', domainId: 'web-app-dev' }]), 'p', true), []);
});

test('save: "New version of…" lists same-kind, unarchived artifacts owned by that participation', () => {
  const [sde, qa] = S.workspaceChoices(IDX, 'p', true);
  assert.deepEqual(S.existingTargets(ARTS, sde, 'git_commit').map((t) => t.artifactId), ['A-REL']);
  assert.deepEqual(S.existingTargets(ARTS, sde, 'text_file').map((t) => [t.artifactId, t.latestVersionNo]), [['A-NOTES', 2]]);
  assert.deepEqual(S.existingTargets(ARTS, qa, 'git_commit').map((t) => t.artifactId), ['A-QA']);
  assert.deepEqual(S.existingTargets(ARTS, null, 'git_commit'), []);
});

test('save: the name is prefilled from the commit subject or the file name; an existing name steers to a new version', () => {
  const choices = S.workspaceChoices(IDX, 'p', true);
  assert.equal(S.defaultName(commitSrc), 'Ship the release');
  assert.equal(S.defaultName({ kind: 'file', relPath: 'docs/api/notes.md' }), 'notes.md');
  assert.equal(S.defaultName({ kind: 'file', relPath: null }), '');
  const fresh = S.initialSaveState(commitSrc, choices, ARTS);
  assert.deepEqual(fresh, { workspaceId: 'sde', target: { mode: 'new', name: 'Ship the release' }, pending: false, error: null });
  // A file whose name already is an artifact there: the sheet opens on "New version of" that artifact.
  const file = S.initialSaveState({ kind: 'file', relPath: 'notes.md' }, choices, ARTS);
  assert.deepEqual(file.target, { mode: 'existing', artifactId: 'A-NOTES' });
  // Typing an existing name (case and spacing ignored) shows the steer.
  const typed = S.setTarget(fresh, { mode: 'new', name: '  release ' });
  const steer = S.steerTarget(typed, commitSrc, choices, ARTS);
  assert.equal(steer.artifactId, 'A-REL');
  assert.equal(S.steerText(steer.name, 'SDE'), 'An artifact named “Release” already exists in SDE. Add this as a new version of it instead of making a second one.');
  assert.equal(S.steerTarget(S.setTarget(fresh, { mode: 'new', name: 'Brand new' }), commitSrc, choices, ARTS), null);
});

test('save: changing the workspace drops an existing target not owned there', () => {
  const choices = S.workspaceChoices(IDX, 'p', true);
  const s = S.setTarget(S.initialSaveState(commitSrc, choices, ARTS), { mode: 'existing', artifactId: 'A-REL' });
  const moved = S.selectWorkspace(s, 'qa', commitSrc, choices, ARTS);
  assert.equal(moved.workspaceId, 'qa');
  assert.deepEqual(moved.target, { mode: 'new', name: 'Ship the release' });
  assert.equal(S.selectWorkspace(s, 'dl', commitSrc, choices, ARTS), s, 'a withdrawn workspace is not a choice');
  const named = S.setTarget(s, { mode: 'new', name: 'Mine' });
  assert.deepEqual(S.selectWorkspace(named, 'qa', commitSrc, choices, ARTS).target, { mode: 'new', name: 'Mine' }, 'a typed name is kept');
});

test('save: the request carries only { projectId, workspaceId, commit | relPath, target }', () => {
  const choices = S.workspaceChoices(IDX, 'p', true);
  const s = S.initialSaveState(commitSrc, choices, ARTS);
  const c = S.buildRequest('p', s, commitSrc);
  assert.deepEqual(c, { kind: 'commit', args: { projectId: 'p', workspaceId: 'sde', commit: SHA, target: { name: 'Ship the release' } } });
  assert.deepEqual(Object.keys(c.args).sort(), ['commit', 'projectId', 'target', 'workspaceId']);
  const f = S.buildRequest('p', S.setTarget(s, { mode: 'existing', artifactId: 'A-NOTES' }), { kind: 'file', relPath: 'docs\\notes.md' });
  assert.deepEqual(f, { kind: 'file', args: { projectId: 'p', workspaceId: 'sde', relPath: 'docs/notes.md', target: { artifactId: 'A-NOTES' } } });
  assert.deepEqual(Object.keys(f.args).sort(), ['projectId', 'relPath', 'target', 'workspaceId']);
  // Incomplete or unsafe: no request.
  assert.equal(S.buildRequest('p', S.setTarget(s, { mode: 'new', name: '   ' }), commitSrc), null);
  assert.equal(S.buildRequest('p', S.setTarget(s, { mode: 'new', name: 'x'.repeat(201) }), commitSrc), null);
  assert.equal(S.buildRequest('p', S.setTarget(s, { mode: 'new', name: 'a\u0007b' }), commitSrc), null);
  assert.equal(S.buildRequest('p', S.setTarget(s, { mode: 'existing', artifactId: null }), commitSrc), null);
  assert.equal(S.buildRequest('p', s, { kind: 'commit', sha: 'abc1234', subject: '' }), null, 'a short sha is not a commit id');
  assert.equal(S.buildRequest('p', { ...s, workspaceId: null }, commitSrc), null);
  for (const bad of [null, '', '/etc/passwd', 'C:/x.txt', 'c:x', '..\\up.txt', 'a/../../b', 'a//b', 'a\0b'])
    assert.equal(S.buildRequest('p', s, { kind: 'file', relPath: bad }), null, String(bad));
});

test('save: pending blocks a second submit; a failure clears pending and keeps the choices', () => {
  const s = S.initialSaveState(commitSrc, S.workspaceChoices(IDX, 'p', true), ARTS);
  assert.equal(S.beginSave(s, false), null, 'an incomplete sheet cannot submit');
  const p = S.beginSave(s, true);
  assert.equal(p.pending, true);
  assert.equal(S.beginSave(p, true), null);
  assert.equal(S.setTarget(p, { mode: 'new', name: 'other' }), p, 'nothing changes while saving');
  const f = S.saveFailed(p, 'nope');
  assert.deepEqual([f.pending, f.error, f.workspaceId, f.target.mode], [false, 'nope', 'sde', 'new']);
});

test('save: every refusal reads through errorCopy, each with its own sentence', () => {
  const reasons = ['sensitive_name', 'secret_in_content', 'too_large', 'not_text', 'path_refused', 'not_a_commit', 'not_a_repository',
    'file_not_found', 'project_folder_unavailable', 'kind_mismatch', 'secret_in_metadata'];
  const seen = new Set();
  for (const reason of reasons) {
    const text = S.saveFailureText(fail('invalid', { reason }));
    assert.equal(text, errorCopy('invalid', reason).text, reason);
    assert.notEqual(text, errorCopy('invalid').text, `${reason} has its own sentence`);
    seen.add(text);
  }
  assert.equal(seen.size, reasons.length);
  assert.match(S.saveFailureText(fail('invalid', { reason: 'path_refused' })), /cannot be saved from where it is/);
  for (const code of ['not_participating', 'participation_inactive', 'conflict', 'not_found', 'denied', 'internal'])
    assert.equal(S.saveFailureText(fail(code)), errorCopy(code).text, code);
  assert.equal(S.saveFailureText(fail('platform_unavailable', { reason: 'busy' })), errorCopy('platform_unavailable', 'busy').text);
});

test('save: failures that may mean stale screens ask for a reload; busy and plain refusals do not', () => {
  for (const r of [fail('not_found'), fail('conflict'), fail('not_participating'), fail('participation_inactive'), fail('platform_unavailable', { reason: 'held' })])
    assert.equal(S.shouldReloadAfterSave(r), true, r.code);
  for (const r of [fail('platform_unavailable', { reason: 'busy' }), fail('invalid', { reason: 'too_large' }), fail('denied'), fail('internal')])
    assert.equal(S.shouldReloadAfterSave(r), false, r.code);
});

test('save: the file chooser lists entries relative to the project root, never .git or odd names; big files are marked', () => {
  const entries = [{ name: 'src', isDir: true, size: 0 }, { name: '.git', isDir: true, size: 0 }, { name: 'README.md', isDir: false, size: 10 },
    { name: 'big.log', isDir: false, size: 70000 }, { name: '..', isDir: true, size: 0 }, { name: 'a/b', isDir: false, size: 1 }];
  assert.deepEqual(S.fileChoices('', entries).map((f) => [f.relPath, f.isDir, f.tooLarge]), [['src', true, false], ['README.md', false, false], ['big.log', false, true]]);
  assert.deepEqual(S.fileChoices('src/lib', [{ name: 'x.ts', isDir: false, size: 1 }]).map((f) => f.relPath), ['src/lib/x.ts']);
  assert.deepEqual(S.fileChoices('../out', entries), [], 'a folder outside the project lists nothing');
  assert.equal(S.parentDir('src/lib'), 'src');
  assert.equal(S.parentDir('src'), '');
});

// ---------- source pins ----------

const sheet = src('project/SaveArtifactSheet.tsx');
const passport = src('project/ArtifactPassport.tsx');
const panel = src('project/PassportPanel.tsx');

test('pin: the Save sheet renders only while writes are on and sends only through the two save channels', () => {
  assert.match(sheet, /const canWrite = usePlatform\(selectCanWrite\);/);
  assert.match(sheet, /if \(!canWrite\) return null;/);
  assert.match(sheet, /nexusClient\.artifactSaveCommit\(req\.args\) : await nexusClient\.artifactSaveTextFile\(req\.args\)/);
  assert.match(sheet, /const req = buildRequest\(project\.id, state, source\);/);
  // The renderer never reads file contents; it lists the project folder and the git log through the existing channels.
  assert.doesNotMatch(sheet, /readFile|readBinary|statAbs|writeFile/);
  assert.match(sheet, /window\.cth\.listDir\(root, dir\)/);
  assert.match(sheet, /useFolder\(project\.rootPath, dir,/);
  assert.match(sheet, /window\.cth\.gitLog\(root, 30\)/);
  assert.doesNotMatch(sheet, /\.path\b(?!\w)/, 'the absolute path listDir returns is not used');
});

test('pin: the Save sheet bumps rev before the unmount check, blocks a double submit, and cannot be closed mid-save', () => {
  assert.match(sheet, /if \(r\.ok \|\| shouldReloadAfterSave\(r\)\) bumpRev\(\);\s*if \(!alive\.current\) return;/);
  assert.equal((sheet.match(/bumpRev\(\)/g) || []).length, 1);
  assert.match(sheet, /if \(running\.current\) return;/);
  assert.match(sheet, /const next = beginSave\(state, req !== null\);\s*if \(!next \|\| !req\) return;/);
  assert.match(sheet, /const safeClose = useCallback\(\(\) => \{ if \(!pendingRef\.current\) closeRef\.current\(\); \}, \[\]\);/);
  assert.match(sheet, /<Sheet open onClose=\{safeClose\}/);
  assert.match(sheet, /disabled=\{pending \|\| request === null\}>\{pending \? 'Saving…' : 'Save'\}/);
  assert.match(sheet, /<Button disabled=\{pending\} onClick=\{safeClose\}>Cancel<\/Button>/);
  assert.match(sheet, /setState\(\(s\) => saveFailed\(s, saveFailureText\(r\)\)\)/);
  assert.match(sheet, /role="alert">\{state\.error\}/);
  assert.match(sheet, /workspaceChoices\(idx, project\.id, canWrite\)/);
  assert.match(sheet, /steerText\(steer\.name, ws\.label\)/);
});

test('pin: the artifact Passport is read-only: reads only, lineage both ways, no version action', () => {
  for (const call of ['artifactGet', 'versionGet', 'lineageGet']) assert.match(passport, new RegExp(`nexusClient\\.${call}\\(`), call);
  assert.match(passport, /direction: 'up', depth: 1/);
  assert.match(passport, /direction: 'down', depth: 1/);
  for (const write of ['versionMarkReady', 'versionPromote', 'versionDiscard', 'versionLinkSources', 'handoffSend', 'artifactSave', 'bumpRev', 'actionsFor'])
    assert.doesNotMatch(passport, new RegExp(write), write);
  assert.match(passport, /artifactPassportView\(/);
  assert.match(passport, /truncated=\{view\.upstreamTruncated\}/);
  assert.match(passport, /truncated=\{view\.downstreamTruncated\}/);
});

test('pin: the project Passport offers saving only when the bench passes onSave, and shows the artifact Passport for artifact nodes', () => {
  assert.match(panel, /if \(props\.node\.kind === 'artifact'\) return <ArtifactPassport /);
  assert.match(panel, /\{onSave && c && \(/);
  assert.match(panel, />Save as artifact<\/Button>/);
  assert.match(panel, /\{onSave && node\.kind === 'source' && <Button icon="files" onClick=\{\(\) => save\(\{ kind: 'file', relPath: null \}\)\}>Save a file…<\/Button>\}/);
  assert.match(panel, /\{p\.relationshipsNote && <p className="nx-muted">\{p\.relationshipsNote\}<\/p>\}/);
});

test('pin: the new styles use unique prefixes and existing tokens only', () => {
  const css = fs.readFileSync(path.join(NEXUS, 'styles', 'platform.css'), 'utf8');
  for (const cls of ['nx-spx-muted', 'nx-spx-state', 'nx-apx__links', 'nx-svx', 'nx-svx__steer', 'nx-svx-commit']) assert.match(css, new RegExp(`\\.${cls}\\b`), cls);
  const tokens = fs.readFileSync(path.join(NEXUS, 'styles', 'tokens.css'), 'utf8');
  for (const v of new Set(css.match(/var\(--nx-[a-z0-9-]+\)/g) || [])) assert.ok(tokens.includes(`${v.slice(4, -1)}:`), v);
});

test('the passport relationships note gives way once the project has artifacts', () => {
  const { passportFor, RELATIONSHIPS_NOTE } = loadTs('src/renderer/src/nexus/project/passport.ts');
  const project = { id: 'p', name: 'X', rootPath: 'C:/x', domainId: 'web-app-dev', detectedLanguages: [], frameworks: [], health: {} };
  const node = { kind: 'source', id: 'source', vcs: 'git', branch: 'main', head: null };
  const idx = P.legacyIndex([project]);
  assert.equal(passportFor({ project, idx, node, commits: [] }).relationshipsNote, RELATIONSHIPS_NOTE);
  assert.equal(passportFor({ project, idx, node, commits: [], hasArtifacts: true }).relationshipsNote, null);
  const artNode = { kind: 'artifact', id: 'artifact:A', artifactId: 'A', artifactKind: 'text_file', name: 'n', versionNo: 1, status: 'draft', isCurrent: false };
  assert.equal(passportFor({ project, idx, node: artNode, commits: [] }).kind, 'Text file');
});
