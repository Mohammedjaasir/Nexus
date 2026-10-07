'use strict';
// Pinned source rule (B1 Task 1, fix round 1). recursive_triggers is off, so
// INSERT OR REPLACE / REPLACE INTO / UPDATE OR REPLACE delete the conflicting row
// without firing its BEFORE DELETE guard, and an upsert's DO UPDATE rewrites a row in a
// way the schema is not meant to allow. Either could swap a handoff subject, an activity
// row or a version underneath its triggers. So no platform code may aim them at an
// append-only or immutable table. INSERT OR IGNORE is fine: it never deletes or rewrites.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', 'src', 'main', 'nexus');
const PROTECTED = new Set(['activity', 'artifact_versions', 'artifact_edges', 'handoffs', 'handoff_subjects', 'job_inputs', 'jobs',
  'agent_sessions', 'nexus_migrations']);
// "<file relative to src/main/nexus>:<table>" entries that are allowed, each with a reason.
// Empty: at e2fceec plus Task 1 no platform code uses OR REPLACE or DO UPDATE at all.
const ALLOW = new Map([]);

function tsFiles(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...tsFiles(p));
    else if (e.name.endsWith('.ts')) out.push(p);
  }
  return out;
}
const ident = '"?([A-Za-z_][A-Za-z0-9_]*)"?';
/** Every replacing or upserting write in a source text, with the table it targets ('?' when it cannot be read). */
function replacingWrites(text) {
  const hits = [];
  const replace = new RegExp(`\\b(?:INSERT\\s+OR\\s+REPLACE\\s+INTO|REPLACE\\s+INTO|UPDATE\\s+OR\\s+REPLACE)\\s+${ident}`, 'gi');
  let m;
  while ((m = replace.exec(text))) hits.push({ kind: 'replace', table: m[1].toLowerCase(), at: m.index });
  const bareOrReplace = /\bOR\s+REPLACE\b/gi;
  while ((m = bareOrReplace.exec(text))) {
    if (!hits.some((h) => h.kind === 'replace' && m.index >= h.at && m.index - h.at < 20)) hits.push({ kind: 'replace', table: '?', at: m.index });
  }
  const upsert = /\bDO\s+UPDATE\b/gi;
  while ((m = upsert.exec(text))) {
    const before = text.slice(0, m.index);
    const inserts = [...before.matchAll(new RegExp(`\\bINSERT\\s+(?:OR\\s+[A-Z]+\\s+)?INTO\\s+${ident}`, 'gi'))];
    const last = inserts[inserts.length - 1];
    hits.push({ kind: 'upsert', table: last ? last[1].toLowerCase() : '?', at: m.index });
  }
  return hits;
}

/** Block comments and whole-line // comments are prose (schemaV8.ts documents this very rule); code is scanned. */
const stripComments = (text) => text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');

test('the scanner itself catches every replacing form (no vacuous pass)', () => {
  const tables = (sql) => replacingWrites(sql).map((h) => h.table);
  assert.deepEqual(tables('INSERT OR REPLACE INTO handoff_subjects (a) VALUES (1)'), ['handoff_subjects']);
  assert.deepEqual(tables('REPLACE INTO activity (a) VALUES (1)'), ['activity']);
  assert.deepEqual(tables('UPDATE OR REPLACE "jobs" SET a = 1'), ['jobs']);
  assert.deepEqual(tables('INSERT INTO handoffs (id) VALUES (?)\n ON CONFLICT (id) DO UPDATE SET title = excluded.title'), ['handoffs']);
  assert.deepEqual(tables('INSERT OR IGNORE INTO nexus_migrations (version) VALUES (8)'), []);
  assert.deepEqual(tables('INSERT INTO jobs (id) VALUES (?) ON CONFLICT DO NOTHING'), []);
  assert.deepEqual(tables(stripComments('/* REPLACE INTO jobs */\n  db.exec("REPLACE INTO jobs (id) VALUES (1)")')), ['jobs']);
});

test('no OR REPLACE or DO UPDATE aimed at an append-only or immutable platform table under src/main/nexus', () => {
  const files = tsFiles(ROOT);
  assert.ok(files.length > 20, 'the platform sources were found');
  const bad = [];
  for (const f of files) {
    const rel = path.relative(ROOT, f).split(path.sep).join('/');
    for (const h of replacingWrites(stripComments(fs.readFileSync(f, 'utf8')))) {
      if (ALLOW.has(`${rel}:${h.table}`)) continue;
      if (h.table === '?' || PROTECTED.has(h.table)) bad.push(`${rel}: ${h.kind} on ${h.table}`);
    }
  }
  assert.deepEqual(bad, []);
});
