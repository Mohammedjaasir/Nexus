import { describe, expect, it } from "vitest";
import { classifyCodexNotification } from "./codex-notification-identity.js";
const classify = (method: string, params: Record<string, unknown>) =>
  classifyCodexNotification({
    method,
    params,
    runId: "run",
    rootThreadId: "root",
    activeTurnId: "active",
    knownThreads: new Set(["root", "child"]),
    settledTurns: new Set(["old"]),
  }).classification;
describe("provider notification authority", () => {
  it.each([
    ["warning", { message: "buffered before replacement rejection" }, "root"],
    ["nexus/canonicalProviderEvent", { threadId: null, eventType: "provider.notice.recorded" }, "root"],
    ["nexus/canonicalProviderEvent", { threadId: null, eventType: "auth.credentials.updated" }, "root"],
    ["nexus/canonicalProviderEvent", { threadId: "child", eventType: "auth.credentials.updated" }, "invalid_authority"],
    ["nexus/canonicalProviderEvent", { threadId: null, eventType: "tool.execution.started" }, "invalid_authority"],
    ["item/started", { threadId: "root", turnId: "active" }, "root"],
    ["nexus/runtimeRequestExpired", { threadId: "root", turnId: "active" }, "root"],
    ["nexus/runtimeRequestExpired", { threadId: "child", turnId: "active" }, "invalid_authority"],
    ["nexus/runtimeRequestExpired", { threadId: null, turnId: "active" }, "invalid_authority"],
    ["nexus/runtimeRequestExpired", { threadId: "root", turnId: "old" }, "stale_turn"],
    ["turn/completed", { threadId: "root", turnId: "old" }, "stale_turn"],
    [
      "turn/completed",
      { threadId: "child", turnId: "child-turn" },
      "descendant",
    ],
    [
      "thread/started",
      {
        thread: {
          id: "new-child",
          source: { subAgent: { thread_spawn: { parent_thread_id: "child" } } },
        },
      },
      "descendant",
    ],
    [
      "thread/started",
      { thread: { id: "unrelated" } },
      "unrelated_information",
    ],
    [
      "thread/status/changed",
      { threadId: "unrelated" },
      "unrelated_information",
    ],
    ["mcpServer/startupStatus/updated", { threadId: "not-yet-known-child", status: "starting" }, "unrelated_information"],
    ["mcpServer/startupStatus/updated", { threadId: "child", status: "ready" }, "descendant"],
    ["mcpServer/startupStatus/updated", { threadId: "child", thread: { id: "different" } }, "invalid_authority"],
    ["nexus/runResult", { threadId: "child" }, "invalid_authority"],
    ["turn/completed", { threadId: "unrelated" }, "invalid_authority"],
    ["item/started", { threadId: 5 }, "invalid_authority"],
    [
      "item/started",
      { threadId: "root", thread: { id: "other" } },
      "invalid_authority",
    ],
    [
      "thread/status/changed",
      { threadId: "root", runId: "other-task" },
      "invalid_authority",
    ],
  ] as const)("classifies %s %j as %s", (method, params, expected) =>
    expect(classify(method, params)).toBe(expected),
  );
});
