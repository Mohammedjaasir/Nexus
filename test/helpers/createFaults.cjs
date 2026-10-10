'use strict';
// Test-only `docker create` faults (B2a Task 12: K10, K11, L9): the argv the Docker driver built is rewritten AFTER it
// was built, standing for a broken or tampered Docker. Used by test/helpers/runner-child.cjs (NEXUS_TEST_CREATE_FAULT)
// and by the in-process sandbox harness. Preflight or Docker itself must refuse every one of them.
function faultyCreate(argv, fault) {
  if (argv[0] !== 'create') return argv;
  const a = [...argv];
  const imageAt = a.findIndex((x) => /^sha256:[0-9a-f]{64}$/.test(x) || /@sha256:[0-9a-f]{64}$/.test(x));
  const insert = (items) => a.splice(imageAt, 0, ...items);
  if (fault === 'network-bridge') { const i = a.indexOf('--network'); if (i >= 0) a[i + 1] = 'bridge'; }
  if (fault === 'drop-pids') { const i = a.indexOf('--pids-limit'); if (i >= 0) a.splice(i, 2); }
  if (fault === 'docker-sock') insert(['--mount', 'type=bind,src=/var/run/docker.sock,dst=/var/run/docker.sock']);
  if (fault === 'memory-4m') { const m = a.indexOf('--memory'); if (m >= 0) a[m + 1] = '4m'; const s = a.indexOf('--memory-swap'); if (s >= 0) a[s + 1] = '4m'; }
  return a;
}

module.exports = { faultyCreate };
