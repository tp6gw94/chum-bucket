import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { EventType, type AdapterYieldChunk, type StreamChunk, type UIMessage } from "@tanstack/ai";
import sharp from "sharp";
import {
  settleToolStep,
  runAgentLoop,
  type AgentChatStream,
  type AgentCheckpoint,
  type AgentSession,
  type ChatCompaction,
} from "../../../server/harness/agent-loop";
import type { ConversationState } from "../../../server/harness/conversation";
import { ContextOverflowError, type ModelCall } from "../../../server/harness/model-turn";
import type { RunTools } from "../../../server/harness/tools";
import type { BrowserHandoff } from "../../../shared/testing";

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

test("a bounded loop reserves its last model turn for a tool-free final reply", async () => {
  const events: StreamChunk[] = [];
  const executed: ModelCall[] = [];
  const offered: { tools: number; prompts: readonly string[] }[] = [];
  const streams = [toolTurn("call-1", "codemode", { code: "1" }), textTurn("m-final", "{}")];
  const base = sessionFor(streams, events, executed);
  const session: AgentSession = {
    ...base,
    tools: {
      ...base.tools,
      getModelTools: async () => ({
        definitions: [{ name: "codemode", description: "run", inputSchema: { type: "object" } }],
        systemPrompt: "codemode instructions",
      }),
    },
    chatStream: async (options) => {
      offered.push({ tools: options.tools.length, prompts: options.systemPrompts });

      return base.chatStream(options);
    },
  };
  const result = await runAgentLoop({
    session,
    conversation: baseline,
    model: "deepseek-ai/DeepSeek-V4.1-Flash",
    prompt: "role prompt",
    compaction: bounded(2),
    finalTurn: "Tools are closed. Reply with the final JSON object only.",
    checkpoint: passCheckpoint,
    signal: new AbortController().signal,
  });
  assert.equal(result.state, "done");
  assert.deepEqual(offered, [
    { tools: 1, prompts: ["role prompt", "codemode instructions"] },
    {
      tools: 0,
      prompts: ["role prompt", "Tools are closed. Reply with the final JSON object only."],
    },
  ]);
  assert.equal(executed.length, 1);
});

test("a tool call attempted on the reserved final turn is not executed", async () => {
  const events: StreamChunk[] = [];
  const executed: ModelCall[] = [];
  const session = sessionFor(
    [toolTurn("call-1", "codemode", { code: "1" }), toolTurn("call-2", "codemode", { code: "2" })],
    events,
    executed,
  );
  const result = await runAgentLoop({
    session,
    conversation: baseline,
    model: "deepseek-ai/DeepSeek-V4.1-Flash",
    prompt: "role prompt",
    compaction: bounded(2),
    finalTurn: "final",
    checkpoint: passCheckpoint,
    signal: new AbortController().signal,
  });
  assert.equal(result.state, "done");
  assert.deepEqual(
    executed.map((call) => call.id),
    ["call-1"],
  );
});

test("one executor model turn runs all seventeen direct check calls before the reserved final reply", async () => {
  const checkIds = Array.from({ length: 17 }, (_, index) => `chk-${index + 1}`);
  const events: StreamChunk[] = [];
  const executed: ModelCall[] = [];
  const parallelTurn = async function* (): AsyncGenerator<AdapterYieldChunk> {
    yield { type: EventType.RUN_STARTED, threadId: "thread", runId: "provider-run" };

    for (const checkId of checkIds) {
      const input = { checkId };
      yield { type: EventType.TOOL_CALL_START, toolCallId: checkId, toolCallName: "verify_ac" };
      yield { type: EventType.TOOL_CALL_ARGS, toolCallId: checkId, delta: JSON.stringify(input) };
      yield { type: EventType.TOOL_CALL_END, toolCallId: checkId, input };
    }

    yield { type: EventType.RUN_FINISHED, threadId: "thread", runId: "provider-run" };
  };
  const session = sessionFor(
    [parallelTurn(), textTurn("m-final", '{"checks":[]}')],
    events,
    executed,
  );
  const result = await runAgentLoop({
    session,
    conversation: baseline,
    model: "deepseek-ai/DeepSeek-V4.1-Flash",
    prompt: "role prompt",
    compaction: bounded(6),
    finalTurn: "final",
    checkpoint: passCheckpoint,
    signal: new AbortController().signal,
  });
  assert.equal(result.state, "done");
  assert.deepEqual(
    executed.map((call) => [call.name, call.id]),
    checkIds.map((checkId) => ["verify_ac", checkId]),
  );
});

const HANDOFF_IMAGES = join(process.cwd(), ".data", "browser-evidence");

type StoredImage = Readonly<{ path: string; digest: string; base64: string }>;
type ModelMessages = Parameters<AgentChatStream>[0]["messages"];

async function storedImage(t: TestContext, shade: number): Promise<StoredImage> {
  const bytes = await sharp({
    create: { width: 1280, height: 900, channels: 3, background: { r: shade, g: shade, b: shade } },
  })
    .png()
    .toBuffer();
  const path = `${randomUUID()}.png`;
  await mkdir(HANDOFF_IMAGES, { recursive: true });
  await writeFile(join(HANDOFF_IMAGES, path), bytes);
  t.after(() => rm(join(HANDOFF_IMAGES, path), { force: true }));

  return {
    path,
    digest: createHash("sha256").update(bytes).digest("hex"),
    base64: bytes.toString("base64"),
  };
}

function imageId(caseId: string, handoffId: string, image: StoredImage): string {
  return `browser-handoff-image:${createHash("sha256")
    .update(JSON.stringify([caseId, handoffId, image.digest]))
    .digest("hex")}`;
}

function imageNote(caseId: string, handoffId: string) {
  return {
    type: "text",
    content: `Labeled screenshot for handoff ${handoffId} of case ${caseId}. Each mark is labeled with its candidate or link id. It is a handoff aid, not evidence.`,
  };
}

function pausedOutput(caseId: string, handoffId: string, image: StoredImage): BrowserHandoff {
  return {
    state: "selection_required",
    checkId: `${caseId}-check`,
    handoff: {
      kind: "selection",
      id: handoffId,
      caseId,
      ordinal: 1,
      laterHandoffsAllowed: 2,
      expiresAt: "2026-10-13T00:03:00.000Z",
      url: "http://shop.test/",
      target: { intent: "submit control", operation: "click", at: { kind: "action", index: 1 } },
      candidates: [{ id: "c0", description: "Submit" }],
      links: [],
      diagnostics: { code: "candidate_overflow", candidateCount: 300 },
      image: { path: image.path, digest: image.digest },
    },
  };
}

async function* verifyBatch(callIds: readonly string[]): AsyncGenerator<AdapterYieldChunk> {
  yield { type: EventType.RUN_STARTED, threadId: "thread", runId: "provider-run" };

  for (const id of callIds) {
    const input = { checkId: id };
    yield { type: EventType.TOOL_CALL_START, toolCallId: id, toolCallName: "verify_ac" };
    yield { type: EventType.TOOL_CALL_ARGS, toolCallId: id, delta: JSON.stringify(input) };
    yield { type: EventType.TOOL_CALL_END, toolCallId: id, input };
  }

  yield { type: EventType.RUN_FINISHED, threadId: "thread", runId: "provider-run" };
}

function imageSession(
  streams: AsyncGenerator<AdapterYieldChunk>[],
  outputs: Readonly<Record<string, () => Promise<unknown>>>,
  requests: ModelMessages[],
): AgentSession {
  const base = sessionFor(streams, []);

  return {
    ...base,
    tools: { ...base.tools, executeTool: async (_messages, call) => outputs[call.id]!() },
    chatStream: async (options) => {
      requests.push(structuredClone(options.messages));

      return base.chatStream(options);
    },
  };
}

function imagesIn(messages: ModelMessages): string[] {
  return messages.flatMap((message) =>
    message.role === "user" && Array.isArray(message.content)
      ? message.content.flatMap((part) => (part.type === "image" ? [part.source.value] : []))
      : [],
  );
}

function outline(message: ModelMessages[number]): unknown {
  if (message.role === "assistant") {
    return ["assistant", message.toolCalls?.map((call) => call.id)];
  }

  if (message.role === "tool") {
    return ["tool", message.toolCallId];
  }

  return [message.role, imagesIn([message])];
}

const loopInput = {
  conversation: baseline,
  model: "deepseek-ai/DeepSeek-V4.1-Flash",
  prompt: "role prompt",
  signal: new AbortController().signal,
};

test("a verify handoff adds its labeled screenshot as a user image inside the same tool checkpoint and the next model request carries it", async (t) => {
  const image = await storedImage(t, 120);
  const requests: ModelMessages[] = [];
  const recorded: [string, unknown][] = [];
  const result = await runAgentLoop({
    ...loopInput,
    session: imageSession(
      [verifyBatch(["call-1"]), textTurn("m-final", "{}")],
      { "call-1": async () => pausedOutput("case-a", "h1", image) },
      requests,
    ),
    compaction: bounded(3),
    checkpoint: async ({ name, work }) => {
      const value = await work();
      recorded.push([name, structuredClone(value)]);

      return value;
    },
  });

  const metadata = {
    browserHandoffImage: {
      caseId: "case-a",
      handoffId: "h1",
      image: { path: image.path, digest: image.digest },
    },
  };

  assert.deepEqual(requests[1]!.at(-1), {
    id: imageId("case-a", "h1", image),
    role: "user",
    content: [
      imageNote("case-a", "h1"),
      { type: "image", source: { type: "data", value: image.base64, mimeType: "image/png" } },
    ],
    metadata,
  });
  assert.deepEqual(
    recorded.map(([name, value]) => [name, JSON.stringify(value).includes(image.base64)]),
    [
      ["model:0", false],
      ["tool:0:0", true],
      ["model:1", true],
    ],
  );
  assert.deepEqual(
    result.conversation.display.find((message) => message.id === imageId("case-a", "h1", image)),
    {
      id: imageId("case-a", "h1", image),
      role: "user",
      metadata,
      parts: [imageNote("case-a", "h1")],
    },
  );
  assert.equal(JSON.stringify(result.conversation.display).includes(image.base64), false);
});

test("a batch pausing two cases sends every tool result before both screenshots, and equal handoff ids from different cases stay distinct", async (t) => {
  const first = await storedImage(t, 110);
  const second = await storedImage(t, 130);
  const requests: ModelMessages[] = [];
  await runAgentLoop({
    ...loopInput,
    session: imageSession(
      [verifyBatch(["call-a", "call-b"]), textTurn("m-final", "{}")],
      {
        "call-a": async () => pausedOutput("case-a", "h1", first),
        "call-b": async () => pausedOutput("case-b", "h1", second),
      },
      requests,
    ),
    compaction: bounded(3),
    checkpoint: passCheckpoint,
  });

  assert.deepEqual(requests[1]!.map(outline), [
    ["user", []],
    ["assistant", ["call-a", "call-b"]],
    ["tool", "call-a"],
    ["tool", "call-b"],
    ["user", [first.base64]],
    ["user", [second.base64]],
  ]);
});

test("a re-read keeps the attached screenshot without reading its file, a later screenshot batch retires earlier images from context only, and replay needs no file", async (t) => {
  const first = await storedImage(t, 110);
  const second = await storedImage(t, 130);
  const requests: ModelMessages[] = [];
  const recorded = new Map<string, unknown>();
  const result = await runAgentLoop({
    ...loopInput,
    session: imageSession(
      [verifyBatch(["call-1"]), verifyBatch(["call-2", "call-3"]), textTurn("m-final", "{}")],
      {
        "call-1": async () => pausedOutput("case-a", "h1", first),
        "call-2": async () => {
          await rm(join(HANDOFF_IMAGES, first.path));

          return pausedOutput("case-a", "h1", first);
        },
        "call-3": async () => pausedOutput("case-b", "h2", second),
      },
      requests,
    ),
    compaction: bounded(4),
    checkpoint: async ({ name, work }) => {
      const value = await work();
      recorded.set(name, structuredClone(value));

      return value;
    },
  });

  assert.deepEqual(requests.map(imagesIn), [[], [first.base64], [second.base64]]);
  assert.deepEqual(
    result.conversation.display.flatMap((message) =>
      message.metadata?.browserHandoffImage
        ? [[message.metadata.browserHandoffImage.handoffId, message.parts.map((part) => part.type)]]
        : [],
    ),
    [
      ["h1", ["text"]],
      ["h2", ["text"]],
    ],
  );
  assert.equal(JSON.stringify(result.conversation.display).includes(second.base64), false);
  await rm(join(HANDOFF_IMAGES, second.path));
  const replay = (async ({ name }) => recorded.get(name)) as AgentCheckpoint;

  assert.deepEqual(
    await runAgentLoop({
      ...loopInput,
      session: imageSession([], {}, []),
      compaction: bounded(4),
      checkpoint: replay,
    }),
    result,
  );
});
