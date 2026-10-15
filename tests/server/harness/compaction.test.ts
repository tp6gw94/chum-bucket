import assert from "node:assert/strict";
import { test } from "node:test";
import type { AdapterYieldChunk, UIMessage } from "@tanstack/ai";
import {
  compactConversation,
  estimateTextTokens,
  seedSideChat,
  selectCut,
  shouldCompact,
} from "../../../server/harness/compaction";
import { projectConversation } from "../../../server/harness/conversation";
import type { ChatStream } from "../../../server/harness/model-turn";

const text = (id: string, role: UIMessage["role"], content: string): UIMessage => ({
  id,
  role,
  parts: [{ type: "text", content }],
});

function summaryStream(reply: string | Error, requests: Parameters<ChatStream>[0][] = []) {
  const stream: ChatStream = async (options) => {
    requests.push(options);
    if (reply instanceof Error) {
      throw reply;
    }
    return (async function* (): AsyncGenerator<AdapterYieldChunk> {
      yield { type: "RUN_STARTED", runId: "summary", threadId: "summary" } as AdapterYieldChunk;
      yield {
        type: "TEXT_MESSAGE_START",
        messageId: "reply",
        role: "assistant",
      } as AdapterYieldChunk;
      yield { type: "TEXT_MESSAGE_CONTENT", messageId: "reply", delta: reply } as AdapterYieldChunk;
      yield { type: "TEXT_MESSAGE_END", messageId: "reply" } as AdapterYieldChunk;
      yield { type: "RUN_FINISHED", runId: "summary", threadId: "summary" } as AdapterYieldChunk;
    })();
  };
  return stream;
}

const history: UIMessage[] = [
  text("u1", "user", "a".repeat(40_000)),
  text("a1", "assistant", "b".repeat(40_000)),
  text("u2", "user", "c".repeat(40_000)),
  text("a2", "assistant", "d".repeat(40_000)),
  text("u3", "user", "Latest request"),
];

test("token estimates count CJK characters individually and ASCII by four", () => {
  assert.equal(estimateTextTokens("abcdefgh"), 2);
  assert.equal(estimateTextTokens("壓縮對話"), 4);
  assert.equal(shouldCompact([text("u", "user", "short")], "prompt"), false);
  assert.equal(shouldCompact([text("u", "user", "x".repeat(500_000))], "prompt"), true);
});

test("the cut keeps recent messages worth at least the requested budget", () => {
  assert.equal(selectCut(history, 0), 5);
  assert.equal(selectCut(history, 1), 4);
  assert.equal(selectCut(history, 15_000), 2);
  assert.equal(selectCut(history, 1_000_000), undefined);
  const summarized = [{ ...text("s", "user", "Summary"), metadata: { fromSummary: true } }];
  assert.equal(selectCut(summarized, 0), undefined);
});

test("a threshold compaction summarizes old messages and anchors the context at the summary", async () => {
  const requests: Parameters<ChatStream>[0][] = [];
  const result = await compactConversation({
    conversation: { display: history, context: history },
    trigger: "threshold",
    summaryId: "summary-1",
    model: "offline",
    chatStream: summaryStream("## Goal\nShip it", requests),
  });

  assert.equal(result.status, "done");
  assert.ok(result.status === "done");
  assert.deepEqual(
    result.conversation.display.map((message) => message.id),
    ["u1", "a1", "summary-1", "u2", "a2", "u3"],
  );
  assert.deepEqual(
    result.conversation.context.map((message) => message.id),
    ["summary-1", "u2", "a2", "u3"],
  );
  assert.equal(result.conversation.context[0]!.metadata?.fromSummary, true);
  assert.match(JSON.stringify(result.conversation.context[0]), /Ship it/);
  assert.deepEqual(projectConversation(result.conversation).contextAnchor, "summary-1");
  assert.equal(result.event.compactedMessages, 2);
  assert.ok(result.event.tokensAfter < result.event.tokensBefore);
  assert.deepEqual(requests[0]!.tools, []);
  assert.match(JSON.stringify(requests[0]!.messages), /\[User\]: a{100}/);
});

test("a repeated compaction merges the previous summary instead of re-summarizing it", async () => {
  const first = await compactConversation({
    conversation: { display: history, context: history },
    trigger: "manual",
    summaryId: "summary-1",
    model: "offline",
    chatStream: summaryStream("First summary"),
  });
  assert.ok(first.status === "done");
  const next = {
    display: [...first.conversation.display, text("u4", "user", "Follow-up")],
    context: [...first.conversation.context, text("u4", "user", "Follow-up")],
  };
  const requests: Parameters<ChatStream>[0][] = [];
  const second = await compactConversation({
    conversation: next,
    trigger: "manual",
    summaryId: "summary-2",
    model: "offline",
    chatStream: summaryStream("Second summary", requests),
    instructions: "Focus on the follow-up",
  });

  assert.ok(second.status === "done");
  const prompt = JSON.stringify(requests[0]!.messages);
  assert.match(prompt, /<previous-summary>/);
  assert.match(prompt, /First summary/);
  assert.match(prompt, /Focus on the follow-up/);
  assert.deepEqual(
    second.conversation.display.map((message) => message.id),
    ["u1", "a1", "u2", "a2", "u3", "summary-1", "u4", "summary-2"],
  );
  assert.deepEqual(
    second.conversation.context.map((message) => message.id),
    ["summary-2"],
  );
});

test("compaction reports skipped and failed results without throwing", async () => {
  const skipped = await compactConversation({
    conversation: { display: [], context: [] },
    trigger: "manual",
    summaryId: "unused",
    model: "offline",
    chatStream: summaryStream("unused"),
  });
  assert.equal(skipped.status, "skipped");

  const failed = await compactConversation({
    conversation: { display: history, context: history },
    trigger: "overflow",
    summaryId: "unused",
    model: "offline",
    chatStream: summaryStream(new Error("Summary provider unavailable")),
  });
  assert.ok(failed.status === "failed");
  assert.equal(failed.event.error, "Summary provider unavailable");
});

test("a side chat starts with a summary of the parent context", async () => {
  const user = text("side-user", "user", "What did we decide?");
  const requests: Parameters<ChatStream>[0][] = [];
  const result = await seedSideChat({
    conversation: { display: [user], context: [user] },
    parentContext: history,
    summaryId: "side-summary",
    model: "offline",
    chatStream: summaryStream("Parent summary", requests),
  });

  assert.ok(result.status === "done");
  assert.equal(result.event.trigger, "side-chat");
  assert.deepEqual(
    result.conversation.context.map((message) => message.id),
    ["side-summary", "side-user"],
  );
  assert.deepEqual(projectConversation(result.conversation).contextAnchor, "side-summary");
  assert.match(requests[0]!.systemPrompts[0]!, /side chat/);
});
