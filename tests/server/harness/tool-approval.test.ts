import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { DBOS } from "@dbos-inc/dbos-sdk";
import type { ToolApprovalRequest } from "../../../shared/tool-approval";
import type { ModelCall } from "../../../server/harness/model-turn";
import { gateToolApproval } from "../../../server/harness/tool-approval";
import { sendApprovedJiraComment } from "../../../server/harness/tools/atlassian";
import { composeCodeModeTurn } from "../../../server/harness/tools/code-mode";
import { coreTools, fakeBaseUrl, mcpFixture, withMcpEnvironment } from "../../fixtures/mcp-fixture";

const run = {
  runId: "run-1",
  threadId: "d08035f1-07df-49f3-b2d0-5cf5cb2b1e74",
  workflowId: "run-1",
};
const input = { issue_key: "PROJ-123", body: "workshop 測試留言 1" };
const comment: ModelCall = {
  id: "call-1",
  name: "jira_add_comment",
  arguments: JSON.stringify(input),
  input,
};
const request: ToolApprovalRequest = {
  approvalId: "6f1c1a52-58f4-4b8e-9c7d-1a2b3c4d5e6f",
  threadId: run.threadId,
  runId: run.runId,
  toolCallId: comment.id,
  workflowId: run.workflowId,
  topic: "tool-approval:run-1:call-1",
  tool: "jira_add_comment",
  arguments: input,
  context: { site: fakeBaseUrl, visibility: "jira-default", policy: "jira-comment-v1" },
  digest: "d".repeat(64),
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
};
const approve = { approvalId: request.approvalId, tool: request.tool, digest: request.digest };

function scripted(steps: Record<string, unknown>, received: unknown) {
  const names: string[] = [];
  const topics: unknown[] = [];
  const step = mock.method(
    DBOS,
    "runStep",
    async (work: () => Promise<unknown>, options: { name: string }) => {
      names.push(options.name);
      const prefix = options.name.split(":")[0]!;

      return prefix in steps ? steps[prefix] : work();
    },
  );
  const recv = mock.method(DBOS, "recv", async (topic: unknown) => {
    topics.push(topic);

    return received;
  });

  return {
    names,
    topics,
    restore() {
      step.mock.restore();
      recv.mock.restore();
    },
  };
}

const requested = { "approval-request": { state: "requested", request } };

test("only jira_add_comment is gated", async () => {
  const dbos = scripted({}, null);

  try {
    const result = await gateToolApproval(
      run,
      { id: "c", name: "jira_get_issue", arguments: "{}", input: {} },
      [],
    );
    assert.equal(result, undefined);
    assert.deepEqual(dbos.names, []);
  } finally {
    dbos.restore();
  }
});

test("an approval with the stored digest posts the stored comment", async () => {
  const dbos = scripted(
    {
      ...requested,
      "approval-approve": undefined,
      "approval-dispatch": { state: "succeeded", externalId: "10001" },
      "approval-resolve": undefined,
    },
    { ...approve, approved: true },
  );

  try {
    const result = await gateToolApproval(run, comment, []);
    assert.deepEqual(dbos.topics, [request.topic]);
    assert.deepEqual(dbos.names, [
      "approval-request:call-1",
      "approval-approve:call-1",
      "approval-dispatch:call-1",
      "approval-resolve:call-1",
    ]);
    assert.equal(result?.error, false);
    assert.equal(result?.output.status, "succeeded");
    assert.equal(result?.output.externalId, "10001");
  } finally {
    dbos.restore();
  }
});

test("a rejection, a mismatched digest or a timeout never dispatches", async () => {
  for (const [received, status] of [
    [{ ...approve, approved: false }, "rejected"],
    [{ ...approve, digest: "e".repeat(64), approved: true }, "rejected"],
    [{ ...approve, tool: "jira_edit_comment", approved: true }, "rejected"],
    [null, "expired"],
  ] as const) {
    const dbos = scripted({ ...requested, "approval-resolve": undefined }, received);

    try {
      const result = await gateToolApproval(run, comment, []);
      assert.deepEqual(dbos.names, ["approval-request:call-1", "approval-resolve:call-1"]);
      assert.equal(result?.error, true);
      assert.equal(result?.output.status, status);
      assert.equal(result?.output.externalId, null);
    } finally {
      dbos.restore();
    }
  }
});

test("an approved comment whose delivery is unconfirmed is not reported as sent", async () => {
  const dbos = scripted(
    {
      ...requested,
      "approval-approve": undefined,
      "approval-dispatch": { state: "approved", error: "Jira did not return a comment ID" },
    },
    { ...approve, approved: true },
  );

  try {
    const result = await gateToolApproval(run, comment, []);
    assert.equal(result?.output.status, "approved");
    assert.match(String(result?.output.message), /delivery was not confirmed/);
    assert.equal(dbos.names.includes("approval-resolve:call-1"), false);
  } finally {
    dbos.restore();
  }
});

test("a denied or malformed proposal returns without waiting", async () => {
  const denied = scripted(
    { "approval-request": { state: "denied", status: "rejected", reason: "already rejected" } },
    null,
  );

  try {
    const result = await gateToolApproval(run, comment, []);
    assert.equal(result?.output.status, "rejected");
    assert.equal(result?.output.reason, "already rejected");
    assert.deepEqual(denied.topics, []);
  } finally {
    denied.restore();
  }

  const malformed = scripted({}, null);

  try {
    const result = await gateToolApproval(
      run,
      { ...comment, input: { ...input, visibility: "internal" } },
      [],
    );
    assert.equal(result?.error, true);
    assert.match(String(result?.output.error), /visibility/);
    assert.deepEqual(malformed.topics, []);
  } finally {
    malformed.restore();
  }
});

test("Code Mode never exposes jira_add_comment", () => {
  const schema = { type: "object" as const, properties: {} };
  const turn = composeCodeModeTurn({
    definitions: [
      { name: "jira_get_issue", description: "read", inputSchema: schema },
      { name: "jira_add_comment", description: "write", inputSchema: schema },
    ],
    dispatch: async () => {
      throw new Error("unreachable");
    },
    guard: () => {},
  });

  assert.deepEqual(turn.functions, ["external_jira_get_issue"]);
  assert.doesNotMatch(turn.systemPrompt, /jira_add_comment/);
});

const commentTool = {
  name: "jira_add_comment",
  description: "Native jira_add_comment",
  inputSchema: { type: "object", properties: {} },
  outputSchema: {
    type: "object",
    properties: { result: { type: "string" } },
    required: ["result"],
    "x-fastmcp-wrap-result": true,
  },
};

test("an approved comment is sent with the stored arguments and must return an ID", async () => {
  for (const [comment, expected] of [
    [{ id: "10001", body: input.body }, "10001"],
    [{ body: "no id" }, undefined],
  ] as const) {
    const fixture = mcpFixture({
      pages: [[...coreTools, commentTool]],
      rules: [
        {
          method: "tools/call",
          name: "jira_add_comment",
          result: {
            content: [{ type: "text", text: "wrapped" }],
            structuredContent: { result: JSON.stringify(comment) },
          },
        },
      ],
    });
    await withMcpEnvironment(
      async () => {
        const sending = sendApprovedJiraComment(input, fakeBaseUrl, AbortSignal.timeout(10_000));

        if (expected) {
          assert.deepEqual(await sending, { externalId: expected });
        } else {
          await assert.rejects(sending, /did not return a comment ID/);
        }

        assert.deepEqual(fixture.calls()[0]!.message.params?.arguments, input);
      },
      true,
      fixture,
    );
  }
});

test("a different configured Jira site never opens the MCP connection", async () => {
  const fixture = mcpFixture();
  await withMcpEnvironment(
    async () => {
      await assert.rejects(
        sendApprovedJiraComment(input, "https://other.atlassian.net", AbortSignal.timeout(10_000)),
        /differs from the approved one/,
      );
      await assert.rejects(
        sendApprovedJiraComment(
          { ...input, visibility: "x" },
          fakeBaseUrl,
          AbortSignal.timeout(10_000),
        ),
      );
    },
    true,
    fixture,
  );
  assert.equal(fixture.requests.length, 0);
});
