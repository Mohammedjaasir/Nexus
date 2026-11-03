import test from 'node:test';
import { verifyControllerRuntime } from '../../packages/nexus-runner/scripts/controlled-evals/verify-runtime.mjs';

test('the uploaded controller preserves every inventoried runtime file', {
  skip: !process.env.NEXUS_CONTROLLER_TRANSPORT_DIRECTORY,
}, async () => {
  await verifyControllerRuntime({
    directory: process.env.NEXUS_CONTROLLER_TRANSPORT_DIRECTORY,
    sourceRevision: process.env.GITHUB_SHA,
    receiptSha256: process.env.NEXUS_CONTROLLER_RECEIPT_SHA256,
  });
});
