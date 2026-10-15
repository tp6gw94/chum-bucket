import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type { StreamChunk } from "@tanstack/ai";
import { createToolEvents, droppedToolEventsName } from "../../../server/harness/tool-events";

function custom(event: StreamChunk) {
  assert.equal(event.type, "CUSTOM");
  return { name: event.name, value: event.value };
}

test("custom events are appended one at a time in emission order", async () => {
  const stored: StreamChunk[] = [];
  let active = 0;
  const events = createToolEvents(
    async (event) => {
      active++;
      assert.equal(active, 1);
      await delay(stored.length % 2 ? 1 : 5);
      stored.push(event);
      active--;
    },
    { maxEvents: 10, maxEventBytes: 1_000 },
  );

  for (let index = 0; index < 4; index++) {
    events.emitCustomEvent("step", { index });
  }
  await events.flush();

  assert.deepEqual(
    stored.map(custom),
    [0, 1, 2, 3].map((index) => ({ name: "step", value: { index } })),
  );
});

test("count and size limits drop or replace events and late events are ignored", async () => {
  const stored: StreamChunk[] = [];
  const events = createToolEvents(
    async (event) => {
      stored.push(event);
    },
    { maxEvents: 2, maxEventBytes: 40 },
  );

  events.emitCustomEvent("small", { ok: true, skipped: undefined });
  events.emitCustomEvent("large", { text: "x".repeat(100) });
  events.emitCustomEvent("over", { index: 3 });
  events.emitCustomEvent("over", { index: 4 });
  await events.flush();
  events.emitCustomEvent("late", { index: 5 });
  await events.flush();

  assert.deepEqual(stored.map(custom), [
    { name: "small", value: { ok: true } },
    { name: "large", value: { omitted: true, reason: "too_large", bytes: 111 } },
    { name: droppedToolEventsName, value: { dropped: 2 } },
  ]);
});

test("storage failures stop later appends and surface when the step flushes", async () => {
  const stored: string[] = [];
  const events = createToolEvents(
    async (event) => {
      const { name } = custom(event);
      if (name === "fail") {
        throw new Error("Database unavailable");
      }
      stored.push(name);
    },
    { maxEvents: 10, maxEventBytes: 1_000 },
  );

  events.emitCustomEvent("first", {});
  events.emitCustomEvent("fail", {});
  events.emitCustomEvent("after", {});
  await delay(10);
  await assert.rejects(events.flush(), /Database unavailable/);
  assert.deepEqual(stored, ["first"]);
});
