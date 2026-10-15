import assert from "node:assert/strict";
import { test } from "node:test";
import type { ToolExecutionContext } from "@tanstack/ai";
import {
  createCodeMode,
  type CodeModeDefinition,
  type CodeModeDispatch,
  type CodeModePolicy,
} from "../../../../server/harness/tools/code-mode";

const policy: CodeModePolicy = {
  timeoutMs: 1_000,
  memoryLimitMb: 32,
  maxStackBytes: 256 * 1024,
  maxCodeLength: 2_000,
  maxToolCalls: 3,
  maxResultChars: 200,
  maxLogs: 2,
  maxMessageChars: 20,
};
const definitions: CodeModeDefinition[] = [
  {
    name: "lookup",
    description: "Look up a record\nMore detail",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
    },
    outputSchema: {
      type: "object",
      properties: { id: { type: "string" }, title: { type: "string" } },
      required: ["id", "title"],
    },
  },
];

function harness(dispatch: CodeModeDispatch, guard: (value: unknown) => void = () => {}) {
  const events: [string, Record<string, unknown>][] = [];
  const context: ToolExecutionContext = {
    toolCallId: "outer",
    emitCustomEvent: (name, value) => {
      events.push([name, value]);
    },
  };
  const codeMode = createCodeMode({ definitions, dispatch, guard, policy });
  return { codeMode, events, run: (code: string) => codeMode.execute({ code }, context) };
}

test("definition and prompt list sandbox functions with input and output declarations", () => {
  const { codeMode } = harness(async () => null);
  assert.equal(codeMode.definition.name, "codemode");
  assert.match(codeMode.definition.description, /external_lookup/);
  assert.deepEqual(codeMode.definition.inputSchema, {
    type: "object",
    properties: {
      code: {
        type: "string",
        minLength: 1,
        maxLength: 2_000,
        description: "TypeScript program body. Top-level await and return are allowed.",
      },
    },
    required: ["code"],
    additionalProperties: false,
  });
  assert.match(codeMode.systemPrompt, /- `external_lookup\(input\)`: Look up a record\n/);
  assert.match(codeMode.systemPrompt, /interface External_lookupInput \{\n {2}id: string;\n\}/);
  assert.match(
    codeMode.systemPrompt,
    /declare function external_lookup\(input: External_lookupInput\): Promise<External_lookupOutput>;/,
  );
  assert.match(
    codeMode.systemPrompt,
    /interface External_lookupOutput \{\n {2}id: string;\n {2}title: string;\n\}/,
  );
});

test("TypeScript programs call the shared dispatcher in parallel and return results, logs and events", async () => {
  const calls: { name: string; input: unknown; toolCallId?: string; signal: boolean }[] = [];
  const { run, events } = harness(async (name, input, context) => {
    calls.push({ name, input, toolCallId: context.toolCallId, signal: !!context.abortSignal });
    const { id } = input as { id: string };
    return { id, title: `Title ${id}` };
  });

  const result = await run(`
    const ids: string[] = ["A", "B"];
    const records = await Promise.all(ids.map((id) => external_lookup({ id })));
    console.log("found", records.length);
    return records.map((record) => record.title);
  `);

  assert.deepEqual(result, { success: true, result: ["Title A", "Title B"], logs: ["found 2"] });
  assert.deepEqual(
    calls.map(({ name, input, signal }) => ({ name, input, signal })),
    [
      { name: "lookup", input: { id: "A" }, signal: true },
      { name: "lookup", input: { id: "B" }, signal: true },
    ],
  );
  assert.deepEqual(calls.map((call) => call.toolCallId).sort(), ["outer:1", "outer:2"]);
  assert.deepEqual(
    events.map(([name]) => name),
    [
      "code_mode:execution_started",
      "code_mode:external_call",
      "code_mode:external_call",
      "code_mode:external_result",
      "code_mode:external_result",
      "code_mode:console",
      "code_mode:execution_finished",
    ],
  );
  assert.equal(events.at(-1)![1].success, true);
});

test("dispatcher failures surface as catchable errors without host stacks", async () => {
  const { run, events } = harness(async () => {
    throw new Error("Tool jira_search is not discovered");
  });

  const caught = await run(`
    try {
      await external_lookup({ id: "A" });
    } catch (error) {
      return (error as Error).message;
    }
  `);
  assert.deepEqual(caught, {
    success: true,
    result: "Tool jira_search is not discovered",
    logs: [],
  });
  assert.ok(events.some(([name]) => name === "code_mode:external_error"));

  const thrown = await run(`await external_lookup({ id: "A" });`);
  assert.equal(thrown.success, false);
  assert.deepEqual(Object.keys(thrown.error!).sort(), ["message", "name"]);
});

test("tool call, time, result and log limits are enforced", async () => {
  let dispatched = 0;
  const { run } = harness(async () => {
    dispatched++;
    return { id: "A", title: "x" };
  });

  const limited = await run(`
    const settled = await Promise.allSettled([1, 2, 3, 4].map(() => external_lookup({ id: "A" })));
    return settled.map((entry) => entry.status === "rejected" ? entry.reason.message : "ok");
  `);
  assert.deepEqual(limited.result, ["ok", "ok", "ok", "Code Mode allows at most 3 tool calls"]);
  assert.equal(dispatched, 3);

  const timedOut = await run("while (true) {}");
  assert.equal(timedOut.success, false);
  assert.equal(timedOut.error?.name, "TimeoutError");

  const large = await run(`return "x".repeat(500);`);
  assert.equal(large.truncated, true);
  assert.equal((large.result as string).length, 201);

  const noisy = await run(`
    for (let index = 0; index < 5; index++) console.log("line " + index + " ".repeat(40));
    return null;
  `);
  assert.deepEqual(noisy.logs, [
    "line 0              …",
    "line 1              …",
    "[3 more log lines omitted]",
  ]);
});

test("syntax errors, invalid input and guarded output fail before reaching the model", async () => {
  const { run, codeMode } = harness(
    async () => ({ id: "A", title: "secret-token" }),
    (value) => {
      if (JSON.stringify(value)?.includes("secret-token")) {
        throw new Error("Tool data contains configured Atlassian credentials");
      }
    },
  );

  const syntax = await run("const = ;");
  assert.equal(syntax.success, false);

  for (const input of [
    {},
    { code: "" },
    { code: "return 1", extra: true },
    { code: "x".repeat(2_001) },
  ]) {
    await assert.rejects(
      codeMode.execute(input, { toolCallId: "outer", emitCustomEvent: () => {} }),
    );
  }

  const leaked = await run(`return await external_lookup({ id: "A" });`);
  assert.equal(leaked.success, false);
  assert.match(leaked.error!.message, /^Tool data contains/);
  await assert.rejects(run(`return "secret-token";`), /configured Atlassian credentials/);
});

test("tool names that are not identifiers are never exposed to the sandbox", () => {
  assert.throws(
    () =>
      createCodeMode({
        definitions: [{ name: "bad-name", description: "", inputSchema: { type: "object" } }],
        dispatch: async () => null,
        guard: () => {},
        policy,
      }),
    /cannot be exposed to Code Mode/,
  );
});
