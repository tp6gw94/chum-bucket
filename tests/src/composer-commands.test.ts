import assert from "node:assert/strict";
import { test } from "node:test";
import {
  commandMenuAction,
  commandRunBody,
  parseComposerCommand,
  suggestCommands,
} from "../../src/composer-commands";
import { readCompactionEvent } from "../../shared/compaction-event";
import { compactionLines, compactionProgress } from "../../src/hooks/use-threads";

test("typing a slash prefix suggests matching commands until the command is complete", () => {
  for (const text of ["/", "/c", " /comp"]) {
    assert.deepEqual(
      suggestCommands(text).map((option) => option.name),
      ["/compact"],
    );
  }
  for (const text of ["", "hi", "/compact", "/compact 保留", "/x", "/c\n"]) {
    assert.deepEqual(suggestCommands(text), []);
  }
});

test("menu keys navigate, pick, and dismiss while shift keeps editor behavior", () => {
  assert.equal(commandMenuAction({ key: "ArrowDown", shiftKey: false }), "next");
  assert.equal(commandMenuAction({ key: "ArrowUp", shiftKey: false }), "previous");
  assert.equal(commandMenuAction({ key: "Enter", shiftKey: false }), "pick");
  assert.equal(commandMenuAction({ key: "Tab", shiftKey: false }), "pick");
  assert.equal(commandMenuAction({ key: "Escape", shiftKey: false }), "dismiss");
  assert.equal(commandMenuAction({ key: "Enter", shiftKey: true }), undefined);
  assert.equal(commandMenuAction({ key: "a", shiftKey: false }), undefined);
});

test("finished compactions leave no progress lines behind", () => {
  const base = { trigger: "manual", tokensBefore: 4000 } as const;

  assert.deepEqual(compactionLines(null), []);
  assert.equal(compactionLines({ phase: "started", ...base }).length, 1);
  assert.deepEqual(
    compactionLines({
      phase: "done",
      ...base,
      tokensAfter: 500,
      summaryMessageId: "s",
      compactedMessages: 3,
    }),
    [],
  );
  assert.deepEqual(compactionLines({ phase: "skipped", ...base, reason: "nothing-to-compact" }), [
    "手動壓縮：目前沒有可壓縮的訊息",
  ]);
});

test("/compact is parsed with optional focus instructions", () => {
  assert.deepEqual(parseComposerCommand("  /compact "), { kind: "compact" });
  assert.deepEqual(parseComposerCommand("/compact 保留檔案路徑\n與決策"), {
    kind: "compact",
    instructions: "保留檔案路徑\n與決策",
  });
  for (const text of ["/compacted", "please /compact", "/usr/bin/env"]) {
    assert.deepEqual(parseComposerCommand(text), { kind: "message", text });
  }
});

test("compact commands become compact run bodies while messages only carry the revision", () => {
  assert.deepEqual(commandRunBody({ kind: "message", text: "Hi" }, 2), { baseRevision: 2 });
  assert.deepEqual(commandRunBody({ kind: "compact" }, 3), { baseRevision: 3, kind: "compact" });
  assert.deepEqual(commandRunBody({ kind: "compact", instructions: "保留決策" }, 4), {
    baseRevision: 4,
    kind: "compact",
    instructions: "保留決策",
  });
});

test("compaction events are read from custom stream chunks and shown as progress", () => {
  const event = {
    phase: "done",
    trigger: "threshold",
    tokensBefore: 120_000,
    tokensAfter: 18_000,
    summaryMessageId: "summary",
    compactedMessages: 12,
  } as const;

  assert.deepEqual(
    readCompactionEvent({ type: "CUSTOM", name: "context-compaction", value: event }),
    event,
  );
  assert.equal(readCompactionEvent({ type: "CUSTOM", name: "other", value: event }), null);
  assert.equal(
    readCompactionEvent({ type: "CUSTOM", name: "context-compaction", value: { phase: "done" } }),
    null,
  );
  assert.equal(
    compactionProgress(event),
    "接近上下文上限：已壓縮 12 則訊息，約 120.0k → 18.0k tokens",
  );
  assert.equal(
    compactionProgress({ phase: "started", trigger: "side-chat", tokensBefore: 900 }),
    "正在摘要主對話（約 900 tokens）…",
  );
});
