import assert from "node:assert/strict";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { ToolApproval } from "../../../shared/tool-approval";
import { ToolApprovals } from "../../../src/components/tool-approvals";

const approval: ToolApproval = {
  approvalId: "5b0a3c3e-6f3e-8a51-9d6e-0c7f1e2a3b4c",
  threadId: "d08035f1-07df-49f3-b2d0-5cf5cb2b1e74",
  runId: "run",
  operationId: "operation",
  taskId: "task",
  toolCallId: "call",
  childWorkflowId: "child",
  topic: "tool-approval:task:call",
  tool: "jira_add_comment",
  arguments: { issue_key: "PROJ-1", body: "workshop 測試留言 1\n第二行" },
  presentation: { title: "Jira 留言核准 · PROJ-1" },
  context: {
    site: "https://offline.atlassian.net",
    visibility: "jira-default",
    policy: "jira-comment-v1",
  },
  digest: "a".repeat(64),
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
  state: "pending",
  receipt: null,
};
const decide = async () => undefined;

test("approval cards show the exact pending comment with both decisions", () => {
  const html = renderToStaticMarkup(<ToolApprovals approvals={[approval]} onDecide={decide} />);

  assert.match(html, /Jira 留言核准 · PROJ-1/);
  assert.match(html, /https:\/\/offline\.atlassian\.net/);
  assert.match(html, /並非私人留言/);
  assert.match(html, /workshop 測試留言 1\n第二行/);
  assert.match(html, /核准送出/);
  assert.match(html, /拒絕/);
  assert.doesNotMatch(html, /\sdisabled=""/);
});

test("resolved cards are hidden and expired cards cannot be decided", () => {
  assert.equal(
    renderToStaticMarkup(
      <ToolApprovals approvals={[{ ...approval, state: "rejected" }]} onDecide={decide} />,
    ),
    "",
  );
  const expired = renderToStaticMarkup(
    <ToolApprovals
      approvals={[{ ...approval, expiresAt: new Date(Date.now() - 1).toISOString() }]}
      onDecide={decide}
    />,
  );
  assert.equal(expired.match(/\sdisabled=""/g)?.length, 2);
});
