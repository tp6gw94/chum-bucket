import assert from "node:assert/strict";
import { test } from "node:test";
import type { ToolExecutionContext } from "@tanstack/ai";
import type { RoleTask } from "../../../shared/testing";
import {
  TOOL_APPROVAL_REQUESTED,
  TOOL_APPROVAL_RESOLVED,
  approvalCancelKey,
  approvalDecisionKey,
  parseToolApprovalEvent,
  projectToolApprovals,
  toolArgumentSchemas,
  type ToolApprovalEvent,
} from "../../../shared/tool-approval";
import { allowsTool } from "../../../server/harness/agents";
import { withRoleTools } from "../../../server/harness/testing-tools";
import { commentOutcomeOf } from "../../../server/harness/tool-approval-store";

const approvalId = "5b0a3c3e-6f3e-8a51-9d6e-0c7f1e2a3b4c";
const context: ToolExecutionContext = { toolCallId: "call", emitCustomEvent: () => undefined };
const task: RoleTask = {
  summary: "Comment",
  goal: "Comment on PROJ-1",
  sources: [{ kind: "jira", issueKey: "PROJ-1" }],
  requirements: null,
  plan: null,
  design: null,
  targetUrl: null,
  checks: [],
};

function requested(expiresAt: string): ToolApprovalEvent {
  const event = parseToolApprovalEvent(TOOL_APPROVAL_REQUESTED, {
    approvalId,
    threadId: "d08035f1-07df-49f3-b2d0-5cf5cb2b1e74",
    runId: "run",
    operationId: "operation",
    taskId: "task",
    toolCallId: "call",
    childWorkflowId: "child",
    topic: "tool-approval:task:call",
    tool: "jira_add_comment",
    arguments: { issue_key: "PROJ-1", body: "workshop" },
    presentation: { title: "Jira 留言核准 · PROJ-1" },
    context: {
      site: "https://offline.atlassian.net",
      visibility: "jira-default",
      policy: "jira-comment-v1",
    },
    digest: "a".repeat(64),
    expiresAt,
  });
  assert.ok(event);

  return event;
}

function resolved(state: string, externalId: string | null = null): ToolApprovalEvent {
  const event = parseToolApprovalEvent(TOOL_APPROVAL_RESOLVED, {
    approvalId,
    state,
    receipt: externalId ? { externalId } : null,
  });
  assert.ok(event);

  return event;
}

const future = new Date(Date.now() + 60_000).toISOString();

test("jira_add_comment is direct-only and only the atlassian role may propose it", () => {
  assert.equal(allowsTool("atlassian", "jira_add_comment", "direct"), true);
  assert.equal(allowsTool("atlassian", "jira_add_comment", "codemode"), false);
  assert.equal(allowsTool("atlassian", "jira_get_issue", "codemode"), true);
  assert.equal(allowsTool("main", "jira_add_comment", "direct"), false);
  assert.equal(allowsTool("planner", "jira_add_comment", "direct"), false);
});

test("the atlassian role dispatcher never sends comments without orchestration", async () => {
  await withRoleTools(
    {
      role: "atlassian",
      taskId: "task",
      task,
      state: { receipts: [] },
      guard: async () => undefined,
      append: async () => undefined,
    },
    async (tools) => {
      const call = {
        id: "call",
        name: "jira_add_comment",
        input: { issue_key: "PROJ-1", body: "hi" },
        arguments: "{}",
      };
      await assert.rejects(
        tools.executeTool([], call, context),
        /Jira comments require durable orchestration approval/,
      );
    },
  );
});

test("comment arguments reject hidden fields and malformed issue keys", () => {
  const schema = toolArgumentSchemas.jira_add_comment;
  assert.equal(schema.safeParse({ issue_key: "PROJ-1", body: "ok" }).success, true);
  assert.equal(
    schema.safeParse({ issue_key: "PROJ-1", body: "ok", visibility: { type: "role" } }).success,
    false,
  );
  assert.equal(schema.safeParse({ issue_key: "proj-1", body: "ok" }).success, false);
  assert.equal(schema.safeParse({ issue_key: "PROJ-0", body: "ok" }).success, false);
  assert.equal(schema.safeParse({ issue_key: "PROJ-1", body: "" }).success, false);
});

test("approval cards follow the first resolution except approved", () => {
  const state = (events: ToolApprovalEvent[]) => projectToolApprovals(events).map((a) => a.state);

  assert.deepEqual(state([requested(future)]), ["pending"]);
  assert.deepEqual(state([requested(new Date(Date.now() - 1).toISOString())]), ["expired"]);
  assert.deepEqual(state([requested(future), resolved("rejected"), resolved("succeeded", "1")]), [
    "rejected",
  ]);
  const succeeded = projectToolApprovals([
    requested(future),
    resolved("approved"),
    resolved("succeeded", "10001"),
  ]);
  assert.equal(succeeded[0].state, "succeeded");
  assert.deepEqual(succeeded[0].receipt, { externalId: "10001" });
  assert.deepEqual(projectToolApprovals([resolved("succeeded", "1")]), []);
  assert.notEqual(approvalDecisionKey(approvalId), approvalCancelKey(approvalId));
  assert.equal(approvalDecisionKey(approvalId), approvalDecisionKey(approvalId));
});

test("comment outcomes tell the main agent how to report", () => {
  assert.match(commentOutcomeOf("succeeded", "10001").message, /10001/);
  assert.match(commentOutcomeOf("approved", null).message, /not confirmed/);
  assert.match(commentOutcomeOf("rejected", null).message, /Do not delegate/);
  for (const status of ["rejected", "expired", "cancelled"] as const) {
    assert.match(commentOutcomeOf(status, null).message, /not posted/);
    assert.doesNotMatch(commentOutcomeOf(status, null).message, /not confirmed/);
  }
});
