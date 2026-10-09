import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { read } from "./fs";

test("native file reading has a terminable cancellation boundary and retains its normal result", async () => {
  const dir = await mkdtemp(join(tmpdir(), "side-read-"));
  const path = join(dir, "input.txt");
  await writeFile(path, "original file text");
  try {
    const controller = new AbortController();
    const pending = read.execute!(
      { path },
      { toolCallId: "cancel-read", abortSignal: controller.signal, emitCustomEvent: () => {} },
    );
    controller.abort();
    await assert.rejects(Promise.resolve(pending), /cancelled|aborted/);
    const result = await read.execute!(
      { path },
      { toolCallId: "normal-read", emitCustomEvent: () => {} },
    );
    assert.match(JSON.stringify(result), /original file text/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
