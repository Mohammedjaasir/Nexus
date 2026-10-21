# B2b plan review: pre-flight conflict table and findings

- **Reviewed:** `b2b-plan.md` (1209 lines), measured against `b2b-user-decisions.md`, `b2a-user-brief.md`, `architecture-b2.md`, and the code at HEAD `6761e0c9` on `our-platform`.
- **CLI evidence:** `claude --version` reports `2.1.295 (Claude Code)`. `claude --help` and `claude auth status --help` were read. No agent was run and no model call was made.
- **Mode:** read-only. No code was changed and nothing was committed.

**Verdict: FIX PLAN FIRST.** There are 5 Blockers, 17 Important findings and 11 Minor findings. The Blockers are in the pinned CLI argv and environment, the exec protocol, the test:runtime harness and the git engine dispatch path. Each one makes a task impossible to implement or to test exactly as written.

---

## 1. Pairwise conflict table (tasks that share a file or an interface)

| # | Producer → Consumer | Produced | Consumed | Match? |
|---|---|---|---|---|
| P1 | T1 → T5, T9 | `RunnerToMain agent.exec {execId, attemptId, argv, cwd, timeoutMs}`, sent "only after main authorized"; `MainToRunner agent.exec.result {exit, stdout ≤64 KiB, stderr ≤64 KiB, truncated}` | T5: "main replies to the runner's **pending** `agent.exec` with allow". T9: the runner runs `driver.exec`, so the runner is the side that holds stdout. | **NO.** The result travels the wrong way (main has no Docker). The request is also described two incompatible ways. → F1 |
| P2 | T1 → T4, T5 | `mcp.call.bearer` ≤ 1 KiB; every protocol string ≤ 4 KiB | T4 token `base64url(JSON payload).hmac`. The payload carries caps with scopes, up to 20 input ids and 11 tool names, which is about 1.5–3 KiB after base64. | **NO.** Bearers would be dropped as malformed. → F9 |
| P3 | T1 → T5 | `ready {op, bootId}` (exact keys, unchanged by T1) | T5 `core.ts` reports `mcpUrl` in `ready` | **NO.** The T1 parser does not have the key. → F23 |
| P4 | T1 → T6, T7, T8 | `EngineTask` variants: `git.worktree.create`, `git.changeset.collect`, `git.accept`, `git.ff`, `git.status` | T7 `git.applies_cleanly` runs `merge-tree` in the runner. T6 integration-ref initialisation (`update-ref … ''`). T12 diff part. | **Missing variants:** merge-check, ref-init, diff. → F5 |
| P5 | T1 (no `recipes.ts` edit) → T6, T7, T8 | — | Engine plans are built **only** from `recipe.executor === 'engine'` jobs (`planBuilder.ts:353,551`) | **NO dispatch path.** No recipe, job kind or lease or recovery rule exists for the five git tasks or for a mid-turn `changeset.register`. → F5 |
| P6 | T1 → T9, T10 | `RunRequest.mcp {url, tokenFile}`. Plan text sets `credential: {ref:'runtime-owned'}` | T9 and T10 pass the token by env `NEXUS_MCP_TOKEN`. The V3 test pins the type `credential:{ref:string}`. | **Partial.** `tokenFile` is unused. A literal type would break V3, an unnamed test edit. → F23 |
| P7 | T1 → T11 | `AgentRuntime.describe() → {version, supportsHttpMcp, supportsResume, models}` | T11: "the adapter's display label is the one string from `describe()`" | **NO** `label` field. → F23 |
| P8 | T1 `AgentUsage` → T4 → T9 | `RuntimeEvent usage {inputTokens, outputTokens, costUsd?}` (dollars) | T4 sums `usage_json.$.costUsdCents`. T9 maps the event to `usage_json`. | **Names and units unpinned.** No conversion or field list is fixed. → F10, F23 |
| P9 | T2 → T4 | `capability_tokens` (jti, job, session, principal = `'agent:'‖session_id`, no token text) | `TokenService.mint` writes the row | **Yes** |
| P10 | T2 → T8 | `change_set_accepts` trigger: version is `active`. `reviews` trigger: version is `candidate`. | T8: promote, then insert, inside one tx | **Yes** (S10-2 drives the order) |
| P11 | T2 → T6, T9 | `session_worktrees` PK `session_id`, `branch GLOB 'nexus/job/*'` | T6: path and branch from "12 hex of jobId" (job ids are ULIDs, not hex). Is the worktree per job or per session? T9 AT5: a new session on the same worktree. | **Ambiguous.** → F23 |
| P12 | T3 → all of main | `platformAvailable` widened to ≤ 10 | `handoffsAvailable` (`=== V8 ‖ V9`), `executionAvailable` (`=== V9`), the v9 step's reopen branch (`=== V9`, `db.ts:680`), and the exact-shape reopen checks | **NO.** At v10, handoffs and execution switch off and the v9 step mis-branches. → F8 |
| P13 | T3 → T11 | T3 hands `agentsUnavailableReason` to IPC from `index.ts` | The IPC deps type gains the field only in T11 | **Order.** T3 does not typecheck as written. → F23 |
| P14 | T4 → T5 | `TokenService.verify`, `AuthService.authorizeWithToken(token, action, scope)` | `McpGateway.call` steps 1–4 | **Yes** |
| P15 | T4 → T9 | `mint(system, {...})` writes a DB row | T9: "the token minted at lease" inside `planBuilder.agentPlan` (a builder) | **Placement.** It must happen in the executionService lease transaction. → F23 |
| P16 | T4 → T9 | `startGuard(projectId)` built on `budgetDecision` | `AgentService.start` step 3 | Signatures match, but the semantics leave gaps. → F10 |
| P17 | T5 → T9 | `ContextResolver.resolve(job) → {file under the job dir, hash}` (main writes it) | T9 runner step 2: "write the job config dir (… the context file …)" | **Conflict:** the plan does not say who writes the file. → F23 |
| P18 | T5, T6 → T9 | MG and RW tests need a running `agent.run` job, a session, an agent principal and a token | Only T9's `AgentService` creates these | **Forward dependency.** It needs a named fixture helper. → F21 |
| P19 | T6 → T7, T8 | `gitWrite` exports `createWorktree`, `collectAndCommit`, `acceptMerge`, `fastForward`, `status` | T7 (collect + secret scan), T8 (accept, ff, status) | Yes. However, `gitWrite` must reuse the `proc.ts` `spawn(gitBin` site: the posture test pins exactly that site (`nexus-runner-posture.test.cjs:89`). → F6 |
| P20 | T7 → T8 | `git.applies_cleanly` re-checked at accept. On a conflict: "stays candidate with a new failed row" | B2a finalize rules (a blocking failed row) | **Inconsistent.** → F23 |
| P21 | T8 → T9 | `ReviewService.decide(request_changes)` calls `AgentService.continueWith` | `continueWith` is created in T9. RA10 asserts the new turn job. | **Forward dependency:** T8 cannot pass. → F7 |
| P22 | T8 → T11 | `accept(user, versionId, expectedIntegrationHead)`, `status`, `mergeAccepted(…, confirm)` | #48, #49, #50 | **Yes** |
| P23 | T9 → T10 | T9 adds a `taskkill` spawn site and runs "the posture test" | The posture pin is edited only in T10. Global Constraints say "exactly **three** programs"; T9 and T10 say four. | **NO.** → F6 |
| P24 | T9 → T10 | `runtimes/registry.ts` created in T9 | modified in T10 | Yes |
| P25 | T10 → B2a image | "`egressPolicy.decide` … both proxies use" | No such function exists. The decision code lives in `infra/images/sde-node/egress-proxy.js`, inside the image context. | **NO.** Moving the code changes the image hash; copying it duplicates it. → F14 |
| P26 | T10 `env.ts` → T10 CR tests | Allow-list drops `ANTHROPIC_*`, `*_API_KEY` and `*_TOKEN`; `NO_PROXY=''`; the proxy refuses plain HTTP (HE3) | CR2–CR7 and CR10 need the CLI to reach a loopback mock model from a fake home that has no login | **NO seam.** → F3 |
| P27 | T11 → T12 | 10 channels; `nexus:version:preview` `part` enum "widens in Task 11" | T12 Monaco diff between recorded commits | **Producer missing** (who runs `git diff`, its bounds, its tests). → F19 |
| P28 | T11 → T12 | T12 "consumes the Task 11 client calls" | `nexusClient.ts` appears only in T12's file list | Wording mismatch. → F23 |
| P29 | T1 → T12 | Both edit `test/nexus-honesty-audit.test.cjs` | sequential | Yes |
| P30 | T1 → T13 | `B2B_IMPL` e2e list, with titles from T13 | pin test records the ordering | Yes |
| P31 | T3 → T11 | Both edit `src/main/index.ts` | sequential | Yes (see P13) |
| P32 | T5, T9 vs the in-flight B2a-close work | `executionService.ts`, `recovery.ts`, `src/main/git.ts`, `gitBinary.ts` | T5, T9 and T6 edit them or depend on them | Prerequisite gate stated. The base hash is stale. → F22 |
| P33 | T5, T9 → composition | gateway, agent service, probe cache | `platform.ts` and `execWiring.ts` are not in the T5 or T9 file lists | Incomplete file lists. → F23 |

---

## 2. Per-task self-check

| Task | Tests match code? | Created files vs later tasks | Independently testable? | Sized for one agent? |
|---|---|---|---|---|
| T1 contracts | Mostly. SC1 says "every new op round-trips through `parseRunnerMessage`", but that parser only reads RunnerToMain, so `mcp.reply` and `agent.exec.result` cannot be covered. | Missing `recipes.ts` (P5), `ready.mcpUrl` (P3) and `describe().label` (P7) | Yes (pure) | Yes, though large |
| T2 schema v10 | Yes | Matches T4 and T8 | Yes | Yes |
| T3 migration | M10 covers the cases, but nothing names the exact-version getters (P12) | IPC getter ordering (P13) | Yes | Yes (16 tests; borderline) |
| T4 tokens / budget | TK and BG match. Day-cap and in-flight semantics are untested (F10). | OK | Only with a fixture: sessions and principals come from T9 | Yes |
| T5 MCP | MG5 and MG10 need a worktree, an exec and a session that do not exist yet | OK | Needs a fixture helper (P18) | **No.** It covers the main gateway, resolver and skills plus the runner HTTP server plus `executionService` and `core.ts`. Split it into T5a (main) and T5b (runner server). |
| T6 worktrees | RW match | `gitWrite` must route through `proc.ts` (P19) | Needs an agent job in `running` (fixture) | Yes |
| T7 change sets | CS4 only checks an AWS key. No test proves a lockfile change passes (F15). No nested-repo or link test (F12). | Dispatch path missing (P4, P5) | Yes once F5 is fixed | Yes |
| T8 review / accept | RA10 cannot pass before T9 (P21). No crash-between-ref-and-DB test (F11). | OK | **No** (RA10) | Yes |
| T9 turns | AT6 proves the cap only for ScriptedRuntime (F10). AT7 and AT8 need a spawnable fake CLI binary through the one spawn site (F6). | Posture conflict (P23) | Posture test red until T10 | **No.** It covers main sessions, scheduler, plan and recovery plus the runner attempt, procTree, the scripted runtime and the registry. Split it into T9a (main) and T9b (runner). |
| T10 adapter / proxy | CR2–CR10 are infeasible as specified (P26, F3). CR10 measures a fake home with no login, so it cannot measure D-B1's real cost. | `egressPolicy.decide` does not exist (P25) | **No** (the harness is undefined, and the plan's own rule forbids running the real CLI in a task) | **No.** Split it into T10a (host proxy and HE) and T10b (adapter and CR). |
| T11 IPC | IA match | Diff part missing (P27) | Yes | Yes |
| T12 renderer | UA10 is environment-dependent and fails today (F20) | — | Yes, except UA10 | Large, but acceptable |
| T13 e2e + docs | E2E and XA are fine | — | Yes | **No.** It covers two e2e fixtures, six XA tests and docs §49–§60. Move the docs into T13b. |

---

## 3. Violations of user decisions and constraints

| Constraint | Status in the plan |
|---|---|
| No engine-specific concepts in data, UI, jobs or workflows | Mostly kept (`cli-agent`, neutral views). Three leaks remain: the agent-panel sentence "permission to reach `<hosts>`" shows `api.anthropic.com` outside the setup row (D-B9); `--model <model id from settings>` stores an engine model id in Nexus settings; and the host list must come from the adapter, because `src/main/nexus/agents/**` is now in the vendor scan. → F24 |
| Secrets never in the renderer, logs, artifacts, activity, prompts or errors | Gaps: the context goes in argv (F2); the host-side `Read` can send repo-tracked `.env`, `*.pem` and `id_rsa` files to the model (F16); `auth status` output contains the account email (F17); the `sandbox_json` projection of an AgentPlan is unspecified (F31); the runner `scrub()` has no rule for `mcp.call` (F9). |
| Spend and rate caps enforced | Not enforced as written. Usage arrives only in the final `result`. A cancelled or timed-out turn counts as $0. The day cap is checked only at start. Tool calls count MCP calls only. Grant caps come from the renderer, unbounded. → F10 |
| The only network destination is `api.anthropic.com:443` | `health()` (`--version`, `--help`, `auth status`) runs without the proxy, so it could connect directly (F17). `NO_PROXY=''` breaks the loopback MCP instead (F4). |
| Accept never touches the user's branch | Holds in the happy path. It fails on a crash or refusal between `update-ref` and the DB transaction: unaccepted or rejected work stays in `nexus/accepted/*`, and "Merge" then fast-forwards it into the user's branch. It also fails when the user has the integration ref checked out. → F11 |
| v10 is opt-in with a backup first | Kept (`NEXUS_ENABLE_V10`, `harness-v9-<UTC>.db`, V8 order). Exact-version getters are missing (F8). |
| No peer-owned file touched | Kept by the file lists. UA10, as designed, reads the peer's own uncommitted edits (F20). |
| Nothing claims completion without evidence | `run.completed` with zero registered versions becomes `completed` (vacuous). Task 10 says "pass on CLI 2.1.295" with no runnable harness. → F27, F3 |
| D-B1: STOP and ask on a login failure | The plan's Task 10 risk says "the fallback is D-B1(c)", which reads as automatic. → F18 |
| D-B4 caps | The values match. Renderer-raisable caps at #51 can exceed them. → F10 |
| Resource constraint 1 | The plan says 21 GB free. **Measured now: 8.3 GB free on C:.** → F22 |
| Constraint 7 (disk limits) | A bind-mounted worktree has no quota and bypasses B2a's `workspace_too_large` guard. → F12 |

---

## 4. Security review (summary; details in the findings)

- **MCP loopback server.** The Host-equals-`127.0.0.1:<port>` check, the Origin refusal, the bearer and the `Content-Type` check close DNS rebinding and simple cross-origin POSTs.
  - Open points: Streamable-HTTP details (`Accept` for both types, 202 for notifications, `Mcp-Session-Id`, the protocol version header). Errors must never echo `Authorization`.
  - After a runner-only restart, port 0 can be reissued to the same number while live tokens are still valid. → F9, F33
- **Capability tokens.**
  - A self-contained payload is unnecessary, because main both mints and verifies. It also overflows the 1 KiB bearer bound.
  - Revocation on a runner-only restart is unspecified.
  - Scope is only checked at register for host-side edits. That is by design and matches D-B3.
  - → F9
- **Host-side CLI.**
  - `NO_PROXY=''` plus `HTTP_PROXY` sends the loopback MCP call into the proxy.
  - `dontAsk` with no allow rules denies Edit, Write and every MCP tool.
  - The effect of `--safe-mode` on `--mcp-config` and `--settings` is unproven.
  - Admin-managed settings still apply, which the docs must say.
  - The user's `~/.claude.json` per-project entries are ignored only under `--restricted` and `--strict-mcp-config`.
  - CR3 plants only in the home. It must also plant project-level `.claude/settings.json`, `.mcp.json`, `CLAUDE.md`, `.claude/agents` and `.claude/skills` in the worktree.
  - → F4, F16, F18
- **Worktree and `.git` tampering.** RW7 (an explicit `--git-dir` after checking the `.git` file) is good. The container can still plant links, nested `.git` repositories or gitlinks, and unbounded files through the rw bind mount. These are host-side git code-execution and disk-exhaustion vectors. → F12
- **merge-tree + CAS accept.** The CAS on the ref is correct. Git and DB atomicity is missing. Merge uses the ref *name* rather than the confirmed SHA. → F11
- **Windows process trees.** Killing by pid plus `IMAGENAME eq claude.exe` will hit the user's own interactive sessions of the same binary after pid reuse. The creation-time check promised in Review Focus 5 and in the file map is not in Task 9. → F13

---

## 5. Feasibility (CLI 2.1.295 `--help`)

| Plan flag | In `--help`? | Note |
|---|---|---|
| `-p`, `--output-format stream-json`, `--verbose`, `--input-format text` | yes | |
| `--restricted` | yes | Removes code-running tools and WebFetch, ignores user/project/local settings, confines file tools to the working dirs, and lets only a person or handler approve writes to settings, git and tool-config files. |
| `--safe-mode` | yes | Disables "CLAUDE.md, skills, installed plugins, hooks, **MCP servers** …". Whether `--mcp-config` servers survive is **unproven** (F18). |
| `--strict-mcp-config`, `--mcp-config <configs...>` | yes | variadic |
| `--settings`, `--setting-sources` | yes | the empty value is unproven (the plan already pins a fallback) |
| `--tools`, `--disallowedTools` | yes | `Task` is now `Agent` (F30) |
| `--permission-mode dontAsk`, `--permission-prompts none` | yes | `dontAsk` denies anything not pre-allowed (F4) |
| `--no-session-persistence`, `--disable-slash-commands`, `--no-chrome`, `--max-budget-usd`, `--model` | yes | |
| `--append-system-prompt` | yes | Windows 32,767-character limit (F2) |
| `--append-system-prompt-file` | appears only inside the `--bare` description text | A literal "pinned flag in `--help`" check would fail on it (F2) |
| `auth status` | yes (`--json` is the default, `--text`) | Its output includes account identity (F17) |
| `--allowedTools` | yes | Needed by F4 |

---

## 6. Things a reviewer would flag as defects

- **UA10** (`git diff --name-only` against the peer list). It is vacuous for B2b, red today, and depends on the environment. → F20
- **AT6** proves the turn cap only for ScriptedRuntime. The real adapter maps usage only from `result`. → F10
- **`egressPolicy.decide`**: a "shared" function that does not exist. → F14
- **Secret scan** with `looksSecret` (an entropy rule) over added lines. It false-positives on `package-lock.json` integrity hashes. → F15
- **CR10** audits a fake home with no login, so it cannot measure what D-B1 actually costs. → F3
- **SC1** claims coverage that the parser cannot give. → F26

---

## 7. Numbered findings

### Blockers

1. **Blocker: the exec protocol runs the wrong way and is described two ways.**
   - T1 has `MainToRunner agent.exec.result` carrying stdout and stderr, but the runner runs the exec. T1 says `agent.exec` is sent after authorization; T5 says main answers a pending `agent.exec`.
   - The 64 KiB strings also exceed the protocol's 4 KiB string bound.
   - **Change:** use one flow.
     1. The CLI sends MCP `sandbox.exec` to the runner server.
     2. The runner forwards it as `mcp.call`.
     3. Main authorizes and replies `mcp.reply {ok, value:{grant:{execId, argv, cwd, timeoutMs}}}`.
     4. The runner runs `driver.exec` and returns the redacted, capped output to the CLI.
     5. The runner reports `RunnerToMain agent.exec.done {execId, exit, stdoutBytes, stderrBytes, stdoutSha256, truncated}`, with no output text.
   - Delete `agent.exec.result`. Rewrite SC1, MG5 and AT1 to match.

2. **Blocker: context and skills travel through argv (`--append-system-prompt` with file content).**
   - The Windows `CreateProcess` limit is 32,767 characters. The context allows 20 messages of up to 8000 characters plus review comments and diagnostics. Iteration, an exit criterion, will exceed the limit.
   - Argv is also readable by any process of the same user.
   - **Change:** send the resolved context as a preamble of the stdin message, or only through `context.get`. Send skills on stdin, or through `--append-system-prompt-file <configDir>/skills.md` only if a contract probe proves it on 2.1.x. Make the pinned-flag check accept its `[-file]` form in the `--bare` text.
   - Add CR11: a 200 KiB context reaches the mock model intact, and the CLI's argv stays under 8 KiB.

3. **Blocker: the test:runtime harness cannot work as specified, and the plan forbids itself from running it.**
   - The fake home has no login. `env.ts` drops `ANTHROPIC_*`, `*_API_KEY` and `NODE_EXTRA_CA_CERTS`. HE3 refuses plain HTTP, and the CLI speaks TLS to `api.anthropic.com`. So CR2–CR7 and CR10 cannot reach the mock.
   - The standing rule says "never invoke the real agent CLI in a task", yet Task 10 says "pass on CLI 2.1.295".
   - **Change:** pin one test seam reachable only through `createForTests()` and source-pinned like HE6. For example, `ANTHROPIC_BASE_URL=http://127.0.0.1:<mock>`, a fake key and a loopback-only test admission; or a test CA. CR5 then asserts the allow-list plus exactly those test names.
   - Reword the rule to allow the real binary with a fake home and the mock only, never the user's home, login or network, and get the user's OK for that wording. Otherwise move CR runs to a controller step.
   - Add a **Task 0 adapter feasibility probe** before Task 5. It runs the real binary against the mock and proves that `--safe-mode` keeps `--mcp-config`, that env expansion works in `--mcp-config` headers, that the allow rules work, and that the proxy is honoured. Tasks 5–9 build on all four.

4. **Blocker: the pinned env and argv defeat the design.**
   - `NO_PROXY=''` plus `HTTP_PROXY` sends the CLI's `http://127.0.0.1:<port>/mcp` calls into the egress proxy. The proxy refuses them as `plain_http` or `private_address`.
   - `--permission-mode dontAsk` with `--permission-prompts none` and no allow rules denies Edit, Write and every MCP tool.
   - **Change:**
     - Set `NO_PROXY=127.0.0.1` (exactly the MCP host). Set only `HTTPS_PROXY`, not `HTTP_PROXY`.
     - Add `--allowedTools Edit Write mcp__nexus__<each token tool>`, pinned in CR1. Keep `--restricted` so that writes to `.git` and settings files remain person-only.
     - CR2 must assert that one Edit inside the worktree succeeded and that `changeset.register` reached main.

5. **Blocker: the git engine tasks have no dispatch path.**
   - Engine plans exist only for jobs of engine recipes. The plan adds no recipe, no job kind and no lease or recovery rule for worktree-create, collect, accept, ff and status. It also lacks EngineTask variants for the `applies_cleanly` merge check, the integration-ref initialisation and the T12 diff.
   - A mid-turn `changeset.register` would need a child job or a new op.
   - **Change:** in T1, add `recipes.ts` entries, for example `repo.worktree`, `changeset.collect`, `changeset.merge_check`, `changeset.accept`, `repo.ff`, `repo.status` and `changeset.diff`, with `executor:'engine'`. Add the missing EngineTask variants.
   - State that `register`, `accept` and `merge` run as system child jobs, with their wall clock, recovery (an interrupted accept is reconciled, never retried blindly) and the MCP-call wait bound.

### Important

6. **Important: the posture pin conflicts.**
   - Global Constraints say "exactly three programs"; T9 and T10 say four. T9 adds a `taskkill` spawn but the pin edit is in T10, so T9's own posture run is red.
   - The plan does not say what process ScriptedRuntime or AT7 spawns.
   - `gitWrite` must not add a spawn site.
   - **Change:** make the pin edit in T9 (`taskkill`) and again in T10 (CLI), named in each.
   - ScriptedRuntime runs in-process. AT7 and AT8 spawn a test binary (`process.execPath` with `ELECTRON_RUN_AS_NODE`) through the same `spawn(agentBin` site, injected by the registry.
   - `gitWrite` calls `proc.ts`'s git runner. Fix the Global Constraints text to say four.

7. **Important: T8 depends forward on T9.** RA10 needs `AgentService.continueWith`. **Change:** give T8 an injected `TurnStarter` port, faked in RA10, and move the real wiring and its assertion into T9 (AT13).

8. **Important: T3 misses the exact-version sites in `db.ts`.**
   - `handoffsAvailable` (`=== V8‖V9`), `executionAvailable` (`=== V9`), the v9 step's `if (this.version === V9)` reopen branch (line 680), the v7, v8 and v9 reopen exact-shape checks, and `executionUnavailableReason`.
   - At v10, handoffs and execution turn off, and the v9 step mis-branches.
   - **Change:** list each site in T3's interface (`>= V9`, `exact:false` above that version). Add M10-17: at v10, `handoffsAvailable`, `executionAvailable` and `agentsAvailable` are all true, and a reopen runs no step.

9. **Important: the token design.**
   - The self-contained payload exceeds the 1 KiB bearer bound and adds nothing, since main is both issuer and verifier.
   - Runner-only restart revocation is unspecified, and port reuse lets an orphan CLI reach a fresh server while its token is still valid.
   - The runner `scrub()` has no rule for `mcp.call`. `looksSecret(bearer)` is true, so any generic redaction destroys it.
   - **Change:**
     - Use an opaque `jti.mac` token: 32 random bytes plus an HMAC. Claims live in the `capability_tokens` row and in memory.
     - On every runner `ready` with a new boot, revoke the tokens of all live `agent.run` attempts (`restart`).
     - Exempt `bearer` from `scrub` explicitly, and never log `mcp.call`.
     - Add TK11 (runner restart revokes) and TK12 (`drop()` logs never contain a bearer).

10. **Important: spend and rate caps are not enforced as written.**
    - `stream.ts` maps usage only from `result`, so token and USD caps cannot trigger mid-turn on the real adapter.
    - Cancelled or timed-out turns report $0 toward the day cap.
    - The day cap is checked only at start ($9.99 + $2 = $11.99).
    - The tool-call cap counts MCP calls only.
    - "Tokens" is undefined; cache reads alone exceed 400k in a long turn.
    - #51 lets the renderer raise the caps.
    - **Change:**
      - Map each assistant `message.usage` to monotonic usage. Define tokens as input + output + cache-creation, with cache reads reported but not capped.
      - Charge a turn that ends without a reported cost at the turn cap (labelled "estimated").
      - Pass `--max-budget-usd min(turn, dayRemaining)`.
      - Count every `tool_use` from the stream toward the 200-call cap.
      - Grant caps may only lower the D-B4 values.
      - Add CR-level tests (mock usage mid-turn → cancel) and BG6–BG8.

11. **Important: accept is not atomic between git and the DB.**
    - Accept moves the ref and then runs the DB transaction. A crash, a trigger refusal or a concurrent reject in between leaves the integration ref holding unaccepted or rejected work, and "Merge accepted work" then fast-forwards it into the user's branch.
    - `merge --ff-only <ref>` merges whatever the ref holds at the moment of merging, not what the dialog showed.
    - `update-ref` happily moves a ref the user has checked out.
    - **Change:**
      - Hold the version in an IMMEDIATE transaction with a durable "accepting" marker (activity or `job_events`) before `update-ref`.
      - On any later failure, roll the ref back with CAS (`update-ref <ref> <old> <new>`).
      - Reconcile at recovery (O25: the integration ref's head ≠ the last accept's `ref_after`).
      - Run `git merge --ff-only <expectedAcceptedHead SHA>`, and re-check `symbolic-ref HEAD` immediately before.
      - Refuse with `ref_checked_out` when any worktree has the integration ref checked out.
      - Add RA11 to RA13.

12. **Important: the container reaches the host through the rw bind mount.**
    - `sandbox.exec` can plant symlinks (WSL creates NT symlinks for relative targets), nested `.git` repositories or gitlinks, and an unbounded amount of data.
    - Host-side git and CLI reads follow those links. Bind mounts have no quota, so this also bypasses B2a's workspace guard.
    - **Change:**
      - After every exec and before collect, walk the worktree with `lstat`. Refuse links, reparse points, nested `.git` at any depth and gitlinks (`symlink_in_worktree`, `nested_repo`).
      - Add `-c gc.auto=0 -c maintenance.auto=false -c submodule.recurse=false -c protocol.file.allow=never --ignore-submodules=all`.
      - Refuse mode 120000 and 160000 entries at collect.
      - Cap the worktree size after each exec, plus per-file and total caps at collect.
      - Add RW10 (a nested-repo fsmonitor canary never runs), RW11 (a planted link) and CS11 (an oversize file).

13. **Important: killing orphans by pid plus image name will hit the user's own `claude.exe` sessions.**
    - The user runs this binary all day, so after pid reuse the filter does not protect them.
    - The creation-time check promised in Review Focus 5 and in the file map was dropped in Task 9.
    - **Change:**
      - Record the main boot id and the runner pid in the pidfile. Kill only orphans from the same main boot (a runner crash).
      - After an app restart, do not kill. The orphan is inert: its proxy port is dead and its token is revoked. Document that.
      - Fix the Review Focus and file-map text.
      - Add an app-quit test (the `shutdown` op kills live CLI trees).

14. **Important: `egressPolicy.decide` does not exist.**
    - B2a's CONNECT, SNI and private-address logic is in `infra/images/sde-node/egress-proxy.js`, inside the image context.
    - Moving the logic changes the sde-node `contextSha256`, which means a rebuild and an A2 approval, contradicting Conflict 21. Copying it duplicates about 260 lines.
    - **Change:** decide explicitly. Either build a host proxy that `require`s the same JS file from the repository with no image change, or accept a port plus a shared vector-table conformance test (EP1) run against both proxies.

15. **Important: the secret scan of added lines will block normal change sets.**
    - `looksSecret`'s entropy rule matches `package-lock.json` `"integrity": "sha512-…"` lines and base64 fixtures.
    - **Change:** use `hasProviderKey` plus the private-key header for diff lines, with the entropy rule only outside lockfiles. Add CS11b: a lockfile-only change passes.

16. **Important: repo-tracked secrets reach the model through the host `Read` tool (constraint 6, "prompts").**
    - **Change:** the generated settings get `permissions.deny` for Read and Edit on the `SENSITIVE_PATH_RE` patterns (`.env*`, `*.pem`, `id_rsa*`, `*.key`, `.npmrc`, `.pypirc`). Add CR12. State the residual limit in the docs.

17. **Important: `health()` breaks the network rule and handles identity data.**
    - `--version`, `--help` and `auth status` run without the proxy, so a direct connection is possible (D-B2).
    - `auth status` prints the account identity.
    - **Change:** run every probe with `agentEnv`, pointing at a deny-all proxy before consent and at the allow proxy after. Parse the output to `signedIn` only, inside the adapter, and never log or store the output. Add CR13.

18. **Important: the isolation flags are unproven and the plan has no stop branch.**
    - Nothing proves that `--safe-mode` keeps `--mcp-config` and `--settings`, and the plan has no STOP branch for it.
    - The T10 risk text says "the fallback is D-B1(c)", which breaks the binding "STOP and ask".
    - **Change:** add both checks to the Task 0 probe (F3). If `--safe-mode` drops the Nexus server or the login, STOP and ask. Never drop `--safe-mode` silently, never switch to a setup-token silently.

19. **Important: Task 12's diff has no producer.** **Change:** add to T11 the `nexus:version:preview` `part:'diff'` through a runner engine `changeset.diff` task, capped at 1 MiB per side, redacted, and computed between the recorded `base` and `head` only. Add IA13 and IA14.

20. **Important: UA10 is a broken test.** It runs `git diff --name-only` against the peer list, and the peer currently has 9 of those files modified, so it fails regardless of B2b and depends on the environment. **Change:** delete UA10. Each task's reviewer checks `git show --name-only <commit>` against the peer list.

21. **Important: four tasks are too large for one agent, and two are not testable alone.**
    - **Change:** split T5 into main and runner halves, T9 into main and runner halves, T10 into proxy and adapter halves, and T13 into e2e and docs.
    - Add a named `test/helpers/agentFixtures.cjs`, owned by T4, that opens a session, an agent principal and a running `agent.run` job through real services, so T4–T8 can be tested before T9.

22. **Important: the base and resource facts are stale.**
    - HEAD is now `6761e0c9`. The git:* hardening and exec-off work are still uncommitted in the tree.
    - **Free disk is 8.3 GB**, not 21 GB, and close to the 5 GiB lease floor.
    - **Change:** update the base and prerequisites. Point the downgrade test at the final B2a-close commit. Make V0 re-measure disk and RAM and declare V4–V7 NOT RUN below the floors. Note that `npm run build` and the Docker VM also need headroom.

### Minor

23. **Minor: interface gaps and naming.**
    - **Change:**
      - T1: add `ready.mcpUrl`; add `describe().label`; pin the `AgentUsage` fields and units (`costUsdCents`).
      - `runtime.ts`: keep `credential:{ref:string}` (V3 pin) and set the value; drop `mcp.tokenFile`.
      - Use `validators.ts` with a B2b constructor (the `v()` helper hard-codes `'B2a'`).
      - T6: worktree per session; branch `nexus/job/<first job's ulid lowercased>`, not "hex".
      - Mint inside the lease transaction.
      - Decide one context-file writer.
      - T3: move the IPC getter handoff into T11.
      - Add `platform.ts`, `execWiring.ts`, `planBuilder.ts` and `recipes.ts` to the file lists.
      - Clarify T7's "stays candidate" against the finalize rules.
      - Fix T12's "consumes the T11 client calls" wording.

24. **Minor: the engine name leaks outside the setup row (D-B9) and into data.** **Change:**
    - The agent-panel sentence reads "Agent turns need your network permission (see Setup)". Hosts appear only in the setup sheet.
    - Drop `--model`, so the CLI default is used, or keep the model id inside the adapter's config, never in Nexus settings.
    - The consent host list comes from the adapter through the probe, not from code under `src/main/nexus/agents`.

25. **Minor: refs and objects in the user's repository.**
    - `refs/heads/nexus/*` is pushed by `git push --all` or `--mirror`.
    - The A3 text omits writes to `.git/objects`.
    - Worktrees are not locked.
    - **Change:**
      - Consider `refs/nexus/*` for job and accepted refs (D-B6 says "nexus/*").
      - Name the object writes in the A3 text.
      - Run `git worktree lock --reason Nexus`.
      - Make GC exclude `wt/` and `jobs/`.

26. **Minor: protocol bounds.** **Change:**
    - Chunk `message.delta` at 4 KiB or less.
    - Give `mcp.call.args` a bounded deep copier (depth, keys, bytes).
    - Note that non-ASCII summaries of 4000 characters can exceed 4 KiB.
    - Re-scope SC1 to RunnerToMain only.

27. **Minor: a turn can be "completed" with no evidence.** `run.completed` with no registered version becomes `completed`. **Change:** make it `partial` with `outcome:'no_change'`, and show "the agent made no change"; the step is never done.

28. **Minor: Windows path forms in the scope rules.** **Change:** add `.GIT/config`, `GIT~1/config`, `.git./x`, `a/.git/config` (any depth) and `x::$DATA` to the SC4 and `SENSITIVE_PATH_RE` cases.

29. **Minor: iteration diff base and accept identity.**
    - The reviewed diff of v2 must equal what accept merges.
    - `commit-tree` needs an identity.
    - **Change:** the change-set `base` is the session base, or the merge-base with the integration ref, not v1's head. Pin the accept commit's identity: the user's, or `Nexus <agent@nexus.invalid>` with a `Nexus-Accepted-By: user:local` trailer.

30. **Minor: stale tool name.** `--disallowedTools … Task` uses the old name of `Agent`. **Change:** pin the current names. This is harmless given `--tools`.

31. **Minor: the agent plan's DB record is unspecified.** **Change:** specify that the `sandbox_json` and `environment_json` projection of an AgentPlan holds no token, message, config path or worktree host path. Extend CR4 and AT9 to scan `job_attempts`.

32. **Minor: the wrong principal starts a requested-changes turn.** `continueWith(system, …)` records the system as the starter of a user's request_changes, which breaks constraint 13 ("who started it"). **Change:** pass the reviewing user as the requester.

33. **Minor: hand-rolled MCP server details.** **Change:** the MS tests also cover `Accept: application/json, text/event-stream`, 202 for notifications, `MCP-Protocol-Version` negotiation, and error bodies that never echo `Authorization`.
