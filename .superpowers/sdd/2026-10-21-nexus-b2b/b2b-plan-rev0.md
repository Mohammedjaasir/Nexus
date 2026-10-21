# Nexus B2b plan — Revision 0 (superseded; kept for the "as in Revision 0" references)

> **This file is not the plan.** `b2b-plan.md` (Revision 1) is the plan, and it wins on every difference.
> Revision 1 often writes "as in Revision 0", meaning: take the named tests, tables or interfaces from this file, then apply the changes Revision 1 states. Revision 0's task numbers map to Revision 1's as follows:
>
> | Revision 0 | Revision 1 |
> |---|---|
> | — | Task 0 (new) |
> | T1–T4 | Tasks 1–4 |
> | T5 | Tasks 5 (main) and 6 (runner server) |
> | T6 | Task 7 |
> | T7 | Task 8 |
> | T8 | Task 9 |
> | T9 | Tasks 10 (main) and 11 (runner) |
> | T10 | Tasks 12 (proxy) and 13 (adapter) |
> | T11 | Task 14 |
> | T12 | Task 15 |
> | T13 | Tasks 16 (e2e) and 17 (docs) |
>
> MCP tool names in this file use dots (`context.get`). Revision 1 renames them all to underscores (`context_get`).

---

## Review Focus (Revision 0)

1. **The host-side CLI reaches outside the worktree.** The routes are a symlink or junction in the repository, an absolute path or `..` in a file-tool call, and the agent rewriting the worktree's `.git` file. Tests: RW7 (Task 6), CR6 (Task 10).
2. **Accept races.** The integration ref moves, or the user's tree is dirty or mid-rebase. Tests: RA4, RA5, RA6 (Task 8).
3. **Secrets in agent output.** Tests: CS4 (Task 7), MG9 (Task 5), CR4 (Task 10), AT9 (Task 9).
4. **Runaway spend.** Tests: BG3, BG4, BG5 (Task 4), AT6 (Task 9).
5. **Orphan processes on Windows.** Tests: AT7, AT8 (Task 9), CR9 (Task 10).

---

## Task 1 (Revision 0): shared contracts — tests

- **SC1:** every new `runnerProtocol` op round-trips through `parseRunnerMessage`. Twelve malformed variants each answer `null`.
- **SC2:** every `MCP_TOOLS` capability is in the SDE ceiling. No tool is named like promote, accept, merge, approve, sign, handoff or secret.
- **SC3:** `budgetDecision` boundaries.
  - At the cap, refused.
  - One below the cap, ok.
  - `liveTurns === concurrentTurns` answers `busy`.
- **SC4:** `pathInScope`.
  - `src/a.ts` is in scope under `['**','!.git/**']`.
  - These are refused: `.git/config`, `../x`, `C:/x`, `a/../../b`, `.env`.
- **SC5:** `checkRegistry` passes. No QA, DA, DS, ML or DL step changed status or sub-phase.
- **SC6:** the skills contain no persona or engine name, and each is ≤ 8 KiB.

`budgetDecision(i: { usage: { turnUsdCents: number; dayUsdCents: number; turnsLastHour: number; liveTurns: number }; caps }) : { ok: true } | { ok: false; reason: 'budget_exhausted' | 'rate_limited' | 'busy' }`

---

## Task 2 (Revision 0): schema v10 tables

- **`capability_tokens`**: `jti` PK; `job_id` → jobs NOT NULL; `session_id` → agent_sessions NOT NULL; `principal_id`; `on_behalf_of`; `caps_sha256`; `tools_json`; `issued_at`; `expires_at`; `revoked_at`; `revoke_reason`.
  - Triggers: the principal is kind `agent` and equals `'agent:' || session_id`.
  - Identity is immutable, revocation is set once, and there are no deletes.
- **`reviews`**: `id`; `version_id` → artifact_versions; `principal_id`; `decision` CHECK in (`approve`, `request_changes`, `reject`); `comment` (≤ 4000); `comment_sha256`; `intent_id` UNIQUE; `created_at`.
  - Triggers: the principal is kind `user`; the version's kind is `change_set` and its status is `candidate`.
  - `comment` is NOT NULL for `request_changes` and `reject`.
  - Append-only.
- **`change_set_accepts`**: `version_id` PK; `project_id`; `integration_ref`; `ref_before`; `ref_after`; `merge_commit`; `accepted_by` (a user); `accepted_at`.
  - Immutable. The version must be `active`, so the order is promote first, then insert.
- **`repo_merges`**: `id`, `project_id`, `branch`, `before`, `after`, `merged_by`, `merged_at`, `confirmed_via = 'dialog'`. Append-only.
- **`runtime_consents`**: `id`, `runtime_kind`, `hosts_json`, `hosts_sha256`, the caps, `granted_by`, `granted_at`, `revoked_at`, `revoked_by`.
  - `ux_consent_live` allows one live row per runtime. Revocation is set once.
- **`session_worktrees`**: `session_id` PK, `project_id`, `rel_path`, `branch`, `base_commit`, `created_at`, `removed_at`.
- **Indexes**: `ix_tokens_job`, `ix_reviews_version`, `ix_accepts_project`, `ux_consent_live`, `ix_merges_project`, `ix_worktrees_project`.

**Tests:**
- **S10-1:** names and counts equal `V10_EXPECTED`.
- **S10-2:** each trigger refuses its illegal write.
- **S10-3:** the append-only pin.
- **S10-4:** the `V7_DDL`, `V8_DDL` and `V9_DDL` sha256 values are unchanged.

---

## Task 3 (Revision 0): migration tests M10-1 … M10-16

These mirror the v9 M-series:
- success, with the log lines in order;
- a fresh database (no backup taken);
- held, once for each switch in the cascade;
- not enabled;
- the failure marker counting up to auto-hold;
- a backup failure;
- a kill mid-transaction;
- a post-check failure;
- a reopen that does nothing;
- a v10 file opened with v9 off;
- v8 → v9 → v10 in one launch, with a later failure;
- the restore-tool hint for a v9 backup;
- downgrade: the older build opens the file as newer, and its delete guard stays on;
- legacy row counts unchanged, including the five `project_plans` rows.

**PC-10** pins `enableV10: process.env.NEXUS_ENABLE_V10 === '1' ? true : undefined` and bans `enableV10: false`.

---

## Task 4 (Revision 0): tokens, authorization and budgets

`AuthService.authorizeWithToken(token, action, scope: { projectId; versionId?; recipeId?; kind?; path? })` is the intersection of four checks:
- `decide()` for `onBehalfOf`;
- the domain ceiling;
- `token.caps`;
- the job still `running` or `awaiting_approval`.

Every denial writes one `auth.denied` row with `actorKind: 'agent'`. `decide()` still answers `agent_requires_token`.

**Token matrix:**

| Id | Case |
|---|---|
| TK1 | forged signature |
| TK2 | altered payload of the same length |
| TK3 | expired |
| TK4 | revoked |
| TK5 | job A's token used on job B's versions |
| TK6 | path, recipe or kind out of scope |
| TK7 | tool not in `mcpTools` |
| TK8 | job is terminal |
| TK9 | key changed after a restart |
| TK10 | token for a user principal |

Each is denied with exactly one audit row, and no activity row matches `TOKEN_RE`.

- **AZ1:** an agent cannot promote, accept, merge, answer approvals or grant consent.
- **AZ2:** `decide()` is unchanged.

**Budget tests:**
- **BG1:** no consent answers `consent_missing`.
- **BG2:** grant and revoke are each set once.
- **BG3:** the day cap is reached from recorded usage only.
- **BG4:** a 7th turn within one hour answers `rate_limited`.
- **BG5:** with a live turn and `concurrentTurns = 1`, a new turn answers `busy`.

---

## Task 5 (Revision 0): MCP gateway and server tests

- **MG1:** every allowed tool's happy path.
- **MG2:** `artifact.read` of a version not in the inputs is denied.
- **MG3:** `job.request` for `sde.build.node` is denied.
- **MG4:** the 21st child job is denied.
- **MG5:** `sandbox.exec` for another job's attempt is denied.
- **MG6:** the tool-call cap answers `limit`.
- **MG7:** malformed args answer `bad_args`, with one audit row.
- **MG8:** an unknown tool is refused.
- **MG9:** a secret-shaped argument is stored redacted, and the result is redacted.
- **MG10:** a requirement draft runs `req.schema`, then finalizes to `candidate`.
- **MG11:** a call after the job ends answers `revoked`.
- **MG12:** the context file holds no secret, and its hash is stored in `jobs.context_hash`.

Server tests:
- **MS1:** a Host mismatch answers 403.
- **MS2:** an `Origin` header answers 403.
- **MS3:** GET answers 405.
- **MS4:** an oversize body answers 413.
- **MS5:** a missing bearer answers a JSON-RPC error and is not forwarded.
- **MS6:** the server binds `127.0.0.1` only.

**Tool semantics:**
- `context.get`: the summary.
- `artifact.list` and `artifact.read`: within the token's project. `read` covers `inputs ∪ own outputs`, ≤ 256 KiB.
- `validations.get`.
- `job.status` and `job.logs`: own job tree only, ≤ 64 KiB.
- `job.request`: only `sde.deps.node`, `sde.deps.python` and `sde.test.discover`. Installs go through A1.
- `requirement.draft`: an inline draft.
- `review.request`: a note plus the Needs-you flag.

---

## Task 6 (Revision 0): repository-write tests

- **RW1:** the first turn creates a pending A3. No ref and no worktree exist before `once`.
- **RW2:** deny fails the job `denied`, and the repository is byte-identical (refs, status hash, mtime walk).
- **RW3:** approve creates the worktree and the branch. The user's HEAD, branch and index are unchanged.
- **RW4:** a second session needs no new approval.
- **RW5:** a planted hook and a planted filter driver never run.
- **RW6:** LFS pointers stay pointers.
- **RW7:** a rewritten `.git` file answers `worktree_tampered`, with no commit.
- **RW8:** a path longer than 260 characters works.
- **RW9:** an empty repository answers `failed: repo_empty`, shown as a sentence.

---

## Task 7 (Revision 0): change-set tests

- **CS1:** the happy path reaches `candidate`, with exact lineage.
- **CS2:** an empty diff is refused and no version is written.
- **CS3:** `.git/config` or `.env` fails `paths_in_scope`.
- **CS4:** a secret line fails, and the evidence holds path:line only.
- **CS5:** a failing test keeps the change set out of `candidate`.
- **CS6:** exit 0 with zero tests answers `failed: no_tests`.
- **CS7:** a merge-tree conflict fails `git.applies_cleanly`.
- **CS8:** Docker stopped gives `error` and the version stays a draft. Revalidate passes later.
- **CS9:** revise gives v2 `derived_from` v1.
- **CS10:** O1–O24 = 0.

`cs.tests_pass`: the check runner enqueues `sde.test.discover` on the head commit, then the `sde.test.*` child. It passes only when that suite's latest blocking `sde.tests_pass` row passed. The evidence holds the suite version id, the JUnit hash and the counts.

---

## Task 8 (Revision 0): accept tests

- **RA1:** approve, then accept, gives `active` plus an accept row; the ref moves by CAS.
- **RA2:** accept without an approving review answers `illegal_transition`.
- **RA3:** no token path to accept exists.
- **RA4:** dirty tree. The user has uncommitted edits, untracked files and a stash. Accept succeeds, and the user's HEAD, branch, index hash and every working file hash are identical before and after.
- **RA5:** the ref moved answers `conflict ref_moved` with the current head, and nothing is written.
- **RA6:** of two concurrent accepts, exactly one wins.
- **RA7:** merge refuses `tree_dirty`, `branch_mismatch` and `not_fast_forward`, and the files are unchanged.
- **RA8:** a dialog cancel answers `cancelled`, with no row.
- **RA9:** merge succeeds and writes a row.
- **RA10:** `request_changes` needs a comment and starts a new turn job with the review as input.

---

## Task 9 (Revision 0): agent-turn tests and interfaces

- **AT1:** a full ScriptedRuntime turn: read the context, run `sandbox.exec` `npm test`, register a change set, completed.
- **AT2:** a second message while a turn runs answers `conflict`.
- **AT3:** cancel works in provisioning, running and awaiting approval (A3, A1). Drafts become `cancelled_partial`, the token is revoked and the container removed.
- **AT4:** the wall clock gives `timed_out`, with the same cleanup.
- **AT5:** a restart mid-turn gives `interrupted`. The worktree is kept and unchanged, the token is dead, and a new message opens a new session on the same worktree.
- **AT6:** usage over the turn token cap gives `failed: limit`.
- **AT7:** after cancel, no child process remains.
- **AT8:** a runner crash leads to the next `hello` killing the recorded tree.
- **AT9:** a secret in `message.delta` and in exec output is redacted everywhere.
- **AT10:** a restart in each of queued, provisioning, running, tool execution, validation and awaiting approval is reconstructed correctly, and never completed.
- **AT11:** Docker unavailable gives `waiting:docker`.
- **AT12:** with `concurrentTurns = 1`, a second session waits.

`AgentService.start` checks, in order:
1. `agentsAvailable`;
2. runtime health;
3. consent and budget;
4. one turn per session;
5. open or reuse the session (`agent:<sessionId>`);
6. create the `agent.run` job (priority 1; `params_json {message, skillId}`; focus versions as `job_inputs`; `limits_json` from the consent caps).

`get` returns turns, display-only messages from the redacted log frames, tool calls from `job_events`, registered versions and approvals.

The scheduler adds the guards `waiting:runtime`, `waiting:budget` and `waiting:rate`. A turn container counts as a job slot with 1024 MiB.

The plan profile comes from the repository. The container runs `sleep <s>` with the worktree bind mounted rw at `/workspace`, the deps cache read-only, and network `none`.

---

## Task 10 (Revision 0): adapter and proxy tests

- **CR1:** argv equals the pinned list, and neither the message nor the token is in it.
- **CR2:** with the mock model: Bash, WebFetch and WebSearch are unavailable, and MCP reaches Nexus.
- **CR3:** canaries planted in the fake home (a hook, an MCP server, a plugin, CLAUDE.md) have no effect.
- **CR4:** the token never appears in output, logs, the context or request bodies.
- **CR5:** the env equals the allow-list.
- **CR6:** `../`, absolute paths and links are denied.
- **CR7:** cancel finishes within the grace period plus 10 s, with no process left.
- **CR8:** an unknown version or a missing flag gives `version_unsupported`.
- **CR9:** a runner kill ends the CLI.
- **CR10:** the fake-home writes audit.

ScriptedRuntime contract:
- **SR1:** events and their ordering.
- **SR2:** cancel.
- **SR3:** no orphan process.

Proxy tests:
- **HE1:** an allow-listed CONNECT is accepted.
- **HE2:** another host is refused.
- **HE3:** plain HTTP is refused.
- **HE4:** an IP literal is refused.
- **HE5:** an SNI mismatch is refused.
- **HE6:** source pin: the test-only constructor is never used in production.

Env allow-list (Revision 1 changes the proxy variables): `SystemRoot`, `windir`, `PATH` (System32 plus the CLI folder), `USERPROFILE`, `HOMEDRIVE`, `HOMEPATH`, `APPDATA`, `LOCALAPPDATA`, `TEMP` and `TMP` (the job dir), `LANG`. Added: `NEXUS_MCP_TOKEN`, `DISABLE_AUTOUPDATER=1`, `DISABLE_TELEMETRY=1`, `DISABLE_ERROR_REPORTING=1`, `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`. Dropped: `ANTHROPIC_*`, `CLAUDE_*`, `*_API_KEY`, `*_TOKEN`. `CLAUDE_CONFIG_DIR` is never set.

---

## Task 11 (Revision 0): IPC table and tests

| # | Channel | Args (validated) | Data | Errors |
|---|---|---|---|---|
| 42 | `nexus:agent:start` | `{ projectId, workspaceId, sessionId \| null, skillId?, focusVersionIds ≤ 20, message ≤ 8000, intentId }` | `{ session, job }` | `unavailable` (`runtime_missing`, `runtime_unsupported`, `not_signed_in`, `consent_missing`, `budget_exhausted`, `rate_limited`, `docker_*`), `conflict`, `denied` |
| 43 | `nexus:sessions:list` | `{ projectId, statuses? }` | `SessionView[]` | `not_found`, `denied` |
| 44 | `nexus:session:get` | `sessionId` | `SessionDetailView` | `not_found`, `denied` |
| 45 | `nexus:session:end` | `sessionId` | `SessionView` | `illegal_transition` |
| 46 | `nexus:session:cancel` | `sessionId` | `SessionView` | `illegal_transition` |
| 47 | `nexus:review:decide` | `versionId, { decision, comment? }, intentId` | `{ review, job? }` | `invalid` (comment required), `denied` |
| 48 | `nexus:changeSet:accept` | `versionId, expectedIntegrationHead` | `{ version, accept }` | `conflict ref_moved`, `merge_conflict`, `illegal_transition`, `approval_required` |
| 49 | `nexus:repo:status` | `projectId` | `RepoStatusView` | `not_found`, `denied` |
| 50 | `nexus:repo:mergeAccepted` | `projectId, { branch, expectedAcceptedHead }` | `MergeView` | `refused`, `cancelled` |
| 51 | `nexus:agent:consent` | `{ op: 'get' } \| { op: 'grant', caps } \| { op: 'revoke' }` | `AgentSetupView` | `denied` |

- **IA1:** each channel is registered once, and the preload count is pinned.
- **IA2:** with v10 off, these channels answer `platform_unavailable / agents_unavailable / subReason`, and #1–#41 still answer.
- **IA3:** no path, command, principal, model id or host is accepted.
- **IA4:** views carry no token, config path, pid, worktree host path, container id or principal id.
- **IA5:** intent idempotency.
- **IA6:** A3 is answered by users only.
- **IA7:** #48 on a non-candidate answers `illegal_transition`.
- **IA8:** #50 cancel answers `cancelled`.
- **IA9:** #51 grant needs the owner role.
- **IA10:** activity keys and sentences exist for the new rows.
- **IA11:** with a hung runner, #43 and #44 answer within 250 ms.
- **IA12:** no system-only method is reachable.

---

## Task 12 (Revision 0): renderer

**Files:**
- Create: `src/renderer/src/nexus/agent/{AgentPanel.tsx,agentModel.ts,SessionLog.tsx}`, `project/{ChangeSetReview.tsx,changeSetModel.ts}`, `data/useAgents.ts`, `test/nexus-ui-agent-models.test.cjs`.
- Modify: `data/{nexusClient.ts,executionModel.ts}`, `components/ExecutionSetupSheet.tsx`, `project/{ProjectBench.tsx,kindViewers.tsx,actionModel.ts,spineModel.ts}`, `review/ReviewSurface.tsx`, `intent/IntentLine.tsx`, `runs/jobRunModel.ts`, `styles/execution.css`, `test/nexus-honesty-audit.test.cjs`.

**Models:**
- `agentPanelModel(health, sessions, consent)`: setup sentences, sessions, and "Working" or "Waiting for you".
- `changeSetModel(version, validations, review, repoStatus)`: a headline that names every blocking check, the diff `{base, head}`, and the actions as buttons or sentences.
- `sessionLogModel(detail)`: display-only messages, tool calls with result sizes, and registered versions.

**Placement:**
- The agent panel goes in the bench.
- Change sets go in the Changes tool, above the uncommitted review.
- The Folio shows the read-only diff, the evidence, Approve / Request changes / Reject, Accept and Merge.
- The setup sheet gets agent rows.
- IntentLine sends #42 on an SDE project route, and keeps its legacy behaviour everywhere else.

**Tests:**
- **UA1:** every reason has one sentence and no raw code.
- **UA2:** no engine name in `agent/**` strings.
- **UA3:** Accept appears only on a candidate with an approving review.
- **UA4:** Merge appears only when `acceptedNotMerged > 0`, and is a sentence when the tree is dirty.
- **UA5:** no percentage or cost without the "reported" label.
- **UA6:** messages are labelled display-only.
- **UA7:** honesty audit for unmet prerequisites.
- **UA8:** the IntentLine route rule.
- **UA9:** a failing `cs.tests_pass` never reads "passed".

---

## Task 13 (Revision 0): end-to-end, real Docker and docs

**E2E-B2b-1**, on a Node fixture (node:test plus `nexus.app.json`) and a Python fixture (pytest). The flow:
1. requirement: an agent draft that the user promotes;
2. a turn produces a change set;
3. `cs.tests_pass`;
4. approve;
5. accept;
6. snapshot of the accepted ref;
7. build;
8. application;
9. a healthy dev deployment (fake driver);
10. diagnose;
11. a `request_changes` turn with the diagnostic as input;
12. v2 `derived_from` v1;
13. accept;
14. merge.

It asserts:
- every SDE step is `done` by `stepStateFrom`;
- `isExecutableEndToEnd(SDE,'B2b')`;
- the orphan queries are 0, `foreign_key_check` is clean, and the activity chain verifies.

**E2E-B2b-2** covers the negative paths. **E2E-B2b-3** runs the observability query per agent job.

**Real-Docker tests:**
- **XA1:** the turn container passes preflight with the worktree bind and network `none`.
- **XA2:** a network probe fails inside it.
- **XA3:** the container sees no host path beyond `/workspace`.
- **XA4:** cancel leaves nothing behind.
- **XA5:** a restart mid-turn removes the container in phase B.
- **XA6:** `cs.tests_pass` passes and fails on real fixtures.

**Docs, platform-core Part IV:**

| Section | Content |
|---|---|
| §49 | status |
| §50 | code map |
| §51 | v10 DDL |
| §52 | migration and runbook |
| §53 | runtime and adapter isolation |
| §54 | network and consent |
| §55 | tokens and MCP |
| §56 | worktrees, change sets, accept, merge |
| §57 | caps |
| §58 | IPC #42–#51 |
| §59 | limitations |
| §60 | differences from the plan |

---

## Conflicts with the architecture (Revision 0 items 1–21)

1. **Credential.** The architecture's options were an API key in safeStorage (D9) or an un-isolated CLI login. Now: the user's existing login in place, isolated by flags. There is no secret store in B2b, and `credential.ref` is `'runtime-owned'`.
2. **Config dir.** A per-job `CLAUDE_CONFIG_DIR` would hide the login, so none is set. The CLI writes its own bookkeeping into its store; that is measured and reported.
3. **Skills.** `--safe-mode` disables CLI skills, so Nexus appends its skill text itself and records its hashes.
4. **CLI version.** The architecture assumed 2.1.292. The installed CLI is 2.1.295, a native `claude.exe` that updates itself.
5. **Tool set.** `artifact.registerVersion` and `git.commit` are replaced by `changeset.register` and `requirement.draft`. `approval.request` is dropped, because A1 asks by itself. `lineage.get` and `handoff.create` are not in B2b.
6. **Tests on change sets.** `sde.tests_pass` judges `test_suite` only, so change sets use `cs.tests_pass`, which judges through a suite at the head commit.
7. **Typecheck.** `sde.typecheck_ok` and `sde.typecheck` are deferred. `llm.review_notes` is not built.
8. **Runtime kind.** `claude-cli` becomes the opaque `cli-agent`. The frozen DDL comments stay as they are.
9. **Runtime events.** They become `attempt.progress` events with `data_json.t`, and MCP calls become `mcp.call` activity rows. v9 is unchanged.
10. **`respondApproval`.** Not used: permission prompts are off, and approvals live in Nexus.
11. **Merges.** `repo_merges` uses `confirmed_via = 'dialog'`. A3 uses `repo.write_refs` and is asked at the first agent turn in a project.
12. **New tables.** v10 adds `runtime_consents` and `session_worktrees`.
13. **Worktree home.** The data home `wt/`, not `C:\nx\w`.
14. **Channels.** #51 consent is added, and #23 gains the agent view.
15. **Token key.** One per main boot.
16. **Agent network.** The agent's traffic goes through the loopback allow-list proxy.
17. **Sessions.** The v7 vocabulary is unchanged. There is no CLI resume.
18. **Mock.** The mock speaks only the pinned CLI's protocol.
19. **Completion.** The `CompletionEvaluator` arrives in B2c. B2b uses `stepStateFrom` plus `isExecutableEndToEnd`.
20. **Stale doc.** platform-core §42 / §46 item 32 is stale: test:exec passed 39/39.
21. **Container command.** The agent container runs `sleep <s>` through the B2a entry, so no image change is needed.
