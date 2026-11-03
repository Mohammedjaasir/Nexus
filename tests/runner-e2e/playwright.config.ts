import path from "node:path";
import { defineConfig } from "@playwright/test";
import {
  runnerE2EWebServerCommand,
  runnerE2EWebServerGracefulShutdown,
} from "./web-server-command.js";

function required(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

const port = Number(required("NEXUS_RUNNER_E2E_PORT"));
const temporaryRoot = required("NEXUS_RUNNER_E2E_TEMP_ROOT");
const privateDir = required("NEXUS_RUNNER_E2E_PRIVATE_DIR");
const nexusHome = required("NEXUS_HOME");
const configPath = required("NEXUS_CONFIG");
const baseURL = `http://127.0.0.1:${port}`;
const playwrightChannel = process.env.NEXUS_PLAYWRIGHT_CHANNEL?.trim();
const chromiumExecutable =
  process.env.NEXUS_RUNNER_E2E_CHROMIUM_EXECUTABLE?.trim();
if (playwrightChannel && chromiumExecutable) {
  throw new Error(
    "NEXUS_PLAYWRIGHT_CHANNEL and NEXUS_RUNNER_E2E_CHROMIUM_EXECUTABLE are mutually exclusive",
  );
}
if (chromiumExecutable && !path.isAbsolute(chromiumExecutable)) {
  throw new Error(
    "NEXUS_RUNNER_E2E_CHROMIUM_EXECUTABLE must be an absolute path",
  );
}
required("NEXUS_INSTANCE_ID");
required("NEXUS_AGENT_JWT_SECRET");
required("NEXUS_DECISION_SIGNING_SECRET");
required("NEXUS_TOOL_ACTION_SIGNING_SECRET");
required("BETTER_AUTH_SECRET");
if (
  !nexusHome.startsWith(`${temporaryRoot}${path.sep}`) ||
  !configPath.startsWith(`${temporaryRoot}${path.sep}`)
) {
  throw new Error("Nexus server paths escape the isolated temporary root");
}
const repositoryRoot = path.resolve(import.meta.dirname, "../..");

export default defineConfig({
  testDir: ".",
  testMatch: process.env.NEXUS_RUNNER_E2E_INSTALLED_STARTUP_ONLY === "1" ? "installed-startup.spec.ts" : "runner.spec.ts",
  timeout: Number(process.env.NEXUS_RUNNER_E2E_TEST_TIMEOUT_MS ?? 600_000),
  expect: { timeout: 30_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  use: {
    baseURL,
    browserName: "chromium",
    ...(playwrightChannel ? { channel: playwrightChannel } : {}),
    ...(chromiumExecutable
      ? { launchOptions: { executablePath: chromiumExecutable } }
      : {}),
    headless: true,
    actionTimeout: 30_000,
    navigationTimeout: 30_000,
    screenshot: process.env.NEXUS_RUNNER_E2E_PUBLIC_MCP === "1" ? "off" : "only-on-failure",
    trace: process.env.NEXUS_RUNNER_E2E_PUBLIC_MCP === "1" ? "off" : "retain-on-failure",
    // A developer-supplied system Chromium keeps the local smoke loop
    // installation-free; CI's managed browser retains failure video as usual.
    video: chromiumExecutable || process.env.NEXUS_RUNNER_E2E_PUBLIC_MCP === "1" ? "off" : "retain-on-failure",
  },
  webServer: {
    // Do not put an env object here: Playwright serializes webServer config in
    // blob reports. The wrapper inherits the test process and strips provider
    // keys before spawning the real Nexus process.
    command: runnerE2EWebServerCommand(repositoryRoot),
    gracefulShutdown: { ...runnerE2EWebServerGracefulShutdown,
      ...(JSON.parse(process.env.NEXUS_RUNNER_E2E_EXECUTION_IDS ?? "[]").some((id: string) => id.startsWith("rolling-web-deployment.")) ? { timeout: 105_000 } : {}),
    },
    url: `${baseURL}/api/health`,
    reuseExistingServer: false,
    // Fresh databases apply the complete migration history before health is ready.
    timeout: 300_000,
    stdout: "pipe",
    stderr: "pipe",
  },
  outputDir: path.join(privateDir, "playwright-output"),
  reporter: [
    ["list"],
    ["blob", { outputDir: path.join(privateDir, "blob-report") }],
    ["junit", { outputFile: path.join(privateDir, "junit.xml") }],
    [
      "html",
      { open: "never", outputFolder: path.join(privateDir, "html-report") },
    ],
  ],
});
