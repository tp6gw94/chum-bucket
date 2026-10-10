import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { test } from "node:test";
import { openaiCompatibleText } from "@tanstack/ai-openai/compatible";
import { resolveDebugOption } from "@tanstack/ai/adapter-internals";
import {
  EventType,
  convertMessagesToModelMessages,
  type AdapterYieldChunk,
  type StreamChunk,
  type UIMessage,
} from "@tanstack/ai";
import {
  ContextOverflowError,
  streamModelTurn,
  type Turn,
} from "../../../server/harness/model-turn";
import type { ModelTool } from "../../../server/harness/tools/atlassian";

test("offline HTTP SSE smoke exposes safe overflow and a complete provider response", async () => {
  let requests = 0;
  const server = createServer(async (request, response) => {
    for await (const _chunk of request) {
    }
    requests++;
    if (requests === 1) {
      response.writeHead(400, { "Content-Type": "application/json" });
      response.end(
        JSON.stringify({
          error: { code: "context_length_exceeded", message: "Private provider payload" },
        }),
      );
      return;
    }
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    response.end(
      [
        {
          choices: [
            {
              index: 0,
              delta: { role: "assistant", content: "Recovered over HTTP" },
              finish_reason: null,
            },
          ],
        },
        { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
      ]
        .map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`)
        .join("") + "data: [DONE]\n\n",
    );
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const adapter = openaiCompatibleText("offline-model", {
    apiKey: "offline",
    baseURL: `http://127.0.0.1:${address.port}/v1`,
  });
  const invoke = () =>
    streamModelTurn({
      messages: [],
      stream: adapter.chatStream({
        model: "offline-model",
        messages: [{ role: "user", content: "Continue" }],
        tools: [],
        logger: resolveDebugOption(false),
      }),
      append: async () => {},
    });
  try {
    await assert.rejects(
      invoke(),
      (error: unknown) =>
        error instanceof ContextOverflowError &&
        error.message === "Model context capacity exceeded",
    );
    const result = await invoke();
    assert.deepEqual(result.calls, []);
    assert.deepEqual(
      result.messages
        .flatMap((message) => message.parts)
        .filter((part) => part.type === "text")
        .map((part) => part.content),
      ["Recovered over HTTP"],
    );
    assert.equal(requests, 2);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test("provider overflow classification is allowlisted for streamed and thrown failures", async () => {
  const overflowMessage =
    "This model's maximum context length is 8192 tokens. However, you requested 10000 tokens.";
  const cases = [
    {
      error: { code: "context_length_exceeded", message: "private provider diagnostic" },
      overflow: true,
    },
    {
      error: { error: { code: "max_context_length_exceeded" }, message: "private" },
      overflow: true,
    },
    { error: { code: "400", message: overflowMessage }, overflow: true },
    { error: { message: overflowMessage }, overflow: true },
    { error: { code: "invalid_request_error", message: overflowMessage }, overflow: false },
    { error: { code: "429", message: overflowMessage }, overflow: false },
    {
      error: { status: 503, code: "context_length_exceeded", message: "Unavailable" },
      overflow: false,
    },
    { error: { status: 401, code: "context_length_exceeded", message: "Denied" }, overflow: false },
    { error: { code: "ECONNRESET", message: overflowMessage }, overflow: false },
    { error: { code: "context_length_exceeded", message: "Rate limit exceeded" }, overflow: false },
    { error: { message: "Input too long" }, overflow: false },
  ];
  for (const fixture of cases) {
    for (const streamed of [false, true]) {
      const failure = Object.assign(new Error(fixture.error.message), fixture.error);
      async function* stream(): AsyncGenerator<AdapterYieldChunk> {
        if (streamed) {
          yield { type: EventType.RUN_ERROR, message: failure.message, rawEvent: failure };
        } else {
          throw failure;
        }
      }
      await assert.rejects(
        streamModelTurn({ messages: [], stream: stream(), append: async () => {} }),
        (error: unknown) => {
          assert.equal(
            error instanceof ContextOverflowError,
            fixture.overflow,
            JSON.stringify(fixture),
          );
          if (fixture.overflow) {
            assert.equal((error as Error).message, "Model context capacity exceeded");
          }
          return true;
        },
      );
    }
  }
});

test("local append and protected-history failures never become provider overflow", async () => {
  const failure = Object.assign(new Error("context_length_exceeded"), {
    code: "context_length_exceeded",
  });
  async function* stream(): AsyncGenerator<AdapterYieldChunk> {
    yield { type: EventType.TEXT_MESSAGE_START, messageId: "fresh", role: "assistant" };
  }
  await assert.rejects(
    streamModelTurn({
      messages: [],
      stream: stream(),
      append: async () => {
        throw failure;
      },
    }),
    (error: unknown) => error === failure,
  );
  async function* collision(): AsyncGenerator<AdapterYieldChunk> {
    yield { type: EventType.TEXT_MESSAGE_START, messageId: "archived", role: "assistant" };
  }
  await assert.rejects(
    streamModelTurn({
      messages: [],
      protectedMessages: [{ id: "archived", role: "assistant", parts: [] }],
      stream: collision(),
      append: async () => {},
    }),
    /collides with conversation history/,
  );
});

test("iterator cleanup preserves primary provider and local failures", async () => {
  const overflow = Object.assign(new Error("private overflow"), {
    code: "context_length_exceeded",
  });
  const ordinary = new Error("ordinary provider failure");
  const local = Object.assign(new Error("local failure"), { code: "context_length_exceeded" });
  for (const fixture of [
    { source: "next", failure: overflow, overflow: true },
    { source: "next", failure: ordinary, overflow: false },
    { source: "append", failure: local, overflow: false },
    { source: "event", failure: overflow, overflow: true },
  ]) {
    let closed = false;
    const stream: AsyncIterable<AdapterYieldChunk> = {
      [Symbol.asyncIterator]() {
        return {
          async next() {
            if (fixture.source === "next") {
              throw fixture.failure;
            }
            const value: AdapterYieldChunk =
              fixture.source === "event"
                ? {
                    type: EventType.RUN_ERROR,
                    message: fixture.failure.message,
                    rawEvent: fixture.failure,
                  }
                : { type: EventType.TEXT_MESSAGE_START, messageId: "fresh", role: "assistant" };
            return { done: false, value };
          },
          async return() {
            closed = true;
            throw Object.assign(new Error("cleanup failure"), { code: "context_length_exceeded" });
          },
        };
      },
    };
    await assert.rejects(
      streamModelTurn({
        messages: [],
        stream,
        append: async () => {
          throw fixture.failure;
        },
      }),
      (error: unknown) => {
        if (fixture.overflow) {
          assert.ok(error instanceof ContextOverflowError);
          assert.equal(error.message, "Model context capacity exceeded");
        } else {
          assert.equal(error, fixture.failure);
        }
        return true;
      },
    );
    assert.equal(closed, true);
  }
});

type ToolCallEnd = Extract<StreamChunk, { type: "TOOL_CALL_END" }>;

const messages: UIMessage[] = [
  { id: "user", role: "user", parts: [{ type: "text", content: "Call the tool" }] },
];

function compatibleStream(definition: ModelTool, argumentsJson: string, strict: boolean) {
  const adapter = openaiCompatibleText("offline-model", {
    apiKey: "offline",
    baseURL: "http://offline/v1",
    fetch: async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as {
        tools: { function: { name: string; strict?: boolean } }[];
      };
      assert.equal(body.tools[0]?.function.strict, strict);
      return new Response(
        [
          {
            choices: [
              {
                index: 0,
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: "policy-call",
                      type: "function",
                      function: { name: definition.name, arguments: argumentsJson },
                    },
                  ],
                },
                finish_reason: null,
              },
            ],
          },
          { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
        ]
          .map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`)
          .join("") + "data: [DONE]\n\n",
        { headers: { "Content-Type": "text/event-stream" } },
      );
    },
  });
  return adapter.chatStream({
    model: "offline-model",
    messages: convertMessagesToModelMessages(messages),
    tools: [definition],
    logger: resolveDebugOption(false),
  });
}

function assertTurn(turn: Turn, argumentsJson: string, input: unknown) {
  assert.deepEqual(turn.calls, [
    { id: "policy-call", name: "policyTool", arguments: argumentsJson, input },
  ]);
  const part = turn.messages.at(-1)?.parts.find((part) => part.type === "tool-call");
  assert.equal(part?.arguments, argumentsJson);
  assert.deepEqual(part?.input, input);
  assert.deepEqual(JSON.parse(JSON.stringify(turn)), turn);
}

async function* declaredStream(
  argumentsJson: string,
  end: Pick<ToolCallEnd, "input" | "metadata">,
): AsyncGenerator<AdapterYieldChunk> {
  yield {
    type: EventType.TOOL_CALL_START,
    toolCallId: "policy-call",
    toolCallName: "policyTool",
  };
  yield { type: EventType.TOOL_CALL_ARGS, toolCallId: "policy-call", delta: argumentsJson };
  yield { type: EventType.TOOL_CALL_END, toolCallId: "policy-call", ...end };
  yield { type: EventType.RUN_FINISHED, threadId: "thread", runId: "run" };
}

const strictCases: {
  name: string;
  schema: ModelTool["inputSchema"];
  arguments: string;
  input: unknown;
}[] = [
  {
    name: "omits synthetic optional nulls and preserves genuine nullable and required nulls",
    schema: {
      type: "object",
      properties: {
        required: { type: "string" },
        omitted: { type: "string" },
        nullable: { type: ["string", "null"] },
        requiredNull: { type: "null" },
      },
      required: ["required", "requiredNull"],
    },
    arguments: ' { "required": "keep", "omitted": null, "nullable": null, "requiredNull": null } ',
    input: { required: "keep", nullable: null, requiredNull: null },
  },
  {
    name: "normalizes nested objects and arrays without changing order or legal nulls",
    schema: {
      type: "object",
      properties: {
        profile: {
          type: "object",
          properties: {
            label: { type: "string" },
            note: { type: "string" },
            comment: { type: ["string", "null"] },
          },
          required: ["label"],
        },
        rows: {
          type: "array",
          items: {
            type: "object",
            properties: { name: { type: "string" }, tag: { type: "string" } },
            required: ["name"],
          },
        },
        elements: { type: "array", items: { type: ["string", "null"] } },
      },
      required: ["profile", "rows", "elements"],
    },
    arguments:
      '{"profile":{"label":"a","note":null,"comment":null},"rows":[{"name":"first","tag":null},{"name":"second","tag":"kept"}],"elements":["a",null,"b"]}',
    input: {
      profile: { label: "a", comment: null },
      rows: [{ name: "first" }, { name: "second", tag: "kept" }],
      elements: ["a", null, "b"],
    },
  },
];

for (const outcome of strictCases) {
  test(`real adapter ${outcome.name} and preserves raw arguments`, async () => {
    const definition = {
      name: "policyTool",
      description: "Strict input control",
      inputSchema: outcome.schema,
    };
    const events: StreamChunk[] = [];
    const turn = await streamModelTurn({
      messages,
      stream: compatibleStream(definition, outcome.arguments, true),
      append: async (event) => {
        events.push(event);
      },
    });
    assertTurn(turn, outcome.arguments, outcome.input);
    const ends = events.filter((event) => event.type === EventType.TOOL_CALL_END);
    assert.equal(ends.length, 1);
    assert.deepEqual(ends[0]?.metadata?.tanstack?.input, outcome.input);
    assert.equal(
      events
        .filter((event) => event.type === EventType.TOOL_CALL_ARGS)
        .map((event) => event.delta)
        .join(""),
      outcome.arguments,
    );
  });
}

const nonStrictCases: { name: string; variant: ModelTool["inputSchema"] }[] = [
  { name: "oneOf", variant: { oneOf: [{ type: "string" }, { type: "null" }] } },
  { name: "typeless", variant: {} },
  { name: "open object", variant: { type: ["object", "null"], additionalProperties: true } },
  {
    name: "prefixItems tuple",
    variant: { type: ["array", "null"], prefixItems: [{ type: "string" }] },
  },
];

for (const outcome of nonStrictCases) {
  test(`real adapter preserves non-strict ${outcome.name} nulls`, async () => {
    const definition: ModelTool = {
      name: "policyTool",
      description: "Non-strict input control",
      inputSchema: {
        type: "object",
        properties: {
          keep: { type: "string" },
          omitted: { type: "string" },
          variant: outcome.variant,
        },
        required: ["keep"],
      },
    };
    const argumentsJson = '{"keep":"value","omitted":null,"variant":null}';
    const turn = await streamModelTurn({
      messages,
      stream: compatibleStream(definition, argumentsJson, false),
      append: async () => {},
    });
    assertTurn(turn, argumentsJson, { keep: "value", omitted: null, variant: null });
  });
}

test("model turn consumes metadata-only normalized input and preserves provider metadata", async () => {
  const events: StreamChunk[] = [];
  const argumentsJson = '{"required":"keep","omitted":null,"nullable":null}';
  const input = { required: "keep", nullable: null };
  const metadata = { provider: { signature: "kept" }, tanstack: { input } };
  const turn = await streamModelTurn({
    messages,
    stream: declaredStream(argumentsJson, { metadata }),
    append: async (event) => {
      events.push(event);
    },
  });
  assertTurn(turn, argumentsJson, input);
  assert.deepEqual(
    events.find((event) => event.type === EventType.TOOL_CALL_END)?.metadata,
    metadata,
  );
});

for (const input of [{ required: "changed" }, { extra: null }]) {
  test(`model turn trusts mismatched provider input ${JSON.stringify(input)} over raw arguments and metadata`, async () => {
    const argumentsJson = ' { "required": "original", "nullable": null } ';
    const end = {
      input,
      metadata: { tanstack: { input: { required: "metadata" } } },
    };
    const events: StreamChunk[] = [];
    const turn = await streamModelTurn({
      messages,
      stream: declaredStream(argumentsJson, end),
      append: async (event) => {
        events.push(event);
      },
    });
    assertTurn(turn, argumentsJson, input);
    assert.deepEqual(
      events.find((event) => event.type === EventType.TOOL_CALL_END)?.metadata?.tanstack?.input,
      input,
    );
  });
}

for (const argumentsJson of ["{", "", "null", "[]", '"text"', "1", "true"]) {
  test(`model turn rejects invalid raw arguments ${JSON.stringify(argumentsJson)} despite normalized input`, async () => {
    const events: StreamChunk[] = [];
    await assert.rejects(
      streamModelTurn({
        messages,
        stream: declaredStream(argumentsJson, { input: { normalized: "valid" } }),
        append: async (event) => {
          events.push(event);
        },
      }),
      argumentsJson === "{" || argumentsJson === "" ? SyntaxError : /Invalid tool arguments/,
    );
    assert.equal(
      events.some((event) => event.type === EventType.TOOL_CALL_END),
      false,
    );
    assert.equal(
      events.some((event) => event.type === EventType.RUN_FINISHED),
      false,
    );
  });
}
