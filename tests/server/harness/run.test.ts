import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, mock } from "node:test";
import { Pool } from "pg";
import { DBOS } from "@dbos-inc/dbos-sdk";
import { createReadTool, createWriteTool, createEditTool } from "@earendil-works/pi-coding-agent";
import { read } from "../../../server/harness/tools/fs";
import type { ModelTool } from "../../../server/harness/tools/atlassian";
import type { RunTools } from "../../../server/harness/tools";
import { withCatalogTools as withRunTools } from "../../fixtures/catalog-tools";
import {
  mcpFixture,
  jiraSchema,
  coreTools,
  allTools,
  fakeEmail,
  fakeToken,
  withMcpEnvironment,
} from "../../fixtures/mcp-fixture";
import { eventResponse, parseCursor, parseRunBody, parseCompactBody } from "../../../server/chat";
import { ChatClient, fetchServerSentEvents } from "@tanstack/ai-react";
import { openaiCompatibleText } from "@tanstack/ai-openai/compatible";
import { resolveDebugOption } from "@tanstack/ai/adapter-internals";
import {
  EventType,
  StreamProcessor,
  convertMessagesToModelMessages,
  convertSchemaToJsonSchema,
  type AdapterYieldChunk,
  type StreamChunk,
  type UIMessage,
} from "@tanstack/ai";
import { acceptRun, reconcileRuns, executeRun, ensureStarted } from "../../../server/harness/run";
import { agentRegistry } from "../../../server/harness/agents";
import { snapshot, streamModelTurn, type Turn } from "../../../server/harness/model-turn";
import { compactionPolicy } from "../../../server/harness/compaction";
import {
  readProjection,
  type RunProjection,
  type ConversationState,
} from "../../../server/harness/conversation";
import { parseCompactionEvent } from "../../../shared/compaction-event";
import {
  BUILD,
  persistRun,
  checkpointCompaction,
  emit,
  finishRun,
  hydrateThread,
  checkCursor,
  observeRun,
  type AcceptedRun,
} from "../../../server/harness/run-store";

const deferred = () => Promise.withResolvers<void>();
const modelTools = (tools: RunTools, messages: readonly UIMessage[] = []) =>
  tools.getModelTools(messages).then((turn) => turn.definitions);
const readSchema = convertSchemaToJsonSchema(read.inputSchema);
assert.ok(readSchema);
const readDefinitions: ModelTool[] = [
  {
    name: read.name,
    description: read.description,
    inputSchema: readSchema,
  },
];
const baseline: UIMessage[] = [
  { id: "user-1", role: "user", parts: [{ type: "text", content: "Hello" }] },
];
let runDiscoverySequence = 0;

async function discoveryHistory(tools: RunTools, toolNames: string[]): Promise<UIMessage[]> {
  const id = `run-discovery-${++runDiscoverySequence}`;
  const argumentsText = JSON.stringify({ toolNames });
  const output = await tools.executeTool(
    [],
    { id, name: "discover_atlassian_tools", arguments: argumentsText, input: { toolNames } },
    { toolCallId: id, emitCustomEvent: () => {} },
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

let textSequence = 0;

async function* textStream(
  wait?: Promise<void>,
  messageId = "provider-id",
): AsyncGenerator<AdapterYieldChunk> {
  yield { type: EventType.RUN_STARTED, threadId: "provider-thread", runId: "provider-run" };
  yield { type: EventType.TEXT_MESSAGE_START, messageId, role: "assistant" };
  yield { type: EventType.TEXT_MESSAGE_CONTENT, messageId, delta: "root = Stack(" };

  if (wait) {
    await wait;
  }

  yield { type: EventType.TEXT_MESSAGE_CONTENT, messageId, delta: ")" };
  yield { type: EventType.TEXT_MESSAGE_END, messageId };
  yield { type: EventType.RUN_FINISHED, threadId: "provider-thread", runId: "provider-run" };
}

test(
  "first durable token reaches the real SSE ChatClient before provider completion",
  { timeout: 5000 },
  async () => {
    const release = deferred();
    const visible = deferred();
    const encoder = new TextEncoder();
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({
      start(value) {
        controller = value;
      },
    });
    let sequence = 0;
    let providerCompleted = false;
    const log: StreamChunk[] = [];
    const requested = deferred();
    let submitted!: ReturnType<typeof parseRunBody>;

    const append = async (event: StreamChunk) => {
      log.push(structuredClone(event));
      controller.enqueue(encoder.encode(`id: ${sequence++}\ndata: ${JSON.stringify(event)}\n\n`));
    };

    const client = new ChatClient({
      threadId: accepted.threadId,
      connection: fetchServerSentEvents("http://offline/api/chat", {
        fetchClient: async (_url, init) => {
          submitted = parseRunBody(
            JSON.parse(String(init?.body)),
            new Headers(init?.headers).get("X-Run-Id") ?? undefined,
          );
          requested.resolve();

          return new Response(body, { headers: { "Content-Type": "text/event-stream" } });
        },
      }),
      onMessagesChange(messages: UIMessage[]) {
        if (
          messages.some((message) =>
            message.parts.some((part) => part.type === "text" && part.content === "root = Stack("),
          )
        ) {
          visible.resolve();
        }
      },
    });
    const sending = client.sendMessage({ id: "user-1", content: "Hello" }, { baseRevision: 0 });
    await requested.promise;
    assert.match(submitted.runId, /^run-/);
    await append({
      type: EventType.RUN_STARTED,
      threadId: submitted.threadId,
      runId: submitted.runId,
    });
    await append(snapshot(baseline));
    const producing = streamModelTurn({
      messages: baseline,
      stream: textStream(release.promise),
      append,
    }).then((result) => {
      providerCompleted = true;

      return result;
    });

    try {
      await Promise.race([
        visible.promise,
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("No early token")), 2000).unref(),
        ),
      ]);
      assert.equal(providerCompleted, false);
      assert.ok(log.some((event) => event.type === EventType.TEXT_MESSAGE_CONTENT));
      release.resolve();
      const result = await producing;
      await append(snapshot(result.messages));
      await append({
        type: EventType.RUN_FINISHED,
        threadId: submitted.threadId,
        runId: submitted.runId,
      });
      controller.close();
      await sending;
      assert.equal(result.messages.at(-1)?.id, "provider-id");
      assert.equal(log.filter((event) => event.type === EventType.RUN_FINISHED).length, 1);
      assert.equal(log.filter((event) => event.type === EventType.RUN_STARTED).length, 1);
    } finally {
      release.resolve();
      client.unsubscribe();
    }
  },
);

test("native snapshot discards failed OpenUI partial before the next attempt", async () => {
  const processor = new StreamProcessor({ initialMessages: baseline });
  processor.processChunk({
    type: EventType.TEXT_MESSAGE_START,
    messageId: "failed",
    role: "assistant",
  });
  processor.processChunk({
    type: EventType.TEXT_MESSAGE_CONTENT,
    messageId: "failed",
    delta: "root = Stack(",
  });
  processor.processChunk(snapshot(baseline));
  const result = await streamModelTurn({
    messages: baseline,
    stream: textStream(),
    append: async (event) => {
      processor.processChunk(event);
    },
  });
  assert.deepEqual(
    processor.getMessages().map((message) => message.id),
    ["user-1", "provider-id"],
  );
  assert.deepEqual(processor.getMessages().at(-1)?.parts, result.messages.at(-1)?.parts);
});

test("native text boundaries and metadata survive while content after completion rejects", async () => {
  async function* provider(afterCompletion: boolean): AsyncGenerator<AdapterYieldChunk> {
    yield {
      type: EventType.TEXT_MESSAGE_START,
      messageId: "provider-id",
      role: "assistant",
      metadata: { tanstack: { toolCallId: "unknown" } },
    };
    yield { type: EventType.TEXT_MESSAGE_CONTENT, messageId: "provider-id", delta: "text" };
    yield {
      type: EventType.TEXT_MESSAGE_END,
      messageId: "provider-id",
      metadata: { tanstack: { toolCallId: "unknown" } },
    };
    yield { type: EventType.RUN_FINISHED, threadId: "thread", runId: "provider-run" };

    if (afterCompletion) {
      yield { type: EventType.TEXT_MESSAGE_CONTENT, messageId: "provider-id", delta: "late" };
    }
  }

  for (const afterCompletion of [false, true]) {
    const events: StreamChunk[] = [];
    const result = streamModelTurn({
      messages: baseline,
      stream: provider(afterCompletion),
      append: async (event) => {
        events.push(event);
      },
    });

    if (afterCompletion) {
      await assert.rejects(result, /content after completion/);
    } else {
      assert.deepEqual((await result).messages.at(-1)?.parts, [{ type: "text", content: "text" }]);
    }

    assert.deepEqual(events, [
      {
        type: EventType.TEXT_MESSAGE_START,
        messageId: "provider-id",
        role: "assistant",
        metadata: { tanstack: { toolCallId: "unknown" } },
      },
      { type: EventType.TEXT_MESSAGE_CONTENT, messageId: "provider-id", delta: "text" },
      {
        type: EventType.TEXT_MESSAGE_END,
        messageId: "provider-id",
        metadata: { tanstack: { toolCallId: "unknown" } },
      },
    ]);
  }
});

test("append failure stops provider consumption and cannot complete a turn", async () => {
  let continued = false;

  async function* provider(): AsyncGenerator<AdapterYieldChunk> {
    yield { type: EventType.TEXT_MESSAGE_CONTENT, messageId: "source", delta: "first" };
    continued = true;
    yield { type: EventType.RUN_FINISHED, threadId: "thread", runId: "run" };
  }

  await assert.rejects(
    streamModelTurn({
      messages: baseline,
      stream: provider(),
      append: async (event) => {
        if (event.type === EventType.TEXT_MESSAGE_CONTENT) {
          throw new Error("append unavailable");
        }
      },
    }),
    /append unavailable/,
  );
  assert.equal(continued, false);
});

const accepted: AcceptedRun = {
  kind: "chat",
  threadId: "d08035f1-07df-49f3-b2d0-5cf5cb2b1e74",
  runId: "ca2f180a-8461-4cfb-9012-f413df6d72f9",
  baseRevision: 0,
  message: { id: "user-1", text: "Hello" },
  messages: baseline,
  context: baseline,
  prompt: "offline",
  model: "deepseek-ai/DeepSeek-V4.1-Flash",
  build: BUILD,
};
const toolTurn: Turn = {
  messages: baseline,
  calls: [
    {
      id: "tool-1",
      name: "read",
      arguments: '{"path":"TEST-1"}',
      input: { path: "TEST-1" },
    },
    {
      id: "tool-2",
      name: "read",
      arguments: '{"path":"TEST-2"}',
      input: { path: "TEST-2" },
    },
  ],
};

test("model checkpoint serialization failure halts all tools", async () => {
  const names: string[] = [];
  const stepping = mock.method(
    DBOS,
    "runStep",
    async (callback: () => Promise<unknown>, config?: { name?: string }) => {
      const name = config?.name ?? "";
      names.push(name);

      if (name.startsWith("model:")) {
        throw new Error("Checkpoint serialization rejected");
      }

      return callback();
    },
  );

  try {
    await assert.rejects(executeRun(accepted), /Checkpoint serialization rejected/);
    assert.deepEqual(names, ["compact:0", "model:0"]);
  } finally {
    stepping.mock.restore();
  }
});

test("reasoning-first and two native tool calls survive snapshots and model history conversion", async () => {
  async function* provider(): AsyncGenerator<AdapterYieldChunk> {
    yield { type: EventType.REASONING_MESSAGE_CONTENT, messageId: "thought", delta: "thinking" };
    yield { type: EventType.TEXT_MESSAGE_START, messageId: "provider-message", role: "assistant" };

    for (const [id, path] of [
      ["provider-one", "TEST-1"],
      ["provider-two", "TEST-2"],
    ]) {
      yield {
        type: EventType.TOOL_CALL_START,
        toolCallId: id!,
        toolCallName: "read",
        parentMessageId: "provider-message",
      };
      yield { type: EventType.TOOL_CALL_ARGS, toolCallId: id!, delta: JSON.stringify({ path }) };
      yield { type: EventType.TOOL_CALL_END, toolCallId: id!, input: { path } };
    }

    yield { type: EventType.RUN_FINISHED, threadId: "thread", runId: "provider-run" };
  }

  const events: StreamChunk[] = [];
  const result = await streamModelTurn({
    messages: baseline,
    stream: provider(),
    append: async (event) => {
      events.push(event);
    },
  });
  assert.deepEqual(
    result.calls.map((call) => call.id),
    ["provider-one", "provider-two"],
  );
  assert.deepEqual(
    result.calls.map((call) => call.input),
    [{ path: "TEST-1" }, { path: "TEST-2" }],
  );
  const processor = new StreamProcessor({ initialMessages: baseline });

  for (const event of events) {
    processor.processChunk(event);
  }

  for (const call of result.calls) {
    processor.processChunk({
      type: EventType.TOOL_CALL_RESULT,
      toolCallId: call.id,
      messageId: `${call.id}/result`,
      role: "tool",
      content: '{"ok":true}',
    });
  }

  const completed = processor.getMessages();
  processor.processChunk({
    type: EventType.TEXT_MESSAGE_START,
    messageId: "failed-next",
    role: "assistant",
  });
  processor.processChunk({
    type: EventType.TEXT_MESSAGE_CONTENT,
    messageId: "failed-next",
    delta: "partial",
  });
  processor.processChunk(snapshot(completed));
  assert.deepEqual(
    processor.getMessages().map((message) => message.id),
    completed.map((message) => message.id),
  );
  assert.deepEqual(
    completed.map((message) => message.id),
    ["user-1", "provider-message"],
  );
  const history = convertMessagesToModelMessages(completed);
  assert.deepEqual(
    history.flatMap((message) => message.toolCalls ?? []).map((call) => call.id),
    ["provider-one", "provider-two"],
  );
  assert.deepEqual(
    history.filter((message) => message.role === "tool").map((message) => message.toolCallId),
    ["provider-one", "provider-two"],
  );
  const parts = processor.getMessages().at(-1)!.parts;
  assert.equal(parts.filter((part) => part.type === "tool-result").length, 2);
  assert.equal(
    parts.filter((part) => part.type === "tool-call" && part.state === "complete").length,
    2,
  );
  assert.ok(parts.some((part) => part.type === "thinking" && part.content === "thinking"));
});

test("tool-only reasoning, encrypted signatures, and provider metadata retain native references", async () => {
  async function* provider(): AsyncGenerator<AdapterYieldChunk> {
    yield { type: EventType.RUN_STARTED, threadId: "provider-thread", runId: "provider-run" };
    yield {
      type: EventType.STEP_STARTED,
      stepName: "provider-step",
      metadata: {
        tanstack: {
          threadId: "provider-thread",
          runId: "provider-run",
          messageId: "provider-message",
          stepId: "provider-step-id",
        },
      },
    };
    yield {
      type: EventType.REASONING_MESSAGE_CONTENT,
      messageId: "provider-thought",
      delta: "hmm",
    };
    yield {
      type: EventType.REASONING_ENCRYPTED_VALUE,
      subtype: "message",
      entityId: "provider-thought",
      encryptedValue: "message-signature",
    };
    yield {
      type: EventType.TOOL_CALL_START,
      toolCallId: "provider-tool",
      toolCallName: "read",
    };
    yield {
      type: EventType.TOOL_CALL_ARGS,
      toolCallId: "provider-tool",
      delta: '{"path":"T-1"}',
    };
    yield {
      type: EventType.TOOL_CALL_END,
      toolCallId: "provider-tool",
      metadata: {
        tanstack: {
          threadId: "provider-thread",
          runId: "provider-run",
          toolCallId: "provider-tool",
          input: { path: "T-1" },
        },
      },
    };
    yield {
      type: EventType.REASONING_ENCRYPTED_VALUE,
      subtype: "tool-call",
      entityId: "provider-tool",
      encryptedValue: "tool-signature",
    };
    yield { type: EventType.STEP_FINISHED, stepName: "provider-step" };
    yield { type: EventType.RUN_FINISHED, threadId: "provider-thread", runId: "provider-run" };
  }

  const events: StreamChunk[] = [];
  const result = await streamModelTurn({
    messages: baseline,
    stream: provider(),
    append: async (event) => {
      events.push(event);
    },
  });
  const ofType = <T extends StreamChunk["type"]>(type: T) =>
    events.filter((event): event is Extract<StreamChunk, { type: T }> => event.type === type);
  assert.deepEqual(
    result.calls.map((call) => call.id),
    ["provider-tool"],
  );
  assert.equal(ofType(EventType.STEP_STARTED)[0]!.stepName, "provider-step");
  assert.equal(ofType(EventType.STEP_FINISHED)[0]!.stepName, "provider-step");
  assert.deepEqual(ofType(EventType.STEP_STARTED)[0]!.metadata, {
    tanstack: {
      threadId: "provider-thread",
      runId: "provider-run",
      messageId: "provider-message",
      stepId: "provider-step-id",
    },
  });
  assert.deepEqual(
    ofType(EventType.REASONING_ENCRYPTED_VALUE).map((event) => event.entityId),
    ["provider-thought", "provider-tool"],
  );
  assert.equal(ofType("TOOL_CALL_END")[0]!.toolCallId, "provider-tool");
  assert.deepEqual(ofType("TOOL_CALL_END")[0]!.metadata, {
    tanstack: {
      threadId: "provider-thread",
      runId: "provider-run",
      toolCallId: "provider-tool",
      input: { path: "T-1" },
    },
  });
  let visible: UIMessage[] = [];
  const client = new ChatClient({
    threadId: accepted.threadId,
    connection: fetchServerSentEvents("http://offline/api/chat", {
      fetchClient: async () =>
        new Response(
          [
            { type: EventType.RUN_STARTED, threadId: accepted.threadId, runId: accepted.runId },
            snapshot(baseline),
            ...events,
            snapshot(result.messages),
            { type: EventType.RUN_FINISHED, threadId: accepted.threadId, runId: accepted.runId },
          ]
            .map((event, index) => `id: ${index}\ndata: ${JSON.stringify(event)}\n\n`)
            .join(""),
          { headers: { "Content-Type": "text/event-stream" } },
        ),
    }),
    onMessagesChange(messages) {
      visible = messages;
    },
  });

  try {
    await client.sendMessage({ id: "user-1", content: "Hello" }, { baseRevision: 0 });
  } finally {
    client.unsubscribe();
  }

  const parts = visible.flatMap((message) => message.parts);
  assert.ok(
    parts.some((part) => part.type === "thinking" && part.signature === "message-signature"),
  );
  assert.ok(
    parts.some(
      (part) =>
        part.type === "tool-call" &&
        part.id === "provider-tool" &&
        (part.metadata as { thoughtSignature?: string } | undefined)?.thoughtSignature ===
          "tool-signature",
    ),
  );
  const history = convertMessagesToModelMessages(visible);
  assert.ok(
    history.some((message) =>
      message.toolCalls?.some(
        (call) =>
          call.id === "provider-tool" &&
          (call.metadata as { thoughtSignature?: string } | undefined)?.thoughtSignature ===
            "tool-signature",
      ),
    ),
  );
});

test("real compatible adapter reasoning-first and tool-only streams reach ChatClient with native references", async () => {
  for (const withText of [false, true]) {
    let requests = 0;
    const adapter = openaiCompatibleText("offline-model", {
      apiKey: "offline",
      baseURL: "http://offline/v1",
      fetch: async () => {
        requests++;
        const deltas = [
          { reasoning_content: "think first" },
          ...(withText ? [{ content: "visible" }] : []),
          {
            tool_calls: [
              {
                index: 0,
                id: "native-call",
                type: "function",
                function: { name: "read", arguments: '{"path":' },
              },
            ],
          },
          { tool_calls: [{ index: 0, function: { arguments: '"TEST-1"}' } }] },
        ];
        const chunks = [
          ...deltas.map((delta) => ({ choices: [{ index: 0, delta, finish_reason: null }] })),
          { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
        ];

        return new Response(
          chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n",
          { headers: { "Content-Type": "text/event-stream" } },
        );
      },
    });
    const events: StreamChunk[] = [];
    const turn = await streamModelTurn({
      messages: baseline,
      stream: adapter.chatStream({
        model: "offline-model",
        messages: convertMessagesToModelMessages(baseline),
        tools: readDefinitions,
        logger: resolveDebugOption(false),
      }),
      append: async (event) => {
        events.push(event);
      },
    });
    assert.equal(requests, 1);
    assert.deepEqual(turn.calls, [
      {
        id: "native-call",
        name: "read",
        arguments: '{"path":"TEST-1"}',
        input: { path: "TEST-1" },
      },
    ]);
    assert.equal(
      events.some(
        (event) => event.type === EventType.RUN_STARTED || event.type === EventType.RUN_FINISHED,
      ),
      false,
    );
    const processor = new StreamProcessor({ initialMessages: turn.messages });
    const result: StreamChunk = {
      type: EventType.TOOL_CALL_RESULT,
      toolCallId: "native-call",
      messageId: "native-result",
      role: "tool",
      content: '{"ok":true}',
    };
    processor.processChunk(result);
    let visible: UIMessage[] = [];
    const client = new ChatClient({
      threadId: accepted.threadId,
      connection: fetchServerSentEvents("http://offline/api/chat", {
        fetchClient: async () =>
          new Response(
            [
              { type: EventType.RUN_STARTED, threadId: accepted.threadId, runId: accepted.runId },
              snapshot(baseline),
              ...events,
              snapshot(turn.messages),
              result,
              snapshot(processor.getMessages()),
              { type: EventType.RUN_FINISHED, threadId: accepted.threadId, runId: accepted.runId },
            ]
              .map((event, index) => `id: ${index}\ndata: ${JSON.stringify(event)}\n\n`)
              .join(""),
            { headers: { "Content-Type": "text/event-stream" } },
          ),
      }),
      onMessagesChange(messages) {
        visible = messages;
      },
    });

    try {
      await client.sendMessage({ id: "user-1", content: "Hello" }, { baseRevision: 0 });
      const parts = visible.flatMap((message) => message.parts);
      assert.ok(parts.some((part) => part.type === "thinking" && part.content === "think first"));
      assert.ok(
        parts.some(
          (part) =>
            part.type === "tool-call" && part.id === "native-call" && part.state === "complete",
        ),
      );
      assert.ok(
        parts.some(
          (part) =>
            part.type === "tool-result" &&
            part.toolCallId === "native-call" &&
            part.content === '{"ok":true}',
        ),
      );
      assert.equal(
        parts.some((part) => part.type === "text" && part.content === "visible"),
        withText,
      );
      const history = convertMessagesToModelMessages(visible);
      assert.ok(
        history.some((message) => message.toolCalls?.some((call) => call.id === "native-call")),
      );
      assert.ok(
        history.some((message) => message.role === "tool" && message.toolCallId === "native-call"),
      );
    } finally {
      client.unsubscribe();
    }
  }
});

const representativeConfluenceSearch: ModelTool = {
  name: "confluence_search",
  description: "Representative Confluence search",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string" },
      limit: { type: "integer", default: 10, minimum: 1, maximum: 50 },
      spaces_filter: { type: "string", default: null },
    },
    required: ["query"],
  },
};

test("real compatible adapter accepts representative confluence_search optional-null arguments", async () => {
  const definitions = [representativeConfluenceSearch];
  const argumentsJson = '{"query":"space = SMAXH","limit":10,"spaces_filter":null}';
  const adapter = openaiCompatibleText("offline-model", {
    apiKey: "offline",
    baseURL: "http://offline/v1",
    fetch: async () =>
      new Response(
        [
          {
            choices: [
              {
                index: 0,
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: "search-call",
                      type: "function",
                      function: { name: "confluence_search", arguments: argumentsJson },
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
      ),
  });
  const events: StreamChunk[] = [];
  const turn = await streamModelTurn({
    messages: baseline,
    stream: adapter.chatStream({
      model: "offline-model",
      messages: convertMessagesToModelMessages(baseline),
      tools: definitions,
      logger: resolveDebugOption(false),
    }),
    append: async (event) => {
      events.push(event);
    },
  });
  assert.deepEqual(turn.calls, [
    {
      id: "search-call",
      name: "confluence_search",
      arguments: argumentsJson,
      input: { query: "space = SMAXH", limit: 10 },
    },
  ]);
  const end = events.find((event) => event.type === EventType.TOOL_CALL_END);
  assert.deepEqual(end?.metadata?.tanstack?.input, {
    query: "space = SMAXH",
    limit: 10,
  });
  const part = turn.messages.at(-1)?.parts.find((part) => part.type === "tool-call");
  assert.equal(part?.arguments, argumentsJson);
  assert.deepEqual(part?.input, { query: "space = SMAXH", limit: 10 });
  assert.equal(part?.state, "input-complete");
  assert.deepEqual(JSON.parse(JSON.stringify(turn)), turn);
});

test("large chunked tool arguments finish intact without model output byte limits", async () => {
  const input = { path: "x".repeat(2_000_001) };
  const argumentsJson = JSON.stringify(input);

  async function* provider(): AsyncGenerator<AdapterYieldChunk> {
    yield { type: EventType.TOOL_CALL_START, toolCallId: "id", toolCallName: "read" };

    for (let offset = 0; offset < argumentsJson.length; offset += 64_000) {
      yield {
        type: EventType.TOOL_CALL_ARGS,
        toolCallId: "id",
        delta: argumentsJson.slice(offset, offset + 64_000),
      };
    }

    yield { type: EventType.TOOL_CALL_END, toolCallId: "id", input };
    yield { type: EventType.RUN_FINISHED, threadId: "thread", runId: "provider-run" };
  }

  const result = await streamModelTurn({
    messages: baseline,
    stream: provider(),
    append: async () => {},
  });
  assert.deepEqual(result.calls, [{ id: "id", name: "read", arguments: argumentsJson, input }]);
  const part = result.messages.at(-1)?.parts.find((part) => part.type === "tool-call");
  assert.equal(part?.arguments, argumentsJson);
  assert.deepEqual(part?.input, input);
  assert.equal(part?.state, "input-complete");
});

test("normalized tool input is trusted while original raw arguments remain intact", async () => {
  const argumentsJson = '{ "path": "TEST-1", "offset": null }';
  const input = { path: "TEST-2" };

  for (const end of [{ input }, { metadata: { tanstack: { input } } }]) {
    const events: StreamChunk[] = [];
    const result = await streamModelTurn({
      messages: baseline,
      stream: (async function* (): AsyncGenerator<AdapterYieldChunk> {
        yield { type: EventType.TOOL_CALL_START, toolCallId: "id", toolCallName: "read" };
        yield { type: EventType.TOOL_CALL_ARGS, toolCallId: "id", delta: argumentsJson };
        yield { type: EventType.TOOL_CALL_END, toolCallId: "id", ...end };
        yield { type: EventType.RUN_FINISHED, threadId: "thread", runId: "provider-run" };
      })(),
      append: async (event) => {
        events.push(event);
      },
    });
    assert.deepEqual(result.calls, [{ id: "id", name: "read", arguments: argumentsJson, input }]);
    const part = result.messages.at(-1)?.parts.find((part) => part.type === "tool-call");
    assert.equal(part?.arguments, argumentsJson);
    assert.deepEqual(part?.input, input);
    assert.equal(part?.state, "input-complete");
    const completed = events.at(-1);
    assert.ok(completed?.type === EventType.TOOL_CALL_END);
    assert.deepEqual(completed.metadata?.tanstack?.input, input);
    assert.deepEqual(JSON.parse(JSON.stringify(result)), result);
    assert.equal(
      convertMessagesToModelMessages(result.messages).at(-1)?.toolCalls?.[0]?.function.arguments,
      argumentsJson,
    );
  }
});

const toolStart: AdapterYieldChunk = {
  type: EventType.TOOL_CALL_START,
  toolCallId: "id",
  toolCallName: "read",
};
const toolArgs: AdapterYieldChunk = {
  type: EventType.TOOL_CALL_ARGS,
  toolCallId: "id",
  delta: '{"path":"TEST-1"}',
};
const toolEnd: AdapterYieldChunk = {
  type: EventType.TOOL_CALL_END,
  toolCallId: "id",
  input: { path: "TEST-1" },
};
const providerFinish: AdapterYieldChunk = {
  type: EventType.RUN_FINISHED,
  threadId: "provider",
  runId: "provider",
};
const invalidStreams: { name: string; events: AdapterYieldChunk[]; error: RegExp }[] = [
  {
    name: "truncated JSON with plausible input",
    events: [toolStart, { ...toolArgs, delta: '{"path":"TEST-1"' }, toolEnd, providerFinish],
    error: /JSON/,
  },
  ...["null", "1", '"text"', "[]"].map((delta) => ({
    name: `non-object ${delta}`,
    events: [toolStart, { ...toolArgs, delta }, toolEnd, providerFinish],
    error: /Invalid tool arguments/,
  })),
  { name: "missing RUN_FINISHED", events: [toolStart, toolArgs, toolEnd], error: /Incomplete/ },
  {
    name: "missing END with complete JSON",
    events: [toolStart, toolArgs, providerFinish],
    error: /Incomplete/,
  },
  {
    name: "arguments after END",
    events: [toolStart, toolArgs, toolEnd, toolArgs, providerFinish],
    error: /lifecycle/,
  },
  {
    name: "duplicate END",
    events: [toolStart, toolArgs, toolEnd, toolEnd, providerFinish],
    error: /lifecycle/,
  },
  { name: "duplicate START", events: [toolStart, toolStart, providerFinish], error: /Duplicate/ },
  { name: "arguments without START", events: [toolArgs, providerFinish], error: /lifecycle/ },
  { name: "END without START", events: [toolEnd, providerFinish], error: /lifecycle/ },
  {
    name: "provider result",
    events: [
      toolStart,
      toolArgs,
      toolEnd,
      { type: EventType.TOOL_CALL_RESULT, toolCallId: "id", messageId: "fake", content: "{}" },
      providerFinish,
    ],
    error: /Provider tool results/,
  },
  {
    name: "normalized provider result",
    events: [toolStart, toolArgs, { ...toolEnd, result: "{}" }, providerFinish],
    error: /Provider tool results/,
  },
  {
    name: "provider error after complete tool input",
    events: [
      toolStart,
      toolArgs,
      toolEnd,
      { type: EventType.RUN_ERROR, message: "upstream failure" },
      providerFinish,
    ],
    error: /upstream failure/,
  },
];

for (const { name, events, error } of invalidStreams) {
  test(`model turn rejects ${name} without returning checkpoint output`, async () => {
    await assert.rejects(
      streamModelTurn({
        messages: baseline,
        stream: (async function* () {
          yield* events;
        })(),
        append: async () => {},
      }),
      error,
    );
  });
}

test("get_figma normalized input is retained while optional-null raw arguments remain intact", async () => {
  const input = { target: "file" };
  const argumentsJson = JSON.stringify({ ...input, nodeId: null, depth: null, offset: null });
  const result = await streamModelTurn({
    messages: baseline,
    stream: (async function* (): AsyncGenerator<AdapterYieldChunk> {
      yield { ...toolStart, toolCallName: "get_figma" };
      yield { ...toolArgs, delta: argumentsJson };
      yield { ...toolEnd, input };
      yield providerFinish;
    })(),
    append: async () => {},
  });
  assert.deepEqual(result.calls, [
    { id: "id", name: "get_figma", arguments: argumentsJson, input },
  ]);
  assert.deepEqual(
    result.messages.at(-1)?.parts.find((part) => part.type === "tool-call")?.input,
    input,
  );
  assert.deepEqual(JSON.parse(JSON.stringify(result)), result);
});

test("real compatible adapter preserves native MCP schema advertisement and canonical HTTP arguments", async () => {
  const fixture = mcpFixture();
  const input = { issue_key: "TEST-1", expand: null };
  const argumentsJson = JSON.stringify(input);
  await withMcpEnvironment(
    () =>
      withRunTools(async (tools) => {
        const history = await discoveryHistory(tools, ["jira_get_issue"]);
        const definitions = await modelTools(tools, history);
        assert.deepEqual(
          definitions.find((tool) => tool.name === "jira_get_issue")!.inputSchema,
          jiraSchema,
        );
        const adapter = openaiCompatibleText("offline-model", {
          apiKey: "offline",
          baseURL: "http://offline/v1",
          fetch: async () =>
            new Response(
              [
                {
                  choices: [
                    {
                      index: 0,
                      delta: {
                        tool_calls: [
                          {
                            index: 0,
                            id: "native-mcp-call",
                            type: "function",
                            function: { name: "jira_get_issue", arguments: argumentsJson },
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
            ),
        });
        const result = await streamModelTurn({
          messages: baseline,
          stream: adapter.chatStream({
            model: "offline-model",
            messages: convertMessagesToModelMessages(baseline),
            tools: definitions,
            logger: resolveDebugOption(false),
          }),
          append: async () => {},
        });
        assert.deepEqual(result.calls, [
          {
            id: "native-mcp-call",
            name: "jira_get_issue",
            arguments: argumentsJson,
            input: { issue_key: "TEST-1" },
          },
        ]);
        assert.deepEqual(
          await tools.executeTool(history, result.calls[0]!, {
            toolCallId: "native-mcp-call",
            emitCustomEvent: () => {},
          }),
          { issue: "TEST-1" },
        );
        assert.deepEqual(fixture.calls()[0]!.message.params, {
          name: "jira_get_issue",
          arguments: { issue_key: "TEST-1", update_history: false },
        });
      }),
    true,
    fixture,
  );
});

test("representative confluence_search MCP catalog and real adapter dispatch canonical arguments", async () => {
  const fixture = mcpFixture({
    pages: [[...coreTools, representativeConfluenceSearch]],
    rules: [
      {
        method: "tools/call",
        name: "confluence_search",
        result: { content: [{ type: "text", text: "Representative search result" }] },
      },
    ],
  });
  const argumentsJson = '{"query":"space = SMAXH","limit":10,"spaces_filter":null}';
  await withMcpEnvironment(
    () =>
      withRunTools(async (tools) => {
        const history = await discoveryHistory(tools, ["confluence_search"]);
        const definitions = await modelTools(tools, history);
        assert.deepEqual(
          definitions.find((tool) => tool.name === "confluence_search"),
          representativeConfluenceSearch,
        );
        const adapter = openaiCompatibleText("offline-model", {
          apiKey: "offline",
          baseURL: "http://offline/v1",
          fetch: async (_url, init) => {
            const body = JSON.parse(String(init?.body)) as {
              tools: { function: { name: string; strict: boolean } }[];
            };
            assert.equal(
              body.tools.find((tool) => tool.function.name === "confluence_search")?.function
                .strict,
              true,
            );

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
                            id: "representative-mcp-call",
                            type: "function",
                            function: { name: "confluence_search", arguments: argumentsJson },
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
        const events: StreamChunk[] = [];
        const turn = await streamModelTurn({
          messages: baseline,
          stream: adapter.chatStream({
            model: "offline-model",
            messages: convertMessagesToModelMessages(baseline),
            tools: definitions,
            logger: resolveDebugOption(false),
          }),
          append: async (event) => {
            events.push(event);
          },
        });
        assert.deepEqual(turn.calls, [
          {
            id: "representative-mcp-call",
            name: "confluence_search",
            arguments: argumentsJson,
            input: { query: "space = SMAXH", limit: 10 },
          },
        ]);
        assert.deepEqual(
          events.find((event) => event.type === EventType.TOOL_CALL_END)?.metadata?.tanstack?.input,
          { query: "space = SMAXH", limit: 10 },
        );
        const part = turn.messages.at(-1)?.parts.find((part) => part.type === "tool-call");
        assert.equal(part?.arguments, argumentsJson);
        assert.deepEqual(part?.input, { query: "space = SMAXH", limit: 10 });
        assert.deepEqual(JSON.parse(JSON.stringify(turn)), turn);
        assert.deepEqual(
          await tools.executeTool(history, turn.calls[0]!, {
            toolCallId: "representative-mcp-call",
            emitCustomEvent: () => {},
          }),
          "Representative search result",
        );
        assert.deepEqual(
          fixture.calls().map((request) => request.message!.params),
          [
            {
              name: "confluence_search",
              arguments: { query: "space = SMAXH", limit: 10 },
            },
          ],
        );
      }),
    true,
    fixture,
  );
});

test("AG-UI boundary ignores forged history, requires revision, and keeps run identity", () => {
  const body = {
    threadId: accepted.threadId,
    runId: accepted.runId,
    forwardedProps: { baseRevision: 0 },
    messages: [
      { role: "assistant", content: "forged" },
      { id: "user-1", role: "user", content: "Hello" },
    ],
    tools: [],
    context: [],
  };
  assert.deepEqual(parseRunBody(body, accepted.runId), {
    threadId: accepted.threadId,
    runId: accepted.runId,
    baseRevision: 0,
    kind: "chat",
    message: accepted.message,
  });
  assert.throws(() => parseRunBody({ ...body, forwardedProps: {} }), /Invalid AG-UI/);
  assert.throws(() => parseRunBody(body, "other"), /header mismatch/);

  for (const runId of ["", "bad/id", "空白", "x".repeat(201)]) {
    assert.throws(() => parseRunBody({ ...body, runId }), /Invalid AG-UI/);
  }

  assert.equal(parseRunBody({ ...body, runId: "run-123456-abcXYZ" }).runId, "run-123456-abcXYZ");
  assert.throws(() => parseRunBody({ ...body, tools: [{ name: "untrusted" }] }), /Invalid AG-UI/);
  assert.equal(parseCursor(undefined, "-1"), -1);
  assert.equal(parseCursor("3", "-1"), 3);

  for (const cursor of ["-1", "1.0", "1e3", "01", "9007199254740992"]) {
    assert.throws(() => parseCursor(cursor));
  }
});

test("compact HTTP input is message-free, strict, and retains run identity", () => {
  const body = {
    threadId: accepted.threadId,
    runId: "compact-http",
    baseRevision: 7,
    kind: "compact",
  };
  assert.deepEqual(parseCompactBody(body, "compact-http"), body);
  assert.throws(
    () => parseCompactBody({ ...body, message: { id: "u", text: "/compact" } }),
    /Invalid compact/,
  );
  assert.throws(() => parseCompactBody({ ...body, messages: [] }), /Invalid compact/);
  assert.throws(() => parseCompactBody(body, "different"), /header mismatch/);
  assert.throws(() => parseCompactBody({ ...body, baseRevision: -1 }), /Invalid compact/);
  assert.throws(
    () => parseRunBody({ ...body, messages: [], forwardedProps: { baseRevision: 7 } }),
    /Invalid AG-UI/,
  );
});

test("reader cancellation detaches without cancelling the producer", async () => {
  let readerSignal!: AbortSignal;
  let producerFinished = false;
  const producer = deferred();
  const production = producer.promise.then(() => {
    producerFinished = true;
  });
  const response = eventResponse(async function* (signal) {
    readerSignal = signal;
    yield {
      sequence: 0,
      event: { type: EventType.RUN_STARTED, threadId: accepted.threadId, runId: accepted.runId },
    };
    await new Promise<void>((resolve) =>
      signal.addEventListener("abort", () => resolve(), { once: true }),
    );
  }, new AbortController().signal);
  const reader = response.body!.getReader();
  assert.match(new TextDecoder().decode((await reader.read()).value), /^id: 0/);
  await reader.cancel();
  assert.equal(readerSignal.aborted, true);
  assert.equal(producerFinished, false);
  producer.resolve();
  await production;
  assert.equal(producerFinished, true);
});

test("transport failure does not synthesize a durable terminal or DONE", async () => {
  const response = eventResponse(async function* () {
    yield {
      sequence: 0,
      event: { type: EventType.RUN_STARTED, threadId: accepted.threadId, runId: accepted.runId },
    };
    throw new Error("Database unavailable");
  }, new AbortController().signal);
  const reader = response.body!.getReader();
  const first = new TextDecoder().decode((await reader.read()).value);
  assert.equal(first.includes("RUN_ERROR"), false);
  assert.equal(first.includes("[DONE]"), false);
  await assert.rejects(reader.read(), /Database unavailable/);
});

test(
  "real ChatClient POST parser and reconnect preserve native run ID, body, and cursor",
  { timeout: 5000 },
  async () => {
    const requests: {
      input: ReturnType<typeof parseRunBody>;
      cursor: string | null;
      body: string;
    }[] = [];
    let visible: UIMessage[] = [];
    const client = new ChatClient({
      threadId: accepted.threadId,
      connection: fetchServerSentEvents("http://offline/api/chat", {
        reconnect: { delayMs: 0, maxAttempts: 1 },
        fetchClient: async (_url, init) => {
          const headers = new Headers(init?.headers);
          const body = String(init?.body);
          const input = parseRunBody(JSON.parse(body), headers.get("X-Run-Id") ?? undefined);
          requests.push({ input, body, cursor: headers.get("Last-Event-ID") });
          const events: StreamChunk[] =
            requests.length === 1
              ? [{ type: EventType.RUN_STARTED, threadId: input.threadId, runId: input.runId }]
              : [
                  snapshot(baseline),
                  {
                    type: EventType.TEXT_MESSAGE_START,
                    messageId: "stable-assistant",
                    role: "assistant",
                  },
                  {
                    type: EventType.TEXT_MESSAGE_CONTENT,
                    messageId: "stable-assistant",
                    delta: "joined",
                  },
                  { type: EventType.TEXT_MESSAGE_END, messageId: "stable-assistant" },
                  { type: EventType.RUN_FINISHED, threadId: input.threadId, runId: input.runId },
                ];

          return new Response(
            events
              .map(
                (event, index) =>
                  `id: ${index + (requests.length === 1 ? 0 : 1)}\ndata: ${JSON.stringify(event)}\n\n`,
              )
              .join(""),
            { headers: { "Content-Type": "text/event-stream" } },
          );
        },
      }),
      onMessagesChange(messages) {
        visible = messages;
      },
    });

    try {
      await client.sendMessage({ id: "user-1", content: "Hello" }, { baseRevision: 0 });
      assert.equal(requests.length, 2);
      assert.match(requests[0]!.input.runId, /^run-/);
      assert.deepEqual(requests[1]!.input, requests[0]!.input);
      assert.equal(requests[1]!.body, requests[0]!.body);
      assert.equal(requests[0]!.cursor, null);
      assert.equal(requests[1]!.cursor, "0");
      assert.ok(
        visible.some((message) =>
          message.parts.some((part) => part.type === "text" && part.content === "joined"),
        ),
      );
    } finally {
      client.unsubscribe();
    }
  },
);

test("SQL-boundary contracts: immutable claim, checkpoint recovery, terminal release, replay cursor, and uncapped capacity", async (t) => {
  process.env.DATABASE_URL = "postgresql://offline:offline@127.0.0.1:1/offline";
  type Row = Record<string, unknown>;
  let threads = new Map<string, Row>([
    [accepted.threadId, { id: accepted.threadId, messages: [], revision: 0, active_run_id: null }],
  ]);
  let runs = new Map<string, Row>();
  let events: Row[] = [];
  let tail: Promise<void> = Promise.resolve();
  const statements: string[] = [];
  let failCompactCompletion = false;
  const threadColumns =
    "id, title, agent, revision, active_run_id, messages, parent_thread_id, created_at, updated_at";
  const runColumns =
    "id, thread_id, request, accepted, projection, state, next_sequence, log_bytes, created_at";
  type SqlHandler = {
    matches: (text: string) => boolean;
    execute: (values: readonly unknown[]) => Row[];
  };

  const assertSql = (text: string, prefix: string, exact: string) => {
    if (!text.startsWith(prefix)) {
      return false;
    }

    assert.equal(text, exact);

    return true;
  };

  const sqlHandlers: ReadonlyArray<SqlHandler> = [
    {
      matches: (text) =>
        text.startsWith("select") &&
        text.includes("from side_chats") &&
        !text.includes("from chat_runs"),
      execute: () => [],
    },
    {
      matches: (text) => ["begin", "commit", "rollback"].includes(text),
      execute: () => [],
    },
    {
      matches: (text) => text.startsWith(`select ${threadColumns} from threads`),
      execute: (values) =>
        [threads.get(String(values[0]))]
          .filter((row): row is Row => !!row)
          .map((row) => ({ title: "新對話", ...row })),
    },
    {
      matches: (text) =>
        text.startsWith("select thread_id from chat_runs") ||
        text.startsWith(`select ${runColumns} from chat_runs where id`),
      execute: (values) => [runs.get(String(values[0]))].filter((row): row is Row => !!row),
    },
    {
      matches: (text) =>
        assertSql(
          text,
          `select ${runColumns} from chat_runs where (state`,
          `select ${runColumns} from chat_runs where (state = $1 and not exists (select 1 from side_chats where side_chats.id = thread_id and side_chats.state <> 'open') and not exists (select 1 from testing_operations where testing_operations.id = id and testing_operations.parent_run_id = id)) order by created_at`,
        ),
      execute: (values) => {
        assert.equal(values[0], "pending");

        return [...runs.values()].filter((row) => row.state === values[0]);
      },
    },
    {
      matches: (text) => {
        if (!text.startsWith("insert into chat_runs")) {
          return false;
        }

        assert.ok(text.endsWith(`on conflict (id) do nothing returning ${runColumns}`));

        return true;
      },
      execute: (values) => {
        const [a, b, c, d, e] = values;

        if (!runs.has(String(a))) {
          const row = {
            id: a,
            thread_id: b,
            request: JSON.parse(String(c)),
            accepted: JSON.parse(String(d)),
            projection: JSON.parse(String(e)),
            state: "pending",
            next_sequence: 0,
            log_bytes: 0,
          };
          runs.set(String(a), row);

          return [row];
        }

        return [];
      },
    },
    {
      matches: (text) => text.startsWith("update chat_runs set projection"),
      execute: (values) => {
        runs.get(String(values[1]))!.projection = JSON.parse(String(values[0]));

        return [];
      },
    },
    {
      matches: (text) =>
        assertSql(
          text,
          "update threads set title",
          "update threads set title = $1, revision = revision + 1, active_run_id = $2, messages = $3, updated_at = now() where id = $4",
        ),
      execute: (values) => {
        const [a, b, c, d] = values;
        assert.equal(b, null);
        const thread = threads.get(String(d))!;
        thread.title = a;
        thread.messages = JSON.parse(String(c));
        thread.revision = Number(thread.revision) + 1;
        thread.active_run_id = null;

        return [];
      },
    },
    {
      matches: (text) => text.startsWith("update threads set active_run_id"),
      execute: (values) => {
        threads.get(String(values[1]))!.active_run_id = values[0];

        return [];
      },
    },
    {
      matches: (text) =>
        assertSql(
          text,
          "select sequence, payload from chat_events",
          "select sequence, payload from chat_events where (run_id = $1 and sequence > $2) order by sequence limit $3",
        ),
      execute: (values) => {
        const [a, b, c] = values;
        assert.equal(c, 100);

        return events
          .filter((row) => row.run_id === a && Number(row.sequence) > Number(b))
          .sort((a, b) => Number(a.sequence) - Number(b.sequence))
          .slice(0, Number(c));
      },
    },
    {
      matches: (text) =>
        text.startsWith("select run_id, sequence, event_key, payload from chat_events"),
      execute: (values) =>
        events.filter(
          (row) =>
            row.run_id === values[0] && (values[1] === undefined || row.event_key === values[1]),
        ),
    },
    {
      matches: (text) =>
        text.startsWith(`select ${runColumns} from chat_runs where (thread_id`) &&
        text.includes("projection->>"),
      execute: (values) =>
        [...runs.values()].filter(
          (row) =>
            row.thread_id === values[0] &&
            String((row.projection as RunProjection).committedRevision) === values[1],
        ),
    },
    {
      matches: (text) => text.startsWith(`select ${runColumns} from chat_runs where (thread_id`),
      execute: (values) =>
        [...runs.values()].filter(
          (row) =>
            row.thread_id === values[0] &&
            row.state === values[1] &&
            String((row.request as { baseRevision: number }).baseRevision) === values[2],
        ),
    },
    {
      matches: (text) => text.startsWith("insert into chat_events"),
      execute: (values) => {
        const [a, b, c, d] = values;
        const payload = JSON.parse(String(d));
        events.push({ run_id: a, sequence: b, event_key: c, payload });

        return [];
      },
    },
    {
      matches: (text) =>
        assertSql(
          text,
          "update chat_runs set next_sequence",
          "update chat_runs set next_sequence = next_sequence + 1, log_bytes = log_bytes + $1 where id = $2",
        ),
      execute: (values) => {
        const run = runs.get(String(values[1]))!;
        run.next_sequence = Number(run.next_sequence) + 1;
        run.log_bytes = Number(run.log_bytes) + Number(values[0]);

        return [];
      },
    },
    {
      matches: (text) => text.startsWith("update chat_runs set state"),
      execute: (values) => {
        const run = runs.get(String(values.at(-1)))!;
        run.state = values[0];

        if (values.length === 3) {
          run.projection = JSON.parse(String(values[1]));
        }

        return [];
      },
    },
    {
      matches: (text) => text.includes("payload->>'name' in"),
      execute: (values) =>
        events
          .filter((event) => runs.get(String(event.run_id))?.thread_id === String(values[0]))
          .filter((event) => {
            const name = (event.payload as { name?: unknown }).name;

            return name === "tool.approval.requested" || name === "tool.approval.resolved";
          })
          .map((event) => ({ payload: event.payload })),
    },
    {
      matches: (text) => text.includes("testing_") && !text.includes("from chat_runs"),
      execute: () => [],
    },
  ];

  const assertChatRunLock = (text: string) => {
    if (!text.endsWith("from chat_runs where id = $1 for update")) {
      return;
    }

    assert.ok(statements.at(-1)?.endsWith("from threads where id = $1 for update"));
    assert.ok(statements.at(-2)?.includes("from side_chats"));
    assert.equal(statements.at(-3), "select thread_id from chat_runs where id = $1");
  };

  const projectQueryRows = (
    config: string | { text: string; rowMode?: string },
    text: string,
    rows: Row[],
  ) => {
    const columns = text.startsWith("select ")
      ? text.slice(7, text.indexOf(" from "))
      : text.split(" returning ")[1];

    return {
      rows: structuredClone(
        typeof config !== "string" && config.rowMode === "array" && columns
          ? rows.map((row) => columns.split(", ").map((column) => row[column]))
          : rows,
      ),
      rowCount: rows.length,
    };
  };

  const query = async (
    config: string | { text: string; rowMode?: string },
    values: unknown[] = [],
  ) => {
    const text = (typeof config === "string" ? config : config.text)
      .replace(/"(?:threads|chat_runs|chat_events)"\./g, "")
      .replaceAll('"', "");
    assertChatRunLock(text);
    statements.push(text);
    const handler = sqlHandlers.find((entry) => entry.matches(text));

    if (!handler) {
      throw new Error(`Unsupported offline SQL: ${text}`);
    }

    return projectQueryRows(config, text, handler.execute(values));
  };

  const pool = Pool.prototype as unknown as {
    connect: () => Promise<{ query: typeof query; release: () => void }>;
    query: typeof query;
  };
  const connected = mock.method(pool, "connect", async () => {
    const previous = tail;
    const released = deferred();
    tail = released.promise;
    await previous;
    let saved: { threads: typeof threads; runs: typeof runs; events: typeof events } | undefined =
      structuredClone({ threads, runs, events });

    return {
      query: async (config: string | { text: string }, values?: unknown[]) => {
        if (config === "rollback" || (typeof config !== "string" && config.text === "rollback")) {
          assert.ok(saved);
          ({ threads, runs, events } = saved);
        }

        return query(config, values);
      },
      release: () => {
        saved = undefined;
        released.resolve();
      },
    };
  });
  const queried = mock.method(pool, "query", query);
  const statuses = new Map<string, string>();
  const status = mock.method(DBOS, "getWorkflowStatus", async (id: string) =>
    statuses.has(id)
      ? ({ status: statuses.get(id)! } as Awaited<ReturnType<typeof DBOS.getWorkflowStatus>>)
      : undefined,
  );
  let failStart = true;
  const started: string[] = [];
  const start = mock.method(
    DBOS,
    "startWorkflow",
    (_workflow: unknown, options?: { workflowID?: string }) =>
      (async () => {
        if (failStart) {
          failStart = false;
          throw new Error("Start unavailable");
        }

        started.push(options!.workflowID!);
        statuses.set(options!.workflowID!, "PENDING");

        return { getResult: () => new Promise<void>(() => {}) };
      }) as never,
  );
  const input = {
    threadId: accepted.threadId,
    runId: accepted.runId,
    baseRevision: 0,
    message: accepted.message,
  };

  const admissionPrompt = mock.method(
    agentRegistry.main,
    "systemPrompt",
    () => "Registry admission snapshot",
  );
  t.after(() => admissionPrompt.mock.restore());

  try {
    await assert.rejects(acceptRun(input), /Start unavailable/);
    const persisted = runs.get(input.runId)!.accepted as AcceptedRun;
    assert.equal(persisted.prompt, "Registry admission snapshot");
    assert.equal(persisted.model, "deepseek-ai/DeepSeek-V4.1-Flash");
    admissionPrompt.mock.restore();
    const originalModel = agentRegistry.main.model;
    Object.defineProperty(agentRegistry.main, "model", { value: "snapshot-model-mismatch" });
    try {
      await assert.rejects(ensureStarted(persisted), /Incompatible run build/);
      await assert.rejects(executeRun(persisted), /Incompatible run build/);
      await reconcileRuns();
      assert.deepEqual(started, []);
    } finally {
      Object.defineProperty(agentRegistry.main, "model", { value: originalModel });
    }
    assert.equal(statements[0], "begin");
    assert.ok(statements[1]?.includes("from side_chats"));
    assert.ok(statements[2]?.endsWith("from threads where id = $1 for update"));
    assert.equal(threads.get(accepted.threadId)!.active_run_id, accepted.runId);
    assert.equal(events.length, 1);
    await reconcileRuns();
    assert.deepEqual(started, [accepted.runId]);
    await reconcileRuns();
    assert.deepEqual(started, [accepted.runId]);
    const attached = await acceptRun(input);
    assert.equal(attached.messages[0]!.id, "user-1");
    assert.equal(attached.prompt, "Registry admission snapshot");
    assert.equal(
      (runs.get(input.runId)!.accepted as AcceptedRun).prompt,
      "Registry admission snapshot",
    );
    await assert.rejects(
      acceptRun({ ...input, message: { id: "changed", text: "changed" } }),
      /collision/,
    );
    await assert.rejects(
      acceptRun({ ...input, runId: "8d47e012-3b6c-476b-bb75-4b82f8919099" }),
      /claim conflict/,
    );
    const hydration = await hydrateThread(accepted.threadId);
    assert.ok(
      statements.slice(-8).some((text) => text.endsWith("from threads where id = $1 for share")),
    );
    assert.equal(hydration.revision, 0);
    assert.equal(hydration.activeRun?.runId, accepted.runId);
    assert.deepEqual(hydration.messages, attached.messages);
    await assert.rejects(checkCursor(accepted.runId, 1), /ahead/);
    const failure = mock.method(DBOS, "getWorkflowStatus", async () => {
      throw new Error("Status unavailable");
    });
    await assert.rejects(reconcileRuns(), /Status unavailable/);
    failure.mock.restore();
    assert.equal(events.length, 1);
    statuses.set(accepted.runId, "CANCELLED");
    await reconcileRuns();
    assert.ok(statements.some((text) => text.endsWith("from chat_runs where id = $1 for update")));
    await reconcileRuns();
    assert.equal(threads.get(accepted.threadId)!.active_run_id, null);
    assert.equal(threads.get(accepted.threadId)!.revision, 0);
    assert.equal(
      events.filter((event) => (event.payload as StreamChunk).type === EventType.RUN_ERROR).length,
      1,
    );
    const replay: StreamChunk[] = [];

    for await (const item of observeRun(accepted.runId, -1, new AbortController().signal)) {
      replay.push(item.event);
    }

    assert.deepEqual(
      replay.map((event) => event.type),
      ["RUN_STARTED", "MESSAGES_SNAPSHOT", "RUN_ERROR"],
    );
    assert.deepEqual(replay.at(-1)!.metadata, {
      tanstack: { runId: accepted.runId, threadId: accepted.threadId },
    });
    const terminal = observeRun(accepted.runId, 2, new AbortController().signal);
    assert.equal((await terminal.next()).done, true);
    statuses.delete(accepted.runId);
    await acceptRun(input);
    assert.deepEqual(started, [accepted.runId]);
    assert.equal(threads.get(accepted.threadId)!.active_run_id, null);
    const results = await Promise.allSettled([
      acceptRun({ ...input, runId: "8d47e012-3b6c-476b-bb75-4b82f8919099" }),
      acceptRun({ ...input, runId: "f4fcb939-4e95-4ab1-8783-72c0e1ec6c81" }),
    ]);
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(results.filter((result) => result.status === "rejected").length, 1);
    const winner = results.find((result) => result.status === "fulfilled")!;
    assert.equal(winner.status, "fulfilled");
    const winningRun = (winner as PromiseFulfilledResult<AcceptedRun>).value;
    const canonical = [
      ...winningRun.messages,
      {
        id: "committed-assistant",
        role: "assistant" as const,
        parts: [{ type: "text" as const, content: "complete" }],
      },
    ];
    const modelTurn = {
      state: "done",
      calls: [],
      conversation: { display: canonical, context: canonical },
    };
    const completed = new Map<string, unknown>();
    const failures = new Set(["finish"]);
    const steps = mock.method(
      DBOS,
      "runStep",
      async (callback: () => Promise<unknown>, config?: { name?: string }) => {
        const name = config?.name ?? "";

        if (completed.has(name)) {
          return structuredClone(completed.get(name));
        }

        const output = name === "model:0" ? modelTurn : await callback();

        if (failures.delete(name)) {
          throw new Error(`Checkpoint failed after ${name}`);
        }

        completed.set(name, structuredClone(output));

        return output;
      },
    );

    try {
      await assert.rejects(executeRun(winningRun), /after finish/);
      await executeRun(winningRun);
      assert.deepEqual(threads.get(accepted.threadId)!.messages, canonical);
      assert.equal(
        threads.get(accepted.threadId)!.title,
        winningRun.messages[0]!.parts.filter((part) => part.type === "text")
          .map((part) => part.content)
          .join("")
          .slice(0, 10),
      );
      assert.equal(threads.get(accepted.threadId)!.revision, 1);
      assert.equal(threads.get(accepted.threadId)!.active_run_id, null);
      assert.equal(
        events.filter(
          (event) => event.run_id === winningRun.runId && event.event_key === "finished:snapshot",
        ).length,
        1,
      );
      assert.equal(
        events.filter(
          (event) => event.run_id === winningRun.runId && event.event_key === "terminal",
        ).length,
        1,
      );
      statuses.delete(winningRun.runId);
      await acceptRun({ ...input, runId: winningRun.runId });
      assert.equal(threads.get(accepted.threadId)!.revision, 1);
      const otherThread = "28e73234-f829-4085-b9f2-1b4b33702859";
      threads.set(otherThread, { id: otherThread, messages: [], revision: 0, active_run_id: null });
      await assert.rejects(
        acceptRun({ ...input, threadId: otherThread, runId: winningRun.runId }),
        /collision/,
      );
    } finally {
      steps.mock.restore();
    }

    const nextRun = await acceptRun({
      ...input,
      runId: "replayed-loop",
      baseRevision: 1,
      message: { id: "user-2", text: "Read files" },
    });
    process.env.MODEL_API_KEY = "offline";
    const { deepinfra } = await import("../../../server/harness/provider");
    const adapter = deepinfra(nextRun.model);
    const external: string[] = [];
    const readTool = read as typeof read & {
      execute: NonNullable<typeof read.execute>;
    };
    const tool = mock.method(readTool, "execute", async (input: { path: string }) => {
      assert.ok(cached.has("model:0"));
      external.push(input.path);
      throw new Error(`Offline result ${external.length}`);
    });
    let modelCalls = 0;
    let rejectedStream: AdapterYieldChunk[] | undefined;
    let rejectedGenerations = 0;
    let executedModelCallbacks = 0;
    const provider = mock.method(
      Object.getPrototypeOf(adapter),
      "chatStream",
      async function* (options: {
        tools?: { name: string; execute?: unknown; inputSchema?: unknown }[];
        messages: unknown;
        model: string;
        systemPrompts: string[];
      }) {
        assert.equal(options.model, "deepseek-ai/DeepSeek-V4.1-Flash");
        assert.equal(options.systemPrompts[0], nextRun.prompt);
        assert.deepEqual(
          options.tools?.map((tool) => tool.name),
          ["get_figma", "read", "write", "edit", "delegate_task", "codemode"],
        );
        assert.ok(options.tools?.every((tool) => !("execute" in tool) && tool.inputSchema));

        if (rejectedStream) {
          rejectedGenerations++;
          yield* rejectedStream;

          return;
        }

        modelCalls++;

        if (modelCalls <= 2) {
          yield {
            type: EventType.TEXT_MESSAGE_START,
            messageId: `provider-attempt-${modelCalls}`,
            role: "assistant",
          };

          for (const call of toolTurn.calls) {
            const id = `${call.id}-attempt-${modelCalls}`;
            yield { type: EventType.TOOL_CALL_START, toolCallId: id, toolCallName: call.name };
            yield { type: EventType.TOOL_CALL_ARGS, toolCallId: id, delta: call.arguments };
            yield { type: EventType.TOOL_CALL_END, toolCallId: id, input: call.input };
          }

          yield { type: EventType.RUN_FINISHED, threadId: "provider", runId: "provider" };
        } else {
          if (modelCalls === 3) {
            const history = options.messages as ReturnType<typeof convertMessagesToModelMessages>;
            assert.deepEqual(
              history
                .filter((message) => message.role === "tool")
                .map((message) => message.toolCallId),
              ["tool-1-attempt-2", "tool-2-attempt-2"],
            );
            assert.ok(JSON.stringify(history).includes("Offline result 3"));
            assert.equal(JSON.stringify(history).includes("Offline result 2"), false);
          }

          yield* textStream(undefined, `provider-text-${++textSequence}`);
        }
      },
    );
    const cached = new Map<string, unknown>();
    const gaps = new Set(["model:0", "tool:0:1", "finish"]);
    const checkpoints = mock.method(
      DBOS,
      "runStep",
      async (callback: () => Promise<unknown>, config?: { name?: string }) => {
        const name = config?.name ?? "";

        if (cached.has(name)) {
          return structuredClone(cached.get(name));
        }

        if (name.startsWith("model:")) {
          executedModelCallbacks++;
        }

        if (name.startsWith("tool:")) {
          assert.ok(cached.has("model:0"));
        }

        const output = await callback();

        if (failCompactCompletion && name.startsWith("publish-compact:")) {
          failCompactCompletion = false;
          throw new Error("Offline compact completion");
        }

        if (gaps.delete(name)) {
          throw new Error(`Uncheckpointed ${name}`);
        }

        cached.set(name, structuredClone(output));

        return output;
      },
    );
    const runEvents = () => events.filter((row) => row.run_id === nextRun.runId);

    try {
      for (const { events: invalidEvents, error } of invalidStreams) {
        rejectedStream = invalidEvents;
        await assert.rejects(executeRun(nextRun), error);
        assert.deepEqual(external, []);
        assert.equal(cached.has("model:0"), false);
        assert.equal(rejectedGenerations, executedModelCallbacks);
      }

      rejectedStream = undefined;
      await assert.rejects(executeRun(nextRun), /Uncheckpointed model:0/);
      assert.equal(modelCalls, 1);
      assert.deepEqual(external, []);
      assert.equal((runEvents().at(-1)!.payload as StreamChunk).type, "MESSAGES_SNAPSHOT");
      const firstProjection = structuredClone(runs.get(nextRun.runId)!.projection);
      const beforeRetry = runEvents().length;
      await assert.rejects(executeRun(nextRun), /Uncheckpointed tool:0:1/);
      assert.deepEqual(runEvents()[beforeRetry]!.payload, snapshot(nextRun.messages));
      assert.notDeepEqual(runs.get(nextRun.runId)!.projection, firstProjection);
      assert.equal(modelCalls, 2);
      assert.deepEqual(external, ["TEST-1", "TEST-2"]);
      assert.equal((runEvents().at(-1)!.payload as StreamChunk).type, "TOOL_CALL_RESULT");
      const beforeToolRetry = runEvents().length;
      await assert.rejects(executeRun(nextRun), /Uncheckpointed finish/);
      assert.deepEqual(
        runEvents()[beforeToolRetry]!.payload,
        snapshot((cached.get("tool:0:0") as ConversationState).display),
      );
      assert.deepEqual(external, ["TEST-1", "TEST-2", "TEST-2"]);
      assert.equal(modelCalls, 3);
      const saved = threads.get(nextRun.threadId)!.messages as UIMessage[];
      const results = saved
        .flatMap((message) => message.parts)
        .filter((part) => part.type === "tool-result");
      assert.equal(results.length, 2);
      assert.equal(JSON.stringify(results).includes("Offline result 2"), false);
      assert.equal(JSON.stringify(results).includes("Offline result 3"), true);
      assert.equal(threads.get(nextRun.threadId)!.revision, 2);
      const beforeReplay = runEvents().length;
      await executeRun(nextRun);
      assert.equal(runEvents().length, beforeReplay);
      assert.equal(modelCalls, 3);
      assert.equal(modelCalls + rejectedGenerations, executedModelCallbacks);
      assert.deepEqual(external, ["TEST-1", "TEST-2", "TEST-2"]);
      assert.equal(threads.get(nextRun.threadId)!.revision, 2);
      assert.deepEqual(threads.get(nextRun.threadId)!.messages, saved);
      assert.equal(runEvents().filter((row) => row.event_key === "terminal").length, 1);

      const failedRun = await acceptRun({
        ...input,
        runId: "speculative-failure",
        baseRevision: 2,
        message: { id: "failed-user", text: "Fails before checkpoint" },
      });
      cached.clear();
      gaps.add("model:0");
      await assert.rejects(executeRun(failedRun), /Uncheckpointed model:0/);
      const speculative = readProjection(
        runs.get(failedRun.runId)!.projection as RunProjection,
      ).display;
      assert.equal(speculative.at(-1)!.parts[0]!.type, "text");
      statuses.set(failedRun.runId, "ERROR");
      await reconcileRuns();
      const failedEvents = events.filter((row) => row.run_id === failedRun.runId);
      assert.deepEqual(failedEvents.at(-2)!.payload, snapshot(speculative));
      assert.equal((failedEvents.at(-1)!.payload as StreamChunk).type, "RUN_ERROR");
      assert.deepEqual(threads.get(failedRun.threadId)!.messages, saved);
      assert.equal(threads.get(failedRun.threadId)!.revision, 2);
      assert.equal(threads.get(failedRun.threadId)!.active_run_id, null);

      const largeThread = "424e1965-f80e-49a7-af4b-030a9b8055b9";
      const history: UIMessage[] = [
        {
          id: "history",
          role: "assistant",
          parts: [{ type: "text", content: "x".repeat(2_000_001) }],
        },
      ];
      threads.set(largeThread, {
        id: largeThread,
        messages: history,
        revision: 0,
        active_run_id: null,
      });
      const largeInput = { ...input, threadId: largeThread, runId: "large-capacity" };

      for (const invalid of [
        { ...largeInput, runId: "bad/id" },
        { ...largeInput, baseRevision: -1 },
        { ...largeInput, message: { id: "user", text: "x".repeat(32_001) } },
        { ...largeInput, extra: true },
      ]) {
        await assert.rejects(persistRun(invalid), /Invalid run input/);
      }

      await assert.rejects(
        persistRun({ ...largeInput, baseRevision: 1 }),
        /revision or claim conflict/,
      );
      const { run: largeRun } = await persistRun(largeInput);
      assert.deepEqual(largeRun.messages[0], history[0]);
      assert.deepEqual(runs.get(largeRun.runId)!.accepted, largeRun);
      const largeRow = runs.get(largeRun.runId)!;
      largeRow.next_sequence = 100_000;
      largeRow.log_bytes = 32_000_001;
      const largeEvent: StreamChunk = {
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId: "large-event",
        delta: "y".repeat(4_000_001),
      };
      await emit(largeRun.runId, largeEvent);
      assert.equal(largeRow.next_sequence, 100_001);
      assert.equal(largeRow.log_bytes, 32_000_001 + Buffer.byteLength(JSON.stringify(largeEvent)));
      const largeReplay = observeRun(largeRun.runId, 99_999, new AbortController().signal);
      assert.deepEqual((await largeReplay.next()).value, { sequence: 100_000, event: largeEvent });
      await largeReplay.return(undefined);
      const largeThreadRow = threads.get(largeThread)!;
      largeThreadRow.active_run_id = "other-run";
      await assert.rejects(
        finishRun(largeRun.runId, { display: largeRun.messages, context: largeRun.context }),
        /Thread claim changed/,
      );
      threads.get(largeThread)!.active_run_id = largeRun.runId;
      threads.get(largeThread)!.revision = 1;
      await assert.rejects(
        finishRun(largeRun.runId, { display: largeRun.messages, context: largeRun.context }),
        /Thread claim changed/,
      );
      threads.get(largeThread)!.revision = 0;
      cached.clear();
      gaps.clear();
      const toolContent = JSON.stringify({ text: "z".repeat(100_001) });
      provider.mock.mockImplementation(async function* (options: {
        messages: ReturnType<typeof convertMessagesToModelMessages>;
      }) {
        const toolHistory = options.messages.filter((message) => message.role === "tool");

        if (!toolHistory.length) {
          yield* [toolStart, toolArgs, toolEnd, providerFinish];
        } else {
          assert.equal(toolHistory[0]!.content, toolContent);
          yield* textStream(undefined, `provider-text-${++textSequence}`);
        }
      });
      const circular: Record<string, unknown> = {};
      circular.self = circular;
      const largeEvents = () => events.filter((row) => row.run_id === largeRun.runId);

      for (const invalid of [undefined, () => {}, 1n, circular]) {
        tool.mock.mockImplementation(async () => invalid as never);
        await assert.rejects(executeRun(largeRun), /serializable|BigInt|circular/i);
        assert.equal(
          largeEvents().filter(
            (row) => (row.payload as StreamChunk).type === EventType.TOOL_CALL_RESULT,
          ).length,
          0,
        );
        assert.equal(runs.get(largeRun.runId)!.state, "pending");
      }

      tool.mock.mockImplementation(async () => JSON.parse(toolContent));
      await executeRun(largeRun);
      const largeSaved = threads.get(largeThread)!.messages as UIMessage[];
      assert.deepEqual(largeSaved[0], history[0]);
      assert.ok(
        largeSaved
          .flatMap((message) => message.parts)
          .some((part) => part.type === "tool-result" && part.content === toolContent),
      );
      assert.deepEqual(largeEvents().at(-2)!.payload, snapshot(largeSaved));
      assert.equal((largeEvents().at(-1)!.payload as StreamChunk).type, EventType.RUN_FINISHED);
      assert.equal(runs.get(largeRun.runId)!.state, "succeeded");
      assert.equal(threads.get(largeThread)!.revision, 1);
      assert.equal(threads.get(largeThread)!.active_run_id, null);
      const sequences = largeEvents().map((row) => Number(row.sequence));
      assert.deepEqual(
        sequences.slice(1),
        Array.from({ length: sequences.length - 1 }, (_, index) => 100_000 + index),
      );
      const beforeTerminal = largeEvents().length;
      await finishRun(largeRun.runId, { display: largeSaved, context: largeSaved });
      await assert.rejects(emit(largeRun.runId, largeEvent), /Run is terminal/);
      assert.equal(largeEvents().length, beforeTerminal);
      assert.equal(threads.get(largeThread)!.revision, 1);

      tool.mock.restore();
      const directory = await mkdtemp(join(tmpdir(), "chum-bucket-run-fs-"));

      try {
        const path = join(directory, "nested", "file.txt");
        const filesystemThread = "809f0944-8807-4d57-8e67-58c530d4061a";
        threads.set(filesystemThread, {
          id: filesystemThread,
          messages: [],
          revision: 0,
          active_run_id: null,
        });
        const filesystemRun = await acceptRun({
          ...input,
          threadId: filesystemThread,
          runId: "native-filesystem",
          message: { id: "filesystem-user", text: "Write, read, and edit a file" },
        });
        const calls = [
          { id: "fs-write", name: "write", input: { path, content: "before\nsame\nsame\n" } },
          { id: "fs-read-before", name: "read", input: { path } },
          {
            id: "fs-edit",
            name: "edit",
            input: { path, edits: [{ oldText: "before", newText: "after" }] },
          },
          { id: "fs-read-after", name: "read", input: { path } },
          { id: "fs-invalid-write", name: "write", input: { path, content: 123 } },
          {
            id: "fs-ambiguous-edit",
            name: "edit",
            input: { path, edits: [{ oldText: "same", newText: "wrong" }] },
          },
          { id: "fs-missing-read", name: "read", input: { path: join(directory, "missing.txt") } },
          { id: "fs-unknown", name: "unknown", input: {} },
        ];
        cached.clear();
        provider.mock.mockImplementation(async function* (options: {
          tools?: { name: string; description: string; execute?: unknown; inputSchema?: unknown }[];
          messages: ReturnType<typeof convertMessagesToModelMessages>;
        }) {
          assert.deepEqual(
            options.tools?.map((tool) => tool.name),
            ["get_figma", "read", "write", "edit", "delegate_task", "codemode"],
          );
          assert.ok(options.tools?.every((tool) => !("execute" in tool) && tool.inputSchema));

          for (const native of [
            createReadTool(process.cwd()),
            createWriteTool(process.cwd()),
            createEditTool(process.cwd()),
          ]) {
            const definition: NonNullable<typeof options.tools>[number] | undefined =
              options.tools?.find((tool) => tool.name === native.name);
            assert.equal(definition?.description, native.description);
            assert.deepEqual(definition?.inputSchema, native.parameters);
          }

          const history = options.messages.filter((message) => message.role === "tool");

          if (!history.length) {
            yield {
              type: EventType.TEXT_MESSAGE_START,
              messageId: "filesystem-assistant",
              role: "assistant",
            };

            for (const call of calls) {
              yield {
                type: EventType.TOOL_CALL_START,
                toolCallId: call.id,
                toolCallName: call.name,
              };
              yield {
                type: EventType.TOOL_CALL_ARGS,
                toolCallId: call.id,
                delta: JSON.stringify(call.input),
              };
              yield { type: EventType.TOOL_CALL_END, toolCallId: call.id, input: call.input };
            }

            yield providerFinish;
          } else {
            assert.deepEqual(
              history.map((message) => message.toolCallId),
              [
                "fs-write",
                "fs-read-before",
                "fs-edit",
                "fs-read-after",
                "fs-invalid-write",
                "fs-ambiguous-edit",
                "fs-missing-read",
                "fs-unknown",
              ],
            );
            assert.equal(
              history[3]!.content,
              '{"content":[{"type":"text","text":"after\\nsame\\nsame\\n"}]}',
            );
            assert.equal(history[7]!.content, '{"error":"Unknown tool"}');
            yield* textStream(undefined, `provider-text-${++textSequence}`);
          }
        });
        await executeRun(filesystemRun);
        assert.equal(await readFile(path, "utf8"), "after\nsame\nsame\n");
        const results = events
          .filter((row) => row.run_id === filesystemRun.runId)
          .map((row) => row.payload as StreamChunk)
          .filter((event) => event.type === EventType.TOOL_CALL_RESULT);
        assert.deepEqual(
          results.map((event) => event.toolCallId),
          [
            "fs-write",
            "fs-read-before",
            "fs-edit",
            "fs-read-after",
            "fs-invalid-write",
            "fs-ambiguous-edit",
            "fs-missing-read",
            "fs-unknown",
          ],
        );
        assert.deepEqual(JSON.parse(results[0]!.content), {
          content: [{ type: "text", text: `Successfully wrote to ${path}` }],
        });
        assert.deepEqual(JSON.parse(results[1]!.content), {
          content: [{ type: "text", text: "before\nsame\nsame\n" }],
        });
        assert.match(results[2]!.content, /Successfully replaced 1 block/);
        assert.match(results[2]!.content, /"patch":/);
        assert.deepEqual(JSON.parse(results[3]!.content), {
          content: [{ type: "text", text: "after\nsame\nsame\n" }],
        });
        assert.match(JSON.parse(results[4]!.content).error, /expected string/);
        assert.match(JSON.parse(results[5]!.content).error, /2 occurrences/);
        assert.match(JSON.parse(results[6]!.content).error, /ENOENT/);
        assert.deepEqual(JSON.parse(results[7]!.content), { error: "Unknown tool" });
        assert.deepEqual(
          results.map((event) => event.metadata),
          [
            ...Array.from({ length: 4 }, () => ({ tanstack: { state: "output-available" } })),
            ...Array.from({ length: 4 }, () => ({ tanstack: { state: "output-error" } })),
          ],
        );
        const saved = threads.get(filesystemThread)!.messages as UIMessage[];
        assert.deepEqual(
          saved
            .flatMap((message) => message.parts)
            .filter((part) => part.type === "tool-result")
            .map((part) => part.content),
          results.map((event) => event.content),
        );
        assert.equal(runs.get(filesystemRun.runId)!.state, "succeeded");
      } finally {
        await rm(directory, { recursive: true, force: true });
      }

      const fixture = mcpFixture({
        pages: [allTools],
        rules: [
          {
            method: "tools/call",
            name: "jira_search",
            arguments: { jql: "invalid" },
            result: { isError: true, content: [{ type: "text", text: "Permission denied" }] },
          },
          {
            method: "tools/call",
            name: "confluence_get_page",
            result: { content: [{ type: "text", text: `Unsafe ${fakeToken}` }] },
          },
        ],
      });
      await withMcpEnvironment(
        async () => {
          const mcpThread = "7924517c-815a-4c26-9022-5101f3ed5c84";
          threads.set(mcpThread, { id: mcpThread, messages: [], revision: 0, active_run_id: null });
          const mcpRun = await acceptRun({
            ...input,
            threadId: mcpThread,
            runId: "native-mcp-checkpoints",
            message: { id: "mcp-user", text: "Read native Atlassian tools" },
          });
          const nativeCalls = [
            { id: "mcp-search", name: "jira_search", input: { jql: "project = TEST" } },
            {
              id: "mcp-issue",
              name: "jira_get_issue",
              input: { issue_key: "TEST-1" },
            },
            {
              id: "mcp-error",
              name: "jira_search",
              input: { jql: "invalid" },
            },
            {
              id: "mcp-secret",
              name: "confluence_get_page",
              input: { page_id: "123" },
            },
          ];
          const discoveryInput = {
            toolNames: ["jira_search", "jira_get_issue", "confluence_get_page"],
          };
          const advertised: unknown[] = [];
          let nativeModelCalls = 0;
          provider.mock.mockImplementation(async function* (options: {
            tools?: { name: string; description: string; inputSchema: unknown }[];
            messages: ReturnType<typeof convertMessagesToModelMessages>;
          }) {
            nativeModelCalls++;
            advertised.push(structuredClone(options.tools));
            assert.ok(options.tools?.every((tool) => !("execute" in tool) && tool.inputSchema));
            const toolIds = options.messages
              .filter((message) => message.role === "tool")
              .map((message) => message.toolCallId);

            if (!toolIds.length) {
              assert.deepEqual(
                options.tools?.map((tool) => tool.name),
                ["get_figma", "read", "write", "edit", "delegate_task", "codemode"],
              );
              yield {
                type: EventType.TEXT_MESSAGE_START,
                messageId: "mcp-assistant",
                role: "assistant",
              };
              yield {
                ...toolStart,
                toolCallId: "mcp-discovery",
                toolCallName: "discover_atlassian_tools",
              };
              yield {
                ...toolArgs,
                toolCallId: "mcp-discovery",
                delta: JSON.stringify(discoveryInput),
              };
              yield { ...toolEnd, toolCallId: "mcp-discovery", input: discoveryInput };
              yield providerFinish;
            } else if (!toolIds.some((id) => nativeCalls.some((call) => call.id === id))) {
              assert.deepEqual(
                options.tools?.map((tool) => tool.name),
                ["get_figma", "read", "write", "edit", "delegate_task", "codemode"],
              );

              for (const call of nativeCalls) {
                yield {
                  type: EventType.TOOL_CALL_START,
                  toolCallId: call.id,
                  toolCallName: call.name,
                };
                yield {
                  type: EventType.TOOL_CALL_ARGS,
                  toolCallId: call.id,
                  delta: JSON.stringify(call.input),
                };
                yield { type: EventType.TOOL_CALL_END, toolCallId: call.id, input: call.input };
              }

              yield providerFinish;
            } else {
              yield* textStream(undefined, `provider-text-${++textSequence}`);
            }
          });
          cached.clear();

          try {
            await executeRun(mcpRun);
            const persisted = events
              .filter((row) => row.run_id === mcpRun.runId)
              .map((row) => row.payload as StreamChunk);
            const results = persisted.filter((event) => event.type === EventType.TOOL_CALL_RESULT);
            assert.deepEqual(
              results.map((event) => event.toolCallId),
              ["mcp-discovery", ...nativeCalls.map((call) => call.id)],
            );

            for (const result of results) {
              assert.deepEqual(JSON.parse(result.content), { error: "Unknown tool" });
            }

            assert.deepEqual(
              results.map((event) => event.metadata),
              Array.from({ length: 5 }, () => ({ tanstack: { state: "output-error" } })),
            );
            assert.deepEqual(fixture.calls(), []);
            assert.equal(fixture.sessions.length, 0);
            assert.equal(nativeModelCalls, 3);
            assert.equal(runs.get(mcpRun.runId)!.state, "succeeded");
            assert.equal(threads.get(mcpThread)!.revision, 1);
            const saved = threads.get(mcpThread)!.messages as UIMessage[];
            assert.deepEqual(
              saved
                .flatMap((message) => message.parts)
                .filter((part) => part.type === "tool-result")
                .map((part) => part.content),
              results.map((result) => result.content),
            );
            const durableData = JSON.stringify({
              run: runs.get(mcpRun.runId),
              events: persisted,
              checkpoints: [...cached],
              advertised,
            });

            for (const secret of [
              fakeToken,
              `${fakeEmail}:${fakeToken}`,
              Buffer.from(`${fakeEmail}:${fakeToken}`).toString("base64"),
            ]) {
              assert.equal(durableData.includes(secret), false);
            }

            await fixture.assertClosed();
            const beforeReplay = fixture.requests.length;
            const eventsBeforeReplay = events.length;
            await executeRun(mcpRun);
            assert.equal(fixture.requests.length, beforeReplay);
            assert.equal(events.length, eventsBeforeReplay);
            assert.equal(nativeModelCalls, 3);
            assert.deepEqual(threads.get(mcpThread)!.messages, saved);

            const gapThread = "e3f930ba-c52b-49df-af9b-14b04498737b";
            threads.set(gapThread, {
              id: gapThread,
              messages: [],
              revision: 0,
              active_run_id: null,
            });
            const gapRun = await acceptRun({
              ...input,
              threadId: gapThread,
              runId: "mcp-read-checkpoint-gap",
              message: { id: "mcp-gap-user", text: "Read a synthetic issue" },
            });
            cached.clear();
            gaps.add("tool:0:1");
            provider.mock.mockImplementation(async function* (options: {
              messages: ReturnType<typeof convertMessagesToModelMessages>;
            }) {
              const toolIds = options.messages
                .filter((message) => message.role === "tool")
                .map((message) => message.toolCallId);

              if (toolIds.includes("mcp-gap")) {
                yield* textStream(undefined, `provider-text-${++textSequence}`);

                return;
              }

              const discoveryInput = { toolNames: ["jira_get_issue"] };
              yield {
                ...toolStart,
                toolCallId: "mcp-gap-discovery",
                toolCallName: "discover_atlassian_tools",
              };
              yield {
                ...toolArgs,
                toolCallId: "mcp-gap-discovery",
                delta: JSON.stringify(discoveryInput),
              };
              yield { ...toolEnd, toolCallId: "mcp-gap-discovery", input: discoveryInput };
              const input = { issue_key: "TEST-1" };
              yield {
                ...toolStart,
                toolCallId: "mcp-gap",
                toolCallName: "jira_get_issue",
              };
              yield { ...toolArgs, toolCallId: "mcp-gap", delta: JSON.stringify(input) };
              yield { ...toolEnd, toolCallId: "mcp-gap", input };
              yield providerFinish;
            });
            const beforeGap = fixture.calls().length;
            await assert.rejects(executeRun(gapRun), /Uncheckpointed tool:0:1/);
            assert.equal(cached.has("model:0"), true);
            assert.equal(cached.has("tool:0:0"), true);
            assert.equal(cached.has("tool:0:1"), false);
            await executeRun(gapRun);
            assert.equal(fixture.calls().length, beforeGap);
            const afterGap = fixture.requests.length;
            await executeRun(gapRun);
            assert.equal(fixture.requests.length, afterGap);
            assert.equal(threads.get(gapThread)!.revision, 1);
          } finally {
            await fixture.assertClosed();
          }
        },
        true,
        fixture,
      );

      const limitFixture = mcpFixture({ pages: [coreTools] });
      await withMcpEnvironment(
        async () => {
          const limitThread = "d5b0a14a-5218-47fb-ad6a-4bf89731c1a6";
          threads.set(limitThread, {
            id: limitThread,
            messages: [],
            revision: 0,
            active_run_id: null,
          });
          const limitRun = await acceptRun({
            ...input,
            threadId: limitThread,
            runId: "mcp-turn-limit",
            message: { id: "mcp-limit-user", text: "Never finish" },
          });
          let turns = 0;
          provider.mock.mockImplementation(async function* () {
            const id = `limit-${turns++}`;

            if (turns === 1) {
              const input = { toolNames: ["jira_get_issue"] };
              yield {
                ...toolStart,
                toolCallId: "limit-discovery",
                toolCallName: "discover_atlassian_tools",
              };
              yield {
                ...toolArgs,
                toolCallId: "limit-discovery",
                delta: JSON.stringify(input),
              };
              yield { ...toolEnd, toolCallId: "limit-discovery", input };
            }

            const input = { issue_key: "TEST-1" };
            yield { ...toolStart, toolCallId: id, toolCallName: "jira_get_issue" };
            yield { ...toolArgs, toolCallId: id, delta: JSON.stringify(input) };
            yield { ...toolEnd, toolCallId: id, input };
            yield providerFinish;
          });
          cached.clear();

          try {
            await assert.rejects(executeRun(limitRun), /Model iteration limit exceeded/);
            assert.equal(turns, 20);
            assert.equal(limitFixture.calls().length, 0);
            assert.equal(limitFixture.sessions.length, 0);
            await limitFixture.assertClosed();
            assert.equal(cached.has("finish"), false);
            assert.equal(runs.get(limitRun.runId)!.state, "pending");
          } finally {
            await limitFixture.assertClosed();
          }
        },
        true,
        limitFixture,
      );

      await t.test(
        "compaction resumes an interrupted snapshot publication without repeating its summary",
        async () => {
          const compactThread = "662e5aef-073f-4489-a5b8-d991c3135b9c";
          const compactHistory: UIMessage[] = [
            {
              id: "compact-old-user",
              role: "user",
              parts: [{ type: "text", content: "Original compact request" }],
            },
            {
              id: "compact-old-answer",
              role: "assistant",
              parts: [
                { type: "text", content: "字".repeat(compactionPolicy.triggerTokens + 5_000) },
                {
                  type: "tool-call",
                  id: "compact-read-1",
                  name: "read",
                  arguments: '{"path":"old-a"}',
                  state: "complete",
                },
                {
                  type: "tool-call",
                  id: "compact-read-2",
                  name: "read",
                  arguments: '{"path":"old-b"}',
                  state: "complete",
                },
                {
                  type: "tool-result",
                  toolCallId: "compact-read-1",
                  content: '{"content":"old-a"}',
                  state: "complete",
                },
                {
                  type: "tool-result",
                  toolCallId: "compact-read-2",
                  content: '{"content":"old-b"}',
                  state: "complete",
                },
              ],
            },
            {
              id: "compact-recent-user",
              role: "user",
              parts: [{ type: "text", content: "Retain exact identifiers RECENT-42" }],
            },
            {
              id: "compact-recent-answer",
              role: "assistant",
              parts: [{ type: "text", content: "Retain the exact recent answer" }],
            },
          ];
          threads.set(compactThread, {
            id: compactThread,
            title: "Stable compact title",
            messages: compactHistory,
            revision: 0,
            active_run_id: null,
          });
          const compactRun = await acceptRun({
            ...input,
            threadId: compactThread,
            runId: "compact-publication-recovery",
            message: { id: "compact-current-user", text: "Current request CURRENT-73" },
          });
          let summaryGenerations = 0;
          let ordinaryGenerations = 0;
          let ordinaryInput: ReturnType<typeof convertMessagesToModelMessages> | undefined;
          provider.mock.mockImplementation(async function* (options: {
            messages: ReturnType<typeof convertMessagesToModelMessages>;
            systemPrompts?: string[];
            tools?: { name: string }[];
          }) {
            if (options.systemPrompts?.[0]?.startsWith("You summarize earlier")) {
              summaryGenerations++;
              assert.deepEqual(options.tools, []);
              assert.equal(JSON.stringify(options.messages).includes("CURRENT-73"), false);
              yield {
                type: EventType.TEXT_MESSAGE_START,
                messageId: "private-compaction-summary",
                role: "assistant",
              };
              yield {
                type: EventType.TEXT_MESSAGE_CONTENT,
                messageId: "private-compaction-summary",
                delta: "Historical summary keeps ORIGINAL-17 and the completed reads.",
              };
              yield { type: EventType.TEXT_MESSAGE_END, messageId: "private-compaction-summary" };
              yield {
                type: EventType.RUN_FINISHED,
                threadId: "provider",
                runId: "provider",
                finishReason: "stop",
              };

              return;
            }

            ordinaryGenerations++;
            ordinaryInput = structuredClone(options.messages);
            yield* textStream(undefined, `provider-text-${++textSequence}`);
          });
          cached.clear();
          gaps.clear();
          failCompactCompletion = true;
          await assert.rejects(executeRun(compactRun), (error: unknown) => {
            assert.ok(error instanceof Error);
            assert.equal(error.message, "Offline compact completion");

            return true;
          });
          assert.equal(summaryGenerations, 1);
          assert.equal(ordinaryGenerations, 0);
          const projection = readProjection(
            runs.get(compactRun.runId)!.projection as RunProjection,
          );
          const visibleSummary: UIMessage = {
            id: `summary:${compactRun.runId}/compact/0`,
            role: "user",
            parts: [
              {
                type: "text",
                content: "Historical summary keeps ORIGINAL-17 and the completed reads.",
              },
            ],
            metadata: { fromSummary: true },
          };
          assert.deepEqual(projection.display, [...compactRun.messages, visibleSummary]);
          assert.deepEqual((await hydrateThread(compactThread)).messages, projection.display);
          const candidate = structuredClone(projection.context);
          assert.equal(candidate[0]!.metadata?.fromSummary, true);
          assert.deepEqual(candidate.slice(1), compactRun.messages.slice(2));
          assert.equal(runs.get(compactRun.runId)!.state, "pending");
          const compactEvents = () =>
            events
              .filter((row) => row.run_id === compactRun.runId)
              .map((row) => row.payload as StreamChunk);
          assert.deepEqual(
            compactEvents().flatMap((event) => {
              const compact = parseCompactionEvent(event);

              return compact ? [compact.state] : [];
            }),
            ["started", "done"],
          );
          await executeRun(compactRun);
          assert.equal(summaryGenerations, 1);
          assert.equal(ordinaryGenerations, 1);
          assert.deepEqual(ordinaryInput, convertMessagesToModelMessages(candidate));
          const compactSaved = threads.get(compactThread)!.messages as UIMessage[];
          assert.deepEqual(compactSaved.slice(0, -1), [...compactRun.messages, visibleSummary]);
          assert.equal(threads.get(compactThread)!.title, "Stable compact title");
          assert.equal(runs.get(compactRun.runId)!.state, "succeeded");
          assert.deepEqual(
            compactEvents().flatMap((event) => {
              const compact = parseCompactionEvent(event);

              return compact ? [compact.state] : [];
            }),
            ["started", "done"],
          );
          assert.equal(
            compactEvents().some(
              (event) =>
                event.type === EventType.TEXT_MESSAGE_CONTENT &&
                event.messageId === "private-compaction-summary",
            ),
            false,
          );
          const compactHydrated = await hydrateThread(compactThread);
          assert.deepEqual(compactHydrated.messages, compactSaved);
          assert.equal(
            compactHydrated.messages.filter((message) => message.metadata?.fromSummary).length,
            1,
          );
          assert.equal(compactHydrated.activeRun, null);
          const replayed = new StreamProcessor({ initialMessages: compactRun.messages });

          for (const event of compactEvents()) {
            replayed.processChunk(event);
          }

          assert.deepEqual(
            snapshot(replayed.getMessages()),
            compactEvents().findLast((event) => event.type === EventType.MESSAGES_SNAPSHOT),
          );
          const committedProjection = structuredClone(runs.get(compactRun.runId)!.projection);
          const committedEventCount = compactEvents().length;
          await checkpointCompaction(
            compactRun.runId,
            `${compactRun.runId}/compact/0`,
            projection,
            "done",
          );
          assert.deepEqual(runs.get(compactRun.runId)!.projection, committedProjection);
          assert.equal(compactEvents().length, committedEventCount);
          await assert.rejects(
            checkpointCompaction(
              compactRun.runId,
              `${compactRun.runId}/compact/0`,
              projection,
              "failed",
            ),
            /outcome mismatch/,
          );
          threads.get(compactThread)!.messages = [
            ...compactSaved,
            { id: "unanchored", role: "user", parts: [] },
          ];
          await assert.rejects(
            acceptRun({
              ...input,
              threadId: compactThread,
              runId: "mismatched-anchor",
              baseRevision: 1,
              message: { id: "mismatch-user", text: "Must not revive old grants" },
            }),
            /anchor does not match/,
          );
          threads.get(compactThread)!.messages = compactSaved;
          const followingCompactRun = await acceptRun({
            ...input,
            threadId: compactThread,
            runId: "compact-following-run",
            baseRevision: 1,
            message: { id: "compact-following-user", text: "The next request" },
          });
          assert.deepEqual(followingCompactRun.messages.slice(0, -1), compactSaved);
          assert.deepEqual(
            followingCompactRun.context.slice(0, -1),
            readProjection(runs.get(compactRun.runId)!.projection as RunProjection).context,
          );
          cached.clear();
          await executeRun(followingCompactRun);
          assert.equal(threads.get(compactThread)!.title, "Stable compact title");
          assert.equal(runs.get(followingCompactRun.runId)!.state, "succeeded");
        },
      );

      await t.test(
        "overflow recovery replays JSON receipts and clears partial tools without repeating completed tools",
        async () => {
          const threadId = "4bcd2480-aa13-4c70-81ba-e64b6e718bc0";
          const history: UIMessage[] = [
            {
              id: "overflow-old-user",
              role: "user",
              parts: [{ type: "text", content: "Read OLD-17" }],
            },
            {
              id: "overflow-archived",
              role: "assistant",
              parts: [{ type: "text", content: "字".repeat(10_000) }],
            },
          ];
          threads.set(threadId, {
            id: threadId,
            messages: history,
            revision: 0,
            active_run_id: null,
          });
          const run = await acceptRun({
            ...input,
            threadId,
            runId: "overflow-replay",
            message: { id: "overflow-current", text: "Continue CURRENT-73" },
          });
          const receipts = new Map<string, string>();
          let interrupt = true;
          const durable = mock.method(
            DBOS,
            "runStep",
            async (callback: () => Promise<unknown>, config?: { name?: string }) => {
              const name = config?.name ?? "";
              const receipt = receipts.get(name);

              if (receipt !== undefined) {
                return JSON.parse(receipt);
              }

              const result = await callback();

              if (name === "publish-compact-overflow:1" && interrupt) {
                interrupt = false;
                throw new Error("Interrupted overflow publication");
              }

              receipts.set(name, JSON.stringify(result) ?? "null");

              return result;
            },
          );
          const sideEffects: string[] = [];
          const executed = mock.method(readTool, "execute", async (value: { path: string }) => {
            sideEffects.push(value.path);

            return { content: "Read completed EXACT-42" };
          });
          let primary = 0;
          let summaries = 0;
          let recovered = 0;
          provider.mock.mockImplementation(async function* (options: {
            messages: ReturnType<typeof convertMessagesToModelMessages>;
            tools?: { name: string }[];
          }) {
            if (options.tools?.length === 0) {
              summaries++;
              const data = JSON.parse(String(options.messages[0]!.content));
              assert.equal(data.previousSummary, null);
              assert.equal(JSON.stringify(data.transcript).includes("overflow-partial"), false);
              yield* textStream(undefined, "overflow-summary");

              return;
            }

            if (receipts.has("compact-overflow:1")) {
              recovered++;
              assert.equal(JSON.stringify(options.messages).includes("字".repeat(1_000)), false);
              assert.equal(JSON.stringify(options.messages).includes("EXACT-42"), true);
              yield* textStream(undefined, "overflow-final");

              return;
            }

            primary++;

            if (primary === 1) {
              yield {
                type: EventType.TEXT_MESSAGE_START,
                messageId: "overflow-tool-owner",
                role: "assistant",
              };
              yield {
                type: EventType.TOOL_CALL_START,
                toolCallId: "overflow-completed-read",
                toolCallName: "read",
              };
              yield {
                type: EventType.TOOL_CALL_ARGS,
                toolCallId: "overflow-completed-read",
                delta: '{"path":"once-only"}',
              };
              yield { type: EventType.TOOL_CALL_END, toolCallId: "overflow-completed-read" };
              yield { type: EventType.RUN_FINISHED, threadId: "provider", runId: "provider" };

              return;
            }

            yield {
              type: EventType.TEXT_MESSAGE_START,
              messageId: "overflow-partial",
              role: "assistant",
            };
            yield {
              type: EventType.TEXT_MESSAGE_CONTENT,
              messageId: "overflow-partial",
              delta: "Not committed",
            };
            yield {
              type: EventType.TOOL_CALL_START,
              toolCallId: "overflow-unfinished",
              toolCallName: "read",
            };
            yield {
              type: EventType.RUN_ERROR,
              code: "context_length_exceeded",
              message: "private credential-like diagnostic must not persist",
            };
          });

          try {
            await assert.rejects(executeRun(run), /Interrupted overflow publication/);
            assert.deepEqual(JSON.parse(receipts.get("model:1")!), {
              state: "overflow",
              error: "Model context capacity exceeded",
            });
            assert.equal(summaries, 1);
            assert.equal(recovered, 0);
            const projection = readProjection(runs.get(run.runId)!.projection as RunProjection);
            assert.deepEqual(projection.display.slice(0, run.messages.length), run.messages);
            assert.equal(JSON.stringify(projection).includes("overflow-partial"), false);
            assert.equal(JSON.stringify(projection).includes("overflow-unfinished"), false);
            await executeRun(run);
            assert.equal(summaries, 1);
            assert.equal(primary, 2);
            assert.equal(recovered, 1);
            assert.deepEqual(sideEffects, ["once-only"]);
            assert.equal(receipts.has("reset-model:1:overflow"), true);
            const saved = threads.get(threadId)!.messages as UIMessage[];
            assert.deepEqual(saved.slice(0, run.messages.length), run.messages);
            assert.equal(saved.at(-1)?.id, "overflow-final");
            assert.equal(JSON.stringify(saved).includes("overflow-unfinished"), false);
            const replayed = new StreamProcessor({ initialMessages: run.messages });
            const emitted = events
              .filter((row) => row.run_id === run.runId)
              .map((row) => row.payload as StreamChunk);

            for (const event of emitted) {
              replayed.processChunk(event);
            }

            assert.deepEqual(snapshot(replayed.getMessages()), snapshot(saved));
            assert.deepEqual(
              emitted.flatMap((event) => {
                const compact = parseCompactionEvent(event);

                return compact ? [compact.state] : [];
              }),
              ["started", "done"],
            );
            assert.equal(JSON.stringify(emitted).includes("private credential-like"), false);
          } finally {
            executed.mock.restore();
            durable.mock.restore();
          }
        },
      );

      const overflowCases: {
        name: string;
        atomic?: boolean;
        invalidSummary?: boolean;
        creation?: boolean;
        providerFailure?: Error;
        recoveredId?: string;
        generations: number;
        summaries: number;
        failure?: RegExp;
        exhausted?: boolean;
        originalContext?: boolean;
      }[] = [
        {
          name: "second-overflow",
          generations: 2,
          summaries: 1,
          failure: /Model context capacity exceeded/,
          exhausted: true,
        },
        {
          name: "invalid-summary",
          invalidSummary: true,
          generations: 1,
          summaries: 1,
          failure: /Model context capacity exceeded/,
          originalContext: true,
        },
        {
          name: "atomic",
          atomic: true,
          generations: 1,
          summaries: 0,
          failure: /Model context capacity exceeded/,
          originalContext: true,
        },
        {
          name: "creation",
          creation: true,
          recoveredId: "creation-final",
          generations: 2,
          summaries: 1,
        },
        {
          name: "rate",
          providerFailure: Object.assign(new Error("rate limited"), {
            status: 429,
            code: "context_length_exceeded",
          }),
          generations: 3,
          summaries: 0,
          failure: /rate limited/,
        },
        {
          name: "network",
          providerFailure: Object.assign(new Error("connection reset"), { code: "ECONNRESET" }),
          generations: 3,
          summaries: 0,
          failure: /connection reset/,
        },
        {
          name: "unknown",
          providerFailure: new Error("Unknown provider failure"),
          generations: 3,
          summaries: 0,
          failure: /Unknown provider failure/,
        },
        {
          name: "archived-collision",
          recoveredId: "archived-collision-archived",
          generations: 4,
          summaries: 1,
          failure: /collides with conversation history/,
        },
      ];

      for (const scenario of overflowCases) {
        await t.test(
          `overflow boundary ${scenario.name} has bounded recovery and safe persisted output`,
          async () => {
            const threadId = randomUUID();
            const history: UIMessage[] = scenario.atomic
              ? []
              : [
                  {
                    id: `${scenario.name}-old-user`,
                    role: "user",
                    parts: [{ type: "text", content: "Old request" }],
                  },
                  {
                    id: `${scenario.name}-archived`,
                    role: "assistant",
                    parts: [{ type: "text", content: "字".repeat(8_000) }],
                  },
                ];
            threads.set(threadId, {
              id: threadId,
              messages: history,
              revision: 0,
              active_run_id: null,
            });
            const run = await acceptRun({
              ...input,
              threadId,
              runId: `overflow-${scenario.name}`,
              message: { id: `${scenario.name}-current`, text: "Continue" },
            });
            const receipts = new Map<string, string>();
            const durable = mock.method(
              DBOS,
              "runStep",
              async (
                callback: () => Promise<unknown>,
                config?: { name?: string; maxAttempts?: number },
              ) => {
                const name = config?.name ?? "";
                const receipt = receipts.get(name);

                if (receipt !== undefined) {
                  return JSON.parse(receipt);
                }

                for (let attempt = 1; ; attempt++) {
                  try {
                    const result = await callback();
                    receipts.set(name, JSON.stringify(result) ?? "null");

                    return result;
                  } catch (error) {
                    if (attempt >= (config?.maxAttempts ?? 1)) {
                      throw error;
                    }
                  }
                }
              },
            );
            let summaries = 0;
            let generations = 0;
            provider.mock.mockImplementation((options: { tools?: { name: string }[] }) => {
              if (options.tools?.length !== 0) {
                generations++;

                if (scenario.creation && generations === 1) {
                  throw Object.assign(new Error("private creation error"), {
                    code: "context_length_exceeded",
                  });
                }
              }

              return (async function* (): AsyncGenerator<AdapterYieldChunk> {
                if (options.tools?.length === 0) {
                  summaries++;

                  if (scenario.invalidSummary) {
                    return;
                  }

                  yield* textStream(undefined, `${scenario.name}-summary`);

                  return;
                }

                if (scenario.providerFailure) {
                  throw scenario.providerFailure;
                }

                if (generations > 1 && scenario.recoveredId) {
                  yield* textStream(undefined, scenario.recoveredId);

                  return;
                }

                yield {
                  type: EventType.TEXT_MESSAGE_START,
                  messageId: `${scenario.name}-partial-${generations}`,
                  role: "assistant",
                };
                yield {
                  type: EventType.TEXT_MESSAGE_CONTENT,
                  messageId: `${scenario.name}-partial-${generations}`,
                  delta: "Discard partial response",
                };
                throw Object.assign(new Error("private overflow detail"), {
                  code: "context_length_exceeded",
                });
              })();
            });

            try {
              if (scenario.failure) {
                await assert.rejects(executeRun(run), scenario.failure);
              } else {
                await executeRun(run);
              }

              assert.equal(generations, scenario.generations);
              assert.equal(summaries, scenario.summaries);
              const projection = readProjection(runs.get(run.runId)!.projection as RunProjection);
              assert.deepEqual(projection.display.slice(0, run.messages.length), run.messages);
              assert.equal(JSON.stringify(projection).includes("Discard partial response"), false);
              assert.equal(
                JSON.stringify([...receipts.values()]).includes("private overflow"),
                false,
              );
              assert.equal(receipts.has("reset-model:0:exhausted"), scenario.exhausted ?? false);

              if (scenario.originalContext) {
                assert.deepEqual(projection.context, run.context);
              }

              assert.equal(runs.get(run.runId)!.state, scenario.failure ? "pending" : "succeeded");
              const emitted = events
                .filter((row) => row.run_id === run.runId)
                .map((row) => row.payload as StreamChunk);
              const replay = new StreamProcessor({ initialMessages: run.messages });

              for (const event of emitted) {
                replay.processChunk(event);
              }

              assert.deepEqual(snapshot(replay.getMessages()), snapshot(projection.display));
            } finally {
              durable.mock.restore();
            }
          },
        );
      }

      const legacyThread = "58b47547-a3b2-4f61-9d92-f29cf9f6cb83";
      threads.set(legacyThread, {
        id: legacyThread,
        messages: [],
        revision: 0,
        active_run_id: null,
      });
      const legacyRun = await acceptRun({
        ...input,
        threadId: legacyThread,
        runId: "official-v3-saved-checkpoint",
        message: { id: "official-user", text: "Resume official Jira read" },
      });
      (legacyRun as unknown as Record<string, unknown>).build = "durable-chat-loop-v3";
      (runs.get(legacyRun.runId)!.accepted as Record<string, unknown>).build =
        "durable-chat-loop-v3";
      const legacyInput = { cloudId: "offline-cloud-id", issueIdOrKey: "TEST-1" };
      const legacyCall = {
        id: "official-v3-call",
        name: "getJiraIssue",
        arguments: JSON.stringify(legacyInput),
        input: legacyInput,
      };
      const legacyProcessor = new StreamProcessor({
        initialMessages: structuredClone(legacyRun.messages),
      });
      legacyProcessor.processChunk({
        type: EventType.TOOL_CALL_START,
        toolCallId: legacyCall.id,
        toolCallName: legacyCall.name,
      });
      legacyProcessor.processChunk({
        type: EventType.TOOL_CALL_ARGS,
        toolCallId: legacyCall.id,
        delta: legacyCall.arguments,
      });
      legacyProcessor.processChunk({
        type: EventType.TOOL_CALL_END,
        toolCallId: legacyCall.id,
        input: legacyInput,
      });
      const savedOfficialTurn: Turn = {
        messages: legacyProcessor.getMessages(),
        calls: [legacyCall],
      };
      cached.clear();
      gaps.clear();
      cached.set("model:0", savedOfficialTurn);
      provider.mock.mockImplementation(async function* () {
        yield* textStream(undefined, `provider-text-${++textSequence}`);
      });
      const legacyFixture = mcpFixture();
      await withMcpEnvironment(
        async () => {
          const beforeLegacyEvents = events.length;
          const beforeLegacySteps = checkpoints.mock.callCount();
          const failure = await executeRun(legacyRun).then(
            () => undefined,
            (error: Error) => error,
          );
          const persistedResults = events
            .slice(beforeLegacyEvents)
            .map((row) => row.payload as StreamChunk)
            .filter((event) => event.type === EventType.TOOL_CALL_RESULT);
          assert.deepEqual(
            persistedResults,
            [],
            "Old v3 checkpoint must not persist native-dispatch errors",
          );
          assert.match(failure?.message ?? "Run resolved", /Incompatible run build/);
          assert.equal(checkpoints.mock.callCount(), beforeLegacySteps);
          assert.deepEqual(cached.get("model:0"), savedOfficialTurn);
          assert.equal(cached.has("tool:0:0"), false);
          assert.equal(runs.get(legacyRun.runId)!.state, "pending");
          assert.equal(threads.get(legacyThread)!.active_run_id, legacyRun.runId);
          assert.deepEqual(legacyFixture.sessions, []);
        },
        true,
        legacyFixture,
      );
    } finally {
      checkpoints.mock.restore();
      provider.mock.restore();
      tool.mock.restore();
    }

    await t.test(
      "manual commands preserve archives, replay once, and never create user commands or ordinary replies",
      async () => {
        const threadId = randomUUID();
        const history: UIMessage[] = Array.from({ length: 3 }, (_, index) => [
          {
            id: `manual-u${index}`,
            role: "user" as const,
            parts: [{ type: "text" as const, content: `問題${index}`.repeat(500) }],
          },
          {
            id: `manual-a${index}`,
            role: "assistant" as const,
            parts: [{ type: "text" as const, content: `回答${index}`.repeat(500) }],
          },
        ]).flat();
        threads.set(threadId, {
          id: threadId,
          title: "固定標題",
          messages: history,
          revision: 0,
          active_run_id: null,
        });
        const { deepinfra } = await import("../../../server/harness/provider");
        let summaryText = "第一份完整摘要";
        const summaryProvider = mock.method(
          Object.getPrototypeOf(deepinfra(accepted.model)),
          "chatStream",
          async function* (options: { tools: unknown[] }) {
            assert.deepEqual(options.tools, []);
            yield {
              type: EventType.TEXT_MESSAGE_START,
              messageId: "private-summary",
              role: "assistant",
            };
            yield {
              type: EventType.TEXT_MESSAGE_CONTENT,
              messageId: "private-summary",
              delta: summaryText,
            };
            yield { type: EventType.TEXT_MESSAGE_END, messageId: "private-summary" };
            yield {
              type: EventType.RUN_FINISHED,
              threadId: "provider",
              runId: "provider",
              finishReason: "stop",
            };
          },
        );
        const durable = mock.method(DBOS, "runStep", async (callback: () => Promise<unknown>) =>
          callback(),
        );

        try {
          const command = {
            threadId,
            runId: "manual-first",
            baseRevision: 0,
            kind: "compact" as const,
          };
          const run = await acceptRun(command);
          assert.deepEqual(run.messages, history);
          assert.deepEqual(await acceptRun(command), run);
          await assert.rejects(acceptRun({ ...command, runId: "manual-busy" }), /claim conflict/);
          await assert.rejects(
            acceptRun({ ...command, kind: "chat", message: { id: "slash", text: "/compact" } }),
            /collision/,
          );
          await executeRun(run);
          const saved = (await hydrateThread(threadId)).messages;
          assert.deepEqual(saved.slice(0, -1), history);
          assert.deepEqual(saved.at(-1)?.parts, [{ type: "text", content: "第一份完整摘要" }]);
          assert.equal(threads.get(threadId)!.title, "固定標題");
          assert.equal(threads.get(threadId)!.active_run_id, null);
          assert.equal(threads.get(threadId)!.revision, 1);
          assert.equal((runs.get(run.runId)!.projection as RunProjection).committedRevision, 1);
          const firstEvents = events
            .filter((row) => row.run_id === run.runId)
            .map((row) => row.payload as StreamChunk);
          assert.deepEqual(
            firstEvents.map((event) => event.type),
            [
              "RUN_STARTED",
              "CUSTOM",
              "MESSAGES_SNAPSHOT",
              "CUSTOM",
              "MESSAGES_SNAPSHOT",
              "RUN_FINISHED",
            ],
          );
          assert.deepEqual(
            firstEvents.flatMap((event) => {
              const parsed = parseCompactionEvent(event);

              return parsed ? [parsed.state] : [];
            }),
            ["started", "done"],
          );
          const eventCount = events.length;
          await acceptRun(command);
          await finishRun(run.runId, { display: saved, context: run.context });
          assert.equal(events.length, eventCount);
          await assert.rejects(
            acceptRun({ ...command, runId: "manual-stale" }),
            /revision or claim conflict/,
          );
          summaryText = "第二份完整摘要";
          const second = await acceptRun({ ...command, runId: "manual-second", baseRevision: 1 });
          await executeRun(second);
          const twice = (await hydrateThread(threadId)).messages;
          assert.deepEqual(twice.slice(0, -1), saved);
          assert.deepEqual(twice.at(-1)?.parts, [{ type: "text", content: "第二份完整摘要" }]);
          const after = await acceptRun({ ...command, runId: "manual-skip", baseRevision: 2 });
          assert.deepEqual(
            after.context
              .filter((message) => message.metadata?.fromSummary)
              .map((message) => message.id),
            ["summary:manual-second/compact/0"],
          );
          assert.equal(JSON.stringify(after.context).includes("第一份完整摘要"), false);
          await executeRun(after);
          assert.deepEqual((await hydrateThread(threadId)).messages, twice);
          assert.equal(threads.get(threadId)!.revision, 3);
          assert.deepEqual(
            events
              .filter((row) => row.run_id === after.runId)
              .flatMap((row) => {
                const parsed = parseCompactionEvent(row.payload);

                return parsed ? [parsed.state] : [];
              }),
            ["skipped"],
          );
          assert.equal(runs.get(after.runId)!.state, "succeeded");
          const failedThread = randomUUID();
          threads.set(failedThread, {
            id: failedThread,
            title: "失敗測試",
            messages: history,
            revision: 0,
            active_run_id: null,
          });
          summaryText = "";
          const failure = await acceptRun({
            ...command,
            threadId: failedThread,
            runId: "manual-failed",
          });
          await executeRun(failure);
          assert.deepEqual((await hydrateThread(failedThread)).messages, history);
          assert.equal(threads.get(failedThread)!.revision, 0);
          assert.equal(threads.get(failedThread)!.active_run_id, null);
          assert.equal(runs.get(failure.runId)!.state, "failed");
          assert.deepEqual(
            events
              .filter((row) => row.run_id === failure.runId)
              .flatMap((row) => {
                const parsed = parseCompactionEvent(row.payload);

                return parsed ? [parsed.state] : [];
              }),
            ["started", "failed"],
          );
        } finally {
          durable.mock.restore();
          summaryProvider.mock.restore();
        }
      },
    );

    await t.test(
      "recovery commits the exact automatic summary after model failure but not inherited summaries",
      async () => {
        const threadId = randomUUID();
        const history: UIMessage[] = [
          { id: "auto-old-user", role: "user", parts: [{ type: "text", content: "原始問題" }] },
          {
            id: "auto-old-answer",
            role: "assistant",
            parts: [{ type: "text", content: "字".repeat(compactionPolicy.triggerTokens + 5000) }],
          },
        ];
        threads.set(threadId, {
          id: threadId,
          title: "原始標題",
          messages: history,
          revision: 0,
          active_run_id: null,
        });
        const { deepinfra } = await import("../../../server/harness/provider");
        const external = mock.method(
          Object.getPrototypeOf(deepinfra(accepted.model)),
          "chatStream",
          async function* (options: { tools: unknown[] }) {
            if (options.tools.length) {
              throw new Error("Ordinary provider unavailable");
            }

            yield {
              type: EventType.TEXT_MESSAGE_START,
              messageId: "private-auto-summary",
              role: "assistant",
            };
            yield {
              type: EventType.TEXT_MESSAGE_CONTENT,
              messageId: "private-auto-summary",
              delta: "完整自動摘要，保留 EXACT-42。",
            };
            yield { type: EventType.TEXT_MESSAGE_END, messageId: "private-auto-summary" };
            yield {
              type: EventType.RUN_FINISHED,
              threadId: "provider",
              runId: "provider",
              finishReason: "stop",
            };
          },
        );
        const durable = mock.method(DBOS, "runStep", async (callback: () => Promise<unknown>) =>
          callback(),
        );

        try {
          const run = await acceptRun({
            ...input,
            threadId,
            runId: "auto-model-failed",
            message: { id: "auto-current", text: "目前問題" },
          });
          await assert.rejects(executeRun(run), /Ordinary provider unavailable/);
          const published = readProjection(runs.get(run.runId)!.projection as RunProjection);
          assert.deepEqual(published.display.at(-1)?.parts, [
            { type: "text", content: "完整自動摘要，保留 EXACT-42。" },
          ]);
          assert.deepEqual((await hydrateThread(threadId)).messages, published.display);
          statuses.set(run.runId, "ERROR");
          await reconcileRuns();
          assert.equal(runs.get(run.runId)!.state, "failed");
          assert.equal((runs.get(run.runId)!.projection as RunProjection).committedRevision, 1);
          assert.equal(threads.get(threadId)!.active_run_id, null);
          assert.deepEqual((await hydrateThread(threadId)).messages, published.display);
          assert.deepEqual(published.display.slice(0, -1), run.messages);
          const saved = structuredClone(published.display);
          const next = await acceptRun({
            ...input,
            threadId,
            runId: "inherited-summary-failed",
            baseRevision: 1,
            message: { id: "next-auto", text: "下一題" },
          });
          assert.deepEqual(next.context.slice(0, -1), published.context);
          await assert.rejects(executeRun(next), /Ordinary provider unavailable/);
          statuses.set(next.runId, "ERROR");
          await reconcileRuns();
          assert.equal(runs.get(next.runId)!.state, "failed");
          assert.equal(
            (runs.get(next.runId)!.projection as RunProjection).committedRevision,
            undefined,
          );
          assert.equal(threads.get(threadId)!.revision, 1);
          assert.deepEqual((await hydrateThread(threadId)).messages, saved);
          const before = events.length;
          await reconcileRuns();
          assert.equal(events.length, before);
        } finally {
          durable.mock.restore();
          external.mock.restore();
        }
      },
    );

    const oldRun = await acceptRun({
      ...input,
      runId: "old-build",
      baseRevision: 2,
      message: { id: "user-3", text: "Old build" },
    });
    const oldRow = runs.get(oldRun.runId)!;
    statuses.delete(oldRun.runId);
    const beforeOldStart = started.length;
    const beforeOldEvents = events.length;

    for (const legacyBuild of [
      "durable-chat-loop-v8",
      "durable-chat-loop-v4",
      "durable-chat-loop-v3",
      "durable-chat-loop-v2",
    ]) {
      (oldRow.accepted as Record<string, unknown>).build = legacyBuild;
      await reconcileRuns();
      assert.equal(started.length, beforeOldStart);
      await assert.rejects(acceptRun(oldRow.request as typeof input), /Incompatible run build/);
      await assert.rejects(executeRun(oldRow.accepted as AcceptedRun), /Incompatible run build/);
      assert.equal(oldRow.state, "pending");
      assert.equal(threads.get(oldRun.threadId)!.active_run_id, oldRun.runId);
      assert.equal(events.length, beforeOldEvents);
    }
  } finally {
    start.mock.restore();
    status.mock.restore();
    queried.mock.restore();
    connected.mock.restore();
  }
});
