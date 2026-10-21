/**
 * Schema v10 (B2b): the claims of each per-turn capability token (never the token text, never its MAC),
 * user reviews of change-set candidates, accepted change sets with the job that accepted them, dialog-confirmed
 * merges with the confirmed sha, the runtime consent capped at the D-B4 values, and one worktree per agent session.
 * Additive only: every statement is CREATE ... IF NOT EXISTS; nothing in v1-v9 is altered, no v1-v9 row is
 * rewritten, no FK is added to a v1-v9 table, and no trigger or index is put on a v1-v9 table. v10 inserts no rows.
 *
 * V10_DDL is shipped migration text once v10 runs on a real database: never edit it then - later changes go in a
 * new migration. It is a plain template literal with no interpolation, so the docs (DOC10-1) and the append-only
 * source rule can read it as text. The one `'%\%'` LIKE pattern (the B2a path CHECK) is written `\\%` below so
 * the SQL text keeps its backslash.
 *
 * Binding decisions carried by the CHECKs and triggers:
 *   - D-B4: the consent ceilings ($2 a turn, $10 a day, 6 turns an hour, 1 concurrent turn, 400k tokens a turn,
 *     200 tool calls) are CHECKs, so a grant can only lower them (values in v10Seed.ts, pinned by the test).
 *   - D-B13: Nexus refs live only under refs/nexus/* (refs/nexus/job/* and refs/nexus/accepted/<branch>).
 *     Ref columns also refuse what git itself refuses in a ref name (`..`, `@{`, `.lock`, control characters,
 *     space, `~^:?*[\`, a component starting with `.`, an empty component, a trailing `/` or `.`).
 *   - Tokens are opaque: the row holds the claims keyed by the jti. The raw token and its MAC are never stored.
 *
 * applyV10 runs inside the caller's single BEGIN IMMEDIATE transaction:
 *   exact v7 shape -> exact v8 shape -> exact v9 shape -> v10 shape pre-check -> DDL ->
 *   nexus_migrations record -> one activity row (only when the record is new) -> verifyV10.
 * Any throw rolls the whole step back. user_version is the caller's (Task 3 wires the step into db.ts).
 *
 * Known limit of the triggers (as v8 and v9): recursive_triggers is off, so INSERT OR REPLACE (and an upsert's
 * DO UPDATE) on a protected table deletes or rewrites the old row without firing its BEFORE DELETE / BEFORE UPDATE
 * guard. That is closed as a pinned source rule: test/nexus-core-append-only-writes.test.cjs derives its protected
 * set from V7_DDL to V10_DDL. INSERT OR IGNORE is fine: it never deletes.
 */
import type Database from 'better-sqlite3';
import type { MigrationContext } from './migrationTypes';
import { ddlObjects, normaliseSql, v7ShapeProblem, type V7DdlObject } from './schemaV7';
import { v8ShapeProblem } from './schemaV8';
import { v9ShapeProblem } from './schemaV9';
import { appendActivityRow } from '../activity/writer';

export const V10_DDL: string = `
-- ===== capability tokens: the claims of each per-turn token, keyed by its jti (no token text, no MAC) =====
CREATE TABLE IF NOT EXISTS capability_tokens (
  jti           TEXT PRIMARY KEY CHECK (length(jti) = 22 AND jti NOT GLOB '*[^A-Za-z0-9_-]*'),
  job_id        TEXT NOT NULL REFERENCES jobs(id),
  session_id    TEXT NOT NULL REFERENCES agent_sessions(id),
  principal_id  TEXT NOT NULL REFERENCES principals(id),
  on_behalf_of  TEXT NOT NULL REFERENCES principals(id),
  caps_json     TEXT NOT NULL CHECK (json_valid(caps_json) AND json_type(caps_json) = 'object' AND length(caps_json) <= 8192),
  inputs_json   TEXT NOT NULL CHECK (json_valid(inputs_json) AND json_type(inputs_json) = 'array' AND length(inputs_json) <= 8192),
  tools_json    TEXT NOT NULL CHECK (json_valid(tools_json) AND json_type(tools_json) = 'array' AND length(tools_json) <= 2048),
  caps_sha256   TEXT NOT NULL CHECK (length(caps_sha256) = 64 AND caps_sha256 NOT GLOB '*[^0-9a-f]*'),
  issued_at     INTEGER NOT NULL,
  expires_at    INTEGER NOT NULL,
  revoked_at    INTEGER,
  revoke_reason TEXT CHECK (revoke_reason IS NULL OR revoke_reason IN ('job_ended','session_cancelled','restart','runner_restart','budget')),
  CHECK (expires_at > issued_at),
  CHECK ((revoked_at IS NULL) = (revoke_reason IS NULL)),
  CHECK (revoked_at IS NULL OR revoked_at >= issued_at)
);
CREATE INDEX IF NOT EXISTS ix_tokens_job ON capability_tokens(job_id);
CREATE TRIGGER IF NOT EXISTS tr_tokens_insert BEFORE INSERT ON capability_tokens
BEGIN
  SELECT RAISE(ABORT, 'a token is minted live') WHERE NEW.revoked_at IS NOT NULL;
  SELECT RAISE(ABORT, 'the token principal is the agent of its session')
    WHERE NEW.principal_id IS NOT ('agent:' || NEW.session_id)
       OR (SELECT kind FROM principals WHERE id = NEW.principal_id) IS NOT 'agent';
  SELECT RAISE(ABORT, 'a token is minted for an agent turn job of its session')
    WHERE NOT EXISTS (SELECT 1 FROM jobs j WHERE j.id = NEW.job_id AND j.session_id = NEW.session_id AND j.kind = 'agent.run');
  SELECT RAISE(ABORT, 'a token acts on behalf of a user')
    WHERE (SELECT kind FROM principals WHERE id = NEW.on_behalf_of) IS NOT 'user';
END;
CREATE TRIGGER IF NOT EXISTS tr_tokens_update BEFORE UPDATE ON capability_tokens
BEGIN
  SELECT RAISE(ABORT, 'token identity and claims are immutable')
    WHERE NEW.jti IS NOT OLD.jti OR NEW.job_id IS NOT OLD.job_id OR NEW.session_id IS NOT OLD.session_id
       OR NEW.principal_id IS NOT OLD.principal_id OR NEW.on_behalf_of IS NOT OLD.on_behalf_of
       OR NEW.caps_json IS NOT OLD.caps_json OR NEW.inputs_json IS NOT OLD.inputs_json OR NEW.tools_json IS NOT OLD.tools_json
       OR NEW.caps_sha256 IS NOT OLD.caps_sha256 OR NEW.issued_at IS NOT OLD.issued_at OR NEW.expires_at IS NOT OLD.expires_at;
  SELECT RAISE(ABORT, 'a token revocation is recorded once')
    WHERE OLD.revoked_at IS NOT NULL AND (NEW.revoked_at IS NOT OLD.revoked_at OR NEW.revoke_reason IS NOT OLD.revoke_reason);
END;
CREATE TRIGGER IF NOT EXISTS tr_tokens_no_delete BEFORE DELETE ON capability_tokens
BEGIN SELECT RAISE(ABORT, 'capability tokens are never deleted'); END;

-- ===== reviews: a user's decision on a change-set candidate (append-only) =====
CREATE TABLE IF NOT EXISTS reviews (
  id             TEXT PRIMARY KEY,
  version_id     TEXT NOT NULL REFERENCES artifact_versions(id) ON DELETE RESTRICT,
  principal_id   TEXT NOT NULL REFERENCES principals(id),
  decision       TEXT NOT NULL CHECK (decision IN ('approve','request_changes','reject')),
  comment        TEXT CHECK (comment IS NULL OR length(comment) BETWEEN 1 AND 4000),
  comment_sha256 TEXT CHECK (comment_sha256 IS NULL OR (length(comment_sha256) = 64 AND comment_sha256 NOT GLOB '*[^0-9a-f]*')),
  intent_id      TEXT NOT NULL UNIQUE CHECK (length(intent_id) BETWEEN 1 AND 128),
  created_at     INTEGER NOT NULL,
  CHECK ((comment IS NULL) = (comment_sha256 IS NULL)),
  CHECK (decision = 'approve' OR comment IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS ix_reviews_version ON reviews(version_id, created_at);
CREATE TRIGGER IF NOT EXISTS tr_reviews_insert BEFORE INSERT ON reviews
BEGIN
  SELECT RAISE(ABORT, 'a review is decided by a user')
    WHERE (SELECT kind FROM principals WHERE id = NEW.principal_id) IS NOT 'user';
  SELECT RAISE(ABORT, 'a review decides a change-set candidate')
    WHERE NOT EXISTS (SELECT 1 FROM artifact_versions v JOIN artifacts a ON a.id = v.artifact_id
      WHERE v.id = NEW.version_id AND a.kind = 'change_set' AND v.status = 'candidate');
END;
CREATE TRIGGER IF NOT EXISTS tr_reviews_no_update BEFORE UPDATE ON reviews
BEGIN SELECT RAISE(ABORT, 'reviews are append-only'); END;
CREATE TRIGGER IF NOT EXISTS tr_reviews_no_delete BEFORE DELETE ON reviews
BEGIN SELECT RAISE(ABORT, 'reviews are append-only'); END;

-- ===== change-set accepts: one immutable row per accepted version, with the job that accepted it =====
CREATE TABLE IF NOT EXISTS change_set_accepts (
  version_id      TEXT PRIMARY KEY REFERENCES artifact_versions(id) ON DELETE RESTRICT,
  project_id      TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  integration_ref TEXT NOT NULL CHECK (integration_ref GLOB 'refs/nexus/accepted/?*' AND length(integration_ref) <= 255
                    AND integration_ref NOT GLOB '*[^!-~]*' AND integration_ref NOT GLOB '*[[~^:?*]*' AND instr(integration_ref, char(92)) = 0
                    AND integration_ref NOT LIKE '%..%' AND integration_ref NOT LIKE '%//%' AND integration_ref NOT LIKE '%/.%'
                    AND integration_ref NOT LIKE '%@{%' AND integration_ref NOT GLOB '*/' AND integration_ref NOT GLOB '*.'
                    AND integration_ref NOT GLOB '*.lock'),
  ref_before      TEXT NOT NULL CHECK (length(ref_before) = 40 AND ref_before NOT GLOB '*[^0-9a-f]*'),
  ref_after       TEXT NOT NULL CHECK (length(ref_after) = 40 AND ref_after NOT GLOB '*[^0-9a-f]*'),
  merge_commit    TEXT NOT NULL CHECK (length(merge_commit) = 40 AND merge_commit NOT GLOB '*[^0-9a-f]*'),
  accept_job_id   TEXT NOT NULL REFERENCES jobs(id),
  accepted_by     TEXT NOT NULL REFERENCES principals(id),
  accepted_at     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_accepts_project ON change_set_accepts(project_id, accepted_at);
CREATE INDEX IF NOT EXISTS ix_accepts_job     ON change_set_accepts(accept_job_id);
CREATE TRIGGER IF NOT EXISTS tr_accepts_insert BEFORE INSERT ON change_set_accepts
BEGIN
  SELECT RAISE(ABORT, 'an accept records a change set of its project')
    WHERE NOT EXISTS (SELECT 1 FROM artifact_versions v JOIN artifacts a ON a.id = v.artifact_id
      WHERE v.id = NEW.version_id AND v.project_id = NEW.project_id AND a.kind = 'change_set');
  SELECT RAISE(ABORT, 'an accepted change set version is active')
    WHERE (SELECT status FROM artifact_versions WHERE id = NEW.version_id) IS NOT 'active';
  SELECT RAISE(ABORT, 'the accept job belongs to the project')
    WHERE (SELECT project_id FROM jobs WHERE id = NEW.accept_job_id) IS NOT NEW.project_id;
  SELECT RAISE(ABORT, 'a change set is accepted by a user')
    WHERE (SELECT kind FROM principals WHERE id = NEW.accepted_by) IS NOT 'user';
END;
CREATE TRIGGER IF NOT EXISTS tr_accepts_no_update BEFORE UPDATE ON change_set_accepts
BEGIN SELECT RAISE(ABORT, 'change set accepts are immutable'); END;
CREATE TRIGGER IF NOT EXISTS tr_accepts_no_delete BEFORE DELETE ON change_set_accepts
BEGIN SELECT RAISE(ABORT, 'change set accepts are immutable'); END;

-- ===== repo merges: "Merge accepted work", a dialog-confirmed fast-forward to the confirmed sha (append-only) =====
CREATE TABLE IF NOT EXISTS repo_merges (
  id            TEXT PRIMARY KEY,
  project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  branch        TEXT NOT NULL CHECK (length(branch) BETWEEN 1 AND 255 AND branch NOT GLOB '*[^!-~]*' AND branch NOT GLOB '*[[~^:?*]*'
                  AND instr(branch, char(92)) = 0 AND branch NOT LIKE '%..%' AND branch NOT GLOB '-*' AND branch NOT GLOB 'refs/*'),
  before        TEXT NOT NULL CHECK (length(before) = 40 AND before NOT GLOB '*[^0-9a-f]*'),
  after         TEXT NOT NULL CHECK (length(after) = 40 AND after NOT GLOB '*[^0-9a-f]*'),
  sha_confirmed TEXT NOT NULL CHECK (length(sha_confirmed) = 40 AND sha_confirmed NOT GLOB '*[^0-9a-f]*'),
  merged_by     TEXT NOT NULL REFERENCES principals(id),
  merged_at     INTEGER NOT NULL,
  confirmed_via TEXT NOT NULL CHECK (confirmed_via = 'dialog'),
  ff_job_id     TEXT NOT NULL REFERENCES jobs(id),
  CHECK (after = sha_confirmed)
);
CREATE INDEX IF NOT EXISTS ix_merges_project ON repo_merges(project_id, merged_at);
CREATE TRIGGER IF NOT EXISTS tr_merges_insert BEFORE INSERT ON repo_merges
BEGIN
  SELECT RAISE(ABORT, 'a merge is confirmed by a user')
    WHERE (SELECT kind FROM principals WHERE id = NEW.merged_by) IS NOT 'user';
  SELECT RAISE(ABORT, 'the fast-forward job belongs to the project')
    WHERE NEW.ff_job_id IS NOT NULL AND (SELECT project_id FROM jobs WHERE id = NEW.ff_job_id) IS NOT NEW.project_id;
END;
CREATE TRIGGER IF NOT EXISTS tr_merges_no_update BEFORE UPDATE ON repo_merges
BEGIN SELECT RAISE(ABORT, 'repo merges are append-only'); END;
CREATE TRIGGER IF NOT EXISTS tr_merges_no_delete BEFORE DELETE ON repo_merges
BEGIN SELECT RAISE(ABORT, 'repo merges are append-only'); END;

-- ===== runtime consents: the user's grant of the agent runtime, within the D-B4 ceilings; one live consent =====
CREATE TABLE IF NOT EXISTS runtime_consents (
  id               TEXT PRIMARY KEY,
  runtime_kind     TEXT NOT NULL CHECK (length(runtime_kind) BETWEEN 1 AND 32),
  hosts_json       TEXT NOT NULL CHECK (json_valid(hosts_json) AND json_type(hosts_json) = 'array' AND json_array_length(hosts_json) >= 1
                     AND length(hosts_json) <= 1024),
  hosts_sha256     TEXT NOT NULL CHECK (length(hosts_sha256) = 64 AND hosts_sha256 NOT GLOB '*[^0-9a-f]*'),
  turn_usd_cents   INTEGER NOT NULL CHECK (turn_usd_cents BETWEEN 1 AND 200),
  day_usd_cents    INTEGER NOT NULL CHECK (day_usd_cents BETWEEN 1 AND 1000),
  turns_per_hour   INTEGER NOT NULL CHECK (turns_per_hour BETWEEN 1 AND 6),
  concurrent_turns INTEGER NOT NULL CHECK (concurrent_turns = 1),
  turn_tokens      INTEGER NOT NULL CHECK (turn_tokens BETWEEN 1 AND 400000),
  tool_calls       INTEGER NOT NULL CHECK (tool_calls BETWEEN 1 AND 200),
  granted_by       TEXT NOT NULL REFERENCES principals(id),
  granted_at       INTEGER NOT NULL,
  revoked_at       INTEGER,
  revoked_by       TEXT REFERENCES principals(id),
  CHECK (turn_usd_cents <= day_usd_cents),
  CHECK ((revoked_at IS NULL) = (revoked_by IS NULL)),
  CHECK (revoked_at IS NULL OR revoked_at >= granted_at)
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_consent_live ON runtime_consents((revoked_at IS NULL)) WHERE revoked_at IS NULL;
CREATE TRIGGER IF NOT EXISTS tr_consents_insert BEFORE INSERT ON runtime_consents
BEGIN
  SELECT RAISE(ABORT, 'a consent is granted live') WHERE NEW.revoked_at IS NOT NULL OR NEW.revoked_by IS NOT NULL;
  SELECT RAISE(ABORT, 'a consent is granted by a user')
    WHERE (SELECT kind FROM principals WHERE id = NEW.granted_by) IS NOT 'user';
END;
CREATE TRIGGER IF NOT EXISTS tr_consents_update BEFORE UPDATE ON runtime_consents
BEGIN
  SELECT RAISE(ABORT, 'a consent grant is immutable; its revocation is recorded once')
    WHERE NEW.id IS NOT OLD.id OR NEW.runtime_kind IS NOT OLD.runtime_kind OR NEW.hosts_json IS NOT OLD.hosts_json
       OR NEW.hosts_sha256 IS NOT OLD.hosts_sha256 OR NEW.turn_usd_cents IS NOT OLD.turn_usd_cents
       OR NEW.day_usd_cents IS NOT OLD.day_usd_cents OR NEW.turns_per_hour IS NOT OLD.turns_per_hour
       OR NEW.concurrent_turns IS NOT OLD.concurrent_turns OR NEW.turn_tokens IS NOT OLD.turn_tokens
       OR NEW.tool_calls IS NOT OLD.tool_calls OR NEW.granted_by IS NOT OLD.granted_by OR NEW.granted_at IS NOT OLD.granted_at
       OR (OLD.revoked_at IS NOT NULL AND (NEW.revoked_at IS NOT OLD.revoked_at OR NEW.revoked_by IS NOT OLD.revoked_by));
  SELECT RAISE(ABORT, 'a consent is revoked by a user or the system')
    WHERE NEW.revoked_by IS NOT NULL AND COALESCE((SELECT kind FROM principals WHERE id = NEW.revoked_by), '') NOT IN ('user','system');
END;
CREATE TRIGGER IF NOT EXISTS tr_consents_no_delete BEFORE DELETE ON runtime_consents
BEGIN SELECT RAISE(ABORT, 'consents are never deleted'); END;

-- ===== session worktrees: one locked worktree per agent session, under the Nexus data folder =====
CREATE TABLE IF NOT EXISTS session_worktrees (
  session_id      TEXT PRIMARY KEY REFERENCES agent_sessions(id),
  project_id      TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  rel_path        TEXT NOT NULL CHECK (rel_path GLOB 'wt/?*' AND length(rel_path) <= 200 AND rel_path NOT LIKE '/%'
                    AND rel_path NOT LIKE '%:%' AND rel_path NOT LIKE '%..%' AND rel_path NOT LIKE '%\\%'),
  ref             TEXT NOT NULL CHECK (ref GLOB 'refs/nexus/job/?*' AND length(ref) <= 255
                    AND ref NOT GLOB '*[^!-~]*' AND ref NOT GLOB '*[[~^:?*]*' AND instr(ref, char(92)) = 0
                    AND ref NOT LIKE '%..%' AND ref NOT LIKE '%//%' AND ref NOT LIKE '%/.%'
                    AND ref NOT LIKE '%@{%' AND ref NOT GLOB '*/' AND ref NOT GLOB '*.' AND ref NOT GLOB '*.lock'),
  integration_ref TEXT NOT NULL CHECK (integration_ref GLOB 'refs/nexus/accepted/?*' AND length(integration_ref) <= 255
                    AND integration_ref NOT GLOB '*[^!-~]*' AND integration_ref NOT GLOB '*[[~^:?*]*' AND instr(integration_ref, char(92)) = 0
                    AND integration_ref NOT LIKE '%..%' AND integration_ref NOT LIKE '%//%' AND integration_ref NOT LIKE '%/.%'
                    AND integration_ref NOT LIKE '%@{%' AND integration_ref NOT GLOB '*/' AND integration_ref NOT GLOB '*.'
                    AND integration_ref NOT GLOB '*.lock'),
  base_commit     TEXT NOT NULL CHECK (length(base_commit) = 40 AND base_commit NOT GLOB '*[^0-9a-f]*'),
  locked          INTEGER NOT NULL CHECK (locked IN (0,1)),
  created_at      INTEGER NOT NULL,
  removed_at      INTEGER,
  reused_from_session_id TEXT UNIQUE REFERENCES session_worktrees(session_id),
  CHECK (removed_at IS NULL OR removed_at >= created_at),
  CHECK (reused_from_session_id IS NULL OR reused_from_session_id <> session_id)
);
CREATE INDEX IF NOT EXISTS ix_worktrees_project ON session_worktrees(project_id);
CREATE TRIGGER IF NOT EXISTS tr_worktrees_insert BEFORE INSERT ON session_worktrees
BEGIN
  SELECT RAISE(ABORT, 'a worktree belongs to the project of its session')
    WHERE (SELECT project_id FROM agent_sessions WHERE id = NEW.session_id) IS NOT NEW.project_id;
  SELECT RAISE(ABORT, 'a worktree is recorded live') WHERE NEW.removed_at IS NOT NULL;
  SELECT RAISE(ABORT, 'a new worktree is named after its session')
    WHERE NEW.reused_from_session_id IS NULL AND (NEW.rel_path IS NOT ('wt/' || lower(NEW.session_id))
       OR NEW.ref IS NOT ('refs/nexus/job/' || lower(NEW.session_id)));
  SELECT RAISE(ABORT, 'a worktree is reused only from a live worktree of an interrupted session in this project, at the same path')
    WHERE NEW.reused_from_session_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM session_worktrees p JOIN agent_sessions s ON s.id = p.session_id
      WHERE p.session_id = NEW.reused_from_session_id AND p.project_id = NEW.project_id AND p.rel_path = NEW.rel_path
        AND p.removed_at IS NULL AND s.status = 'interrupted');
END;
CREATE TRIGGER IF NOT EXISTS tr_worktrees_update BEFORE UPDATE ON session_worktrees
WHEN NEW.session_id IS NOT OLD.session_id OR NEW.project_id IS NOT OLD.project_id OR NEW.rel_path IS NOT OLD.rel_path
  OR NEW.ref IS NOT OLD.ref OR NEW.integration_ref IS NOT OLD.integration_ref OR NEW.base_commit IS NOT OLD.base_commit
  OR NEW.created_at IS NOT OLD.created_at OR NEW.reused_from_session_id IS NOT OLD.reused_from_session_id
  OR OLD.removed_at IS NOT NULL
BEGIN SELECT RAISE(ABORT, 'worktree identity is immutable and a removed worktree is frozen'); END;
CREATE TRIGGER IF NOT EXISTS tr_worktrees_no_delete BEFORE DELETE ON session_worktrees
BEGIN SELECT RAISE(ABORT, 'worktrees are never deleted'); END;
`;

/** Every v10 table with its columns in declaration order (checked against PRAGMA table_info). */
export const V10_EXPECTED: { tables: Record<string, string[]>; indexes: string[]; triggers: string[] } = {
  tables: {
    capability_tokens: ['jti', 'job_id', 'session_id', 'principal_id', 'on_behalf_of', 'caps_json', 'inputs_json', 'tools_json', 'caps_sha256',
      'issued_at', 'expires_at', 'revoked_at', 'revoke_reason'],
    reviews: ['id', 'version_id', 'principal_id', 'decision', 'comment', 'comment_sha256', 'intent_id', 'created_at'],
    change_set_accepts: ['version_id', 'project_id', 'integration_ref', 'ref_before', 'ref_after', 'merge_commit', 'accept_job_id', 'accepted_by',
      'accepted_at'],
    repo_merges: ['id', 'project_id', 'branch', 'before', 'after', 'sha_confirmed', 'merged_by', 'merged_at', 'confirmed_via', 'ff_job_id'],
    runtime_consents: ['id', 'runtime_kind', 'hosts_json', 'hosts_sha256', 'turn_usd_cents', 'day_usd_cents', 'turns_per_hour', 'concurrent_turns',
      'turn_tokens', 'tool_calls', 'granted_by', 'granted_at', 'revoked_at', 'revoked_by'],
    session_worktrees: ['session_id', 'project_id', 'rel_path', 'ref', 'integration_ref', 'base_commit', 'locked', 'created_at', 'removed_at',
      'reused_from_session_id']
  },
  indexes: ['ix_tokens_job', 'ix_reviews_version', 'ix_accepts_project', 'ix_accepts_job', 'ix_merges_project', 'ux_consent_live', 'ix_worktrees_project'],
  triggers: [
    'tr_tokens_insert', 'tr_tokens_update', 'tr_tokens_no_delete',
    'tr_reviews_insert', 'tr_reviews_no_update', 'tr_reviews_no_delete',
    'tr_accepts_insert', 'tr_accepts_no_update', 'tr_accepts_no_delete',
    'tr_merges_insert', 'tr_merges_no_update', 'tr_merges_no_delete',
    'tr_consents_insert', 'tr_consents_update', 'tr_consents_no_delete',
    'tr_worktrees_insert', 'tr_worktrees_update', 'tr_worktrees_no_delete'
  ]
};

const V10_OBJECTS: V7DdlObject[] = ddlObjects(V10_DDL);
const V10_TABLES = new Set(Object.keys(V10_EXPECTED.tables));
/** Not compared with the pre-counts: the migration itself writes them (or SQLite does). */
const COUNT_EXEMPT = new Set(['activity', 'nexus_migrations', 'sqlite_sequence']);
const quoteIdent = (name: string): string => `"${name.replace(/"/g, '""')}"`;
const countOf = (db: Database.Database, table: string): number =>
  (db.prepare(`SELECT COUNT(*) AS n FROM ${quoteIdent(table)}`).get() as { n: number }).n;
const columnsOf = (db: Database.Database, table: string): string[] =>
  (db.prepare(`PRAGMA table_info(${quoteIdent(table)})`).all() as Array<{ name: string }>).map((c) => c.name);

/**
 * The first difference between the database and the v10 definition, or null.
 * Same rules as v7ShapeProblem to v9ShapeProblem: tables by columns (in order), every table, index and trigger by
 * its stored definition. With `exact` true every v10 object must exist; with `exact` false only the v10 objects that
 * already exist are checked (the pre-check before IF NOT EXISTS). It checks only v10 objects; v7 to v9 have their own.
 */
export function v10ShapeProblem(db: Database.Database, exact = true): string | null {
  const rows = db.prepare('SELECT type, name, tbl_name, sql FROM sqlite_master WHERE sql IS NOT NULL').all() as
    Array<{ type: string; name: string; tbl_name: string; sql: string }>;
  const byName = new Map(rows.map((r) => [r.name, r]));
  for (const [table, cols] of Object.entries(V10_EXPECTED.tables)) {
    const row = byName.get(table);
    if (!row) { if (exact) return `table ${table} is missing`; continue; }
    if (row.type !== 'table') return `${table} exists as a ${row.type}, not a table`;
    const found = columnsOf(db, table);
    if (found.join(',') !== cols.join(',')) return `table ${table} has columns (${found.join(', ')}), expected (${cols.join(', ')})`;
  }
  for (const obj of V10_OBJECTS) {
    const row = byName.get(obj.name);
    if (!row) { if (exact) return `${obj.type} ${obj.name} is missing`; continue; }
    if (row.type !== obj.type || row.tbl_name !== obj.table) {
      return `${obj.name} exists as a ${row.type} on ${row.tbl_name}, expected a ${obj.type} on ${obj.table}`;
    }
    if (normaliseSql(row.sql) !== obj.sql) return `${obj.type} ${obj.name} has a different definition`;
  }
  return null;
}

/**
 * Throws on the first mismatch. Runs inside the v10 transaction, so a throw rolls everything back.
 * `pre` is the step's MigrationContext: with pre-counts, every pre-existing table keeps its row count exactly
 * (v10 adds rows to no v1-v9 table).
 */
export function verifyV10(db: Database.Database, pre: MigrationContext): void {
  const v7 = v7ShapeProblem(db, true);
  if (v7) throw new Error(`v10 verification failed: the v7 shape changed: ${v7}`);
  const v8 = v8ShapeProblem(db, true);
  if (v8) throw new Error(`v10 verification failed: the v8 shape changed: ${v8}`);
  const v9 = v9ShapeProblem(db, true);
  if (v9) throw new Error(`v10 verification failed: the v9 shape changed: ${v9}`);
  const shape = v10ShapeProblem(db, true);
  if (shape) throw new Error(`v10 verification failed: ${shape}`);
  const fk = db.pragma('foreign_key_check') as Array<{ table: string }>;
  if (fk.length) {
    throw new Error(`v10 verification failed: foreign_key_check reports ${fk.length} row(s) in ${[...new Set(fk.map((r) => r.table))].join(', ')}`);
  }
  if (pre.preCounts) {
    for (const [table, before] of Object.entries(pre.preCounts)) {
      if (V10_TABLES.has(table) || COUNT_EXEMPT.has(table)) continue;
      if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)) {
        throw new Error(`v10 verification failed: table ${table} is missing`);
      }
      const after = countOf(db, table);
      if (after !== before) throw new Error(`v10 verification failed: ${table} has ${after} rows, expected ${before}`);
    }
  }
}

/**
 * MIGRATIONS[9]. Sits only on an exact v7 + v8 + v9. Idempotent: on a database that already has v10 it changes
 * nothing (`recorded` is false). Not wired: Task 3 calls it from db.ts behind enableV10.
 */
export function applyV10(db: Database.Database, ctx: MigrationContext): { tables: number; recorded: boolean } {
  const v7 = v7ShapeProblem(db, true);
  if (v7) throw new Error(`v10 needs an exact v7 shape: ${v7}`);
  const v8 = v8ShapeProblem(db, true);
  if (v8) throw new Error(`v10 needs an exact v8 shape: ${v8}`);
  const v9 = v9ShapeProblem(db, true);
  if (v9) throw new Error(`v10 needs an exact v9 shape: ${v9}`);
  const conflict = v10ShapeProblem(db, false);
  if (conflict) throw new Error(`v10 cannot be applied over an existing object: ${conflict}`);
  const now = ctx.now();
  db.exec(V10_DDL);
  const record = db.prepare(`INSERT OR IGNORE INTO nexus_migrations (version, from_version, applied_at, app_version, backup_file,
      backup_sha256, backup_bytes, row_counts_json, backfill_json) VALUES (10, 9, ?, ?, ?, ?, ?, ?, '{}')`).run(
    now, ctx.appVersion, ctx.backup?.file ?? null, ctx.backup?.sha256 ?? null, ctx.backup?.bytes ?? null,
    JSON.stringify(ctx.preCounts ?? {}));
  if (record.changes === 1) {
    appendActivityRow(db, {
      actorKind: 'system', actorId: 'system', entityType: 'schema', entityId: '10', action: 'db.migrated', status: 'succeeded',
      details: { from: 9, to: 10, backupFile: ctx.backup?.file ?? null, backupSha256: ctx.backup?.sha256 ?? null }
    }, now);
  }
  verifyV10(db, ctx);
  return { tables: V10_TABLES.size, recorded: record.changes === 1 };
}
