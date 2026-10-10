'use strict';
// A real RunnerCore in its own process (B2a Task 12, test:exec only): the Docker driver over the real Docker CLI, the
// real file system and real timers, joined to the test process over the fork IPC channel exactly as the app's runner
// utilityProcess is joined to main over its MessagePort (test/helpers/execReal.cjs wraps it as the runner host's
// RunnerChild). The test kills this process to stand for a runner crash (L3, L13-L15).
//
// NEXUS_TEST_CREATE_FAULT (tests only, K10, K11, L9) rewrites the `docker create` argv the driver built, AFTER the driver
// built it, to stand for a broken or tampered Docker: `network-bridge` (adds --network bridge), `drop-pids` (removes
// --pids-limit), `docker-sock` (adds a docker.sock mount), `memory-4m` (sets --memory and --memory-swap to 4m, below
// Docker's 6 MiB minimum). Preflight (or Docker itself) must refuse each; nothing in the product reads this variable.
// NEXUS_TEST_FREE_BYTES (L10) is the free space the runner reports; NEXUS_TEST_WORKSPACE_MAX the workspace guard's limit.
const path = require('node:path');
const fsp = require('node:fs/promises');
const loadTs = require('../load-ts.cjs');

const { RunnerCore } = loadTs('src/runner/core.ts');
const { dockerCli } = loadTs('src/runner/sandbox/dockerCli.ts');
const { DockerDriver } = loadTs('src/runner/sandbox/dockerDriver.ts');

const { faultyCreate } = require('./createFaults.cjs');

// Only as a forked child with an IPC channel (a plain `node --test test/` that loads this file runs nothing).
if (typeof process.send === 'function') start();

function start() {
  const cli = dockerCli(fsp);
  const fault = process.env.NEXUS_TEST_CREATE_FAULT || '';
  const runner = fault ? { binary: () => cli.binary(), run: (argv, opts) => cli.run(faultyCreate(argv, fault), opts) } : cli;
  const transport = {
    postMessage: (m) => { if (process.connected) process.send(m); },
    on: (_event, fn) => process.on('message', fn)
  };
  const core = new RunnerCore(transport, {
    driver: new DockerDriver(runner, { now: Date.now }), now: Date.now, fs: fsp, docker: runner,
    imagesDir: path.resolve(__dirname, '..', '..', 'infra', 'images'),
    ...(process.env.NEXUS_TEST_WORKSPACE_MAX ? { limits: { workspaceMaxBytes: Number(process.env.NEXUS_TEST_WORKSPACE_MAX) } } : {}),
    // L10: the free space the runner reports (the lease floor hook); unset, the data home's real free space.
    ...(process.env.NEXUS_TEST_FREE_BYTES ? { freeBytes: async () => Number(process.env.NEXUS_TEST_FREE_BYTES) } : {}),
    onShutdown: () => process.exit(0)
  });
  process.on('disconnect', () => { void core.shutdown().finally(() => process.exit(0)); });
}
