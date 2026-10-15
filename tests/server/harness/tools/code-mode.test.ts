import assert from "node:assert/strict";
import { test } from "node:test";
import type { ToolExecutionContext, UIMessage } from "@tanstack/ai";
import type { ModelCall } from "../../../../server/harness/model-turn";
import type { ModelTool } from "../../../../server/harness/tools/atlassian";
import { withRunTools, type RunTools } from "../../../../server/harness/tools";
import {
  codeModeLimits,
  codeModeToolName,
  withCodeMode,
  type CodeModeLimits,
  type CodeModeResult,
} from "../../../../server/harness/tools/code-mode";
import { mcpFixture, withMcpEnvironment } from "../../../fixtures/mcp-fixture";

type Dispatched = {
  messages: readonly UIMessage[];
  call: ModelCall;
  context: ToolExecutionContext;
};
type Handler = (input: Record<string, unknown>, context: ToolExecutionContext) => Promise<unknown>;

const objectSchema = (property: string) => ({
  type: "object",
  properties: { [property]: { type: "string" } },
  required: [property],
});
const definitions: ModelTool[] = [
  { name: "read", description: "Read a file", inputSchema: objectSchema("path") },
  { name: "write", description: "Write a file", inputSchema: objectSchema("path") },
];
const history: UIMessage[] = [
  { id: "user", role: "user", parts: [{ type: "text", content: "Summarize files" }] },
];

function harness(handlers: Record<string, Handler>, limits?: Partial<CodeModeLimits>) {
  const dispatched: Dispatched[] = [];
  const events: { name: string; value: Record<string, unknown> }[] = [];
  const base: RunTools = {
    getModelTools: async () => structuredClone(definitions),
    executeTool: async (messages, call, context) => {
      dispatched.push({ messages, call, context });
      const handler = handlers[call.name];
      assert.ok(handler, `unexpected dispatch of ${call.name}`);
      return handler(call.input as Record<string, unknown>, context);
    },
  };
  const tools = withCodeMode(base, {
    sandboxed: new Set(["read"]),
    limits: { ...codeModeLimits, ...limits },
  });
  const run = (typescriptCode: string, signal?: AbortSignal) =>
    tools.executeTool(
      history,
      {
        id: "code",
        name: codeModeToolName,
        arguments: JSON.stringify({ typescriptCode }),
        input: { typescriptCode },
      },
      {
        toolCallId: "code",
        ...(signal ? { abortSignal: signal } : {}),
        emitCustomEvent: (name, value) => events.push({ name, value }),
      },
    ) as Promise<CodeModeResult>;
  return { tools, run, dispatched, events };
}

const readEcho: Handler = async (input) => ({ path: input.path, size: String(input.path).length });

test("execute_typescript is advertised last with type stubs for sandboxed tools only", async () => {
  const { tools } = harness({});
  const advertised = await tools.getModelTools(history);

  assert.deepEqual(
    advertised.map((tool) => tool.name),
    ["read", "write", codeModeToolName],
  );
  const description = advertised.at(-1)!.description;
  assert.match(description, /declare function external_read\(input: External_readInput\)/);
  assert.match(description, /path: string;/);
  assert.doesNotMatch(description, /external_write/);

  const none = withCodeMode(
    { getModelTools: async () => definitions, executeTool: async () => undefined },
    { sandboxed: new Set() },
  );
  assert.deepEqual(
    (await none.getModelTools(history)).map((tool) => tool.name),
    ["read", "write"],
  );
});

test("TypeScript orchestrates parallel tool calls through the shared dispatcher", async () => {
  const { run, dispatched, events } = harness({ read: readEcho });
  const result = await run(`
    type Stat = { path: string; size: number };
    const paths: string[] = ["a.ts", "bb.ts"];
    const stats = (await Promise.all(paths.map((path) => external_read({ path })))) as Stat[];
    console.log("read", stats.length, { total: stats.length });
    return { largest: stats.reduce((a, b) => (a.size > b.size ? a : b)).path };
  `);

  assert.deepEqual(result, {
    success: true,
    result: { largest: "bb.ts" },
    logs: ['read 2 {"total":2}'],
    toolCalls: 2,
  });
  assert.deepEqual(
    dispatched.map(({ call }) => [call.id, call.name, call.input, call.arguments]),
    [
      ["code:1", "read", { path: "a.ts" }, '{"path":"a.ts"}'],
      ["code:2", "read", { path: "bb.ts" }, '{"path":"bb.ts"}'],
    ],
  );
  assert.ok(dispatched.every(({ messages }) => messages === history));
  assert.ok(dispatched.every(({ call, context }) => context.toolCallId === call.id));
  assert.deepEqual(
    events.map((event) => event.name),
    [
      "code_mode:external_call",
      "code_mode:external_call",
      "code_mode:external_result",
      "code_mode:external_result",
      "code_mode:execution_finished",
    ],
  );
  assert.deepEqual(events[0]!.value, { function: "external_read", sequence: 1 });
  assert.ok(events.every((event) => !JSON.stringify(event.value).includes("a.ts")));
  assert.equal(events.at(-1)!.value.toolCalls, 2);
});

test("the sandbox exposes no host capabilities or unadvertised tools", async () => {
  const { run, dispatched, tools } = harness({ write: async () => "written" });
  const probe = await run(`
    return [typeof fetch, typeof require, typeof process, typeof setTimeout, typeof globalThis.external_write];
  `);

  assert.deepEqual(probe.result, ["undefined", "undefined", "undefined", "undefined", "undefined"]);
  const denied = await run(`return await external_write({ path: "x" });`);
  assert.equal(denied.success, false);
  assert.match(denied.error!.message, /'external_write' is not defined/);
  assert.equal(dispatched.length, 0);

  const direct = await tools.executeTool(
    history,
    { id: "direct", name: "write", arguments: '{"path":"x"}', input: { path: "x" } },
    { toolCallId: "direct", emitCustomEvent: () => {} },
  );
  assert.equal(direct, "written");
  assert.equal(dispatched.length, 1);
});

test("tool failures surface inside the program without leaking host stacks", async () => {
  const { run } = harness({
    read: async (input) => {
      throw new Error(`missing ${String(input.path)}`);
    },
  });
  const caught = await run(`
    try { await external_read({ path: "gone" }); } catch (error) { return (error as Error).message; }
  `);
  assert.deepEqual(caught.result, "missing gone");

  const thrown = await run(`await external_read({ path: "gone" });`);
  assert.equal(thrown.success, false);
  assert.deepEqual(Object.keys(thrown.error!), ["name", "message"]);
  assert.equal(thrown.error!.message, "missing gone");

  const syntax = await run(`return (;`);
  assert.equal(syntax.success, false);
  assert.doesNotMatch(JSON.stringify(syntax), /node_modules|\/Users\//);
});

test("budgets bound tool calls, arguments, time, memory, result size, logs, and code", async () => {
  const calls = harness({ read: readEcho }, { maxToolCalls: 2 });
  const limited = await calls.run(`
    for (const path of ["a", "b", "c"]) await external_read({ path });
    return "unreachable";
  `);
  assert.equal(limited.success, false);
  assert.match(limited.error!.message, /call limit of 2 exceeded/);
  assert.equal(limited.toolCalls, 2);
  assert.equal(calls.dispatched.length, 2);

  const shape = await harness({ read: readEcho }).run(`return await external_read("a");`);
  assert.match(shape.error!.message, /expects one object argument/);

  const time = await harness({}, { timeoutMs: 200 }).run(`while (true) {}`);
  assert.equal(time.error!.name, "TimeoutError");

  const memory = await harness({}, { memoryMb: 4 }).run(
    `const items = []; while (true) items.push("x".repeat(4096));`,
  );
  assert.equal(memory.error!.name, "MemoryLimitError");

  const size = await harness({}, { maxResultChars: 100 }).run(`return "x".repeat(200);`);
  assert.equal(size.error!.name, "ResultTooLarge");
  assert.equal(size.result, undefined);

  const logs = await harness({}, { maxLogs: 3, maxLogChars: 10 }).run(`
    for (let index = 0; index < 1000; index++) console.log("line-" + index + "-padding");
    console.error({ late: true });
    return "done";
  `);
  assert.deepEqual(logs.logs, [
    "line-0-pad",
    "line-1-pad",
    "line-2-pad",
    "[console output truncated]",
  ]);

  const code = harness({}, { maxCodeChars: 10 });
  await assert.rejects(code.run("return 12345678901;"), /1 to 10 characters/);
  await assert.rejects(code.run("   "), /1 to 10 characters/);
});

test("cancellation aborts in-flight and later tool calls and settles promptly", async () => {
  const signals: AbortSignal[] = [];
  const started = Promise.withResolvers<void>();
  const { run, dispatched } = harness({
    read: (_input, context) => {
      signals.push(context.abortSignal!);
      started.resolve();
      return new Promise(() => {});
    },
  });
  const controller = new AbortController();
  const executing = run(
    `
      try { await external_read({ path: "slow" }); } catch {}
      return await external_read({ path: "after" });
    `,
    controller.signal,
  );
  await started.promise;
  const before = Date.now();
  controller.abort();
  const result = await executing;

  assert.ok(Date.now() - before < 1000);
  assert.equal(result.success, false);
  assert.equal(result.error!.name, "AbortError");
  assert.equal(dispatched.length, 1);
  assert.equal(signals[0]!.aborted, true);
});

test("finished executions abort their tool calls", async () => {
  const signals: AbortSignal[] = [];
  const { run } = harness({
    read: async (_input, context) => {
      signals.push(context.abortSignal!);
      return "ok";
    },
  });
  await run(`return await external_read({ path: "a" });`);
  assert.equal(signals[0]!.aborted, true);
});

test("Atlassian tools join the sandbox only after lazy discovery and dispatch through MCP", async () => {
  const fixture = mcpFixture();
  await withMcpEnvironment(
    () =>
      withRunTools(async (tools) => {
        const code = 'return await external_jira_get_issue({ issue_key: "TEST-1" });';
        const call = (messages: UIMessage[]) =>
          tools.executeTool(
            messages,
            {
              id: "code",
              name: codeModeToolName,
              arguments: JSON.stringify({ typescriptCode: code }),
              input: { typescriptCode: code },
            },
            { toolCallId: "code", emitCustomEvent: () => {} },
          ) as Promise<CodeModeResult>;
        const before = await tools.getModelTools([]);
        assert.doesNotMatch(before.at(-1)!.description, /external_jira_get_issue/);
        assert.match((await call([])).error!.message, /'external_jira_get_issue' is not defined/);

        const argumentsText = JSON.stringify({ toolNames: ["jira_get_issue"] });
        const output = await tools.executeTool(
          [],
          {
            id: "discovery",
            name: "discover_atlassian_tools",
            arguments: argumentsText,
            input: { toolNames: ["jira_get_issue"] },
          },
          { toolCallId: "discovery", emitCustomEvent: () => {} },
        );
        const discovered: UIMessage[] = [
          {
            id: "discovery-message",
            role: "assistant",
            parts: [
              {
                type: "tool-call",
                id: "discovery",
                name: "discover_atlassian_tools",
                arguments: argumentsText,
                state: "complete",
              },
              {
                type: "tool-result",
                toolCallId: "discovery",
                content: JSON.stringify(output),
                state: "complete",
              },
            ],
          },
        ];
        const after = await tools.getModelTools(discovered);
        assert.equal(after.at(-1)!.name, codeModeToolName);
        assert.match(after.at(-1)!.description, /declare function external_jira_get_issue/);
        assert.doesNotMatch(after.at(-1)!.description, /external_(write|edit|discover)/);

        const result = await call(discovered);
        assert.equal(result.success, true);
        assert.deepEqual(fixture.calls().at(-1)!.message.params, {
          name: "jira_get_issue",
          arguments: { issue_key: "TEST-1", update_history: false },
        });
      }),
    true,
    fixture,
  );
});
