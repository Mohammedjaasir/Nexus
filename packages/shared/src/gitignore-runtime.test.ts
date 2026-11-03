import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// packages/shared/src/ is three levels below the repo root
const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

describe("gitignore: .nexus-runtime/", () => {
  it("ignores files under .nexus-runtime/ via the explicit gitignore rule", () => {
    const output = execSync(
      "git check-ignore -v .nexus-runtime/codex/home/auth.json",
      { cwd: REPO_ROOT, encoding: "utf8" },
    ).trim();
    // Output format: <source>:<line>:<pattern>\t<path>
    // Asserts that the rule comes from .gitignore and matches .nexus-runtime/
    expect(output).toMatch(/^\.gitignore:\d+:\.nexus-runtime\//);
  });
});
