import assert from "node:assert/strict";
import { test } from "node:test";
import { EventType, StreamProcessor, type StreamChunk, type UIMessage } from "@tanstack/ai";
import {
  advanceConversation,
  projectConversation,
  readProjection,
  type RunProjection,
} from "../../../server/harness/conversation";
import { streamModelTurn } from "../../../server/harness/model-turn";

const original: UIMessage = {
  id: "original",
  role: "user",
  parts: [{ type: "text", content: "Keep Safe and <ds_safety> in my original text" }],
  metadata: { native: "preserved" },
};
const summary: UIMessage = {
  id: "summary:operation",
  role: "user",
  parts: [{ type: "text", content: "Historical context" }],
  metadata: { fromSummary: true },
};

test("compacted context produces full original display without summary messages", () => {
  const answer: UIMessage = {
    id: "answer",
    role: "assistant",
    parts: [
      { type: "thinking", content: "Reasoning" },
      { type: "text", content: "Answer" },
    ],
  };
  const state = advanceConversation({ display: [original], context: [summary] }, [summary, answer]);
  assert.deepEqual(state.display, [original, answer]);
  assert.deepEqual(state.context, [summary, answer]);
  assert.deepEqual(readProjection(projectConversation(state)), { version: 1, ...state });
});

test("legacy arrays initialize both views while unsupported projection versions reject", () => {
  assert.deepEqual(readProjection([original]), { display: [original], context: [original] });
  assert.throws(
    () => readProjection({ version: 2, display: [], context: [] } as unknown as RunProjection),
    /Unsupported/,
  );
});

test("canonical results update current calls without losing native text, metadata, or archived parts", () => {
  const call: UIMessage = {
    id: "call-message",
    role: "assistant",
    metadata: { native: "tool-owner" },
    parts: [
      { type: "text", content: "Reading both files" },
      { type: "tool-call", id: "read-one", name: "read", arguments: "{}", state: "complete" },
      { type: "tool-call", id: "read-two", name: "read", arguments: "{}", state: "complete" },
    ],
  };
  let state = { display: [original, call], context: [summary, call] };
  for (const toolCallId of ["read-one", "read-two"]) {
    const processor = new StreamProcessor({ initialMessages: structuredClone(state.context) });
    processor.processChunk({
      type: EventType.TOOL_CALL_RESULT,
      messageId: `${toolCallId}/result`,
      toolCallId,
      content: '{"ok":true}',
      role: "tool",
    });
    state = advanceConversation(state, processor.getMessages(), call.id);
  }
  assert.deepEqual(state.display[0], original);
  assert.deepEqual(state.display[1]?.metadata, { native: "tool-owner" });
  assert.deepEqual(state.display[1]?.parts, [
    { type: "text", content: "Reading both files" },
    {
      type: "tool-call",
      id: "read-one",
      name: "read",
      arguments: "{}",
      state: "complete",
      output: { ok: true },
    },
    {
      type: "tool-call",
      id: "read-two",
      name: "read",
      arguments: "{}",
      state: "complete",
      output: { ok: true },
    },
    { type: "tool-result", toolCallId: "read-one", content: '{"ok":true}', state: "complete" },
    { type: "tool-result", toolCallId: "read-two", content: '{"ok":true}', state: "complete" },
  ]);
});

test("provider collisions with archived history reject before publishing content", async () => {
  const emitted: unknown[] = [];
  await assert.rejects(
    streamModelTurn({
      messages: [summary],
      protectedMessages: [original],
      stream: (async function* () {
        yield { type: EventType.TEXT_MESSAGE_CONTENT, messageId: original.id, delta: "overwrite" };
      })(),
      append: async (event) => {
        emitted.push(event);
      },
    }),
    /collides/,
  );
  assert.deepEqual(emitted, []);
  assert.deepEqual(original.parts, [
    { type: "text", content: "Keep Safe and <ds_safety> in my original text" },
  ]);
});

const archivedToolMessage: UIMessage = {
  id: "archived-assistant",
  role: "assistant",
  parts: [
    { type: "text", content: "Original tool answer" },
    { type: "tool-call", id: "archived-tool", name: "read", arguments: "{}", state: "complete" },
  ],
};

const archivedReferences: { name: string; event: StreamChunk }[] = [
  {
    name: "structured output start",
    event: {
      type: EventType.CUSTOM,
      name: "structured-output.start",
      value: { messageId: original.id },
    },
  },
  {
    name: "structured output completion",
    event: {
      type: EventType.CUSTOM,
      name: "structured-output.complete",
      value: { messageId: original.id, object: { replaced: true }, raw: '{"replaced":true}' },
    },
  },
  {
    name: "tool approval",
    event: {
      type: EventType.CUSTOM,
      name: "approval-requested",
      value: {
        toolCallId: "archived-tool",
        toolName: "read",
        input: {},
        approval: { id: "new-approval", needsApproval: true },
      },
    },
  },
  {
    name: "encrypted tool signature",
    event: {
      type: EventType.REASONING_ENCRYPTED_VALUE,
      subtype: "tool-call",
      entityId: "archived-tool",
      encryptedValue: "replacement-signature",
    },
  },
];

for (const { name, event } of archivedReferences) {
  test(`provider ${name} cannot publish changes to archived history`, async () => {
    const emitted: StreamChunk[] = [];
    const history = structuredClone([original, archivedToolMessage]);
    await assert.rejects(
      streamModelTurn({
        messages: [summary],
        protectedMessages: history,
        stream: (async function* () {
          yield event;
          yield { type: EventType.RUN_FINISHED, threadId: "provider", runId: "provider" };
        })(),
        append: async (chunk) => {
          emitted.push(chunk);
        },
      }),
      /collides/,
    );
    assert.deepEqual(emitted, []);
    assert.deepEqual(history, [original, archivedToolMessage]);
  });
}

test("new structured output is published without changing archived messages", async () => {
  const emitted: StreamChunk[] = [];
  const turn = await streamModelTurn({
    messages: [summary],
    protectedMessages: [original],
    stream: (async function* () {
      yield {
        type: EventType.CUSTOM,
        name: "structured-output.start",
        value: { messageId: "new-structured" },
      };
      yield {
        type: EventType.CUSTOM,
        name: "structured-output.complete",
        value: {
          messageId: "new-structured",
          object: { answer: "New answer" },
          raw: '{"answer":"New answer"}',
        },
      };
      yield { type: EventType.RUN_FINISHED, threadId: "provider", runId: "provider" };
    })(),
    append: async (chunk) => {
      emitted.push(chunk);
    },
  });
  const state = advanceConversation({ display: [original], context: [summary] }, turn.messages);
  assert.deepEqual(state.display[0], original);
  assert.equal(state.display[1]?.id, "new-structured");
  assert.equal(JSON.stringify(state.display[1]).includes("New answer"), true);
  assert.equal(emitted.length, 2);
});
