import assert from "node:assert/strict";
import { test } from "node:test";
import { EventType } from "@tanstack/ai";
import { compactionEvent, parseCompactionEvent } from "./compaction-event";

test("a compaction event round-trips with its run and operation identity", () => {
  const event = compactionEvent({
    runId: "run-1",
    operationId: "run-1/compact/0",
    state: "started",
  });
  assert.equal(event.type, EventType.CUSTOM);
  assert.deepEqual(parseCompactionEvent(event), {
    runId: "run-1",
    operationId: "run-1/compact/0",
    state: "started",
  });
});

test("unrelated and malformed chunks are ignored", () => {
  assert.equal(parseCompactionEvent({ type: EventType.RUN_FINISHED, runId: "run-1" }), null);
  assert.equal(
    parseCompactionEvent({
      type: EventType.CUSTOM,
      name: "other",
      value: { runId: "run-1", operationId: "run-1/compact/0", state: "started" },
    }),
    null,
  );
  assert.equal(
    parseCompactionEvent({
      type: EventType.CUSTOM,
      name: "context-compaction",
      value: { runId: "run-1", operationId: "run-1/compact/0", state: "unknown" },
    }),
    null,
  );
});
