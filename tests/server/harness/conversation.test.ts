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
