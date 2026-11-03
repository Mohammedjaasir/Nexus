import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ensureCodexSkillsInjected } from "@nexusai/adapter-codex-local/server";

async function makeTempDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

async function createNexusRepoSkill(root: string, skillName: string) {
  await fs.mkdir(path.join(root, "server"), { recursive: true });
  await fs.mkdir(path.join(root, "packages", "adapter-utils"), { recursive: true });
  await fs.mkdir(path.join(root, "skills", skillName), { recursive: true });
  await fs.writeFile(path.join(root, "pnpm-workspace.yaml"), "packages:\n  - packages/*\n", "utf8");
  await fs.writeFile(path.join(root, "package.json"), '{"name":"nexus"}\n', "utf8");
  await fs.writeFile(
    path.join(root, "skills", skillName, "SKILL.md"),
    `---\nname: ${skillName}\n---\n`,
    "utf8",
  );
}

async function createCustomSkill(root: string, skillName: string) {
  await fs.mkdir(path.join(root, "custom", skillName), { recursive: true });
  await fs.writeFile(
    path.join(root, "custom", skillName, "SKILL.md"),
    `---\nname: ${skillName}\n---\n`,
    "utf8",
  );
}

describe("codex local adapter skill injection", () => {
  const nexusKey = "paperclipai/paperclip/nexus";
  const createAgentKey = "paperclipai/paperclip/nexus-create-agent";
  const cleanupDirs = new Set<string>();

  afterEach(async () => {
    await Promise.all(Array.from(cleanupDirs).map((dir) => fs.rm(dir, { recursive: true, force: true })));
    cleanupDirs.clear();
  });

  it("repairs a Codex Nexus skill symlink that still points at another live checkout", async () => {
    const currentRepo = await makeTempDir("nexus-codex-current-");
    const oldRepo = await makeTempDir("nexus-codex-old-");
    const skillsHome = await makeTempDir("nexus-codex-home-");
    cleanupDirs.add(currentRepo);
    cleanupDirs.add(oldRepo);
    cleanupDirs.add(skillsHome);

    await createNexusRepoSkill(currentRepo, "nexus");
    await createNexusRepoSkill(currentRepo, "nexus-create-agent");
    await createNexusRepoSkill(oldRepo, "nexus");
    await fs.symlink(path.join(oldRepo, "skills", "nexus"), path.join(skillsHome, "nexus"));

    const logs: Array<{ stream: "stdout" | "stderr"; chunk: string }> = [];
    await ensureCodexSkillsInjected(
      async (stream, chunk) => {
        logs.push({ stream, chunk });
      },
      {
        skillsHome,
        skillsEntries: [
          {
            key: nexusKey,
            runtimeName: "nexus",
            source: path.join(currentRepo, "skills", "nexus"),
          },
          {
            key: createAgentKey,
            runtimeName: "nexus-create-agent",
            source: path.join(currentRepo, "skills", "nexus-create-agent"),
          },
        ],
      },
    );

    expect(await fs.realpath(path.join(skillsHome, "nexus"))).toBe(
      await fs.realpath(path.join(currentRepo, "skills", "nexus")),
    );
    expect(await fs.realpath(path.join(skillsHome, "nexus-create-agent"))).toBe(
      await fs.realpath(path.join(currentRepo, "skills", "nexus-create-agent")),
    );
    expect(logs).toContainEqual(
      expect.objectContaining({
        stream: "stdout",
        chunk: expect.stringContaining('Repaired Codex skill "nexus"'),
      }),
    );
    expect(logs).toContainEqual(
      expect.objectContaining({
        stream: "stdout",
        chunk: expect.stringContaining('Injected Codex skill "nexus-create-agent"'),
      }),
    );
  });

  it("preserves a custom Codex skill symlink outside Nexus repo checkouts", async () => {
    const currentRepo = await makeTempDir("nexus-codex-current-");
    const customRoot = await makeTempDir("nexus-codex-custom-");
    const skillsHome = await makeTempDir("nexus-codex-home-");
    cleanupDirs.add(currentRepo);
    cleanupDirs.add(customRoot);
    cleanupDirs.add(skillsHome);

    await createNexusRepoSkill(currentRepo, "nexus");
    await createCustomSkill(customRoot, "nexus");
    await fs.symlink(path.join(customRoot, "custom", "nexus"), path.join(skillsHome, "nexus"));

    await ensureCodexSkillsInjected(async () => {}, {
      skillsHome,
      skillsEntries: [{
        key: nexusKey,
        runtimeName: "nexus",
        source: path.join(currentRepo, "skills", "nexus"),
      }],
    });

    expect(await fs.realpath(path.join(skillsHome, "nexus"))).toBe(
      await fs.realpath(path.join(customRoot, "custom", "nexus")),
    );
  });

  it("prunes broken symlinks for unavailable Nexus repo skills before Codex starts", async () => {
    const currentRepo = await makeTempDir("nexus-codex-current-");
    const oldRepo = await makeTempDir("nexus-codex-old-");
    const skillsHome = await makeTempDir("nexus-codex-home-");
    cleanupDirs.add(currentRepo);
    cleanupDirs.add(oldRepo);
    cleanupDirs.add(skillsHome);

    await createNexusRepoSkill(currentRepo, "nexus");
    await createNexusRepoSkill(oldRepo, "agent-browser");
    const staleTarget = path.join(oldRepo, "skills", "agent-browser");
    await fs.symlink(staleTarget, path.join(skillsHome, "agent-browser"));
    await fs.rm(staleTarget, { recursive: true, force: true });

    const logs: Array<{ stream: "stdout" | "stderr"; chunk: string }> = [];
    await ensureCodexSkillsInjected(
      async (stream, chunk) => {
        logs.push({ stream, chunk });
      },
      {
        skillsHome,
        skillsEntries: [{
          key: nexusKey,
          runtimeName: "nexus",
          source: path.join(currentRepo, "skills", "nexus"),
        }],
      },
    );

    await expect(fs.lstat(path.join(skillsHome, "agent-browser"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(logs).toContainEqual(
      expect.objectContaining({
        stream: "stdout",
        chunk: expect.stringContaining('Removed stale Codex skill "agent-browser"'),
      }),
    );
  });

  it("preserves other live Nexus skill symlinks in the shared workspace skill directory", async () => {
    const currentRepo = await makeTempDir("nexus-codex-current-");
    const skillsHome = await makeTempDir("nexus-codex-home-");
    cleanupDirs.add(currentRepo);
    cleanupDirs.add(skillsHome);

    await createNexusRepoSkill(currentRepo, "nexus");
    await createNexusRepoSkill(currentRepo, "agent-browser");
    await fs.symlink(
      path.join(currentRepo, "skills", "agent-browser"),
      path.join(skillsHome, "agent-browser"),
    );

    await ensureCodexSkillsInjected(async () => {}, {
      skillsHome,
      skillsEntries: [{
        key: nexusKey,
        runtimeName: "nexus",
        source: path.join(currentRepo, "skills", "nexus"),
      }],
    });

    expect((await fs.lstat(path.join(skillsHome, "nexus"))).isSymbolicLink()).toBe(true);
    expect((await fs.lstat(path.join(skillsHome, "agent-browser"))).isSymbolicLink()).toBe(true);
    expect(await fs.realpath(path.join(skillsHome, "agent-browser"))).toBe(
      await fs.realpath(path.join(currentRepo, "skills", "agent-browser")),
    );
  });
});
