'use strict';
// B2a Task 12: the SDE recipes end to end on REAL Docker with the pinned images (X1-X12). The same flows as the fake-driver
// file (test/helpers/recipeFlows.cjs), here with the runner in a child process, the real Docker driver, the Nexus entry
// and the images built from infra/images. Runs only behind the test:exec resource gate (node tools/run-exec-tests.cjs);
// anywhere else it prints the skip banner. Each title names the registry e2e test id of the step it proves.
const test = require('node:test');
const { realDockerOrSkip } = require('./helpers/execGate.cjs');

if (realDockerOrSkip()) {
  const { realWorld } = require('./helpers/execReal.cjs');
  const { flows } = require('./helpers/recipeFlows.cjs');
  let w = null;
  const ctx = {};
  const world = async () => { if (!w) w = await realWorld(); return w; };
  const run = (flow) => async () => flow(await world(), ctx);
  const LONG = { timeout: 20 * 60_000 };

  test('X1 e2e.sde.repository snapshot -> repository active, git.head_resolves passed (real Docker world)', LONG, run(flows.X1));
  test('X2 e2e.sde.tests node:test app in sde-node: discover -> suite -> sde.tests_pass passed -> candidate; JUnit counts equal discovery, every case attributed', LONG, run(flows.X2));
  test('X3 failing fixture -> suite failed (tests_failed), headline checks_failed', LONG, run(flows.X3));
  test('X4 empty fixture -> no_tests', LONG, run(flows.X4));
  test('X5 e2e.sde.build build in sde-node -> candidate, manifest hashed, blob.integrity passed', LONG, run(flows.X5));
  test('X6 e2e.sde.application assemble -> application draft, app.manifest_schema passed', LONG, run(flows.X6));
  test('X7 e2e.sde.dev-deployment dev deployment -> healthy on 127.0.0.1 through nexus-fwd, app.preview_health passed, application candidate; Stop -> stopped, cleaned up', LONG, run(flows.X7));
  test('X8 e2e.sde.diagnostics diagnose the running deployment -> diagnostic_report candidate with inspect, http and log sources', LONG, run(flows.X8));
  test('X9 bad health path -> app.preview_health failed, application failed', LONG, run(flows.X9));
  test('X10 pytest app in sde-python -> candidate; environment_json records the base digest, context hash and nexus.versions', LONG, run(flows.X10));
  test('X11 Python wheel build in sde-python -> candidate', LONG, run(flows.X11));
  test('X12 a manifest argument "; touch /out/pwned" stays one argv element and creates no file (the Nexus entry evaluates nothing)', LONG, run(flows.X12));
  test.after(async () => { if (w) await w.close(); });
}
