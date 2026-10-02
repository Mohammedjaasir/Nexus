# Contributing to Nexus

## Code of Conduct

This project follows the [Contributor Covenant](./CODE_OF_CONDUCT.md).

## Setup

See [Development](./README.md#development) in the README. The most common setup
failure is the native `node-pty` rebuild: if launch reports a
`NODE_MODULE_VERSION` mismatch, re-run `npm install`.

## Before you open a PR

1. `npm run typecheck` passes.
2. `npm run test:focused` passes, apart from known platform-specific failures
   noted in the PR.
3. `npm run build` succeeds.
4. New Nexus UI uses the `--nx-*` tokens in
   `src/renderer/src/nexus/styles/tokens.css` and the primitives in
   `src/renderer/src/nexus/ui/`, with no ad-hoc colours or fonts.
5. Real data only: never render invented metrics, users, artifacts or
   deployments. Features without a backend are disabled and labelled
   *Not available yet*.
6. Visual changes include a screenshot.

## Commits and PRs

- Keep each PR focused on one change and say what changed and why.
- Stage files explicitly; don't commit `node_modules/`, `out/` or build output.

## Assets

Some bundled pixel art is licensed for **non-commercial use only** — see
[`ATTRIBUTION.md`](./src/renderer/src/assets/ATTRIBUTION.md). New art must be
your own or compatibly licensed, and listed there.
