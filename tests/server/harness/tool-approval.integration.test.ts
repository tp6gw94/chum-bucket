import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { EventType, type StreamChunk } from "@tanstack/ai";
import { mock, test } from "node:test";
import { DBOS } from "@dbos-inc/dbos-sdk";
import app from "../../../server/chat";
import {
  TOOL_APPROVAL_REQUESTED_EVENT,
  TOOL_APPROVAL_RESOLVED_EVENT,
} from "../../../shared/tool-approval";
import {
  admitAttachedTesting,
  cancelTesting,
  database,
  emit,
  hasFinalApprovalDenial,
  persistRun,
  readCommentOutcome,
  readToolApprovalRequest,
  readToolApprovals,
  reserveRoleTask,
} from "../../../server/harness/run-store";
import { threadsTable } from "../../../server/db/schema";
import { jiraCommentApproval } from "../../../server/harness/tools/atlassian";
import { fakeBaseUrl, mcpFixture, withMcpEnvironment } from "../../fixtures/mcp-fixture";

const enabled = process.env.TESTING_STORE_DATABASE_URL;
const tool = "jira_add_comment" as const;

type Owner = Readonly<{
  threadId: string;
  runId: string;
  operationId: string;
  taskId: string;
  childWorkflowId: string;
}>;

async function approvalRun(title: string) {
  const db = await database();
  const [thread] = await db.insert(threadsTable).values({ title }).returning();
  assert.ok(thread);
  const { run } = await persistRun({
    threadId: thread.id,
    runId: `run-${randomUUID()}`,
    baseRevision: 0,
    message: { id: randomUUID(), text: "Review Jira comment" },
  });
  const admitted = await admitAttachedTesting(run, "comment", {
    role: "atlassian",
    summary: "Review comment",
    goal: "Review comment",
    sources: [{ kind: "jira", issueKey: "CHUM-42" }],
  });
  const frame = await reserveRoleTask(run.runId, admitted.operationId, "atlassian", {});
  assert.ok(frame);

  return {
    thread,
    run,
    owner: {
      threadId: thread.id,
      runId: run.runId,
      operationId: admitted.operationId,
      taskId: frame.taskId,
      childWorkflowId: frame.childWorkflowId,
    } satisfies Owner,
  };
}

function requested(owner: Owner, approvalId: string, toolCallId: string): StreamChunk {
  return {
    type: EventType.CUSTOM,
    name: TOOL_APPROVAL_REQUESTED_EVENT,
    value: {
      approvalId,
      threadId: owner.threadId,
      runId: owner.runId,
      operationId: owner.operationId,
      taskId: owner.taskId,
      toolCallId,
      childWorkflowId: owner.childWorkflowId,
      topic: `tool-approval:${owner.taskId}:${toolCallId}`,
      tool,
      arguments: { issue_key: "CHUM-42", body: "Exact **body**" },
      presentation: { title: "Jira 留言核准 · CHUM-42", destination: fakeBaseUrl, warnings: [] },
      context: { site: fakeBaseUrl, visibility: "jira-default", policy: "jira-comment-v1" },
      digest: "a".repeat(64),
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    },
    timestamp: Date.now(),
    metadata: { tanstack: { toolCallId } },
  };
}

function resolved(approvalId: string, state: "rejected" | "succeeded"): StreamChunk {
  return {
    type: EventType.CUSTOM,
    name: TOOL_APPROVAL_RESOLVED_EVENT,
    value: { approvalId, state, receipt: state === "succeeded" ? { externalId: "42" } : null },
    timestamp: Date.now(),
    metadata: { tanstack: { toolCallId: "comment-1" } },
  };
}

test(
  "pending approvals hydrate from events, keep their call binding, and cancel fail closed",
  { skip: !enabled },
  async () => {
    process.env.DATABASE_URL = enabled;
    const { thread, run, owner } = await approvalRun("Approval hydration");
    const approvalId = randomUUID();
    await emit(run.runId, requested(owner, approvalId, "comment-1"));

    const [pending] = await readToolApprovals(thread.id);
    assert.equal(pending?.approvalId, approvalId);
    assert.equal(pending?.state, "pending");
    assert.equal(pending?.toolCallId, "comment-1");
    assert.deepEqual(pending?.arguments, { issue_key: "CHUM-42", body: "Exact **body**" });
    assert.equal(pending?.presentation.destination, fakeBaseUrl);

    const stored = await readToolApprovalRequest(thread.id, approvalId);
    assert.equal(stored?.topic, `tool-approval:${owner.taskId}:comment-1`);
    assert.equal(stored?.childWorkflowId, owner.childWorkflowId);
    assert.equal(await hasFinalApprovalDenial(run.runId, owner.taskId), false);

    await cancelTesting(run.runId, owner.operationId);

    const [cancelled] = await readToolApprovals(thread.id);
    assert.equal(cancelled?.state, "cancelled");
    assert.equal(await hasFinalApprovalDenial(run.runId, owner.taskId), false);
  },
);

test(
  "a rejected approval stays rejected and blocks reproposal for the task",
  { skip: !enabled },
  async () => {
    process.env.DATABASE_URL = enabled;
    const { thread, run, owner } = await approvalRun("Approval rejection");
    const approvalId = randomUUID();
    await emit(run.runId, requested(owner, approvalId, "comment-1"));
    await emit(run.runId, resolved(approvalId, "rejected"));
    await emit(run.runId, resolved(approvalId, "succeeded"));

    const [approval] = await readToolApprovals(thread.id);
    assert.equal(approval?.state, "rejected");
    assert.equal(approval?.receipt, null);
    assert.equal(await hasFinalApprovalDenial(run.runId, owner.taskId), true);
  },
);

test(
  "the stored operation events yield the comment outcome the delegating model receives",
  { skip: !enabled },
  async () => {
    process.env.DATABASE_URL = enabled;
    const silent = await approvalRun("Comment outcome none");
    assert.equal(await readCommentOutcome(silent.run.runId, silent.owner.operationId), null);

    const rejected = await approvalRun("Comment outcome rejected");
    const rejectedId = randomUUID();
    await emit(rejected.run.runId, requested(rejected.owner, rejectedId, "comment-1"));
    await emit(rejected.run.runId, resolved(rejectedId, "rejected"));
    const rejectedOutcome = await readCommentOutcome(
      rejected.run.runId,
      rejected.owner.operationId,
    );
    assert.equal(rejectedOutcome?.status, "rejected");
    assert.equal(rejectedOutcome?.externalId, null);
    assert.match(rejectedOutcome?.message ?? "", /do not delegate this comment again/);

    const posted = await approvalRun("Comment outcome succeeded");
    const postedId = randomUUID();
    await emit(posted.run.runId, requested(posted.owner, postedId, "comment-1"));
    await emit(posted.run.runId, resolved(postedId, "succeeded"));
    const postedOutcome = await readCommentOutcome(posted.run.runId, posted.owner.operationId);
    assert.equal(postedOutcome?.status, "succeeded");
    assert.equal(postedOutcome?.externalId, "42");
  },
);

test(
  "the Jira adapter refuses to send when the configured site changes after approval",
  { skip: !enabled },
  async () => {
    process.env.DATABASE_URL = enabled;
    const fixture = mcpFixture();
    await withMcpEnvironment(
      async () => {
        process.env.JIRA_BASE_URL = `${fakeBaseUrl}/`;
        const context = jiraCommentApproval.context();
        process.env.JIRA_BASE_URL = "https://changed.atlassian.net";
        await assert.rejects(() =>
          jiraCommentApproval.dispatch(
            { issue_key: "CHUM-42", body: "Destination bound" },
            context,
            new AbortController().signal,
          ),
        );
        assert.equal(fixture.calls().length, 0);
      },
      true,
      fixture,
    );
  },
);

test(
  "approval HTTP acknowledges the durable submission without reading consumed notifications",
  { skip: !enabled },
  async () => {
    process.env.DATABASE_URL = enabled;
    const { thread, run, owner } = await approvalRun("Approval submission acknowledgement");
    const approvalId = randomUUID();
    await emit(run.runId, requested(owner, approvalId, "comment-1"));

    const deliveries: Array<Readonly<{ topic?: string; key?: string }>> = [];
    mock.method(
      DBOS,
      "send",
      async (_destination: string, _message: unknown, topic?: string, key?: string) => {
        deliveries.push({ topic, key });
      },
    );

    const response = await app.request(`/approvals/${approvalId}/decision`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Tool-Approval": "1",
        "Sec-Fetch-Site": "same-origin",
      },
      body: JSON.stringify({
        threadId: thread.id,
        digest: "a".repeat(64),
        tool,
        approved: true,
      }),
    });

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true, approvalId });
    assert.deepEqual(deliveries, [
      { topic: `tool-approval:${owner.taskId}:comment-1`, key: `approval-decision:${approvalId}` },
    ]);
  },
);
