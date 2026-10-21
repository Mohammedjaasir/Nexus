# B2b Task 0 report: agent CLI feasibility probe and test harness

**Status: STOP (S2).** `--safe-mode` drops the Nexus MCP server given by `--mcp-config`. Per the brief, the phase stops here and the user is asked the S2 question. Nothing was worked around. The pinned argv is unchanged.

## What was built

- `test/helpers/agentHarness.cjs` — `start({ home: 'fake', model: 'mock'|'none', proxy: 'deny-all'|'recorder', mcp: 'recorder' }) → { env, argvBase, home, mock, proxy, mcp, stop() }` plus `run()`, `writeJobFiles()`, the canaries, `PINNED_FLAGS`. The env is built from an empty object: the adapter allow-list, plus `ANTHROPIC_API_KEY` (fake) and, for `model: 'mock'`, `ANTHROPIC_BASE_URL` (loopback). No value points into the real home. The harness root goes under `C:\tmp` (outside the real home, so a walk-up from cwd can never reach `C:\Users\pc\.claude\CLAUDE.md`). `stop()` removes it.
- `test/helpers/mockModel.cjs` — loopback Messages API mock (JSON and SSE) that scripts `tool_use` turns and records every request body. Reused from the stopped attempt.
- `test/helpers/proxyRecorder.cjs` — refuses every CONNECT with 403 and records `host:port`. Reused from the stopped attempt.
- `test/helpers/mcpRecorder.cjs` — minimal Streamable-HTTP MCP server. It records `initialize`, `tools/list` and `tools/call` together with their headers.
- `test/helpers/fakeHome.cjs` — a generic planted home, a home-shaped env, and snapshot/diff with mtimes.
- `tools/nexus-agent-probe.cjs` — P0–P10. Parts A and B go through the harness only. Part C needs `--parts C --controller-go-ahead`, and it keeps only `signedIn`.
- `test/fixtures/agent/probe/**` — the job settings (with and without the deny rule), the skills template, and the `auth status` fixtures.
- `test/nexus-core-agent-harness.test.cjs` — HN1–HN5, plain node, and it never runs the CLI.
- Evidence: `task0-probe-report.json` and `task0-probe-report.md` (in this folder).

## Probe findings (CLI 2.1.295, fake home, mock model, recording proxy)

| Id | Result | Finding |
|---|---|---|
| P0 | pass | `2.1.295 (Claude Code)` |
| P1 | pass | All 20 pinned flags are listed. `--append-system-prompt-file` has no option line of its own; it is named in the `--bare` help text as `--append-system-prompt[-file]`. |
| P2 | **fail → STOP S2** | With `--safe-mode`: `system/init` shows `mcp_servers=[]`, the MCP recorder sees nothing, and the tool list lacks `mcp__nexus__context_get`. With the same argv minus `--safe-mode` only, the server is `connected`, the recorder sees `server/discover, initialize, notifications/initialized, tools/list`, and the tool is offered. |
| P3 | pass | `--settings` survives `--safe-mode`. `Read .env` is denied with "File is in a directory that is denied by your permission settings", and the secret never reaches the mock. A control run without the rule reads the secret, so the rule is what refused it. |
| P4 | pass | The skills-file canary reaches the system prompt (`--append-system-prompt-file` works). The stdin preamble canary is in the first user message, not the system prompt. No home or worktree canary appears in any request. |
| P5 | fail → STOP S5 (caused by S2) | `system/init` tools are `Edit, Glob, Grep, Read, Write`. The Edit inside cwd succeeds. The MCP call fails with "No such tool available" because the server is absent. Bash and WebFetch are not offered. |
| P5 names | observed | Under `--tools default`, the subagent tool is named **`Task`**, not `Agent`. **`PowerShell`** is not in this build's default set. The observed disallowed names are `Bash, WebFetch, WebSearch, NotebookEdit, Task`. |
| P6 | n/a (S2) | The MCP server is never contacted under the pinned argv. Without `--safe-mode` the `${NEXUS_MCP_TOKEN}` header is expanded. The token appears in no argv, CLI output or fake-home file, including the MCP log the CLI writes. |
| P7 | fail (MCP part only, S2) | 19 CONNECTs within 30 s, all to `api.anthropic.com:443`. No other host and no plain request: the proxy is honoured, so S6 and S7 did not fire. Under `--safe-mode` the MCP recorder is not reached because the server is dropped. Without `--safe-mode` it is reached directly. |
| P8 | pass | argv is 644 bytes. A 204,800-byte context on stdin reaches the mock intact. |
| P9 | n/a | Controller only, not run. In a fake home, `auth status` prints JSON with `loggedIn` (default `--json`), and the parser maps it to yes, no or unknown. |
| P10 | recorded | One turn writes `.claude.json` and `.claude/backups/.claude.json.backup.<ts>` to the fake home. Without `--safe-mode` it also writes `AppData/Local/claude-cli-nodejs/Cache/<cwd>/mcp-logs-nexus/<ts>.jsonl`. |

Decisions in the report: P0 `pinned-2.1.x`, P1 `all-pinned-flags`, P2 `STOP:S2`, P3 `safe-mode-keeps-settings`, P4 `isolated`, skillsDelivery `append-system-prompt-file`, P5 `STOP:S5 (consequence of S2)`, toolNames (observed, above), mcpHeaderForm `pending:S2` (env-expansion without safe-mode), P7 `proxy-honoured; MCP reach pending:S2`, P8 `stdin-context`, settingSourcesForm `""`, P9 `pending:controller`, P10 `recorded`.

**Informational for the S2 question (not a decision).** I re-ran the turn with only `--safe-mode` removed, keeping `--restricted`, `--setting-sources ""` and `--strict-mcp-config`. The Edit succeeds, the MCP call succeeds, the bearer is env-expanded, and the token is in no file or output. No home or worktree canary reaches any request, the skills canary reaches the system prompt, and the preamble reaches the user turn. This supports the S2 option "drop `--safe-mode` and prove CLAUDE.md exclusion by CR3", but only the user can choose it.

## Verification

- `node --test test/nexus-core-agent-harness.test.cjs`: 5/5 pass.
- `node tools/nexus-agent-probe.cjs --parts A,B`: exits 2 (STOP), as reported above. No `nxh-*` root is left under `C:\tmp`.
- `npm run typecheck`: **fails, in a file this task does not own.** All 27 errors are in `src/shared/nexus/recipes.ts`, which Task 1 is editing right now (uncommitted). There is no error in any file of this task, all of which are `.cjs`.
- `npm run test:focused` in the shared working tree: 24 failures, the 11 baseline plus 13 from Task 1's uncommitted `src/shared/nexus/**` work. RP2 lists Task 1's new RunnerToMain ops (`agent.exec.done`, `mcp.call`, `git.read.result`, …), and 8 test files fail to load on the `recipes.ts` syntax error. None of those tests loads a file of this task: only the new self-test and the probe require the helpers.
- Cross-check: a clean detached worktree at `0d9883ba` with only this task's files added gave 17 failures, the 11 baseline plus 6 in `nexus-ui-exec-models.test.cjs`. Those 6 fail because the fresh checkout has CRLF line endings, which break the source-regex tests. That is a checkout artifact, not this task. The worktree was removed afterwards (the node_modules junction was unlinked first).

## Concerns

1. **S2 blocks B2b.** The user must choose: drop `--safe-mode` (keeping `--restricted`, `--setting-sources` and `--strict-mcp-config`, with CR3 proving exclusion), or stop B2b.
2. **Tool names differ from the plan.** The subagent tool is `Task` in 2.1.295, while Revision 1 finding 30 says `Agent`. `PowerShell` is not in the default set. Tasks 13 (args) and 1 (if they pin names) should use the observed names. Keeping `PowerShell` and `Agent` in `--disallowedTools` as a defence costs nothing.
3. **`server/discover`.** The CLI sends `server/discover` before `initialize`. Task 6's MCP server should answer it, or return method-not-found as the recorder does, which the CLI accepts.
4. **MCP log file.** Without `--safe-mode`, the CLI writes an MCP log under `LOCALAPPDATA/claude-cli-nodejs/Cache/...`. In the real home that would be the user's LOCALAPPDATA. CR10's allow-list and V3 must cover it. The token was not found in it.
5. **Shared-tree gates.** Typecheck and test:focused cannot be clean until Task 1 lands. The controller should re-run both after Tasks 1 and 2 commit.
6. **P-B retries.** The CLI retries the refused API up to 10 times, about 19 CONNECTs in 30 s. The probe kills it at the 30 s window. The adapter's health and turn paths should expect this when the proxy refuses.
