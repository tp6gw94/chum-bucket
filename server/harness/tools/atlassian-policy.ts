const DEFAULT_ATLASSIAN_MCP_URL = "http://127.0.0.1:8000/mcp";
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(["127.0.0.1", "[::1]"]);
const ATLASSIAN_CLOUD_HOST = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.atlassian\.net$/;
const JIRA_KEYS = ["JIRA_BASE_URL", "JIRA_EMAIL", "JIRA_API_TOKEN"] as const;

export const ATLASSIAN_TOOLS = Object.freeze([
  "jira_get_issue",
  "jira_search",
  "confluence_get_page",
  "confluence_search",
  "confluence_get_comments",
] as const);

const REQUIRED_ATLASSIAN_TOOLS = Object.freeze(["jira_get_issue", "confluence_get_page"] as const);

export class AtlassianConfigError extends Error {
  override name = "AtlassianConfigError";
}

export type AtlassianPolicy =
  | { readonly enabled: false }
  | {
      readonly enabled: true;
      readonly endpoint: string;
      readonly siteUrl: string;
      readonly confluenceUrl: string;
      readonly email: string;
      readonly apiToken: string;
    };

type Env = Readonly<Record<string, string | undefined>>;

type DiscoveredTool = { readonly metadata: { readonly mcp: { readonly serverToolName: string } } };

const DISABLED: AtlassianPolicy = Object.freeze({ enabled: false });

function parseUrl(raw: string, key: string): URL {
  if (!URL.canParse(raw)) {
    throw new AtlassianConfigError(`${key} 不是有效的 URL`);
  }

  const url = new URL(raw);

  if (url.username || url.password) {
    throw new AtlassianConfigError(`${key} 不可包含帳密`);
  }

  if (raw.includes("?") || raw.includes("#")) {
    throw new AtlassianConfigError(`${key} 不可包含 query 或 fragment`);
  }

  return url;
}

function parseSiteUrl(raw: string): string {
  const url = parseUrl(raw, "JIRA_BASE_URL");

  if (url.protocol !== "https:" || url.port || !ATLASSIAN_CLOUD_HOST.test(url.hostname)) {
    throw new AtlassianConfigError("JIRA_BASE_URL 必須是 https://your-site.atlassian.net");
  }

  if (url.pathname.startsWith("/wiki")) {
    throw new AtlassianConfigError("JIRA_BASE_URL 不可包含 /wiki");
  }

  if (url.pathname !== "/") {
    throw new AtlassianConfigError("JIRA_BASE_URL 只能是站點根網址");
  }

  return url.origin;
}

function parseEndpoint(raw: string): string {
  const url = parseUrl(raw, "ATLASSIAN_MCP_URL");

  if (url.protocol !== "http:" || !LOOPBACK_HOSTS.has(url.hostname)) {
    throw new AtlassianConfigError("ATLASSIAN_MCP_URL 只接受 http://127.0.0.1 或 http://[::1]");
  }

  return url.href;
}

function read(env: Env, key: string): string {
  return env[key]?.trim() ?? "";
}

export function loadAtlassianPolicy(env: Env = process.env): AtlassianPolicy {
  const missing = JIRA_KEYS.filter((key) => !read(env, key));
  const mcpUrl = read(env, "ATLASSIAN_MCP_URL");

  if (missing.length === JIRA_KEYS.length) {
    if (mcpUrl) {
      throw new AtlassianConfigError(`已設定 ATLASSIAN_MCP_URL，但缺少 ${JIRA_KEYS.join("、")}`);
    }

    return DISABLED;
  }

  if (missing.length > 0) {
    throw new AtlassianConfigError(`Jira 設定不完整，缺少 ${missing.join("、")}`);
  }

  const siteUrl = parseSiteUrl(read(env, "JIRA_BASE_URL"));

  return Object.freeze({
    enabled: true,
    endpoint: parseEndpoint(mcpUrl || DEFAULT_ATLASSIAN_MCP_URL),
    siteUrl,
    confluenceUrl: `${siteUrl}/wiki`,
    email: read(env, "JIRA_EMAIL"),
    apiToken: read(env, "JIRA_API_TOKEN"),
  });
}

export function pickAtlassianTools<T extends DiscoveredTool>(discovered: readonly T[]): T[] {
  const allowed: ReadonlySet<string> = new Set(ATLASSIAN_TOOLS);
  const picked = discovered.filter((tool) => allowed.has(tool.metadata.mcp.serverToolName));
  const names = new Set(picked.map((tool) => tool.metadata.mcp.serverToolName));
  const missing = REQUIRED_ATLASSIAN_TOOLS.filter((name) => !names.has(name));

  if (missing.length > 0) {
    throw new AtlassianConfigError(`Atlassian MCP 缺少必要工具：${missing.join("、")}`);
  }

  return picked;
}
