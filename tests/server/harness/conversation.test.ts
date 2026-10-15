import assert from "node:assert/strict";
import { test } from "node:test";
import type { UIMessage } from "@tanstack/ai";
import {
  advanceConversation,
  readProjection,
  toProjection,
} from "../../../server/harness/conversation";
import { summaryMessage } from "../../../server/harness/compaction";

const user = (id: string, text: string): UIMessage => ({
  id,
  role: "user",
  parts: [{ type: "text", content: text }],
});

test("new context messages are appended to display while summaries stay out", () => {
  const first = user("u1", "hello");
  const summary = summaryMessage("op", "summary");
  const state = { display: [first], context: [first] };
  const next = advanceConversation(state, [summary, first, user("u2", "next")]);
  assert.deepEqual(
    next.display.map((message) => message.id),
    ["u1", "u2"],
  );
  assert.deepEqual(
    next.context.map((message) => message.id),
    ["summary:op", "u1", "u2"],
  );
  assert.equal(next.context[1], first);
});

test("only the named message is replaced in place", () => {
  const first = user("u1", "hello");
  const answer: UIMessage = { id: "a1", role: "assistant", parts: [] };
  const state = { display: [first, answer], context: [first, answer] };
  const updated: UIMessage = { ...answer, parts: [{ type: "text", content: "done" }] };
  const changedFirst = user("u1", "rewritten");
  const next = advanceConversation(state, [changedFirst, updated], "a1");
  assert.equal(next.display[0], first);
  assert.equal(next.context[0], first);
  assert.deepEqual(next.display[1], updated);
  assert.deepEqual(next.context[1], updated);
});

test("a new message colliding with compacted history is rejected", () => {
  const compacted = user("old", "original text");
  const summary = summaryMessage("op", "summary");
  const state = { display: [compacted, summary], context: [summary] };
  assert.throws(
    () => advanceConversation(state, [summary, user("old", "replacement")]),
    /collides with compacted history/,
  );
});

test("projections read legacy arrays and reject unknown versions", () => {
  const messages = [user("u1", "hello")];
  assert.deepEqual(readProjection(messages), { version: 1, display: messages, context: messages });
  assert.deepEqual(readProjection(toProjection({ display: messages, context: [] }, 3)), {
    version: 1,
    display: messages,
    context: [],
    committedRevision: 3,
  });
  assert.throws(() => readProjection({ version: 2, display: [], context: [] }), /Unsupported/);
  assert.throws(() => readProjection({ version: 1, display: [] }), /Unsupported/);
});
