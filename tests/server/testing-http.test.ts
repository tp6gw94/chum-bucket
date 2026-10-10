import assert from "node:assert/strict";
import { test } from "node:test";
import app from "../../server/testing";

for (const body of ["{}", "null", "{", JSON.stringify({ threadId: "invalid", unexpected: true })]) {
  test(`the original request entry rejects ${body} with 400`, async () => {
    const response = await app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: "Invalid testing request" });
  });
}

for (const body of ["{}", "{", JSON.stringify({ threadId: "invalid", unexpected: true })]) {
  test(`the original cancellation entry rejects ${body} with 400`, async () => {
    const response = await app.request("/run/cancel", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: "Invalid testing cancellation" });
  });
}

test("the original read entry requires its threadId query selector", async () => {
  const response = await app.request("/run");
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "Invalid testing read" });
});

test("a boundary refactor does not introduce replacement HTTP paths", async () => {
  const request = await app.request("/testing/requests", { method: "POST", body: "{}" });
  const read = await app.request("/threads/thread/testing/run");
  assert.equal(request.status, 404);
  assert.equal(read.status, 404);
});
