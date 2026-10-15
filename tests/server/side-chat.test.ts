import assert from "node:assert/strict";
import { test } from "node:test";
import type { UIMessage } from "@tanstack/ai";
import { summaryBatches } from "../../server/side-chat";

test("side chat summaries split long messages into bounded batches", () => {
  const message = (id: string, size: number): UIMessage => ({
    id,
    role: "user",
    parts: [{ type: "text", content: "x".repeat(size) }],
  });
  assert.deepEqual(summaryBatches([]), []);
  const small = summaryBatches([message("a", 10), message("b", 10)]);
  assert.equal(small.length, 1);
  assert.equal(small[0]!.length, 2);

  const batches = summaryBatches([message("big", 130_000)]);
  assert.ok(batches.length >= 3);
  assert.ok(batches.flat().every((fragment) => fragment.length <= 12_000));
  assert.ok(
    batches.every((batch) => batch.reduce((total, part) => total + part.length, 0) <= 60_000),
  );
  assert.equal(batches.flat().join(""), JSON.stringify(message("big", 130_000)));
});
