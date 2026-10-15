import assert from "node:assert/strict";
import { test } from "node:test";
import type { AdapterYieldChunk } from "@tanstack/ai";
import {
  ContextOverflowError,
  isContextOverflow,
  streamModelTurn,
  throwProviderError,
} from "../../../server/harness/model-turn";

test("provider errors are classified as context overflow only when they mean it", () => {
  for (const error of [
    { code: "context_length_exceeded", message: "too long" },
    { code: "max_context_length_exceeded" },
    { error: { code: "context_window_exceeded" }, message: "x" },
    { status: 400, message: "This model's maximum context length is 131072 tokens." },
    { code: "413", message: "Input exceeds the context window" },
    new Error("maximum context length is 8192 tokens"),
  ]) {
    assert.equal(isContextOverflow(error), true, JSON.stringify(error));
    assert.throws(() => throwProviderError(error), ContextOverflowError);
  }

  for (const error of [
    { status: 429, message: "maximum context length is 10 tokens" },
    { code: "401", message: "unauthorized" },
    { status: 503, message: "upstream" },
    new TypeError("fetch failed"),
    { code: "400", message: "invalid tool schema" },
  ]) {
    assert.equal(isContextOverflow(error), false, JSON.stringify(error));
    assert.throws(
      () => throwProviderError(error),
      (thrown: Error) => !(thrown instanceof ContextOverflowError),
    );
  }
});

test("a streamed RUN_ERROR for overflow becomes ContextOverflowError", async () => {
  const stream = (async function* () {
    yield {
      type: "RUN_ERROR",
      model: "offline",
      timestamp: 0,
      message: "too long",
      code: "context_length_exceeded",
    } as AdapterYieldChunk;
  })();
  await assert.rejects(
    streamModelTurn({ messages: [], stream, append: async () => {} }),
    ContextOverflowError,
  );
});
