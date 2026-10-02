# Security Policy

## Scope

Nexus is a local-first desktop app. It runs agent CLIs in local terminals and
reads and writes files in folders you register. It listens only on loopback
(the hook server, a local integration broker and a local telemetry collector).
There is no account system or remote API.

Agents can run with their CLI's approval prompts bypassed when *auto mode* is
on (the default). Treat any folder you give an agent as writable by it.

## Supported versions

Security fixes target the current development branch only.

## Reporting a vulnerability

Please don't open a public issue for a security problem. Use your repository
host's private vulnerability reporting for this repository, or contact the
maintainers privately.

<!-- TODO(maintainers): add the Nexus security contact (email or advisory URL). -->

## Notes for reviewers

- Renderer ↔ main IPC goes through a typed `contextBridge` (`window.cth`); the
  renderer has no Node access (`nodeIntegration: false`, `contextIsolation: true`).
- `fs:*` and `git:*` IPC calls are path-validated in the main process.
- The hive is a local git repo committed by a single writer, the main process.
