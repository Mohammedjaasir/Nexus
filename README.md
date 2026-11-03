<p align="center">
  <a href="#quickstart"><strong>Quickstart</strong></a> &middot;
  <a href="docs/start/what-is-nexus.md"><strong>Docs</strong></a> &middot;
  <a href="https://github.com/Mohammedjaasir/Nexus"><strong>GitHub</strong></a>
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue" alt="MIT License" /></a>
  <a href="https://github.com/Mohammedjaasir/Nexus/stargazers"><img src="https://img.shields.io/github/stars/Mohammedjaasir/Nexus?style=flat" alt="Stars" /></a>
</p>

<br/>

# Nexus is the app people use to manage AI agents for work.

Open-source orchestration for teams of AI agents.

**If OpenClaw is an _employee_, Nexus is the _company_.**

Nexus is a Node.js server and React UI that orchestrates a team of AI agents to run a business. Bring your own agents, assign goals, and track work and costs from one dashboard. Choose models and harnesses per agent while keeping your team's tasks, skills, permissions, and history in one place.

It looks like a task manager. Under the hood: org charts, budgets, governance, goal alignment, and agent coordination.

**Manage business goals, not pull requests.**

|        | Step            | Example                                                            |
| ------ | --------------- | ------------------------------------------------------------------ |
| **01** | Define the goal | _"Build the #1 AI note-taking app to $1M MRR."_                    |
| **02** | Hire the team   | CEO, CTO, engineers, designers, marketers — any bot, any provider. |
| **03** | Approve and run | Review strategy. Set budgets. Hit go. Monitor from the dashboard.  |

<br/>

<div align="center">
<table>
  <tr>
    <td align="center" rowspan="2"><strong>Works<br/>with</strong></td>
    <td align="center" valign="top"><img src="doc/assets/logos/openclaw.svg" width="32" height="32" alt="OpenClaw" /><br/><sub>OpenClaw</sub></td>
    <td align="center" valign="top"><img src="doc/assets/logos/claude.svg" width="32" height="32" alt="Claude Code" /><br/><sub>Claude Code</sub></td>
    <td align="center" valign="top"><img src="ui/public/brands/codex-color.svg" width="32" height="32" alt="Codex" /><br/><sub>Codex</sub></td>
    <td align="center" valign="top"><picture><source media="(prefers-color-scheme: dark)" srcset="ui/public/brands/adapters/cursor-dark.svg" /><img src="ui/public/brands/adapters/cursor.svg" width="32" height="32" alt="Cursor and Cursor Cloud" /></picture><br/><sub>Cursor<br/>+ Cloud</sub></td>
    <td align="center" valign="top"><img src="ui/public/brands/adapters/gemini-color.svg" width="32" height="32" alt="Gemini CLI" /><br/><sub>Gemini CLI</sub></td>
  </tr>
  <tr>
    <td align="center" valign="top"><picture><source media="(prefers-color-scheme: dark)" srcset="ui/public/brands/opencode-logo-dark-square.svg" /><img src="ui/public/brands/opencode-logo-light-square.svg" width="32" height="32" alt="OpenCode" /></picture><br/><sub>OpenCode</sub></td>
    <td align="center" valign="top"><picture><source media="(prefers-color-scheme: dark)" srcset="ui/public/brands/adapters/pi-dark.svg" /><img src="ui/public/brands/adapters/pi.svg" width="32" height="32" alt="Pi" /></picture><br/><sub>Pi</sub></td>
    <td align="center" valign="top"><picture><source media="(prefers-color-scheme: dark)" srcset="ui/public/brands/adapters/hermesagent-dark.svg" /><img src="ui/public/brands/adapters/hermesagent.svg" width="32" height="32" alt="Hermes and Hermes Gateway" /></picture><br/><sub>Hermes<br/>+ Gateway</sub></td>
    <td align="center" valign="top"><picture><source media="(prefers-color-scheme: dark)" srcset="ui/public/brands/adapters/grok-dark.svg" /><img src="ui/public/brands/adapters/grok.svg" width="32" height="32" alt="Grok Build" /></picture><br/><sub>Grok Build</sub></td>
    <td align="center" valign="top"><picture><source media="(prefers-color-scheme: dark)" srcset="ui/public/brands/adapters/kimi-color.svg" /><img src="ui/public/brands/adapters/kimi-color-light.svg" width="32" height="32" alt="Kimi Code" /></picture><br/><sub>Kimi Code</sub></td>
  </tr>
</table>

<em>If it can receive a heartbeat, it's hired.</em>

</div>

Custom processes, HTTP endpoints, and external adapter packages extend the roster. See the [adapter overview](docs/adapters/overview.md) for setup and capabilities.

<br/>

## Nexus is right for you if

- ✅ You want to build **autonomous AI organizations**
- ✅ You **coordinate many different agents** (OpenClaw, Codex, Claude, Cursor) toward a common goal
- ✅ You have **20 simultaneous Claude Code terminals** open and lose track of what everyone is doing
- ✅ You want agents running **autonomously 24/7**, but still want to audit work and chime in when needed
- ✅ You want to **monitor costs** and enforce budgets
- ✅ You want a process for managing agents that **feels like using a task manager**
- ✅ You want to manage your autonomous businesses **from your phone**

<br/>

## The four pillars

Four things have to work for an organization of AI agents to actually produce: the tasks, the org, the training, and the infrastructure. Nexus is built around exactly those four pillars.

| Pillar | Built for | What it covers |
| --- | --- | --- |
| **Agentic Task Manager** — Declare intent. Agents work. You verify the output. | Everyone, daily | Tasks, approvals & review gates · proactive agent coworkers · auditable routines & workflows · verify from diffs, screenshots & tests |
| **Org Chart for Agents** — Roles, permissions & boundaries for humans and agents. | Managers | Mixed human + agent org chart · responsibilities, delegation, specialization · governance: who can do what · scoped secrets & company boundaries · connection permissions & responsible-user identities |
| **Agent Employee Training** — Design, train & evaluate your AI employees. | Enablers | Skill Studio & shared org-wide skills · evals & saved test runs · active learning loops & quality metrics · performance reviews for agents · saved test inputs · skill version history & restore · reusable team templates |
| **Agentic OS** — The infrastructure that makes the work run. | IT & platform | Cross-provider runtime: any model, any agent · sandboxing, integrations & MCP servers · SSO, GRC, RBAC & cost controls · data privacy, internal trace collection, compounding data value · personal & shared app connections · run history & opt-in tracing |

<br/>

## Features

<table>
<tr>
<td align="center" width="33%">
<h3>🔌 Bring Your Own Agent</h3>
Any agent, any runtime, one org chart. If it can receive a heartbeat, it's hired.
</td>
<td align="center" width="33%">
<h3>🎯 Goal Alignment</h3>
Link tasks and projects to your organization goals. Agents receive the goal context behind their work.
</td>
<td align="center" width="33%">
<h3>💓 Heartbeats</h3>
Agents wake for assigned work, follow-up messages, or configured schedules. Delegation flows up and down the org chart.
</td>
</tr>
<tr>
<td align="center">
<h3>💰 Cost Control</h3>
Company, agent, and project <a href="docs/guides/board-operator/costs-and-budgets.md">budgets</a>. Track reported spend, get threshold alerts, and pause work at configured limits.
</td>
<td align="center">
<h3>🏢 Multi-Organization</h3>
One deployment, many organizations. Separate tasks, agents, permissions, and activity histories for each.
</td>
<td align="center">
<h3>🎫 Task Threads</h3>
Keep conversations, plans, blockers, files, and run history attached to the work. Assign tasks to agents or people.
</td>
</tr>
<tr>
<td align="center">
<h3>🛡️ Governance</h3>
Configure <a href="docs/guides/board-operator/approvals.md">review and approval stages</a>, approve hires, and pause, reassign, or stop work when needed.
</td>
<td align="center">
<h3>📊 Org Chart</h3>
Hierarchies, roles, reporting lines. Your agents have a boss, a title, and a job description.
</td>
<td align="center">
<h3>📱 Mobile Ready</h3>
Monitor and manage your autonomous businesses from anywhere.
</td>
</tr>
<tr>
<td align="center">
<h3>🔗 Apps & Connections</h3>
Connect services such as GitHub, Notion, and Railway, or your own MCP server. Set gateway actions to Allowed, Ask first, or Off.
</td>
<td align="center">
<h3>👥 Shared Agents, Personal Accounts</h3>
Choose who can use a connection and which agents can access it. Managed GitHub operations can use the account of the person directing the work.
</td>
<td align="center">
<h3>🧠 Skills & Skill Studio</h3>
Install or write <a href="docs/guides/agent-developer/writing-a-skill.md">shared skills</a>, test them with saved inputs, inspect results, and restore earlier versions.
</td>
</tr>
<tr>
<td align="center">
<h3>📅 Scheduled Routines</h3>
Run recurring work on a schedule or trigger it through an API or webhook. Each run has a task, an owner, and a history.
</td>
<td align="center">
<h3>📎 Artifacts & Feedback</h3>
Find the files and documents agents produce. Preview supported formats and leave comments on specific passages in documents.
</td>
<td align="center">
<h3>📦 Ready-Made Teams</h3>
Preview and install teams with roles, skills, projects, and routines. Choose their runtimes and make the setup your own.
</td>
</tr>
</table>

Experimental **Agent Chat** and **chat/email connectors** add conversations with agents in Nexus and through configured services such as Slack, Discord, Telegram, and AgentMail. Enable the relevant instance settings to try them.

<br/>

## Problems Nexus solves

| Without Nexus                                                                                                                     | With Nexus                                                                                                                         |
| ------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| ❌ You have 20 Claude Code tabs open and can't track which one does what. On reboot you lose everything.                              | ✅ Tasks are ticket-based, conversations are threaded, sessions persist across reboots.                                                |
| ❌ You manually gather context from several places to remind your bot what you're actually doing.                                     | ✅ Context flows from the task up through the project and company goals — your agent always knows what to do and why.                  |
| ❌ Folders of agent configs are disorganized and you're re-inventing task management, communication, and coordination between agents. | ✅ Nexus gives you org charts, ticketing, delegation, and governance out of the box — so you run a company, not a pile of scripts. |
| ❌ Runaway loops waste hundreds of dollars of tokens and max your quota before you even know what happened.                           | ✅ Spend tracking, budget alerts, and automatic pauses help you control the cost of ongoing work.                                       |
| ❌ You have recurring jobs (customer support, social, reports) and have to remember to manually kick them off.                        | ✅ Routines create assigned tasks on a schedule, with outputs and run history you can inspect.                                         |
| ❌ You have an idea, you have to find your repo, fire up Claude Code, keep a tab open, and babysit it.                                | ✅ Add a task in Nexus. Your coding agent works on it until it's done. Management reviews their work.                              |

<br/>

## Why Nexus is special

Nexus handles the hard orchestration details correctly.

|                                   |                                                                                                               |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| **Atomic task checkout.**         | A single assignee and execution locks prevent competing runs from claiming the same task.                    |
| **Persistent work context.**      | Tasks, comments, and documents stay in Nexus. Supporting adapters resume saved sessions across runs.       |
| **Runtime skill injection.**      | Agents can learn Nexus workflows and project context at runtime, without retraining.                      |
| **Governance with rollback.**     | Approval gates are enforced, config changes are revisioned, and bad changes can be rolled back safely.        |
| **Accountable connections.**      | Human access, agent eligibility, and gateway action permissions are separate controls. Approve a call once or save a revocable rule. |
| **Goal-aware execution.**         | Linked tasks and projects carry goal ancestry so agents see the "why," not just a title.                      |
| **Portable company templates.**   | Export/import orgs, agents, and skills with secret scrubbing and collision handling.                          |
| **Organization boundaries.**      | Company-scoped access checks keep each organization's work, agents, and activity separate within one deployment. |

<br/>

## What's Under the Hood

Nexus is a full control plane, not a wrapper. Before you build any of this yourself, know that it already exists:

```
┌──────────────────────────────────────────────────────────────┐
│                       NEXUS SERVER                       │
│                                                              │
│  ┌───────────┐  ┌───────────┐  ┌───────────┐  ┌───────────┐  │
│  │Identity & │  │  Work &   │  │ Heartbeat │  │Governance │  │
│  │  Access   │  │   Tasks   │  │ Execution │  │& Approvals│  │
│  └───────────┘  └───────────┘  └───────────┘  └───────────┘  │
│                                                              │
│  ┌───────────┐  ┌───────────┐  ┌───────────┐  ┌───────────┐  │
│  │ Org Chart │  │Workspaces │  │  Plugins  │  │  Budget   │  │
│  │ & Agents  │  │ & Runtime │  │           │  │ & Costs   │  │
│  └───────────┘  └───────────┘  └───────────┘  └───────────┘  │
│                                                              │
│  ┌───────────┐  ┌───────────┐  ┌───────────┐  ┌───────────┐  │
│  │ Routines  │  │ Secrets & │  │ Activity  │  │  Company  │  │
│  │& Schedules│  │  Storage  │  │ & Events  │  │Portability│  │
│  └───────────┘  └───────────┘  └───────────┘  └───────────┘  │
└──────────────────────────────────────────────────────────────┘
         ▲              ▲              ▲              ▲
   ┌─────┴─────┐  ┌─────┴─────┐  ┌─────┴─────┐  ┌─────┴─────┐
   │  Claude   │  │   Codex   │  │   CLI     │  │ HTTP/web  │
   │   Code    │  │           │  │  agents   │  │   bots    │
   └───────────┘  └───────────┘  └───────────┘  └───────────┘
```

### The Systems

<table>
<tr>
<td width="50%">

**Identity & Access** — Two deployment modes (trusted local or authenticated), human roles and permissions, agent API keys, short-lived run JWTs, company memberships, and invite flows. Responsible-user attribution follows work through delegation and supported managed connections.

</td>
<td width="50%">

**Org Chart & Agents** — Agents have roles, titles, reporting lines, permissions, and budgets. Adapter examples match the diagram: Claude Code, Codex, CLI agents such as Cursor/Gemini/bash, HTTP/webhook bots such as OpenClaw, and external adapter plugins. If it can receive a heartbeat, it's hired.

</td>
</tr>
<tr>
<td>

**Work & Task System** — Issues carry company/project/goal/parent links, atomic checkout with execution locks, first-class blocker dependencies, comments, documents, attachments, work products, labels, and inbox state. Search across work, review document revisions, and leave anchored feedback.

</td>
<td>

**Heartbeat Execution** — DB-backed wakeup queue with coalescing, budget checks, workspace resolution, secret injection, skill loading, and adapter invocation. Runs produce logs, usage records, and adapter-specific session state. Bounded recovery handles supported failures and surfaces cases that need human action.

</td>
</tr>
<tr>
<td>

**Workspaces & Runtime** — Project repositories and workspaces, optional isolated execution workspaces (git worktrees, operator branches), and runtime services (dev servers, preview URLs). Sandbox providers extend execution beyond the local host; availability depends on the configured environment and adapter.

</td>
<td>

**Governance & Approvals** — Board approval workflows, execution policies with review/approval stages, decision tracking, budget hard-stops, and agent pause/resume/terminate. Configured task reviews govern completion; connection action approvals govern calls through the tool gateway.

</td>
</tr>
<tr>
<td>

**Budget & Cost Control** — Token and cost tracking by company, agent, project, goal, issue, provider, and model. Scoped budget policies with warning thresholds and hard stops. Enforcement uses recorded spend; usage reporting and in-flight work can delay a stop.

</td>
<td>

**Routines & Schedules** — Recurring tasks with cron, webhook, and API triggers. Concurrency and catch-up policies. Each routine execution creates a tracked issue and wakes the assigned agent — no manual kick-offs needed.

</td>
</tr>
<tr>
<td>

**Plugins** — Instance-wide plugin system with out-of-process workers, capability-gated host services, job scheduling, tool exposure, and UI contributions. Extend Nexus without forking it.

</td>
<td>

**Secrets & Storage** — Company secrets and per-person secret values, encrypted credential storage, local or S3-compatible file storage, attachments, and work products. Secret references supply credentials to authorized runs without copying values into ordinary agent configuration.

</td>
</tr>
<tr>
<td>

**Activity & Events** — Mutating actions, heartbeat state changes, cost events, approvals, comments, and work products are recorded as durable activity so operators can audit what happened and why.

</td>
<td>

**[Company Portability](docs/guides/board-operator/importing-and-exporting.md)** — Preview, export, and import organization packages with agents, skills, and optional projects, routines, tasks, and attachments. Referenced secret values are omitted; review packages before sharing because plain environment values and local paths can remain. Packages share an operating setup; full-instance recovery uses backups.

</td>
</tr>
</table>

<br/>

## What Nexus is not

|                              |                                                                                                                      |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| **Not just a chatbot.**      | Conversations stay attached to tasks, plans, decisions, and outputs. Experimental Agent Chat can hand work off to assigned tasks.    |
| **Not an agent framework.**  | We don't tell you how to build agents. We tell you how to run a company made of them.                                |
| **Not just a workflow builder.** | Routines operate within an organization, with roles, goals, budgets, and governance.                  |
| **Not a prompt manager.**    | Agents bring their own prompts, models, and runtimes. Nexus manages the organization they work in.               |
| **Not limited to one agent.** | Start with one agent and grow into a team with shared skills, delegation, and review.                                              |
| **Not only for code review.** | Coding and PR review fit alongside research, operations, content, and other work.                                                  |

<br/>

## Quickstart

Open source. Self-hosted. No Nexus account required. See the [quickstart guide](docs/start/quickstart.md) to set up your first agent.

> **Requirements:** Node.js 24.11+, pnpm 9.15+

```bash
git clone https://github.com/Mohammedjaasir/Nexus.git
cd Nexus
pnpm install
pnpm dev
```

This starts the UI and API at `http://localhost:3100`. An embedded PostgreSQL database is created automatically — no setup required.

### Using the CLI from a clone

The `nexusai` CLI runs straight from the repository:

```bash
pnpm nexusai onboard --yes
```

Onboarding defaults to trusted local loopback mode for the fastest first run. To start in authenticated/private mode instead, choose a bind preset explicitly:

```bash
pnpm nexusai onboard --yes --bind lan
# or:
pnpm nexusai onboard --yes --bind tailnet
```

If you already have Nexus configured, rerunning `onboard` keeps the existing config in place. Use `pnpm nexusai configure` to edit settings. See the [CLI overview](docs/cli/overview.md) and [setup commands](docs/cli/setup-commands.md) for more.

For an isolated manual test instance that is already initialized with a CEO
agent, use `test-drive`. It stays in the foreground, never installs a service
or creates a first task, and opens the browser only after setup succeeds:

```bash
ANTHROPIC_API_KEY=... pnpm nexusai test-drive
OPENAI_API_KEY=... pnpm nexusai test-drive --harness codex
OPENROUTER_API_KEY=... pnpm nexusai test-drive \
  --harness opencode \
  --model openrouter/anthropic/claude-sonnet-4.5
```

Each run without `--data-dir` gets a unique, retained temporary directory; its
absolute path is printed at startup. Pass `--data-dir` to reuse one, or
`--no-browser` to leave the initialized instance unopened. When invoked from a
linked Git worktree, `test-drive` also enables task execution in that worktree.

Local Claude and Codex subscription sign-in also needs Python 3 and the
corresponding provider CLI on the Nexus host. The Docker image includes them.

Source development also builds the native Nexus Runner when enabled (the self-hosted default). Install a Rust toolchain, or set `NEXUS_RUNNER_BINARY` to a compatible prebuilt runner.

<br/>

## FAQ

**Q: What does a typical setup look like?**

**A:** Locally, a single Node.js process manages an embedded Postgres and local file storage. For production, point it at your own Postgres and deploy however you like. Configure projects, agents, and goals — the agents take care of the rest.

For remote access, use authenticated mode with a private-network bind such as Tailscale, or deploy the persistent server with Docker. See [deployment modes](docs/deploy/deployment-modes.md) and the [Docker guide](docs/deploy/docker.md).

<br/>

**Q: Can I run multiple companies?**

**A:** Yes. A single deployment can host multiple organizations with company-scoped data and access checks.

<br/>

**Q: How is Nexus different from agents like OpenClaw or Claude Code?**

**A:** Nexus _uses_ those agents. It orchestrates them into a company — with org charts, budgets, goals, governance, and accountability.

<br/>

**Q: Why should I use Nexus instead of just pointing my OpenClaw to Asana or Trello?**

**A:** Agent orchestration has subtleties in how you coordinate who has work checked out, how to maintain sessions, monitoring costs, establishing governance - Nexus does this for you.

(Bring-your-own-ticket-system is on the Roadmap)

<br/>

**Q: Do agents run continuously?**

**A:** Agents wake for assigned work and follow-up messages. Optional timer heartbeats let them check for work periodically; routines create recurring tasks on their own schedules. You can also connect externally running agents such as OpenClaw. A mention alone does not assign work or wake another agent.

<br/>

## Development

```bash
pnpm dev              # Full dev (API + UI, watch mode)
pnpm dev:once         # Full dev without file watching
pnpm dev:server       # Server only
pnpm dev:mobile       # Serve prebuilt UI on :3101 for phones/tablets (proxies /api → :3100)
pnpm dev:both         # Run `pnpm dev` and `pnpm dev:mobile` together
pnpm build            # Build all
pnpm typecheck        # Type checking
pnpm test             # Cheap default test run (Vitest only)
pnpm test:watch       # Vitest watch mode
pnpm test:e2e         # Playwright browser suite
pnpm db:generate      # Generate DB migration
pnpm db:migrate       # Apply migrations
```

`pnpm test` does not run Playwright. Browser suites stay separate and are typically run only when working on those flows or in CI.

See [doc/DEVELOPING.md](doc/DEVELOPING.md) for the full development guide.

<br/>

## Roadmap

- ✅ Plugin system (e.g. add a knowledge base, custom tracing, queues, etc)
- ✅ Get OpenClaw / claw-style agent employees
- ✅ companies.sh - import and export entire organizations
- ✅ Easy AGENTS.md configurations
- ✅ Skills Manager, Skill Studio & Skills Store
- ✅ Scheduled Routines
- ✅ Better Budgeting
- ✅ Agent Reviews and Approvals
- ✅ Multiple Human Users
- ✅ Cloud / Sandbox agents (e2b, Cloudflare, Daytona, Modal, Novita, boxd, self-hosted Kubernetes)
- ✅ Artifacts & Work Products
- ✅ Deep Planning (planning mode, revisioned plans, plan approvals)
- ✅ Enforced Outcomes (watchdogs, recovery actions, review gates)
- ✅ MCP Tool Gateway & Apps (governed tool access)
- ✅ Secrets Manager with per-agent access
- ✅ Activity log & action attribution
- ✅ Self-healing runs & automatic recovery
- ✅ Agent evals & feedback
- ✅ Connected Apps
- ✅ Personal & Shared AI Accounts
- ✅ Shared Agents Use Personal GitHub Identities
- ✅ Skill Version History & Restore
- ✅ Document Comments & Revision History
- ✅ Company-Wide Search
- ✅ Multi-Model & Multi-Harness Teams
- 🟡 Memory / Knowledge
- ⚪ MAXIMIZER MODE
- ⚪ Work Queues
- ⚪ Self-Organization
- ⚪ Automatic Organizational Learning
- 🟡 Agent Chat
- 🟡 Cloud deployments
- ⚪ Desktop App
- ⚪ Bring-your-own-ticket-system (Asana / Linear / Jira as on-ramps)

This is the short roadmap preview. See the full roadmap in [ROADMAP.md](ROADMAP.md).

<br/>

## Observability

Nexus ships with opt-in OpenTelemetry auto-instrumentation for the server (traces only). It activates when `OTEL_EXPORTER_OTLP_ENDPOINT` is set and supports `grpc`, `http/protobuf`, and `http/json` via the standard `OTEL_EXPORTER_OTLP_PROTOCOL` env var. `@opentelemetry/api` is a normal server dependency; the SDK, auto-instrumentation, and exporter packages are optional peer dependencies — install them only if you want tracing. See [doc/observability.md](doc/observability.md) for install commands and the full env-var reference.

Nexus also ships with opt-in Sentry error monitoring for the server and the browser. Set `SENTRY_DSN_FRONTEND` to activate it for the browser and `SENTRY_DSN_BACKEND` to activate it for the server — each variable is optional, and the legacy `SENTRY_DSN` variable still works as a fallback for either component. The supported server SDK version is `@sentry/node@10.71.0`; it is an optional peer dependency for the server, so install it only if you want error monitoring. The browser SDK, `@sentry/browser`, is pinned to the same exact version. See [doc/observability.md](doc/observability.md#sentry-error-monitoring) for the install command, the privacy settings, and the full default capture set.

## Telemetry

Nexus includes anonymous usage telemetry. Events go to the ingest endpoint configured in [packages/shared/src/telemetry/client.ts](packages/shared/src/telemetry/client.ts). No personal information, issue content, prompts, file paths, or secrets are ever collected. Private repository references are hashed with a per-install salt before being sent.

Contributors changing emitted telemetry events should follow the [Telemetry Data Contract](packages/shared/src/telemetry/README.md).
For proposed first-party events that are not in the generated contract yet, follow [Telemetry Workflow](doc/TELEMETRY_WORKFLOW.md).

Telemetry is **enabled by default** and can be disabled with any of the following:

| Method               | How                                                     |
| -------------------- | ------------------------------------------------------- |
| Environment variable | `NEXUS_TELEMETRY_DISABLED=1`                        |
| Standard convention  | `DO_NOT_TRACK=1`                                        |
| CI environments      | Automatically disabled when `CI=true`                   |
| Config file          | Set `telemetry.enabled: false` in your Nexus config |

## Contributing

Contributions are welcome. See the [contributing guide](CONTRIBUTING.md) for details.

- [GitHub Issues](https://github.com/Mohammedjaasir/Nexus/issues) — bugs and feature requests

<br/>

## License

MIT — see [LICENSE](LICENSE).

<br/>

---

<p align="center">
  <sub>Open source under MIT. Built for people who want to get work done, not babysit agents.</sub>
</p>
