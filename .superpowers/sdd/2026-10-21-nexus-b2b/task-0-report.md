# B2b Task 0 report: agent CLI feasibility probe and test harness

**Status: DONE. No STOP branch fires under D-B15.**

History:
- **Run 1** (commit `e25cfaed`) fired **STOP S2**: `--safe-mode` drops the job's `--mcp-config` server.
- **The user decided D-B15:** drop `--safe-mode` and keep every other lock: `--restricted`, `--setting-sources ""`, `--strict-mcp-config`, and the permission and tool flags. `--disallowedTools` lists `Task` and `Agent`, plus `PowerShell`, `Bash`, `WebFetch`, `WebSearch` and `NotebookEdit`. D-B15 also adds a CR3+ check.
- **Run 2** (this commit) applies D-B15. Every check passes.

## What was built

- **`test/helpers/agentHarness.cjs`.**
  - `start({ home: 'fake', model: 'mock'|'none', proxy: 'deny-all'|'recorder', mcp: 'recorder' })` returns `{ env, argvBase, home, mock, proxy, mcp, stop() }`. It also provides `run()`, `writeJobFiles()`, `detectPlants()`, the canaries and `PINNED_FLAGS`.
  - The env is built from nothing: the adapter allow-list, plus a fake `ANTHROPIC_API_KEY` and, in mock mode, a loopback `ANTHROPIC_BASE_URL`.
  - The root lives under `C:\tmp`, outside the real home.
  - `run()` returns `writes`: every file added or changed under the harness root during the run (home, worktree, job dir and tmp).
  - `argvBase` has no `--safe-mode` and carries the D-B15 disallowed list.
- **CR3+ plants (D-B15)**, in both the fake home and the worktree:
  - memory files: `CLAUDE.md`, `.claude/CLAUDE.md` and `CLAUDE.local.md`;
  - rules, skills, agents and commands;
  - user, project and local settings, each with hooks (`SessionStart`, `UserPromptSubmit`, `PreToolUse`, `Stop`) that print a canary and write a marker file, and each with a canary `model` value;
  - user, project (`.mcp.json`) and local MCP servers, pointed at recorded stray paths;
  - a user plugin and a project plugin, installed from local marketplaces, each with a skill, a command, an agent, hooks and an MCP server.

  `detectPlants` reports any of these signs: canary text in a request to the mock, a canary model, a hook marker, a stray MCP request, a planted name in `system/init`, or a hook stream event.
- **`test/helpers/mockModel.cjs`, `proxyRecorder.cjs`, `mcpRecorder.cjs` and `fakeHome.cjs`.** `mcpRecorder.cjs` now also records requests to stray paths.
- **`tools/nexus-agent-probe.cjs`** runs P0–P10 and CR3+.
  - Parts A and B use the harness only.
  - Part C needs `--parts C --controller-go-ahead` and keeps only `signedIn`.
- **`test/fixtures/agent/probe/**`** and **`test/nexus-core-agent-harness.test.cjs`** (HN1–HN6). HN6 is the `detectPlants` self-test.
- **Evidence:** `task0-probe-report.json` and `task0-probe-report.md`.

## Probe findings (run 2, CLI 2.1.295, harness only)

| Id | Result | Finding |
|---|---|---|
| P0 | pass | `2.1.295 (Claude Code)` |
| P1 | pass | All 19 pinned flags are listed. `--safe-mode` is no longer pinned (D-B15). `--append-system-prompt-file` is named in the `--bare` help text. |
| P2 | pass | Without `--safe-mode`, the `nexus` server is `connected`. The recorder sees `server/discover, initialize, notifications/initialized, tools/list`. The mock's tool list has `mcp__nexus__context_get`. |
| P3 | pass | The `--settings` deny rule refuses `Read .env` ("denied by your permission settings"), and the secret is not sent. A control run without the rule reads the secret, so the rule is what refused it. |
| P4 | pass | The skills-file canary reaches the system prompt. The stdin preamble reaches the first user message. No plant appears anywhere. |
| CR3+ | pass | **Control run (no locks):** all 21 of 21 plant groups are live, so every plant is proven effective. **Pinned argv:** none load or run. No canary text, model, hook marker, stray MCP request or planted name appears, and the Nexus MCP server is connected. |
| P5 | pass | `system/init` tools are `Edit, Glob, Grep, Read, Write` plus the two `mcp__nexus__*` tools. The Edit succeeds, the MCP call succeeds, and no disallowed tool is offered. |
| P5 names | recorded | Under `--tools default` (without `--restricted`) this build offers `Task, Bash, WebFetch, WebSearch, NotebookEdit`. `Agent` and `PowerShell` do not exist in this build; they stay in the list as a defence. |
| P6 | pass | The `${NEXUS_MCP_TOKEN}` header is env-expanded. The token appears in no argv, no CLI output, and no file under the harness root outside the job dir. |
| P7 | pass | There are 17–19 CONNECTs within 30 s, all to `api.anthropic.com:443`, with no other host and no plain request. The MCP recorder is reached directly. |
| P8 | pass | argv is 637 bytes. A 204,800-byte stdin context arrives intact. |
| P9 | n/a | Controller only, not run. |
| P10 | pass | One pinned turn writes five files (listed below). The MCP token is in none of them. |

**P10: every file written in one pinned turn:**
- `home/.claude.json` (changed)
- `home/.claude/backups/.claude.json.backup.<ts>`
- `home/AppData/Local/claude-cli-nodejs/Cache/<cwd>/mcp-logs-nexus/<ts>.jsonl` (the MCP log under LOCALAPPDATA)
- `tmp/claude/fswatch-probe-*/probe`
- `wt/.claude/settings.local.json` (changed)

The full lists for P10, P5, CR3+ under the locks, CR3+ with a fresh home, and the control run are in `task0-probe-report.md`.

Decisions: P0 `pinned-2.1.x`, P1 `all-pinned-flags`, P2 `mcp-loaded (D-B15)`, P3 `settings-deny-applies`, P4 `isolated`, CR3+ `no-customization-loads`, skillsDelivery `append-system-prompt-file`, P5 `as-pinned`, toolNames (above), mcpHeaderForm `env-expansion`, P7 `proxy-honoured`, P8 `stdin-context`, settingSourcesForm `""`, safeMode `dropped (D-B15)`, P9 `pending:controller`, P10 `recorded`.

## Verification (run 2)

- `node --test test/nexus-core-agent-harness.test.cjs`: 6 of 6 pass.
- `node tools/nexus-agent-probe.cjs --parts A,B`: exits 0, and no STOP branch fires. No `nxh-*` root is left behind.
- `npm run typecheck`: passes.
- `npm run test:focused`: 1308 tests, 11 failures, exactly the 11 in `baseline-fails.txt`.

## Concerns

1. **The CLI writes into the worktree under the locks.** If the user's `~/.claude.json` has a project entry for the worktree path, the CLI migrates its `enabledMcpjsonServers` into `<worktree>/.claude/settings.local.json`, even under `--restricted`. With a fresh home (no project entry) the worktree gets no write. Nexus worktrees are new `<userData>\nexus\wt\<ulid>` paths, so a real entry is unlikely. Even so, the Task 8 change-set validators should refuse or ignore `.claude/**` in the worktree, and CR10 should pin this.
2. **The MCP log.** The CLI writes `LOCALAPPDATA/claude-cli-nodejs/Cache/<cwd>/mcp-logs-nexus/*.jsonl`. Under D-B1 that is the user's real LOCALAPPDATA. The token is not in it, but CR10 and V3 must cover this path, as D-B15 says.
3. **`server/discover`.** The CLI sends `server/discover` before `initialize`. Task 6's server must answer it or return method-not-found, which the CLI accepts.
4. **Tool names.** The subagent tool is `Task` in 2.1.295, while Revision 1 finding 30 says `Agent`. Both are disallowed now.
5. **Admin-managed policy settings** still apply under `--restricted`. A fake home cannot test this.
6. **P-B retries.** When the proxy refuses, the CLI retries up to 10 times, which is about 17–19 CONNECTs in 30 s. The adapter should expect this.
