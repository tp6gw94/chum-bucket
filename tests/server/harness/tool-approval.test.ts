import assert from "node:assert/strict";
import { test } from "node:test";
import { allowsTool, roleSystemPrompt, toolNamesFor } from "../../../server/harness/agents";
import { toolArgumentSchemas, toolApprovalDecisionSchema } from "../../../shared/tool-approval";
import { readAtlassianConfiguration } from "../../../server/harness/tools/atlassian-policy";
import { jiraCommentApproval } from "../../../server/harness/tools/atlassian";
import { fakeBaseUrl, mcpFixture, withMcpEnvironment } from "../../fixtures/mcp-fixture";

const approvalId = "48c8797e-b4d7-4db3-aa7e-87a5a166710c";

test("approval payload freezes exact arguments and rejects visibility or tool substitution", () => {
  const payload = { issue_key: "CHUM-42", body: "  Exact text\n" };
  assert.deepEqual(toolArgumentSchemas.jira_add_comment.parse(payload), payload);
  assert.equal(
    toolArgumentSchemas.jira_add_comment.safeParse({ ...payload, public: false }).success,
    false,
  );
  assert.equal(
    toolArgumentSchemas.jira_add_comment.safeParse({ ...payload, visibility: "private" }).success,
    false,
  );
  assert.equal(
    toolApprovalDecisionSchema.safeParse({
      threadId: approvalId,
      digest: "a".repeat(64),
      tool: "jira_add_comment",
      approved: true,
      body: "edited",
    }).success,
    false,
  );
  assert.equal(
    toolApprovalDecisionSchema.safeParse({
      threadId: approvalId,
      digest: "a".repeat(64),
      tool: "jira_delete_issue",
      approved: true,
    }).success,
    false,
  );
  assert.equal(
    toolApprovalDecisionSchema.safeParse({
      threadId: approvalId,
      digest: "a".repeat(64),
      tool: "jira_add_comment",
      approved: "yes",
    }).success,
    false,
  );
});

test("Jira comments are direct Atlassian capabilities, never sandbox capabilities", () => {
  assert.equal(allowsTool("atlassian", "jira_add_comment", "direct"), true);
  assert.equal(allowsTool("atlassian", "jira_add_comment", "codemode"), false);
  assert.equal(allowsTool("main", "jira_add_comment", "direct"), false);
  assert.equal(allowsTool("planner", "jira_add_comment", "direct"), false);
  assert.ok(toolNamesFor("atlassian").includes("jira_add_comment"));
  assert.equal(allowsTool("main", "write", "codemode"), true);
  assert.equal(allowsTool("main", "edit", "codemode"), true);
  assert.throws(() => roleSystemPrompt("atlassian", "requirements-v2"), /incompatible/);
});

test("launcher enables only the comment write and disables downstream retries", () => {
  const config = readAtlassianConfiguration({
    JIRA_BASE_URL: "https://fixture.example.test",
    JIRA_EMAIL: "fixture@example.test",
    JIRA_API_TOKEN: "fixture-token",
  });
  assert.equal(config.mode, "http");
  if (config.mode !== "http") throw new Error("Expected HTTP mode");
  assert.equal(config.serviceEnvironment.READ_ONLY_MODE, "false");
  assert.equal(config.serviceEnvironment.ATLASSIAN_RETRY_TOTAL, "0");
  assert.equal(config.serviceEnvironment.ATLASSIAN_RETRY_INCLUDE_WRITES, "false");
  assert.deepEqual(
    config.serviceEnvironment.ENABLED_TOOLS?.split(",").filter((name) =>
      /add|create|update|delete/.test(name),
    ),
    ["jira_add_comment"],
  );
});

test("comment context freezes the normalized configured site and fixed policy", async () => {
  await withMcpEnvironment(async () => {
    process.env.JIRA_BASE_URL = `${fakeBaseUrl}///`;
    const context = jiraCommentApproval.context();
    assert.deepEqual(context, {
      site: fakeBaseUrl,
      visibility: "jira-default",
      policy: "jira-comment-v1",
    });
    assert.equal(
      jiraCommentApproval.present({ issue_key: "CHUM-42", body: "x" }, context).destination,
      fakeBaseUrl,
    );
  });
});

test("comment context refuses an unconfigured or invalid site", async () => {
  await withMcpEnvironment(async () => {
    assert.throws(() => jiraCommentApproval.context(), /Jira site is not configured/);
  }, false);
  await withMcpEnvironment(async () => {
    process.env.JIRA_BASE_URL = "not a url";
    assert.throws(() => jiraCommentApproval.context(), /Jira site is not configured/);
  });
});

test("stored comment context rejects unknown keys, policies, and sites", () => {
  const valid = { site: fakeBaseUrl, visibility: "jira-default", policy: "jira-comment-v1" };
  const input = { issue_key: "CHUM-42", body: "x" };
  assert.equal(jiraCommentApproval.present(input, valid).destination, fakeBaseUrl);

  for (const invalid of [
    { ...valid, extra: true },
    { ...valid, site: "" },
    { ...valid, site: "relative" },
    { ...valid, visibility: "private" },
    { ...valid, policy: "jira-comment-v2" },
    {},
  ]) {
    assert.throws(() => jiraCommentApproval.present(input, invalid));
  }
});

test("an approved comment dispatch returns the Jira comment id as the receipt", async () => {
  const payload = { issue_key: "CHUM-42", body: "Exact body" };
  const fixture = mcpFixture({
    rules: [
      {
        method: "tools/call",
        name: "jira_add_comment",
        result: {
          content: [{ type: "text", text: JSON.stringify({ id: 10042 }) }],
          structuredContent: { result: JSON.stringify({ id: 10042 }) },
        },
      },
    ],
  });
  await withMcpEnvironment(
    async () => {
      const context = jiraCommentApproval.context();
      assert.deepEqual(
        await jiraCommentApproval.dispatch(payload, context, new AbortController().signal),
        { externalId: "10042" },
      );
    },
    true,
    fixture,
  );
});

test("an approved comment dispatch without a comment id fails instead of returning a receipt", async () => {
  const payload = { issue_key: "CHUM-42", body: "Exact body" };
  const fixture = mcpFixture({
    rules: [
      {
        method: "tools/call",
        name: "jira_add_comment",
        result: {
          content: [{ type: "text", text: JSON.stringify({ ok: true }) }],
          structuredContent: { result: JSON.stringify({ ok: true }) },
        },
      },
    ],
  });
  await withMcpEnvironment(
    async () => {
      const context = jiraCommentApproval.context();
      await assert.rejects(
        jiraCommentApproval.dispatch(payload, context, new AbortController().signal),
        /carried no comment id/,
      );
    },
    true,
    fixture,
  );
});
