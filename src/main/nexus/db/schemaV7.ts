/**
 * Schema v7: the Nexus platform core (17 tables). Additive only: every statement
 * is CREATE ... IF NOT EXISTS or INSERT OR IGNORE, nothing in v1-v6 is altered,
 * and no FK is added to a v1-v6 table.
 *
 * V7_DDL is copied verbatim from the approved B0b plan ("Schema v7 / Full DDL").
 * It is shipped migration text: never edit it - later changes go in a new migration.
 *
 * applyV7 runs inside the caller's single BEGIN IMMEDIATE transaction:
 *   shape pre-check -> DDL -> seeds -> backfill -> nexus_migrations record ->
 *   one activity row (only when the record is new) -> verifyV7.
 * Any throw rolls the whole step back, including user_version.
 */
import type Database from 'better-sqlite3';
import type { MigrationContext } from './migrationTypes';
import {
  V7_DOMAIN_TO_WORKSPACE, V7_JOB_STATES, V7_JOB_TRANSITIONS, V7_LINEAGE_RELATIONS, V7_MEMBERSHIPS, V7_PRINCIPALS,
  V7_SESSION_STATES, V7_SESSION_TRANSITIONS, V7_WORKSPACE_IDS
} from './v7Seed';
import { appendActivityRow } from '../activity/writer';
import { newId } from './ids';

export const V7_DDL: string = `
-- ===== bookkeeping =====
CREATE TABLE IF NOT EXISTS nexus_migrations (
  version         INTEGER PRIMARY KEY,               -- 7
  from_version    INTEGER NOT NULL,
  applied_at      INTEGER NOT NULL,
  app_version     TEXT,
  backup_file     TEXT,                              -- basename under userData/backups; NULL for a fresh DB
  backup_sha256   TEXT,
  backup_bytes    INTEGER,
  row_counts_json TEXT NOT NULL CHECK (json_valid(row_counts_json)),   -- pre-migration counts per table
  backfill_json   TEXT NOT NULL CHECK (json_valid(backfill_json))      -- {"inserted":n,"unassigned":m}
);

-- ===== identity (single local owner; multi-user later is rows, not schema) =====
CREATE TABLE IF NOT EXISTS principals (
  id           TEXT PRIMARY KEY,                     -- 'user:local', 'system', later 'agent:<jobId>'
  kind         TEXT NOT NULL CHECK (kind IN ('user','agent','system')),
  display_name TEXT NOT NULL,
  disabled_at  INTEGER,
  created_at   INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS memberships (
  principal_id TEXT NOT NULL REFERENCES principals(id) ON DELETE RESTRICT,
  scope_type   TEXT NOT NULL CHECK (scope_type IN ('platform','workspace','project')),
  scope_id     TEXT NOT NULL,                        -- '*' for platform
  role         TEXT NOT NULL CHECK (role IN ('owner','admin','member','viewer')),
  created_at   INTEGER NOT NULL,
  PRIMARY KEY (principal_id, scope_type, scope_id),
  CHECK ((scope_type = 'platform') = (scope_id = '*'))
);

-- ===== workspaces and participation =====
CREATE TABLE IF NOT EXISTS workspaces (
  id         TEXT PRIMARY KEY CHECK (id GLOB '[a-z]*' AND length(id) BETWEEN 2 AND 32),
  created_at INTEGER NOT NULL,
  retired_at INTEGER
);
CREATE TABLE IF NOT EXISTS project_workspaces (
  id              TEXT PRIMARY KEY,
  project_id      TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  workspace_id    TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  objective       TEXT,
  status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','withdrawn','complete')),
  is_primary      INTEGER NOT NULL DEFAULT 0 CHECK (is_primary IN (0,1)),
  source          TEXT NOT NULL CHECK (source IN ('backfill','legacy_domain','user')),
  completion_json TEXT, completion_hash TEXT, completion_at INTEGER,       -- architecture N; unused in B0b
  created_by      TEXT NOT NULL REFERENCES principals(id),
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  UNIQUE (project_id, workspace_id),
  CHECK (is_primary = 0 OR status = 'active')
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_pw_primary   ON project_workspaces(project_id) WHERE is_primary = 1;
CREATE INDEX        IF NOT EXISTS ix_pw_workspace ON project_workspaces(workspace_id, status);
CREATE TRIGGER IF NOT EXISTS tr_pw_identity BEFORE UPDATE ON project_workspaces
WHEN NEW.id IS NOT OLD.id OR NEW.project_id IS NOT OLD.project_id OR NEW.workspace_id IS NOT OLD.workspace_id
  OR NEW.created_by IS NOT OLD.created_by OR NEW.created_at IS NOT OLD.created_at
BEGIN SELECT RAISE(ABORT, 'participation identity is immutable'); END;

-- ===== agent sessions (their own table; user decision, Revision 1) =====
CREATE TABLE IF NOT EXISTS agent_session_states (
  state    TEXT PRIMARY KEY,
  terminal INTEGER NOT NULL CHECK (terminal IN (0,1))
);
CREATE TABLE IF NOT EXISTS agent_session_transitions (
  from_state TEXT NOT NULL REFERENCES agent_session_states(state),
  to_state   TEXT NOT NULL REFERENCES agent_session_states(state),
  PRIMARY KEY (from_state, to_state)
);
CREATE TABLE IF NOT EXISTS agent_sessions (
  id                  TEXT PRIMARY KEY,
  project_id          TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  workspace_id        TEXT NOT NULL REFERENCES workspaces(id),
  participation_id    TEXT NOT NULL REFERENCES project_workspaces(id) ON DELETE RESTRICT,
  context_version_id  TEXT REFERENCES artifact_versions(id),        -- artifact context (brief); nullable
  principal_id        TEXT NOT NULL REFERENCES principals(id),      -- the principal the session acts for
  idempotency_key     TEXT NOT NULL UNIQUE,                         -- intent id; a re-sent open returns the same session
  status              TEXT NOT NULL DEFAULT 'open' REFERENCES agent_session_states(state),
  runtime_kind        TEXT,                                         -- provider/runtime, e.g. 'claude-cli'
  runtime_ref         TEXT,                                         -- the runtime's own session id, when one exists
  cancel_requested_at INTEGER,
  cancel_requested_by TEXT REFERENCES principals(id),
  error_json          TEXT CHECK (error_json IS NULL OR json_valid(error_json)),   -- redacted {code,message}
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL,
  status_changed_at   INTEGER NOT NULL,
  ended_at            INTEGER,
  CHECK ((cancel_requested_at IS NULL) = (cancel_requested_by IS NULL))
);
CREATE INDEX IF NOT EXISTS ix_sessions_project       ON agent_sessions(project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS ix_sessions_status        ON agent_sessions(status, updated_at);
CREATE INDEX IF NOT EXISTS ix_sessions_participation ON agent_sessions(participation_id);
CREATE TRIGGER IF NOT EXISTS tr_sessions_insert BEFORE INSERT ON agent_sessions
BEGIN
  SELECT RAISE(ABORT, 'a session starts open') WHERE NEW.status <> 'open';
  SELECT RAISE(ABORT, 'session participation must belong to the session project and workspace')
    WHERE NOT EXISTS (SELECT 1 FROM project_workspaces p WHERE p.id = NEW.participation_id
        AND p.project_id = NEW.project_id AND p.workspace_id = NEW.workspace_id AND p.status = 'active');
  SELECT RAISE(ABORT, 'session context comes from the session project')
    WHERE NEW.context_version_id IS NOT NULL
      AND (SELECT project_id FROM artifact_versions WHERE id = NEW.context_version_id) IS NOT NEW.project_id;
END;
CREATE TRIGGER IF NOT EXISTS tr_sessions_transition BEFORE UPDATE OF status ON agent_sessions
WHEN NEW.status IS NOT OLD.status AND NOT EXISTS (
  SELECT 1 FROM agent_session_transitions t WHERE t.from_state = OLD.status AND t.to_state = NEW.status)
BEGIN SELECT RAISE(ABORT, 'illegal session state transition'); END;
CREATE TRIGGER IF NOT EXISTS tr_sessions_identity BEFORE UPDATE ON agent_sessions
WHEN NEW.id IS NOT OLD.id OR NEW.project_id IS NOT OLD.project_id OR NEW.workspace_id IS NOT OLD.workspace_id
  OR NEW.participation_id IS NOT OLD.participation_id OR NEW.context_version_id IS NOT OLD.context_version_id
  OR NEW.principal_id IS NOT OLD.principal_id OR NEW.idempotency_key IS NOT OLD.idempotency_key
  OR NEW.created_at IS NOT OLD.created_at
BEGIN SELECT RAISE(ABORT, 'session identity is immutable'); END;
CREATE TRIGGER IF NOT EXISTS tr_sessions_no_delete BEFORE DELETE ON agent_sessions
BEGIN SELECT RAISE(ABORT, 'sessions are never deleted'); END;

-- ===== jobs =====
CREATE TABLE IF NOT EXISTS job_states (
  state    TEXT PRIMARY KEY,
  terminal INTEGER NOT NULL CHECK (terminal IN (0,1))
);
CREATE TABLE IF NOT EXISTS job_state_transitions (
  from_state TEXT NOT NULL REFERENCES job_states(state),
  to_state   TEXT NOT NULL REFERENCES job_states(state),
  PRIMARY KEY (from_state, to_state)
);
CREATE TABLE IF NOT EXISTS jobs (
  id                  TEXT PRIMARY KEY,
  kind                TEXT NOT NULL CHECK (kind IN ('agent.run','tool.run','validate','ingest')),
  recipe_id           TEXT,
  validator_id        TEXT,
  project_id          TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  workspace_id        TEXT NOT NULL REFERENCES workspaces(id),
  participation_id    TEXT REFERENCES project_workspaces(id) ON DELETE RESTRICT,
  session_id          TEXT REFERENCES agent_sessions(id),         -- nullable; required for agent.run
  parent_job_id       TEXT REFERENCES jobs(id),
  retry_of            TEXT REFERENCES jobs(id),
  idempotency_key     TEXT NOT NULL UNIQUE,
  requested_by        TEXT NOT NULL REFERENCES principals(id),
  on_behalf_of        TEXT NOT NULL REFERENCES principals(id),
  state               TEXT NOT NULL DEFAULT 'queued' REFERENCES job_states(state),
  phase               TEXT,
  outcome             TEXT,
  error_json          TEXT CHECK (error_json IS NULL OR json_valid(error_json)),   -- redacted {code,message}
  priority            INTEGER NOT NULL DEFAULT 1 CHECK (priority IN (0,1,2)),
  params_json         TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(params_json)),
  capabilities_json   TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(capabilities_json)),
  limits_json         TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(limits_json)),
  retry_json          TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(retry_json)),
  attempts            INTEGER NOT NULL DEFAULT 0,
  next_attempt_at     INTEGER,
  progress_json       TEXT,
  state_json          TEXT,
  runtime_kind        TEXT,                          -- e.g. 'claude-cli'; provider/runtime ref (brief)
  runtime_ref         TEXT,                          -- runtime session id when one exists
  context_hash        TEXT,
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL,
  state_changed_at    INTEGER NOT NULL,
  started_at          INTEGER,
  finished_at         INTEGER,
  cancel_requested_at INTEGER,
  CHECK (kind <> 'agent.run' OR session_id IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS ix_jobs_project       ON jobs(project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS ix_jobs_state         ON jobs(state, updated_at);
CREATE INDEX IF NOT EXISTS ix_jobs_participation ON jobs(participation_id);
CREATE INDEX IF NOT EXISTS ix_jobs_session       ON jobs(session_id, created_at) WHERE session_id IS NOT NULL;
CREATE TRIGGER IF NOT EXISTS tr_jobs_insert BEFORE INSERT ON jobs
BEGIN
  SELECT RAISE(ABORT, 'a job starts queued') WHERE NEW.state <> 'queued';
  SELECT RAISE(ABORT, 'job participation must belong to the job project and workspace')
    WHERE NEW.participation_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM project_workspaces p WHERE p.id = NEW.participation_id
        AND p.project_id = NEW.project_id AND p.workspace_id = NEW.workspace_id);
  SELECT RAISE(ABORT, 'job session must belong to the job project and workspace')
    WHERE NEW.session_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM agent_sessions s WHERE s.id = NEW.session_id
        AND s.project_id = NEW.project_id AND s.workspace_id = NEW.workspace_id);
END;
CREATE TRIGGER IF NOT EXISTS tr_jobs_transition BEFORE UPDATE OF state ON jobs
WHEN NEW.state IS NOT OLD.state AND NOT EXISTS (
  SELECT 1 FROM job_state_transitions t WHERE t.from_state = OLD.state AND t.to_state = NEW.state)
BEGIN SELECT RAISE(ABORT, 'illegal job state transition'); END;
CREATE TRIGGER IF NOT EXISTS tr_jobs_identity BEFORE UPDATE ON jobs
WHEN NEW.id IS NOT OLD.id OR NEW.kind IS NOT OLD.kind OR NEW.project_id IS NOT OLD.project_id
  OR NEW.workspace_id IS NOT OLD.workspace_id OR NEW.participation_id IS NOT OLD.participation_id
  OR NEW.session_id IS NOT OLD.session_id
  OR NEW.idempotency_key IS NOT OLD.idempotency_key OR NEW.requested_by IS NOT OLD.requested_by
  OR NEW.on_behalf_of IS NOT OLD.on_behalf_of OR NEW.created_at IS NOT OLD.created_at
BEGIN SELECT RAISE(ABORT, 'job identity is immutable'); END;
CREATE TRIGGER IF NOT EXISTS tr_jobs_no_delete BEFORE DELETE ON jobs
BEGIN SELECT RAISE(ABORT, 'jobs are never deleted'); END;

-- ===== artifacts and versions =====
CREATE TABLE IF NOT EXISTS artifacts (
  id                     TEXT PRIMARY KEY,
  project_id             TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  kind                   TEXT NOT NULL CHECK (kind GLOB '[a-z]*' AND length(kind) BETWEEN 2 AND 40),
  name                   TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  description            TEXT,
  owner_scope            TEXT NOT NULL DEFAULT 'participation' CHECK (owner_scope IN ('participation','project')),
  owner_participation_id TEXT REFERENCES project_workspaces(id) ON DELETE RESTRICT,
  owner_workspace_id     TEXT REFERENCES workspaces(id),          -- "origin workspace" (brief); NULL only when project-owned
  created_by             TEXT NOT NULL REFERENCES principals(id),
  status                 TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  current_version_id     TEXT REFERENCES artifact_versions(id),   -- circular FK; always set after the version exists
  metadata_json          TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json)),
  created_at             INTEGER NOT NULL,
  updated_at             INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_artifacts_project_kind ON artifacts(project_id, kind);
CREATE INDEX IF NOT EXISTS ix_artifacts_owner        ON artifacts(owner_participation_id);
CREATE INDEX IF NOT EXISTS ix_artifacts_current      ON artifacts(current_version_id) WHERE current_version_id IS NOT NULL;
CREATE TRIGGER IF NOT EXISTS tr_artifacts_insert BEFORE INSERT ON artifacts
BEGIN
  SELECT RAISE(ABORT, 'an artifact starts without a current version') WHERE NEW.current_version_id IS NOT NULL;
  SELECT RAISE(ABORT, 'only repository may be project-owned, and it has no owning participation')
    WHERE (NEW.owner_scope = 'project') <> (NEW.owner_participation_id IS NULL)
       OR (NEW.owner_scope = 'project' AND NEW.kind <> 'repository');
  SELECT RAISE(ABORT, 'owner participation must belong to the project and name the origin workspace')
    WHERE NEW.owner_participation_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM project_workspaces p WHERE p.id = NEW.owner_participation_id
        AND p.project_id = NEW.project_id AND p.workspace_id IS NEW.owner_workspace_id);
END;
CREATE TRIGGER IF NOT EXISTS tr_artifacts_identity BEFORE UPDATE ON artifacts
WHEN NEW.id IS NOT OLD.id OR NEW.project_id IS NOT OLD.project_id OR NEW.kind IS NOT OLD.kind
  OR NEW.owner_scope IS NOT OLD.owner_scope OR NEW.owner_participation_id IS NOT OLD.owner_participation_id
  OR NEW.owner_workspace_id IS NOT OLD.owner_workspace_id OR NEW.created_by IS NOT OLD.created_by
  OR NEW.created_at IS NOT OLD.created_at
BEGIN SELECT RAISE(ABORT, 'artifact identity and ownership are immutable'); END;
CREATE TRIGGER IF NOT EXISTS tr_artifacts_current BEFORE UPDATE OF current_version_id ON artifacts
WHEN NEW.current_version_id IS NOT OLD.current_version_id
BEGIN
  SELECT RAISE(ABORT, 'the current version can move but not be cleared') WHERE NEW.current_version_id IS NULL;
  SELECT RAISE(ABORT, 'current version must be an active version of this artifact')
    WHERE NEW.current_version_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM artifact_versions v WHERE v.id = NEW.current_version_id
        AND v.artifact_id = NEW.id AND v.status = 'active');
END;
CREATE TRIGGER IF NOT EXISTS tr_artifacts_no_delete BEFORE DELETE ON artifacts
BEGIN SELECT RAISE(ABORT, 'artifacts are archived, never deleted'); END;

CREATE TABLE IF NOT EXISTS artifact_versions (
  id                 TEXT PRIMARY KEY,
  artifact_id        TEXT NOT NULL REFERENCES artifacts(id) ON DELETE RESTRICT,
  version_no         INTEGER NOT NULL CHECK (version_no >= 1),   -- COALESCE(MAX)+1 under BEGIN IMMEDIATE
  project_id         TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  participation_id   TEXT REFERENCES project_workspaces(id) ON DELETE RESTRICT,   -- NULL only for platform artifacts
  status             TEXT NOT NULL CHECK (status IN ('draft','candidate','active','failed','deprecated')),
  draft_flag         TEXT CHECK (draft_flag IS NULL OR draft_flag = 'cancelled_partial'),
  storage_kind       TEXT NOT NULL CHECK (storage_kind IN ('git','blob','tree','external','inline')),
  storage_ref_json   TEXT NOT NULL CHECK (json_valid(storage_ref_json)),
  content_hash       TEXT NOT NULL,
  inputs_json        TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(inputs_json)),
  io_contract_json   TEXT CHECK (io_contract_json IS NULL OR json_valid(io_contract_json)),   -- "outputs" (brief)
  metadata_json      TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json)),
  validation_state   TEXT NOT NULL DEFAULT 'pending' CHECK (validation_state IN ('pending','passed','failed','error')),
  produced_by_job_id TEXT REFERENCES jobs(id),
  produced_by_session_id TEXT REFERENCES agent_sessions(id),     -- the agent session (brief); nullable
  produced_by_action TEXT,
  actor_id           TEXT NOT NULL REFERENCES principals(id),    -- creator (brief)
  on_behalf_of       TEXT NOT NULL REFERENCES principals(id),
  environment_json   TEXT CHECK (environment_json IS NULL OR json_valid(environment_json)),
  created_at         INTEGER NOT NULL,
  status_changed_at  INTEGER NOT NULL,
  promoted_by        TEXT REFERENCES principals(id),
  promoted_at        INTEGER,
  purged_at          INTEGER,
  client_key         TEXT,
  output_path        TEXT,
  UNIQUE (artifact_id, version_no)
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_versions_job_client ON artifact_versions(produced_by_job_id, client_key)
  WHERE client_key IS NOT NULL;
CREATE TRIGGER IF NOT EXISTS tr_versions_insert BEFORE INSERT ON artifact_versions
BEGIN
  SELECT RAISE(ABORT, 'a version starts as draft') WHERE NEW.status <> 'draft';
  SELECT RAISE(ABORT, 'only the owning participation may add versions to an active artifact')
    WHERE NOT EXISTS (SELECT 1 FROM artifacts a WHERE a.id = NEW.artifact_id AND a.project_id = NEW.project_id
                        AND a.owner_participation_id IS NEW.participation_id AND a.status = 'active');
  SELECT RAISE(ABORT, 'the owning participation is not active')
    WHERE NEW.participation_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM project_workspaces p WHERE p.id = NEW.participation_id AND p.status = 'active');
  SELECT RAISE(ABORT, 'the producing session belongs to another project')
    WHERE NEW.produced_by_session_id IS NOT NULL
      AND (SELECT project_id FROM agent_sessions WHERE id = NEW.produced_by_session_id) IS NOT NEW.project_id;
END;
CREATE TRIGGER IF NOT EXISTS tr_versions_identity BEFORE UPDATE ON artifact_versions
WHEN NEW.id IS NOT OLD.id OR NEW.artifact_id IS NOT OLD.artifact_id OR NEW.version_no IS NOT OLD.version_no
  OR NEW.project_id IS NOT OLD.project_id OR NEW.participation_id IS NOT OLD.participation_id
  OR NEW.actor_id IS NOT OLD.actor_id OR NEW.on_behalf_of IS NOT OLD.on_behalf_of
  OR NEW.produced_by_job_id IS NOT OLD.produced_by_job_id OR NEW.produced_by_session_id IS NOT OLD.produced_by_session_id
  OR NEW.client_key IS NOT OLD.client_key
  OR NEW.output_path IS NOT OLD.output_path OR NEW.created_at IS NOT OLD.created_at
BEGIN SELECT RAISE(ABORT, 'version identity is immutable'); END;
CREATE TRIGGER IF NOT EXISTS tr_versions_immutable BEFORE UPDATE ON artifact_versions
WHEN OLD.status <> 'draft' AND (
     NEW.storage_kind IS NOT OLD.storage_kind OR NEW.storage_ref_json IS NOT OLD.storage_ref_json
  OR NEW.content_hash IS NOT OLD.content_hash OR NEW.inputs_json IS NOT OLD.inputs_json
  OR NEW.metadata_json IS NOT OLD.metadata_json OR NEW.io_contract_json IS NOT OLD.io_contract_json
  OR NEW.environment_json IS NOT OLD.environment_json)
BEGIN SELECT RAISE(ABORT, 'version content is immutable after draft'); END;
CREATE TRIGGER IF NOT EXISTS tr_versions_status BEFORE UPDATE OF status ON artifact_versions
WHEN NEW.status IS NOT OLD.status AND (OLD.status || '>' || NEW.status) NOT IN (
  'draft>candidate','draft>failed','draft>deprecated','candidate>active','candidate>deprecated',
  'active>deprecated','deprecated>active')
BEGIN SELECT RAISE(ABORT, 'illegal version transition'); END;
CREATE TRIGGER IF NOT EXISTS tr_versions_current_stays_active BEFORE UPDATE OF status ON artifact_versions
WHEN OLD.status = 'active' AND NEW.status <> 'active'
  AND EXISTS (SELECT 1 FROM artifacts a WHERE a.current_version_id = OLD.id)
BEGIN SELECT RAISE(ABORT, 'move the current pointer before deactivating this version'); END;
CREATE TRIGGER IF NOT EXISTS tr_versions_no_delete BEFORE DELETE ON artifact_versions
BEGIN SELECT RAISE(ABORT, 'versions are never deleted'); END;

CREATE TABLE IF NOT EXISTS job_inputs (                          -- artifact context of a job / session
  job_id       TEXT NOT NULL REFERENCES jobs(id) ON DELETE RESTRICT,
  version_id   TEXT NOT NULL REFERENCES artifact_versions(id) ON DELETE RESTRICT,
  role         TEXT NOT NULL CHECK (length(role) BETWEEN 1 AND 64),
  content_hash TEXT NOT NULL,
  PRIMARY KEY (job_id, version_id, role)
);
CREATE TRIGGER IF NOT EXISTS tr_job_inputs_insert BEFORE INSERT ON job_inputs
BEGIN
  SELECT RAISE(ABORT, 'job inputs come from the job project')
    WHERE (SELECT project_id FROM jobs WHERE id = NEW.job_id)
       IS NOT (SELECT project_id FROM artifact_versions WHERE id = NEW.version_id);
  SELECT RAISE(ABORT, 'job inputs are fixed once the job leaves queued')
    WHERE (SELECT state FROM jobs WHERE id = NEW.job_id) <> 'queued';
END;
CREATE TRIGGER IF NOT EXISTS tr_job_inputs_no_update BEFORE UPDATE ON job_inputs
BEGIN SELECT RAISE(ABORT, 'job inputs are immutable'); END;
CREATE TRIGGER IF NOT EXISTS tr_job_inputs_no_delete BEFORE DELETE ON job_inputs
BEGIN SELECT RAISE(ABORT, 'job inputs are immutable'); END;

-- ===== lineage (version-level DAG) =====
CREATE TABLE IF NOT EXISTS lineage_relations (
  relation      TEXT PRIMARY KEY,
  description   TEXT NOT NULL,
  planned_phase TEXT NOT NULL      -- documentation only: the phase expected to first write it; no behaviour in B0b
);
CREATE TABLE IF NOT EXISTS artifact_edges (
  id              TEXT PRIMARY KEY,
  from_version_id TEXT NOT NULL REFERENCES artifact_versions(id),   -- the consumer / newer version
  to_version_id   TEXT NOT NULL REFERENCES artifact_versions(id),   -- its source
  relation        TEXT NOT NULL REFERENCES lineage_relations(relation),
  source          TEXT NOT NULL CHECK (source IN ('job_input','ingest','user_action','handoff_convert')),
  job_id          TEXT REFERENCES jobs(id),
  created_by      TEXT NOT NULL REFERENCES principals(id),
  created_at      INTEGER NOT NULL,
  CHECK (from_version_id <> to_version_id),
  UNIQUE (from_version_id, to_version_id, relation)
);
CREATE INDEX IF NOT EXISTS ix_edges_to ON artifact_edges(to_version_id);
CREATE TRIGGER IF NOT EXISTS tr_edges_insert BEFORE INSERT ON artifact_edges
BEGIN
  SELECT RAISE(ABORT, 'lineage edges stay inside one project')
    WHERE (SELECT project_id FROM artifact_versions WHERE id = NEW.from_version_id)
       IS NOT (SELECT project_id FROM artifact_versions WHERE id = NEW.to_version_id);
  SELECT RAISE(ABORT, 'job edges need a job') WHERE NEW.source IN ('job_input','ingest') AND NEW.job_id IS NULL;
END;
CREATE TRIGGER IF NOT EXISTS tr_edges_no_update BEFORE UPDATE ON artifact_edges
BEGIN SELECT RAISE(ABORT, 'lineage is append-only'); END;
CREATE TRIGGER IF NOT EXISTS tr_edges_no_delete BEFORE DELETE ON artifact_edges
BEGIN SELECT RAISE(ABORT, 'lineage is append-only'); END;

-- ===== activity (append-only, redacted, hash-chained) =====
CREATE TABLE IF NOT EXISTS activity (
  seq          INTEGER PRIMARY KEY AUTOINCREMENT,
  id           TEXT NOT NULL UNIQUE,
  ts           INTEGER NOT NULL,
  actor_kind   TEXT NOT NULL CHECK (actor_kind IN ('user','agent','system')),
  actor_id     TEXT NOT NULL,
  on_behalf_of TEXT,
  session_id   TEXT,                                   -- agent session (no FK: the audit outlives its subjects)
  job_id       TEXT,
  attempt_n    INTEGER,
  workspace_id TEXT,
  project_id   TEXT,
  artifact_id  TEXT,
  version_id   TEXT,
  entity_type  TEXT NOT NULL,
  entity_id    TEXT,
  action       TEXT NOT NULL,
  status       TEXT NOT NULL CHECK (status IN ('started','succeeded','failed','denied','cancelled')),
  details_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(details_json)),   -- redactDetails() output only
  prev_hash    TEXT NOT NULL,
  hash         TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_activity_project ON activity(project_id, seq);
CREATE INDEX IF NOT EXISTS ix_activity_session ON activity(session_id, seq) WHERE session_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_activity_job     ON activity(job_id, seq) WHERE job_id IS NOT NULL;
CREATE TRIGGER IF NOT EXISTS tr_activity_no_update BEFORE UPDATE ON activity
BEGIN SELECT RAISE(ABORT, 'activity is append-only'); END;
CREATE TRIGGER IF NOT EXISTS tr_activity_no_delete BEFORE DELETE ON activity
BEGIN SELECT RAISE(ABORT, 'activity is append-only'); END;
`;

/** Every v7 table with its columns in declaration order (checked against PRAGMA table_info). */
export const V7_EXPECTED: { tables: Record<string, string[]>; indexes: string[]; triggers: string[] } = {
  tables: {
    nexus_migrations: ['version', 'from_version', 'applied_at', 'app_version', 'backup_file', 'backup_sha256', 'backup_bytes',
      'row_counts_json', 'backfill_json'],
    principals: ['id', 'kind', 'display_name', 'disabled_at', 'created_at'],
    memberships: ['principal_id', 'scope_type', 'scope_id', 'role', 'created_at'],
    workspaces: ['id', 'created_at', 'retired_at'],
    project_workspaces: ['id', 'project_id', 'workspace_id', 'objective', 'status', 'is_primary', 'source', 'completion_json',
      'completion_hash', 'completion_at', 'created_by', 'created_at', 'updated_at'],
    agent_session_states: ['state', 'terminal'],
    agent_session_transitions: ['from_state', 'to_state'],
    agent_sessions: ['id', 'project_id', 'workspace_id', 'participation_id', 'context_version_id', 'principal_id', 'idempotency_key',
      'status', 'runtime_kind', 'runtime_ref', 'cancel_requested_at', 'cancel_requested_by', 'error_json', 'created_at', 'updated_at',
      'status_changed_at', 'ended_at'],
    job_states: ['state', 'terminal'],
    job_state_transitions: ['from_state', 'to_state'],
    jobs: ['id', 'kind', 'recipe_id', 'validator_id', 'project_id', 'workspace_id', 'participation_id', 'session_id', 'parent_job_id',
      'retry_of', 'idempotency_key', 'requested_by', 'on_behalf_of', 'state', 'phase', 'outcome', 'error_json', 'priority', 'params_json',
      'capabilities_json', 'limits_json', 'retry_json', 'attempts', 'next_attempt_at', 'progress_json', 'state_json', 'runtime_kind',
      'runtime_ref', 'context_hash', 'created_at', 'updated_at', 'state_changed_at', 'started_at', 'finished_at', 'cancel_requested_at'],
    artifacts: ['id', 'project_id', 'kind', 'name', 'description', 'owner_scope', 'owner_participation_id', 'owner_workspace_id',
      'created_by', 'status', 'current_version_id', 'metadata_json', 'created_at', 'updated_at'],
    artifact_versions: ['id', 'artifact_id', 'version_no', 'project_id', 'participation_id', 'status', 'draft_flag', 'storage_kind',
      'storage_ref_json', 'content_hash', 'inputs_json', 'io_contract_json', 'metadata_json', 'validation_state', 'produced_by_job_id',
      'produced_by_session_id', 'produced_by_action', 'actor_id', 'on_behalf_of', 'environment_json', 'created_at', 'status_changed_at',
      'promoted_by', 'promoted_at', 'purged_at', 'client_key', 'output_path'],
    job_inputs: ['job_id', 'version_id', 'role', 'content_hash'],
    lineage_relations: ['relation', 'description', 'planned_phase'],
    artifact_edges: ['id', 'from_version_id', 'to_version_id', 'relation', 'source', 'job_id', 'created_by', 'created_at'],
    activity: ['seq', 'id', 'ts', 'actor_kind', 'actor_id', 'on_behalf_of', 'session_id', 'job_id', 'attempt_n', 'workspace_id',
      'project_id', 'artifact_id', 'version_id', 'entity_type', 'entity_id', 'action', 'status', 'details_json', 'prev_hash', 'hash']
  },
  indexes: [
    'ux_pw_primary', 'ix_pw_workspace',
    'ix_sessions_project', 'ix_sessions_status', 'ix_sessions_participation',
    'ix_jobs_project', 'ix_jobs_state', 'ix_jobs_participation', 'ix_jobs_session',
    'ix_artifacts_project_kind', 'ix_artifacts_owner', 'ix_artifacts_current',
    'ux_versions_job_client', 'ix_edges_to',
    'ix_activity_project', 'ix_activity_session', 'ix_activity_job'
  ],
  triggers: [
    'tr_pw_identity',
    'tr_sessions_insert', 'tr_sessions_transition', 'tr_sessions_identity', 'tr_sessions_no_delete',
    'tr_jobs_insert', 'tr_jobs_transition', 'tr_jobs_identity', 'tr_jobs_no_delete',
    'tr_artifacts_insert', 'tr_artifacts_identity', 'tr_artifacts_current', 'tr_artifacts_no_delete',
    'tr_versions_insert', 'tr_versions_identity', 'tr_versions_immutable', 'tr_versions_status',
    'tr_versions_current_stays_active', 'tr_versions_no_delete',
    'tr_job_inputs_insert', 'tr_job_inputs_no_update', 'tr_job_inputs_no_delete',
    'tr_edges_insert', 'tr_edges_no_update', 'tr_edges_no_delete',
    'tr_activity_no_update', 'tr_activity_no_delete'
  ]
};

export interface V7DdlObject { type: 'table' | 'index' | 'trigger'; name: string; table: string; sql: string }

/**
 * Comparable form of one CREATE statement: comments and IF NOT EXISTS removed,
 * whitespace collapsed. SQLite keeps the statement text (minus IF NOT EXISTS) in
 * sqlite_master, so a stored definition and the DDL normalise to the same string.
 */
export function normaliseSql(sql: string): string {
  return sql.replace(/--[^\n]*/g, ' ').replace(/\bIF\s+NOT\s+EXISTS\b/gi, ' ').replace(/\s+/g, ' ')
    .replace(/\s*;\s*$/, '').replace(/\s*([(),])\s*/g, '$1').trim();
}

/** The CREATE statements of a DDL script, in order. A trigger body ends at its END; everything else at the first ';'. */
export function v7DdlObjects(ddl: string): V7DdlObject[] {
  const text = ddl.replace(/--[^\n]*/g, '');
  const out: V7DdlObject[] = [];
  const re = /CREATE\s+(UNIQUE\s+INDEX|INDEX|TABLE|TRIGGER)\s+IF\s+NOT\s+EXISTS\s+([a-z_]+)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const kind = m[1].toUpperCase();
    const type: V7DdlObject['type'] = kind === 'TABLE' ? 'table' : kind === 'TRIGGER' ? 'trigger' : 'index';
    const end = type === 'trigger' ? text.indexOf('END;', m.index) + 4 : text.indexOf(';', m.index) + 1;
    const sql = text.slice(m.index, end);
    const table = type === 'table' ? m[2] : (/\bON\s+([a-z_]+)/i.exec(sql.slice(m[0].length)) ?? [])[1] ?? '';
    out.push({ type, name: m[2], table, sql: normaliseSql(sql) });
    re.lastIndex = end;
  }
  return out;
}

const V7_OBJECTS: V7DdlObject[] = v7DdlObjects(V7_DDL);
const V7_TABLES = new Set(Object.keys(V7_EXPECTED.tables));
const quoteIdent = (name: string): string => `"${name.replace(/"/g, '""')}"`;

const columnsOf = (db: Database.Database, table: string): string[] =>
  (db.prepare(`PRAGMA table_info(${quoteIdent(table)})`).all() as Array<{ name: string }>).map((c) => c.name);

/**
 * The first difference between the database and the v7 definition, or null.
 * Tables are compared by columns (in order) and every table, index and trigger
 * by its stored definition. With `requireAll` false only the v7 objects that
 * already exist are checked: that is the pre-check that stops IF NOT EXISTS
 * from silently accepting a pre-existing object with the wrong shape.
 */
export function v7ShapeProblem(db: Database.Database, requireAll = true): string | null {
  const rows = db.prepare('SELECT type, name, tbl_name, sql FROM sqlite_master WHERE sql IS NOT NULL').all() as
    Array<{ type: string; name: string; tbl_name: string; sql: string }>;
  const byName = new Map(rows.map((r) => [r.name, r]));
  for (const [table, cols] of Object.entries(V7_EXPECTED.tables)) {
    const row = byName.get(table);
    if (!row) { if (requireAll) return `table ${table} is missing`; continue; }
    if (row.type !== 'table') return `${table} exists as a ${row.type}, not a table`;
    const found = columnsOf(db, table);
    if (found.join(',') !== cols.join(',')) return `table ${table} has columns (${found.join(', ')}), expected (${cols.join(', ')})`;
  }
  for (const obj of V7_OBJECTS) {
    const row = byName.get(obj.name);
    if (!row) { if (requireAll) return `${obj.type} ${obj.name} is missing`; continue; }
    if (row.type !== obj.type || row.tbl_name !== obj.table) {
      return `${obj.name} exists as a ${row.type} on ${row.tbl_name}, expected a ${obj.type} on ${obj.table}`;
    }
    if (normaliseSql(row.sql) !== obj.sql) return `${obj.type} ${obj.name} has a different definition`;
  }
  return null;
}

function seedV7(db: Database.Database, now: number): void {
  const principal = db.prepare('INSERT OR IGNORE INTO principals (id, kind, display_name, disabled_at, created_at) VALUES (?, ?, ?, NULL, ?)');
  for (const p of V7_PRINCIPALS) principal.run(p.id, p.kind, p.displayName, now);
  const membership = db.prepare("INSERT OR IGNORE INTO memberships (principal_id, scope_type, scope_id, role, created_at) VALUES (?, 'platform', '*', ?, ?)");
  for (const m of V7_MEMBERSHIPS) membership.run(m.principalId, m.role, now);
  const workspace = db.prepare('INSERT OR IGNORE INTO workspaces (id, created_at, retired_at) VALUES (?, ?, NULL)');
  for (const id of V7_WORKSPACE_IDS) workspace.run(id, now);
  const jobState = db.prepare('INSERT OR IGNORE INTO job_states (state, terminal) VALUES (?, ?)');
  for (const s of V7_JOB_STATES) jobState.run(s.state, s.terminal);
  const jobMove = db.prepare('INSERT OR IGNORE INTO job_state_transitions (from_state, to_state) VALUES (?, ?)');
  for (const [from, to] of V7_JOB_TRANSITIONS) jobMove.run(from, to);
  const sessionState = db.prepare('INSERT OR IGNORE INTO agent_session_states (state, terminal) VALUES (?, ?)');
  for (const s of V7_SESSION_STATES) sessionState.run(s.state, s.terminal);
  const sessionMove = db.prepare('INSERT OR IGNORE INTO agent_session_transitions (from_state, to_state) VALUES (?, ?)');
  for (const [from, to] of V7_SESSION_TRANSITIONS) sessionMove.run(from, to);
  const relation = db.prepare('INSERT OR IGNORE INTO lineage_relations (relation, description, planned_phase) VALUES (?, ?, ?)');
  for (const r of V7_LINEAGE_RELATIONS) relation.run(r.relation, r.description, r.plannedPhase);
}

/** INSERT OR IGNORE also swallows CHECK failures, so every seed row is confirmed present and unchanged. */
function seedProblem(db: Database.Database): string | null {
  const has = (sql: string, ...args: unknown[]): boolean => db.prepare(sql).get(...args) !== undefined;
  for (const p of V7_PRINCIPALS) {
    if (!has('SELECT 1 FROM principals WHERE id = ? AND kind = ? AND display_name = ?', p.id, p.kind, p.displayName)) return `seed principal ${p.id} is missing`;
  }
  for (const m of V7_MEMBERSHIPS) {
    if (!has("SELECT 1 FROM memberships WHERE principal_id = ? AND scope_type = 'platform' AND scope_id = '*' AND role = ?", m.principalId, m.role)) {
      return `seed membership ${m.principalId} is missing`;
    }
  }
  for (const id of V7_WORKSPACE_IDS) if (!has('SELECT 1 FROM workspaces WHERE id = ?', id)) return `seed workspace ${id} is missing`;
  for (const s of V7_JOB_STATES) {
    if (!has('SELECT 1 FROM job_states WHERE state = ? AND terminal = ?', s.state, s.terminal)) return `seed job state ${s.state} is missing`;
  }
  for (const [f, t] of V7_JOB_TRANSITIONS) {
    if (!has('SELECT 1 FROM job_state_transitions WHERE from_state = ? AND to_state = ?', f, t)) return `seed job transition ${f}>${t} is missing`;
  }
  for (const s of V7_SESSION_STATES) {
    if (!has('SELECT 1 FROM agent_session_states WHERE state = ? AND terminal = ?', s.state, s.terminal)) return `seed session state ${s.state} is missing`;
  }
  for (const [f, t] of V7_SESSION_TRANSITIONS) {
    if (!has('SELECT 1 FROM agent_session_transitions WHERE from_state = ? AND to_state = ?', f, t)) return `seed session transition ${f}>${t} is missing`;
  }
  for (const r of V7_LINEAGE_RELATIONS) {
    if (!has('SELECT 1 FROM lineage_relations WHERE relation = ? AND description = ? AND planned_phase = ?', r.relation, r.description, r.plannedPhase)) {
      return `seed lineage relation ${r.relation} is missing`;
    }
  }
  return null;
}

/**
 * One primary participation per existing project, from the frozen Phase A mapping
 * (V7_DOMAIN_TO_WORKSPACE). Unmapped domains (cybersecurity, unknown ids) get no
 * row and stay Unassigned; secondary domains create nothing. A project that already
 * has a primary, or a row for that workspace, is left alone, so a re-run inserts nothing.
 */
export function backfillProjectWorkspacesV7(db: Database.Database, now: number): { inserted: number; unassigned: number } {
  const projects = db.prepare('SELECT id, domain_id FROM projects ORDER BY rowid').all() as Array<{ id: string; domain_id: string }>;
  const hasPrimary = db.prepare('SELECT 1 FROM project_workspaces WHERE project_id = ? AND is_primary = 1');
  const hasRow = db.prepare('SELECT 1 FROM project_workspaces WHERE project_id = ? AND workspace_id = ?');
  const insert = db.prepare(`INSERT INTO project_workspaces (id, project_id, workspace_id, objective, status, is_primary, source,
      completion_json, completion_hash, completion_at, created_by, created_at, updated_at)
    VALUES (?, ?, ?, NULL, 'active', 1, 'backfill', NULL, NULL, NULL, 'system', ?, ?)`);
  let inserted = 0;
  let unassigned = 0;
  for (const p of projects) {
    const ws = Object.prototype.hasOwnProperty.call(V7_DOMAIN_TO_WORKSPACE, p.domain_id) ? V7_DOMAIN_TO_WORKSPACE[p.domain_id] : null;
    if (!ws) { unassigned++; continue; }
    if (hasPrimary.get(p.id) || hasRow.get(p.id, ws)) continue;
    insert.run(newId(now), p.id, ws, now, now);
    inserted++;
  }
  return { inserted, unassigned };
}

/** Throws on the first mismatch. Runs inside the v7 transaction, so a throw rolls everything back. */
export function verifyV7(db: Database.Database, ctx: MigrationContext): void {
  const shape = v7ShapeProblem(db, true);
  if (shape) throw new Error(`v7 verification failed: ${shape}`);
  const seeds = seedProblem(db);
  if (seeds) throw new Error(`v7 verification failed: ${seeds}`);
  const fk = db.pragma('foreign_key_check') as Array<{ table: string }>;
  if (fk.length) {
    throw new Error(`v7 verification failed: foreign_key_check reports ${fk.length} row(s) in ${[...new Set(fk.map((r) => r.table))].join(', ')}`);
  }
  if (ctx.preCounts) {
    for (const [table, before] of Object.entries(ctx.preCounts)) {
      if (V7_TABLES.has(table)) continue;
      if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)) {
        throw new Error(`v7 verification failed: legacy table ${table} is missing`);
      }
      const after = (db.prepare(`SELECT COUNT(*) AS n FROM ${quoteIdent(table)}`).get() as { n: number }).n;
      if (after !== before) throw new Error(`v7 verification failed: ${table} has ${after} rows, expected ${before}`);
    }
  }
}

/** MIGRATIONS[6]. Idempotent: on a database that already has v7 it changes nothing. */
export function applyV7(db: Database.Database, ctx: MigrationContext): { backfilled: number; unassigned: number } {
  const conflict = v7ShapeProblem(db, false);
  if (conflict) throw new Error(`v7 cannot be applied over an existing object: ${conflict}`);
  const now = ctx.now();
  db.exec(V7_DDL);
  seedV7(db, now);
  const { inserted, unassigned } = backfillProjectWorkspacesV7(db, now);
  const record = db.prepare(`INSERT OR IGNORE INTO nexus_migrations (version, from_version, applied_at, app_version, backup_file,
      backup_sha256, backup_bytes, row_counts_json, backfill_json) VALUES (7, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    ctx.fromVersion, now, ctx.appVersion, ctx.backup?.file ?? null, ctx.backup?.sha256 ?? null, ctx.backup?.bytes ?? null,
    JSON.stringify(ctx.preCounts ?? {}), JSON.stringify({ inserted, unassigned }));
  if (record.changes === 1) {
    appendActivityRow(db, {
      actorKind: 'system', actorId: 'system', entityType: 'schema', entityId: '7', action: 'db.migrated', status: 'succeeded',
      details: { from: ctx.fromVersion, to: 7, backupFile: ctx.backup?.file ?? null, backupSha256: ctx.backup?.sha256 ?? null,
        backfilled: inserted, unassigned }
    }, now);
  }
  verifyV7(db, ctx);
  return { backfilled: inserted, unassigned };
}
