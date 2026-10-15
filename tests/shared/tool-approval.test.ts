import assert from "node:assert/strict";
import { test } from "node:test";
import {
  applyToolApprovalEvent,
  parseToolApprovals,
  projectToolApprovals,
  toolApprovalDecisionSchema,
  toolApprovalRequestedEvent,
  toolApprovalResolvedEvent,
  toolArgumentSchemas,
  type ToolApprovalRequest,
  type ToolApprovalResolution,
} from "../../shared/tool-approval";

const now = Date.parse("2026-10-15T08:00:00.000Z");

function request(approvalId = "6f1c1a52-58f4-4b8e-9c7d-1a2b3c4d5e6f"): ToolApprovalRequest {
  return {
    approvalId,
    threadId: "d08035f1-07df-49f3-b2d0-5cf5cb2b1e74",
    runId: "run-1",
    toolCallId: "call-1",
    workflowId: "run-1",
    topic: "tool-approval:run-1:call-1",
    tool: "jira_add_comment",
    arguments: { issue_key: "PROJ-123", body: "workshop 測試留言 1" },
    context: {
      site: "https://offline.atlassian.net",
      visibility: "jira-default",
      policy: "jira-comment-v1",
    },
    digest: "a".repeat(64),
    expiresAt: new Date(now + 60_000).toISOString(),
  };
}

function resolved(state: ToolApprovalResolution, externalId?: string, approvalId?: string) {
  return toolApprovalResolvedEvent({
    approvalId: approvalId ?? request().approvalId,
    state,
    receipt: externalId ? { externalId } : null,
  });
}

const requested = toolApprovalRequestedEvent(request());

test("a request alone is pending until it expires", () => {
  assert.equal(projectToolApprovals([requested], now)[0]!.state, "pending");
  assert.equal(projectToolApprovals([requested], now + 60_000)[0]!.state, "expired");
});

test("the first resolution wins except that approved is replaced by its outcome", () => {
  assert.equal(
    projectToolApprovals([requested, resolved("rejected"), resolved("succeeded", "1")], now)[0]!
      .state,
    "rejected",
  );
  const delivered = projectToolApprovals(
    [requested, resolved("approved"), resolved("approved"), resolved("succeeded", "10001")],
    now,
  )[0]!;
  assert.equal(delivered.state, "succeeded");
  assert.deepEqual(delivered.receipt, { externalId: "10001" });
  assert.equal(
    projectToolApprovals([requested, resolved("approved")], now + 120_000)[0]!.state,
    "approved",
  );
});

test("resolutions without a request and duplicate requests are ignored", () => {
  const other = "0b4f9d3e-1c2a-4e5f-8a9b-0c1d2e3f4a5b";
  assert.deepEqual(projectToolApprovals([resolved("succeeded", "1", other)], now), []);
  assert.equal(applyToolApprovalEvent([], { type: "CUSTOM", name: "other" }).length, 0);
  const twice = [requested, requested].reduce(applyToolApprovalEvent, []);
  assert.equal(twice.length, 1);
});

test("hydrated approvals are validated and anything malformed is dropped", () => {
  const approvals = projectToolApprovals([requested], now);
  assert.deepEqual(parseToolApprovals(JSON.parse(JSON.stringify(approvals))), approvals);
  assert.deepEqual(parseToolApprovals([{ request: { approvalId: "x" }, state: "pending" }]), []);
  assert.deepEqual(parseToolApprovals(undefined), []);
});

test("comment arguments are strict and a decision cannot carry arguments", () => {
  const schema = toolArgumentSchemas.jira_add_comment;
  assert.equal(schema.safeParse({ issue_key: "PROJ-123", body: "hi" }).success, true);

  for (const input of [
    { issue_key: "PROJ-123", body: "hi", visibility: "internal" },
    { issue_key: "proj-123", body: "hi" },
    { issue_key: "PROJ-0", body: "hi" },
    { issue_key: "PROJ-123", body: "" },
  ]) {
    assert.equal(schema.safeParse(input).success, false, JSON.stringify(input));
  }

  const decision = {
    threadId: request().threadId,
    digest: "a".repeat(64),
    tool: "jira_add_comment",
    approved: true,
  };
  assert.equal(toolApprovalDecisionSchema.safeParse(decision).success, true);

  for (const extra of [{ body: "changed" }, { arguments: {} }, { visibility: "x" }]) {
    assert.equal(toolApprovalDecisionSchema.safeParse({ ...decision, ...extra }).success, false);
  }
});
