'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const guard = require('./helpers/identityGuard.cjs');
const ROOT = path.resolve(__dirname, '..');
const walk = (d) => !fs.existsSync(d) ? [] : fs.readdirSync(d, { withFileTypes: true })
  .flatMap((e) => e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]);
const files = () => [
  ...walk(path.join(ROOT, 'src/main/nexus')), ...walk(path.join(ROOT, 'src/shared/nexus')),
  ...fs.readdirSync(__dirname).filter((f) => /^nexus-(db|platform|core)-.+\.test\.cjs$/.test(f)).map((f) => path.join(__dirname, f)),
  ...['helpers/sqlite.cjs', 'helpers/migrate-and-die.cjs', 'helpers/register-worker.cjs'].map((f) => path.join(__dirname, f)),
  ...['tools/run-electron-tests.cjs', 'tools/nexus-db-restore.cjs', 'docs/nexus/platform-core.md'].map((f) => path.join(ROOT, f))
].filter((f) => fs.existsSync(f));

test('no brand or persona identity in any B0b file (code, comments, fixtures, seeds, docs)', () => {
  const hits = files().flatMap((f) => guard.scanText(fs.readFileSync(f, 'utf8'))
    .filter((x) => x.rule === 'brand' || x.rule === 'persona')
    .map((x) => `${path.relative(ROOT, f)}: ${x.match}`));
  assert.deepEqual(hits, []);
});
test('the scan sees the harness files', () => {
  assert.ok(files().some((f) => f.endsWith('helpers' + path.sep + 'sqlite.cjs')));
});
