'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');
const { redactDetails, REDACTED } = loadTs('src/main/nexus/activity/redact.ts');
const { verifyChainRows, activityHash } = loadTs('src/main/nexus/activity/chain.ts');

test('secret-named keys are redacted at any depth', () => {
  const out = redactDetails({ apiKey: 'abc', nested: { password: 'p', Authorization: 'Bearer z' }, list: [{ token: 't' }], session_key: 'k' });
  assert.equal(out.apiKey, REDACTED); assert.equal(out.nested.password, REDACTED);
  assert.equal(out.nested.Authorization, REDACTED); assert.equal(out.list[0].token, REDACTED); assert.equal(out.session_key, REDACTED);
});
test('secret-shaped values inside ordinary keys are redacted', () => {
  const out = JSON.stringify(redactDetails({ note: 'failed with sk-ant-abcdefghijklmnopqrstuv', url: 'https://u:pw123456@h.example/x' }));
  assert.doesNotMatch(out, /sk-ant-abc|pw123456/); assert.match(out, /redacted/);
});
test('contents are never stored: long strings and binaries become markers', () => {
  const out = redactDetails({ content: 'a'.repeat(5000), file: Buffer.from('xyz') });
  assert.equal(out.content, '[omitted: 5000 chars]'); assert.equal(out.file, '[binary: 3 bytes]');
});
test('limits and odd values', () => {
  const deep = { a: { b: { c: { d: { e: 1 } } } } };
  assert.equal(redactDetails(deep).a.b.c.d, '[truncated]');
  assert.equal(redactDetails({ xs: Array.from({ length: 80 }, (_, i) => i) }).xs.length, 51);
  const out = redactDetails({ d: new Date(0), n: NaN, f() {}, s: Symbol('x') });
  assert.deepEqual(out, { d: '1970-01-01T00:00:00.000Z', n: null });
  assert.deepEqual(redactDetails(null), {}); assert.deepEqual(redactDetails(undefined), {});
  assert.deepEqual(redactDetails('plain'), { value: 'plain' });
});
test('ordinary details pass unchanged', () => {
  const d = { from: 6, to: 7, backupFile: 'harness-v6-20261006T120000Z.db', counts: { projects: 0 } };
  assert.deepEqual(redactDetails(d), d);
});
test('chain verification finds the first tampered row', () => {
  const rows = []; let prev = '0'.repeat(64);
  for (let i = 1; i <= 3; i++) {
    const r = { seq: i, id: `a${i}`, ts: i, actorKind: 'system', actorId: 'system', onBehalfOf: null, jobId: null, workspaceId: null,
      projectId: 'p', artifactId: null, versionId: null, entityType: 'x', entityId: null, action: 'x.y', status: 'succeeded', details: {} };
    const hash = activityHash(prev, { ...r, detailsJson: '{}' }); rows.push({ ...r, prevHash: prev, hash }); prev = hash;
  }
  assert.deepEqual(verifyChainRows(rows), { ok: true, rows: 3 });
  rows[1] = { ...rows[1], action: 'x.z' };
  assert.deepEqual(verifyChainRows(rows), { ok: false, brokenAtSeq: 2 });
});

// ---- additions beyond the brief's pinned cases ----
const HEX64 = 'ab'.repeat(32);
test('known integrity hash fields keep their hex value (controller ruling)', () => {
  const d = { backupSha256: HEX64, sha256: HEX64, contentHash: HEX64, content_hash: HEX64, nested: { storage: { sha256: HEX64 } } };
  assert.deepEqual(redactDetails(d), d);
});
test('the same hex under any other key is still redacted', () => {
  const out = redactDetails({ hookSecretHex: HEX64, note: `hook ${HEX64}`, hash: HEX64 });
  assert.equal(out.hookSecretHex, REDACTED);
  assert.doesNotMatch(JSON.stringify(out), new RegExp(HEX64));
});
test('an exempt hash key does not exempt a non-hex or secret-shaped value', () => {
  const out = redactDetails({ sha256: 'token=sk-ant-abcdefghijklmnopqrstuv', contentHash: 'x'.repeat(600) });
  assert.doesNotMatch(JSON.stringify(out), /sk-ant-abc/);
  assert.equal(out.contentHash, '[omitted: 600 chars]');
});
test('more secret key shapes and secret-shaped keys', () => {
  const out = redactDetails({ client_secret: 's', refreshToken: 'r', cookie: 'c', credentials: { u: 1 }, private_key: 'pk',
    'api-key': 'x', passwd: 'y', [`sk-ant-${'q'.repeat(20)}`]: 1 });
  for (const k of ['client_secret', 'refreshToken', 'cookie', 'credentials', 'private_key', 'api-key', 'passwd']) assert.equal(out[k], REDACTED, k);
  assert.doesNotMatch(JSON.stringify(out), /sk-ant-q/);
});
test('key count, cycles, errors, typed arrays and bigints are bounded and serialisable', () => {
  const many = {}; for (let i = 0; i < 80; i++) many[`k${i}`] = i;
  const outMany = redactDetails(many);
  assert.equal(Object.keys(outMany).length, 51); assert.equal(outMany.__truncated, '[truncated]');
  const cyc = { name: 'c' }; cyc.self = cyc;
  const outCyc = redactDetails(cyc);
  assert.doesNotThrow(() => JSON.stringify(outCyc));
  const outErr = redactDetails({ err: new Error('auth failed: token=abc123secret'), u8: new Uint8Array(7), big: 10n, inf: Infinity, nd: new Date(NaN) });
  assert.equal(outErr.err.message.includes('abc123secret'), false);
  assert.equal(outErr.u8, '[binary: 7 bytes]'); assert.equal(outErr.big, '10'); assert.equal(outErr.inf, null); assert.equal(outErr.nd, null);
  assert.deepEqual(redactDetails([1, 'a']), { value: [1, 'a'] });
  assert.deepEqual(redactDetails(5), { value: 5 });
  assert.deepEqual(redactDetails('Bearer abcdefghijkl'), { value: 'Bearer [redacted]' });
});
test('chain verification catches a broken link, a bad genesis and a details edit', () => {
  const mk = () => {
    const rows = []; let prev = '0'.repeat(64);
    for (let i = 1; i <= 3; i++) {
      const r = { seq: i, id: `a${i}`, ts: i, actorKind: 'user', actorId: 'u', onBehalfOf: null, sessionId: null, jobId: null, workspaceId: null,
        projectId: 'p', artifactId: null, versionId: null, entityType: 'x', entityId: null, action: 'x.y', status: 'succeeded', details: { n: i } };
      const hash = activityHash(prev, { ...r, detailsJson: JSON.stringify(r.details) }); rows.push({ ...r, prevHash: prev, hash }); prev = hash;
    }
    return rows;
  };
  assert.deepEqual(verifyChainRows(mk()), { ok: true, rows: 3 });
  const removed = mk(); removed.splice(1, 1);
  assert.deepEqual(verifyChainRows(removed), { ok: false, brokenAtSeq: 3 });
  const edited = mk(); edited[2] = { ...edited[2], details: { n: 99 } };
  assert.deepEqual(verifyChainRows(edited), { ok: false, brokenAtSeq: 3 });
  assert.deepEqual(verifyChainRows(mk().slice(1)), { ok: false, brokenAtSeq: 2 });
  assert.deepEqual(verifyChainRows([]), { ok: true, rows: 0 });
});
