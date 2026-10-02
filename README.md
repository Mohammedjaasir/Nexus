# Nexus

**An AI-native development platform.** Pick the kind of work you're doing, open a
workspace, and build with AI agents alongside your normal development tools.

> **Status: Phase A (beta).** The shell, the workspace launcher, the workspace
> and project pages and the assistant panel are built and run on real local data.
> Artifacts, handoffs, "Turn into App" and deployments are planned and appear in
> the app as clearly labelled placeholders. Nothing in the UI is simulated.

## What works today

- **Launcher.** "What are you working on?" with workspaces for SDE, ML, DL,
  Data Analytics, Research, QA, UI/UX and DevOps, plus *Your Projects*.
- **Projects.** Create or import a local folder. Nexus analyses it
  deterministically (languages, frameworks, tests, git, a code graph, a repo
  health score) and files it under the matching workspace.
- **Agents.** Run the CLI coding agents you already use (Claude Code, Codex and
  others) in real terminals, coordinated through a local hive with a lead agent.
- **Assistant panel.** Sends requests to the lead agent, with the current
  workspace and project attached as context.
- **Files / IDE, terminals, git history**, skills, MCP servers and integrations.
- **Search** with <kbd>Ctrl</kbd>/<kbd>⌘</kbd>+<kbd>K</kbd> and the assistant with
  <kbd>Ctrl</kbd>/<kbd>⌘</kbd>+<kbd>J</kbd>; light and dark themes.

## Planned

Artifacts with versions and lineage, cross-workspace handoffs, "Turn into App",
builds and deployments, and a sandboxed agent runtime. See
[`docs/superpowers/specs/`](./docs/superpowers/specs/) for the design and the
open follow-ups.

## Development

Requirements: Node.js 18+, npm, and a C/C++ toolchain for the native `node-pty`
addon (Xcode command-line tools on macOS, Visual Studio Build Tools on Windows).
Agents need their own CLIs (for example `claude`) on `PATH`.

```bash
npm install          # postinstall rebuilds node-pty against Electron's ABI
npm run dev          # live-reloading Electron app
npm run typecheck    # node + web TypeScript projects
npm run test:focused # focused test set (includes the Nexus tests)
node --test test/    # full test suite
npm run build        # production build
```

If launch fails with a `NODE_MODULE_VERSION` or "wrong ELF/Mach-O" error, re-run
`npm install` to rebuild `node-pty`.

## Project layout

| Path | Contents |
|---|---|
| `src/main/` | Electron main process: projects, agents and hive, terminals, files, git, skills, integrations, the local database. |
| `src/preload/` | The typed IPC bridge (`window.cth`). |
| `src/renderer/src/nexus/` | The Nexus shell: launcher, workspaces, pages, assistant, command palette. |
| `src/renderer/src/` | Other UI: IDE, terminals, agent views, settings. |
| `src/shared/` | Types and registries shared by main and renderer. |
| `docs/superpowers/` | Specs and implementation plans. |

## Privacy

Official builds send a small set of anonymous usage events (opt-out in
Settings). The full contract is in [`TELEMETRY.md`](./TELEMETRY.md).

## Licence

MIT — see [`LICENSE`](./LICENSE). Nexus is built on an MIT-licensed open-source
agent harness; its copyright notice is kept in `LICENSE`. Some bundled pixel-art
assets are licensed for non-commercial use only — see
[`ATTRIBUTION.md`](./src/renderer/src/assets/ATTRIBUTION.md).
