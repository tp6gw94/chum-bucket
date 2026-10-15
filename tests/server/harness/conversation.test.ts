import assert from "node:assert/strict";
import { test } from "node:test";
import type { UIMessage } from "@tanstack/ai";
import {
  advanceConversation,
  readProjection,
  writeProjection,
} from "../../../server/harness/conversation";

function text(id: string, role: "user" | "assistant", content: string): UIMessage {
  return { id, role, parts: [{ type: "text", content }] };
}

const summary: UIMessage = {
  id: "summary:run/compact/0",
  role: "user",
  parts: [{ type: "text", content: "summary" }],
  metadata: { fromSummary: true },
};

test("new context messages append to display while summaries stay out of it", () => {
  const original = [text("u1", "user", "one"), text("a1", "assistant", "two")];
  const state = { display: original, context: [summary, original[1]!] };
  const next = advanceConversation(state, [
    summary,
    structuredClone(original[1]!),
    text("u2", "user", "three"),
  ]);

  assert.deepEqual(
    next.display.map((message) => message.id),
    ["u1", "a1", "u2"],
  );
  assert.deepEqual(
    next.context.map((message) => message.id),
    [summary.id, "a1", "u2"],
  );
  assert.equal(next.context[1], original[1]);
});

test("only the named message is replaced in both display and context", () => {
  const assistant = text("a1", "assistant", "before");
  const state = { display: [text("u1", "user", "hi"), assistant], context: [assistant] };
  const updated = text("a1", "assistant", "after");
  const untouched = advanceConversation(state, [updated]);
  const replaced = advanceConversation(state, [updated], "a1");

  assert.equal(untouched.context[0], assistant);
  assert.equal(replaced.context[0], updated);
  assert.equal(replaced.display[1], updated);
});

test("a new message reusing a compacted message ID is rejected", () => {
  const state = { display: [text("u1", "user", "old")], context: [summary] };

  assert.throws(
    () => advanceConversation(state, [summary, text("u1", "user", "new")]),
    /collides with compacted history/,
  );
});

test("legacy projections read as identical display and context", () => {
  const messages = [text("u1", "user", "hi")];

  assert.deepEqual(readProjection(messages), {
    version: 1,
    display: messages,
    context: messages,
  });
  assert.deepEqual(readProjection(writeProjection({ display: messages, context: [] }, 3)), {
    version: 1,
    display: messages,
    context: [],
    committedRevision: 3,
  });
  assert.throws(() => readProjection({ version: 2, display: [], context: [] }), /Unsupported/);
  assert.throws(() => readProjection({ version: 1, display: [] }), /Unsupported/);
});
