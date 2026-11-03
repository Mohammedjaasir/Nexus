---
title: Deployment Modes
summary: local_trusted vs authenticated (private/public)
---

Nexus supports two runtime modes with different security profiles. Reachability is configured separately with `bind`.

## `local_trusted`

The default mode. Optimized for single-operator local use.

- **Host binding**: loopback only (localhost)
- **Bind**: `loopback`
- **Authentication**: no login required
- **Use case**: local development, solo experimentation
- **Board identity**: auto-created local board user

```sh
# Set during onboard
pnpm nexusai onboard
# Choose "local_trusted"
```

## `authenticated`

Login required. Supports two exposure policies.

### `authenticated` + `private`

For private network access (Tailscale, VPN, LAN).

- **Authentication**: login required via Better Auth
- **URL handling**: auto base URL mode (lower friction)
- **Host trust**: private-host trust policy required
- **Bind**: choose `loopback`, `lan`, `tailnet`, or `custom`

```sh
pnpm nexusai onboard
# Choose "authenticated" -> "private"
```

Allow custom Tailscale hostnames:

```sh
npx nexusai allowed-hostname my-machine
```

### `authenticated` + `public`

For internet-facing deployment.

- **Authentication**: login required
- **URL**: explicit public URL required
- **Security**: stricter deployment checks in doctor
- **Bind**: usually `loopback` behind a reverse proxy; `lan/custom` is advanced

```sh
pnpm nexusai onboard
# Choose "authenticated" -> "public"
```

## Board Claim Flow

When migrating from `local_trusted` to `authenticated`, Nexus emits a one-time claim URL at startup:

```
/board-claim/<token>?code=<code>
```

A signed-in user visits this URL to claim board ownership. This:

- Promotes the current user to instance admin
- Demotes the auto-created local board admin
- Ensures active company membership for the claiming user

## Changing Modes

Update the deployment mode:

```sh
pnpm nexusai configure --section server
```

Runtime override via environment variable:

```sh
NEXUS_DEPLOYMENT_MODE=authenticated NEXUS_BIND=lan pnpm nexusai run
```
