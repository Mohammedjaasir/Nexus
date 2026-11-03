import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  listCursorSkills,
  syncCursorSkills,
} from "@nexusai/adapter-cursor-local/server";

async function makeTempDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

async function createSkillDir(root: string, name: string) {
  const skillDir = path.join(root, name);
  await fs.mkdir(skillDir, { recursive: true });
  await fs.writeFile(path.join(skillDir, "SKILL.md"), `---\nname: ${name}\n---\n`, "utf8");
  return skillDir;
}

describe("cursor local skill sync", () => {
  const nexusKey = "paperclipai/paperclip/nexus";
  const cleanupDirs = new Set<string>();

  afterEach(async () => {
    await Promise.all(Array.from(cleanupDirs).map((dir) => fs.rm(dir, { recursive: true, force: true })));
    cleanupDirs.clear();
  });

  it("defaults and installs the operational Nexus skill in the Cursor skills home", async () => {
    const home = await makeTempDir("nexus-cursor-skill-sync-");
    cleanupDirs.add(home);

    const ctx = {
      agentId: "agent-1",
      companyId: "company-1",
      adapterType: "cursor",
      config: {
        env: {
          HOME: home,
        },
      },
    } as const;

    const before = await listCursorSkills(ctx);
    expect(before.mode).toBe("persistent");
    expect(before.desiredSkills).toContain(nexusKey);
    expect(before.entries.find((entry) => entry.key === nexusKey)?.state).toBe("missing");

    const after = await syncCursorSkills(ctx, [nexusKey]);
    expect(after.entries.find((entry) => entry.key === nexusKey)?.state).toBe("installed");
    expect((await fs.lstat(path.join(home, ".cursor", "skills", "nexus"))).isSymbolicLink()).toBe(true);
  });

  it("keeps the operational skill installed after an explicit empty replacement", async () => {
    const home = await makeTempDir("nexus-cursor-required-skill-");
    cleanupDirs.add(home);

    const snapshot = await syncCursorSkills({
      agentId: "agent-required",
      companyId: "company-1",
      adapterType: "cursor",
      config: {
        env: { HOME: home },
        nexusSkillSync: { desiredSkills: [] },
      },
    }, []);

    expect(snapshot.desiredSkills).toEqual([nexusKey, "paperclipai/paperclip/complain", "paperclipai/paperclip/suggestion-box"]);
    expect(snapshot.entries.find((entry) => entry.key === nexusKey)?.state).toBe("installed");
    expect((await fs.lstat(path.join(home, ".cursor", "skills", "nexus"))).isSymbolicLink()).toBe(true);
  });

  it("recognizes company-library runtime skills supplied outside the bundled Nexus directory", async () => {
    const home = await makeTempDir("nexus-cursor-runtime-skills-home-");
    const runtimeSkills = await makeTempDir("nexus-cursor-runtime-skills-src-");
    cleanupDirs.add(home);
    cleanupDirs.add(runtimeSkills);

    const nexusDir = await createSkillDir(runtimeSkills, "nexus");
    const asciiHeartDir = await createSkillDir(runtimeSkills, "ascii-heart");

    const ctx = {
      agentId: "agent-3",
      companyId: "company-1",
      adapterType: "cursor",
      config: {
        env: {
          HOME: home,
        },
        nexusRuntimeSkills: [
          {
            key: "nexus",
            runtimeName: "nexus",
            source: nexusDir,
          },
          {
            key: "ascii-heart",
            runtimeName: "ascii-heart",
            source: asciiHeartDir,
          },
        ],
        nexusSkillSync: {
          desiredSkills: ["ascii-heart"],
        },
      },
    } as const;

    const before = await listCursorSkills(ctx);
    expect(before.warnings).toEqual([]);
    expect(before.desiredSkills).toEqual(["ascii-heart"]);
    expect(before.entries.find((entry) => entry.key === "ascii-heart")?.state).toBe("missing");

    const after = await syncCursorSkills(ctx, ["ascii-heart"]);
    expect(after.warnings).toEqual([]);
    expect(after.entries.find((entry) => entry.key === "ascii-heart")?.state).toBe("installed");
    expect((await fs.lstat(path.join(home, ".cursor", "skills", "ascii-heart"))).isSymbolicLink()).toBe(true);
  });

});
