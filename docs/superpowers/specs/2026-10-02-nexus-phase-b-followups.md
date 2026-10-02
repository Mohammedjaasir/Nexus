# Nexus — Phase B follow-ups recorded at Phase A sign-off

Status: open · Date: 2026-10-02 · Branch: `our-platform`

Phase A (shell, launcher, workspace/project/planned pages, assistant panel) is
complete. These items were deliberately left for Phase B. None of them is
implemented.

## Deferred by decision

1. **Open, extensible `WorkspaceId`.** `nexus/workspaces/types.ts` derives it
   from a closed tuple of eight ids. Phase B needs an open id so that adding a
   workspace is one config entry.
2. **Workspace capability registry in shared code.** The registry lives in the
   renderer (`nexus/workspaces/`). The main-process orchestrator and policy
   engine need workspace capabilities, so the capability part moves to
   `src/shared`.
3. **AgentRuntime / Hermes.** Hermes sits behind `AgentRuntime` in the Nexus
   backend (main process), never in the renderer. The renderer's
   `AssistantPort` talks to the Nexus orchestrator over IPC. The Phase A spec
   note about a renderer `hermesPort.ts` is superseded. The port also needs
   streamed events, approvals, cancel and outputs (it is send-only today).
4. **Artifact backend.**
5. **Handoff backend.**
6. **Deployment backend.**
7. **Hermes sandbox.** Rules from the Step 0 spike: one gateway/profile per
   agent session, Docker as the boundary, network off and enforced, Nexus
   preflight of CPU/memory/PID/network limits, Nexus-owned wall clock,
   approval choices limited to once/deny, pinned Hermes version, Nexus-owned
   skill discovery, real-LLM tool calling verified before Milestone 1.
8. **Phase B data model** (artifacts, versions, lineage, handoffs,
   applications, builds, environments, deployments, sessions, activity,
   memberships).

## Found during Phase A verification (not fixed in Phase A)

- **Lead-agent readiness is optimistic.** The assistant shows "Lead agent"
  as ready from the hive's god status, even when the lead agent's CLI process
  has exited (seen: engine CLI `qwen` not installed, exit code 3).
- **Legacy screens reachable from the Nexus shell still carry the old
  identity.** IDE header "MUNDER DIFFLIN · IDE", the agents floor and cards
  ("Michael" / "BOSS", "Message Michael"), Project Command Center ("Floor
  Office View", "Phase 9A" labels), Settings copy, `index.html` title before
  the shell mounts. The lead agent is named "Michael" in `hooks/useHive.ts`.
- **Legacy Settings modal ignores Escape** (its close button works).
- **`projectDelete` leaves `project_plans` / `project_gaps` /
  `project_goals` rows** behind (orphans).
- **Legacy nested-button warning** in `RealtimeMichaelToggle` / `PixelButton`
  (React `validateDOMNesting`).
- **Recent-project cards are narrow** (four 185px columns at 1440 with the
  assistant open); long names truncate (full name in the tooltip).
- **Below-1280 layouts are unreachable in the desktop window** (`MIN_WIN` is
  1280×800); they were verified with viewport emulation only.
