import { describe, expect, it } from "vitest";
import { sanitizeInheritedNexusEnv } from "./server-utils.js";

describe("sanitizeInheritedNexusEnv", () => {
  it("drops the host-only Nexus CLI command pointer", () => {
    expect(sanitizeInheritedNexusEnv({
      NEXUSAI_CMD: "node /missing/nexusai/dist/index.js",
      NEXUS_RUNTIME_API_URL: "http://127.0.0.1:3100",
      PATH: "/usr/bin",
    })).toEqual({
      NEXUS_RUNTIME_API_URL: "http://127.0.0.1:3100",
      PATH: "/usr/bin",
    });
  });
});
