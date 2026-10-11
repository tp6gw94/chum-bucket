import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { test, mock, type TestContext } from "node:test";
import type { ToolExecutionContext, UIMessage } from "@tanstack/ai";
import type { ModelCall } from "../../../../server/harness/model-turn";
import type { ModelTool } from "../../../../server/harness/tools/atlassian";
import {
  composeCodeModeTurn,
  type CodeModePolicy,
} from "../../../../server/harness/tools/code-mode";
import type { RunTools } from "../../../../server/harness/tools/index";
import { withCatalogTools as withRunTools } from "../../../fixtures/catalog-tools";
import {
  coreTools,
  fakeToken,
  mcpFixture,
  withMcpEnvironment,
} from "../../../fixtures/mcp-fixture";

type CodeModeResult = {
  success: boolean;
  result?: unknown;
  logs?: string[];
  error?: { name?: string; message: string };
};

type Dispatch = (call: ModelCall, context: ToolExecutionContext) => Promise<unknown>;

const readDefinition: ModelTool = {
  name: "read",
  description: "Read a file",
  inputSchema: {
    type: "object",
    properties: { path: { type: "string" } },
    required: ["path"],
  },
};

const context = (overrides: Partial<ToolExecutionContext> = {}): ToolExecutionContext => ({
  toolCallId: "code-mode-call",
  emitCustomEvent: () => {},
  ...overrides,
});

const modelCall = (code: string, id = "code-mode-call"): ModelCall => {
  const input = { code };

  return { id, name: "codemode", arguments: JSON.stringify(input), input };
};

const execute = (
  tools: RunTools,
  messages: readonly UIMessage[],
  code: string,
  overrides: Partial<ToolExecutionContext> = {},
): Promise<CodeModeResult> =>
  tools.executeTool(messages, modelCall(code), context(overrides)) as Promise<CodeModeResult>;

const compose = (
  policy: Partial<CodeModePolicy>,
  dispatch: Dispatch = async () => ({ ok: true }),
) => composeCodeModeTurn({ definitions: [readDefinition], dispatch, guard: () => {}, policy });

const composeEmpty = (
  policy: Partial<CodeModePolicy>,
  dispatch: Dispatch = async () => ({ ok: true }),
) => composeCodeModeTurn({ definitions: [], dispatch, guard: () => {}, policy });

const rejection = (promise: Promise<unknown>) =>
  promise.then(
    () => undefined,
    (error: unknown) => (error instanceof Error ? error : new Error(String(error))),
  );

async function temporaryDirectory(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "chum-code-mode-"));
  t.after(() => rm(directory, { recursive: true, force: true }));

  return directory;
}

let discoverySequence = 0;

async function discoveryHistory(tools: RunTools, toolNames: string[]): Promise<UIMessage[]> {
  const id = `code-mode-discovery-${++discoverySequence}`;
  const argumentsText = JSON.stringify({ toolNames });
  const output = await tools.executeTool(
    [],
    { id, name: "discover_atlassian_tools", arguments: argumentsText, input: { toolNames } },
    context({ toolCallId: id }),
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
        {
          type: "tool-result",
          toolCallId: id,
          content: JSON.stringify(output),
          state: "complete",
        },
      ],
    },
  ];
}

test("codemode runs TypeScript and returns native filesystem outcomes", async (t) => {
  const directory = await temporaryDirectory(t);
  const path = relative(process.cwd(), join(directory, "code-mode.txt"));
  await withRunTools(async (tools) => {
    const code = `
      const written = await external_write({ path: ${JSON.stringify(path)}, content: "alpha\\nbeta" });
      await external_edit({ path: ${JSON.stringify(path)}, edits: [{ oldText: "beta", newText: "gamma" }] });
      const read = await external_read({ path: ${JSON.stringify(path)} });
      const text = read.content.map((part) => part.text).join("");
      const parallel = await Promise.all([
        external_read({ path: ${JSON.stringify(path)} }),
        external_read({ path: ${JSON.stringify(path)} }),
      ]);
      return { text, wrote: written.content.length > 0, parallel: parallel.length };
    `;
    const result = await execute(tools, [], code);
    assert.deepEqual(result, {
      success: true,
      result: { text: "alpha\ngamma", wrote: true, parallel: 2 },
      logs: [],
    });
    assert.equal(await readFile(join(directory, "code-mode.txt"), "utf8"), "alpha\ngamma");
  });
});

test("the model turn documents exactly the bindings the sandbox exposes", async () => {
  await withRunTools(async (tools) => {
    const turn = await tools.getModelTools([]);
    assert.deepEqual(
      turn.definitions.map((tool) => tool.name),
      ["get_figma", "read", "write", "edit", "codemode"],
    );
    const codeMode = turn.definitions.find((tool) => tool.name === "codemode")!;
    assert.deepEqual(codeMode.inputSchema.required, ["code"]);
    const properties = codeMode.inputSchema.properties as Record<
      string,
      { type?: unknown; description?: unknown }
    >;
    assert.equal(properties.code?.type, "string");
    assert.equal(typeof properties.code?.description, "string");
    assert.equal("typescriptCode" in properties, false);
    assert.equal(codeMode.inputSchema.additionalProperties, false);
    assert.match(codeMode.description, /JSON `\{"code": "<typescript>"\}`/);
    assert.match(turn.systemPrompt, /JSON `\{ "code": "<typescript>" \}`/);
    assert.match(turn.systemPrompt, /declare function external_read\(/);
    assert.match(turn.systemPrompt, /declare function external_write\(/);
    assert.match(turn.systemPrompt, /declare function external_edit\(/);
    assert.match(turn.systemPrompt, /declare function external_get_figma\(/);
    assert.match(turn.systemPrompt, /`external_read\(input\)`: Read the contents of a file/);
    assert.match(turn.systemPrompt, /path: string;/);
    assert.doesNotMatch(turn.systemPrompt, /external_codemode/);
    assert.doesNotMatch(turn.systemPrompt, /external_discover_atlassian_tools/);
  });
});

test("codemode executes TypeScript with genuinely empty bindings and projects its events", async () => {
  const turn = composeEmpty({ timeoutMs: 5000 });
  assert.match(turn.definition.description, /No external functions are available/);
  assert.match(turn.systemPrompt, /No external functions are available/);
  assert.doesNotMatch(turn.definition.description, /external_/);
  assert.doesNotMatch(turn.systemPrompt, /external_/);

  const events: { name: string; value: Record<string, unknown> }[] = [];
  const code = `
    const values: number[] = [2, 4, 6].map((value: number) => value * 3);
    console.log("computed");
    return { values, total: values.reduce((sum, value) => sum + value, 0) };
  `;
  const result = (await turn.execute(
    { code },
    context({
      emitCustomEvent: (name, value) => events.push({ name, value }),
    }),
  )) as CodeModeResult;

  assert.deepEqual(result, {
    success: true,
    result: { values: [6, 12, 18], total: 36 },
    logs: ["computed"],
  });
  assert.deepEqual(
    events.map(({ name }) => name),
    ["code_mode:execution_started", "code_mode:console", "code_mode:execution_finished"],
  );
  assert.equal(events[0]!.value.codeLength, code.length);
  assert.deepEqual(events[1]!.value, { level: "log", byteLength: 8 });
  assert.equal(events[2]!.value.phase, "execute");
  assert.equal(events[2]!.value.success, true);
});

test("empty bindings retain source, result, console, timeout and cancellation bounds", async () => {
  await assert.rejects(
    composeEmpty({ maxSourceBytes: 32, timeoutMs: 5000 }).execute(
      { code: `const value = 1; ${" ".repeat(64)}return value;` },
      context(),
    ),
    /source exceeds 32 bytes/,
  );
  await assert.rejects(
    composeEmpty({ maxResultBytes: 32, timeoutMs: 5000 }).execute(
      { code: `return "x".repeat(128);` },
      context(),
    ),
    /result is too large/,
  );

  const bounded = (await composeEmpty({
    maxConsoleEntries: 2,
    maxConsoleBytes: 64,
    maxConsoleEntryBytes: 32,
    timeoutMs: 5000,
  }).execute(
    {
      code: `for (let index = 0; index < 20; index++) console.log("x".repeat(100)); return "done";`,
    },
    context(),
  )) as CodeModeResult;
  assert.equal(bounded.success, true);
  assert.ok((bounded.logs?.length ?? 0) <= 2);
  assert.ok(Buffer.byteLength(bounded.logs?.join("") ?? "", "utf8") <= 64);

  const memoryLimited = (await composeEmpty({
    memoryLimitMb: 8,
    timeoutMs: 5000,
  }).execute({ code: `return "x".repeat(20_000_000);` }, context())) as CodeModeResult;
  assert.equal(memoryLimited.success, false);
  assert.match(memoryLimited.error?.message ?? "", /memory|allocation/i);

  const started = Date.now();
  const timed = (await composeEmpty({ timeoutMs: 250 }).execute(
    { code: "while (true) {}" },
    context(),
  )) as CodeModeResult;
  assert.equal(timed.success, false);
  assert.match(timed.error?.message ?? "", /timed out/i);
  assert.ok(Date.now() - started < 5000);
  const controller = new AbortController();
  const cancelled = composeEmpty({ timeoutMs: 350 }).execute(
    { code: "while (true) {}" },
    context({ abortSignal: controller.signal }),
  );
  setTimeout(() => controller.abort(), 25);
  await assert.rejects(cancelled, /cancelled/);
  const afterCancellation = (await composeEmpty({ timeoutMs: 5000 }).execute(
    { code: "return 7;" },
    context(),
  )) as CodeModeResult;
  assert.equal(afterCancellation.result, 7);
  await assert.rejects(
    composeEmpty({ timeoutMs: 5000 }).execute(
      { code: "return 1;" },
      context({ abortSignal: AbortSignal.abort() }),
    ),
    /cancelled/,
  );
});

test("codemode preserves external descriptions and excludes recursive bindings", async () => {
  const description = "Read execute_typescript and typescriptCode documentation";
  const turn = composeCodeModeTurn({
    definitions: [
      { ...readDefinition, description },
      { name: "codemode", description: "Run code", inputSchema: { type: "object" } },
      {
        name: "discover_atlassian_tools",
        description: "Discover tools",
        inputSchema: { type: "object" },
      },
    ],
    dispatch: async () => ({ text: "documentation" }),
    guard: () => {},
  });
  assert.match(turn.systemPrompt, /Read execute_typescript and typescriptCode documentation/);
  const result = await turn.execute(
    {
      code: `
        const file = await external_read({ path: "README.md" });
        return {
          text: file.text,
          recursive: typeof external_codemode,
          discovery: typeof external_discover_atlassian_tools,
        };
      `,
    },
    context(),
  );
  assert.deepEqual(result, {
    success: true,
    result: { text: "documentation", recursive: "undefined", discovery: "undefined" },
    logs: [],
  });
});

test("discovery grants sandbox bindings while recursive and discovery calls stay unavailable", async () => {
  const fixture = mcpFixture({ pages: [coreTools] });
  await withMcpEnvironment(
    async () => {
      await withRunTools(async (tools) => {
        const before = await tools.getModelTools([]);
        assert.doesNotMatch(before.systemPrompt, /external_jira_get_issue/);
        const history = await discoveryHistory(tools, ["jira_get_issue"]);
        const after = await tools.getModelTools(history);
        assert.match(after.systemPrompt, /declare function external_jira_get_issue\(/);
        const result = await execute(
          tools,
          history,
          `
            const available = Object.keys(globalThis).filter((key) => key.startsWith("external_"));
            let recursive = "missing";
            try {
              await external_codemode({ code: "return 1" });
              recursive = "callable";
            } catch (error) {}
            let discovery = "missing";
            try {
              await external_discover_atlassian_tools({ toolNames: ["jira_get_issue"] });
              discovery = "callable";
            } catch (error) {}
            const issue = await external_jira_get_issue({ issue_key: "TEST-1" });
            return { available: available.sort(), recursive, discovery, issue };
          `,
        );
        assert.equal(result.success, true);
        assert.deepEqual(result.result, {
          available: [
            "external_edit",
            "external_get_figma",
            "external_jira_get_issue",
            "external_read",
            "external_write",
          ],
          recursive: "missing",
          discovery: "missing",
          issue: { issue: "TEST-1" },
        });
      });
    },
    true,
    fixture,
  );
});

test("code mode events stay metadata-only and arrive in execution order", async (t) => {
  const directory = await temporaryDirectory(t);
  const path = join(directory, "events.txt");
  await writeFile(path, "file-payload");
  const relativePath = relative(process.cwd(), path);
  await withRunTools(async (tools) => {
    const events: { name: string; value: Record<string, unknown> }[] = [];
    const code = `
      console.log("guest-message");
      const file = await external_read({ path: ${JSON.stringify(relativePath)} });
      return file.content.map((part) => part.text).join("");
    `;
    const result = await execute(tools, [], code, {
      emitCustomEvent: (name, value) => events.push({ name, value }),
    });
    assert.equal(result.success, true);
    assert.equal(result.result, "file-payload");
    assert.deepEqual(
      events.map((event) => event.name),
      [
        "code_mode:execution_started",
        "code_mode:external_call",
        "code_mode:external_result",
        "code_mode:console",
        "code_mode:execution_finished",
      ],
    );
    assert.equal(events[0]!.value.codeLength, code.length);
    assert.equal(events[1]!.value.function, "external_read");
    assert.equal(typeof events[1]!.value.argumentBytes, "number");
    assert.equal(events[4]!.value.success, true);
    const serialized = JSON.stringify(events);
    assert.equal(serialized.includes("file-payload"), false);
    assert.equal(serialized.includes("guest-message"), false);
    assert.equal(serialized.includes("typescriptCode"), false);
    assert.equal(serialized.includes('"code"'), false);
  });
});

test("configured credentials never cross the code mode boundary", async () => {
  const fixture = mcpFixture();
  await withMcpEnvironment(
    async () => {
      await withRunTools(async (tools) => {
        for (const code of [
          `const token = ${JSON.stringify(fakeToken)}; return token;`,
          `const token = ${JSON.stringify(fakeToken.slice(0, 24))} + ${JSON.stringify(fakeToken.slice(24))}; throw new Error("leak " + token);`,
          `const token = ${JSON.stringify(fakeToken.slice(0, 24))} + ${JSON.stringify(fakeToken.slice(24))}; console.log(token); return "done";`,
        ]) {
          const failure = await rejection(execute(tools, [], code));
          assert.ok(failure, code);
          assert.match(failure.message, /configured Atlassian credentials/);
          assert.equal(failure.message.includes(fakeToken), false);
        }

        for (const input of [
          { code: "return 1;", [fakeToken]: true },
          { code: 42, extra: fakeToken },
        ]) {
          const failure = await rejection(
            tools.executeTool(
              [],
              { id: "invalid-secret", name: "codemode", arguments: JSON.stringify(input), input },
              context(),
            ),
          );
          assert.ok(failure);
          assert.match(failure.message, /configured Atlassian credentials/);
          assert.equal(failure.message.includes(fakeToken), false);
        }
      });
    },
    true,
    fixture,
  );
});

test("a credential in a host result fails the execution even when the guest catches it", async () => {
  const fixture = mcpFixture({
    pages: [coreTools],
    rules: [
      {
        method: "tools/call",
        name: "jira_get_issue",
        result: {
          content: [{ type: "text", text: `token ${fakeToken}` }],
          structuredContent: { issue: fakeToken },
        },
      },
    ],
  });
  await withMcpEnvironment(
    async () => {
      await withRunTools(async (tools) => {
        const history = await discoveryHistory(tools, ["jira_get_issue"]);
        const failure = await rejection(
          execute(
            tools,
            history,
            `
              let outcome = "clean";
              try {
                await external_jira_get_issue({ issue_key: "TEST-1" });
              } catch (error) {
                outcome = "caught";
              }
              return outcome;
            `,
          ),
        );
        assert.ok(failure);
        assert.match(failure.message, /configured Atlassian credentials/);
        assert.equal(failure.message.includes(fakeToken), false);
      });
    },
    true,
    fixture,
  );
});

test("sandbox host calls carry child identifiers, the parent deadline and the call budget", async () => {
  const calls: { id: string; toolCallId?: string; signal: boolean }[] = [];
  const turn = compose({ maxHostCalls: 3, timeoutMs: 5000 }, async (call, child) => {
    calls.push({
      id: call.id,
      toolCallId: child.toolCallId,
      signal: Boolean(child.abortSignal),
    });

    return { content: [{ type: "text", text: String((call.input as { path?: unknown }).path) }] };
  });
  const result = (await turn.execute(
    {
      code: `
        const first = await external_read({ path: "one" });
        const second = await external_read({ path: "two" });
        return [first.content[0].text, second.content[0].text];
      `,
    },
    context({ toolCallId: "parent-call" }),
  )) as CodeModeResult;
  assert.deepEqual(result.result, ["one", "two"]);
  assert.deepEqual(calls, [
    { id: "parent-call/external/1", toolCallId: "parent-call/external/1", signal: true },
    { id: "parent-call/external/2", toolCallId: "parent-call/external/2", signal: true },
  ]);
  await assert.rejects(
    compose({ maxHostCalls: 1, timeoutMs: 5000 })
      .execute(
        {
          code: `
            await external_read({ path: "one" });
            await external_read({ path: "two" });
            return "done";
          `,
        },
        context(),
      )
      .then((value) => value as CodeModeResult),
    /exceeded 1 tool calls/,
  );
});

test("cancelled and oversized executions stop before sandbox work", async () => {
  const dispatch = async () => ({ ok: true });
  await assert.rejects(
    compose({ timeoutMs: 5000 }, dispatch).execute(
      { code: "return 1;" },
      context({ abortSignal: AbortSignal.abort() }),
    ),
    /cancelled/,
  );
  const controller = new AbortController();
  const pending = compose(
    { timeoutMs: 5000 },
    async (_call, child) =>
      new Promise((_resolve, reject) => {
        child.abortSignal?.addEventListener("abort", () => reject(new Error("host stopped")), {
          once: true,
        });
      }),
  ).execute(
    { code: `const value = await external_read({ path: "slow" }); return value;` },
    context({ abortSignal: controller.signal }),
  );
  setTimeout(() => controller.abort(), 25);
  await assert.rejects(pending, /cancelled/);
  await assert.rejects(
    compose({ maxSourceBytes: 64, timeoutMs: 5000 }, dispatch).execute(
      { code: `const value = 1;\n${" ".repeat(120)}return value;` },
      context(),
    ),
    /source exceeds 64 bytes/,
  );
});

test("runaway guest code is stopped by the execution budget", async () => {
  const started = Date.now();
  const result = (await compose({ timeoutMs: 400 }).execute(
    { code: "while (true) {}" },
    context(),
  )) as CodeModeResult;
  assert.equal(result.success, false);
  assert.match(result.error?.message ?? "", /timed out/);
  assert.ok(Date.now() - started < 10_000);
});

test("console output stays bounded when the guest rewrites the console", async () => {
  const result = (await compose({
    maxConsoleEntries: 4,
    maxConsoleBytes: 512,
    maxConsoleEntryBytes: 128,
    timeoutMs: 5000,
  }).execute(
    {
      code: `
        try { console.log = () => {}; } catch (error) {}
        try { delete console.log; } catch (error) {}
        try { globalThis.console = { log: () => {} }; } catch (error) {}
        try { String.prototype.slice = function () { return String(this); }; } catch (error) {}
        try { String.prototype.charCodeAt = function () { return 0; }; } catch (error) {}
        try { Array.prototype.join = function () { return "joined"; }; } catch (error) {}
        try { JSON.stringify = function () { return "stringified"; }; } catch (error) {}
        for (let index = 0; index < 500; index++) {
          console.log("entry-" + index + "-" + "x".repeat(300));
        }
        return "done";
      `,
    },
    context(),
  )) as CodeModeResult;
  assert.equal(result.success, true);
  const logs = result.logs ?? [];
  assert.ok(logs.length > 0, "console output is captured");
  assert.ok(logs.length <= 4, `console entries are bounded, received ${logs.length}`);
  assert.ok(Buffer.byteLength(logs.join(""), "utf8") <= 512, "console bytes are bounded");
  assert.ok(
    logs.every((entry) => !entry.includes("x".repeat(200))),
    "truncated entries never reach the host collector in full",
  );
});

test("console byte budgets count UTF-8 bytes instead of code units", async () => {
  const result = (await compose({
    maxConsoleEntries: 2,
    maxConsoleBytes: 40,
    maxConsoleEntryBytes: 40,
    timeoutMs: 5000,
  }).execute(
    {
      code: `
        console.log("中".repeat(100));
        console.log("é".repeat(100));
        console.log("tail");
        return "done";
      `,
    },
    context(),
  )) as CodeModeResult;
  assert.equal(result.success, true);
  const logs = result.logs ?? [];
  assert.ok(logs.length <= 2, `console entries are bounded, received ${logs.length}`);
  assert.ok(Buffer.byteLength(logs.join(""), "utf8") <= 40, "console bytes are bounded");
  assert.ok((logs[0]?.length ?? 0) > 0);
  assert.ok("中".repeat(100).startsWith(logs[0]!));
});

test("a late guest continuation cannot dispatch host work after the execution finished", async () => {
  const dispatched: string[] = [];
  const signals: (AbortSignal | undefined)[] = [];
  const events: string[] = [];
  const release = Promise.withResolvers<void>();
  const turn = composeCodeModeTurn({
    definitions: [
      readDefinition,
      {
        name: "write",
        description: "Write a file",
        inputSchema: {
          type: "object",
          properties: { path: { type: "string" }, content: { type: "string" } },
          required: ["path", "content"],
        },
      },
    ],
    guard: () => {},
    policy: { timeoutMs: 5000 },
    dispatch: async (call, child) => {
      dispatched.push(call.name);
      signals.push(child.abortSignal);
      await release.promise;

      return { content: [{ type: "text", text: "slow" }] };
    },
  });
  const result = (await turn.execute(
    {
      code: `
        void external_read({ path: "slow" }).catch(() => external_write({ path: "late", content: "x" }));
        return "done";
      `,
    },
    context({
      emitCustomEvent: (name) => {
        events.push(name);
      },
    }),
  )) as CodeModeResult;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(result.success, true);
  assert.equal(result.result, "done");
  assert.deepEqual(dispatched, ["read"]);
  assert.deepEqual(
    events.filter((name) => name.startsWith("code_mode:external")),
    ["code_mode:external_call"],
  );
  assert.equal(events.at(-1), "code_mode:execution_finished");
  assert.equal(signals[0]?.aborted, true);
  release.resolve();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(dispatched, ["read"]);
  assert.deepEqual(
    events.filter((name) => name.startsWith("code_mode:external")),
    ["code_mode:external_call"],
  );
});

test("guest tool calls reject non-object input without dispatching", async () => {
  const dispatched: string[] = [];
  const turn = compose({ timeoutMs: 5000 }, async (call) => {
    dispatched.push(call.name);

    return { ok: true };
  });
  const result = (await turn.execute(
    {
      code: `
        let outcome = "accepted";
        try {
          await external_read("nope");
        } catch (error) {
          outcome = "rejected";
        }
        return outcome;
      `,
    },
    context(),
  )) as CodeModeResult;
  assert.equal(result.success, true);
  assert.equal(result.result, "rejected");
  assert.deepEqual(dispatched, []);
});

test("invalid input and oversized results are rejected before returning to the model", async () => {
  const dispatched: string[] = [];
  const turn = compose({ timeoutMs: 5000 }, async (call) => {
    dispatched.push(call.name);

    return { ok: true };
  });

  for (const invalid of [
    {},
    { code: 42 },
    { typescriptCode: "return 1;" },
    { code: "return 1;", typescriptCode: "return 2;" },
    { code: "return 1;", extra: true },
  ]) {
    await assert.rejects(turn.execute(invalid, context()), /expected string|Unrecognized key/);
  }

  assert.deepEqual(dispatched, []);
  await assert.rejects(
    compose({ maxResultBytes: 64, timeoutMs: 5000 }).execute(
      { code: `return "x".repeat(200);` },
      context(),
    ),
    /result is too large/,
  );
});

test("a credential in the sandbox result or error never reaches the host logger", async () => {
  const fixture = mcpFixture();
  await withMcpEnvironment(
    async () => {
      const logged: unknown[][] = [];
      const spy = mock.method(console, "error", (...args: unknown[]) => {
        logged.push(args);
      });

      try {
        await withRunTools(async (tools) => {
          for (const code of [
            `const token = ${JSON.stringify(fakeToken.slice(0, 24))} + ${JSON.stringify(fakeToken.slice(24))}; return token;`,
            `const token = ${JSON.stringify(fakeToken.slice(0, 24))} + ${JSON.stringify(fakeToken.slice(24))}; throw new Error("leak " + token);`,
          ]) {
            const failure = await rejection(execute(tools, [], code));
            assert.ok(failure);
            assert.match(failure.message, /configured Atlassian credentials/);
            assert.equal(failure.message.includes(fakeToken), false);
          }
        });
        assert.ok(logged.length > 0, "the library logger path is exercised");
        assert.equal(JSON.stringify(logged).includes(fakeToken), false);
      } finally {
        spy.mock.restore();
      }
    },
    true,
    fixture,
  );
});

test("the exact user program with null Jira arguments dispatches through the sandbox", async () => {
  const code = `const out: Record<string, unknown> = {};
try {
  const r = await external_jira_get_issue({
    issue_key: "FETM-77",
    fields: "summary,status",
    expand: null,
    comment_limit: null,
    properties: null,
    update_history: false,
    include: null,
    use_display_names: true,
  });
  out.jira = r;
} catch (e) { out.jiraError = String(e); }
console.log(JSON.stringify(out).slice(0, 500));
return out;`;
  const calls: { name: string; input: unknown }[] = [];
  const turn = composeCodeModeTurn({
    definitions: [
      {
        name: "jira_get_issue",
        description: "Get a Jira issue by key",
        inputSchema: {
          type: "object",
          properties: {
            issue_key: { type: "string" },
            fields: { type: "string" },
            expand: { type: "string" },
            comment_limit: { type: "number" },
            properties: { type: "string" },
            update_history: { type: "boolean" },
            include: { type: "string" },
            use_display_names: { type: "boolean" },
          },
          required: ["issue_key"],
        },
      },
    ],
    guard: () => {},
    dispatch: async (call) => {
      calls.push({ name: call.name, input: call.input });

      return { ok: true, key: "FETM-77" };
    },
  });
  assert.match(turn.systemPrompt, /Get a Jira issue by key/);
  assert.match(turn.definition.description, /external_jira_get_issue/);
  const result = (await turn.execute({ code }, context({ toolCallId: "repro" }))) as CodeModeResult;
  assert.equal(result.success, true);
  assert.deepEqual(result.result, { jira: { ok: true, key: "FETM-77" } });
  assert.deepEqual(calls, [
    {
      name: "jira_get_issue",
      input: {
        issue_key: "FETM-77",
        fields: "summary,status",
        expand: null,
        comment_limit: null,
        properties: null,
        update_history: false,
        include: null,
        use_display_names: true,
      },
    },
  ]);
});
