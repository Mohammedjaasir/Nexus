# Nexus platform core (schema v7 and v8)

This is the reference for the Nexus platform core. It has two parts.

**Part I (sections 1 to 19)** covers the B0b platform core: schema v7, the authorization chain, the activity log, the job, version and agent-session state tables, and the lineage vocabulary. It also has the v7 migration procedure and the operator runbook for backup, hold and restore.

**[Part II](#part-ii-schema-v8-and-b1) (sections 20 to 29)** covers B1:
- schema v8 (handoffs) and its migration runbook;
- handoffs, user saves and "mark ready";
- the `nexus:*` IPC surface;
- the workspace authority flip and the screens built on it.

Part I is kept as the B0b reference. Where B1 changed a statement in it, the section says so and links to Part II.

**Why one document.** The B1 material is a part of this file, not a separate `platform-b1.md`, for three reasons:
- the B1 brief names this file;
- v8 is built on v7's tables, rules and runbook, so the restore, hold and downgrade steps read best side by side;
- `test/nexus-core-identity-scan.test.cjs` scans this file, so the B1 text is covered by the same guard without widening that test.

The code is the source of truth. Table, index and trigger names below are copied from `V7_DDL` and `V7_EXPECTED` in `src/main/nexus/db/schemaV7.ts`, and `test/nexus-db-migration.test.cjs` pins those names against a real database. Where the code differs from the B0b plan, the code is described and the difference is listed in [section 17](#17-differences-from-the-plan-and-the-architecture).

Paths are written relative to `userData`, Electron's `app.getPath('userData')` folder for this app. The database file is `userData/harness.db`.

**What B0b is, and is not.**
- It is schema v7, plus platform services in the Electron main process. The services cover principals and authorization, workspaces and participation, artifacts and immutable versions, a version-level lineage DAG, durable jobs and agent sessions, and an append-only, redacted, hash-chained activity log.
- Nothing executes. There is no executor, scheduler, lease, runtime, blob store, MCP server or utilityProcess engine.
- There is no IPC. `src/main/index.ts` composes the platform and runs its startup pass, and no renderer path can reach it.
- No product path creates artifacts, versions, jobs or sessions yet. On a real database the platform tables hold only seeds, the participation backfill and activity rows.

B1 changes three of these statements:
- There is IPC now: the 21 `nexus:*` channels ([section 24](#24-the-ipc-surface)).
- User actions create artifacts, versions, lineage edges, participations and handoffs ([sections 25](#25-handoffs) to [27](#27-versions-from-the-ui-mark-ready-promote-discard-and-link-sources)).
- Screens read the platform tables ([section 28](#28-the-renderer)).

Nothing executes in B1 either, and jobs and sessions are still created by no product path.

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

[Part II: Schema v8 and B1](#part-ii-schema-v8-and-b1)

20. [Where the B1 code lives](#20-where-the-b1-code-lives)
21. [Schema v8: tables, triggers, indexes and seeds](#21-schema-v8-tables-triggers-indexes-and-seeds)
22. [The v8 migration and its runbook](#22-the-v8-migration-and-its-runbook)
23. [Authorization in B1](#23-authorization-in-b1)
24. [The IPC surface](#24-the-ipc-surface)
25. [Handoffs](#25-handoffs)
26. [User saves](#26-user-saves)
27. [Versions from the UI: mark ready, promote, discard and link sources](#27-versions-from-the-ui-mark-ready-promote-discard-and-link-sources)
28. [The renderer](#28-the-renderer)
29. [B1: differences between the code and the plan](#29-b1-differences-between-the-code-and-the-plan)

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
| `src/main/index.ts` | Opens the store and composes the platform. In B0b it registered no IPC; in B1 it calls `registerNexusIpc` once ([section 24](#24-the-ipc-surface)). |
| `tools/nexus-db-restore.cjs` | The verified restore tool ([section 15.6](#156-restore-procedure)). Since B1 it also names the hold switch that matches the backup's schema ([section 22.6](#226-restore-to-v7)). |

The B1 files (schema v8, handoffs, user saves, the IPC module and the renderer data layer) are listed in [section 20](#20-where-the-b1-code-lives).

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
- Since v8, `handoffs` and `handoff_subjects` use RESTRICT too, and `hasPlatformRecords` counts `handoffs` ([section 21](#21-schema-v8-tables-triggers-indexes-and-seeds)).

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
| `viewer` | `project.read`, `workspace.read`, `artifact.read`, `lineage.read`, `job.read`, `session.read`, `activity.read`, `handoff.read` (B1) |
| `member` | `participation.attach`, `participation.withdraw`, `artifact.create`, `version.register`, `version.update_draft`, `version.discard`, `version.promote`, `lineage.write`, `job.create`, `job.cancel`, `session.open`, `session.cancel`, `handoff.send`, `handoff.respond`, `handoff.withdraw` (B1) |
| `admin` | `artifact.archive` |
| system only | `version.finalize`, `job.transition`, `session.transition`, `system.reconcile` |

B1 added the four `handoff.*` actions and nothing else. "Mark ready" lets a user make their own draft ready without making `version.finalize` a user action: the system performs it on the user's behalf (ruling C4). [Section 23](#23-authorization-in-b1) covers this, what each B1 operation requires, and the known limit of the user-save pre-check.

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

**Actions added in B1:**
- `handoff.send`, `handoff.accept`, `handoff.decline` (details `{ withNote }`, never the note text) and `handoff.withdraw`;
- `db.migrated` with `entity_id` `'8'`, once, in the v8 transaction;
- `version.finalize` rows for "mark ready" and for the receipt of an accept. Each has actor `system`, `on_behalf_of` the user, and `details.via` set to `mark_ready` or `accept_handoff`;
- `artifact.create`, `version.register`, `version.promote` and `lineage.write` rows written by user saves, source links and accepts.

A version's `produced_by_action` column records how a user made it: `user.save_commit`, `user.save_file` or `user.accept_handoff`.

---

## 8. Artifacts and the version state table

**Ownership.**
- An artifact belongs to the ACTIVE participation of (project, workspace) at creation. The service resolves the row; the caller only names the workspace.
- Only that participation appends versions (`tr_versions_insert`).
- A withdrawn owner freezes its artifacts. Register, edit, discard and promote then return `participation_inactive`. The engine's `finalize` may still close a frozen draft as `failed`.
- `repository` (project-owned) is refused. B0b planned it for B1, but B1 kept the refusal: a saved commit is the plain participation-owned kind `git_commit` (ruling C5, [section 26](#26-user-saves)). Repository artifacts are deferred ([section 18](#18-deferred-to-later-phases)).
- B1 adds the kinds `git_commit`, `text_file` and `handoff_receipt`, and the single-transaction user flows built on this table: `saveUserVersion`, `markReady` and accept ([sections 25](#25-handoffs) to [27](#27-versions-from-the-ui-mark-ready-promote-discard-and-link-sources)).

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
| `handoff_convert` | Written only by `HandoffService.accept` (B1): one edge from the receipt version to each subject, with relation `depends_on`, created by the accepting user, inside the accept's transaction ([section 25](#25-handoffs)). `LineageService.record` refuses this source with `invalid`: "handoff_convert edges are written only by accepting a handoff". |

B1 also adds `LineageService.linkSources`. A user records `derived_from` edges (source `user_action`) from one version to 1 to 20 source versions, all in one transaction ([section 27](#27-versions-from-the-ui-mark-ready-promote-discard-and-link-sources)).

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
  - **Since B1:** it also refuses with `conflict` and `detail.openHandoffs` while the participation has a `sent` handoff in either direction ([section 25](#25-handoffs)).
  - **B1** adds `listForReader`: every participation of every project the caller may read, used by `nexus:participations:list`.
- **Authority flipped in B1.** Every screen now reads `project_workspaces` through IPC. The renderer registry keeps only labels, hues and the planned modules. When the platform is unavailable, the screens fall back to the domain grouping and hide writes ([section 28](#28-the-renderer)). Projects can be attached to, and withdrawn from, extra workspaces from the project page. **What did not flip:** the primary still follows the legacy domain, as described next. There is no `setPrimary`, and that stays deferred.
- **The primary is a projection of `projects.domain_id` in B0b and B1 (D4).** `PersistStore.saveProject` runs `syncPrimaryFromLegacyDomain` in a caught SAVEPOINT inside the save's IMMEDIATE transaction. A sync failure never fails the legacy save. If the failure aborts the whole transaction, the project row is saved once more without the sync. At startup, `reconcileLegacyPrimaries` repairs drift, including rows written by an older build.
  - **A mapped domain:** the target row becomes active and primary (inserted with `source = 'legacy_domain'` when missing), and every other row is cleared first.
  - **An unmapped domain:** every primary flag is cleared, and the rows are kept.
  - **A target whose participation is `complete`:** see [section 16, item 3](#16-known-limitations-and-operational-notes).
- **The delete guard (D2).** `PersistStore.deleteProject` refuses, returning `false` and writing nothing, while the project has rows in `artifacts`, `jobs` or `agent_sessions` (`hasPlatformRecords`). Since B1 it also counts `handoffs`, and it is active at v7 and v8 (`version >= 7`). It logs `[nexus] deleteProject refused project=<id>: it has platform records (artifacts, jobs or agent sessions)`. A failing check answers "present", so a project is kept rather than half-deleted. Participations alone do not block a delete: they cascade.
- **The graph goes with the row.** `ProjectManager.deleteProject` calls `PersistStore.deleteProject(id, { withGraph: true })`. The store deletes the knowledge graph in the same transaction as the project row, only when the row is actually removed, and only after the platform-record re-check of a queued delete. A delete refused at any point, including a queued delete refused when it finally runs, keeps the graph. A normal delete removes it, as in Phase A.

---

## 13. Wiring in main

`src/main/index.ts`, in `whenReady`:
0. The first line returns when the single-instance lock was not obtained (`gotInstanceLock`), so a losing second instance never opens the store.
1. `persist.open({ log: nexusMainLog, backupDir: join(userData, 'backups'), holdV7: process.env.NEXUS_DB_HOLD_V7 === '1', appVersion })`. The call is guarded: a DB failure degrades to defaults and never blocks startup.
2. If `persist.platformAvailable` (v7 and the post-check passed), main composes the platform: `createNexusPlatform(persist.platformDatabase(), { log })`, on the same better-sqlite3 connection as the legacy store.
3. Main then calls `startup()`. It resolves the seeded principals, ensures the workspace catalogue, reconciles the legacy primaries, recovers sessions and then jobs, and logs one `[nexus] platform ready` line.
4. Any throw leaves `nexusPlatform = null` and logs `[nexus] platform startup failed error=<name> code=<code>; platform disabled, legacy features unaffected`.

In B0b, no IPC channel and no preload change were registered; nothing read `nexusPlatform`.

**Since B1:**
- Step 1 also passes `holdV8: process.env.NEXUS_DB_HOLD_V8 === '1'`.
- Step 2 runs when the store is at v7 or v8, and passes `handoffs: persist.handoffsAvailable`. Without handoffs, the platform logs `[nexus] handoffs unavailable: schema v8 not in place` and has `handoffs = null`.
- Main keeps two module-level reasons for the IPC layer:
  - `nexusUnavailableReason`: `held`, `migration_failed`, `newer_schema`, `shape_mismatch`, `startup_failed`, `not_open`, or null once the platform is up;
  - `handoffsUnavailableReason`, from `persist.handoffsUnavailableReason`.
- A startup throw sets the first to `startup_failed` and the second to null.
- `registerNexusIpc(ipcMain, { platform, unavailableReason, handoffsUnavailableReason, sources, log })` is called once, at module top level. The platform is read at call time, so a call before startup answers `platform_unavailable`. See [section 24](#24-the-ipc-surface).

---

## 14. Migration procedure

`PersistStore.open()` and `migrate()` in `src/main/db.ts`, for a database at `user_version = from`.

**Since B1:**
- This v7 step is unchanged, except for two branches. A database at v7 **or v8** takes the `from = 7` branch, and the newer-schema branch is `from > 8`.
- After the v7 step, the sibling v8 step runs ([section 22](#22-the-v8-migration-and-its-runbook)). It runs only when v7 is in place with a clean shape.
- `lastMigration` still reports this v7 step; `lastMigrationV8` reports v8.

The steps:

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

**Newer schema:** `[db] schema v<n> is newer than this build (v7); opened for legacy use only, platform disabled, nothing migrated`. This is the B0b build's text. The B1 build says `(v8)` and uses this branch only for `n > 8`.

The v8 lines, which follow these on a B1 build, are in [section 22.3](#223-log-lines-in-order).

### 15.4 The hold switch

`NEXUS_DB_HOLD_V7=1` in the app's environment keeps the database at v6. The legacy steps still run up to v6 (without a backup, as before B0b). Phase A runs normally and the platform is unavailable. Unset it to migrate on the next launch, which takes a new backup first. While the switch is set, the failure marker is not read or written.

Since B1, `NEXUS_DB_HOLD_V7=1` implies `NEXUS_DB_HOLD_V8=1`. `NEXUS_DB_HOLD_V8=1` alone keeps a database at v7, with the platform on and handoffs off ([section 22.4](#224-the-hold-switch-the-failure-marker-and-auto-hold)).

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
5. **Relaunch.** To stay on v6, relaunch with `NEXUS_DB_HOLD_V7=1` in the environment, or run the pre-B0b build. Launched without the hold, the app migrates again: a new backup first, then v7 (and, on a B1 build, a `harness-v7-<UTC>.db` backup and then v8). If the failure marker reached 3, delete `harness.db.v7-failures.json` before retrying.

   **Since B1, the tool names the switch for you.** It reads the backup's `user_version` from the SQLite header (bytes 60 to 63, big-endian) and prints the switch that keeps the app on that schema:
   - a v6 backup gives `NEXUS_DB_HOLD_V7=1 to stay on schema v6`;
   - a v7 backup gives `NEXUS_DB_HOLD_V8=1 to stay on schema v7`.

   Restoring a v7 backup is covered in [section 22.6](#226-restore-to-v7).

To check a restore without launching the app: open the restored `harness.db` with an Electron-as-node script (`ELECTRON_RUN_AS_NODE=1` and Electron's own node binary, because better-sqlite3 is built for Electron). Check that `user_version` is 6, `integrity_check` is `ok`, and the legacy row counts match `row_counts_json`.

---

## 16. Known limitations and operational notes

1. **Activity tail deletion.** The hash chain detects an edited, inserted or reordered row. It cannot detect deletion of the newest rows: the remaining prefix still verifies. `tr_activity_no_delete` stops deletion through ordinary SQL, but not someone who drops the trigger or edits the file. A later phase anchors the head hash and the row count outside the chain, for example in a record written in the same transaction, or outside the database. This is unchanged in B1. B1 writes many more activity rows (user saves, handoffs, source links), and the Passport shows them, but the tail-deletion limit and the deferred anchor are the same.
2. **Older builds have no delete guard.** A pre-B0b build (for example `e1fd80f`) opens a v7 database for legacy use, because its migration loop stops at 6. Its `deleteProject` has no `hasPlatformRecords` check. Once a project has artifacts, jobs or sessions, that build's delete fails with an FK error (`ON DELETE RESTRICT`, `SQLITE_CONSTRAINT_FOREIGNKEY`). Its `LegacyWriteQueue` does not treat that error as transient: the delete is retried up to `MAX_WRITE_ATTEMPTS` = 5 times, every later legacy write waits behind it in FIFO order meanwhile, and then the delete is dropped with an error log (`write "deleteProject:<id>" failed 5 times and was dropped`). The project stays. Participations alone do not block it, because they cascade. In the B0b build, a `deleteProject` that was queued (because its first attempt threw) re-checks `hasPlatformRecords` when it finally runs. A delete queued before any platform record existed is therefore refused cleanly, not retried forever. Its log line is `[nexus] queued deleteProject refused project=<id>: it has platform records`. A legacy save by an older build does not sync the primary; the B0b startup reconcile repairs it. The B0b build (`e2fceec`) has the same weakness on a v8 database: see item 13.
3. **A completed participation as the mapped primary.** If the legacy domain maps to a workspace whose participation is `complete`, the sync never touches that row. Not its status, not its completion evidence. The DDL `CHECK (is_primary = 0 OR status = 'active')` forbids a non-active primary, so the project is left with **no** primary, and the sync returns `complete_target`. Only when that sync actually cleared a previous primary does it log `[nexus] primary sync: project=<id> maps to workspace=<ws> whose participation is complete; left without a primary` (the id bounded and secret-redacted, and the save path scrubs the line like the other `[nexus]` lines) and write an activity row; later saves and startups of such a project are silent. In B0b, the renderer still showed the mapped workspace, because it derived it from the domain.

   **Resolved in B1.** The renderer reads `project_workspaces`, so such a project now shows as **Unassigned**: no active primary, and not listed in that workspace. It is not offered for attach to that workspace either. The database and the screens agree (test R5 in `test/nexus-participation.test.cjs`). Only the legacy fallback, used while the platform is unavailable, still shows the mapped workspace. Nothing in B1 produces a `complete` participation.
4. **Cancellation does not cascade everywhere.**
   - A terminal session transition (`completed`, `failed`, `timed_out` or `interrupted` through `transition` or recovery) does not cascade to the session's jobs. They can still finish, but they can never be requeued or retried, because the no-resurrection rule refuses `→ retry_scheduled` and `→ queued` once the session has ended.
   - `JobService.requestCancel` on a parent job does not cascade to its children (`parent_job_id`). Child cancellation is the J.5 executor follow-up.
   - `SessionService.cancel` does cover the whole job tree, children first. Every child must share its parent's session and participation, so the session's jobs are the complete tree.
   - This is unchanged in B1. No B1 path creates jobs or sessions, so it has no effect on the B1 screens.
5. **Deferred denial audit rows.** A denial raised while a caller's transaction is open is not written into it, because a rollback would lose it. It is queued with `queueMicrotask`. If a transaction is still open then, it is retried up to 5 attempts, 10, 20, 30 and 40 ms apart (about 100 ms in all). After that, a warning is logged and the row is dropped. The row is lost if the process exits in that window. The services authorize before opening a transaction, so this path is the exception.
6. **Job params are stored exactly.** There is no lossy redaction. Instead, params that contain anything secret-shaped are refused: `invalid` with `detail.reason = 'secret_in_params'`. The check is `containsSecret`. It covers a secret-named key (except numeric token counts and hex digests under hash keys), and a key or string value that the redactor would change. It also covers any string holding a private-key header. False positives are refused too: keys such as `tokenizer` or `passwordPolicy` match the secret-key pattern, and hex runs of 48 or more characters are treated as tokens. Rename such keys. Secrets travel only by reference (capability tokens and a secret store, in later phases). Large text goes in as input versions, not params. Params are exact JSON, at most 64 KiB.
7. **Error messages** (`redactedErrorJson`, jobs and sessions): a `{code, message}` with `code` a short label. The message is handled in three steps, so a secret can never straddle a cut:
   1. it is bounded to its first 65,536 characters (64 Ki);
   2. the whole bounded message is redacted with `redactSecretText`. This also redacts an unterminated private-key block through to the end of the message;
   3. the result is cut to 4,096 characters.

   Longer messages are truncated, never refused, so an error report never fails a transition.
8. **Lineage walks.** A walk drops every version the caller cannot read (`lineage.read` with the version's stored owner workspace) and does not expand through it. Nothing beyond it is revealed, and there are no redacted markers, because markers would still reveal existence and shape. A version reachable by another, readable path still appears. Walks are capped at 5000 nodes (`MAX_LINEAGE_NODES`) and return `{ nodes, truncated }`. When truncated, the nodes returned are the shallowest ones.
9. **Workspace grants.**
   - A workspace membership applies to a project only while the project has an ACTIVE participation in that workspace. Withdrawn and complete history stays readable through project or platform grants. This fails closed. B0b planned to revisit it with multi-user in B1; B1 is single-user, so it stays deferred (ruling C13). B1 also adds a related limit for user saves (item 21).
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

**Added in B1:**

13. **The `e2fceec` (B0b) build on a v8 database.**
    - It opens the database for legacy use only (`schema v8 is newer than this build (v7)`), with the platform disabled.
    - Its delete guard is off at v8, because its `hasPlatformRecords` requires version 7 exactly. So a delete of a project that has artifacts, jobs, sessions or handoffs fails with the FK error. It is retried and then dropped, as item 2 describes. The project stays.
    - The B1 build reopens the file normally.
    - `test/nexus-db-phase-a.test.cjs` pins this ([section 22.7](#227-downgrade-the-e2fceec-build-on-a-v8-database)).
14. **Receipts.** Accepting a handoff creates a `handoff_receipt` artifact ("Received") in the receiving workspace. It is created active, and it holds references only: `{ handoffId, subjects: [{ versionId, contentHash }] }`.
    - It is a real record of the decision, but it has no content of its own to review. Opening a subject means following its `depends_on`/`handoff_convert` edge back to the sender's version.
    - Receipts are never deleted, like every artifact. They freeze with their participation.
    - A subject that changes status after the send is still accepted as sent ([section 25](#25-handoffs) has the ruling).
15. **The 64 KiB stored-record limit.** A text-file save must pass two limits:
    - the raw file is at most 65,536 bytes;
    - the stored `{ path, text }` record is at most 65,536 bytes of canonical JSON (`INLINE_MAX_BYTES`, unchanged from v7).

    JSON escaping (quotes, backslashes, control characters) and the wrapper add bytes. A file just under 64 KiB, or one full of quotes, can therefore be refused as `too_large`. Both refusals carry `detail.limit = 65536`. Larger files wait for the blob store.
16. **The sensitive-name list.**
    - User saves refuse, by basename and again by the real file's name: `.env` and `.env.*`; key and keystore files (`*.pem`, `*.key`, `*.jks`, `*.keystore`, `*.p12`, `*.pfx`, `*.ppk`, `id_rsa*`, `id_dsa*`, `id_ecdsa*`, `id_ed25519*`); `.npmrc`, `.pypirc`, `.netrc`, `.git-credentials`, `.htpasswd`, `credentials*` and `*.kdbx`; and anything under a `.git` segment.
    - Matching is case-insensitive and ignores trailing dots and spaces.
    - The list is a name rule, not a content scan. A secret in a file with an ordinary name is caught only by the content checks.
    - The generic `registerVersion` still does not check inline content (item 11).
17. **The long-token rule (ReDoS bound).** Several redactor patterns cost (word boundaries in a run) × (run length). A crafted 64 KiB string could block the main process for seconds.
    - **The rule:** `containsSecret` treats any whitespace-free run of token characters (`A-Z a-z 0-9 + . _ -`) that holds **128 or more `+`, `.` or `-`** (`LONG_TOKEN_SEPARATORS`), plus at least one letter or digit, as secret-shaped. `redactSecretText` replaces such a run with `[redacted]`. One linear scan finds these runs.
    - **Where it applies:** job params (`secret_in_params`), artifact and version metadata (`secret_in_metadata`), handoff titles and notes, user-save content (`secret_in_content`), and error messages (redacted, not refused). `redactText` and `redactDetails` are unchanged, because activity hashes depend on their output.
    - **False positives:** a long base64 or base64url blob with many `+` or `-`; table-of-contents dot leaders (`Chapter 1 .......... 12`); minified SVG path data (`M10.5-3.2-4.1...`); and long kebab-case or dotted chains. Workaround: split the run with whitespace, or shorten it. Refusing is the safe direction.
    - **Residual cost:** about 40 ms on a crafted 64 KiB input with compiled regexes. With V8's regex interpreter forced (`--regexp-interpret-all`), the measured worst case was **3.4 s** in `containsSecret` (1.7 s in `redactSecretText`). V8 was not observed to fall back to the interpreter in normal use.
    - **Deferred:** a linear rewrite of the four slow patterns, with byte-identical output.
18. **The `summariesByProject` cap.** `nexus:artifacts:byProject` returns at most 1000 artifacts per project, in creation order, and sets `truncated: true` only when more exist. The Spine then draws only those 1000 (the oldest, since the order is creation order) and says so under the nodes: "Only the first 1000 artifacts of this project are shown, oldest first." (`SPINE_TRUNCATED_TEXT`; `nextArtifacts` carries `truncated` into the state, and a passing failure keeps the last value). Other list answers also carry `truncated` when more rows exist than were returned. Lineage walks keep their own `truncated` (item 8).
19. **Lists are paged by limit, not by cursor.**
    - `nexus:artifacts:list` and `nexus:handoffs:list` have no offset or cursor. "Show more" re-reads with a limit 100 rows larger, up to 500. The page then asks the person to narrow the filters.
    - Sorting by name happens in the renderer, over the rows returned.
    - Only `nexus:activity:byProject` has a cursor (`beforeSeq`).
20. **The Passport's handoff list is capped.** The artifact Passport lists the handoffs carrying its versions from the project's first 20 handoffs (open ones first, then the newest), and says so when capped. There is no "by version" query yet. A detail is re-read only when its list row's `statusChangedAt` or `updatedAt` changed.
21. **User saves pre-check at project scope.** The pre-check runs before any file or git read, at plain project scope. A principal whose only right comes from a workspace grant cannot save, even where `saveUserVersion` would allow it ([section 23](#23-authorization-in-b1)). This fails closed and is harmless for the single local user. It must be revisited with multi-user grants.
22. **Hard-linked files cannot be saved.** `nlink > 1` is refused as `path_refused`. This affects files in pnpm stores, and files that some backup or deduplication tools hard-link. The message says so. Copy the file to save it.
23. **Smaller B1 UI limits:**
    - The artifact Passport reads content for the newest 12 versions only. Older rows show the number and status.
    - Commit subjects come from the project's own git log (the last 200 commits). An older commit shows its sha alone.
    - The link picker offers versions of at most 30 other artifacts (the most recently changed), one source per pick. Versions downstream of this one are offered; the service refuses a cycle.
    - Archived artifacts are not drawn on the Spine. They stay on the Artifacts page.
    - "Hand off…" appears only after a handoff channel has answered successfully, only on active versions, and only when the project has at least one other active participation to receive it (the send sheet's "To" choices, `toChoices`). A project with a single active participation shows no "Hand off…", because no send could succeed.
    - In this single-user app, the handoff side shown (receiving or sending) follows the page view. The services enforce the real rule.
    - Complete participations are not listed in the Workspaces section.
24. **Unchanged by B1, and still true:** the terminal session transition does not cascade (item 4), and the activity chain cannot detect tail deletion (item 1).

Further operational notes:
- **Backups accumulate.** Every migration attempt that reaches the backup step writes a new file. Since B1 that includes the `harness-v7-<UTC>.db` backups of the v8 step. Nothing prunes `userData/backups`.
- **No minimum-version guard.** Nothing stops a pre-B0b build from opening a v7 database (D1). That is by design, and the downgrade test covers it.
- **Workspace rows are never retired or deleted in B0b.** `retired_at` exists for later phases.
- **Test B1 flows on a scratch userData only.** Try saves and handoffs only on a scratch userData folder, for example by launching with `--user-data-dir=<temp>`, never on the userData you work in. B1 artifacts (receipts included), versions and handoffs are never deleted, and a project that has any of them cannot be deleted (the delete guard, `hasPlatformRecords`). A trial save or handoff on a real project stays for good and blocks deleting that project.
- **Busy database.** A lock held past `busy_timeout` (5 s) surfaces from every service, workspaces included, as `platform_unavailable` (`immediateTx`). The transaction has rolled back. Since B1, the IPC layer answers it with reason `busy` and a fixed message, and the screens offer "Try again" instead of the degraded mode.

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
| D2 | A legacy delete of a project that has Nexus records is refused (returns false, logs, deletes nothing, does not queue), instead of archiving it. | In effect. The queued-delete re-check was added in Task 7. Archive was planned for B1 but stays deferred (ruling C16): no renderer path deletes projects. |
| D3 | Repository artifacts are not created at migration. | In effect. Planned for B1, but still deferred (ruling C5): `create` refuses `repository`, and a saved commit is `git_commit`. |
| D4 | The primary participation is a projection of `projects.domain_id` (savepoint sync plus startup reconcile). There is no `setPrimary`, and secondary domains create no participations. | In effect for the primary. B1 flipped the READ authority: screens read `project_workspaces` ([section 28](#28-the-renderer)), and the `complete_target` gap is resolved ([section 16, item 3](#16-known-limitations-and-operational-notes)). `setPrimary` is still deferred. |
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

The B1 differences are listed in [section 29](#29-b1-differences-between-the-code-and-the-plan).

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
| `builds`, `environments`, `deployments` (application stays an artifact kind); `deployed_as` semantics (M2). B1 did not start the local preview: Deployments stays a Planned page. | Its approved phase / B6 |
| Domain projections: `datasets`, `experiments`, `change_set_accepts`, `metrics`, `dashboards`, `test_cases`, `test_runs`, `test_results`, `defects` | B2 to B5 |
| Behaviour for the 32 seeded lineage relations (endpoint-kind rules, writers); the meaning of `implements`; `deployed_as` edges once deployment records exist | Per `planned_phase` (B1 to B6) |
| `data-analyst` and `data-scientist` as new `workspaces` rows, and any move of existing `data` participations (M4) | Registry phase, in its own approved migration |
| How job outcomes drive agent-session status; agent principals `agent:<sessionId>` acting under tokens | Runtime and execution phase |
| `minAppVersion` downgrade guard, scheduled daily backups, weekly `integrity_check`, activity export and archive tooling, and the external anchor for the activity chain head ([section 16, item 1](#16-known-limitations-and-operational-notes)) | Later hardening |
| Hermes runtime (behind a flag) and ClaudeCliRuntime | Their approved phase |

**Delivered in B1** (moved off this list):
- the first platform IPC (`nexus:*`);
- the read-authority flip to `project_workspaces`;
- the spine, artifact, handoff and activity UI reading these tables;
- `handoffs` and `handoff_subjects`;
- the `handoff_convert` edge source;
- `ix_versions_project_status`.

**Deferred after B1** (the next phases):

| Item | Phase |
|---|---|
| `handoff_comments` (threads); handoff routes per kind; the states `changes_requested`, `converted`, `delivered` and `closed`; `return_of` and `supersedes` (fix loops); acceptance rules; "convert to work" jobs | B2 |
| Repository artifacts (`ux_repository_per_project`, `repo.snapshot`, the integration ref, `contains` edges); `change_set` with validators; Accept, Discard and Request changes on change sets | SDE vertical (the architecture's B1 tasks, moved by ruling C11) |
| Persisted runs from `jobs`; any executor, scheduler, lease or runtime; agent principals and capability tokens; agent-created handoffs | Execution and MCP phases |
| The Completion engine and its rule sets; the Completion tool content | With completion rules |
| Deployments, local previews and beyond | Its approved phase |
| Archive instead of delete for projects with platform records (D2) | Later, with a UI that deletes projects |
| Artifact archive from the UI (`artifact.archive`, admin; the service exists) | Later |
| Blob storage (files over 64 KiB, binaries); a project file picker beyond the folder browser | Blob phase |
| The kind registry: aliases for `git_commit`, `text_file` and `handoff_receipt`; endpoint-kind lineage rules; user links with relations other than `derived_from` | Registry phase |
| Multi-user workspace grants ([section 16, item 9](#16-known-limitations-and-operational-notes)), including the user-save pre-check at workspace scope (item 21); explicit `setPrimary` | Multi-user phase |
| Server-side "handoffs carrying this version" and cursor paging for the artifact and handoff lists (items 19 and 20) | When volumes need it |
| A linear rewrite of the four slow redactor patterns, with byte-identical output (item 17) | Later hardening |
| The activity export, an external anchor for the chain head, scheduled backups | Later hardening |
| `data-analyst` and `data-scientist` workspace rows (M4) | Registry phase |

B1 did not start B0c, B2 or any execution work.

---

## 19. Tests

| Command | What it runs |
|---|---|
| `npm run test:db` | Every `test/nexus-db-*` and `test/nexus-platform-*` file, under Electron-as-node with real SQLite (`tools/run-electron-tests.cjs`). A file fails on a non-zero exit, 0 tests, any skip or todo, or the plain-node skip banner. |
| `npm run test:focused` | Pure tests under plain node. These include `nexus-core-*`: the identity scan, workspace catalogue, redaction, policy, state tables and this restore tool. |
| `node --test test/nexus-core-restore-tool.test.cjs` | The restore tool, in temp folders only. It covers moves without deletes, a hash mismatch, the dry run, CLI exit codes 0, 2 and 4, a backup equal to the target, a missing backup, name collisions, `-journal`, (on Windows) a real share-mode lock giving exit 3 with nothing moved, and install-phase failures (copy, re-hash, final rename) with a working rollback and with a failed rollback (exit 5 and the manual steps). |

The real-SQLite files print one skip banner each under plain `node --test test/`. They are meant to run through `npm run test:db`.

**B1 test files.**

| File | Runner | Covers |
|---|---|---|
| `test/nexus-db-v8-schema.test.cjs` | `test:db` | The v8 module: object names and counts, triggers T1 to T12, the shape check, verification and rollback |
| `test/nexus-db-v8-migration.test.cjs` | `test:db` | The v8 step, cases M1 to M16: log lines, backups, hold, marker and auto-hold, the post-check, a kill mid-transaction (M13), backup failure (M15), and v6 to v8 in one launch with a v8 failure (M16). Also `handoffsUnavailableReason`. |
| `test/nexus-db-phase-a.test.cjs` | `test:db` | Adds the `e2fceec` downgrade on a v8 database |
| `test/nexus-platform-b1-services.test.cjs` | `test:db` | User-save transactions, mark ready, source links, cross-project reads and the withdraw guard (S1 to S16) |
| `test/nexus-platform-handoffs.test.cjs` | `test:db` | Send, accept, decline and withdraw: atomicity at 7 failure points, races, side-specific denials, and subjects accepted as sent (H1 to H19) |
| `test/nexus-platform-user-saves.test.cjs` | `test:db` | Real temp git repos and files (U1 to U20): links, junctions, hard links, Windows aliases, sensitive names and content, BOM, control bytes, tags, sparse files, and the timing of the long-token rule |
| `test/nexus-platform-ipc.test.cjs` | `test:db` | The IPC wrapper with a fake registrar: hostile arguments, availability envelopes, busy, truncation and accessors |
| `test/nexus-platform-b1-flows.test.cjs` | `test:db` | End-to-end flows F1 to F8 and an error sweep through the handlers. After each one: the orphan queries O1 to O9 = 0 (`test/helpers/orphans.cjs`), an empty `foreign_key_check`, `integrity_check` ok, and the activity chain verified |
| `test/nexus-core-append-only-writes.test.cjs` | `test:focused` | No `OR REPLACE` or `DO UPDATE` on protected tables in `src/main/nexus` and `src/main/nexusIpc` |
| `test/nexus-core-restore-tool.test.cjs` | `test:focused` | Adds the header read (bytes 60 to 63, big-endian) and the matching hold switch for v6 and v7 backups, through the CLI |
| `test/nexus-participation.test.cjs`, `nexus-platform-state`, `nexus-error-copy`, `nexus-workspaces-section`, `nexus-artifact-model`, `nexus-activity-model`, `nexus-artifacts-page`, `nexus-handoff-model` | `test:focused` | The pure renderer models (through `load-ts`), plus source pins on the `.tsx` files |

---

# Part II: Schema v8 and B1

B1 connects the Nexus screens to the platform and adds handoffs. It has six parts:
- **Schema v8**, additive, run with the v7 safety procedure.
- **Service additions:** handoffs, user saves, "mark ready", source links and cross-project reads.
- **One `nexus:*` IPC family.**
- **The workspace authority flip:** screens read `project_workspaces`.
- **Real screens:** artifact nodes on the Spine, the artifact Passport, and the Artifacts and Handoffs pages.
- **Unchanged:** Completion and Deployments stay Planned, and Runs stay session-only.

Part I (sections 1 to 19) still describes v7 and the B0b services. Where B1 changed a Part I statement, that section says so and points here. As in Part I, the code is the source of truth. [Section 29](#29-b1-differences-between-the-code-and-the-plan) lists every place where the code differs from the B1 plan.

**What B1 is, and is not.**
- B1 writes real records from user actions only. A user saves a commit or a small text file, marks it ready, promotes it, links its sources, and hands versions to another workspace of the same project. The other side accepts, declines, or the sender withdraws.
- Nothing executes. There are no jobs from the UI, no agents and no runtime. The `jobs` and `agent_sessions` tables are still written by nothing but tests.
- No content is copied between workspaces. A handoff carries version ids and content hashes, and an accept records references.

## 20. Where the B1 code lives

| Path | Role |
|---|---|
| `src/main/nexus/db/schemaV8.ts` | `V8_DDL` (frozen migration text), `V8_EXPECTED`, `v8ShapeProblem`, `verifyV8` and `applyV8`. |
| `src/main/nexus/db/v8Seed.ts` | The frozen v8 seeds: `V8_HANDOFF_STATES` and `V8_HANDOFF_TRANSITIONS`. |
| `src/main/db.ts` | `migrateV8` (a sibling of the v7 step), `holdV8`, `handoffsAvailable`, `lastMigrationV8` and `handoffsUnavailableReason`. |
| `src/main/nexus/handoff/handoffRules.ts`, `handoffService.ts` | The handoff state table and constants; `send`, `accept`, `decline`, `withdraw`, `get`, `list` and `openCountFor`. |
| `src/main/nexus/commands/userSaves.ts` | `UserSaves.saveCommit` and `saveTextFile`. These are rules only: every read goes through injected `SourcePorts`. |
| `src/main/nexus/artifact/artifactService.ts` | Adds `saveUserVersion`, `markReady`, `summariesByProject` and `listForReader`, plus the in-transaction helpers (`insertArtifactTx`, `insertVersionTx`, `setStatusTx` and `promoteTx`, all `@internal`). |
| `src/main/nexus/lineage/lineageService.ts` | `linkSources` (`derived_from`, `user_action`, 1 to 20 sources). |
| `src/main/nexus/workspace/workspaceService.ts` | `listForReader`, and the open-handoffs withdraw guard. |
| `src/main/nexus/activity/redact.ts` | The long-token rule (`LONG_TOKEN_SEPARATORS`, `hasLongToken`); see [section 16, item 17](#16-known-limitations-and-operational-notes). |
| `src/main/nexusIpc/registerNexusIpc.ts` | The only module that registers `nexus:*` channels (`NEXUS_CHANNELS`, 21). |
| `src/main/nexusIpc/validate.ts`, `envelope.ts`, `dto.ts` | Request validation, the result envelope, and the views sent to the renderer. |
| `src/main/nexusIpc/sources.ts` | The main-process `SourcePorts`: the project folder, a confined file read, and a commit resolve. |
| `src/main/git.ts` | `resolveCommit(cwd, sha)`, built on the async `runGit`. |
| `src/shared/nexus/ipc.ts` | Types only: `NexusResult`, the reasons, the views and the request shapes. |
| `src/preload/index.ts` | The 21 `nexus*` preload methods. |
| `src/renderer/src/nexus/data/*` | `nexusClient`, `errorCopy`, `platformState`, `platformStore`, `useParticipations` and the read hooks. |
| `src/renderer/src/nexus/workspaces/participation.ts` | The participation index and its legacy fallback. |

`src/main/nexusIpc` sits outside `src/main/nexus` on purpose. The core never knows about transport, Electron or the file system, and the composition test's ban on `ipcMain` and `webContents` inside `src/main/nexus` keeps its meaning.

---

## 21. Schema v8: tables, triggers, indexes and seeds

v8 is additive. Every statement is `CREATE … IF NOT EXISTS` or `INSERT OR IGNORE`. No v1 to v7 table is altered, no v1 to v7 row is rewritten, and no FK is added to a v1 to v7 table. `V7_DDL` is unchanged; `schemaV7.ts` only gained the export `ddlObjects`.

`V8_EXPECTED` holds:
- **4 tables**, with columns in DDL order: `handoff_states`, `handoff_transitions`, `handoffs` and `handoff_subjects`;
- **8 named indexes**;
- **9 triggers**.

`test/nexus-db-v8-schema.test.cjs` pins these names and counts against a real database.

### 21.1 Tables

| Table | What it holds |
|---|---|
| `handoff_states` | The status vocabulary: `state`, `terminal` and `description`. It is a lookup table, not a CHECK list, so B2 adds states as rows. |
| `handoff_transitions` | The legal `(from_state, to_state)` pairs. |
| `handoffs` | One handoff: artifact versions sent by reference from one participation to another of the SAME project. The row holds both participation ids, with their workspace ids stored beside them, plus `title`, `note`, `subject_count` (1 to 20), `status`, `created_by`, the answer fields (`responded_by`, `responded_at`, `response_note`), `receipt_version_id`, and the timestamps `created_at`, `updated_at` and `status_changed_at`. |
| `handoff_subjects` | The versions a handoff carries: `(handoff_id, version_id)`, plus `position` (1 to 20) and the `content_hash` copied from the version. The hash is evidence of what was sent, never the content. |

ON DELETE behaviour:
- `handoffs.project_id`, both participation ids and both subject FKs are RESTRICT.
- A project with handoffs cannot be deleted, and `hasPlatformRecords` counts `handoffs` (see [section 12](#12-workspaces-participation-and-phase-a)).
- A participation named by a handoff cannot be deleted either. Participations are never deleted by the services; they cascade only with their project.

Tables deliberately not added:
- `handoff_comments`: B1 stores one optional answer note in `response_note`.
- `repository` artifacts (`ux_repository_per_project`): see [section 26](#26-user-saves).
- `blobs`: inline storage covers files of 64 KiB and less.

### 21.2 The DDL

This is `V8_DDL`, verbatim from `src/main/nexus/db/schemaV8.ts`. It is shipped migration text and is never edited; later changes go in a new migration.

```sql
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
```

### 21.3 Triggers

The services enforce the same rules in TypeScript and return typed `PlatformError`s. The triggers are the backstop.

| Trigger | Enforces |
|---|---|
| `tr_handoffs_insert` | A handoff starts as `sent`, unanswered and without a receipt. Both participations must be ACTIVE, in this project, and name the stored workspace. |
| `tr_handoffs_identity` | `id`, `project_id`, both participation and workspace ids, `title`, `note`, `subject_count`, `created_by` and `created_at` never change. |
| `tr_handoffs_transition` | A few rules apply to every status change:<br>- it must be a row of `handoff_transitions`;<br>- every declared subject must be recorded first;<br>- `accepted` needs a receipt and an ACTIVE receiving participation;<br>- an accept or decline records `responded_by` and `responded_at`;<br>- a withdrawal leaves all three answer fields NULL. |
| `tr_handoffs_response_once` | The answer fields are written only in the UPDATE that moves `sent` to `accepted` or `declined`. They never change afterwards, and never without a transition. |
| `tr_handoffs_receipt` | The receipt is set once, in the update that accepts. It must be an ACTIVE `handoff_receipt` version owned by the receiving participation, in the same project. |
| `tr_handoffs_no_delete` | Handoffs are never deleted. |
| `tr_handoff_subjects_insert` | Subjects are recorded only on an unanswered `sent` handoff, up to `subject_count`. Each must be a `candidate` or `active` version owned by the sending participation, in the same project, with the matching `content_hash`. |
| `tr_handoff_subjects_no_update`, `tr_handoff_subjects_no_delete` | Subjects are immutable. |

**Known trigger limit, closed by a source rule.** With `recursive_triggers` off, `INSERT OR REPLACE`, `REPLACE INTO` and an upsert's `DO UPDATE` bypass BEFORE DELETE and BEFORE UPDATE guards. `test/nexus-core-append-only-writes.test.cjs` therefore scans `src/main/nexus` and `src/main/nexusIpc`. It fails on any such write aimed at a protected table.
- The protected set is derived from every table that has a BEFORE DELETE or BEFORE UPDATE trigger in `V7_DDL` and `V8_DDL`, plus `nexus_migrations`. Schema-qualified names count.
- `INSERT OR IGNORE` is allowed.
- The scan is text-only: SQL assembled at run time is not seen.

### 21.4 Indexes and their access reasons

| Index | On | Access path it serves |
|---|---|---|
| `ix_handoffs_project` | `handoffs(project_id, created_at DESC)` | A project's handoffs, newest first: the Passport's handoff list, and the project filter of `nexus:handoffs:list`. It also serves the FK check from `projects`. |
| `ix_handoffs_to` | `handoffs(to_participation_id, status)` | The withdraw guard and `openCountFor` (open handoffs received by a participation), the inbox of a project's workspace, and the FK check from `project_workspaces`. |
| `ix_handoffs_from` | `handoffs(from_participation_id, status)` | The same as `ix_handoffs_to`, for the sending side. |
| `ix_handoffs_status` | `handoffs(status, created_at DESC)` | The global Handoffs page: open (`sent`) first, then newest, across projects. |
| `ux_handoffs_receipt` (unique, partial `WHERE receipt_version_id IS NOT NULL`) | `handoffs(receipt_version_id)` | One handoff per receipt, and "which handoff produced this receipt". |
| PK `(handoff_id, version_id)` and `UNIQUE (handoff_id, position)` (auto) | `handoff_subjects` | A handoff's subjects in order, the duplicate-subject backstop, and the subject count in `tr_handoffs_transition`. |
| `ix_handoff_subjects_version` | `handoff_subjects(version_id)` | "Handoffs carrying this version", and the FK check from `artifact_versions`. |
| PK `(from_state, to_state)` (auto) | `handoff_transitions` | The `tr_handoffs_transition` lookup. |
| `ix_versions_project_status` | `artifact_versions(project_id, status)` | Spine and artifact summaries of a project, and "the candidate or active versions of this project" (the send and link pickers). This index was deferred from B0b. |
| `ix_artifacts_updated` | `artifacts(updated_at DESC)` | The global Artifacts page (`listForReader`), newest first, with LIMIT. |

The last two are on v7 tables. They are additive, and v7's shape check ignores extra objects.

Not built:
- a per-workspace inbox index across projects (`to_workspace_id`), because the global page filters through `ix_handoffs_status` and the volumes are single-user;
- any index on `receipt_version_id` beyond the unique partial one.

### 21.5 Seeds

`src/main/nexus/db/v8Seed.ts`, `INSERT OR IGNORE`. `verifyV8` re-reads every seed row with all its columns.

| `state` | `terminal` | `description` |
|---|---|---|
| `sent` | 0 | Sent to the receiving workspace; waiting for an answer |
| `accepted` | 0 | Accepted; a receipt version in the receiving workspace references the subjects |
| `declined` | 1 | Declined by the receiving workspace |
| `withdrawn` | 1 | Withdrawn by the sending workspace before an answer |

`handoff_transitions` has 3 rows: `sent → accepted`, `sent → declined` and `sent → withdrawn`. `HANDOFF_TRANSITIONS` in `handoffRules.ts` mirrors them, and `test/nexus-core-states.test.cjs` compares the two.

Notes on the vocabulary:
- `accepted` is non-terminal, so B2 can add `accepted → converted` as a new row. B1 seeds no transition out of it.
- There is no `draft` state. A handoff is composed in one sheet and sent in one transaction.
- The architecture's states map like this: `open` is `sent`, and `rejected` is `declined`. `changes_requested`, `converted`, `delivered` and `closed` arrive in B2 as rows.

There are no other seeds. The receipt edge uses the existing `depends_on` relation (ruling C18), so the 32-relation vocabulary is unchanged.

---

## 22. The v8 migration and its runbook

### 22.1 Procedure

`PersistStore.open()` runs the v7 step exactly as in [section 14](#14-migration-procedure), then `migrateV8` (through `migrateV8Guarded`). Legacy writes keep waiting in the `LegacyWriteQueue` until both steps are done. `open()` never throws because of v8: an unexpected throw logs `[db] v8 step: unexpected error=<redacted>; handoffs disabled`, and the platform runs as the v7 step left it.

1. **Decide:**
   - **v7 not in place:** the v7 step was held, skipped or failed, its post-check failed, or the v7 shape check reported a problem. The outcome is `skipped: v7_unavailable`. No v8 line is logged, and `handoffsAvailable` is false.
   - **`from > 8`:** the newer-schema branch handles it. It logs `[db] schema v<n> is newer than this build (v8); opened for legacy use only, platform disabled, nothing migrated`.
   - **Already at v8:** `v8ShapeProblem(db, true)` runs. A problem logs `[db] v8 shape check failed: <problem>; handoffs disabled`. The outcome is `not_needed`.
   - **Hold** (`holdV8`, or `holdV7`, which implies it): the outcome is `skipped: held`.
   - **The v8 failure marker counts 3 or more:** the outcome is `skipped: held` (`repeated_failure`), and no backup is taken.
2. **Pre-checks.** These run only when the database held data before this `open()` (`from > 0`):
   - `integrity_check = ok`;
   - free space in `backups` is at least 2 × (`harness.db` + `-wal`);
   - row counts of every table.

   A failure skips v8 (`precheck_failed` or `insufficient_disk`) and leaves v7 running.
3. **Backup** of the v7 database: `userData/backups/harness-v7-<UTC>.db`. It is written, verified and hashed exactly like the v7 backup ([section 14](#14-migration-procedure), steps 3 and 4), with `user_version = 7`. A failure gives `skipped: backup_failed`.
   - When the database was at v6, the same launch has already taken `harness-v6-<UTC>.db` for v7. v8 then takes its own `harness-v7-<UTC>.db` after the v7 COMMIT, so each step can be restored on its own.
   - A fresh database takes no v8 backup.
4. **Migrate** in ONE `BEGIN IMMEDIATE` transaction: `applyV8`, then `user_version = 8`, then COMMIT. `applyV8` runs, in order:
   1. `v7ShapeProblem(db, true)` must be null: v8 sits only on an exact v7;
   2. `v8ShapeProblem(db, false)` refuses a pre-existing object of the wrong shape;
   3. `V8_DDL`;
   4. the seeds;
   5. the `nexus_migrations` row 8 (below);
   6. one `db.migrated` activity row, only if that record is new;
   7. `verifyV8`, which checks that:
      - the v7 shape is still exact;
      - the v8 shape is exact;
      - every seed row is present;
      - `foreign_key_check` is empty;
      - every pre-existing table's row count equals its pre-count, except `activity` (+1), `nexus_migrations` (+1), `sqlite_sequence` and the v8 tables.
5. **After COMMIT:** the v8 failure marker is deleted, then `quick_check` runs. If it is not `ok`, handoffs stay off and the log names the backup. The v7 services stay on, because the v7 objects are unchanged.
6. **On a throw in step 4:** SQLite rolls everything back, including `user_version`. The database stays at v7, the backup is kept, and the v8 marker is incremented. The platform runs at v7 without handoffs.

The outcome is `PersistStore.lastMigrationV8`. `lastMigration` still means the v7 step, so its contract and every v7 assertion are unchanged.

Store getters:
- `platformAvailable` is true at v7 or v8 when the v7 shape check passed.
- `handoffsAvailable` is true only at v8 with the v8 post-check (or the reopen shape check) passed, and the platform available.
- `hasPlatformRecords` is now `version >= 7`. It counts `artifacts`, `jobs`, `agent_sessions` and `handoffs`.

### 22.2 The `nexus_migrations` row 8

After a successful v8 step, `nexus_migrations` has a second row:
- `version = 8` and `from_version = 7`;
- `applied_at` (ms) and `app_version`;
- `backup_file`: the basename, for example `harness-v7-20261007T120000Z.db`. It is NULL for a fresh database;
- `backup_sha256`: the same value as the `backup ok` log line;
- `backup_bytes`;
- `row_counts_json`: the pre-migration count of every table;
- `backfill_json` = `'{}'`.

The `db.migrated` activity row has actor `system`, `entity_id` `'8'`, and details `{from: 7, to: 8, backupFile, backupSha256}`.

### 22.3 Log lines, in order

Every line is prefixed with an ISO timestamp. As in v7, lines carry versions, counts, durations, basenames, hashes and redacted errors, and never row contents, kv values or full paths (test M12).

**First launch of a v7 database (success):**
```
[db] schema version 7
[db] v8 precheck ok integrity=ok integrityMs=<n> free=<bytes|unknown> needed=<n>
[db] backup ok file=harness-v7-<UTC>.db bytes=<n> sha256=<hex> from=7 writeMs=<n> verifyMs=<n> hashMs=<n>
[db] row counts <table>=<n> ...
[db] v8 migration: start from=7
[db] v8 migration: success to=8 durationMs=<n> handoffStates=4 handoffTransitions=3
[nexus] platform ready: principals ok, workspaces added=0, primaries set=<n> cleared=<n>, sessions interrupted=0, jobs interrupted=0 requeued=0
```

**A v6 database in one launch:** the six v7 lines of [section 15.3](#153-log-lines-in-order), unchanged and with the `harness-v6-…` backup. Then the v8 lines above, without the `schema version` line.

**Fresh database:**
- `[db] schema version 0`, then `[db] fresh database: no backup needed`;
- the v7 `start` and `success` lines;
- `[db] fresh database: no v8 backup needed`;
- `[db] v8 migration: start from=7` and `[db] v8 migration: success to=8 …`.

**Every later launch:** `[db] schema version 8`, then the `[nexus] platform ready` line. No second backup and no migration.

**Held by the switch:**
```
[db] v8 migration: skipped reason=held (NEXUS_DB_HOLD_V8=1); database stays at v7
```
The parenthesis reads `(NEXUS_DB_HOLD_V7=1)` when only the v7 hold is set on a v7 database. The line is logged on every held launch at v7, including a launch that just applied v7. It is not logged when v7 itself is held: a v6 database stays at v6 with the v7 hold line only.

**The v8 transaction failed:**
```
[db] v8 migration: failed from=7 error=<redacted>; database left at v7; backup kept at harness-v7-<UTC>.db
[db] v8 migration will be retried at the next launch (failure <n> of 3); set NEXUS_DB_HOLD_V8=1 to stay on v7
```
- On the third consecutive failure, the second line reads instead: `[db] v8 migration has failed 3 times in a row; it is held from the next launch (held: repeated_failure)`.
- On a fresh database, the first line ends `no backup (fresh database)`.

**Held after repeated failures:**
```
[db] v8 migration: skipped reason=held: repeated_failure count=3; database stays at v7; no new backup taken
[db] to retry v8, quit and delete harness.db.v8-failures.json next to harness.db; existing backups are kept (restore one with the restore tool, tools/nexus-db-restore.cjs, if needed)
```

**Other skips (the database stays at v7, untouched):**
- `[db] v8 migration: skipped reason=precheck_failed detail=…; database left at v7`, or `reason=insufficient_disk detail=free=<n> needed=<n>`.
- `[db] backup failed stage=<write|verify|exists|unexpected> error=…`, then `[db] v8 migration: skipped reason=backup_failed detail=stage=<stage>; database left at v7`.

**Post-commit check failed:** `[db] v8 post-check FAILED; handoffs disabled; restore from backup harness-v7-<UTC>.db`.

**Reopen with a v8 shape problem:** `[db] v8 shape check failed: <problem>; handoffs disabled`.

**Platform composed without handoffs:** `[nexus] handoffs unavailable: schema v8 not in place`.

**A held launch, in order** (a v7 database with `NEXUS_DB_HOLD_V8=1` set; the hold line names `NEXUS_DB_HOLD_V7=1` when only that switch is set):
```
[db] schema version 7
[db] v8 migration: skipped reason=held (NEXUS_DB_HOLD_V8=1); database stays at v7
[nexus] handoffs unavailable: schema v8 not in place
[nexus] platform ready: principals ok, workspaces added=0, primaries set=<n> cleared=<n>, sessions interrupted=0, jobs interrupted=0 requeued=0
```

### 22.4 The hold switch, the failure marker and auto-hold

| What | Where and how |
|---|---|
| Hold switch | `NEXUS_DB_HOLD_V8=1` in the app's environment keeps the database at v7. The platform runs and handoffs are off. `NEXUS_DB_HOLD_V7=1` implies it, so a v6 database stays at v6. Unset it to migrate on the next launch, which takes a new backup first. While held, the v8 marker is not read or written. |
| Failure marker | `userData/harness.db.v8-failures.json`, next to the database: `{"count":n,"lastFailureAt":<ms>}`. It is separate from `harness.db.v7-failures.json`. Each failed v8 transaction increments it, and a successful commit deletes it. Skips (pre-check, disk, backup) do not count. |
| Auto-hold | At 3 consecutive failures (`V8_FAILURE_LIMIT`), v8 holds itself. No new backup is taken on each launch, and the two "held after repeated failures" lines are logged. To retry, quit the app and delete `harness.db.v8-failures.json`. Existing backups are kept. |
| Backups | `userData/backups/harness-v7-<UTC>.db`, next to any `harness-v6-<UTC>.db`. Nothing prunes them. |

### 22.5 When handoffs alone are off

`PersistStore.handoffsUnavailableReason` says why handoffs are off while the platform is up. It is null when handoffs are available, and also when the whole platform is off. `src/main/index.ts` reads it after `open()` and resets it to null if platform startup fails.

The handoff channels (#15 to #20) answer `{ ok: false, code: 'platform_unavailable', reason: 'handoffs_unavailable', subReason }`. Every other channel works normally.

| `subReason` | Set when | What the UI shows (`handoffsNotice`) |
|---|---|---|
| `held` | `NEXUS_DB_HOLD_V8=1` (or `NEXUS_DB_HOLD_V7=1`) kept the database at v7 | "Handoffs are not available because the database upgrade that adds them is held." |
| `auto_held` | The v8 marker reached 3 | "Handoffs are not available because the database upgrade that adds them was held after an earlier problem." |
| `backup_failed` | The `harness-v7` backup could not be written or verified | "Handoffs are not available because the backup before the database upgrade that adds them failed." |
| `failed` | The v8 transaction rolled back, the v8 post-check failed, a pre-check or the disk check skipped v8, or the v8 step threw unexpectedly | "Handoffs are not available because the database upgrade that adds them did not complete." |
| `shape` | The database is at v8, but the v8 shape check failed on reopen | "Handoffs are not available because the handoff tables do not have the expected layout." |
| (none) | An unknown or missing sub-reason | "Handoffs are not available on this database." |

The sentence appears on the Handoffs page, as an `nx-hfx__off` status line, and in the Passport's handoffs section. Elsewhere, "Hand off…" is never rendered: it needs a handoff channel to have answered successfully first. Even with handoffs on, it renders only when the project has another active participation to receive the handoff (`canHandOff(…, hasReceiver)`, where `hasReceiver` uses the send sheet's `toChoices`). Everything else (artifacts, versions, lineage, workspaces and activity) keeps working.

When the whole platform is off, the reason is one of `held`, `migration_failed`, `newer_schema`, `shape_mismatch`, `startup_failed` or `not_open`. [Section 28](#28-the-renderer) shows what the UI does then.

### 22.6 Restore to v7

You do not need a restore after a failed v8 transaction: the database is still v7. Restore after a v8 post-check failure, or when the user asks to roll back to v7. Follow [section 15.6](#156-restore-procedure), with the v7 backup:

1. Quit the app. Copy `harness.db` and any `-wal`/`-shm` to a folder outside userData, as your independent fallback.
2. Take the sha256 from the v8 `backup ok … from=7` log line, or from `nexus_migrations` row 8 (`backup_sha256`).
3. Dry run:
   ```
   node tools/nexus-db-restore.cjs --db <userData>/harness.db --backup <userData>/backups/harness-v7-<UTC>.db --sha256 <hex>
   ```
4. Apply: the same command with `--apply`.
5. Relaunch with `NEXUS_DB_HOLD_V8=1` to stay on v7. Without the hold, the app migrates again: a new `harness-v7-<UTC>.db` backup first, then v8. If the v8 marker reached 3, delete `harness.db.v8-failures.json` before retrying.

**The tool names the matching hold switch.** After the sha256 check, it reads the backup's `user_version` from the SQLite header (bytes 60 to 63, big-endian) and prints it in its last line:
- a v7 backup prints `Next: launch with NEXUS_DB_HOLD_V8=1 to stay on schema v7, …`;
- a v6 backup prints `Next: launch with NEXUS_DB_HOLD_V7=1 to stay on schema v6, …`;
- a dry run prints the same sentence after `After the restore:`.

Backups are written by `VACUUM INTO` in journal mode DELETE, so the header is current. A file without a SQLite header gets a sentence that names both switches. A version with no switch (for example v8) gets a sentence that names none. The restore itself never depends on the header.

To check a restore without launching the app, open the restored file with Electron-as-node. Expect:
- `user_version` 7;
- `integrity_check` `ok`;
- the legacy row counts equal to `row_counts_json` of row 8.

### 22.7 Downgrade: the `e2fceec` build on a v8 database

The B0b build (`e2fceec`) knows schemas up to v7. On a v8 database:
- It logs `[db] schema v8 is newer than this build (v7); opened for legacy use only, platform disabled, nothing migrated`. The outcome is `skipped: newer_schema`.
- Phase A works: list, save, and delete a project that has no platform records. `user_version` stays 8.
- **Its delete guard is off at v8.** Its `hasPlatformRecords` answers false whenever the version is not exactly 7. A delete of a project that has artifacts, jobs, sessions or handoffs therefore hits the FK RESTRICT (`SQLITE_CONSTRAINT_FOREIGNKEY`). It is retried and then dropped, exactly as [section 16, item 2](#16-known-limitations-and-operational-notes) describes for pre-B0b builds on v7. The project and its records stay.
- The current build then reopens the file with outcome `not_needed` for both steps and handoffs on. It refuses that delete cleanly.

`test/nexus-db-phase-a.test.cjs` pins this. It materialises `e2fceec`'s `db.ts`, `legacyWriteQueue.ts`, `crashLog.ts`, `src/main/nexus` and `src/shared` with `test/helpers/materialize-rev.cjs`. Nothing stops an older build from opening a v8 database (D1, unchanged).

---

## 23. Authorization in B1

**Policy.** `policy.ts` gains four actions. Nothing else changes, and `version.finalize` stays system only.

| Minimum role | Actions added in B1 |
|---|---|
| `viewer` | `handoff.read` |
| `member` | `handoff.send`, `handoff.respond`, `handoff.withdraw` |

The full table is in [section 6](#6-the-authorization-chain). The rules of section 6 still hold: authorize first, before any transaction; the authority workspace always comes from a stored row; authorization comes before existence.

**What each B1 operation requires** (all before its transaction):

| Operation | Required |
|---|---|
| `saveUserVersion`, new artifact | `artifact.create` AND `version.register`, on the resolved participation's stored workspace. This is stricter than one call, and no weaker than the two B0b calls it replaces. |
| `saveUserVersion`, append | `version.register` on the artifact's stored `owner_workspace_id` |
| `markReady` | `version.update_draft` for the user, and `version.finalize` for the system principal, both on the stored owner workspace |
| `linkSources` | `lineage.write` on each endpoint's stored owner workspace |
| `handoffs.send` | `handoff.send` on the sending participation's stored project and workspace, plus `artifact.read` on each subject (`requireVersionReadable`) |
| `handoffs.accept` | For the user, on the stored receiving workspace: `handoff.respond`, `artifact.create`, `version.register`, `version.promote` and `lineage.write`. For the system principal: `version.finalize`. |
| `handoffs.decline` | `handoff.respond` on the stored receiving workspace |
| `handoffs.withdraw` | `handoff.withdraw` on the stored sending workspace |
| `handoffs.get` | `handoff.read` on either side's stored workspace. A denial is audited against the receiving side. |
| `handoffs.list` | `handoff.read`. A `projectId` filter is checked at project scope (audited). Rows are then filtered with a read-only, cached `authorize` that writes no audit rows: the inbox checks the receiving side, Sent checks the sending side, and All checks either. |
| `workspaces.listForReader`, `artifacts.listForReader` | `project.read` or `artifact.read` per row, with the row's stored workspace. The check is read-only, cached per (project, workspace), and writes no audit rows. |

**Mark ready (ruling C4).** `version.finalize` is system only, but a user can make their own draft ready. `ArtifactService.markReady`:
- requires the user to hold `version.update_draft` on the stored owner workspace;
- requires the draft to have no producing job or session (`invalid`, reason `produced_by_job`), so a user can never push an engine-made draft through;
- has the system principal perform the finalize, `draft → candidate`;
- writes a `version.finalize` activity row with actor `system`, `on_behalf_of` the user, and details `{from: 'draft', to: 'candidate', via: 'mark_ready'}`.

Other outcomes:
- A candidate is returned as is, with no second row.
- Any other status is `illegal_transition`.
- An archived artifact is a `conflict`.
- A withdrawn owner gives `participation_inactive`.

**Workspace grants.** A workspace membership counts for a project only while the project has an ACTIVE participation in that workspace ([section 16, item 9](#16-known-limitations-and-operational-notes)). That is unchanged in B1, and multi-user grants stay deferred (ruling C13). In the single-user app, `user:local` is the platform `owner`, so every check passes for it. The rules matter for the tests' restricted principals, and for later multi-user work.

**Known B1 limitation: user saves pre-check at project scope.**
- `UserSaves` authorizes BEFORE any file or git read, so a denied caller learns nothing about files or commits. That check is `projects.require(p, projectId, 'artifact.create' | 'version.register')` at plain project scope.
- A principal whose only right comes from a workspace grant is therefore denied there, even though `saveUserVersion` itself would allow it.
- This fails closed. It is harmless for the single local user, and it must be revisited with multi-user grants.

**The principal.** It is always `user:local` (see [section 24](#24-the-ipc-surface)).

---

## 24. The IPC surface

**Module.** `src/main/nexusIpc/registerNexusIpc.ts` exports `registerNexusIpc(registrar, deps)` and `NEXUS_CHANNELS` (21 channels, frozen).
- `src/main/index.ts` calls it once, at module top level, with `ipcMain`.
- `deps` are: `platform()` (read at call time), `unavailableReason()`, `handoffsUnavailableReason()`, `sources` (the main `SourcePorts`) and `log`.
- No other file registers a `nexus:*` channel, and no channel outside the `nexus:*` family was added.

**The wrapper.** Every channel runs through one wrapper, `handler(channel, parse, run)`. It never throws:
1. **Platform check.** No platform answers `platform_unavailable` with the store's reason (or `not_open`). A handoff channel while `nx.handoffs` is null answers `platform_unavailable`, reason `handoffs_unavailable`, with the `subReason`.
2. **Validation**, through `validate.ts`.
3. **The principal:** `nx.principals.localUser()`, which is always `user:local`. Nothing identity-shaped is read from the arguments: no schema has a principal, actor, role or folder field.
4. **One service call**, mapped to a view by `dto.ts`. Authorization stays in the services; the IPC layer decides nothing.
5. **Errors**, through `envelope.ts`.

**Result type** (`src/shared/nexus/ipc.ts`):
```ts
type NexusOk<T>   = { ok: true; data: T; truncated?: boolean };
type NexusFail    = { ok: false; code: NexusErrorCode; message: string; reason?: string; subReason?: string; field?: string;
                      detail?: Partial<Record<NexusErrorDetailKey, string | number | null>> };
type NexusResult<T> = NexusOk<T> | NexusFail;   // a channel never rejects
```
`truncated` is set on list answers, and is true only when more rows exist than were returned.

### 24.1 The 21 channels

Every channel can also answer:
- `platform_unavailable`;
- `internal`;
- `invalid` with reason `bad_request` and the refused `field`.

Channels #15 to #20 can also answer `platform_unavailable` with reason `handoffs_unavailable`.

| # | Channel and preload method | Args (validated) | `data` | Service | Other error codes and reasons |
|---|---|---|---|---|---|
| 1 | `nexus:participations:list`, `nexusParticipationsList()` | none | `ParticipationView[]`: every participation (every status) of every project the user may read. `truncated: false`. | `workspaces.listForReader` | none |
| 2 | `nexus:participation:attach`, `nexusParticipationAttach(projectId, workspaceId)` | `projectId`, `workspaceId` | `ParticipationView` | `workspaces.attach` | `invalid` (unknown or retired workspace), `conflict` (a `complete` participation), `not_found`, `denied` |
| 3 | `nexus:participation:withdraw`, `nexusParticipationWithdraw(participationId)` | platform id | `ParticipationView` | `workspaces.withdraw` | `invalid` (the primary); `conflict` with `detail.liveJobs`/`liveSessions` (live work) or `detail.openHandoffs` (open handoffs); `not_found`, `denied` |
| 4 | `nexus:artifacts:list`, `nexusArtifactsList(filter?)` | optional `{ projectId?, workspaceId?, kind?, status?: 'active'\|'archived', limit? }` | `ArtifactSummaryView[]`, most recently updated first. `truncated` when more exist. | `artifacts.listForReader` | none beyond `bad_request` |
| 5 | `nexus:artifacts:byProject`, `nexusArtifactsByProject(projectId)` | `projectId` | `ArtifactSummaryView[]` with each artifact's latest and current version, in creation order, at most 1000. `truncated` only when a 1001st exists. | `artifacts.summariesByProject` | `not_found`, `denied` |
| 6 | `nexus:artifact:get`, `nexusArtifactGet(artifactId)` | platform id | `{ artifact: ArtifactView; versions: VersionView[] }`, with no content | `artifacts.get` + `listVersions` | `not_found`, `denied` |
| 7 | `nexus:version:get`, `nexusVersionGet(versionId)` | platform id | `VersionDetail`: a `VersionView` plus `content`, which is one of:<br>- `{ type: 'git', commit }`;<br>- `{ type: 'text', path, text }`;<br>- `{ type: 'receipt', handoffId }`;<br>- `{ type: 'none' }`. | `artifacts.getVersion` + `get` | `not_found`, `denied` |
| 8 | `nexus:lineage:get`, `nexusLineageGet(versionId, { direction, depth? })` | `direction` is `'up'` or `'down'`; `depth` is an integer from 1 to 6 (default 6, strict) | `{ nodes: LineageNodeView[]; truncated }`. The envelope's `truncated` equals the walk's. | `lineage.upstream` / `downstream` | `not_found`, `denied`, `invalid` |
| 9 | `nexus:artifact:saveCommit`, `nexusArtifactSaveCommit(args)` | `{ projectId, workspaceId, commit (40 hex), target: { artifactId } \| { name } }`, exact keys | `{ artifact, version, created }` | `UserSaves.saveCommit` → `artifacts.saveUserVersion` | `invalid` with reasons `not_a_repository`, `not_a_commit`, `project_folder_unavailable`, `kind_mismatch` or `secret_in_metadata`; `not_participating`, `participation_inactive`, `conflict` (archived), `not_found`, `denied` |
| 10 | `nexus:artifact:saveTextFile`, `nexusArtifactSaveTextFile(args)` | `{ projectId, workspaceId, relPath, target }`, exact keys | `{ artifact, version, created }` | `UserSaves.saveTextFile` → `artifacts.saveUserVersion` | `invalid` with reasons `file_not_found`, `path_refused`, `too_large` (`detail.limit` 65536), `not_text`, `secret_in_content`, `sensitive_name`, `project_folder_unavailable` or `kind_mismatch`; plus the codes of #9 |
| 11 | `nexus:version:markReady`, `nexusVersionMarkReady(versionId)` | platform id | `VersionView` | `artifacts.markReady` | `illegal_transition`, `invalid` (reason `produced_by_job`), `conflict` (archived), `participation_inactive`, `not_found`, `denied` |
| 12 | `nexus:version:promote`, `nexusVersionPromote(versionId, expectedCurrentVersionId)` | platform id; the expected current version, an id or `null` (required) | `VersionView` | `artifacts.promote` (a compare-and-set) | `conflict` with `detail.currentVersionId` (the pointer moved), `illegal_transition`, `participation_inactive`, `not_found`, `denied` |
| 13 | `nexus:version:discard`, `nexusVersionDiscard(versionId)` | platform id | `VersionView` | `artifacts.discard` | `illegal_transition`, `participation_inactive`, `not_found`, `denied` |
| 14 | `nexus:version:linkSources`, `nexusVersionLinkSources(versionId, sourceVersionIds)` | platform id; 1 to 20 unique platform ids | `{ edges: EdgeView[]; created: number }` | `lineage.linkSources` | `cycle`; `invalid` (a draft source, another project); `conflict` (archived consumer), `participation_inactive`, `not_found`, `denied` |
| 15 | `nexus:handoffs:list`, `nexusHandoffsList(filter?)` | optional `{ projectId?, workspaceId?, box?: 'inbox'\|'sent'\|'all', status?, limit? }` | `HandoffSummaryView[]`: open first, then newest. `truncated` when more exist. | `handoffs.list` | none beyond `bad_request` |
| 16 | `nexus:handoff:get`, `nexusHandoffGet(handoffId)` | platform id | `HandoffDetailView`: subjects with artifact name, kind, version number, current status and `newerVersionNo` | `handoffs.get` | `not_found`, `denied` |
| 17 | `nexus:handoff:send`, `nexusHandoffSend(args)` | `{ projectId, fromParticipationId, toParticipationId, versionIds (1 to 20), title, note? }`, exact keys | `{ handoff: HandoffDetailView; created }` | `handoffs.send` | `invalid` (another project, the same participation, a draft or foreign subject, `secret_in_metadata`), `participation_inactive`, `not_found`, `denied` |
| 18 | `nexus:handoff:accept`, `nexusHandoffAccept(handoffId)` | platform id | `HandoffDetailView` | `handoffs.accept` | `illegal_transition` (already answered or withdrawn; `detail.handoffId`), `participation_inactive`, `conflict` (lost a race), `not_found`, `denied` |
| 19 | `nexus:handoff:decline`, `nexusHandoffDecline(handoffId, note?)` | platform id; an optional note | `HandoffDetailView` | `handoffs.decline` | as #18, plus `invalid` (`secret_in_metadata` in the note) |
| 20 | `nexus:handoff:withdraw`, `nexusHandoffWithdraw(handoffId)` | platform id | `HandoffDetailView` | `handoffs.withdraw` | as #18 |
| 21 | `nexus:activity:byProject`, `nexusActivityByProject(projectId, page?)` | `projectId`; optional `{ beforeSeq? (integer ≥ 1), limit? }` | `ActivityView[]`, newest first. `truncated` when more exist. | `projects.require(activity.read)`, then `activity.list` | `not_found` (unknown project), `denied` |

**Limits.**
- `limit` on #4 and #15 defaults to 200 and is clamped to 500. On #21 it defaults to 50 and is clamped to 50.
- A limit that is not an integer, or lies outside 1 to 100,000, is `bad_request`.
- The services have their own caps: `listForReader` and `handoffs.list` take 1 to 1000, and `summariesByProject` 1000.

**Views.**
- No view carries a principal id: there is no `createdBy`, `respondedBy`, `actorId` or `onBehalfOf`. `ActivityView` has the actor kind and an `onBehalfOfUser` flag.
- Lists carry no storage and no content.
- Version metadata is not sent. A git version exposes only its commit; the renderer reads commit subjects from the project's own git log.
- Activity `details` are reduced to scalar, allow-listed keys. Strings are scrubbed and capped at 64 characters.

### 24.2 Errors

`envelope.ts`:
- **A `RequestError`** from validation gives `invalid`, reason `bad_request`, and the `field`.
- **A `PlatformError`** keeps its code.
  - The message is scrubbed: absolute paths are cut to their basename, secret-shaped text is redacted (`redactSecretText`), the text is put on one line and capped at 300 characters.
  - A service `detail.reason` is lifted to `reason`. For the user-facing reasons, the message is replaced by a fixed sentence, for example `path_refused`: "That file cannot be saved. Paths outside the project folder are refused, and so are files with several hard links (as pnpm stores and some backup tools create them)."
  - `detail` keeps only the allow-listed keys `currentVersionId`, `handoffId`, `versionId`, `participationId`, `liveJobs`, `liveSessions`, `openHandoffs`, `existingId` and `limit`, with scalar values only.
- **A `platform_unavailable` from a service** never carries its own text. It becomes one of:
  - `busy`, with the message "The database is busy. Try again in a moment.", when `detail.sqliteCode` is `SQLITE_BUSY*` or `SQLITE_LOCKED*`. Another writer held the lock past `busy_timeout`, nothing was written, and the request may be sent again.
  - `handoffs_unavailable`, with its `subReason`, when the service says so.
  - `startup_failed` otherwise, for example when a seeded principal is missing.
- **Anything else** gives `internal`, with the message "The request could not be completed.". It also writes one log line, `[nexus-ipc] <channel> failed error=<name> code=<code>`, with no stack, no path and no SQLite text.

| `reason` of `platform_unavailable` | Meaning |
|---|---|
| `held` | The v7 upgrade is held (`NEXUS_DB_HOLD_V7=1`) |
| `migration_failed` | The v7 step was skipped or failed, or its post-check failed |
| `newer_schema` | The database is newer than this build |
| `shape_mismatch` | The v7 shape check failed |
| `startup_failed` | Platform startup threw, or a service reported the platform unusable |
| `not_open` | The store is not open (yet) |
| `busy` | A held lock; retry |
| `handoffs_unavailable` (+ `subReason`) | Handoff channels only; see [section 22.5](#225-when-handoffs-alone-are-off) |

### 24.3 Validation rules (`validate.ts`)

| Kind | Rule |
|---|---|
| Platform id (artifact, version, participation, handoff) | `^[0-9A-HJKMNP-TV-Z]{26}$`, the ULID shape `newId` produces |
| `projectId` | `^[A-Za-z0-9_-]{1,64}$` |
| `workspaceId` | `^[a-z][a-z0-9-]{1,31}$`. The service checks it against `workspaces`. |
| `commit` | `^[0-9a-f]{40}$` (a full lowercase sha) |
| `kind` (artifact filter) | `^[a-z][a-z0-9_.-]{1,39}$` |
| `relPath` | 1 to 1024 characters. NUL, absolute paths (POSIX, drive letter or UNC) and any `..` segment are refused. Backslashes become `/`. The source port confines it again ([section 26](#26-user-saves)). |
| `title`, `name` | Trimmed, 1 to 200 characters, no control characters |
| `note` | 0 to 2000 characters, no NUL |
| Id arrays | 1 to the stated maximum, unique entries |
| Objects | A plain object (prototype `Object.prototype` or null) with an exact key set: an unknown key is refused, and so are own `__proto__`, `constructor` and `prototype` keys and symbol keys. Values are read from their own data descriptors; a getter or setter is refused and never run. An unknown key is echoed as `field` only when it is a plain identifier. |
| Numbers | Safe integers in range |
| Positional arguments | At most the channel's count; trailing `undefined` arguments are ignored |
| `target` | Exactly one of `{ artifactId }` or `{ name }` |
| `expectedCurrentVersionId` | An id or an explicit `null`; `undefined` is refused |

### 24.4 Preload and the pins

`src/preload/index.ts` exposes 21 camelCase methods, one per channel, in the table's order. Each returns `Promise<NexusResult<…>>`. Their types come in through `import type` from `../shared/nexus/ipc`, so the preload's runtime imports stay `electron` only. The renderer reaches them through `data/nexusClient.ts`, which turns a rejected invoke or a malformed answer into `{ ok: false, code: 'internal' }`.

Where the pins live:
- **`test/nexus-platform-composition.test.cjs`, "nexus:* channels":**
  - `NEXUS_CHANNELS`, the literals in `registerNexusIpc.ts`, the channels actually registered (through a fake registrar) and the preload's `ipcRenderer.invoke('nexus:…')` literals all equal one 21-entry list written in the test;
  - the preload methods equal an exact list;
  - `index.ts` has no `nexus:` literal and exactly one `registerNexusIpc(ipcMain, {` call;
  - no other file under `src/main` holds a `nexus:` literal.
- **The same file, "nexusIpc":**
  - there is exactly one `registrar.handle(` call, wrapped in `handler(…)`;
  - `principals.localUser()` appears exactly once, inside the wrapper;
  - no identity field is read from a request;
  - the ban on transport inside `src/main/nexus` is repeated.
- **`test/nexus-caller-paths.test.cjs`:** `sources.ts` takes the folder only from `getProject(id).rootPath` through `acceptFsRoot`, and no request schema has a root, cwd, path, dir or folder field other than `relPath`.
- **`test/nexus-platform-ipc.test.cjs`:** hostile arguments to every channel, the availability envelopes, busy, truncation, and the accessor refusal. **`test/nexus-platform-b1-flows.test.cjs`:** the end-to-end flows and the orphan checks ([section 19](#19-tests)).
- **`test/nexus-core-identity-scan.test.cjs`:** it also walks `src/main/nexusIpc` and `src/shared/nexus/ipc.ts`.

---

## 25. Handoffs

A handoff sends one or more artifact versions, by reference, from one participation to another participation of the SAME project. B1 is user-only: agents act only through tokens, which arrive later. There is no route table.

**Send** (`HandoffService.send`):
- Validated first:
  - 1 to 20 distinct version ids;
  - a title of 1 to 200 characters and an optional note of at most 2000;
  - neither may be secret-shaped (`invalid`, reason `secret_in_metadata`).
- Participation checks:
  - The `projectId` the caller passes must match the sending participation's stored project.
  - Both participations must be ACTIVE (`participation_inactive`).
  - The receiver must be in the same project and must not be the sender (`invalid`).
  - An unknown or foreign participation id answers `denied` to a caller who is not authorized platform-wide, with one audited row, so nothing leaks about other projects.
- Each subject must be readable, `candidate` or `active`, and owned by the sending participation (`invalid`).
- One `immediateTx`:
  - re-checks the participations and the subjects;
  - **dedupes:** an open handoff with the same sender, the same receiver and the same subject set (in any order) is returned with `created: false`;
  - otherwise inserts the handoff, its subjects (positions 1 to n, with each hash copied) and one `handoff.send` activity row with `{ subjects, toWorkspaceId }`.

**Accept** creates the **receipt** (rulings C1 and C18, confirmed by the user). In one `immediateTx`, in this order:
1. The handoff is re-read. Any status other than `sent` is `illegal_transition` with `detail.handoffId` and the message "cannot accept a handoff that is already <status>". The receiving participation must be active.
2. A new artifact is created with kind `handoff_receipt` (shown as "Received"). It is owned by the receiving participation and named after the handoff title.
3. Its version 1 is created. It is inline, and holds **references only**: `{ handoffId, subjects: [{ versionId, contentHash }] }`. Its `inputs_json` lists the subjects with role `received`, and its `produced_by_action` is `user.accept_handoff`.
4. The system finalizes the version to `candidate` on the user's behalf (`via: 'accept_handoff'`).
5. The user promotes it to `active`. `tr_handoffs_receipt` requires an active receipt.
6. One lineage edge is written per subject: receipt → subject, relation `depends_on`, source `handoff_convert`, created by the user. Each edge has its own `lineage.write` row.
7. One compare-and-set UPDATE moves `sent → accepted` and sets `receipt_version_id`, `responded_by` and `responded_at`. If it changes no row, the answer is `conflict`.
8. One `handoff.accept` row is written with `{ receiptVersionId, subjects }`.

The activity order is pinned: `artifact.create`, `version.register`, `version.finalize`, `version.promote`, then `lineage.write` per subject, then `handoff.accept`. All of these rows are in the receiving workspace.

No content is copied: the receipt never holds the subject's text or commit. A failure at any of the 7 injection points tested (H7) leaves no receipt, no edge and no status change.

**`handoff_convert` edges** are written only by `HandoffService.accept`. `LineageService.record` refuses that source with `invalid`: "handoff_convert edges are written only by accepting a handoff".

**Subjects are accepted as sent.** The copied `content_hash` is the evidence of what was sent. A subject that was discarded or deprecated after the send is still accepted, and its edge points at the now-deprecated version (test H19). `nexus:handoff:get` shows each subject's CURRENT status, and the UI notes when a newer version exists (`newerVersionNo`).

**Decline** requires `handoff.respond` on the receiving side. A compare-and-set moves `sent → declined` and records `responded_by`, `responded_at` and the optional validated note. The `handoff.decline` activity row holds `{ withNote }`, never the note text. No receipt is created. Any other status is `illegal_transition`: "cannot decline a handoff that is already <status>".

**Withdraw** requires `handoff.withdraw` on the sending side. It works only before an answer. A compare-and-set moves `sent → withdrawn`. The answer fields stay NULL, because a withdrawal is not an answer (the trigger refuses them); the withdrawing principal is in the activity row. `withdrawn` is terminal. Any other status is `illegal_transition`: "cannot withdraw a handoff that is already <status>".

**Races.** An accept that loses to a withdraw, which can be a second connection between accept's checks and its transaction, fails cleanly with `illegal_transition` and writes nothing (test H17). A double accept, or a double answer, is refused the same way.

**The withdraw guard.** `WorkspaceService.withdraw` refuses with `conflict` and `detail: { participationId, openHandoffs }` while the participation has any `sent` handoff in either direction (`openCountFor`, through `ix_handoffs_from` and `ix_handoffs_to`). The UI says "Answer or withdraw its open handoffs first." This sits beside the B0b live-work guard (`liveJobs`, `liveSessions`). Once every open handoff is answered or withdrawn, the withdraw succeeds. After that:
- the participation's artifacts freeze (`participation_inactive`), including its receipts;
- a send to it is `participation_inactive`;
- a save into it is `not_participating`.

**Reads.**
- `get` joins each subject to its artifact name, kind, version number, current status and `newerVersionNo`.
- `list` returns open handoffs first, then the newest. The service limit defaults to 200, with a maximum of 1000. Paging works like `artifacts.listForReader`.
- With `workspaceId`, the box decides which column is matched.

---

## 26. User saves

`UserSaves` (rules) plus `SourcePorts` (main adapters, `src/main/nexusIpc/sources.ts`). The renderer only ever names a project, a workspace, a relative path or a commit sha. None of them is trusted.

**Order, for both saves:**
1. **Authorization before any I/O**, at plain project scope ([section 23](#23-authorization-in-b1)). A denied caller causes no port call.
2. **The project folder.** It comes only from the stored `projects` row (`getProject(id).rootPath`), accepted by `acceptFsRoot`, and must be a directory. Otherwise the answer is `invalid`, reason `project_folder_unavailable`.
3. **The read and its checks** (below).
4. **The write.** It always goes through `ArtifactService.saveUserVersion`, which runs in ONE IMMEDIATE transaction:
   - it re-authorizes with the stored workspace;
   - it re-checks the participation and the artifact after every await;
   - it creates the artifact (if new) and the version together, so there is never an artifact without a version;
   - it dedupes by content hash: the newest draft, candidate or active version with the same hash is returned with `created: false`;
   - it writes the activity rows.

   The new version is a `draft`. Kind and storage are pinned:

   | Kind | Storage | `produced_by_action` |
   |---|---|---|
   | `git_commit` | `git` | `user.save_commit` |
   | `text_file` | `inline` | `user.save_file` |

   `git_commit` is a plain participation-owned kind, not `repository` (ruling C5).

**Path rules (text files).** A path is refused as `path_refused` when:
- it is absolute: POSIX, a drive letter, UNC, or the Windows `\\?\` and `\\.\` forms;
- it holds a `..` segment or a NUL;
- it is longer than 1024 characters;
- on Windows, a segment holds `:` (alternate data streams), ends in a dot or a space (Windows would open a different name: `.env.` opens `.env`), or is a reserved device name (`CON`, `PRN`, `AUX`, `NUL`, `CONIN$`, `CONOUT$`, `CLOCK$`, `COM0`–`COM9`, `LPT0`–`LPT9` and the superscript forms, with or without an extension).

Every existing step of the path is resolved with realpath and must stay inside the real project root. Symbolic links and junctions are followed only while they stay inside. A link that leaves the project is refused, even when its target is missing, so nothing outside the project can be probed.

Only a **regular file with one link** is read. `nlink > 1` is refused, because a hard link is a second name for a file that may live outside the project. It is checked on the stat, on the open handle and after the read. **This refuses files in pnpm stores, and files that some backup and deduplication tools hard-link.** Copy such a file before saving it. A directory is reported as `file_not_found`.

**Double-swap checks.** After the read:
- the confined name must still realpath to itself, inside the root;
- it must name the SAME file (device and inode) as the open handle.

A file swapped away and back during the read is refused.

**Size.**
- The size is checked before the read and again on the handle, and at most 65,537 bytes are ever read. A 4 GiB sparse file is refused in under a second.
- Two limits apply (ruling C6): the raw file must be at most **64 KiB** (`TEXT_FILE_MAX_BYTES` = 65,536), AND the stored record `{ path, text }` must fit `INLINE_MAX_BYTES` (65,536 bytes of canonical JSON). Escaping (quotes, backslashes, control characters) and the wrapper add bytes, so a file just under 64 KiB can still be refused.
- Both refusals are `too_large`, with `detail.limit = 65536`. The Save sheet shows files over 64 KiB as disabled.

**Text.**
- The bytes must be strict UTF-8.
- A byte-order mark is KEPT: the stored text re-encodes to the file's bytes exactly.
- C0 control characters other than tab, LF, FF and CR, and DEL, are refused as `not_text`.

**Sensitive names and content (ruling C7).** The generic `registerVersion` still does not secret-check inline content ([section 16, item 11](#16-known-limitations-and-operational-notes)), so the user-save command does it.
- **Names.** These are refused as `sensitive_name` BEFORE any read, on the requested basename and again on the real file's name (a link inside the project may point at `.env`). Matching is case-insensitive and ignores trailing dots and spaces. The list is `SENSITIVE_NAMES` in `userSaves.ts`:
  - `.env` and `.env.*`;
  - `*.pem`, `*.key`, `*.jks`, `*.keystore`, `*.p12`, `*.pfx` and `*.ppk`;
  - `id_rsa*`, `id_dsa*`, `id_ecdsa*` and `id_ed25519*`;
  - `.npmrc`, `.pypirc`, `.netrc`, `.git-credentials` and `.htpasswd`;
  - `credentials*` and `*.kdbx`;
  - any path with a `.git` segment.
- **Content.** These are refused as `secret_in_content`:
  - private-key material by its header: PEM, OpenSSH and PGP `-----BEGIN … PRIVATE KEY( BLOCK)?-----`, or `PuTTY-User-Key-File-`;
  - anything `containsSecret` flags, including the long-token rule ([section 16, item 17](#16-known-limitations-and-operational-notes)).

  The size check runs before the secret scan, so the scan only ever sees a record that fits.
- **Metadata** is `{ source: 'project_file', path, bytes }`.

**Commit rules.**
- The caller must send a **full 40-character lowercase sha**. Through IPC a malformed sha is `invalid`/`bad_request` (field `commit`). The service itself answers `not_a_commit` for a malformed or unknown sha.
- `git.resolveCommit` runs `rev-parse --verify --quiet <sha>^{commit}` in the project folder, then `show -s` on git's own full sha, never on the caller's text. The `%H` git prints must equal it. So a sha can never be read as an option, a ref or a range.
- **Annotated tags are peeled:** the stored commit is the tag's commit, and the hash is `git:<commit>`.
- **Parent-repository commits are allowed.** A project folder inside a larger repository (a monorepo sub-folder) resolves commits of that repository. This is a ruling: such projects are legitimate.
- On failure, one extra `rev-parse --git-dir` tells `not_a_repository` apart from `not_a_commit`.
- Storage is `{ kind: 'git', commit }`. Metadata is `{ source: 'git_commit', subject?, committedAt }`:
  - `committedAt` is in milliseconds;
  - the subject is capped at 500 characters, and dropped (never fatal) when `containsSecret` flags it.
- Git runs through the async `runGit` (spawn, never a shell); no synchronous process call was added under `src/main`.

---

## 27. Versions from the UI: mark ready, promote, discard and link sources

- **Mark ready:** `draft → candidate`, performed by the system for the user ([section 23](#23-authorization-in-b1)).
- **Make current / Roll back:** `nexus:version:promote`, with the current version the screen shows as `expectedCurrentVersionId`. It is a compare-and-set on `artifacts.current_version_id`. If the pointer moved, the answer is `conflict` with `detail.currentVersionId`, and the UI says "The current version changed; the list is refreshed". A roll back makes a `deprecated` version that was active before current again; its activity row has `rollback: true`.
- **Discard:** a draft or candidate becomes `deprecated`.
- **Link sources:** `LineageService.linkSources(p, fromVersionId, toVersionIds)`. It records "this version was derived from those". Each edge is `derived_from` with source `user_action`, for 1 to 20 sources, all in one transaction.
  - Every endpoint needs `lineage.write` on its stored owner workspace.
  - The consumer's artifact must be writable: archived is `conflict`, and an inactive owner is `participation_inactive`.
  - Sources must be out of draft and in the same project.
  - A self link, or one that would close a cycle, is `cycle`, and nothing is written.
  - A re-send creates 0 edges.
- **Archive** (`artifact.archive`, admin) has no UI in B1.

---

## 28. The renderer

### 28.1 The authority flip (D4) and the legacy fallback (C10)

Before B1, every screen derived a project's workspace from `projects.domain_id` through the renderer registry. Now:
- Screens read participations from the database through `nexus:participations:list`.
- The renderer registry keeps only labels, hues and the planned modules.
- `data/useParticipations.ts`, mounted once in `NexusShell`, loads the list in three cases:
  - on mount;
  - when the project-list signature (`id:domainId:updatedAt`) changes;
  - after every successful write (`rev`).
- The pure `workspaces/participation.ts` builds the `ParticipationIndex`:
  - the primary is the row that is both `isPrimary` and `active`;
  - attached workspaces are the other active rows;
  - "Unassigned" means no active primary.

**What did not flip:** the primary still follows the legacy domain. `PersistStore.saveProject` syncs it, as in [section 12](#12-workspaces-participation-and-phase-a). There is still no `setPrimary`. A domain change moves the primary, and the old workspace stays as an attached participation.

**The fallback (ruling C10).** When the platform is unavailable (any `platform_unavailable` reason other than `busy` and `handoffs_unavailable`):
- The screens use `legacyIndex(projects)`, the old domain grouping. It is identical to the backfilled primary. `legacyIndex` is the only remaining caller of `workspaceForDomain`.
- One non-fatal `PlatformNotice` (`role="status"`) explains why: "Workspace data is not available because <why>. Projects are grouped by their detected domain until it runs."
- **Every platform write action is hidden.** `selectCanWrite` is true only in database mode with nothing unavailable.
- The legacy project actions (New project, Import) stay.

Before the first answer, or after a `busy` or `internal` first read, the screens also use the legacy index, without the notice, and writes stay hidden. A passing failure (`busy`, `internal`) keeps the last database index and offers "Try again".

### 28.2 What each screen shows

| Screen | Shows |
|---|---|
| Launcher, Start | Projects per workspace from the participation index (primary and attached). |
| Workspaces index | Each workspace's count is its active participations, primary plus attached. A tooltip names the primary domains and the number of attached projects. The page also shows the Unassigned count. |
| Workspace page | Primary projects first, then attached ones with an "Attached" tag. The empty state says no project takes part yet. While writes are on, it adds that a project can be added from its own page. |
| Projects page | The workspace filter matches any active participation. "Unassigned" means no primary. Each row shows the primary's label and hue, plus "+N" for attached workspaces. |
| Project bench: the Spine | One group per active participation (primary first, then registry order). A withdrawn or complete participation that owns artifacts gets a muted group labelled with its state. Source and changes stay in the lead group. Artifact nodes show the kind label, the status in words, the name and `v<n>`. Drafts are dashed. Archived artifacts are not drawn. Further lines:<br>- "Reading artifacts…" while loading;<br>- an error line, with "Try again" when it can help;<br>- the "nothing yet" sentence only after a successful read that found nothing;<br>- "Only the first 1000 artifacts of this project are shown, oldest first." when `nexus:artifacts:byProject` answered `truncated`. |
| Passport, source node | Identity (the primary workspace). A **Workspaces** section: "Add to workspace" (registry workspaces that are not active or complete) and "Withdraw" on each non-primary row, with an inline confirmation. "Save as artifact" on each commit row and "Save a file…". **Recent activity:** 20 rows as sentences ("Version 2 of API notes marked ready"), shown as "You", "Nexus", "Nexus, for you" or "An agent", with "Show older activity". |
| Save sheet | Commit mode (the last 30 commits, with the full sha) or file mode (a folder browser over the project root; files over 64 KiB are disabled). The workspace is chosen from the project's active participations. The target is "New artifact" by name, or "New version of" an existing artifact of the same kind owned there. |
| Passport, artifact node | Real versions, with the current one marked. The newest 12 show their content as text: a commit sha, a file path, or "Received through a handoff". Allowed actions only: Mark ready, Make current, Roll back and Discard. Roll back and Discard have an inline confirmation. "Link a source" offers a picker over at most 30 other artifacts. Sources and Used by are shown at depth 1. "Handoffs" lists the handoffs carrying this artifact's versions, from the project's first 20 handoffs (open first, then newest). "Hand off…" appears on active versions once handoffs are known to be on, and only when the project has another active participation to receive it (the send sheet's `toChoices`). |
| Artifacts page (`#/artifacts`, `#/artifacts/<id>`) | Filters: project, workspace, kind, status (active, archived, or both) and sort (recently changed, or name). "Show more" asks for 100 more rows, up to 500, then asks the person to narrow the filters. The empty state reads "No artifacts yet. Save a commit or a file from a project's passport." While the platform is unavailable, the `PlatformNotice` alone explains why; the list adds no second sentence. The detail view reuses the artifact Passport. |
| Handoffs page (`#/handoffs`, `#/handoffs/<id>`) | Inbox, Sent and All, with workspace and status filters, grouped by workspace ("To QA", "From SDE"). The detail shows:<br>- From and To, the project, the times, the note and the answer note;<br>- the subjects by reference: "Version n, status · hash prefix", with a note when a newer version exists;<br>- after an accept, a Received section that links to the receipt artifact and the project.<br>The answers follow the page view: Accept and Decline (with an optional note) on the receiving side, and Withdraw on the sending side, with inline confirmations. Statuses are always words. |
| Send sheet | From is the artifact's owner participation. To is another active participation of the same project. Versions are the candidate and active versions of the sender's own artifacts, preselected from the version in view, at most 20. Then a title and an optional note. |
| Navigation and palette | "Go to": home, workspaces, projects, artifacts, handoffs, agents. "Planned" holds only Deployments. |
| Completion | Still **Planned**, with no phase number (ruling C9): nothing real backs completion yet. |
| Deployments | Still a **Planned** page. |
| Runs | Unchanged: session-only, in the UI store. Nothing executes, so persisted runs would be fake (ruling C11). |

All copy is plain words. Status is always shown as text, never by colour alone. Colour means provenance. No screen shows a principal id, a participation id or raw version metadata. A screen shows real rows, or an honest empty or unavailable state.

---

## 29. B1: differences between the code and the plan

The code wins. Each item says what the code does.

1. **The v8 hold line.** The plan's line always named `NEXUS_DB_HOLD_V8=1`. The code names the switch actually set (`NEXUS_DB_HOLD_V7=1` when only the v7 hold applies). It always logs the line on a held launch at v7. Migration test 18 was amended to expect it (ruling, Task 2).
2. **Unavailable reasons.** The plan had one `nexusUnavailableReason` that included `handoffs_unavailable`. The code keeps it for the whole platform, adds a separate sub-reason (`handoffsUnavailableReason`: `held`, `auto_held`, `backup_failed`, `failed` or `shape`), and adds the `busy` reason for a held lock.
3. **The envelope.** `truncated` sits on the ok envelope (plus inside the lineage data), and `subReason` is a field of `NexusFail`. A limit above the channel maximum is clamped, not refused; only a non-integer or a value outside 1 to 100,000 is refused. The plan wrote "limit ≤ 500".
4. **`nexus:artifacts:byProject`** asks the service for 1001 rows, so `truncated` is exact at 1000.
5. **`nexus:activity:byProject`** first runs `projects.require(…, 'activity.read')`, so an unknown project is `not_found`, not an empty list.
6. **Stricter authorization.** A new-artifact save requires `artifact.create` AND `version.register`. Accept also requires `version.register` and `version.promote`. `markReady` refuses an archived artifact (`conflict`). `linkSources` refuses a frozen or archived consumer.
7. **The user-save pre-check** runs at plain project scope ([section 23](#23-authorization-in-b1)).
8. **User saves.** A directory path is reported as `file_not_found`. `committedAt` is in milliseconds. A secret-shaped commit subject is dropped. `too_large` carries `detail.limit = 65536` for both size limits.
9. **Hard links.** The plan did not mention them. `nlink > 1` is refused, along with dev and inode double-swap checks and Windows aliases: trailing dot or space, devices, ADS, `\\?\`.
10. **The sensitive-name list** is wider than the plan's. It adds DSA, ECDSA, PPK, keystores, `.git-credentials`, `.htpasswd` and `.git` segments. Private-key content is refused by header.
11. **The ReDoS fix** is a linear long-token rule (128 separators), not the requested 2048-character run rule. The run rule left multi-second cases and broke two B0b job tests (ruling, Task 5).
12. **Send dedupe.** An identical open handoff (same sender, receiver and subject set) returns `created: false`. The plan did not specify a dedupe.
13. **Subjects are accepted as sent**, whatever their current status (ruling, Task 4). The plan said nothing about a subject that changed status after the send.
14. **Views** omit every principal id and all version metadata. Git versions expose only the commit, and commit subjects come from the renderer's own git log.
15. **The platform only builds `HandoffService`** when `opts.handoffs` (default true) AND the v8 shape check passes, so a forced `true` on a v7 shape builds none.
16. **The restore-tool hint** names a switch only for v6 (`NEXUS_DB_HOLD_V7`) and v7 (`NEXUS_DB_HOLD_V8`) backups. Any other version, or an unreadable header, gets a plain sentence, because no `NEXUS_DB_HOLD_V9` or older switch exists.
17. **Two more v7 test files** needed the mechanical C8 `holdV8: true` edit: `nexus-db-phase-a` and `nexus-platform-activity`.
18. **The renderer.** Artifacts and Handoffs lists page by a larger limit, because the channels have no cursor. Sorting by name is done in the renderer. The Passport's handoff list reads at most 20 handoffs and their details. "Hand off…" appears only on active versions, though the send sheet offers candidate versions too, and only when another active participation of the project can receive it.
