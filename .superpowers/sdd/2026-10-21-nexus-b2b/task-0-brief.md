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

