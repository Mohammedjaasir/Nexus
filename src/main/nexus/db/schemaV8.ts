/**
 * Schema v8: handoffs between participations of one project, their subjects, the
 * handoff state vocabulary as lookup tables, and two indexes on v7 tables used by
 * the B1 screens. Additive only: every statement is CREATE ... IF NOT EXISTS or
 * INSERT OR IGNORE; nothing in v1-v7 is altered and no FK is added to a v1-v7 table.
 *
 * V8_DDL is copied verbatim from the approved B1 plan ("Schema v8 / Full DDL").
 * It is shipped migration text: never edit it - later changes go in a new migration.
 *
 * applyV8 runs inside the caller's single BEGIN IMMEDIATE transaction:
 *   exact v7 shape -> v8 shape pre-check -> DDL -> seeds -> nexus_migrations record ->
 *   one activity row (only when the record is new) -> verifyV8.
 * Any throw rolls the whole step back, including user_version.
 *
 * Known limit of the triggers: recursive_triggers is off, so INSERT OR REPLACE (and
 * an upsert's DO UPDATE) on a protected table deletes or rewrites the old row without
 * firing its BEFORE DELETE / BEFORE UPDATE guard. That is closed as a pinned source
 * rule instead: test/nexus-core-append-only-writes.test.cjs fails on any OR REPLACE
 * or ON CONFLICT ... DO UPDATE aimed at an append-only or immutable platform table
 * under src/main/nexus. INSERT OR IGNORE is fine: it never deletes.
 */
import type Database from 'better-sqlite3';
import type { MigrationContext } from './migrationTypes';
import { V8_HANDOFF_STATES, V8_HANDOFF_TRANSITIONS } from './v8Seed';
import { ddlObjects, normaliseSql, v7ShapeProblem, type V7DdlObject } from './schemaV7';
import { appendActivityRow } from '../activity/writer';

export const V8_DDL: string = `
-- ===== handoff vocabulary: lookup tables, so later phases add rows instead of rebuilding a CHECK =====
CREATE TABLE IF NOT EXISTS handoff_states (
  state       TEXT PRIMARY KEY CHECK (state GLOB '[a-z]*' AND length(state) BETWEEN 2 AND 32),
  terminal    INTEGER NOT NULL CHECK (terminal IN (0,1)),
  description TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS handoff_transitions (
  from_state TEXT NOT NULL REFERENCES handoff_states(state),
  to_state   TEXT NOT NULL REFERENCES handoff_states(state),
  PRIMARY KEY (from_state, to_state),
  CHECK (from_state <> to_state)
);

-- ===== handoffs: artifact versions sent by reference between two participations of ONE project =====
CREATE TABLE IF NOT EXISTS handoffs (
  id                    TEXT PRIMARY KEY,
  project_id            TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  from_participation_id TEXT NOT NULL REFERENCES project_workspaces(id) ON DELETE RESTRICT,
  from_workspace_id     TEXT NOT NULL REFERENCES workspaces(id),
  to_participation_id   TEXT NOT NULL REFERENCES project_workspaces(id) ON DELETE RESTRICT,
  to_workspace_id       TEXT NOT NULL REFERENCES workspaces(id),
  title                 TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  note                  TEXT CHECK (note IS NULL OR length(note) <= 2000),
  subject_count         INTEGER NOT NULL CHECK (subject_count BETWEEN 1 AND 20),
  status                TEXT NOT NULL REFERENCES handoff_states(state),
  created_by            TEXT NOT NULL REFERENCES principals(id),
  responded_by          TEXT REFERENCES principals(id),
  responded_at          INTEGER,
  response_note         TEXT CHECK (response_note IS NULL OR length(response_note) <= 2000),
  receipt_version_id    TEXT REFERENCES artifact_versions(id),
  created_at            INTEGER NOT NULL,
  updated_at            INTEGER NOT NULL,
  status_changed_at     INTEGER NOT NULL,
  CHECK (from_participation_id <> to_participation_id),
  CHECK (from_workspace_id <> to_workspace_id),
  CHECK ((responded_by IS NULL) = (responded_at IS NULL)),
  CHECK (response_note IS NULL OR responded_at IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS ix_handoffs_project ON handoffs(project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS ix_handoffs_to      ON handoffs(to_participation_id, status);
CREATE INDEX IF NOT EXISTS ix_handoffs_from    ON handoffs(from_participation_id, status);
CREATE INDEX IF NOT EXISTS ix_handoffs_status  ON handoffs(status, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS ux_handoffs_receipt ON handoffs(receipt_version_id) WHERE receipt_version_id IS NOT NULL;
CREATE TRIGGER IF NOT EXISTS tr_handoffs_insert BEFORE INSERT ON handoffs
BEGIN
  SELECT RAISE(ABORT, 'a handoff starts as sent, unanswered and without a receipt')
    WHERE NEW.status <> 'sent' OR NEW.responded_by IS NOT NULL OR NEW.responded_at IS NOT NULL
       OR NEW.response_note IS NOT NULL OR NEW.receipt_version_id IS NOT NULL;
  SELECT RAISE(ABORT, 'the sending participation must be active, in this project and name its workspace')
    WHERE NOT EXISTS (SELECT 1 FROM project_workspaces p WHERE p.id = NEW.from_participation_id
      AND p.project_id = NEW.project_id AND p.workspace_id = NEW.from_workspace_id AND p.status = 'active');
  SELECT RAISE(ABORT, 'the receiving participation must be active, in this project and name its workspace')
    WHERE NOT EXISTS (SELECT 1 FROM project_workspaces p WHERE p.id = NEW.to_participation_id
      AND p.project_id = NEW.project_id AND p.workspace_id = NEW.to_workspace_id AND p.status = 'active');
END;
CREATE TRIGGER IF NOT EXISTS tr_handoffs_identity BEFORE UPDATE ON handoffs
WHEN NEW.id IS NOT OLD.id OR NEW.project_id IS NOT OLD.project_id
  OR NEW.from_participation_id IS NOT OLD.from_participation_id OR NEW.from_workspace_id IS NOT OLD.from_workspace_id
  OR NEW.to_participation_id IS NOT OLD.to_participation_id OR NEW.to_workspace_id IS NOT OLD.to_workspace_id
  OR NEW.title IS NOT OLD.title OR NEW.note IS NOT OLD.note OR NEW.subject_count IS NOT OLD.subject_count
  OR NEW.created_by IS NOT OLD.created_by OR NEW.created_at IS NOT OLD.created_at
BEGIN SELECT RAISE(ABORT, 'handoff identity and request are immutable'); END;
CREATE TRIGGER IF NOT EXISTS tr_handoffs_transition BEFORE UPDATE OF status ON handoffs
WHEN NEW.status IS NOT OLD.status
BEGIN
  SELECT RAISE(ABORT, 'illegal handoff transition')
    WHERE NOT EXISTS (SELECT 1 FROM handoff_transitions t WHERE t.from_state = OLD.status AND t.to_state = NEW.status);
  SELECT RAISE(ABORT, 'a handoff is answered only once all its subjects are recorded')
    WHERE (SELECT COUNT(*) FROM handoff_subjects s WHERE s.handoff_id = OLD.id) <> OLD.subject_count;
  SELECT RAISE(ABORT, 'an accepted handoff records its receipt, and its receiving participation is active')
    WHERE NEW.status = 'accepted' AND (NEW.receipt_version_id IS NULL OR NOT EXISTS (
      SELECT 1 FROM project_workspaces p WHERE p.id = OLD.to_participation_id AND p.status = 'active'));
  SELECT RAISE(ABORT, 'an accept or decline records who answered and when')
    WHERE NEW.status IN ('accepted','declined') AND (NEW.responded_by IS NULL OR NEW.responded_at IS NULL);
  SELECT RAISE(ABORT, 'a withdrawal is not an answer and leaves the answer fields empty')
    WHERE NEW.status = 'withdrawn'
      AND (NEW.responded_by IS NOT NULL OR NEW.responded_at IS NOT NULL OR NEW.response_note IS NOT NULL);
END;
CREATE TRIGGER IF NOT EXISTS tr_handoffs_response_once BEFORE UPDATE ON handoffs
WHEN (OLD.responded_at IS NOT NULL OR OLD.status <> 'sent' OR NEW.status IS OLD.status)
  AND (NEW.responded_by IS NOT OLD.responded_by OR NEW.responded_at IS NOT OLD.responded_at
    OR NEW.response_note IS NOT OLD.response_note)
BEGIN SELECT RAISE(ABORT, 'a handoff answer is recorded once, in the update that answers it'); END;
CREATE TRIGGER IF NOT EXISTS tr_handoffs_receipt BEFORE UPDATE OF receipt_version_id ON handoffs
WHEN NEW.receipt_version_id IS NOT OLD.receipt_version_id
BEGIN
  SELECT RAISE(ABORT, 'a receipt is set once, in the update that accepts the handoff')
    WHERE OLD.receipt_version_id IS NOT NULL OR OLD.status <> 'sent' OR NEW.status <> 'accepted';
  SELECT RAISE(ABORT, 'the receipt must be an active handoff_receipt version owned by the receiving participation')
    WHERE NOT EXISTS (SELECT 1 FROM artifact_versions v JOIN artifacts a ON a.id = v.artifact_id
      WHERE v.id = NEW.receipt_version_id AND v.project_id = NEW.project_id
        AND v.participation_id = NEW.to_participation_id AND a.kind = 'handoff_receipt' AND v.status = 'active');
END;
CREATE TRIGGER IF NOT EXISTS tr_handoffs_no_delete BEFORE DELETE ON handoffs
BEGIN SELECT RAISE(ABORT, 'handoffs are never deleted'); END;

CREATE TABLE IF NOT EXISTS handoff_subjects (
  handoff_id   TEXT NOT NULL REFERENCES handoffs(id) ON DELETE RESTRICT,
  version_id   TEXT NOT NULL REFERENCES artifact_versions(id) ON DELETE RESTRICT,
  position     INTEGER NOT NULL CHECK (position BETWEEN 1 AND 20),
  content_hash TEXT NOT NULL,                                   -- evidence of what was sent; never the content
  PRIMARY KEY (handoff_id, version_id),
  UNIQUE (handoff_id, position)
);
CREATE INDEX IF NOT EXISTS ix_handoff_subjects_version ON handoff_subjects(version_id);
CREATE TRIGGER IF NOT EXISTS tr_handoff_subjects_insert BEFORE INSERT ON handoff_subjects
BEGIN
  SELECT RAISE(ABORT, 'subjects are recorded on an unanswered handoff, up to its declared count')
    WHERE NOT EXISTS (SELECT 1 FROM handoffs h WHERE h.id = NEW.handoff_id AND h.status = 'sent'
      AND h.responded_at IS NULL AND NEW.position <= h.subject_count);
  SELECT RAISE(ABORT, 'a subject is a candidate or active version owned by the sending participation')
    WHERE NOT EXISTS (SELECT 1 FROM handoffs h JOIN artifact_versions v ON v.id = NEW.version_id
      JOIN artifacts a ON a.id = v.artifact_id
      WHERE h.id = NEW.handoff_id AND v.project_id = h.project_id AND a.owner_participation_id = h.from_participation_id
        AND v.status IN ('candidate','active') AND v.content_hash = NEW.content_hash);
END;
CREATE TRIGGER IF NOT EXISTS tr_handoff_subjects_no_update BEFORE UPDATE ON handoff_subjects
BEGIN SELECT RAISE(ABORT, 'handoff subjects are immutable'); END;
CREATE TRIGGER IF NOT EXISTS tr_handoff_subjects_no_delete BEFORE DELETE ON handoff_subjects
BEGIN SELECT RAISE(ABORT, 'handoff subjects are immutable'); END;

-- ===== indexes on v7 tables used by the B1 screens (additive) =====
CREATE INDEX IF NOT EXISTS ix_versions_project_status ON artifact_versions(project_id, status);
CREATE INDEX IF NOT EXISTS ix_artifacts_updated       ON artifacts(updated_at DESC);
`;

/** Every v8 table with its columns in declaration order (checked against PRAGMA table_info). */
export const V8_EXPECTED: { tables: Record<string, string[]>; indexes: string[]; triggers: string[] } = {
  tables: {
    handoff_states: ['state', 'terminal', 'description'],
    handoff_transitions: ['from_state', 'to_state'],
    handoffs: ['id', 'project_id', 'from_participation_id', 'from_workspace_id', 'to_participation_id', 'to_workspace_id', 'title',
      'note', 'subject_count', 'status', 'created_by', 'responded_by', 'responded_at', 'response_note', 'receipt_version_id',
      'created_at', 'updated_at', 'status_changed_at'],
    handoff_subjects: ['handoff_id', 'version_id', 'position', 'content_hash']
  },
  indexes: [
    'ix_handoffs_project', 'ix_handoffs_to', 'ix_handoffs_from', 'ix_handoffs_status', 'ux_handoffs_receipt',
    'ix_handoff_subjects_version', 'ix_versions_project_status', 'ix_artifacts_updated'
  ],
  triggers: [
    'tr_handoffs_insert', 'tr_handoffs_identity', 'tr_handoffs_transition', 'tr_handoffs_response_once', 'tr_handoffs_receipt',
    'tr_handoffs_no_delete', 'tr_handoff_subjects_insert', 'tr_handoff_subjects_no_update', 'tr_handoff_subjects_no_delete'
  ]
};

const V8_OBJECTS: V7DdlObject[] = ddlObjects(V8_DDL);
const V8_TABLES = new Set(Object.keys(V8_EXPECTED.tables));
/** Not compared with the pre-counts: the migration itself writes them (or SQLite does). */
const COUNT_EXEMPT = new Set(['activity', 'nexus_migrations', 'sqlite_sequence']);
const quoteIdent = (name: string): string => `"${name.replace(/"/g, '""')}"`;

const columnsOf = (db: Database.Database, table: string): string[] =>
  (db.prepare(`PRAGMA table_info(${quoteIdent(table)})`).all() as Array<{ name: string }>).map((c) => c.name);

/**
 * The first difference between the database and the v8 definition, or null.
 * Same rules as v7ShapeProblem: tables by columns (in order), every table, index
 * and trigger by its stored definition. With `requireAll` false only the v8
 * objects that already exist are checked (the pre-check before IF NOT EXISTS).
 * It checks only v8 objects; the v7 shape has its own check.
 */
export function v8ShapeProblem(db: Database.Database, requireAll = true): string | null {
  const rows = db.prepare('SELECT type, name, tbl_name, sql FROM sqlite_master WHERE sql IS NOT NULL').all() as
    Array<{ type: string; name: string; tbl_name: string; sql: string }>;
  const byName = new Map(rows.map((r) => [r.name, r]));
  for (const [table, cols] of Object.entries(V8_EXPECTED.tables)) {
    const row = byName.get(table);
    if (!row) { if (requireAll) return `table ${table} is missing`; continue; }
    if (row.type !== 'table') return `${table} exists as a ${row.type}, not a table`;
    const found = columnsOf(db, table);
    if (found.join(',') !== cols.join(',')) return `table ${table} has columns (${found.join(', ')}), expected (${cols.join(', ')})`;
  }
  for (const obj of V8_OBJECTS) {
    const row = byName.get(obj.name);
    if (!row) { if (requireAll) return `${obj.type} ${obj.name} is missing`; continue; }
    if (row.type !== obj.type || row.tbl_name !== obj.table) {
      return `${obj.name} exists as a ${row.type} on ${row.tbl_name}, expected a ${obj.type} on ${obj.table}`;
    }
    if (normaliseSql(row.sql) !== obj.sql) return `${obj.type} ${obj.name} has a different definition`;
  }
  return null;
}

function seedV8(db: Database.Database): void {
  const state = db.prepare('INSERT OR IGNORE INTO handoff_states (state, terminal, description) VALUES (?, ?, ?)');
  for (const s of V8_HANDOFF_STATES) state.run(s.state, s.terminal, s.description);
  const move = db.prepare('INSERT OR IGNORE INTO handoff_transitions (from_state, to_state) VALUES (?, ?)');
  for (const [from, to] of V8_HANDOFF_TRANSITIONS) move.run(from, to);
}

/** INSERT OR IGNORE also swallows CHECK failures, so every seed row is confirmed present and unchanged. */
function seedProblem(db: Database.Database): string | null {
  const has = (sql: string, ...args: unknown[]): boolean => db.prepare(sql).get(...args) !== undefined;
  for (const s of V8_HANDOFF_STATES) {
    if (!has('SELECT 1 FROM handoff_states WHERE state = ? AND terminal = ? AND description = ?', s.state, s.terminal, s.description)) {
      return `seed handoff state ${s.state} is missing`;
    }
  }
  for (const [f, t] of V8_HANDOFF_TRANSITIONS) {
    if (!has('SELECT 1 FROM handoff_transitions WHERE from_state = ? AND to_state = ?', f, t)) return `seed handoff transition ${f}>${t} is missing`;
  }
  return null;
}

/** Throws on the first mismatch. Runs inside the v8 transaction, so a throw rolls everything back. */
export function verifyV8(db: Database.Database, ctx: MigrationContext): void {
  const v7 = v7ShapeProblem(db, true);
  if (v7) throw new Error(`v8 verification failed: the v7 shape changed: ${v7}`);
  const shape = v8ShapeProblem(db, true);
  if (shape) throw new Error(`v8 verification failed: ${shape}`);
  const seeds = seedProblem(db);
  if (seeds) throw new Error(`v8 verification failed: ${seeds}`);
  const fk = db.pragma('foreign_key_check') as Array<{ table: string }>;
  if (fk.length) {
    throw new Error(`v8 verification failed: foreign_key_check reports ${fk.length} row(s) in ${[...new Set(fk.map((r) => r.table))].join(', ')}`);
  }
  if (ctx.preCounts) {
    for (const [table, before] of Object.entries(ctx.preCounts)) {
      if (V8_TABLES.has(table) || COUNT_EXEMPT.has(table)) continue;
      if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)) {
        throw new Error(`v8 verification failed: table ${table} is missing`);
      }
      const after = (db.prepare(`SELECT COUNT(*) AS n FROM ${quoteIdent(table)}`).get() as { n: number }).n;
      if (after !== before) throw new Error(`v8 verification failed: ${table} has ${after} rows, expected ${before}`);
    }
  }
}

/** MIGRATIONS[7]. Sits only on an exact v7. Idempotent: on a database that already has v8 it changes nothing. */
export function applyV8(db: Database.Database, ctx: MigrationContext): { handoffStates: number; handoffTransitions: number } {
  const v7 = v7ShapeProblem(db, true);
  if (v7) throw new Error(`v8 needs an exact v7 shape: ${v7}`);
  const conflict = v8ShapeProblem(db, false);
  if (conflict) throw new Error(`v8 cannot be applied over an existing object: ${conflict}`);
  const now = ctx.now();
  db.exec(V8_DDL);
  seedV8(db);
  const record = db.prepare(`INSERT OR IGNORE INTO nexus_migrations (version, from_version, applied_at, app_version, backup_file,
      backup_sha256, backup_bytes, row_counts_json, backfill_json) VALUES (8, 7, ?, ?, ?, ?, ?, ?, '{}')`).run(
    now, ctx.appVersion, ctx.backup?.file ?? null, ctx.backup?.sha256 ?? null, ctx.backup?.bytes ?? null,
    JSON.stringify(ctx.preCounts ?? {}));
  if (record.changes === 1) {
    appendActivityRow(db, {
      actorKind: 'system', actorId: 'system', entityType: 'schema', entityId: '8', action: 'db.migrated', status: 'succeeded',
      details: { from: 7, to: 8, backupFile: ctx.backup?.file ?? null, backupSha256: ctx.backup?.sha256 ?? null }
    }, now);
  }
  verifyV8(db, ctx);
  const n = (table: string): number => (db.prepare(`SELECT COUNT(*) AS n FROM ${quoteIdent(table)}`).get() as { n: number }).n;
  return { handoffStates: n('handoff_states'), handoffTransitions: n('handoff_transitions') };
}
