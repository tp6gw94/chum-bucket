import assert from "node:assert/strict";
import { test } from "node:test";
import app from "../../server/side-chat";

test("side chat routes reject invalid thread IDs before touching the database", async () => {
  const create = await app.request("/", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ parentThreadId: "not-a-uuid" }),
  });
  assert.equal(create.status, 400);

  const extra = await app.request("/", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ parentThreadId: crypto.randomUUID(), title: "x" }),
  });
  assert.equal(extra.status, 400);

  assert.equal((await app.request("/")).status, 400);
  assert.equal((await app.request("/?parentThreadId=bad")).status, 400);
  assert.equal((await app.request("/bad", { method: "DELETE" })).status, 400);
});
