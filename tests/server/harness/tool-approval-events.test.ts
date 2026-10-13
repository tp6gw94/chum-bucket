import assert from "node:assert/strict";
import { test } from "node:test";
import { EventType } from "@tanstack/ai";
import {
  TOOL_APPROVAL_REQUESTED_EVENT,
  TOOL_APPROVAL_RESOLVED_EVENT,
  applyToolApprovalEvent,
  approvalCancelKey,
  approvalDecisionKey,
  projectToolApprovals,
  toolApprovalDecisionSchema,
  toolArgumentSchemas,
} from "../../../shared/tool-approval";

const approvalA = "48c8797e-b4d7-4db3-aa7e-87a5a166710c";
const approvalB = "11111111-2222-4333-8444-555555555555";
const threadId = "99999999-8888-4777-8666-555555555555";

function requested(approvalId: string, toolCallId: string, expiresAt = "2099-01-01T00:00:00.000Z") {
  return {
    type: EventType.CUSTOM,
    name: TOOL_APPROVAL_REQUESTED_EVENT,
    value: {
      approvalId,
      threadId,
      runId: "run-1",
      operationId: "op-1",
      taskId: "task-1",
      toolCallId,
      childWorkflowId: "child-1",
      topic: `tool-approval:task-1:${toolCallId}`,
      tool: "jira_add_comment",
      arguments: { issue_key: "CHUM-42", body: "exact text" },
      presentation: { title: "Jira", destination: "https://example.test", warnings: [] },
      context: {
        site: "https://example.test",
        visibility: "jira-default",
        policy: "jira-comment-v1",
      },
      digest: "a".repeat(64),
      expiresAt,
    },
  };
}

function resolved(approvalId: string, state: string, externalId: string | null = null) {
  return {
    type: EventType.CUSTOM,
    name: TOOL_APPROVAL_RESOLVED_EVENT,
    value: { approvalId, state, receipt: externalId ? { externalId } : null },
  };
}

test("approval events project pending, resolved, cancelled, and expired states", () => {
  const events = [requested(approvalA, "call-1"), resolved(approvalA, "succeeded", "ext-9")];
  const [done] = projectToolApprovals(events);
  assert.equal(done?.state, "succeeded");
  assert.deepEqual(done?.receipt, { externalId: "ext-9" });
  assert.deepEqual(done?.arguments, { issue_key: "CHUM-42", body: "exact text" });

  const cancelled = projectToolApprovals(
    [requested(approvalA, "call-1")],
    new Map([[approvalA, "cancelled"]]),
  );
  assert.equal(cancelled[0]?.state, "cancelled");

  const expired = projectToolApprovals(
    [requested(approvalA, "call-1", "2020-01-01T00:00:00.000Z")],
    new Map(),
    Date.parse("2021-01-01T00:00:00.000Z"),
  );
  assert.equal(expired[0]?.state, "expired");
});

test("each call keeps its own approval binding and the first resolution wins", () => {
  let views = projectToolApprovals([
    requested(approvalA, "call-1"),
    requested(approvalB, "call-2"),
  ]);
  assert.deepEqual(
    views.map((view) => view.state),
    ["pending", "pending"],
  );

  views = applyToolApprovalEvent(views, {
    kind: "resolved",
    resolution: { approvalId: approvalA, state: "rejected", receipt: null },
  });
  views = applyToolApprovalEvent(views, {
    kind: "resolved",
    resolution: { approvalId: approvalA, state: "succeeded", receipt: { externalId: "late" } },
  });
  assert.equal(views[0]?.state, "rejected");
  assert.equal(views[0]?.receipt, null);
  assert.equal(views[1]?.state, "pending");
  assert.notEqual(views[0]?.toolCallId, views[1]?.toolCallId);
  assert.notEqual(views[0]?.approvalId, views[1]?.approvalId);
});

test("a resolution has no effect without its stored request", () => {
  const orphan = applyToolApprovalEvent([], {
    kind: "resolved",
    resolution: { approvalId: approvalA, state: "succeeded", receipt: { externalId: "ghost" } },
  });
  assert.deepEqual(orphan, []);
});

test("approval decisions stay strict and cannot substitute payload or tool", () => {
  const digest = "a".repeat(64);
  const valid = { threadId, digest, tool: "jira_add_comment", approved: true };
  assert.equal(toolApprovalDecisionSchema.safeParse(valid).success, true);

  for (const patch of [
    { approved: "true" },
    { approved: 1 },
    { tool: "jira_delete_issue" },
    { body: "edited" },
    { arguments: { issue_key: "CHUM-1" } },
    { digest: "short" },
  ]) {
    assert.equal(toolApprovalDecisionSchema.safeParse({ ...valid, ...patch }).success, false);
  }

  assert.equal(
    toolArgumentSchemas.jira_add_comment.safeParse({ issue_key: "CHUM-42", body: "x", extra: 1 })
      .success,
    false,
  );
});

test("one approval keeps one stable decision identity so the first durable choice wins", () => {
  const approvalId = "48c8797e-b4d7-4db3-aa7e-87a5a166710c";
  assert.equal(approvalDecisionKey(approvalId), approvalDecisionKey(approvalId));
  assert.notEqual(approvalDecisionKey(approvalId), approvalDecisionKey(approvalB));
  assert.notEqual(approvalDecisionKey(approvalId), approvalCancelKey(approvalId));
});
