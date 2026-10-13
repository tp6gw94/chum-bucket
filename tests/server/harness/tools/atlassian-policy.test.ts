import assert from "node:assert/strict";
import { test } from "node:test";
import {
  atlassianToolNames,
  defaultAtlassianEndpoint,
  readAtlassianConfiguration,
} from "../../../../server/harness/tools/atlassian-policy";

const full = {
  JIRA_BASE_URL: "https://offline.atlassian.net",
  JIRA_EMAIL: "mcp-test@example.invalid",
  JIRA_API_TOKEN: "offline-atlassian-token-7319",
};

test("all empty Jira values select local mode and an empty endpoint keeps it local", () => {
  assert.deepEqual(readAtlassianConfiguration({}), { mode: "local" });
  assert.deepEqual(readAtlassianConfiguration({ ATLASSIAN_MCP_URL: "" }), { mode: "local" });
});

test("endpoint-only or partial Jira configuration fails closed", () => {
  for (const environment of [
    { ATLASSIAN_MCP_URL: defaultAtlassianEndpoint },
    { ...full, JIRA_EMAIL: "", JIRA_API_TOKEN: "" },
    { ...full, JIRA_BASE_URL: "", JIRA_EMAIL: "" },
    { ATLASSIAN_MCP_URL: defaultAtlassianEndpoint, JIRA_BASE_URL: full.JIRA_BASE_URL },
  ]) {
    assert.throws(() => readAtlassianConfiguration(environment), /JIRA_|ATLASSIAN_MCP_URL/);
  }
});

test("malformed Jira credentials fail closed with safe messages", () => {
  for (const environment of [
    { ...full, JIRA_BASE_URL: "http://offline.atlassian.net" },
    {
      ...full,
      JIRA_BASE_URL: `https://${full.JIRA_EMAIL}:${full.JIRA_API_TOKEN}@offline.atlassian.net`,
    },
    { ...full, JIRA_BASE_URL: `${full.JIRA_BASE_URL}?token=${full.JIRA_API_TOKEN}` },
    { ...full, JIRA_BASE_URL: `${full.JIRA_BASE_URL}#${full.JIRA_API_TOKEN}` },
    { ...full, JIRA_EMAIL: "invalid" },
    { ...full, JIRA_API_TOKEN: `${full.JIRA_API_TOKEN}\n` },
  ]) {
    assert.throws(() => readAtlassianConfiguration(environment), /JIRA_/);
  }
});

test("full Jira configuration maps the service environment and derives Confluence from the origin", () => {
  for (const baseUrl of [
    "https://offline.atlassian.net",
    "https://offline.atlassian.net/",
    "https://offline.atlassian.net/jira/",
    "https://offline.atlassian.net/wiki/",
  ]) {
    const configuration = readAtlassianConfiguration({ ...full, JIRA_BASE_URL: baseUrl });
    assert.equal(configuration.mode, "http");

    if (configuration.mode !== "http") {
      continue;
    }

    assert.equal(configuration.endpoint, defaultAtlassianEndpoint);
    assert.equal(configuration.serviceEnvironment.JIRA_URL, baseUrl.replace(/\/+$/, ""));
    assert.equal(configuration.serviceEnvironment.JIRA_USERNAME, full.JIRA_EMAIL);
    assert.equal(configuration.serviceEnvironment.JIRA_API_TOKEN, full.JIRA_API_TOKEN);
    assert.equal(
      configuration.serviceEnvironment.CONFLUENCE_URL,
      "https://offline.atlassian.net/wiki",
    );
    assert.equal(configuration.serviceEnvironment.CONFLUENCE_USERNAME, full.JIRA_EMAIL);
    assert.equal(configuration.serviceEnvironment.CONFLUENCE_API_TOKEN, full.JIRA_API_TOKEN);
    assert.equal(configuration.serviceEnvironment.READ_ONLY_MODE, "false");
    assert.equal(configuration.serviceEnvironment.PYTHON_DOTENV_DISABLED, "1");
    assert.equal(configuration.serviceEnvironment.ALLOW_GLOBAL_CRED_FALLBACK, "true");
    assert.equal(
      configuration.serviceEnvironment.TOOLSETS,
      "jira_issues,jira_comments,confluence_pages,confluence_comments",
    );
    assert.equal(configuration.serviceEnvironment.ENABLED_TOOLS, atlassianToolNames.join(","));

    for (const secret of [
      full.JIRA_API_TOKEN,
      `${full.JIRA_EMAIL}:${full.JIRA_API_TOKEN}`,
      Buffer.from(full.JIRA_API_TOKEN).toString("base64"),
      Buffer.from(full.JIRA_API_TOKEN).toString("base64url"),
      encodeURIComponent(full.JIRA_API_TOKEN),
    ]) {
      assert.ok(configuration.secrets.includes(secret));
    }
  }
});

test("endpoint accepts only literal loopback HTTP URLs and defaults to the fixed local service", () => {
  for (const endpoint of [
    "http://127.0.0.1:8123/mcp",
    "http://127.0.0.1:8123/custom/path",
    "http://[::1]:8123/mcp",
  ]) {
    const configuration = readAtlassianConfiguration({ ...full, ATLASSIAN_MCP_URL: endpoint });
    assert.equal(configuration.mode, "http");

    if (configuration.mode === "http") {
      assert.equal(configuration.endpoint, endpoint);
    }
  }

  for (const endpoint of [
    "https://127.0.0.1:8000/mcp",
    "http://localhost:8000/mcp",
    "http://offline.invalid/mcp",
    `http://${full.JIRA_EMAIL}:${full.JIRA_API_TOKEN}@127.0.0.1:8000/mcp`,
    "http://127.0.0.1:8000/mcp?token=unsafe",
    "http://127.0.0.1:8000/mcp#unsafe",
    " http://127.0.0.1:8000/mcp",
  ]) {
    assert.throws(
      () => readAtlassianConfiguration({ ...full, ATLASSIAN_MCP_URL: endpoint }),
      /ATLASSIAN_MCP_URL/,
    );
  }
});

test("policy names the approved comment and five readers", () => {
  assert.deepEqual(atlassianToolNames, [
    "jira_get_issue",
    "jira_add_comment",
    "jira_search",
    "confluence_get_page",
    "confluence_search",
    "confluence_get_comments",
  ]);
  const configuration = readAtlassianConfiguration(full);
  assert.equal(configuration.mode, "http");

  if (configuration.mode === "http") {
    assert.equal(
      configuration.serviceEnvironment.ENABLED_TOOLS,
      "jira_get_issue,jira_add_comment,jira_search,confluence_get_page,confluence_search,confluence_get_comments",
    );
  }
});
