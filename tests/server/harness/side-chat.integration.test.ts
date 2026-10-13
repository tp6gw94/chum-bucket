import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test, mock } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { eq } from "drizzle-orm";
import type { UIMessage } from "@tanstack/ai";
import { threadsTable, sideChatsTable, chatRunsTable } from "../../../server/db/schema";
import {
  discardSideChat,
  ensureStarted,
  launchChatRuntime,
  shutdownChatRuntime,
} from "../../../server/harness/run";
import {
  database,
  persistRun,
  finishRun,
  hydrateThread,
  openSideChat,
  readSideTranscript,
  transferSideSummary,
} from "../../../server/harness/run-store";
import { sideTransferRunId } from "../../../shared/side-chat";
import sideChat from "../../../server/side-chat";

const enabled = process.env.SIDE_CHAT_TEST_DATABASE_URL;
const message = (id: string, content: string): UIMessage => ({
  id,
  role: "user",
  parts: [{ type: "text", content }],
});

async function waitFor(predicate: () => Promise<boolean>) {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (await predicate()) {
      return;
    }

    await delay(20);
  }

  throw new Error("Outcome did not settle");
}

test(
  "side chats seed from the parent, hand off one summary, and disappear when closed",
  { skip: !enabled, timeout: 60_000 },
  async (t) => {
    assert.equal(process.env.DATABASE_URL, enabled);
    const db = await database();
    let slow = false;
    let aborted = false;
    const requested: string[] = [];
    const provider = mock.method(globalThis, "fetch", async (_url: unknown, init?: RequestInit) => {
      requested.push(String(init?.body));
      const encoder = new TextEncoder();
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          const chunk = (value: unknown) =>
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(value)}\n\n`));
          chunk({
            id: "provider",
            choices: [{ index: 0, delta: { role: "assistant", content: "附屬結論" } }],
          });

          if (slow) {
            init?.signal?.addEventListener(
              "abort",
              () => {
                aborted = true;
                controller.error(new Error("Cancelled provider"));
              },
              { once: true },
            );

            return;
          }

          chunk({ id: "provider", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
        },
      });

      return new Response(body, { headers: { "Content-Type": "text/event-stream" } });
    });
    await launchChatRuntime();

    async function sideTurn(sideId: string, text: string) {
      const accepted = await persistRun({
        threadId: sideId,
        runId: `side-turn-${randomUUID()}`,
        baseRevision: (await hydrateThread(sideId)).revision,
        message: { id: randomUUID(), text },
      });
      await finishRun(accepted.run.runId, {
        display: [...accepted.run.messages, message(randomUUID(), `${text} 回覆`)],
        context: accepted.run.context,
      });
    }

    try {
      const parentId = randomUUID();
      await db.insert(threadsTable).values({ id: parentId, title: "Parent", messages: [] });
      const base = await persistRun({
        threadId: parentId,
        runId: `base-${randomUUID()}`,
        baseRevision: 0,
        message: { id: "parent-user", text: "PARENT SECRET" },
      });
      const summary: UIMessage = {
        ...message("parent-summary", "PARENT SUMMARY"),
        metadata: { fromSummary: true },
      };
      await finishRun(base.run.runId, {
        display: [...base.run.messages, summary],
        context: [message("parent-summary", "effective parent context")],
      });
      const parent = await hydrateThread(parentId);

      await t.test("a side chat starts from the parent display and compacted context", async () => {
        const side = await openSideChat(parentId);
        const accepted = await persistRun({
          threadId: side.id,
          runId: `seed-${randomUUID()}`,
          baseRevision: 0,
          message: { id: "child-user", text: "CHILD ORIGINAL" },
        });
        assert.deepEqual(accepted.run.messages.slice(0, -1), parent.messages);
        assert.deepEqual(
          accepted.run.context.map((entry) => entry.parts),
          [
            [{ type: "text", content: "effective parent context" }],
            [{ type: "text", content: "CHILD ORIGINAL" }],
          ],
        );
        assert.equal(accepted.run.side, true);
        await finishRun(accepted.run.runId, {
          display: accepted.run.messages,
          context: accepted.run.context,
        });
        assert.deepEqual(
          (await readSideTranscript(side.id)).map((entry) => entry.id),
          ["child-user"],
        );
        assert.deepEqual(await hydrateThread(parentId), parent);
        await assert.rejects(openSideChat(side.id), /Nested/);
        await discardSideChat(side.id);
      });

      await t.test("the summary request carries only the side discussion", async () => {
        const side = await openSideChat(parentId);
        await sideTurn(side.id, "CHILD QUESTION");
        const response = await sideChat.request(`/${side.id}/summary`, { method: "POST" });
        assert.equal(response.status, 200);
        assert.deepEqual(await response.json(), { text: "附屬結論" });
        assert.match(requested.at(-1)!, /CHILD QUESTION/);
        assert.doesNotMatch(requested.at(-1)!, /PARENT SECRET|PARENT SUMMARY/);
        await discardSideChat(side.id);
      });

      await t.test("a busy parent rejects the handoff and keeps the side chat open", async () => {
        const side = await openSideChat(parentId);
        await sideTurn(side.id, "busy check");
        const busy = await persistRun({
          threadId: parentId,
          runId: `busy-${randomUUID()}`,
          baseRevision: parent.revision,
          message: { id: "busy-user", text: "Busy parent" },
        });
        await assert.rejects(transferSideSummary(side.id, "handoff"), /busy/);
        const [row] = await db.select().from(sideChatsTable).where(eq(sideChatsTable.id, side.id));
        assert.equal(row.state, "open");
        await finishRun(busy.run.runId);
        await discardSideChat(side.id);
      });

      await t.test("a handoff becomes one main message and survives retries", async () => {
        const before = await hydrateThread(parentId);
        const side = await openSideChat(parentId);
        await sideTurn(side.id, "handoff question");
        const response = await sideChat.request(`/${side.id}/transfer`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: "Edited handoff" }),
        });
        assert.equal(response.status, 200);
        const runId = sideTransferRunId(side.id);
        assert.deepEqual(await response.json(), { runId });
        await waitFor(async () => (await hydrateThread(parentId)).activeRun === null);
        await waitFor(
          async () =>
            (await db.select().from(sideChatsTable).where(eq(sideChatsTable.id, side.id)))
              .length === 0,
        );
        const replay = await transferSideSummary(side.id, "Edited handoff");
        assert.equal(replay.run.runId, runId);
        assert.equal(replay.pending, false);
        await assert.rejects(transferSideSummary(side.id, "changed"), /already transferred/);
        const main = await hydrateThread(parentId);
        const added = main.messages.slice(before.messages.length);
        assert.deepEqual(
          added.filter((entry) => entry.role === "user").map((entry) => entry.parts),
          [[{ type: "text", content: "Edited handoff" }]],
        );
        assert.ok(requested.some((body) => body.includes("Edited handoff")));
        assert.equal(
          (await db.select().from(threadsTable).where(eq(threadsTable.id, side.id))).length,
          0,
        );
      });

      await t.test("an accepted handoff stays in the main thread when its run fails", async () => {
        const side = await openSideChat(parentId);
        await sideTurn(side.id, "failure question");
        const accepted = await transferSideSummary(side.id, "Durable handoff");
        await finishRun(accepted.run.runId);
        await discardSideChat(side.id);
        const main = await hydrateThread(parentId);
        assert.equal(main.messages.at(-1)?.id, accepted.run.runId);
        assert.deepEqual(main.messages.at(-1)?.parts, [
          { type: "text", content: "Durable handoff" },
        ]);
      });

      await t.test("closing stops the running side turn before deleting it", async () => {
        const side = await openSideChat(parentId);
        slow = true;
        const accepted = await persistRun({
          threadId: side.id,
          runId: `slow-${randomUUID()}`,
          baseRevision: 0,
          message: { id: randomUUID(), text: "long side question" },
        });
        await ensureStarted(accepted.run);
        await waitFor(async () => requested.some((body) => body.includes("long side question")));
        const response = await sideChat.request(`/${side.id}`, { method: "DELETE" });
        assert.equal(response.status, 200);
        assert.equal(aborted, true);
        assert.equal(
          (await db.select().from(sideChatsTable).where(eq(sideChatsTable.id, side.id))).length,
          0,
        );
        assert.equal(
          (await db.select().from(chatRunsTable).where(eq(chatRunsTable.thread_id, side.id)))
            .length,
          0,
        );
        await discardSideChat(side.id);
        slow = false;
      });
    } finally {
      provider.mock.restore();
      await shutdownChatRuntime();
    }
  },
);
