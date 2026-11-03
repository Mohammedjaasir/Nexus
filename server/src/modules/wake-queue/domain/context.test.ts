import { describe, expect, it } from "vitest";
import { enrichPromotedWakeContext } from "./context.js";

describe("enrichPromotedWakeContext", () => {
  it("clears stale derived comment projections when the canonical id list is empty, but keeps an independent interaction continuation", () => {
    const contextSnapshot: Record<string, unknown> = {
      // Normalization already dropped the canonical wake comment ids upstream
      // of this function; no wakeCommentIds field remains on the snapshot.
      nexusWake: { commentId: "comment-2" },
      nexusWakeComment: { id: "comment-2", body: "stale body" },
      nexusTaskMarkdown: "stale markdown",
      nexusTaskMarkdownCompact: "stale compact markdown",
      // Independent interaction continuation the promoted run must keep.
      interactionId: "interaction-1",
      interactionKind: "request_confirmation",
      interactionStatus: "accepted",
    };

    const result = enrichPromotedWakeContext({
      contextSnapshot,
      reason: "issue_execution_promoted",
      source: "automation",
      triggerDetail: null,
      payload: { mutation: "interaction" },
    });

    expect(result.contextSnapshot.wakeCommentIds).toBeUndefined();
    expect(result.contextSnapshot.commentId).toBeUndefined();
    expect(result.contextSnapshot.wakeCommentId).toBeUndefined();
    expect(result.contextSnapshot.nexusWake).toBeUndefined();
    expect(result.contextSnapshot.nexusWakeComment).toBeUndefined();
    expect(result.contextSnapshot.nexusTaskMarkdown).toBeUndefined();
    expect(result.contextSnapshot.nexusTaskMarkdownCompact).toBeUndefined();
    // The independent interaction continuation survives the clear.
    expect(result.contextSnapshot.interactionId).toBe("interaction-1");
    expect(result.contextSnapshot.interactionStatus).toBe("accepted");
  });

  it("sets the canonical id and latest-id fields when the recomputed list has entries, and still clears the stale projections", () => {
    const contextSnapshot: Record<string, unknown> = {
      wakeCommentIds: ["comment-1"],
      nexusWake: { commentId: "comment-1" },
      nexusWakeComment: { id: "comment-1", body: "will be rebuilt" },
      nexusTaskMarkdown: "will be rebuilt",
      nexusTaskMarkdownCompact: "will be rebuilt",
    };

    const result = enrichPromotedWakeContext({
      contextSnapshot,
      reason: "issue_execution_promoted",
      source: "automation",
      triggerDetail: null,
      payload: {},
    });

    expect(result.contextSnapshot.wakeCommentIds).toEqual(["comment-1"]);
    expect(result.contextSnapshot.commentId).toBe("comment-1");
    expect(result.contextSnapshot.wakeCommentId).toBe("comment-1");
    // The derived projections are cleared so the run rebuilds them from the
    // canonical ids instead of carrying forward a queue-time snapshot.
    expect(result.contextSnapshot.nexusWake).toBeUndefined();
    expect(result.contextSnapshot.nexusWakeComment).toBeUndefined();
    expect(result.contextSnapshot.nexusTaskMarkdown).toBeUndefined();
    expect(result.contextSnapshot.nexusTaskMarkdownCompact).toBeUndefined();
  });

  it("adds a new id from the payload to the canonical list and clears the stale projections", () => {
    const contextSnapshot: Record<string, unknown> = {
      wakeCommentIds: ["comment-1"],
      nexusWakeComment: { id: "comment-1", body: "stale body" },
    };

    const result = enrichPromotedWakeContext({
      contextSnapshot,
      reason: "issue_execution_promoted",
      source: "automation",
      triggerDetail: null,
      payload: { commentId: "comment-2" },
    });

    expect(result.contextSnapshot.wakeCommentIds).toEqual(["comment-1", "comment-2"]);
    expect(result.contextSnapshot.commentId).toBe("comment-2");
    expect(result.contextSnapshot.wakeCommentId).toBe("comment-2");
    expect(result.contextSnapshot.nexusWakeComment).toBeUndefined();
  });

  it("keeps the raw issue, execution-stage, and accepted-plan fields a dispatch rebuild needs, alongside the cleared text projections", () => {
    const contextSnapshot: Record<string, unknown> = {
      wakeCommentIds: ["comment-1"],
      nexusWake: { commentId: "comment-1" },
      nexusTaskMarkdown: "stale markdown",
      nexusTaskMarkdownCompact: "stale compact markdown",
      // Raw context a dispatch-time rebuild reads directly off the promoted
      // run; none of it is derived from the comment ids above, so none of it
      // should be cleared alongside the stale text projections.
      issueId: "issue-1",
      executionStage: { stage: "review" },
      planReviewInteraction: { acceptedTargetRevision: { revisionId: "revision-1" } },
      acceptedPlanWakeRouting: { targetAgentId: "agent-1" },
      workspaceRefreshReason: "accepted_plan_confirmation",
    };

    const result = enrichPromotedWakeContext({
      contextSnapshot,
      reason: "issue_execution_promoted",
      source: "automation",
      triggerDetail: null,
      payload: {},
    });

    // The rendered text is cleared; dispatch rebuilds it from the raw fields.
    expect(result.contextSnapshot.nexusWake).toBeUndefined();
    expect(result.contextSnapshot.nexusTaskMarkdown).toBeUndefined();
    expect(result.contextSnapshot.nexusTaskMarkdownCompact).toBeUndefined();
    // The raw fields the rebuild needs are untouched.
    expect(result.contextSnapshot.issueId).toBe("issue-1");
    expect(result.contextSnapshot.executionStage).toEqual({ stage: "review" });
    expect(result.contextSnapshot.planReviewInteraction).toEqual({
      acceptedTargetRevision: { revisionId: "revision-1" },
    });
    expect(result.contextSnapshot.acceptedPlanWakeRouting).toEqual({ targetAgentId: "agent-1" });
    expect(result.contextSnapshot.workspaceRefreshReason).toBe("accepted_plan_confirmation");
  });
});
