import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { setTimeout as delay } from "node:timers/promises";

export const fakeEmail = "mcp-test@example.invalid";
export const fakeToken = "offline-atlassian-token-7319";
export const fakeBaseUrl = "https://offline.atlassian.net";
export const jiraSchema = {
  type: "object" as const,
  properties: {
    issue_key: { type: "string", pattern: "^[A-Z][A-Z0-9_]+-\\d+(?:-\\d+)*$" },
    fields: { type: "string", default: "summary,status" },
    expand: { type: "string", default: null },
    comment_limit: { type: "integer", minimum: 0, maximum: 100, default: 10 },
    update_history: { type: "boolean", default: true },
    include: { type: "string", default: null },
  },
  required: ["issue_key"],
  additionalProperties: false,
};

type WireTool = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
};
export const coreTools: WireTool[] = [
  {
    name: "jira_get_issue",
    description: "Read an issue",
    inputSchema: jiraSchema,
    outputSchema: {
      type: "object",
      properties: { issue: { type: "string" } },
      required: ["issue"],
    },
  },
  {
    name: "confluence_get_page",
    description: "Read Confluence content",
    inputSchema: {
      type: "object",
      properties: { page_id: { type: "string" } },
      required: ["page_id"],
    },
  },
];
export const allTools: WireTool[] = [
  ...coreTools,
  {
    name: "jira_search",
    description: "Search Jira",
    inputSchema: { type: "object", properties: { jql: { type: "string" } }, required: ["jql"] },
  },
  {
    name: "confluence_search",
    description: "Search Confluence",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        limit: { type: "integer", default: 10 },
        spaces_filter: { type: "string", default: null },
      },
      required: ["query"],
    },
  },
  {
    name: "confluence_get_comments",
    description: "Read Confluence comments",
    inputSchema: {
      type: "object",
      properties: { page_id: { type: "string" } },
      required: ["page_id"],
    },
  },
  ...[
    "jira_add_comment",
    "jira_edit_comment",
    "jira_delete_issue",
    "confluence_add_comment",
    "discovery",
    "execute",
    "search",
  ].map((name) => ({
    name,
    description: `Native ${name}`,
    inputSchema: { type: "object", properties: {} },
  })),
];

type FixtureRule = {
  method: string;
  name?: string;
  arguments?: Record<string, unknown>;
  once?: boolean;
  hang?: boolean;
  destroy?: boolean;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
};
type FixtureOptions = {
  pages?: WireTool[][];
  rules?: FixtureRule[];
};
type McpRequest = {
  session: string;
  headers: Record<string, string | string[] | undefined>;
  message: {
    jsonrpc: string;
    id?: number;
    method: string;
    params?: { cursor?: string; name?: string; arguments?: Record<string, unknown> };
  };
  aborted: boolean;
};

export function mcpFixture(options: FixtureOptions = {}) {
  let server: Server | undefined;
  let url: string | undefined;
  let records: McpRequest[] = [];
  let sessions: string[] = [];
  let pending = 0;
  const usedRules = new Set<number>();
  let waiters: { method: string; resolve: () => void }[] = [];

  const finish = (res: ServerResponse, message: { id?: number }, result: unknown) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
  };

  const argumentsMatch = (rule: FixtureRule, message: McpRequest["message"]) =>
    !rule.arguments ||
    Object.entries(rule.arguments).every(
      ([key, value]) => message.params?.arguments?.[key] === value,
    );
  const ruleMatches = (rule: FixtureRule, message: McpRequest["message"]) =>
    rule.method === message.method &&
    (!rule.name || rule.name === message.params?.name) &&
    argumentsMatch(rule, message);
  const matchingRule = (message: McpRequest["message"]): [number, FixtureRule] | undefined => {
    const rules = options.rules ?? [];
    const index = rules.findIndex(
      (rule, index) => !usedRules.has(index) && ruleMatches(rule, message),
    );
    if (index < 0) {
      return undefined;
    }
    return [index, rules[index]!];
  };
  const trackRequest = (record: McpRequest, res: ServerResponse) => {
    records.push(record);
    pending++;
    let settled = false;
    const settle = () => {
      if (!settled) {
        settled = true;
        pending--;
      }
    };
    res.on("close", () => {
      if (!settled) {
        record.aborted = true;
        settle();
      }
    });
    return settle;
  };
  const listToolsResult = (message: McpRequest["message"]) => {
    const pages = options.pages ?? [allTools.slice(0, 2), allTools.slice(2)];
    const page = Number(message.params?.cursor ?? 0);
    return {
      tools: pages[page],
      ...(page + 1 < pages.length ? { nextCursor: String(page + 1) } : {}),
    };
  };
  const toolsCallResult = (message: McpRequest["message"]) => {
    if (message.params?.name === "jira_get_issue") {
      return {
        content: [{ type: "text", text: "Native text fallback" }],
        structuredContent: { issue: message.params.arguments?.issue_key },
      };
    }
    return { content: [{ type: "text", text: "Native tool result" }] };
  };
  const rpcResults = new Map<string, (message: McpRequest["message"]) => unknown>([
    [
      "initialize",
      () => ({
        protocolVersion: "2025-03-26",
        capabilities: { tools: {} },
        serverInfo: { name: "offline-atlassian", version: "0.23.1" },
      }),
    ],
    ["tools/list", listToolsResult],
    ["tools/call", toolsCallResult],
  ]);
  const applyMatchedRule = (
    message: McpRequest["message"],
    res: ServerResponse,
    settle: () => void,
  ) => {
    const match = matchingRule(message);
    if (!match) {
      return false;
    }
    const [index, rule] = match;
    if (rule.once) {
      usedRules.add(index);
    }
    if (rule.hang) {
      return true;
    }
    if (rule.destroy) {
      res.destroy();
      return true;
    }
    if (rule.error) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, error: rule.error }));
      settle();
      return true;
    }
    finish(res, message, rule.result);
    settle();
    return true;
  };
  const handleGet = (req: IncomingMessage, res: ServerResponse) => {
    const stream: McpRequest = {
      session: String(req.headers["mcp-session-id"] ?? ""),
      headers: req.headers,
      message: { jsonrpc: "2.0", method: "sse" },
      aborted: false,
    };
    trackRequest(stream, res);
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  };
  const handlePost = async (req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(chunk as Buffer);
    }
    const message = JSON.parse(Buffer.concat(chunks).toString("utf8")) as McpRequest["message"];
    const record: McpRequest = {
      session: String(req.headers["mcp-session-id"] ?? ""),
      headers: req.headers,
      message,
      aborted: false,
    };
    const settle = trackRequest(record, res);
    for (const waiter of waiters.filter((waiter) => waiter.method === message.method)) {
      waiter.resolve();
    }
    waiters = waiters.filter((waiter) => waiter.method !== message.method);
    if (message.id === undefined) {
      res.writeHead(202).end();
      settle();
      return;
    }
    if (message.method === "initialize") {
      const session = randomUUID();
      sessions.push(session);
      res.setHeader("mcp-session-id", session);
    }
    if (applyMatchedRule(message, res, settle)) {
      return;
    }
    const result = rpcResults.get(message.method)?.(message) ?? {};
    finish(res, message, result);
    settle();
  };
  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    if (req.method === "GET") {
      handleGet(req, res);
      return;
    }
    if (req.method !== "POST") {
      res.writeHead(404).end();
      return;
    }
    await handlePost(req, res);
  };

  return {
    get url() {
      assert.ok(url, "Fixture is not started");
      return url;
    },
    get requests() {
      return records;
    },
    get sessions() {
      return sessions;
    },
    calls(): McpRequest[] {
      return records.filter((record) => record.message.method === "tools/call");
    },
    async start() {
      assert.equal(server, undefined, "Fixture is already started");
      server = createServer((req, res) => {
        void handle(req, res).catch(() => {
          res.destroy();
        });
      });
      await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
      const { port } = server.address() as AddressInfo;
      url = `http://127.0.0.1:${port}/mcp`;
      records = [];
      sessions = [];
      pending = 0;
      usedRules.clear();
      waiters = [];
      return url;
    },
    async stop() {
      const active = server;
      server = undefined;
      url = undefined;
      if (active) {
        active.closeAllConnections();
        await new Promise<void>((resolve) => active.close(() => resolve()));
      }
      pending = 0;
      waiters = [];
    },
    async waitFor(method: string) {
      if (records.some((record) => record.message.method === method)) {
        return;
      }
      await new Promise<void>((resolve) => waiters.push({ method, resolve }));
    },
    async assertClosed() {
      for (let attempt = 0; attempt < 500; attempt++) {
        if (pending === 0) {
          return;
        }
        await delay(10);
      }
      assert.fail("Fixture still has open MCP requests");
    },
  };
}

export async function withMcpEnvironment<T>(
  use: () => Promise<T>,
  configured = true,
  fixture = mcpFixture(),
): Promise<T> {
  const keys = [
    "JIRA_BASE_URL",
    "JIRA_EMAIL",
    "JIRA_API_TOKEN",
    "ATLASSIAN_MCP_URL",
    "UV_PYTHON",
    "READ_ONLY_MODE",
    "ENABLED_TOOLS",
    "TOOLSETS",
    "PYTHON_DOTENV_DISABLED",
    "ATLASSIAN_OAUTH_STORE",
    "MODEL_API_KEY",
    "CONFLUENCE_API_TOKEN",
    "CONFLUENCE_BASE_URL",
    "CONFLUENCE_USERNAME",
    "JIRA_URL",
    "JIRA_USERNAME",
  ];
  const previous = new Map(keys.map((key) => [key, process.env[key]]));
  const url = await fixture.start();
  process.env.JIRA_BASE_URL = configured ? fakeBaseUrl : "";
  process.env.JIRA_EMAIL = configured ? fakeEmail : "";
  process.env.JIRA_API_TOKEN = configured ? fakeToken : "";
  process.env.ATLASSIAN_MCP_URL = configured ? url : "";
  delete process.env.UV_PYTHON;
  try {
    return await use();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    try {
      await fixture.assertClosed();
    } finally {
      await fixture.stop();
    }
  }
}
