import assert from "node:assert/strict";
import { test } from "node:test";
import { compactionEvent } from "../../../shared/compaction-event";
import { compactionNotice, readServerSentEvents } from "../../../src/hooks/use-threads";

test("compaction events map to user-facing notices", () => {
  const event = (state: "started" | "done" | "skipped" | "failed") =>
    compactionEvent({ runId: "r", operationId: "r/compact/0", state, reason: "manual" });
  assert.equal(compactionNotice(event("started")), "started");
  assert.deepEqual(compactionNotice(event("done")), {
    state: "done",
    message: "上下文已整理，完整摘要與原文已保留。",
  });
  assert.match((compactionNotice(event("skipped")) as { message: string }).message, /沒有足夠/);
  assert.match((compactionNotice(event("failed")) as { message: string }).message, /失敗/);
  assert.equal(compactionNotice({ type: "TEXT_MESSAGE_CONTENT" }), null);
});

test("server-sent events are parsed across chunk boundaries", async () => {
  const body = 'id: 0\ndata: {"type":"RUN_STARTED"}\n\nid: 1\ndata: {"type":"CUS';
  const rest = 'TOM","name":"x"}\n\nid: 2\ndata: {"type":"RUN_FINISHED"}\n\n';
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(body));
      controller.enqueue(new TextEncoder().encode(rest));
      controller.close();
    },
  });
  const events: unknown[] = [];
  await readServerSentEvents(new Response(stream), (event) => events.push(event));
  assert.deepEqual(events, [
    { type: "RUN_STARTED" },
    { type: "CUSTOM", name: "x" },
    { type: "RUN_FINISHED" },
  ]);
});
