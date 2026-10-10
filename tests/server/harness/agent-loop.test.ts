import assert from "node:assert/strict";
import { test } from "node:test";
import { EventType, type AdapterYieldChunk, type StreamChunk, type UIMessage } from "@tanstack/ai";
import {
  settleToolStep,
  runAgentLoop,
  type AgentCheckpoint,
  type AgentSession,
  type ChatCompaction,
} from "../../../server/harness/agent-loop";
import type { ConversationState } from "../../../server/harness/conversation";
import { ContextOverflowError, type ModelCall } from "../../../server/harness/model-turn";
import type { RunTools } from "../../../server/harness/tools";

const passCheckpoint: AgentCheckpoint = ({ work }) => work();

const baseline: ConversationState = {
  display: [{ id: "user-1", role: "user", parts: [{ type: "text", content: "Hello" }] }],
  context: [{ id: "user-1", role: "user", parts: [{ type: "text", content: "Hello" }] }],
};

async function* textTurn(messageId: string, text = "answer"): AsyncGenerator<AdapterYieldChunk> {
  yield { type: EventType.RUN_STARTED, threadId: "thread", runId: "provider-run" };
  yield { type: EventType.TEXT_MESSAGE_START, messageId, role: "assistant" };
  yield { type: EventType.TEXT_MESSAGE_CONTENT, messageId, delta: text };
  yield { type: EventType.TEXT_MESSAGE_END, messageId };
  yield { type: EventType.RUN_FINISHED, threadId: "thread", runId: "provider-run" };
}

async function* toolTurn(
  id: string,
  name: string,
  input: Record<string, unknown>,
): AsyncGenerator<AdapterYieldChunk> {
  yield { type: EventType.RUN_STARTED, threadId: "thread", runId: "provider-run" };
  yield { type: EventType.TOOL_CALL_START, toolCallId: id, toolCallName: name };
  yield { type: EventType.TOOL_CALL_ARGS, toolCallId: id, delta: JSON.stringify(input) };
  yield { type: EventType.TOOL_CALL_END, toolCallId: id, input };
  yield { type: EventType.RUN_FINISHED, threadId: "thread", runId: "provider-run" };
}

function sessionFor(
  streams: AsyncGenerator<AdapterYieldChunk>[],
  events: StreamChunk[],
  executed: ModelCall[] = [],
  output: unknown = { ok: true },
): AgentSession {
  const queue = [...streams];
  const tools: RunTools = {
    getModelTools: async () => ({ definitions: [], systemPrompt: "" }),
    executeTool: async (_messages, call) => {
      executed.push(call);
      return output;
    },
  };
  return {
    runId: "run-shared",
    assertExecution: async () => {},
    emit: async (_runId, event) => {
      events.push(structuredClone(event));
    },
    chatStream: async () => {
      const next = queue.shift();
      if (!next) {
        throw new Error("Unexpected model call");
      }
      return next;
    },
    tools,
  };
}

function bounded(maxTurn: number) {
  return { kind: "bounded", maxTurn } as const;
}

test("bounded loop publishes a text turn and finishes without compaction", async () => {
  const events: StreamChunk[] = [];
  const session = sessionFor([textTurn("m-1", "done")], events);
  const result = await runAgentLoop({
    session,
    conversation: baseline,
    model: "deepseek-ai/DeepSeek-V4.1-Flash",
    prompt: "offline",
    compaction: bounded(3),
    checkpoint: passCheckpoint,
    signal: new AbortController().signal,
  });
  assert.equal(result.state, "done");
  assert.deepEqual(
    result.conversation.context.map((message) => message.id),
    ["user-1", "m-1"],
  );
  assert.deepEqual(
    events.map((event) => event.type),
    [
      EventType.MESSAGES_SNAPSHOT,
      EventType.TEXT_MESSAGE_START,
      EventType.TEXT_MESSAGE_CONTENT,
      EventType.TEXT_MESSAGE_END,
      EventType.MESSAGES_SNAPSHOT,
    ],
  );
  const lastSnapshot = events.findLast((event) => event.type === EventType.MESSAGES_SNAPSHOT);
  assert.equal(
    lastSnapshot?.type === EventType.MESSAGES_SNAPSHOT ? lastSnapshot.messages.at(-1)?.id : null,
    "m-1",
  );
});

test("bounded loop executes a tool once and publishes the settled result", async () => {
  const events: StreamChunk[] = [];
  const executed: ModelCall[] = [];
  const session = sessionFor(
    [toolTurn("call-1", "read", { path: "TEST-1" }), textTurn("m-2", "read")],
    events,
    executed,
    { ok: true },
  );
  const result = await runAgentLoop({
    session,
    conversation: baseline,
    model: "deepseek-ai/DeepSeek-V4.1-Flash",
    prompt: "offline",
    compaction: bounded(3),
    checkpoint: passCheckpoint,
    signal: new AbortController().signal,
  });
  assert.equal(result.state, "done");
  assert.equal(executed.length, 1);
  assert.equal(executed[0]!.name, "read");
  const settled = events.filter((event) => event.type === EventType.TOOL_CALL_RESULT);
  assert.equal(settled.length, 1);
  assert.deepEqual(settled[0], {
    type: EventType.TOOL_CALL_RESULT,
    toolCallId: "call-1",
    messageId: "call-1/result",
    role: "tool",
    content: '{"ok":true}',
    timestamp: settled[0]!.timestamp,
    metadata: { tanstack: { state: "output-available" } },
  });
  const toolResult = result.conversation.context
    .flatMap((message) => message.parts)
    .find((part) => part.type === "tool-result");
  assert.equal(toolResult?.type === "tool-result" ? toolResult.toolCallId : null, "call-1");
});

test("settled output skips tool execution and keeps the shared result event", async () => {
  const events: StreamChunk[] = [];
  const executed: ModelCall[] = [];
  const assistant: UIMessage = {
    id: "assistant-1",
    role: "assistant",
    parts: [
      {
        type: "tool-call",
        id: "call-1",
        name: "read",
        arguments: '{"path":"TEST-1"}',
        state: "complete",
      },
    ],
  };
  const session = sessionFor([], events, executed);
  const conversation: ConversationState = { display: [assistant], context: [assistant] };
  const call: ModelCall = {
    id: "call-1",
    name: "read",
    arguments: '{"path":"TEST-1"}',
    input: { path: "TEST-1" },
  };
  const result = await settleToolStep(session, {
    conversation,
    call,
    output: { durable: "payload" },
  });
  assert.equal(executed.length, 0);
  const settled = events.filter((event) => event.type === EventType.TOOL_CALL_RESULT);
  assert.equal(settled.length, 1);
  assert.equal(
    settled[0]!.type === EventType.TOOL_CALL_RESULT ? settled[0]!.content : null,
    '{"durable":"payload"}',
  );
  assert.ok(
    result.context.some((message) =>
      message.parts.some((part) => part.type === "tool-result" && part.toolCallId === "call-1"),
    ),
  );
  assert.ok(events.at(-1));
  assert.equal(events.at(-1)!.type, EventType.TOOL_CALL_RESULT);
});

test("chat compaction runs threshold then overflow before retrying", async () => {
  const events: StreamChunk[] = [];
  const reasons: string[] = [];
  const attempts: (() => Promise<AsyncIterable<AdapterYieldChunk>>)[] = [
    async () => {
      throw new ContextOverflowError();
    },
    async () => textTurn("m-1", "recovered"),
  ];
  const session: AgentSession = {
    runId: "run-shared",
    assertExecution: async () => {},
    emit: async (_runId, event) => {
      events.push(structuredClone(event));
    },
    chatStream: async () => attempts.shift()!(),
    tools: {
      getModelTools: async () => ({ definitions: [], systemPrompt: "" }),
      executeTool: async () => ({}),
    },
  };
  const compaction: ChatCompaction = {
    kind: "chat",
    compact: async ({ reason }) => {
      reasons.push(reason);
      return baseline;
    },
  };
  const result = await runAgentLoop({
    session,
    conversation: baseline,
    model: "deepseek-ai/DeepSeek-V4.1-Flash",
    prompt: "offline",
    compaction,
    checkpoint: passCheckpoint,
    signal: new AbortController().signal,
  });
  assert.equal(result.state, "done");
  assert.deepEqual(reasons, ["threshold", "overflow"]);
  assert.deepEqual(
    events.filter((event) => event.type === EventType.MESSAGES_SNAPSHOT).map((event) => event.type),
    [
      EventType.MESSAGES_SNAPSHOT,
      EventType.MESSAGES_SNAPSHOT,
      EventType.MESSAGES_SNAPSHOT,
      EventType.MESSAGES_SNAPSHOT,
    ],
  );
});

test("bounded loop reports overflow without compaction", async () => {
  const events: StreamChunk[] = [];
  const session: AgentSession = {
    runId: "run-shared",
    assertExecution: async () => {},
    emit: async (_runId, event) => {
      events.push(structuredClone(event));
    },
    chatStream: async () => {
      throw new ContextOverflowError();
    },
    tools: {
      getModelTools: async () => ({ definitions: [], systemPrompt: "" }),
      executeTool: async () => ({}),
    },
  };
  const result = await runAgentLoop({
    session,
    conversation: baseline,
    model: "deepseek-ai/DeepSeek-V4.1-Flash",
    prompt: "offline",
    compaction: bounded(5),
    checkpoint: passCheckpoint,
    signal: new AbortController().signal,
  });
  assert.equal(result.state, "overflow");
});

test("bounded loop stops at the caller budget after repeated tool turns", async () => {
  const events: StreamChunk[] = [];
  const executed: ModelCall[] = [];
  const session = sessionFor(
    [
      toolTurn("call-1", "read", { path: "TEST-1" }),
      toolTurn("call-2", "read", { path: "TEST-2" }),
    ],
    events,
    executed,
  );
  const result = await runAgentLoop({
    session,
    conversation: baseline,
    model: "deepseek-ai/DeepSeek-V4.1-Flash",
    prompt: "offline",
    compaction: bounded(2),
    checkpoint: passCheckpoint,
    signal: new AbortController().signal,
  });
  assert.equal(result.state, "limit");
  assert.equal(executed.length, 2);
});
