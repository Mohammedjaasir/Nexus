'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');
const { selectionLabel } = loadTs('src/renderer/src/nexus/intent/intentContext.ts');
const { buildContextHeader } = loadTs('src/renderer/src/nexus/assistant/context.ts');

test('selectionLabel', () => {
  assert.equal(selectionLabel(null), null);
  assert.equal(selectionLabel({ kind: 'changes', label: 'Uncommitted changes, 3 files' }), 'Uncommitted changes, 3 files');
});

test('context header carries the selection', () => {
  const h = buildContextHeader({ workspace: 'ML', project: { name: 'OCR', rootPath: '/w/ocr' }, page: 'Changes', selection: 'Uncommitted changes, 3 files' });
  assert.equal(h, '[Nexus context: workspace ML; project OCR (/w/ocr); page Changes; selected Uncommitted changes, 3 files]');
});

test('no context yields no header', () => {
  assert.equal(buildContextHeader({}), null);
});
