'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const { highlightSegments } = loadTs('src/renderer/src/nexus/launcher/highlight.ts');
const { emblemPath, EMBLEM_POINTS, EMBLEM_VIEW } = loadTs('src/renderer/src/nexus/launcher/emblems.ts');
const { typewriterText, TYPE_EXAMPLES } = loadTs('src/renderer/src/nexus/launcher/typewriter.ts');
const { WORKSPACES } = loadTs('src/renderer/src/nexus/workspaces/registry.ts');

const join = (segs) => segs.map((s) => s.text).join('');
const hits = (segs) => segs.filter((s) => s.hit).map((s) => s.text);

test('highlight: empty query is one plain segment', () => {
  assert.deepEqual(highlightSegments('Machine Learning', ''), [{ text: 'Machine Learning', hit: false }]);
  assert.deepEqual(highlightSegments('Machine Learning', '   '), [{ text: 'Machine Learning', hit: false }]);
});

test('highlight: marks the typed prefix of each matching word, case-insensitive', () => {
  const s = highlightSegments('Machine Learning', 'lea');
  assert.equal(join(s), 'Machine Learning');
  assert.deepEqual(hits(s), ['Lea']);
  assert.deepEqual(hits(highlightSegments('Deep Learning', 'DE')), ['De']);
  assert.deepEqual(hits(highlightSegments('UI / UX Design', 'u')), ['U', 'U']);
});

test('highlight: no match leaves the text untouched', () => {
  assert.deepEqual(highlightSegments('DevOps', 'model'), [{ text: 'DevOps', hit: false }]);
});

test('emblems: every workspace has a closed path with the same point count, inside the view', () => {
  const counts = new Set();
  for (const w of WORKSPACES) {
    const d = emblemPath(w.id);
    assert.match(d, /^M [\d.]+ [\d.]+( L [\d.]+ [\d.]+)+ Z$/, w.id);
    const nums = d.match(/[\d.]+/g).map(Number);
    counts.add(nums.length / 2);
    for (const n of nums) assert.ok(n >= 0 && n <= EMBLEM_VIEW, `${w.id}: ${n} outside 0..${EMBLEM_VIEW}`);
  }
  assert.deepEqual([...counts], [EMBLEM_POINTS], 'identical point counts let the shapes morph into each other');
});

test('emblems: shapes are distinct per workspace; unknown ids get the generic shape', () => {
  const paths = WORKSPACES.map((w) => emblemPath(w.id));
  assert.equal(new Set(paths).size, WORKSPACES.length);
  assert.equal(emblemPath('future-workspace'), emblemPath('generic'));
  assert.equal(emblemPath('ml'), emblemPath('ml'), 'deterministic');
});

test('typewriter: types an example, holds it, erases it, then moves to the next', () => {
  const [first, second] = TYPE_EXAMPLES;
  assert.equal(typewriterText(0), '');
  assert.equal(typewriterText(1), first.slice(0, 1));
  assert.equal(typewriterText(first.length), first);
  const states = Array.from({ length: 400 }, (_, i) => typewriterText(i));
  assert.ok(states.includes(second), 'reaches the second example');
  assert.ok(states.every((s) => TYPE_EXAMPLES.some((e) => e.startsWith(s))), 'only ever shows a prefix of an example');
});
