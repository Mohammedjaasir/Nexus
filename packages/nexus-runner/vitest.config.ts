import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { configDefaults, defineConfig } from "vitest/config";

const packageRoot = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  resolve: {
    alias: [
      { find: "@nexusai/nexus-runner/react", replacement: resolve(packageRoot, "src/react/index.ts") },
      { find: "@nexus-runner-local/capability", replacement: resolve(packageRoot, "src/scenarios/index.ts") },
    ],
  },
  test: {
    ...(process.env.NEXUS_CI_PROFILE === "true"
      ? { reporters: [...configDefaults.reporters, resolve(packageRoot, "../../scripts/ci-profile/vitest-reporter.mjs")] }
      : {}),
    environment: "node",
    include: [
      "src/**/*.test.ts",
      "src/**/*.test.tsx",
      "devtools/browser/src/**/*.test.ts",
      "devtools/issue-thread/src/**/*.test.ts",
      "devtools/issue-thread/src/**/*.test.tsx",
      "examples/scenario-explorer/src/**/*.test.ts",
      "examples/scenario-explorer/src/**/*.test.tsx",
      "scripts/local-runner-browser-server.test.mjs",
      "scripts/live-console-browser-server.test.mjs",
    ],
  },
});
