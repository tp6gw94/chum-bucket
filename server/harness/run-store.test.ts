import assert from "node:assert/strict";
import { test } from "node:test";
import type { UIMessage } from "@tanstack/ai";
import { nextThreadTitle } from "./run-store";

function request(id: string, content: string): UIMessage {
  return { id, role: "user", parts: [{ type: "text", content }] };
}

function summary(id: string): UIMessage {
  return {
    id,
    role: "user",
    parts: [{ type: "text", content: "舊摘要" }],
    metadata: { fromSummary: true },
  };
}

test("a saved title survives runs whose accepted history lost the original request", () => {
  const accepted = [summary("summary"), request("u2", "第二個問題")];
  assert.equal(
    nextThreadTitle({ current: "第一個問題", history: accepted, accepted }),
    "第一個問題",
  );
});

test("the first successful run derives the title from the accepted original request", () => {
  assert.equal(
    nextThreadTitle({
      current: "新對話",
      history: [],
      accepted: [request("u1", "第一個問題")],
    }),
    "第一個問題",
  );
});

test("derivation skips summary messages and falls back when nothing remains", () => {
  assert.equal(
    nextThreadTitle({ current: "新對話", history: [], accepted: [summary("summary")] }),
    "新對話",
  );
});

test("an empty saved title is derived again", () => {
  assert.equal(
    nextThreadTitle({
      current: "",
      history: [request("u2", "第二個問題")],
      accepted: [request("u1", "第一個問題")],
    }),
    "第一個問題",
  );
});
