# Nexus — Phase A specification

Status: draft for review · Date: 2026-10-01 · Branch: `our-platform`
Scope: the Nexus shell, the launcher (Home), workspace/project/placeholder pages, and the assistant panel. No new backend.

---

## A. Product specification

**Goal.** Opening the app should make one idea obvious: *pick the kind of work → enter that workspace → work with your projects and agents.* Phase A delivers the frame and the front door of that loop on top of what really exists today. The frame is navigation, search and the assistant. The front door is the island launcher.

**The product loop, and where Phase A sits in it**

| Stage | Phase A |
|---|---|
| Launcher | ✅ built: island stage, workspace hotspots, recent projects |
| Workspace | ✅ built: workspace page listing the real projects that map to it |
| Project | ✅ routed to the existing Project Command Center (unchanged) |
| Artifact | ⬜ honest placeholder page (backend is a later phase) |
| AI / Agent | ✅ assistant panel → the real lead agent; Agents view = the existing floor and terminals |
| Handoff, Turn into App, Deploy | ⬜ honest placeholder pages; quick actions are visibly disabled |

**Principles**
1. **Real or absent.** Every number, name and list on screen comes from real data, or the element is not rendered. There are no avatars, users, notification counts or invented metrics.
2. **Disabled, not faked.** Features without a backend appear as disabled controls or as explained empty states, each labelled *Not available yet*.
3. **Registry-driven.** Workspaces are data. Adding one means adding an entry, not editing the shell.
4. **Provider-agnostic AI.** The assistant UI talks to an `AssistantPort`. Phase A's only implementation is the lead agent. A future Hermes agent becomes another port, not a rewrite.
5. **Original identity.** "Nexus" uses `--nx-*` tokens: a deep-navy frame, light content cards and a blue→violet signature gradient used sparingly. None of the retired pixel/cream language carries over.
6. **Inner screens untouched.** The Project Command Center, IDE, terminals, task overlay, settings and agent strip are hosted by the shell, not redesigned.

**Out of scope:** artifact/handoff/deployment backends, Hermes, the final 3D art, redesigning inner screens, accounts, notifications, and renaming the product or appId.

---

## B. Screen-by-screen UX

### B1. Shell (every screen after onboarding and the hive picker)

**Top bar (56px, drag region)**
- **Left:** Nexus mark and wordmark, plus a "Beta" pill. On macOS, 80px of left padding clears the traffic lights.
- **Centre:** a search field showing "Search projects, workspaces, pages…" with a `Ctrl K` / `⌘K` hint. Clicking it or pressing the shortcut opens the command palette (B9).
- **Right:** theme toggle (sun/moon), assistant toggle (only shown below 1280px), settings.
- No bell and no avatar.

**Left sidebar (240px)**
- **Main group:**
  - Home
  - Workspaces
  - Projects
  - Artifacts
  - Handoffs
  - Deployments

  The last three carry a small "Soon" tag.
- **"Resources" group:**
  - **Files:** opens the existing IDE overlay. This is an action, not a route.
  - **Agents:** the Agents view, which is the legacy floor.
  - **Integrations:** opens Settings on *Connections*.
  - **Settings:** opens Settings.
- **Setup card** (B7) sits at the bottom of the sidebar.
- **Active item:** filled pill in `--nx-nav-active` with an accent bar on the left.
- **Hover:** subtle fill.
- **Focus:** visible ring.

**Right assistant panel (360px)** — see H.

**Global overlays** stay mounted by `App.tsx` exactly as today:
- AddAgent, Settings, Quit, FullscreenTerminal, FullscreenFileEditor, IDE, TaskDetail, ProjectDashboard, NewProjectWizard
- Update and completion toasts

### B2. Home (launcher) — `#/`

1. **Heading:** "What are you working on?", with "working on?" in the signature gradient. Subtitle: "Choose a workspace and start building with your agents."
2. **Island stage.** This is the launcher itself, not a decorative background.
   - **Background:** the art image if present, otherwise the placeholder (sky gradient, soft drifting clouds, and a faint CSS "island" platform under each hotspot).
   - **Hotspots:** one per workspace, plus the **Your Projects** shortcut at the centre. Each is a card with:
     - an icon tile in the workspace hue
     - the label and a chevron
     - a tagline (e.g. "Code · APIs · Build")
     - a count chip ("3 projects") **only if count > 0**, computed from real projects
   - **States:**

     | State | Behaviour |
     |---|---|
     | Idle | Gentle 3px float, staggered per card, 6s ease-in-out. Off under `prefers-reduced-motion`. |
     | Hover / focus | Lifts 4px, ring in the workspace hue, its island platform brightens, tooltip shows the full description. |
     | Pressed | Scales to 0.98. |
     | Click / Enter | Navigates to `#/w/<id>` and records it as the last chosen workspace. |

   - **Keyboard:**
     - The stage is one tab stop with a roving tabindex.
     - Arrow keys move between hotspots by nearest position.
     - Home/End jump to the first and last hotspot.
     - Enter/Space opens the focused one.
3. **Recent projects row**, with the heading "Recent projects" and a chevron linking to `#/projects`.
   - Shows up to 4 real projects, ordered by `updatedAt` descending.
   - **Each card shows:**
     - workspace icon and project name
     - "<Workspace> workspace", or "Unassigned workspace" when the domain doesn't map
     - relative "Updated 2h ago" from `updatedAt`
     - a **Repo health** bar from `health.healthScore`, labelled "Repo health 75" with a tooltip: "Heuristic from tests, docs, entry points and git status (project analyzer)". It's hidden if the field is missing or not a number.
   - **Card menu** (⋯): "Open", "Open in Agents view" (makes it the active project), "Refresh analysis" (the real `projectRefresh`).
   - **Click:** goes to `#/p/<id>`.

### B3. Workspaces — `#/workspaces`
- A grid of all registry workspaces: icon, label, description, real project count, and the domains it covers (e.g. "software-engineering, web-app-dev, …").
- Clicking a card goes to `#/w/<id>`.

### B4. Workspace page — `#/w/<id>`
- **Header:** icon, label, description, and a "New project" button that opens the existing NewProjectWizard preset to `defaultDomainId`.
  - Workspaces without a default domain (QA, UI/UX) open the wizard without a preset.
- **"Projects in <Workspace>" list:** real projects whose `domainId` maps here. Each row shows name, root path, domain, updated time, and repo health if present. Clicking a row goes to `#/p/<id>`.
- **"Coming to this workspace" strip:** the workspace's planned modules from the registry (e.g. ML: Datasets, Experiments, Models), shown as muted chips with "Planned". They are not clickable.
- **Empty state:**
  - Mapped workspaces: "No <Workspace> projects yet" plus New project and Import buttons.
  - QA and UI/UX: "Projects are grouped by the domain the analyzer detects. QA and UI/UX projects will arrive through handoffs in a later phase." plus a link to all projects.

### B5. Projects — `#/projects`
- **Toolbar:** text filter, workspace filter (All, each workspace, Unassigned), "New project" (the wizard), "Import" (the existing import modal).
- **Table/list:** name, workspace, domain, root path, updated, repo health (if present).
- **Click:** goes to `#/p/<id>`.

### B6. Project — `#/p/<id>`
- Calls `projectSetActive(id)` (real) and stores the result as `activeProject`, then renders the **existing** `ProjectCommandCenter` unchanged.
  - `onBackToHome` navigates back.
  - `onRefreshProject` calls the real refresh.
- **Unknown id:** an error state with a link back to Projects.

### B7. Setup card (sidebar) — guided setup, not gamification
- **Title:** "Get set up". A small "2 of 4" count, with no ring, percentage or confetti.
- **Steps**, each with a status icon and an action link:

  | Step | Done when | Action | Status in Phase A |
  |---|---|---|---|
  | Choose a workspace | A workspace has been opened at least once (`nx.lastWorkspace` is set) | Go to Home | Can complete |
  | Create or import a project | `projects.length > 0` | Open the wizard | Can complete |
  | Register an artifact | — | — | Locked, "Available in a later phase" |
  | Deploy an app | — | — | Locked, "Available in a later phase" |

- Once both available steps are done, the card collapses to a single line: "Setup complete for now · 2 steps arrive later". The user can dismiss it, and that preference is stored locally.

### B8. Artifacts / Handoffs / Deployments — `#/artifacts`, `#/handoffs`, `#/deployments`
Each is an honest explainer page (details in J).

### B9. Command palette (Ctrl/⌘K)
- A modal with a text input, plus results grouped as Pages, Workspaces and Projects (real).
- Arrow keys move, Enter opens, Esc closes.
- Pages include actions: "New project", "Open Files (IDE)", "Open Settings".
- **No results:** "Nothing matches '<q>'".

### B10. Agents — `#/agents`
- The existing floor view, moved verbatim out of `App.tsx`: OfficeFloor, MemoryPanel, empty/booting overlays, splitter, AgentDetailPanel sidebar, and the **AgentStrip**.
- The AgentStrip only renders on this route.

---

## C. Component architecture

```
src/renderer/src/nexus/
  NexusShell.tsx            frame: TopBar + Sidebar + <RouteView> + AssistantPanel; responsive classes
  routes/RouteView.tsx      switch on parsed route → page component
  router/
    routes.ts               PURE: Route union, parseHash(), formatRoute()  (unit-tested)
    useRoute.ts             hook: subscribes to hashchange, navigate()
  workspaces/
    types.ts                WorkspaceConfig, LauncherShortcut, PlannedModule
    registry.ts             WORKSPACES[], LAUNCHER_SHORTCUTS[], UNMAPPED_DOMAINS
    mapping.ts              PURE: workspaceForDomain(), projectsForWorkspace(), countsByWorkspace()
  data/
    useProjects.ts          loads projectList via window.cth, loading/error state, refresh()
    selectors.ts            PURE: recentProjects(), repoHealth(), relativeTime(), setupSteps()
  assistant/
    port.ts                 AssistantPort interface + types
    leadAgentPort.ts        implementation over useStore (god agent + enqueueMessage)
    context.ts              PURE: buildContextHeader(route, workspace, project)
    prompts.ts              quick actions + suggestion templates (data)
    AssistantPanel.tsx      UI (consumes a port via hook useAssistant())
  launcher/
    HomePage.tsx            heading + IslandStage + RecentProjects
    IslandStage.tsx         stage, art/placeholder, hotspots, roving focus
    WorkspaceHotspot.tsx    one card
    hotspotNav.ts           PURE: nextHotspot(current, direction, positions)
    RecentProjects.tsx
  pages/
    WorkspacesPage.tsx  WorkspacePage.tsx  ProjectsPage.tsx  ProjectPage.tsx
    PlannedPage.tsx         shared honest empty-state template (Artifacts/Handoffs/Deployments)
    AgentsView.tsx          legacy floor + sidebar + AgentStrip (moved from App.tsx)
  chrome/
    TopBar.tsx  Sidebar.tsx  SetupCard.tsx  CommandPalette.tsx  MobileNav.tsx
  ui/                       Nexus primitives (class-based)
    Button.tsx  IconTile.tsx  Badge.tsx  EmptyState.tsx  Skeleton.tsx  Sheet.tsx   (cards/tooltips are CSS classes)
  iconNames.ts              PURE: icon vocabulary + hues
  icons.tsx                 the lucide glyph map + <Icon> (single import surface)
  state/prefs.ts            PURE: nx.-prefixed localStorage that never throws
  state/uiStore.ts          small zustand store for shell UI state
  chrome/paletteIndex.ts    PURE: command palette index and search
  styles/
    tokens.css              --nx-* (light + dark)
    shell.css  launcher.css  pages.css  assistant.css  ui.css
  assets/                   launcher-islands.{webp,png} (optional; supplied later)
```

**Boundaries**
- **Pure modules** (`routes.ts`, `mapping.ts`, `selectors.ts`, `context.ts`, `hotspotNav.ts`, `registry.ts`) import nothing from `@/` or React. They are unit-testable through the existing `test/load-ts.cjs`, which resolves relative paths and `@shared/`.
- **`App.tsx`:**
  - keeps config loading, `useHive`, the hive picker and onboarding gates, PTY reconcile, quit handling and the global overlays
  - replaces its title bar and main area with `<NexusShell>`
  - moves the floor JSX into `pages/AgentsView.tsx`
- **Shell → App callbacks** (typed `ShellActions`): `openSettings(section?)`, `openNewProject(domainId?)`, `openImport()`, `openIde()`. App owns the modals.
- **Legacy components** (`Pixel*`) are only used inside legacy views. Nexus code never imports them.

---

## D. State and data requirements

| State | Owner | Persistence | Source |
|---|---|---|---|
| Current route | `useRoute` (hash) | URL hash | user navigation |
| Projects list | existing store `projects` + `useProjects` loading/error | SQLite via `projectList` | real |
| Active project | existing store `activeProject` | SQLite via `projectSetActive` | real |
| Agents, lead agent, queues | existing store | existing | real |
| Assistant open (compact layouts) | `nexus/state/uiStore.ts` (small zustand) | none | UI |
| Sidebar compact preference | `nexus/state/uiStore.ts` | localStorage `nx.sidebarCompact` | UI |
| Last chosen workspace | `nexus/state/uiStore.ts` | localStorage `nx.lastWorkspace` | user action |
| Setup card dismissed | `nexus/state/uiStore.ts` | localStorage `nx.setupDismissed` | user action |
| Assistant draft | `nexus/state/uiStore.ts` | none | UI |

- **New IPC:** none. **New backend:** none.
- **localStorage:** every access is wrapped in try/catch, with the `nx.` prefix. The existing "reset & start over" clears only `cth.` keys, so the plan extends that clear to `nx.` keys too (one-line change in SettingsModal).

---

## E. Workspace configuration structure

```ts
// nexus/workspaces/types.ts
export interface WorkspaceConfig {
  id: WorkspaceId;                 // 'sde' | 'ml' | 'dl' | 'data' | 'research' | 'qa' | 'uiux' | 'devops'
  label: string;                   // 'SDE'
  name: string;                    // 'Software Engineering'
  tagline: string;                 // 'Code · APIs · Build'
  description: string;             // one sentence for tooltips/pages
  icon: NexusIconName;             // key into nexus/icons.ts
  hue: HueToken;                   // 'violet' | 'blue' | 'orange' | 'teal' | 'green' | 'amber' | 'pink' | 'slate'
  domainIds: DomainId[];           // which analysed domains count as this workspace (may be empty)
  defaultDomainId?: DomainId;      // preset for "New project" (omitted → no preset)
  island: { x: number; y: number }; // hotspot centre, % of stage (0–100)
  order: number;                   // grid/list order and keyboard fallback order
  plannedModules: string[];        // e.g. ['Datasets','Experiments','Models'] — displayed as "Planned"
}
export interface LauncherShortcut { id: 'projects'; label: string; icon: NexusIconName; route: Route; island: {x:number;y:number}; }
```

**Phase A registry**

| id | label | tagline | domainIds | default | hue |
|---|---|---|---|---|---|
| sde | SDE | Code · APIs · Build | software-engineering, web-app-dev, mobile-dev, game-dev, embedded-systems, robotics-iot, blockchain-web3, automation-rpa | software-engineering | violet |
| ml | ML | Datasets · Models · Deploy | ai-ml | ai-ml | blue |
| dl | DL | Training · Experiments | computer-vision | computer-vision | orange |
| data | Data Analytics | Dashboards · Insights | data-analytics, data-science, gis-geospatial | data-analytics | teal |
| research | Research | Explore · Innovate | research-scientific | research-scientific | green |
| qa | QA | Test · Automate | — | — | amber |
| uiux | UI / UX | Design · Prototype | — | — | pink |
| devops | DevOps | Deploy · Monitor | devops-cloud | devops-cloud | slate |
| *(shortcut)* projects | Your Projects | — | — | — | — |

- `UNMAPPED_DOMAINS = ['cybersecurity']`. Projects in that domain show as "Unassigned" in Projects. They're never hidden.
- **Invariants, enforced by a unit test:**
  1. ids are unique
  2. every `DomainId` is mapped to exactly one workspace or listed in `UNMAPPED_DOMAINS`
  3. `defaultDomainId ∈ domainIds`
  4. island coordinates are within 10–90 and no two hotspots are closer than a minimum distance
  5. every icon key exists

**Adding a domain later:** add one registry entry (and an icon key if it's new). The launcher, Workspaces grid, palette, filters and mapping pick it up automatically. If the stage gets crowded, the island coordinates are the only layout decision to make.

---

## F. Responsive behaviour

| Width | Layout |
|---|---|
| ≥ 1280 | Sidebar 240 · main · assistant 360 (persistent) |
| 900–1279 | Sidebar becomes a 64px icon rail with tooltips; it expands as an overlay on hover/focus or via the toggle. The assistant becomes a right **sheet** (toggle button, Ctrl/⌘J, Esc closes, focus is trapped). The island stage stays. |
| 640–899 | Rail as above. The **island stage is replaced by a workspace grid** (2–3 columns of the same hotspot cards, same states). Recent projects go to 2 columns. |
| < 640 | No sidebar. A **bottom navigation bar** (Home, Projects, Agents, Assistant) with 56px targets and safe-area padding. The top bar keeps the wordmark, a search icon and settings. The assistant opens full-screen. Single-column grid and lists. The setup card moves to the top of Home. |

- Breakpoints live once in `styles/tokens.css` as comments and are used consistently in media queries.
- Container queries are used inside cards so they look right in the sheet and in the main column.
- There's no horizontal page scroll at any width, and all touch targets are at least 44px.

---

## G. Routing specification

The router is hash-based (`location.hash`), so it works under Electron's `file://` and the Vite dev server.

```ts
type Route =
  | { name: 'home' }                          // #/
  | { name: 'workspaces' }                    // #/workspaces
  | { name: 'workspace'; id: WorkspaceId }    // #/w/:id
  | { name: 'projects' }                      // #/projects
  | { name: 'project'; id: string }           // #/p/:id
  | { name: 'artifacts' } | { name: 'handoffs' } | { name: 'deployments' }
  | { name: 'agents' }                        // #/agents
  | { name: 'not-found'; path: string };
```

- `parseHash(hash)` and `formatRoute(route)` are pure. They round-trip and URL-decode ids.
- An unknown workspace id returns `not-found`.
- An empty hash returns `home`.
- `navigate(route)` sets `location.hash`, so back/forward work.
- Changing routes resets main-pane scroll and moves focus to the page `<h1>` for screen readers.
- **Files, Integrations and Settings are actions, not routes.**
- The old `mainView` state in `App.tsx` is removed. `'project'` becomes `#/p/<activeProject.id>` and `'agents'` becomes `#/agents`.
- The second-window (`window:newFloor`) path is unchanged.

---

## H. AI assistant behaviour

```ts
// nexus/assistant/port.ts
export interface AssistantTarget { id: string; name: string; kind: 'lead-agent' | (string & {}) }
export type AssistantStatus =
  | { state: 'unavailable'; reason: string }                 // no lead agent
  | { state: 'starting'; target: AssistantTarget }           // booting: sends still queue to it
  | { state: 'ready'; target: AssistantTarget; deliveryPaused: boolean };
export type SendResult = { ok: true; target: AssistantTarget } | { ok: false; error: string };
export interface AssistantPort {          // obtained via the hook useAssistant()
  status: AssistantStatus;
  send(input: { text: string; contextHeader: string | null }): SendResult;
  openConversation(): void;               // where replies appear
  replyHint: string;                      // e.g. "Replies appear in the lead agent's terminal in Agents."
}
```

**`leadAgentPort` (Phase A's only implementation)**
- **Target:** the agent with `isGod` in the store, i.e. the existing lead agent.
- **Status:**
  - `starting` while `godStatus === 'booting'`
  - `unavailable` if there's no lead agent
  - `ready` otherwise, with `deliveryPaused` read from `window.cth.controlSnapshot(godId).autoDeliveryPaused`, polled every 2s exactly as `MessageQueueComposer`'s `useDeliveryPaused` does
- **`send`:** calls the existing `enqueueMessage(godId, text, { instruction })`.
  - `text` is what the queue and cards show: the user's words.
  - `instruction` is what gets typed into the agent's terminal: the context header plus the user's words.
  - Delivery, pausing, release and compaction rules all stay the existing queue's behaviour.
- **`openConversation`:** navigates to `#/agents` and selects the lead agent, so its terminal is visible.

**Context header** (pure `buildContextHeader`; one line, only real facts):
```
[Nexus context — workspace: ML · project: fraud-detector (C:\repos\fraud-detector) · page: Home]
```
- It appears in the panel as removable **chips** (workspace and project). Removing a chip drops that part.
- With no workspace or project, the header is omitted.

**Panel UI, top to bottom**
1. Header: "Assistant", the target ("Lead agent · <name>"), and a status dot. The ⋯ menu offers "Open conversation in Agents".
2. Greeting: time-of-day greeting from the local clock ("Good morning"), then "Ask your lead agent to plan, build or fix something." No invented user name.
3. **Quick actions** (four cards):

   | Card | Behaviour |
   |---|---|
   | Create a new project | **Real:** opens the wizard |
   | Analyze a dataset | **Real:** fills the composer with a template; the user edits and sends |
   | Turn a model into a web app | **Disabled**, badge "Not available yet", tooltip naming the later phase |
   | Deploy an application | **Disabled**, same treatment |

4. **Suggested prompts** (templates that only fill the composer):
   - "Train a model on the latest dataset in this project"
   - "Create an API endpoint for this project's model"
   - "Design a landing page for this project"
   - "Run the tests and fix any failures"

   "View all" expands the full list from `prompts.ts`.
5. **Last sent:** an inline confirmation after sending, e.g. "Queued for Michael · delivered when ready" or "· delivery paused — release it in Agents", plus an "Open conversation" link. Replies are **not** shown in the panel in Phase A, because the agent's words live in its terminal. The panel says this rather than imitating a chat transcript.
6. **Composer:** a textarea ("Ask your lead agent…"), Enter to send, Shift+Enter for a newline, and a send button. Attachments and web buttons from the mockup are **omitted** (no backend).

**Disabled and blocked conditions**

| Status | Behaviour |
|---|---|
| `unavailable` | Composer disabled. Message: "No lead agent is running" with a button "Open Agents". |
| `starting` | Composer enabled. Messages queue as they do today. A notice says they'll be delivered once it's ready. |

**Hermes later:** implement `AssistantPort` in `nexus/assistant/hermesPort.ts` and select the port in one place (`useAssistant()`). The panel UI doesn't change.

---

## I. Real-data mapping

| UI element (mockup) | Phase A source | Rendered when |
|---|---|---|
| Wordmark "Nexus · Beta" | static brand (UI only) | always |
| Search | registry + `projects` + page list | always |
| Notification bell / dot | — | **omitted** |
| User avatar / menu | — | **omitted** |
| Workspace hotspots | `WORKSPACES` registry | always |
| Hotspot project count | `countsByWorkspace(projects)` | count > 0 |
| Recent project name / root | `Project.name`, `rootPath` | always |
| Recent project workspace label | `workspaceForDomain(Project.domainId)` | always ("Unassigned" fallback) |
| Recent project time | `Project.updatedAt` | always |
| Recent project progress bar | `Project.health.healthScore`, labelled **Repo health** | field is a finite number 0–100 |
| Recent project team avatars | — | **omitted** |
| Setup progress | `nx.lastWorkspace`, `projects.length` | always (2 locked steps) |
| Assistant target / status | store `agents` (isGod), `godStatus`, `controlSnapshot(godId).autoDeliveryPaused` | always |
| Assistant greeting time | local clock | always |
| Suggested items | `prompts.ts` templates (fill composer only) | always |
| "Need help?" card | focuses the assistant composer | always (no robot art) |

---

## J. Empty, loading and error states

| Surface | Loading | Empty | Error |
|---|---|---|---|
| Recent projects | 4 skeleton cards (shimmer off under reduced motion) | "No projects yet" + New project / Import | "Couldn't load projects" + Retry (calls `projectList` again) |
| Projects page | skeleton rows | "No projects yet. Create one or import an existing folder." + actions | same as above |
| Workspace page | skeleton rows | mapped: "No <WS> projects yet" + actions · QA/UI-UX: domain explanation (B4) | same |
| Project page | "Opening <name>…" | — | unknown id → "That project isn't in your list" + Back to Projects; `projectSetActive` failure → message + Retry |
| Hotspot counts | not shown until loaded | not shown | not shown |
| Island art | placeholder renders immediately; art fades in on load | placeholder | art failed to load → placeholder silently |
| Command palette | — | "Nothing matches '<q>'" | — |
| Assistant | — | — | `unavailable` notice (H); send failure → inline error under composer, draft kept |

**Planned pages** (one `PlannedPage` template: title, a "Planned · not available yet" badge, "What this will do", "How it fits", "What you can do today"):
- **Artifacts:** "Datasets, models, APIs, dashboards and designs as versioned objects tied to real files in your projects." Today: "Your agents' outputs are files in your projects. Open Files or a project."
- **Handoffs:** "Send an artifact version from one workspace to another with a request, then track it to delivery." Today: "Ask your lead agent to coordinate work between agents."
- **Deployments:** "Build, run and publish what you made, with environments, logs and rollback." Today: "Build and test commands can be run by your agents inside a project."

---

## K. Implementation plan (summary)

The detailed, step-by-step plan is in `nexus-phase-a-plan.md`. Phases, each one or more commits:

1. **Foundation:** add `lucide-react` (verified absent), `--nx-*` tokens, `ui/` primitives, `icons.ts`.
2. **Pure core + tests:** routes, registry, mapping, selectors, hotspotNav, context header.
3. **Shell:** NexusShell, TopBar, Sidebar, MobileNav, RouteView. Move the floor into `AgentsView`. Rewire `App.tsx` (remove the interim bar and `mainView`). Agents and Project routes work.
4. **Launcher:** HomePage, IslandStage (placeholder art and optional real art), hotspots and keyboard nav, RecentProjects.
5. **Pages:** Workspaces, Workspace, Projects, Project, PlannedPage ×3, SetupCard.
6. **Assistant:** port, leadAgentPort, AssistantPanel, quick actions and prompts, sheet behaviour.
7. **Command palette** (Ctrl/⌘K) and Ctrl/⌘J.
8. **Responsive pass, accessibility pass, de-slop audit;** browser-preview fallback updated for screenshots.
9. **Verification:** typecheck, focused and full tests, build, screenshots at 1440, 1100, 800 and 390, and a dev-run log check.

---

## L. Testing plan

- **Unit tests** (node:test via `load-ts.cjs`, new `test/nexus-*.test.cjs`, added to `test:focused`):
  - `routes`: parse/format round-trip for every route, decoding, unknown → not-found, empty → home.
  - `registry`: the invariants in E (complete domain coverage, unique ids, defaults within mapping, coordinate bounds and spacing, icon keys).
  - `mapping`: `workspaceForDomain` for every DomainId; `countsByWorkspace`; unassigned handling.
  - `selectors`:
    - `recentProjects` (sort, limit 4, stable on ties)
    - `repoHealth` (returns null for a missing, NaN or out-of-range value, so the bar never renders without a real score)
    - `relativeTime` boundaries
    - `setupSteps` states
  - `hotspotNav`: directional movement picks the nearest hotspot in the given direction and wraps sensibly.
  - `context`: the header includes only provided facts and is omitted when empty.
- **Static:** `npm run typecheck`.
- **Regression:** `npm run test:focused` and `node --test test/` must keep exactly the current 11 pre-existing failures (Windows path tests) and no new ones.
- **Build:** `npm run build`. Then check that the production bundle has no browser-fallback sample data, no Pixel* import from `nexus/`, and no old palette hexes in `nexus/`.
- **Visual and responsive:** a scratch Electron script loads the Vite renderer in the browser-preview mode and captures PNGs at 1440×900, 1100×800, 800×900 and 390×844, in light and dark. I'll review them and share them with you.
- **Behaviour in the real app:** `npm run dev` with `ELECTRON_RUN_AS_NODE` unset. Check the main and renderer logs for errors. Click-through (hotspot → workspace → project → command center, Agents view, Files → IDE, assistant send → queue) needs **you to close your running instance first**, because the single-instance lock blocks a second one.
- **Accessibility:**
  - keyboard-only walk-through (Tab order, roving focus on the stage, Esc closes sheet and palette)
  - visible focus everywhere
  - contrast of `--nx-*` pairs verified numerically (≥ 4.5 text, ≥ 3 UI)
  - reduced motion verified

---

## M. Files expected to change

**New**
- `src/renderer/src/nexus/**`: about 40 files, per the tree in C.
- `test/nexus-routes.test.cjs`, `test/nexus-registry.test.cjs`, `test/nexus-selectors.test.cjs`, `test/nexus-hotspot-nav.test.cjs`, `test/nexus-context.test.cjs`

**Modified**
- `src/renderer/src/App.tsx`: interim bar, `mainView` and floor JSX removed; renders `<NexusShell>`; passes `ShellActions`; overlays unchanged.
- `src/renderer/src/main.tsx`: imports the nexus styles.
- `src/renderer/src/browserFallback.ts` (dev only): `onboardingComplete: true` and a fake-free agent list, so the preview reaches the shell. Still labelled with its banner.
- `src/renderer/src/components/SettingsModal.tsx`: reset also clears `nx.` keys (one line).
- `package.json` / `package-lock.json`: `lucide-react` added, new tests added to `test:focused`.
- `src/renderer/index.html`: `<title>`/splash stay on the product name (no rename), with an optional Nexus splash mark.

**Unchanged on purpose**
- All of `src/main/**` and `src/preload/**`
- ProjectCommandCenter, IdePanel, FullscreenTerminal, TaskDetailOverlay, SettingsModal (except the one line), AgentStrip, OfficeFloor, OnboardingWizard, HivePicker

**Open items for you**
1. Supply `launcher-islands.webp`: about 2400×1460, 16:9.75 like the mockup, **no labels or cards**. I'll tune the hotspot coordinates to it.
2. Confirm the Repo health bar. It's a real field, but a heuristic; omitting it is a one-line registry/selector change.
