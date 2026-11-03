import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { NexusConfig } from "../config/schema.js";
import { addAllowedHostname } from "../commands/allowed-hostname.js";

function createTempConfigPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-allowed-hostname-"));
  return path.join(dir, "config.json");
}

function writeBaseConfig(configPath: string) {
  const base: NexusConfig = {
    $meta: {
      version: 1,
      updatedAt: new Date("2026-01-01T00:00:00.000Z").toISOString(),
      source: "configure",
    },
    database: {
      mode: "embedded-postgres",
      embeddedPostgresDataDir: "/tmp/nexus-db",
      embeddedPostgresPort: 54329,
      backup: {
        enabled: true,
        intervalMinutes: 60,
        retentionDays: 30,
        dir: "/tmp/nexus-backups",
      },
    },
    logging: {
      mode: "file",
      logDir: "/tmp/nexus-logs",
    },
    server: {
      deploymentMode: "authenticated",
      exposure: "private",
      host: "0.0.0.0",
      port: 3100,
      allowedHostnames: [],
      serveUi: true,
    },
    auth: {
      baseUrlMode: "auto",
      disableSignUp: false,
    },
    telemetry: {
      enabled: true,
    },
    storage: {
      provider: "local_disk",
      localDisk: { baseDir: "/tmp/nexus-storage" },
      s3: {
        bucket: "nexus",
        region: "us-east-1",
        prefix: "",
        forcePathStyle: false,
      },
    },
    secrets: {
      provider: "local_encrypted",
      strictMode: false,
      localEncrypted: { keyFilePath: "/tmp/nexus-secrets/master.key" },
    },
  };
  fs.writeFileSync(configPath, JSON.stringify(base, null, 2));
}

describe("allowed-hostname command", () => {
  it("adds and normalizes hostnames", async () => {
    const configPath = createTempConfigPath();
    writeBaseConfig(configPath);

    await addAllowedHostname("https://Dotta-MacBook-Pro:3100", { config: configPath });
    await addAllowedHostname("dotta-macbook-pro", { config: configPath });

    const raw = JSON.parse(fs.readFileSync(configPath, "utf-8")) as NexusConfig;
    expect(raw.server.allowedHostnames).toEqual(["dotta-macbook-pro"]);
  });
});
