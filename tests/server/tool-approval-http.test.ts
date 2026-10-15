import assert from "node:assert/strict";
import { test } from "node:test";
import chat from "../../server/chat";

const id = "6f1c1a52-58f4-4b8e-9c7d-1a2b3c4d5e6f";
const decision = {
  threadId: "d08035f1-07df-49f3-b2d0-5cf5cb2b1e74",
  digest: "a".repeat(64),
  tool: "jira_add_comment",
  approved: true,
};

function post(headers: Record<string, string>, body: unknown = decision, approval = id) {
  return chat.request(`http://localhost/approvals/${approval}/decision`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

test("a decision needs the approval header", async () => {
  const response = await post({ "Sec-Fetch-Site": "same-origin" });
  assert.equal(response.status, 409);
});

test("a decision from another site is refused", async () => {
  for (const headers of [
    { "X-Tool-Approval": "1", Origin: "https://evil.example" } as Record<string, string>,
    { "X-Tool-Approval": "1", Origin: "https://evil.example", "Sec-Fetch-Site": "cross-site" },
    { "X-Tool-Approval": "1" },
  ]) {
    const response = await post(headers);
    assert.equal(response.status, 409, JSON.stringify(headers));
  }
});

test("a decision cannot carry comment arguments or target a malformed id", async () => {
  const headers = { "X-Tool-Approval": "1", "Sec-Fetch-Site": "same-origin" };

  for (const extra of [{ body: "changed" }, { arguments: {} }, { visibility: "x" }]) {
    const response = await post(headers, { ...decision, ...extra });
    assert.equal(response.status, 400, JSON.stringify(extra));
  }

  const malformed = await post({ ...headers, Origin: "http://localhost" }, decision, "not-a-uuid");
  assert.equal(malformed.status, 400);
});
