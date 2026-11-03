import { describe, expect, it } from "vitest";
import {
  findNexusConfigKeyWarnings,
  mergeNexusConfig,
  nexusConfigSchema,
} from "./config-schema.js";

describe("nexus config schema", () => {
  it("defaults omitted runtime paths to legacy instance-root locations", () => {
    const parsed = nexusConfigSchema.parse({
      $meta: {
        version: 1,
        updatedAt: "2026-05-10T00:00:00.000Z",
        source: "configure",
      },
      database: {
        mode: "embedded-postgres",
      },
      logging: {
        mode: "file",
      },
      server: {},
    });

    expect(parsed.database.embeddedPostgresDataDir).toBe("~/.nexus/instances/default/db");
    expect(parsed.database.backup.dir).toBe("~/.nexus/instances/default/data/backups");
    expect(parsed.logging.logDir).toBe("~/.nexus/instances/default/logs");
    expect(parsed.storage.localDisk.baseDir).toBe("~/.nexus/instances/default/data/storage");
    expect(parsed.secrets.localEncrypted.keyFilePath).toBe("~/.nexus/instances/default/secrets/master.key");
  });

  it("retains extension keys at the top level and every nested config boundary", () => {
    const parsed = nexusConfigSchema.parse({
      $meta: {
        version: 1,
        updatedAt: "2026-05-10T00:00:00.000Z",
        source: "configure",
        extensionMeta: "keep",
      },
      database: {
        mode: "embedded-postgres",
        backup: {
          backupExtension: "keep",
        },
      },
      logging: {
        mode: "file",
      },
      server: {
        serverExtension: "keep",
      },
      storage: {
        localDisk: {
          driverExtension: "keep",
        },
        s3: {
          s3Extension: "keep",
        },
      },
      secrets: {
        localEncrypted: {
          providerExtension: "keep",
        },
      },
      topLevelExtension: {
        enabled: true,
      },
    });

    expect(parsed).toMatchObject({
      $meta: { extensionMeta: "keep" },
      database: { backup: { backupExtension: "keep" } },
      server: { serverExtension: "keep" },
      storage: {
        localDisk: { driverExtension: "keep" },
        s3: { s3Extension: "keep" },
      },
      secrets: { localEncrypted: { providerExtension: "keep" } },
      topLevelExtension: { enabled: true },
    });
  });

  it("merges retained extensions without resurrecting removed known fields", () => {
    const source = nexusConfigSchema.parse({
      $meta: {
        version: 1,
        updatedAt: "2026-05-10T00:00:00.000Z",
        source: "configure",
      },
      llm: {
        provider: "openai",
        apiKey: "remove-me",
        providerExtension: "keep",
      },
      database: { mode: "embedded-postgres" },
      logging: { mode: "file" },
      server: { port: 3100, serverExtension: "keep" },
      topLevelExtension: "keep",
    });
    const update = nexusConfigSchema.parse({
      ...source,
      llm: {
        provider: "openai",
      },
      server: {
        ...source.server,
        port: 3200,
      },
    });

    const merged = mergeNexusConfig(source, update);

    expect(merged.server.port).toBe(3200);
    expect(merged.server.serverExtension).toBe("keep");
    expect(merged.topLevelExtension).toBe("keep");
    expect(merged.llm?.providerExtension).toBe("keep");
    expect(merged.llm).not.toHaveProperty("apiKey");
  });

  it("warns about likely misspellings while leaving arbitrary extensions alone", () => {
    expect(findNexusConfigKeyWarnings({
      servr: {},
      server: {
        ports: 3100,
        pluginOptions: {
          arbitrary: true,
        },
      },
      extensionNamespace: {
        port: 9999,
      },
    })).toEqual([
      { path: "servr", suggestion: "server" },
      { path: "server.ports", suggestion: "server.port" },
    ]);
  });
});
