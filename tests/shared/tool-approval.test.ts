import assert from "node:assert/strict";
import { test } from "node:test";
import {
  jiraCommentParamsSchema,
  projectToolApprovals,
  toolApprovalDecisionRequestSchema,
  toolApprovalRequestedEventName,
  toolApprovalResolvedEventName,
} from "../../shared/tool-approval";

const id = `approval-${"a".repeat(32)}`;
const request = {
  id,
  workflowId: "testing-atlassian-1",
  operationId: "testing-op",
  requestKey: "delegate-call",
  tool: "jira_add_comment",
  params: { issue_key: "TEST-1", body: "Looks good" },
};
const requested = { type: "CUSTOM", name: toolApprovalRequestedEventName, value: request };
const resolved = (state: string, commentId: string | null = null) => ({
  type: "CUSTOM",
  name: toolApprovalResolvedEventName,
  value: { id, state, commentId, reason: null },
});

test("a requested event opens a pending card", () => {
  assert.deepEqual(projectToolApprovals([requested])[id], {
    ...request,
    state: "pending",
    commentId: null,
    reason: null,
  });
});

test("the first resolution wins and later events cannot reopen or overwrite it", () => {
  const approvals = projectToolApprovals([
    requested,
    resolved("posted", "10001"),
    resolved("failed"),
    requested,
  ]);

  assert.equal(approvals[id]!.state, "posted");
  assert.equal(approvals[id]!.commentId, "10001");
});

test("resolutions without a request and unrelated events are ignored", () => {
  const base = projectToolApprovals([]);

  assert.equal(
    projectToolApprovals(
      [resolved("posted", "1"), { type: "CUSTOM", name: "other", value: {} }, null],
      base,
    ),
    base,
  );
});

test("projection folds incrementally onto an earlier state", () => {
  const pending = projectToolApprovals([requested]);
  const next = projectToolApprovals([resolved("rejected")], pending);

  assert.equal(pending[id]!.state, "pending");
  assert.equal(next[id]!.state, "rejected");
});

test("comment params are strict and decisions are validated", () => {
  assert.equal(
    jiraCommentParamsSchema.safeParse({ issue_key: "TEST-1", body: " " }).success,
    false,
  );
  assert.equal(
    jiraCommentParamsSchema.safeParse({ issue_key: "TEST-1", body: "x", visibility: "{}" }).success,
    false,
  );
  assert.equal(
    toolApprovalDecisionRequestSchema.safeParse({
      threadId: "00000000-0000-4000-8000-000000000000",
      decision: { decision: "reject", reason: "Wrong issue" },
    }).success,
    true,
  );
  assert.equal(
    toolApprovalDecisionRequestSchema.safeParse({
      threadId: "00000000-0000-4000-8000-000000000000",
      decision: { decision: "maybe" },
    }).success,
    false,
  );
});
