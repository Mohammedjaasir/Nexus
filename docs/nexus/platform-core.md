# Nexus platform core (schema v7)

This is the reference for the B0b platform core. It covers the schema, the authorization chain, the activity log, the job, version and agent-session state tables, and the lineage vocabulary. It also has the migration procedure and the operator runbook for backup, hold and restore.

The code is the source of truth. Table, index and trigger names below are copied from `V7_DDL` and `V7_EXPECTED` in `src/main/nexus/db/schemaV7.ts`, and `test/nexus-db-migration.test.cjs` pins those names against a real database. Where the code differs from the B0b plan, the code is described and the difference is listed in [section 17](#17-differences-from-the-plan-and-the-architecture).

Paths are written relative to `userData`, Electron's `app.getPath('userData')` folder for this app. The database file is `userData/harness.db`.

**What B0b is, and is not.**
- It is schema v7, plus platform services in the Electron main process. The services cover principals and authorization, workspaces and participation, artifacts and immutable versions, a version-level lineage DAG, durable jobs and agent sessions, and an append-only, redacted, hash-chained activity log.
- Nothing executes. There is no executor, scheduler, lease, runtime, blob store, MCP server or utilityProcess engine.
- There is no IPC. `src/main/index.ts` composes the platform and runs its startup pass, and no renderer path can reach it.
- No product path creates artifacts, versions, jobs or sessions yet. On a real database the platform tables hold only seeds, the participation backfill and activity rows.

---

## Contents

1. [Where the code lives](#1-where-the-code-lives)
2. [Entities and tables](#2-entities-and-tables)
3. [Indexes and their access reasons](#3-indexes-and-their-access-reasons)
4. [Triggers](#4-triggers)
5. [Seeds and the backfill](#5-seeds-and-the-backfill)
6. [The authorization chain](#6-the-authorization-chain)
7. [Activity: redaction and the hash chain](#7-activity-redaction-and-the-hash-chain)
8. [Artifacts and the version state table](#8-artifacts-and-the-version-state-table)
9. [Lineage and the 32-relation vocabulary](#9-lineage-and-the-32-relation-vocabulary)
10. [Jobs and the job state table](#10-jobs-and-the-job-state-table)
11. [Agent sessions](#11-agent-sessions)
12. [Workspaces, participation and Phase A](#12-workspaces-participation-and-phase-a)
13. [Wiring in main](#13-wiring-in-main)
14. [Migration procedure](#14-migration-procedure)
15. [Runbook: backup, logs, hold and restore](#15-runbook-backup-logs-hold-and-restore)
16. [Known limitations and operational notes](#16-known-limitations-and-operational-notes)
17. [Differences from the plan and the architecture](#17-differences-from-the-plan-and-the-architecture)
18. [Deferred to later phases](#18-deferred-to-later-phases)
19. [Tests](#19-tests)

---

## 1. Where the code lives

| Path | Role |
|---|---|
| `src/main/db.ts` | `PersistStore`: opens `harness.db` and runs the v1 to v6 migrations and the v7 orchestration (pre-check, backup, single transaction, post-check, log lines, hold, failure marker). It also holds the Phase A coupling: the primary sync on save, and the delete guard. |
| `src/main/nexus/db/schemaV7.ts` | `V7_DDL` (frozen migration text), `V7_EXPECTED`, `applyV7`, `verifyV7`, `v7ShapeProblem`, and the backfill. |
| `src/main/nexus/db/v7Seed.ts` | The frozen v7 seed data. |
| `src/main/nexus/db/backup.ts` | `backupAndVerify` (`VACUUM INTO`, then verify, then finalise and hash), `tableRowCounts`, `integrityOk`, `freeBytes`. |
| `src/main/nexus/db/tx.ts` | `immediateTx`: an IMMEDIATE transaction. SQLITE_BUSY and SQLITE_LOCKED become `platform_unavailable`. |
| `src/main/nexus/activity/*` | `redact.ts`, `chain.ts`, `writer.ts` (the only writer) and `activityService.ts` (reads, chain verify). |
| `src/main/nexus/auth/*` | `principals.ts`, `policy.ts` (pure `decide()`) and `authService.ts` (`authorize`, `require`, `auditDenial`). |
| `src/main/nexus/project/projectAccess.ts` | Project-scoped authorization and the version-readable check. |
| `src/main/nexus/workspace/*` | `workspaceService.ts`, plus `legacyPrimary.ts` (the primary projection of the legacy `domain_id`). |
| `src/main/nexus/artifact/*` | `artifactService.ts`, plus `versionRules.ts` (the F.7 table, storage validation, the content hash, exact JSON). |
| `src/main/nexus/lineage/*` | `edgeWriter.ts` (dedupe, cycle check, insert) and `lineageService.ts` (`record`, walks). |
| `src/main/nexus/jobs/*` | `jobRules.ts` (the state table, `canRetry`) and `jobService.ts`. |
| `src/main/nexus/sessions/*` | `sessionRules.ts` and `sessionService.ts`. |
| `src/main/nexus/platform.ts` | `createNexusPlatform`: the composition root, and `startup()`. |
| `src/shared/nexus/platform.ts` | Shared types only, with no runtime values. |
| `src/shared/nexus/workspaceCatalog.ts` | The live workspace catalogue and the legacy domain mapping. |
| `src/main/index.ts` | Opens the store and composes the platform. No IPC. |
| `tools/nexus-db-restore.cjs` | The verified restore tool ([section 15.6](#156-restore-procedure)). |

---

## 2. Entities and tables

v7 creates **17 tables**. It is additive: every statement is `CREATE … IF NOT EXISTS` or `INSERT OR IGNORE`. No v1 to v6 table is altered or rewritten, and no FK is added to a v1 to v6 table. The only legacy table that v7 tables reference is `projects`.

Vocabularies that later phases extend are lookup tables, not CHECK lists: `job_states`, `job_state_transitions`, `agent_session_states`, `agent_session_transitions` and `lineage_relations`. Changing a CHECK in SQLite means rebuilding the table, which would be a destructive migration. Adding rows is additive.

| Group | Table | What it holds |
|---|---|---|
| Bookkeeping | `nexus_migrations` | One row per platform migration. For v7: `version` 7, `from_version`, `applied_at`, `app_version`, `backup_file` (a basename under `userData/backups`; NULL for a fresh database), `backup_sha256`, `backup_bytes`, `row_counts_json` (pre-migration row count of every table) and `backfill_json` (`{"inserted":n,"unassigned":m}`). |
| Identity | `principals` | `id`, `kind` (`user`, `agent` or `system`), `display_name`, `disabled_at`. Seeded with `user:local` and `system`. |
| | `memberships` | `(principal_id, scope_type, scope_id)` maps to a `role` (`owner`, `admin`, `member` or `viewer`). `scope_type` is `platform` (with `scope_id` `'*'`, enforced by CHECK), `workspace` or `project`. |
| Workspaces | `workspaces` | The FK target for workspace ids: `id` (lowercase, 2 to 32 characters), `created_at`, `retired_at`. Display data stays in the renderer registry. |
| | `project_workspaces` | Participation: a project taking part in a workspace. Columns: `status` (`active`, `withdrawn` or `complete`), `is_primary`, `source` (`backfill`, `legacy_domain` or `user`), `objective`, and the `completion_*` columns (unused in B0b). Constraints: `UNIQUE(project_id, workspace_id)` and `CHECK (is_primary = 0 OR status = 'active')`. `project_id` cascades on project delete; `workspace_id` is RESTRICT. |
| Sessions | `agent_session_states`, `agent_session_transitions` | The session vocabulary: 8 states and 14 transitions. |
| | `agent_sessions` | One agent conversation in one project participation. See [section 11](#11-agent-sessions). |
| Jobs | `job_states`, `job_state_transitions` | The job vocabulary: 11 states and 23 transitions. |
| | `jobs` | One unit of work. `kind` is `agent.run`, `tool.run`, `validate` or `ingest`. It records the participation and an optional `session_id` (required for `agent.run` by CHECK), `parent_job_id`, `retry_of`, a UNIQUE `idempotency_key`, `requested_by` and `on_behalf_of`. It also holds the state and timing columns, the exact `params_json`, the redacted `error_json`, the retry policy, `attempts`, and the runtime refs. |
| | `job_inputs` | The versions a job may read: `(job_id, version_id, role)` plus the `content_hash` copied from the version. |
| Artifacts | `artifacts` | A named, kinded artifact, owned by one participation (`owner_participation_id` and `owner_workspace_id`). Columns include `status` (`active` or `archived`), a circular `current_version_id`, and `metadata_json`. |
| | `artifact_versions` | Immutable versions. Columns: `version_no` (unique per artifact), `status` (the F.7 table), `storage_kind` and `storage_ref_json`, `content_hash`, `inputs_json`, `io_contract_json`, `metadata_json`, `validation_state`, `produced_by_job_id`, `produced_by_session_id`, `actor_id`, `on_behalf_of`, `promoted_by` and `promoted_at`, `client_key`. |
| Lineage | `lineage_relations` | The 32 relations: `relation`, `description`, `planned_phase` (documentation only). |
| | `artifact_edges` | Version-level DAG edges. `from_version_id` is the consumer and `to_version_id` its source. The table also holds `relation` (an FK to `lineage_relations`), `source` (`job_input`, `ingest`, `user_action` or `handoff_convert`), `job_id` and `created_by`. It has `UNIQUE(from_version_id, to_version_id, relation)` and `CHECK (from_version_id <> to_version_id)`. |
| Audit | `activity` | Append-only, redacted and hash-chained. `seq` is AUTOINCREMENT. The row carries the actor (`actor_kind`, `actor_id`, `on_behalf_of`), the references (`session_id`, `job_id`, `attempt_n`, `workspace_id`, `project_id`, `artifact_id`, `version_id`, `entity_type`, `entity_id`), plus `action`, `status`, `details_json`, `prev_hash` and `hash`. **There are no FKs, by design**: the audit outlives the rows it names, and a denial row may name a principal or project that does not exist. |

**ON DELETE behaviour towards `projects`.**
- `project_workspaces` uses CASCADE. Participations go with their project.
- `artifacts`, `artifact_versions`, `jobs` and `agent_sessions` use RESTRICT. A project that owns platform records cannot be deleted. The B0b build refuses such a delete before writing ([section 12](#12-workspaces-participation-and-phase-a)).

---

## 3. Indexes and their access reasons

Every named index is listed in `V7_EXPECTED.indexes` (17). The implicit autoindexes from PRIMARY KEY and UNIQUE constraints are listed too, because several hot paths rely on them.

| Index | On | Access path it serves |
|---|---|---|
| `UNIQUE(project_id, workspace_id)` (auto) | `project_workspaces` | The participations of a project (`WorkspaceService.participations`). The (project, workspace) row used by attach idempotency, `participationFor`, the legacy primary sync, and the `EXISTS` sub-query in `AuthService.rolesFor` that admits a workspace grant only for an active participation. |
| `ux_pw_primary` (unique, partial `WHERE is_primary = 1`) | `project_workspaces(project_id)` | The invariant of one primary per project, and `primaryOf`. |
| `ix_pw_workspace` | `project_workspaces(workspace_id, status)` | Active projects in a workspace (`WorkspaceService.projectIdsIn`), and the RESTRICT check if a `workspaces` row is ever deleted. B0b never deletes one. |
| `memberships` PK `(principal_id, scope_type, scope_id)` | `memberships` | `authorize()`: a principal's roles across the platform, workspace and project scopes (`rolesFor`). |
| `ix_sessions_project` | `agent_sessions(project_id, created_at DESC)` | A project's sessions, newest first (`SessionService.listByProject`). |
| `ix_sessions_status` | `agent_sessions(status, updated_at)` | Restart recovery (`status IN ('running','awaiting_approval')`), and later "active sessions" listings. |
| `ix_sessions_participation` | `agent_sessions(participation_id)` | The count of live sessions of a participation on withdraw, and the FK check from `project_workspaces`. |
| `agent_sessions.idempotency_key` UNIQUE (auto) | `agent_sessions` | Idempotent `open`: a re-sent intent returns the same session. |
| `ix_jobs_project` | `jobs(project_id, created_at DESC)` | A project's jobs, newest first (`JobService.listByProject`). |
| `ix_jobs_state` | `jobs(state, updated_at)` | Restart recovery (`state IN ('leased','running','awaiting_approval')`), and later "active jobs" listings. |
| `ix_jobs_participation` | `jobs(participation_id)` | The count of live jobs of a participation on withdraw, and the FK check from `project_workspaces`. |
| `ix_jobs_session` (partial `WHERE session_id IS NOT NULL`) | `jobs(session_id, created_at)` | A session's jobs in order (`JobService.listBySession`, `SessionService.jobsOf`), and the session cancel cascade. |
| `jobs.idempotency_key` UNIQUE (auto) | `jobs` | Idempotent `create` (architecture J.7). |
| `ix_artifacts_project_kind` | `artifacts(project_id, kind)` | Artifacts of a project, optionally by kind (`ArtifactService.listByProject`), and the FK check from `projects`. |
| `ix_artifacts_owner` | `artifacts(owner_participation_id)` | Artifacts owned by a participation, and the FK check from `project_workspaces`. |
| `ix_artifacts_current` (partial `WHERE current_version_id IS NOT NULL`) | `artifacts(current_version_id)` | The `tr_versions_current_stays_active` lookup on every version status change ("which artifact points at version V"). |
| `UNIQUE(artifact_id, version_no)` (auto) | `artifact_versions` | Version allocation (`COALESCE(MAX(version_no), 0) + 1`), versions by artifact in order (`listVersions`), and the uniqueness backstop. |
| `ux_versions_job_client` (unique, partial `WHERE client_key IS NOT NULL`) | `artifact_versions(produced_by_job_id, client_key)` | Idempotent `registerVersion` per (job, clientKey) (J.7). |
| `UNIQUE(from_version_id, to_version_id, relation)` (auto) | `artifact_edges` | Edge dedupe in `writeEdge`, the upstream walk, and the cycle CTE (`e.from_version_id = up.v`). |
| `ix_edges_to` | `artifact_edges(to_version_id)` | The downstream (impact) walk, and the `wouldCycle` shortcut ("does anything consume `from` yet?"). |
| `job_inputs` PK `(job_id, version_id, role)` | `job_inputs` | A job's inputs (`toJob`, idempotency comparison), and the `input_not_granted` checks in `registerVersion` and `LineageService.record`. |
| `ix_activity_project` | `activity(project_id, seq)` | Activity by project, in order (`ActivityService.list`, newest first). |
| `ix_activity_session` (partial) | `activity(session_id, seq)` | Activity by agent session, in order. |
| `ix_activity_job` (partial) | `activity(job_id, seq)` | Activity by job (one run inside a session), in order. |
| `activity.id` UNIQUE (auto) | `activity` | Lookup by id, and the duplicate guard. |

Architecture indexes deliberately not built: each has no B0b query, and adding one later is additive.

| Index | Waits for |
|---|---|
| `ix_versions_project_status` | Spine queries (B1) |
| `ix_versions_hash` | The blob dedupe and GC phase |
| `ux_versions_job_path` | The ingest phase |
| `ix_jobs_sched` | The scheduler (execution phase); it adds `(state, priority, created_at)` |
| `ux_repository_per_project` | Repository artifacts (B1). B0b refuses `kind = 'repository'`. |
| `ix_attempts_lease`, `ix_validations_version`, `ix_test_cases_auto`, `ix_results_case` | Their tables, which are deferred |

`jobs.parent_job_id`, `jobs.retry_of` and `artifact_edges.job_id` have no index. Jobs and edges are never deleted, so no FK child scan runs on them, and B0b has no query by those columns.

---

## 4. Triggers

All 27 are listed in `V7_EXPECTED.triggers`. The services enforce the same rules in TypeScript, so errors are typed `PlatformError`s. The triggers are the backstop.

| Trigger | Enforces |
|---|---|
| `tr_pw_identity` | A participation's `id`, `project_id`, `workspace_id`, `created_by` and `created_at` never change. |
| `tr_sessions_insert` | A session starts `open`. Its participation must be ACTIVE and belong to the same project and workspace. Its `context_version_id`, if set, must come from the same project. |
| `tr_sessions_transition` | Every status change is a row of `agent_session_transitions`. |
| `tr_sessions_identity` | `id`, `project_id`, `workspace_id`, `participation_id`, `context_version_id`, `principal_id`, `idempotency_key` and `created_at` never change. |
| `tr_sessions_no_delete` | Sessions are never deleted. |
| `tr_jobs_insert` | A job starts `queued`. Its participation (if any) and its session (if any) must belong to the job's project and workspace. |
| `tr_jobs_transition` | Every state change is a row of `job_state_transitions`. |
| `tr_jobs_identity` | `id`, `kind`, `project_id`, `workspace_id`, `participation_id`, `session_id`, `idempotency_key`, `requested_by`, `on_behalf_of` and `created_at` never change. |
| `tr_jobs_no_delete` | Jobs are never deleted. |
| `tr_artifacts_insert` | An artifact starts without a current version. Only `repository` may be project-owned, and it has no owning participation. The owner participation must belong to the project and name `owner_workspace_id`. |
| `tr_artifacts_identity` | Identity and ownership never change: `id`, `project_id`, `kind`, `owner_scope`, `owner_participation_id`, `owner_workspace_id`, `created_by` and `created_at`. |
| `tr_artifacts_current` | `current_version_id` can move but never be cleared. It must point at an `active` version of the same artifact. |
| `tr_artifacts_no_delete` | Artifacts are archived, never deleted. |
| `tr_versions_insert` | A version starts as `draft`. Only the artifact's owning participation adds versions, the artifact must be `active`, and the owning participation must be `active`. A producing session must be in the same project. |
| `tr_versions_identity` | `id`, `artifact_id`, `version_no`, `project_id`, `participation_id`, `actor_id`, `on_behalf_of`, `produced_by_job_id`, `produced_by_session_id`, `client_key`, `output_path` and `created_at` never change. |
| `tr_versions_immutable` | Once a version leaves `draft`, its storage, `content_hash`, inputs, metadata, IO contract and environment never change. |
| `tr_versions_status` | Status changes follow the F.7 table ([section 8](#8-artifacts-and-the-version-state-table)). |
| `tr_versions_current_stays_active` | The current version cannot be deactivated until the pointer moves. |
| `tr_versions_no_delete` | Versions are never deleted. |
| `tr_job_inputs_insert` | Inputs come from the job's project, and are fixed once the job leaves `queued`. |
| `tr_job_inputs_no_update`, `tr_job_inputs_no_delete` | Job inputs are immutable. |
| `tr_edges_insert` | Edges stay inside one project. `job_input` and `ingest` edges need a job. |
| `tr_edges_no_update`, `tr_edges_no_delete` | Lineage is append-only. |
| `tr_activity_no_update`, `tr_activity_no_delete` | Activity is append-only. |

SQLite does not allow recursive CTEs in triggers, so the lineage cycle check runs in `edgeWriter.ts`, inside the writing IMMEDIATE transaction.

---

## 5. Seeds and the backfill

The seeds are frozen in `src/main/nexus/db/v7Seed.ts` (`INSERT OR IGNORE`). `verifyV7` re-reads every seed row, because `INSERT OR IGNORE` would otherwise silently swallow a CHECK failure.

- **Principals:** `user:local` (kind `user`, "Local owner") and `system` (kind `system`, "Nexus platform").
- **Memberships**, at platform scope `'*'`: `user:local` is `owner` and `system` is `admin`.
- **Workspaces:** the Phase A registry ids `sde`, `ml`, `dl`, `data`, `research`, `qa`, `uiux` and `devops` (M4).
- **Job states** (`terminal` in brackets): `queued` (0), `leased` (0), `running` (0), `awaiting_approval` (0), `retry_scheduled` (0), `completed` (1), `partial` (1), `failed` (1), `cancelled` (1), `timed_out` (1), `interrupted` (1). There are 23 transitions; see [section 10](#10-jobs-and-the-job-state-table).
- **Session states:** `open`, `running` and `awaiting_approval` are non-terminal. `completed`, `failed`, `cancelled`, `timed_out` and `interrupted` are terminal. There are 14 transitions; see [section 11](#11-agent-sessions).
- **Lineage relations:** 32, see [section 9](#9-lineage-and-the-32-relation-vocabulary).

**The backfill** (`backfillProjectWorkspacesV7`) uses the frozen map `V7_DOMAIN_TO_WORKSPACE`. That map equals the renderer's `workspaceForDomain` over the registry, and `test/nexus-core-workspace-catalog.test.cjs` pins the two together.

| Legacy `domain_id` | Workspace |
|---|---|
| `software-engineering`, `web-app-dev`, `mobile-dev`, `game-dev`, `embedded-systems`, `robotics-iot`, `blockchain-web3`, `automation-rpa` | `sde` |
| `ai-ml` | `ml` |
| `computer-vision` | `dl` |
| `data-analytics`, `data-science`, `gis-geospatial` | `data` |
| `research-scientific` | `research` |
| `devops-cloud` | `devops` |

How the backfill applies the map:
- Each project with a mapped domain gets one row: `is_primary = 1`, `status = 'active'`, `source = 'backfill'`, `created_by = 'system'`.
- `cybersecurity` and unknown ids get no row and stay "Unassigned", exactly as the renderer shows them.
- Secondary domains create nothing.
- A project that already has a primary, or a row for that workspace, is skipped, so a re-run inserts nothing.

---

## 6. The authorization chain

```
caller in main ──Principal {id, kind}──▶ AuthService.require(p, action, scope)
                                            │ 1. re-resolve the principal from `principals`
                                            │ 2. roles from `memberships` that match the scope
                                            │ 3. decide() (pure, policy.ts)
                                            ├─ allowed ──▶ the service opens its IMMEDIATE transaction
                                            └─ denied  ──▶ one `denied` activity row, PlatformError('denied')
```

**1. Principal.** The renderer never supplies identity: main resolves a `Principal` through `PrincipalResolver`. `AuthService` re-reads the stored row on every call. A caller object whose `kind` differs from the stored kind is not that principal (`unknown_principal`), so a caller cannot raise itself to `system`.

**2. Scope and roles** (`rolesFor`):

| Scope | Membership rows that count |
|---|---|
| `{ type: 'platform' }` | The platform `'*'` row. |
| `{ type: 'workspace', workspaceId }` | Platform, plus that workspace's row. |
| `{ type: 'project', projectId }` | Platform, plus that project's row. |
| `{ type: 'project', projectId, workspaceId }` | The above, plus the workspace's row **only while the project has an ACTIVE `project_workspaces` row for that workspace**. |
| Anything else | Nothing (fail closed). |

**3. Decision** (`decide()`, first match wins):
1. `unknown_principal`.
2. `disabled_principal`.
3. `agent_requires_token`: agents act only through capability tokens, which arrive later.
4. A system-only action is allowed only for kind `system`; anyone else gets `system_only`.
5. `no_membership`.
6. The strongest role across all matching rows must cover the action's minimum role, else `role` with `needed`.

| Minimum role | Actions |
|---|---|
| `viewer` | `project.read`, `workspace.read`, `artifact.read`, `lineage.read`, `job.read`, `session.read`, `activity.read` |
| `member` | `participation.attach`, `participation.withdraw`, `artifact.create`, `version.register`, `version.update_draft`, `version.discard`, `version.promote`, `lineage.write`, `job.create`, `job.cancel`, `session.open`, `session.cancel` |
| `admin` | `artifact.archive` |
| system only | `version.finalize`, `job.transition`, `session.transition`, `system.reconcile` |

**Rules every service follows:**
- **Authorize first, before any transaction**, so a denial is audited in its own IMMEDIATE transaction.
- **The workspace used as authority always comes from a stored row.** Services use the participation of a job or session, the artifact's `owner_workspace_id`, or the participation being withdrawn. They never use a workspace named by the caller (`ProjectAccess` rule). When no stored row exists yet (attach, or the first create in a workspace), the caller is authorized at plain project scope, and the workspace id only selects the participation.
- **Authorization comes before existence.** A principal without access gets `denied` whether or not the record exists. An unknown id is `not_found` only for a principal authorized for the action at platform scope.
- **Reading an input version** (job inputs, session context, version inputs) needs `artifact.read` with the version's owner workspace (`ProjectAccess.requireVersionReadable`). This check runs before any status check, so a draft's status does not leak. A missing version, and a version of another project, are first authorized with `artifact.read` at the caller's project scope and then at platform scope; only then are they `not_found` and `invalid`. A principal not authorized platform-wide gets `denied` for both, with identical denial rows, and learns nothing about the foreign version.
- **Denials outside `authorize()`** use `AuthService.auditDenial`, which writes the same `denied` row. Examples are `input_not_granted`, `not_session_principal`, and a non-system `ingest` edge. `auditDenial` records the STORED principal: a forged kind for a known id is recorded under its stored kind. An unknown id is recorded as `agent` when it claims `agent` and as `user` otherwise, never as `system`. Whenever the claimed kind differs from the recorded one, the claim is kept in `details.claimedKind`. Every id-like field, the action and the reason are capped at 128 characters, and `details.truncated = true` marks a row where any of them was cut. `reason`, `needed`, `claimedKind` and `truncated` cannot be set by caller details.
- **A denial inside a caller's open transaction** is not written into it, because a rollback would lose it. It is queued and written after the transaction ends ([section 16, item 5](#16-known-limitations-and-operational-notes)).

---

## 7. Activity: redaction and the hash chain

**Writer.** `appendActivityRow` (`activity/writer.ts`) is the only way rows enter `activity`.
- It runs inside the caller's transaction, so the row commits or rolls back with the operation it records.
- With no transaction open, it opens its own IMMEDIATE transaction.
- Callers must use IMMEDIATE transactions. The chain head is then read under the write lock, so two writers serialise and the chain stays linear.

**Redaction** (`redactDetails`, `activity/redact.ts`). `details_json` is always this function's output:
- A key that names a secret loses its value. The secret-name pattern covers `secret`, `token`, `passw`, `pwd`, `passphrase`, `api key`, `authorization`, `cookie`, `credential`, `private key`, `session key`, `access key`, `auth token` or `auth header`, a bare `auth`, `signature`, `dsn`, and connection strings.
- Every string goes through the crash-log redactor `redactForLog`. It strips PEM private keys, JWTs, provider key shapes, bearer and basic credentials, authorization headers, URL credentials, chat webhook URLs, hex runs of 48 or more characters, and sensitive `key=value` pairs. Two extra passes remove URL user names and `sig=` or `signature=` values.
- Bounds:
  - a string over 512 characters becomes `[omitted: n chars]`;
  - binaries become `[binary: n bytes]`;
  - depth is capped at 4, arrays at 50 items and objects at 50 keys (with `__truncated`);
  - the whole output is capped at 16 KiB, else `{ omitted: '[details too large: n bytes]' }`.
- Exempt fields:
  - integrity hashes (a hex digest, optionally `git:`-prefixed) under the keys `backupSha256`, `sha256`, `contentHash` and `content_hash` are kept;
  - numeric token-usage counts under exact keys (`tokensUsed`, `inputTokens`, `outputTokens` and similar) are kept.
- It never throws.

**Hash chain** (`activity/chain.ts`).
- Each row's hash is `sha256(prev_hash + canonicalJson(fields))`.
- The hashed fields are `id`, `ts`, the actor, `on_behalf_of`, `session_id`, `job_id`, `attempt_n`, `workspace_id`, `project_id`, `artifact_id`, `version_id`, `entity_type`, `entity_id`, `action`, `status`, and the stored `details_json` text.
- The first row chains to 64 zeros.
- `verifyActivityChain` (exposed as `ActivityService.verifyChain`, which needs platform `activity.read`) reports the first broken `seq`.
- The chain detects an edited or reordered row. It does not detect deletion of the newest rows ([section 16, item 1](#16-known-limitations-and-operational-notes)).

**Reads** (`ActivityService.list`).
- A project filter needs `activity.read` on that project.
- Any other filter (session, job, or none) needs it at platform scope, because a session or job id alone does not prove which project the caller may see.
- Results are newest first, paged with `beforeSeq`, 50 by default and at most 200.

**Actions written in B0b:**
- `db.migrated` (once, in the v7 transaction);
- `project_workspace.primary_synced` and `workspace.catalog_ensured`;
- `participation.attach` and `participation.withdraw`;
- `artifact.create` and `artifact.archive`;
- `version.register`, `version.update_draft`, `version.finalize`, `version.discard` and `version.promote`;
- `lineage.write`;
- `job.create`, `job.transition`, `job.cancel` and `job.recover`;
- `session.open`, `session.transition`, `session.cancel` and `session.recover`;
- `denied` rows for every refused action.

---

## 8. Artifacts and the version state table

**Ownership.**
- An artifact belongs to the ACTIVE participation of (project, workspace) at creation. The service resolves the row; the caller only names the workspace.
- Only that participation appends versions (`tr_versions_insert`).
- A withdrawn owner freezes its artifacts. Register, edit, discard and promote then return `participation_inactive`. The engine's `finalize` may still close a frozen draft as `failed`.
- `repository` (project-owned) is refused until B1.

**Versions.**
- `version_no` is `COALESCE(MAX)+1` inside BEGIN IMMEDIATE.
- B0b storage is `inline` (exact JSON, at most 64 KiB of canonical JSON; the content hash is the sha256 of the canonical JSON) or `git` (a 40-hex commit; the hash is `git:<commit>`). `blob`, `tree` and `external` return `storage_unavailable` until the blob store exists.
- Caller JSON (inline payload, metadata, IO contract) must be exact JSON. Nothing is coerced, and own `__proto__` keys are refused.
- An artifact name, description or metadata, and a version's metadata or IO contract (on register and on `updateDraft`), that hold anything secret-shaped are refused before any transaction: `invalid` with `detail.reason = 'secret_in_metadata'` (`containsSecret` for JSON, `redactText` for text). Inline storage content is not checked ([section 16, item 11](#16-known-limitations-and-operational-notes)).

**F.7 status table.** `VERSION_TRANSITIONS` in `versionRules.ts` mirrors `tr_versions_status`:

| From | To |
|---|---|
| `draft` | `candidate`, `failed`, `deprecated` |
| `candidate` | `active`, `deprecated` |
| `active` | `deprecated` |
| `deprecated` | `active` (rollback: only a version that was active before, so `promoted_at` is set) |
| `failed` | (none) |

Who moves a version:
- `finalize` is system only: draft to candidate or failed.
- `discard` moves a draft or candidate to deprecated.
- `promote` moves candidate to active, or deprecated back to active as a rollback. It is a compare-and-set on `artifacts.current_version_id`, in one transaction: activate the version, move the pointer, then deprecate the previous active versions. Every kind is single-active until the kind registry exists.

**Producers.**
- A producing job or session must exist, be in the artifact's project, act for the artifact's owner participation, and not be terminal. A finished job or an ended session is a `conflict` (the same code `job.create` uses for an ended session).
- With a job, every input must be granted to it in `job_inputs` as the same (version, role). Otherwise the call fails with `input_not_granted` and one denied row.
- A repeated (job, clientKey) returns the stored version if the content hash matches, and is a `conflict` if it does not.

---

## 9. Lineage and the 32-relation vocabulary

**Edges come only from Nexus records.** `LineageService.record` takes version ids and a relation from `lineage_relations`, never free text.

| Source | Rule |
|---|---|
| `user_action` | A user principal only, with no job. |
| `job_input` | `from` was produced by the named job, and `to` is one of its declared inputs. Otherwise `input_not_granted`, with one denied row. |
| `ingest` | The system principal only, with the producing job named. A non-system caller gets a denied row (`system_only`). |
| `handoff_convert` | Refused until handoffs exist (B2). |

**Endpoint and write rules.**
- Both endpoints must be in one project.
- The target (`to`, the consumed source) must be out of draft. The consumer may still be a draft.
- `lineage.write` is authorized on each endpoint with its stored owner workspace.
- The dedupe, the cycle check (a recursive CTE with `UNION`, so it terminates with no depth cap; D6) and the insert run in one IMMEDIATE transaction.
- A new edge writes one activity row. An identical re-send returns the stored edge. The same (from, to, relation) with a different source or job is a `conflict`.

**Walks** (`upstream` and `downstream`).
- A walk is breadth first, one indexed query per level. Depth is 6 by default, clamped to 1..32; a non-finite depth is `invalid`.
- The start version needs `lineage.read`.
- Every reached version is filtered with a read-only `authorize()`, once per distinct (project, owner workspace), with no audit row.
- See [section 16, item 8](#16-known-limitations-and-operational-notes) for dropped nodes and the 5000-node cap.

**Vocabulary.** The vocabulary is the brief's eight relations plus the full architecture L.1 set: 32 rows (M2). `planned_phase` records the phase expected to write each relation first. It is documentation only: B0b attaches no behaviour to a relation beyond vocabulary membership.

| Relation | Meaning | `planned_phase` |
|---|---|---|
| `derived_from` | A newer version of the same kind, a new artifact derived from another version, or a change set derived from its base repository commit | B1 |
| `contains` | A repository snapshot that contains a change set (git ancestry) | B1 |
| `extracted_from` | An API description extracted from a repository | B1 |
| `built_from` | A build made from a repository | B1 |
| `assembled_from` | An application assembled from a build | B1 |
| `fixes` | A change set that fixes a defect | B2 |
| `tests` | A test run that tests a build or an application | B2 |
| `executes` | A test run that executes a test plan | B2 |
| `found_in` | A defect found in a build | B2 |
| `evidenced_by` | A defect evidenced by a test run | B2 |
| `verified_by` | A defect verified by a test run | B2 |
| `summarizes` | A quality report that summarizes a test run or a defect | B2 |
| `recommends` | A release recommendation that recommends a build | B2 |
| `based_on` | A release recommendation based on a quality report | B2 |
| `depends_on` | An experiment that depends on a baseline evaluation, a test plan that depends on a report, or an application that depends on an API | B2 |
| `queried_from` | A query that reads from a dataset | B3a |
| `visualizes` | A dashboard that visualizes a query | B3a |
| `cites` | A report or insight that cites a query, dashboard, analysis, experiment, evaluation or dataset | B3a |
| `analyzes` | An analysis of a dataset or a query | B3a |
| `tested_on` | An experiment tested on a dataset | B3b |
| `evaluates` | An evaluation of a model or a model export | B3b |
| `evaluated_on` | An evaluation run on a dataset | B3b |
| `run_of` | A training run that belongs to an experiment | B4 |
| `trained_on` | A training run or model trained on a dataset | B4 |
| `produced_by` | A model or checkpoint produced by a training run | B4 |
| `packages` | A serving package that packages a model or a model export | B4 |
| `serves` | A change set that serves a serving package or model export version | B4 |
| `resumed_from` | A training run resumed from a checkpoint | B5 |
| `selected_from` | A model selected from a checkpoint | B5 |
| `exported_from` | A model export made from a model | B5 |
| `deployed_as` | A version rolled out as a deployment. Deployment records arrive in B6; vocabulary only until then | B6 |
| `implements` | A version that realises a specification or design version | unassigned |

The brief's eight are `derived_from`, `trained_on`, `evaluated_on`, `implements`, `serves`, `built_from`, `deployed_as` and `depends_on` (`BRIEF_LINEAGE_RELATIONS`).

---

## 10. Jobs and the job state table

Eleven states (M1): the brief's nine plus `leased` and `retry_scheduled`. The architecture's `succeeded` is `completed`. `JOB_TRANSITIONS` (`jobRules.ts`) mirrors `job_state_transitions`, and `test/nexus-core-states.test.cjs` compares the two.

| From | To |
|---|---|
| `queued` | `leased`, `cancelled` |
| `leased` | `running`, `queued`, `failed`, `cancelled`, `interrupted` |
| `running` | `awaiting_approval`, `completed`, `partial`, `failed`, `cancelled`, `timed_out`, `interrupted` |
| `awaiting_approval` | `running`, `failed`, `cancelled`, `timed_out`, `interrupted` |
| `failed` | `retry_scheduled` |
| `timed_out` | `retry_scheduled` |
| `retry_scheduled` | `queued`, `cancelled` |
| `completed`, `partial`, `cancelled`, `interrupted` | (none) |

That is 23 transitions. `queued → running` does not exist: a job is `leased` first.

| Architecture J.2 | v7 |
|---|---|
| `succeeded` | `completed` |
| `running` with phase `awaiting_approval` | `awaiting_approval` (a state) |
| `failed` with outcome `interrupted` | `interrupted` (a state) |
| A succeeded `agent.run` with a failed output version | `partial` |

**Column rules** (`JobService.applyTransition`):
- `→ leased` counts an attempt.
- The first `→ running` sets `started_at`.
- A terminal state sets `finished_at` and `outcome`.
- `retry_scheduled → queued` clears `finished_at`, and clears `outcome` and `error_json` unless new values are given.
- `→ retry_scheduled` needs `canRetry`: the job was declared idempotent, has attempts left, and is not `agent.run`.
- **No resurrection.** `→ retry_scheduled` and `→ queued` are refused once the participation is not active or the job's session has ended.

**Service rules.**
- `create` is idempotent by `idempotencyKey`. A re-send compares the requester, kind, project, workspace, session, parent and retryOf every time. It compares the recipe, validator, priority, inputs (as a set), retry, runtime and raw params when they are supplied. Different work is a `conflict`.
- A job runs in the ACTIVE participation. A missing row is `not_participating`; a withdrawn or complete row is `participation_inactive`.
- `agent.run` needs a live session in the same participation, and only the session's principal (or the system) adds jobs to it (`not_session_principal`). A job for a session that has ended is a `conflict`.
- A child job must share its parent's participation and session.
- Inputs must be candidate or active versions of the job's project that the caller can read. Their content hash is copied into `job_inputs`.
- `transition` is system only. `requestCancel` is a user action (see [section 16, item 4](#16-known-limitations-and-operational-notes)).
- Params are stored exactly ([section 16, item 6](#16-known-limitations-and-operational-notes)). Errors are stored redacted ([section 16, item 7](#16-known-limitations-and-operational-notes)). Runtime refs that look secret are refused (`secret_in_ref`).

**Restart recovery** (`recoverAfterRestart`, system only, idempotent):
- `running` and `awaiting_approval` jobs become `interrupted`.
- A `leased` job goes back to `queued`, unless its participation is inactive or its session has ended; then it is interrupted.
- `queued` and `retry_scheduled` jobs are untouched.

This is correct only while nothing executes across restarts. The execution phase replaces it with the full R.2 routine.

---

## 11. Agent sessions

A session is the durable record of one agent conversation in a project's workspace. It has its own table, `agent_sessions` (M3, with D5 overruled). The brief's session fields map onto columns like this:

| Session field (brief) | `agent_sessions` column |
|---|---|
| Session id | `id` |
| Project, workspace | `project_id`, `workspace_id`, plus the resolved `participation_id` (must be active at insert) |
| Artifact context | `context_version_id` (nullable; a candidate or active version of the same project that the caller can read) |
| Principal | `principal_id`: the calling principal, never named in the input |
| Status | `status` (an FK to `agent_session_states`) |
| Created, updated | `created_at`, `updated_at`, `status_changed_at`, `ended_at` |
| Runtime or provider ref | `runtime_kind`, `runtime_ref` (refused if it looks secret) |
| Cancellation | `cancel_requested_at`, `cancel_requested_by` (both set or both NULL, by CHECK) |
| Error | `error_json` (redacted `{code, message}`) |
| Intent id | `idempotency_key` (UNIQUE; a re-sent `open` returns the same session) |

**Links to the rest of the core.**
- **Jobs:** `jobs.session_id` is nullable. It is required for `agent.run` (CHECK), must name a session in the same project and workspace (`tr_jobs_insert`), and is immutable (`tr_jobs_identity`). Indexed by `ix_jobs_session`.
- **Versions:** `artifact_versions.produced_by_session_id`. The producing session must be in the same project (`tr_versions_insert`); the column is in `tr_versions_identity`. `registerVersion` also requires the session to act for the artifact's owner participation and not to have ended.
- **Activity:** every session mutation writes a row carrying `session_id` (`ix_activity_session`). Job rows carry the session id too.
- **Delete guard:** `hasPlatformRecords` counts sessions, so a project with sessions cannot be deleted.

**State table** (`SESSION_TRANSITIONS` mirrors `agent_session_transitions`, 14 rows):

| From | To |
|---|---|
| `open` | `running`, `failed`, `cancelled` |
| `running` | `awaiting_approval`, `completed`, `failed`, `cancelled`, `timed_out`, `interrupted` |
| `awaiting_approval` | `running`, `failed`, `cancelled`, `timed_out`, `interrupted` |
| `completed`, `failed`, `cancelled`, `timed_out`, `interrupted` | (none) |

**Operations.**
- `open` is idempotent. A re-send for a different project, workspace, principal or context is a `conflict`.
- `transition` is system only; a terminal status sets `ended_at`.
- `cancel` runs in one transaction. It records who asked and when, cancels every non-terminal job of the session (children before parents), then moves the session to `cancelled`, with one activity row per change.
- `recoverAfterRestart` moves `running` and `awaiting_approval` sessions to `interrupted`. `open` sessions are untouched.
- A session's status is not derived from its jobs. How job outcomes drive it is a runtime-phase decision.

---

## 12. Workspaces, participation and Phase A

- `attach` adds a NON-primary participation. It is idempotent: an active row is returned as is, a withdrawn row is reactivated, and a `complete` row is a `conflict`.
- `withdraw` refuses the primary (`invalid`). While the participation has any non-terminal job or session, it refuses with `conflict`. The row is kept with status `withdrawn`.
- **The primary is a projection of `projects.domain_id` in B0b (D4).** `PersistStore.saveProject` runs `syncPrimaryFromLegacyDomain` in a caught SAVEPOINT inside the save's IMMEDIATE transaction. A sync failure never fails the legacy save. If the failure aborts the whole transaction, the project row is saved once more without the sync. At startup, `reconcileLegacyPrimaries` repairs drift, including rows written by an older build.
  - **A mapped domain:** the target row becomes active and primary (inserted with `source = 'legacy_domain'` when missing), and every other row is cleared first.
  - **An unmapped domain:** every primary flag is cleared, and the rows are kept.
  - **A target whose participation is `complete`:** see [section 16, item 3](#16-known-limitations-and-operational-notes).
- **The delete guard (D2).** `PersistStore.deleteProject` refuses, returning `false` and writing nothing, while the project has rows in `artifacts`, `jobs` or `agent_sessions` (`hasPlatformRecords`). It logs `[nexus] deleteProject refused project=<id>: it has platform records (artifacts, jobs or agent sessions)`. A failing check answers "present", so a project is kept rather than half-deleted. Participations alone do not block a delete: they cascade.
- **The graph goes with the row.** `ProjectManager.deleteProject` calls `PersistStore.deleteProject(id, { withGraph: true })`. The store deletes the knowledge graph in the same transaction as the project row, only when the row is actually removed, and only after the platform-record re-check of a queued delete. A delete refused at any point, including a queued delete refused when it finally runs, keeps the graph. A normal delete removes it, as in Phase A.

---

## 13. Wiring in main

`src/main/index.ts`, in `whenReady`:
0. The first line returns when the single-instance lock was not obtained (`gotInstanceLock`), so a losing second instance never opens the store.
1. `persist.open({ log: nexusMainLog, backupDir: join(userData, 'backups'), holdV7: process.env.NEXUS_DB_HOLD_V7 === '1', appVersion })`. The call is guarded: a DB failure degrades to defaults and never blocks startup.
2. If `persist.platformAvailable` (v7 and the post-check passed), main composes the platform: `createNexusPlatform(persist.platformDatabase(), { log })`, on the same better-sqlite3 connection as the legacy store.
3. Main then calls `startup()`. It resolves the seeded principals, ensures the workspace catalogue, reconciles the legacy primaries, recovers sessions and then jobs, and logs one `[nexus] platform ready` line.
4. Any throw leaves `nexusPlatform = null` and logs `[nexus] platform startup failed error=<name> code=<code>; platform disabled, legacy features unaffected`.

No IPC channel and no preload change are registered. Nothing reads `nexusPlatform` in B0b.

---

## 14. Migration procedure

`PersistStore.open()` and `migrate()` in `src/main/db.ts`, for a database at `user_version = from`:

0. **Open** with WAL, `synchronous=NORMAL`, `busy_timeout=5000` and `foreign_keys=ON`. Legacy writes submitted before or during open wait in the `LegacyWriteQueue` and flush after open, so the app writes nothing before the backup is verified.
1. **Decide:**
   - `from > 7`: opened for legacy use, platform disabled, nothing migrated (`newer_schema`).
   - `from = 7`: `v7ShapeProblem` checks the schema. The platform is available only if the shape is exact. Nothing is migrated.
   - Hold set (`NEXUS_DB_HOLD_V7=1`): the legacy steps run up to v6; outcome `skipped: held`.
   - The failure marker counts 3 or more: the legacy steps run; outcome `skipped: held` (repeated_failure); no backup is taken.
   - `from = 0` (fresh): no backup; continue at step 5.
2. **Pre-checks**, which do not touch the database:
   - `integrity_check = ok`;
   - free space in the backup folder is at least 2 × (size of `harness.db` plus `-wal`);
   - row counts of every user table are taken.

   A failure runs the legacy steps only (`precheck_failed` or `insufficient_disk`).
3. **Backup.** `VACUUM INTO` writes `userData/backups/harness-v<from>-<UTC>.db.partial` outside any transaction. This is a consistent snapshot that includes WAL content. An existing name is never overwritten; within the same second, the stamp moves to the next second, up to 4 times.
4. **Verify the backup.** Open the copy with `fileMustExist` and set `journal_mode=DELETE`. Check `integrity_check = ok`, `user_version = from`, and row counts equal to the pre-counts. Then finalise the `.partial` (hard link, then remove the `.partial`; a rename is the fallback), re-open the final file read-only, run `quick_check`, and hash it with sha256. A failure removes the partial file, runs the legacy steps only, and gives `backup_failed`. Only after this step may the original change.
5. **Legacy steps.** If `from < 6`, migrations `from+1` to 6 run exactly as before, one transaction each, now protected by the backup.
6. **Migrate** in one `BEGIN IMMEDIATE` transaction: `applyV7`, then `user_version = 7`, then COMMIT. `applyV7` runs, in order:
   1. the shape pre-check, which refuses a pre-existing object of the wrong shape (`IF NOT EXISTS` would otherwise accept it silently);
   2. `V7_DDL`;
   3. the seeds;
   4. the backfill;
   5. the `nexus_migrations` row (`INSERT OR IGNORE`);
   6. one `db.migrated` activity row, only if that record is new;
   7. `verifyV7`: every table, column, index and trigger matches the DDL; every seed row is present; `foreign_key_check` is empty; and every legacy table's row count equals its pre-count.

   Any throw rolls the whole step back, including `user_version`.
7. **After COMMIT:** clear the failure marker and run `quick_check`. If it is not `ok`, the platform is disabled and the log names the backup to restore from.
8. **On a throw in step 6:** the database stays at the legacy version, the backup is kept, the failure marker is incremented, and the store finishes opening, so Phase A runs and the queued legacy writes flush. `open()` never throws because of v7.

The outcome is `PersistStore.lastMigration`. It is one of `not_needed`, `applied`, `skipped` (with reason `held`, `precheck_failed`, `insufficient_disk`, `backup_failed` or `newer_schema`) or `failed`.

---

## 15. Runbook: backup, logs, hold and restore

### 15.1 Where things are

| What | Where |
|---|---|
| Database | `userData/harness.db` (plus `-wal` and `-shm` while open) |
| Pre-migration backup | `userData/backups/harness-v6-<UTC yyyymmddThhmmssZ>.db`, for example `harness-v6-20261006T120000Z.db`. It is a self-contained file (journal mode DELETE). Backups are never pruned automatically. |
| Failure marker | `userData/harness.db.v7-failures.json`, next to the database: `{"count":n,"lastFailureAt":<ms>}`. |
| Log | `main.log` in Electron's logs folder (`app.getPath('logs')`; on Windows normally `userData/logs`). It rotates at 5 MB and keeps 3 files. Every line is also written to the console. |

### 15.2 The `nexus_migrations` record

After a successful migration, `SELECT * FROM nexus_migrations` returns one row:
- `version = 7` and `from_version = 6`;
- `applied_at` (ms) and `app_version`;
- `backup_file`: the basename only, for example `harness-v6-20261006T120000Z.db`;
- `backup_sha256`: the sha256 of that file, the same value as the `backup ok` log line;
- `backup_bytes`;
- `row_counts_json`: the pre-migration count of every table;
- `backfill_json`: `{"inserted":n,"unassigned":m}`.

The `db.migrated` activity row repeats `from`, `to`, `backupFile`, `backupSha256`, `backfilled` and `unassigned`. The backup sha256 differs from the sha256 of a manual copy of `harness.db`, because `VACUUM INTO` rewrites the file. Verify the backup against this record or the log line, not against a manual copy.

### 15.3 Log lines, in order

Every line is prefixed with an ISO timestamp. Lines carry versions, counts, durations, the backup basename and hash, and redacted error text. They never carry row contents, kv values or full paths.

**First launch of a v6 database (success):**
```
[db] schema version 6
[db] v7 precheck ok integrity=ok integrityMs=<n> free=<bytes|unknown> needed=<bytes>
[db] backup ok file=harness-v6-<UTC>.db bytes=<n> sha256=<hex> from=6 writeMs=<n> verifyMs=<n> hashMs=<n>
[db] row counts command_history=<n> kv=<n> project_gaps=<n> project_goals=<n> project_graph_edges=<n> project_graph_nodes=<n> project_plans=<n> projects=<n>
[db] v7 migration: start from=6
[db] v7 migration: success to=7 durationMs=<n> backfilled=<n> unassigned=<n>
[nexus] platform ready: principals ok, workspaces added=0, primaries set=<n> cleared=<n>, sessions interrupted=0, jobs interrupted=0 requeued=0
```

**Every later launch:** `[db] schema version 7`, then the `[nexus] platform ready` line. There is no second backup or migration. A shape problem logs `[db] v7 shape check failed: <problem>; platform disabled`.

**Fresh database:** `[db] schema version 0`, then `[db] fresh database: no backup needed`, then `start from=0` and `success to=7 …`.

**The migration transaction failed:**
```
[db] v7 migration: failed from=6 error=<redacted>; database left at v6; backup kept at harness-v6-<UTC>.db
[db] v7 migration will be retried at the next launch (failure <n> of 3); set NEXUS_DB_HOLD_V7=1 to stay on v6
```
On the third consecutive failure, the second line reads instead: `[db] v7 migration has failed 3 times in a row; it is held from the next launch (held: repeated_failure)`.

**Held by the switch:** `[db] v7 migration: skipped reason=held (NEXUS_DB_HOLD_V7=1); database stays at v6`.

**Held after repeated failures:**
```
[db] v7 migration: skipped reason=held: repeated_failure count=3; database stays at v6; no new backup taken
[db] to retry v7, quit and delete harness.db.v7-failures.json next to harness.db; existing backups are kept (restore one with the restore tool, tools/nexus-db-restore.cjs, if needed)
```

**Other skips (the database is untouched):**
- `[db] v7 migration: skipped reason=precheck_failed detail=…; database left at v6`, or `reason=insufficient_disk detail=free=<n> needed=<n>`.
- `[db] backup failed stage=<write|verify|exists|unexpected> error=…`, followed by `skipped reason=backup_failed detail=stage=<stage>`.

**Post-commit check failed:** `[db] v7 post-check FAILED; platform disabled; restore from backup harness-v6-<UTC>.db`.

**Newer schema:** `[db] schema v<n> is newer than this build (v7); opened for legacy use only, platform disabled, nothing migrated`.

### 15.4 The hold switch

`NEXUS_DB_HOLD_V7=1` in the app's environment keeps the database at v6. The legacy steps still run up to v6 (without a backup, as before B0b). Phase A runs normally and the platform is unavailable. Unset it to migrate on the next launch, which takes a new backup first. While the switch is set, the failure marker is not read or written.

### 15.5 The failure marker and auto-hold

- Each failed v7 transaction increments the count in `harness.db.v7-failures.json`. A successful commit deletes the file.
- Skips (pre-check, disk, backup) do not count.
- At 3 consecutive failures, v7 holds itself: no new backup is taken on each launch, and the two "held after repeated failures" lines are logged.
- To retry, quit the app and delete the marker file. Existing backups are kept.

### 15.6 Restore procedure

Use a restore after a post-check failure, or when the user asks to roll back to v6. After a failed transaction you do not need one: the database is still v6.

The tool is `tools/nexus-db-restore.cjs`. It is plain node (fs and crypto only), so it runs without the app.

```
node tools/nexus-db-restore.cjs --db <userData>/harness.db --backup <userData>/backups/harness-v6-<UTC>.db --sha256 <hex> [--apply | --dry-run]
```

| Exit | Meaning |
|---|---|
| 0 | Restored, or (dry run) the plan was printed |
| 2 | sha256 mismatch: nothing was changed |
| 3 | The target is locked or in use (EBUSY/EPERM on rename): quit the app |
| 4 | Bad arguments. This includes a missing backup, a backup that is not a file, and a backup that is the target database or one of its `-wal`/`-shm`/`-journal` files. |
| 1 | Any other I/O error (for example a failed copy). Files already moved are put back. |
| 5 | The restore failed **and** the rollback could not put every file back. The message lists the exact manual renames (see the double-failure procedure below). |

`--dry-run` is the default. Steps:

1. **Quit the app first.** Check that no app window or process is running. On Windows, an open SQLite file cannot be renamed, and the tool stops with exit 3 before anything moves. An antivirus or indexer holding the file can cause the same exit 3; wait and retry. On other platforms an open file can be renamed, so quitting first is the only protection.
2. **Copy aside.** Copy `harness.db` and any `-wal`/`-shm` to a folder outside userData, and record their sha256. The tool never deletes anything, but this copy is your independent fallback.
3. **Dry run.** Take the sha256 from the `backup ok` log line, or from `nexus_migrations.backup_sha256` if the database is still readable. Run the tool without `--apply`. It verifies the backup's sha256 and prints every step: verify, the moves, the copy, the re-hash and the rename. Nothing changes.
4. **Apply.** Run the same command with `--apply`. In order, it:
   - verifies the backup's sha256 before touching anything;
   - **moves** (never deletes) `harness.db`, then `-wal`, `-shm` and `-journal` if present, to `harness.db.pre-restore-<UTC>`, `harness.db.pre-restore-<UTC>-wal` and so on, with a `-2`, `-3`, … suffix if that name is taken. Moving the stale `-wal` is essential, or SQLite would replay v7 pages onto the restored file;
   - copies the backup to `harness.db.restoring-<UTC>`, re-hashes the copy, and only then renames it to `harness.db`.

   The backup file itself stays in `backups/`. If a move, the copy, the re-hash or the final rename fails, the tool rolls back: the files already moved are put back, the main file first, and it exits with that failure's code (1, 2 or 3). A `harness.db.restoring-<UTC>` copy may be left behind for inspection; it is never used automatically and is safe to delete by hand.

   **Double failure (exit 5).** If the restore fails and the main file cannot be put back either, the rollback stops at once. The `-wal`, `-shm` and `-journal` files stay in their `pre-restore` names on purpose, because a stale WAL must never sit beside a missing or different `harness.db`. The message says `ROLLBACK INCOMPLETE` and lists, in order, every file still aside as a ready-to-run command: `move "<pre-restore name>" "<original name>"` on Windows (it works in both cmd and PowerShell) or `mv "<pre-restore name>" "<original name>"` elsewhere. With the app still closed, either:
   - **put the original back:** do those renames in the order given, main file first; or
   - **finish the restore:** if the message says "a verified copy of the backup is at <temp>; move it to harness.db", run the `move` (or `mv`) command it prints and leave the side files aside.

   If the message says **"A NEW harness.db appeared … most likely because the app is running"**, the app was started during the restore and created a fresh database. The tool never overwrites it. Quit the app, move that new file aside first with the command the message prints (to `harness.db.unexpected-<UTC>`), and then run the listed steps.

   If the message says the copy "did NOT verify", do not use it. When the main file went back but a side file did not, the message says `harness.db is back in place`; do the listed side-file renames before launching.
5. **Relaunch.** To stay on v6, relaunch with `NEXUS_DB_HOLD_V7=1` in the environment, or run the pre-B0b build. Launched without the hold, the app migrates again: a new backup first, then v7. If the failure marker reached 3, delete `harness.db.v7-failures.json` before retrying.

To check a restore without launching the app: open the restored `harness.db` with an Electron-as-node script (`ELECTRON_RUN_AS_NODE=1` and Electron's own node binary, because better-sqlite3 is built for Electron). Check that `user_version` is 6, `integrity_check` is `ok`, and the legacy row counts match `row_counts_json`.

---

## 16. Known limitations and operational notes

1. **Activity tail deletion.** The hash chain detects an edited, inserted or reordered row. It cannot detect deletion of the newest rows: the remaining prefix still verifies. `tr_activity_no_delete` stops deletion through ordinary SQL, but not someone who drops the trigger or edits the file. A later phase anchors the head hash and the row count outside the chain, for example in a record written in the same transaction, or outside the database.
2. **Older builds have no delete guard.** A pre-B0b build (for example `e1fd80f`) opens a v7 database for legacy use, because its migration loop stops at 6. Its `deleteProject` has no `hasPlatformRecords` check. Once a project has artifacts, jobs or sessions, that build's delete fails with an FK error (`ON DELETE RESTRICT`, `SQLITE_CONSTRAINT_FOREIGNKEY`). Its `LegacyWriteQueue` does not treat that error as transient: the delete is retried up to `MAX_WRITE_ATTEMPTS` = 5 times, every later legacy write waits behind it in FIFO order meanwhile, and then the delete is dropped with an error log (`write "deleteProject:<id>" failed 5 times and was dropped`). The project stays. Participations alone do not block it, because they cascade. In the B0b build, a `deleteProject` that was queued (because its first attempt threw) re-checks `hasPlatformRecords` when it finally runs. A delete queued before any platform record existed is therefore refused cleanly, not retried forever. Its log line is `[nexus] queued deleteProject refused project=<id>: it has platform records`. A legacy save by an older build does not sync the primary; the B0b startup reconcile repairs it.
3. **A completed participation as the mapped primary.** If the legacy domain maps to a workspace whose participation is `complete`, the sync never touches that row. Not its status, not its completion evidence. The DDL `CHECK (is_primary = 0 OR status = 'active')` forbids a non-active primary, so the project is left with **no** primary, and the sync returns `complete_target`. Only when that sync actually cleared a previous primary does it log `[nexus] primary sync: project=<id> maps to workspace=<ws> whose participation is complete; left without a primary` (the id bounded and secret-redacted, and the save path scrubs the line like the other `[nexus]` lines) and write an activity row; later saves and startups of such a project are silent. The renderer still shows the mapped workspace, because it derives it from the domain. This parity gap is to be revisited in B1, when authority flips to `project_workspaces`.
4. **Cancellation does not cascade everywhere.**
   - A terminal session transition (`completed`, `failed`, `timed_out` or `interrupted` through `transition` or recovery) does not cascade to the session's jobs. They can still finish, but they can never be requeued or retried, because the no-resurrection rule refuses `→ retry_scheduled` and `→ queued` once the session has ended.
   - `JobService.requestCancel` on a parent job does not cascade to its children (`parent_job_id`). Child cancellation is the J.5 executor follow-up.
   - `SessionService.cancel` does cover the whole job tree, children first. Every child must share its parent's session and participation, so the session's jobs are the complete tree.
5. **Deferred denial audit rows.** A denial raised while a caller's transaction is open is not written into it, because a rollback would lose it. It is queued with `queueMicrotask`. If a transaction is still open then, it is retried up to 5 attempts, 10, 20, 30 and 40 ms apart (about 100 ms in all). After that, a warning is logged and the row is dropped. The row is lost if the process exits in that window. The services authorize before opening a transaction, so this path is the exception.
6. **Job params are stored exactly.** There is no lossy redaction. Instead, params that contain anything secret-shaped are refused: `invalid` with `detail.reason = 'secret_in_params'`. The check is `containsSecret`. It covers a secret-named key (except numeric token counts and hex digests under hash keys), and a key or string value that the redactor would change. It also covers any string holding a private-key header. False positives are refused too: keys such as `tokenizer` or `passwordPolicy` match the secret-key pattern, and hex runs of 48 or more characters are treated as tokens. Rename such keys. Secrets travel only by reference (capability tokens and a secret store, in later phases). Large text goes in as input versions, not params. Params are exact JSON, at most 64 KiB.
7. **Error messages** (`redactedErrorJson`, jobs and sessions): a `{code, message}` with `code` a short label. The message is handled in three steps, so a secret can never straddle a cut:
   1. it is bounded to its first 65,536 characters (64 Ki);
   2. the whole bounded message is redacted with `redactSecretText`. This also redacts an unterminated private-key block through to the end of the message;
   3. the result is cut to 4,096 characters.

   Longer messages are truncated, never refused, so an error report never fails a transition.
8. **Lineage walks.** A walk drops every version the caller cannot read (`lineage.read` with the version's stored owner workspace) and does not expand through it. Nothing beyond it is revealed, and there are no redacted markers, because markers would still reveal existence and shape. A version reachable by another, readable path still appears. Walks are capped at 5000 nodes (`MAX_LINEAGE_NODES`) and return `{ nodes, truncated }`. When truncated, the nodes returned are the shallowest ones.
9. **Workspace grants.**
   - A workspace membership applies to a project only while the project has an ACTIVE participation in that workspace. Withdrawn and complete history stays readable through project or platform grants. This fails closed, and is to be revisited with multi-user in B1.
   - A `workspaceId` used as authority always comes from a stored row: the participation of a job or session, the artifact's `owner_workspace_id`, or the participation being withdrawn. It never comes from caller input.
10. **The downgrade test.** `test/nexus-db-phase-a.test.cjs` ("the HEAD e1fd80f build opens a v7 database …") proves an older build still works on a v7 database. It reads `e1fd80f:src/main/db.ts` and `e1fd80f:src/main/legacyWriteQueue.ts` with `git show`, and writes both to `<temp>/old/src/main/`. It then loads the old `db.ts` with `loadTs.loadAbsolute(<temp>/old/src/main/db.ts)`. `test/load-ts.cjs` transpiles TypeScript to CommonJS on the fly and resolves imports as follows:
    - **Type-only imports** (`../shared/project` and the other `../shared/*` types) are erased by the transpile, so no file is needed for them.
    - **Relative runtime imports** (`./legacyWriteQueue`) resolve against the temp folder, trying `<base>`, `<base>.ts` and `<base>/index.ts`. That is why the old queue is written beside the old `db.ts`: the old build runs against its own queue, not the current one.
    - **Bare specifiers** (`better-sqlite3`, `electron`, `node:path`) fall through to `load-ts.cjs`'s own `require`. They resolve from the repository's `test/` folder, so the old build uses the repository's Electron-built better-sqlite3. Under `ELECTRON_RUN_AS_NODE`, `electron` resolves to the npm package and `app` is unused, because the test passes the database path to the constructor.

    The test then:
    - opens the v7 database with the old store;
    - lists, saves and deletes a project (its participations cascade);
    - checks that `user_version` is still 7 and `foreign_key_check` is empty;
    - checks that the B0b build reopens the file with outcome `not_needed`.

    It runs only under `npm run test:db`. A skip fails that runner.
11. **Artifact metadata never holds secrets; inline content is product data.** Artifact names, descriptions and metadata, and version metadata and IO contracts, are refused when secret-shaped (`secret_in_metadata`), like job params. Inline storage CONTENT (the `StorageRef` json) is product data and is NOT secret-checked; secrets must travel by reference, never inside an artifact.
12. **A withdrawn participation can become primary again.** A legacy domain change that maps to a withdrawn participation re-activates it as primary (D4 rule); its jobs and sessions are not resurrected.

Further operational notes:
- **Backups accumulate.** Every migration attempt that reaches the backup step writes a new file. Nothing prunes `userData/backups`.
- **No minimum-version guard.** Nothing stops a pre-B0b build from opening a v7 database (D1). That is by design, and the downgrade test covers it.
- **Workspace rows are never retired or deleted in B0b.** `retired_at` exists for later phases.
- **Busy database.** A lock held past `busy_timeout` (5 s) surfaces from every service, workspaces included, as `platform_unavailable` (`immediateTx`). The transaction has rolled back.

---

## 17. Differences from the plan and the architecture

### Material differences: resolved by user decision (Revision 1, 2026-10-06)

| Id | Difference | Status |
|---|---|---|
| M1 | Job states: the brief's nine plus `leased` and `retry_scheduled` (11), with 23 transitions. `succeeded` maps to `completed`. `canRetry` is added, and `→ leased` counts attempts. | **Resolved by user decision.** Implemented ([section 10](#10-jobs-and-the-job-state-table)). |
| M2 | Lineage relations: the brief's eight plus architecture L.1 (32), with a documentation-only `planned_phase`. `deployed_as` is B6; `implements` is unassigned. | **Resolved by user decision.** Implemented ([section 9](#9-lineage-and-the-32-relation-vocabulary)). |
| M3 | v7 is the core subset plus `agent_sessions`, `agent_session_states` and `agent_session_transitions` (17 tables). Each deferred table is its own later, approved, backed-up migration. | **Resolved by user decision.** Implemented ([section 11](#11-agent-sessions)). |
| M4 | Workspace ids are the Phase A registry ids. `data-analyst` and `data-scientist` arrive later as new `workspaces` rows, in that phase's own approved migration. | **Resolved by user decision.** Implemented ([section 5](#5-seeds-and-the-backfill)). |

### Deviations judged not material

| Id | Deviation | Status |
|---|---|---|
| D1 | No engine, no pre-migration mode, no approval flag, no `minAppVersion` downgrade guard. The migration runs in `PersistStore.open()`, and `NEXUS_DB_HOLD_V7=1` replaces the approval flag. Downgrade safety rests on the `e1fd80f` build working on v7, not on a kv guard. | In effect. The failure marker and auto-hold (added in Task 4) extend it. |
| D2 | A legacy delete of a project that has Nexus records is refused (returns false, logs, deletes nothing, does not queue), instead of archiving it. | In effect. Archive moves to B1. The queued-delete re-check was added in Task 7. |
| D3 | Repository artifacts are not created at migration. | In effect. Moves to B1; `create` refuses `repository`. |
| D4 | The primary participation is a projection of `projects.domain_id` (savepoint sync plus startup reconcile). There is no `setPrimary`, and secondary domains create no participations. | In effect. Authority flips in B1. See the `complete_target` gap ([section 16, item 3](#16-known-limitations-and-operational-notes)). |
| D5 | Model agent sessions as `agent.run` jobs with no table. | **Overruled by the user (Revision 1).** v7 has `agent_sessions`. |
| D6 | The lineage cycle check has no depth cap of 64: `UNION` terminates on its own and cannot miss a deep cycle. | In effect. |
| D7 | Extra triggers beyond P.2: identity immutability, the F.7 table, current-pointer validity, no-delete triggers, the session table, and same-project edges, inputs, job sessions and session context. | In effect ([section 4](#4-triggers)). |

### Where the code differs from the plan text

Each item records what the code does now. The code wins.

1. **Log lines.** The plan's `backup ok` line has no timings. The code appends `writeMs=`, `verifyMs=` and `hashMs=`, and logs a `[db] v7 precheck ok …` line before it (Task 4 review).
2. **Repeated failures.** The plan retried a failed v7 with a new backup on every launch. The code adds the failure marker and holds automatically after 3 consecutive failures (Task 4 fix round).
3. **Backup finalisation.** The plan said "close, rename `.partial` → final". The code hard-links (`linkSync`, which cannot replace an existing file), removes the `.partial`, falls back to rename, and re-runs `quick_check` on the final file opened read-only before hashing (Task 3).
4. **Backfill naming.** `nexus_migrations.backfill_json` uses the key `inserted`, while the log line and the activity row say `backfilled`. They are the same number.
5. **Complete target.** An earlier ruling had a `complete` target become primary with its status kept. The DDL CHECK forbids that, so the code leaves no primary and returns `complete_target` (Task 7).
6. **Error bound unit.** "64 KiB" for error messages is 65,536 **characters** (UTF-16 code units), not bytes (`MAX_ERROR_INPUT_CHARS`). The params limit of 64 KiB is in UTF-8 bytes.
7. **Agent principal ids.** The frozen DDL comment on `principals.id` says `agent:<jobId>`. The deferred list (Revision 1) says agent principals will be `agent:<sessionId>`. The comment is shipped migration text and is not edited; the later phase decides.
8. **`ix_pw_workspace`.** The plan cites the RESTRICT check "when a workspace row is retired". Retiring only sets `retired_at`, and no code deletes a `workspaces` row, so the RESTRICT check never runs in B0b.
9. **Old-build test.** The plan said it runs `git show e1fd80f:src/main/db.ts`. The code also materialises the old `legacyWriteQueue.ts`, because the old `db.ts` imports it at run time ([section 16, item 10](#16-known-limitations-and-operational-notes)).
10. **Lineage walks.** The plan's walks returned a node list. The code returns `{ nodes, truncated }`, drops unreadable nodes, and caps them at 5000 (Task 9 rulings).
11. **Job params.** The plan stored params redacted. The code stores them exactly and refuses secret-shaped params (Task 10 ruling).

---

## 18. Deferred to later phases

| Item | Phase |
|---|---|
| Engine `utilityProcess`, MessagePort RPC, the `window.nexus` bridge, the engine supervisor and the health page (architecture X B0b items moved by ruling P1) | Next engine phase |
| The blob store, `blobs`, `version_blobs` and GC; `blob`, `tree` and `external` storage in `registerVersion` | Blob phase |
| `job_attempts`, `job_logs`, leases and heartbeats, the scheduler (`ix_jobs_sched`), executors, the J.5 executor hand-off on cancel, full R.2 recovery, and the scheduler and lease rows that drive the already-seeded `leased` and `retry_scheduled` states | Execution phase |
| `approvals`, `capability_tokens`, CapabilityToken mint and verify, agent principals (`agent_requires_token` today), the Nexus MCP server, and the session layer of user ∩ workspace ∩ session | Execution and MCP phase |
| The DomainSpec v2 registry with six first-class domains; the `data` → `data-analyst`/`data-scientist` alias or split of `workspaces` and `project_workspaces` rows (M4); the kind registry (endpoint-kind lineage rules, `singleActive` exceptions, metadata schemas) | Registry phase |
| `validations`, `reviews`, the validator registry, `reviewRequired` promotion gating, and the user revalidate of `draft(cancelled_partial) → candidate` | Validation phase |
| Repository artifacts (`ux_repository_per_project`, `repo.snapshot`, the integration ref); archive instead of delete for projects with Nexus records (D2); the primary-participation authority flip and `setPrimary` (D4); spine and runs UI reading these tables; the first platform IPC | B1 |
| `handoffs`, `handoff_subjects`, `handoff_comments`; the `handoff_convert` edge source | B2 |
| `builds`, `environments`, `deployments` (application stays an artifact kind); `deployed_as` semantics (M2) | B1 (local preview) / B6 |
| Domain projections: `datasets`, `experiments`, `change_set_accepts`, `metrics`, `dashboards`, `test_cases`, `test_runs`, `test_results`, `defects` | B2 to B5 |
| Behaviour for the 32 seeded lineage relations (endpoint-kind rules, writers); the meaning of `implements`; `deployed_as` edges once deployment records exist | Per `planned_phase` (B1 to B6) |
| `data-analyst` and `data-scientist` as new `workspaces` rows, and any move of existing `data` participations (M4) | Registry phase, in its own approved migration |
| How job outcomes drive agent-session status; agent principals `agent:<sessionId>` acting under tokens | Runtime and execution phase |
| `minAppVersion` downgrade guard, scheduled daily backups, weekly `integrity_check`, activity export and archive tooling, and the external anchor for the activity chain head ([section 16, item 1](#16-known-limitations-and-operational-notes)) | Later hardening |
| Hermes runtime (behind a flag) and ClaudeCliRuntime | Their approved phase |

---

## 19. Tests

| Command | What it runs |
|---|---|
| `npm run test:db` | Every `test/nexus-db-*` and `test/nexus-platform-*` file, under Electron-as-node with real SQLite (`tools/run-electron-tests.cjs`). A file fails on a non-zero exit, 0 tests, any skip or todo, or the plain-node skip banner. |
| `npm run test:focused` | Pure tests under plain node. These include `nexus-core-*`: the identity scan, workspace catalogue, redaction, policy, state tables and this restore tool. |
| `node --test test/nexus-core-restore-tool.test.cjs` | The restore tool, in temp folders only. It covers moves without deletes, a hash mismatch, the dry run, CLI exit codes 0, 2 and 4, a backup equal to the target, a missing backup, name collisions, `-journal`, (on Windows) a real share-mode lock giving exit 3 with nothing moved, and install-phase failures (copy, re-hash, final rename) with a working rollback and with a failed rollback (exit 5 and the manual steps). |

The real-SQLite files print one skip banner each under plain `node --test test/`. They are meant to run through `npm run test:db`.
