import assert from "node:assert/strict";
import { test } from "node:test";
import app from "../../server/chat";

const url = "http://localhost:3000/approvals/5b0a3c3e-6f3e-8a51-9d6e-0c7f1e2a3b4c/decision";
const decision = {
  threadId: "d08035f1-07df-49f3-b2d0-5cf5cb2b1e74",
  digest: "a".repeat(64),
  tool: "jira_add_comment",
  approved: true,
};

function post(headers: Record<string, string>, body: unknown = decision) {
  return app.request(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

test("approval decisions require the app header and a same-origin request", async () => {
  assert.equal((await post({ "Sec-Fetch-Site": "same-origin" })).status, 409);
  assert.equal(
    (
      await post({
        "X-Tool-Approval": "1",
        Origin: "https://evil.example",
        "Sec-Fetch-Site": "cross-site",
      })
    ).status,
    409,
  );
});

test("approval decisions cannot carry comment content", async () => {
  for (const extra of [
    { body: "changed" },
    { arguments: { issue_key: "PROJ-2" } },
    { visibility: "x" },
  ]) {
    const response = await post(
      { "X-Tool-Approval": "1", "Sec-Fetch-Site": "same-origin" },
      { ...decision, ...extra },
    );
    assert.equal(response.status, 400);
  }
});
