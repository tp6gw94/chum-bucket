import assert from "node:assert/strict";
import { test } from "node:test";
import type { UIMessage } from "@tanstack/ai";
import {
  advanceConversation,
  conversationFromProjection,
  projectConversation,
} from "../../../server/harness/conversation";

const text = (id: string, role: UIMessage["role"], content: string): UIMessage => ({
  id,
  role,
  parts: [{ type: "text", content }],
});
const summary: UIMessage = {
  ...text("summary", "user", "Summary"),
  metadata: { fromSummary: true },
};

test("advanceConversation appends new messages and replaces updated ones in both views", () => {
  const assistant = text("assistant", "assistant", "Calling a tool");
  const state = {
    display: [text("old", "user", "Old"), summary, text("user", "user", "Ask"), assistant],
    context: [summary, text("user", "user", "Ask"), assistant],
  };
  const updated: UIMessage = {
    ...assistant,
    parts: [
      ...assistant.parts,
      { type: "tool-result", toolCallId: "call", content: "{}", state: "complete" },
    ],
  };
  const next = advanceConversation(state, [
    ...state.context.slice(0, 2),
    updated,
    text("answer", "assistant", "Done"),
  ]);

  assert.deepEqual(
    next.display.map((message) => message.id),
    ["old", "summary", "user", "assistant", "answer"],
  );
  assert.deepEqual(
    next.context.map((message) => message.id),
    ["summary", "user", "assistant", "answer"],
  );
  assert.deepEqual(next.display[3], updated);
  assert.deepEqual(next.context[2], updated);
});

test("the projection stores the display history with the summary anchor and restores the context", () => {
  const display = [text("old", "user", "Old"), summary, text("user", "user", "Ask")];
  const state = { display, context: display.slice(1) };
  const projection = projectConversation(state);

  assert.deepEqual(projection, { messages: display, contextAnchor: "summary" });
  assert.deepEqual(conversationFromProjection(projection), state);
  assert.deepEqual(projectConversation({ display, context: display }), { messages: display });
});

test("the projection rejects contexts that are not a suffix of the display history", () => {
  const display = [text("old", "user", "Old"), summary, text("user", "user", "Ask")];

  assert.throws(() => projectConversation({ display, context: [summary] }), /not a suffix/);
  assert.throws(
    () => conversationFromProjection({ messages: display, contextAnchor: "old" }),
    /anchor is missing/,
  );
});
