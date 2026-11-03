import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  listKimiSkills,
  syncKimiSkills,
} from "@nexusai/adapter-kimi-local/server";

async function makeTempDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

describe("kimi local skill sync", () => {
  const nexusKey = "paperclipai/paperclip/nexus";
  const cleanupDirs = new Set<string>();

  afterEach(async () => {
    await Promise.all(Array.from(cleanupDirs).map((dir) => fs.rm(dir, { recursive: true, force: true })));
    cleanupDirs.clear();
  });

  it("defaults and installs the operational Nexus skill in the Kimi skills home", async () => {
    const kimiCodeHome = await makeTempDir("nexus-kimi-skill-sync-");
    cleanupDirs.add(kimiCodeHome);

    const ctx = {
      agentId: "agent-1",
      companyId: "company-1",
      adapterType: "kimi_local",
      config: {
        env: {
          KIMI_CODE_HOME: kimiCodeHome,
        },
      },
    } as const;

    const before = await listKimiSkills(ctx);
    expect(before.adapterType).toBe("kimi_local");
    expect(before.mode).toBe("persistent");
    expect(before.desiredSkills).toContain(nexusKey);
    expect(before.entries.find((entry) => entry.key === nexusKey)?.state).toBe("missing");

    const after = await syncKimiSkills(ctx, [nexusKey]);
    expect(after.entries.find((entry) => entry.key === nexusKey)?.state).toBe("installed");
    expect((await fs.lstat(path.join(kimiCodeHome, "skills", "nexus"))).isSymbolicLink()).toBe(true);
  });
});
