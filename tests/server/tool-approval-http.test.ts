import assert from "node:assert/strict";
import { test } from "node:test";
import app from "../../server/chat";

const id = "48c8797e-b4d7-4db3-aa7e-87a5a166710c";
const headers = {
  "Content-Type": "application/json",
  "X-Tool-Approval": "1",
  "Sec-Fetch-Site": "same-origin",
  Origin: "http://localhost",
  Referer: "http://localhost/",
};

test("approval commands reject cross-origin and missing approval markers", async () => {
  for (const patch of [
    { "Sec-Fetch-Site": "cross-site", Origin: "", Referer: "" },
    { "Sec-Fetch-Site": "", Origin: "https://foreign.example.test", Referer: "" },
    { "Sec-Fetch-Site": "", Origin: "", Referer: "not a URL" },
    { "X-Tool-Approval": "" },
  ] as Record<string, string>[]) {
    const response = await app.request(`/approvals/${id}/decision`, {
      method: "POST",
      headers: { ...headers, ...patch },
      body: JSON.stringify({
        threadId: id,
        digest: "a".repeat(64),
        tool: "jira_add_comment",
        approved: true,
      }),
    });
    assert.equal(response.status, 409);
  }
});

test("approval commands accept a single practical same-origin signal", async () => {
  for (const patch of [
    { Origin: "http://localhost", "Sec-Fetch-Site": "", Referer: "" },
    { Origin: "", "Sec-Fetch-Site": "same-origin", Referer: "" },
    { Origin: "", "Sec-Fetch-Site": "", Referer: "http://localhost/" },
  ] as Record<string, string>[]) {
    const response = await app.request(`/approvals/${id}/decision`, {
      method: "POST",
      headers: { ...headers, ...patch },
      body: "{}",
    });
    assert.equal(response.status, 400);
  }
});

test("approval command cannot replace the frozen payload or select another tool", async () => {
  for (const extra of [
    { body: "Edited body" },
    { public: false },
    { visibility: "private" },
    { tool: "unknown_tool" },
    { tool: undefined },
    { tool: 7 },
  ]) {
    const response = await app.request(`/approvals/${id}/decision`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        threadId: id,
        digest: "a".repeat(64),
        tool: "jira_add_comment",
        approved: true,
        ...extra,
      }),
    });
    assert.equal(response.status, 400);
  }
});

test("approval command cannot inject arguments through the decision body", async () => {
  const response = await app.request(`/approvals/${id}/decision`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      threadId: id,
      digest: "a".repeat(64),
      tool: "jira_add_comment",
      approved: true,
      arguments: { issue_key: "CHUM-1", body: "injected" },
    }),
  });
  assert.equal(response.status, 400);
});
