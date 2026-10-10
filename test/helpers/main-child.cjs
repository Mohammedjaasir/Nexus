'use strict';
// Main in its own process (B2a Task 12 fix round 1, item 13; test:exec only, started by test/helpers/execReal.cjs
// mainChild for L16). It reopens an existing database and data home exactly as a restarted app would (the platform, the
// REAL execution wiring and its runner child), starts `sde.build.run` of the repository version it is given, and reports
// `{ ok, jobId, containerId }` to its parent once the build's container runs. Then it does nothing until it is killed:
// the test kills it at once (a main crash: no quit path, no shutdown message, no store close), and a new main in the
// test process must adopt the still-running container.
//
// Only as a forked child with an IPC channel (a plain `node --test test/` that loads this file runs nothing).
if (typeof process.send === 'function') {
  process.once('message', (m) => { void run(m); });
}

async function run(m) {
  try {
    const { realWorld } = require('./execReal.cjs');
    const x = await realWorld({ reopen: { file: m.file, userData: m.userData, roots: new Set(m.roots) } });
    const j = x.start('sde.build.run', { inputs: [{ versionId: m.repo, slot: 'repository' }] });
    const live = () => x.db.prepare("SELECT container_id FROM job_attempts WHERE job_id = ? AND state IN ('starting','running') AND container_id IS NOT NULL").get(j.id);
    await x.until(() => x.job(j.id).state === 'running' && !!live(), 'the build runs', 3 * 60_000);
    process.send({ ok: true, jobId: j.id, containerId: live().container_id });
    // Stay up (holding the database, the wiring and the runner child) until the parent kills this process.
    setInterval(() => {}, 60_000);
  } catch (e) {
    try { process.send({ ok: false, error: String((e && e.stack) || e) }); } catch { /* the parent is gone */ }
  }
}
