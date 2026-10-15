import assert from "node:assert/strict";
import { test } from "node:test";
import { compactionEvent, parseCompactionEvent } from "../../shared/compaction-event";

test("compaction events round-trip and reject other custom events", () => {
  const event = compactionEvent({
    runId: "r",
    operationId: "r/compact/0",
    state: "done",
    reason: "manual",
  });
  assert.equal(event.name, "context-compaction");
  assert.deepEqual(parseCompactionEvent(JSON.parse(JSON.stringify(event))), {
    runId: "r",
    operationId: "r/compact/0",
    state: "done",
    reason: "manual",
  });
  assert.equal(parseCompactionEvent({ ...event, name: "code_mode:console" }), null);
  assert.equal(parseCompactionEvent({ ...event, value: { ...event.value, state: "maybe" } }), null);
  assert.equal(parseCompactionEvent(null), null);
  assert.throws(() =>
    compactionEvent({ runId: "", operationId: "x", state: "done", reason: "manual" }),
  );
});
