'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');
const { passportFor } = loadTs('src/renderer/src/nexus/project/passport.ts');

const project = { name: 'Invoice OCR', rootPath: 'C:/work/ocr', domainId: 'ai-ml', detectedLanguages: [{ language: 'Python', percentage: 81 }], frameworks: ['FastAPI'], health: { healthScore: 72 } };
const source = { kind: 'source', id: 'source', vcs: 'git', branch: 'main', head: { shortSha: 'abc1234', subject: 'Fix totals' } };

test('repository passport uses only real fields', () => {
  const p = passportFor({ project, node: source, commits: [{ shortSha: 'abc1234', subject: 'Fix totals', time: 1 }, { shortSha: 'def5678', subject: 'Init', time: 0 }] });
  assert.equal(p.kind, 'Repository');
  const rows = Object.fromEntries(p.sections.flatMap((s) => s.rows).map((r) => [r.label, r.value]));
  assert.equal(rows['Location'], 'C:/work/ocr');
  assert.equal(rows['Workspace'], 'ML');
  assert.equal(rows['Languages'], 'Python');
  assert.equal(rows['Frameworks'], 'FastAPI');
  assert.equal(rows['Repo health'], '72 of 100');
  assert.deepEqual(p.versions.map((v) => [v.id, v.current]), [['abc1234', true], ['def5678', false]]);
  assert.deepEqual(p.actions, ['ask', 'files', 'terminal', 'refresh']);
});

test('missing values are omitted, never invented', () => {
  const p = passportFor({ project: { ...project, detectedLanguages: [], frameworks: [], health: {} }, node: { ...source, vcs: 'none', branch: null, head: null }, commits: [] });
  const labels = p.sections.flatMap((s) => s.rows).map((r) => r.label);
  assert.ok(!labels.includes('Languages'));
  assert.ok(!labels.includes('Frameworks'));
  assert.ok(!labels.includes('Repo health'));
  assert.equal(p.kind, 'Folder');
  assert.deepEqual(p.versions, []);
});

test('relationships are explained, not faked; no unsupported actions', () => {
  const p = passportFor({ project, node: source, commits: [] });
  assert.match(p.relationshipsNote, /artifacts/i);
  for (const a of ['handoff', 'turn-into-app', 'test', 'create-api']) assert.ok(!p.actions.includes(a));
});
