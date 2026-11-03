---
title: CLI Overview
summary: CLI installation and setup
---

The Nexus CLI handles instance setup, diagnostics, and control-plane operations.

## Usage

```sh
pnpm nexusai --help
```

## Global Options

All commands support:

| Flag | Description |
|------|-------------|
| `--data-dir <path>` | Local Nexus data root (isolates from `~/.nexus`) |
| `--api-base <url>` | API base URL |
| `--api-key <token>` | API authentication token |
| `--context <path>` | Context file path |
| `--profile <name>` | Context profile name |
| `--json` | Output as JSON |

Company-scoped commands also accept `--company-id <id>`.

For clean local instances, pass `--data-dir` on the command you run:

```sh
npx nexusai run --data-dir ./tmp/nexus-dev
```

## Context Profiles

Store defaults to avoid repeating flags:

```sh
# Set defaults
npx nexusai context set --api-base http://localhost:3100 --company-id <id>

# View current context
pnpm nexusai context show

# List profiles
pnpm nexusai context list

# Switch profile
npx nexusai context use default
```

To avoid storing secrets in context, use an env var:

```sh
npx nexusai context set --api-key-env-var-name NEXUS_API_KEY
export NEXUS_API_KEY=...
```

Secret operations are available under `nexusai secrets`:

```sh
npx nexusai secrets declarations --company-id <company-id> --kind secret
npx nexusai secrets create --company-id <company-id> --name anthropic-api-key --value-env ANTHROPIC_API_KEY
npx nexusai secrets link --company-id <company-id> --name prod-stripe-key --provider aws_secrets_manager --external-ref <provider-ref>
npx nexusai secrets doctor --company-id <company-id>
npx nexusai secrets migrate-inline-env --company-id <company-id> --apply
```

Context is stored at `~/.nexus/context.json`.

## Command Categories

The CLI has two categories:

1. **[Setup commands](/cli/setup-commands)** — instance bootstrap, diagnostics, configuration
2. **[Control-plane commands](/cli/control-plane-commands)** — issues, agents, approvals, activity
