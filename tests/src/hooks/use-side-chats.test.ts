import assert from "node:assert/strict";
import { test, mock } from "node:test";
import { sideRequest } from "../../../src/hooks/use-side-chats";
import {
  isDefinitiveTransferRejection,
  summaryTransferFailure,
  transferReceiptSchema,
  type SummaryTransfer,
} from "@/shared/side-chat";

test("side commands carry a page-memory scope and return the server receipt unchanged", async () => {
  const calls: Array<{ url: string; headers: Headers; body: string }> = [];
  const transport = mock.method(globalThis, "fetch", async (url: unknown, init?: RequestInit) => {
    calls.push({ url: String(url), headers: new Headers(init?.headers), body: String(init?.body) });
    return Response.json({ mainRunId: "accepted-main", messageId: "one-user-message" });
  });
  try {
    assert.deepEqual(
      await sideRequest("/child/transfer", "page-scope", {
        method: "POST",
        body: JSON.stringify({ text: "edited draft", transferKey: "stable-key" }),
      }),
      { mainRunId: "accepted-main", messageId: "one-user-message" },
    );
    assert.equal(calls[0].url, "/api/side-chat/child/transfer");
    assert.equal(calls[0].headers.get("X-Side-Chat-Scope"), "page-scope");
    assert.equal(calls[0].body, '{"text":"edited draft","transferKey":"stable-key"}');
  } finally {
    transport.mock.restore();
  }
});

test("only known transaction rejections unlock a transfer, never network faults, 5xx, or malformed success", async () => {
  const original: SummaryTransfer = {
    kind: "draft",
    draft: {
      id: "6f468531-5da6-4d21-85c9-27c6fd9c40cc",
      sideRevision: 1,
      through: 2,
      text: "原始摘要",
    },
    text: "凍結的回填文字",
    key: "2f7f288b-a1fb-47d2-b24b-075a26835baf",
  };
  for (const outcome of [400, 404, 409, 500, 503, 200, "network", "callback"] as const) {
    const transport = mock.method(globalThis, "fetch", async () => {
      if (outcome === "network") {
        throw new TypeError("Connection lost");
      }
      return Response.json(
        { error: "No valid receipt" },
        {
          status: typeof outcome === "number" ? outcome : 200,
        },
      );
    });
    try {
      let retained = original;
      let rejected = false;
      try {
        const receipt = await sideRequest("/child/transfer", "page-scope", { method: "POST" });
        if (outcome === "callback") {
          throw new TypeError("Callback failed after acceptance");
        }
        transferReceiptSchema.parse(receipt);
        assert.fail("No valid receipt was returned");
      } catch (cause) {
        rejected = isDefinitiveTransferRejection(cause);
        retained = summaryTransferFailure(original, cause);
      }
      const definitive = outcome === 400 || outcome === 404 || outcome === 409;
      assert.equal(rejected, definitive, String(outcome));
      assert.deepEqual(retained, { ...original, kind: definitive ? "draft" : "unresolved" });
    } finally {
      transport.mock.restore();
    }
  }
});

test("busy transfer reports retention instead of pretending to accept", async () => {
  const transport = mock.method(globalThis, "fetch", async () =>
    Response.json({ error: "busy" }, { status: 409 }),
  );
  try {
    await assert.rejects(
      sideRequest("/child/transfer", "page-scope", { method: "POST" }),
      /草稿已保留/,
    );
  } finally {
    transport.mock.restore();
  }
});
