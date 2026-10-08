'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const loadTs = require('./load-ts.cjs');

const ROOT = path.resolve(__dirname, '..');
const BASE = '64682eab10972f2311b0b65c7cbfb2826dec26a5';
const FORBIDDEN = ['character', 'leadCharacter', 'departmentName', 'departmentRoom'];

function listTs(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...listTs(p));
    else if (/\.tsx?$/.test(e.name)) out.push(p);
  }
  return out;
}

const FILES = [path.join(ROOT, 'src/shared/domain.ts'), ...listTs(path.join(ROOT, 'src/shared/nexus'))];

test('RC-a shared domain registry files import nothing from src/renderer', () => {
  for (const f of FILES) {
    const src = fs.readFileSync(f, 'utf8');
    const specs = [...src.matchAll(/(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g)].map((m) => m[1]);
    for (const s of specs) {
      assert.ok(!/renderer/.test(s), `${path.relative(ROOT, f)} imports ${s}`);
      if (s.startsWith('.')) {
        const target = path.resolve(path.dirname(f), s);
        assert.ok(!target.startsWith(path.join(ROOT, 'src/renderer')), `${path.relative(ROOT, f)} reaches the renderer via ${s}`);
      }
    }
  }
});

test('RC-b no persona property declaration or object key in the shared registry files', () => {
  const re = new RegExp(String.raw`(^|[\s{,;])(${FORBIDDEN.join('|')})\??\s*:`);
  for (const f of FILES) {
    const lines = fs.readFileSync(f, 'utf8').split(/\r?\n/);
    lines.forEach((line, i) => {
      const code = line.replace(/\/\/.*$/, '').replace(/'[^']*'|"[^"]*"|`[^`]*`/g, "''");
      assert.ok(!re.test(code), `${path.relative(ROOT, f)}:${i + 1} declares a persona property: ${line.trim()}`);
    });
  }
});

test('RC-c at runtime no role and no domain carries a persona key', () => {
  const mod = loadTs('src/shared/domain.ts');
  const domains = Object.values(mod.INITIAL_DOMAINS);
  assert.ok(domains.length > 0);
  assert.ok(domains.some((d) => d.agentRoles.length > 0));
  for (const d of domains) {
    for (const k of FORBIDDEN) assert.ok(!(k in d), `domain ${d.id} has ${k}`);
    for (const r of d.agentRoles) {
      for (const k of FORBIDDEN) assert.ok(!(k in r), `role ${r.roleId} has ${k}`);
    }
  }
});

test('RC-d the identity guard known-leaks list has not grown since the base commit', () => {
  const count = (j) => Object.values(j.knownLeaks || {}).reduce((n, xs) => n + xs.length, 0);
  const base = JSON.parse(execFileSync('git', ['show', `${BASE}:test/nexus-identity-leaks.json`], { cwd: ROOT, encoding: 'utf8' }));
  const now = JSON.parse(fs.readFileSync(path.join(ROOT, 'test/nexus-identity-leaks.json'), 'utf8'));
  assert.ok(count(now) <= count(base), `known leaks grew from ${count(base)} to ${count(now)}`);
});
