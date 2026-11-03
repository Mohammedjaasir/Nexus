import { resolveNexusRunnerPiThinkingLevel } from "./nexus-runner-permissions.js";
import { describe, expect, it } from "vitest";

import {
  NEXUS_RUNNER_DEFAULT_MODELS,
  NEXUS_RUNNER_ACPX_PROFILES,
  nexusRunnerTransitionConfig,
  isNexusRunnerProvider,
  resolveNexusRunnerModel,
  resolveNexusRunnerPermissionMode,
  resolveNexusRunnerCursorMode,
} from "./nexus-runner-permissions.js";

describe("Nexus Runner permission defaults", () => {
  it("exposes qualified Kimi Code with an explicit runtime credential", () => {
    expect(NEXUS_RUNNER_ACPX_PROFILES.find(profile => profile.value === "kimi"))
      .toMatchObject({ qualified: true, credentialEnvironment: ["KIMI_API_KEY"] });
  });
  it("marks Pi and Copilot qualified with their provider credential bindings", () => {
    expect(NEXUS_RUNNER_ACPX_PROFILES.find(profile => profile.value === "pi"))
      .toMatchObject({ qualified: true, credentialEnvironment: expect.arrayContaining(["OPENROUTER_API_KEY", "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GEMINI_API_KEY"]) });
    expect(NEXUS_RUNNER_ACPX_PROFILES.find(profile => profile.value === "copilot"))
      .toMatchObject({ qualified: true, credentialEnvironment: ["COPILOT_GITHUB_TOKEN"] });
  });
  it("defaults Codex to the only qualified non-interactive mode", () => {
    expect(resolveNexusRunnerPermissionMode("codex", undefined)).toBe(
      "never",
    );
    expect(resolveNexusRunnerPermissionMode("codex", "on-request")).toBe("never");
    expect(resolveNexusRunnerPermissionMode("codex", "untrusted")).toBe("never");
  });

  it("defaults Claude and OpenCode to full auto", () => {
    expect(resolveNexusRunnerPermissionMode("opencode", undefined)).toBe(
      "allow",
    );
    expect(resolveNexusRunnerPermissionMode("acpx", undefined)).toBe(
      "approve-all",
    );
  });

  it.each(["approve-nexus", "approve-reads", "deny-all", "approve-all"])("preserves explicit Claude %s settings", (mode) => {
    expect(resolveNexusRunnerPermissionMode("acpx", mode)).toBe(mode);
  });

  it.each([
    ["claude_local", "acpxPermissionMode", "approve-all"],
    ["codex_local", "codexPermissionMode", "never"],
    ["opencode_local", "opencodePermissionMode", "allow"],
    ["pi_local", "acpxPermissionMode", "approve-all"],
    ["grok_local", "acpxPermissionMode", "approve-all"],
  ])("uses full auto when converting %s to the new runner", (adapter, key, value) => {
    expect(nexusRunnerTransitionConfig(adapter, undefined)).toMatchObject({ [key]: value });
  });

  it("keeps Pi models explicit during conversion", () => {
    expect(nexusRunnerTransitionConfig("pi_local", undefined)).toMatchObject({ provider: "acpx", acpxAgent: "pi", model: "" });
    expect(nexusRunnerTransitionConfig("pi_local", "openrouter/provider/model")).toMatchObject({ provider: "acpx", acpxAgent: "pi", model: "openrouter/provider/model" });
  });

  it("keeps Grok's harness and model when converting its adapter", () => {
    expect(nexusRunnerTransitionConfig("grok_local", "grok-4.7"))
      .toMatchObject({ provider: "acpx", acpxAgent: "grok", model: "grok-4.7" });
  });

  it.each([undefined, "", "grok-build"])("resolves Grok's legacy default %s to the native model", model => {
    expect(nexusRunnerTransitionConfig("grok_local", model)).toMatchObject({ model: "grok-4.7" });
  });

  it("recognizes only exact provider identifiers", () => {
    expect(isNexusRunnerProvider("codex")).toBe(true);
    expect(isNexusRunnerProvider("opencode")).toBe(true);
    expect(isNexusRunnerProvider("claude_managed")).toBe(true);
    expect(isNexusRunnerProvider("aws_agentcore")).toBe(true);
    expect(isNexusRunnerProvider("acpx")).toBe(true);
    expect(isNexusRunnerProvider("toString")).toBe(false);
    expect(isNexusRunnerProvider("__proto__")).toBe(false);
  });

  it("keeps managed provider permissions under the qualified profile", () => {
    expect(resolveNexusRunnerPermissionMode("claude_managed", "never"))
      .toBe("provider-managed");
    expect(resolveNexusRunnerPermissionMode("aws_agentcore", "approve-all"))
      .toBe("provider-managed");
  });

  it("uses the Codex default for missing or blank models", () => {
    expect(resolveNexusRunnerModel("codex", undefined)).toBe(
      NEXUS_RUNNER_DEFAULT_MODELS.codex,
    );
    expect(resolveNexusRunnerModel("codex", "   ")).toBe(
      NEXUS_RUNNER_DEFAULT_MODELS.codex,
    );
  });

  it("preserves an explicit Codex model", () => {
    expect(resolveNexusRunnerModel("codex", "gpt-5.5")).toBe("gpt-5.5");
    expect(resolveNexusRunnerModel("codex", "  gpt-5.5  ")).toBe("gpt-5.5");
  });
});


describe("Cursor session mode admission", () => {
  it.each([undefined, "agent", "plan", "ask"])("retains mode %s with an explicit Cursor default", mode => {
    expect(resolveNexusRunnerCursorMode("acpx", "cursor", mode)).toBe(mode ?? "agent");
  });
  it.each([null, "", "auto", "PLAN", true, {}, ["plan"]])("rejects invalid mode %j", mode => {
    expect(() => resolveNexusRunnerCursorMode("acpx", "cursor", mode)).toThrow("Cursor session mode");
  });
  it.each([["codex", "cursor"], ["acpx", "copilot"], ["acpx", "pi"], ["acpx", "claude"]])("rejects mode on %s/%s", (provider, agent) => {
    expect(resolveNexusRunnerCursorMode(provider, agent, undefined)).toBeUndefined();
    expect(() => resolveNexusRunnerCursorMode(provider, agent, "plan")).toThrow("only for Cursor");
  });
});

describe("Pi thinking configuration", () => {
  it.each([undefined, "off", "low", "high", "max"] as const)("persists exact level %s with low as the fresh-config default", value => {
    expect(resolveNexusRunnerPiThinkingLevel("acpx", "pi", value)).toBe(value ?? "low");
  });
  it.each(["medium", "minimal", "xhigh", "", null, 1])("rejects unsupported alias %s", value => {
    expect(() => resolveNexusRunnerPiThinkingLevel("acpx", "pi", value)).toThrow();
  });
  it("rejects foreign provider settings", () => {
    expect(() => resolveNexusRunnerPiThinkingLevel("codex", "pi", "low")).toThrow(/only/);
    expect(() => resolveNexusRunnerPiThinkingLevel("acpx", "cursor", "low")).toThrow(/only/);
    expect(resolveNexusRunnerPiThinkingLevel("codex", undefined, undefined)).toBeUndefined();
  });
});
