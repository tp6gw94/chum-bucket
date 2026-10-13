import assert from "node:assert/strict";
import { test } from "node:test";
import { EventType } from "@tanstack/ai";
import { commentOutcomeOf } from "../../../server/harness/run-store";
import {
  TOOL_APPROVAL_REQUESTED_EVENT,
  TOOL_APPROVAL_RESOLVED_EVENT,
} from "../../../shared/tool-approval";

const first = "48c8797e-b4d7-4db3-aa7e-87a5a166710c";
const second = "11111111-2222-4333-8444-555555555555";
const threadId = "99999999-8888-4777-8666-555555555555";

function requested(
  approvalId: string,
  operationId: string,
  expiresAt = "2099-01-01T00:00:00.000Z",
) {
  return {
    type: EventType.CUSTOM,
    name: TOOL_APPROVAL_REQUESTED_EVENT,
    value: {
      approvalId,
      threadId,
      runId: "run-1",
      operationId,
      taskId: "task-1",
      toolCallId: `call-${approvalId}`,
      childWorkflowId: "child-1",
      topic: `tool-approval:task-1:call-${approvalId}`,
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

test("an operation that proposed no comment has no comment outcome", () => {
  assert.equal(commentOutcomeOf([], "op-1"), null);
  assert.equal(commentOutcomeOf([requested(first, "op-other")], "op-1"), null);
});

test("a rejected comment tells the main model it was not posted and must not be delegated again", () => {
  const outcome = commentOutcomeOf([requested(first, "op-1"), resolved(first, "rejected")], "op-1");

  assert.deepEqual(outcome, {
    status: "rejected",
    externalId: null,
    message:
      "The user rejected the Jira comment. It was not posted. Tell the user it was not posted and do not delegate this comment again unless the user asks for it again in a new message.",
  });
});

test("a posted comment carries its external id", () => {
  const outcome = commentOutcomeOf(
    [requested(first, "op-1"), resolved(first, "approved"), resolved(first, "succeeded", "10042")],
    "op-1",
  );

  assert.deepEqual(outcome, {
    status: "succeeded",
    externalId: "10042",
    message: "The Jira comment was posted (externalId 10042). Report that it was posted.",
  });
});

test("an approval whose dispatch never confirmed stays approved and is not claimed as posted", () => {
  const outcome = commentOutcomeOf([requested(first, "op-1"), resolved(first, "approved")], "op-1");

  assert.equal(outcome?.status, "approved");
  assert.equal(outcome?.externalId, null);
  assert.match(outcome?.message ?? "", /delivery was never confirmed/);
});

test("expired and cancelled comments report that nothing was posted", () => {
  assert.deepEqual(
    commentOutcomeOf([requested(first, "op-1", "2000-01-01T00:00:00.000Z")], "op-1"),
    {
      status: "expired",
      externalId: null,
      message:
        "The Jira comment approval expired. It was not posted. Tell the user it was not posted.",
    },
  );
  assert.deepEqual(
    commentOutcomeOf([requested(first, "op-1"), resolved(first, "cancelled")], "op-1"),
    {
      status: "cancelled",
      externalId: null,
      message:
        "The Jira comment approval was cancelled. It was not posted. Tell the user it was not posted.",
    },
  );
});

test("an unresolved request on a closing operation is reported as cancelled", () => {
  assert.equal(commentOutcomeOf([requested(first, "op-1")], "op-1")?.status, "cancelled");
});

test("only the latest approval of the operation counts and other operations are ignored", () => {
  const events = [
    requested(first, "op-1"),
    resolved(first, "rejected"),
    requested(second, "op-1"),
    resolved(second, "succeeded", "7"),
    requested("22222222-3333-4444-8555-666666666666", "op-2"),
  ];

  const outcome = commentOutcomeOf(events, "op-1");
  assert.equal(outcome?.status, "succeeded");
  assert.equal(outcome?.externalId, "7");
});
