import { describe, expect, it } from "vitest";
import { capabilityCanonicalOperationsForSurface } from "../../catalog/canonical-operations.js";

import {
  acpxRuntimePermissionPolicy,
  claudeNexusPermissionRules,
  decideAcpxPermission,
} from "./permission-policy.js";

describe("ACPX permission policy", () => {
  it.each(["approve-reads", "approve-nexus"] as const)("allows assigned canonical live reads, including approval lookup, in %s", mode => {
    const reads = capabilityCanonicalOperationsForSurface("live").filter(action => action.sideEffectClass === "read");
    expect(reads.some(action => action.operationId === "get_approval")).toBe(true);
    for (const action of reads) {
      expect(claudeNexusPermissionRules([{ name: action.operationId }], mode)).toEqual([`mcp__nexus__${action.operationId}`]);
    }
    expect(claudeNexusPermissionRules([{ name: "get_approval" }], "deny-all")).toEqual([]);
  });
  it("uses only catalogued reads assigned to this run, regardless of tool hints", () => {
    const tools = [
      "nexus__get_task_context", "read_document", "write_document",
      "call_api", "request_approval", "unknown_read", "mcp__other__get_task_context",
    ].map((name) => ({ name, annotations: { readOnlyHint: true, effect: "read" } }));
    expect(claudeNexusPermissionRules(tools, "approve-reads")).toEqual([
      "mcp__nexus__get_task_context", "mcp__nexus__read_document",
    ]);
    expect(claudeNexusPermissionRules([], "approve-reads")).toEqual([]);
  });

  it("allows assigned Nexus mutations without admitting unknown or external tools", () => {
    const tools = ["nexus__write_document", "create_task", "reassign_task", "request_approval",
      "write_document", "mcp__other__create_task", "Bash", "unknown_write", "mcp__nexus__create_task",
      "decide_approval", "control_workspace_service", "call_api", "create_skill", "schedule_wake"]
      .map(name => ({ name, annotations: { readOnlyHint: true } }));
    expect(claudeNexusPermissionRules(tools, "approve-nexus")).toEqual([
      "mcp__nexus__create_task", "mcp__nexus__reassign_task",
      "mcp__nexus__request_approval", "mcp__nexus__write_document",
    ]);
    expect(claudeNexusPermissionRules([], "approve-nexus")).toEqual([]);
    expect(claudeNexusPermissionRules(tools, "deny-all")).toEqual([]);
  });

  it("maps each configured mode to a closed ACP runtime policy", () => {
    expect(acpxRuntimePermissionPolicy("approve-all")).toEqual({
      defaultAction: "approve",
    });
    expect(acpxRuntimePermissionPolicy("deny-all")).toEqual({
      defaultAction: "deny",
    });
    expect(acpxRuntimePermissionPolicy("approve-nexus")).toEqual({ defaultAction: "escalate" });
    expect(acpxRuntimePermissionPolicy("approve-reads")).toEqual({
      defaultAction: "escalate",
    });
  });

  it.each(["approve-reads", "approve-nexus"] as const)("requires repository acquisition approval in %s", (mode) => {
    const tools = ["prepare_repository", "nexus__prepare_repository", "mcp__nexus__prepare_repository"]
      .map(name => ({ name, annotations: { readOnlyHint: true, effect: "read" } }));
    expect(claudeNexusPermissionRules(tools, mode)).toEqual([]);
    expect(decideAcpxPermission("claude", mode, {
      inferredKind: "read",
      raw: { toolCall: { name: "mcp__nexus__prepare_repository" } },
    })).toBe("delegate");
  });

  it.each([
    ["approve-all", "execute", "allow_once"],
    ["approve-reads", "read", "delegate"],
    ["approve-reads", "search", "delegate"],
    ["approve-reads", "execute", "delegate"],
    ["approve-nexus", "read", "delegate"],
    ["approve-nexus", "write", "delegate"],
    ["approve-nexus", "execute", "delegate"],
    ["deny-all", "read", "reject_once"],
  ] as const)("%s maps %s to %s", (mode, inferredKind, expected) => {
    expect(
      decideAcpxPermission("claude", mode, { inferredKind, raw: {} }),
    ).toBe(expected);
  });

  it("keeps deny-all closed against provider-supplied semantic metadata", () => {
    for (const [agent, raw] of [
      ["claude", { toolCall: { name: "mcp__nexus__nexus_finish" } }],
      ["claude", { toolCall: { rawInput: { serverName: "nexus" } } }],
      [
        "codex",
        {
          _meta: { is_mcp_tool_approval: true },
          toolCall: { title: "MCP approval" },
        },
      ],
    ] as const) {
      expect(
        decideAcpxPermission(
          agent,
          "deny-all",
          { inferredKind: "execute", raw },
          { allConfiguredMcpServersAreRunnerOwned: true },
        ),
      ).toBe("reject_once");
    }
  });

  it.each(["approve-reads", "approve-nexus"] as const)("does not let provider metadata widen %s", (mode) => {
    for (const [agent, inferredKind, raw, options] of [
      [
        "codex",
        "execute",
        {
          _meta: { is_mcp_tool_approval: true },
          toolCall: { title: "MCP approval" },
        },
        { allConfiguredMcpServersAreRunnerOwned: true },
      ],
      [
        "claude",
        "write",
        { toolCall: { rawInput: { serverName: "nexus" } } },
        {},
      ],
      [
        "claude",
        "execute",
        { toolCall: { name: "mcp__nexus__nexus_finish" } },
        {},
      ],
      [
        "claude",
        "write",
        {
          toolCall: {
            _meta: {
              claudeCode: { toolName: "mcp.nexus.get_task_context" },
            },
          },
        },
        {},
      ],
    ] as const) {
      expect(
        decideAcpxPermission(
          agent,
          mode,
          { inferredKind, raw },
          options,
        ),
      ).toBe("delegate");
    }
  });

  it("does not trust provider-originated read classifications", () => {
    for (const inferredKind of ["read", "search", "list", "READ"]) {
      expect(
        decideAcpxPermission("codex", "approve-reads", {
          inferredKind,
          raw: {
            _meta: { is_mcp_tool_approval: true },
            toolCall: {
              name: "mcp__nexus__get_task_context",
              rawInput: { serverName: "nexus" },
            },
          },
        }),
      ).toBe("delegate");
    }
  });
});
