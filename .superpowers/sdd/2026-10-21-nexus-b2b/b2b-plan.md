# Nexus B2b — Agent runtime and AI-assisted SDE: implementation plan (Revision 1)

> **For agentic workers:** REQUIRED SUB-SKILL: use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan one task at a time. Each task gets its own implementer and a separate reviewer. Steps use checkbox (`- [ ]`) syntax for tracking.

**Status:** Revision 1 of the proposal. It answers the pre-flight review (`b2b-plan-review.md`: 5 Blockers, 17 Important, 11 Minor) and the binding user decisions (`b2b-user-decisions.md`).
- Nothing in this plan is implemented yet.
- B2b is planned, built, verified and reported, and then it **stops**. It contains no B2c or later work.
- Before Task 0 starts, the user must answer the new decisions D-B12 to D-B14 (see [Decisions](#decisions)).
- **"As in Revision 0"** points to `b2b-plan-rev0.md` in this folder. That file holds the Revision 0 tests, tables and interfaces, and its header maps the old task numbers to these. This file wins on any difference. Every MCP tool name changes from dots to underscores.

**Goal:** make SDE executable end to end with a real agent. The agent is the user's existing CLI login, reached only through the replaceable `AgentRuntime` interface.
- The agent drafts requirements, implements changes in a Nexus worktree, and iterates on review comments and diagnostics.
- Every claim rests on git facts and validated test evidence.
- Review, accept and merge stay with the user.

**Architecture:**
- **The agent process.** The agent CLI runs on the host, as a child of the runner `utilityProcess`, under a Nexus-generated per-turn policy:
  - built-in tools are limited to Read, Edit, Write, Glob and Grep, confined to the session worktree;
  - there is no shell and no web access;
  - MCP is strict: the only server is Nexus's;
  - no user hooks, settings, plugins or CLAUDE.md are loaded;
  - sessions are not persisted;
  - repository files with sensitive names cannot be read.
- **Commands.** Every command runs through the Nexus MCP tool `sandbox_exec`. It executes in the turn's own Docker container, which has network `none` and the worktree bind-mounted at `/workspace`.
- **The CLI's own traffic.** It goes through a runner-hosted loopback proxy. That proxy is B2a's `egress-proxy.js` itself, loaded from the repository, so no image changes. It admits `api.anthropic.com:443` only.
- **Main** authorizes every MCP call with an opaque per-turn capability token. It records everything in the v10 tables, `job_events` and activity.
- **Git writes.** Every git write is a system engine job:
  - Nexus commits the agent's work on `refs/nexus/job/<session>`.
  - Accept merges into `refs/nexus/accepted/<branch>` with `merge-tree`, a CAS `update-ref`, and a rollback when the database part fails. It never touches the user's branch or files.
  - "Merge accepted work" is a dialog-confirmed `git merge --ff-only <confirmed sha>`.

**Tech stack:**
- Electron 32 (`utilityProcess`, `MessageChannelMain`), React 18, zustand, better-sqlite3 (one connection, WAL), TypeScript.
- Tests run with `node:test`, `test/load-ts.cjs` and `tools/run-electron-tests.cjs`.
- Docker Desktop CLI; git ≥ 2.38 (`merge-tree --write-tree`).
- The installed agent CLI: 2.1.295 today, the native `C:\Users\pc\.local\bin\claude.exe`.
- **No new npm dependency.** The MCP server is hand-rolled (D7), and the proxy is B2a's file.

**Spec:**
- `.superpowers/sdd/2026-10-21-nexus-b2b/architecture-b2.md`: §1.3 steps 1, 5, 7, 9 and 12; §2; §6; §9.3; §10.3; §12; §13; §14; §15.2. This is the pre-review text; [Conflicts](#conflicts-with-the-architecture) lists what is stale.
- `docs/nexus/platform-core.md` Parts I–III. The code wins.
- `b2a-user-brief.md`.
- `b2b-user-decisions.md` (binding).

**Base:** HEAD **`4aec76f6`** on `our-platform`. The B2a-close commits have landed:
- `fe933d35`: the L11 bound is p99 < 50 ms and max < 250 ms;
- `6761e0c9`: a runner restart holds lease expiry until it reconciles;
- `4aec76f6`: the legacy git path is hardened, and `hive` resolves git through `gitBinary`.

Execution stays off by default (`V9_ENABLED_BY_DEFAULT = false`). The peer's uncommitted renderer work (listed below) is still in the tree.

---

## Global Constraints

### The B2a user constraints (2026-10-08), verbatim where they apply

1. **Pre-flight resource gate.**
   - At least 30 GB of free disk before verification; 35–40 GB+ preferred.
   - Never silently continue heavy execution tests when the requirement is not met.
   - Expose a clear, actionable preflight or failure state.
2. **AgentRuntime abstraction.**
   - The Claude CLI is approved as the default engine.
   - Nexus → AgentRuntime abstraction → Claude CLI adapter.
   - All agent execution goes through the replaceable interface.
   - The data model, UI, job system and workflows must never be designed around Claude-specific concepts.
3. **B2b scope** (replaces B2a's item 3 for this phase):
   - `AgentRuntime`, the CLI adapter and `ScriptedRuntime`;
   - the context resolver; skills; capability tokens;
   - the MCP endpoint and gateway; agent principals;
   - the A1 egress flow for agent-requested installs;
   - `change_set` with its validators;
   - review; the integration ref; accept; merge accepted (A4);
   - request changes and iteration;
   - the intent line and agent panel;
   - channels #42–#51.

   Never claim a domain other than SDE is complete. No fake domain functionality to fill screens.
4. **Evidence-based completion.**
   - Never success merely because of: exit code 0, a file existing, a README existing, the UI saying completed, or an expected directory existing.
   - Completion requires domain-specific validated evidence: a parsed test report, verified build output, a fingerprinted artifact, validated metrics, an endpoint health check, an I/O contract check, or a reproducible execution record.
   - Persist the evidence and associate it with the job, artifact and version.
5. **Network.**
   - Off by default.
   - Any network-enabled operation goes through an explicit Nexus-controlled policy and approval path.
   - No unrestricted escape.
6. **Secrets.**
   - Kept in encrypted secret storage.
   - Never exposed to the renderer, logs, artifacts, activity, prompts or errors.
   - Enforce the planned spending and rate controls.
7. **Docker and resource safety.** Docker is the default boundary. Test all of these:
   - CPU, memory, disk and process limits
   - cancellation and timeout
   - container cleanup
   - abnormal termination
   - concurrent jobs
   - Docker unavailable
   - Docker resource exhaustion

   The Electron UI stays responsive whenever execution fails, times out, or Docker is under pressure.
8. **Python.**
   - Use pinned images or environments, never the global host Python.
   - Record the environment and version used.
9. **Database.**
   - SQLite stays the single source of truth. No second authoritative database for job state.
   - Engine scratch state must be recoverable and reconcilable through Nexus-owned state.
10. **Recovery.**
    - Test restart during each of these: queued, provisioning, running, tool execution, validation, waiting for approval.
    - Nexus must reconstruct the correct state, and never falsely mark unfinished work as completed.
11. **Security.** Test each of these:
    - unauthorized job execution
    - unauthorized file access
    - path traversal
    - access outside the workspace
    - invalid artifact or job references
    - secret exposure
    - approval bypass
    - network policy bypass
    - malformed tool requests

    No permission check may be bypassed for testing.
12. **Testing, before declaring B2b complete.**
    - B2b unit, integration, failure-path, restart/recovery, security and concurrency/resource tests all pass.
    - Typecheck and the production build pass.
    - The existing Nexus regression suite passes.
    - The legacy identity guard passes.
    - A fresh-app click-through passes.
    - Do not hide failures by changing or removing existing tests.
13. **Observability.** Every job durably records:
    - who or what started it
    - domain and project
    - inputs
    - allowed tools
    - environment
    - what actually executed
    - evidence produced
    - why it succeeded or failed
    - the resulting artifact or version
14. **Product.** Keep Spine + Folio. No generic dashboards, cards, islands or legacy office-style UI.
15. **Stop** (B2b form).
    - Implement B2b only: no B2c, no QA, ML, DL, DA or DS workflows, and no further domain implementation.
    - Afterwards: run the full verification, then report exact results, resource and preflight findings, known limitations, exact files changed and the commit hash.
    - Then STOP and wait. Do not proceed to B2c.

### The user's B2b decisions (binding; `b2b-user-decisions.md`)

- **D-B1 / D-B3: where the CLI runs and how it signs in.**
  - The CLI runs on the host under the runner, using the user's existing login store in place. There is **no `CLAUDE_CONFIG_DIR` override**.
  - Nexus never reads, copies or stores the credential.
  - Every command goes into a network-`none` container through `sandbox_exec`.
  - The file-tool boundary is a policy, not OS isolation, and the UI and docs say so.
  - **If the real-login smoke fails under the isolation flags: STOP and ask about a setup-token. Never fall back silently.**
- **D-B2: the network destination.**
  - There is one destination, `api.anthropic.com:443`, for the agent process only, through the runner-hosted proxy.
  - It is granted once in the setup sheet and can be revoked.
  - **If the CLI needs anything else: STOP and ask.**
- **D-B4: caps.**
  - $2 per turn, $10 per day, 6 turns per hour, 1 concurrent turn, 400k tokens per turn, 200 tool calls, a 30-minute wall clock, 20 child jobs.
  - Cost is labelled "reported" (an estimate).
- **D-B5: CLI version.** Accept 2.1.x when every pinned flag is present; otherwise the runtime reads as unsupported.
- **D-B6 / A3: writing into the user's repository.**
  - Writes into the user's `.git` are allowed after an approval given once per project.
  - Worktrees live under `<userData>\nexus\wt\`, and refs only under `nexus/*`.
  - Accept never touches the user's checked-out branch or files.
  - "Merge accepted work" is a dialog-confirmed fast-forward that refuses a dirty tree or a non-fast-forward.
- **D-B7: context.** The context is rebuilt from Nexus records each turn (`--no-session-persistence`). The CLI's own resume is not used.
- **D-B8: commit identity.**
  - Agent commits use `Nexus agent <agent@nexus.invalid>` with a `Nexus-Job:` trailer.
  - Accept merges use `Nexus <agent@nexus.invalid>` with `Nexus-Accepted-By: user:local`.
- **D-B9: the engine name in the UI.** The engine name appears only on the setup row. Every other screen says "the agent".
- **D-B10: a new channel.** `#51 nexus:agent:consent` is added. B2c's planned numbers shift by one.
- **D-B11: v10 and resources.**
  - v10 runs on a test copy first, then a fingerprinted backup is taken, then it runs on the real DB, only with the user's go-ahead at verification.
  - `test:exec` needs at least 30 GiB free and Docker running.
- **Execution stays off by default** until B2b is verified. Both default flips (`V9_ENABLED_BY_DEFAULT` and `V10_ENABLED_BY_DEFAULT`) are proposed in the report and done only on the user's go-ahead.
- **Secrets under D-B1.**
  - B2b stores no secret, so the encrypted store holds nothing new.
  - The secrets that do exist are the capability token, anything the agent or the repository emits, and the CLI's `auth status` identity. They reach no renderer, log, artifact, activity row, prompt or error.

### Standing rules (carried from B2a, updated)

- **Branch and commits.**
  - Work on `our-platform` only, one commit per task.
  - No squash, amend, rebase or force-push. Do not touch `stash@{0}`.
  - Commit by explicit pathspec: `git commit -m "<msg>" -- <path> …`.
  - Never use `git add -A`, `git add .` or `git commit -a`.
  - Before each commit, run `git diff --cached --name-only`. Never unstage or commit the peer's staged `hairline/*` rename and deletes.
  - Every commit message ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
  - The task reviewer checks `git show --name-only <commit>` against the peer-owned list below (replaces UA10, F20).
- **Peer-owned files, never edited:**
  - `src/renderer/src/App.tsx`
  - `src/renderer/src/nexus/routes/RouteView.tsx`
  - `src/renderer/src/nexus/state/uiStore.ts`
  - `src/renderer/src/nexus/start/*`
  - `src/renderer/src/nexus/pages/WelcomePage.tsx`
  - `src/renderer/src/nexus/styles/start.css`
  - `src/renderer/src/nexus/styles/welcome.css`
  - `src/renderer/src/nexus/hairline/*`
  - `test/nexus-start.test.cjs`

  Read-only use is allowed: `useNexusUi` and the route types. **No new route** is added. The UI lives in the existing project tools (`bench`, `changes`, `runs`) and the Folio.
- **Things never changed.** No `appId`, `productName`, userData or `harness.db` rename. `proj_a8a7a6adbc58`, `proj_50dd134996e7` and the three older orphan plans stay untouched. Never bypass permissions for database cleanup.
- **Launching the app and the real CLI.**
  - Never launch the app in a task, and never touch `%APPDATA%\munder-difflin`.
  - **Real CLI rule (needs D-B12):** a task may run the installed CLI binary only through `test/helpers/agentHarness.cjs`. That harness provides:
    - a planted fake home;
    - `ANTHROPIC_BASE_URL` pointed at the loopback mock model;
    - a fake key;
    - a deny-all recording proxy.

    It never uses the user's home, login, CLI store or the network. Until D-B12 is approved, Task 0 and the CR tests are run by the controller instead.
  - The real login, real Docker, the model API and the user's repositories are used only in Verification, by the controller, after the user's go-ahead.
- **Additive schema only.**
  - v10 uses only `CREATE … IF NOT EXISTS` and `INSERT OR IGNORE`.
  - No `DROP` or `ALTER`, no rewrite of a v1–v9 row, no FK on a v1–v9 table.
  - `V7_DDL`, `V8_DDL` and `V9_DDL` stay byte-identical, and so do their log lines, outcomes and backup names.
- **No permission bypass in tests.** Agents act only through `AuthService.authorizeWithToken`. Tests use the real `AuthService`.
- **Freezing ratchet.**
  - No `execSync`, `spawnSync` or `execFileSync`, no `shell: true`, and no command built from a string.
  - **The runner spawns exactly four programs, each by a resolved absolute path:** `docker`, `git`, the agent CLI, and `%SystemRoot%\System32\taskkill.exe`.
  - The posture pin is widened twice, each time as a named edit: Task 11 adds taskkill and Task 13 adds the CLI.
  - Every new git call goes through `proc.ts` `runGit` and `git.ts` `gitPrefix`. There is no new git spawn site.
- **UI honesty.**
  - No fake data and no old UI: Spine + Folio only.
  - An action that cannot run is shown as a sentence, never as a disabled button.
  - No number without a source. Usage and cost read "reported by the agent runtime", or "estimated" when Nexus charged the cap.
- **Vendor-neutral scan.** `test/nexus-core-vendor-neutral.test.cjs` covers `src/shared/nexus/**`, `schemaV10.ts` (`LATER`), `src/main/nexus/agents/**`, `src/main/nexus/repo/**`, `src/main/nexus/review/**`, `src/renderer/src/nexus/agent/**` and `resources/skills/**`.
  - Engine names, env names, flags, hosts and model ids may appear only in `src/runner/runtimes/cliAgent/**`, `test/helpers/agentHarness.cjs`, `test/runtime-*.test.cjs`, `tools/nexus-agent-probe.cjs` and their fixtures.
  - The model id the CLI reports is stored opaquely in `job_attempts.environment_json` (constraint 13). No view shows it.
- **IPC.** No new IPC outside `nexus:*`. No `nexus:*` literal outside `registerNexusIpc.ts` and the preload.
- **Test runners.**
  - `test:db` fails on any skip, todo or 0 tests.
  - `test:focused` and `node --test test/` show exactly the 11 baseline failures.
  - `test:exec` and the new `test:runtime` end in PASS, FAIL or NOT RUN (exit 3); they never skip silently.
- **Subagent effort** is `high`.

---

## Review Focus

These are the failure modes most likely to hurt a user. Each line names the test, in its owning task, that pins it.

1. **The host-side CLI or git escapes the worktree.** The routes are:
   - a symlink or junction, either checked out or planted through the rw bind mount;
   - a nested `.git` directory or a gitlink;
   - an absolute path or `..` in a file-tool call;
   - a rewritten worktree `.git` file;
   - a tracked `.env` or `*.pem` that the model is shown.

   **Expected:** the read is refused or never followed. Collect refuses links and nested repositories, and Nexus's own git always uses a verified explicit `--git-dir`. Tests: RW7, RW10, RW11 (Task 7); CR6, CR12 (Task 13); AT14 (Task 11).
2. **Accept races and crashes.** The cases:
   - the integration ref moves between review and click;
   - a crash or refusal falls between `update-ref` and the database transaction;
   - the user's tree is dirty or mid-rebase.

   **Expected:** a CAS miss answers `ref_moved`. An unfinished accept is rolled back, never merged later. The user's HEAD, branch, index and files stay byte-identical. Tests: RA4, RA5, RA6, RA11, RA12, RA13 (Task 9).
3. **Secrets in agent output.** A secret can appear in added lines, messages, MCP args, CLI stderr, `sandbox_exec` output, `auth status` output, or the AgentPlan record.

   **Expected:** a change set holding a provider-key or private-key shape fails, and the evidence carries path:line only. Every log, event, attempt row and view is redacted. The token is never in argv, a log, the context, a database row or a view. Tests: CS4 (Task 8), MG9 (Task 5), TK12 (Task 4), CR4, CR13 (Task 13), AT9 (Task 11), AT15 (Task 10).
4. **Runaway spend.** The cases:
   - a turn that loops tool calls or long outputs;
   - a CLI whose own budget flag fails;
   - a turn killed before it reports cost;
   - many turns in a short time.

   **Expected:**
   - Usage is tracked monotonically per assistant message, and the turn is cancelled at its token, USD or tool-call cap.
   - An unreported cost is charged at the turn cap, as "estimated".
   - The day cap also applies mid-turn.
   - The hourly rate limit and the concurrency limit refuse a new start.

   Tests: BG3–BG8 (Task 4); AT6, AT16 (Task 10); CR14 (Task 13).
5. **Orphan processes on Windows.** **Expected:**
   - A cancel, a timeout, an app quit or a runner crash in the same main boot ends the CLI tree.
   - After an app restart, nothing is killed: the orphan is inert, because its proxy and MCP ports and its token died with the old boot.
   - The user's own CLI sessions are never touched.

   Tests: AT7, AT8, AT17 (Task 11); CR9 (Task 13).

---

## File structure map

### Shared contracts (vendor-neutral, pure)

| File | Change | Responsibility |
|---|---|---|
| `src/shared/nexus/runtime.ts` | modify | `credential: { ref: string }` stays (V3 pin); B2b sets the value to `'runtime-owned'`. `mcp: { url: string }` (drops `tokenFile`; the token travels in memory). `describe()` gains `label: string` and `egressHosts: { host: string; port: number }[]`. Adds the `AgentUsage` type. |
| `src/shared/nexus/execution.ts` | modify | `AgentPlan` (fourth `AttemptPlan`). `MountSpec.kind` += `'worktree'`. `EngineTask` git variants. `GitReadTask`. |
| `src/shared/nexus/runnerProtocol.ts` | modify | New ops and parsers. `ready.mcpUrl`. A bounded deep copier for MCP args. |
| `src/shared/nexus/recipes.ts` | modify | Engine recipes: `repo.worktree`, `changeset.collect`, `changeset.merge_check`, `changeset.accept`, `changeset.accept_rollback`, `repo.ff` (`subPhase: 'B2b'`). |
| `src/shared/nexus/tokens.ts` | create | `CapabilityClaims` type; `TOKEN_RE = /^[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}$/`. |
| `src/shared/nexus/mcpTools.ts` | create | `MCP_TOOLS` (underscore names) and `parseToolArgs`. |
| `src/shared/nexus/agentPolicy.ts` | create | `AGENT_DEFAULTS` (D-B4), `budgetDecision`, `clampCaps`. |
| `src/shared/nexus/changeSet.ts` | create | `ChangeSetMeta`, `pathInScope`, `SENSITIVE_PATH_RE`, `isLockfilePath`. |
| `src/shared/nexus/capabilities.ts`, `validators.ts`, `evidence.ts`, `actions.ts`, `domainSpec.ts`, `domains/sde.ts`, `ipc.ts`, `registryCheck.ts`, `secretShape.ts` | modify | Skills, change-set validators (with a `vB2b` constructor), SDE steps, views, the diff-line secret rule. |

### Main (transport-free core)

| File | Change | Responsibility |
|---|---|---|
| `src/main/nexus/db/schemaV10.ts`, `v10Seed.ts` | create | v10 DDL, shape, verify, apply. |
| `src/main/db.ts` | modify | `migrateV10Guarded`, the exact-version sites (F8), `agentsAvailable`. |
| `src/main/nexus/auth/{policy,authService}.ts`, `src/shared/nexus/platform.ts` | modify | New actions; `authorizeWithToken`. |
| `src/main/nexus/agents/{tokenService,budgetService,contextResolver,skills,mcpGateway,agentService}.ts` | create | Tokens, consent and caps, context, skills, gateway, sessions and turns. |
| `src/main/nexus/repo/{worktreeService,changeSetService,acceptService,gitRead}.ts` | create | A3 and worktrees; change sets; accept and merge; the bounded `git.read` port. |
| `src/main/nexus/review/reviewService.ts` | create | Review decisions (`TurnStarter` port). |
| `src/main/nexus/validation/validators/{diffNonempty,pathsInScope,secretScan,secretEntropyNotes,csTestsPass,appliesCleanly}.ts` | create | The change-set validators. |
| `src/main/nexus/exec/{executionService,scheduler,planBuilder,recovery,ingest}.ts` | modify | Agent lease (mint inside the lease transaction), engine git jobs, runtime events and usage, recovery. |
| `src/main/nexus/{platform,registryImpl}.ts` | modify | Composition; `B2B_IMPL`. |

### Electron edge, runner and IPC

| File | Change | Responsibility |
|---|---|---|
| `src/main/nexusExec/execWiring.ts`, `runnerHost.ts` | modify | MCP relay, `confirmMerge` dialog port, probe cache; `shutdown` kills live CLI trees. |
| `src/runner/mcpServer.ts` | create | Loopback Streamable-HTTP JSON-RPC server. Forwards to main and decides nothing. |
| `src/runner/hostEgressProxy.ts` | create | Loads `infra/images/sde-node/egress-proxy.js` and listens on `127.0.0.1:0`. |
| `src/runner/agentAttempt.ts`, `procTree.ts`, `worktreeGuard.ts`, `gitWrite.ts`, `gitRead.ts` | create | One turn; the CLI tree; lstat walk and size cap; git writes; git reads. |
| `src/runner/runtimes/{registry,scripted}.ts`, `runtimes/cliAgent/{adapter,args,env,stream,binary,files}.ts` | create | Runtimes. **`cliAgent/**` is the only code that names the engine.** |
| `src/main/nexusIpc/{registerNexusIpc,validate,dto}.ts`, `src/preload/index.ts`, `src/main/index.ts` | modify | `NEXUS_AGENT_CHANNELS` #42–#51 and the `diff` preview part. |

### Renderer (non-peer files only)

| File | Change | Responsibility |
|---|---|---|
| `src/renderer/src/nexus/agent/{AgentPanel.tsx,agentModel.ts,SessionLog.tsx}` | create | Sessions and turns in the bench. |
| `src/renderer/src/nexus/project/{ChangeSetReview.tsx,changeSetModel.ts}` | create | Change sets in the Changes tool and the Folio. |
| `data/{nexusClient.ts,useAgents.ts,executionModel.ts}`, `components/ExecutionSetupSheet.tsx`, `project/{ProjectBench,kindViewers,actionModel,spineModel}`, `review/ReviewSurface.tsx`, `intent/IntentLine.tsx`, `runs/jobRunModel.ts`, `styles/execution.css` | modify / create | Client, setup rows, wiring. |

### Other

| File | Change | Responsibility |
|---|---|---|
| `resources/skills/nexus-sde-{change,tests-first,requirement-draft,app-manifest}/SKILL.md` | create | Nexus-owned skills. |
| `tools/nexus-agent-probe.cjs`, `test/helpers/{agentHarness,mockModel,fakeHome,proxyRecorder,mcpRecorder,agentFixtures,scriptedFixtures}.cjs`, `test/fixtures/agent/**` | create | Task 0 probe; harness; fixtures. |
| `tools/run-runtime-tests.cjs`, `package.json` (one script line) | create / modify | The `test:runtime` gate. |
| `docs/nexus/platform-core.md` | modify | Part IV. |

---

## Tasks

There are 18 tasks, run strictly in order: 0 → 17. Each task ends green on its named tests plus `npm run typecheck`. Each task also runs its layer's regression suite, which must stay at baseline:
- `npm run test:focused` for shared, runner and renderer work;
- `npm run test:db` for main.

Every task's report lists its files and its commit hash.

### Task 0: Adapter feasibility probe (real CLI, no model call) — with STOP branches

The probe proves, on the installed binary, what Tasks 5–13 rely on. It never reaches the model:
- Probe P-A answers from a loopback mock model, with a fake home and a fake key.
- Probe P-B sends the CLI's real API traffic to a recording proxy that **refuses every CONNECT**.
- Probe P-C only reads the login state, through a deny-all proxy.

**Who runs it:**
- P-A and P-B are run by the task agent if D-B12 is approved, otherwise by the controller.
- P-C reads the user's real home and is run **only by the controller**, with the user's go-ahead.

**Files:**
- Create: `tools/nexus-agent-probe.cjs`, `test/helpers/{agentHarness,mockModel,fakeHome,proxyRecorder,mcpRecorder}.cjs`, `test/fixtures/agent/probe/**`
- Output: `.superpowers/sdd/2026-10-21-nexus-b2b/task0-probe-report.json` and `.md`. These are probe results, not code.

**Interfaces (produced, used by Tasks 6, 12 and 13):**
- `agentHarness.start({ home: 'fake', model: 'mock' | 'none', proxy: 'deny-all' | 'recorder', mcp: 'recorder' }) → { env, argvBase, home, mock, proxy, mcp, stop() }`.
  - The mock model speaks the Messages API over plain HTTP on 127.0.0.1. It scripts `tool_use` turns and records every request body, including the system prompt and the tool list.
  - `proxyRecorder` logs each `CONNECT host:port` and refuses it with 403.
  - `mcpRecorder` is a minimal Streamable-HTTP MCP server. It records `initialize`, `tools/list` and `tools/call` together with their headers.
- `probeReport`: `{ cliVersion, helpFlags: Record<flag, boolean>, checks: { id, result: 'pass'|'fail'|'n/a', detail }[], decisions: { id, branch }[] }`.

**Checks and branches:**

| Id | Check | Pass | Branch on failure |
|---|---|---|---|
| P0 | `--version` matches `^2\.1\.\d+` | — | **STOP (S1):** ask the user to install a 2.1.x CLI, or to approve re-pinning |
| P1 | `--help` lists every flag in `PINNED_FLAGS`: `-p`, `--output-format`, `--verbose`, `--input-format`, `--restricted`, `--safe-mode`, `--strict-mcp-config`, `--mcp-config`, `--settings`, `--setting-sources`, `--tools`, `--allowedTools`, `--disallowedTools`, `--permission-mode`, `--permission-prompts`, `--no-session-persistence`, `--disable-slash-commands`, `--no-chrome`, `--max-budget-usd`, `--append-system-prompt`; and `--append-system-prompt[-file]` in any form | all present | **STOP (S1)** for a missing flag. `[-file]` alone missing → **pre-decided, no stop:** skills travel as a stdin preamble (the default for context anyway, F2) |
| P2 | P-A with `--safe-mode --restricted --strict-mcp-config --mcp-config <job mcp.json>`: the MCP recorder receives `initialize` and `tools/list`, and the mock model's tool list contains `mcp__nexus__context_get` | received | **STOP (S2):** `--safe-mode` drops the Nexus server. Ask the user: drop `--safe-mode` (keep `--restricted` + `--setting-sources` + `--strict-mcp-config` and prove CLAUDE.md exclusion by CR3), or stop B2b. **Never drop it silently** |
| P3 | P-A with `--settings <job settings.json>` that holds a `permissions.deny` on `Read(**/.env*)`: a scripted `Read .env` returns a denial to the mock | denied | **STOP (S3):** `--safe-mode` drops `--settings`. Same question as S2 |
| P4 | P-A: the mock's system prompt contains the canary from the skills file (`--append-system-prompt-file`) and the stdin preamble canary; it lacks the fake home's CLAUDE.md canary and the worktree's `CLAUDE.md`/`.claude/*` canaries | as stated | A home or worktree canary present → **STOP (S4)** (isolation broken). Skills canary missing → pre-decided: stdin preamble |
| P5 | P-A: `--tools Read,Edit,Write,Glob,Grep --allowedTools Read Edit Write Glob Grep mcp__nexus__<each> --disallowedTools Bash PowerShell WebFetch WebSearch NotebookEdit Agent --permission-mode dontAsk --permission-prompts none`. A scripted Edit inside cwd succeeds, an MCP call succeeds, and Bash and WebFetch are absent from the tool list. Record the exact built-in tool names from the `system/init` event | as stated | Edit or MCP denied, or Bash offered → **STOP (S5)** with the observed behaviour. Tool names differ → pre-decided: pin the observed names |
| P6 | P-A: the MCP config uses the header `Authorization: Bearer ${NEXUS_MCP_TOKEN}`. The recorder sees the env value, and the argv holds no token | expanded | Pre-decided, no stop: write the header value into the per-turn `mcp.json` under the job dir (deleted at turn end, never logged). Record which form was used |
| P7 | P-B (no `ANTHROPIC_BASE_URL`, fake key, `HTTPS_PROXY` = the recorder, `NO_PROXY=127.0.0.1`, the adapter's env allow-list): the recorder sees `CONNECT api.anthropic.com:443` and nothing else within 30 s; the MCP recorder is still reached directly | as stated | No CONNECT, and the CLI reports a network or auth error → it bypassed the proxy → **STOP (S6)**. Any other host in a CONNECT, such as telemetry or update hosts despite the `DISABLE_*` env → **STOP (S7): ask the user about that host.** No model call happens in either case: every CONNECT is refused |
| P8 | P-A: argv length with a 200 KiB context on stdin is < 8 KiB, and the full context reaches the mock (F2) | as stated | Fail → **STOP (S8)** |
| P9 | P-C (controller only): `auth status` under `agentEnv` with a deny-all proxy. The adapter parses it to `signedIn: 'yes'\|'no'\|'unknown'`; nothing else is kept, printed or stored | yes or unknown | `no` → the user signs in, then re-run. `unknown` (it needs the network) → pre-decided: the setup row reads "Not checked yet", and V3 decides |
| P10 | P-A: writes to the fake home after one turn (a file list with mtimes) | list recorded | Informational: it pins CR10's allow-list |

**Steps:**
- [ ] Build the harness and the probe. A plain-node self-test of the mock model, the recorders and the fake home is `test/nexus-core-agent-harness.test.cjs` (HN1–HN4: the mock serves a scripted turn; the recorder refuses and records; the fake home holds every canary; no real home path appears in `env`).
- [ ] Run `node tools/nexus-agent-probe.cjs --parts A,B` and write the report.
- [ ] The controller runs `--parts C` after the user's go-ahead.
- [ ] **If any STOP branch fired: report it to the user and stop the phase.** Otherwise, record the pre-decided branches in the report. Tasks 6 and 13 read the report's `decisions`.
- [ ] Commit the probe, the harness and the self-test. The report files are committed too: they are evidence.

**Risks:**
- P-B lets the CLI attempt `api.anthropic.com` once, through the refusing recorder. This is the user-approved host, and no request leaves the machine.
- The probe pins today's binary. CR8 re-checks it at every `test:runtime` run.

**Commit:** `test(nexus): B2b Task 0 — agent CLI feasibility probe (flags, safe-mode with MCP and settings, prompt delivery, tool allow-list, proxy honour) without any model call`

---

### Task 1: Shared contracts, recipes, registry and skills

**Files:**
- Create: `src/shared/nexus/{tokens,mcpTools,agentPolicy,changeSet}.ts`, `resources/skills/nexus-sde-{change,tests-first,requirement-draft,app-manifest}/SKILL.md`, `test/nexus-core-agent-contracts.test.cjs`
- Modify: `src/shared/nexus/{runtime,execution,runnerProtocol,recipes,capabilities,validators,evidence,actions,domainSpec,ipc,registryCheck,secretShape}.ts`, `domains/sde.ts`, `test/nexus-core-vendor-neutral.test.cjs` (scan widened as in Global Constraints; the named edit)

**Interfaces (produced):**

- **The agent plan.**
  ```ts
  AgentPlan = PlanBase & {
    kind: 'agent';
    container: ContainerSpec;
    worktree: { hostPath; gitDir; ref; base; editable: string[] };
    runtime: { kind: RuntimeKind; request: RunRequest; token: string };
    egress: { allow: { host: string; port: number }[] };
    caps: { turnTokens; turnUsdCents; dayRemainingUsdCents; toolCalls };
    resourceLabels: ResourceLabels;
  }
  ```
  - `token` travels only over the MessagePort.
  - `AttemptPlan` also includes `AgentPlan`.
- **`EngineTask` (writes, run as system child jobs):**
  - `{ engine: 'repo.worktree'; repoPath; worktreePath; ref; integrationRef; branch }` initialises `integrationRef` at the branch HEAD when absent (CAS on absence), creates `ref` at the integration head, then runs `worktree add --detach` and `worktree lock`.
  - `{ engine: 'changeset.collect'; repoPath; worktreePath; gitDir; ref; integrationRef; scope: string[]; message: string; maxFileBytes; maxTotalBytes }`
  - `{ engine: 'changeset.merge_check'; repoPath; integrationRef; head }`
  - `{ engine: 'changeset.accept'; repoPath; integrationRef; expectedOld; head; message }`. Before `update-ref`, it reports a durable `accept.prepared { old, new }` progress event.
  - `{ engine: 'changeset.accept_rollback'; repoPath; integrationRef; from; to }`
  - `{ engine: 'repo.ff'; repoPath; branch; sha }`
- **`GitReadTask` (reads, no job row):**
  - `{ read: 'status'; repoPath; branch; integrationRef }`
  - `{ read: 'diff'; repoPath; base; head; maxBytesPerSide: 1_048_576 }`
- **Protocol `MainToRunner` additions:**
  - `{ op: 'mcp.reply'; callId; result: { ok: true; value: unknown } | { ok: false; code; message } }`. For `sandbox_exec`, the `value` is `{ grant: { execId; argv: string[]; cwd: string; timeoutMs } }`.
  - `{ op: 'git.read'; reqId; task: GitReadTask }`
  - `{ op: 'agent.shutdownTrees' }`
- **Protocol `RunnerToMain` additions:**
  - `ready { bootId; mcpUrl: string }`
  - `{ op: 'mcp.call'; callId; bearer: string /* ≤ 128 B, TOKEN_RE */; tool; args: unknown /* bounded deep copy: depth ≤ 8, keys ≤ 64, ≤ 64 KiB */ }`
  - `{ op: 'agent.exec.done'; attemptId; execId; exit: ExitInfo; stdoutBytes; stderrBytes; stdoutSha256; truncated }`. It carries no output text; the runner returns the text to the CLI only.
  - `{ op: 'attempt.runtime'; attemptId; seq; event: RuntimeEvent }`, where `message.delta.text` is ≤ 4 KiB and longer text is chunked.
  - `{ op: 'git.read.result'; reqId; result }`
  - `probe.result.runtimes[i].setup?: { signedIn: 'yes'|'no'|'unknown'; flagsOk: boolean; label: string; egressHosts }`
- **`AgentUsage`:** `{ inputTokens; outputTokens; cacheCreationTokens; cacheReadTokens; costUsdCents: number | null; toolCalls; estimated: boolean }`.
  - Capped tokens = input + output + cache creation. Cache reads are reported but not capped (F10).
  - The `usage` RuntimeEvent carries these fields, and the event is monotonic per turn.
- **Tokens:** `CapabilityClaims = { jti; sub: \`agent:${string}\`; onBehalfOf: 'user:local'; projectId; workspaceId; participationId; jobId; sessionId; caps; inputs: string[]; mcpTools: string[]; maxChildJobs; iat; exp }`. The raw token is opaque: `<jti 22 b64url>.<mac 43 b64url>`.
- **MCP tools.** `MCP_TOOLS` names use underscores, because model tool names allow `[a-zA-Z0-9_-]` only:
  - `context_get`, `artifact_list`, `artifact_read`, `validations_get`, `job_status`, `job_logs`;
  - `sandbox_exec`, `job_request`, `changeset_register`, `requirement_draft`, `review_request`.

  `McpToolDef = { name; capability; args: ParamsSchema; mutates; resultMaxBytes }`.
- **Agent policy.**
  - `AGENT_DEFAULTS` holds the D-B4 values.
  - `clampCaps(requested, defaults)` returns each value at most equal to the default (grants may only lower caps).
  - `budgetDecision(...)` behaves as in Revision 0 and adds the day-remaining calculation.
- **Change-set rules.**
  - `pathInScope`.
  - `SENSITIVE_PATH_RE` covers, case-insensitively at any depth:
    - `.git` (also `GIT~1`, a trailing dot, `::$DATA`);
    - `.env*`, `*.pem`, `id_rsa*`, `*.key`, `.npmrc`, `.pypirc`.
  - `isLockfilePath`.
  - `secretShape.ts` adds `diffLineSecret(line) = hasProviderKey(line) || PRIVATE_KEY_HEADER.test(line)`. The entropy rule stays in `looksSecret`.
- **Recipes.** These are the six engine recipes (`executor: 'engine'`, `subPhase: 'B2b'`):

  | Recipe | Idempotent | Wall clock | Recovery |
  |---|---|---|---|
  | `repo.worktree` | yes ×2 | 60 s | requeue |
  | `changeset.collect` | no | 120 s | interrupted |
  | `changeset.merge_check` | yes ×2 | 60 s | requeue |
  | `changeset.accept` | no | 120 s | interrupted, then the reconcile rule in Task 9 |
  | `changeset.accept_rollback` | yes ×3 | 60 s | requeue |
  | `repo.ff` | no | 60 s | interrupted |

- **Validators.** Defined with a `vB2b` helper (`subPhase: 'B2b'`), all on `change_set`:

  | Validator | Stage | Runs in | Blocking |
  |---|---|---|---|
  | `git.diff_nonempty` | register | main | yes |
  | `git.paths_in_scope` | register | main | yes |
  | `sec.secret_scan` | register | main | yes |
  | `sec.entropy_notes` | register | main | **advisory** |
  | `cs.tests_pass` | candidate | child-job | yes |
  | `git.applies_cleanly` | candidate | child-job (`changeset.merge_check`) | yes |

- **The SDE spec.**
  - `CURRENT_SUB_PHASE` is `'B2b'`.
  - Steps 5, 7 and 12 become REAL with their e2e ids. Step 1's `via` gains the skill.
  - `SKILLS` holds four entries.
- **`ipc.ts` views.** `SessionView`, `SessionDetailView`, `ReviewView`, `ChangeSetAcceptView`, `RepoStatusView`, `MergeView` and `AgentSetupView`. No view contains a host, a model id, a token or a path.

**Tests (`test/nexus-core-agent-contracts.test.cjs`, plain node):**
- **SC1:** every **RunnerToMain** addition round-trips through `parseRunnerMessage`. These malformed cases answer `null`:
  - a bearer that is oversize or not `TOKEN_RE`;
  - args with depth 9 or 65 keys;
  - a `message.delta` over 4 KiB;
  - an `agent.exec.done` carrying output text;
  - extra keys;
  - a negative seq;
  - a `ready` without `mcpUrl`;
  - an `mcpUrl` that is not `http://127.0.0.1:<port>/mcp`.
- **SC1b:** the MainToRunner shapes are type-checked. A grant always has an argv array.
- **SC2:** every tool name matches `/^[a-z_]{3,48}$/` and its capability is in the SDE ceiling. No tool name contains promote, accept, merge, approve, sign, handoff or secret.
- **SC3:** `budgetDecision` boundaries; `clampCaps` never raises a value.
- **SC4:** `pathInScope` and `SENSITIVE_PATH_RE`. Covers `.git/config`, `.GIT/config`, `GIT~1/config`, `.git./x`, `a/.git/config`, `x::$DATA`, `../x`, `C:/x`, `.env.local` and `certs/a.PEM`.
- **SC5:** the registry passes. The other five domains are unchanged (snapshot).
- **SC6:** the skills contain no persona or engine name and are each ≤ 8 KiB.
- **SC7:** `diffLineSecret`. An AWS key line and a `-----BEGIN OPENSSH PRIVATE KEY-----` line hit. A `package-lock.json` `"integrity": "sha512-…"` line does not.
- **SC8:** the six recipes are engine recipes with the recovery class from the table above.
- The vendor-neutral tests V1–V4 pass on the widened scan.

**Steps:**
- [ ] Write SC1–SC8 and run them. They fail.
- [ ] Add the types, the parsers (reusing the validating copier), the recipes, the validators and the registry flip. `actionsFor` answers `unavailable: agents_unavailable` for B2b actions while `agentsAvailable` is false, and the honesty audit asserts this (HA-B2b).
- [ ] Run SC1–SC8, the vendor-neutral, domain-registry and honesty tests, `npm run test:focused` and `npm run typecheck`.
- [ ] Commit.

**Risks:**
- The registry e2e ids need Task 16's test titles. Until then `B2B_IMPL` reads a stub list, and a pin records the ordering.

**Commit:** `feat(nexus): B2b contracts — agent plan, MCP relay and exec-done ops, opaque token claims, MCP tool table, caps, change-set rules, git engine recipes, SDE agent steps and skills`

---

### Task 2: Schema v10 module (not wired)

**Files:** create `src/main/nexus/db/schemaV10.ts`, `v10Seed.ts`, `test/nexus-db-v10-schema.test.cjs`. Modify `test/nexus-core-append-only-writes.test.cjs` (derive from `V10_DDL`; named edit).

**Interfaces:** `V10_DDL`, `V10_EXPECTED`, `v10ShapeProblem(db, exact)`, `applyV10(db, ctx)`, `verifyV10(db, pre)`. Every table has a no-delete trigger.

- **`capability_tokens`**
  - Columns: `jti` PK; `job_id` NOT NULL; `session_id` NOT NULL; `principal_id`; `on_behalf_of`; `caps_json` (≤ 8 KiB); `inputs_json` (≤ 8 KiB); `tools_json` (≤ 2 KiB); `caps_sha256`; `issued_at`; `expires_at`; `revoked_at`; `revoke_reason` (one of `job_ended`, `session_cancelled`, `restart`, `runner_restart`, `budget`).
  - Triggers: the principal is `'agent:'‖session_id` and its kind is `agent`. Identity and claims are immutable. Revocation is set once.
  - **No token text and no MAC are stored.**
- **`reviews`** is as in Revision 0.
- **`change_set_accepts`**
  - Columns: `version_id` PK; `project_id`; `integration_ref` (GLOB `refs/nexus/accepted/*`); `ref_before`, `ref_after` and `merge_commit` (each 40 hex); `accept_job_id` → jobs; `accepted_by` (user); `accepted_at`.
  - Trigger: the version is `active`.
- **`repo_merges`**
  - Columns: `id`, `project_id`, `branch`, `before`, `after`, `sha_confirmed` (40 hex), `merged_by` (user), `merged_at`, `confirmed_via` (`= 'dialog'`), `ff_job_id`.
  - Append-only.
- **`runtime_consents`**
  - Columns: `runtime_kind`; `hosts_json` (≤ 1 KiB); `hosts_sha256`; `turn_usd_cents` (≤ 200); `day_usd_cents` (≤ 1000); `turns_per_hour` (≤ 6); `concurrent_turns` (= 1); `turn_tokens` (≤ 400000); `tool_calls` (≤ 200); `granted_by`; `granted_at`; `revoked_at`; `revoked_by`.
  - The D-B4 ceilings are CHECKs, so a grant can only lower them.
  - `ux_consent_live` allows one live consent.
- **`session_worktrees`**
  - Columns: `session_id` PK; `project_id`; `rel_path` (GLOB `wt/*`; the B2a path CHECK); `ref` (GLOB `refs/nexus/job/*`); `integration_ref`; `base_commit`; `locked` (0/1); `created_at`; `removed_at`.
  - One worktree per session. A new session after `interrupted` gets a new row that points at the same `rel_path` (`reused_from_session_id`).
- **Indexes:** as in Revision 0, plus `ix_accepts_job`.

**Tests (`test/nexus-db-v10-schema.test.cjs`, test:db):**
- **S10-1:** names and counts.
- **S10-2:** every refusal, including a consent above any ceiling and a `refs/heads/*` integration ref.
- **S10-3:** the append-only pin.
- **S10-4:** the `V7_DDL`, `V8_DDL` and `V9_DDL` sha256 values are unchanged.

**Steps:** write the tests, see them fail, implement, see them pass, run `npm run test:db`, commit.

**Commit:** `feat(nexus): schema v10 module — token claims (no token text), reviews, accepts with their job, merges with the confirmed sha, consents capped at the D-B4 values, session worktrees; not wired`

---

### Task 3: v10 migration step and every exact-version site

**Files:**
- Modify: `src/main/db.ts`, `tools/nexus-db-restore.cjs`, `src/main/index.ts` (the `persist.open` lines only: `holdV10`, `enableV10: process.env.NEXUS_ENABLE_V10 === '1' ? true : undefined`), `test/nexus-platform-composition.test.cjs`
- Create: `test/nexus-db-v10-migration.test.cjs`

**Interfaces:**
- `enableV10`, `holdV10`, `V10_ENABLED_BY_DEFAULT = false`, `V10_FAILURE_LIMIT = 3`, `lastMigrationV10`, `agentsAvailable`, `agentsUnavailableReason`.
- **Exact-version sites** (F8), each changed as stated:

| Site in `db.ts` | Today | Change |
|---|---|---|
| `platformAvailable` | `version <= V9` | `<= V10` |
| `handoffsAvailable` | `version === V8 \|\| version === V9` | `version >= V8 && version <= V10` |
| `executionAvailable` | `version === V9` | `version >= V9 && version <= V10` (the v9 shape check runs `exact: false` above v9) |
| the v9 step's reopen branch (`if (this.version === V9)`, about line 680) | v9 only | `>= V9`, shape-checking v9 non-exact at v10 |
| the v7, v8 and v9 reopen shape checks | `exact: true` | `exact: false` when `version` is above their own |
| `executionUnavailableReason`, `handoffsUnavailableReason` | v9-specific branches | aware of v10 |
| the newer-schema branch | `from > V9` | `from > V10` |

- The IPC getter is wired in Task 14, not here (F23).

**Tests:**
- **M10-1 to M10-16:** as in Revision 0. The downgrade case uses the B2a-close build at **`4aec76f6`** (`git show 4aec76f6:src/main/db.ts` into a temp folder).
- **M10-17:** at v10, `platformAvailable`, `handoffsAvailable`, `executionAvailable` and `agentsAvailable` are all true, and a reopen runs no step and logs no v9 line.
- **M10-18:** a v10 file with v10 not enabled leaves execution on and agents off (`not_enabled`).
- **PC-10:** the composition pins.
- Existing tests: the only named mechanical edits are where an assertion reads "newer than this build (v9)", which becomes `(v10)`. Each one is listed in the commit body.

**Steps:** write the tests, see them fail, implement, then run the full `npm run test:db`, then commit.

**Commit:** `feat(nexus): v10 migration step — opt-in, verified backup, hold cascade, failure marker; handoffs and execution stay on at v10`

---

### Task 4: Tokens, agent authorization, consent, budgets and the agent fixture helper

**Files:**
- Create: `src/main/nexus/agents/{tokenService,budgetService}.ts`, `test/helpers/agentFixtures.cjs`, `test/nexus-platform-agent-auth.test.cjs`
- Modify: `src/main/nexus/auth/{policy,authService}.ts`, `src/shared/nexus/platform.ts`, `src/main/nexus/platform.ts`

**Interfaces:**
- **`TokenService(db, { now, randomBytes })`.** The key is 32 bytes per instance, which means one per main boot. It is never exported or logged.
  - `mintTx(system, claims): string` runs **inside the caller's transaction** (Task 10's lease transaction). It inserts the claims row and returns `jti.mac`, where `mac` = HMAC-SHA256(key, jti) in base64url.
  - `verify(raw, now)` returns `{ ok: true; claims } | { ok: false; code: 'malformed'|'bad_signature'|'unknown'|'expired'|'revoked' }`. It checks `TOKEN_RE`, does a constant-time MAC compare, then loads the row (cached in memory per jti).
  - `revokeForJob(system, jobId, reason)`.
  - `revokeLiveAgentTokens(system, reason: 'restart' | 'runner_restart')`, called at platform startup and at every runner `ready` that carries a new runner boot (F9).
- **`AuthService.authorizeWithToken(claims, action, scope)`.** As in Revision 0. Every denial writes one `auth.denied` activity row that never contains the token.
- **New actions:**

  | Action | Who may perform it |
  |---|---|
  | `agent.start` | member |
  | `review.decide` | member, user only |
  | `changeset.accept` | member, user only |
  | `repo.merge` | owner |
  | `agent.consent` | owner |
  | `token.mint` | system only |

- **`principals`.** The row `agent:<sessionId>` is created in the session-open transaction.
- **`BudgetService`.**
  - `grant(user, { runtimeKind, hosts, caps })`. The hosts come from the runtime probe (`describe().egressHosts`), never from the renderer. The caps go through `clampCaps`.
  - `revoke`.
  - `usageToday()` sums `job_attempts.usage_json` for `agent.run` attempts since local midnight. An attempt with `costUsdCents: null` counts as `turnUsdCents`, flagged `estimated`.
  - `startGuard(projectId)` returns one of `consent_missing`, `budget_exhausted`, `rate_limited` or `busy`.
  - `dayRemainingCents()`.
- **`agentFixtures.openRunningTurn(db, services, { project, repoPath? }) → { session, job, claims, token }`.** It goes through the real services: session open, principal, an `agent.run` job leased by the real lease path with a fake runner, and the token minted. Tasks 4–9 use it before Task 10 exists (F21).

**Tests:**
- **TK1–TK10:** as in Revision 0.
- **TK11:** a runner `ready` with a new boot revokes live agent tokens (`runner_restart`). The next call answers `revoked`.
- **TK12:** a malformed `mcp.call` dropped by `parseRunnerMessage` logs no bearer. This is a source pin plus a runtime check on `drop()` lines and the `scrub()` exemption.
- **AZ1** and **AZ2.**
- **BG1–BG5:** as in Revision 0.
- **BG6:** a grant whose caps are above D-B4 is clamped, and a raw insert is refused by the CHECK.
- **BG7:** a cancelled turn with no cost counts at the turn cap as `estimated`.
- **BG8:** `dayRemainingCents` = day cap − today's usage, never below 0.

**Steps:** write the tests, see them fail, implement, see them pass, run `npm run test:db`, commit.

**Commit:** `feat(nexus): opaque capability tokens minted in the lease transaction and revoked on restart, token-only agent authorization, runtime consent within the D-B4 ceilings, spend/rate guards and the agent test fixture`

---

### Task 5: MCP gateway, context resolver and skills (main)

**Files:**
- Create: `src/main/nexus/agents/{mcpGateway,contextResolver,skills}.ts`, `test/nexus-platform-agent-mcp.test.cjs`
- Modify: `src/main/nexus/exec/executionService.ts` (route `mcp.call`, send `mcp.reply`, accept `agent.exec.done`), `src/main/nexus/platform.ts`

**Interfaces:**
- **`McpGateway.call(raw)`** runs in order:
  1. Verify the token.
  2. Check that the tool is in the claims.
  3. `parseToolArgs`.
  4. `authorizeWithToken`.
  5. Count the call against the per-turn cap: these are MCP calls; stream tool calls are counted in Task 10.
  6. Run one service call.
  7. Write one `mcp.call` activity row (`argsSummary` ≤ 200 characters, redacted).
  8. Write one `attempt.progress` event `{t:'tool'}`.
- **`sandbox_exec`.** Main authorizes the call and records a pending exec `{ execId, argvSha256, argvCount, cwd }` in an `attempt.progress` event. It replies `{ grant: { execId, argv, cwd, timeoutMs ≤ remaining } }`. On `agent.exec.done`, main records the exit, the byte counts and the `stdoutSha256`. An `agent.exec.done` for an unknown `execId` is dropped with one log line (F1).
- **Other tools.**
  - `job_request` is limited to `sde.deps.node`, `sde.deps.python` and `sde.test.discover`. Installs go through B2a's A1.
  - `requirement_draft` creates an inline draft; `req.schema` checks it, then the system finalizes it.
  - `review_request` writes an event and sets the Needs-you flag.
  - `changeset_register` belongs to Task 8.
- **`ContextResolver.resolve(job)`** writes **`<dataHome>/jobs/<jobId>/agent/context.md`**. Main is the single writer of this file (F23).
  - Contents: the domain and step, the vocabulary, the focus versions, up to 20 prior user messages, `request_changes` comments, and the diagnostic facts.
  - Every field is secret-checked. A field that hits is dropped and recorded as `context_redacted`.
  - It returns `{ path, sha256, bytes }`. The hash goes into `jobs.context_hash`.
- **`Skills.write(job, ids)`** writes `skills.md` to the same folder and returns `{ id, version, sha256 }[]`.

**Tests (test:db, using `agentFixtures` and a fake runner):**
- **MG1–MG12:** as in Revision 0, with the tool names updated.
- **MG5:** `sandbox_exec` for another job's attempt is denied.
- **MG13:** a grant is issued once per `callId`, and an `agent.exec.done` with a forged `execId` is dropped.
- **MG14:** the context file holds a 200 KiB history intact and contains no secret.

**Steps:** write the tests, see them fail, implement, see them pass, run `npm run test:db`, commit.

**Commit:** `feat(nexus): MCP gateway in main (token, tool, scope, caps, audit), exec grants without output relay, a main-written context file and skill bundle`

---

### Task 6: Loopback MCP server and the runner relay

**Files:**
- Create: `src/runner/mcpServer.ts`, `test/nexus-core-mcp-server.test.cjs`
- Modify: `src/runner/core.ts` (start the server at `hello`, report `mcpUrl` in `ready`, relay `mcp.call`/`mcp.reply`, run granted execs via `driver.exec` and return the redacted, capped output to the caller), `src/runner/logs.ts` (`scrub` exempts `bearer`; `mcp.call` is never logged)

**Interfaces:**
- `McpServer({ onCall, onExecGrant })` returns `{ url; close }`.
  - It accepts only `POST /mcp`, with `Host = 127.0.0.1:<port>`, no `Origin`, `Content-Type: application/json`, and `Accept` containing `application/json`. The body is ≤ 1 MiB.
  - It speaks JSON-RPC `initialize` (protocol version negotiated from the client's `MCP-Protocol-Version`; the Task 0 recording pins the value) and `notifications/*`, which return `202` with no body. It also handles `tools/list` and `tools/call`.
  - It assigns `Mcp-Session-Id` per turn.
  - Error bodies never echo headers.
- **`sandbox_exec` flow (F1):**
  1. `tools/call` arrives.
  2. The server sends `mcp.call` to main.
  3. Main replies with a grant.
  4. The runner runs `driver.exec(containerId of the attempt, grant.argv, { timeoutMs, maxOutputBytes: 64 KiB })`.
  5. The output is redacted and returned to the CLI as the tool result.
  6. The runner sends `agent.exec.done` to main.

  A grant that names another attempt's container is refused by the runner, as defence in depth.

**Tests (plain node, fake main and fake driver):**
- **MS1–MS6:** as in Revision 0.
- **MS7:** `Accept` lacking `application/json` → 406.
- **MS8:** a notification → 202.
- **MS9:** `initialize` negotiates the pinned protocol version.
- **MS10:** an error never echoes `Authorization`.
- **MS11:** the full exec flow. The CLI-side result has the redacted output, and main sees only counts and the sha.
- **MS12:** after `close()`, the port refuses connections.

**Steps:** write the tests, see them fail, implement, then run `npm run test:focused` and the runner posture test, then commit.

**Commit:** `feat(nexus): loopback Streamable-HTTP MCP server in the runner that decides nothing, and the sandbox exec relay (output to the agent, counts and hashes to main)`

---

### Task 7: Repository writes — A3, worktrees and git engine jobs

**Files:**
- Create: `src/main/nexus/repo/{worktreeService,gitRead}.ts`, `src/runner/{gitWrite,gitRead,worktreeGuard}.ts`, `test/nexus-platform-agent-repo.test.cjs`, `test/nexus-core-gitwrite.test.cjs`
- Modify: `src/main/nexus/exec/{planBuilder,ingest,recovery}.ts` (engine plans for the six recipes; `NOT_INGESTED` entries with reasons), `src/runner/core.ts` (dispatch the engine tasks and `git.read`), `src/main/nexusExec/dataHome.ts` (`wt/`, `jobs/`)

**Interfaces:**
- **`WorktreeService.ensure(system, session, turnJob)`** returns one of:
  - `{ ready: { path, gitDir, ref, base } }`
  - `{ waiting: 'approval'; approvalId }`
  - `{ waiting: 'job'; jobId }`
  - `{ failed }`

  It behaves as follows:
  1. **A3.** If there is no consumed `repo.write_refs` approval for the project, it creates a pending one. The request text lists exactly what will be written:
     - `refs/nexus/job/*` and `refs/nexus/accepted/<branch>`;
     - `.git/worktrees/<name>`;
     - **new objects in `.git/objects`**;
     - a locked worktree under the Nexus data folder;
     - and it states "never your branch, index or files".
  2. It then enqueues the system child job `repo.worktree`.
  3. Paths: `wt/<sessionId lowercased>` and `refs/nexus/job/<sessionId lowercased>`. There is one worktree per session (F23).
- **`GitRead.request(task, timeoutMs = 10_000)`** returns the read result. Status and diff go over `git.read` and write no job rows.
- **`gitWrite.ts`.** Every call goes through `runGit` and `gitPrefix`, plus:
  - `-c core.hooksPath=<empty> -c core.fsmonitor=false -c commit.gpgsign=false -c tag.gpgsign=false -c core.symlinks=false -c core.longpaths=true`
  - `-c gc.auto=0 -c maintenance.auto=false -c submodule.recurse=false -c protocol.file.allow=never`
  - the B2a filter-driver neutralisation and `GIT_LFS_SKIP_SMUDGE=1`
  - `--ignore-submodules=all` where it applies

  For worktree commands it passes an explicit `--git-dir` and `--work-tree`, after checking the worktree's `.git` file. A mismatch fails with `worktree_tampered`. Worktrees are created with `worktree add --detach` and then `worktree lock --reason "Nexus session"`.
- **`worktreeGuard.walk(path, { maxTotalBytes: 8 GiB, maxFileBytes: 50 MiB })`** walks with `lstat` and never follows links. It refuses with one of:
  - `symlink_in_worktree` (a symlink, junction or reparse point);
  - `nested_repo` (a `.git` at any depth other than the root `.git` file);
  - `worktree_too_large`;
  - `file_too_large`.

  It runs after every exec (Task 11) and before collect (Task 8).

**Tests:**
- **RW1–RW9:** as in Revision 0, with refs under `refs/nexus/*`. RW3 also asserts `git branch --list` is unchanged, which means no new user-visible branch.
- **RW10:** a nested repository whose config holds an fsmonitor canary, planted in the worktree. Collect refuses it with `nested_repo`, and the canary never runs.
- **RW11:** a link planted by the container (a relative NT symlink) and a junction are refused, and the target is never read.
- **RW12:** `git worktree list --porcelain` shows the worktree locked.
- **RW13:** blob GC (`gc.scan`) never lists anything under `wt/` or `jobs/`.
- **RW14:** a `repo.worktree` job interrupted by a restart is requeued, idempotently.

**Steps:** write the tests, see them fail, implement, then run `npm run test:db`, `node --test test/nexus-core-gitwrite.test.cjs` and the posture test, then commit.

**Risks:**
- This is Nexus's first write into the user's `.git`. It happens only after A3, only under `refs/nexus/*`, `.git/worktrees/*` and objects, and all of these are named in A3.
- Removing a worktree is a later cleanup (known limitation).

**Commit:** `feat(nexus): repository write approval (A3), locked session worktrees and refs under refs/nexus, git writes as system engine jobs, bounded git reads, and a worktree guard against links, nested repositories and size`

---

### Task 8: Change sets — register, validators and lineage

**Files:**
- Create: `src/main/nexus/repo/changeSetService.ts`, `src/main/nexus/validation/validators/{diffNonempty,pathsInScope,secretScan,secretEntropyNotes,csTestsPass,appliesCleanly}.ts`, `test/nexus-platform-agent-changesets.test.cjs`
- Modify: `src/main/nexus/validation/{checkRunner,validationService}.ts`, `src/main/nexus/exec/ingest.ts`, `mcpGateway.ts` (wire `changeset_register`), `src/runner/gitWrite.ts` (collect)

**Interfaces:**
- **`ChangeSetService.register(claims, { title ≤ 200; summary ≤ 4000; requirementVersionIds ≤ 5; reviseArtifactId?; clientKey })`.** It enqueues the system child job `changeset.collect` (parent: the turn).
  - The MCP call waits up to **120 s** for ingest. Past that it returns `{ pending: jobId }`, and the agent can poll `job_status`.
- **`changeset.collect` in the runner**, in order:
  1. `worktreeGuard.walk`.
  2. `git add -A -- <scope>`.
  3. Refuse index entries with mode `120000` or `160000` (`link_or_gitlink`).
  4. `git commit` with identity `Nexus agent <agent@nexus.invalid>` and the trailer `Nexus-Job: <turn job id>`.
  5. `update-ref <ref> HEAD`.
  6. Compute `base = git merge-base <integrationRef> HEAD` (F29), the diffstat, the paths (≤ 5000), and `secretHits` (from `diffLineSecret` over added lines) as `{ path, line }`. Also compute `entropyHits` (`looksSecret` over added lines of non-lockfile paths) as `{ path, line }`.
- **Ingest, in one transaction:**
  - a draft `change_set` with `storage_ref_json {base, head, ref}` and `content_hash 'git:'+tree`;
  - lineage edges `derived_from` the repository version, `implements` each requirement, and `derived_from` the previous change set;
  - the register validators, run inline.
- **Validators:**
  - `sec.secret_scan` fails on any `secretHits`.
  - `sec.entropy_notes` is advisory: it lists entropy hits for the reviewer and never gates (F15; see Revision 1).
  - `cs.tests_pass` behaves as in Revision 0.
  - `git.applies_cleanly` runs as the child job `changeset.merge_check`.
- **Finalize rule (F23).**
  - A blocking `failed` result makes the version `failed`. A `failed` change set never becomes a candidate again; the agent revises it as v2.
  - At accept, a merge conflict does not touch the version. Accept answers `merge_conflict` and writes an **advisory** `git.applies_cleanly` row. A version that is no longer a draft only gets advisory rows (B2a §38.2).

**Tests:**
- **CS1–CS3:** as in Revision 0.
- **CS4:** an AWS key, and separately a PEM private key header, in an added line. The version fails. The evidence holds path:line only. The key appears nowhere in `validations`, `activity`, `job_events`, `job_attempts` or the logs.
- **CS5–CS10:** as in Revision 0.
- **CS11:** a 60 MiB file fails with `file_too_large`.
- **CS11b:** a change that only touches `package-lock.json` (sha512 integrity lines) passes `sec.secret_scan`, and `sec.entropy_notes` records nothing for lockfiles.
- **CS12:** a planted gitlink or symlink in the index fails with `link_or_gitlink`.
- **CS13:** register waits up to 120 s, then answers `pending` and the agent polls.
- **CS14:** v2's base is the merge-base with the integration ref. After v1 is accepted, v2's diff shows only the new work.

**Steps:** write the tests, see them fail, implement, see them pass, run `npm run test:db`, commit.

**Commit:** `feat(nexus): change sets — Nexus commits the agent's work in a guarded worktree, register validators (diff, scope, provider-key and private-key scan, advisory entropy notes), tests and clean-merge evidence, lineage`

---

### Task 9: Review, accept with rollback, and "Merge accepted work"

**Files:**
- Create: `src/main/nexus/review/reviewService.ts`, `src/main/nexus/repo/acceptService.ts`, `test/nexus-platform-agent-accept.test.cjs`
- Modify: `src/main/nexus/platform.ts`, `src/main/nexusExec/execWiring.ts` (the `confirmMerge` port), `src/main/nexus/exec/recovery.ts` (accept reconcile)

**Interfaces:**
- **`ReviewService(db, { turns: TurnStarter })`**, where `TurnStarter = { continueWith(user: Principal, sessionId, reviewId): { job } }` (F7).
  - `decide(user, versionId, { decision, comment?, intentId })` returns `{ review; job? }`.
  - `request_changes` calls `turns.continueWith` with the **reviewing user** (F32).
- **`AcceptService.accept(user, versionId, expectedIntegrationHead)`**, in order (F11):
  1. In one IMMEDIATE transaction:
     - check that the version is a candidate with an approving review and no newer review deciding against it;
     - insert the system child job `changeset.accept`, with params `{ versionId, expectedOld, head }`. The job row is the durable "accepting" marker.
  2. The engine runs `merge-tree --write-tree`, then `commit-tree` (identity `Nexus <agent@nexus.invalid>`, trailer `Nexus-Accepted-By: user:local`). It reports `accept.prepared { old, new }`, and only then runs `update-ref <ref> <new> <old>`.
  3. Ingest, in one transaction: promote the version (user CAS), insert the accept row, complete the job.
  4. **If step 3 fails** (a trigger, a concurrent reject, the version no longer a candidate), the same transaction enqueues `changeset.accept_rollback { from: new, to: old }`. The job then fails with `accept_rolled_back`.
  5. **Recovery.** An interrupted `changeset.accept` whose `accept.prepared` event exists and has no accept row is answered with `accept_rollback`. It is never retried.
  - The result is either `{ version; accept }` or one of `conflict ref_moved {current}`, `merge_conflict` or `illegal_transition`.
- **`status(user, projectId)`** uses `GitRead` and returns:
  - the branch, the integration head and `acceptedNotMerged`;
  - `userTreeClean`;
  - `integrationConsistent`, which is the **O25** check: the integration head equals the last accept's `ref_after`, or equals the initial head when no accept exists.
- **`mergeAccepted(user, projectId, { branch, expectedAcceptedHead }, confirm)`.** It refuses with `tree_dirty`, `branch_mismatch`, `not_fast_forward`, `integration_unexpected` (O25 fails) or `cancelled`. Otherwise:
  1. The dialog lists the commits.
  2. The system child job `repo.ff` runs `symbolic-ref HEAD` (re-checked right before), then `git merge --ff-only <expectedAcceptedHead sha>`.
  3. A `repo_merges` row is written with `sha_confirmed`.

  There is no `ref_checked_out` case: `refs/nexus/*` cannot be checked out as a branch (see Revision 1, F11).

**Tests:**
- **RA1–RA9:** as in Revision 0.
- **RA10:** `request_changes` calls the fake `TurnStarter` with the reviewing user and the review id. A missing comment answers `invalid`.
- **RA11:** a crash after `update-ref` and before ingest. The restart rolls the ref back to `old`, and "Merge" is never offered for that sha.
- **RA12:** a reject recorded between the job's start and ingest. The ingest refuses, the ref is rolled back, and the version is still a candidate (rejected).
- **RA13:** the integration ref moved by hand. Status reads `integrationConsistent: false`, and merge refuses with `integration_unexpected`.
- **RA14:** merge uses the confirmed sha. A ref moved after the dialog is not merged; the fast-forward runs to the confirmed sha or refuses.

**Steps:** write the tests, see them fail, implement, see them pass, run `npm run test:db`, commit.

**Commit:** `feat(nexus): user review decisions, accept by merge-tree and CAS with a durable marker and rollback, an integration-ref consistency check, and a dialog-confirmed fast-forward to the confirmed sha`

---

### Task 10: Agent turns in main — sessions, scheduling, plan, usage and recovery

**Files:**
- Create: `src/main/nexus/agents/agentService.ts`, `test/nexus-platform-agent-turns.test.cjs`
- Modify: `src/main/nexus/exec/{executionService,scheduler,planBuilder,recovery}.ts`, `src/main/nexus/sessions/sessionService.ts`, `src/main/nexus/platform.ts` (wire `TurnStarter` into `ReviewService`)

**Interfaces:**
- **`AgentService.start(user, { projectId, workspaceId, sessionId|null, skillId?, focusVersionIds ≤ 20, message ≤ 8000, intentId })`** returns `{ session; job }`.
  - It checks, in order: availability, runtime health from the cache, `startGuard`, and that only one turn runs per session.
  - It opens or reuses the session and creates an `agent.run` job.
- **Other methods:** `continueWith(user, sessionId, reviewId)` implements `TurnStarter`; `end`, `cancel`, `list` and `get` as in Revision 0.
- **Scheduler guards:** `waiting:runtime`, `waiting:consent`, `waiting:budget` and `waiting:rate`.
- **The lease transaction mints the token** (`tokenService.mintTx`), writes `context.md` and `skills.md` (Task 5), and builds the `AgentPlan` (F23):
  - the container runs `sleep <s>` with a worktree bind and network `none`;
  - `caps.dayRemainingUsdCents` is set.
- **`sandbox_json` projection** (F31): the profile, image, limits, network, mounts (destination plus `kind` only, **no host path**), the runtime kind, the adapter version, the flags sha256, the skills sha256 values, the context sha256 and the proxy allow-list. It never holds the token, the message, the config path or the worktree host path.
- **`environment_json`:** the runtime kind, CLI version, model id (opaque) and image.
- **Runtime events:**
  - `usage` updates `job_attempts.usage_json` monotonically.
  - If tokens exceed `turnTokens`, cost exceeds `turnUsdCents` or `dayRemaining`, or tool calls exceed `toolCalls`, the job is cancelled with `failed: limit` (F10).
  - On `run.completed`, if the turn registered at least one version, the job is `completed`. If it registered none, it is **`partial` with outcome `no_change`** (F27).
  - `run.failed{auth}` gives `failed: runtime_auth`, and the session becomes `failed`.
- **Recovery (phase A):** a live agent attempt is set to `abandoned`, its job and session to `interrupted`, and its token revoked (`restart`). The worktree is kept. The container is removed in phase B.

**Tests (test:db, fake runner):**
- **AT1–AT6:** as in Revision 0, main side. AT6 uses mid-turn `usage` events.
- **AT10–AT12:** as in Revision 0.
- **AT13:** `continueWith` from a review creates the turn job, with the user as `requested_by` and the review as a `job_inputs` row.
- **AT15:** `sandbox_json` and `environment_json` of an agent attempt contain no token, message, config path or worktree host path.
- **AT16:** the day cap is reached mid-turn and the job is cancelled with `limit`.
- **AT18:** a turn that registers nothing becomes `partial: no_change`, and the step is not done.

**Steps:** write the tests, see them fail, implement, see them pass, run `npm run test:db`, commit.

**Commit:** `feat(nexus): agent turns in main — sessions, runtime/consent/budget/rate guards, the token minted in the lease transaction, the agent plan and its redacted record, monotonic usage caps, no-change turns and restart recovery`

---

### Task 11: Agent turns in the runner — the turn attempt, ScriptedRuntime and process trees

**Files:**
- Create: `src/runner/{agentAttempt,procTree}.ts`, `src/runner/runtimes/{registry,scripted}.ts`, `test/helpers/scriptedFixtures.cjs`, `test/nexus-core-agent-runner.test.cjs`
- Modify: `src/shared/nexus/preflightCheck.ts` (a `worktree` rw bind is allowed for `nexus.kind = agent` containers only), `src/runner/core.ts`, `test/nexus-runner-posture.test.cjs` (**named edit:** `taskkill.exe` added to the spawn list)

**Interfaces:**
- **`agentAttempt.run(plan, port)`**, in order:
  1. Create, preflight and start the container.
  2. Start the host proxy (Task 12) for this turn.
  3. Write the adapter's engine-format files into `jobs/<id>/agent/`.
  4. Run `runtime.start(request)`.
  5. Relay events (`message.delta` chunked to ≤ 4 KiB).
  6. Run `worktreeGuard.walk` after every exec. A refusal cancels the turn with `failed: worktree_guard`.
  7. At the end: stop and remove the container, close the proxy, delete the config files except `context.md` (kept for the record), and report `attempt.exited`.
- **`ScriptedRuntime`** runs **in-process** in the runner. It replays a fixture of MCP calls through the real MCP server over HTTP and emits the same events.
- **Test CLI stand-in:** the registry injects `agentBin = process.execPath` with `ELECTRON_RUN_AS_NODE=1` and the script `test/fixtures/agent/fake-cli.cjs`. It goes through the **same** `spawn(agentBin` site (F6).
- **`procTree`** (F13):
  - `record({ jobId, pid, imageName, mainBootId, runnerPid })` writes a pidfile.
  - `killRecorded(currentMainBootId)` runs at runner `hello`. It kills only pidfiles from **the same main boot** (a runner crash), using `taskkill /PID <pid> /T /F /FI "IMAGENAME eq <name>"`. Pidfiles from other main boots are deleted, and their processes are not touched. Such orphans are inert, because their proxy port, MCP port and token are dead.
  - `shutdownTrees()` handles the app-quit `agent.shutdownTrees` op.

**Tests (plain node, real runner core, fake driver, the fake CLI):**
- **AT1r:** a ScriptedRuntime turn end to end through the real MCP server.
- **AT7:** cancel leaves no fake-CLI process; the pid is checked with `tasklist /FI "PID eq …"` through the resolved taskkill or tasklist path, in test code only.
- **AT8:** a runner crash in the same main boot leads to the next `hello` killing the tree. A pidfile from another main boot is not killed.
- **AT9:** a secret in `message.delta` and in exec output is redacted in the log frames, events and `attempt.runtime`.
- **AT14:** a symlink planted by an exec is caught by the walk and the turn fails with `worktree_guard`.
- **AT17:** `shutdown` kills live trees and leaves no process.
- **AT19:** a `message.delta` of 20 KiB arrives as 5 chunks, in order.

**Steps:** write the tests, see them fail, implement, then run `npm run test:focused` and the posture test (green with taskkill), then commit.

**Commit:** `feat(nexus): the agent turn in the runner — the network-none container with the guarded worktree, in-process ScriptedRuntime, same-boot process-tree cleanup and app-quit shutdown`

---

### Task 12: Host egress proxy for the agent process

**Files:**
- Create: `src/runner/hostEgressProxy.ts`, `test/nexus-core-host-egress.test.cjs`
- Modify: none in `infra/images` (F14)

**Interfaces:**
- `startHostEgressProxy({ allow, onDecision, lookup? })` returns `{ url: 'http://127.0.0.1:<port>'; close }`.
  - It `require`s `infra/images/sde-node/egress-proxy.js` and calls its exported `serve(allow, { log, lookup })`. It listens on `127.0.0.1:0`.
  - The image context is unchanged, so `contextSha256` and every B2a image pin hold.
  - Decisions arrive through the `log` hook. They are parsed from `decisionLine` into `egress` progress events (host, port, decision and reason; at most 200 per attempt).
- **The production allow-list** comes only from the adapter's `egressHosts`, compared with the live consent's `hosts_sha256`. A mismatch fails the turn with `failed: consent_mismatch`.
- **Deny-all mode** (an empty allow list) is used by `health()` probes before consent.

**Tests:**
- **HE1–HE5:** as in Revision 0, run against the real file through `startHostEgressProxy`.
- **HE6:** a source pin. Production code passes no test lookup or pinned entry; `lookup` is injected only from tests.
- **HE7:** `tools/nexus-lock-images.cjs --check` still passes, which means the image context is unchanged.
- **HE8:** binding is `127.0.0.1` only.
- **HE9:** a consent hash mismatch refuses the start.

**Steps:** write the tests, see them fail, implement, see them pass, run `npm run test:focused`, commit.

**Commit:** `feat(nexus): a loopback allow-list proxy for the agent process that runs B2a's own egress proxy code (no image change), bound to the live consent`

---

### Task 13: The CLI adapter and the `test:runtime` gate

**Files:**
- Create: `src/runner/runtimes/cliAgent/{adapter,args,env,stream,binary,files}.ts`, `tools/run-runtime-tests.cjs`, `test/runtime-cli-contract.test.cjs`, `test/runtime-scripted-contract.test.cjs`, `test/fixtures/agent/**`
- Modify: `package.json` (`"test:runtime": "node tools/run-runtime-tests.cjs"`), `src/runner/runtimes/registry.ts`, `test/nexus-runner-posture.test.cjs` (**named edit:** the CLI is added; the list is now four programs, plus a pin for the agent env builder)

**Interfaces** (every choice that Task 0 decided is read from `task0-probe-report.json` and pinned in CR1):
- **`binary.ts`:** `resolveAgentCli()` returns the native executable only.
- **`describe()`** returns:
  - `label` (the adapter's display name, shown only on the setup row);
  - `version`;
  - `egressHosts: [{ host: 'api.anthropic.com', port: 443 }]`, pinned by CR15;
  - `supportsHttpMcp: true`, `supportsResume: false`, `models: []`.
- **`health()`** runs `--version`, `--help` (flag check against `PINNED_FLAGS`) and `auth status`.
  - All three run under `agentEnv`, with the deny-all proxy before consent and the allow proxy after it.
  - The `auth status` output is parsed **inside the adapter** to `signedIn`. The raw output is never logged, stored or sent (F17).
- **`args.ts`:**
  ```
  -p --output-format stream-json --verbose --input-format text
  --restricted --safe-mode --strict-mcp-config
  --mcp-config <files>/mcp.json --settings <files>/settings.json --setting-sources <probe form>
  --tools Read,Edit,Write,Glob,Grep
  --allowedTools Read Edit Write Glob Grep <mcp__nexus__ + each claims tool>
  --disallowedTools <names observed in P5: Bash PowerShell WebFetch WebSearch NotebookEdit Agent>
  --permission-mode dontAsk --permission-prompts none
  --no-session-persistence --disable-slash-commands --no-chrome
  --max-budget-usd <min(turn, dayRemaining)/100>
  [--append-system-prompt-file <files>/skills.md when P1/P4 proved it]
  ```
  - **No `--model`** (F24): the CLI's default is used, and the model it reports is recorded opaquely.
  - The message, the context and (as a fallback) the skills go on **stdin** as one preamble (F2).
  - cwd is the worktree.
- **`files.ts`** writes `mcp.json` (the `${NEXUS_MCP_TOKEN}` header, or the literal form decided in P6) and `settings.json`:
  - `permissions.deny` for Read and Edit on `SENSITIVE_PATH_RE` patterns (F16);
  - `disableAllHooks: true`;
  - no `env`.
- **`env.ts`:** `agentEnv(base, { proxyUrl, token })`.
  - Allow-list as in Revision 0, **with `HTTPS_PROXY` = the proxy, no `HTTP_PROXY`, and `NO_PROXY=127.0.0.1`** (F4).
  - Adds `NEXUS_MCP_TOKEN` and the four `DISABLE_*` names.
  - Drops inherited `ANTHROPIC_*`, `CLAUDE_*`, `*_API_KEY`, `*_TOKEN` and `NODE_EXTRA_CA_CERTS`.
  - No `CLAUDE_CONFIG_DIR`.
- **Test seam (F3):** `createCliAdapterForTests({ envOverlay })` is the only way to add `ANTHROPIC_BASE_URL` (a loopback mock) and a fake `ANTHROPIC_API_KEY`. Source pin **CR0:** no production file references `ForTests` or those two names outside `cliAgent/testSeam.ts`.
- **`stream.ts`:**
  - Each assistant message's `usage` becomes a monotonic `usage` event.
  - Each `tool_use` increments `toolCalls`.
  - `result` gives the final cost (cents), then `run.completed` or `run.failed`.
  - `runRef` is a Nexus id.
  - Lines over 1 MiB fail with `protocol`.

**Tests** (`npm run test:runtime`; harness from Task 0; fake home; mock model; never the user's home or the network):
- If the CLI is missing, the gate reports **NOT RUN, exit 3**.
- **CR0:** the test-seam pin.
- **CR1:** argv equals the pinned list (with Task 0's decisions). The message, context and token are absent, and argv is under 8 KiB.
- **CR2:** a scripted turn. Bash and WebFetch are unavailable. **One Edit inside the worktree succeeds**, `context_get` reaches the server, and `changeset_register` reaches the fake main.
- **CR3:** canaries planted in the **fake home** (a settings hook, an MCP server, a plugin, `CLAUDE.md`) and in the **worktree** (`.claude/settings.json`, `.mcp.json`, `CLAUDE.md`, `.claude/agents`, `.claude/skills`). None runs and none reaches the mock's prompt.
- **CR4:** the token appears in no frame, log, context file, request body to the mock, `job_attempts` projection or view.
- **CR5:** env equals the allow-list plus exactly the two test-seam names.
- **CR6:** `../outside.txt`, an absolute path, a planted symlink and a junction are each denied or not followed.
- **CR7:** cancel delivers `run.cancelled` within the grace period plus 10 s, and no process remains.
- **CR8:** an unknown version or a missing pinned flag gives `version_unsupported`, and no turn starts.
- **CR9:** a runner kill in the same boot leads to `killRecorded` ending the CLI.
- **CR10:** the writes to the fake home equal the allow-list recorded in Task 0's P10. Its limit is stated: it measures a fake home, and V3 measures the real one.
- **CR11:** a 200 KiB context reaches the mock intact on stdin.
- **CR12:** a scripted `Read .env` and `Read certs/a.pem` are denied.
- **CR13:** the `auth status` output (a fixture containing an email) never appears in a log, event, probe message or view. Only `signedIn` leaves the adapter.
- **CR14:** mock usage mid-turn above the token cap makes Nexus cancel. A mock `result` without cost is charged as estimated.
- **CR15:** `describe().egressHosts` equals exactly `api.anthropic.com:443`.
- **SR1–SR3:** the ScriptedRuntime contract.

**Steps:**
- [ ] Write the tests and run `npm run test:runtime`. It fails.
- [ ] Implement the adapter.
- [ ] Run `npm run test:runtime`. It passes on 2.1.295 with the harness only.
- [ ] Run `npm run test:focused` and the posture test.
- [ ] Commit.

**Risks:**
- Flag drift (CR8).
- The proxy routes and records but does not enforce at the OS level.
- Admin-managed (policy) settings still apply under `--restricted` and `--safe-mode`. The docs say so.

**Commit:** `feat(nexus): the CLI agent adapter behind AgentRuntime (restricted tools with explicit allow rules, strict MCP, no user or project config, sensitive files unreadable, context on stdin, proxy-only network) and the test:runtime contract gate on a fake home`

---

### Task 14: IPC channels #42–#51, the diff preview part, preload and views

**Files:**
- Modify: `src/main/nexusIpc/{registerNexusIpc,validate,dto}.ts`, `src/preload/index.ts`, `src/main/index.ts` (IPC deps `agents`, `agentsUnavailableReason`, `confirmMerge`), `test/nexus-caller-paths.test.cjs` (extended)
- Create: `test/nexus-platform-ipc-agents.test.cjs`

**Interfaces:**
- The channel table is as in Revision 0, #42–#51. `nexus:agent:consent` `grant` carries caps only; hosts come from the probe, and caps are clamped.
- **#23 health** gains `agent: AgentSetupView`: the state, `label` (the setup row only), version, `signedIn`, consent `{ live, caps, hostsCount }`, and `usageToday { usdCents, turns, estimated }`. **Hosts appear only in the setup sheet's consent row** (F24).
- **#34 `nexus:version:preview`** gains `part: 'diff'` for `change_set` versions (F19). It runs `GitRead { read:'diff', base, head }` using the recorded base and head only, capped at 1 MiB per side and redacted. A larger diff answers with a `too_large` sentence.

**Tests:**
- **IA1–IA12:** as in Revision 0.
- **IA13:** the diff part works for a change set and is refused for other kinds. An oversized diff gives `too_large`.
- **IA14:** the diff preview of a change set with a secret line shows it redacted.
- **IA15:** a #51 grant with caps above D-B4 is clamped.

**Steps:** write the tests, see them fail, implement, see them pass, run `npm run test:db`, commit.

**Commit:** `feat(nexus): agent IPC — channels #42-#51 and a bounded change-set diff preview through the one wrapper, ids only from the renderer`

---

### Task 15: Renderer — agent panel, change-set review, setup rows, intent line

**Files:** as in Revision 0. **UA10 is removed** (F20). Uses the Task 14 channels through new `nexusClient.ts` methods, created in this task (F23).

**Interfaces:**
- The pure models are as in Revision 0.
- The agent-panel sentence for a missing consent reads: **"Agent turns need your network permission. Open Setup to grant it."** No host is named outside the setup sheet (F24).
- Usage reads "reported by the agent runtime", or "estimated" when `estimated` is set.

**Tests:**
- **UA1–UA9:** as in Revision 0.
- **UA11:** no host or model string appears in `agent/**` or in the change-set views, except the setup row's view-supplied label and host list.
- **UA12:** a `partial: no_change` turn reads "The agent made no change", never done.

**Steps:** write the tests, see them fail, implement, then run `npm run test:focused`, `npm run typecheck` and `npm run build`, then commit.

**Commit:** `feat(nexus): agent panel, change-set review, accept and merge in the Changes tool, agent setup rows and the project-bound intent line, inside Spine + Folio`

---

### Task 16: End-to-end flows and the real-Docker agent suite

**Files:**
- Create: `test/nexus-platform-b2b-flows-node.test.cjs`, `test/nexus-platform-b2b-flows-python.test.cjs` (split to respect the 180 s file timeout), `test/nexus-exec-agent.test.cjs`
- Modify: `src/main/nexus/registryImpl.ts` (`B2B_IMPL` e2e titles)

**Tests:**
- **E2E-B2b-1** (one per fixture): as in Revision 0, including the iteration and merge. It also asserts:
  - O1–O25 = 0, where O25 is the integration-ref consistency check;
  - `isExecutableEndToEnd(SDE,'B2b')` is true, and false for the other five domains.
- **E2E-B2b-2:** the negative paths.
- **E2E-B2b-3:** the constraint-13 observability query per agent job.
- **XA1–XA6** (real Docker, gated): as in Revision 0.
- **XA7:** the worktree bind holds a planted link, which is refused by the guard after `sandbox_exec`.

**Steps:** write the flows, see them fail, fill the gaps, see them pass. Then run the full `npm run test:db`, `npm run test:focused`, `node --test test/`, typecheck, build and the identity guard. Commit. `test:exec` and `test:runtime` run in Verification only.

**Commit:** `test(nexus): B2b end-to-end SDE flows with ScriptedRuntime (node and python fixtures), the gated real-Docker agent suite, and the registry closure`

---

### Task 17: Docs Part IV

**Files:**
- Modify: `docs/nexus/platform-core.md` (Part IV §49–§60, as listed in Revision 0, plus a section on the Task 0 probe results and the STOP rules)
- Create: `test/nexus-core-docs-v10-names.test.cjs`

**Content corrections:**
- §42 and §46 item 32 ("test:exec has never passed") are corrected. It passed 39/39 during stabilization.
- The limits are stated:
  - the file boundary is policy only;
  - the proxy routes and records traffic, but does not enforce it at the OS level;
  - admin-managed CLI settings still apply;
  - the CLI's own store writes (V3 list);
  - worktree cleanup is a later feature;
  - the residual pid-reuse risk.

**Tests:** **DOC10-1:** the §51 DDL equals `V10_DDL` byte for byte, and the name list equals `V10_EXPECTED`.

**Commit:** `docs(nexus): Part IV — schema v10, the agent runtime and its isolation, network consent, tokens and MCP, worktrees, change sets, accept and merge, caps, IPC #42-#51, limits`

---

## Verification

The controller runs these steps in order and stops at the first failure. **Any STOP branch from Task 0, V3 or V5 is reported to the user, and the phase stops.**

### Exit criteria (§15.2) mapped to the steps

| §15.2 exit criterion | Step | Pass condition |
|---|---|---|
| 1. `test:runtime` (denials, env, no token, no orphan processes) | V2 | CR0–CR15, SR1–SR3, HE1–HE9 pass; exit 0 |
| 2. SDE e2e with a real model on the fixtures and one real repository; the completion predicates hold | V5, V6 | Every SDE step `done` from records; `isExecutableEndToEnd`; O1–O25 = 0; usage within the caps; proxy decisions show `api.anthropic.com:443` only |
| 3a. Restart mid-turn | V7 | job and session `interrupted`; worktree hash unchanged; no CLI process; no `nexus.job` container |
| 3b. A failing test keeps the change set out of `candidate` | E2E-B2b-2, V5b | `cs.tests_pass` failed; Accept is a sentence |
| 3c. A dirty-tree accept | RA4, V6b | HEAD, branch, index and every file hash identical |
| 3d. Merge refusals | RA7, RA13, V6c | refusal sentences shown; files unchanged |
| 4. Token matrix | TK1–TK12, MG, AZ | denied once each and audited; no token text anywhere |

### Steps

- **V0 Preconditions (re-measured, never assumed):**
  - **Disk.** Measure free disk on C: and at the Docker data volume. It was **8.7 GB on 2026-10-21**, against the **30 GiB** gate (35–40 GiB preferred).
    - Below the gate, V4 is **NOT RUN**.
    - Below the 5 GiB lease floor plus 3 GiB for `npm run build` and the Docker VM, V5–V7 are also NOT RUN.
    - **The user must free about 22 GB or more before V4.**
  - **Free RAM.** At least 2 GB is wanted. Below 1.5 GB, V5–V7 are run but labelled "loaded machine", and the L7 and L11 checks are re-run on a quiet machine.
  - **Docker.** Docker is running, and the `sde-node`, `sde-python` and `nexus-fwd` images are present. If they are missing, re-preparing them needs A2 and the disk gate.
  - **The CLI.** It is signed in. The user checks this in their own terminal.
  - **The repository.** The user has chosen one real repository.
  - **Quota.** The user accepts using their own CLI plan quota within D-B4.
- **V1 Static checks:**
  - `npm run typecheck`
  - `npm run build`
  - `npm run test:focused` (11 baseline failures)
  - `node --test test/`
  - `npm run test:db`
  - the identity guard
- **V2:** run `npm run test:runtime`, and record the CLI version and the flags sha.
- **V3 Real-login smoke.** On a scratch userData with `NEXUS_ENABLE_V9=1 NEXUS_ENABLE_V10=1`, run one turn on a 3-file fixture. Record:
  - whether the login was read;
  - every proxy decision;
  - the usage;
  - the files touched in the user's CLI store (names and mtimes only).

  **STOP and ask** if any of these happens:
  - the login is not read under the flags (the setup-token question);
  - any refused host appears;
  - any write outside the CLI's own store appears.
- **V4:** `npm run test:exec`, covering B2a's 39 plus XA1–XA7.
- **V5:** the real-model e2e on both fixtures. **V5b:** the failing-test variant.
- **V6:** the full flow on the real repository, up to the merge. **V6b:** a dirty-tree accept. **V6c:** the merge refusals.
- **V7:** a restart mid-turn.
- **V8 Migration v10:**
  1. Take a manual fingerprinted backup.
  2. Run the migration on a restored copy, and check the v9 → v10 log lines and the own backup `harness-v9-<UTC>.db`.
  3. Do a restore drill back to v9.
  4. **Only after the user's go-ahead:** migrate the real DB, then compare it row by row.
- **V9 Click-through:** use CDP on a fresh scratch userData. Show:
  - every agent setup state;
  - a turn;
  - a change set with its evidence;
  - review, accept and the merge refusal;
  - that no raw codes appear, and no engine name or host outside the setup sheet.
- **V10 Report:** results, resources, the CLI version, the probe and smoke decisions, usage spent, limitations, files changed and commits. Then **STOP**. The default flips are proposed only.

---

## Decisions

### Already decided (binding)

D-B1 to D-B11 are recorded in `b2b-user-decisions.md` and summarised under Global Constraints.

### New decisions the user must make (raised by Revision 1)

| Id | Decision | Recommended answer |
|---|---|---|
| **D-B12** | **May a task agent run the installed CLI binary in tests?** Only through the harness: a fake home, a loopback mock model, a fake key, and a deny-all or refusing proxy. It never uses your home, login, CLI store or the network. This covers Task 0 P-A/P-B and `test:runtime` (CR tests). | **Yes.** Without this, the controller must run Task 0 and every CR run by hand, and implementers cannot see their own tests pass. The P-C login read (`auth status`) and V3 stay controller-only, after your go-ahead. |
| **D-B13** | **Where the Nexus refs live** inside the `nexus/*` namespace that D-B6 allows: `refs/nexus/job/*` and `refs/nexus/accepted/<branch>` (hidden), or `refs/heads/nexus/*` (shown as branches) | **`refs/nexus/*`.** These refs are not pushed by `git push --all`, do not clutter your branch list, and cannot be checked out as a branch, so accept can never move a branch you have open. You merge with "Merge accepted work", or inspect with `git log refs/nexus/accepted/<branch>`. |
| **D-B14** | **Secret scan of agent diffs** | **Block** on provider-key shapes and private-key headers. **Show, but do not block,** generic high-entropy strings as an advisory note for your review (lockfile integrity hashes excluded). Blocking on entropy would fail ordinary changes, such as lockfiles and base64 fixtures. |

---

## Conflicts with the architecture

These are the Revision 0 items 1–21, still valid, with these changes:
- **#5 (tools):** the names now use underscores (`context_get`, …). The architecture's dotted names are invalid as model tool names.
- **#11 (A4):** `repo_merges` records `sha_confirmed` and the `repo.ff` job.
- **#13 (worktree home):** refs move to `refs/nexus/*` (D-B13).
- **#15 (token key):** the key is per main boot, and live agent tokens are also revoked at every runner restart. Tokens are opaque, and their claims live in the database.
- **#21 (agent container):** still true. The host proxy also needs no image change (F14).

New items:

22. **§6.2 / §12.5: MCP results.** The architecture routes all results through main. **Now:** `sandbox_exec` output goes from the runner straight to the agent, and main gets only counts and hashes. Main still authorizes every exec before it runs.
23. **§12.6: git work.** The architecture describes git work as RepoService calls in main. **Now:** git writes are engine recipes run as system child jobs, and reads go over a bounded `git.read` op. That way they have durable state and recovery.
24. **§5.2 `partial`:** it is now also used for a turn that registered nothing (`no_change`).

---

## Revision 1: how each finding was resolved

| # | Severity | Resolution |
|---|---|---|
| 1 | Blocker | **Fixed as proposed.** The exec is granted through `mcp.reply`, the runner executes it, and the output goes to the agent only. `agent.exec.done` carries counts and a sha. `agent.exec.result` is deleted. Tasks 1, 5, 6 and 11 are changed, and SC1, MG13 and MS11 cover it. |
| 2 | Blocker | **Fixed.** Context, message and the fallback skills go on stdin. The skills file flag is used only when Task 0's P1 and P4 prove it. CR1 pins argv under 8 KiB; CR11 and P8 cover the rest. |
| 3 | Blocker | **Fixed** with the `ANTHROPIC_BASE_URL` loopback seam, reachable only through `createForTests` (CR0 pin). I chose it over a test CA because it needs no TLS material and leaves the proxy untouched in production. Added the harness, **Task 0**, and the new decision D-B12 on the rule wording. CR10's limit is stated, and V3 measures the real store. |
| 4 | Blocker | **Fixed as proposed.** `NO_PROXY=127.0.0.1`, `HTTPS_PROXY` only, an explicit `--allowedTools` list, and `--restricted` kept. CR2 asserts an Edit and a register. P5 proves the behaviour first. |
| 5 | Blocker | **Fixed.** Six engine recipes run as system child jobs, with recovery classes. Reads go over a `git.read` op. Added the merge-check, ref-init (inside `repo.worktree`), rollback and diff variants. Register waits 120 s and then answers `pending`. |
| 6 | Important | **Fixed as proposed.** The pin is edited in Task 11 (taskkill) and Task 13 (the CLI). Global Constraints say four programs. ScriptedRuntime runs in-process. The fake CLI goes through the same spawn site. `gitWrite` uses `runGit`. |
| 7 | Important | **Fixed.** A `TurnStarter` port, faked in RA10. AT13 covers the real wiring in Task 10. |
| 8 | Important | **Fixed.** Every exact-version site is listed in Task 3. M10-17 and M10-18 are added. |
| 9 | Important | **Fixed as proposed.** Opaque `jti.mac` tokens with claims in the DB. Revoked on every runner restart. The bearer is exempt from `scrub` and never logged. TK11 and TK12 added. |
| 10 | Important | **Fixed as proposed.** Monotonic usage per assistant message. Capped tokens = input + output + cache creation. An unreported cost is charged at the turn cap as "estimated". `--max-budget-usd` is set to min(turn, day remaining). Stream tool calls are counted. Grants are clamped, and v10 CHECKs enforce the ceilings. BG6–BG8, AT16 and CR14 added. |
| 11 | Important | **Fixed.** A durable accept job is the marker. `accept.prepared` comes before `update-ref`. A failed ingest triggers a CAS rollback, and recovery rolls back too. O25 checks consistency. The merge uses the confirmed sha after a `symbolic-ref` re-check. RA11–RA14 added. **Partly moot:** with `refs/nexus/*` (D-B13) the integration ref cannot be a checked-out branch, so I did not add `ref_checked_out`. |
| 12 | Important | **Fixed as proposed.** An lstat walk after every exec and before collect. Links, nested repositories and gitlinks are refused, and so are modes 120000 and 160000. The extra git `-c` options are added. Size caps: 8 GiB for the worktree and 50 MiB per file. RW10, RW11, CS11, CS12, AT14 and XA7 added. |
| 13 | Important | **Fixed.** Pidfiles record the main boot. Only same-boot orphans are killed. After an app restart the orphan is inert and documented. App quit runs `agent.shutdownTrees`. AT8 and AT17 added, and the Review Focus text is corrected. |
| 14 | Important | **Decided:** the host proxy `require`s B2a's `egress-proxy.js` from the repository and uses its exported `serve()`. There is no copy and no image change. HE7 pins `nexus-lock-images --check`. |
| 15 | Important | **Better fix:** block only on provider-key shapes (`hasProviderKey`) and private-key headers. Entropy hits become an advisory `sec.entropy_notes`, with lockfiles excluded. The proposed fix kept entropy blocking outside lockfiles, which would still fail ordinary base64 fixtures. Raised as D-B14. CS11b added. |
| 16 | Important | **Fixed as proposed.** `permissions.deny` covers Read and Edit on sensitive patterns. P3 proves `--settings` survives `--safe-mode` (else STOP). CR12 added, and the docs state the limit. |
| 17 | Important | **Fixed as proposed.** Probes run under `agentEnv` with a deny-all or allow proxy. `auth status` is parsed to `signedIn` inside the adapter only. CR13 added. |
| 18 | Important | **Fixed.** Task 0 checks P2 and P3 with STOP branches S2 and S3. The Revision 0 "fallback" text is removed, and every login or host problem is a STOP. |
| 19 | Important | **Fixed.** The `diff` preview part comes from `GitRead`, is bounded and redacted, and runs between the recorded base and head only (Task 14). IA13 and IA14 added. |
| 20 | Important | **Fixed.** UA10 is deleted. The reviewer runs `git show --name-only` against the peer list. |
| 21 | Important | **Fixed.** T5 is split into Tasks 5 and 6, T9 into Tasks 10 and 11, T10 into Tasks 12 and 13, and T13 into Tasks 16 and 17. `agentFixtures.cjs` is owned by Task 4. |
| 22 | Important | **Fixed.** Rebased on `4aec76f6`. The downgrade test targets `4aec76f6`. V0 re-measures disk (8.7 GB today) and RAM, and states the NOT RUN thresholds and what the user must free. |
| 23 | Minor | **Fixed:** `ready.mcpUrl`, `describe().label` and `egressHosts`, `AgentUsage` fields in cents, `credential.ref` kept as a string, `tokenFile` dropped, `vB2b`, one worktree per session with lowercased-ULID names, the mint inside the lease transaction, main as the context-file writer, the IPC getter in Task 14, full file lists, the finalize wording in Task 8, and the client calls created in Task 15. |
| 24 | Minor | **Fixed.** The panel sentence names no host. No `--model`, and the model id is stored opaquely and never shown. Hosts come from the adapter's `describe()`. |
| 25 | Minor | **Fixed.** `refs/nexus/*` (D-B13). The A3 text names object writes. `worktree lock`. GC never touches `wt/` or `jobs/` (RW13). |
| 26 | Minor | **Fixed.** `message.delta` chunked at 4 KiB or less (AT19). A bounded deep copier for args. SC1 rescoped to RunnerToMain, with SC1b for MainToRunner. |
| 27 | Minor | **Fixed.** A turn with nothing registered ends `partial: no_change` (AT18, UA12). |
| 28 | Minor | **Fixed.** Windows path forms are added to `SENSITIVE_PATH_RE` and SC4. |
| 29 | Minor | **Fixed.** The base is the merge-base with the integration ref (CS14). The accept identity is pinned. |
| 30 | Minor | **Fixed.** Tool names are pinned from what Task 0's P5 observes (`Agent`, not `Task`). |
| 31 | Minor | **Fixed.** The `sandbox_json` and `environment_json` projections are specified, and AT15 and CR4 scan `job_attempts`. |
| 32 | Minor | **Fixed.** `continueWith(user, …)` records the reviewing user (RA10, AT13). |
| 33 | Minor | **Fixed.** `Accept` header, 202 for notifications, protocol version and no header echo (MS7–MS10). |
| own-1 | (new) | Dotted MCP tool names are invalid model tool names (`[a-zA-Z0-9_-]` only), so every tool is renamed to underscores. |
| own-2 | (new) | The host proxy's allow-list is bound to the live consent's `hosts_sha256` (HE9). A turn cannot run with hosts the user did not grant. |

**Rejected findings:** none outright. Two were resolved differently from the review's proposal, as stated above:
- **F15:** entropy hits are advisory instead of blocking outside lockfiles.
- **F11:** the `ref_checked_out` refusal is made unnecessary by `refs/nexus/*`.
