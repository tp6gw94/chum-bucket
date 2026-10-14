import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { createAtlassianTools } from "./atlassian";
import { loadAtlassianPolicy } from "./atlassian-policy";

const policy = loadAtlassianPolicy({
  JIRA_BASE_URL: "https://acme.atlassian.net",
  JIRA_EMAIL: "dev@acme.com",
  JIRA_API_TOKEN: "token",
});

const tool = (serverToolName: string) => ({
  name: serverToolName,
  metadata: { mcp: { serverToolName } },
});

const fakeClient = (names: string[]) => ({
  tools: mock.fn(async () => names.map(tool)),
  close: mock.fn(async () => {}),
});

type Connect = NonNullable<Parameters<typeof createAtlassianTools>[1]>;

test("disabled policy never connects", async () => {
  const connect = mock.fn<Connect>();

  assert.deepEqual(await createAtlassianTools({ enabled: false }, connect)(), []);
  assert.equal(connect.mock.callCount(), 0);
});

test("connects with the backend policy once and returns only allowlisted tools", async () => {
  const client = fakeClient(["jira_get_issue", "jira_create_issue", "confluence_get_page"]);
  const connect = mock.fn<Connect>(async () => client as never);
  const load = createAtlassianTools(policy, connect);

  const names = (await load()).map((item) => item.name);
  await load();

  assert.deepEqual(names, ["jira_get_issue", "confluence_get_page"]);
  assert.deepEqual(connect.mock.calls[0].arguments, [policy]);
  assert.equal(connect.mock.callCount(), 1);
});

test("connection failures fall back to local tools and retry on the next call", async () => {
  const warn = mock.method(console, "warn", () => {});
  const connect = mock.fn<Connect>(async () => {
    throw new Error("ECONNREFUSED");
  });
  const load = createAtlassianTools(policy, connect);

  try {
    assert.deepEqual(await load(), []);
    connect.mock.mockImplementation(
      async () => fakeClient(["jira_get_issue", "confluence_get_page"]) as never,
    );
    assert.equal((await load()).length, 2);
    assert.equal(connect.mock.callCount(), 2);
    assert.equal(warn.mock.callCount(), 1);
  } finally {
    warn.mock.restore();
  }
});

test("missing required tools falls back and closes the client", async () => {
  const warn = mock.method(console, "warn", () => {});
  const client = fakeClient(["jira_search"]);
  const load = createAtlassianTools(policy, async () => client as never);

  try {
    assert.deepEqual(await load(), []);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(client.close.mock.callCount(), 1);
  } finally {
    warn.mock.restore();
  }
});
