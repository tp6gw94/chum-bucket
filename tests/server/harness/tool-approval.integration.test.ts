import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, mock, test } from "node:test";
import type { StreamChunk } from "@tanstack/ai";

const databaseUrl = process.env.TEST_DATABASE_URL;
const skip = databaseUrl ? false : "set TEST_DATABASE_URL to a disposable Postgres database";

if (databaseUrl) {
  process.env.DATABASE_URL = databaseUrl;
}

async function modules() {
  const [schema, store, approvals, shared, dbos] = await Promise.all([
    import("../../../server/db/schema"),
    import("../../../server/harness/run-store"),
    import("../../../server/harness/tool-approval-store"),
    import("../../../shared/tool-approval"),
    import("@dbos-inc/dbos-sdk"),
  ]);
  const db = await store.database();

  return { schema, store, approvals, shared, dbos, db };
}

let m: Awaited<ReturnType<typeof modules>>;

before(async () => {
  if (!databaseUrl) {
    return;
  }

  m = await modules();
  const { migrate } = await import("drizzle-orm/node-postgres/migrator");
  await migrate(m.db, { migrationsFolder: "drizzle" });
});

after(async () => {
  if (databaseUrl) {
    await m.db.$client.end();
  }
});

async function pendingRun() {
  const threadId = randomUUID();
  await m.db.insert(m.schema.threadsTable).values({ id: threadId, title: "t", messages: [] });
  const runId = randomUUID();
  await m.store.persistRun({
    threadId,
    runId,
    baseRevision: 0,
    message: { id: randomUUID(), text: "在 PROJ-123 留言：workshop 測試留言 1" },
  });

  return { threadId, runId };
}

function approvalFor(run: { threadId: string; runId: string }) {
  return {
    approvalId: randomUUID(),
    threadId: run.threadId,
    runId: run.runId,
    toolCallId: "call-1",
    workflowId: run.runId,
    topic: `tool-approval:${run.runId}:call-1`,
    tool: "jira_add_comment" as const,
    arguments: { issue_key: "PROJ-123", body: "workshop 測試留言 1" },
    context: {
      site: "https://offline.atlassian.net",
      visibility: "jira-default" as const,
      policy: "jira-comment-v1" as const,
    },
    digest: "a".repeat(64),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  };
}

async function record(runId: string, key: string, event: unknown) {
  await m.store.appendRunEventOnce(runId, key, event as StreamChunk);
}

test("a requested approval is read back once and found by its id", { skip }, async () => {
  const run = await pendingRun();
  const request = approvalFor(run);
  const event = m.shared.toolApprovalRequestedEvent(request);
  await record(run.runId, `approval:${request.approvalId}:requested`, event);
  await record(run.runId, `approval:${request.approvalId}:requested`, event);

  const approvals = await m.approvals.readRunApprovals(run.runId);
  assert.equal(approvals.length, 1);
  assert.equal(approvals[0]!.state, "pending");
  const found = await m.approvals.findToolApproval(request.approvalId);
  assert.equal(found?.request.topic, request.topic);
  assert.equal(found?.request.workflowId, run.runId);
  assert.equal(await m.approvals.findToolApproval(randomUUID()), undefined);
});

test(
  "a rejection is final for the run and a finished run cancels pending cards",
  { skip },
  async () => {
    const run = await pendingRun();
    const rejected = approvalFor(run);
    const waiting = approvalFor(run);
    await record(
      run.runId,
      `approval:${rejected.approvalId}:requested`,
      m.shared.toolApprovalRequestedEvent(rejected),
    );
    assert.equal(await m.approvals.hasFinalApprovalDenial(run.runId), false);
    await record(
      run.runId,
      `approval:${rejected.approvalId}:rejected`,
      m.shared.toolApprovalResolvedEvent({
        approvalId: rejected.approvalId,
        state: "rejected",
        receipt: null,
      }),
    );
    assert.equal(await m.approvals.hasFinalApprovalDenial(run.runId), true);

    await record(
      run.runId,
      `approval:${waiting.approvalId}:requested`,
      m.shared.toolApprovalRequestedEvent(waiting),
    );
    await m.store.finishRun(run.runId);
    assert.equal(await m.approvals.isRunPending(run.runId), false);
    assert.equal((await m.approvals.findToolApproval(waiting.approvalId))?.state, "cancelled");
  },
);

test("a decision is sent to the stored workflow and topic with a fixed key", { skip }, async () => {
  const run = await pendingRun();
  const request = approvalFor(run);
  await record(
    run.runId,
    `approval:${request.approvalId}:requested`,
    m.shared.toolApprovalRequestedEvent(request),
  );
  const sent: unknown[][] = [];
  const send = mock.method(m.dbos.DBOS, "send", async (...args: unknown[]) => {
    sent.push(args);
  });

  try {
    const { default: chat } = await import("../../../server/chat");
    const response = await chat.request(
      `http://localhost/approvals/${request.approvalId}/decision`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Tool-Approval": "1",
          "Sec-Fetch-Site": "same-origin",
        },
        body: JSON.stringify({
          threadId: run.threadId,
          digest: request.digest,
          tool: request.tool,
          approved: true,
        }),
      },
    );
    assert.equal(response.status, 202);
    assert.deepEqual(sent, [
      [
        run.runId,
        {
          approvalId: request.approvalId,
          tool: request.tool,
          digest: request.digest,
          approved: true,
        },
        request.topic,
        `approval-decision:${request.approvalId}`,
      ],
    ]);

    const mismatch = await chat.request(
      `http://localhost/approvals/${request.approvalId}/decision`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Tool-Approval": "1",
          "Sec-Fetch-Site": "same-origin",
        },
        body: JSON.stringify({
          threadId: run.threadId,
          digest: "b".repeat(64),
          tool: request.tool,
          approved: true,
        }),
      },
    );
    assert.equal(mismatch.status, 409);
    assert.equal(sent.length, 1);
  } finally {
    send.mock.restore();
  }
});
