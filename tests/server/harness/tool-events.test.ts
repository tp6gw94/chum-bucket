import assert from "node:assert/strict";
import { test } from "node:test";
import { EventType, type StreamChunk } from "@tanstack/ai";
import {
  createToolEventBuffer,
  drainToolEvents,
  maxToolEvents,
} from "../../../server/harness/tool-events";

const customEvents = (events: readonly StreamChunk[]) =>
  events.flatMap((event) => (event.type === EventType.CUSTOM ? [event] : []));

test("buffered tool events persist in call order with the parent identifier", async () => {
  const buffer = createToolEventBuffer("call-7");
  buffer.emit("code_mode:execution_started", { codeLength: 12 });
  buffer.emit("code_mode:external_call", { function: "read", argumentBytes: 3 });
  buffer.emit("code_mode:execution_finished", { phase: "execute", success: true });
  const persisted: StreamChunk[] = [];
  await drainToolEvents(buffer, async (event) => {
    persisted.push(event);
  });
  assert.deepEqual(
    customEvents(persisted).map((event) => event.name),
    ["code_mode:execution_started", "code_mode:external_call", "code_mode:execution_finished"],
  );
  assert.deepEqual(
    customEvents(persisted).map((event) => event.metadata?.tanstack),
    [
      { toolCallId: "call-7", toolEvent: 0 },
      { toolCallId: "call-7", toolEvent: 1 },
      { toolCallId: "call-7", toolEvent: 2 },
    ],
  );
});

test("closed tool event buffers ignore late callbacks", () => {
  const buffer = createToolEventBuffer("call-8");
  buffer.emit("code_mode:execution_started", { codeLength: 1 });
  buffer.close();
  buffer.emit("code_mode:console", { level: "log", byteLength: 9 });
  assert.deepEqual(
    customEvents(buffer.drain()).map((event) => event.name),
    ["code_mode:execution_started"],
  );
});

test("tool event overflow rejects the callback and stops buffering", () => {
  const buffer = createToolEventBuffer("call-9");

  for (let index = 0; index < maxToolEvents; index++) {
    buffer.emit("code_mode:console", { level: "log", byteLength: index });
  }

  assert.throws(
    () => buffer.emit("code_mode:console", { level: "log", byteLength: 0 }),
    /exceeded their bound/,
  );
  assert.equal(buffer.drain().length, maxToolEvents);
  assert.deepEqual(buffer.drain(), []);
});

test("a failed persist surfaces the failure and stops draining later events", async () => {
  const buffer = createToolEventBuffer("call-10");
  buffer.emit("code_mode:execution_started", { codeLength: 1 });
  buffer.emit("code_mode:execution_finished", { phase: "execute", success: true });
  const seen: string[] = [];
  await assert.rejects(
    drainToolEvents(buffer, async (event) => {
      seen.push(customEvents([event])[0]!.name);
      throw new Error("store is offline");
    }),
    /store is offline/,
  );
  assert.deepEqual(seen, ["code_mode:execution_started"]);
  assert.deepEqual(buffer.drain(), []);
});
