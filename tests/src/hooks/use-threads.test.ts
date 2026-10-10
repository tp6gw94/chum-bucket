import assert from "node:assert/strict";
import { test, mock } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { ChatClient } from "@tanstack/ai-react";
import { fetchServerSentEvents } from "@tanstack/ai-react";
import { EventType, uiMessagesToWire, type StreamChunk } from "@tanstack/ai";
import { createThread, terminalResult } from "../../../src/hooks/use-threads";

const threadId = "d08035f1-07df-49f3-b2d0-5cf5cb2b1e74";
const runId = "run-recovery-test";

async function until(predicate: () => boolean) {
  for (let i = 0; i < 200; i++) {
    if (predicate()) {
      return;
    }

    await delay(5);
  }

  assert.fail("Expected client state was not observed");
}

function eventStream() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let sequence = 0;
  const stream = new ReadableStream<Uint8Array>({
    start(value) {
      controller = value;
    },
  });

  return {
    response: new Response(stream, { headers: { "Content-Type": "text/event-stream" } }),
    emit(event: StreamChunk) {
      controller.enqueue(
        new TextEncoder().encode(`id: ${sequence++}\ndata: ${JSON.stringify(event)}\n\n`),
      );
    },
    close() {
      controller.close();
    },
  };
}

test("creation is empty and never sends chat", async () => {
  const requests: unknown[] = [];
  const mocked = mock.method(
    globalThis,
    "fetch",
    async (_url: string | URL | Request, init?: RequestInit) => {
      requests.push(JSON.parse(String(init?.body)));

      return Response.json({ id: threadId, title: "新對話" });
    },
  );

  try {
    assert.deepEqual(await createThread(), { id: threadId, title: "新對話" });
    assert.deepEqual(requests, [{}]);
  } finally {
    mocked.mock.restore();
  }
});

test("only a matching durable terminal unlocks the current run", () => {
  assert.equal(terminalResult({ type: "RUN_FINISHED", runId }, runId), "succeeded");
  assert.equal(
    terminalResult({ type: "RUN_ERROR", metadata: { tanstack: { runId } } }, runId),
    "failed",
  );

  for (const event of [
    { type: "RUN_FINISHED", runId: "other" },
    { type: "RUN_ERROR" },
    { type: "RUN_FINISHED", runId, finishReason: "tool_calls" },
    { type: "RUN_FINISHED", runId, metadata: { tanstack: { finishReason: "tool_calls" } } },
    { type: "TEXT_MESSAGE_END", runId },
    null,
  ]) {
    assert.equal(terminalResult(event, runId), null);
  }
});

test(
  "server hydration joins live tokens, replaces an attempt, and reloads after detach without cancellation",
  { timeout: 5000 },
  async () => {
    const user = {
      id: "first-user",
      role: "user" as const,
      parts: [{ type: "text" as const, content: "Hello" }],
    };
    const baseline = [user];
    const requests: Array<{ url: URL; method: string }> = [];
    const streams: ReturnType<typeof eventStream>[] = [];
    const signals: AbortSignal[] = [];
    const connection = fetchServerSentEvents("http://offline/api/chat", {
      fetchClient: async (input, init) => {
        const url = new URL(String(input));
        requests.push({ url, method: init?.method ?? "GET" });

        if (!url.searchParams.has("runId")) {
          assert.equal(url.searchParams.get("threadId"), threadId);

          return Response.json({ messages: baseline, activeRun: { runId }, revision: 0 });
        }

        assert.equal(url.searchParams.get("runId"), runId);
        assert.equal(url.searchParams.get("offset"), "-1");
        signals.push(init!.signal!);
        const stream = eventStream();
        streams.push(stream);

        return stream.response;
      },
    });
    const first = new ChatClient({ threadId, persistence: true, connection });
    first.attach();
    let second: ChatClient | undefined;
    const text = (client: ChatClient) =>
      client
        .getMessages()
        .flatMap((message) => message.parts)
        .filter((part) => part.type === "text")
        .map((part) => part.content)
        .join("|");

    try {
      await until(() => streams.length === 1);
      const stream = streams[0]!;
      stream.emit({ type: EventType.RUN_STARTED, threadId, runId });
      stream.emit({ type: EventType.MESSAGES_SNAPSHOT, messages: uiMessagesToWire(baseline) });
      stream.emit({
        type: EventType.TEXT_MESSAGE_START,
        messageId: "attempt-1",
        role: "assistant",
      });
      stream.emit({
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId: "attempt-1",
        delta: "root = Stack(",
      });
      await until(() => text(first).includes("root = Stack("));
      stream.emit({ type: EventType.MESSAGES_SNAPSHOT, messages: uiMessagesToWire(baseline) });
      stream.emit({
        type: EventType.TEXT_MESSAGE_START,
        messageId: "attempt-2",
        role: "assistant",
      });
      stream.emit({
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId: "attempt-2",
        delta: "root = Text(",
      });
      await until(() => text(first) === "Hello|root = Text(");
      assert.deepEqual(
        first.getMessages().map((message) => message.id),
        [user.id, "attempt-2"],
      );
      first.detach();
      assert.equal(signals[0]!.aborted, true);
      first.dispose();
      second = new ChatClient({ threadId, persistence: true, connection });
      second.attach();
      await until(() => streams.length === 2);
      const replay = streams[1]!;
      replay.emit({ type: EventType.RUN_STARTED, threadId, runId });
      replay.emit({ type: EventType.MESSAGES_SNAPSHOT, messages: uiMessagesToWire(baseline) });
      replay.emit({
        type: EventType.TEXT_MESSAGE_START,
        messageId: "attempt-2",
        role: "assistant",
      });
      replay.emit({
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId: "attempt-2",
        delta: "root = Text(",
      });
      await until(() => text(second!) === "Hello|root = Text(");
      replay.emit({ type: EventType.TEXT_MESSAGE_CONTENT, messageId: "attempt-2", delta: ")" });
      replay.emit({ type: EventType.TEXT_MESSAGE_END, messageId: "attempt-2" });
      replay.emit({ type: EventType.RUN_FINISHED, threadId, runId });
      replay.close();
      await until(() => text(second!) === "Hello|root = Text()");
      assert.equal(second.getMessages().length, 2);
      assert.ok(requests.every((request) => request.method === "GET"));
    } finally {
      first.dispose();
      second?.dispose();
      streams[0]?.close();
    }
  },
);
