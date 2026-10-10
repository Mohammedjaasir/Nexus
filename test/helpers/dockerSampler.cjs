'use strict';
// A Docker sampler in its own process (B2a Task 12 fix round 1, item 4; test:exec only, started by
// test/helpers/execReal.cjs dockerSampler). Every `ms` it counts the RUNNING containers carrying this install's
// `nexus.home` (and any extra labels) with `docker ps --filter status=running` and sends `{ running, at }` to its parent
// (-1 when Docker did not answer). Its synchronous docker calls run on THIS process's loop, never on main's, so L11's
// event-loop lag measures main alone. It stops on 'stop' or when its parent goes away.
const { spawnSync } = require('node:child_process');

// Only as a forked child with an IPC channel (a plain `node --test test/` that loads this file runs nothing).
if (typeof process.send === 'function' && process.argv[2]) start(JSON.parse(process.argv[2]));

function start({ home, extra, ms }) {
  const filters = ['--filter', 'status=running', '--filter', `label=nexus.home=${home}`,
    ...Object.entries(extra || {}).flatMap(([k, v]) => ['--filter', `label=${k}=${v}`])];
  let stopped = false;
  process.on('message', (m) => { if (m === 'stop') stopped = true; });
  process.on('disconnect', () => process.exit(0));
  const tick = () => {
    if (stopped || !process.connected) { process.exit(0); return; }
    const r = spawnSync('docker', ['ps', '-q', '--no-trunc', ...filters], { encoding: 'utf8', timeout: 10_000, windowsHide: true });
    const running = r.status === 0 ? (r.stdout || '').split(/\r?\n/).filter((x) => x.trim()).length : -1;
    try { process.send({ running, at: Date.now() }); } catch { process.exit(0); }
    setTimeout(tick, Math.max(50, Number(ms) || 200));
  };
  tick();
}
