## Header

### Goal

Build one honest, sandboxed execution path and prove it on the SDE tool path, with no agent and no model credential.

- **Schema v9**, additive, with the v7/v8 safety procedure: job attempts, job events, blobs, version blobs, validations, approvals, image builds, deployments, their state lookups, four lineage relation rows (D12), and six indexes on v7 tables.
- **Execution core in main** (`src/main/nexus/exec`): scheduler with leases and heartbeats, cancel, timeout, retry, ingest, restart recovery (R.2). SQLite stays the only authority for job state.
- **A runner `utilityProcess`** (`src/runner`) with no database access: Docker sandbox driver with a mandatory preflight, staging, output hashing, logs, JUnit parsing (`fast-xml-parser`), health probes, image builds. It reports facts; main decides.
- **Evidence and validation:** a validator framework, `validations` rows bound to job, attempt and version, and the B2a validators. A step is done only on validated evidence.
- **Domain registry:** `DomainSpec` v3 for the six first-class domains plus three registry-only entries, with boot checks; the renderer shows each domain's real lifecycle and language.
- **SDE tool path, user-triggered:** repository snapshot, dependency install (approved egress), test discovery, tests (node:test, jest, vitest, mocha, pytest), build (node, python), application assembly, dev deployment on 127.0.0.1 through a forwarder, diagnostics. Requirements and problem statements are written in Nexus.
- **Resource gate and preflight:** disk, Docker, memory, CPUs, images; exposed through IPC and in the UI as actionable states; heavy tests refuse to run below the gate.
- **Persona cleanup** in `src/shared/domain.ts`.
- **Twenty new `nexus:*` invoke channels (#22–#41) and one push hint (`nexus:hint`).**
- **UI** inside Spine + Folio: run history with real evidence, approvals, preflight state, deployments, lifecycle rails in each domain's words.

**Not in B2a:** any agent execution, AgentRuntime implementations, ClaudeCliRuntime, capability tokens, MCP, secrets storage, spend caps (all B2b); change sets, review, accept (B2b); QA, DA, DS, ML, DL workflows (B2c–B6). B2a never claims a domain is complete.

### Architecture

- **Layers.** Renderer (untrusted, ids only) → `nexus:*` invoke → main (platform services, the one SQLite writer, `ExecutionService`) → `RunnerPort` (MessagePort) → runner `utilityProcess` (no DB) → `docker` CLI (async spawn, argv arrays) → containers (one per attempt, labelled).
- **Where the code lives.**
  - `src/shared/nexus/`: types and pure rules only (`execution.ts`, `runnerProtocol.ts`, `runtime.ts`, `evidence.ts`, `domainSpec.ts`, `domains/*`, `kinds.ts`, `capabilities.ts`, `recipes.ts`, `validators.ts`, `actions.ts`, `registryCheck.ts`, `resourceGate.ts`, `preflightCheck.ts`, `ipc.ts`).
  - `src/main/nexus/` (transport-free, testable on a bare database with a fake runner): `db/schemaV9.ts`, `db/v9Seed.ts`, `exec/*`, `blobs/*`, `validation/*`, `approvals/*`, `deployments/*`, `repo/*`, `registry/*`.
  - `src/main/nexusExec/` (new, outside the core because it uses Electron): `runnerHost.ts` (fork, MessageChannelMain, supervision), `dataHome.ts`, `execWiring.ts` (timers, hint coalescing, log reads).
  - `src/runner/` (new electron-vite input, built to `out/main/runner.js`): the runner.
  - `src/main/nexusIpc/`: still the only `nexus:*` registrar.
  - `infra/images/{sde-node,sde-python,nexus-fwd,common}/`: Dockerfiles, lockfiles, the Nexus-owned entry script, `lock.json`.
- **Trust boundary.** The renderer sends ids, enums and schema-checked params only. Main resolves the principal, the project folder (from the `projects` row through `acceptFsRoot`), every host path (under the data home) and the container spec. The runner holds no authority: every message is a report that main validates (shape, known attempt, lease owner = current boot, monotonic `seq`).
- **Process isolation.** Main never runs Docker, a parser or a hash over output trees. The runner never opens SQLite. Containers see only their mounts.
- **Testing.**
  - `npm run test:focused` (plain node): pure contracts, registry, preflight comparator, protocol parser, JUnit parser, runner core with a fake driver, renderer models, posture pins.
  - `npm run test:db` (Electron-as-node, real SQLite): v9 schema and migration, services, scheduler, ingest, validation, approvals, recovery, IPC, flows, all with a **fake runner**.
  - `npm run test:exec` (new; Electron-as-node + real Docker): runs only when the resource preflight passes, and otherwise reports **NOT RUN** with reasons and a distinct exit code. It never skips silently.

### Tech stack

Electron 32 (`utilityProcess`, `MessageChannelMain`), React 18, zustand, better-sqlite3 (one connection, WAL), TypeScript, `node:test`, `test/load-ts.cjs`, `tools/run-electron-tests.cjs`, Docker Desktop CLI. **One new dependency:** `fast-xml-parser@5.11.2`, pinned exactly, used by the runner only (D7).

### Spec

`b2a-user-brief.md` + `nexus-domains-architecture-b2.md` (rulings applied) + `docs/nexus/platform-core.md`.

### Global constraints (one line each)

- Work on `our-platform` only. One commit per task. No squash, amend, rebase or force-push. Do not touch `stash@{0}`.
- **Commit only this task's own files, by explicit pathspec:** `git commit -m "<msg>" -- <path> <path> …`. Never `git add -A`, `git add .`, `git commit -a`, or a commit without a pathspec. A peer session has staged changes on this branch (`hairline/*`, `WelcomePage.tsx`, `RouteView.tsx`, `uiStore.ts`, `welcome.css`); a pathless commit would take them. Before each commit run `git diff --cached --name-only` and check it lists only the task's files; if anything else is staged, commit with the pathspec anyway (the pathspec form commits only those paths) and never unstage the peer's files.
- Every commit message ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- **Never touch** `src/renderer/src/nexus/pages/WelcomePage.tsx`, `src/renderer/src/nexus/hairline/*`, `src/renderer/src/nexus/routes/RouteView.tsx`, `src/renderer/src/nexus/state/uiStore.ts`, `src/renderer/src/nexus/styles/welcome.css`. Read-only use (importing `useNexusUi`) is allowed.
- Do not change `appId`, `productName`, the userData path or the `harness.db` filename.
- **Never launch the app in a task.** No `npm run dev`, `npm start`, `npm run preview`, no Electron on the app entry. Never touch `%APPDATA%\munder-difflin`. Only the controller launches, in Verification, after an explicit go-ahead, on a scratch `--user-data-dir` (except the one approved real-DB migration launch).
- **No image pull or build, and no container start, in a task.** Tasks use the fake driver. Real Docker runs only in `test:exec`, in Verification, after the resource gate passes and the user's go-ahead.
- **Network in tasks:** only `npm install --save-exact fast-xml-parser@5.11.2` (Task 11) and the registry-metadata lookups of `tools/nexus-lock-images.cjs` (Task 12), both run by the controller (see Open questions Q3).
- **Fixtures only.** Tests use temp folders, `h.v6Fixture()`, temp git repos made by the test, and temp data homes. Nothing reads or writes the real userData.
- **Additive only.** v9 is `CREATE … IF NOT EXISTS` and `INSERT OR IGNORE` only. No `DROP`, no `ALTER`, no rewrite of a v1–v8 row, no FK on a v1–v8 table, no change to `V7_DDL` or `V8_DDL` text.
- **v7 and v8 behaviour is unchanged.** Their log lines, outcomes, backup names and markers stay byte-identical. The only edits to existing tests are the mechanical ones named in Tasks 3, 5 and 13, each listed in the commit body with its reason.
- **No permission check is bypassed for testing.** Tests use the real `AuthService` with restricted test principals; nothing mocks authorization.
- **No persona names.** No brand or persona string in any new file, fixture, seed, comment, log line or copy. The identity guard's known-leaks list may shrink, never grow. `test/nexus-core-identity-scan.test.cjs` also scans `src/runner`, `src/main/nexusExec` and `infra/images`.
- **Freezing ratchet.** No `execSync`, `spawnSync` or `execFileSync` under `src/main` (the existing posture test stays unchanged) or `src/runner` (a new pin). No `shell: true`. No command built from a string.
- **No fake data.** No placeholder jobs, evidence, metrics, deployments or activity. A screen shows real rows or an honest empty, unavailable or "not in this release" state. An action that cannot run is a sentence, never a disabled button.
- **No old UI.** Spine + Folio only. No dashboards, cards, islands, office language or gradients. Reuse `styles/tokens.css` and the existing components.
- **B0a protections stay.** No renderer-chosen path, root, command or identity. `configPolicy` and `spawnPolicy` untouched.
- **Test runners.** `test:db` fails on any skip/todo/0 tests. `test:focused` and `node --test test/` show exactly the 11 baseline failures. `test:exec` is PASS, FAIL or NOT RUN, never a silent skip.
- **No new IPC outside `nexus:*`**, and no `nexus:*` literal outside `src/main/nexusIpc/registerNexusIpc.ts` (main) and the preload.
- **Scope stop.** No B2b, no agent execution, no QA/DA/DS/ML/DL workflow, no Hermes.

### Review focus: the 6 most likely failure modes

1. **v9 breaks startup, v7 or v8.** A throw escapes `open()`; `migrateV8` re-runs on a v9 file because it tests `version === V8`; holds do not cascade; a v8 log string changes. **Check:** Task 5 cases M1–M16 and every existing `nexus-db-*` test (with only the named mechanical edits).
2. **Work is falsely completed.** A job reaches `completed` or a version reaches `candidate` on exit code 0, a file's existence or a recovery guess. **Check:** the evidence invariant O16 (no job-produced candidate or active version without a passed row for every blocking validator of its kind) runs after every flow; negative tests N1–N12 (Task 8); recovery tests RC1–RC12 (Task 10).
3. **The sandbox does not hold.** A container starts without limits, with a network, with a writable root or an extra mount; egress without an approval; a published port on 0.0.0.0. **Check:** create → inspect (preflight) → start, with a pure comparator (Task 1) and fault-injection tests (Tasks 11, 12).
4. **Main blocks or the database gets a second writer.** Docker or hashing on the main thread; the runner importing SQLite; a hang in Docker freezing IPC. **Check:** posture pins (Task 11), the event-loop lag test and the hung-runner IPC test (Task 7, Task 13).
5. **Recovery corrupts state.** A running container is interrupted instead of adopted; an exited one is never ingested; a leased job is lost; orphans survive or a user's own container is touched. **Check:** Task 10 (fake) and Task 12 (real) recovery matrices; the label filter test.
6. **The UI lies.** An enabled action for a FUTURE step or a missing prerequisite; a "completed" headline on a run whose checks failed; a percentage no parser reported. **Check:** the honesty audit test (Task 15) and the run-model tests (Task 14).

---

