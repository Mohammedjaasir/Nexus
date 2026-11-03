import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { ACPX_QUALIFICATION_ENV, ANTIGRAVITY_CANDIDATE_ADMISSION_ENV, resolveAcpxQualification, resolveKimiCandidateAdmission } from "./acpx-qualification.js";
import { QUALIFIED_ACPX_PROFILES, KIMI_DISTRIBUTION_CLOSURE_SHA256 } from "../../vendor/nexus-runner/index.js";
import type { NativeExecutionInput } from "../../vendor/nexus-runner/index.js";
import { resolveNexusRunnerProviderProfile, resolveNexusRunnerNativeProviderInput } from "./provider-profile.js";

const provider = { kind: "acpx", agent: "copilot", model: "exact-model", permissionMode: "approve-all" } as Extract<NativeExecutionInput["provider"], { kind: "acpx" }>;
const authorize = (value: unknown) => ({ [ACPX_QUALIFICATION_ENV]: JSON.stringify(value) });
describe("host ACPX qualification admission", () => {
  afterEach(() => vi.unstubAllEnvs());

  it.each([undefined, "malformed", JSON.stringify(kimiAdmission("linux", "x64"))])("admits released Kimi without candidate authority (%s)", authority => {
    vi.stubEnv(ANTIGRAVITY_CANDIDATE_ADMISSION_ENV, authority);
    vi.stubEnv(ACPX_QUALIFICATION_ENV, "malformed-unrelated-authority");
    const config = { provider: "acpx", acpxAgent: "kimi", model: "kimi-for-coding" };
    expect(QUALIFIED_ACPX_PROFILES.kimi.agentProfileVersion).toBe(17);
    expect(QUALIFIED_ACPX_PROFILES.kimi.qualificationStatus).not.toBe("pending");
    expect(resolveKimiCandidateAdmission({ companyId: "candidate-company", model: config.model })).toBeUndefined();
    expect(resolveNexusRunnerProviderProfile(config, { companyId: "candidate-company" })).toMatchObject(config);
    expect(resolveNexusRunnerNativeProviderInput({ companyId: "candidate-company", backend: "acpx_runtime", adapterConfig: config }))
      .toMatchObject({ ...config, acpxPermissionMode: "approve-all" });
    expect(() => resolveNexusRunnerProviderProfile({ ...config, model: "" }))
      .toThrow(expect.objectContaining({ code: "nexus_runner_acpx_model_required" }));
  });

  it.each([undefined, "malformed", JSON.stringify([{ agent: "antigravity", model: "exact-model" }])])(
    "keeps pending Antigravity closed despite host authorization (%s)", host => {
      vi.stubEnv(ACPX_QUALIFICATION_ENV, host);
      const config = { provider: "acpx", acpxAgent: "antigravity", model: "exact-model",
        env: { [ACPX_QUALIFICATION_ENV]: JSON.stringify([{ agent: "antigravity", model: "exact-model" }]) } };
      for (const resolve of [() => resolveNexusRunnerProviderProfile(config),
        () => resolveNexusRunnerNativeProviderInput({ backend: "acpx_runtime", adapterConfig: config })]) {
        expect(resolve).toThrow(expect.objectContaining({ code: "nexus_runner_acpx_agent_unavailable" }));
        expect(resolve).toThrow("Google Antigravity is awaiting native Runner acceptance");
      }
    },
  );

  it("admits only the exact Pi model without host authorization and preserves permission modes", () => {
    const config = { provider: "acpx", acpxAgent: "pi", model: "openrouter/deepseek/deepseek-v4-flash-0731" };
    for (const authorization of [undefined, "malformed unrelated candidate authorization"]) {
      vi.stubEnv(ACPX_QUALIFICATION_ENV, authorization);
      expect(resolveNexusRunnerProviderProfile(config)).toMatchObject(config);
      for (const acpxPermissionMode of [undefined, "approve-all", "approve-nexus", "approve-reads", "deny-all"]) {
        expect(resolveNexusRunnerNativeProviderInput({ backend: "acpx_runtime", adapterConfig: { ...config, acpxPermissionMode } }))
          .toMatchObject({ ...config, acpxPermissionMode: acpxPermissionMode ?? "approve-all" });
      }
      for (const model of [undefined, ""]) {
        expect(() => resolveNexusRunnerProviderProfile({ ...config, model }))
          .toThrow(expect.objectContaining({ code: "nexus_runner_acpx_model_required" }));
      }
    }
  });

  it.each([[], {}, [{ agent: "cursor", model: "" }], [{ agent: "cursor", model: " exact-model" }],
    [{ agent: "cursor", model: "exact-model", allowAll: true }], [{ agent: "claude", model: "exact-model" }],
    [{ agent: "cursor", model: "exact-model" }, { agent: "cursor", model: "exact-model" }],
  ])("rejects malformed or broad authorization %j", entries => {
    expect(() => resolveAcpxQualification({ ...provider, agent: "pi" }, authorize(entries))).toThrow("Invalid ACPX");
  });
  it("admits Cursor through ordinary configuration and ignores unrelated qualification authority", () => {
    const config = { provider: "acpx", acpxAgent: "cursor", model: "exact-cursor-model" };
    vi.stubEnv(ACPX_QUALIFICATION_ENV, JSON.stringify([{ agent: "pi", model: "pi-model" }]));
    expect(resolveNexusRunnerProviderProfile(config)).toMatchObject({ acpxAgent: "cursor", model: config.model });
    expect(resolveNexusRunnerNativeProviderInput({ backend: "acpx_runtime", adapterConfig: config })).toMatchObject({ acpxAgent: "cursor", model: config.model });
    expect(resolveAcpxQualification({ ...provider, agent: "cursor" } as typeof provider, authorize([]))).toBeUndefined();
    expect(() => resolveNexusRunnerProviderProfile({ ...config, model: "" })).toThrow(expect.objectContaining({ code: "nexus_runner_acpx_model_required" }));
  });
  it.each([undefined, "malformed", JSON.stringify([{agent:"pi",model:"pi-model"}])])("admits ordinary Copilot without host overrides (%s)", host => {
    vi.stubEnv(ACPX_QUALIFICATION_ENV,host);
    const config={provider:"acpx",acpxAgent:"copilot",model:"gpt-5.6-luna"};
    expect(resolveNexusRunnerProviderProfile(config)).toMatchObject({acpxAgent:"copilot",model:config.model});
    expect(resolveNexusRunnerNativeProviderInput({backend:"acpx_runtime",adapterConfig:config})).toMatchObject({acpxAgent:"copilot",model:config.model});
    expect(resolveAcpxQualification({...provider,model:config.model},{})).toBe("copilot");
  });
  it.each(["", " ", "auto", "default"])("refuses implicit Copilot model %s",model=>{
    expect(()=>resolveNexusRunnerProviderProfile({provider:"acpx",acpxAgent:"copilot",model})).toThrow(expect.objectContaining({code:"nexus_runner_acpx_model_required"}));
    expect(()=>resolveAcpxQualification({...provider,model},{})).toThrow("explicit available model");
  });
  it("does not alter existing qualified providers", () => {
    expect(resolveAcpxQualification({ ...provider, agent: "codex" } as typeof provider, authorize([]))).toBeUndefined();
  });
  it.each(["claude", "codex", "grok", "cursor", "pi"])("keeps %s model selection open to native verification", (acpxAgent) => {
    const adapterConfig = { provider: "acpx", acpxAgent, model: "explicit-new-model" };
    expect(resolveNexusRunnerProviderProfile(adapterConfig))
      .toMatchObject({ acpxAgent, model: "explicit-new-model" });
    expect(resolveNexusRunnerNativeProviderInput({ backend: "acpx_runtime", adapterConfig }))
      .toMatchObject({ acpxAgent, model: "explicit-new-model" });
  });
  it("requires an explicit Codex ACP selection", () => {
    for (const model of [undefined, "", " "]) {
      expect(() => resolveNexusRunnerProviderProfile({ provider: "acpx", acpxAgent: "codex", model }))
        .toThrow(expect.objectContaining({ code: "nexus_runner_acpx_model_unqualified" }));
    }
  });
  it("preserves product defaults separately from qualification examples", () => {
    for (const [acpxAgent, model] of [["claude", "claude-opus-5-5"], ["grok", "grok-4.7"]]) {
      expect(resolveNexusRunnerProviderProfile({ provider: "acpx", acpxAgent }))
        .toMatchObject({ acpxAgent, model });
    }
  });
  it("binds the executor to host process environment rather than agent configuration", () => {
    const source = readFileSync(new URL("./native-session-executor.ts", import.meta.url), "utf8");
    expect(source).toContain("resolveAcpxQualification(input.execution.provider, process.env)");
    expect(source).not.toContain("resolveAcpxQualification(input.execution.provider, effectiveRunnerEnvironment)");
  });
});

it.each([undefined, "off", "low", "high", "max"] as const)("validates saved Pi thinking %s and projects it explicitly", piThinkingLevel => {
  const adapterConfig = { provider: "acpx", acpxAgent: "pi", model: "openrouter/deepseek/deepseek-v4-flash-0731", piThinkingLevel };
  expect(resolveNexusRunnerNativeProviderInput({ backend: "acpx_runtime", adapterConfig })).toMatchObject({ piThinkingLevel: piThinkingLevel ?? "low" });
  for (const alias of ["medium", "minimal", "xhigh"]) expect(() => resolveNexusRunnerProviderProfile({ ...adapterConfig, piThinkingLevel: alias })).toThrow(expect.objectContaining({ code: "nexus_runner_pi_thinking_invalid" }));
});

function kimiAdmission(platform: "darwin" | "linux", architecture: "arm64" | "x64") {
  return { schema: "nexus.acpx-candidate-admission.v1", companyId: "candidate-company", agent: "kimi", model: "kimi-for-coding",
    platform, architecture, expiresAt: Date.now() + 60_000, profileDigest: QUALIFIED_ACPX_PROFILES.kimi.commandDigest,
    nativeClosureDigest: `sha256:${KIMI_DISTRIBUTION_CLOSURE_SHA256[`${platform}-${architecture}` as "darwin-arm64" | "linux-x64"]}` };
}
