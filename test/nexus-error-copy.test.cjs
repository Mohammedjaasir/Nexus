// test/nexus-error-copy.test.cjs
// R8: every nexus:* error code and every reason in the IPC table has plain copy; no raw code is ever shown.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const E = loadTs('src/renderer/src/nexus/data/errorCopy.ts');
const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

/** The string literals of a `export type Name = 'a' | 'b' ...;` union in a source file. */
function unionOf(file, name) {
  const src = read(file);
  const m = src.match(new RegExp(`export type ${name} =([^;]+);`));
  assert.ok(m, `${name} in ${file}`);
  return [...m[1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1]);
}

const CODES = [...unionOf('src/shared/nexus/platform.ts', 'PlatformErrorCode'), 'internal'];
const UNAVAILABLE = unionOf('src/shared/nexus/ipc.ts', 'PlatformUnavailableReason');
const HANDOFF_SUBS = unionOf('src/shared/nexus/ipc.ts', 'HandoffsUnavailableSubReason');
// The service reasons in the IPC table (channels #9, #10, #11) plus bad_request from validation.
const SERVICE = ['bad_request', 'not_a_repository', 'not_a_commit', 'project_folder_unavailable', 'kind_mismatch', 'secret_in_metadata',
  'file_not_found', 'path_refused', 'too_large', 'not_text', 'secret_in_content', 'sensitive_name', 'produced_by_job'];

/** A shown sentence: non-empty, one line, ends with a full stop, and holds no snake_case token. */
function plain(text, what) {
  assert.equal(typeof text, 'string', what);
  assert.ok(text.trim().length > 10, what);
  assert.doesNotMatch(text, /\n/, what);
  assert.match(text, /\.$/, what);
  assert.doesNotMatch(text, /\b[a-z]+_[a-z_]+\b/, `${what}: ${text}`);
}

test('R8 every NexusErrorCode has its own plain sentence that never names the code', () => {
  assert.deepEqual([...E.NEXUS_ERROR_CODES].sort(), [...CODES].sort());
  for (const code of CODES) {
    const c = E.errorCopy(code);
    plain(c.text, code);
    assert.doesNotMatch(c.text, new RegExp(`\\b${code.replace(/_/g, '[ _]')}\\b`, 'i'), `${code}: ${c.text}`);
  }
});

test('R8 every platform-unavailable reason has a notice; busy is "try again", not the degraded mode', () => {
  assert.deepEqual([...E.UNAVAILABLE_REASONS].sort(), [...UNAVAILABLE].sort());
  for (const r of UNAVAILABLE) {
    const c = E.errorCopy('platform_unavailable', r);
    plain(c.text, r);
    assert.equal(c.kind, 'unavailable', r);
    assert.equal(c.retry, false, r);
    assert.match(c.text, /grouped by their detected domain/, r);
  }
  assert.equal(E.unavailableNotice('held'),
    'Workspace data is not available because the database upgrade is held. Projects are grouped by their detected domain until it runs.');
  // True at startup and mid-session alike.
  assert.equal(E.unavailableNotice('startup_failed'),
    'Workspace data is not available because the workspace database could not be read. Projects are grouped by their detected domain until it runs.');
  assert.doesNotMatch(E.unavailableNotice('startup_failed'), /did not start/);
  const busy = E.errorCopy('platform_unavailable', 'busy');
  assert.deepEqual([busy.kind, busy.retry], ['busy', true]);
  assert.match(busy.text, /try again/i);
  assert.doesNotMatch(busy.text, /grouped by/);
  plain(E.errorCopy('platform_unavailable', 'something_new').text, 'unknown unavailable reason');
  plain(E.errorCopy('platform_unavailable').text, 'no reason');
});

test('R8 handoffs_unavailable affects only handoffs, with every sub-reason covered', () => {
  assert.deepEqual([...E.HANDOFFS_SUB_REASONS].sort(), [...HANDOFF_SUBS].sort());
  for (const s of [...HANDOFF_SUBS, null, 'unknown_sub']) {
    const c = E.errorCopy('platform_unavailable', 'handoffs_unavailable', s);
    plain(c.text, `handoffs ${s}`);
    assert.equal(c.kind, 'handoffs_unavailable');
    assert.match(c.text, /^Handoffs are not available/);
    assert.doesNotMatch(c.text, /Workspace data|grouped by/);
  }
});

test('R8 every service reason in the IPC table has a sentence; internal may be retried', () => {
  assert.deepEqual([...E.SERVICE_REASONS].sort(), [...SERVICE].sort());
  for (const r of SERVICE) {
    const c = E.errorCopy('invalid', r);
    plain(c.text, r);
    assert.equal(c.kind, 'refused');
    if (r !== 'bad_request') assert.notEqual(c.text, E.errorCopy('invalid').text, `${r} has its own sentence`);
  }
  assert.deepEqual([E.errorCopy('internal').kind, E.errorCopy('internal').retry], ['internal', true]);
  plain(E.errorCopy('some_future_code').text, 'unknown code');
  plain(E.errorCopy('invalid', 'some_future_reason').text, 'unknown reason falls back to the code');
});
