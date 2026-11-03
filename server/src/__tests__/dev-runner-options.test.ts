import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { applyDevRunnerOptions } from "../../../scripts/dev-runner-options.ts";

describe("applyDevRunnerOptions", () => {
  it("turns --data-dir into isolated Nexus paths and consumes the option", () => {
    const env: NodeJS.ProcessEnv = {};
    const cwd = path.join(os.tmpdir(), "nexus-dev-runner-options");
    const previousInstanceId = process.env.NEXUS_INSTANCE_ID;
    process.env.NEXUS_INSTANCE_ID = "ambient-test-instance";

    try {
      const result = applyDevRunnerOptions(
        ["--bind", "loopback", "--data-dir", "./tmp", "--future-option"],
        env,
        cwd,
      );

      const expectedHome = path.resolve(cwd, "tmp");
      expect(result).toEqual({
        forwardedArgs: ["--bind", "loopback", "--future-option"],
        dataDir: expectedHome,
      });
      expect(env.NEXUS_HOME).toBe(expectedHome);
      expect(env.NEXUS_INSTANCE_ID).toBe("default");
      expect(env.NEXUS_CONFIG).toBe(
        path.join(expectedHome, "instances", "default", "config.json"),
      );
      expect(env.NEXUS_CONTEXT).toBe(path.join(expectedHome, "context.json"));
    } finally {
      if (previousInstanceId === undefined) {
        delete process.env.NEXUS_INSTANCE_ID;
      } else {
        process.env.NEXUS_INSTANCE_ID = previousInstanceId;
      }
    }
  });

  it.each([
    ["short option", ["-d", "~/nexus-dev"]],
    ["equals form", ["--data-dir=~/nexus-dev"]],
  ])("supports the %s", (_label, args) => {
    const env: NodeJS.ProcessEnv = {};

    const result = applyDevRunnerOptions(args, env, "/unused");

    expect(result.forwardedArgs).toEqual([]);
    expect(result.dataDir).toBe(path.join(os.homedir(), "nexus-dev"));
  });

  it("uses the selected instance for the default config path", () => {
    const env: NodeJS.ProcessEnv = { NEXUS_INSTANCE_ID: "experiment" };

    applyDevRunnerOptions(["--data-dir", "/isolated/home"], env, "/unused");

    expect(env.NEXUS_CONFIG).toBe(
      path.join("/isolated/home", "instances", "experiment", "config.json"),
    );
  });

  it("preserves explicit config and context paths", () => {
    const env: NodeJS.ProcessEnv = {
      NEXUS_CONFIG: "/explicit/config.json",
      NEXUS_CONTEXT: "/explicit/context.json",
    };

    applyDevRunnerOptions(["--data-dir", "/isolated/home"], env, "/unused");

    expect(env.NEXUS_HOME).toBe("/isolated/home");
    expect(env.NEXUS_CONFIG).toBe("/explicit/config.json");
    expect(env.NEXUS_CONTEXT).toBe("/explicit/context.json");
  });

  it.each([["--data-dir"], ["-d"], ["--data-dir="]])(
    "rejects a missing value for %s",
    (...args) => {
      expect(() => applyDevRunnerOptions(args, {}, "/unused")).toThrow(
        /requires a value/,
      );
    },
  );
});
