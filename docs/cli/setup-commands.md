---
title: Setup Commands
summary: Onboard, run, doctor, and configure
---

Instance setup and diagnostics commands.

## `nexusai run`

One-command bootstrap and start:

```sh
pnpm nexusai run
```

Does:

1. Auto-onboards if config is missing
2. Runs `nexusai doctor` with repair enabled
3. Starts the server when checks pass

Choose a specific instance:

```sh
npx nexusai run --instance dev
```

## `nexusai onboard`

Interactive first-time setup:

```sh
pnpm nexusai onboard
```

If Nexus is already configured, rerunning `onboard` keeps the existing config in place. Use `nexusai configure` to change settings on an existing install.

First prompt:

1. `Quickstart` (recommended): local defaults (embedded database, no LLM provider, local disk storage, default secrets)
2. `Advanced setup`: full interactive configuration

Start immediately after onboarding:

```sh
pnpm nexusai onboard --run
```

Quickstart defaults + immediate start:

```sh
pnpm nexusai onboard --yes
```

When onboarding starts Nexus from an interactive terminal, it opens the
onboarding page in your browser once. Non-interactive terminals stay silent.
Suppress browser opening explicitly for headless or automated runs with either
environment variable:

```sh
NEXUS_NO_BROWSER=1 pnpm nexusai onboard --yes
NEXUS_OPEN_ON_LISTEN=false pnpm nexusai onboard --yes
```

On an existing install, `--yes` now preserves the current config and just starts Nexus with that setup.

## `nexusai doctor`

Health checks with optional auto-repair:

```sh
pnpm nexusai doctor
pnpm nexusai doctor --repair
```

Validates:

- Server configuration
- Database connectivity
- Secrets adapter configuration, including AWS Secrets Manager non-secret env
  config when selected
- Storage configuration
- Missing key files

## `nexusai configure`

Update configuration sections:

```sh
pnpm nexusai configure --section server
pnpm nexusai configure --section secrets
pnpm nexusai configure --section storage
```

`--section secrets` updates the deployment-level provider used as the fallback
for secrets that do not target a specific company vault. Per-company provider
vaults (named instances, default vault selection, multiple vaults per provider,
coming-soon GCP/Vault) live in the board UI under
`Company Settings → Secrets → Provider vaults` and the
`/api/companies/{companyId}/secret-provider-configs` API.

## `nexusai env`

Show resolved environment configuration:

```sh
pnpm nexusai env
```

This now includes bind-oriented deployment settings such as `NEXUS_BIND` and `NEXUS_BIND_HOST` when configured.

## `nexusai allowed-hostname`

Allow a private hostname for authenticated/private mode:

```sh
npx nexusai allowed-hostname my-tailscale-host
```

## Local Storage Paths

| Data | Default Path |
|------|-------------|
| Config | `~/.nexus/instances/default/config.json` |
| Database | `~/.nexus/instances/default/db` |
| Logs | `~/.nexus/instances/default/logs` |
| Storage | `~/.nexus/instances/default/data/storage` |
| Secrets key | `~/.nexus/instances/default/secrets/master.key` |

Override with:

```sh
NEXUS_HOME=/custom/home NEXUS_INSTANCE_ID=dev pnpm nexusai run
```

Or pass `--data-dir` directly on any command:

```sh
npx nexusai run --data-dir ./tmp/nexus-dev
npx nexusai doctor --data-dir ./tmp/nexus-dev
```
