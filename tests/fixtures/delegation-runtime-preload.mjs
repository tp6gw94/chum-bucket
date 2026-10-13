import { appendFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { mock } from "node:test";
import {
  planningMixedIntent,
  planningMixedPrompt,
  scriptedEvents,
} from "./testing-runtime-external-fixture.mjs";

function textOf(message) {
  return typeof message?.content === "string"
    ? message.content
    : (message?.content ?? []).map((part) => part.text ?? "").join("");
}

if (process.argv.some((arg) => /server\/index\.ts$|delegation-recovery-worker\.mjs$/.test(arg))) {
  const { mcpFixture, fakeBaseUrl, fakeEmail, fakeToken, sourceReadPages, sourceReadRule } =
    await import("./mcp-fixture.ts");
  const fixture = mcpFixture({
    pages: sourceReadPages,
    rules: [
      ...(process.env.DELEGATION_FIXTURE_SCENARIO === "jira-comment"
        ? [
            {
              method: "tools/call",
              name: "jira_add_comment",
              arguments: {
                issue_key: "CHUM-42",
                body: "Approval fixture **exact body**\nSecond line. No live Jira write.",
              },
              result: {
                content: [{ type: "text", text: JSON.stringify({ id: "fixture-comment-42" }) }],
                structuredContent: { result: JSON.stringify({ id: "fixture-comment-42" }) },
              },
            },
          ]
        : []),
      sourceReadRule(
        "jira_get_issue",
        { issue_key: "CHUM-42" },
        {
          key: "CHUM-42",
          summary: "Checkout",
          description: "## 驗收條件\n1. AC-1 Checkout succeeds",
        },
      ),
      { method: "tools/call", error: { code: -32602, message: "Unknown fixture resource" } },
    ],
  });
  process.env.JIRA_BASE_URL = fakeBaseUrl;
  process.env.JIRA_EMAIL = fakeEmail;
  process.env.JIRA_API_TOKEN = fakeToken;
  process.env.ATLASSIAN_MCP_URL = await fixture.start();
  process.env.MODEL_API_KEY = "offline-fixture";
  process.env.FIGMA_API_KEY = "offline-fixture";
  const record = (event) => {
    const line = JSON.stringify({ at: new Date().toISOString(), pid: process.pid, ...event });
    console.log(`FIXTURE ${line}`);
    if (process.env.DELEGATION_EVIDENCE)
      appendFileSync(`${process.env.DELEGATION_EVIDENCE}/fixture.jsonl`, `${line}\n`);
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.hostname === "api.figma.com") {
      if (
        !/^\/v1\/files\/(FILE|CheckoutDemo)\/nodes$/.test(url.pathname) ||
        url.searchParams.get("ids") !== "12:34"
      )
        throw new Error("Unknown fixture Figma resource");
      record({ boundary: "figma", file: url.pathname, node: "12:34" });
      return new Response(
        JSON.stringify({
          nodes: {
            "12:34": {
              document: {
                id: "12:34",
                name: "Checkout",
                type: "FRAME",
                visible: true,
                absoluteBoundingBox: { x: 0, y: 0, width: 320, height: 48 },
              },
            },
          },
        }),
        { headers: { "content-type": "application/json" } },
      );
    }
    if (url.hostname !== "127.0.0.1" && url.hostname !== "localhost")
      throw new Error("External network denied by delegation fixture");
    if (
      process.env.DELEGATION_FIXTURE_SCENARIO === "jira-comment" &&
      init?.body &&
      String(init.body).includes("jira_add_comment")
    )
      record({ boundary: "mcp", request: JSON.parse(String(init.body)) });
    const response = await originalFetch(input, init);
    if (
      process.env.DELEGATION_FIXTURE_COMMENT_ACCEPT_DELAY &&
      init?.body &&
      String(init.body).includes('"name":"jira_add_comment"')
    ) {
      record({ boundary: "comment-accepted" });
      await delay(Number(process.env.DELEGATION_FIXTURE_COMMENT_ACCEPT_DELAY));
    }
    return response;
  };
  const { deepinfra } = await import("../../server/harness/provider.ts");
  const adapter = deepinfra("deepseek-ai/DeepSeek-V4.1-Flash");
  mock.method(Object.getPrototypeOf(adapter), "chatStream", async function* (options) {
    const users = (options.messages ?? []).filter((message) => message.role === "user").map(textOf);
    const taskText = users.find((text) => text.startsWith("testing-role:"));
    const role = taskText?.match(/testing-role:([a-z]+)/)?.[1] ?? "main";
    record({ boundary: "model", role });
    if (role === process.env.DELEGATION_FIXTURE_DELAY_ROLE)
      await delay(Number(process.env.DELEGATION_FIXTURE_DELAY_MS ?? "8000"));
    const last = users.at(-1) ?? "";
    const planningMixed = process.env.DELEGATION_FIXTURE_SCENARIO === "planning-mixed";
    const input =
      role === "main" && planningMixed && last === planningMixedPrompt
        ? planningMixedIntent
        : role === "main" && last.startsWith("fixture ")
          ? JSON.parse(last.slice(8))
          : undefined;
    if (role === "main" && !input) {
      yield* scriptedEvents(options, { ordinary: true });
      return;
    }
    const events = scriptedEvents(options, {
      intent: input,
      planningMixed,
      jiraComment: process.env.DELEGATION_FIXTURE_SCENARIO === "jira-comment",
    });
    if (role === "atlassian")
      record({
        boundary: "proposal",
        feedback: users.filter((text) => text.startsWith("Private validation failed:")),
        events,
      });
    for (const event of events) {
      if (planningMixed && role === "main" && event.type === "TEXT_MESSAGE_CONTENT") {
        await delay(Number(process.env.DELEGATION_FIXTURE_STREAM_MS ?? "200"));
      }
      yield event;
    }
  });
  process.on("beforeExit", () => void fixture.stop());
  record({ boundary: "installed", network: "loopback-and-fixture-only" });
}
