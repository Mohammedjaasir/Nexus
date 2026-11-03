---
name: nexus-task-bridge
description: Create, comment on, update, and list Nexus tasks from Hermes using scoped Nexus API credentials.
---

# Nexus Task Bridge

Use this skill when a Hermes-originated request needs to create or update Nexus work directly. This is the Hermes-to-Nexus direction, separate from Nexus waking Hermes through the `hermes_local` or `hermes_gateway` adapter.

## Required Environment

Configure these in Hermes env/profile secrets, not in prompt text:

- `NEXUS_API_URL` - Nexus base URL, with or without `/api`.
- `NEXUS_BRIDGE_API_KEY` - a Nexus agent API key created with `scope.kind = "task_bridge"`.

Optional:

- `NEXUS_API_KEY` - fallback env var for older profiles; it must still contain a `task_bridge` scoped key, never a full agent key.
- `NEXUS_COMPANY_ID` - skips one identity lookup when set.
- `NEXUS_AGENT_ID` - skips one identity lookup when set.
- `NEXUS_RUN_ID` - sent as `X-Nexus-Run-Id` on mutating requests when Hermes is running inside a Nexus heartbeat.

Never print or paste API keys. The helper reads credentials from environment variables and only prints response summaries. Do not put a normal claimed agent API key in an internet-facing Hermes runtime; normal keys can use broad same-company Nexus routes.

## Create a Bridge Key

Create the key from a board-authenticated Nexus API session and store the returned token once:

```sh
curl -X POST "$NEXUS_API_URL/api/agents/$HERMES_AGENT_ID/keys" \
  -H "Authorization: Bearer $BOARD_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Hermes task bridge",
    "scope": {
      "kind": "task_bridge",
      "parentIssueId": "00000000-0000-4000-8000-000000000000"
    }
  }'
```

Use `parentIssueId` or `parentIssueIds` when Hermes should only create child tasks under approved work. Use `projectId` or `projectIds` when the approved boundary is a project. A bridge key can create tasks only inside that boundary, can comment/update only bridge-created or assigned issues, and cannot use company-wide issue list/search/read surfaces.

## Helper

Run the helper from this skill directory:

```sh
node ./nexus-task.mjs --help
```

Commands:

```sh
node ./nexus-task.mjs list-assigned
node ./nexus-task.mjs create-task --parent-id "00000000-0000-4000-8000-000000000000" --title "Investigate checkout failures" --description "Capture failing request and root cause."
node ./nexus-task.mjs comment --issue PAP-123 --body "Found the failing request path."
node ./nexus-task.mjs update-status --issue PAP-123 --status in_review --comment "Ready for review."
```

`create-task` defaults to assigning the task to the authenticated Hermes agent so the work is immediately actionable. Use `--unassigned` to create backlog work instead. Use `--assignee-agent-id <uuid>` only when the Nexus API key has permission to assign work to that agent.

For multiline bodies, prefer files or stdin:

```sh
node ./nexus-task.mjs create-task --title "Write rollout note" --description-file ./task.md
node ./nexus-task.mjs comment --issue PAP-123 --body-file -
```

## Workflow Expectations

- Keep tasks company-scoped by using the company resolved from the scoped agent key.
- Let Nexus activity logging come from the normal API endpoints; do not write local logs that include credentials.
- Use comments for durable progress.
- Use `update-status` only when the issue has a real disposition: `done`, `in_review`, `blocked`, `todo`, `in_progress`, `backlog`, or `cancelled`.
- Use `list-assigned` before creating duplicate work when the user asks about current Nexus assignments.
