import assert from "node:assert/strict";
import { test } from "node:test";
import type { ToolExecutionContext } from "@tanstack/ai";
import type { ModelCall } from "../../../../server/harness/model-turn";
import type { ModelTool } from "../../../../server/harness/tools/atlassian";
import { ToolViolationError } from "../../../../server/harness/tools/boundary";
import {
  composeCodeModeTurn,
  type CodeModeDispatch,
} from "../../../../server/harness/tools/code-mode";

const definitions: ModelTool[] = [
  {
    name: "read",
    description: "Read a file",
    inputSchema: { type: "object", properties: { path: { type: "string" } } },
  },
  {
    name: "discover_atlassian_tools",
    description: "Discover",
    inputSchema: { type: "object", properties: {} },
  },
];

function contextFor(events: [string, Record<string, unknown>][] = []): ToolExecutionContext {
  return {
    toolCallId: "parent",
    abortSignal: new AbortController().signal,
    emitCustomEvent: (name: string, value: Record<string, unknown>) => {
      events.push([name, value]);
    },
  };
}

function turnWith(
  dispatch: CodeModeDispatch,
  options: {
    guard?: (value: unknown) => void;
    policy?: Parameters<typeof composeCodeModeTurn>[0]["policy"];
  } = {},
) {
  return composeCodeModeTurn({
    definitions,
    dispatch,
    guard: options.guard ?? (() => undefined),
    ...(options.policy ? { policy: options.policy } : {}),
    excluded: new Set(["discover_atlassian_tools"]),
  });
}

const echo: CodeModeDispatch = async (call) => ({ path: (call.input as { path: string }).path });

test("only bindings backed by dispatchable tools are advertised and codemode accepts a strict input", async () => {
  const turn = turnWith(echo);

  assert.deepEqual(turn.functions, ["external_read"]);
  assert.match(turn.systemPrompt, /external_read/);
  assert.doesNotMatch(turn.systemPrompt, /external_codemode|external_discover/);
  assert.equal(turn.definition.name, "codemode");
  assert.equal(
    (turn.definition.inputSchema as { additionalProperties?: boolean }).additionalProperties,
    false,
  );

  for (const input of [{}, { code: 1 }, { code: "return 1", extra: true }, "return 1"]) {
    await assert.rejects(turn.execute(input, contextFor()), /Invalid codemode input/);
  }
});

test("TypeScript runs in QuickJS and composes tool results", async () => {
  const calls: ModelCall[] = [];
  const turn = turnWith(async (call, context) => {
    calls.push(call);
    assert.equal(context.toolCallId, call.id);
    assert.ok(context.abortSignal);

    return { text: `content of ${(call.input as { path: string }).path}` };
  });

  const plain = await turn.execute({ code: "return 2 + 3;" }, contextFor());
  assert.deepEqual(plain, { success: true, result: 5, logs: [] });

  const composed = await turn.execute(
    {
      code: `
        const paths: string[] = ["a.txt", "b.txt"];
        const files = await Promise.all(paths.map((path) => external_read({ path })));
        return files.map((file: { text: string }) => file.text);
      `,
    },
    contextFor(),
  );

  assert.deepEqual(composed.result, ["content of a.txt", "content of b.txt"]);
  assert.deepEqual(calls.map((call) => call.id).sort(), ["parent/external/1", "parent/external/2"]);
});

test("host call budget violations survive guest try/catch", async () => {
  let dispatched = 0;
  const turn = turnWith(
    async () => {
      dispatched++;

      return {};
    },
    { policy: { maxHostCalls: 2 } },
  );
  const result = await turn.execute(
    {
      code: `
        for (let index = 0; index < 5; index++) {
          try { await external_read({ path: "a" }); } catch (failure) {}
        }
        return "finished";
      `,
    },
    contextFor(),
  );

  assert.equal(result.success, false);
  assert.equal(result.error?.name, "CodeModeBoundaryError");
  assert.equal(dispatched, 2);
});

test("credentials in code, host data or results stop the execution without echoing them", async () => {
  const guard = (value: unknown) => {
    if (JSON.stringify(value)?.includes("s3cret")) {
      throw new ToolViolationError("Tool data contains configured Atlassian credentials");
    }
  };
  const turn = turnWith(async () => ({ leaked: "s3cret" }), { guard });

  const inCode = await turn.execute({ code: 'return "s3cret";' }, contextFor());
  assert.equal(inCode.success, false);
  assert.doesNotMatch(JSON.stringify(inCode), /s3cret/);

  const inResult = await turn.execute(
    { code: 'try { await external_read({ path: "a" }); } catch (failure) {} return "ok";' },
    contextFor(),
  );
  assert.equal(inResult.success, false);
  assert.equal(inResult.error?.name, "CodeModeBoundaryError");
  assert.doesNotMatch(JSON.stringify(inResult), /s3cret/);
});

test("console output, source and result sizes are bounded", async () => {
  const turn = turnWith(echo, {
    policy: {
      maxConsoleEntries: 2,
      maxConsoleEntryBytes: 16,
      maxSourceBytes: 200,
      maxResultBytes: 500,
    },
  });
  const logged = await turn.execute(
    { code: 'console.log("x".repeat(100)); console.log("b"); console.log("c"); return 1;' },
    contextFor(),
  );

  assert.equal(logged.success, true);
  assert.equal(logged.logs?.length, 2);
  assert.ok(logged.logs!.every((line) => Buffer.byteLength(line) <= 16));

  const source = await turn.execute({ code: `return "${"a".repeat(300)}";` }, contextFor());
  assert.equal(source.success, false);
  assert.match(source.error!.message, /source size limit/);

  const large = await turn.execute({ code: 'return "a".repeat(3000);' }, contextFor());
  assert.equal(large.success, false);
  assert.equal(large.error?.name, "CodeModeResultTooLarge");
});

test("events are projected to metadata and never carry code, arguments or content", async () => {
  const events: [string, Record<string, unknown>][] = [];
  const turn = turnWith(async () => ({ secretBody: "FULL-FILE-CONTENT" }));
  await turn.execute(
    {
      code: 'console.log("PRIVATE-LOG"); await external_read({ path: "PRIVATE-PATH" }); return 1;',
    },
    contextFor(events),
  );

  const names = events.map(([name]) => name);
  assert.equal(names[0], "code_mode:execution_started");
  assert.equal(names.at(-1), "code_mode:execution_finished");
  assert.ok(names.includes("code_mode:external_call"));
  assert.ok(names.includes("code_mode:external_result"));
  assert.doesNotMatch(JSON.stringify(events), /PRIVATE|FULL-FILE-CONTENT|external_read\(/);
});

test("pending host work started by a forgotten await cannot continue after the execution", async () => {
  let dispatched = 0;
  const turn = turnWith(async () => {
    dispatched++;

    return {};
  });
  await turn.execute({ code: 'external_read({ path: "a" }); return "done";' }, contextFor());
  const after = dispatched;
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.equal(dispatched, after);
});
