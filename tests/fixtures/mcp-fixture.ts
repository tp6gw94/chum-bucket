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

  const matchingRule = (message: McpRequest["message"]): [number, FixtureRule] | undefined => {
    for (const [index, rule] of (options.rules ?? []).entries()) {
      if (usedRules.has(index)) {
        continue;
      }
      if (rule.method !== message.method || (rule.name && rule.name !== message.params?.name)) {
        continue;
      }
      if (
        rule.arguments &&
        !Object.entries(rule.arguments).every(
          ([key, value]) => message.params?.arguments?.[key] === value,
        )
      ) {
        continue;
      }
      return [index, rule];
    }
    return undefined;
  };

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    if (req.method === "GET") {
      const stream: McpRequest = {
        session: String(req.headers["mcp-session-id"] ?? ""),
        headers: req.headers,
        message: { jsonrpc: "2.0", method: "sse" },
        aborted: false,
      };
      records.push(stream);
      pending++;
      let settled = false;
      const settle = () => {
        if (!settled) {
          settled = true;
          pending--;
        }
      };
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      res.on("close", () => {
        if (!settled) {
          stream.aborted = true;
          settle();
        }
      });
      return;
    }
    if (req.method !== "POST") {
      res.writeHead(404).end();
      return;
    }
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
    const match = matchingRule(message);
    if (match) {
      const [index, rule] = match;
      if (rule.once) {
        usedRules.add(index);
      }
      if (rule.hang) {
        return;
      }
      if (rule.destroy) {
        res.destroy();
        return;
      }
      if (rule.error) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, error: rule.error }));
        settle();
        return;
      }
      finish(res, message, rule.result);
      settle();
      return;
    }
    if (message.method === "initialize") {
      finish(res, message, {
        protocolVersion: "2025-03-26",
        capabilities: { tools: {} },
        serverInfo: { name: "offline-atlassian", version: "0.23.1" },
      });
      settle();
      return;
    }
    if (message.method === "tools/list") {
      const pages = options.pages ?? [allTools.slice(0, 2), allTools.slice(2)];
      const page = Number(message.params?.cursor ?? 0);
      finish(res, message, {
        tools: pages[page],
        ...(page + 1 < pages.length ? { nextCursor: String(page + 1) } : {}),
      });
      settle();
      return;
    }
    if (message.method === "tools/call") {
      if (message.params?.name === "jira_get_issue") {
        finish(res, message, {
          content: [{ type: "text", text: "Native text fallback" }],
          structuredContent: { issue: message.params.arguments?.issue_key },
        });
      } else {
        finish(res, message, { content: [{ type: "text", text: "Native tool result" }] });
      }
      settle();
      return;
    }
    finish(res, message, {});
    settle();
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
