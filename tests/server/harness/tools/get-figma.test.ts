import assert from "node:assert/strict";
import { test } from "node:test";
import { getFigma } from "../../../../server/harness/tools/get-figma";
import { z } from "zod";

test("get_figma fetches bounded design data and reports failures", async () => {
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.FIGMA_API_KEY;
  process.env.FIGMA_API_KEY = "test-key";
  const execute = async (input: { target: string; depth: number; offset: number }) =>
    z
      .object({ truncated: z.boolean(), nodes: z.array(z.record(z.string(), z.unknown())) })
      .passthrough()
      .parse(await getFigma.execute!(input));
  const input = {
    target: "https://www.figma.com/design/abc/Test?node-id=1-2",
    depth: 2,
    offset: 0,
  };
  let document: Record<string, unknown> = {
    id: "1:2",
    name: "Frame",
    type: "FRAME",
    unused: "discard",
    children: [
      { id: "1:3", name: "Text", type: "TEXT", characters: "Hello" },
      { id: "1:4", name: "Hidden", type: "TEXT", visible: false },
    ],
  };

  try {
    globalThis.fetch = async (url, init) => {
      const request = new URL(String(url));
      assert.equal(request.pathname, "/v1/files/abc/nodes");
      assert.equal(request.searchParams.get("ids"), "1:2");
      assert.equal(request.searchParams.get("depth"), "2");
      assert.ok(init?.signal);

      return Response.json({ nodes: { "1:2": { document } } });
    };

    const result = await execute(input);
    assert.equal(result.truncated, false);
    assert.deepEqual(result.nodes, [
      {
        id: "1:2",
        name: "Frame",
        type: "FRAME",
        children: [{ id: "1:3", name: "Text", type: "TEXT", characters: "Hello" }],
      },
    ]);
    document = {
      id: "1:2",
      name: "Large",
      type: "FRAME",
      children: Array.from({ length: 25 }, (_, i) => ({
        id: `2:${i}`,
        name: "界".repeat(1000),
        type: "TEXT",
        characters: "x".repeat(2000),
      })),
    };
    const summary = await execute(input);
    assert.equal(summary.truncated, true);
    assert.equal(summary.nodes.length, 20);
    assert.ok(Buffer.byteLength(JSON.stringify(summary)) <= 30_000);
    const page = await execute({ ...input, offset: 20 });
    assert.equal(page.nodes.length, 6);
    await assert.rejects(
      () => execute({ ...input, target: "https://evil.test/design/abc" }),
      /Figma URL/,
    );
    globalThis.fetch = async () => Response.json({ nodes: { "1:2": null } });
    await assert.rejects(() => execute(input), /not found/);
    globalThis.fetch = async () => new Response("denied", { status: 403 });
    await assert.rejects(() => execute(input), /403/);
    globalThis.fetch = async () =>
      new Response("not json", { headers: { "content-type": "text/html" } });
    await assert.rejects(() => execute(input), /non-JSON/);
  } finally {
    globalThis.fetch = originalFetch;

    if (originalKey === undefined) {
      delete process.env.FIGMA_API_KEY;
    } else {
      process.env.FIGMA_API_KEY = originalKey;
    }
  }
});
