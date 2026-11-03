import { describe, expect, it } from "vitest";
import {
  normalizeNexusOperationalSkillPreference,
  normalizeNexusRunnerAdapterConfig,
  NEXUS_OPERATIONAL_SKILL_KEY,
  resolveLegacyNexusDesiredSkillNames,
} from "@nexusai/adapter-utils/server-utils";

const legacyConfig = {
  nexusSkillSync: {
    desiredSkills: [NEXUS_OPERATIONAL_SKILL_KEY],
  },
};

describe("nexus_runner operational skill normalization", () => {
  it("applies full-auto native runner defaults at persistence boundaries", () => {
    expect(normalizeNexusRunnerAdapterConfig("nexus_runner", {})).toEqual({
      provider: "codex",
      model: "gpt-5.6-sol",
      codexPermissionMode: "never",
      lifecycleMode: "per_turn",
    });
  });

  it("repairs an existing blank model without replacing an explicit model", () => {
    expect(normalizeNexusRunnerAdapterConfig("nexus_runner", { model: "" }))
      .toMatchObject({ model: "gpt-5.6-sol" });
    expect(normalizeNexusRunnerAdapterConfig("nexus_runner", { model: "gpt-5.5" }))
      .toMatchObject({ model: "gpt-5.5" });
  });

  it("does not replace a non-Codex provider model with the Codex default", () => {
    expect(normalizeNexusRunnerAdapterConfig("nexus_runner", {
      provider: "claude_managed",
      model: "claude-sonnet-5",
    })).toMatchObject({
      provider: "claude_managed",
      model: "claude-sonnet-5",
    });
  });

  it("removes the legacy operational skill while preserving optional skills", () => {
    const normalized = normalizeNexusOperationalSkillPreference("nexus_runner", {
      nexusSkillSync: {
        desiredSkills: [NEXUS_OPERATIONAL_SKILL_KEY, "company-1/reviewer"],
      },
    });

    expect(normalized).toEqual({
      nexusSkillSync: { desiredSkills: ["company-1/reviewer"] },
    });
  });

  it("restores the required operational skill through the legacy resolver after switching back", () => {
    const normalized = normalizeNexusOperationalSkillPreference("nexus_runner", legacyConfig);
    expect(resolveLegacyNexusDesiredSkillNames(normalized, [{
      key: NEXUS_OPERATIONAL_SKILL_KEY,
      runtimeName: "nexus",
    }])).toEqual([NEXUS_OPERATIONAL_SKILL_KEY]);
  });

  it("does not change direct adapter preferences", () => {
    expect(normalizeNexusOperationalSkillPreference("codex_local", legacyConfig)).toBe(legacyConfig);
  });
});
