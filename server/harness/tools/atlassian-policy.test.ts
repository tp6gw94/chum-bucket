import assert from "node:assert/strict";
import { test } from "node:test";
import {
  AtlassianConfigError,
  ATLASSIAN_TOOLS,
  loadAtlassianPolicy,
  pickAtlassianTools,
} from "./atlassian-policy";

const jira = {
  JIRA_BASE_URL: "https://acme.atlassian.net/",
  JIRA_EMAIL: "dev@acme.com",
  JIRA_API_TOKEN: "token",
};

test("all Jira fields empty disables Atlassian and keeps only local tools", () => {
  assert.deepEqual(loadAtlassianPolicy({}), { enabled: false });
  assert.deepEqual(loadAtlassianPolicy({ JIRA_BASE_URL: " ", JIRA_EMAIL: "" }), { enabled: false });
});

test("partial Jira config or MCP URL without Jira is a config error", () => {
  assert.throws(() => loadAtlassianPolicy({ JIRA_EMAIL: "dev@acme.com" }), AtlassianConfigError);
  assert.throws(
    () => loadAtlassianPolicy({ ATLASSIAN_MCP_URL: "http://127.0.0.1:8000/mcp" }),
    AtlassianConfigError,
  );
});

test("full config resolves a frozen policy on the default loopback endpoint", () => {
  const policy = loadAtlassianPolicy(jira);

  assert.deepEqual(policy, {
    enabled: true,
    endpoint: "http://127.0.0.1:8000/mcp",
    siteUrl: "https://acme.atlassian.net",
    confluenceUrl: "https://acme.atlassian.net/wiki",
    email: "dev@acme.com",
    apiToken: "token",
  });
  assert.ok(Object.isFrozen(policy));
  assert.ok(Object.isFrozen(ATLASSIAN_TOOLS));
  assert.partialDeepStrictEqual(
    loadAtlassianPolicy({ ...jira, ATLASSIAN_MCP_URL: "http://[::1]:9000/mcp" }),
    { endpoint: "http://[::1]:9000/mcp" },
  );
});

test("JIRA_BASE_URL must be a bare Atlassian Cloud site", () => {
  for (const JIRA_BASE_URL of [
    "http://acme.atlassian.net",
    "https://acme.atlassian.net/wiki",
    "https://acme.atlassian.net/jira",
    "https://acme.atlassian.net/?a=1",
    "https://acme.atlassian.net/?",
    "https://acme.atlassian.net/#x",
    "https://user:pass@acme.atlassian.net",
    "https://acme.atlassian.net:8443",
    "https://acme.atlassian.net.evil.com",
    "https://jira.acme.com",
    "not a url",
  ]) {
    assert.throws(
      () => loadAtlassianPolicy({ ...jira, JIRA_BASE_URL }),
      AtlassianConfigError,
      JIRA_BASE_URL,
    );
  }
});

test("ATLASSIAN_MCP_URL must be a plain loopback HTTP URL", () => {
  for (const ATLASSIAN_MCP_URL of [
    "https://127.0.0.1:8000/mcp",
    "http://localhost:8000/mcp",
    "http://10.0.0.5:8000/mcp",
    "http://mcp.example.com/mcp",
    "http://user:pass@127.0.0.1:8000/mcp",
    "http://127.0.0.1:8000/mcp?token=1",
    "http://127.0.0.1:8000/mcp#x",
  ]) {
    assert.throws(
      () => loadAtlassianPolicy({ ...jira, ATLASSIAN_MCP_URL }),
      AtlassianConfigError,
      ATLASSIAN_MCP_URL,
    );
  }
});

const tool = (serverToolName: string) => ({
  name: serverToolName,
  metadata: { mcp: { serverToolName } },
});

test("only allowlisted tools pass and optional ones may be missing", () => {
  const picked = pickAtlassianTools([
    tool("jira_get_issue"),
    tool("jira_create_issue"),
    tool("confluence_get_page"),
    tool("confluence_update_page"),
  ]);

  assert.deepEqual(
    picked.map((item) => item.name),
    ["jira_get_issue", "confluence_get_page"],
  );
});

test("missing required tools is an error", () => {
  assert.throws(
    () => pickAtlassianTools([tool("jira_get_issue"), tool("jira_search")]),
    AtlassianConfigError,
  );
  assert.throws(() => pickAtlassianTools([tool("confluence_get_page")]), AtlassianConfigError);
});
