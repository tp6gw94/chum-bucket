import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ToolExecutionContext, UIMessage } from "@tanstack/ai";
import type { ModelCall } from "../../../../server/harness/model-turn";
import { atlassianToolNames } from "../../../../server/harness/tools/atlassian-policy";
import { atlassianOutputs } from "../../../../server/harness/tools/atlassian-output";
import { withRunTools, type RunTools } from "../../../../server/harness/tools/index";
import { allTools, fakeToken, mcpFixture, withMcpEnvironment } from "../../../fixtures/mcp-fixture";

const context: ToolExecutionContext = { toolCallId: "outer", emitCustomEvent: () => {} };
const codemode = (code: string): ModelCall => ({
  id: "outer",
  name: "codemode",
  arguments: JSON.stringify({ code }),
  input: { code },
});

async function withTemporaryFile(content: string, use: (path: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "chum-code-mode-"));
  try {
    const path = join(directory, "file.txt");
    await writeFile(path, content);
    await use(path);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function discover(tools: RunTools, toolNames: string[]): Promise<UIMessage[]> {
  const id = "code-mode-discovery";
  const argumentsText = JSON.stringify({ toolNames });
  const output = await tools.executeTool(
    [],
    { id, name: "discover_atlassian_tools", arguments: argumentsText, input: { toolNames } },
    context,
  );
  return [
    {
      id: `${id}-message`,
      role: "assistant",
      parts: [
        {
          type: "tool-call",
          id,
          name: "discover_atlassian_tools",
          arguments: argumentsText,
          state: "complete",
        },
        { type: "tool-result", toolCallId: id, content: JSON.stringify(output), state: "complete" },
      ],
    },
  ];
}

test("output schemas cover exactly the Atlassian whitelist", () => {
  assert.deepEqual(Object.keys(atlassianOutputs).sort(), [...atlassianToolNames].sort());
});

test("code mode reaches local tools through the same handler as direct calls", async () => {
  await withMcpEnvironment(
    () =>
      withTemporaryFile("local data", (path) =>
        withRunTools(async (tools) => {
          const turn = await tools.getModelTools([]);
          assert.equal(turn.definitions.at(-1)!.name, "codemode");
          assert.match(turn.systemPrompt, /declare function external_read\(/);
          assert.doesNotMatch(turn.systemPrompt, /external_jira|external_discover/);

          const direct = await tools.executeTool(
            [],
            { id: "direct", name: "read", arguments: "", input: { path } },
            context,
          );
          const viaCode = await tools.executeTool(
            [],
            codemode(`return await external_read({ path: ${JSON.stringify(path)} });`),
            context,
          );
          assert.deepEqual(viaCode, {
            success: true,
            result: JSON.parse(JSON.stringify(direct)),
            logs: [],
          });

          const invalid = (await tools.executeTool(
            [],
            codemode(`return await external_get_figma({ target: "" });`),
            context,
          )) as { success: boolean; error?: { message: string } };
          assert.equal(invalid.success, false);
          assert.match(invalid.error!.message, /too_small|at least 1/);
        }),
      ),
    false,
  );
});

test("code mode only exposes discovered Atlassian tools and unwraps mcp-atlassian result text", async () => {
  const issue = { id: "10001", key: "TEST-1", summary: "Wrapped summary" };
  const fixture = mcpFixture({
    pages: [
      allTools.map((tool) =>
        tool.name === "jira_get_issue"
          ? {
              ...tool,
              outputSchema: {
                type: "object",
                properties: { result: { type: "string" } },
                required: ["result"],
                "x-fastmcp-wrap-result": true,
              },
            }
          : tool,
      ),
    ],
    rules: [
      {
        method: "tools/call",
        name: "jira_get_issue",
        result: { content: [], structuredContent: { result: JSON.stringify(issue) } },
      },
    ],
  });
  await withMcpEnvironment(
    () =>
      withRunTools(async (tools) => {
        const before = await tools.getModelTools([]);
        assert.doesNotMatch(before.systemPrompt, /external_jira_get_issue/);
        assert.deepEqual(
          await tools.executeTool(
            [],
            codemode(
              "return [typeof external_jira_get_issue, typeof external_discover_atlassian_tools];",
            ),
            context,
          ),
          { success: true, result: ["undefined", "undefined"], logs: [] },
        );

        const history = await discover(tools, ["jira_get_issue", "jira_search"]);
        const after = await tools.getModelTools(history);
        assert.match(
          after.systemPrompt,
          /declare function external_jira_get_issue\(input: External_jira_get_issueInput\): Promise<External_jira_get_issueOutput>;/,
        );
        assert.match(
          after.systemPrompt,
          /interface External_jira_searchOutput \{\n {2}total: number;/,
        );
        assert.match(after.systemPrompt, /browse_url\?: string;/);
        assert.equal(
          after.definitions.some((tool) => "outputSchema" in tool),
          false,
        );

        const jiraCall: ModelCall = {
          id: "direct",
          name: "jira_get_issue",
          arguments: "",
          input: { issue_key: "TEST-1" },
        };
        assert.deepEqual(await tools.executeTool(history, jiraCall, context), issue);
        assert.deepEqual(
          await tools.executeTool(
            history,
            codemode(`const issue = await external_jira_get_issue({ issue_key: "TEST-1" });
return issue.summary;`),
            context,
          ),
          { success: true, result: "Wrapped summary", logs: [] },
        );
        assert.deepEqual(
          fixture.calls().map((request) => request.message.params?.arguments),
          [
            { issue_key: "TEST-1", update_history: false },
            { issue_key: "TEST-1", update_history: false },
          ],
        );
      }),
    true,
    fixture,
  );
});

test("credential guards apply to results read inside code mode", async () => {
  await withMcpEnvironment(() =>
    withTemporaryFile(`token=${fakeToken}`, (path) =>
      withRunTools(async (tools) => {
        const events: unknown[] = [];
        const output = await tools.executeTool(
          [],
          codemode(`
try {
  return await external_read({ path: ${JSON.stringify(path)} });
} catch (error) {
  return (error as Error).message;
}`),
          { toolCallId: "outer", emitCustomEvent: (_name, value) => events.push(value) },
        );
        assert.deepEqual(output, {
          success: true,
          result: "Tool data contains configured Atlassian credentials",
          logs: [],
        });
        assert.equal(JSON.stringify(events).includes(fakeToken), false);
      }),
    ),
  );
});
