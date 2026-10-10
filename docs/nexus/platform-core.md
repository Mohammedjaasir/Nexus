# Nexus platform core (schema v7, v8 and v9)

This is the reference for the Nexus platform core. It has three parts.

**Part I (sections 1 to 19)** covers the B0b platform core: schema v7, the authorization chain, the activity log, the job, version and agent-session state tables, and the lineage vocabulary. It also has the v7 migration procedure and the operator runbook for backup, hold and restore.

**[Part II](#part-ii-schema-v8-and-b1) (sections 20 to 29)** covers B1:
- schema v8 (handoffs) and its migration runbook;
- handoffs, user saves and "mark ready";
- the `nexus:*` IPC surface;
- the workspace authority flip and the screens built on it.

**[Part III](#part-iii-schema-v9-and-b2a) (sections 30 to 48)** covers B2a, the execution core:
- schema v9 (execution records, blobs, validations, approvals, deployments), opt-in until verification, and its runbook;
- the scheduler, the runner process, the sandbox, networks and approvals, and restart recovery;
- evidence-based completion and the validators;
- the 20 execution channels, the domain registry, the resource gate, the pending wiring and the known limitations.

Part I is kept as the B0b reference. Where B1 or B2a changed a statement in it, the section says so and links to Part II or Part III.

**Why one document.** The B1 and B2a material is part of this file, not a separate `platform-b1.md` or `platform-b2a.md`, for three reasons:
- the B1 and B2a briefs name this file;
- v8 and v9 are built on v7's tables, rules and runbook, so the restore, hold and downgrade steps read best side by side;
- `test/nexus-core-identity-scan.test.cjs` scans this file, so the later text is covered by the same guard without widening that test.

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

B2a (Part III) builds the execution core: jobs, attempts, a sandboxed runner and evidence. It is **not yet switched on**. v9 is opt-in, and the app does not start the runner until the pending wiring lands ([section 45](#45-pending-wiring)). So on a real database, the two statements above still hold.

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

[Part III: Schema v9 and B2a](#part-iii-schema-v9-and-b2a)

30. [Status: what B2a is, and is not](#30-status-what-b2a-is-and-is-not)
31. [Where the B2a code lives](#31-where-the-b2a-code-lives)
32. [Schema v9: tables, triggers, indexes and seeds](#32-schema-v9-tables-triggers-indexes-and-seeds)
33. [The v9 migration and its runbook](#33-the-v9-migration-and-its-runbook)
34. [The execution model](#34-the-execution-model)
35. [Restart recovery](#35-restart-recovery)
36. [The sandbox](#36-the-sandbox)
37. [Networks and approvals](#37-networks-and-approvals)
38. [Evidence-based completion](#38-evidence-based-completion)
39. [Recipes: what each SDE step runs](#39-recipes-what-each-sde-step-runs)
40. [The IPC surface](#40-the-ipc-surface)
41. [The domain registry](#41-the-domain-registry)
42. [The resource gate and the test:exec gate](#42-the-resource-gate-and-the-testexec-gate)
43. [Python](#43-python)
44. [Observability map](#44-observability-map)
45. [Pending wiring](#45-pending-wiring)
46. [Known limitations](#46-known-limitations)
47. [B2a: differences from the plan and rulings](#47-b2a-differences-from-the-plan-and-rulings)
48. [Deferred after B2a](#48-deferred-after-b2a)

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

**Since v9: 36 relations (ruling R2).** v9 adds four rows with `INSERT OR IGNORE`. No existing row changes ([section 32.5](#325-seeds)).

| Relation | Meaning | `planned_phase` |
|---|---|---|
| `covers` | A test suite or test case that covers a requirement | B2c |
| `transformed_by` | A dataset produced by a preprocessing pipeline or a cleaning query | B3 |
| `configured_by` | A training run configured by an architecture or configuration version | B6 |
| `monitors` | A monitoring report that monitors an inference service version | B5 |

The four new rows use the B2a phase numbering. The 32 rows above keep the older labels, and ruling R3 maps old to new ([section 32.5](#325-seeds)): B2 → B2c, B3a → B3, B3b → B4, B4 → B5, B5 → B6, and B6 (deploy) → local scope only. `implements` keeps `unassigned`, but its meaning is now documented: a change set that implements a requirement, first written in B2b.

B2a's ingest writes `derived_from`, `built_from` and `assembled_from`, with the sources `job_input` and `ingest` ([section 32.5](#325-seeds)). `LineageService.record` still refuses `ingest` edges from any principal but the system.

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

**Added in B2a** (schema v9 and the execution core; see [Part III](#part-iii-schema-v9-and-b2a)):

25. **v9 is opt-in, and the app does not start execution.**
    - `V9_ENABLED_BY_DEFAULT` is false. Until the pending `index.ts` edits land, nothing in the app enables v9, starts the runner, or registers channels #22 to #41.
    - Real databases stay at v8, and the B1 behaviour is unchanged.
    - The edits wait for the peer session's commit and the user's approval ([section 45](#45-pending-wiring)).
26. **Egress: what the allow-list enforces, and what it cannot** (B2a stabilization; before it, an approved install had ordinary outbound access and reached the host's `127.0.0.1`).
    - An approved dependency install has **no route out**: it runs on the job's `--internal` network `nexus-egress-in-<jobId>`, whose only other member is the Nexus egress proxy ([section 37](#37-networks-and-approvals)). Only the proxy joins the outbound bridge `nexus-egress-out-<jobId>`.
    - The proxy allows only HTTPS `CONNECT` to the recipe's allow-list (`registry.npmjs.org:443`; `pypi.org:443` and `files.pythonhosted.org:443`), checks that the TLS ClientHello names the same host, resolves the name itself and refuses if any address is private, loopback, link-local, CGNAT, metadata or otherwise not globally routable, then connects to the address it checked.
    - **Not enforced inside the TLS tunnel.** The proxy does not decrypt TLS. A client could send an HTTP `Host` header for another site behind the same CDN as an allowed registry (domain fronting); whether the CDN serves it is the CDN's policy, not Nexus's. The tunnel's TLS name must match, and packages must still match the lockfile hashes.
    - **Proven without the internet.** The real-Docker tests (K8, K12) use a test-only pinned entry to a local test server. The path to the real registries is not exercised by any automated test.
    - **The internal network's gateway answers.** On Docker Desktop, a container on an `--internal` network gets connection refusals (not timeouts) from the gateway address of that network, which is the Docker VM. No listener was found on the probed ports. This is the same for the dev deployment's internal network.
    - Install scripts are disabled (`npm ci --ignore-scripts`, `pip --only-binary=:all:`), and every package must match a lockfile hash (`npm ci` integrity, `pip --require-hashes`).
    - **Image preparation is still not limited to particular hosts.** `docker build` runs through the daemon's own network; its approval summary says so. A Python install needs the sde-node image too, because the proxy runs in it.
27. **The discovery ceiling is about 1,300 files.**
    - A discovered test list is kept whole in the suite version's metadata, which is limited to 64 KiB. The list must be whole, because a test run judges coverage against it.
    - With typical path lengths, that holds about 1,300 files, well below `MAX_DISCOVERED_FILES` (5,000).
    - A larger list is refused `invalid_output` / `discovery_too_large`, and is not retried.
28. **`#41` runs blob GC only.**
    - `nexus:blobs:gc` lists and removes unreferenced blobs that are more than 24 h old.
    - Nothing yet reclaims the work folders (`work/<job>/<n>`), attempt logs, image build logs or `nexus-deps-*` volumes. They accumulate in the data home and in Docker.
29. **A job waiting for git.**
    - The first lease after git disappears still ends in one runner refusal (`git_missing`) and one `abandoned` attempt row; the job then waits (`waiting:git`).
    - Since the final fix round (final batch item 3), the scheduler holds `waiting:git` jobs without leasing them until main itself finds a git binary again (`resolveGitBinary`, a file-system check only, at most once every 5 s, and at once after a `git_missing` refusal). Before, each backoff step leased the job again and left one more abandoned row, about 60 an hour per waiting job.
30. **Docker resources from a deleted data home need manual cleanup.**
    - Recovery removes only resources whose `nexus.home` is this install's, and whose `nexus.attempt` names an ended attempt of this database ([section 35.5](#355-orphan-scoping)).
    - Containers, volumes and networks left by a data home that was later deleted (for example a scratch `--user-data-dir`) are never removed automatically. Recovery reports the ones whose attempt id this database does not know, and leaves them in place.
    - **To find them:** `docker ps -a --filter label=nexus.attempt`, `docker volume ls --filter label=nexus.attempt` and `docker network ls --filter label=nexus.attempt`. Compare their `nexus.home` label with the labels of the data homes you still use, and remove only the others.
31. **The socat pin is unverified.**
    - `infra/images/nexus-fwd/Dockerfile` installs `socat=1.8.0.0-r0`. Resolving Alpine package versions needs APKINDEX, which was outside the approved metadata scope.
    - Since the final fix round (final review B7), the version alone is not trusted: the build takes `SOCAT_APK_SHA256`, refuses an empty or malformed value before fetching anything, fetches that version with `apk fetch`, checks it with `sha256sum -c`, and installs only that file. `lock.json` records `profiles.nexus-fwd.packages.socat = { version, apkSha256 }`, with `apkSha256: null` today.
    - **Until the hash is set at verification, the `nexus-fwd` build refuses.** Set it with `node tools/nexus-lock-images.cjs --pin-apk socat=<sha256>` (no network; it writes both fields and rehashes). `--check` fails when they disagree, and warns while the hash is null.
    - If the version pin is wrong, the build fails loudly. The fix is to edit the version, then run `--pin-apk` with the new file's hash and `--check`.
32. **The real-Docker suites have not run.**
    - The disk is far below the 30 GiB gate: `test:exec` last reported 3.5 GiB free at the Docker data volume, and exited 3. No image has been built.
    - So none of the following is proven against Docker yet: K1 to K11 (sandbox), L1 to L16 (lifecycle and recovery), X1 to X12 (recipes), the Nexus entry inside the images, `npm ci` against the generated lockfile, pip with hashes, the forwarder, and `host.docker.internal` reaching a loopback listener.
    - The same flows pass through the fake sandbox driver.
33. **Windows has no `O_NOFOLLOW`.**
    - The runner opens `/out` files and stored objects with `O_RDONLY|O_NOFOLLOW`, which is a no-op on Windows.
    - There, the guard is an lstat (a regular file with one link), followed by an identity re-check on the open handle: device, inode, size and link count.
    - How Windows sees a symlink made inside a container in a bind-mounted `/out` is a Verification item.
34. **textconv and external diff drivers are not neutralised in the legacy diffs** of `src/main/git.ts` (they need repository config; git ships no system default like `filter.lfs`). This is the behaviour from before B2a; only `status` and `archive` neutralise filter drivers.
    **Legacy `src/main/hive.ts` still runs git by name.** It calls `spawnSync('git', …, { cwd: root })`, so a planted `git` in that folder could run. This predates B2a and is out of its scope. All B2a and B1 git calls go through the resolved absolute binary (`src/main/gitBinary.ts`).
    **Neither is reachable from B2a** (stabilization review; guarded by GC4 in `test/nexus-platform-exec-git-config.test.cjs`). B2a code imports from `src/main/git.ts` only `resolveCommit`, and `index.ts` injects `repositoryCheck`; neither produces a diff. No B2a module imports `hive.ts`, whose `root` is `<harness home>/hive`, never a project folder. The legacy `git:*` channels can still be pointed at a project folder by the user; with git 2.55 their current argv shapes ran no textconv or external diff driver, but `git:log` and `git:graph` run `git log`, which honours a repository's `log.showSignature` and `gpg.program`.
    **Fixed on the B2a path in the same review** (each proven live by a control in GC1 to GC3): the runner's `git archive` names every signature program as the resolved git binary, because an `export-subst` `%G?` placeholder would run the repository's `gpg.program`; the snapshot's `git status` runs with `--ignore-submodules=all`, because a submodule's own config can name a filter driver; `resolveCommit` runs `git show --no-show-signature`.
35. **A checkout is one commit, archived.**
    - `git archive` leaves out submodules and `export-ignore` paths.
    - **LFS files stage as their pointers** (final review B1): no filter driver runs, so a file tracked by Git LFS reaches the container as its small pointer text, never its content. A repository whose tests need LFS content cannot run them in B2a.
    - Uncommitted changes are never included. The UI note says "Tests run on commit <short>; uncommitted changes are not included."
36. **Test attribution.**
    - node's JUnit reporter names no file, so node:test suites run one file at a time, and the runner attributes the cases.
    - For other frameworks, a multi-file suite whose report names no file, judged against a file-level discovered list, reads `error` / `unattributed_report`. That is never a pass.
    - pytest's discovery is id-level, so it is judged by id.
37. **Dev deployment limits.**
    - A preview binds only to `127.0.0.1`.
    - It lives for a fixed 2 hours.
    - At most 2 run at once.
    - It can have no environment variables or secrets: a manifest that names env variables is refused.
    - It is never requeued.
    - Its job completes (`stopped`) only when the runner reports the exit after a passed health check.
38. **The data home is fixed** at `<userData>/nexus`. Moving it is deferred. Its contents are not part of the database backup.
39. **No GPU.** The probe reports a detected GPU, but `usableInContainers` is always false. GPU use is FUTURE.
40. **No disk quota.** The storage driver cannot cap a container's disk. The runner's 5-second size guard kills a container whose `/out` exceeds the recipe's cap or whose `/workspace` exceeds 8 GiB. A container can therefore overshoot by up to one poll interval of writing before it is killed. The `/tmp` and `/home/nexus` tmpfs mounts are hard caps.
41. **Logs.**
    - An attempt log is capped at 50 MiB. Past the cap, the middle is dropped and replaced by one marker.
    - Lines are redacted before they are framed. A token run of more than 4,096 characters with no separator, straddling a forced flush of an unterminated line, can still be split. No known credential shape is that long.
42. **The entry's timeout and host sleep.**
    - Main leaves sleep-like gaps out of the wall clock, up to 1 × the wall clock.
    - The Nexus entry's own `timeout` (`NEXUS_WALL_SECONDS`, twice the recipe's wall clock since the final fix round, counted from the container start) does not know about those gaps. Whether it fires after a host sleep depends on the Docker VM's clock, and this is untested.
    - If it fires, the attempt fails. It never completes.
43. **v9 changes two earlier statements.**
    - **The v9 triggers stay in the file.** A file migrated to v9 and later opened without `enableV9` keeps its three `jobs` backstop triggers. B0b-style completion of a `tool.run` job without an attempt is refused there.
    - **Cancel now cascades for execution jobs.** `nexus:job:cancel` (`ExecutionService.cancel`) cascades to children first. The B0b `JobService.requestCancel` in item 4 is unchanged.
44. **Older builds on a v9 file.**
    - The B1 build (`d7abc87b`) keeps its delete guard ([section 33.9](#339-downgrade-the-d7abc87b-build-on-a-v9-database)).
    - The B0b build (`e2fceec`) opens a v9 file as newer than v7, with its delete guard off, exactly as item 13 describes for v8.
45. **Image builds.**
    - A build fails `timeout` after 10 minutes without progress, or after 180 minutes in all.
    - Any runner-wide fault (a fault naming no attempt, the runner leaving `ready`, or a replaced runner) interrupts every running build. The user can request it again.
46. **What an install proves.** A dependency install completes only when its single output `lock.sha256` equals both the repository version's lockfile hash and the hash in the approval it consumed (`sde.deps.lock_matches`, advisory, Task 13 review fixes). That proves which lockfile was installed. It does not prove where the packages came from (item 26).
    - **A real install needs two Nexus-owned lockfile steps** (final batch item 1, ruled): the snapshot records the lockfile's hash at the commit, and the install writes the hash of the lockfile it installed from. Without the first, an install is refused at lease (`lockfile_missing`); without the second, it has no `lock.sha256` and fails `invalid_output`. See [section 39](#39-recipes-what-each-sde-step-runs).
    - **Snapshots taken before this change carry no lockfile hash.** A new snapshot of the same commit deduplicates to the old version, so an install of such a repository needs a new commit first; until then it is refused `lockfile_missing`.
    - Only `package-lock.json` and then `requirements.txt` are recorded (the first present at the commit), and a lockfile over 64 MiB is not hashed (`LOCKFILE_MAX_BYTES`): such a repository's installs are refused `lockfile_missing`.
47. **The data home after a restore.** The data home is not part of the database backup, so a restore to v8 leaves its blobs, logs and work folders in place. The v8 schema does not read them. After a later re-migration, the first blob store hygiene pass sweeps unindexed objects older than 24 h. Work folders and logs stay (item 28).

Further operational notes:
- **Backups accumulate.** Every migration attempt that reaches the backup step writes a new file. Since B1 that includes the `harness-v7-<UTC>.db` backups of the v8 step, and since B2a the `harness-v8-<UTC>.db` backups of the v9 step. Nothing prunes `userData/backups`.
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

**Delivered in B2a** (moved off the lists above). The schema is v9 ([Part III](#part-iii-schema-v9-and-b2a)), opt-in until verification:
- `job_attempts`, leases and heartbeats, the scheduler (`ix_jobs_sched`), Docker execution through a runner `utilityProcess`, the cancel cascade to children (`ix_jobs_parent`), and R.2 restart recovery, adapted. Its orphan rule is superseded ([section 35](#35-restart-recovery)). The scheduler and lease rows now drive `leased` and `retry_scheduled`.
- The blob store: `blobs`, `version_blobs`, GC, and `tree` storage for ingested versions.
- `validations`, the validator registry and the finalize rule for engine-made drafts. The user's Revalidate covers a `cancelled_partial` draft.
- `approvals` for egress and image preparation. These are once-only user consent, not capability tokens.
- `deployments`, limited to local dev previews on `127.0.0.1`.
- The DomainSpec registry (v3) with six first-class domains and a startup check.
- Repository artifacts: `ux_repository_per_project` and `repo.snapshot`.
- Four lineage relations (`covers`, `transformed_by`, `configured_by`, `monitors`) and the documented meaning of `implements`.
- `ix_versions_hash`, `ix_versions_job`, `ux_versions_job_path` and `ix_jobs_retry_due`.

**Deferred after B2a** (the next phases; the full list is in [section 48](#48-deferred-after-b2a)):

| Item | Phase |
|---|---|
| AgentRuntime and the Claude CLI adapter, agent principals and capability tokens, encrypted secrets, spending caps, the MCP server; how job outcomes drive agent sessions | B2b |
| Change sets: implement, review, accept and iterate; `implements` edges; the repository write approval | B2b |
| QA workflows and `covers` edges; handoff states and routes beyond B1 | B2c |
| `data-scientist` workspace rows (M4); DA, DS, ML and DL workflows beyond the problem statements | B3 to B6 |
| GC of work folders, logs and dependency caches; moving the data home; GPU use; an egress allow-list for image preparation | Later |
| The execution UI (Runs from jobs, evidence, actions, approvals, deployments, setup) | B2a Tasks 14 and 15 (done: [section 40.1](#401-the-renderer)) |
| The B0b and B1 items not listed under "Delivered" above: `reviews`, `reviewRequired` gating, multi-user grants, the activity anchor, scheduled backups, the linear redactor rewrite | As listed above |

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

**B2a test files.**

Three runners apply. `test:db` runs every `nexus-db-*` and `nexus-platform-*` file under Electron-as-node. The `test/nexus-exec-*` files run only under `test:exec`, behind the resource preflight ([section 42](#42-the-resource-gate-and-the-testexec-gate)). The plain-node files run under `node --test test/` today. Until the pending `package.json` edit, they are not part of `npm run test:focused` ([section 45](#45-pending-wiring)).

| File | Runner | Covers |
|---|---|---|
| `test/nexus-db-v9-schema.test.cjs` | `test:db` | The v9 module: names and counts, every trigger and CHECK, the shape check, verification and rollback |
| `test/nexus-db-v9-migration.test.cjs` | `test:db` | The v9 step: M0 (off by default), M1 to M17, the hold cascade, the marker and auto-hold, the post-check, the reason precedence, and the backstops B1 and B2 |
| `test/nexus-db-phase-a.test.cjs` | `test:db` | Adds the `d7abc87b` downgrade on a v9 database |
| `test/nexus-platform-blobs.test.cjs` | `test:db` | `BlobIndex` and the data home: the ingest and GC lock, confinement, the GC dry run and apply |
| `test/nexus-platform-exec-scheduler.test.cjs` | `test:db` | Leases, caps, heartbeats, stalls and sleep, cancel, timeout, retry and backoff, availability, and the event-loop budget (C1 to C24, N1 to N3, R1 to R4, Palt, C20b) |
| `test/nexus-platform-exec-validation.test.cjs` | `test:db` | Ingest, validators, finalize, revalidate, dedupe, evidence shape, and O10 to O17 (N1 to N12, E1 to E14, R1 to R15, S1 to S5) |
| `test/nexus-platform-exec-approvals.test.cjs` | `test:db` | Approvals A1 to A10, image builds, dev deployments D1 to D10, snapshots R1 to R4, and the bypass and secret sweeps |
| `test/nexus-platform-exec-recovery.test.cjs` | `test:db` | Restart recovery RC1 to RC20, D1 to D11, F1 to F8 and G1 to G7: the six restart states of constraint 10, durable exits, orphan scoping and the reconcile bound |
| `test/nexus-platform-exec-wiring.test.cjs` | `test:db` | `startExecution` and the runner host: restarts, reconcile routing, the blob pass, the hint, quit (H1 to H3, W1 to W8) |
| `test/nexus-platform-exec-recipes.test.cjs` | `test:db` | X1 to X12 and the F-* flows through the fake sandbox driver, with real main, runner, git, hashing and parsers |
| `test/nexus-platform-ipc-exec.test.cjs` | `test:db` | Channels #22 to #41 and `nexus:hint` through the wrapper: hostile arguments, envelopes and the push rate |
| `test/nexus-platform-exec-security.test.cjs` | `test:db` | The constraint 11 sweep (S1 to S9): unauthorized execution and file access, traversal, references, secrets, approval and network bypass, malformed requests |
| `test/nexus-platform-b2a-flows.test.cjs` | `test:db` | End-to-end flows (F1 onward) and F-OBS. After each one: O1 to O22 = 0, an empty `foreign_key_check`, `integrity_check` ok, and the activity chain verified |
| `test/nexus-exec-sandbox.test.cjs`, `nexus-exec-lifecycle.test.cjs`, `nexus-exec-recovery.test.cjs`, `nexus-exec-recipes.test.cjs` | `test:exec` (gated) | Real Docker: K1 to K11, L1 to L12, L13 to L16 and X1 to X12. **Not run yet** (disk below the gate). |
| `test/nexus-core-exec-contracts.test.cjs` | plain node | The shared contracts, the resource gate, the preflight comparator and the runner protocol parser |
| `test/nexus-core-vendor-neutral.test.cjs` | plain node | No vendor-specific concept in the shared contracts |
| `test/nexus-core-domain-registry.test.cjs`, `test/nexus-domain-registry-clean.test.cjs` | plain node | DR0 to DR12 and the e2e title check; persona-free domain data |
| `test/nexus-core-runner.test.cjs`, `test/nexus-core-junit.test.cjs` | plain node | The runner with a fake driver (D1 to D24, CD*, FR*, RV*) and the JUnit and discovery parsers (J1 to J14) |
| `test/nexus-runner-posture.test.cjs` | plain node | The runner's posture: spawn sites, no database, no Python, git only by its resolved path |
| `test/nexus-core-git-binary.test.cjs` | plain node | git resolution and the planted-binary cases (GB1 to GB7) |
| `test/nexus-core-exec-preflight-runner.test.cjs` | plain node | The `test:exec` preflight and gate (P1 to P9) |
| `test/nexus-core-image-lock.test.cjs`, `test/nexus-core-exec-diagnose.test.cjs`, `test/nexus-core-exec-entry.test.cjs` | plain node | The image lock (IL1 to IL5); diagnose (DG1 to DG6); the Nexus entry on Git's POSIX sh (E1 to E9) |
| `test/nexus-core-docs-v9-names.test.cjs` | plain node | This document: the v9 name list in [section 32.6](#326-the-v9-name-list) equals `V9_EXPECTED`, the DDL block equals `V9_DDL`, and the trigger and index tables name only v9 objects |

B2a also extended five existing tests, and weakened none:
- `nexus-platform-composition` (41 channels, the push, the process boundaries);
- `nexus-caller-paths` (no path-like key in any request schema);
- `nexus-core-append-only-writes` (`V9_DDL`);
- `nexus-core-identity-scan` (the runner, the execution wiring and their fixtures);
- `nexus-core-policy` (the new actions).

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
- Activity `details` are reduced to scalar, allow-listed keys. Strings are scrubbed and capped at 64 characters. B2a (final review) adds `reason`, `decision`, `status`, `job` and `requested`, which the execution rows' sentences read: an approval's reason and answer, an image build's status, a recovery decision and a failed recovery's status, a dev deployment stop's effect on its job, and the count of leftover sandbox resources handed to the runner. Without them, Approve once and Deny read the same, and every recovery read alike.

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
| Runs | Unchanged in B1: session-only, in the UI store. Nothing executes, so persisted runs would be fake (ruling C11). **B2a changed this:** the Runs tool shows persisted jobs above the session requests ([section 40.1](#401-the-renderer)). |

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

---

# Part III: Schema v9 and B2a

B2a is the execution core. It adds seven things:
- **Schema v9.** It is additive and opt-in, and it runs with the v7 and v8 safety procedure.
- **The execution core in main.** Jobs are leased to attempts by a scheduler, with leases and heartbeats, cancel, timeout, retry and restart recovery.
- **A runner `utilityProcess`.** It drives Docker and git, and opens no database.
- **Evidence and validators.** A version leaves draft only on validated evidence.
- **Approvals** for network egress and image preparation.
- **Local dev deployments** behind a loopback forwarder, and a **content-addressed blob store**.
- **The domain registry** (DomainSpec v3), plus **20 new `nexus:*` channels** and one push channel.

Parts I and II still describe v7, v8, B0b and B1. Where B2a changed a statement there, that section says so and points here. As in the earlier parts, the code is the source of truth, and the task reports and the controller's rulings record why it differs from the B2a plan. [Section 47](#47-b2a-differences-from-the-plan-and-rulings) lists those differences.

## 30. Status: what B2a is, and is not

**What runs for real, by domain.**

| Domain | Steps that run for real (REAL) | Everything else |
|---|---|---|
| SDE | Requirement, Project, Repository, Code, Tests, Build, Application, Dev deployment, Logs and diagnostics. These run against a real repository. | AI-assisted implementation, Review and Iteration are FUTURE (B2b). |
| Data Analyst | Business question only: an inline problem statement | FUTURE (B3) |
| ML Engineer | Problem only: an inline problem statement | FUTURE (B5) |
| DL Engineer | Problem only: an inline problem statement | FUTURE (B6) |
| QA/Test Engineer | None | FUTURE (B2c) |
| Data Scientist | None. No project can take part in `data-scientist` until B4 adds its workspace row, so even its problem step is FUTURE. | FUTURE (B4) |

The DA, ML and DL steps are real in a narrow sense:
- a user writes a problem statement;
- it is stored as an inline `problem_statement` version;
- `problem.schema` validates it.

Nothing else in those three domains runs. **None of the six domains is complete.** No step is shown as done without validated evidence ([section 38](#38-evidence-based-completion)).

**How far the REAL SDE steps are proven.**
- Requirement, Project, Code and the problem statements need no container. They are proven end to end now.
- Repository snapshots run git through the runner. They are proven with real git.
- Tests, Build, Application, Dev deployment and Diagnostics need Docker. They are proven through the fake sandbox driver, which uses real main, the real runner, real git, real hashing and real parsers, with recorded container outputs.
- The real-Docker suites have not run, and no image has been built ([section 42](#42-the-resource-gate-and-the-testexec-gate)).

**Wiring status.**
- **v9 is opt-in.** `V9_ENABLED_BY_DEFAULT = false` in `src/main/db.ts`. It stays false until the user's verification go-ahead. Making it the default is a separate one-line commit ([section 33.1](#331-opt-in)).
- **The app does not start the runner yet.** `src/main/index.ts` does not pass `execution` to `createNexusPlatform`, does not call `startExecution`, and does not register the 20 execution channels. The edits are written but wait for the peer session and the user ([section 45](#45-pending-wiring)).
- **On a real database today:** the schema stays at v8, nothing executes, and the B1 screens work as before.
- **The renderer calls the new channels** (Tasks 14 and 15, [section 40.1](#401-the-renderer)): Runs from persisted jobs, Folio evidence and kind viewers, the action bar, approvals, dev deployments, the execution setup sheet, and every domain's lifecycle rail. Until the pending `index.ts` edit lands, every execution channel rejects. The UI then reads "Running jobs is not available because it did not answer, so it is not connected in this build of the app.", the B1 screens work as before, and the rails use the registry bundled with the build.

**What B2a is not.**
- No agent runs. The AgentRuntime, the Claude CLI adapter, capability tokens, encrypted secrets and spending caps are B2b.
- There is no GPU use.
- There is no change-set accept or review.
- There is no QA, DA, DS, ML or DL workflow beyond the problem statements.
- Deployments are local previews on `127.0.0.1` only.

---

## 31. Where the B2a code lives

| Path | Role |
|---|---|
| `src/main/nexus/db/schemaV9.ts` | `V9_DDL` (frozen migration text), `V9_EXPECTED`, `v9ShapeProblem`, `verifyV9` and `applyV9`. |
| `src/main/nexus/db/v9Seed.ts` | The frozen v9 seeds: attempt, approval and deployment states and transitions, and the four lineage relations. |
| `src/main/db.ts` | `migrateV9` (a sibling of the v8 step), `V9_ENABLED_BY_DEFAULT`, the `enableV9` and `holdV9` options, `V9_FAILURE_LIMIT`, `executionAvailable`, `lastMigrationV9` and `executionUnavailableReason`. `PLATFORM_RECORD_TABLES` adds `deployments` and `approvals`. |
| `src/main/nexus/exec/executionService.ts` | The core: start, lease, tick, runner messages, cancel, retry, timeout and the ingest hand-off. |
| `src/main/nexus/exec/scheduler.ts` | The caps and lease guards (pure). |
| `src/main/nexus/exec/attempts.ts`, `attemptRules.ts`, `events.ts` | Attempt rows, the lease and heartbeat, and `job_events`. |
| `src/main/nexus/exec/planBuilder.ts` | Builds every container, service and engine plan: argv templates, the env allow-list, mounts and labels. |
| `src/main/nexus/exec/ingest.ts` | `IngestService` and `INGEST_RULES`. |
| `src/main/nexus/exec/recovery.ts` | Phases A and B, orphan decisions, the reconcile bound, blob store hygiene and `RUNNER_RECOVERY_CONTRACT`. |
| `src/main/nexus/exec/execQueries.ts`, `diagnosticReport.ts`, `runnerPort.ts` | The reads behind channels #24, #28, #32 and #34; the diagnostic report; the runner port interface. |
| `src/main/nexus/validation/*` | `validationService.ts` (record, finalize, revalidate), `checkRunner.ts` (validate jobs), `normalized.ts` (re-checks the runner's parser output), `evidenceShape.ts` and `validators/*`. |
| `src/main/nexus/approvals/*` | `ApprovalService`: egress and image approvals, and image builds. |
| `src/main/nexus/deployments/*` | `DeploymentService`: dev deployments. |
| `src/main/nexus/repo/repoService.ts` | Snapshot requests and the app manifest reader. |
| `src/main/nexus/blobs/blobIndex.ts` | `BlobIndex`: blob rows, the ingest and GC lock, and the GC dry run and apply. |
| `src/main/nexus/registryImpl.ts` | The registry check at startup. |
| `src/main/nexus/platform.ts` | Composes all of the above, with `isV9File`, `bootId` and recovery at startup. |
| `src/main/nexusExec/runnerHost.ts` | Forks the runner (`utilityProcess`) and supervises it. |
| `src/main/nexusExec/execWiring.ts` | `startExecution`: hello, reconcile, tick, hint and quit. Also the log and preview readers, and `execIpcPort`. |
| `src/main/nexusExec/dataHome.ts`, `profiles.ts` | The data home layout and confinement; the sandbox profiles loaded from `infra/images/lock.json`. |
| `src/main/gitBinary.ts`, `src/main/git.ts` | git resolved to an absolute path; `repositoryCheck` and `resolveCommit`. |
| `src/runner/*` | The runner, built to `out/main/runner.js`: `core.ts`, `sandbox/dockerCli.ts`, `sandbox/dockerDriver.ts`, `sandbox/sizeGuard.ts`, `staging.ts`, `outputs.ts`, `objectStore.ts`, `logs.ts`, `junitMerge.ts`, `parsers/*`, `git.ts`, `probe.ts`, `service.ts`, `imageBuilder.ts`, `reconcile.ts` and `diagnose.ts`. |
| `src/shared/nexus/*` | The pure contracts: `execution.ts`, `runnerProtocol.ts`, `preflightCheck.ts`, `resourceGate.ts`, `recipes.ts`, `validators.ts`, `evidence.ts`, `actions.ts`, `domainSpec.ts`, `domains/*`, `registryCheck.ts`, `homeLabel.ts`, `stepState.ts`, `secretShape.ts`, `repoSnapshot.ts`, `kinds.ts`, `capabilities.ts` and `runtime.ts`. |
| `src/main/nexusIpc/*` | Channels #22 to #41, and `nexus:hint`. |
| `src/preload/index.ts` | 20 more methods, plus `onNexusHint`. |
| `src/renderer/src/nexus/data/useExecution.ts`, `data/executionModel.ts`, `data/nexusClient.ts`, `data/errorCopy.ts` | The execution reads (one shared health read, hint-driven list reloads, `useDomains`), availability and the setup sheet's rows (pure), the 20 client calls (a rejected or missing channel answers "execution unreachable", never a throw), and `execFailText`. |
| `src/renderer/src/nexus/runs/jobRunModel.ts`, `runs/JobLogSheet.tsx`, `runs/ProjectRuns.tsx` | A job as a headline, a status word and a six-stage strip (pure); the paged, redacted run log; the project's Runs tool (persisted jobs above the session requests). |
| `src/renderer/src/nexus/project/evidenceModel.ts`, `EvidenceSection.tsx`, `kindViewers.tsx` | Check results with their sourced facts, log ranges, and the per-kind viewers (test results, build manifest, application manifest, diagnostic report, requirement, problem statement, repository). |
| `src/renderer/src/nexus/project/actionModel.ts`, `ActionBar.tsx`, `ApprovalsSection.tsx`, `DeploymentsSection.tsx`, `RequirementSheet.tsx`, `execContext.ts` | What a person may start, answer or stop (pure, registry-checked); approvals (Approve once, Deny); dev deployments (loopback URL, Stop, Diagnose); the requirement and problem-statement writing sheet; the context that lends the bench's sheets. |
| `src/renderer/src/nexus/components/ExecutionSetupSheet.tsx`, `components/ExecutionNotice.tsx` | The execution setup sheet (Docker, memory, CPUs, disk, images, runner, git, GPU, each with a word and an action) and the one-line notice on the bench. |
| `src/renderer/src/nexus/workspaces/lifecycleModel.ts`, `workspaces/LifecycleRail.tsx` | Each domain's lifecycle as a rail in its own words, with states from records only (`stepStateFrom`); shown on the workspace page and, compact, on each Spine group. |
| `src/renderer/src/nexus/project/spineModel.ts`, `Spine.tsx`, `ProjectBench.tsx`, `PassportPanel.tsx`, `ArtifactPassport.tsx`, `styles/execution.css` | The Spine's checks words and rail records, the bench that mounts the notice, approvals and sheets, and the Passport that hosts the viewers, evidence, actions and deployments. |
| `infra/images/*` | The three image contexts (`sde-node`, `sde-python`, `nexus-fwd`), `common/nexus-entry` and `lock.json`. |
| `tools/run-exec-tests.cjs`, `tools/nexus-lock-images.cjs`, `tools/nexus-prepare-images.cjs` | The `test:exec` gate and runner; the image pin tool; the image builder for Verification. |
| `test/nexus-ui-exec-models.test.cjs`, `test/nexus-lifecycle-rail.test.cjs`, `test/nexus-honesty-audit.test.cjs` | The renderer's models and source pins (plain node); the rails against the registry and main's own projection; the honesty audit (no FUTURE step offered, no unmet machine prerequisite, no number without a source, nothing called complete). |

The process boundaries are pinned by tests:
- `src/main/nexus` never imports Electron, and `utilityProcess` appears only in `runnerHost.ts` (`test/nexus-platform-composition.test.cjs`).
- The runner opens no database and spawns only the resolved `docker` and `git` binaries (`test/nexus-runner-posture.test.cjs`).

---

## 32. Schema v9: tables, triggers, indexes and seeds

v9 is additive:
- every statement is `CREATE … IF NOT EXISTS` or `INSERT OR IGNORE`;
- no v1 to v8 table is altered, and no FK is added to one;
- no v1 to v8 row is rewritten;
- `V7_DDL` and `V8_DDL` are unchanged.

The only rows v9 adds to an older table are four new `lineage_relations` rows.

`V9_EXPECTED` holds:
- **15 tables**, with their columns in DDL order;
- **23 named indexes**: 16 on v9 tables, and 7 on v7 tables;
- **33 triggers**: 30 on v9 tables, and 3 backstops on the v7 `jobs` table.

`test/nexus-db-v9-schema.test.cjs` pins these names and counts against a real database. `test/nexus-core-docs-v9-names.test.cjs` pins this section against `V9_EXPECTED` and `V9_DDL`.

The plan had 14 tables. `version_attempts` was added by the Task 4 ruling, so that every ingested version names the attempt that produced it.

**One edit before release.** `V9_DDL` was edited once before v9 had ever run on a real database. In B2a Task 9, the `deployments.stop_reason` CHECK gained `refused`, `preflight_failed`, `runner_lost` and `exit_not_reported`, so that a row stores its true end cause. `V9_ENABLED_BY_DEFAULT` was false at the time, and no database outside the tests held v9. From now on the text is frozen like `V7_DDL` and `V8_DDL`: a later change needs a new migration.

### 32.1 Tables

| Group | Table | What it holds |
|---|---|---|
| Attempts | `attempt_states`, `attempt_transitions` | The attempt vocabulary: 7 states and 10 transitions. |
| | `job_attempts` | One row per try of a job: `n` (unique per job), `state`, `boot_id` (the boot that created it) and `lease_owner` (the boot that owns it now), `lease_expires_at`, `heartbeat_at`, `container_id`, the exit (`exit_code`, `signal`, `oom_killed`), `outcome`, the redacted `error_json`, `sandbox_json` (what actually ran), `environment_json` (image, digests, versions), `runtime_kind`/`runtime_ref`, `log_path` (relative to the data home) with `log_bytes`, `out_bytes`, `usage_json` and the timestamps. |
| Events | `job_events` | Append-only, redacted execution facts: `seq` AUTOINCREMENT, the time, the project, job, attempt, image build, approval and deployment references, a `type`, a `summary` (at most 200 characters) and `data_json` (at most 4 KiB). Heartbeats are not events. |
| Blobs | `blobs` | Content-addressed bytes by `sha256`: size, media type, `created_at`, `last_referenced_at` and `verified_at`. The bytes live in the data home, not in SQLite. |
| | `version_blobs` | The bytes a version holds: `(version_id, sha256, role, path)`. `role` is `content`, `manifest`, `file`, `discovery`, `junit`, `report` or `log`. The path is relative and confined by CHECK. |
| | `version_attempts` | The attempt that produced each ingested version: `version_id` → `(job_id, attempt_n)`. |
| Evidence | `validations` | Append-only validator results: version, validator id and version, `stage`, `status` (`passed`, `failed`, `error` or `skipped`), `blocking` / `advisory`, `summary`, `evidence_json` (a typed array, at most 64 KiB), the job and attempt that produced it, `created_by`, and the start and finish times. |
| Approvals | `approval_states`, `approval_transitions` | 5 states and 4 transitions. |
| | `approvals` | Once-only user consent: a `reason`, a `summary`, the exact `request_json` and its `request_sha256`, who asked (`requested_by`, `on_behalf_of`), `expires_at`, the decision (`decided_by`, `decided_at`, `decision` `once` or `deny`) and the consumption (`consumed_at`, `consumed_by_job_id`, `consumed_by_attempt_n`). |
| Images | `image_builds` | One approved image preparation per row: profile, the approval it consumed, status, `context_sha256`, `base_digest`, `image_id`, size, log path, error and requester. Image builds are not project-scoped, so they are not jobs. |
| Deployments | `deployment_states`, `deployment_transitions` | 5 states and 9 transitions. |
| | `deployments` | A local dev deployment of an application version. It records the project, participation, subject version and job (one deployment per job), `environment` (`local-preview` only), `bind_address` (`127.0.0.1` only, by CHECK), `host_port`, `status`, the last 50 probes in `health_json`, `stop_reason`, `stopped_by`, `created_by` and the timestamps. |

The approval `reason` vocabulary has six values. B2a writes only `egress.deps` and `image.prepare`. `egress.weights`, `repo.write_refs`, `training.long` and `blobs.gc` are vocabulary for later phases.

**ON DELETE behaviour.**
- `job_attempts.job_id`, both `version_blobs` references, `validations.version_id`, `approvals.project_id`, and the project, participation and subject references of `deployments` are RESTRICT.
- Every v9 record table has a no-delete trigger, except `blobs`: a blob may be removed by GC, but `tr_blobs_delete` refuses the delete of a blob that a version holds. The six lookup tables have no triggers, like the v7 and v8 vocabularies.
- `hasPlatformRecords` now also counts `deployments` and `approvals`. So a project with any of them cannot be deleted, as in [section 12](#12-workspaces-participation-and-phase-a).

### 32.2 The DDL

This is `V9_DDL`, as it runs, copied from `src/main/nexus/db/schemaV9.ts`. In the TypeScript source, the backslash of the three `NOT LIKE '%\%'` patterns is written `\\`, so that the template literal keeps it. The test named above compares this block with `V9_DDL` byte for byte.

```sql
-- ===== attempt vocabulary =====
CREATE TABLE IF NOT EXISTS attempt_states (
  state       TEXT PRIMARY KEY CHECK (state GLOB '[a-z]*' AND length(state) BETWEEN 2 AND 32),
  terminal    INTEGER NOT NULL CHECK (terminal IN (0,1)),
  description TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS attempt_transitions (
  from_state TEXT NOT NULL REFERENCES attempt_states(state),
  to_state   TEXT NOT NULL REFERENCES attempt_states(state),
  PRIMARY KEY (from_state, to_state),
  CHECK (from_state <> to_state)
);

-- ===== job attempts: what actually executed, one row per try =====
CREATE TABLE IF NOT EXISTS job_attempts (
  id               TEXT PRIMARY KEY,
  job_id           TEXT NOT NULL REFERENCES jobs(id) ON DELETE RESTRICT,
  n                INTEGER NOT NULL CHECK (n >= 1),
  state            TEXT NOT NULL REFERENCES attempt_states(state),
  boot_id          TEXT NOT NULL CHECK (length(boot_id) = 26),          -- the boot that created it (immutable)
  lease_owner      TEXT NOT NULL CHECK (length(lease_owner) = 26),      -- the boot that owns it now (adoption moves it)
  lease_expires_at INTEGER NOT NULL,
  heartbeat_at     INTEGER,
  container_id     TEXT CHECK (container_id IS NULL OR (length(container_id) = 64 AND container_id NOT GLOB '*[^0-9a-f]*')),
  exit_code        INTEGER,
  signal           TEXT CHECK (signal IS NULL OR length(signal) BETWEEN 1 AND 32),
  oom_killed       INTEGER CHECK (oom_killed IS NULL OR oom_killed IN (0,1)),
  outcome          TEXT CHECK (outcome IS NULL OR (outcome GLOB '[a-z]*' AND length(outcome) <= 32)),
  error_json       TEXT CHECK (error_json IS NULL OR json_valid(error_json)),          -- redacted {code,message}
  sandbox_json     TEXT CHECK (sandbox_json IS NULL OR (json_valid(sandbox_json) AND length(sandbox_json) <= 32768)),
  environment_json TEXT CHECK (environment_json IS NULL OR (json_valid(environment_json) AND length(environment_json) <= 8192)),
  runtime_kind     TEXT CHECK (runtime_kind IS NULL OR length(runtime_kind) BETWEEN 1 AND 32),
  runtime_ref      TEXT CHECK (runtime_ref IS NULL OR length(runtime_ref) BETWEEN 1 AND 128),
  log_path         TEXT CHECK (log_path IS NULL OR (length(log_path) <= 200 AND log_path NOT LIKE '/%'
                     AND log_path NOT LIKE '%:%' AND log_path NOT LIKE '%..%' AND log_path NOT LIKE '%\%')),
  log_bytes        INTEGER NOT NULL DEFAULT 0 CHECK (log_bytes >= 0),
  out_bytes        INTEGER NOT NULL DEFAULT 0 CHECK (out_bytes >= 0),
  usage_json       TEXT CHECK (usage_json IS NULL OR json_valid(usage_json)),
  created_at       INTEGER NOT NULL,
  started_at       INTEGER,
  finished_at      INTEGER,
  updated_at       INTEGER NOT NULL,
  UNIQUE (job_id, n),
  CHECK ((state IN ('starting','running')) = (finished_at IS NULL)),
  CHECK (state <> 'running' OR started_at IS NOT NULL),
  CHECK (state <> 'succeeded' OR (exit_code IS NOT NULL AND outcome IS NOT NULL)),
  CHECK (state NOT IN ('running','succeeded') OR (sandbox_json IS NOT NULL AND environment_json IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_attempts_live      ON job_attempts(job_id) WHERE state IN ('starting','running');
CREATE INDEX        IF NOT EXISTS ix_attempts_lease     ON job_attempts(state, lease_expires_at) WHERE state IN ('starting','running');
CREATE INDEX        IF NOT EXISTS ix_attempts_container ON job_attempts(container_id) WHERE container_id IS NOT NULL;
CREATE TRIGGER IF NOT EXISTS tr_attempts_insert BEFORE INSERT ON job_attempts
BEGIN
  SELECT RAISE(ABORT, 'an attempt starts as starting, unfinished and without a container')
    WHERE NEW.state <> 'starting' OR NEW.finished_at IS NOT NULL OR NEW.container_id IS NOT NULL OR NEW.exit_code IS NOT NULL;
  SELECT RAISE(ABORT, 'an attempt is inserted with the lease of its job and carries the job attempt count')
    WHERE NOT EXISTS (SELECT 1 FROM jobs j WHERE j.id = NEW.job_id AND j.state = 'leased' AND j.attempts = NEW.n);
  SELECT RAISE(ABORT, 'a new attempt is owned by the boot that created it')
    WHERE NEW.lease_owner <> NEW.boot_id;
END;
CREATE TRIGGER IF NOT EXISTS tr_attempts_transition BEFORE UPDATE OF state ON job_attempts
WHEN NEW.state IS NOT OLD.state
BEGIN
  SELECT RAISE(ABORT, 'illegal attempt transition')
    WHERE NOT EXISTS (SELECT 1 FROM attempt_transitions t WHERE t.from_state = OLD.state AND t.to_state = NEW.state);
END;
CREATE TRIGGER IF NOT EXISTS tr_attempts_identity BEFORE UPDATE ON job_attempts
WHEN NEW.id IS NOT OLD.id OR NEW.job_id IS NOT OLD.job_id OR NEW.n IS NOT OLD.n
  OR NEW.boot_id IS NOT OLD.boot_id OR NEW.created_at IS NOT OLD.created_at
  OR (OLD.container_id IS NOT NULL AND NEW.container_id IS NOT OLD.container_id)
  OR (OLD.log_path IS NOT NULL AND NEW.log_path IS NOT OLD.log_path)
BEGIN SELECT RAISE(ABORT, 'attempt identity, container and log path are immutable once set'); END;
CREATE TRIGGER IF NOT EXISTS tr_attempts_terminal_frozen BEFORE UPDATE ON job_attempts
WHEN OLD.state IN ('succeeded','failed','cancelled','timed_out','abandoned')
BEGIN SELECT RAISE(ABORT, 'a finished attempt is immutable'); END;
CREATE TRIGGER IF NOT EXISTS tr_attempts_no_delete BEFORE DELETE ON job_attempts
BEGIN SELECT RAISE(ABORT, 'attempts are never deleted'); END;

-- ===== image builds: approved image preparations (not project-scoped, so not jobs) =====
CREATE TABLE IF NOT EXISTS image_builds (
  id             TEXT PRIMARY KEY,
  profile_id     TEXT NOT NULL CHECK (profile_id GLOB '[a-z]*' AND length(profile_id) BETWEEN 3 AND 32),
  approval_id    TEXT NOT NULL UNIQUE REFERENCES approvals(id),
  status         TEXT NOT NULL CHECK (status IN ('running','succeeded','failed','cancelled','interrupted')),
  context_sha256 TEXT NOT NULL CHECK (length(context_sha256) = 64 AND context_sha256 NOT GLOB '*[^0-9a-f]*'),
  base_digest    TEXT NOT NULL CHECK (base_digest GLOB 'sha256:*' AND length(base_digest) = 71),
  image_id       TEXT CHECK (image_id IS NULL OR (image_id GLOB 'sha256:*' AND length(image_id) = 71)),
  size_bytes     INTEGER CHECK (size_bytes IS NULL OR size_bytes >= 0),
  log_path       TEXT CHECK (log_path IS NULL OR (length(log_path) <= 200 AND log_path NOT LIKE '/%' AND log_path NOT LIKE '%..%' AND log_path NOT LIKE '%:%'
                   AND log_path NOT LIKE '%\%')),
  error_json     TEXT CHECK (error_json IS NULL OR json_valid(error_json)),
  requested_by   TEXT NOT NULL REFERENCES principals(id),
  started_at     INTEGER NOT NULL,
  finished_at    INTEGER,
  CHECK ((status = 'running') = (finished_at IS NULL)),
  CHECK (status <> 'succeeded' OR (image_id IS NOT NULL AND size_bytes IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS ix_image_builds_profile ON image_builds(profile_id, started_at DESC);
CREATE TRIGGER IF NOT EXISTS tr_image_builds_insert BEFORE INSERT ON image_builds
BEGIN
  SELECT RAISE(ABORT, 'an image build starts running') WHERE NEW.status <> 'running' OR NEW.image_id IS NOT NULL;
  SELECT RAISE(ABORT, 'an image build needs an approved, consumed image.prepare approval for this profile and context')
    WHERE NOT EXISTS (SELECT 1 FROM approvals a WHERE a.id = NEW.approval_id AND a.reason = 'image.prepare'
      AND a.status = 'approved' AND a.consumed_at IS NOT NULL
      AND json_extract(a.request_json, '$.profileId') = NEW.profile_id
      AND json_extract(a.request_json, '$.contextSha256') = NEW.context_sha256);
  SELECT RAISE(ABORT, 'an image build is requested by the principal its approval was requested for')
    WHERE NEW.requested_by IS NOT (SELECT a.on_behalf_of FROM approvals a WHERE a.id = NEW.approval_id);
END;
CREATE TRIGGER IF NOT EXISTS tr_image_builds_update BEFORE UPDATE ON image_builds
BEGIN
  SELECT RAISE(ABORT, 'a finished image build is immutable') WHERE OLD.status <> 'running';
  SELECT RAISE(ABORT, 'image build identity is immutable')
    WHERE NEW.id IS NOT OLD.id OR NEW.profile_id IS NOT OLD.profile_id OR NEW.approval_id IS NOT OLD.approval_id
       OR NEW.context_sha256 IS NOT OLD.context_sha256 OR NEW.base_digest IS NOT OLD.base_digest
       OR NEW.requested_by IS NOT OLD.requested_by OR NEW.started_at IS NOT OLD.started_at;
END;
CREATE TRIGGER IF NOT EXISTS tr_image_builds_no_delete BEFORE DELETE ON image_builds
BEGIN SELECT RAISE(ABORT, 'image builds are never deleted'); END;

-- ===== job events: append-only, redacted execution facts (heartbeats are not events) =====
CREATE TABLE IF NOT EXISTS job_events (
  seq            INTEGER PRIMARY KEY AUTOINCREMENT,
  ts             INTEGER NOT NULL,
  project_id     TEXT REFERENCES projects(id),
  job_id         TEXT REFERENCES jobs(id),
  attempt_n      INTEGER CHECK (attempt_n IS NULL OR attempt_n >= 1),
  image_build_id TEXT REFERENCES image_builds(id),
  approval_id    TEXT REFERENCES approvals(id),
  deployment_id  TEXT REFERENCES deployments(id),
  type           TEXT NOT NULL CHECK (type IN ('job.transition','attempt.transition','attempt.provisioned','attempt.progress',
                   'attempt.output','attempt.heartbeat_gap','approval','deployment','validation','image_build','recovery','preflight')),
  summary        TEXT NOT NULL CHECK (length(summary) BETWEEN 1 AND 200),
  data_json      TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(data_json) AND length(data_json) <= 4096),
  CHECK (job_id IS NOT NULL OR image_build_id IS NOT NULL OR approval_id IS NOT NULL),
  CHECK (attempt_n IS NULL OR job_id IS NOT NULL),
  FOREIGN KEY (job_id, attempt_n) REFERENCES job_attempts(job_id, n)
);
CREATE INDEX IF NOT EXISTS ix_job_events_job     ON job_events(job_id, seq) WHERE job_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_job_events_project ON job_events(project_id, seq) WHERE project_id IS NOT NULL;
CREATE TRIGGER IF NOT EXISTS tr_job_events_insert BEFORE INSERT ON job_events
BEGIN
  SELECT RAISE(ABORT, 'a job event names the project of its job')
    WHERE NEW.job_id IS NOT NULL AND (SELECT project_id FROM jobs WHERE id = NEW.job_id) IS NOT NEW.project_id;
  SELECT RAISE(ABORT, 'a job event names the project of its approval')
    WHERE NEW.approval_id IS NOT NULL AND (SELECT project_id FROM approvals WHERE id = NEW.approval_id) IS NOT NEW.project_id;
  SELECT RAISE(ABORT, 'a job event names the project of its deployment')
    WHERE NEW.deployment_id IS NOT NULL AND (SELECT project_id FROM deployments WHERE id = NEW.deployment_id) IS NOT NEW.project_id;
  SELECT RAISE(ABORT, 'an event without a job, approval or deployment names no project')
    WHERE NEW.project_id IS NOT NULL AND NEW.job_id IS NULL AND NEW.approval_id IS NULL AND NEW.deployment_id IS NULL;
END;
CREATE TRIGGER IF NOT EXISTS tr_job_events_no_update BEFORE UPDATE ON job_events
BEGIN SELECT RAISE(ABORT, 'job events are append-only'); END;
CREATE TRIGGER IF NOT EXISTS tr_job_events_no_delete BEFORE DELETE ON job_events
BEGIN SELECT RAISE(ABORT, 'job events are append-only'); END;

-- ===== content-addressed blobs and the versions that hold them =====
CREATE TABLE IF NOT EXISTS blobs (
  sha256             TEXT PRIMARY KEY CHECK (length(sha256) = 64 AND sha256 NOT GLOB '*[^0-9a-f]*'),
  bytes              INTEGER NOT NULL CHECK (bytes >= 0),
  media_type         TEXT NOT NULL CHECK (length(media_type) BETWEEN 3 AND 100),
  created_at         INTEGER NOT NULL,
  last_referenced_at INTEGER NOT NULL,
  verified_at        INTEGER
);
CREATE TRIGGER IF NOT EXISTS tr_blobs_identity BEFORE UPDATE ON blobs
WHEN NEW.sha256 IS NOT OLD.sha256 OR NEW.bytes IS NOT OLD.bytes OR NEW.media_type IS NOT OLD.media_type OR NEW.created_at IS NOT OLD.created_at
BEGIN SELECT RAISE(ABORT, 'blob identity is immutable'); END;
CREATE TRIGGER IF NOT EXISTS tr_blobs_delete BEFORE DELETE ON blobs
WHEN EXISTS (SELECT 1 FROM version_blobs vb WHERE vb.sha256 = OLD.sha256)
BEGIN SELECT RAISE(ABORT, 'a blob held by a version is never deleted'); END;
CREATE TABLE IF NOT EXISTS version_blobs (
  version_id TEXT NOT NULL REFERENCES artifact_versions(id) ON DELETE RESTRICT,
  sha256     TEXT NOT NULL REFERENCES blobs(sha256) ON DELETE RESTRICT,
  role       TEXT NOT NULL CHECK (role IN ('content','manifest','file','discovery','junit','report','log')),
  path       TEXT NOT NULL DEFAULT '' CHECK (length(path) <= 1024 AND path NOT LIKE '/%' AND path NOT LIKE '%\%'
               AND path <> '..' AND path NOT LIKE '../%' AND path NOT LIKE '%/../%' AND path NOT LIKE '%/..'
               AND instr(path, char(0)) = 0),
  PRIMARY KEY (version_id, sha256, role, path)
);
CREATE INDEX IF NOT EXISTS ix_version_blobs_sha ON version_blobs(sha256);
CREATE TRIGGER IF NOT EXISTS tr_version_blobs_insert BEFORE INSERT ON version_blobs
BEGIN
  SELECT RAISE(ABORT, 'bytes are attached to a version only while it is a draft')
    WHERE (SELECT status FROM artifact_versions WHERE id = NEW.version_id) IS NOT 'draft';
END;
CREATE TRIGGER IF NOT EXISTS tr_version_blobs_no_update BEFORE UPDATE ON version_blobs
BEGIN SELECT RAISE(ABORT, 'version blobs are immutable'); END;
CREATE TRIGGER IF NOT EXISTS tr_version_blobs_no_delete BEFORE DELETE ON version_blobs
BEGIN SELECT RAISE(ABORT, 'version blobs are immutable'); END;

-- ===== version attempts: the attempt that produced each ingested version (written by ingest) =====
CREATE TABLE IF NOT EXISTS version_attempts (
  version_id TEXT PRIMARY KEY REFERENCES artifact_versions(id),
  job_id     TEXT NOT NULL,
  attempt_n  INTEGER NOT NULL,
  FOREIGN KEY (job_id, attempt_n) REFERENCES job_attempts(job_id, n)
);
CREATE TRIGGER IF NOT EXISTS tr_version_attempts_insert BEFORE INSERT ON version_attempts
BEGIN
  SELECT RAISE(ABORT, 'a version is bound to an attempt of the job that produced it')
    WHERE (SELECT produced_by_job_id FROM artifact_versions WHERE id = NEW.version_id) IS NOT NEW.job_id;
END;
CREATE TRIGGER IF NOT EXISTS tr_version_attempts_no_update BEFORE UPDATE ON version_attempts
BEGIN SELECT RAISE(ABORT, 'version attempts are append-only'); END;
CREATE TRIGGER IF NOT EXISTS tr_version_attempts_no_delete BEFORE DELETE ON version_attempts
BEGIN SELECT RAISE(ABORT, 'version attempts are append-only'); END;

-- ===== validations: append-only validator results with their evidence =====
CREATE TABLE IF NOT EXISTS validations (
  id                TEXT PRIMARY KEY,
  version_id        TEXT NOT NULL REFERENCES artifact_versions(id) ON DELETE RESTRICT,
  validator_id      TEXT NOT NULL CHECK (validator_id GLOB '[a-z]*' AND length(validator_id) BETWEEN 3 AND 64),
  validator_version TEXT NOT NULL CHECK (length(validator_version) BETWEEN 1 AND 16),
  stage             TEXT NOT NULL CHECK (stage IN ('register','candidate','promote')),
  status            TEXT NOT NULL CHECK (status IN ('passed','failed','error','skipped')),
  blocking          INTEGER NOT NULL CHECK (blocking IN (0,1)),
  advisory          INTEGER NOT NULL CHECK (advisory IN (0,1)),
  summary           TEXT NOT NULL CHECK (length(summary) BETWEEN 1 AND 500),
  evidence_json     TEXT NOT NULL CHECK (json_valid(evidence_json) AND json_type(evidence_json) = 'array' AND length(evidence_json) <= 65536),
  job_id            TEXT REFERENCES jobs(id),
  attempt_n         INTEGER CHECK (attempt_n IS NULL OR attempt_n >= 1),
  created_by        TEXT NOT NULL REFERENCES principals(id),
  started_at        INTEGER NOT NULL,
  finished_at       INTEGER NOT NULL,
  CHECK (finished_at >= started_at),
  CHECK (NOT (blocking = 1 AND advisory = 1)),
  CHECK (attempt_n IS NULL OR job_id IS NOT NULL),
  FOREIGN KEY (job_id, attempt_n) REFERENCES job_attempts(job_id, n)
);
CREATE INDEX IF NOT EXISTS ix_validations_version ON validations(version_id, validator_id, finished_at);
CREATE INDEX IF NOT EXISTS ix_validations_job     ON validations(job_id) WHERE job_id IS NOT NULL;
CREATE TRIGGER IF NOT EXISTS tr_validations_insert BEFORE INSERT ON validations
BEGIN
  SELECT RAISE(ABORT, 'a validation job belongs to the project of the version')
    WHERE NEW.job_id IS NOT NULL AND (SELECT project_id FROM jobs WHERE id = NEW.job_id)
       IS NOT (SELECT project_id FROM artifact_versions WHERE id = NEW.version_id);
  SELECT RAISE(ABORT, 'a passed or failed blocking result is recorded only by the system')
    WHERE NEW.blocking = 1 AND NEW.status IN ('passed','failed')
      AND (SELECT kind FROM principals WHERE id = NEW.created_by) IS NOT 'system';
END;
CREATE TRIGGER IF NOT EXISTS tr_validations_no_update BEFORE UPDATE ON validations
BEGIN SELECT RAISE(ABORT, 'validations are append-only'); END;
CREATE TRIGGER IF NOT EXISTS tr_validations_no_delete BEFORE DELETE ON validations
BEGIN SELECT RAISE(ABORT, 'validations are append-only'); END;

-- ===== approvals: once-only user consent =====
CREATE TABLE IF NOT EXISTS approval_states (
  state       TEXT PRIMARY KEY CHECK (state GLOB '[a-z]*' AND length(state) BETWEEN 2 AND 32),
  terminal    INTEGER NOT NULL CHECK (terminal IN (0,1)),
  description TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS approval_transitions (
  from_state TEXT NOT NULL REFERENCES approval_states(state),
  to_state   TEXT NOT NULL REFERENCES approval_states(state),
  PRIMARY KEY (from_state, to_state),
  CHECK (from_state <> to_state)
);
CREATE TABLE IF NOT EXISTS approvals (
  id                TEXT PRIMARY KEY,
  project_id        TEXT REFERENCES projects(id) ON DELETE RESTRICT,
  job_id            TEXT REFERENCES jobs(id),
  session_id        TEXT REFERENCES agent_sessions(id),
  reason            TEXT NOT NULL CHECK (reason IN ('egress.deps','egress.weights','image.prepare','repo.write_refs','training.long','blobs.gc')),
  summary           TEXT NOT NULL CHECK (length(summary) BETWEEN 1 AND 500),
  request_json      TEXT NOT NULL CHECK (json_valid(request_json) AND length(request_json) <= 8192),
  request_sha256    TEXT NOT NULL CHECK (length(request_sha256) = 64 AND request_sha256 NOT GLOB '*[^0-9a-f]*'),
  status            TEXT NOT NULL REFERENCES approval_states(state),
  requested_by      TEXT NOT NULL REFERENCES principals(id),
  on_behalf_of      TEXT NOT NULL REFERENCES principals(id),
  requested_at      INTEGER NOT NULL,
  expires_at        INTEGER NOT NULL,
  decided_by        TEXT REFERENCES principals(id),
  decided_at        INTEGER,
  decision          TEXT CHECK (decision IS NULL OR decision IN ('once','deny')),
  consumed_at       INTEGER,
  consumed_by_job_id    TEXT,
  consumed_by_attempt_n INTEGER,
  status_changed_at INTEGER NOT NULL,
  CHECK (expires_at > requested_at),
  CHECK ((decided_by IS NULL) = (decided_at IS NULL)),
  CHECK ((decision IS NULL) = (decided_at IS NULL)),
  CHECK (consumed_at IS NULL OR status = 'approved'),
  CHECK (reason NOT IN ('egress.deps','egress.weights') OR (job_id IS NOT NULL AND project_id IS NOT NULL)),
  CHECK (reason <> 'image.prepare' OR (job_id IS NULL AND project_id IS NULL)),
  CHECK ((decided_at IS NOT NULL) = (status IN ('approved','denied'))),
  CHECK ((consumed_by_job_id IS NULL) = (consumed_by_attempt_n IS NULL)),
  CHECK (consumed_by_job_id IS NULL OR consumed_at IS NOT NULL),
  CHECK (consumed_at IS NULL OR consumed_by_job_id IS job_id),
  FOREIGN KEY (consumed_by_job_id, consumed_by_attempt_n) REFERENCES job_attempts(job_id, n)
);
CREATE INDEX IF NOT EXISTS ix_approvals_status ON approvals(status, expires_at);
CREATE INDEX IF NOT EXISTS ix_approvals_project ON approvals(project_id, requested_at DESC) WHERE project_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS ux_approvals_job_pending ON approvals(job_id) WHERE job_id IS NOT NULL AND status = 'pending';
CREATE TRIGGER IF NOT EXISTS tr_approvals_insert BEFORE INSERT ON approvals
BEGIN
  SELECT RAISE(ABORT, 'an approval starts pending, undecided and unconsumed')
    WHERE NEW.status <> 'pending' OR NEW.decided_at IS NOT NULL OR NEW.consumed_at IS NOT NULL;
  SELECT RAISE(ABORT, 'an approval job belongs to its project')
    WHERE NEW.job_id IS NOT NULL AND (SELECT project_id FROM jobs WHERE id = NEW.job_id) IS NOT NEW.project_id;
  SELECT RAISE(ABORT, 'an approval session belongs to its project')
    WHERE NEW.session_id IS NOT NULL AND (SELECT project_id FROM agent_sessions WHERE id = NEW.session_id) IS NOT NEW.project_id;
END;
CREATE TRIGGER IF NOT EXISTS tr_approvals_transition BEFORE UPDATE OF status ON approvals
WHEN NEW.status IS NOT OLD.status
BEGIN
  SELECT RAISE(ABORT, 'illegal approval transition')
    WHERE NOT EXISTS (SELECT 1 FROM approval_transitions t WHERE t.from_state = OLD.status AND t.to_state = NEW.status);
  SELECT RAISE(ABORT, 'only a user approves or denies, once, recording who and when')
    WHERE NEW.status IN ('approved','denied') AND (NEW.decided_by IS NULL
      OR (SELECT kind FROM principals WHERE id = NEW.decided_by) IS NOT 'user'
      OR NEW.decision IS NOT (CASE NEW.status WHEN 'approved' THEN 'once' ELSE 'deny' END));
  SELECT RAISE(ABORT, 'expiry and withdrawal are not decisions')
    WHERE NEW.status IN ('expired','withdrawn') AND (NEW.decided_by IS NOT NULL OR NEW.decision IS NOT NULL);
END;
CREATE TRIGGER IF NOT EXISTS tr_approvals_once BEFORE UPDATE ON approvals
WHEN NEW.id IS NOT OLD.id OR NEW.project_id IS NOT OLD.project_id OR NEW.job_id IS NOT OLD.job_id
  OR NEW.session_id IS NOT OLD.session_id OR NEW.reason IS NOT OLD.reason OR NEW.summary IS NOT OLD.summary
  OR NEW.request_json IS NOT OLD.request_json OR NEW.request_sha256 IS NOT OLD.request_sha256
  OR NEW.requested_by IS NOT OLD.requested_by OR NEW.on_behalf_of IS NOT OLD.on_behalf_of
  OR NEW.requested_at IS NOT OLD.requested_at OR NEW.expires_at IS NOT OLD.expires_at
  OR (OLD.decided_at IS NOT NULL AND (NEW.decided_by IS NOT OLD.decided_by OR NEW.decided_at IS NOT OLD.decided_at OR NEW.decision IS NOT OLD.decision))
  OR (OLD.consumed_at IS NOT NULL AND (NEW.consumed_at IS NOT OLD.consumed_at
    OR NEW.consumed_by_job_id IS NOT OLD.consumed_by_job_id OR NEW.consumed_by_attempt_n IS NOT OLD.consumed_by_attempt_n))
  OR (OLD.status <> 'pending' AND NEW.status IS NOT OLD.status)
BEGIN SELECT RAISE(ABORT, 'an approval request is immutable; its decision and its consumption are recorded once'); END;
CREATE TRIGGER IF NOT EXISTS tr_approvals_no_delete BEFORE DELETE ON approvals
BEGIN SELECT RAISE(ABORT, 'approvals are never deleted'); END;

-- ===== deployments: local dev deployments of an application version =====
CREATE TABLE IF NOT EXISTS deployment_states (
  state       TEXT PRIMARY KEY CHECK (state GLOB '[a-z]*' AND length(state) BETWEEN 2 AND 32),
  terminal    INTEGER NOT NULL CHECK (terminal IN (0,1)),
  description TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS deployment_transitions (
  from_state TEXT NOT NULL REFERENCES deployment_states(state),
  to_state   TEXT NOT NULL REFERENCES deployment_states(state),
  PRIMARY KEY (from_state, to_state),
  CHECK (from_state <> to_state)
);
CREATE TABLE IF NOT EXISTS deployments (
  id                 TEXT PRIMARY KEY,
  project_id         TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  participation_id   TEXT NOT NULL REFERENCES project_workspaces(id) ON DELETE RESTRICT,
  subject_version_id TEXT NOT NULL REFERENCES artifact_versions(id) ON DELETE RESTRICT,
  job_id             TEXT NOT NULL UNIQUE REFERENCES jobs(id),
  environment        TEXT NOT NULL CHECK (environment = 'local-preview'),
  bind_address       TEXT NOT NULL DEFAULT '127.0.0.1' CHECK (bind_address = '127.0.0.1'),
  host_port          INTEGER CHECK (host_port IS NULL OR host_port BETWEEN 1024 AND 65535),
  status             TEXT NOT NULL REFERENCES deployment_states(state),
  health_json        TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(health_json) AND json_type(health_json) = 'array' AND length(health_json) <= 16384),
  stop_reason        TEXT CHECK (stop_reason IS NULL OR stop_reason IN ('user','idle','cancel','app_quit','recovery','exited','probe_failed','start_timeout',
                       'refused','preflight_failed','runner_lost','exit_not_reported')),
  stopped_by         TEXT REFERENCES principals(id),
  created_by         TEXT NOT NULL REFERENCES principals(id),
  started_at         INTEGER NOT NULL,
  stopped_at         INTEGER,
  status_changed_at  INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL,
  CHECK ((status IN ('stopped','failed')) = (stopped_at IS NOT NULL)),
  CHECK ((status IN ('stopped','failed')) = (stop_reason IS NOT NULL)),
  CHECK ((status = 'stopped') = (stopped_by IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS ix_deployments_project ON deployments(project_id, started_at DESC);
CREATE INDEX IF NOT EXISTS ix_deployments_live    ON deployments(status) WHERE status IN ('starting','healthy','unhealthy');
CREATE INDEX IF NOT EXISTS ix_deployments_subject ON deployments(subject_version_id);
CREATE UNIQUE INDEX IF NOT EXISTS ux_deployments_port_live ON deployments(host_port)
  WHERE host_port IS NOT NULL AND status IN ('starting','healthy','unhealthy');
CREATE TRIGGER IF NOT EXISTS tr_deployments_insert BEFORE INSERT ON deployments
BEGIN
  SELECT RAISE(ABORT, 'a deployment starts as starting') WHERE NEW.status <> 'starting' OR NEW.stopped_at IS NOT NULL;
  SELECT RAISE(ABORT, 'the deploying participation must be active and in this project')
    WHERE NOT EXISTS (SELECT 1 FROM project_workspaces p WHERE p.id = NEW.participation_id AND p.project_id = NEW.project_id AND p.status = 'active');
  SELECT RAISE(ABORT, 'a deployment subject is an application or inference service version of this project')
    WHERE NOT EXISTS (SELECT 1 FROM artifact_versions v JOIN artifacts a ON a.id = v.artifact_id
      WHERE v.id = NEW.subject_version_id AND v.project_id = NEW.project_id AND a.kind IN ('application','inference_service')
        AND v.status IN ('draft','candidate','active'));
  SELECT RAISE(ABORT, 'a deployment is run by a tool job of this project and participation')
    WHERE NOT EXISTS (SELECT 1 FROM jobs j WHERE j.id = NEW.job_id AND j.kind = 'tool.run'
      AND j.project_id = NEW.project_id AND j.participation_id = NEW.participation_id);
END;
CREATE TRIGGER IF NOT EXISTS tr_deployments_transition BEFORE UPDATE OF status ON deployments
WHEN NEW.status IS NOT OLD.status
BEGIN
  SELECT RAISE(ABORT, 'illegal deployment transition')
    WHERE NOT EXISTS (SELECT 1 FROM deployment_transitions t WHERE t.from_state = OLD.status AND t.to_state = NEW.status);
END;
CREATE TRIGGER IF NOT EXISTS tr_deployments_identity BEFORE UPDATE ON deployments
WHEN NEW.id IS NOT OLD.id OR NEW.project_id IS NOT OLD.project_id OR NEW.participation_id IS NOT OLD.participation_id
  OR NEW.subject_version_id IS NOT OLD.subject_version_id OR NEW.job_id IS NOT OLD.job_id OR NEW.environment IS NOT OLD.environment
  OR NEW.bind_address IS NOT OLD.bind_address OR NEW.created_by IS NOT OLD.created_by OR NEW.started_at IS NOT OLD.started_at
  OR (OLD.host_port IS NOT NULL AND NEW.host_port IS NOT OLD.host_port)
  OR OLD.status IN ('stopped','failed')
BEGIN SELECT RAISE(ABORT, 'deployment identity is immutable and a finished deployment is frozen'); END;
CREATE TRIGGER IF NOT EXISTS tr_deployments_no_delete BEFORE DELETE ON deployments
BEGIN SELECT RAISE(ABORT, 'deployments are never deleted'); END;

-- ===== execution backstops on the v7 jobs table (additive triggers; constraint 4) =====
CREATE TRIGGER IF NOT EXISTS tr_jobs_completed_needs_attempt BEFORE UPDATE OF state ON jobs
WHEN NEW.state IS NOT OLD.state AND NEW.state IN ('completed','partial') AND NEW.kind IN ('tool.run','validate')
BEGIN
  SELECT RAISE(ABORT, 'a tool or validate job completes only when its current attempt succeeded')
    WHERE NEW.state = 'completed' AND NOT EXISTS (SELECT 1 FROM job_attempts a
      WHERE a.job_id = NEW.id AND a.n = NEW.attempts AND a.state = 'succeeded');
  SELECT RAISE(ABORT, 'a tool or validate job ends partial only when its current attempt finished')
    WHERE NEW.state = 'partial' AND NOT EXISTS (SELECT 1 FROM job_attempts a
      WHERE a.job_id = NEW.id AND a.n = NEW.attempts AND a.state IN ('succeeded','failed'));
END;
CREATE TRIGGER IF NOT EXISTS tr_jobs_attempts_monotonic BEFORE UPDATE OF attempts ON jobs
WHEN NEW.attempts < OLD.attempts
BEGIN SELECT RAISE(ABORT, 'a job attempt count never decreases'); END;
CREATE TRIGGER IF NOT EXISTS tr_jobs_end_after_attempts BEFORE UPDATE OF state ON jobs
WHEN NEW.state IS NOT OLD.state AND NEW.state IN ('queued','retry_scheduled','completed','partial','failed','cancelled','timed_out','interrupted')
BEGIN
  SELECT RAISE(ABORT, 'a job ends or goes back to waiting only after its live attempt has ended')
    WHERE EXISTS (SELECT 1 FROM job_attempts a WHERE a.job_id = NEW.id AND a.state IN ('starting','running'));
END;

-- ===== indexes on v7 tables used by the execution core (additive) =====
CREATE INDEX IF NOT EXISTS ix_jobs_sched       ON jobs(state, priority, created_at);
CREATE INDEX IF NOT EXISTS ix_jobs_retry_due   ON jobs(next_attempt_at) WHERE state = 'retry_scheduled';
CREATE INDEX IF NOT EXISTS ix_jobs_parent      ON jobs(parent_job_id) WHERE parent_job_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS ux_versions_job_path ON artifact_versions(produced_by_job_id, output_path)
  WHERE output_path IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_versions_job     ON artifact_versions(produced_by_job_id) WHERE produced_by_job_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_versions_hash    ON artifact_versions(content_hash);
CREATE UNIQUE INDEX IF NOT EXISTS ux_repository_per_project ON artifacts(project_id) WHERE kind = 'repository';
```

### 32.3 Triggers

The services enforce the same rules in TypeScript and return typed `PlatformError`s. The triggers are the backstop.

| Trigger | Enforces |
|---|---|
| `tr_attempts_insert` | An attempt starts as `starting`, unfinished, with no container and no exit. It is inserted only while its job is `leased` and `jobs.attempts = n`, so the lease and the insert share one transaction. A new attempt is owned by the boot that created it. |
| `tr_attempts_transition` | A state change must be a row of `attempt_transitions`. |
| `tr_attempts_identity` | `id`, `job_id`, `n`, `boot_id` and `created_at` never change. `container_id` and `log_path` are set once. |
| `tr_attempts_terminal_frozen` | A finished attempt (`succeeded`, `failed`, `cancelled`, `timed_out` or `abandoned`) is immutable. |
| `tr_attempts_no_delete` | Attempts are never deleted. |
| `tr_image_builds_insert` | A build starts `running`, needs an `image.prepare` approval that is approved and consumed for this profile and context hash, and is requested by the principal the approval was for. |
| `tr_image_builds_update` | A finished build is immutable, and its identity never changes. |
| `tr_image_builds_no_delete` | Image builds are never deleted. |
| `tr_job_events_insert` | An event names the project of its job, approval and deployment. An event with none of them names no project. |
| `tr_job_events_no_update`, `tr_job_events_no_delete` | Events are append-only. |
| `tr_blobs_identity` | `sha256`, `bytes`, `media_type` and `created_at` never change. |
| `tr_blobs_delete` | A blob that a version holds is never deleted. |
| `tr_version_blobs_insert` | Bytes are attached to a version only while it is a draft. |
| `tr_version_blobs_no_update`, `tr_version_blobs_no_delete` | Version blobs are immutable. |
| `tr_version_attempts_insert` | A version is bound only to an attempt of the job that produced it. |
| `tr_version_attempts_no_update`, `tr_version_attempts_no_delete` | Append-only. |
| `tr_validations_insert` | A validation job belongs to the version's project. A `passed` or `failed` **blocking** result is recorded only by the system principal. |
| `tr_validations_no_update`, `tr_validations_no_delete` | Validations are append-only. |
| `tr_approvals_insert` | An approval starts pending, undecided and unconsumed. Its job and session belong to its project. |
| `tr_approvals_transition` | A status change must be a row of `approval_transitions`. Only a principal of kind `user` approves or denies, once, recording who and when, and `approved` records `once` and `denied` records `deny`. An expiry or a withdrawal is not a decision. |
| `tr_approvals_once` | The request is immutable. The decision is recorded once, and so is the consumption. A non-pending approval never changes status again. |
| `tr_approvals_no_delete` | Approvals are never deleted. |
| `tr_deployments_insert` | A deployment starts `starting`. Its participation is active and in this project. Its subject is a draft, candidate or active `application` or `inference_service` version of this project. Its job is a `tool.run` job of this project and participation. |
| `tr_deployments_transition` | A status change must be a row of `deployment_transitions`. |
| `tr_deployments_identity` | Identity, environment, bind address and requester never change. `host_port` is set once. A stopped or failed deployment is frozen. |
| `tr_deployments_no_delete` | Deployments are never deleted. |
| `tr_jobs_completed_needs_attempt` | On the v7 `jobs` table: a `tool.run` or `validate` job becomes `completed` only when its **current** attempt (`n = jobs.attempts`) `succeeded`, and becomes `partial` only when its current attempt finished (`succeeded` or `failed`). |
| `tr_jobs_attempts_monotonic` | On `jobs`: `attempts` never decreases. |
| `tr_jobs_end_after_attempts` | On `jobs`: a job never ends, and never goes back to `queued` or `retry_scheduled`, while it has a live (`starting` or `running`) attempt. |

The CHECKs on `job_attempts` add four more rules:
- an attempt is unfinished exactly while it is `starting` or `running`;
- `running` needs `started_at`;
- `succeeded` needs both `exit_code` and `outcome`;
- `running` and `succeeded` need both `sandbox_json` and `environment_json`.

**The three `jobs` triggers outlive "off".** They are part of the file. A v9 file opened later without `enableV9` keeps them. On such a file, B0b-style completion of a `tool.run` job without an attempt is refused, while the platform and handoffs work normally.

**The known trigger limit is still closed by a source rule.** `test/nexus-core-append-only-writes.test.cjs` derives its protected set from `V7_DDL`, `V8_DDL` and `V9_DDL` ([section 21.3](#213-triggers)).

### 32.4 Indexes and their access reasons

| Index | On | Access path it serves |
|---|---|---|
| `UNIQUE (job_id, n)` (auto) | `job_attempts` | A job's attempts in order; the attempt-number backstop; the FK target of `job_events`, `validations`, `version_attempts` and `approvals`. |
| `ux_attempts_live` (unique, partial) | `job_attempts(job_id)` live only | At most one live attempt per job; "the live attempt of job J" on every runner report and on cancel. |
| `ix_attempts_lease` (partial) | `job_attempts(state, lease_expires_at)` live only | Restart recovery (every live attempt) and the lease-expiry sweep. |
| `ix_attempts_container` (partial) | `job_attempts(container_id)` | Runner reports and recovery map a container id to its attempt. |
| `ix_image_builds_profile` | `image_builds(profile_id, started_at DESC)` | Health and the scheduler: the latest build per profile (expected image id, context hash). |
| `UNIQUE (approval_id)` (auto) | `image_builds` | One build per approval. |
| `ix_job_events_job` (partial) | `job_events(job_id, seq)` | A job's events in order (job detail). |
| `ix_job_events_project` (partial) | `job_events(project_id, seq)` | `nexus:events:since` with a project. Without a project it uses the `seq` primary key. |
| PK `sha256` | `blobs` | Blob upsert at ingest; existence checks. |
| PK `(version_id, sha256, role, path)` | `version_blobs` | A version's bytes: previews, the integrity re-hash. |
| `ix_version_blobs_sha` | `version_blobs(sha256)` | GC's "is this blob referenced", `tr_blobs_delete`, and the FK check from `blobs`. |
| PK `version_id` | `version_attempts` | The producing attempt of a version. |
| `ix_validations_version` | `validations(version_id, validator_id, finished_at)` | The latest result per (version, validator): `nexus:version:validations`, `finalizeIfReady`, the step state. |
| `ix_validations_job` (partial) | `validations(job_id)` | The results a job produced; the evidence backstop. |
| `ix_approvals_status` | `approvals(status, expires_at)` | The expiry sweep; the pending list. |
| `ix_approvals_project` (partial) | `approvals(project_id, requested_at DESC)` | A project's approvals, newest first. |
| `ux_approvals_job_pending` (unique, partial) | `approvals(job_id)` pending only | One pending approval per job; "the pending approval of job J". |
| `ix_deployments_project` | `deployments(project_id, started_at DESC)` | A project's deployments, newest first. |
| `ix_deployments_live` (partial) | `deployments(status)` live only | Recovery, the probe pass and the live-service cap. |
| `ix_deployments_subject` | `deployments(subject_version_id)` | The deployments of an application version. |
| `ux_deployments_port_live` (unique, partial) | `deployments(host_port)` live only | No two live deployments on one host port. |
| PK `(from_state, to_state)` (auto) | the three transition tables | The transition-trigger lookups. |
| `ix_jobs_sched` | `jobs(state, priority, created_at)` | The scheduler pick: queued jobs by priority, then age. |
| `ix_jobs_retry_due` (partial) | `jobs(next_attempt_at)` | Due retries (`retry_scheduled`). |
| `ix_jobs_parent` (partial) | `jobs(parent_job_id)` | The cancel cascade to children; a check job's parent. |
| `ux_versions_job_path` (unique, partial) | `artifact_versions(produced_by_job_id, output_path)` | Ingest idempotency by (job, output path). |
| `ix_versions_job` (partial) | `artifact_versions(produced_by_job_id)` | A job's outputs; marking a cancelled job's drafts `cancelled_partial`. |
| `ix_versions_hash` | `artifact_versions(content_hash)` | Dedupe by content hash at ingest. |
| `ux_repository_per_project` (unique, partial) | `artifacts(project_id) WHERE kind = 'repository'` | One `repository` artifact per project. This was deferred from B1 (ruling C5). |

The last seven are on v7 tables. They are additive, and the v7 shape check ignores extra objects.

Not built:
- an index on `job_events(type)`, because no query filters by type alone;
- an index on `blobs(last_referenced_at)`, because GC scans the table under its lock;
- an index on `job_events(image_build_id)`. A build's last progress is read from memory, and after a restart by a backwards scan of `job_events`.

### 32.5 Seeds

The seeds are in `src/main/nexus/db/v9Seed.ts`, written with `INSERT OR IGNORE`. `verifyV9` re-reads every row with all its columns, and checks that each v9 lookup table holds exactly its seed.

**Attempt states** (7):

| `state` | `terminal` | Meaning |
|---|---|---|
| `starting` | 0 | Leased; the sandbox is being provisioned, or the attempt is waiting for an approval |
| `running` | 0 | The sandbox passed preflight and the work is executing |
| `succeeded` | 1 | The work exited and its outputs were ingested |
| `failed` | 1 | The work or its sandbox failed |
| `cancelled` | 1 | Cancelled by the user, or with its parent |
| `timed_out` | 1 | The wall clock expired |
| `abandoned` | 1 | Lost before it could finish: a restart, a runner refusal or a vanished sandbox |

The 10 attempt transitions:
- `starting` → `running`, `succeeded`, `failed`, `cancelled` or `abandoned`;
- `running` → `succeeded`, `failed`, `cancelled`, `timed_out` or `abandoned`.

**Approval states** (5): `pending` (not terminal), then `approved`, `denied`, `expired` and `withdrawn` (all terminal). The 4 transitions all leave `pending`.

**Deployment states** (5): `starting`, `healthy` and `unhealthy` (live), then `stopped` and `failed` (terminal). The 9 transitions are:
- `starting` → `healthy`, `failed` or `stopped`;
- `healthy` ↔ `unhealthy`;
- `healthy` or `unhealthy` → `stopped` or `failed`.

**Four lineage relations (ruling R2).** These are added to the v7 vocabulary. No existing row changes.

| Relation | Meaning | `planned_phase` |
|---|---|---|
| `covers` | A test suite or test case that covers a requirement | B2c |
| `transformed_by` | A dataset produced by a preprocessing pipeline or a cleaning query | B3 |
| `configured_by` | A training run configured by an architecture or configuration version | B6 |
| `monitors` | A monitoring report that monitors an inference service version | B5 |

So the vocabulary is now 36 relations ([section 9](#9-lineage-and-the-32-relation-vocabulary)). B2a writes none of the four.

**The phase renumbering (ruling R3, documentation only).** The 32 v7 rows and Part I use the older phase numbering. The four v9 rows, the domain registry and this part use the new one. The v7 rows are frozen seed data and are not rewritten. `planned_phase` is documentation only, so nothing behaves differently.

| Old label (v7 rows, Part I) | Now |
|---|---|
| B2 (QA) | B2c |
| B3a (DA) | B3 |
| B3b (DS) | B4 |
| B4 (ML) | B5 |
| B5 (DL) | B6 |
| B6 (deploy) | Local scope only: dev deployments in B2a, local inference services in B5. Anything wider is FUTURE. |

**The meaning of `implements`** (D12). The v7 row keeps `planned_phase = 'unassigned'`, because rewriting a v7 row is forbidden. Its meaning is now documented: a change set that implements a requirement. Its first writer is B2b. Nothing in B2a writes it.

**What B2a writes.**
- `derived_from`: a repository snapshot from the previous snapshot; a test suite from the repository it was discovered in; a diagnostic report from the application it diagnosed; and every new output version from the previous version of its artifact.
- `built_from`: a build from its repository.
- `assembled_from`: an application from its build.

The sources are `job_input` for a job's granted inputs, and `ingest` for the previous version and the diagnosed application.

### 32.6 The v9 name list

This list is copied from `V9_EXPECTED`, in its order. `test/nexus-core-docs-v9-names.test.cjs` checks that it equals `V9_EXPECTED` exactly. It also checks that every `ix_`, `ux_` and `tr_` name in sections 32.3 and 32.4 is a v9 name.

```text
tables: attempt_states, attempt_transitions, job_attempts, image_builds, job_events, blobs, version_blobs, version_attempts, validations, approval_states, approval_transitions, approvals, deployment_states, deployment_transitions, deployments
indexes: ux_attempts_live, ix_attempts_lease, ix_attempts_container, ix_image_builds_profile, ix_job_events_job, ix_job_events_project, ix_version_blobs_sha, ix_validations_version, ix_validations_job, ix_approvals_status, ix_approvals_project, ux_approvals_job_pending, ix_deployments_project, ix_deployments_live, ix_deployments_subject, ux_deployments_port_live, ix_jobs_sched, ix_jobs_retry_due, ix_jobs_parent, ux_versions_job_path, ix_versions_job, ix_versions_hash, ux_repository_per_project
triggers: tr_attempts_insert, tr_attempts_transition, tr_attempts_identity, tr_attempts_terminal_frozen, tr_attempts_no_delete, tr_image_builds_insert, tr_image_builds_update, tr_image_builds_no_delete, tr_job_events_insert, tr_job_events_no_update, tr_job_events_no_delete, tr_blobs_identity, tr_blobs_delete, tr_version_blobs_insert, tr_version_blobs_no_update, tr_version_blobs_no_delete, tr_version_attempts_insert, tr_version_attempts_no_update, tr_version_attempts_no_delete, tr_validations_insert, tr_validations_no_update, tr_validations_no_delete, tr_approvals_insert, tr_approvals_transition, tr_approvals_once, tr_approvals_no_delete, tr_deployments_insert, tr_deployments_transition, tr_deployments_identity, tr_deployments_no_delete, tr_jobs_completed_needs_attempt, tr_jobs_attempts_monotonic, tr_jobs_end_after_attempts
```

---

## 33. The v9 migration and its runbook

### 33.1 Opt-in

`PersistStore.open()` runs v9 only when it is enabled. Four things decide that:
- **`PersistOpenOptions.enableV9`.** When the caller does not set it, the default is `V9_ENABLED_BY_DEFAULT`, which is **false**.
- **v9 off, on a v8 file.** The file stays at v8. The outcome is `skipped: not_enabled`, and `executionUnavailableReason` is `'not_enabled'`. The platform and handoffs are unchanged, and nothing is written: no backup, no marker and no v9 object.
- **v9 off, on a v9 file.** The v9 shape is still checked. Execution reports `not_enabled`, and the platform and handoffs work.
- **The default flip.** Making v9 the default is one line: `V9_ENABLED_BY_DEFAULT = true`. It comes in a separate small commit after the user's verification go-ahead, together with the test edits that commit needs (section 45).

Only tests enable v9 today. The pending `index.ts` line maps `NEXUS_ENABLE_V9=1` to `enableV9: true`, and never passes an explicit `false`, which would override the default after the flip (ruling F1).

### 33.2 Procedure

`PersistStore.open()` runs the v7 step ([section 14](#14-migration-procedure)), then the v8 step ([section 22.1](#221-procedure)), then `migrateV9` through `migrateV9Guarded`. `open()` never throws because of v9: an unexpected throw logs `[db] v9 step: unexpected error=<redacted>; execution disabled`, and the platform and handoffs stay as the v8 step left them.

1. **Decide.**
   - **v8 not in place:** v7 or v8 was held, skipped or failed, or either shape check failed. The outcome is `skipped: v8_unavailable`, and no v9 line is logged.
   - **`from > 9`:** the newer-schema branch logs `[db] schema v<n> is newer than this build (v9); opened for legacy use only, platform disabled, nothing migrated`.
   - **Already at v9:** `v9ShapeProblem(db, true)` runs. A problem logs `[db] v9 shape check failed: <problem>; execution disabled`. The outcome is `not_needed`.
   - **Not enabled:** `[db] v9 migration: not enabled; database stays at v8`. This is logged only on a v8 file whose v8 step is in place.
   - **Held** (`holdV9`, or `holdV8` or `holdV7`, which imply it): the outcome is `skipped: held`.
   - **The v9 failure marker counts 3 or more:** the outcome is `skipped: held` (`repeated_failure`), and no backup is taken.
2. **Pre-checks.** These run only when the file held data before this `open()`:
   - `integrity_check` is `ok`;
   - free space in `backups` is at least 2 × (`harness.db` + `-wal`);
   - the row counts of every table are taken.

   A failure skips v9 (`precheck_failed` or `insufficient_disk`), and the file stays at v8.
3. **Backup** of the v8 database: `userData/backups/harness-v8-<UTC>.db`. It is written, verified and hashed exactly like the v7 and v8 backups, with `user_version = 8`. A failure gives `skipped: backup_failed`. A fresh database takes no v9 backup.
4. **Migrate**, in ONE `BEGIN IMMEDIATE` transaction: `applyV9`, then `user_version = 9`, then COMMIT. `applyV9` runs, in order:
   1. `v7ShapeProblem(db, true)` and `v8ShapeProblem(db, true)` must both be null;
   2. `v9ShapeProblem(db, false)` refuses a pre-existing object of the wrong shape;
   3. `V9_DDL`;
   4. the seeds;
   5. the `nexus_migrations` row 9;
   6. one `db.migrated` activity row, only if that record is new;
   7. `verifyV9`. It checks the exact v7, v8 and v9 shapes, every seed row, exact seed counts in the v9 lookup tables, and an empty `foreign_key_check`. It also checks that every pre-existing table kept its row count, with these exceptions: `activity` and `nexus_migrations` grow by 1, `sqlite_sequence` is not compared, and `lineage_relations` grows by exactly the number of rows the seed inserted (at most 4).
5. **After COMMIT:** the v9 failure marker is deleted and `quick_check` runs. If it is not `ok`, execution stays off and the log names the backup. The platform and handoffs stay on, because the v7 and v8 objects are unchanged.
6. **On a throw in step 4:** SQLite rolls everything back, including `user_version`. The file stays at v8, the backup is kept, and the marker is incremented.

The outcome is `PersistStore.lastMigrationV9`. `lastMigration` (v7) and `lastMigrationV8` keep their contracts.

**Store getters.**
- `platformAvailable` is true at v7, v8 or v9 when the v7 shape check passed.
- `handoffsAvailable` is true at v8 or v9 when the v8 check passed.
- `executionAvailable` is true only when all of these hold:
  - v9 is enabled for this `open()`;
  - the store is at v9, and the v9 post-check (or the reopen shape check) passed;
  - handoffs are available.
- `hasPlatformRecords` counts `artifacts`, `jobs`, `agent_sessions`, `handoffs`, `deployments` and `approvals`.

The platform adds two conditions of its own. `createNexusPlatform` builds the execution services only when:
- the caller passes `execution: true`;
- handoffs are on;
- `v9ShapeProblem` is null;
- the registry check passes ([section 41](#41-the-domain-registry)).

### 33.3 The `nexus_migrations` row 9

After a successful v9 step, `nexus_migrations` has a third row:
- `version = 9` and `from_version = 8`;
- `applied_at` (ms) and `app_version`;
- `backup_file`: the basename (`harness-v8-<UTC>.db`). It is NULL for a fresh database;
- `backup_sha256`: the same value as the `backup ok` line;
- `backup_bytes`;
- `row_counts_json`: the pre-migration counts;
- `backfill_json` = `'{}'`.

The `db.migrated` activity row has actor `system`, `entity_id` `'9'`, and details `{from: 8, to: 9, backupFile, backupSha256}`.

### 33.4 Log lines, in order

Every line is prefixed with an ISO timestamp. As before, lines never carry row contents, kv values or full paths.

**First launch of a v8 database with v9 enabled (success):**
```
[db] schema version 8
[db] v9 precheck ok integrity=ok integrityMs=<n> free=<bytes|unknown> needed=<n>
[db] backup ok file=harness-v8-<UTC>.db bytes=<n> sha256=<hex> from=8 writeMs=<n> verifyMs=<n> hashMs=<n>
[db] row counts <table>=<n> ...
[db] v9 migration: start from=8
[db] v9 migration: success to=9 durationMs=<n> attemptStates=7 approvalStates=5 deploymentStates=5 relationsAdded=4
[nexus] execution core ready: runner not attached
[nexus] platform ready: principals ok, workspaces added=0, primaries set=<n> cleared=<n>, sessions interrupted=0, jobs interrupted=0 requeued=0
[nexus] execution recovery: adopted=0 finalized=0 requeued=0 interrupted=0 expired=0 pending=0
```
The two `[nexus]` lines that mention execution appear only when main composes the platform with `execution: true`, which is part of the pending wiring.

**v9 not enabled (today's default), on a v8 file:**
```
[db] schema version 8
[db] v9 migration: not enabled; database stays at v8
[nexus] platform ready: ...
```

**Fresh database:**
- the v7 and v8 lines of [section 22.3](#223-log-lines-in-order);
- `[db] fresh database: no v9 backup needed`;
- the `start` and `success` lines.

**Every later launch at v9:** `[db] schema version 9`, then the `[nexus]` lines. There is no second backup and no migration.

**Held:**
```
[db] v9 migration: skipped reason=held (NEXUS_DB_HOLD_V9=1); database stays at v8
```
The parenthesis names `NEXUS_DB_HOLD_V8=1` or `NEXUS_DB_HOLD_V7=1` when only one of those is set. The switches are read only when v9 is enabled.

**The v9 transaction failed:**
```
[db] v9 migration: failed from=8 error=<redacted>; database left at v8; backup kept at harness-v8-<UTC>.db
[db] v9 migration will be retried at the next launch (failure <n> of 3); set NEXUS_DB_HOLD_V9=1 to stay on v8
```
- On the third failure, the second line reads instead: `[db] v9 migration has failed 3 times in a row; it is held from the next launch (held: repeated_failure)`.
- On a fresh database, the first line ends `no backup (fresh database)`.

**Held after repeated failures:**
```
[db] v9 migration: skipped reason=held: repeated_failure count=3; database stays at v8; no new backup taken
[db] to retry v9, quit and delete harness.db.v9-failures.json next to harness.db; existing backups are kept (restore one with the restore tool, tools/nexus-db-restore.cjs, if needed)
```

**Other skips (the file stays at v8):**
- `[db] v9 migration: skipped reason=precheck_failed detail=…; database left at v8`, or `reason=insufficient_disk detail=free=<n> needed=<n>`;
- `[db] backup failed stage=<stage> error=…`, then `[db] v9 migration: skipped reason=backup_failed detail=stage=<stage>; database left at v8`.

**Post-commit check failed:** `[db] v9 post-check FAILED; execution disabled; restore from backup harness-v8-<UTC>.db`.

**Execution held at startup on a v9 file** (execution off for any reason):
```
[nexus] execution recovery held: execution is off (<reason>); jobs with a live attempt are left for the next start with execution on
```

**Registry check failed:** `[nexus] domain registry check failed: <n> problem(s); execution is off (first: …)`.

### 33.5 The hold cascade, the failure marker and auto-hold

| What | Where and how |
|---|---|
| Hold switch | `NEXUS_DB_HOLD_V9=1` keeps the database at v8 when v9 is enabled. `NEXUS_DB_HOLD_V8=1` and `NEXUS_DB_HOLD_V7=1` imply it: the holds cascade v7 → v8 → v9. While v9 is not enabled, the switches are not read for v9 at all. |
| Failure marker | `userData/harness.db.v9-failures.json`, next to the database: `{"count":n,"lastFailureAt":<ms>}`. It is separate from the v7 and v8 markers. Each failed v9 transaction increments it, and a successful commit deletes it. Skips do not count. |
| Auto-hold | At 3 consecutive failures (`V9_FAILURE_LIMIT`), v9 holds itself and takes no new backup. To retry, quit and delete `harness.db.v9-failures.json`. |
| Backups | `userData/backups/harness-v8-<UTC>.db`, next to the older ones. Nothing prunes them. |

### 33.6 When execution alone is off

`PersistStore.executionUnavailableReason` says why execution is off while the platform is on. It is null when execution is available, and also when the whole platform is off.

| Reason | Set when |
|---|---|
| `not_enabled` | v9 was not enabled for this `open()`, and v8 is in place. This is the default today. |
| `held` | A hold switch kept the file at v8 (or v8 itself is held). |
| `auto_held` | The v9 marker reached 3 (or v8 is auto-held). |
| `backup_failed` | The `harness-v8` backup failed (or the `harness-v7` one, for v8). |
| `failed` | The v9 transaction rolled back, the post-check failed, a pre-check or the disk check skipped v9, or the step threw (or v8 failed). |
| `shape` | The file is at v9, but the v9 shape check failed on reopen (or the v8 one did). |

When v8 is not in place, the reason is the handoffs reason, whatever `enableV9` says, because execution needs handoffs. The platform adds three reasons of its own: `v8_unavailable`, `registry_invalid` and `not_started`.

The execution channels #24 to #41 then answer `{ ok: false, code: 'platform_unavailable', reason: 'execution_unavailable', subReason }`. #22 and #23 and every B1 channel still answer normally.

### 33.7 Runbook: enabling v9

Do this only after the user's verification go-ahead, and only once the pending wiring ([section 45](#45-pending-wiring)) has landed. Until then, nothing in the app can enable v9.

1. **Quit the app.** Copy `harness.db` and any `-wal` and `-shm` to a folder outside userData. This is your independent fallback. The migration takes its own verified backup as well, but do not rely on it alone.
2. **Check free space.** v9 itself needs 2 × the database in `backups`. The execution gate needs 30 GiB free at the data home, and `test:exec` also checks the Docker data volume ([section 42](#42-the-resource-gate-and-the-testexec-gate)).
3. **Launch once with `NEXUS_ENABLE_V9=1`,** or launch normally after the default flip.
4. **Check the log** for the lines in [section 33.4](#334-log-lines-in-order), and note the `backup ok … from=8` sha256.
5. **Check the file** with Electron-as-node: `user_version` is 9, `integrity_check` is `ok`, `nexus_migrations` row 9 is present, and `foreign_key_check` is empty.

To try execution without touching your real data, launch with `--user-data-dir=<temp>` first. This follows the standing rule that click-throughs run only on a scratch userData. Executions, versions, approvals and deployments are never deleted, and a project that has any of them cannot be deleted.

### 33.8 Restore to v8

You do not need a restore after a failed v9 transaction: the file is still v8. Restore after a v9 post-check failure, or when the user asks to go back to v8. Follow [section 15.6](#156-restore-procedure) with the v8 backup:

1. Quit the app. Copy `harness.db`, `-wal` and `-shm` outside userData.
2. Take the sha256 from the v9 `backup ok … from=8` line, or from `nexus_migrations` row 9 (`backup_sha256`).
3. Dry run:
   ```
   node tools/nexus-db-restore.cjs --db <userData>/harness.db --backup <userData>/backups/harness-v8-<UTC>.db --sha256 <hex>
   ```
4. Apply: the same command with `--apply`.
5. Relaunch. The tool reads the backup's `user_version` from its header, and for a v8 backup prints: `Next: launch with NEXUS_DB_HOLD_V9=1 to stay on schema v8, or launch normally: a build with schema v9 enabled migrates it again (a new backup is taken first); a build without it stays on v8.` While v9 is not enabled, a normal launch stays at v8. If the v9 marker reached 3, delete `harness.db.v9-failures.json` before you retry.

The data home `<userData>/nexus` is not part of the database backup. After a restore to v8 it keeps its blobs, logs and work folders. The v8 schema does not read them, and a later v9 migration starts with empty v9 tables. The first blob store hygiene pass after execution starts removes unindexed objects older than 24 hours. Docker resources labelled for the data home are left in place ([section 35.5](#355-orphan-scoping)).

To check a restore without launching, open the file with Electron-as-node. Expect `user_version` 8, `integrity_check` `ok`, and the row counts of row 9's `row_counts_json`.

### 33.9 Downgrade: the `d7abc87b` build on a v9 database

The B1 build (`d7abc87b`) knows schemas up to v8. On a v9 database:
- It logs `[db] schema v9 is newer than this build (v8); opened for legacy use only, platform disabled, nothing migrated`. The outcome is `skipped: newer_schema`.
- Phase A works: list, save, and delete a project that has no platform records. `user_version` stays 9.
- **Its delete guard stays on.** The B1 guard is `version >= 7`, and it counts `artifacts`, `jobs`, `agent_sessions` and `handoffs`. Every B2a deployment names a job of its project, and every project-scoped B2a approval names a job too. So the guard sees them through `jobs`, and refuses the delete without writing.
- The current build then reopens the file with `not_needed` for all three steps.

`test/nexus-db-phase-a.test.cjs` pins this ("the B1 build d7abc87b opens a v9 database as newer"). Older builds behave as before. For example, `e2fceec` (B0b) opens a v9 file as newer than v7, and its delete guard is off, as [section 16, item 13](#16-known-limitations-and-operational-notes) describes for v8. Nothing stops an older build from opening a v9 database (D1, unchanged).

---

## 34. The execution model

### 34.1 Three processes, one authority

| Process | Holds | Never |
|---|---|---|
| Electron main | SQLite (the only authority for job state), the platform, the scheduler, ingest, validators, approvals and deployments | runs Docker or a recipe command |
| Runner (`utilityProcess`, `out/main/runner.js`) | the per-attempt state machine; Docker and git calls; staging, hashing, parsing and logs | opens the database, decides a job's state, or derives its own install label |
| Docker | the containers, volumes and networks | sees the host beyond its mounts |

Main and the runner talk over a MessagePort, using `src/shared/nexus/runnerProtocol.ts`. Main validates every runner message with `parseRunnerMessage`. It then accepts the message only when all three of these hold:
- the attempt is known;
- its `lease_owner` is this boot;
- an `attempt.event` seq is strictly increasing.

Anything else is dropped with one log line and no write.

`startExecution` runs the start-up sequence:
1. Fork the runner. `runnerHost` restarts a crashed runner after 1 s, 5 s, then 30 s. After 5 restarts in 10 minutes it gives up with `Execution is unavailable: the runner stopped repeatedly`.
2. Attach it with `platform.bootId`.
3. At every runner `ready`, send `reconcile.list` and route the answer to phase B ([section 35](#35-restart-recovery)).
4. Start the 1-second scheduler tick after the first phase B. If the runner is unavailable, or 2 minutes pass, the tick starts anyway.
5. Push `nexus:hint` at most 4 times a second.

On quit, `stop()` first stops every live dev deployment (`app_quit`). It then tells the runner to shut down, and kills it after 5 s.

### 34.2 Jobs and attempts

A user action (`nexus:job:start`) creates a `tool.run` job that names a recipe. The job keeps the v7 state table ([section 10](#10-jobs-and-the-job-state-table)). An attempt is one try.

| Job move | B2a cause |
|---|---|
| `queued → leased` | The scheduler leases it, in ONE IMMEDIATE transaction: a compare-and-set on `state = 'queued'`, `attempts + 1`, and attempt n inserted (`starting`, `lease_owner = bootId`, `lease_expires_at = now + 60 s`). It also records `sandbox_json` and `environment_json`, one activity row and one event. |
| `leased → running` | A container attempt: an `attempt.provisioned` report with a passing preflight and the planned image id. An engine attempt: a report without a container. An egress recipe: main moves it to `running` (phase `approval`) when it asks for the approval. |
| `running → awaiting_approval` | The egress approval row is created, in the same transaction. |
| `awaiting_approval → running` | The user answers `once`. The approval is consumed for this attempt and the plan is sent. |
| `awaiting_approval → failed` | Denied, expired, or consumed but not started within 15 minutes (`approval_stale`). The outcome is `denied`. |
| `leased → queued` | The runner refused before start with a waiting reason, or the plan could not be sent. The attempt is `abandoned`, and the job waits with a backoff of 2 s doubling to 60 s (`next_attempt_at`). |
| `running → completed` | The exit was made durable, the contract outputs are present, ingest committed, and the evidence backstop holds ([section 38.3](#383-what-never-completes-a-job)). |
| `running` or `leased → failed` | `limits_not_applied` (preflight), `nonzero_exit`, `invalid_output`, `oom`, `no_evidence`, `ingest_unavailable`, a refusal that fails, or an infrastructure fault. |
| any live state → `cancelled` | The user cancels; a parent cancels. |
| `running` / `awaiting_approval → timed_out` | The wall clock ran out ([section 34.4](#344-timeouts-stalls-and-sleep)). |
| live → `interrupted` | Recovery finds work that it can neither adopt nor retry. |
| `failed` / `timed_out → retry_scheduled → queued` | `canRetry`, for idempotent recipes and infrastructure failures only ([section 34.5](#345-failure-classes-and-retry)). |

Every job transition writes one activity row and one `job_events` row, in the same transaction. Attempt transitions write `job_events` only. `JobDetailView` names the attempt list `attemptHistory`, because `Job.attempts` is already the count.

### 34.3 The scheduler, leases and heartbeats

The 1-second tick does this, in order:
1. writes the heartbeats received since the last tick, in one transaction;
2. moves due retries to `queued`;
3. runs the timeout sweep, the lease-expiry sweep and the heartbeat-gap sweep;
4. considers queued jobs by `ix_jobs_sched` (priority 0 first, then age).

There is no lease at all while blob GC holds its exclusive lock.

A queued job is leased only when every guard passes. The first guard that fails sets the job's `phase`:

| Guard | Waiting reason |
|---|---|
| The runner is ready (and fewer than 3 consecutive sends have failed) | `waiting:runner` |
| Docker is running (container recipes) | `waiting:docker` |
| The profile image is present and matches its pin. A dev deployment also needs `nexus-fwd`. | `waiting:image` |
| Free space at the data home ≥ max(5 GiB, 2 × the recipe's output cap) | `waiting:disk` |
| Slots: at most 3 job containers and 2 service containers | `waiting:slots` |
| Memory: live containers reserve at most 60 % of Docker's memory. With nothing live, one container may use up to 85 %. | `waiting:memory` |

A runner refusal after the lease can also set a waiting phase. For example, when git is missing the runner refuses `git_missing`: the attempt is `abandoned`, and the job is requeued with the backoff and reads `waiting:git`.

Engine recipes need only the runner. A project may have at most 20 jobs that are queued or live (`queue_full` on start). Approval waits hold no slot and no memory. The cached probe is refreshed every 60 s.

**Leases.**
- A lease lasts 60 s (`LEASE_MS`). Heartbeats arrive from the runner every 15 s, from `attempt.start` onward, and each one extends the lease.
- The message handler keeps heartbeats in memory. The next tick writes them, so `heartbeat_at` can lag by up to a second.
- A 45 s gap writes one `attempt.heartbeat_gap` event.
- A live attempt of this boot whose lease expires fails `runner_lost`.
- After 3 consecutive failed sends, the runner counts as not ready until a fresh `probe.result` or `ready` arrives. Probing goes on meanwhile.

### 34.4 Timeouts, stalls and sleep

Each recipe has a wall clock: 15 minutes for installs, tests and builds; 5 minutes for discovery; 60 s for engine recipes; the 2-hour lifetime plus 10 minutes for a dev deployment. Main is the timeout authority. Its clock runs from the lease, minus the time the job spent in `awaiting_approval`.

**Collecting is out of the wall clock** (final review A3). Once an attempt's exit is durable (phase `collecting`), the work has run, so the wall clock no longer applies: a blob GC that holds the store's lock never times out finished work. Collecting has its own deadline instead (`COLLECT_DEADLINE_MS`, 10 minutes from the durable exit), which ends the attempt `ingest_error`, a retryable failure.

**Stalls (a tick gap over 10 s).** Leases move forward by the gap only, at most once per 60 s window, and the runner is probed. So an attempt keeps exactly the lease it had left before the stall. Heartbeats queued during the stall are written before the sweep.

**Sleep-like gaps (5 minutes or more)** are left out of the wall clock. The total left out per attempt is capped at 1 × its wall clock. So a laptop sleep longer than the remaining budget ends the attempt `timed_out`, which is an honest outcome the user can retry. This was a controller ruling.

**Two backstops sit inside the sandbox:**
- the Nexus entry runs the recipe under `timeout -s TERM -k 10 <NEXUS_WALL_SECONDS>`, where `NEXUS_WALL_SECONDS` is **twice** the recipe's wall clock, set by main (`ENTRY_WALL_FACTOR`, final batch item 2: the Task 7 R3 ruling puts the in-container backstop at no less than the limit plus the sleep cap, so it never ends work that main still counts as in time);
- the runner's own timer fires at 2 × the wall clock from the container start. If it fires first, main records `timed_out`.

### 34.5 Failure classes and retry

An idempotent recipe with attempts left is retried only for infrastructure failures:
- `docker_resources`, `disk_full`, `docker_error` and `io_error` (a `fault` that names the attempt);
- `container_vanished`;
- `ingest_error`;
- `runner_lost`.

The backoff is 10 s, 60 s, then 300 s.

These are never retried: `timed_out`, `nonzero_exit`, `invalid_output` (and its reasons), `oom` and `limits_not_applied`. These runner refusals fail the job at once: `bad_plan`, `network_not_approved`, `unknown_attempt` and `input_changed`. Any other refusal waits.

The idempotent recipes are `repo.snapshot`, the two installs, discovery, `sde.app.assemble` and `sde.diagnose`. Test runs, builds and dev deployments are not idempotent. A dev deployment is never requeued: `deployments.job_id` is unique.

### 34.6 Cancel

`nexus:job:cancel` (`ExecutionService.cancel`) does the following in one transaction:
1. cascades to the children first (`ix_jobs_parent`);
2. withdraws a pending approval;
3. ends the live attempt `cancelled`;
4. flags the job's drafts `cancelled_partial`;
5. cancels the job.

`attempt.cancel` is sent after commit: the runner stops with a 10 s grace, then kills. A later exit of a cancelled attempt is dropped, so cancel wins a race with an exit. The B0b `JobService.requestCancel` is unchanged and still does not cascade ([section 16, item 4](#16-known-limitations-and-operational-notes)).

### 34.7 The data home

The data home is fixed at `<userData>/nexus` in B2a. Every path in it is main-owned. The renderer never names one.

```
objects/<2 hex>/<62 hex>     content-addressed blobs; objects/tmp/ for in-flight writes
logs/jobs/<jobId>/<n>.log    attempt logs: JSON frames, redacted on write, capped at 50 MiB
logs/images/<buildId>.log    image build logs
work/<jobId>/<n>/{in,out}    staging; kept until main sends attempt.release
```

**Confinement** (`confineToDataHome`) applies B1's segment rules on every platform. It refuses:
- absolute, drive, UNC and `\\?\` paths;
- NUL, `..`, alternate data streams and reserved device names;
- a segment that ends in a dot or a space.

It then lstats each step. Any link or junction is refused, and so is a final file with more than one hard link. Every write is async, which is the posture rule.

**Docker-side scratch.** Each resource carries `nexus.job`, `nexus.attempt`, `nexus.boot`, `nexus.project` and `nexus.home`:
- `nexus-ws-<attemptId>`: the `/workspace` volume;
- `nexus-deps-<profile>-<12 hex>`: dependency caches, written only by an approved install and mounted read-only afterwards;
- `nexus-egress-in-<jobId>` (internal: the install and its proxy) and `nexus-egress-out-<jobId>` (the proxy's outbound bridge);
- `nexus-svc-<jobId>` and `nexus-pub-<jobId>`: the dev deployment networks.

`nexus.home` is the first 16 hex characters of sha256 of the resolved data home path. On Windows the path is first lowercased and stripped of any `\\?\` prefix (`src/shared/nexus/homeLabel.ts`).

---

## 35. Restart recovery

Recovery rebuilds everything from SQLite. The runner holds no state that main must trust. The path is chosen by the **file**, never by `enableV9`:
- `isV9File` is true when `user_version` is 9 or more, or when `job_attempts` exists;
- on a v9 file, `startup()` runs phase A instead of B1's `jobs.recoverAfterRestart`;
- on a v7 or v8 file, B1's routine is unchanged.

**Two rules hold for every decision:**
- each decision is one IMMEDIATE transaction, with exactly one `exec.recover` activity row and one `recovery` event;
- recovery never completes a job. A completion needs a real exit, ingest and evidence.

### 35.1 Phase A (startup, database only)

Every `leased`, `running` or `awaiting_approval` job is handled in its own transaction:

| Situation | Decision |
|---|---|
| No live attempt (agent runs, B0b jobs) | B1's rule (`JobService.recoverJobTx`). |
| Waiting for approval: pending and unexpired, or already consumed by this attempt | Keeps waiting. The attempt is re-owned (`lease_owner := bootId`, one fresh lease). |
| Waiting for approval, past `expires_at`, or denied | The approval becomes `expired`, the attempt fails, and the job fails `denied` (`approval_expired`). |
| Engine attempt (the work lived in the dead runner) | `abandoned`. A leased job goes back to `queued`. A running job goes to `retry_scheduled` when idempotent with attempts left, else `interrupted`. |
| Main check (a `validate` job without a recipe) | `abandoned`. A leased check is requeued. A running check is interrupted, and the same check is queued again as a new job (deviation RC9). |
| Container recipe, no container recorded | `abandoned`. A leased tool job goes back to `queued`. A dev deployment or a running job is retried or interrupted. |
| Container recorded | Left for phase B (`pending`). |

Then pending approvals past their time that no waiting job holds expire, and image builds left `running` become `interrupted` (`restarted`).

Phase A logs `[nexus] execution recovery: adopted=0 finalized=0 requeued=<n> interrupted=<n> expired=<n> pending=<n>`.

### 35.2 Phase B (at every runner `ready`)

Main sends `reconcile.list`, and the runner answers one `reconcile.result`. The answer is parsed by the protocol's own parser, and its boot id must be the attached runner's. Each live attempt with a recorded container is then decided in its own transaction. An entry that is unreported, has another container id, or arrives while Docker is not running counts as `missing`.

| Container | Decision |
|---|---|
| `running` | **Adopted**: one fresh lease, and `attempt.adopt` sent. The runner reattaches the log and resumes heartbeats and any probe loop. A dev deployment keeps its status. |
| `exited` | If the inspected exit and the staged list already show the exit cannot pass (OOM, a non-zero exit of a non-test recipe, a missing contract output), the attempt fails and is released. Otherwise it is **adopted for finalization**: phase `collecting`, no wall clock, one fresh lease and `attempt.adopt`. The runner re-hashes `/out` from the data home and reports `attempt.exited` again, and that report is ingested exactly like a live exit. |
| `created` or `missing` | `abandoned`. A tool job is retried (idempotent) or interrupted. A dev deployment is interrupted with its deployment stopped (`recovery`). If its deployment had already stopped before the restart, the job fails `exit_not_reported`. |

Approval waits still owned by another boot are re-owned. The line is `[nexus] execution recovery at runner ready: adopted=.. finalized=.. requeued=.. interrupted=.. reowned=.. orphans=.. docker=..`.

### 35.3 The reconcile bound

An attempt that phase A left pending must be decided within a bound:
- **The anchor.** The bound is 10 minutes after the later of phase A and the **first** reconcile request after it. Later requests never move the anchor (ruling on R3-1).
- **Waiting for an answer.** While a request has had no phase B, the bound waits up to 5 more minutes. So the latest it can fall is the first request plus 15 minutes.
- **When it falls.** At most every 30 s, the scheduler fails each still-unreconciled attempt `runner_lost`, using the core's failure rule (retried when idempotent). It sends `attempt.cancel` (grace 10 s, reason `timeout`) when a runner is attached.
- **Durable exits are never failed by the bound.** They keep waiting, and a later phase B finalizes them.
- **The headline meanwhile.** A job whose live attempt another boot owns reads `waiting:runner`.

### 35.4 Durable exits

An accepted exit is made durable before ingest, in its own transaction: job phase `collecting`, plus one `attempt.output` event. Phase B adopts such an attempt for finalization **whatever the container or Docker state**, with event reason `exit_durable`. The runner re-hashes `<dataHome>/work/<job>/<n>/out` and reads the exit it recorded beside it (`exit.json`), so no Docker is needed. An attempt this process is ingesting right now is skipped. A replayed exit is dropped. Ingest is idempotent, so an exit is ingested once.

### 35.5 Orphan scoping

This supersedes plan R.2's orphan rule (controller ruling, Task 10 review). Plan R.2 would have removed `nexus.*` resources of other boots. That is unsafe:
- click-throughs on a scratch userData share the Docker daemon with the real app;
- so does `test:exec`.

Phase B therefore lists a labelled resource for removal (reason `attempt_ended`) **only when all of these hold**:
- its `nexus.home` equals this install's;
- it has a `nexus.attempt` that this database's `job_attempts` knows;
- that attempt has ended;
- it is not a `nexus-deps-*` volume. Dependency caches are shared by later attempts.

Some resources are never listed:
- another install's resources;
- unlabelled resources, or ones with only other `nexus.*` keys;
- resources of live attempts, whoever owns them;
- resources without a data home label.

Attempt ids that the database does not know are logged and recorded in one `exec.recover` row (`unknown_resources`), and left in place. Main sends the list as `reconcile.remove`. The runner re-checks the labels, stops each resource with a 10 s grace, removes it by id, and main records one `exec.orphan_removed` row.

The cost of the ruling: **resources left by a deleted data home are never removed automatically** ([section 16](#16-known-limitations-and-operational-notes), item 30).

### 35.6 Blob store hygiene

`exec.recoverBlobStore` runs once per app start, after the first phase B and before the first tick. It does not run if the tick started first, or at a mid-session runner restart. It holds the blob store's exclusive lock, and it:
- sweeps `objects/tmp` files older than 24 h;
- removes unindexed objects older than 24 h, but only while no attempt is live;
- closes a lone `started` GC run once nothing younger remains;
- reports hard-linked or undeletable leftovers `failed` on every pass, and never deletes them.

### 35.7 Hold mode

On a v9 file whose execution is off, phase A recovers only jobs without a live attempt, by B1's rule. It writes no v9 table. Jobs with a live attempt are left exactly as they are for the next start with execution on.

The runner side of all this is exported as `RUNNER_RECOVERY_CONTRACT` (`src/main/nexus/exec/recovery.ts`).

---

## 36. The sandbox

Every container goes through three steps, in this order: **create, inspect (preflight), start**. The preflight compares `docker inspect` with the spec (`src/shared/nexus/preflightCheck.ts`, pure). Any problem removes the container, fails the attempt `limits_not_applied` and the job `infra_error`, and writes one `preflight` event that lists the problems.

| Control | Applied as | Checked by preflight |
|---|---|---|
| CPU | `--cpus` (recipe: 1 or 2; forwarder 0.5) | `NanoCpus` |
| Memory | `--memory` = `--memory-swap` (no swap): 1 or 2 GiB; forwarder 128 MiB | `Memory`, `MemorySwap` |
| Processes | `--pids-limit 512` | `PidsLimit` |
| Root and temp | `--read-only`; `/tmp` tmpfs of 512 MiB (forwarder 16 MiB); `/home/nexus` tmpfs of 256 MiB | `ReadonlyRootfs`, the tmpfs keys and sizes |
| Privileges | `--cap-drop ALL`, `no-new-privileges`, `--user 10001:10001`, no `--privileged`, no devices | `CapDrop`, `CapAdd` empty, `SecurityOpt`, `Privileged`, `User`, `Devices` |
| Mounts | only the spec's: `/in` read-only, `/out` (a bind under the data home), `/workspace` (a named volume), the deps cache read-only | the exact set of destination, RW flag and type. Never the Docker socket or the host root. |
| Network | `none` by default ([section 37](#37-networks-and-approvals)) | `NetworkMode`; `none` has no endpoint; no port bindings except the forwarder's `127.0.0.1` |
| Image | the pinned local image id (`sha256:<id>`), `--pull never` | the exact image id, entrypoint, `Cmd` and env names |
| Runtime | `--runtime runc`, `--restart no`, no `--rm`, private IPC and cgroup namespaces | each field |
| Labels | `nexus.*` | exact |
| Wall clock | the entry's `timeout` and the runner's backstop ([section 34.4](#344-timeouts-stalls-and-sleep)) | recorded |

**Env.** A container gets only the names on `ALLOWED_ENV_NAMES` plus the image's own ENV names, with values set by main. Main checks every value with `containsSecret` and the secret-shape rules. No secret ever reaches a container in B2a, because the secret store is B2b.

**What this storage driver cannot enforce.**
- **There is no disk quota.** Docker's storage driver (overlayfs or the containerd snapshotter) has no per-container quota. The runner's **size guard** stands in for one. Every 5 s it measures `/out` on the host, with an lstat walk that never follows a link, and `/workspace` inside the container, with `/usr/bin/du -s -x -k /workspace` run through `docker exec`. It kills the container when `/out` exceeds the recipe's output cap (`output_too_large`) or `/workspace` exceeds 8 GiB (`workspace_too_large`).
- **The overshoot is bounded but real.** A container can write for up to one poll interval (5 s), plus the time of the walk, past its limit before it is killed. The tmpfs mounts are hard caps, charged to the memory cgroup. The host-side lease floor stops new leases below max(5 GiB, 2 × the output cap).

**Checkouts never write the user's repository.**
- The code reaches a container as `git archive --format=tar <commit>`. The runner writes it into `work/<job>/<n>/in/src.tar`, hashing it as it goes, and the entry extracts it into `/workspace`.
- B2a creates no worktree and no ref in the user's `.git`.
- **What a checkout leaves out:** submodules, `export-ignore` paths and uncommitted changes. LFS-tracked files arrive as their pointer text (below). The UI note is "Tests run on commit <short>; uncommitted changes are not included."
- `git archive` runs with `-c core.autocrlf=false -c core.eol=lf`, so the container receives the committed line endings, and a lockfile hashes in the container exactly as it hashes at the commit.

**git on the host.**
- git is resolved once to an absolute path (`src/main/gitBinary.ts`), from absolute PATH folders and the usual install folders.
- It is launched with `-C <repo>` from a neutral folder, never by name.
- A git binary inside the repository is refused.
- Every runner call adds `-c core.fsmonitor=false -c core.hooksPath=<an empty folder>`, and main adds `-c core.fsmonitor=false`.
- **No filter driver runs on the host** (final review B1). `git archive` smudges and `git status` cleans content through any configured `filter.<name>.*`, and Git for Windows ships `filter.lfs.*` in its system config, which would make git-lfs reach the network with the user's credentials. So before every `archive` or `status`, in the runner and in main alike, the driver names are read with `git config --name-only --get-regexp "^filter\."` (read-only), and each one is switched off with `-c filter.<n>.smudge= -c filter.<n>.clean= -c filter.<n>.process= -c filter.<n>.required=false`. If the names cannot be read, the call is refused. `GIT_LFS_SKIP_SMUDGE=1` is in every git call's environment. LFS-tracked files therefore stage as their pointers ([section 16](#16-known-limitations-and-operational-notes), item 35).
- **The snapshot records the lockfile** (final batch item 1): the first of `package-lock.json` and `requirements.txt` present as a blob at the commit is streamed with `git cat-file blob` (raw bytes: no filter, no textconv) and hashed in the runner. Only `{ path, sha256 }` leaves the runner, and `repo.snapshot` stores it as the repository version's `metadata.lockfile.sha256`.
- A missing git is reported as `setup:git_missing` (main) or the refusal `git_missing` (runner). The job then waits (`waiting:git`).

**Outputs.**
- The runner walks `/out` with lstat only. It refuses symlinks, hard links, special files and bad names, and nothing outside `/out` is opened.
- It hashes each file into the object store with an `O_NOFOLLOW` open.
- The node:test JUnit merge writes its temporary file in the work folder, which is never mounted, and replaces `junit.xml` only when that is absent or a plain single-link file.

**Logs.**
- Each line is redacted as a whole before it is cut into frames.
- A log is capped at 50 MiB. Past the cap, the head and tail are kept and one marker replaces the middle.

---

## 37. Networks and approvals

| Mode | Used by | How | Approval |
|---|---|---|---|
| `none` | every recipe by default: snapshot, discovery, tests, build, assemble, diagnose | `--network none` | none |
| `egress-approved` | `sde.deps.node` and `sde.deps.python` only | The install joins only `docker network create --internal nexus-egress-in-<jobId>` (no route out), with `HTTPS_PROXY` (and npm's or pip's proxy setting) pointing at the job's Nexus egress proxy. `npm ci --ignore-scripts`, or `pip install --only-binary=:all: --require-hashes --no-deps`. | A1, per job |
| egress proxy | one per approved install: `node /opt/nexus/egress-proxy.js` in the pinned sde-node image | joins `nexus-egress-in-<jobId>` as `nexus-egress-proxy` and the outbound bridge `nexus-egress-out-<jobId>`; no mount, no port; `NEXUS_EGRESS_ALLOW` is the recipe's allow-list | A1 (the same approval) |
| image preparation | `docker build` of a profile | the daemon pulls the pinned base and installs the pinned packages | A2, per build |
| `service-internal` | the dev deployment's app container | `docker network create --internal nexus-svc-<jobId>`; no egress | none |
| forwarder | `nexus-fwd` (socat) | joins `nexus-svc-<jobId>` and `nexus-pub-<jobId>`; publishes only `127.0.0.1:<port>:8080`, with the port from 49152 to 65535 | none |

**A1, egress for a dependency install.**
1. At lease, main creates a pending `egress.deps` approval. Its `request_json` holds the recipe id and version, the job id, the lockfile sha256, the profile, and the expected registries: `registry.npmjs.org`, or `pypi.org` and `files.pythonhosted.org`. Its `request_sha256` is the sha256 of the canonical request.
2. The approval expires after 15 minutes. An install whose repository version records no lockfile hash fails at lease (`lockfile_missing`), and no approval is asked for.
3. `nexus:approval:respond` with `once` decides, consumes the approval for the job's **current** attempt, and resumes the job, all in one transaction.
4. The plan carries the approval (`plan.approval`). The runner refuses an egress network whose approval id is missing, differs, or was consumed by another job or attempt (`network_not_approved`).
4a. **The egress policy** (B2a stabilization, constraint 5; `src/shared/nexus/egressPolicy.ts`, `infra/images/sde-node/egress-proxy.js`, `src/runner/egress.ts`).
   - The allow-list is main's, per recipe (`EGRESS_ALLOWLISTS`): `sde.deps.node` reaches `registry.npmjs.org:443`; `sde.deps.python` reaches `pypi.org:443` and `files.pythonhosted.org:443`. The plan writes it into the proxy's `NEXUS_EGRESS_ALLOW`; the approval summary names the same hosts; the runner refuses a plan whose proxy carries anything else (`network_not_approved`), so a test-only pinned entry never reaches a real run.
   - The proxy allows only `CONNECT host:port` for an exact allow-listed name and port. It refuses plain HTTP (`plain_http`), IP literals (`ip_literal`), other names (`host_not_allowed`) and ports (`port_not_allowed`), and malformed requests. After the `200` it reads the TLS ClientHello and refuses a missing or different name (`sni_mismatch`, `not_tls`). Only then does it resolve the name. If any address is loopback, private (10/8, 172.16/12, 192.168/16, fc00::/7), link-local (169.254/16, fe80::/10), CGNAT (100.64/10), cloud metadata, multicast, reserved, a documentation range, or an IPv4-mapped, NAT64 or 6to4 form of one, it refuses (`private_address`). Otherwise it connects to the address it checked, so a second lookup cannot rebind it.
   - Preflight pins both containers before either starts: the install has exactly one endpoint (the internal network) and no alias; the proxy has the internal network with alias `nexus-egress-proxy` and the outbound bridge with none. For every container, `ExtraHosts`, `Dns`, `DnsOptions`, `DnsSearch` and `Links` must be empty, and no endpoint may carry `IPAMConfig`, `Links` or `DriverOpts`. The proxy's command, image and environment are compared exactly, as for any container.
   - The runner starts the proxy first and starts the install only after the proxy prints that it listens (30 s, else a `docker_error` fault). Each decision the proxy prints becomes an `attempt.event` of type `egress` (host, port, decision, reason; never a path, query string or header; at most 200 per attempt) and a line in the attempt log. The proxy is stopped when the install exits, before the exit is reported.
   - `job_attempts.sandbox_json` records the proxy's image, command, environment names, allow-list and both networks.
5. A `deny`, an expiry, or a consumption more than 15 minutes old fails the job `denied`. A second answer is `illegal_transition`.

**A2, image preparation.** `nexus:setup:prepareImage` creates a pending `image.prepare` approval. Its request holds the profile, the context sha256, the base digest, the estimated bytes and the free bytes.
- Before any row is written, the request is refused below the resource gate, for an unknown profile, or while a build of that profile runs.
- `once` consumes the approval and inserts a `running` image build. `tr_image_builds_insert` refuses a build without such an approval.
- A build fails `timeout` after 10 minutes without progress, or after 180 minutes in all.
- Any runner-wide fault interrupts every running build.

**Who may answer.** Only a stored, enabled principal of kind `user` may answer (`approval.respond`, which is owner-level). The system, agents and forged principals are denied and audited. `tr_approvals_transition` refuses any other decider.

**What the consent says.** The approval summary states exactly what is enforced: "Network access for this one Node dependency install job, through the Nexus egress proxy. Only registry.npmjs.org (HTTPS, port 443) can be reached; every other host, private and loopback addresses, cloud metadata and this computer are refused. Install scripts are disabled and packages must match the lockfile hashes (…)." The hosts come from the same allow-list the proxy receives. What the proxy cannot see is listed in [section 16](#16-known-limitations-and-operational-notes), item 26.

**Dev deployments.**
- A preview runs the application manifest's validated `run` argv: 1 to 32 plain strings, never a shell string.
- It is reachable only on `127.0.0.1` through the forwarder.
- It becomes `healthy` on the first `200` from its health path. It becomes `unhealthy` after 3 failed probes, and `healthy` again after 2 good ones. It fails `probe_failed` if it is still `starting` 60 s after its container started.
- **Windows across a restart or a stall** (final review A2). When restart recovery re-owned the deployment's attempt (`adopt` or `finalize`), the 60 s start window and the stopping wait count from that decision, not from the container start. A stopped deployment that waits for its exit is not judged before the runner's re-report deadline. A window that overlapped main's downtime, or a scheduler stall of 5 minutes or more, was not observed: `app.preview_health` records `error` / `start_window_unobserved` (the check could not run), never `failed`, so nothing blocks the application draft and the user can start the deployment again.
- It stops after a fixed 2 hours (`idle`).
- At most 2 run at once.
- A manifest that names env variables is refused: "secrets for dev deployments are not supported yet".
- A user's stop completes the job `stopped` only if the deployment had passed its health check and the exit code is known.

---

## 38. Evidence-based completion

A job is never complete because of an exit code of 0, a file existing, a README, a folder, or a status a tool printed (user constraint 4). Completion needs validated, persisted evidence that is bound to the job, its attempt and the resulting version.

### 38.1 Validators

The definitions are in `src/shared/nexus/validators.ts`, and the implementations in `src/main/nexus/validation/validators/*`.

| Validator | Kind | Stage | Runs in | Fails when |
|---|---|---|---|---|
| `git.head_resolves` | repository | register | main | The commit does not resolve in the project folder through main's own `resolveCommit`, or its full hash differs. |
| `req.schema` | requirement | register | main | No title, no acceptance criterion, a repeated criterion id, a body over 32 KiB, or a secret. |
| `problem.schema` | problem_statement | register | main | No question, or a field breaks the schema. |
| `suite.discovered` | test_suite | register | main | No test was discovered, or the list's hash differs. |
| `sde.tests_pass` | test_suite | candidate | a child test job | It checks, in this order: `junit_missing`, `parser_contract` (`error`), `counts_mismatch`, `no_tests`, `discovery_truncated`, `undiscovered_ids`, `discovered_not_run`, `exit_inconsistent`, `tests_failed`. An unattributed report on a multi-file list is `error` / `unattributed_report`. |
| `build.exit_zero` | build | candidate | main | A non-zero exit. This is one check among four, never enough on its own. |
| `build.manifest_present` | build | candidate | main | The output tree is missing or empty. |
| `build.output_hashed` | build | candidate | main | A file of the tree has no stored blob. |
| `blob.integrity` | build | candidate | the runner (re-hash) | A re-hash differs, or an object is missing. No answer within 60 s is `error`. |
| `app.manifest_schema` | application | register | main | `nexus.app.json` breaks its schema. |
| `app.preview_health` | application | candidate | the dev deployment | No `200` within 60 s, the container exited, or the port is bound anywhere but `127.0.0.1`. |
| `diag.schema` | diagnostic_report | register | main | A field has no inspect, probe or log source, or nothing was observed at all (`nothing_observed`). |
| `sde.deps.lock_matches` (advisory) | repository | candidate | main, at install ingest | The exit is not 0; `lock.sha256` is missing, not the only output, or not 64 hex characters; or it differs from the repository version's lockfile hash (`metadata.lockfile.sha256`, recorded by the snapshot) or from the hash of the approval this attempt consumed. `lock.sha256` is written by a Nexus-owned entry step, never by the repository's own tools. |

The first twelve are blocking. `sde.deps.lock_matches` came with the Task 13 review fixes. It is advisory: it records an install's own evidence on the repository version and never gates that version.

**Evidence** is a typed list (`src/shared/nexus/evidence.ts`): `hash`, `number` (with a JSON pointer into a hashed file), `exit`, `junit`, `schema`, `file`, `http`, `git`, `user`, `inspect`, `log` and `case`.
- `checkEvidence` refuses any other shape (`error` / `bad_evidence`).
- Secret-shaped evidence is stored as `[]`, with `error` / `secret_in_evidence`.
- Evidence over 64 KiB is `error` / `evidence_too_large`.
- `error` means the check could not run. It is never a pass.

### 38.2 Blocking and advisory rows; finalize

- **Who records results.** Only the system principal records a blocking `passed` or `failed` result. This is enforced by the service and by `tr_validations_insert`.
- **Blocking rows go on drafts only.** A result recorded on a version that is no longer a draft is written advisory (`blocking = 0`, `advisory = 1`). It is still bound to (job, n), so the evidence backstop holds. A user's test run on a candidate suite records an advisory row, and the suite stays a candidate.
- **What counts.** A version's status is read from the **latest blocking** row per validator: newest `finished_at`, then insertion order. Advisory rows are shown as run results and never gate anything.
- **`finalizeIfReady`** moves only engine-made drafts (made by a job or a session):
  - every blocking register and candidate validator of the kind has a latest `passed` row → `candidate`;
  - any `failed` → `failed`;
  - any `error` → the version stays a draft (`validation_state = 'error'`), and Revalidate can recover it.

  A `repository` candidate is promoted `active` in the same transaction, by the system on the user's behalf. A user's own draft is never finalized here: Mark ready (B1) does that.

### 38.3 What never completes a job

These rules hold in layers:
1. **The exit is durable first** (phase `collecting`), and ingest runs in one transaction under the blob store's shared lock.
2. **Contract outputs** are re-read from the runner's report and re-validated (`normalized.ts`). A secret-shaped value, an oversized list or tree, or a link in `/out` refuses the outputs (`invalid_output`). Nothing is stored.
3. **No ingest rule means no completion.** A recipe without one fails `ingest_unavailable` / `no_ingest_rule`.
4. **The evidence backstop.** After ingest, the core requires a `validations` row or a `version_attempts` row bound to (job, current attempt). Otherwise the job fails `no_evidence`. A deduplicated output still records a validation bound to (job, n).
5. **The database backstop.** `tr_jobs_completed_needs_attempt` refuses `completed` unless the current attempt `succeeded`. `succeeded` needs `exit_code`, `outcome`, `sandbox_json` and `environment_json` (CHECK).
6. **A step is done** only on a candidate or active version whose blocking validators passed (`stepStateFrom`, `src/shared/nexus/stepState.ts`). It is never done on a completed job alone.

A test run that exits non-zero but leaves a parsable JUnit is a **completed** job, and the product failure is in `sde.tests_pass`. A build is judged by its four validators, not by the bare `dist/**` contract.

### 38.4 The O1 to O22 invariants

`test/helpers/orphans.cjs` holds the invariant queries. `allOrphans(db)` must count 0 after every flow, together with an empty `foreign_key_check`, an `ok` `integrity_check` and a verified activity chain.

| Id | Must be empty |
|---|---|
| O1 to O9 | The B1 set: artifacts with no version; bad current pointers; handoff subject counts, receipts and conversion edges; version participations; references to a missing project; activity rows that name no row. |
| O10 | Attempts whose job is missing, or whose `n` exceeds `jobs.attempts`. |
| O11 | Jobs with more than one live attempt. |
| O12 | Terminal jobs with a live attempt. |
| O13 | Succeeded attempts missing `exit_code`, `outcome`, `environment_json` or `sandbox_json`. |
| O14 | `version_blobs` or blob storage references naming a missing blob. |
| O15 | Validations naming a missing version, job or attempt. |
| O16 | Job-produced candidate or active versions whose latest blocking row for some blocking validator of their kind is not `passed`. |
| O17 | Completed `tool.run` or `validate` jobs whose current attempt has neither an ingested version nor a validation. |
| O18 | Live attempts whose job is not `leased`, `running` or `awaiting_approval`. |
| O19 | A blob version without its `content` blob, or a tree version whose `file` blobs do not match its file list. |
| O20 | Live deployments whose job is terminal. |
| O21 | Pending approvals past `expires_at` after an expiry sweep (`sweptAt`). |
| O22 | Validations bound to a job of another project than their version's. |

O10 to O17 come from Task 8. O18 to O22 come from Task 13: they cover the Task 13 brief's O10, O12, O13, O14 and O15 under new numbers, so that Task 8's exact-key tests stay unchanged.

---

## 39. Recipes: what each SDE step runs

The recipes are data in `src/shared/nexus/recipes.ts`. Main builds every argv from fixed templates (`ARGV_TEMPLATES` in `planBuilder.ts`). The renderer never supplies any part of a command, path, network, image or limit.

| Step | Recipe | Executor | Output, then evidence |
|---|---|---|---|
| Requirement | none: `nexus:artifact:saveInline` | main | an inline `requirement` → `req.schema` |
| Repository | `repo.snapshot` | engine: 4 fixed git argv in the runner, plus the lockfile read (`cat-file`) | a `repository` version (`git` storage: commit, branch, dirty, tree; `metadata.lockfile.sha256`) → `git.head_resolves` |
| Tests (discover) | `sde.test.discover` | container, `none` | a `test_suite` with the whole discovered list in its metadata → `suite.discovered` |
| Tests (run) | `sde.test.node` or `sde.test.pytest`, as a child `validate` job | container, `none` | the JUnit result → `sde.tests_pass` |
| Build | `sde.build.node` or `sde.build.python` | container, `none` | a `build` tree (`dist/**` or wheels) → the four build validators |
| Application | `sde.app.assemble` | engine: `git cat-file -s`, then `git show <commit>:nexus.app.json` (at most 16 KiB) | an `application` → `app.manifest_schema`, then `app.preview_health` |
| Dev deployment | `sde.preview.start` | service: the app plus the `nexus-fwd` forwarder | a deployment row; health → `app.preview_health` |
| Logs and diagnostics | `sde.diagnose` | engine: label-checked `docker inspect`, plus hashed log ranges | a `diagnostic_report` → `diag.schema` |
| (dependencies) | `sde.deps.node` or `sde.deps.python` | container, `egress-approved` | the install, then the Nexus step `nexus-lock-hash` → `lock.sha256` → `sde.deps.lock_matches` (advisory) |

**node:test attribution.** node's JUnit reporter names no file. So the entry runs each discovered file on its own (`nexus-node-test`), and the runner merges the reports into `/out/junit.xml`, attributing each case from main's own `perFileJunit` mapping. A file whose report is missing gives no case, and the suite then fails `discovered_not_run`.

**Dependencies: the two lockfile steps** (final batch item 1, ruled). A real install needs both:
1. `repo.snapshot` records `metadata.lockfile.sha256` from the lockfile at the commit (`git cat-file blob`, hashed in the runner). An install of a repository version without it is refused at lease (`lockfile_missing`), before any approval is asked for.
2. After `npm ci --ignore-scripts` or `pip install … --require-hashes`, the install's argv ends with a Nexus-owned entry step with a fixed argv and no job value: `nexus-lock-hash --file package-lock.json --out /out/lock.sha256` (or `requirements.txt`). It refuses a link anywhere on the lockfile's path and writes the sha256 as 64 lowercase hex characters and a newline.

Main then judges `lock.sha256` against step 1's hash and the consumed approval's hash (`sde.deps.lock_matches`). The two hashes agree because the checkout keeps the committed line endings ([section 36](#36-the-sandbox)).

**Builds.** A build is keyed by (commit, tree). The same tree from another commit is a new version with its own `built_from` edge, while its blobs still deduplicate as blobs.

**Fixed limits.** At most 5,000 discovered files, 5,000 tree files, 20,000 JUnit cases and 16 MiB of JUnit. A JUnit file with a DOCTYPE or an ENTITY is refused.

---

## 40. The IPC surface

B2a adds 20 invoke channels (#22 to #41) and one push. The renderer calls them from Tasks 14 and 15 on ([section 40.1](#401-the-renderer)); until the pending `index.ts` edit lands, main does not register them, and the renderer reads that as "not connected".
- **Registration.** `NEXUS_CHANNELS` stays B1's frozen 21. The new ones are `NEXUS_EXEC_CHANNELS` (20), and `NEXUS_ALL_CHANNELS` is all 41. `registerNexusIpc` registers the 20 only when main passes an execution dependency. Until the pending `index.ts` edit lands, main registers B1's 21 only, and the 20 preload methods would reject with "no handler" (Task 13 deviation, accepted by ruling).
- **The wrapper.** Every channel goes through the one `handler()` wrapper. It checks the platform, then handoffs where needed, then execution (#24 to #41), then validates the request, resolves `user:local`, makes one service call, and returns the envelope.
- **What a request may carry.** Ids come from the renderer. No channel accepts a folder, file, image, network, argv, command or env.

| # | Channel | Authorization | Service call |
|---|---|---|---|
| 22 | `nexus:domains:list` | the wrapper only; static registry | `DOMAINS.map(domainView)` |
| 23 | `nexus:platform:health` | `platform.health` | `exec.health()` (cache only). The optional `{ probe: true }` (the setup sheet's "Check again", final review C3) also calls `exec.requestProbe()`, at most one probe per 5 s, never waited for; the answer is still the cache. |
| 24 | `nexus:actions:available` | `project.read`; the version's `artifact.read`; per action `authorize` (no audit row for a list) | `queries.actionsFor` |
| 25 | `nexus:job:start` | `job.create` in the stored participation; each input readable | `exec.start`, or `repo.requestSnapshot` for the snapshot action |
| 26 | `nexus:jobs:list` | `job.read` | `exec.list` (limit clamped to 500) |
| 27 | `nexus:job:get` | `job.read` | `exec.get` |
| 28 | `nexus:job:logs` | `job.read` | a confined, re-redacted log page of at most 256 KiB |
| 29 | `nexus:job:cancel` | `job.cancel` | `exec.cancel` |
| 30 | `nexus:job:retry` | `job.create` | `exec.retry` |
| 31 | `nexus:events:since` | `job.read` | `exec.eventsSince` (limit 500) |
| 32 | `nexus:version:validations` | `artifact.read` | the latest blocking row per validator is `status`; the newest advisory row is `latestRun` |
| 33 | `nexus:version:revalidate` | `version.revalidate` | `validation.revalidate`, which answers `{ jobs }` |
| 34 | `nexus:version:preview` | `artifact.read` | a paged preview of at most 256 KiB |
| 35 | `nexus:artifact:saveInline` | a user principal; `artifact.create` and `version.register` | `artifacts.saveInline` (requirement or problem statement) |
| 36 | `nexus:deployments:list` | `job.read` | `deployments.list` |
| 37 | `nexus:deployment:stop` | users only; `deployment.stop` | `deployments.stop` |
| 38 | `nexus:approvals:list` | `approval.read` | `approvals.list` |
| 39 | `nexus:approval:respond` | users only; `approval.respond` in the approval's project | `approvals.respond` (`once` or `deny`; anything else is `bad_request`) |
| 40 | `nexus:setup:prepareImage` | users only; `approval.respond` platform-wide | `approvals.requestImage` |
| 41 | `nexus:blobs:gc` | `blob.gc` platform-wide (admin), for both the dry run and the apply | the blob GC dry run, or the apply with the dry run's `expectedCandidatesHash` |
| push | `nexus:hint` | none | `{ lastSeq }` only, at most 4 per second, sent by `startExecution` |

**What the views leave out.** No principal id, params, sandbox or environment record, container id, log or object location, or env value. Image ids are shortened to `sha256:` plus 12 hex characters. A deployment URL is only `http://127.0.0.1:<port><healthPath>`.

**No system-only door.** No system-only method is reachable from IPC, and the IPC test I-P4 scans for 25 such names. `resumeApproved` in particular is never mapped: `respond` is the one door.

**Policy.** B2a adds these actions:
- `approval.read` and `platform.health` (viewer);
- `deployment.stop` and `version.revalidate` (member);
- `blob.gc` (admin);
- `approval.respond` (owner);
- `approval.create`, `deployment.transition` and `exec.ingest` (system only).

**Attempt ids.** `JobDetailView.attemptHistory` carries each attempt's `id` (the attempt row's ULID) since the final review. A diagnostic report names the attempt of each log range by that id, so a log-range link opens exactly that attempt, also for a job with several.

### 40.1 The renderer

The execution UI keeps Spine and Folio (user constraint 14): no dashboard, cards or tiles. Every status is a word, and every number comes from a view (`HealthView`, an approval, a job, a check result); nothing is estimated in the renderer.

| Where | What it shows |
|---|---|
| Bench notice (`ExecutionNotice`) | One `role="status"` line when jobs cannot run, or an advisory such as the disk below 30 GB, with "How to set up". Nothing when the platform itself is off: its own notice speaks. Before main's first probe nothing reads ready ("This computer has not been checked yet…"). |
| Execution setup sheet | Rows for Docker, memory, CPUs, free disk, each sandbox image, the runner, git (only when main reports it missing) and the GPU, each with a status word, the exact numbers and what to do. "Prepare image" asks for an approval first. "Check again" asks main for a fresh probe (#23 `{ probe: true }`) and reads the cache again about 1.5 s later. "Checked at <time>" says when main last probed. |
| Runs tool | Persisted jobs above the session requests: the title from the registry, a headline ("Tests ran; checks failed: no tests were executed"), a status word and a six-stage strip. Cancel only for live jobs; Retry only for failed, timed out, cancelled or interrupted ones; Logs. A job whose checks failed never reads completed or passed. |
| Run log | The paged, redacted log of one attempt, read from main's byte offsets ("Load more"). A log range from a diagnostic report opens its own attempt at its own offset. |
| Folio: evidence | The latest blocking result per validator, with its sourced facts (JUnit counts "Reported by the framework", 12-character hashes, exit codes, HTTP probes) and advisory run results. Revalidate only on a draft whose checks could not run. A kind with no checks reads "No checks for this kind". |
| Folio: kind viewers | Test results (failures first) and the discovered list, a build's manifest, an application's manifest, a diagnostic report's sourced facts and log ranges (a report larger than one page says so and offers "Load more"), a requirement, a problem statement, a repository snapshot. |
| Folio: actions | Main's #24 answer, checked again against the registry: an available action of a step in this release is a button; an unavailable one is a sentence that says why. A FUTURE step's action is never shown. |
| Approvals | What is reached or downloaded, the hashes it is bound to and when it expires; only "Approve once" and "Deny", with an inline confirmation. |
| Dev deployments | A status word, `http://127.0.0.1:<port>` only while healthy or not answering, the last health check, Stop, and Diagnose when main offers it. Diagnose lives on this row only; a run row does not offer it in this release. |
| Lifecycle rails | Each domain's steps in its own words on the workspace page and, compact, on each Spine group. A state comes from records only (`stepStateFrom`). A FUTURE step reads "Not in this release: arrives with …". A step whose versions' checks were not read (past the Spine's 40-version read cap) claims no state. No domain is ever called complete. |
| Activity | One sentence per row, from the allow-listed details. A job's `completed` state reads "Job ran; its checks give the result", because a run whose checks failed is still a completed job. A recovery decision this build does not know reads "Restart recovery recorded a decision". |

`test/nexus-honesty-audit.test.cjs` holds the audit: for every domain and every availability state, even when main's answer claims every action is available, no button maps to a FUTURE step, an unmet machine prerequisite or a missing input; and no rail text, B2a activity sentence (mapped through the real `dto.activityView`) or job-run headline calls work complete.

---

## 41. The domain registry

The registry is DomainSpec v3, in `src/shared/nexus/domainSpec.ts` and `domains/*`. Six domains are data: their steps, kinds, capability ceiling, recipes, actions, handoff routes and modules. `CURRENT_SUB_PHASE` is `B2a`. A step may be REAL or PARTIAL only once that sub-phase has reached it.

**The step state is computed from records.** It is never ticked by hand.

**`checkRegistry(DOMAINS, B2A_IMPL)`** checks that:
- every id resolves;
- every REAL step names an `e2eTestId` that is a word of a `test('…')` title in the end-to-end files;
- every Docker-dependent REAL step has a title in `test/nexus-exec-recipes.test.cjs` itself.

**At startup, `registryImpl.ts`** also compares `B2A_IMPL` with what main has actually registered: the planned recipes, the validators main can run, and the ingest rules (`INGEST_RULES`, with `NOT_INGESTED` naming each implemented recipe whose outputs are never ingested, and why). Any problem keeps execution off (`registry_invalid`), and nothing throws.

---

## 42. The resource gate and the test:exec gate

**The resource gate** (`src/shared/nexus/resourceGate.ts`, pure) evaluates these limits:
- 30 GiB free (32.2 GB);
- Docker missing or stopped;
- less than 4 GiB of Docker memory, or fewer than 2 CPUs;
- a missing or mismatched image.

From 30 to 40 GiB free it passes with a warning. Sizes are binary.

**What the 30 GiB limit holds (ruled, final review C2).** Below 30 GiB free, main refuses **image preparation** (`requestImage` answers `setup:disk_low` before any row is written), and `test:exec` does not run the **verification checks** (its preflight). Jobs still run: a job is leased only above its **lease floor** (`leaseFloorBytes`: 5 GiB, or twice the recipe's output cap when that is larger), below which it waits (`waiting:disk`) and #24 answers `setup:disk_low` for its action. Docker, memory, CPUs and images block jobs whatever the disk.

**What the UI says.** `nexus:platform:health` and the action availability carry the problems as actionable `setup:*` reasons with fixed sentences, for example "Docker is not running. Start Docker Desktop and try again." Below 30 GiB the renderer shows an advisory, never a blocker: "Free disk is 18 GB; preparing images and the execution checks need 30 GB (40 GB recommended)." Only "Prepare image" is unavailable ("It can be prepared once the disk has 30 GB free."). The availability stays ready, and heavy actions are not disabled for this reason. Below the lease floor the availability is `setup`, because no job starts there. The UI prints binary GB, rounded down.

**`test:exec`** is `node tools/run-exec-tests.cjs` today. The `npm run test:exec` script is part of the pending wiring.
- **The preflight.** It runs five checks and prints every failing one with exact numbers and the action to take:
  - **disk:** 30 GiB at the located Docker data volume and at the temp data home;
  - **docker:** a Linux server;
  - **memory:** 4 GiB and 2 CPUs;
  - **images:** the three images, labelled with the context hash `lock.json` pins;
  - **env:** no `NEXUS_DB_HOLD_*` variable, and the temp data home is not inside the real userData.
- **The report.** It writes `<tmp>/nexus-test-exec-preflight.json` every time.
- **The run.** It runs `test/nexus-exec-*.test.cjs` under Electron-as-node with the `test:db` rules.
- **The exit code:** 0 for a pass, 1 for a failure, and 3 for not run.
- **No bypass.** Each heavy file also runs the preflight itself (`test/helpers/execGate.cjs`), and fails when it does not pass. No environment variable skips it. Under plain node, the files print the usual skip banner.

**On this machine, test:exec has never passed its preflight.** Its last run printed `NOT RUN: free disk 3.5 GiB < 30 GiB at C:\Users\pc\AppData\Local\Docker\wsl …`, plus one line for each of the three missing images, and exited 3. So the real-Docker suites have never run: `nexus-exec-sandbox` (K1 to K11), `nexus-exec-lifecycle` (L1 to L12), `nexus-exec-recovery` (L13 to L16) and `nexus-exec-recipes` (X1 to X12).

**The images** are pinned in `infra/images/lock.json`: base digests, lockfiles, `contextSha256`, `estimatedBytes` and `versions`.
- `sde-node` is node 20.20.2 (bookworm-slim), with jest-junit and mocha-junit-reporter installed by `npm ci --ignore-scripts`. About 205 MiB.
- `sde-python` is CPython 3.11 (slim-bookworm), with pytest, build, wheel and setuptools installed by `pip --require-hashes --no-deps --only-binary`. About 150 MiB.
- `nexus-fwd` is alpine 3.20 with `socat=1.8.0.0-r0`. About 12 MiB. The socat pin is unverified, and its package hash is set at verification ([section 16](#16-known-limitations-and-operational-notes), item 31).

`tools/nexus-lock-images.cjs` fetches metadata only, and `--check` verifies the lock offline. `tools/nexus-prepare-images.cjs --build` builds through the app's own image builder, and only above the gate.

---

## 43. Python

B2a needs Python only inside the `sde-python` image, to run a repository's pytest suite and `python -m build`. Nexus itself runs no Python: `nexus_tools` is B3.
- **The host's Python is never spawned.** `test/nexus-runner-posture.test.cjs` pins that nothing under `src/main` or `src/runner` spawns `python`, `py`, `pip`, `uv` or `pytest`.
- **The environment is recorded per attempt** (constraint 8): the profile, the base digest, the context sha256, the local image id, and the image's `nexus.versions` label (for example the Python and pytest versions). The image's build self-test checks that label against the installed tools.
- **Installs** use `pip install --only-binary=:all: --require-hashes --no-deps -r /workspace/requirements.txt --target /deps` behind the A1 approval.

---

## 44. Observability map

Constraint 13 says that every job durably records the facts below. Each one is answered from stored records. Test F-OBS in `test/nexus-platform-b2a-flows.test.cjs` answers each with one query.

| Question | Stored where |
|---|---|
| Who or what started it | `jobs.requested_by` and `on_behalf_of`, and the `job.create` activity row. For a system check job, `parent_job_id` leads to the user's job. For image builds, `image_builds.requested_by` plus the approval's `decided_by`. |
| Domain and project | `jobs.project_id`, `workspace_id` and `participation_id` |
| Inputs | `job_inputs (version_id, role, content_hash)`; `jobs.params_json` (exact, with secrets refused) |
| Allowed tools | `jobs.recipe_id`, `capabilities_json` and `limits_json`; the recipe version in `environment_json`; the network mode and approval id in `sandbox_json` |
| Environment | `job_attempts.environment_json`: image id and versions, base digest, context sha256, profile, lockfile sha256, recipe id and version, Nexus version, Docker version and runner boot. It is copied to each output version's `environment_json`. |
| What actually executed | `job_attempts.sandbox_json` holds the argv (the first 200 entries, the count and the sha256), env **names**, mounts, network, limits, container id, the full preflight report and the size guard's configuration. The attempt row holds `exit_code`, `signal`, `oom_killed` and the times. Also the log (`log_path`, `log_bytes`) and the `attempt.*` events. |
| Evidence produced | `validations` (status, typed evidence, validator version, job, attempt); `version_blobs` and `blobs` |
| Why it succeeded or failed | `jobs.state`, `outcome` and `error_json`; the attempt's `outcome` and `error_json`; validation summaries; `recovery` events |
| The resulting artifact or version | `artifact_versions.produced_by_job_id` and `output_path`; `version_attempts`; `attempt.output` events; deployments by `job_id` |

---

## 45. Pending wiring

These edits are written but **not applied**. They touch files that the peer session owns: `src/main/index.ts`, `package.json` and `package-lock.json`. They wait for the peer session to commit its own changes to those files, and then for the user's approval. The full text is below, so this section needs no other source. It is the consolidated text of Tasks 5, 11, 12, 13, 14 and 15 in its final form; where two tasks differed, the later one won.

### 45.1 `package.json` and `package-lock.json`

1. **The dependency**, in `dependencies` between `"electron-updater"` and `"lucide-react"`. It is written by `npm install --save-exact fast-xml-parser@5.11.2` (a user-approved network item), which also updates `package-lock.json`. Today it is installed `--no-save`, and the runner bundles it.
```json
    "fast-xml-parser": "5.11.2",
```
2. **The script**, in `scripts` after `"test:db"`:
```json
    "test:exec": "node tools/run-exec-tests.cjs",
```
3. **The plain-node B2a tests**, appended to the end of the file list inside the `scripts.test:focused` string (one line; a leading space separates it from the last existing file):
```text
 test/nexus-core-exec-contracts.test.cjs test/nexus-core-vendor-neutral.test.cjs test/nexus-core-domain-registry.test.cjs test/nexus-domain-registry-clean.test.cjs test/nexus-core-runner.test.cjs test/nexus-core-junit.test.cjs test/nexus-runner-posture.test.cjs test/nexus-core-exec-preflight-runner.test.cjs test/nexus-core-image-lock.test.cjs test/nexus-core-exec-diagnose.test.cjs test/nexus-core-exec-entry.test.cjs test/nexus-core-git-binary.test.cjs test/nexus-core-docs-v9-names.test.cjs test/nexus-core-final-fix.test.cjs test/nexus-ui-exec-models.test.cjs test/nexus-lifecycle-rail.test.cjs test/nexus-honesty-audit.test.cjs
```
   `nexus-core-final-fix` holds the final fix round's plain-node backend tests (FF1 to FF6). The last three are the renderer's tests (Tasks 14 and 15, and the final review). All seventeen run today under `node --test test/`. The final round's real-SQLite tests (`test/nexus-platform-exec-final.test.cjs`) need no line: `test:db` picks up every `nexus-platform-*` file.

### 45.2 `src/main/index.ts`

**Imports**, beside the other `./nexusExec` and `./git` imports (merge into an existing `./git` import if there is one):
```ts
import { startExecution, type ExecutionHandle } from './nexusExec/execWiring';
import { resolveDataHome } from './nexusExec/dataHome';
import { imagesDirFor, loadImageProfiles } from './nexusExec/profiles';
import { repositoryCheck, resolveCommit } from './git';
```

**Module state**, after `let handoffsUnavailableReason ...`:
```ts
/** Why execution (schema v9) is off, for the execution channels (#24-#41); null once it is on. */
let executionUnavailableReason: string | null = 'not_enabled';
/** Main's execution wiring (runner host, data home readers); null until startExecution resolves. */
let nexusExecution: ExecutionHandle | null = null;
```

**`persist.open({ … })`**, next to `holdV7` and `holdV8`. It must never pass an explicit `false` for `enableV9` (ruling F1): that would override `V9_ENABLED_BY_DEFAULT`, and the planned default flip would silently do nothing.
```ts
      holdV9: process.env.NEXUS_DB_HOLD_V9 === '1',
      enableV9: process.env.NEXUS_ENABLE_V9 === '1' ? true : undefined,
```

**The one `registerNexusIpc(ipcMain, {` call** becomes:
```ts
registerNexusIpc(ipcMain, {
  platform: () => nexusPlatform,
  unavailableReason: () => nexusUnavailableReason,
  handoffsUnavailableReason: () => handoffsUnavailableReason,
  sources: createSourcePorts({ acceptFsRoot, getProject: (id) => projectManager.getProject(id) }),
  log: nexusMainLog,
  executionUnavailableReason: () => executionUnavailableReason,
  exec: () => nexusExecution
});
```

**The platform composition** in the startup `try` block replaces the `createNexusPlatform(...)` call and the `nexusPlatform?.startup();` line. `createNexusPlatform` receives `execution`, `isRepository: repositoryCheck` (never `isRepo`: it reports a missing git as `'git_missing'`), the data home, the pinned profiles and image contexts, `resolveCommit` and the app version:
```ts
    // B2a Task 12 (A3): the pinned sandbox profiles and image contexts from infra/images/lock.json (packaged:
    // <resources>/images); without them nothing is planned and image preparation is refused.
    const imageProfiles = loadImageProfiles(imagesDirFor({ packaged: app.isPackaged, resourcesPath: process.resourcesPath, appPath: app.getAppPath() }));
    if (imageProfiles.problem) nexusMainLog(`${new Date().toISOString()} [nexus] sandbox profiles not loaded: ${imageProfiles.problem}`);
    nexusPlatform = persist.platformAvailable
      ? createNexusPlatform(persist.platformDatabase()!, {
        log: (line) => nexusMainLog(`${new Date().toISOString()} ${line}`),
        handoffs: persist.handoffsAvailable,
        execution: persist.executionAvailable,
        executionUnavailableReason: persist.executionUnavailableReason,
        dataHome: persist.executionAvailable ? resolveDataHome(app.getPath('userData')) : null,
        profiles: imageProfiles.profiles,
        imageContexts: imageProfiles.imageContexts,
        acceptFsRoot,
        isRepository: repositoryCheck,
        resolveCommit,
        appVersion: app.getVersion()
      })
      : null;
    nexusPlatform?.startup();
    executionUnavailableReason = persist.executionAvailable ? null : (persist.executionUnavailableReason ?? 'not_enabled');
    // B2a Task 11: after `[nexus] platform ready`, once: the runner utilityProcess and the execution wiring.
    if (nexusPlatform && persist.executionAvailable) {
      void startExecution({ platform: nexusPlatform, userData: app.getPath('userData'),
        log: (line) => nexusMainLog(`${new Date().toISOString()} ${line}`),
        hintTargets: () => [...allWindows].map((win) => (win.isDestroyed() ? null : win.webContents)) })
        .then((h) => { nexusExecution = h; })
        .catch((e) => nexusMainLog(`${new Date().toISOString()} [nexus] execution did not start error=${e instanceof Error ? e.name : typeof e}`));
    }
```

The startup `catch` needs no new line: `executionUnavailableReason` is set only after `nexusPlatform?.startup()` returns, so a failed startup leaves it at `'not_enabled'`.

**Quit.** The existing `app.on('before-quit', ...)` becomes the handler below. The bounded stop is **awaited**, or dev deployments survive a fast quit (Task 11, round 1):
```ts
let quittingForExecution = false;
app.on('before-quit', (e) => {
  if (allowQuit || ptyManager.list().length === 0) {
    const h = nexusExecution;
    if (h && !quittingForExecution) {
      quittingForExecution = true;
      nexusExecution = null;
      e.preventDefault();
      const bound = new Promise<void>((resolve) => setTimeout(resolve, 10_000));
      void Promise.race([h.stop().catch(() => undefined), bound]).finally(() => app.quit());
    }
    return;
  }
  e.preventDefault();
  if (mainWindow) {
    mainWindow.focus();
    mainWindow.webContents.send('app:closeRequested', { ptyCount: ptyManager.list().length });
  }
});
```
`teardownAndQuit()` needs nothing more: it calls `app.quit()`, which enters the handler above with `allowQuit` set. `stopAllForQuit` runs synchronously first, while the store is still open, because `h.stop()` calls it before its first await.

**Comments.** The comments around the `persist.open` call that describe v7 and v8 only are refreshed to cover v9, `NEXUS_DB_HOLD_V9` and the enable switch.

### 45.3 `test/nexus-platform-composition.test.cjs`

These pins are added once `index.ts` has the lines above. They cannot pass before then.
```js
test('index.ts starts execution exactly once, after the platform startup, and hands the IPC layer its execution deps', () => {
  const idx = read('src/main/index.ts');
  assert.equal((idx.match(/startExecution\(/g) || []).length, 1);
  assert.ok(idx.indexOf('startExecution(') > idx.indexOf('nexusPlatform?.startup();'));
  assert.match(idx, /executionUnavailableReason: \(\) => executionUnavailableReason/);
  assert.match(idx, /exec: \(\) => nexusExecution/);
  assert.match(idx, /isRepository: repositoryCheck/);
  assert.match(idx, /execution: persist\.executionAvailable/);
});
```
Two more pins go with the `persist.open` lines:
- `NEXUS_DB_HOLD_V9` is honoured by main;
- the exact form `/enableV9: process\.env\.NEXUS_ENABLE_V9 === '1' \? true : undefined/` inside the `persist.open({` call, plus a ban on `enableV9: false`.

### 45.4 The default flip

The default flip comes later, as its own commit after the user's go-ahead:
- `V9_ENABLED_BY_DEFAULT = true`;
- M0 in `test/nexus-db-v9-migration.test.cjs` flips with it;
- `holdV9: true` is added where the v8-migration, phase-a, v8-schema, handoffs and activity tests assert v8 after an unheld open.

Until all of this lands, the app runs exactly as B1 did, and the execution UI reads "not connected".

---

## 46. Known limitations

The B2a limitations are items 25 to 47 of [section 16](#16-known-limitations-and-operational-notes), next to the B0b and B1 items. In short:

| Item | Limitation |
|---|---|
| 25 | v9 is opt-in, and the app does not start execution yet |
| 26 | Egress is limited to the allow-list through the Nexus proxy, but the proxy cannot see inside the TLS tunnel (domain fronting is the CDN's to refuse), the real registry path is untested, and image preparation is not limited to particular hosts |
| 27 | The discovery ceiling is about 1,300 files |
| 28 | `#41` runs blob GC only; work folders, logs and dependency caches are never reclaimed |
| 29 | A job waiting for git leaves one abandoned attempt row, then waits without being leased until main finds git |
| 30 | Docker resources from a deleted data home need manual cleanup |
| 31 | The socat pin is unverified |
| 32 | The real-Docker suites have not run (the disk is below the 30 GiB gate) |
| 33 | Windows has no `O_NOFOLLOW`; an identity re-check stands in |
| 34 | Legacy `src/main/hive.ts` still runs git by name, and the legacy diffs do not neutralise textconv or external diff drivers; neither is reachable from B2a |
| 35 to 47 | What a checkout includes (LFS files as pointers); node:test attribution; dev deployment limits; the fixed data home; no GPU; no disk quota; log caps; the entry's timeout and host sleep; the v9 triggers on a file with v9 off; older builds on v9; image build deadlines; what an install proves; the data home after a restore |

---

## 47. B2a: differences from the plan and rulings

Each item records what the code does now, and the code wins. The "Ruling" lines of the controller's ledger are binding.

| Id | Difference | Status |
|---|---|---|
| R2 | Four lineage relations are added in v9 (`covers`, `transformed_by`, `configured_by`, `monitors`). `implements` gets its documented meaning. | Implemented ([section 32.5](#325-seeds)). |
| R3 | `planned_phase` renumbering, documentation only. | Documented ([section 32.5](#325-seeds)). The v7 rows are unchanged. |
| R6 | A runner `utilityProcess` with no database, the platform and SQLite in main, and the B1 invoke surface plus one `nexus:hint` push, instead of a `window.nexus` bridge. | Implemented. |
| Opt-in | User decision: v9 is off until verification (`V9_ENABLED_BY_DEFAULT = false`, `enableV9`). | In effect. |
| `version_attempts` | Not in the plan's DDL. It was added with the constraint 4 backstops (Task 4 ruling): the three `jobs` triggers and the attempt CHECKs. | In effect. |
| `stop_reason` | The CHECK was widened before v9 shipped, so that a row stores the true end cause (Task 9 ruling). | In effect. |
| Orphan rule | **Plan R.2's orphan rule is superseded.** Removal is scoped by `nexus.home` plus a `nexus.attempt` of an ended attempt in this database (Task 10 ruling). | In effect ([section 35.5](#355-orphan-scoping)). |
| Durable exits | Durable exits are adopted for finalization whatever the Docker state. The bound is anchored to the first reconcile request, plus up to 5 minutes. | In effect. |
| RC3, RC9 | The v7 job table has no `running → queued`. A recovered running job goes through `retry_scheduled`, or is interrupted. A running main check is interrupted and queued again as a new job. | Accepted deviations. |
| Ingest timing | Ingest runs synchronously when nothing contends for the lock. It is async only for snapshots and GC waits. It always runs after the exit is durable. | Accepted. |
| Builds | A build is keyed by (commit, tree), not by tree alone (Task 12 ruling). | In effect. |
| Diagnostic report | Its edge to the application is `derived_from` (source `ingest`). The plan named `depends_on`. | In effect. |
| Wall clock | The entry reads `NEXUS_WALL_SECONDS` (an allow-listed env set by main), instead of an argv prefix. It is twice the wall clock (final batch item 2, the Task 7 R3 ruling); main's wall clock stays the authority. Sleep-like gaps are excluded up to 1 × the wall clock. Collecting is out of the wall clock, with its own 10-minute deadline (final review A3). | Accepted (Task 12 and Task 7 rulings; final fix round). |
| Disk gate | 30 GiB holds image preparation and the verification checks only; jobs run above the lease floor. The UI shows an advisory below 30 GiB ([section 42](#42-the-resource-gate-and-the-testexec-gate)). | Ruled (final review C2). |
| L5 | An outside `docker kill` is recorded as `nonzero_exit`, with exit detail `exit 137 (SIGKILL), OOMKilled false`. There is no new outcome. | Accepted. |
| Channels | `NEXUS_CHANNELS` stays 21. The 20 new channels are `NEXUS_EXEC_CHANNELS`, registered only with execution dependencies (Task 13 ruling). | In effect. |
| #33 | It answers `{ jobs }`, one check job per blocking validator, not `{ job }`. | Accepted. |
| #41 | Blob GC only. | Accepted; recorded as a limitation. |
| O18 to O22 | The Task 13 brief's O10, O12, O13, O14 and O15 are numbered O18 to O22. O21 needs `sweptAt`. | Accepted. |
| `test:focused` | Plain-node B2a tests, the renderer's three included, are not registered yet (ruling: package.json is peer-held). The exact line is in [section 45.1](#451-packagejson-and-package-lockjson). | Pending ([section 45](#45-pending-wiring)). |
| DA, ML, DL | The problem steps are REAL, because inline problem statements are real (Task 2 ruling). The Data Scientist problem step is FUTURE (B4). | In effect. |
| Agents | AgentRuntime, the Claude CLI adapter, secrets and spending caps are B2b (ruling). | Not in B2a. |

---

## 48. Deferred after B2a

| Item | Phase |
|---|---|
| AgentRuntime and the Claude CLI adapter (behind the replaceable interface), agent principals `agent:<sessionId>`, capability tokens, encrypted secret storage, spending and rate caps, the Nexus MCP server | B2b |
| Change sets: AI-assisted implementation, review, accept and iteration; the first `implements` edges; the repository write approval (`repo.write_refs`) | B2b |
| QA workflows, `covers` edges, handoff routes to QA | B2c |
| DA (B3), DS (B4), ML (B5) and DL (B6) workflows beyond the problem statements; `nexus_tools` Python; GPU use | B3 to B6 |
| An egress allow-list for image preparation (`docker build` uses the daemon's network) | Later |
| GC of work folders, logs and dependency caches; the data home relocation | Later |
| Verification items: Linux `cp -P` keeping links in `dist` (collection refuses them); the forwarder's supervising shell under real signals; the socat pin; how Windows sees container-made symlinks in `/out`; the real inspect capture for P7 | Verification |
| Temp-folder teardown in pre-B2a tests that leak `nx-*` folders | Final batch, after asking the user |
