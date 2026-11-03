import { defineConfig } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const canaryVersion = process.env.NEXUSAI_VERSION?.trim();
if (!canaryVersion || !/^[0-9A-Za-z.+-]+$/.test(canaryVersion)) {
  throw new Error(
    "NEXUSAI_VERSION must name the exact published canary version to test",
  );
}

const baseUrl =
  process.env.NEXUS_CANARY_SMOKE_BASE_URL ?? "http://127.0.0.1:3233";
const parsedBaseUrl = new URL(baseUrl);
if (parsedBaseUrl.hostname !== "127.0.0.1" || !parsedBaseUrl.port) {
  throw new Error("NEXUS_CANARY_SMOKE_BASE_URL must use 127.0.0.1 and an explicit port");
}

const workspace = fs.mkdtempSync(
  path.join(os.tmpdir(), "nexus-canary-onboarding-smoke-"),
);
const dataDir = path.join(workspace, "data");
const npmCache = path.join(workspace, "npm-cache");
fs.mkdirSync(dataDir);
fs.mkdirSync(npmCache);

const serverLog =
  process.env.NEXUS_CANARY_SMOKE_SERVER_LOG ??
  path.join(workspace, "canary-onboarding-server.log");

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

const command = [
  shellQuote(process.execPath),
  shellQuote(path.resolve("tests/canary-onboarding/start-published-canary.mjs")),
  shellQuote(canaryVersion),
  shellQuote(workspace),
  shellQuote(dataDir),
  ">",
  shellQuote(serverLog),
  "2>&1",
].join(" ");

export default defineConfig({
  testDir: ".",
  testMatch: "**/*.spec.ts",
  timeout: 90_000,
  expect: {
    timeout: 20_000,
  },
  retries: 0,
  workers: 1,
  use: {
    baseURL: baseUrl,
    headless: true,
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: {
        browserName: "chromium",
        ...(process.env.NEXUS_PLAYWRIGHT_CHANNEL
          ? { channel: process.env.NEXUS_PLAYWRIGHT_CHANNEL }
          : {}),
      },
    },
  ],
  webServer: {
    command,
    url: `${baseUrl}/api/health`,
    reuseExistingServer: false,
    gracefulShutdown: { signal: "SIGTERM", timeout: 5_000 },
    timeout: 300_000,
    env: {
      ...process.env,
      PORT: parsedBaseUrl.port,
      NEXUS_NO_BROWSER: "1",
      NEXUS_OPEN_ON_LISTEN: "false",
      npm_config_cache: npmCache,
    },
  },
  outputDir: "./test-results",
  reporter: [
    ["list"],
    ["html", { open: "never", outputFolder: "./playwright-report" }],
  ],
});
