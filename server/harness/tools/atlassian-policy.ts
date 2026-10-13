import type { JSONSchema } from "@tanstack/ai";

export type ModelToolShape = Readonly<{
  name: string;
  description: string;
  inputSchema: JSONSchema;
}>;

export type Environment = Readonly<Record<string, string | undefined>>;

export const defaultAtlassianEndpoint = "http://127.0.0.1:8000/mcp";
export const discoveryToolName = "discover_atlassian_tools";

export type ToolRoute = "direct" | "codemode";
export type AtlassianToolPolicy = Readonly<{ required: boolean; routes?: readonly ToolRoute[] }>;
export type AtlassianCatalog = ReadonlyMap<string, ModelToolShape>;

export const atlassianTools: ReadonlyMap<string, AtlassianToolPolicy> = new Map([
  ["jira_get_issue", { required: true }],
  ["jira_add_comment", { required: false, routes: ["direct"] }],
  ["jira_search", { required: false }],
  ["confluence_get_page", { required: true }],
  ["confluence_search", { required: false }],
  ["confluence_get_comments", { required: false }],
]);

export const atlassianToolNames: readonly string[] = [...atlassianTools.keys()];

const exposedToolNames = new Set(
  [...atlassianTools]
    .filter(([, policy]) => policy.required || policy.routes?.includes("direct"))
    .map(([name]) => name),
);

export const exposedAtlassianToolNames: readonly string[] = [...exposedToolNames];

export type AtlassianToolFactory = Readonly<{
  names: readonly string[];
  create: (catalog: AtlassianCatalog) => readonly ModelToolShape[];
}>;

export const atlassianToolFactory: AtlassianToolFactory = {
  names: exposedAtlassianToolNames,
  create: (catalog) =>
    [...catalog].filter(([name]) => exposedToolNames.has(name)).map(([, definition]) => definition),
};

export type AtlassianConfiguration =
  | Readonly<{ mode: "local" }>
  | Readonly<{
      mode: "http";
      endpoint: string;
      serviceEnvironment: Readonly<Record<string, string>>;
      secrets: readonly string[];
    }>;

function fail(message: string): never {
  throw new Error(message);
}

function jiraUrl(value: string): URL {
  let url: URL;

  try {
    url = new URL(value);
  } catch {
    return fail("JIRA_BASE_URL must be an HTTPS URL without credentials, query, or fragment");
  }

  if (
    value !== value.trim() ||
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    return fail("JIRA_BASE_URL must be an HTTPS URL without credentials, query, or fragment");
  }

  return url;
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "[::1]"]);
const FORBIDDEN_ENDPOINT_FIELDS = ["username", "password", "search", "hash"] as const;

function endpoint(value: string): string {
  let url: URL;

  try {
    url = new URL(value);
  } catch {
    return fail(
      "ATLASSIAN_MCP_URL must be a loopback HTTP URL without credentials, query, or fragment",
    );
  }

  if (
    value !== value.trim() ||
    /\s/.test(value) ||
    url.protocol !== "http:" ||
    !LOOPBACK_HOSTS.has(url.hostname) ||
    FORBIDDEN_ENDPOINT_FIELDS.some((field) => Boolean(url[field]))
  ) {
    return fail(
      "ATLASSIAN_MCP_URL must be a loopback HTTP URL without credentials, query, or fragment",
    );
  }

  return value;
}

function secretsFor(email: string, token: string): readonly string[] {
  return [
    ...new Set(
      [token, `${email}:${token}`].flatMap((secret) => [
        secret,
        Buffer.from(secret).toString("base64"),
        Buffer.from(secret).toString("base64url"),
        encodeURIComponent(secret),
      ]),
    ),
  ];
}

export function readAtlassianConfiguration(env: Environment): AtlassianConfiguration {
  const baseUrl = env.JIRA_BASE_URL ?? "";
  const email = env.JIRA_EMAIL ?? "";
  const token = env.JIRA_API_TOKEN ?? "";
  const configuredEndpoint = env.ATLASSIAN_MCP_URL ?? "";
  const configured = [baseUrl, email, token].filter(Boolean).length;

  if (configured === 0) {
    if (configuredEndpoint) {
      return fail("ATLASSIAN_MCP_URL requires JIRA_BASE_URL, JIRA_EMAIL, and JIRA_API_TOKEN");
    }

    return { mode: "local" };
  }

  if (configured !== 3) {
    return fail("Configure JIRA_BASE_URL, JIRA_EMAIL, and JIRA_API_TOKEN together");
  }

  const jira = jiraUrl(baseUrl);

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !/^[\x21-\x7e]+$/.test(token)) {
    return fail("JIRA_EMAIL or JIRA_API_TOKEN is invalid; check backend configuration");
  }

  return {
    mode: "http",
    endpoint: configuredEndpoint ? endpoint(configuredEndpoint) : defaultAtlassianEndpoint,
    serviceEnvironment: {
      JIRA_URL: jira.href.replace(/\/+$/, ""),
      JIRA_USERNAME: email,
      JIRA_API_TOKEN: token,
      CONFLUENCE_URL: new URL("/wiki", jira).href,
      CONFLUENCE_USERNAME: email,
      CONFLUENCE_API_TOKEN: token,
      READ_ONLY_MODE: "false",
      ATLASSIAN_RETRY_TOTAL: "0",
      ATLASSIAN_RETRY_INCLUDE_WRITES: "false",
      PYTHON_DOTENV_DISABLED: "1",
      ALLOW_GLOBAL_CRED_FALLBACK: "true",
      TOOLSETS: "jira_issues,jira_comments,confluence_pages,confluence_comments",
      ENABLED_TOOLS: atlassianToolNames.join(","),
    },
    secrets: secretsFor(email, token),
  };
}
