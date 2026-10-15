import assert from "node:assert/strict";
import { test } from "node:test";
import type { StreamChunk } from "@tanstack/ai";
import { createToolEventBuffer, persistToolEvents } from "../../../server/harness/tool-events";

test("events keep their order and carry the parent tool call id and sequence", () => {
  const buffer = createToolEventBuffer("call-7");
  buffer.emit("code_mode:execution_started", { sourceBytes: 3 });
  buffer.emit("code_mode:execution_finished", { success: true });
  const events = buffer.close();
  assert.deepEqual(
    events.map((event) => [
      event.type,
      "name" in event ? event.name : undefined,
      "value" in event ? event.value : undefined,
    ]),
    [
      [
        "CUSTOM",
        "code_mode:execution_started",
        { sourceBytes: 3, parentToolCallId: "call-7", sequence: 0 },
      ],
      [
        "CUSTOM",
        "code_mode:execution_finished",
        { success: true, parentToolCallId: "call-7", sequence: 1 },
      ],
    ],
  );
});

test("the buffer stops accepting events past its count or byte budget and after close", () => {
  const counted = createToolEventBuffer("call", { maxEvents: 2, maxBytes: 65_536 });

  for (let index = 0; index < 5; index++) {
    counted.emit("event", { index });
  }

  assert.equal(counted.close().length, 2);

  const sized = createToolEventBuffer("call", { maxEvents: 100, maxBytes: 400 });
  sized.emit("small", { a: 1 });
  sized.emit("large", { text: "x".repeat(500) });
  sized.emit("small", { a: 2 });
  assert.deepEqual(
    sized.close().map((event) => ("name" in event ? event.name : undefined)),
    ["small"],
  );

  const closed = createToolEventBuffer("call");
  closed.emit("before", {});
  assert.equal(closed.close().length, 1);
  closed.emit("late", {});
  assert.deepEqual(closed.close(), []);
});

test("a storage failure stops saving the remaining events", async () => {
  const buffer = createToolEventBuffer("call");

  for (const name of ["one", "two", "three"]) {
    buffer.emit(name, {});
  }

  const saved: string[] = [];
  await assert.rejects(
    persistToolEvents(buffer.close(), async (event: StreamChunk) => {
      const name = "name" in event ? String(event.name) : "";

      if (name === "two") {
        throw new Error("storage failed");
      }

      saved.push(name);
    }),
    /storage failed/,
  );
  assert.deepEqual(saved, ["one"]);
});
