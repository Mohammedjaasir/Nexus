# Handoff — continue B2b on another machine (2026-10-21)

Branch `our-platform`. B0a–B2a done and verified; B2a closed at 4aec76f6.

## Where things stand
- **B2b plan:** `b2b-plan.md` (Revision 1, 18 tasks, base 4aec76f6). `b2b-plan-rev0.md` is the older text the revision refers to.
- **Binding user decisions:** `b2b-user-decisions.md`, covering D-B1 to D-B14.
- **Architecture:** `architecture-b2.md`, recovered from the session transcript (pre-review version; the code wins on conflicts).
- **Pre-flight review:** `b2b-plan-review.md`. Every finding in it is resolved in the plan's "Revision 1" section.
- **Execution ledger:** `progress.md`. Task 0 was dispatched and then stopped for the machine move. Nothing of Task 0 is committed. Two half-written helpers, `test/helpers/mockModel.cjs` and `test/helpers/proxyRecorder.cjs`, were left uncommitted on the old laptop. Restart Task 0 from its brief, `task-0-brief.md`.
- **B2a history and rulings:** `../2026-10-08-nexus-domains/` (progress.md, b2a-user-brief.md with the 15 constraints, baseline-fails.txt with the 11 known Windows failures).

## Standing rules
- **Phase gating:** build B2b one phase at a time: plan → build → verify → report → STOP.
- **Execution default:** `V9_ENABLED_BY_DEFAULT` stays false until B2b is verified.
- **The real database stays on the old laptop.** It is at schema v9, in %APPDATA%\munder-difflin. Backups: `backups\manual-pre-v9-20261011-004622.db` (sha256 3b335497…a461) and `backups\harness-v8-20261010T191840Z.db` (970bb7b8…0e07). A new machine starts with an empty database.
- **Never launch the app on the real database without the user asking.** Click-throughs use a scratch `--user-data-dir`.
- **No appId/productName/userData rename.** dataDir.ts pins dev userData to %APPDATA%\munder-difflin.
- **Never bypass permissions.** Commit by explicit pathspec, no amend, rebase or force, and don't touch `main`.
- **Peer-owned files** (another session's uncommitted work, not on this branch): App.tsx, RouteView.tsx, uiStore.ts, nexus/start/*, WelcomePage.tsx, start.css, welcome.css, hairline/*, test/nexus-start.test.cjs.

## New machine setup
- `npm ci`, then `npm run build`.
- Docker Desktop, with the three images rebuilt via `node tools/nexus-prepare-images.cjs --build`. `lock.json` pins them, including the socat .apk sha256.
- At least 30 GiB free (40 recommended) for `npm run test:exec`.
- The Claude CLI must be installed and logged in for the B2b real-login steps (controller-only, with the user's go-ahead).
- Run `node --test test/` with Node 20; Node 22 treats `test/` as a module path.
