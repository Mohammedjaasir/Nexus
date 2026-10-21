# Nexus B2–B6: six real domain workflows — architecture and implementation specification

- **Status:** a proposal for approval. **Nothing in this document is implemented.** Every sub-phase (B2a, B2b, B2c, B3, B4, B5, B6) needs explicit approval before it starts, and every schema migration needs its own approval, a verified backup and a hold switch.
- **Base:** `C:\Users\pc\munder-difflin`, branch `our-platform`, HEAD `d7abc87b`. B0a (security), B0b (platform core, schema v7) and B1 (screens on the platform, schema v8 handoffs, 21 `nexus:*` channels) are complete and approved. The user's real database is at v8.
- **Authority, in order:**
  1. The user's brief for this phase (six real domains; required flows; agent layering; evidence; production requirements; design rules; 15 deliverables).
  2. `docs/nexus/platform-core.md` and the code at `d7abc87b`. Where they disagree with an earlier plan, the code wins.
  3. The approved A–Z six-domain architecture (`nexus-six-domain-architecture.md`, revision 3), where B0b and B1 did not change it. [Section 2.6](#26-departures-from-the-a–z-architecture) lists every departure and why.
  4. The B1 plan's rulings C1–C19 and its Deferred list.
- **Constraints carried into every sub-phase:** B1 is closed (no B1 change unless a later sub-phase needs it, and each one is named); additive migrations only; no database cleanup that bypasses permissions; the two `b0b-smoke` plan rows (`proj_a8a7a6adbc58`, `proj_50dd134996e7`) and the three older orphan plans in `project_plans` stay untouched; no `appId`, `productName`, userData or `harness.db` rename; nothing launches the app or touches `%APPDATA%` outside an approved verification step on a scratch `--user-data-dir`.

### Status labels used in this document

| Label | Meaning for a lifecycle step |
|---|---|
| **REAL** | At the end of the named sub-phase, the step executes for real end to end: it runs real code on real inputs, writes immutable versions, records evidence that a validator checked, and appears in lineage and activity. |
| **PARTIAL** | The step executes for real, with a stated scope limit (for example "CPU only", "local files only", "local traffic only"). Nothing in it is simulated; the limit is printed next to the step in the UI. |
| **FUTURE** | Not built in B2–B6. The UI shows the step's position and the reason, never an enabled action or a result. |
| **Today** | The state at `d7abc87b`. Only "Project" (B0b/B1) and "Code" (B1 `git_commit` saves) are REAL today. |

**When a domain may be called complete.** A domain's workflow is "executable end to end" only when every step of its required flow is REAL or PARTIAL at the same build, and an automated end-to-end test drives the whole flow on fixtures and on one real input. Until then the workspace says which steps work and which do not. A domain is never labelled complete because a page, a module tab or a phase exists.

---

## Executive summary

### What this phase delivers

Nexus becomes an execution platform. Today it records artifacts, versions, lineage, handoffs and activity, but **nothing executes**: `jobs` and `agent_sessions` are written only by tests, Runs are session-only, Completion and Deployments are Planned (platform-core §18, §28). This document specifies how the six domains become real products on top of the B0b/B1 core:

1. **An execution layer** that B0b deferred: a scheduler with leases and heartbeats in main, a new **runner** process (an Electron `utilityProcess`) that drives Docker containers and agent runtimes but never opens the database, a content-addressed blob store, job attempts and logs, and restart recovery that adopts or finalizes running work.
2. **A replaceable agent layer:** Nexus UI → Nexus orchestration (main) → `AgentRuntime` interface → execution backend. The default runtime is the installed Claude CLI (2.1.292) run headless with a per-job configuration; every command it executes runs in a Docker sandbox through Nexus MCP tools authorized by a per-job capability token. A deterministic `ScriptedRuntime` proves the interface in tests. Hermes stays a candidate adapter behind a flag, never authoritative.
3. **A registry-driven domain engine:** one `DomainSpec` per domain (lifecycle steps, kinds, recipes, validators, capabilities, handoff routes, completion rules) drives the workspace pages, the Spine, the actions offered and the agent's context. No per-domain app.
4. **Evidence, not heuristics:** every lifecycle step is "done" only when a version of its output kind exists with every blocking validator passed. Validators parse artifacts the platform hashed (JUnit XML, `metrics.json`, `stats.json`, manifests, HTTP probes, `docker inspect` state, git ancestry); evaluation metrics come from Nexus's own evaluator in a separate job, never from the training code that produced the model.
5. **Six workflows**, delivered in approval-gated sub-phases:

| Sub-phase | Delivers | Domain state at its exit |
|---|---|---|
| **B2a** Execution core | Runner, Docker sandbox with preflight, jobs/attempts/logs, blob store, validators, domain registry, persona cleanup, repository snapshots, SDE tool jobs (tests, build, application, local dev deployment, diagnostics) | SDE steps Requirement, Project, Repository, Code, Tests, Build, Application, Dev Deployment, Logs/Diagnostics REAL (user-triggered). AI implementation, review and iteration not yet. |
| **B2b** Agent runtime and AI-assisted SDE | `AgentRuntime`, ClaudeCliRuntime, capability tokens, Nexus MCP endpoint, approvals, change sets, review, accept into an integration ref, iteration | **SDE executable end to end.** |
| **B2c** QA and the SDE ↔ QA loop | QA kinds and tables, `qa-web` image, manual and automated runs, defects, retest, regression, quality report, signed release recommendation, handoff lifecycle (convert, deliver, close, return loops), completion rules | **QA executable end to end**; flow *SDE → QA → Defect → SDE → New Build → QA → Release* REAL. |
| **B3** Data Analyst | `data-python` image with DuckDB inside, datasets, profiling, cleaning, queries with snapshots, analysis, charts, dashboards, reports, insights, export | **DA executable end to end** (local files; PARTIAL publish: file export and in-app sharing). |
| **B4** Data Scientist | `data-scientist` workspace, notebooks, statistics, pre-registered experiments, feature sets, baseline models, evaluation, reports, handoff to ML | **DS executable end to end**; DA → DS REAL. |
| **B5** ML Engineer | `ml-python` image, expectation suites, experiments, training, Nexus evaluation, model versions, validation gates, packaging, local inference service, monitoring report, ML → SDE serving handoff | **ML executable end to end** (CPU, local serving, PARTIAL monitoring); flow *DA → DS → ML → SDE → QA → Release* REAL. |
| **B6** DL Engineer | `dl-cpu` image, folder datasets, preprocessing pipelines, architectures, CPU training with checkpoints, comparison, ONNX export with parity, benchmark, int8 optimization, serving | **DL executable end to end** (CPU only; PARTIAL optimization); flow *DL → ML → SDE → QA* REAL. |

### Where Nexus stands (verified at `d7abc87b`)

- **Platform core (B0b):** 17 v7 tables; `AuthService` with a pure `decide()`; immutable versions with the F.7 status table; a 32-relation lineage DAG; 11 job states and 23 transitions; 8 session states and 14 transitions; an append-only, redacted, hash-chained activity log. The v7 `jobs` table already carries `phase`, `outcome`, `capabilities_json`, `limits_json`, `retry_json`, `progress_json`, `state_json`, `context_hash`, `runtime_kind`, `runtime_ref`; `artifact_versions` already carries `draft_flag`, `storage_kind` (`git`, `blob`, `tree`, `external`, `inline`), `validation_state`, `environment_json`, `client_key` and `output_path`. Blob, tree and external storage answer `storage_unavailable` until a blob store exists.
- **B1:** schema v8 (handoffs with receipts), user saves (`git_commit`, `text_file`), mark ready, promote, discard, source links, 21 `nexus:*` channels, the workspace authority flip, real Spine nodes, Passport, Artifacts and Handoffs pages.
- **Agents today:** interactive CLIs in host PTYs on the legacy Agents page (`spawnAgentCore` in `src/main/index.ts`). B0a's `spawnPolicy.ts` refuses shells and interpreters (`cmd`, `powershell`, `bash`, `node`, `python`, …) as engines and gates every renderer-requested binary. No headless agent path exists; `policy.ts` refuses every agent principal with `agent_requires_token`.
- **Legacy registry:** `src/shared/domain.ts` holds 16 legacy domain ids with role preambles, and still carries persona fields: `character` on 31 roles, `leadCharacter`, `departmentName` and `departmentRoom` on each domain, and an import of `OfficeCharacterName` from the renderer's office scene. `src/main/routing/taskRouter.ts` copies `role.character` into `PreparedAgentConfig.character` (`src/shared/routing.ts`). Removal is task B2a-T2.

### Host facts (read-only checks on 2026-10-08)

| Item | Found | Consequence |
|---|---|---|
| OS, CPU, RAM | Windows 11 Home, i7-13620H, 15.7 GB RAM | 16 GB-class laptop; CPU training only by default |
| Docker | Docker Desktop, engine 29.7.2, Linux server on WSL2 (default distro Ubuntu, WSL 2); 16 CPUs and **7.6 GiB** memory given to the Docker VM; about 10 unrelated containers already running (Postgres, SQL Server, a Supabase stack) | The sandbox prerequisite is met; the scheduler must size job memory from `docker info` and leave room for the user's own containers |
| Disk | C: 448 GB, **19 GB free (96 % used)**; no second drive | The largest practical risk. Images for all profiles need about 8–10 GB unpacked; blobs, logs and dependency caches come on top. See decision D11 |
| Git | 2.55.0.windows.3 | Meets the worktree and `update-ref` CAS needs |
| Node | 20.20.2 (npm 10.8.2); Electron 32.3.3 | The runner runs on Electron's own Node; no system Node is used for product execution |
| Python (host) | 3.11.6 with torch 2.11, scikit-learn 1.9, pandas 3.0.3, polars 1.40, pyarrow 24, onnx 1.22, onnxruntime 1.28, pytest 9.0.3, matplotlib; **no duckdb**; uv 0.11.32 | Not used for product execution (no isolation, not pinned). uv is used only to build image lockfiles |
| GPU | NVIDIA GeForce RTX 3050 Laptop, 4 GB, driver 610.78; `docker info` lists only the `runc` runtime | GPU passthrough into containers is **unverified**; GPU stays FUTURE (decision D4) |
| Agent CLI | Claude Code 2.1.292 on PATH | The default runtime's binary is present; headless flags are pinned by a contract test, not assumed |
| Hermes | Spike folder `C:\Users\pc\nexus-hermes-spike` present; `hermes` not on PATH; image `nousresearch/hermes-sandbox:desktop` (4.37 GB) present | Hermes is a candidate only; spike verdict CONDITIONAL GO, single-user |
| DuckDB | No CLI on the host | DuckDB lives only inside the `data-python` image (decision D3) |

### The design in brief

- **State stays where B0b put it.** Platform services and the single SQLite connection stay in Electron main. The new runner process executes but never opens the database; it reports facts (exit codes, hashes, heartbeats, runtime events) over a `MessagePort`, and main decides every state transition inside an IMMEDIATE transaction.
- **Execution is sandboxed and default-deny.** Every recipe, every agent command and every service runs in a Docker container: non-root, read-only root filesystem, `--cap-drop ALL`, `no-new-privileges`, CPU, memory and PID limits, `--network none`, read-only inputs, one writable `/out`. A mandatory `docker inspect` preflight refuses any container whose limits or network do not match. There is no host fallback and no host mode.
- **Agents act only through tokens.** An agent run gets a capability token (user role ∩ domain ceiling ∩ job grant ∩ availability) and reaches Nexus only through the MCP endpoint. It can edit files in its worktree, execute in its container, request recipes, register drafts and request approvals. It can never promote, accept, sign, close, merge or reach the network.
- **Evidence decides.** Draft → candidate happens only when every blocking validator passed on platform-hashed evidence. Candidate → active is a user action. Completion is a predicate over records.
- **Handoffs stay by reference.** B1 receipts are kept; B2c adds conversion to work (the subjects become job inputs, so lineage follows automatically), delivery, closing and return loops.

### Recommended first sub-phase

**B2a — Execution core, registry and the SDE tool path.** It builds what every domain needs (runner, sandbox, jobs, blob store, validators, registry), it needs no model credential and no new runtime, and it turns nine of the twelve SDE steps into REAL user-triggered jobs on the user's own repositories. Its risks (Docker on Windows, disk, recovery, preflight) are the platform's real risks, so they are retired first. It does not claim SDE is complete: AI implementation, review and iteration arrive in B2b. Full argument in [section 15.9](#159-recommended-first-sub-phase).

### Decisions the user must make before B2a

Docker as a hard requirement (D1), the Python environment strategy (D2), DuckDB placement (D3), GPU policy (D4), per-job network policy (D5), the runtime (D6), new npm dependencies (D7), image distribution (D8), the agent credential (D9), the Data Scientist workspace id (D10), the data home and disk (D11), new lineage relations (D12), and preview networking (D13). Each has a recommended answer in [Decisions needed](#decisions-needed), followed by the six points that conflict with B0b/B1 and need a ruling.

---

## 1. Domain architecture

### 1.1 What a domain is

A domain is **data plus a small amount of registered code**, not an app:

- **Data:** one `DomainSpec` (type in [section 12.9](#129-the-domain-registry-contract)) in `src/shared/nexus/domains/<id>.ts`: its lifecycle steps, the kinds it produces and accepts, its capability ceiling, its recipes, skills, validators, handoff routes, completion rules and workspace modules, plus its vocabulary ("Run" in ML, "Training run" in DL, "Notebook" in DS).
- **Code, registered by id:** recipe definitions (argv templates for pinned images), output parsers, validators and folio viewers. A spec can reference only ids that resolve; a boot check and a unit test fail on any unresolved id or on any step marked REAL without a registered implementation and an end-to-end test id.

The platform core is the same for every domain: participations, artifacts, versions, lineage, jobs, sessions, validations, approvals, handoffs, activity. A DA query job and an ML training job are both `tool.run` jobs with different recipes, images, validators and vocabulary.

**A lifecycle step is a state over records.** `step.done ⇔ ∃ version v of a kind in step.produces, owned by the participation, with v.status ∈ {candidate, active} and every blocking validator of v passed`. Steps that are user decisions (review, sign, select) are done when their record exists (`reviews`, `release_recommendation` signed by a user principal, a `selected_from` edge). The lifecycle rail in the UI is computed from these facts; nothing is ticked by hand or by an agent.

### 1.2 Workspaces and ids

| Domain | Workspace id | Status today | Hue slot | Note |
|---|---|---|---|---|
| Software Development Engineer | `sde` | seeded (v7) | 0 | unchanged |
| QA/Test Engineer | `qa` | seeded (v7) | 5 | unchanged |
| Data Analyst | `data` | seeded (v7) as "Data Analytics" | 3 | **kept as the DA workspace and relabelled "Data Analyst"** (decision D10) |
| Data Scientist | `data-scientist` | new row in B4's migration | 8 (max + 1) | legacy `data-science` projects move their primary here only with ruling R1 |
| ML Engineer | `ml` | seeded (v7) | 1 | unchanged |
| DL Engineer | `dl` | seeded (v7) | 2 | gains the legacy id `deep-learning` in the live map |
| Registry-only | `research`, `uiux`, `devops` | seeded (v7) | 4, 6, 7 | shown as "Not yet a supported workflow", no modules, no actions |

### 1.3 SDE (`sde`)

**Purpose.** Turn a requirement into reviewed, tested, built and running code, with every claim backed by commits, test reports, build manifests and health checks.

| # | Step | Output (kind) | How it runs | Evidence recorded | Label | Sub-phase | Prerequisites; when missing |
|---|---|---|---|---|---|---|---|
| 1 | Requirement | `requirement` | User writes it in Nexus (`nexus:artifact:saveInline`), saves a Markdown file (B1 `text_file`, then converts), or an agent drafts it (B2b) for user review | content hash; `req.schema` (title, ≥ 1 acceptance criterion with a stable id) | REAL | B2a (user), B2b (agent draft) | none |
| 2 | Project | project row + SDE participation | Existing B0b/B1 import and attach | `projects` row, `project_workspaces` row, activity | REAL (today) | — | none |
| 3 | Repository | `repository` (project-owned) | System recipe `repo.snapshot` (engine-side, async git) on import and whenever a job needs code newer than the last snapshot | HEAD commit, branch, dirty flag, `git.head_resolves`; from B2b the integration ref `nexus/accepted/<branch>` and `contains` edges from `git merge-base --is-ancestor` | REAL | B2a | git (present); missing or not a repository → the step shows "This folder is not a git repository" and no code step is offered |
| 4 | Code | `git_commit` (B1) and repository versions | User commits; B1 "Save as artifact"; code jobs check out the exact commit in a clean worktree | commit sha, tree hash | REAL (today for saves); REAL for jobs in B2a | B1, B2a | git |
| 5 | AI-assisted implementation | `change_set` (draft) | `agent.run` with skill `nexus-sde-change` in worktree branch `nexus/job/<jobId>` off the integration ref; the agent edits files, runs commands in its container through `sandbox.exec`, requests test recipes, registers the change set | base and head shas, diffstat, `git.diff_nonempty`, `git.paths_in_scope`, `sec.secret_scan`; context hash, skill hashes, model id, token usage, transcript blob hash (display only) | REAL | B2b | Docker, `sde-node`/`sde-python` image, Claude CLI, credential (D9). Missing → "Agent runs need: <item>"; no run starts |
| 6 | Tests | `test_suite` (discovered tests at a commit) and validation results on the code version | `tool.run` `sde.test.discover` then `sde.test.npm` / `sde.test.pytest` in a clean checkout, network none, dependency cache read-only | JUnit XML sha256 parsed into counts; discovery list sha256; `sde.tests_pass` (≥ 1 test executed, failed + errored = 0, counts match discovery); exit code cross-checked; image digest; lockfile hash | REAL | B2a (any commit), B2b (agent change sets) | Docker, image, installed dependencies (`sde.deps.*` with approved egress, D5). Missing dependencies → `failed: deps_missing` with the install action |
| 7 | Review | `reviews` row; change set `active` via Accept | User reviews the diff and evidence in the Folio; Accept merges into `nexus/accepted/<branch>` in a Nexus worktree (never the user's branch); Request changes starts a new agent turn with the comments | reviewer principal (a user), decision, comment hash; merge commit sha; `git.applies_cleanly`; integration-ref CAS (`git update-ref <ref> <new> <old>`) | REAL | B2b | git; a repository-write approval once per project (A3) |
| 8 | Build | `build` | `tool.run` `sde.build.node` / `sde.build.python` on a repository snapshot of the integration ref (or of a commit in B2a) | exit 0; output tree manifest (per-file sha256) and its hash; image digest; lockfile hash; commit; duration | REAL | B2a | Docker, image |
| 9 | Application | `application` | `ingest` `sde.app.assemble` reads `nexus.app.json` from the built commit | manifest schema (`app.manifest_schema`: run argv, port, health path, env names only); build version ref; manifest hash | REAL | B2a | a `nexus.app.json` in the repository. Missing → the step says so and offers "Draft nexus.app.json" (an agent turn, B2b) |
| 10 | Dev deployment | `deployments` row (`local-preview`) for an application version | Service job `sde.preview.start` on an internal network; a Nexus forwarder publishes the port on 127.0.0.1 only | container running (`docker inspect`), forwarded port bound to 127.0.0.1, HTTP probe status and latency on the declared health path within 60 s (`app.preview_health`), image digest | REAL (local scope) | B2a | Docker, `nexus-fwd` image; remote or multi-service environments are FUTURE |
| 11 | Logs/diagnostics | job logs (byte ranges) and `diagnostic_report` | Logs stream from the service container into the attempt log; `sde.diagnose` (engine-side) snapshots inspect state, exit code, OOM flag, restart count, the health-probe series and hashed log ranges | the report's fields, each from `docker inspect`, the probe table or a log byte range; nothing inferred from text | REAL | B2a | a deployment or a failed job to diagnose |
| 12 | Iteration | new `change_set` with `derived_from` the previous change set, `fixes` a defect, or inputs that include a `diagnostic_report` or review comments | `agent.run` turn or new session with those versions as inputs | edges written from job inputs (`job_input` source) | REAL | B2b | as step 5 |

**At the end of B2b, SDE is executable end to end** for repositories whose tests produce JUnit (npm with a JUnit reporter, pytest) and whose app declares `nexus.app.json`. Other test frameworks are added as recipes; until then the Tests step says "No supported test runner was found in this repository" and offers nothing fake.

### 1.4 QA/Test Engineer (`qa`)

**Purpose.** Decide, with computed evidence, whether a specific build is fit to release.

| # | Step | Output (kind) | How it runs | Evidence recorded | Label | Sub-phase | Prerequisites; when missing |
|---|---|---|---|---|---|---|---|
| 1 | Application/build intake | `handoff_receipt` (B1) for `application` + `build` versions; a conversion job | SDE sends a handoff (action `test`); QA accepts (B1 receipt); "Convert to work" creates the first QA job with the subjects as inputs | handoff id, subject version ids and content hashes, receipt version, conversion job id | REAL | B2c (send and accept are REAL today) | an active QA participation |
| 2 | Test plan | `test_plan` v1 bound to the **application artifact** (not to one build) | User writes it, or agent skill `nexus-qa-plan-from-requirements` drafts it from the requirement and application versions | `qa.plan_schema` (scope, application artifact, requirement refs, entry criteria) | REAL | B2c | none |
| 3 | Strategy | `test_plan` v2 (owner revise) with a `strategy` block | User or agent adds risks, test levels, environments and numeric exit criteria | `qa.strategy_complete`: every requirement criterion maps to ≥ 1 level; exit criteria numeric (max open defects per severity, min pass rate, required automated share) | REAL | B2c | none |
| 4 | Test cases | `test_case` artifacts (manual steps or an automation id), each `covers` a requirement criterion | User, or agent skill `nexus-qa-cases-from-requirements` / `nexus-qa-cases-from-openapi` | `qa.case_schema`; for automated cases `qa.case_refs_resolve` (the id appears in the discovery output of the QA test suite commit) | REAL | B2c | none |
| 5 | Execution | `test_run` (one artifact per execution) + `test_results` rows | Manual: user creates a run for an application version, records each case (outcome, note, attachments), submits. Automated: `qa.pytest.api` / `qa.playwright` against a preview of that application version on an internal test network | per-result rows; JUnit sha256; `qa.counts_consistent` (counts = rows); `qa.build_bound` (run names the build and application versions and the preview deployment that served exactly that build) | REAL | B2c | Docker, `qa-web` image, a running preview (manual runs need none) |
| 6 | Automation | QA-owned `test_suite` (test code in `tests/**`, `e2e/**`) registered from a QA `change_set` | Agent skills `nexus-qa-pytest-author`, `nexus-qa-playwright-author` in a worktree; `qa.collect` discovers ids | discovery list hash; `git.paths_in_scope`; `sec.secret_scan`; user review of the test code | REAL | B2c | Docker, `qa-web`, runtime and credential |
| 7 | Defect | `defect` artifact + `defects` row | From a failing `test_results` row: agent `defect.propose` (draft) and user confirm, or user creates | `qa.defect_links` (failing result id, build version, case, severity present) | REAL | B2c | a failing result |
| 8 | Retest | `test_run` on a newer build | `qa.rerun.cases` for the defect's linked cases on the application version SDE handed back | `qa.retest_newer_build`: the case passed on a build with a higher `version_no` whose repository snapshot `contains` the change set that `fixes` the defect (git ancestry, not commit messages) | REAL | B2c | a new application version received |
| 9 | Regression | `test_run` covering every plan case + `regression_report` | Full automated suite plus a manual run on build N+1; `qa.regression.compute` (engine-side SQL) compares with build N | per-case transitions (new failure, fixed, still failing, flaky); `qa.report_numbers_engine_computed` recomputes them | REAL | B2c | previous build's runs |
| 10 | Quality report | `quality_report` for one build | `qa.report.compute` (engine-side); optional agent narrative (display only) | computed pass rate, counts, open and unverified defects by severity, plan execution %, coverage when a report exists; recomputed by the validator | REAL | B2c | runs on that build |
| 11 | Release recommendation | `release_recommendation` (`go`, `no-go`, `go-with-conditions`) | User signs (`nexus:qa:sign`); agents cannot | signer is a user principal (`qa.signed_by_user`); `based_on` the active quality report; `recommends` the build | REAL | B2c | an active quality report |

**At the end of B2c, QA is executable end to end** for web applications and HTTP APIs (pytest API tests, Playwright with Chromium). Cross-browser matrices, mobile and issue-tracker sync are FUTURE.

### 1.5 Data Analyst (`data`, shown as "Data Analyst")

**Purpose.** Answer a business question with reproducible queries over versioned data, and publish the answer.

| # | Step | Output (kind) | How it runs | Evidence recorded | Label | Sub-phase | Prerequisites; when missing |
|---|---|---|---|---|---|---|---|
| 1 | Business question | `problem_statement` (DA view "Business question") | User writes; agent may draft | `problem.schema` (question, decision it informs, success measure, time window) | REAL | B3 | none |
| 2 | Data source | `dataset` v1 | User picks a CSV, Parquet, XLSX or JSONL file or a folder in a **main-process dialog** (`nexus:dataset:register`); `data.register` stream-hashes it into the blob store, or records an `external` manifest above the size cap | sha256 per file, bytes, manifest hash; `data.manifest_hashed` | PARTIAL: local files and folders only; database and cloud connectors FUTURE | B3 | disk space for blobs; above the cap the file stays in place and is re-checked by size and mtime before and after every job |
| 3 | Inspection | dataset profile (draft metadata) and validations | `data.profile` in `data-python` (DuckDB): schema, row count, null and distinct rates, min, max | `profile.json` sha256; `data.readable`, `data.schema_inferred`, `data.profile_computed` | REAL | B3 | Docker, `data-python` image |
| 4 | Cleaning | `query` (purpose `transform`) + derived `dataset` (`derived_from`, `transformed_by`) | User or agent (`nexus-da-duckdb-sql`) writes SQL; `data.derive` runs it read-only and writes Parquet | SQL sha256; `da.sql_readonly` (one `SELECT`/`WITH` statement; `COPY`, `ATTACH`, `INSTALL`, `LOAD`, `PRAGMA`, `CREATE`, `EXPORT`, `SET` refused by a tokenizer, not a regex); row counts before and after; output sha256 | REAL | B3 | as step 3 |
| 5 | Query | `query` v*n* with a result snapshot | `da.query.run` binds named dataset versions and writes `result.parquet` + `result.json` | `da.sql_readonly`, `da.sql_explains`, `da.result_snapshot` (snapshot sha256, row count, column types, `truncated` flag at 5 M rows) | REAL | B3 | as step 3 |
| 6 | Analysis | `analysis` (SQL set or a script from a pinned commit) | `da.analysis.run` writes `summary.json` and figures | `da.analysis_ok` (exit 0, `summary.json` schema, figure hashes) | REAL | B3 | as step 3; scripts run with network none |
| 7 | Visualization | `chart` (Vega-Lite spec bound only to query snapshots) | Agent `nexus-da-chart-vegalite` or user writes the spec; `da.chart.render` renders SVG and PNG in the image (vl-convert) | `da.vegalite_schema`; `da.bindings_resolve` (every `data.url` is `nexus:query/<versionId>` of a candidate or active query; no inline `values`); `da.render_ok` (render sha256) | REAL (static rendering; interactive charts FUTURE, decision D7) | B3 | as step 3 |
| 8 | Dashboard/report | `dashboard` (layout of chart versions) and/or `report` (Markdown with reference tokens `{{nexus:query/<vid>#<selector>}}`) | `report.render` resolves every token against snapshots and renders sanitized HTML | `da.dashboard_bindings`; `report.refs_resolve` (every token resolves to a stored value); advisory `report.unreferenced_numbers` | REAL | B3 | as step 3 |
| 9 | Insight | `insight` (claim + evidence refs) | User or agent `nexus-da-insight` | `insight.has_evidence` (≥ 1 resolvable reference to a query, chart, analysis or dataset version) | REAL | B3 | none |
| 10 | Publish/share | export bundle (activity `export`) and handoffs | `export.bundle` writes sanitized HTML plus referenced snapshot files to a temp folder; main shows a save dialog; sharing inside Nexus is a handoff to DS, ML or another workspace | bundle sha256, file list hash; handoff ids | PARTIAL: file export and in-app handoff; hosted links and scheduled refresh FUTURE | B3 | none |

**At the end of B3, DA is executable end to end** on local files.

### 1.6 Data Scientist (`data-scientist`)

**Purpose.** Establish what is true in the data (statistics, experiments) and what a baseline model can predict, reproducibly, and hand productionizable results to ML. DS models are baselines: never packaged or served (`model.package` is not in the DS ceiling).

| # | Step | Output (kind) | How it runs | Evidence recorded | Label | Sub-phase | Prerequisites; when missing |
|---|---|---|---|---|---|---|---|
| 1 | Business problem | `problem_statement` (DS view "Business problem") | User or agent | `problem.schema` | REAL | B4 | none |
| 2 | Acquisition | `dataset` (registered, or a DA dataset used **by reference** through a handoff) | As DA step 2, or a handoff receipt whose subjects become job inputs | as DA step 2; handoff subject hashes | PARTIAL: local files and handoffs; external connectors FUTURE | B4 | as DA |
| 3 | Exploration | `analysis` (notebook) | Notebook in a DS `change_set` (`notebooks/**`); `ds.notebook.run` (papermill, injected `seed` and `data_dir`), nbconvert to sanitized HTML | executed ipynb sha256; `ds.notebook_no_error_cells`, `ds.params_recorded`, `ds.seed_recorded` | REAL | B4 | Docker, `data-python` |
| 4 | Cleaning | derived `dataset` | as DA step 4 | as DA step 4 | REAL | B4 | as above |
| 5 | Feature engineering | `feature_set` (a dataset view with declared label, feature columns and post-outcome columns) | `data.derive` with feature SQL or a feature script at a commit | manifest; `fs.schema` (label declared, features listed); advisory `data.feature_leakage` (post-outcome columns, label-identical columns, per-row unique ids) | REAL | B4 | as above |
| 6 | Statistical analysis | `analysis` (form `stats`) | `ds.stats.describe` writes `stats.json` (descriptives, correlations, distribution tests) | `ds.stats_schema` (every number finite, test names from an enum, n per group) | REAL | B4 | as above |
| 7 | Experiment | `experiment` v1 (pre-registration: H0, H1, test, alpha, minN, metric, groupBy) → v2 (result) | User pre-registers (`saveInline`); `ds.stats.test` computes the result | `ds.hypothesis_schema`; `ds.hypothesis_preregistered` (v1 committed before the result job was created; otherwise the result is labelled exploratory, never hidden); `ds.min_sample`; `ds.stats_schema` | REAL | B4 | as above |
| 8 | Modeling | split `dataset`s (`data.split`) and baseline `model` versions | `data.split` (seed, strategy); `ds.train.baseline` (scikit-learn estimators from an enum) | split manifests; `data.split_disjoint` (no shared row hash); model file sha256, `signature.json`; `ds.model.baseline` (load and predict 32 rows in a fresh container) | REAL (CPU, scikit-learn baselines) | B4 | as above |
| 9 | Evaluation | `evaluation` | `ds.evaluate` — Nexus's evaluator, a separate job from training, on the held-out split | `eval.disjoint` (row-hash overlap with the training split = 0), `eval.metrics_schema`, `eval.bound_dataset` | REAL | B4 | as above |
| 10 | Insight/model | `insight` and/or a promoted `model` | User promotes after review | insight evidence refs; promotion record | REAL | B4 | none |
| 11 | Report | `report` with reference tokens | Agent `nexus-ds-report` drafts; `report.render` resolves tokens | `report.refs_resolve` | REAL | B4 | as above |
| 12 | Handoff | handoff to ML (`productionize`: model, evaluation, feature set) or DA (`inform`) | B1 send, B2c lifecycle | subject hashes; receipt | REAL | B4 | an ML or DA participation |

**At the end of B4, DS is executable end to end**; DA → DS is REAL.

### 1.7 ML Engineer (`ml`)

**Purpose.** Turn data and a problem into a validated, packaged, served and monitored model, with a reproducible record of every run.

| # | Step | Output (kind) | How it runs | Evidence recorded | Label | Sub-phase | Prerequisites; when missing |
|---|---|---|---|---|---|---|---|
| 1 | Problem | `problem_statement` (ML view: task type, primary metric and direction, acceptance thresholds) | User or agent | `problem.schema` incl. thresholds | REAL | B5 | none |
| 2 | Dataset | `dataset` (registered or handed off) | as DA step 2 / DS step 2 | as there | REAL | B5 | `ml-python` image |
| 3 | Data validation | `expectation_suite` + validation results on the dataset version | User or agent writes expectations (types, null rate bounds, value ranges, uniqueness, row-count bounds, allowed categories); `ml.data.validate` evaluates them with DuckDB | `checks.json` sha256; one validation result per expectation with the **observed** value and the bound | REAL | B5 | as above |
| 4 | Data prep/feature engineering | `feature_set` + split `dataset`s | `data.derive`, `data.split` | as DS steps 5 and 8 | REAL | B5 | as above |
| 5 | Experiment | `experiment` (search space, primary metric, baseline evaluation ref) | User or agent | `ml.experiment_schema` | REAL | B5 | none |
| 6 | Training | `training_run` (one artifact per run) and a `model` version | Training code in an ML `change_set` (`ml/**`) at an accepted commit; `ml.train` runs `python <entry>` in `ml-python` with network none; the run writes `metrics.json`, `signature.json` and the model file to `/out` | exit; `ml.metrics_schema` (training metrics are **reported**, labelled so); model sha256; params; seed; image digest; lockfile hash; wall time | PARTIAL: CPU only; GPU FUTURE | B5 | Docker, image; project-specific packages through `ml.deps.python` with approved egress |
| 7 | Evaluation | `evaluation` | `ml.evaluate`: Nexus's evaluator loads the model in a fresh container and scores the test split | `eval.disjoint`, `eval.metrics_schema`, `eval.bound_dataset`; metric values computed by Nexus code | REAL | B5 | as above |
| 8 | Model version | `model` v*n* (model file + signature) | Registered by the training job; `ml.model.load_infer` | `ml.model_file_hashed`, `ml.signature_schema`, `ml.model.load_infer` (load and predict on samples in a fresh container; output shapes match the signature) | REAL | B5 | as above |
| 9 | Validation | promotion-gate validator results | Run at promote: `ml.no_regression{baseline}` (primary metric of this model's evaluation ≥ baseline − tolerance), `ml.thresholds_met` (problem thresholds), `ml.slice_parity` (when slices are declared) | metric values with pointers into the evaluation's `metrics.json` | REAL | B5 | an evaluation |
| 10 | Packaging | `serving_package` | `ml.package` with template `pkg.sklearn-predict@1` or `pkg.onnx-predict@1` | bundle sha256; `ml.pkg.lockfile_pinned`, `ml.pkg.size_cap`; `ml.pkg.predict_runs`, `ml.pkg.deterministic` (identical outputs ×3) | REAL | B5 | as above |
| 11 | Serving/API | `inference_service` + a deployment | `ml.serve.start` runs the package's FastAPI template as a service job (internal network + forwarder on 127.0.0.1); `ml.serve.contract` sends the signature's sample requests | container state; `/health` 200; `/predict` responses validate against the signature; latency p50/p95 on the samples | REAL (local); the SDE application route (ML → SDE `create-api`) is REAL too | B5 | `nexus-fwd` |
| 12 | Monitoring | `monitoring_report` (`monitors` the inference service) | The template appends one JSON line per prediction to a mounted log; `ml.monitor.compute` computes request count, error rate, latency p50/p95 and input drift (population stability index per feature against the training split's reference histogram) | the prediction log byte range and sha256; computed numbers recomputed by the validator | PARTIAL: local traffic only (sample sets sent through Nexus, or calls to the local endpoint); no alerting, no schedule, no production traffic | B5 | a running service |
| 13 | Iteration | new `experiment` / `training_run` that `depends_on` the monitoring report or evaluation, `derived_from` the previous run | user or agent | edges from job inputs | REAL | B5 | as above |

**At the end of B5, ML is executable end to end** (CPU, local serving, PARTIAL monitoring), and DA → DS → ML → SDE → QA → Release is REAL.

### 1.8 DL Engineer (`dl`)

**Purpose.** Train, compare, export, optimize and serve neural networks with checkpoints and parity evidence.

| # | Step | Output (kind) | How it runs | Evidence recorded | Label | Sub-phase | Prerequisites; when missing |
|---|---|---|---|---|---|---|---|
| 1 | Problem | `problem_statement` (DL view: task, input modality and shape, metric, latency budget) | User or agent | `problem.schema` | REAL | B6 | none |
| 2 | Dataset | folder `dataset` (`tree` manifest: per-file sha256; labels file) | `data.register.folder` | manifest hash; class counts | REAL | B6 | disk; large folders stay `external` |
| 3 | Dataset prep | split `dataset`s (stratified, seed) | `data.split` | `dl.labels_resolve` (every file labelled); `data.split_disjoint` (no shared file hash) | REAL | B6 | `dl-cpu` image |
| 4 | Preprocessing | `preprocessing_pipeline` (config or code at a commit) + preprocessed `dataset` (`transformed_by` the pipeline) | `dl.preprocess` | output manifest; `dl.pipeline_deterministic` (re-running a sample gives identical tensor hashes); recorded output shapes and dtype | REAL | B6 | as above |
| 5 | Architecture/config | `architecture` (model code ref + config) | `dl.arch.check` instantiates the model and runs one forward pass on the declared input shape | parameter count, output shape, FLOPs estimate from the framework's profiler, all computed in the container | REAL | B6 | as above |
| 6 | Training | `training_run` + `checkpoint` versions | `dl.train.cpu`; progress from `metrics.jsonl`; resume through `dl.resume` | `dl.metrics_monotonic_steps`, `dl.no_nan_loss` (a NaN or Inf loss fails the run as `diverged`); seed; image digest | PARTIAL: CPU only; GPU FUTURE (D4) | B6 | 4 GiB job memory; one training job at a time |
| 7 | Checkpoint | `checkpoint` (one artifact per run, a version per saved epoch; not single-active) | Ingested per epoch | sha256; `dl.ckpt_loads` (fresh container) | REAL | B6 | as above |
| 8 | Evaluation | `evaluation` | `dl.evaluate` (Nexus evaluator, torch or ONNX) | `eval.*` validators; per-class metrics | REAL | B6 | as above |
| 9 | Experiment comparison | `experiment` v*n* with the compared runs and the user's selection | Engine computes the comparison table from stored metrics; the user selects | `dl.comparison_engine_computed`; selection by a user principal | REAL | B6 | none |
| 10 | Model version | `model` (selected checkpoint; same blob, no copy) | `nexus:checkpoint:select` | `selected_from` edge; `dl.ckpt_loads` | REAL | B6 | none |
| 11 | Export | `model_export` v1 (ONNX fp32) | `dl.export.onnx` then `dl.parity` | `dl.onnx_checker`; `dl.parity` (max absolute difference ≤ tolerance on N fixed samples) | REAL | B6 | as above |
| 12 | Inference | `benchmark` | `dl.benchmark` on fixed inputs | latency p50/p95, throughput, output sha256, CPU model name, thread count | REAL (CPU) | B6 | as above |
| 13 | Optimization | `model_export` v2 (dynamic int8) + `benchmark` + `evaluation` | `dl.quantize`, then benchmark and evaluate | `dl.quant_delta` (accuracy drop ≤ threshold from two Nexus evaluations); latency change | PARTIAL: ONNX Runtime dynamic int8 only; pruning, distillation, static quantization FUTURE | B6 | as above |
| 14 | Serving | `inference_service` (ONNX Runtime template) | `dl.serve.start` + `dl.serve.contract` | as ML step 11 | REAL (local) | B6 | `nexus-fwd` |
| 15 | Iteration | new `training_run` `resumed_from` a checkpoint, or a new architecture version | user or agent | edges | REAL | B6 | as above |

**At the end of B6, DL is executable end to end** (CPU, PARTIAL optimization), and DL → ML → SDE → QA is REAL.

### 1.9 Production requirements per domain

Every domain uses the shared mechanisms of [sections 2](#2-shared-platform-architecture), [5](#5-state-machines), [7](#7-validation-strategy), [12](#12-execution-architecture) and [13](#13-security-model). This matrix states what each requirement concretely means per domain.

| Requirement | SDE | QA | DA | DS | ML | DL |
|---|---|---|---|---|---|---|
| **Persistent state** | `artifacts`/`artifact_versions` (requirement, repository, change_set, test_suite, build, application, diagnostic_report); `change_set_accepts`; `deployments`; jobs, attempts, logs | test_plan, test_case, test_run, defect, regression_report, quality_report, release_recommendation; `test_results`, `defects` | dataset, query, analysis, chart, dashboard, report, insight; blobs with snapshots | as DA + feature_set, experiment, model, evaluation; `experiment_conclusions` | as DS + expectation_suite, training_run, serving_package, inference_service, monitoring_report; `metrics` | as ML + preprocessing_pipeline, architecture, checkpoint, model_export, benchmark |
| **Versioning** | change set = own artifact, revise on request changes; build v = (commit, lockfile, image) → output hash; repository = snapshot of the integration ref | plan revised by QA; one artifact per run, case, defect; one quality report and recommendation artifact per application, a version per build | dataset re-registration appends by content hash; derived = new artifact; query version per (SQL hash, bound versions) | experiment v1 = pre-registration, v2 = result; one model artifact per estimator | one model artifact per experiment, a version per run; package version per (model version, template) | checkpoint version per epoch (all stay selectable); export v1 fp32, v2 int8 |
| **Lineage** | `implements` (change set → requirement), `derived_from`, `contains`, `built_from`, `assembled_from`, `fixes` | `tests`, `executes`, `covers`, `found_in`, `evidenced_by`, `verified_by`, `summarizes`, `recommends`, `based_on` | `queried_from`, `transformed_by`, `analyzes`, `visualizes`, `cites` | as DA + `tested_on`, `trained_on`, `evaluates`, `evaluated_on` | `run_of`, `trained_on`, `produced_by`, `evaluates`, `packages`, `serves`, `monitors` | `transformed_by`, `configured_by`, `produced_by`, `resumed_from`, `selected_from`, `exported_from`, `evaluates` |
| **Permissions** | user: member on the SDE participation; agent: token with `code.edit` (all paths), no promote/accept | user signs; agent drafts plans, cases, defects only | agent `sql.query` read-only; user promotes | agent `stats.run`, `model.train.cpu` (baseline); no packaging | agent trains and packages; user promotes and serves | agent trains, exports; user selects checkpoints and promotes |
| **Failure handling** | test failure keeps the change set out of candidate; merge conflict keeps it candidate with `merge_conflict`; unhealthy preview fails the application version | infra error (JUnit `<error>`) separated from product failure; JUnit missing → `invalid_output`; flaky flagged, never auto-cleared | non-read-only SQL refused before execution; snapshot over cap → `result_too_large`; input changed during job → `input_changed` | notebook error cell → version `failed`; train/test overlap → failed; n < minN → failed | OOM (exit 137 or `OOMKilled`) → `failed: oom`; metrics missing → `invalid_output`; regression vs baseline blocks promote | NaN loss → `failed: diverged`; parity failure blocks promote; corrupt checkpoint fails `dl.ckpt_loads` |
| **Retries** | idempotent recipes (snapshot, discover, build ingest) ×3 with backoff; tests and agent runs never auto-retry | collect ×2; test runs never auto-retry (re-run = explicit new job); rerun with repeats is a separate recipe | profile, query ×2 | stats, evaluate ×2; notebooks never | evaluate, package, validate ×2; training never | evaluate, export, parity ×2; training never (resume is the recovery path) |
| **Cancellation** | J.5 table: agent run → runtime cancel then container stop; drafts kept as `cancelled_partial`; preview stop | runs cancel container; manual run abandon | query container stop | notebook stop | training stop; checkpoints already ingested stay | training stop; ingested checkpoints stay selectable |
| **Timeouts** (defaults) | agent turn 30 min; tests 15 min; build 20 min; preview start 60 s; idle preview TTL 2 h | runs 20 min; collect 5 min | profile 10 min; query 10 min | notebook 30 min; stats 10 min | train 2 h; evaluate 20 min | train 8 h; export 20 min; benchmark 10 min |
| **Validation** | [section 7.3](#73-validators-per-artifact-type) rows for SDE kinds | QA rows | DA rows | DS rows | ML rows | DL rows |
| **Audit/activity** | every job transition, MCP call (allowed and denied), accept, merge, deploy, approval | plus manual results, defect transitions, signature | plus registrations, exports | plus pre-registration, conclusions | plus promotions with gate results | plus selections |
| **Execution history** | `jobs` + `job_attempts` + per-attempt logs + `job_events`; runs survive reload | same | same | same | same + `metrics` rows per run | same + per-epoch metrics |
| **Approvals** | dependency-install egress; first repository write per project; merge into the user's branch | none beyond SDE's | image preparation | image preparation | dependency egress; long training over the default | pinned-weights download egress |
| **Error recovery** | restart: agent run → `interrupted`, worktree kept; tool run adopted or finalized; preview adopted or stopped | adopted or finalized; manual runs untouched | idempotent re-run | same | training container adopted if still running, else interrupted | as ML; resume from the last checkpoint |
| **Concurrency** | one agent turn per session; sessions in separate worktrees; accept serialized by IMMEDIATE transaction + git CAS | runs against one preview in parallel up to the cap | queries are priority 0 | notebooks priority 1 | one training job at a time (memory) | one training job at a time |
| **Security** | worktree-confined file tools; no Bash; container network none | preview reachable only on the internal test network | SQL guard; files read-only | notebooks network none; HTML sanitized, sandboxed iframe | pickle loaded only in containers; serving on 127.0.0.1 | pinned weights only; ONNX loaded in containers |
| **Reproducibility** | commit, lockfile hash, image digest, recipe version per attempt | build version, plan version, test commit | input hashes, SQL hash, DuckDB version, image digest | seed, params, input hashes, image digest; determinism re-run check | seed, params, code commit, data hashes, image digest | as ML + checkpoint hashes |
| **Deterministic transitions** | job, attempt, version, review, accept: lookup-table transitions with trigger backstops; driven only by recorded facts | plus defect table | as platform | plus experiment pre-registration ordering | plus promote-gate validator results | plus selection records |

### 1.10 The legacy registry and the persona cleanup

`src/shared/domain.ts` stays as the vocabulary of the project analyzer and the legacy Agents page (16 legacy ids, role preambles). It is not the domain registry; `src/shared/nexus/domains/*` is. Task B2a-T2 removes every persona remnant:

| Remove | Where | Replacement |
|---|---|---|
| `DomainAgentRole.character` (31 values) | `src/shared/domain.ts` | nothing; roles are identified by `roleId` and `title` |
| `DomainDefinition.leadCharacter`, `departmentName`, `departmentRoom` | `src/shared/domain.ts` | nothing |
| `import type { OfficeCharacterName } from '../renderer/src/scene/office/cast'` | `src/shared/domain.ts` | removed; `shared` no longer imports renderer code |
| `PreparedAgentConfig.character` | `src/shared/routing.ts`, `src/main/routing/taskRouter.ts:151` | removed; the preload type follows |

The office cast data in `scene/office/*` (legacy floor) is not touched by this task; it is already allow-listed by `test/nexus-identity-guard.test.cjs` as unreachable from Nexus surfaces. A new test, `test/nexus-domain-registry-clean.test.cjs`, fails if `src/shared/domain.ts` or anything under `src/shared/nexus/` imports from `src/renderer` or declares a `character`, `leadCharacter`, `department*` field. The known-leaks list of the identity guard must shrink or stay equal, never grow.

---

## 2. Shared platform architecture

### 2.1 Layers

```
┌──────────────────────── Nexus UI (renderer, untrusted) ─────────────────────────┐
│ Launcher · Workspaces (6 domains + 3 registry-only) · Projects · Spine · Folio   │
│ Passport · Runs · Artifacts · Handoffs · Needs you · Completion · Deployments    │
│ talks only through nexus:* invoke channels (ids and validated values)            │
├──────────────────────── Nexus orchestration (Electron main) ─────────────────────┤
│ B0b/B1 platform services (unchanged authority): auth, workspaces, artifacts,     │
│ lineage, jobs, sessions, handoffs, activity                                       │
│ NEW: domain registry · ExecutionService (scheduler, leases, ingest, recovery) ·   │
│ ValidationService · ApprovalService · TokenService · McpGateway (authorizes      │
│ tool calls) · ContextResolver · BlobIndex · CompletionEvaluator · RepoService    │
│ the only SQLite writer; every transition in one IMMEDIATE transaction            │
├──────────────────────── AgentRuntime abstraction (shared types) ──────────────────┤
│ AgentRuntime · RunRequest · RuntimeEvent      SandboxDriver · ContainerSpec      │
├──────────────────────── Execution backends (runner utilityProcess) ──────────────┤
│ ClaudeCliRuntime (default) · ScriptedRuntime (tests) · HermesRuntime (flag, later)│
│ DockerSandboxDriver · blob writer · log writer · output parsers · MCP HTTP server │
│ never opens the database; reports facts to main over a MessagePort               │
├──────────────────────── Sandbox (Docker Desktop, WSL2) ───────────────────────────┤
│ one container per job attempt; pinned images by digest; limits verified          │
│ sde-node · sde-python · qa-web · data-python · ml-python · dl-cpu · nexus-fwd    │
└───────────────────────────────────────────────────────────────────────────────────┘
```

### 2.2 Process topology

```
 Renderer ──ipcRenderer.invoke('nexus:*')──▶ Electron main (platform + orchestration, SQLite)
     ▲                                          │   ▲
     └──── webContents.send('nexus:hint',{seq}) │   │ MessagePort (runner protocol, §12.3)
                                                ▼   │
                                     Runner (utilityProcess.fork, no DB)
                                       │ async spawn, argv arrays only
              ┌────────────────────────┼─────────────────────────────┐
              ▼                        ▼                             ▼
        docker CLI               claude -p (headless,          HTTP MCP endpoint on
   (per-attempt containers,      per-job config dir,          127.0.0.1:<ephemeral>,
    labelled nexus.job=…)        worktree-confined tools)     bearer = capability token
                                        │                     (forwards calls to main)
                                        └────── calls MCP ─────┘
```

- **Main** owns all state, authorization and transitions. It schedules, mints tokens, verifies MCP calls, ingests outputs, records validations and activity. It never runs Docker, a runtime or a parser itself.
- **The runner** owns processes and bytes: Docker commands, runtime processes, log files, hashing outputs into the blob store (write to `objects/tmp`, hash while writing, atomic rename), parsing JUnit, Cobertura, `metrics.json` and similar into normalized JSON. It holds no authority: every message to main is a report, and main rejects reports for attempts it did not start (`attemptId` unknown, or the lease owner is not the current boot).
- **Containers and runtimes** never see the database, the token key, secrets, or host paths other than their mounts.
- **Supervision.** Main forks the runner at platform startup (after `[nexus] platform ready`), restarts it with backoff 1 s / 5 s / 30 s (at most 5 restarts in 10 minutes, then it stops and reports "Execution is unavailable"), and runs the R.2 recovery routine ([section 12.8](#128-recovery-after-a-restart)) after every runner start. A runner crash never takes main or the database down; the platform keeps serving reads.

### 2.3 Module map (planned code homes)

| Module | Path | Responsibility | Sub-phase |
|---|---|---|---|
| Domain registry | `src/shared/nexus/domains/*.ts`, `kinds/*.ts`, `capabilities.ts`, `recipes.ts`, `validators.ts`, `skills.ts` | DomainSpec, KindDef, capability catalogue, recipe and validator definitions (data only, no I/O) | B2a |
| Registry projection | `src/renderer/src/nexus/workspaces/registry.ts`, `src/shared/nexus/workspaceCatalog.ts` | become projections of `DomainSpec` (labels, hues, modules, legacy map); `WORKSPACE_IDS` gains `data-scientist` in B4 | B2a, B4 |
| Execution service | `src/main/nexus/exec/{scheduler,leases,ingest,recovery,executionService}.ts` | leasing, attempts, heartbeats, cancel, timeout, retry, ingest, recovery | B2a |
| Blob index | `src/main/nexus/blobs/blobIndex.ts` | `blobs`, `version_blobs`, verification, GC under a lock | B2a |
| Validation service | `src/main/nexus/validation/*` | validator registry, `validations` rows, gating `draft → candidate`, promote-time checks | B2a |
| Repo service | `src/main/nexus/repo/*` | `repo.snapshot`, worktrees, integration ref, accept, merge accepted (all through the async `runGit`) | B2a (snapshot, worktrees), B2b (ref, accept, merge) |
| Token service, MCP gateway, context | `src/main/nexus/agents/{tokens,mcpGateway,contextResolver}.ts` | mint and verify tokens; authorize and execute MCP tools; build `ResolvedContext` | B2b |
| Approvals | `src/main/nexus/approvals/*` | approval requests, decisions, expiry | B2a (image, repository write), B2b (egress) |
| Completion | `src/shared/nexus/completion.ts` (pure evaluator), `src/main/nexus/completion/*` | rule sets per domain over records | B2c |
| QA services | `src/main/nexus/qa/*` | manual runs, results, defects, reports, signatures | B2c |
| Runner | `src/runner/` (new electron-vite entry, built to `out/runner/index.js`) | sandbox driver, runtimes, MCP HTTP server, logs, blob writer, parsers | B2a (runtimes B2b) |
| Shared protocol | `src/shared/nexus/{execution,runtime,runnerProtocol,tokens,evidence}.ts` | types only | B2a |
| IPC | `src/main/nexusIpc/registerNexusIpc.ts` (still the only registrar) | new channels ([section 10](#10-ipcapi-contracts)) | each sub-phase |
| Images | `infra/images/<profile>/{Dockerfile,requirements.lock,package-lock.json}`, `infra/images/common/nexus_tools/` | pinned images and Nexus's own Python helper package | B2a onward |
| Skills | `resources/skills/nexus-*/SKILL.md` | Nexus-owned skills, each hashed | B2b onward |

`src/main/nexus` stays transport-free: the composition test's ban on `ipcMain` and `webContents` there is kept. `src/main/nexus/exec` talks to the runner through an injected `RunnerPort` interface, so every service stays testable on a bare database with a fake runner.

### 2.4 Ownership

| Concern | Owner | Never |
|---|---|---|
| Projects, participations, artifacts, versions, edges, handoffs | main platform services | runner, runtime, container, renderer |
| Jobs, attempts, leases, transitions | main `ExecutionService` | runner (it reports only) |
| Bytes of blobs and logs | runner writes; main indexes and verifies | containers (they write only `/out`) |
| Validation results | main `ValidationService`, from parsed evidence | agent text; LLM checks (advisory only) |
| Promote, accept, merge, sign, close, select, conclude, approve | the user, through `nexus:*` | agents (no MCP tool exists for them) |
| Reasoning and tool calling | the runtime | main |
| Isolation and limits | Docker, verified by Nexus preflight | runtime configuration |

### 2.5 Platform invariants (A–Z A.7, adapted)

1. Versions are immutable after `draft` (v7 triggers).
2. Only a user promotes `candidate → active`. Only the system finalizes `draft → candidate`, and only when every blocking validator passed.
3. Lineage edges come only from job inputs, ingest mappings, git evidence and user actions; never from prose, commit messages or notebook text.
4. Evidence is parsed from platform-hashed files or observed by Nexus (exit codes, `docker inspect`, HTTP probes, git). Agent text is never evidence.
5. The runner and runtimes never write the database.
6. No command comes from the renderer or from an agent as a shell string. Recipes are argv templates filled with ids and schema-checked parameters; `sandbox.exec` takes an argv array and runs only inside the job's own container.
7. No silent host fallback: a missing prerequisite makes a capability unavailable with a reason.
8. Completion is a predicate over records.
9. Handoffs reference version ids and content hashes; nothing is copied.
10. The UI never shows a result or an enabled action for a step that is not REAL or PARTIAL and available.
11. One owner per artifact (its participation); derived work is a new artifact. `repository` is the one project-owned kind.
12. No `execSync`, `spawnSync` or `execFileSync` anywhere under `src/main` or `src/runner`; the freezing-ratchet test covers both.
13. Accepting a change set never moves the user's checked-out branch or touches the working tree.

### 2.6 Departures from the A–Z architecture

| A–Z decision | This document | Why |
|---|---|---|
| A `utilityProcess` engine owns SQLite and is the only DB writer (A.4, P.4) | Platform services and SQLite **stay in main**, as B0b and B1 built them. A new runner `utilityProcess` executes and never opens the database | B0b/B1 shipped the services with IMMEDIATE transactions, triggers, rulings and tests on main's connection. Moving the writer would re-open approved code; two writers was a recorded risk (Z.11). Heavy I/O (Docker, hashing, logs, parsing) still leaves the main thread |
| A `window.nexus` MessagePort RPC bridge (B.6) | The B1 `nexus:*` invoke surface is extended; one push channel (`nexus:hint`) carries only a sequence number; data is pulled | Keeps B1's single registrar, validation, envelope and pins |
| `participations` table | `project_workspaces` (B0b) | Built and approved |
| Handoff states open/rejected/changes_requested/converted/delivered/closed | B1's `sent`, `accepted`, `declined`, `withdrawn`, plus new rows `converted`, `delivered`, `closed` | B1 ruling C2; lookup rows are additive |
| Accept is a status change; convert creates work | Accept creates a receipt (B1 C1); convert makes the subjects job inputs | B1 rulings C1 and C18 |
| New workspace rows `data-analyst` and `data-scientist` (M4) | Keep `data` as the Data Analyst workspace; add only `data-scientist` | Avoids moving existing `data` participations; ruling R1 |
| Stdio MCP shim per job | A loopback HTTP MCP endpoint with the token as a bearer header in the per-job MCP config; the stdio shim only for a runtime that lacks HTTP MCP | The installed CLI's HTTP MCP support is checked by a contract test before it is relied on |
| Broker model-proxy extension for the API key | Credential decision D9; recommended: the key is decrypted from safeStorage into the CLI child's environment only | Smaller; a proxy can come later without changing the runtime interface |
| HermesRuntime built behind a flag in the engine phase | Not built in B2–B6 unless approved (D6); the interface is proven by `ScriptedRuntime` | The spike's conditions are still open (real-LLM tool path, per-run scoping) |
| SDE host mode (`host.exec`) | None | Every execution path stays sandboxed |
| Previews on a bridge network with outbound egress (Z.24) | Internal network plus a Nexus forwarder container (D13) | The brief requires default-deny networking |
| Vega-Lite in the renderer (Z.14) | Server-side SVG/PNG in `data-python` (vl-convert) | No renderer dependencies; interactive charts are a later decision |
| Ajv for JSON Schema (Z.15) | Hand-written TypeScript validators in the style of `nexusIpc/validate.ts` | No new dependency |
| Monitoring hooks in the deploy phase | A local monitoring report in B5 | The ML flow requires a Monitoring step |
| Phase numbering B1 SDE, B2 QA, B3a DA, B3b DS, B4 ML, B5 DL, B6 deploy | B2a/B2b/B2c, B3 DA, B4 DS, B5 ML, B6 DL; deployment limited to local previews and local inference services | The user's phase plan; ruling R3 covers the frozen `planned_phase` labels |
| `change_set` as the only code kind | Adds `requirement`, `test_suite`, `diagnostic_report`, `problem_statement`, `expectation_suite`, `feature_set`, `chart`, `preprocessing_pipeline`, `architecture`, `benchmark`, `inference_service`, `monitoring_report`, `regression_report` | The user's taxonomy |

Kept from A–Z: the F.1a ownership rules, the F.7 version table, the capability intersection (G), recipe definitions (H.2), the validator registry shape (K), lineage rules (L.2), O.5 container hardening, R.2 recovery, the honesty rules (S.6), the completion DSL (N), and Z.18 (pickle only in containers).

---

## 3. Domain capability matrix

### 3.1 Step status summary (end state of B2–B6)

| Domain | Steps | REAL | PARTIAL (scope) | FUTURE inside the flow | Executable end to end at |
|---|---|---|---|---|---|
| SDE | 12 | 12 | — (the dev deployment is local by definition) | none | B2b |
| QA | 11 | 11 | — | none | B2c |
| Data Analyst | 10 | 8 | Data source (local files), Publish/share (file export and in-app) | none | B3 |
| Data Scientist | 12 | 11 | Acquisition (local files and handoffs) | none | B4 |
| ML Engineer | 13 | 11 | Training (CPU), Monitoring (local traffic) | none | B5 |
| DL Engineer | 15 | 13 | Training (CPU), Optimization (dynamic int8) | none | B6 |

FUTURE capabilities that sit **outside** the required flows: database and warehouse connectors, hosted share links, scheduled refresh, GPU training, remote or multi-service deployments, production monitoring with alerting, multi-user collaboration, cross-browser QA matrices, MLflow import.

### 3.2 Capability ceilings per domain

Capabilities are what a token grants ([section 6](#6-agent-capabilitytool-matrix)). ✓ = in the ceiling; text = granted with that scope; – = never. The last column says when the capability becomes REAL.

| Capability | SDE | QA | DA | DS | ML | DL | REAL from |
|---|---|---|---|---|---|---|---|
| `code.read` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | B2b |
| `code.edit` | all paths except `.git/**` and sensitive names | `tests/**`, `e2e/**` | `analysis/**` | `notebooks/**`, `ds/**` | `ml/**` | `dl/**` | B2b (SDE), B2c (QA), each domain's phase |
| `git.commit` (job branch only) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | B2b |
| `sandbox.exec` (own container) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | B2b |
| `artifact.read` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | B2b |
| `artifact.register` (own kinds, own artifacts) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | B2b |
| `job.request` (own recipes) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | B2b |
| `handoff.create` (sends; never accepts) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | B2c |
| `review.request` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | B2b |
| `approval.request` (egress only) | dependency installs | – | – | – | dependency installs | pinned weights | B2b, B5, B6 |
| `test.run` | ✓ | ✓ | – | – | – | – | B2b |
| `test.author`, `defect.propose` | – | ✓ | – | – | – | – | B2c |
| `build.request`, `preview.request` | ✓ | preview only | – | – | – | – | B2b |
| `data.read`, `data.register` | – | – | ✓ | ✓ | ✓ | ✓ | B3 |
| `sql.query` | – | – | ✓ | ✓ | ✓ | – | B3 |
| `notebook.run`, `stats.run` | – | – | – | ✓ | – | – | B4 |
| `model.train.cpu` | – | – | – | baseline estimators only | ✓ | ✓ | B4, B5, B6 |
| `model.evaluate` | – | – | – | ✓ | ✓ | ✓ | B4 |
| `model.package`, `model.serve` | – | – | – | – | ✓ | ✓ | B5, B6 |
| `model.export`, `model.optimize` | – | – | – | – | – | ✓ | B6 |
| `gpu.train` | – | – | – | – | – | FUTURE | — |
| `connector.read` | – | – | FUTURE | FUTURE | – | – | — |
| `host.exec` | – | – | – | – | – | – | never |

### 3.3 User actions per domain (renderer → main)

| Domain | User actions (each is an `actionId` with a parameter schema, never a command) |
|---|---|
| Shared | save an inline artifact; register a file or folder (main dialog); run an action; cancel; retry; mark ready (user-authored drafts only, B1); promote; discard; link sources; send, accept, decline, withdraw a handoff (B1); convert, deliver, close, comment (B2c); approve or deny an approval; export a bundle |
| SDE | run tests on a commit; build; assemble the application; start and stop a dev deployment; diagnose; start an agent session; review; accept a change set; request changes; merge accepted work |
| QA | create a plan; add the strategy; create cases; start, record and submit a manual run; run the automated suite; rerun cases; create, confirm, reject, close a defect; compute the regression and quality reports; sign the release recommendation |
| DA | profile; save and run a query; derive a dataset; run an analysis; render a chart; compose a dashboard; render a report; save an insight |
| DS | run a notebook; describe statistics; pre-register an experiment; run its test; record the conclusion; split; train a baseline; evaluate |
| ML | write expectations; validate data; create an experiment; train; evaluate; package; serve; send sample requests; compute monitoring |
| DL | preprocess; check the architecture; train; resume; compare and select a checkpoint; evaluate; export; check parity; benchmark; quantize; serve |

---

## 4. Artifact taxonomy

### 4.1 Common envelope and lifecycle

Every kind uses the v7 envelope (`artifacts`, `artifact_versions`) and the F.7 version table (draft → candidate → active → deprecated; draft → failed; rollback deprecated → active). Rules common to every kind:

- **Owner:** the participation that created the artifact; only it appends versions (`tr_versions_insert`). `repository` is project-owned.
- **Versioning:** `version_no` allocated under BEGIN IMMEDIATE; content immutable after `draft`; "latest" = the highest `version_no` among the requested statuses; promotion is a compare-and-set on `current_version_id`; single-active unless the kind says otherwise.
- **Draft → candidate:** the system finalizes only after every blocking `register` and `candidate` validator passed (`validations` rows). A user can "mark ready" only a draft with no producing job (B1 ruling C4).
- **Inputs:** a version's `inputs_json` must be a subset of its producing job's `job_inputs` (B0b `input_not_granted`).
- **Permissions:** read = `artifact.read` on the owner workspace; create and register = a member of the owning participation (user) or a token with `artifact.register` for that kind (agent); promote and discard = a user member; archive = admin.
- **Handoff:** only `candidate` or `active` versions, by reference (B1 trigger `tr_handoff_subjects_insert`).

The kind registry (`src/shared/nexus/kinds/*.ts`) adds, per kind: allowed storage forms, a metadata validator, the single-active flag, the viewer, the validators per stage (`register`, `candidate`, `promote`), the allowed lineage endpoint pairs, the handoff routes, and `userAuthorable` (whether `nexus:artifact:saveInline` may create it).

### 4.2 User terms to kind ids

| User's term | Kind id | Note |
|---|---|---|
| requirement | `requirement` | new |
| repository | `repository` | project-owned (B0b design, deferred by C5, built in B2a) |
| source-code | `change_set` (a reviewed code change) and `git_commit` (B1 save) | |
| test-suite | `test_suite` | SDE- or QA-owned |
| build, application | `build`, `application` | |
| test-plan, test-case, test-run, defect | `test_plan`, `test_case`, `test_run`, `defect` | |
| regression-report, quality-report, release-recommendation | `regression_report`, `quality_report`, `release_recommendation` | |
| dataset, query, analysis, chart, dashboard, report, insight | same ids | |
| feature-set | `feature_set` | |
| experiment, model, evaluation | same ids | |
| inference-service | `inference_service` | |
| preprocessing-pipeline, architecture, checkpoint, benchmark | `preprocessing_pipeline`, `architecture`, `checkpoint`, `benchmark` | |
| problem, business question, business problem | `problem_statement` | one kind, three domain labels |
| data validation | `expectation_suite` | |
| training | `training_run` | |
| packaging, export | `serving_package`, `model_export` | |
| monitoring, logs/diagnostics | `monitoring_report`, `diagnostic_report` | |

### 4.3 SDE and platform kinds

| Kind | Owner | Storage | Versioning and lifecycle | Inputs → outputs | Validators | Lineage (from → to) | Permissions | Handoff |
|---|---|---|---|---|---|---|---|---|
| `repository` | project (platform) | `git` (commit, branch, integration ref) | versions only from `repo.snapshot`; created **active** by platform policy (it records git state, no work product) | git → snapshot | `git.head_resolves` | `derived_from` the previous snapshot; `contains` → change sets newly reachable (ancestry-verified) | system writes; every participant reads | as a subject in any route |
| `requirement` | SDE | `inline` | owner revise; single-active | text → criteria list | `req.schema` | — (target of `implements`, `covers`) | user or agent drafts; user promotes | SDE → QA (`test`, as context) |
| `change_set` | any domain, within its `code.edit` scope | `git` (base, head, job branch) | one artifact per change; request changes appends a version; **not** single-active (every accepted change stays active) | repository version + inputs → commits on `nexus/job/<jobId>` | register: `git.diff_nonempty`, `git.paths_in_scope`, `sec.secret_scan`; candidate: `sde.tests_pass`, `sde.typecheck_ok` (when a `tsconfig.json` exists), `git.applies_cleanly` | `derived_from` repository (base); `implements` requirement; `fixes` defect; `serves` serving_package/model_export | agent registers; user reviews and accepts | reaches QA through builds |
| `test_suite` | SDE or QA | `git` (commit + discovery list blob) | a version per discovered commit | commit → discovered ids | `suite.discovered` (≥ 1 id; list hashed) | `derived_from` repository | system registers from discovery | with the application to QA |
| `build` | SDE | `tree` (output manifest) | one artifact per build target; a version per (commit, lockfile, image) | repository version → output tree | `build.exit_zero`, `build.manifest_present`, `build.output_hashed` | `built_from` repository | user or agent requests | SDE → QA (`test`) |
| `application` | SDE | `inline` (manifest) + build ref | a version per (build version, manifest hash); candidate needs a passed `app.preview_health` | build → runnable app | `app.manifest_schema`; candidate: `app.preview_health` | `assembled_from` build; `depends_on` api (when declared) | user promotes | SDE → QA (`test`) |
| `diagnostic_report` | SDE | `inline` + log ranges | one per diagnosis | deployment or failed job → facts | `diag.schema` (every field has a source) | `depends_on` application | system writes | SDE → QA (`inform`) |
| `git_commit`, `text_file`, `handoff_receipt` | B1 kinds, unchanged | | | | | | | |

### 4.4 QA kinds

| Kind | Owner | Storage | Versioning and lifecycle | Validators | Lineage | Permissions | Handoff |
|---|---|---|---|---|---|---|---|
| `test_plan` | QA | `inline` | one per application artifact; owner revise (v2 adds the strategy); single-active | `qa.plan_schema`; `qa.strategy_complete` (when a strategy block exists) | `depends_on` requirement | user or agent drafts; user promotes | QA → SDE (`inform`) |
| `test_case` | QA | `inline` (+ git ref for automation) | one artifact per case | `qa.case_schema`; `qa.case_refs_resolve` (automated) | `covers` requirement | user or agent drafts | — |
| `test_run` | QA | `blob` (JUnit, attachments) + `test_results` rows | one artifact per execution, one version | `qa.junit_parsed` (automated), `qa.counts_consistent`, `qa.build_bound`, `qa.manual_complete` (manual: every planned case recorded or explicitly skipped) | `tests` build and application; `executes` test_plan | system (automated) or user (manual) | QA → SDE (`inform`) |
| `defect` | QA | `inline`; status in `defects` | one artifact per defect; v1 is the immutable report; status lives in the projection | `qa.defect_links`; `qa.retest_newer_build` (gates `verified`) | `found_in` build; `evidenced_by` test_run; `verified_by` test_run | agent proposes (draft); user confirms, rejects, closes | QA → SDE (`fix`) |
| `regression_report` | QA | `inline` (engine-computed) | one per build pair | `qa.report_numbers_engine_computed` | `summarizes` test_runs | system computes | — |
| `quality_report` | QA | `inline` (engine-computed) + optional narrative blob (display only) | one artifact per application, a version per build | `qa.report_numbers_engine_computed` | `summarizes` test_runs and defects | system computes; user promotes | QA → any (`inform`) |
| `release_recommendation` | QA | `inline` | one artifact per application, a version per build | `qa.signed_by_user` | `recommends` build; `based_on` quality_report | **user only** (signs) | QA → SDE (`release-gate`) |

### 4.5 Data and model kinds (DA, DS, ML, DL)

| Kind | Owners | Storage | Versioning and lifecycle | Validators | Lineage | Permissions | Handoff |
|---|---|---|---|---|---|---|---|
| `problem_statement` | DA, DS, ML, DL | `inline` | owner revise; single-active | `problem.schema` | — (target of `depends_on`) | user or agent drafts | as context in any route |
| `dataset` | DA, DS, ML, DL | `blob`, `tree`, or `external` (manifest; the file stays in place) | re-registering the same source appends by content hash; derived data is a new artifact | `data.manifest_hashed`; candidate: `data.readable`, `data.schema_inferred`, `data.profile_computed`; splits: `data.split_disjoint`; DL: `dl.labels_resolve` | `derived_from`, `transformed_by` | user registers (main dialog); agent derives | DA → DS/ML (`use-as-input`), ML → DA (`inform`) |
| `query` | DA, DS, ML | `inline` (SQL) + `blob` (snapshot) | a version per (SQL hash, bound dataset versions) | register: `da.sql_readonly`; candidate: `da.sql_explains`, `da.result_snapshot` | `queried_from` dataset | user or agent | DA → DS |
| `analysis` | DA, DS | `git` (source) + `blob` (executed output) | a version per execution | DA: `da.analysis_ok`; DS: `ds.notebook_no_error_cells`, `ds.params_recorded`, `ds.seed_recorded`, `ds.stats_schema` (form `stats`) | `analyzes` dataset/query | system runs | DS → DA (`inform`) |
| `chart` | DA | `blob` (Vega-Lite spec, renders) | owner revise | `da.vegalite_schema`, `da.bindings_resolve`, `da.render_ok` | `visualizes` query | user or agent | with the dashboard or report |
| `dashboard` | DA | `blob` (layout) | owner revise | `da.dashboard_bindings` (every tile is a candidate or active chart version) | `cites` chart | user or agent | DA → any (`inform`) |
| `report` | DA, DS | `blob` (Markdown + rendered HTML) | owner revise | `doc.utf8_markdown`, `report.refs_resolve`; advisory `report.unreferenced_numbers` | `cites` query, chart, dashboard, analysis, experiment, evaluation, dataset | user or agent | any (`inform`) |
| `insight` | DA, DS | `inline` | owner revise | `insight.has_evidence` | `cites` evidence versions | user or agent | DA → DS (`investigate`), DA → ML (`feature-idea`) |
| `feature_set` | DS, ML | `blob`/`external` (Parquet) + declared columns | a new artifact per feature definition | `fs.schema`; advisory `data.feature_leakage` | `derived_from` dataset; `transformed_by` query | system runs | DS → ML (`productionize`) |
| `expectation_suite` | ML (DS may use it) | `inline` | owner revise | `exp.schema` (each expectation from an enum, with bounds) | `depends_on` problem_statement | user or agent | — |
| `experiment` | DS, ML, DL | `inline` | DS: v1 pre-registration, v2 result; ML: search definition; DL: comparison and selection versions | DS: `ds.hypothesis_schema`, `ds.hypothesis_preregistered`, `ds.min_sample`, `ds.stats_schema`; ML: `ml.experiment_schema`; DL: `dl.comparison_engine_computed` | `tested_on` dataset; `depends_on` baseline evaluation | user creates; system writes results | DS → ML |
| `training_run` | ML, DL | `inline` + `blob` (`metrics.jsonl`) | one artifact per run | ML: `ml.metrics_schema`; DL: `dl.metrics_monotonic_steps`, `dl.no_nan_loss` | `run_of` experiment; `trained_on` dataset; `configured_by` architecture (DL); `resumed_from` checkpoint | system runs | — |
| `checkpoint` | DL | `blob` | a version per saved epoch; **not** single-active | `dl.ckpt_loads` | `produced_by` training_run | system ingests | — |
| `model` | DS (baseline, `servable: false`), ML, DL | `blob` (model file + `signature.json`) | DS: per estimator; ML: per experiment, a version per run; DL: per selected network | DS: `ds.model.baseline`; ML: `ml.model_file_hashed`, `ml.signature_schema`, `ml.model.load_infer`; promote: `ml.no_regression`, `ml.thresholds_met`, `ml.slice_parity`; DL: `dl.ckpt_loads` | `produced_by` training_run; `trained_on` dataset; `selected_from` checkpoint | system registers; user promotes | DS → ML (`productionize`), DL → ML (`package`) |
| `evaluation` | DS, ML, DL | `inline` + `blob` | one per (model version, dataset version, split) | `eval.disjoint`, `eval.metrics_schema`, `eval.bound_dataset` | `evaluates` model/model_export; `evaluated_on` dataset | Nexus evaluator only | with the model |
| `serving_package` | ML | `blob` (tar) | a version per (model version, template version) | `ml.pkg.lockfile_pinned`, `ml.pkg.size_cap`; candidate: `ml.pkg.predict_runs`, `ml.pkg.deterministic` | `packages` model/model_export | system builds; user promotes | ML → SDE (`create-api`) |
| `inference_service` | ML, DL | `inline` (template, port, source ref, contract results) | a version per (package or export version, template) | `svc.health`, `svc.contract` | `serves` serving_package/model_export | user starts; system records | ML → SDE (`create-api`), ML → QA (`test-api`) |
| `monitoring_report` | ML | `inline` (computed) + log range | one per window | `mon.numbers_engine_computed` | `monitors` inference_service | system computes | ML → DS (`inform`) |
| `preprocessing_pipeline` | DL | `git` (code or config) | a version per commit | `dl.pipeline_deterministic` | — (target of `transformed_by`) | agent or user | — |
| `architecture` | DL | `git` (code + config) | a version per commit | `dl.arch_instantiates` | — (target of `configured_by`) | agent or user | — |
| `model_export` | DL (ML may consume it) | `blob` (ONNX) | v1 fp32, v2 int8 (owner revise) | `dl.onnx_checker`, `dl.parity`, `dl.quant_delta` | `exported_from` model; `derived_from` the previous export | system; user promotes | DL → ML (`package`), DL → SDE (`create-api`) |
| `benchmark` | DL | `inline` | one per (export version, input set, thread count) | `bench.schema` (finite values; CPU recorded) | `evaluates` model_export | system | with the export |

### 4.6 Metadata sketches for the new kinds

The A–Z F.4 sketches for `dataset`, `query`, `analysis`, `dashboard`, `report`, `insight`, `experiment`, `training_run`, `checkpoint`, `model`, `evaluation`, `serving_package`, `model_export`, `build`, `application`, `test_plan`, `test_case`, `test_run`, `defect`, `quality_report` and `release_recommendation` are kept. New ones:

```ts
interface RequirementMeta { title: string; body: string /* ≤ 32 KiB */; criteria: { id: string; text: string }[]; priority: 'must' | 'should' | 'could' }
interface ProblemStatementMeta {
  domainView: 'business_question' | 'business_problem' | 'ml_problem' | 'dl_problem';
  question: string; decision?: string; successMeasure?: string;
  task?: 'binary_classification' | 'multiclass' | 'regression' | 'image_classification' | 'text_classification' | 'other';
  primaryMetric?: { name: string; direction: 'max' | 'min' };
  thresholds?: Record<string, number>; latencyBudgetMs?: number; inputShape?: (number | null)[];
}
interface TestSuiteMeta { framework: 'pytest' | 'jest' | 'vitest' | 'mocha' | 'playwright'; commit: string; ids: Sha256 /* blob holding the id list */; count: number }
interface DiagnosticReportMeta {
  deploymentId?: string; jobId?: string;
  container: { exitCode: number | null; oomKilled: boolean; restartCount: number; state: string };
  health: { at: number; status: number | null; ms: number | null }[];      // probe series, ≤ 200 rows
  logRanges: { stream: 'stdout' | 'stderr'; offset: number; length: number; sha256: Sha256 }[];
}
interface ChartMeta { vegaLiteVersion: string; spec: Sha256; bindings: { dataName: string; queryVersionId: string }[]; renders: { svg: Sha256; png: Sha256 } }
interface FeatureSetMeta { source: string /* dataset version id */; label: { column: string; definition?: string }; features: ColumnSpec[];
  postOutcomeColumns: string[]; transform: { kind: 'sql' | 'script'; ref: Sha256 | GitRef } }
interface ExpectationSuiteMeta { expectations: (
  | { id: string; type: 'column_type'; column: string; dtype: string }
  | { id: string; type: 'null_rate_max'; column: string; max: number }
  | { id: string; type: 'value_range'; column: string; min?: number; max?: number }
  | { id: string; type: 'unique'; column: string }
  | { id: string; type: 'row_count'; min?: number; max?: number }
  | { id: string; type: 'allowed_values'; column: string; values: (string | number)[] })[] }
interface InferenceServiceMeta { template: 'svc.sklearn-fastapi@1' | 'svc.onnx-fastapi@1'; source: string /* package or export version id */;
  containerPort: number; healthPath: '/health'; predictPath: '/predict';
  contract: { samples: number; passed: number; p50Ms: number; p95Ms: number; outputsSha256: Sha256 } }
interface MonitoringReportMeta { serviceVersionId: string; window: { from: number; to: number }; log: { sha256: Sha256; lines: number };
  requests: number; errorRate: number; latency: { p50Ms: number; p95Ms: number };
  drift: { feature: string; psi: number; reference: Sha256 }[] }
interface PreprocessingPipelineMeta { entry: GitRef; config?: GitRef; outputs: { shape: (number | null)[]; dtype: string }; sampleHash: Sha256 }
interface ArchitectureMeta { entry: GitRef; config: GitRef; framework: 'pytorch'; inputShape: (number | null)[]; outputShape: (number | null)[]; params: number; flops?: number }
interface BenchmarkMeta { exportVersionId: string; inputs: Sha256; threads: number; cpu: string; runs: number; p50Ms: number; p95Ms: number;
  throughputPerS: number; outputsSha256: Sha256 }
interface RegressionReportMeta { buildVersionId: string; previousBuildVersionId: string;
  computed: { newFailures: string[]; fixed: string[]; stillFailing: string[]; flaky: string[]; notRun: string[] } }
```

`GitRef = { commit: string; path: string }`; `ColumnSpec = { name: string; type: string; nullable?: boolean }`; `Sha256 = string`.

---

## 5. State machines

Every machine below is either an existing lookup table (B0b/B1, unchanged) or a new lookup table seeded additively, with a TypeScript mirror and a test that compares the two (the `test/nexus-core-states.test.cjs` pattern). Every transition is applied by one service method inside one IMMEDIATE transaction that also writes its activity row; a trigger rejects any transition missing from the table. Transitions are driven only by recorded facts (a user action, a runner report main accepted, a validator result, a wall-clock deadline); nothing transitions on a guess.

### 5.1 Artifact version (F.7, unchanged)

| From | To | Who | Guard |
|---|---|---|---|
| (new) | `draft` | job ingest, MCP `artifact.registerVersion`, user save | metadata valid for the kind; inputs ⊆ job inputs; caller owns the target |
| `draft` | `candidate` | system (`ValidationService.finalizeIfReady`) | every blocking `register` and `candidate` validator `passed`; `draft_flag` ≠ `cancelled_partial`; for user-authored drafts also B1 "mark ready" |
| `draft` | `failed` | system | a blocking validator `failed`, or the producing job failed after registering |
| `draft` | `deprecated` | user (Discard) or system (a newer version of the same artifact became active) | — |
| `candidate` | `active` | user (`promote`, compare-and-set) | every `promote` validator `passed` (for example `ml.no_regression`); `reviewRequired` kinds need an approving review |
| `candidate` | `deprecated` | user (Discard) | — |
| `active` | `deprecated` | system (a newer version of a single-active artifact was promoted) or user | — |
| `deprecated` | `active` | user (rollback, compare-and-set) | `promoted_at` set (it was active before) |
| `failed` | — | | terminal |

A validator result `error` (it could not run, for example Docker stopped) never counts as `passed`: the version stays `draft` with "Validation could not run" and a retry action.

**`cancelled_partial` drafts.** A draft registered by a job that was then cancelled keeps `draft_flag = 'cancelled_partial'` and never moves automatically. B2a adds the user action `nexus:version:revalidate`, which re-runs the validators and, if all pass, lets the system finalize it.

### 5.2 Job (v7, 11 states, 23 transitions, unchanged vocabulary)

The executor gives each existing transition a cause:

| From | To | Cause in B2a+ |
|---|---|---|
| `queued` | `leased` | the scheduler claims the job: an attempt row is inserted with `lease_owner = bootId`, `lease_expires_at = now + 60 s`; `attempts` + 1 |
| `queued` | `cancelled` | user cancel, or the session or parent was cancelled |
| `leased` | `running` | the runner reports `attempt.provisioned` with a passing preflight (or, for engine-side recipes, main starts them) |
| `leased` | `queued` | the runner refused or lost the attempt before start and the job is still allowed to run (attempt → `abandoned`) |
| `leased` | `failed` | preflight refused the container (`infra_error: limits_not_applied`), image missing, disk guard |
| `leased` | `cancelled` / `interrupted` | cancel during provisioning / restart recovery when the participation or session ended |
| `running` | `awaiting_approval` | an `approvals` row of this job became `pending` (for example egress for a dependency install) |
| `running` | `completed` | exit observed, outputs ingested, every required output contract present. A test recipe that exits non-zero **with** a parsable JUnit is `completed`; the product failure is in the validation results |
| `running` | `partial` | an `agent.run` that ended normally but at least one version it registered became `failed` |
| `running` | `failed` | non-zero exit without contract outputs (`nonzero_exit`), missing contract file (`invalid_output`), `oom`, `diverged`, `input_changed`, runtime error, container vanished |
| `running` | `cancelled` | cancel requested before the exit was observed (race rule: cancel wins) |
| `running` | `timed_out` | the wall clock expired (approval waits excluded) |
| `running` | `interrupted` | restart recovery for an `agent.run`, or a `tool.run` whose container cannot be found |
| `awaiting_approval` | `running` | the approval was answered `once` |
| `awaiting_approval` | `failed` | the approval was denied or expired (`outcome: denied`) |
| `awaiting_approval` | `cancelled` / `timed_out` / `interrupted` | as from `running` |
| `failed`, `timed_out` | `retry_scheduled` | `canRetry`: declared idempotent, attempts < max, not `agent.run`, participation active, session live |
| `retry_scheduled` | `queued` | `next_attempt_at` reached (backoff 10 s, 60 s, 300 s) |
| `retry_scheduled` | `cancelled` | user cancel |

`job.outcome` vocabulary (stored in the existing `outcome` column): `ok`, `stopped` (a service stopped by the user), `nonzero_exit`, `invalid_output`, `oom`, `diverged`, `input_changed`, `deps_missing`, `merge_conflict`, `denied`, `infra_error`, `runtime_error`, `interrupted`, `limits_not_applied`, `disk_full`, `file_locked`.

### 5.3 Job attempt (new, v9)

| From | To | Cause |
|---|---|---|
| (new) | `starting` | inserted with the `leased` transition |
| `starting` | `running` | provisioned and preflight passed |
| `starting` | `abandoned` | runner refused, lost, or restart before start |
| `starting`, `running` | `succeeded` | exit observed and the job completed |
| `starting`, `running` | `failed` | exit or fault observed and the job failed |
| `starting`, `running` | `cancelled` | the job was cancelled |
| `running` | `timed_out` | the job timed out |
| `running` | `abandoned` | restart recovery could not adopt it |

Terminal: `succeeded`, `failed`, `cancelled`, `timed_out`, `abandoned`. A job has at most one non-terminal attempt (partial unique index).

### 5.4 Agent session (v7, 8 states, 14 transitions, unchanged vocabulary)

B0b left "how job outcomes drive session status" to the runtime phase. Rule (needs ruling R4): a session is a live conversation that holds one worktree; it has no "idle" state, and the vocabulary has no `running → open` transition.

| Status | Meaning in B2b+ |
|---|---|
| `open` | created; no turn has started |
| `running` | the session is live: a turn is executing **or** the session waits for the next user message. The UI derives "Working", "Waiting for you" or "Idle" from the session's jobs, not from this column |
| `awaiting_approval` | the current turn's job is `awaiting_approval` |
| `completed` | the user ended the session (`nexus:session:end`); its worktree is kept until its change sets are accepted or discarded |
| `failed` | the runtime failed in a way that ends the conversation (authentication, protocol) |
| `cancelled` | the user cancelled; cascades to every job (existing `SessionService.cancel`) |
| `timed_out` | the session's idle limit (default 8 h without a turn) expired |
| `interrupted` | restart recovery while a turn was running (existing rule) |

A turn whose job fails does not end the session; the user can send another message. A new turn after `interrupted` opens a new session with the same worktree (the runtime's own session id is reused for conversation memory when the runtime supports resume).

### 5.5 Handoff (v8 states plus three rows)

| From | To | Who | Guard |
|---|---|---|---|
| `sent` | `accepted` | receiving user (B1) | receipt created, CAS |
| `sent` | `declined` | receiving user (B1) | — |
| `sent` | `withdrawn` | sending user (B1) | — |
| `accepted` | `converted` | receiving user (`nexus:handoff:convert`) | a conversion job was created with every subject as an input |
| `converted` | `delivered` | receiving user confirms (`nexus:handoff:deliver`) | the route's acceptance rule holds over the delivered versions (evaluated, stored in `handoff_details.delivery_json`) |
| `accepted`, `converted`, `delivered` | `closed` | sending user (`nexus:handoff:close`) | for `fix` routes: `qa.retest_newer_build` holds for every subject defect; for `test` routes: a signed release recommendation exists for the delivered build or the handoff is closed with a reason |

`closed` is terminal. `accepted` stays non-terminal as B1 designed. The v8 triggers already admit these rows: the answer fields and the receipt are untouched by the new transitions.

**Return loops.** A follow-up handoff names its predecessor in `handoff_links(handoff_id, kind, other_id)` with kind `return_of` (QA → SDE `fix` returns an SDE → QA `test`) or `supersedes` (re-sent with a newer subject version). A handoff whose work continues in a `return_of` child is delivered when the last child in its chain is delivered.

### 5.6 Approval (new, v9)

| From | To | Who | Guard |
|---|---|---|---|
| (new) | `pending` | system (agent `approval.request`, recipe needing egress, image preparation, first repository write) | a reason enum and a bounded summary |
| `pending` | `approved` | user (`once` only) | user principal; role ≥ admin for egress and image preparation in multi-user later (owner today) |
| `pending` | `denied` | user | — |
| `pending` | `expired` | system | `expires_at` passed (default 15 min; fail closed) |
| `pending` | `withdrawn` | system | its job was cancelled or ended |

There is no "always" or "for the session" choice (the Hermes spike showed those persist allow rules; Nexus never offers them).

### 5.7 Deployment (new, v9)

| From | To | Cause |
|---|---|---|
| (new) | `starting` | service job leased |
| `starting` | `healthy` | health probe 200 within the start timeout |
| `starting` | `failed` | probe never succeeded, or the container exited |
| `healthy` | `unhealthy` | 3 consecutive failed probes |
| `unhealthy` | `healthy` | 2 consecutive successful probes |
| `healthy`, `unhealthy` | `stopped` | user stop, idle TTL, cancel, app quit |
| `healthy`, `unhealthy` | `failed` | the container exited on its own |

### 5.8 Defect (new, v11)

| From | To | Who | Guard |
|---|---|---|---|
| (new) | `proposed` | agent (`defect.propose`) | linked failing result |
| (new) | `open` | user creates | linked failing result |
| `proposed` | `open` | user confirms | — |
| `proposed` | `rejected` | user | — |
| `open` | `fixed` | system rule `defect.fixed` | an accepted change set `fixes` the defect, it is `contains`-reachable from the repository snapshot of a build assembled into an application version handed to QA |
| `fixed` | `verified` | system rule `defect.verify` | `qa.retest_newer_build` passed |
| `fixed` | `open` | system | the retest failed on that build |
| `verified` | `closed` | user | — |
| `open` | `rejected` | user (not a defect) | reason recorded |

A user can close only a `verified` defect. `rejected` and `closed` are terminal.

### 5.9 Change-set acceptance (projection, v10)

`change_set_accepts` holds one row per accepted change-set version: the integration ref, the merge commit, the ref value before and after (CAS), the accepting user and time. States are expressed by the version (`candidate` → `active` on accept) and by this row; there is no separate state column. Merge conflicts leave the version `candidate` with validation `git.applies_cleanly = failed`.

### 5.10 Validation result and lifecycle step (derived, not stored)

- **Validation result** (`validations.status`): `passed`, `failed`, `error`, `skipped`. Append-only: a re-validation writes new rows; the latest row per (version, validator) counts.
- **Lifecycle step state** (computed per participation for the rail): `unavailable` (prerequisite missing or FUTURE) → `blocked` (an input step is not done) → `ready` → `in_progress` (a non-terminal job produces its kind) → `done` (a candidate or active version with blocking validators passed) or `failed` (the latest attempt's version failed). Recomputed from records on read; never written.
- **Participation completion:** `project_workspaces.status = 'complete'` is set only by a user action when the domain's completion rule set evaluates true ([section 7.6](#76-completion-rules)); the evaluation result and its witnesses are stored in the existing `completion_*` columns.

---

## 6. Agent capability/tool matrix

### 6.1 One agent, domain context

There is no per-domain agent persona. A domain agent is the same runtime with a different `ResolvedContext` (domain, lifecycle stage, vocabulary, focus versions, permitted tools), a different token, different skills and a different container image. The legacy role preambles in `src/shared/domain.ts` are not used by Nexus jobs.

### 6.2 MCP tools (served by the runner, authorized and executed by main)

| Tool | Args → result | Required capability | Extra checks | Mutates |
|---|---|---|---|---|
| `context.get` | `{}` → ResolvedContext summary | `artifact.read` | own job | no |
| `artifact.list` | `{ kind?, limit ≤ 100 }` → cards | `artifact.read` | token project | no |
| `artifact.get` | `{ artifactId }` → artifact + versions | `artifact.read` | token project | no |
| `artifact.readContent` | `{ versionId, path?, maxBytes ≤ 256 KiB }` → text or mount path | `artifact.read` | version ∈ token inputs ∪ own outputs | no |
| `lineage.get` | `{ versionId, direction, depth ≤ 3 }` → nodes | `artifact.read` | token project | no |
| `validations.get` | `{ versionId }` → results with evidence summaries | `artifact.read` | token project | no |
| `job.status`, `job.logs` | `{ jobId, fromOffset?, maxBytes ≤ 64 KiB }` | `artifact.read` | own job tree only | no |
| `sandbox.exec` | `{ argv: string[], cwd?: '/workspace/…', timeoutMs }` → `{ exit, stdout, stderr }` (each capped at 64 KiB, redacted) | `sandbox.exec` | own container; argv array; timeout ≤ remaining wall clock; output is **not evidence** | the worktree only |
| `job.request` | `{ recipeId, inputs: [{ versionId, role }], params }` → `{ jobId }` | `job.request` + the recipe's capability | recipe ∈ domain recipes; inputs ⊆ token inputs ∪ own outputs; params schema; child-job budget (default 20) | yes |
| `artifact.registerVersion` | `{ target: { new: { kind, name } } \| { revise: artifactId }, storage: { outPath } \| { commit }, metadata, inputs, clientKey }` → `{ versionId, status: 'draft' }` | `artifact.register` | kind ∈ domain produced kinds; owner = the job's participation; register validators run inline; idempotent per (job, clientKey) | yes |
| `validation.request` | `{ versionId }` → `{ jobId }` | `artifact.register` | own drafts only | yes |
| `review.request` | `{ versionId, note }` | `review.request` | own versions | notification |
| `approval.request` | `{ reason: 'egress.deps' \| 'egress.weights', recipeId, summary }` → `{ approvalId }` | `approval.request` | reason ∈ the domain's allowed reasons | pending record |
| `handoff.create` | `{ toParticipationId, versionIds, title, note? }` → `{ handoffId }` | `handoff.create` | B1 send rules; status `sent`; created by the agent principal on behalf of the user | yes |
| `qa.plan.upsert`, `qa.case.upsert` | plan or case drafts | `test.author` | QA participation | yes |
| `defect.propose` | `{ failingResultId, severity, title, repro, expected, actual }` | `defect.propose` | result in the project | yes (`proposed`) |

**Absent on purpose:** promote, discard, archive, review decisions, accept a change set, merge, accept or decline a handoff, convert, deliver, close, confirm or close a defect, sign, select a checkpoint, conclude an experiment, mark complete, answer an approval, any secret or credential tool, any network tool, any deployment beyond the local service recipes.

### 6.3 Recipes (tools that produce evidence)

Profile `engine` recipes run in the runner without a container because they only hash files, read git state or compute over records main hands them. Every other recipe runs in its pinned image with `--network none` unless the network column says otherwise.

| Recipe | Domains | Profile | What it runs (abridged argv) | Output contract | Network | Retry | Capability | Sub-phase |
|---|---|---|---|---|---|---|---|---|
| `repo.snapshot` | all (platform) | engine | `git rev-parse`, `merge-base --is-ancestor` (async `runGit`) | git facts | — | idempotent ×3 | platform | B2a |
| `sde.deps.node` | SDE, QA | sde-node | `npm ci --ignore-scripts` into `/out/deps` (cache keyed by profile + lockfile sha256) | exit, manifest | egress-approved | idempotent ×2 | `test.run` + approval | B2a |
| `sde.deps.python` | SDE | sde-python | `pip install --only-binary=:all: --require-hashes -r <lock> --target /out/deps` | exit, manifest | egress-approved | idempotent ×2 | same | B2a |
| `sde.test.discover` | SDE | sde-node / sde-python | `pytest --collect-only -q` / `npx jest --listTests` / `npx vitest list` | `ids.txt` | none | idempotent ×2 | `test.run` | B2a |
| `sde.test.npm` | SDE | sde-node | `npm test` with a JUnit reporter forced to `/out/junit.xml` | `junit.xml` | none | ×1 | `test.run` | B2a |
| `sde.test.pytest` | SDE | sde-python | `pytest -q --junitxml=/out/junit.xml` (+ `--cov-report=xml:/out/coverage.xml` when configured) | `junit.xml` | none | ×1 | `test.run` | B2a |
| `sde.typecheck` | SDE | sde-node | `npx tsc --noEmit` | exit | none | ×1 | `test.run` | B2a |
| `sde.build.node` / `sde.build.python` | SDE | sde-node / sde-python | `npm run build` → `/out/dist`; `python -m build --wheel --outdir /out/dist` | `manifest.json` | none | ×1 | `build.request` | B2a |
| `sde.app.assemble` | SDE | engine | read and validate `nexus.app.json` at the build's commit | schema | — | idempotent | `build.request` | B2a |
| `sde.preview.start` | SDE, QA | per manifest + `nexus-fwd` | manifest `run` argv as a service | health | service-internal | ×1 | `preview.request` | B2a |
| `sde.diagnose` | SDE | engine | `docker inspect`, probe table, log ranges | report | — | idempotent | `build.request` | B2a |
| `qa.collect` | QA | qa-web | `pytest --collect-only -q` / `npx playwright test --list` | `ids.txt` | none | idempotent ×2 | `test.run` | B2c |
| `qa.pytest.api` | QA | qa-web | `pytest tests/api --base-url {param:baseUrl} --junitxml=/out/junit.xml` | `junit.xml` | test-internal | ×1 | `test.run` | B2c |
| `qa.playwright` | QA | qa-web | `npx playwright test --reporter=junit` (output forced to `/out/junit.xml`) | `junit.xml` | test-internal | ×1 | `test.run` | B2c |
| `qa.rerun.cases` | QA | qa-web | suite argv filtered to ids, `--count` repeats | `junit.xml` | test-internal | ×1 | `test.run` | B2c |
| `qa.regression.compute`, `qa.report.compute` | QA | engine | SQL over `test_results` and `defects` | computed JSON | — | idempotent | `artifact.register` | B2c |
| `data.register`, `data.register.folder` | DA, DS, ML, DL | engine | stream-hash into the blob store or an external manifest | manifest | — | idempotent | `data.register` | B3 |
| `data.profile` | DA, DS, ML | data-python | `python -m nexus_tools.profile --in /in/dataset --out /out` | `profile.json` | none | idempotent ×2 | `data.read` | B3 |
| `data.derive` | DA, DS, ML | data-python | `python -m nexus_tools.duckdb_query --sql /in/query.sql --bind … --as-dataset --out /out` | `result.parquet`, `result.json` | none | idempotent | `data.register` | B3 |
| `da.query.run` | DA, DS, ML | data-python | same tool, snapshot mode, `--max-rows 5000000` | `result.parquet`, `result.json` | none | idempotent ×2 | `sql.query` | B3 |
| `da.analysis.run` | DA | data-python | `python <script at commit> --in /in --out /out` | `summary.json`, figures | none | ×1 | `data.read` | B3 |
| `da.chart.render` | DA | data-python | `python -m nexus_tools.render_vegalite` | `chart.svg`, `chart.png` | none | idempotent | `artifact.register` | B3 |
| `report.render` | DA, DS | data-python | `python -m nexus_tools.render_report` (tokens resolved from `/in/refs.json`, HTML sanitized) | `report.html`, `refs.json` | none | idempotent | `artifact.register` | B3 |
| `export.bundle` | DA, DS, QA | engine | zip of sanitized HTML and referenced snapshot files | bundle | — | idempotent | `artifact.read` | B3 |
| `ds.notebook.run` | DS | data-python | `papermill <nb> /out/executed.ipynb -p seed … -p data_dir /in/data` + `jupyter nbconvert --to html` | executed ipynb, html | none | ×1 | `notebook.run` | B4 |
| `ds.stats.describe`, `ds.stats.test` | DS | data-python | `python -m nexus_tools.stats` | `stats.json` | none | idempotent | `stats.run` | B4 |
| `data.split` | DS, ML, DL | data-python / dl-cpu | `python -m nexus_tools.split --seed … --strategy …` | split manifests | none | idempotent | `data.register` | B4 |
| `ds.train.baseline` | DS | data-python | `python -m nexus_tools.train_baseline --estimator <enum>` | model, `signature.json`, `metrics.json` | none | ×1 | `model.train.cpu` | B4 |
| `ds.evaluate`, `ml.evaluate`, `dl.evaluate` | DS, ML, DL | own image | `python -m nexus_tools.evaluate --model /in/model --data /in/split --split test` | `metrics.json` | none | idempotent ×2 | `model.evaluate` | B4, B5, B6 |
| `ml.data.validate` | ML, DS | ml-python | `python -m nexus_tools.expectations` | `checks.json` | none | idempotent | `data.read` | B5 |
| `ml.deps.python` | ML | ml-python | as `sde.deps.python` for training extras | manifest | egress-approved | idempotent ×2 | approval | B5 |
| `ml.train` | ML | ml-python | `python <entry at commit> --data /in/data --out /out --seed … --params /in/params.json` | `metrics.json`, `signature.json`, model file | none | ×1 | `model.train.cpu` | B5 |
| `ml.infer.sample` | ML | ml-python | `python -m nexus_tools.infer_test --model /in/model --samples 32` | infer report | none | idempotent | `model.evaluate` | B5 |
| `ml.package` | ML | ml-python | `python -m nexus_tools.package --template <pkg template>` | `pkg.tar`, lockfile | none | idempotent | `model.package` | B5 |
| `ml.inference_test` | ML | ml-python | `python -m nexus_tools.infer_test --package /in/pkg --repeat 3` | infer report | none | idempotent | `model.evaluate` | B5 |
| `ml.serve.start`, `dl.serve.start` | ML, DL | ml-python / dl-cpu + `nexus-fwd` | template service | health | service-internal | ×1 | `model.serve` | B5, B6 |
| `ml.serve.contract`, `dl.serve.contract` | ML, DL | ml-python / dl-cpu | `python -m nexus_tools.contract --url http://svc:<port>` | contract report | test-internal | idempotent | `model.serve` | B5, B6 |
| `ml.monitor.compute` | ML | ml-python | `python -m nexus_tools.monitor --log /in/predictions.jsonl --reference /in/ref` | `monitor.json` | none | idempotent | `model.evaluate` | B5 |
| `dl.preprocess` | DL | dl-cpu | `python <pipeline at commit> --in /in --out /out` | manifest, shapes | none | ×1 | `data.register` | B6 |
| `dl.arch.check` | DL | dl-cpu | `python -m nexus_tools.arch_check --entry … --input-shape …` | `arch.json` | none | idempotent | `model.train.cpu` | B6 |
| `dl.train.cpu`, `dl.resume` | DL | dl-cpu | `python <entry> --config … --data /in/data --out /out [--resume /in/ckpt]` | `metrics.jsonl`, `checkpoints/*.pt` | none | ×1 | `model.train.cpu` | B6 |
| `dl.ckpt.load` | DL | dl-cpu | `python -m nexus_tools.load_check` | load report | none | idempotent | `model.evaluate` | B6 |
| `dl.export.onnx`, `dl.parity`, `dl.quantize`, `dl.benchmark` | DL | dl-cpu | `nexus_tools.export_onnx`, `parity`, `quantize` (dynamic int8), `benchmark` | onnx, parity, bench JSON | none | idempotent | `model.export` / `model.optimize` | B6 |
| `dl.weights.fetch` | DL | dl-cpu | `python -m nexus_tools.fetch_weights --entry <enum of the pinned registry>` (URL + sha256 + license) | weights, license | egress-approved (pinned hosts) | idempotent | approval | B6 |

`nexus_tools` is a Nexus-owned Python package installed in the data, ML and DL images (`infra/images/common/nexus_tools/`), with its own unit tests (`python -m nexus_tools --selftest` runs in each image build).

### 6.4 Skills per domain

Skills are Nexus-owned `SKILL.md` bundles (`resources/skills/nexus-*`), hashed and copied read-only into the job's config directory. A job gets only its domain's skills relevant to its inputs. Skills teach; they never grant.

| Domain | Skills |
|---|---|
| SDE | `nexus-sde-change`, `nexus-sde-tests-first`, `nexus-sde-requirement-draft`, `nexus-sde-app-manifest`, `nexus-sde-fix-defect`, `nexus-sde-api-from-model` (B5) |
| QA | `nexus-qa-plan-from-requirements`, `nexus-qa-strategy`, `nexus-qa-cases-from-requirements`, `nexus-qa-cases-from-openapi`, `nexus-qa-pytest-author`, `nexus-qa-playwright-author`, `nexus-qa-triage-failure` |
| DA | `nexus-da-duckdb-sql`, `nexus-da-cleaning`, `nexus-da-chart-vegalite`, `nexus-da-report`, `nexus-da-insight` |
| DS | `nexus-ds-eda`, `nexus-ds-features`, `nexus-ds-hypothesis-test`, `nexus-ds-baseline-model`, `nexus-ds-report` |
| ML | `nexus-ml-expectations`, `nexus-ml-features`, `nexus-ml-train-contract`, `nexus-ml-evaluate`, `nexus-ml-package`, `nexus-ml-serving-handoff` |
| DL | `nexus-dl-preprocess`, `nexus-dl-architecture`, `nexus-dl-train-contract`, `nexus-dl-small-cpu`, `nexus-dl-export` |

### 6.5 What each domain agent can do, end to end

| Domain | Real operations the agent performs (all through capabilities above) | What it hands to the user |
|---|---|---|
| SDE | reads the repository; edits code and tests in its worktree; runs commands in its container (`sandbox.exec`); requests test, typecheck and build recipes; commits on its job branch; registers the change set; drafts a requirement or `nexus.app.json`; requests a review | review and accept the change set; merge accepted work |
| QA | drafts the plan, strategy and cases; writes pytest and Playwright tests in `tests/**`, `e2e/**`; requests discovery and test runs against a preview; proposes defects from failing results | confirm defects; record manual results; sign the release recommendation |
| DA | inspects profiles; writes cleaning and analysis SQL; runs queries; writes chart specs; drafts reports with reference tokens and insights with evidence | review and promote; export |
| DS | writes notebooks and feature SQL; runs notebooks and statistics; trains baselines; evaluates; drafts reports | pre-register hypotheses; record conclusions; promote; hand off |
| ML | writes expectations, feature definitions and training code; requests training, evaluation, packaging, serving and monitoring recipes; requests dependency egress | promote models (after the validation gates); start serving; hand off |
| DL | writes preprocessing, architecture and training code; requests checks, training, export, parity, quantization and benchmarks | select checkpoints; promote exports; approve weight downloads |

---

## 7. Validation strategy

### 7.1 Framework

```ts
// src/shared/nexus/validation.ts
export type ValidatorStage = 'register' | 'candidate' | 'promote';
export interface ValidatorDef {
  id: ValidatorId; version: string; kinds: KindId[]; domains: WorkspaceId[];
  stage: ValidatorStage;
  executes: 'main' | 'runner' | { recipe: RecipeId };    // pure TS in main, a runner parser, or a sandbox job
  blocking: boolean;                                      // a DomainSpec may make it stricter, never weaker
  advisory: boolean;                                      // LLM-assisted or heuristic flags: never gate anything
  evidence: EvidenceType[];
  timeoutMs: number;
}
export type EvidenceType = 'hash' | 'number' | 'exit' | 'junit' | 'schema' | 'file' | 'http' | 'git' | 'user' | 'inspect' | 'log';
export type Evidence =
  | { type: 'hash'; label: string; sha256: string }
  | { type: 'number'; name: string; value: number; bound?: { op: '>=' | '<=' | '==' | '<' | '>'; value: number };
      source: { blobSha256: string; pointer: string } }                 // JSON pointer into a hashed file
  | { type: 'exit'; code: number | null; signal?: string; oomKilled?: boolean }
  | { type: 'junit'; sha256: string; total: number; passed: number; failed: number; errored: number; skipped: number }
  | { type: 'schema'; schemaId: string; errors: { path: string; message: string }[] }
  | { type: 'file'; path: string; sha256: string; bytes: number }
  | { type: 'http'; method: 'GET' | 'POST'; path: string; status: number | null; ms: number | null; bodySha256?: string }
  | { type: 'git'; commit: string; check: 'resolves' | 'ancestor' | 'merge_tree_clean' | 'paths_in_scope'; detail: string }
  | { type: 'user'; principalKind: 'user'; action: string; at: number }
  | { type: 'inspect'; field: string; value: string | number | boolean }  // from docker inspect
  | { type: 'log'; attemptId: string; stream: 'stdout' | 'stderr'; offset: number; length: number; sha256: string };
export interface ValidationResult {
  id: string; versionId: string; validatorId: ValidatorId; validatorVersion: string;
  status: 'passed' | 'failed' | 'error' | 'skipped';      // error = could not run; never a pass
  blocking: boolean; advisory: boolean; summary: string; evidence: Evidence[];
  jobId?: string; startedAt: number; finishedAt: number;
}
```

- **`register`** validators run in main inside `registerVersion` (cheap; schema, hashes, git path scope). A failure rejects the registration with reasons (the agent sees them).
- **`candidate`** validators run as `validate` jobs right after ingest. All blocking ones must pass for `draft → candidate`.
- **`promote`** validators run when the user promotes (checks that depend on other versions, such as `ml.no_regression` against a baseline).
- Validator versions are recorded; upgrading a validator never rewrites old results; "re-validate" writes new rows.
- Advisory validators (`llm.review_notes`, `report.unreferenced_numbers`, `data.feature_leakage`, `qa.tests_have_assertions`) show as notes in the Folio and never gate.

### 7.2 The trust boundary for outputs

Anything a container writes was produced next to untrusted code (the user's repository, a training script, test code an agent wrote). Nexus therefore separates **reported** facts from **verified** facts:

| Fact | Produced by | Status | How Nexus verifies it |
|---|---|---|---|
| Test results | the test framework running the project's tests | reported by the framework, bound to a commit and image | the JUnit file is hashed by the runner on exit; counts must equal parsed rows; ≥ 1 test executed; executed ids ⊆ ids from a **separate** discovery job; exit code consistent with failures; the commit is checked out fresh by Nexus |
| Training metrics | the user's training code | **reported**, labelled "reported by the training run" | never used for promotion gates |
| Evaluation metrics | Nexus's evaluator in a separate job, fresh container, read-only model and split | verified | split disjointness checked by row hashes; the evaluator's code is pinned in the image |
| Model loadability | Nexus's load check in a fresh container | verified | signature shapes compared |
| Service health | Nexus's probe from outside the service container | verified | status, latency, contract checks against the signature |
| Build output | the project's build script | output identity verified | per-file hashes of `/out/dist`; non-empty; exit 0 |
| Data profile | Nexus's DuckDB profile tool | verified | runs on read-only inputs whose hashes match the manifest before and after |
| Quality numbers | Nexus SQL over `test_results` and `defects` | verified | recomputed by the validator |

The UI labels reported values as reported. Honest limit: a passing test suite proves that **these** tests passed on **this** commit in **this** image; whether the tests are meaningful is a human judgement (review of the test code, QA's independent suite). Nexus never claims more.

### 7.3 Validators per artifact type

| Kind | Validator | Stage | Blocking | Evidence recorded |
|---|---|---|---|---|
| any blob-backed | `blob.integrity` | candidate | ✓ | `hash` (re-hash of the stored object equals its id) |
| `repository` | `git.head_resolves` | register | ✓ | `git` (commit resolves, `%H` equals the stored sha) |
| `requirement` | `req.schema` | register | ✓ | `schema` |
| `problem_statement` | `problem.schema` | register | ✓ | `schema` |
| `change_set` | `git.diff_nonempty` | register | ✓ | `git` (diffstat) |
| | `git.paths_in_scope` | register | ✓ | `git` (every changed path inside the domain's `code.edit` scope; no `.git/**`, no sensitive names) |
| | `sec.secret_scan` | register | ✓ | `file` (added lines scanned with the B1 `containsSecret` rules; hits listed by path and line, never the text) |
| | `sde.tests_pass` | candidate | ✓ | `junit`, `exit`, `hash` (image digest, lockfile) |
| | `sde.typecheck_ok` | candidate | ✓ when `tsconfig.json` exists | `exit`, `log` |
| | `git.applies_cleanly` | candidate, re-checked at accept | ✓ | `git` (`merge-tree` against the integration ref) |
| | `llm.review_notes` | candidate | advisory | — |
| `test_suite` | `suite.discovered` | register | ✓ | `hash` (id list), `number` (count ≥ 1) |
| `build` | `build.exit_zero`, `build.manifest_present`, `build.output_hashed` | candidate | ✓ | `exit`, `file`, `hash` |
| `application` | `app.manifest_schema` | register | ✓ | `schema` |
| | `app.preview_health` | candidate | ✓ | `http`, `inspect` (running, port bound to 127.0.0.1 through the forwarder) |
| `diagnostic_report` | `diag.schema` | register | ✓ | `schema`; every field carries an `inspect`, `http` or `log` source |
| `test_plan` | `qa.plan_schema`, `qa.strategy_complete` | register | ✓ | `schema`, `number` (criteria without a level = 0) |
| `test_case` | `qa.case_schema` | register | ✓ | `schema` |
| | `qa.case_refs_resolve` | candidate | ✓ (automated) | `hash` (discovery list), `file` |
| `test_run` | `qa.junit_parsed` | candidate | ✓ (automated) | `junit` |
| | `qa.counts_consistent` | candidate | ✓ | `number` (counts = rows) |
| | `qa.build_bound` | candidate | ✓ | `hash` (build and application version hashes), `inspect` (the preview's image and the build's manifest hash match) |
| | `qa.manual_complete` | candidate | ✓ (manual) | `number`, `user` |
| | `qa.tests_have_assertions` | candidate | advisory | — |
| `defect` | `qa.defect_links` | register | ✓ | `hash` (failing result row, build version) |
| | `qa.retest_newer_build` | rule for `verified` | ✓ | `git` (ancestor), `number` (build `version_no`), `junit` |
| `regression_report`, `quality_report` | `qa.report_numbers_engine_computed` | candidate | ✓ | `number` (recomputed = stored) |
| `release_recommendation` | `qa.signed_by_user` | register | ✓ | `user` |
| `dataset` | `data.manifest_hashed` | register | ✓ | `hash` |
| | `data.readable`, `data.schema_inferred`, `data.profile_computed` | candidate | ✓ | `file` (`profile.json`), `schema`, `number` (rows) |
| | `data.split_disjoint` | candidate (splits) | ✓ | `number` (shared row hashes = 0) |
| | `dl.labels_resolve` | candidate (DL folders) | ✓ | `number` (unlabelled files = 0) |
| | expectation results (`exp.<id>`) | candidate (when an expectation suite is bound) | ✓ | `number` (observed vs bound), `file` (`checks.json`) |
| `query` | `da.sql_readonly` | register | ✓ | `schema` (token list of the single statement) |
| | `da.sql_explains`, `da.result_snapshot` | candidate | ✓ | `exit`, `hash`, `number` (rows, `truncated`) |
| `analysis` | `da.analysis_ok` / `ds.notebook_no_error_cells`, `ds.params_recorded`, `ds.seed_recorded`, `ds.stats_schema` | candidate | ✓ | `exit`, `schema`, `number` (error cells = 0) |
| `chart` | `da.vegalite_schema`, `da.bindings_resolve`, `da.render_ok` | candidate | ✓ | `schema`, `hash` |
| `dashboard` | `da.dashboard_bindings` | candidate | ✓ | `schema` |
| `report` | `doc.utf8_markdown`, `report.refs_resolve` | candidate | ✓ | `file`, `number` (unresolved tokens = 0) |
| | `report.unreferenced_numbers` | candidate | advisory | — |
| `insight` | `insight.has_evidence` | register | ✓ | `hash` (resolved evidence versions) |
| `feature_set` | `fs.schema` | candidate | ✓ | `schema` |
| | `data.feature_leakage` | candidate | advisory | — |
| `expectation_suite` | `exp.schema` | register | ✓ | `schema` |
| `experiment` | `ds.hypothesis_schema`, `ml.experiment_schema` | register | ✓ | `schema` |
| | `ds.hypothesis_preregistered` | candidate | label | `user` (pre-registration time < result job creation time) |
| | `ds.min_sample`, `ds.stats_schema` | candidate | ✓ | `number` |
| | `dl.comparison_engine_computed` | candidate | ✓ | `number` (recomputed table) |
| `training_run` | `ml.metrics_schema` / `dl.metrics_monotonic_steps`, `dl.no_nan_loss` | candidate | ✓ | `number`, `file` |
| `checkpoint` | `dl.ckpt_loads` | candidate | ✓ | `exit` (fresh container) |
| `model` | `ml.model_file_hashed`, `ml.signature_schema` | register | ✓ | `hash`, `schema` |
| | `ml.model.load_infer` / `ds.model.baseline` | candidate | ✓ | `exit`, `number` (output shape match) |
| | `ml.no_regression`, `ml.thresholds_met`, `ml.slice_parity` | promote | ✓ | `number` with pointers into the evaluation's `metrics.json` |
| `evaluation` | `eval.disjoint`, `eval.metrics_schema`, `eval.bound_dataset` | candidate | ✓ | `number`, `hash` |
| `serving_package` | `ml.pkg.lockfile_pinned`, `ml.pkg.size_cap` | register | ✓ | `hash`, `number` |
| | `ml.pkg.predict_runs`, `ml.pkg.deterministic` | candidate | ✓ | `exit`, `hash` (outputs ×3 equal) |
| `inference_service` | `svc.health`, `svc.contract` | candidate | ✓ | `http`, `number` (p50/p95), `hash` (outputs) |
| `monitoring_report` | `mon.numbers_engine_computed` | candidate | ✓ | `number`, `log` |
| `preprocessing_pipeline` | `dl.pipeline_deterministic` | candidate | ✓ | `hash` (two runs equal) |
| `architecture` | `dl.arch_instantiates` | candidate | ✓ | `exit`, `number` (params), `schema` (shapes) |
| `model_export` | `dl.onnx_checker`, `dl.parity`, `dl.quant_delta` | candidate | ✓ | `exit`, `number` (max abs diff vs tolerance; accuracy delta) |
| `benchmark` | `bench.schema` | candidate | ✓ | `number`, `hash` |

### 7.4 Evidence model: what proves each step, and why it is not a heuristic

| Lifecycle step | Proof | Why it is not a heuristic |
|---|---|---|
| Repository, code | resolved commit sha and tree hash from git | identity, not presence; a folder with files but no resolvable commit is not a repository version |
| AI-assisted implementation | a diff between two recorded commits, inside the scope, without secrets | the agent's message is ignored; the platform reads git |
| Tests | JUnit parsed into rows, sha256 of the file, ≥ 1 executed, counts consistent with discovery and with the exit code, bound to commit and image digest | an exit code alone is never accepted: exit 0 with zero tests is `failed: no_tests`; a JUnit claiming tests discovery never saw fails `qa.case_refs_resolve` / `sde.tests_pass` |
| Review, accept | a `reviews` row by a user principal; a merge commit and a ref CAS | UI state is not a record; only the stored rows count |
| Build | exit 0 and a per-file manifest of the output with its hash | file existence is not enough: the manifest must be non-empty, hashed and tied to commit, lockfile and image |
| Application, dev deployment | manifest schema, `docker inspect` running, HTTP probe 200 on the declared path within 60 s | a started container is not a healthy app; the probe result is stored |
| Logs/diagnostics | byte ranges with hashes, inspect fields, probe table | records facts, draws no conclusion |
| QA execution | per-case rows with outcome, bound to build, application and preview deployment | a run on a different build cannot satisfy a rule about this build |
| Defect fixed, verified | git ancestry from the build's repository snapshot to the fixing change set, then a passing rerun on a higher `version_no` | commit messages ("fixes #12") are never read |
| Quality report, release | numbers recomputed by SQL; signature by a user principal | the narrative is display only |
| Dataset, inspection | per-file sha256 manifest; profile computed by DuckDB over the hashed inputs; size and mtime re-checked before and after each job | a README or a file name says nothing about content |
| Query, cleaning | read-only SQL (token-level guard), result Parquet hashed, row counts | the SQL text and the snapshot are tied by hashes |
| Chart, dashboard, report | spec bound only to query snapshot ids; render hash; every report token resolved | numbers typed into prose are flagged, not trusted |
| Experiment | pre-registration version committed before the result job existed; `stats.json` with finite values; n ≥ minN | post-hoc hypotheses are labelled exploratory automatically |
| Training | exit, model file hash, reported metrics labelled as reported | promotion never relies on them |
| Evaluation, validation gates | Nexus evaluator in a separate job on a disjoint split; gates compare recorded numbers to stated thresholds | the training code cannot write its own grade |
| Packaging, serving | bundle hash; deterministic outputs ×3; HTTP contract checks against the signature | a running process is not a working endpoint |
| Monitoring | numbers computed from a hashed prediction log | no sampling of UI state |
| DL export, optimization | ONNX checker; parity max abs diff on fixed samples; accuracy delta from two Nexus evaluations | "exported" means verified equivalent within tolerance |

### 7.5 Validation failure handling

| Situation | Result |
|---|---|
| A blocking validator fails | version → `failed` (draft) or promote refused (candidate) with the result shown; the job may still be `completed` |
| A validator cannot run (`error`) | version stays `draft`; "Validation could not run: <reason>" with a retry action; never a pass |
| A validator times out | `error` with reason `timeout` |
| An advisory validator flags | note in the Folio; no gating |
| A validator is upgraded | old results stay; "Re-validate with v2" writes new rows |

### 7.6 Completion rules

The A–Z completion DSL (N.1) is kept as pure data evaluated by `src/shared/nexus/completion.ts` over a snapshot main loads with SQL. A domain participation is complete when its rule set holds and the user confirms; the evaluator's witnesses (version ids and validation result ids) are stored with the completion. Rule sets ship with each domain's sub-phase. Examples:

| Rule id | Holds when |
|---|---|
| `sde.accepted-change` | ≥ 1 active `change_set` that `implements` an active requirement and is contained in the latest repository snapshot |
| `sde.build-of-head` | an active `build` `built_from` the latest repository snapshot |
| `sde.app-healthy` | an active `application` `assembled_from` that build, with a passed `app.preview_health` |
| `qa.executed` | every case of the latest active plan has a result on the build under test |
| `qa.exit-criteria` | the plan's numeric exit criteria hold over the computed quality report |
| `qa.no-blockers` | no `open` or `fixed` defect of severity S1/S2 on the application artifact, across all builds |
| `qa.report-signed` | an active `release_recommendation` `based_on` the active quality report of that build (a signed `no-go` completes QA and is surfaced as such) |
| `da.deliverable` | an active dashboard or report whose every binding resolves to an active query of an active dataset |
| `ds.result` | an active experiment with a recorded conclusion, or an active evaluation of a baseline model |
| `ml.package` | an active serving package whose model's promote gates passed |
| `dl.export` | an active model export with `dl.parity` passed |

No rule reads a file's existence, a README, a test exit code alone, or UI state.

---

## 8. Cross-domain handoff matrix

### 8.1 Rules carried from B1 and extended

- A handoff carries 1–20 version ids of the **sender's own** candidate or active versions, with their content hashes, to another active participation of the **same project** (B1 triggers).
- Accept creates a `handoff_receipt` holding references only, with `depends_on` edges (source `handoff_convert`) to each subject (B1 rulings C1, C18).
- **New in B2c:** a route table (from, to, kinds, action), an action stored per handoff (`handoff_details.action`), conversion to work, delivery against an acceptance rule, closing, comments, and return/supersede links.
- **Conversion** creates the receiving domain's first job with every subject version as a `job_inputs` row. Lineage from the receiver's outputs to the sender's versions is then written by ingest (`job_input` edges), so cross-domain lineage is real without copying anything. Everything the receiver produces is a **new artifact owned by the receiving participation** (F.1a).
- **Agents** may send handoffs (`handoff.create`, B2c); only users accept, decline, convert, deliver or close.
- A newer subject version after sending never changes the handoff; the UI shows "a newer version exists" (B1) and offers re-send with `supersedes`.

### 8.2 Route table

| From → To | Subject kinds | Action | Conversion job (receiver) | Acceptance rule for "delivered" | Sub-phase |
|---|---|---|---|---|---|
| SDE → QA | `application`, `build`, `requirement`, `test_suite` | `test` | `qa.plan` agent turn or a manual plan; preview of the application version | a signed `release_recommendation` for the delivered build | B2c |
| QA → SDE | `defect` (+ `test_run`) | `fix` (`return_of` the `test` handoff) | `agent.run` `nexus-sde-fix-defect` with the defect and failing run as inputs | a new `application` version whose snapshot contains a change set that `fixes` the defect | B2c |
| QA → SDE | `release_recommendation`, `quality_report` | `release-gate` | none (information) | — (closed by the receiver's acknowledgement) | B2c |
| QA → any | `quality_report`, `regression_report` | `inform` | none | — | B2c |
| SDE → QA | `diagnostic_report` | `inform` | none | — | B2c |
| DA → DS | `dataset`, `query`, `insight`, `report`, `problem_statement` | `investigate`, `use-as-input` | `ds.notebook.run` or an agent turn with the subjects as inputs | an active DS `report` or `experiment` that `cites`/`tested_on` a subject | B4 |
| DS → DA | `report`, `insight` | `inform` | none | — | B4 |
| DA → ML | `dataset`, `insight` | `use-as-input`, `feature-idea` | `ml.data.validate` on the dataset | an active `feature_set` `derived_from` the subject | B5 |
| DS → ML | `model` (baseline), `evaluation`, `feature_set`, `dataset`, `report` | `productionize` | an ML experiment whose baseline is the DS evaluation | an active ML `model` whose `ml.no_regression{baseline: DS evaluation}` passed | B5 |
| ML → SDE | `serving_package` (+ `inference_service`, `evaluation`) | `create-api` (template `app.fastapi-predict@1`) | `agent.run` `nexus-sde-api-from-model` | an active `application` whose path `assembled_from → built_from → contains → change_set —serves→ package` exists | B5 |
| ML → QA | `inference_service` | `test-api` | QA API cases from the signature | a signed recommendation | B5 |
| ML → DA | `dataset` (predictions) | `inform` | none | — | B5 |
| DL → ML | `model_export`, `model`, `evaluation`, `benchmark` | `package` | `ml.package` with `pkg.onnx-predict@1` | an active `serving_package` that `packages` the export | B6 |
| DL → SDE | `model_export` | `create-api` (template `app.onnx-api@1`) | as ML → SDE | as ML → SDE | B6 |

### 8.3 The required flows, record by record

**SDE → QA → Defect → SDE → New Build → QA → Release** (REAL at B2c exit)

| # | Actor | Record written | Lineage |
|---|---|---|---|
| 1 | SDE user | `application@v1` (from `build@v1`), handoff H1 (`test`, subjects application@v1, build@v1, requirement@v1) | `assembled_from`, `built_from` |
| 2 | QA user | accept H1 → receipt R1; convert H1 → job J1 | `depends_on` (handoff_convert) |
| 3 | QA agent/user | `test_plan@v1→v2`, `test_case`s, QA `test_suite` | `depends_on` requirement; `covers` |
| 4 | System | preview of application@v1; `test_run` T1 (automated) + manual run M1 | `tests` build@v1, application@v1; `executes` plan |
| 5 | QA user | `defect` D1 confirmed from a failing T1 row | `found_in` build@v1; `evidenced_by` T1 |
| 6 | QA user | handoff H2 (`fix`, `return_of` H1, subject D1) → SDE accepts and converts | |
| 7 | SDE agent | `change_set` C2 with D1 as input; user accepts into the integration ref | `fixes` D1; `derived_from` repository |
| 8 | System | `repository@v3` snapshot; `build@v2`; `application@v2`; defect D1 → `fixed` (rule) | `contains` C2; `built_from`; `assembled_from` |
| 9 | SDE user | handoff H3 (`test`, `return_of` H2, subject application@v2) → QA accepts, converts | |
| 10 | QA | `test_run` T2 (`qa.rerun.cases`) on build@v2 → D1 `verified`; regression run T3 + manual M2; `regression_report`; `quality_report@v2` | `verified_by` T2; `summarizes` |
| 11 | QA user | signs `release_recommendation@v2` (`go`) | `recommends` build@v2; `based_on` quality report |
| 12 | Users | H3 delivered (recommendation exists); H2 delivered (retest holds), closed; H1 delivered through its chain, closed | |

**DA → DS → ML → SDE → QA → Release** (REAL at B5 exit): DA `dataset` and `insight` → handoff `investigate` → DS `experiment` (pre-registered, result), `feature_set`, baseline `model`, `evaluation`, `report` → handoff `productionize` → ML `experiment` with the DS evaluation as baseline, `training_run`s, Nexus `evaluation`, promoted `model` (gates passed), `serving_package`, `inference_service`, `monitoring_report` → handoff `create-api` → SDE change set that `serves` the package, `build`, `application`, dev deployment → handoff `test` → QA plan, runs, quality report, signed recommendation. Every arrow is a job with the previous domain's versions as inputs; no artifact is copied.

**DL → ML → SDE → QA** (REAL at B6 exit): DL `model_export` (parity passed) + `evaluation` + `benchmark` → handoff `package` → ML `serving_package` (`packages` the export), `inference_service` → `create-api` → SDE → QA as above.

---

## 9. Persistence/schema changes

### 9.1 Principles (unchanged from v7 and v8)

- **Additive only:** `CREATE … IF NOT EXISTS` and `INSERT OR IGNORE`. No `DROP`, no `ALTER`, no rewrite of an existing row, no FK added to an existing table, no change to the frozen `V7_DDL` or `V8_DDL` text. New facts about existing rows go into side tables (for example `handoff_details`, not new `handoffs` columns), so the v7 and v8 shape checks stay exact.
- **One migration per sub-phase that needs one, each separately approved.** Each is a sibling step after v8 in `PersistStore.open()`, reusing the v7/v8 helpers (pre-check, `VACUUM INTO` backup verified and hashed, one IMMEDIATE transaction, `verifyVn`, post-commit `quick_check`, failure marker, auto-hold after 3 failures, `nexus_migrations` row, one `db.migrated` activity row). The v7 and v8 steps, their log lines and outcomes stay byte-identical.
- **Hold switches cascade:** `NEXUS_DB_HOLD_V9=1` keeps the database at v8 (execution off, everything else on); `NEXUS_DB_HOLD_V8=1` implies V9 and later, and so on.
- **Feature availability follows the shape:** `executionAvailable` (v9 shape exact), `agentsAvailable` (v10), `qaAvailable` (v11), `dataAvailable` (v12), `dsAvailable` (v13), `mlAvailable` (v14). A held or failed step turns off only the channels that need it, with `platform_unavailable`, reason `<feature>_unavailable` and a `subReason` (`held`, `auto_held`, `backup_failed`, `failed`, `shape`), exactly like handoffs in B1.
- **Legacy tables are never written by a migration.** Every `verifyVn` compares every pre-existing table's row count with its pre-count (only `activity` +1 and `nexus_migrations` +1). `project_plans` (including the two `b0b-smoke` rows and the three older orphans) is never read for writing by any step or task.
- **`platformAvailable`** becomes `7 ≤ version ≤ <latest>` with the v7 shape check; the newer-schema branch moves to `from > <latest>`; `hasPlatformRecords` stays `version >= 7` and starts counting `jobs` (already), plus `deployments` and `test_results` are covered through their FKs to versions.
- **The restore tool** (`tools/nexus-db-restore.cjs`) learns each new hold switch (a v8 backup prints `NEXUS_DB_HOLD_V9=1 to stay on schema v8`, and so on).

### 9.2 v9 — execution core (B2a)

| Table | Columns (abridged) | Keys, triggers |
|---|---|---|
| `attempt_states`, `attempt_transitions` | lookup rows of [section 5.3](#53-job-attempt-new-v9) | PK; seeded |
| `job_attempts` | `id`, `job_id` → jobs, `n`, `state` → attempt_states, `lease_owner` (boot id), `lease_expires_at`, `heartbeat_at`, `exit_code`, `signal`, `oom_killed`, `outcome`, `sandbox_json` (container id, image digest, network mode, preflight report), `runtime_kind`, `runtime_ref`, `environment_json` (image digest, lockfile sha256, recipe version, seed, Nexus version), `log_path` (relative to the data home), `log_bytes`, `out_bytes`, `usage_json`, `started_at`, `finished_at` | `UNIQUE(job_id, n)`; partial unique `(job_id) WHERE state IN ('starting','running')`; triggers: transition table, identity immutable, no delete |
| `job_events` | `seq` AUTOINCREMENT, `job_id`, `attempt_n`, `ts`, `type` (enum), `data_json` (redacted, ≤ 4 KiB) | append-only (no update, no delete); `ix_job_events_job(job_id, seq)` |
| `blobs` | `sha256` PK, `bytes`, `media_type`, `created_at`, `last_referenced_at`, `verified_at` | no delete except by GC under its lock (a trigger allows delete only when no `version_blobs` row references it) |
| `version_blobs` | `version_id` → artifact_versions, `sha256` → blobs, `role` (`content`, `snapshot`, `render`, `log`, `manifest`, …), `path` | PK `(version_id, sha256, role)`; immutable |
| `validations` | `id`, `version_id`, `validator_id`, `validator_version`, `status`, `blocking`, `advisory`, `summary`, `evidence_json` (exact JSON, ≤ 64 KiB, secret-checked), `job_id`, `started_at`, `finished_at` | append-only; `ix_validations_version(version_id, validator_id, finished_at)` |
| `approval_states`, `approval_transitions` | lookup rows of [section 5.6](#56-approval-new-v9) | seeded |
| `approvals` | `id`, `project_id`, `job_id`, `session_id`, `reason` (enum), `summary`, `request_json`, `status`, `requested_by`, `on_behalf_of`, `requested_at`, `expires_at`, `decided_by`, `decided_at`, `decision` (`once`/`deny`) | transition trigger; decided fields set once |
| `deployment_states`, `deployment_transitions` | lookup rows of [section 5.7](#57-deployment-new-v9) | seeded |
| `deployments` | `id`, `project_id`, `participation_id`, `subject_version_id` (application, inference service), `job_id` (service job), `environment` (`local-preview`), `host_port`, `status`, `health_json` (last probes), `started_at`, `stopped_at` | transition trigger; no delete |
| new lineage relation rows | `covers`, `transformed_by`, `configured_by`, `monitors` with `planned_phase` B2c, B3, B6, B5 | **only with ruling R2** |
| new indexes on v7 tables | `ix_jobs_sched(state, priority, created_at)`; `ux_versions_job_path(produced_by_job_id, output_path) WHERE output_path IS NOT NULL`; `ux_repository_per_project` on `artifacts(project_id) WHERE kind = 'repository'`; `ix_versions_hash(content_hash)` | additive; the v7 shape check ignores extra objects |

### 9.3 v10 — agents (B2b)

| Table | Columns | Keys, triggers |
|---|---|---|
| `capability_tokens` | `jti` PK, `job_id`, `session_id`, `principal_id` (`agent:<sessionId>`), `on_behalf_of`, `caps_sha256`, `issued_at`, `expires_at`, `revoked_at` | revocation set once; no delete |
| `reviews` | `id`, `version_id`, `principal_id` (user only, CHECK by trigger), `decision` (`approve`, `request_changes`, `reject`), `comment` (≤ 4000, secret-checked), `created_at` | append-only |
| `change_set_accepts` | `version_id` PK, `integration_ref`, `ref_before`, `ref_after`, `merge_commit`, `accepted_by`, `accepted_at` | immutable |
| `repo_merges` | `id`, `project_id`, `branch`, `before`, `after`, `merged_by`, `merged_at`, `approval_id` | append-only (records "Merge accepted work") |
| agent principals | rows in `principals` with kind `agent`, id `agent:<sessionId>` (ruling R5), created at session open | rows, not schema |

### 9.4 v11 — QA and handoff lifecycle (B2c)

| Table | Columns | Keys, triggers |
|---|---|---|
| `test_results` | `run_version_id`, `test_id` (`classname::name[param]` or a case id), `attempt_no`, `case_artifact_id`, `outcome` (`passed`, `failed`, `errored`, `skipped`), `duration_ms`, `message_sha256`, `recorded_by` (system or user), `note` (manual, ≤ 2000) | `UNIQUE(run_version_id, test_id, attempt_no)`; immutable once the run version leaves draft |
| `defect_states`, `defect_transitions` | lookup rows of [section 5.8](#58-defect-new-v11) | seeded |
| `defects` | `artifact_id` PK, `status`, `severity`, `priority`, `found_in_build_version_id`, `failing_result_ref`, `fixed_in_build_version_id`, `verified_by_run_version_id`, `status_changed_at`, `status_changed_by` | transition trigger |
| handoff state rows | `converted` (0), `delivered` (0), `closed` (1); transitions `accepted→converted`, `converted→delivered`, `accepted→closed`, `converted→closed`, `delivered→closed` | seeded into the v8 lookup tables |
| `handoff_details` | `handoff_id` PK, `action`, `acceptance_json`, `delivery_json`, `delivered_versions_json`, `closed_reason` | written once per field |
| `handoff_links` | `handoff_id`, `kind` (`return_of`, `supersedes`), `other_id` | PK `(handoff_id, kind)`; immutable |
| `handoff_conversions` | `handoff_id`, `job_id`, `created_by`, `created_at` | immutable |
| `handoff_comments` | `id`, `handoff_id`, `principal_id`, `text` (≤ 2000, secret-checked), `created_at` | append-only |

### 9.5 v12 to v14 (B3, B4, B5)

| Version | Sub-phase | Contents |
|---|---|---|
| v12 | B3 | `exports` (id, project_id, version_ids_json, bundle_sha256, bytes, created_by, created_at) — the record of each publish; `external_checks` (version_id, checked_at, files, mismatches) for external datasets |
| v13 | B4 | `workspaces` row `data-scientist` (`INSERT OR IGNORE`); `experiment_conclusions` (version_id PK, conclusion text ≤ 4000, exploratory flag, concluded_by, concluded_at) — conclusions are recorded after the result version exists, so they cannot live in immutable metadata |
| v14 | B5 | `metrics` (version_id, name, step, value REAL, source `reported`/`evaluated`) with `ix_metrics(version_id, name)`; hot table for comparisons and gates |
| — | B6 | no migration expected: DL uses `metrics`, `deployments`, `validations` and the relations added in v9 |

### 9.6 Data home (files, not database)

```
<userData>/nexus/                       default; relocatable (decision D11)
  objects/<2 hex>/<62 hex>              content-addressed blobs (sha256); tmp/ for in-flight writes
  logs/jobs/<jobId>/<n>.log             JSONL frames {ts, stream, text}, redacted on write, 50 MB cap per attempt
  work/<jobId>/<n>/{in,out}             staging; deleted 24 h after success, 7 days after failure
  jobs/<jobId>/claude/                  per-job CLAUDE_CONFIG_DIR (settings, MCP config with the token file)
  skills/<id>@<version>/                Nexus-owned skills, read-only
  deps-cache/<profile>/<lockSha256>/    written only by approved install jobs, mounted read-only
  exports/                              bundles before the user saves them
<short root>\nx\w\<shortJobId>\         job and accept worktrees (MAX_PATH); git uses core.longpaths=true
```

Retention: versions, edges, validations, reviews, handoffs and activity forever; job logs 90 days after success and 180 after failure, never while a validation's evidence points into them; worktrees until their change set is accepted or discarded, then 7 days. Blob GC (B2a) is a two-step user action (dry run lists what would be freed; apply runs under an exclusive lock that ingest also takes in shared mode) and never removes a blob referenced by any version.

---

## 10. IPC/API contracts

### 10.1 Rules (B1 rules, unchanged)

- Every channel is registered in `src/main/nexusIpc/registerNexusIpc.ts`, runs through the one `handler()` wrapper (availability check → validation → principal `user:local` from main → one service call → envelope), and answers `NexusResult<T>`. Channels #1–#21 are unchanged.
- Arguments are ids, enums and schema-checked values only. No channel accepts a path, a command, a shell string, a principal, a role or a workspace "authority". Files enter only through main-process dialogs.
- Every write channel takes an `intentId` (a ULID the renderer creates and persists with the pending action), which becomes the job or session idempotency key, so a reload re-sends the same intent instead of starting a second job.
- **Push:** main sends `nexus:hint` with `{ lastSeq: number }` (no data) after it commits a job event, approval or deployment change. The renderer then pulls `nexus:events:since`. The preload exposes `onNexusHint(cb)`; the composition test pins this as the only `webContents.send` in the `nexus:` family.
- New availability reasons: `execution_unavailable`, `agents_unavailable`, `qa_unavailable`, `data_unavailable`, `ds_unavailable`, `ml_unavailable` (each with a `subReason`), and per-action `unavailable` answers carrying a `setup` reason (`docker_missing`, `docker_stopped`, `image_missing`, `disk_low`, `runtime_missing`, `credential_missing`, `gpu_unsupported`).

### 10.2 B2a channels

| # | Channel | Args | `data` | Errors beyond the common ones |
|---|---|---|---|---|
| 22 | `nexus:domains:list` | none | `DomainSpecView[]`: id, labels, vocabulary, lifecycle steps with status (REAL/PARTIAL/FUTURE), scope note, sub-phase, prerequisites, modules | none |
| 23 | `nexus:platform:health` | none | `HealthView`: database version and features; runner state; Docker (version, running, WSL2, CPUs, memory); images (profile, present, digest match, size); disk (free bytes at the data home and at the worktree root); runtimes (kind, version, health); GPU (detected, model, supported: false) | none |
| 24 | `nexus:actions:available` | `{ projectId, workspaceId, versionId? }` | `ActionAvailabilityView[]`: actionId, label, available, reason (`planned`, `future`, `setup:<id>`, `permission`, `blocked_by_step:<id>`), input slots | `not_found`, `denied` |
| 25 | `nexus:job:start` | `{ projectId, workspaceId, actionId, inputs: { versionId, role }[] (≤ 64), params: object, intentId }` | `{ job: JobView; created: boolean }` | `invalid` (`unknown_action`, `bad_params`, `input_not_allowed`), `unavailable` (setup), `participation_inactive`, `conflict` (same intent, different request), `denied` |
| 26 | `nexus:jobs:list` | `{ projectId?, workspaceId?, states?, kind?, limit? (≤ 500) }` | `JobView[]` newest first, `truncated` | none |
| 27 | `nexus:job:get` | `jobId` | `JobDetailView`: state, phase, outcome, error, recipe, inputs, attempts (state, times, exit, image digest, preflight summary), outputs (version ids), validation summary, approvals, deployment | `not_found`, `denied` |
| 28 | `nexus:job:logs` | `jobId`, `{ attempt, fromOffset, maxBytes ≤ 262144 }` | `{ text (redacted), nextOffset, eof, truncatedMiddle }` | `not_found`, `denied` |
| 29 | `nexus:job:cancel` | `jobId` | `JobView` (cancel requested or applied) | `illegal_transition` (terminal), `denied` |
| 30 | `nexus:job:retry` | `jobId`, `intentId` | `{ job: JobView }` (a new job with `retryOf`) | `illegal_transition` (not failed, timed out, cancelled or interrupted), `participation_inactive` |
| 31 | `nexus:events:since` | `{ sinceSeq, projectId?, limit? (≤ 500) }` | `{ events: EventView[]; lastSeq }` (job transitions, attempt progress, approvals, deployments, validations) | none |
| 32 | `nexus:version:validations` | `versionId` | `ValidationResultView[]` (latest per validator; evidence summarized; numbers with their source pointers) | `not_found`, `denied` |
| 33 | `nexus:version:revalidate` | `versionId`, `intentId` | `{ job: JobView }` | `illegal_transition` (not a draft), `denied` |
| 34 | `nexus:version:preview` | `versionId`, `{ part: 'content' \| 'render' \| 'table' \| 'manifest', maxBytes ≤ 1 MiB }` | `PreviewView`: text, a table page, an SVG (sanitized) or a manifest page | `not_found`, `denied`, `too_large` |
| 35 | `nexus:artifact:saveInline` | `{ projectId, workspaceId, kind (user-authorable), target: { artifactId } \| { name }, content: object }` | `{ artifact, version, created }` | `invalid` (`kind_not_authorable`, `bad_content`, `secret_in_metadata`), `participation_inactive`, `conflict` |
| 36 | `nexus:deployments:list` | `{ projectId?, status? }` | `DeploymentView[]` (url `http://127.0.0.1:<port>`, status, subject version, started) | none |
| 37 | `nexus:deployment:stop` | `deploymentId` | `DeploymentView` | `illegal_transition` |
| 38 | `nexus:approvals:list` | `{ projectId?, status? }` | `ApprovalView[]` | none |
| 39 | `nexus:approval:respond` | `approvalId`, `'once' \| 'deny'` | `ApprovalView` | `illegal_transition` (not pending), `denied` |
| 40 | `nexus:setup:prepareImage` | `profileId`, `intentId` | `{ approval: ApprovalView }` (shows download/build size and disk effect); after `once`, a `tool.run` of kind image preparation | `invalid` (unknown profile), `unavailable` (`docker_missing`) |
| 41 | `nexus:blobs:gc` | `{ apply: boolean }` | `{ candidates, bytes, removed }` | `conflict` (a job is ingesting) |

### 10.3 B2b channels

| # | Channel | Args | `data` | Errors |
|---|---|---|---|---|
| 42 | `nexus:agent:start` | `{ projectId, workspaceId, sessionId: string \| null, skillId?, focusVersionIds (≤ 20), message (≤ 8000), intentId }` | `{ session: SessionView; job: JobView }` | `unavailable` (`runtime_missing`, `credential_missing`, `docker_*`), `conflict` (a turn is already running in this session), `denied` |
| 43 | `nexus:sessions:list` | `{ projectId, statuses? }` | `SessionView[]` | `not_found`, `denied` |
| 44 | `nexus:session:get` | `sessionId` | `SessionDetailView`: turns (jobs), messages (display only), tool calls, registered versions, approvals | `not_found`, `denied` |
| 45 | `nexus:session:end` | `sessionId` | `SessionView` (`completed`) | `illegal_transition` |
| 46 | `nexus:session:cancel` | `sessionId` | `SessionView` (`cancelled`, jobs cancelled) | `illegal_transition` |
| 47 | `nexus:review:decide` | `versionId`, `{ decision: 'approve' \| 'request_changes' \| 'reject', comment? }`, `intentId` | `{ review: ReviewView; job?: JobView }` (request changes starts a turn) | `invalid` (comment required for request changes and reject), `denied` |
| 48 | `nexus:changeSet:accept` | `versionId`, `expectedIntegrationHead: string` (40 hex) | `{ version: VersionView; accept: ChangeSetAcceptView }` | `conflict` (`ref_moved`, with the current head), `merge_conflict`, `illegal_transition` (not candidate), `approval_required` (first repository write) |
| 49 | `nexus:repo:status` | `projectId` | `RepoStatusView`: branch, integration ref head, accepted-not-merged count, user tree clean | `not_found`, `denied` |
| 50 | `nexus:repo:mergeAccepted` | `projectId`, `{ branch, expectedAcceptedHead }` | `MergeView` (main shows a confirmation dialog listing the commits; `git merge --ff-only`) | `refused` (`tree_dirty`, `not_fast_forward`, `branch_mismatch`), `cancelled` (dialog) |

### 10.4 B2c channels

| # | Channel | Args | `data` | Errors |
|---|---|---|---|---|
| 51 | `nexus:handoff:convert` | `handoffId`, `{ actionId, params, intentId }` | `{ handoff: HandoffDetailView; job: JobView }` | `illegal_transition` (not accepted), `invalid` (action not on the route) |
| 52 | `nexus:handoff:deliver` | `handoffId`, `versionIds (1–20)` | `HandoffDetailView` with the acceptance evaluation | `invalid` (`acceptance_not_met`, with the failing rule) |
| 53 | `nexus:handoff:close` | `handoffId`, `{ reason? }` | `HandoffDetailView` | `invalid` (`close_rule_not_met`), `illegal_transition` |
| 54 | `nexus:handoff:comment` | `handoffId`, `text` | `CommentView` | `invalid` (`secret_in_metadata`) |
| 55 | `nexus:qa:manualRun:create` | `{ projectId, planVersionId, applicationVersionId, intentId }` | `{ artifact, version }` (draft run) | `invalid` (plan not active) |
| 56 | `nexus:qa:manualRun:record` | `runVersionId`, `{ caseArtifactId, outcome, note? }` | `ResultView` | `illegal_transition` (run submitted) |
| 57 | `nexus:qa:manualRun:submit` | `runVersionId` | `VersionView` (validators run) | `invalid` (`cases_missing`) |
| 58 | `nexus:defect:create` | `{ projectId, failingResultRef, severity, priority, title, repro, expected, actual }` | `{ artifact, version, defect: DefectView }` | `invalid` |
| 59 | `nexus:defect:transition` | `defectArtifactId`, `{ to: 'open' \| 'rejected' \| 'closed', note? }` | `DefectView` | `illegal_transition` (for example closing an unverified defect) |
| 60 | `nexus:qa:sign` | `qualityReportVersionId`, `{ decision: 'go' \| 'no-go' \| 'go-with-conditions', conditions? }` | `{ artifact, version }` (active recommendation) | `invalid` (report not active) |
| 61 | `nexus:completion:get` | `participationId` | `CompletionView`: rules, holds, witnesses, missing | `not_found`, `denied` |
| 62 | `nexus:completion:confirm` | `participationId`, `expectedEvaluationHash` | `ParticipationView` (`complete`) | `conflict` (records changed), `invalid` (rules do not hold) |

### 10.5 B3–B6 channels

| # | Channel | Args | `data` | Sub-phase |
|---|---|---|---|---|
| 63 | `nexus:dataset:register` | `{ projectId, workspaceId, mode: 'file' \| 'folder', target, intentId }` (main opens the dialog; the renderer never sends a path) | `{ job: JobView } \| { cancelled: true }` | B3 |
| 64 | `nexus:export:bundle` | `{ projectId, versionIds (1–50), intentId }` (main opens a save dialog after the bundle job) | `{ job: JobView }` then an export record | B3 |
| 65 | `nexus:experiment:conclude` | `versionId`, `{ conclusion, exploratory: boolean }` | `ExperimentConclusionView` | B4 |
| 66 | `nexus:inference:sendSamples` | `deploymentId`, `{ sampleSetVersionId, count ≤ 1000, intentId }` | `{ job: JobView }` (requests go through the internal network; responses logged) | B5 |
| 67 | `nexus:metrics:compare` | `{ versionIds (2–20), names? }` | `MetricsComparisonView` (engine-computed table; reported and evaluated metrics separated) | B5 |
| 68 | `nexus:checkpoint:select` | `checkpointVersionId`, `{ target: { artifactId } \| { name } }` | `{ artifact, version }` (model version, same blob) | B6 |

### 10.6 Views (shared types in `src/shared/nexus/ipc.ts`)

Views keep B1's rules: no principal ids (actor kinds and an `onBehalfOfUser` flag only), no host paths, no raw metadata, strings scrubbed and capped. Key shapes:

```ts
interface JobView { id: string; kind: 'agent.run' | 'tool.run' | 'validate' | 'ingest'; actionId?: string; recipeId?: string;
  projectId: string; workspaceId: string; state: JobState; phase?: string; outcome?: string; error?: { code: string; message: string };
  attempts: number; createdAt: number; startedAt?: number; finishedAt?: number; cancelRequested: boolean;
  progress?: { kind: 'steps'; done: number; total: number; label?: string } | { kind: 'indeterminate'; label: string };
  outputs: string[]; retryOf?: string; sessionId?: string }
interface EventView { seq: number; at: number; type: 'job.transition' | 'attempt.progress' | 'approval' | 'deployment' | 'validation' | 'tool.call';
  jobId?: string; projectId: string; summary: string }
interface ValidationResultView { validatorId: string; validatorVersion: string; status: 'passed' | 'failed' | 'error' | 'skipped';
  blocking: boolean; advisory: boolean; summary: string; finishedAt: number;
  evidence: ({ type: 'number'; name: string; value: number; bound?: string; source: string } | { type: 'hash'; label: string; short: string }
    | { type: 'junit'; total: number; passed: number; failed: number; errored: number; skipped: number }
    | { type: 'http'; path: string; status: number | null; ms: number | null } | { type: 'git'; check: string; short: string }
    | { type: 'exit'; code: number | null; oomKilled?: boolean } | { type: 'log'; jobId: string; offset: number; length: number })[] }
interface ApprovalView { id: string; reason: 'egress.deps' | 'egress.weights' | 'image.prepare' | 'repo.write_refs' | 'training.long';
  summary: string; status: 'pending' | 'approved' | 'denied' | 'expired' | 'withdrawn'; requestedAt: number; expiresAt: number; jobId?: string }
interface DeploymentView { id: string; projectId: string; subjectVersionId: string; url: string | null;
  status: 'starting' | 'healthy' | 'unhealthy' | 'stopped' | 'failed'; startedAt: number; lastProbe?: { status: number | null; ms: number | null; at: number } }
```

---

## 11. UI/workspace structure

### 11.1 What stays

The approved Spine + Folio interaction model and the shared shell stay: the project's **Spine** (left column; one group per active participation, artifact nodes in lifecycle order), the **Folio** focus area (where any version is read and reviewed with its evidence), the **Passport** (details, versions, lineage, handoffs, activity), and the global Artifacts and Handoffs pages from B1. Colour means provenance (hue slot per workspace), status is always words, and every screen shows real rows or an honest empty or unavailable state.

**Not allowed** (brief): an island launcher, generic dashboard cards, an office scene or office language, SaaS admin layouts, gradient "AI" styling, progress bars or percentages that no parser reported, "Coming soon" pages, placeholder data.

### 11.2 Shared primitives (built once, used by every domain)

| Primitive | What it shows | Source |
|---|---|---|
| **Lifecycle rail** | the domain's steps in order with their derived state (`unavailable`, `blocked`, `ready`, `in progress`, `done`, `failed`) and, for PARTIAL steps, the scope note; FUTURE steps are hatched, non-focusable, with "Not in this release: <reason>" | `nexus:domains:list` + records |
| **Run strip** | a job's stages: queued → provisioning → executing (parser progress or an honest "Running tests · 2 min") → collecting → validating; Cancel and Retry are real buttons | `jobs`, `job_attempts`, `job_events` |
| **Evidence pages** (Folio) | each validator result with its evidence: JUnit counts, numbers with their source file pointer, hashes (short), HTTP probes, git checks, log byte ranges that open the exact lines | `validations` |
| **Kind viewers** (Folio) | diff (change set), results grid failures-first (test run), table page (dataset, query snapshot), sanitized SVG (chart), sanitized HTML in a sandboxed iframe without scripts (report, notebook), metrics table with reported vs evaluated columns (training run, evaluation), parity and benchmark tables (export) | `nexus:version:preview` |
| **Needs you** | approvals pending, reviews requested, handoffs to answer, drafts with "validation could not run", defects proposed | approvals, reviews, handoffs, versions |
| **Action bar** | only actions that `nexus:actions:available` says are available; an unavailable action is not a disabled button but a sentence ("Docker Desktop is not running. Start it, then check again.") with a setup link | registry + availability |
| **Agent panel** | a session's turns: user messages, the agent's messages (display only, labelled), tool calls as rows (tool, short args, result size), the versions it registered with their validation state, approvals it requested | `nexus:session:get` |
| **Lineage strip** | sources and dependants of a version at depth 1, expandable | B1 lineage |

### 11.3 Workspace pages: shared shell, domain language

A workspace page is `WorkspacePage` driven by the domain's `modules` and `vocabulary`. Each module is a list of the domain's own artifacts (by kind, in its words) plus the actions its lifecycle allows. No module renders without real rows or an honest empty state.

| Domain | Modules (in its words) | Primary actions on the page |
|---|---|---|
| SDE | Requirements · Repository · Changes · Tests · Builds · Applications · Dev deployments · Diagnostics · Sessions | New requirement; Run tests on a commit; Build; Start dev deployment; Start agent session |
| QA | Inbox (handoffs) · Test plans · Cases · Test suites · Runs · Defects · Regression · Quality reports · Release decisions | Convert handoff; New plan; Start manual run; Run automated suite; Rerun cases; Sign |
| Data Analyst | Questions · Data sources · Queries · Analyses · Charts · Dashboards · Reports · Insights · Published | Register a file; Profile; New query; Render; Export |
| Data Scientist | Problems · Datasets · Notebooks · Features · Statistics · Experiments · Models · Evaluations · Reports | Run notebook; Pre-register experiment; Train baseline; Evaluate |
| ML Engineer | Problems · Datasets · Expectations · Features · Experiments · Runs · Models · Evaluations · Packages · Services · Monitoring | Validate data; Train; Evaluate; Package; Serve; Send samples; Compute monitoring |
| DL Engineer | Problems · Datasets · Pipelines · Architectures · Training runs · Checkpoints · Comparison · Models · Exports · Benchmarks · Services | Preprocess; Check architecture; Train; Compare; Select checkpoint; Export; Quantize; Serve |

### 11.4 The project page

- **Spine:** each active participation is a group in its hue; nodes are artifacts in lifecycle order showing kind (in the domain's words), name, `v<n>`, status in words, and validation state ("Checks passed", "Checks failed", "Checking…", "Checks could not run"). Handoff connectors between groups are drawn only for real handoffs, labelled with the action and status. Planned positions do not appear as nodes; the lifecycle rail shows them.
- **Focus area (Folio):** the selected version's viewer, evidence pages and allowed actions. Review actions appear only in the workspace of the artifact's owner participation.
- **Tools:** `bench`, `changes`, `runs` (now backed by `jobs`, persisted, survive reload), `completion` (B2c: rule checklist with witnesses; "Mark complete" only when the rules hold).
- **Intent line:** in B2b its "Run" starts an agent turn (`nexus:agent:start`) in the selected workspace with the focused versions as context, and lists the capabilities the turn will get.

### 11.5 Global pages

| Page | Change |
|---|---|
| Launcher, Workspaces | six first-class domains with honest workflow status ("SDE: executable end to end", "ML: available from B5 · steps listed"), registry-only entries labelled "Not yet a supported workflow"; DS appears in B4 with hue slot 8 |
| Runs (new global) | jobs across projects with filters; replaces nothing (B1 runs were session-only) |
| Deployments | B2a: local dev deployments and (B5) local inference services, with status, URL on 127.0.0.1, Stop; no remote targets, no "Production" tab |
| Settings → Platform | the health view: database features, runner, Docker, images (with sizes and a prepare action behind approval), disk at the data home, runtimes, GPU detected/not supported |

### 11.6 Honest states (A–Z S.6, kept)

| Reason | Copy pattern |
|---|---|
| future | "Not in this release. Needs <GPU support / connectors / hosted service>." |
| setup | "<Dependency> is not available: <detected state>." + "How to set up" |
| permission | "Your role cannot <action>." |
| migration | "This needs a database upgrade that is held: <reason>." |
| blocked | "Needs an active <kind> first." + link to that step |
| validation error | "Checks could not run: <reason>." + Retry |
| reported value | "Reported by the training run" next to every number Nexus did not compute |

---

## 12. Execution architecture

### 12.1 Scheduler, leases and heartbeats (main)

- **Loop:** event-driven plus a 1 s tick in main (`ExecutionService`). It reads `queued` jobs through `ix_jobs_sched` (priority, then creation time) and leases one when every cap and guard allows. Leasing is one IMMEDIATE transaction: `queued → leased`, insert the attempt (`starting`, `lease_owner = bootId`, `lease_expires_at = now + 60 s`), `attempts + 1`, activity row.
- **Priorities:** 0 = validate, ingest, queries, renders, discovery; 1 = agent turns, tests, builds; 2 = training and long jobs. No pre-emption.
- **Caps for this host** (computed at runner start from `docker info` and refreshed every 60 s): total reserved container memory ≤ 60 % of the Docker VM memory (7.6 GiB → about 4.5 GiB); at most 3 job containers at once; at most 2 service containers; at most 1 training job; 1 agent turn per session; 2 agent turns per project. A job that does not fit stays `queued` with a visible reason ("Waiting: Docker memory in use").
- **Disk guard:** no lease when free space at the data home is below max(5 GiB, 2 × the recipe's `outputMaxBytes`); the reason is shown. With 19 GB free today the guard will bite early (decision D11).
- **Heartbeats:** the runner reports every 15 s per attempt (container state from `docker inspect`, log bytes, `/out` bytes); main extends the lease and records `heartbeat_at`. A missing heartbeat for 45 s is shown in the run strip; recovery acts only at runner or app start (sleep never triggers false recovery; a live runner renews its own leases after wake).
- **Output cap:** the runner kills a container whose `/out` exceeds `outputMaxBytes` (Docker Desktop has no per-container disk quota); outcome `failed: invalid_output` with reason `output_too_large`.

### 12.2 Sandbox contract

```ts
// src/shared/nexus/execution.ts (types only)
export type SandboxProfileId = 'sde-node' | 'sde-python' | 'qa-web' | 'data-python' | 'ml-python' | 'dl-cpu' | 'nexus-fwd';
export interface SandboxProfile {
  id: SandboxProfileId;
  image: { repository: string; digest: `sha256:${string}` };   // pinned; recorded per attempt
  user: { uid: 10001; gid: 10001 };                              // non-root
  defaults: ResourceLimits;
}
export interface ResourceLimits { cpus: number; memoryMb: number; pids: number; wallClockMs: number; outputMaxBytes: number; tmpfsMb: number }
export type NetworkMode =
  | { mode: 'none' }
  | { mode: 'egress-approved'; approvalId: string; purpose: 'deps' | 'weights' }   // bridge, labelled, per job
  | { mode: 'service-internal'; network: string }    // internal network nexus-svc-<jobId>; reachable only via the forwarder
  | { mode: 'test-internal'; network: string };      // QA test container joins the preview's internal network
export interface MountSpec { kind: 'input' | 'workspace' | 'out' | 'deps' | 'log'; hostPath: string; containerPath: string;
  readOnly: boolean; versionId?: string; contentHash?: string }
export interface ContainerSpec {
  name: `nexus-${string}`;
  labels: { 'nexus.job': string; 'nexus.attempt': string; 'nexus.boot': string; 'nexus.project': string };
  profile: SandboxProfileId; argv: string[];            // filled from the recipe template; never a shell string
  env: Record<string, string>;                          // non-secret, recipe-declared, validated
  mounts: MountSpec[]; network: NetworkMode; limits: ResourceLimits;
  readOnlyRootfs: true; capDrop: ['ALL']; noNewPrivileges: true;
  service?: { containerPort: number; healthPath: string };   // published only through the forwarder on 127.0.0.1
}
export interface PreflightReport {
  ok: boolean;
  observed: { nanoCpus: number; memory: number; pidsLimit: number; networkMode: string; readonlyRootfs: boolean;
              capDrop: string[]; user: string; securityOpt: string[]; mounts: { dst: string; rw: boolean }[]; portBindings: string[] };
  problems: string[];                                   // any problem → remove the container, fail limits_not_applied
}
export interface ExitInfo { code: number | null; signal?: string; oomKilled: boolean; finishedAt: number }
export interface SandboxProbe { docker: 'missing' | 'stopped' | 'running'; version?: string; os?: string; wsl2?: boolean;
  cpus?: number; memoryBytes?: number; gpu: { detected: boolean; model?: string; usableInContainers: false } }
export interface SandboxDriver {
  probe(): Promise<SandboxProbe>;
  imageStatus(profile: SandboxProfileId): Promise<{ present: boolean; digestMatches: boolean; sizeBytes?: number }>;
  prepareImage(profile: SandboxProfileId, approvalId: string, signal: AbortSignal): AsyncIterable<{ phase: string; bytes?: number }>;
  create(spec: ContainerSpec): Promise<{ containerId: string }>;
  preflight(containerId: string, spec: ContainerSpec): Promise<PreflightReport>;
  start(containerId: string): Promise<void>;
  exec(containerId: string, argv: string[], o: { timeoutMs: number; signal: AbortSignal; maxOutputBytes: number }):
    Promise<{ exit: ExitInfo; stdout: string; stderr: string; truncated: boolean }>;
  wait(containerId: string, signal: AbortSignal): Promise<ExitInfo>;
  inspect(containerId: string): Promise<{ state: 'created' | 'running' | 'exited' | 'missing'; exit?: ExitInfo; restartCount: number }>;
  stop(containerId: string, graceMs: number): Promise<void>;
  remove(containerId: string): Promise<void>;
  listByLabels(labels: Partial<ContainerSpec['labels']>): Promise<{ containerId: string; labels: Record<string, string>; state: string }[]>;
}
```

`DockerSandboxDriver` implements it with the `docker` CLI through async `spawn` (argv arrays; the binary resolved once by the runner; no shell), in the order **create → inspect (preflight) → start**. Mounts use `C:/…` paths; worktrees live under a short root with `core.longpaths=true`; renames and worktree removal retry on `EPERM`/`EBUSY` (antivirus, indexer) and then fail `file_locked`. Process trees started by the runner (the Claude CLI and its children) are ended with the existing `procKill.ts` helpers (`taskkill /T /F`, asynchronous) on Windows; container work is ended with `docker stop -t 10` then `docker kill`.

### 12.3 Runner protocol (main ↔ runner over a MessagePort)

```ts
// src/shared/nexus/runnerProtocol.ts (types only)
export type MainToRunner =
  | { op: 'hello'; bootId: string; dataHome: string; worktreeRoot: string; profiles: SandboxProfile[]; mcpPort: 0 }
  | { op: 'probe' }
  | { op: 'attempt.start'; attemptId: string; plan: ToolPlan | AgentPlan | EnginePlan }
  | { op: 'attempt.cancel'; attemptId: string; graceMs: number; reason: 'user' | 'timeout' | 'parent' | 'shutdown' }
  | { op: 'attempt.adopt'; attemptId: string; containerId: string; logPath: string }      // recovery
  | { op: 'mcp.reply'; callId: string; result: { ok: true; value: unknown } | { ok: false; code: string; message: string } }
  | { op: 'blob.verify'; sha256: string };
export type RunnerToMain =
  | { op: 'ready'; mcpUrl: string /* http://127.0.0.1:<port>/mcp */ }
  | { op: 'probe.result'; probe: SandboxProbe; runtimes: { kind: RuntimeKind; health: RuntimeHealth }[] }
  | { op: 'attempt.provisioned'; attemptId: string; containerId?: string; imageDigest?: string; preflight?: PreflightReport }
  | { op: 'attempt.event'; attemptId: string; seq: number; event: RuntimeEvent | ProgressEvent }
  | { op: 'attempt.heartbeat'; attemptId: string; at: number; logBytes: number; outBytes: number; container?: 'running' | 'exited' | 'missing' }
  | { op: 'attempt.exited'; attemptId: string; exit: ExitInfo; outputs: StagedOutput[]; parsed: ParsedOutput[]; logBytes: number }
  | { op: 'mcp.call'; callId: string; bearer: string; tool: string; args: unknown }
  | { op: 'blob.verified'; sha256: string; ok: boolean }
  | { op: 'fault'; message: string };
export interface StagedOutput { relPath: string; sha256: string; bytes: number; mediaType: string }   // already in objects/
export interface ParsedOutput { parser: 'junit' | 'cobertura' | 'metrics-json' | 'metrics-jsonl' | 'stats-json' | 'duckdb-summary' | 'papermill';
  sourceSha256: string; normalized: unknown /* schema-checked again by main */ }
```

Main validates every runner message (shape, attempt known, lease owner = current boot, monotonic `seq`) and drops anything else with a log line. Parsed output is re-validated against its schema in main before it becomes evidence.

### 12.4 Agent runtime contract

```ts
// src/shared/nexus/runtime.ts (types only)
export type RuntimeKind = 'claude-cli' | 'scripted' | 'hermes';
export type RuntimeHealth =
  | { ok: true; version: string }
  | { ok: false; reason: 'not_installed' | 'not_authenticated' | 'version_unsupported' | 'error'; detail: string };
export interface AgentRuntime {
  readonly kind: RuntimeKind;
  describe(): Promise<{ version: string; supportsHttpMcp: boolean; supportsResume: boolean; models: string[] }>;
  health(): Promise<RuntimeHealth>;
  /** Starts one turn. The iterable ends after exactly one of run.completed, run.failed or run.cancelled. */
  start(req: RunRequest, signal: AbortSignal): AsyncIterable<RuntimeEvent>;
  cancel(runRef: string, graceMs: number): Promise<void>;
  respondApproval?(runRef: string, approvalRef: string, decision: 'once' | 'deny'): Promise<void>;
}
export interface RunRequest {
  jobId: string; attempt: number; sessionId: string; idempotencyKey: string;
  resumeRef?: string;                                   // the runtime's own conversation id, when it supports resume
  domainId: string; skills: { id: string; version: string; dir: string; sha256: string }[];
  context: { hash: string; file: string };              // ResolvedContext written by main into the job config dir
  message: string;
  worktree: { hostPath: string; editable: string[] };   // file tools confined here (policy; see §13.4)
  container: { id: string };                            // the turn's sandbox; commands go there through sandbox.exec
  mcp: { url: string; tokenFile: string };              // the token is never in argv, the model context or a log
  model: { provider: 'anthropic'; model: string };
  limits: { wallClockMs: number; maxTurns: number; maxCostUsd?: number };
  credential: { ref: 'safeStorage:anthropic-api-key' | 'cli-login' };
  configDir: string;                                    // per-job, generated by main, deleted with the job's work dir
}
export type RuntimeEvent =
  | { t: 'run.started'; runRef: string; at: number }
  | { t: 'message.delta'; text: string }               // display only; never evidence
  | { t: 'tool.started'; callId: string; tool: string; argsSummary: string }
  | { t: 'tool.completed'; callId: string; ok: boolean; resultBytes: number }
  | { t: 'approval.requested'; approvalRef: string; summary: string }
  | { t: 'usage'; inputTokens: number; outputTokens: number; costUsd?: number }
  | { t: 'run.completed'; at: number; stopReason: string }
  | { t: 'run.failed'; at: number; code: 'runtime_error' | 'auth' | 'limit' | 'protocol'; message: string }
  | { t: 'run.cancelled'; at: number };
```

**`ClaudeCliRuntime` (default, B2b).** The runner spawns the installed `claude` binary headless (`-p` with stream-JSON output; the exact flag set is pinned to a tested CLI version by `test/runtime/claude-cli.contract.test.cjs` against the scripted LLM, and a CLI upgrade that fails the contract makes the runtime `version_unsupported`, not silently different). Per job:

- `CLAUDE_CONFIG_DIR` = `jobs/<jobId>/claude/` with a generated settings file whose permissions are an **allow-list**: `Read`, `Edit`, `Write`, `Glob`, `Grep` restricted to the worktree's editable paths, plus the Nexus MCP tools in the token; everything else denied, explicitly `Bash`, `WebFetch`, `WebSearch`, `NotebookEdit` outside scope, and any other MCP server (strict MCP configuration listing only Nexus's HTTP endpoint with the bearer token read from the token file).
- Environment allow-list: minimal `PATH`, `SystemRoot`, `TEMP`/`TMP`, `HOME`/`USERPROFILE` pointed at the job dir, `CLAUDE_CONFIG_DIR`, locale, and the credential per D9. Nothing is inherited from main's environment.
- The user's `~/.claude*` files are never read for writing; the B0a `configPolicy` and `spawnPolicy` are untouched (this path never takes a binary or argument from the renderer).
- Cancel: abort the stream, then `procKill` the process tree after 10 s.

**`ScriptedRuntime` (tests only).** Replays a fixture of tool calls against the real MCP gateway and emits the same events. It proves the interface is replaceable and makes every agent flow testable without a model. It is never offered in the UI.

**`HermesRuntime` (candidate, not scheduled).** If approved (D6), it implements the same interface with the spike's conditions: one gateway and profile per session, pinned release launched through its Python entry point (never the PATH-rewriting launcher), `docker_network: false`, Nexus preflight on its sandbox, Nexus-owned wall clock through `/stop`, approval choices restricted to `once`/`deny`, and Nexus-owned skill discovery. It is never authoritative: like every runtime, it reaches Nexus state only through the MCP gateway with a token.

### 12.5 The MCP gateway and tokens

- The runner hosts the MCP endpoint (Streamable HTTP, JSON responses, `POST /mcp`, bound to 127.0.0.1 on an ephemeral port). It parses JSON-RPC (`initialize`, `tools/list`, `tools/call`), forwards each call to main as `mcp.call` with the bearer, and returns main's reply. It decides nothing.
- Main's `McpGateway` verifies the token ([section 13.3](#133-capability-tokens)), checks the tool against the token's tool list and capability, runs the B0b/B1 authorization for the agent principal acting on behalf of the user, executes one service call, writes an `mcp.call` activity row (allowed or denied, tool, argument summary, result size), and returns a result that the runtime wraps as untrusted data.
- Implementation choice: a hand-rolled minimal server (about 300 lines, contract-tested against the pinned CLI) or the MCP SDK (decision D7).

### 12.6 Job kinds and their execution paths

| Kind | Path | Output handling |
|---|---|---|
| `tool.run` (recipe) | runner creates the container from the recipe template, stages inputs read-only (copied from blobs with a hash check, or bind-mounted for `external` data after a size/mtime check), runs, waits | runner hashes `/out` into `objects/`, runs the recipe's parsers; main ingests |
| `tool.run` (service) | as above with `service`; the forwarder container (`nexus-fwd`, socat in Alpine, pinned) joins the internal network and publishes 127.0.0.1:<port> | a `deployments` row; health probes from the runner; stop on user action, cancel, idle TTL |
| `agent.run` | runner creates the turn's container (`sleep infinity` as PID 1, worktree bind-mounted read-write at `/workspace`, network none), then starts the runtime | registered versions arrive through MCP during the turn; ingest only checks contracts the skill declared |
| `validate` | in main (pure validators) or as a recipe job | `validations` rows |
| `ingest` | in main, one IMMEDIATE transaction | see 12.7 |

### 12.7 Ingest (main, one transaction)

1. Check the recipe's required output contracts in the attempt's `StagedOutput` list; a missing one → `failed: invalid_output`.
2. In one IMMEDIATE transaction: resolve each output target (`new` → create an artifact owned by the job's participation; `revise` → must be owned by it); allocate `version_no`; insert `draft` versions with `output_path`; upsert `blobs` (touch `last_referenced_at`) and insert `version_blobs`; write lineage edges for the recipe's declared input → output pairs (source `job_input`); write typed rows (`test_results`, `metrics`); enqueue `validate` jobs; job → `completed`; activity rows.
3. Ingest is idempotent by `(produced_by_job_id, output_path)`; a crash before commit rolls back and recovery reruns it.

### 12.8 Recovery after a restart

At every runner start (app start or runner restart), main runs, as the system principal:

```
1. bootId := new ULID; token key := 32 random bytes (all old tokens die)
2. for each attempt in ('starting','running'):
     tool.run:  listByLabels(nexus.job, nexus.attempt)
                running → attempt.adopt (lease_owner := bootId; resume heartbeats; reattach the log)
                exited  → finalize from inspect; ingest if contract outputs exist
                missing → attempt abandoned; job retry_scheduled if canRetry, else interrupted
     agent.run: attempt abandoned; job interrupted; session interrupted; container stopped; worktree kept
     service:   adopt if running (deployment keeps its status), else deployment stopped
     validate, ingest: attempt abandoned; job back to queued (idempotent)
3. jobs 'leased' with no live attempt → queued (or interrupted if the participation or session ended)
4. containers labelled nexus.boot ≠ bootId that were not adopted → stop, remove, activity row
5. approvals pending past expiry → expired; their jobs → failed: denied
6. GC stale work dirs; start the scheduler
```

This replaces B0b's `recoverAfterRestart` for jobs (whose rule "running → interrupted" was correct only while nothing executed). Every decision writes an activity row with actor `system`.

### 12.9 The domain registry contract

```ts
// src/shared/nexus/domainSpec.ts (types only)
export type StepStatus = 'REAL' | 'PARTIAL' | 'FUTURE';
export type SubPhase = 'B1' | 'B2a' | 'B2b' | 'B2c' | 'B3' | 'B4' | 'B5' | 'B6';
export type PrerequisiteId = 'git' | 'docker' | `image:${SandboxProfileId}` | 'runtime:claude-cli' | 'credential:anthropic' | 'gpu' | 'disk:5GiB';
export interface DomainSpec {
  specVersion: 3;
  id: string; label: string; shortLabel: string; description: string;
  tier: 'first-class' | 'registry-only'; hueSlot: number; icon: string; order: number;
  legacyDomainIds: string[];                            // live map used by the primary projection (D4 of B0b)
  vocabulary: Partial<Record<KindId, { singular: string; plural: string }>>;
  kindsProduced: KindId[]; kindsAccepted: KindId[];
  capabilities: { id: CapabilityId; scope?: { paths?: string[]; recipes?: RecipeId[]; kinds?: KindId[] } }[];
  recipes: RecipeId[]; skills: SkillId[]; actions: UserActionId[];
  lifecycle: LifecycleStep[];
  handoffRoutes: { to: string; kinds: KindId[]; action: HandoffAction; acceptance?: CompletionRule[]; subPhase: SubPhase }[];
  completionRules: CompletionRule[];
  modules: { id: string; label: string; kinds: KindId[]; subPhase: SubPhase }[];
}
export interface LifecycleStep {
  id: string; label: string;
  consumes: KindId[]; produces: KindId[];
  via: ({ userAction: UserActionId } | { recipe: RecipeId } | { skill: SkillId })[];
  doneWhen: { kind: KindId; statuses: ('candidate' | 'active')[]; validators: ValidatorId[] }
          | { record: 'review' | 'signature' | 'selection' | 'conclusion' | 'deployment_healthy' };
  status: StepStatus; scopeNote?: string; subPhase: SubPhase; prerequisites: PrerequisiteId[];
  e2eTestId?: string;                                   // required when status ≠ FUTURE (boot check)
}
```

Boot checks (and a unit test): ids unique; hue slots unique and stable; every referenced kind, recipe, validator, skill, capability and action id resolves; every step with status REAL or PARTIAL at the current sub-phase has a registered implementation and an `e2eTestId`; `kindsProduced ⊇` every step's produced kinds; handoff route kinds ⊆ the sender's produced kinds ∩ the receiver's accepted kinds; a step's status may be REAL only if the build's sub-phase ≥ its `subPhase` (so a build cannot show a later phase's step as available).

### 12.10 Prerequisites and what happens when one is missing

| Prerequisite | Check | Missing or failing → |
|---|---|---|
| Docker Desktop running (WSL2) | `docker version`, `docker info` every 60 s while degraded | every container step `unavailable: setup:docker_*`; nothing falls back to the host |
| Image for a profile | `docker image inspect` by digest | `unavailable: setup:image_missing` + "Prepare image (<size>)" behind approval A2 |
| Disk | free bytes at the data home and the worktree root | no new leases; banner with the numbers |
| git | `git --version` ≥ 2.40 | repository and code steps unavailable |
| Claude CLI | `claude --version` within the supported range | agent steps `unavailable: setup:runtime_missing` |
| Credential (D9) | safeStorage presence, or a CLI login check | agent steps `unavailable: setup:credential_missing` |
| GPU | `nvidia-smi` on the host; container passthrough not attempted | always "GPU detected, not supported in this release" or "No GPU" |
| Python, DuckDB, torch | inside the images only | never probed on the host; the host Python 3.11.6 is not used |

---

## 13. Security model

### 13.1 Threat model (local, single user)

| Actor or vector | Example | Primary controls |
|---|---|---|
| Untrusted repository or data | `package.json` scripts, a training script, a notebook, a CSV crafted to inject prompts | runs only in a container: network none, non-root, read-only root, limits, read-only inputs, no secrets |
| Prompt-injected agent | data tells the agent to exfiltrate or to register fake metrics | no network; token scopes; evidence only from parsed outputs and Nexus's own evaluators; inputs ⊆ job inputs |
| Compromised renderer | XSS through rendered report or notebook HTML | `sandbox: true` (B0a); HTML sanitized in the image and shown in a sandboxed iframe without scripts and with a strict CSP; IPC accepts ids only |
| Other local processes | calling the MCP endpoint, impersonating the runner | MCP bound to 127.0.0.1 with per-job HMAC tokens; the runner channel is a MessagePort only main holds |
| Supply chain | images, Python wheels, npm packages, skills, weights | images built from hash-pinned lockfiles and referenced by digest; installs with scripts disabled; Nexus-owned skills only; pinned weights with sha256 and license |
| Destructive actions | force push, deleting branches, moving the user's branch, deleting data | no tool exists for them; the few user actions that write the user's repository need an approval |

### 13.2 The renderer stays untrusted

The B0a and B1 rules hold: the renderer sends ids and validated values; main resolves the principal, the project folder (from the `projects` row through `acceptFsRoot`), every file path (through dialogs) and every workspace authority (from stored rows). New channels add no path, command or identity field; `test/nexus-caller-paths.test.cjs` and the composition pins are extended to the new channels.

### 13.3 Capability tokens

```ts
// src/shared/nexus/tokens.ts — base64url(payload) + '.' + base64url(HMAC-SHA256(key, payload))
export interface CapabilityToken {
  v: 1; jti: string; iss: 'nexus';
  sub: `agent:${string}`;                 // agent:<sessionId> (ruling R5)
  onBehalfOf: 'user:local';
  projectId: string; workspaceId: string; participationId: string; jobId: string; sessionId: string;
  caps: { id: CapabilityId; scope?: { paths?: string[]; recipes?: string[]; kinds?: string[]; versionIds?: string[] } }[];
  inputs: string[];                       // versions the agent may read or declare as inputs
  mcpTools: string[];                     // allow-list for this job
  maxChildJobs: number;                   // default 20
  iat: number; exp: number;               // exp = job wall clock + 5 min
}
```

- **Effective permission** = the user's role (B0b `decide()`) ∩ the domain's ceiling ∩ the job's requested grants ∩ availability, narrowed by scopes. Computed once at turn start, minted, recorded in `capability_tokens`, and re-checked on every MCP call.
- **Key:** 32 random bytes per runner boot, held in main's memory only; never written, never sent to the runner. A restart invalidates every token.
- **Verification on every call:** constant-time HMAC compare; not expired; not revoked; job still `running` or `awaiting_approval`; tool in `mcpTools`; capability present; scope satisfied. Every denial is a `denied` activity row.
- **Revocation:** when the job reaches a terminal state, or on session cancel.
- **Policy change:** `decide()` keeps refusing agent principals (`agent_requires_token`); a new `AuthService.authorizeWithToken(token, action, scope)` is the only path for agents, and it calls `decide()` for the on-behalf-of user as part of the intersection. `version.finalize` and other system-only actions stay system-only.

### 13.4 Sandbox limits

Every container: non-root uid 10001; `--read-only` root with tmpfs `/tmp` and `/home/nexus` (caps 512 MiB / 256 MiB) for tool caches; `--cap-drop ALL`; `--security-opt no-new-privileges`; `--cpus`, `--memory` = `--memory-swap`, `--pids-limit 512`; inputs read-only; one writable `/out`; worktree read-write only for agent turns; the preflight inspect refuses anything else. The Claude CLI's own file tools act on the host worktree and are confined by the per-job allow-list: **this is a policy boundary, not OS isolation**, and it is stated as such (risk K3). Execution never happens on the host.

### 13.5 Secrets by reference

- Secrets live in Electron `safeStorage` (B0a). No channel returns one; activity, logs, job params, artifact metadata, validations and evidence refuse or redact secret-shaped values (the B0b/B1 `containsSecret` and `redactSecretText` rules, including the long-token rule).
- Containers never receive secrets: no secret is in a container environment, mount or image.
- The agent credential (D9) reaches only the CLI child process environment (or stays in the CLI's own login store); never the model's context, never a container, never a log.
- Application manifests declare env **names** only; a dev deployment that needs a secret value is FUTURE (it shows "This app needs <NAME>; secrets for dev deployments are not supported yet").

### 13.6 Network default-deny

| Mode | Who | Egress | Approval |
|---|---|---|---|
| `none` | every recipe and every agent container by default | none | — |
| `egress-approved` (registries) | `sde.deps.node`, `sde.deps.python`, `ml.deps.python` | full outbound for that job, with install scripts disabled (`--ignore-scripts`, binary-only wheels) | per job, `once`, A1 |
| `egress-approved` (pinned weights) | `dl.weights.fetch` | full outbound for that job; the file must match the pinned sha256 | per job, `once`, A1 |
| `service-internal` | dev deployments and inference services | none (internal network); reachable from the host only through the forwarder on 127.0.0.1 | — |
| `test-internal` | QA test and contract jobs | the service on its internal network only | — |
| agent runtime process (host) | the Claude CLI | the model API only (the CLI's own client); `WebFetch`/`WebSearch` denied | D9 |

Dependency caches are per profile, keyed by the lockfile hash, written only by approved install jobs, verified against the lockfile on every mount, and mounted read-only.

### 13.7 Approval gates

| Id | Action | Who requests | Why it is gated |
|---|---|---|---|
| A1 | network egress for one job | a recipe or an agent (`approval.request`) | default-deny networking |
| A2 | prepare (build or pull) an image | user, from setup | downloads and disk (sizes shown) |
| A3 | first repository write per project: create `nexus/*` refs and worktrees in the user's repository | system, on the first change-set job or accept | Nexus writes into the user's `.git` |
| A4 | merge accepted work into the user's branch | user (`nexus:repo:mergeAccepted`) | moves the user's branch; main shows the commits; fast-forward only, clean tree only |
| A5 | a training job longer than the default wall clock | user | resources |
| A6 | blob GC apply, worktree cleanup | user | deletes files (never referenced data) |

Not offered at all: force push, deleting the user's branches, rewriting history, deploying outside the local machine, deleting versions or projects with platform records.

### 13.8 Audit

Every mutating action, MCP call (allowed and denied), job and attempt transition, approval, preflight refusal, recovery decision, export and merge writes an activity row through the single B0b writer (redacted, hash-chained). High-volume runtime events go to `job_events` (redacted, append-only), not the activity chain.

---

## 14. Test strategy

### 14.1 Runners

| Runner | Runs | Needs | Rule |
|---|---|---|---|
| `npm run test:focused` | pure tests under plain node: registry boot checks, state-table mirrors, completion evaluator, token mint/verify, SQL guard tokenizer, JUnit/Cobertura/metrics parsers on fixtures, view models, source pins | nothing | the 11 baseline failures stay the only failures |
| `npm run test:db` | real SQLite under Electron-as-node: migrations v9–v14, services, ingest, recovery with a **fake runner**, MCP gateway with a fake token stream, orphan queries, chain verification | nothing | a file fails on any skip, todo or 0 tests (B0b rule) |
| `npm run test:exec` (new) | the runner against real Docker: preflight, limits, network modes, cancel, timeout, adopt after restart, output cap, every recipe on fixtures | Docker running and the images prepared | fails (never skips) when Docker is missing; run explicitly and in verification |
| `npm run test:runtime` (new) | the `AgentRuntime` contract: `ScriptedRuntime` always; `ClaudeCliRuntime` against a scripted OpenAI/Anthropic-compatible mock (tool calls, denial of `Bash`/`WebFetch`/`WebSearch`, env allow-list, token never in argv or logs, cancel, no orphan processes on Windows) | the CLI installed | the real-model smoke (`NEXUS_REAL_MODEL=1`) is opt-in, needs the credential, and runs only in verification |
| e2e flows | the domain flows through IPC handlers with the real runner, Docker and images, on a scratch `--user-data-dir` and fixture repositories and datasets | everything | run by the controller in verification only, after an explicit go-ahead; never against the real userData |

### 14.2 What every sub-phase must prove

| Area | Tests |
|---|---|
| Migrations | the v8 pattern (M1–M16) for each new version: log lines, backup verified and hashed, hold switch, failure marker and auto-hold, post-check, a kill mid-transaction, backup failure, multi-step launches (v8 → v9 → v10 in one launch with a later failure), downgrade (the B1 build `d7abc87b` opens a v9+ database for legacy use with its delete guard active), restore-tool hints |
| State machines | every table's TypeScript mirror equals its seeded rows; every illegal transition is refused by the trigger and by the service |
| Execution | cancel in every job state (queued, leased, running, awaiting approval, retry scheduled, service), including children and `cancelled_partial` drafts; timeout; retry only for idempotent recipes; restart recovery: adopt a running container, finalize an exited one, interrupt an agent turn, requeue validation; no orphan containers; no orphan processes on Windows |
| Sandbox | a container without limits, with a network, writable root or extra mount is refused by preflight (fault injection); network probes inside containers fail (`none`); a test container reaches only its preview; the preview is reachable only on 127.0.0.1 through the forwarder; output cap kills |
| Evidence | each validator on passing and failing fixtures; exit 0 with zero tests fails; a forged JUnit naming undiscovered tests fails; training-reported metrics never satisfy a promote gate; a changed external file fails the job `input_changed`; an evaluation on an overlapping split fails |
| Tokens and MCP | forged, expired, revoked, wrong-job, out-of-scope, wrong-tool calls are denied with one audit row each; an agent cannot register an input it was not given; cannot promote, accept, sign or answer approvals (no tool) |
| Lineage | every flow's expected edges exist with the right sources; nothing from prose; cycles refused |
| Honesty (UI) | an audit test renders every workspace and project screen from fixtures in each availability state and fails if any enabled action maps to a FUTURE step, an unavailable prerequisite or a missing record; no percentage without a parser; "reported" labels on reported numbers |
| Completion | each domain's rule set holds over its recorded e2e fixture and fails when any single step's record is removed |
| Orphans and integrity | after every flow: the B1 orphan queries O1–O9 plus new ones (attempts without jobs, versions without blobs, deployments without jobs, accepted change sets without accept rows) = 0; `foreign_key_check` empty; `integrity_check` ok; the activity chain verifies |
| Posture | no `execSync`/`spawnSync`/`execFileSync` under `src/main` or `src/runner`; no shell strings; the identity guard's known-leaks list does not grow; `src/shared` imports nothing from `src/renderer` |

### 14.3 End-to-end acceptance per domain

| Domain | Fixture | Passes when |
|---|---|---|
| SDE | a small Node service with Jest tests and `nexus.app.json`, and a Python FastAPI service with pytest; plus one real user repository | requirement → agent change set → tests pass → review → accept → snapshot → build → application → dev deployment healthy → diagnostic report → iteration from a review comment; completion rules hold |
| QA | the SDE fixture's application with seeded bugs | the full SDE ↔ QA loop of [section 8.3](#83-the-required-flows-record-by-record), including a defect that cannot be closed before a passing retest on a newer build, and a signed recommendation |
| DA | public-domain CSVs (sales, invoices) | question → register → profile → clean → query → analysis → chart → dashboard and report → insight → export bundle; a non-read-only SQL statement is refused; a report number typed outside tokens is flagged |
| DS | the DA dataset through a handoff | exploration notebook → features → statistics → pre-registered experiment → baseline → Nexus evaluation → report → handoff; a post-hoc hypothesis is labelled exploratory; a split with overlap fails |
| ML | the DS handoff | expectations → validation → features → experiment → training → Nexus evaluation → model version → gates (regression against the DS baseline) → package → service → monitoring report → iteration; then ML → SDE → QA → release |
| DL | a small labelled image folder (a few hundred images) | dataset → splits → preprocessing → architecture check → CPU training with checkpoints → evaluation → comparison and selection → export with parity → benchmark → int8 with delta → service; then DL → ML → SDE → QA. A NaN-loss injection fails a run as `diverged`; a parity failure blocks promotion |

---

## 15. Phased implementation order

Every sub-phase: explicit approval to start; one commit per task on `our-platform`; no squash, amend, rebase or force push; explicit staging; tests and fixtures only on temp folders and scratch userData; no app launch and no real-database write except the approved migration, run by the controller after a verified backup; a written verification report; then STOP for approval.

### 15.1 B2a — Execution core, registry and the SDE tool path

- **Goal:** one honest execution path that runs sandboxed jobs on the user's repositories and records evidence, with no agent and no model credential.
- **Scope:** runner `utilityProcess` and protocol; `DockerSandboxDriver` with preflight; images `sde-node`, `sde-python`, `nexus-fwd`; scheduler, leases, heartbeats, cancel, timeout, retry, recovery; blob store and GC; job logs and events; validation framework and the SDE validators; approvals (A2, A3); domain registry (`DomainSpec` v3 for six domains plus registry-only), registry projections, lifecycle rail; persona cleanup; `repository` artifacts and `repo.snapshot`; clean worktrees at a commit; `requirement` and `problem_statement` user-authored kinds; SDE recipes (deps with approved egress, discovery, tests, typecheck, build, application, dev deployment, diagnose); Runs, Deployments and Folio evidence pages; channels #22–#41.
- **Tasks (indicative):** T1 shared types (`execution`, `runtime`, `runnerProtocol`, `evidence`, `domainSpec`); T2 persona cleanup and the registry-clean test; T3 registry and boot checks; T4 schema v9 module (DDL, seeds, verify, shape) not wired; T5 v9 migration step, hold switch, marker, restore-tool hint, downgrade test; T6 runner entry, supervision, MessagePort protocol with a fake for tests; T7 sandbox driver and preflight; T8 images and `nexus_tools` skeleton, digest lock file, build script; T9 blob store, staging with hash check, GC; T10 scheduler, leases, heartbeats, cancel, timeout, retry; T11 ingest and validation framework; T12 recovery; T13 repository snapshots and worktrees (A3); T14 SDE recipes and parsers (JUnit, Cobertura); T15 service jobs, forwarder, deployments, diagnose; T16 IPC channels and preload; T17 renderer: lifecycle rail, Runs, Deployments, evidence pages, setup and health; T18 docs (`platform-core.md` Part III); T19 verification report.
- **Exit criteria (demonstrable):**
  1. On the user's machine, `test:exec` passes: a container without limits or with a network is refused; network probes fail inside `none` containers; cancel works in every state with no orphan container or process.
  2. On a fixture repository and on one real repository (scratch userData): run tests on a commit → a `test_suite` version and passing `sde.tests_pass` evidence; build → `build` with a hashed manifest; assemble → `application`; dev deployment healthy on 127.0.0.1 only; diagnose → `diagnostic_report`; every step visible on the Spine, in Runs and in the Folio with evidence.
  3. Killing the runner mid-test and mid-deployment yields the recovery outcomes; restarting the app adopts or finalizes.
  4. Exit 0 with zero tests fails; a JUnit with undiscovered ids fails.
  5. Migration v9 applied on a copy of the real database with a verified backup; then on the real database after go-ahead; legacy row counts unchanged (including the five `project_plans` rows).
  6. The six domains appear with honest step statuses; no FUTURE step has an enabled action (honesty audit test).
  7. `src/shared/domain.ts` has no persona fields; the identity guard's list did not grow.
- **Migration:** v9 (section 9.2), gated and backed up.
- **New dependencies:** none required in the app if the JUnit/Cobertura parsers are hand-written; otherwise `fast-xml-parser` in the runner (D7). Images: `node:20-bookworm-slim` and `python:3.11-slim-bookworm` bases, Alpine for the forwarder (D8).
- **Risks:** disk (19 GB free); Docker Desktop memory shared with the user's running stacks; Windows bind-mount and MAX_PATH behaviour; antivirus file locks; dependency installs needing egress for real repositories; recovery edge cases.
- **What each domain can do at exit:** SDE: Requirement, Project, Repository, Code, Tests, Build, Application, Dev deployment, Logs/diagnostics REAL (user-triggered); AI implementation, Review, Iteration not yet. QA, DA, DS, ML, DL: their workspaces show the lifecycle with honest statuses; nothing executes for them yet (problem statements can be written).

### 15.2 B2b — Agent runtime and AI-assisted SDE

- **Goal:** SDE executable end to end with a real agent.
- **Scope:** `AgentRuntime`, `ClaudeCliRuntime`, `ScriptedRuntime`; context resolver; skills; capability tokens; MCP endpoint and gateway; agent principals; approvals A1 and the egress flow; `change_set` with register validators; review; integration ref, accept, merge accepted (A4); request changes and iteration; intent line and agent panel; channels #42–#50.
- **Exit criteria:**
  1. `test:runtime` passes for both runtimes, including denial of `Bash`, `WebFetch`, `WebSearch`, the environment allow-list, no token in argv, logs or context, and no orphan processes on Windows.
  2. The SDE e2e flow passes with a real model (credential per D9) on the fixtures and one real repository, and its completion rules hold.
  3. Restart mid-turn gives `interrupted` with the worktree kept; a failing test keeps the change set out of `candidate`; accept never changes the user's checked-out branch or files (dirty-tree test); "Merge accepted work" refuses on a dirty tree or a non-fast-forward.
  4. Token matrix: forged, expired, revoked, out-of-scope and wrong-tool calls denied and audited.
- **Migration:** v10 (section 9.3).
- **New dependencies:** none, or the MCP SDK (D7).
- **Risks:** Claude CLI flag drift; the policy-only file boundary (K3); credential decision; model cost; Windows process trees.
- **What each domain can do at exit:** **SDE executable end to end.** Others unchanged.

### 15.3 B2c — QA and the SDE ↔ QA loop

- **Goal:** QA executable end to end and the flow SDE → QA → Defect → SDE → New Build → QA → Release.
- **Scope:** QA kinds; `test_results`, `defects`; `qa-web` image (Playwright with Chromium only); manual runs; automated runs on internal test networks; discovery; defects with the `fixed`/`verified` rules; retest; regression; quality report; signed recommendation; handoff route table, convert, deliver, close, comments, return/supersede links; agent-sent handoffs; completion rules and the Completion tool for SDE and QA; channels #51–#62.
- **Exit criteria:** the QA e2e and the loop of section 8.3 pass and their completion rule tests hold as automated tests over the recorded fixtures; a defect cannot be closed without a passing linked case on a newer build that contains the fix (negative test); an open S1 on an older build blocks `qa.no-blockers` on the new build; quality numbers recomputed by a test match; only a user principal can sign.
- **Migration:** v11 (section 9.4), including the handoff state rows and, with ruling R2, the `covers` relation.
- **New dependencies:** the `qa-web` image (about 1.2 GB compressed).
- **Risks:** flaky browser tests on Windows Docker; preview start times; manual-run UX size.
- **What each domain can do at exit:** **SDE and QA executable end to end; the SDE ↔ QA loop REAL.**

### 15.4 B3 — Data Analyst

- **Goal:** DA executable end to end on local files.
- **Scope:** `data-python` image (DuckDB, pandas, pyarrow, polars, matplotlib, vl-convert, `nexus_tools`); dataset registration through main dialogs (blob or external with size/mtime checks before and after jobs); profiling; cleaning with the token-level read-only SQL guard; queries with snapshots; analysis; charts (server-rendered); dashboards; reports with reference tokens; insights; export bundles; the `data` workspace relabelled "Data Analyst"; channels #63–#64; DA completion rules.
- **Exit criteria:** the DA e2e passes and its completion rules hold; a non-read-only statement is refused before execution; a chart with inline values fails `da.bindings_resolve`; a report number outside tokens is flagged; an external file changed during a job fails it `input_changed`.
- **Migration:** v12.
- **New dependencies:** the `data-python` image (about 1.0–1.3 GB compressed); Python packages listed in its lockfile (approval).
- **Risks:** large files on NTFS bind mounts into WSL2 are slow; disk for blobs; XLSX edge cases.
- **What each domain can do at exit:** DA executable end to end (PARTIAL data source and publish scopes); SDE and QA as before.

### 15.5 B4 — Data Scientist

- **Goal:** DS executable end to end; DA → DS REAL.
- **Scope:** `data-scientist` workspace row and registry entry (hue slot 8); papermill notebooks with sanitized HTML; statistics; pre-registered experiments and conclusions; feature sets with leakage flags; splits; scikit-learn baselines; Nexus evaluation; DS reports; DA → DS and DS → DA routes; channel #65; DS completion rules.
- **Exit criteria:** the DS e2e passes; post-hoc hypotheses are labelled exploratory; overlapping splits fail; a feature set containing the label's source column is flagged; notebooks with error cells fail.
- **Migration:** v13 (with ruling R1 on legacy `data-science` primaries).
- **New dependencies:** papermill, nbconvert, scipy, statsmodels, scikit-learn inside `data-python` (lockfile update, approval).
- **Risks:** notebook HTML sanitization; non-deterministic notebooks.
- **What each domain can do at exit:** DS executable end to end (PARTIAL acquisition).

### 15.6 B5 — ML Engineer

- **Goal:** ML executable end to end; DA → DS → ML → SDE → QA → Release REAL.
- **Scope:** `ml-python` image (FROM `data-python` + onnx, onnxruntime, skl2onnx, FastAPI, uvicorn); expectation suites; experiments; training with reported metrics; the `metrics` table; Nexus evaluation; model versions and load checks; promote gates; packaging templates; inference services and contract tests; monitoring reports from prediction logs; ML → SDE `create-api` with `app.fastapi-predict@1` and the skill `nexus-sde-api-from-model`; channels #66–#67; ML completion rules.
- **Exit criteria:** the ML e2e and the DA → DS → ML → SDE → QA → Release flow pass with their completion rules; `ml.no_regression{baseline}` blocks a worse model; a non-deterministic package fails; the "application serves package" path holds and fails when the API change set is reverted; reported training metrics never pass a gate.
- **Migration:** v14.
- **New dependencies:** the `ml-python` image (about +0.5 GB over `data-python`).
- **Risks:** training memory inside a 7.6 GiB Docker VM shared with other stacks; pickle safety (loaded only in containers); serving template maintenance.
- **What each domain can do at exit:** ML executable end to end (PARTIAL training and monitoring).

### 15.7 B6 — DL Engineer

- **Goal:** DL executable end to end on CPU; DL → ML → SDE → QA REAL.
- **Scope:** `dl-cpu` image (torch CPU wheels, torchvision, onnx, onnxruntime, FastAPI); folder datasets with labels; preprocessing pipelines; architecture checks; CPU training with per-epoch checkpoints and `metrics.jsonl` progress; resume; comparison and selection; Nexus evaluation; ONNX export with parity; benchmarks; dynamic int8 quantization with accuracy delta; inference services; pinned-weights fetch with approval; GPU probe that reports honestly; DL → ML and DL → SDE routes; channel #68; DL completion rules.
- **Exit criteria:** the DL e2e and DL → ML → SDE → QA pass on this laptop within the 8 h wall clock (target: tens of minutes on the fixture); NaN-loss injection fails a run as `diverged`; parity failure blocks promotion; the GPU line says "GPU detected (RTX 3050 Laptop, 4 GB), not supported in this release" and nothing else.
- **Migration:** none expected.
- **New dependencies:** the `dl-cpu` image (about 1.5–2.0 GB compressed); the pinned weights registry (URLs, sha256, licenses; approval).
- **Risks:** CPU training time; memory; disk for checkpoints.
- **What each domain can do at exit:** **all six domains executable end to end** within the stated scopes.

### 15.8 Domain capability by sub-phase

| Domain | after B2a | after B2b | after B2c | after B3 | after B4 | after B5 | after B6 |
|---|---|---|---|---|---|---|---|
| SDE | 9 of 12 steps REAL (user-triggered) | **executable end to end** | + QA loop | same | same | + model-serving apps | + ONNX apps |
| QA | lifecycle shown, nothing runs | same | **executable end to end** | same | same | + API tests of inference services | same |
| DA | problem statements only | same | same | **executable end to end** (PARTIAL scopes) | + DS route | + predictions from ML | same |
| DS | not shown as available (workspace arrives in B4) | same | same | same | **executable end to end** | + ML route | same |
| ML | problem statements only | same | same | same | same | **executable end to end** | + DL exports |
| DL | problem statements only | same | same | same | same | same | **executable end to end** |

### 15.9 Recommended first sub-phase

**Start with B2a.** Every domain's workflow depends on the same five things: a sandbox that provably enforces limits and default-deny networking, durable jobs with recovery, a content-addressed blob store, validators that write evidence, and a registry that tells the UI the truth. B2a builds exactly these and proves them on the SDE tool path, which needs no model credential, no new runtime and no new database kinds beyond `repository`, `requirement`, `problem_statement`, `test_suite`, `build`, `application` and `diagnostic_report`. It exercises the hardest platform risks on this specific machine first: Docker Desktop on WSL2 with only 7.6 GiB for the VM and other stacks running, a C: drive with 19 GB free, Windows paths and file locks, and restart recovery. It also lands the persona cleanup and the registry, so every later screen speaks each domain's language. B2a ends with SDE able to test, build, run and diagnose a real repository with evidence, and it says plainly that AI implementation and review arrive in B2b. Starting with agents first would put an unverified runtime on top of an unverified sandbox; starting with a data domain would add a 1.3 GB image and the blob store at once. B2a is the smallest step that makes everything after it real.

---

## Decisions needed

| Id | Decision | Options | Recommended answer |
|---|---|---|---|
| D1 | **Docker as a requirement** | (a) Docker Desktop (WSL2) required for every execution; (b) host execution with OS restrictions; (c) a host fallback when Docker is absent | **(a).** It is installed and running (29.7.2, WSL2). It is the only boundary the Hermes spike verified (filesystem, env, network, CPU/memory/PIDs). Without Docker, execution steps show "Docker is not available" and nothing falls back to the host. Note Docker Desktop's licence terms for larger companies |
| D2 | **Python environment strategy** | (a) one pinned image per profile, built from hash-pinned lockfiles (`uv pip compile --generate-hashes`, installed with `--require-hashes`); (b) uv-managed virtual environments on the host; (c) the host Python 3.11.6 with its existing packages | **(a).** Reproducible (image digest recorded per run) and isolated. (b) and (c) give no isolation and (c) is unpinned. Project-specific extras install into a per-project layer through an approved, scripts-disabled install job |
| D3 | **DuckDB** | (a) inside the `data-python` image only; (b) the `duckdb` npm package in the app | **(a).** No native module in the app, queries stay inside the sandbox, one engine version recorded per snapshot. Cost: about 1–2 s container start per query |
| D4 | **GPU policy** | (a) CPU only in B2–B6; the probe reports the RTX 3050 (4 GB) as "detected, not supported"; (b) enable `--gpus` for a `dl-gpu` profile in B6 | **(a).** Container GPU passthrough is unverified on this host (`docker info` lists only `runc`), the card has 4 GB, and a CUDA image is 6–9 GB against 19 GB free. A later, separately approved spike can verify `--gpus` on WSL2 and add `dl-gpu` |
| D5 | **Network policy per job** | (a) default `none`; per-job, once-only approved egress for dependency installs (scripts disabled) and pinned weights; services on internal networks; (b) allow egress for agent containers; (c) an allow-list proxy now | **(a).** Agents never get egress. A proxy (c) is useful later and can replace full egress for approved jobs without changing the interface |
| D6 | **Runtime: Claude CLI vs Hermes** | (a) `ClaudeCliRuntime` default, `ScriptedRuntime` for tests, Hermes not built; (b) Hermes default; (c) both now | **(a).** The CLI (2.1.292) is installed; the interface is proven by two implementations. Hermes remains a candidate adapter behind a flag, built only after a separate approval and only if its spike conditions (real-LLM tool calling, per-session gateways, preflight) are met. No runtime is ever authoritative |
| D7 | **New npm dependencies** | candidates: `fast-xml-parser` (JUnit, Cobertura), `@modelcontextprotocol/sdk` (MCP server), `ajv` (schemas), `vega`/`vega-lite`/`vega-interpreter` (interactive charts) | **Approve only `fast-xml-parser`** (B2a, runner only; XML parsing by hand is error-prone and evidence-critical). Hand-roll the minimal MCP server with a contract test (fall back to the SDK only if the contract fails). No Ajv (TypeScript validators). No Vega in the renderer in B3 (server-rendered charts) |
| D8 | **Image distribution** | (a) build locally from Dockerfiles and lockfiles on first use, with consent; (b) publish to a registry and pull | **(a).** No account needed; the digest of the locally built image is recorded per run. First builds take minutes and need network for base images and wheels (an approved image-preparation job, A2) |
| D9 | **Agent credential for headless runs** | (a) an Anthropic API key stored in safeStorage, passed only to the CLI child process; (b) reuse the user's existing CLI login (requires not isolating `CLAUDE_CONFIG_DIR`, so user-level hooks and settings may load); (c) a broker model proxy | **(a)**, with (b) as an explicit opt-in only if a contract test proves the user's global settings, hooks and plugins do not load into Nexus jobs. Also set a per-turn cost cap (default USD 2) and a per-day cap |
| D10 | **Workspace ids for DA and DS** (ruling R1) | (a) keep `data` as Data Analyst, add `data-scientist`; (b) add `data-analyst` and `data-scientist` and move `data` participations (M4) | **(a).** No existing row moves. Legacy `data-science` projects get their primary moved to `data-scientist` by the startup reconcile only if the user agrees; their `data` participation stays as attached (D4 rule), so nothing is lost |
| D11 | **Data home and disk** | (a) `<userData>/nexus` on C: with a disk guard; (b) a relocatable data home and moving Docker Desktop's disk image to another drive; (c) free space on C: first | **(c) then (a)** before B2a's verification: free at least 30 GB on C: (Docker images for all profiles need about 8–10 GB unpacked; blobs, logs and caches come on top). The data home is relocatable by a main-process setting from B2a; the worktree root is short (`C:\nx\w`) |
| D12 | **New lineage relations** (ruling R2) | (a) add `covers`, `transformed_by`, `configured_by`, `monitors` as rows in v9, and give `implements` its meaning (change set → requirement); (b) reuse `depends_on` for all four | **(a).** `depends_on` would erase the meaning of four distinct facts the UI and the completion rules need |
| D13 | **Preview and service networking** | (a) internal network + a pinned forwarder container publishing 127.0.0.1; (b) a dedicated bridge network with outbound egress (A–Z Z.24) | **(a).** Keeps untrusted apps without egress; costs one ~10 MB image |
| D14 | **Approval of the sub-phase plan** | B2a → B2b → B2c → B3 → B4 → B5 → B6, each gated | Approve B2a only; decide the next sub-phase after its verification report |

### Conflicts with B0b/B1 that need a ruling

| Id | Conflict | Recommended ruling |
|---|---|---|
| R1 | **M4** (user decision, B0b) said `data-analyst` and `data-scientist` arrive as new workspace rows, implying a move of existing `data` participations. | Keep `data` as the Data Analyst workspace (relabel in the registry only) and add `data-scientist` in v13 (D10). Changing the live legacy map so `data-science` → `data-scientist` makes the startup reconcile move those projects' primary; the old `data` row stays as an attached participation. Needs confirmation. |
| R2 | **M2** froze the 32-relation vocabulary; B1 ruling C18 said a new relation needs a user decision. | Add four relation rows (`covers`, `transformed_by`, `configured_by`, `monitors`) in v9 and assign `implements` its first meaning (D12). Additive lookup rows; nothing existing changes. |
| R3 | The seeded `lineage_relations.planned_phase` values and platform-core §18 use the A–Z numbering (B2 = QA, B3a = DA, B3b = DS, B4 = ML, B5 = DL, B6 = deploy). This plan renumbers (B2a/B2b/B2c = SDE + QA, B3 = DA, B4 = DS, B5 = ML, B6 = DL). The rows are frozen seed data. | Do not update the rows (that would rewrite v7 data). Document the mapping in `platform-core.md` Part III: old B2 → B2c, B3a → B3, B3b → B4, B4 → B5, B5 → B6, old B6 (deploy) → local scope in B2a/B5 plus FUTURE. `planned_phase` is documentation only, so no behaviour changes. |
| R4 | The session vocabulary has no `running → open` (or idle) transition, and B0b left "how job outcomes drive session status" open. | Treat `running` as "the session is live" across turns (section 5.4) and derive "Working / Waiting for you" from jobs, so the vocabulary is unchanged. Alternative: add an `idle` state and two transitions as lookup rows in v10. |
| R5 | The frozen v7 DDL comment says agent principals are `agent:<jobId>`; the B0b deferred list says `agent:<sessionId>`. | Use `agent:<sessionId>` (one principal per conversation, tokens per job). The DDL comment stays as shipped text. |
| R6 | B0b deferred "engine `utilityProcess`, MessagePort RPC, the `window.nexus` bridge" (ruling P1) to the next engine phase, with the engine owning the database (A–Z). | Build a `utilityProcess` **runner** without database access, keep the platform and SQLite in main, and keep the B1 `nexus:*` invoke surface plus one `nexus:hint` push channel instead of a `window.nexus` bridge (section 2.6). |

---

## Open risks

| Id | Risk | Likelihood / impact | Mitigation |
|---|---|---|---|
| K1 | **Disk:** 19 GB free on C: with no second drive; images, blobs, logs and caches compete with the user's existing Docker images (about 20 GB already present) | high / high | D11 before B2a verification; disk guard; image consent with sizes; blob GC; external datasets stay in place |
| K2 | **Docker memory:** 7.6 GiB VM shared with the user's running Postgres, SQL Server and Supabase containers | high / medium | caps from `docker info`; one training job at a time; clear "waiting for memory" reasons; documented Docker Desktop resource settings |
| K3 | **Policy-only file boundary** for the Claude CLI's file tools on the host worktree | medium / medium | allow-list confined to the worktree; no Bash; no web; execution only in containers; a later containerised runtime (Hermes or the CLI in a container with a model-only egress proxy) can remove it |
| K4 | **Claude CLI flag and protocol drift** across versions | medium / medium | pinned contract tests; `version_unsupported` instead of silent behaviour change; the runtime is replaceable |
| K5 | **Tests as evidence** depend on the quality of tests an agent can also write | high / medium | discovery cross-checks; scope rules; human review of test code; QA's independent suite; advisory assertion checks; the UI says what passing means |
| K6 | **Windows specifics:** MAX_PATH, CRLF, antivirus locks on renames and worktree removal, slow NTFS-to-WSL2 bind mounts for large data | high / medium | short worktree root, `core.longpaths`, retries with backoff then `file_locked`, external datasets bind-mounted read-only |
| K7 | **Scope:** six domains, seven sub-phases, about 70 new recipes, validators and kinds | high / high | strict gates; a domain is never shown as available before its exit tests pass; each sub-phase stands alone |
| K8 | **Model cost and availability** for real-agent verification | medium / medium | `ScriptedRuntime` for all automated tests; per-turn and per-day cost caps; real-model smoke only in verification |
| K9 | **Image supply chain:** base images and wheels fetched at build time | medium / medium | hash-pinned lockfiles, digest recording, SBOM per image, rebuilds only through approved jobs |
| K10 | **Activity chain tail deletion** (platform-core §16.1) becomes more relevant with more rows | low / medium | unchanged limitation; the external anchor stays on the hardening list |
| K11 | **Laptop sleep during long CPU training** counts against wall clocks | medium / low | generous DL limits; A5 approval for long runs; resume from checkpoints |
| K12 | **Two concurrent users of git** (the user and Nexus) on the same repository | medium / medium | Nexus writes only `nexus/*` refs and its own worktrees (A3); accept never touches the user's branch; merge is explicit, fast-forward only, clean tree only |
| K13 | **Pickle and untrusted model files** | medium / high | loaded only inside containers; main never unpickles; UI shows the signature and metadata only |
| K14 | **Hermes left unbuilt** means the "replaceable runtime" claim rests on one production runtime plus a test runtime | medium / low | the contract suite is runtime-agnostic; adding an adapter needs no orchestration change |
