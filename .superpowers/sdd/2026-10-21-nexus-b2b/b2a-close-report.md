# B2a close: the four open items

Branch `our-platform`. Base: `2cf4061d`. The user approved each decision on 2026-10-21.

Status: **DONE.** There are three commits, one for each item that needed a change. Item 4 needed no change.

| Item | Commit |
|---|---|
| 1. L11 threshold | `fe933d35` fix(nexus): close B2a — L11 asserts p99 < 50 ms and max < 250 ms for exec.list + exec.get |
| 2. Runner restart lease hold | `6761e0c9` fix(nexus): close B2a — a runner restart holds lease expiry until it reconciles, bounded by the reconcile bound |
| 3. Legacy git hardening | `4aec76f6` fix(nexus): close B2a — the legacy git path runs no repository signature program, submodule filter, external diff or textconv; hive resolves git through gitBinary |
| 4. Execution off by default | no change: `V9_ENABLED_BY_DEFAULT = false` (`src/main/db.ts:51`) |

How the commits were made:
- Each commit used an explicit pathspec (`git commit -- <paths>`). Nothing was amended.
- No peer-owned file was edited, staged or committed. The peer's staged rename and deletions, and its unstaged renderer and test changes, are exactly as they were before.
- The real database (`%APPDATA%\munder-difflin`) was not touched, and the app GUI was not run.

## 1. L11 threshold (`fe933d35`)

**Test change** in `test/nexus-exec-lifecycle.test.cjs`, L7's L11 part:
- The bound on the list + get samples is now `pct(calls, 0.99) < 50` **and** `Math.max(...calls) < 250`. It used to be `max < 50`.
- `pct` is the test's existing percentile helper.
- The print-out is kept, and it now includes p99: `# L11 exec.list + exec.get n … p50 … p95 … p99 … max … ms; event-loop lag …`.
- The event-loop lag bounds are unchanged: p99 < 100 ms and max < 500 ms.

**Docs.** No section described L11 before. A new L11 row in `docs/nexus/platform-core.md` §47 records:
- what L11 times;
- the bound;
- why the max-only form was replaced;
- the user ruling.

**Not run against real Docker.** test:exec is gated; see "test:exec" below. For reference, stab-D's round-2 run 3 had p95 57.3 ms, so its p99 was above 50 ms. That run would still fail under the new bound.

## 2. A runner restart holds lease expiry (`6761e0c9`)

### Design

These changes are in main, in `executionService.ts` and `recovery.ts`.

**What starts the hold.** Any of these opens an "outage":
- A tick sees the port not attached, `crashed` or `starting`, after it had seen it `ready`.
- `reconcileList()` is called at a restart that no tick saw, for example a crash and the new runner's `ready` between two ticks.

The outage records:
- `since`: when the scheduler last saw the runner live;
- `held`: the set of live attempts this boot owned at that moment.

Attempts leased later are never held.

**What changes while the hold is on.**
- The sweep does not fail held attempts `runner_lost`.
- Wall clocks still run.
- The heartbeat-gap event is still written.

**When the runner answers.** At its `reconcile.result`, inside `ExecutionService.recoverPhaseB`:
- Before phase B decides, each held attempt that is still live and owned by this boot has its lease moved by the downtime (`now - since`).
- An adopted attempt then still gets exactly one fresh lease from `adoptAttemptTx`.
- An attempt phase B leaves alone keeps only what was left of its lease. An example is a `starting` attempt whose container was never recorded.
- The hold also ends this way when the answer turns out to be malformed.

**A port that is `ready` again with no reconcile request.** This can happen when the send failed, or in tests that drive a fake port. The hold ends the same way, with the extension, because no answer is coming.

**The bound.** It is `runnerOutageHoldEnded` in `recovery.ts`, which reuses `reconcileBoundDue`, anchored at the outage:
- 10 minutes from the later of `since` and the first reconcile request during the outage;
- plus up to 5 more minutes while that request has no answer;
- so at most the first request + 15 minutes.

At the bound the hold is lifted without an extension, and the sweep fails the held attempts `runner_lost` at once, because their leases ran out long before.

**A runner that will not come back.** When the host is `unavailable` (supervision gave up), the hold is lifted at once, without an extension.

**Main restarts need no hold.** A new main process has a new boot id. The old boot's attempts are outside the lease sweep, which only looks at `lease_owner = bootId`. They are already decided by phase B, or failed at the existing reconcile bound. Only the runner-only restart (L13/L14) was exposed.

**`execWiring.ts` and `runnerHost.ts` needed no code change.**
- The host's port state (`crashed` / `starting` / `ready` / `unavailable`) gives the core what it needs.
- So does the wiring's synchronous `exec.reconcileList()` at every `ready`.
- A header note was added to `execWiring.ts` that records this dependency.
- `runnerHost.ts` is unchanged.

**Log lines.**
- `[nexus] exec: the runner is restarting; the leases of N live attempt(s) are held …`
- `… the runner is back after X s (reconciled); N held lease(s) moved by the downtime`
- `… lease hold ended (<why>); N held lease(s) run out`

**Docs.**
- `platform-core.md` §35.8 is new.
- `platform-core.md` §47 has a new "Runner restart" row.
- The wiring row of the test table is updated.
- `RUNNER_RECOVERY_CONTRACT` has one new line.
- The `recovery.ts` and `executionService.ts` headers are updated.

### Tests

The tests are in `test/nexus-platform-exec-wiring.test.cjs` (test:db). They use a fake runner through the real `startRunnerHost` and `startExecution`, with one fake clock for the world, the platform and the timers.

**W9: a 90 s restart keeps a healthy attempt.**
- The runner dies 10 s after the attempt's last heartbeat.
- The host restarts it after 1 s, but the new runner says `ready` only 90 s later, and answers its reconcile 5 s after that.
- The attempt's lease ran out, yet the attempt is still `running`. At the answer it is adopted with exactly `now + LEASE_MS`.
- The new runner then heartbeats and reports the exit. The job is `completed` with one attempt, `succeeded`.

**W10: a runner that never comes back.**
- (a) Restarted but never `ready`: the attempt ends `runner_lost` 10 min after the crash, within -1 s / +2 s.
- (b) `ready` with the reconcile never answered: the attempt ends `runner_lost` at the first request + 15 min, within +2 s. A second `ready` at 12 min asks again, and it does not move the bound. This attempt's wall clock is raised to 1 h, because the build's own 15-minute wall clock would otherwise end it first.
- (c) The host gives up (`unavailable`): the attempt ends `runner_lost` within a lease, long before the bound.

**W11: after the reconcile nothing stays held.**
- A container reported `missing` is `abandoned` at the answer.
- An adopted attempt whose next heartbeat says `missing` fails `container_vanished` at once.
- A `starting` attempt with no recorded container fails `runner_lost` within its remaining lease after the answer (≤ 60 s), not at the bound.

**Proof the tests catch the bug.** With the hold disabled (`const held = false`, a temporary edit that was restored), W9, W10 and W11 all fail.

**Other files that exercise leases.**
- These pass unchanged: recovery (40/40), approvals (54/54), validation (51/51), and wiring H1–W8.
- The scheduler file passes 52/52 on its own rerun. Once it failed C20b, the load-sensitive heartbeat-handler p99 bound (13.91 ms). That is a known load flake (stab-D), and the handler is untouched. The rerun measured p99 0.057 ms, and the full test:db run 0.118 ms.

### Real L13/L14

**Not run.** Docker is running (server 29.7.2), but the test:exec gate refused:

`[test:exec] NOT RUN: free disk 8.3 GiB < 30 GiB at C:\Users\pc\AppData\Local\Docker\wsl …`

C: has about 8.3 GiB free now, not 21 GB. The gate was not bypassed.

## 3. Legacy git hardening (`4aec76f6`)

**`src/main/git.ts`, `runGit`.**
- Every call carries `log.showSignature=false`.
- Every call names `gpg.program`, `gpg.ssh.program` and `gpg.x509.program` as the resolved git binary.
- This is passed as **command-scope config in the call's environment**: `GIT_CONFIG_COUNT`, `GIT_CONFIG_KEY_<n>` and `GIT_CONFIG_VALUE_<n>`, from `configEnv(inertSignatureConfig(bin))`. Entries the caller's environment already holds are kept, and ours are appended after them.
- The approved wording was `-c`. The environment form was used because two existing tests pin the argv, and they must stay unchanged:
  - `nexus-runner-posture` pins the spawn line `spawn(bin, ['-C', cwd, ...SAFE_GIT_CONFIG, ...args], { cwd: path.dirname(bin)`.
  - `nexus-core-final-fix` FF2 pins argv positions 4+ (`['rev-parse', '--is-inside-work-tree']`, and the config query right after `SAFE_GIT_CONFIG`).
  - A `-c` before the subcommand broke FF2. That was observed.
- The effect is the same as `-c`. Live check with git 2.55: the environment entries override a repository's own `log.showSignature=true` and `gpg.program`.
- As belt and braces, `getLog` and `getLogGraph` also pass `--no-show-signature` in their argv. This is after the subcommand, where no test pins it.

**`getStatus`.**
- It adds `--ignore-submodules=dirty`. A submodule's recorded-commit change still shows.
- The worker-worktree checks (`worktreeHasUnintegratedWork`, `worktreeIsGcSafe`) were deliberately left with full status. Ignoring a dirty submodule there could let GC discard work.
- `checkoutRef` uses `getStatus`, so a dirty submodule work tree no longer blocks a checkout. Its recorded-commit change still does.

**Diffs.** `--no-ext-diff --no-textconv` (`NO_DIFF_DRIVERS`) is added to:
- `getDiff` (`show HEAD:<path>`);
- `getFileAtRev` (`show <rev>:<path>`);
- `getCommitFiles` (`diff-tree`);
- `compareRefs` (both modes);
- `worktreeIsGcSafe` (`diff --quiet`). Here a raw comparison is the fail-safe direction: it keeps more.

`resolveCommit` is unchanged. GC4 pins that its body has no diff flags.

**`src/main/gitBinary.ts`.**
- New: `gitBinaryCandidates` (pure). `resolveGitBinary` now uses it, with the same order and filters.
- New: `inertSignatureConfig`, `configEnv`, `NO_DIFF_DRIVERS`.

**`src/main/hive.ts`.**
- `git()` resolves the binary from `gitBinaryCandidates()`. It checks them with `statSync`, because hive's git is synchronous.
- It keeps a found binary, and drops it on ENOENT.
- It then calls `spawnSync(bin, …)` with the same args, cwd, encoding and timeout as before. No git found returns `{ ok: false }`, as a failed `spawnSync('git')` did.
- The main-posture count of one `spawnSync` in hive.ts is unchanged.

**New tests** in `test/nexus-platform-exec-git-config.test.cjs` (test:db). Each one first proves the planted program runs under plain git (the control).
- **GC5:** with `log.showSignature=true` and all three gpg programs planted, `getLog` and `getLogGraph` run none of them, and they still parse the signed commit.
- **GC6:** a submodule's own clean filter does not run through `getStatus`. The superproject's untracked file still shows, and so does a submodule commit change.
- **GC7:** with `diff.external`, `diff.evil.command` and `diff.evil.textconv` planted, none runs through `getDiff`, `getFileAtRev`, `getCommitFiles`, `compareRefs` (two/three) or `worktreeIsGcSafe`. All of their answers are checked.
- **GC8:** pins the environment config, the diff flags on every diff/diff-tree/show call, the `--no-show-signature` on both log calls, and hive's resolution (no `git` by name, `spawnSync(bin, …)`). It also checks that the candidate order equals `resolveGitBinary`'s.

**What the tests show against HEAD's `git.ts`.** GC5, GC6 and GC8 fail there. GC7 passes either way: as stab-C found, today's argv shapes never triggered drivers, so the flags are future-proofing, and GC8 pins them.

**Existing git tests stay green, unchanged:**
- `nexus-core-git-binary`, `nexus-runner-posture`, `nexus-core-final-fix` (FF2), `nexus-main-posture`, `hive-*`, `nexus-local-servers` and `nexus-main-copy`: 106 pass, 2 skipped.
- GC1–GC4.
- `nexus-platform-user-saves`: 22/22.
- `nexus-platform-exec-validation`: 51/51.

**Docs.** `platform-core.md` §16 item 34 is rewritten as closed, and the §46 row 34 is updated.

## 4. Execution stays off by default

`src/main/db.ts:51`: `export const V9_ENABLED_BY_DEFAULT = false;`. No commit in this round touches it.

## Verification (each in its own call, after the three commits)

| Check | Result |
|---|---|
| `npm run typecheck` | exit 0 (node + web) |
| `npm run test:db` | **35/35 files passed** (C20b handler p99 0.118 ms) |
| `npm run test:focused` | 1306 tests, 1293 pass, 11 fail, 2 skipped. The 11 failures are exactly the baseline |
| `node --test test/` | 1500 tests, 1451 pass, 11 fail, 38 skipped. The failures are **identical** to `baseline-fails.txt` (diff empty) |
| `test/nexus-identity-guard.test.cjs` | 11/11 pass |
| `npm run test:exec` | **NOT RUN**: disk gate, 8.3 GiB free < 30 GiB. Docker was running |

**About `node --test test/`.** The active nvm Node is now v22.23.3. Given `test/`, it tries to load it as a module, which is one failing "test", from both Git Bash and PowerShell. The baseline was taken with directory semantics, so the suite was run with the installed v20.20.2 binary by its path: `C:\Users\pc\AppData\Local\nvm\v20.20.2\node.exe --test test/`. No global nvm switch was made.

## Concerns

- **Real L13/L14 and L7 were not run** (disk gate). The hold is proven with a fake runner only. A real-Docker L13/L14/L7 run is still owed once there is 30 GiB free.
- **The legacy signature hardening uses the environment, not `-c`.** It is equivalent (command scope), but it relies on git ≥ 2.31 for `GIT_CONFIG_COUNT`. On an older git, the `--no-show-signature` on the two log calls still covers the measured log path, but the gpg program overrides would not apply.
- **Behaviour notes for item 2.**
  - A held attempt can now outlive its 60 s lease by up to the bound (first request + 15 min) when the runner is restarting and never comes back. That is the approved trade.
  - A runner that is `ready` but never answers its reconcile holds only the attempts the dead runner had, never new ones.
- **Behaviour note for item 3.** Because `getStatus` now ignores dirty submodule work trees, `checkoutRef` no longer refuses on uncommitted changes inside a submodule. A submodule's recorded-commit change still blocks it.
- **Load-sensitive bounds remain.** C20b failed once under load in a targeted run, and passed on rerun and in the full test:db.
- **The machine's disk is low.** C: had 8.3 GiB free.
