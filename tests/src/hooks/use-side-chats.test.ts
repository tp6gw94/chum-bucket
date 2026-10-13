import assert from "node:assert/strict";
import { test, mock } from "node:test";
import { sideRequest } from "../../../src/hooks/use-side-chats";

test("side commands post JSON to the side chat API and return the response body", async () => {
  const calls: Array<{ url: string; body: string }> = [];
  const transport = mock.method(globalThis, "fetch", async (url: unknown, init?: RequestInit) => {
    calls.push({ url: String(url), body: String(init?.body) });

    return Response.json({ runId: "side-child" });
  });

  try {
    assert.deepEqual(
      await sideRequest("/child/transfer", {
        method: "POST",
        body: JSON.stringify({ text: "edited draft" }),
      }),
      { runId: "side-child" },
    );
    assert.deepEqual(calls, [
      { url: "/api/side-chat/child/transfer", body: '{"text":"edited draft"}' },
    ]);
  } finally {
    transport.mock.restore();
  }
});

test("failed side commands keep the draft and report why", async () => {
  for (const [status, message] of [
    [409, /對話忙碌或已關閉，草稿已保留/],
    [503, /HTTP 503.*草稿已保留/],
  ] as const) {
    const transport = mock.method(globalThis, "fetch", async () =>
      Response.json({ error: "failed" }, { status }),
    );

    try {
      await assert.rejects(sideRequest("/child/transfer", { method: "POST" }), message);
    } finally {
      transport.mock.restore();
    }
  }
});
