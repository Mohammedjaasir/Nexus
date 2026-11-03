# Nexus MCP Server

Model Context Protocol server for Nexus.

This package is a thin MCP wrapper over the existing Nexus REST API. It does
not talk to the database directly and it does not reimplement business logic.

## Authentication

The server reads its configuration from environment variables:

- `NEXUS_API_URL` - Nexus base URL, for example `http://localhost:3100`
- `NEXUS_API_KEY` - bearer token used for `/api` requests
- `NEXUS_COMPANY_ID` - optional default company for company-scoped tools
- `NEXUS_AGENT_ID` - optional default agent for checkout helpers
- `NEXUS_RUN_ID` - optional run id forwarded on mutating requests

Inside an active heartbeat, Nexus also injects `NEXUS_RUNTIME_TOOLS_*` variables. They enable the run-scoped `connections_search` and `connection_request` tools and expire with the run.

## Usage

```sh
npx -y @nexusai/mcp-server
```

Or locally in this repo:

```sh
pnpm --filter @nexusai/mcp-server build
node packages/mcp-server/dist/stdio.js
```

## Tool Surface

Run-scoped connection tools:

- `connections_search`
- `connection_request`

Read tools:

- `nexusMe`
- `nexusInboxLite`
- `nexusListAgents`
- `nexusGetAgent`
- `nexusListIssues`
- `nexusGetIssue`
- `nexusGetHeartbeatContext`
- `nexusListComments`
- `nexusGetComment`
- `nexusListIssueApprovals`
- `nexusListDocuments`
- `nexusGetDocument`
- `nexusListDocumentRevisions`
- `nexusListProjects`
- `nexusGetProject`
- `nexusGetIssueWorkspaceRuntime`
- `nexusWaitForIssueWorkspaceService`
- `nexusListGoals`
- `nexusGetGoal`
- `nexusListApprovals`
- `nexusGetApproval`
- `nexusGetApprovalIssues`
- `nexusListApprovalComments`

Write tools:

- `nexusCreateIssue`
- `nexusUpdateIssue`
- `nexusCheckoutIssue`
- `nexusReleaseIssue`
- `nexusAddComment`
- `nexusSuggestTasks`
- `nexusAskUserQuestions`
- `nexusRequestConfirmation`
- `nexusUpsertIssueDocument`
- `nexusRestoreIssueDocumentRevision`
- `nexusControlIssueWorkspaceServices`
- `nexusCreateApproval`
- `nexusLinkIssueApproval`
- `nexusUnlinkIssueApproval`
- `nexusApprovalDecision`
- `nexusAddApprovalComment`

Escape hatch:

- `nexusApiRequest`

`nexusApiRequest` is limited to paths under `/api` and JSON bodies. It is
meant for endpoints that do not yet have a dedicated MCP tool.
