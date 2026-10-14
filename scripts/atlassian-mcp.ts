import "dotenv/config";
import { spawn } from "node:child_process";
import { ATLASSIAN_TOOLS, loadAtlassianPolicy } from "../server/harness/tools/atlassian-policy";

const policy = loadAtlassianPolicy();

if (!policy.enabled) {
  console.log("未設定 Jira，略過 Atlassian MCP server");
  process.exit(0);
}

const endpoint = new URL(policy.endpoint);
const inherited = ["PATH", "HOME", "TMPDIR", "LANG", "UV_CACHE_DIR"].filter(
  (key) => process.env[key],
);

const server = spawn(
  "uvx",
  [
    "mcp-atlassian@0.23.1",
    "--env-file",
    "/dev/null",
    "--transport",
    "streamable-http",
    "--host",
    endpoint.hostname.replace(/^\[(.*)\]$/, "$1"),
    "--port",
    endpoint.port || "80",
    "--path",
    endpoint.pathname,
  ],
  {
    stdio: "inherit",
    env: {
      ...Object.fromEntries(inherited.map((key) => [key, process.env[key]])),
      JIRA_URL: policy.siteUrl,
      JIRA_USERNAME: policy.email,
      JIRA_API_TOKEN: policy.apiToken,
      CONFLUENCE_URL: policy.confluenceUrl,
      CONFLUENCE_USERNAME: policy.email,
      CONFLUENCE_API_TOKEN: policy.apiToken,
      READ_ONLY_MODE: "true",
      TOOLSETS: "all",
      ENABLED_TOOLS: ATLASSIAN_TOOLS.join(","),
    },
  },
);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => server.kill(signal));
}

server.on("error", (error) => {
  console.error(`無法啟動 Atlassian MCP server：${error.message}`);
  process.exit(1);
});

server.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
