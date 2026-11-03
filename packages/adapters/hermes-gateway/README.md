# Hermes Gateway Adapter Compatibility Shim

`@nexusai/adapter-hermes-gateway` is a deprecated compatibility shim.

Use `@nexusai/hermes-nexus-adapter` for new installs and import gateway
entrypoints from `@nexusai/hermes-nexus-adapter/gateway`. The adapter
type remains `hermes_gateway`; only package ownership changed.

`hermes_gateway` is for an already-running Hermes API server. It does not start
the local Hermes CLI. If Nexus should launch local `hermes chat` as a child
process, use `hermes_local` from `@nexusai/hermes-nexus-adapter`
instead.

The shim preserves the legacy exports for one release:

- `.`
- `./server`
- `./ui`
- `./cli`
- `./ui-parser`

These exports forward to the unified Hermes package. Existing
`@nexusai/adapter-hermes-gateway` plugin installs should continue to load
during the compatibility window, but should migrate to
`@nexusai/hermes-nexus-adapter` before the shim is removed.
