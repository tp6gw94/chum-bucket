import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { ChatClient, fetchServerSentEvents, type UIMessage } from "@tanstack/ai-react";

const threadId = "d08035f1-07df-49f3-b2d0-5cf5cb2b1e74";
const oldMessages: UIMessage[] = [
  { id: "old", role: "user", parts: [{ type: "text", content: "Old history" }] },
];

async function until(predicate: () => boolean) {
  for (let i = 0; i < 200; i++) {
    if (predicate()) {
      return;
    }

    await delay(5);
  }

  assert.fail("Expected client state was not observed");
}

function fixture(initialMessages: UIMessage[] = [], failSend = false, id = threadId) {
  const response = Promise.withResolvers<Response>();
  const requested = Promise.withResolvers<void>();
  const requests: Array<{ method: string; url: string }> = [];
  let hydration!: Promise<unknown>;
  const connection = fetchServerSentEvents("http://offline/api/chat", {
    fetchClient: async (url, init) => {
      const method = init?.method ?? "GET";
      requests.push({ method, url: String(url) });

      if (method === "GET") {
        requested.resolve();

        return (await response.promise).clone();
      }

      if (failSend) {
        return Response.json({ error: "Conflict" }, { status: 409 });
      }

      const body = JSON.parse(String(init?.body));
      const events = [
        { type: "RUN_STARTED", threadId: id, runId: body.runId },
        { type: "TEXT_MESSAGE_START", messageId: "answer", role: "assistant" },
        { type: "TEXT_MESSAGE_CONTENT", messageId: "answer", delta: "New answer" },
        { type: "TEXT_MESSAGE_END", messageId: "answer" },
        { type: "RUN_FINISHED", threadId: id, runId: body.runId },
      ];

      return new Response(
        events.map((event, i) => `id: ${i}\ndata: ${JSON.stringify(event)}\n\n`).join(""),
        { headers: { "Content-Type": "text/event-stream" } },
      );
    },
  });
  const hydrate = connection.hydrate!;
  const client = new ChatClient({
    threadId: id,
    initialMessages,
    persistence: true,
    connection: {
      ...connection,
      hydrate(...args) {
        hydration = hydrate(...args);

        return hydration as ReturnType<typeof hydrate>;
      },
    },
  });

  return {
    client,
    response,
    requested,
    requests,
    get hydration() {
      return hydration;
    },
  };
}

for (const existing of [false, true]) {
  test(`${existing ? "existing thread" : "empty thread"}: hydrate before sending preserves history and new tokens`, async () => {
    const state = fixture(existing ? oldMessages : []);

    try {
      state.client.attach();
      await state.requested.promise;
      assert.equal(state.client.getStatus(), "ready");
      assert.equal(state.client.getIsLoading(), false);
      state.response.resolve(Response.json({ messages: oldMessages, activeRun: null }));
      await state.hydration;
      await until(() => state.client.getMessages()[0]?.id === "old");
      await state.client.sendMessage({ id: "new-user", content: "New question" }, undefined, {
        body: { baseRevision: existing ? 1 : 0 },
      });
      assert.deepEqual(
        state.client.getMessages().map((message) => message.id),
        ["old", "new-user", "answer"],
      );
      assert.equal(state.requests.length, 2);
    } finally {
      state.client.dispose();
    }
  });
}

test("failed submission can be followed by a fresh attachment", async () => {
  const state = fixture([], true);

  try {
    state.client.attach();
    await state.requested.promise;
    state.response.resolve(Response.json({ messages: oldMessages, activeRun: null }));
    await until(() => state.client.getMessages()[0]?.id === "old");
    await state.client.sendMessage("New question", undefined, { body: { baseRevision: 1 } });
    assert.match(state.client.getError()!.message, /409/);
    state.client.detach();
    state.client.attach();
    await until(() => state.client.getMessages().length === 1);
    assert.deepEqual(
      state.client.getMessages().map((message) => message.id),
      ["old"],
    );
  } finally {
    state.client.dispose();
  }
});

test("SDK hydration failure is silent in public chat status and requires application feedback", async () => {
  const state = fixture();

  try {
    state.client.attach();
    await state.requested.promise;
    const rejected = assert.rejects(state.hydration, /Offline/);
    state.response.reject(new Error("Offline"));
    await rejected;
    assert.equal(state.client.getStatus(), "ready");
    assert.equal(state.client.getError(), undefined);
    assert.equal(state.requests.length, 1);
  } finally {
    state.client.dispose();
  }
});

test("a detached document cannot rejoin after its delayed hydration completes", async () => {
  const old = fixture();
  const next = fixture([], false, "7d8b4d7a-7a8f-4dac-a076-7f67a8f6c451");

  try {
    old.client.attach();
    await old.requested.promise;
    old.client.detach();
    next.client.attach();
    await next.requested.promise;
    next.response.resolve(Response.json({ messages: oldMessages, activeRun: null }));
    await until(() => next.client.getMessages()[0]?.id === "old");
    await next.client.sendMessage("New question", undefined, { body: { baseRevision: 0 } });
    old.response.resolve(
      Response.json({ messages: oldMessages, activeRun: { runId: "run-stale" } }),
    );
    await old.hydration;
    await delay(0);
    assert.deepEqual(old.client.getMessages(), []);
    assert.equal(old.requests.length, 1);
    assert.deepEqual(
      next.client.getMessages().map((message) => message.role),
      ["user", "user", "assistant"],
    );
  } finally {
    old.client.dispose();
    next.client.dispose();
  }
});
