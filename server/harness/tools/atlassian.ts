import {
  convertSchemaToJsonSchema,
  type JSONSchema,
  type ToolExecutionContext,
  type UIMessage,
} from "@tanstack/ai";
import { createMCPClient, type MCPClient } from "@tanstack/ai-mcp";
import { z } from "zod";
import type { ModelCall } from "../model-turn";
import {
  atlassianTools,
  readAtlassianConfiguration,
  type AtlassianConfiguration,
} from "./atlassian-policy";

export type ModelTool = Readonly<{
  name: string;
  description: string;
  inputSchema: JSONSchema;
}>;
export type AtlassianCatalog = ReadonlyMap<string, ModelTool>;
export type LocalToolHandler = (input: unknown, context: ToolExecutionContext) => Promise<unknown>;
export type AtlassianScope = Readonly<{
  getModelTools: (
    messages: readonly UIMessage[],
    compose: (remote: AtlassianCatalog) => ModelTool[],
  ) => Promise<ModelTool[]>;
  executeTool: (
    messages: readonly UIMessage[],
    call: ModelCall,
    context: ToolExecutionContext,
    local: LocalToolHandler | undefined,
  ) => Promise<unknown>;
  guard: () => Promise<(value: unknown) => void>;
}>;

type RemoteRegistration = Readonly<{
  definition: ModelTool;
  handler: LocalToolHandler;
}>;
type RemoteCatalog = Readonly<{
  registrations: ReadonlyMap<string, RemoteRegistration>;
  close: () => Promise<void>;
}>;
type RemoteSession = Readonly<{
  controller: AbortController;
  deadlines: Set<AbortSignal>;
  catalog: Promise<RemoteCatalog>;
}>;

const MCP_TIMEOUT_MS = 60_000;

export const discoveryToolName = "discover_atlassian_tools";

const discoveryRequestSchema = z.object({ toolNames: z.array(z.string()).min(1) }).strict();

const discoveryResultSchema = z
  .object({
    tools: z.array(
      z
        .object({
          name: z.string(),
          description: z.string(),
          inputSchema: z.record(z.string(), z.unknown()),
        })
        .strict(),
    ),
  })
  .strict();

function discoveryDefinition(names: readonly string[]): ModelTool {
  return {
    name: discoveryToolName,
    description:
      "List the available Atlassian tool definitions by exact tool name. Call this before using Atlassian tools.",
    inputSchema: {
      type: "object",
      properties: {
        toolNames: {
          type: "array",
          items: { type: "string", enum: [...names] },
          minItems: 1,
        },
      },
      required: ["toolNames"],
      additionalProperties: false,
    },
  };
}

export class ToolBoundaryError extends Error {}

function parseDiscoveryRequest(argumentsText: string): readonly string[] | undefined {
  let parsed: unknown;

  try {
    parsed = JSON.parse(argumentsText);
  } catch {
    return undefined;
  }

  const request = discoveryRequestSchema.safeParse(parsed);

  return request.success ? [...new Set(request.data.toolNames)] : undefined;
}

type DiscoveryCall = Readonly<{
  order: number;
  arguments: string;
  state: string;
  flagged: boolean;
}>;
type DiscoveryResult = Readonly<{
  order: number;
  content: unknown;
  state: string;
  error: string | undefined;
  name: string | undefined;
  flagged: boolean;
}>;
type DiscoveryHistory = Readonly<{
  calls: ReadonlyMap<string, DiscoveryCall>;
  results: ReadonlyMap<string, DiscoveryResult>;
  ambiguous: ReadonlySet<string>;
}>;
type MutableHistory = {
  calls: Map<string, DiscoveryCall>;
  results: Map<string, DiscoveryResult>;
  callIds: Set<string>;
  resultIds: Set<string>;
  ambiguous: Set<string>;
};
type HttpConfig = Extract<AtlassianConfiguration, { mode: "http" }>;
type McpToolList = Awaited<ReturnType<MCPClient["tools"]>>;

function outputErrorFlagged(tanstack: unknown): boolean {
  return (
    !!tanstack &&
    typeof tanstack === "object" &&
    (tanstack as { state?: unknown }).state === "output-error"
  );
}

function markCallIdentity(id: string, history: MutableHistory): void {
  if (history.callIds.has(id) || history.resultIds.has(id) || id.length === 0) {
    history.ambiguous.add(id);
  }

  history.callIds.add(id);
}

function markResultIdentity(id: string, history: MutableHistory): void {
  if (history.resultIds.has(id) || id.length === 0) {
    history.ambiguous.add(id);
  }

  history.resultIds.add(id);
}

function noteToolCall(
  part: {
    id: string;
    name: string;
    arguments: string;
    state: string;
    metadata?: unknown;
  },
  order: number,
  history: MutableHistory,
): void {
  markCallIdentity(part.id, history);

  if (part.name !== discoveryToolName || history.calls.has(part.id)) {
    return;
  }

  history.calls.set(part.id, {
    order,
    arguments: part.arguments,
    state: part.state,
    flagged: outputErrorFlagged((part.metadata as { tanstack?: unknown } | undefined)?.tanstack),
  });
}

function noteToolResult(
  part: {
    toolCallId: string;
    content: unknown;
    state: string;
    error?: string;
    name?: string;
    metadata?: { tanstack?: unknown };
  },
  order: number,
  history: MutableHistory,
): void {
  markResultIdentity(part.toolCallId, history);

  if (history.results.has(part.toolCallId)) {
    return;
  }

  history.results.set(part.toolCallId, {
    order,
    content: part.content,
    state: part.state,
    error: part.error,
    name: part.name,
    flagged: outputErrorFlagged(part.metadata?.tanstack),
  });
}

function collectDiscoveryHistory(messages: readonly UIMessage[]): DiscoveryHistory {
  const history: MutableHistory = {
    calls: new Map(),
    results: new Map(),
    callIds: new Set(),
    resultIds: new Set(),
    ambiguous: new Set(),
  };
  let order = 0;

  for (const message of messages) {
    if (message.role !== "assistant") {
      continue;
    }

    for (const part of message.parts) {
      if (part.type === "tool-call") {
        noteToolCall(part, order, history);
      } else if (part.type === "tool-result") {
        noteToolResult(part, order, history);
      }

      order += 1;
    }
  }

  return {
    calls: history.calls,
    results: history.results,
    ambiguous: history.ambiguous,
  };
}

function discoveryPairReady(call: DiscoveryCall, result: DiscoveryResult): boolean {
  return result.order > call.order && call.state === "complete" && result.state === "complete";
}

function discoveryResultClean(result: DiscoveryResult): boolean {
  return result.error === undefined && !result.flagged;
}

function discoveryResultNamed(result: DiscoveryResult): boolean {
  return result.name === undefined || result.name === discoveryToolName;
}

function parsedDiscoveryTools(
  content: string,
  config: AtlassianConfiguration,
): readonly { name: string }[] | undefined {
  let parsed: unknown;

  try {
    parsed = JSON.parse(content);
  } catch {
    return undefined;
  }

  const output = discoveryResultSchema.safeParse(parsed);

  if (!output.success) {
    return undefined;
  }

  try {
    guardCredentials(output.data, config);
  } catch {
    return undefined;
  }

  return output.data.tools;
}

function discoveryNamesGranted(names: readonly string[], requested: readonly string[]): boolean {
  return (
    names.length === requested.length &&
    names.every((name, index) => name === requested[index]) &&
    names.every((name) => atlassianTools.has(name))
  );
}

function discoveryEligible(
  call: DiscoveryCall,
  result: DiscoveryResult | undefined,
): result is DiscoveryResult & { content: string } {
  return (
    !!result &&
    discoveryPairReady(call, result) &&
    !call.flagged &&
    discoveryResultClean(result) &&
    discoveryResultNamed(result) &&
    typeof result.content === "string"
  );
}

function discoveryGrant(
  call: DiscoveryCall,
  result: DiscoveryResult | undefined,
  config: AtlassianConfiguration,
): readonly string[] {
  if (!discoveryEligible(call, result)) {
    return [];
  }

  const requested = parseDiscoveryRequest(call.arguments);

  if (!requested) {
    return [];
  }

  const tools = parsedDiscoveryTools(result.content, config);

  if (!tools) {
    return [];
  }

  const names = tools.map((tool) => tool.name);

  return discoveryNamesGranted(names, requested) ? names : [];
}

function grantedNames(
  messages: readonly UIMessage[],
  config: AtlassianConfiguration,
): ReadonlySet<string> {
  const history = collectDiscoveryHistory(messages);
  const granted = new Set<string>();

  for (const [id, call] of history.calls) {
    if (history.ambiguous.has(id)) {
      continue;
    }

    for (const name of discoveryGrant(call, history.results.get(id), config)) {
      granted.add(name);
    }
  }

  return granted;
}

type Deadline = Readonly<{ signal: AbortSignal; release: () => void }>;

function armedDeadline(deadlines: Set<AbortSignal>, ms: number): Deadline {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  deadlines.add(controller.signal);

  return {
    signal: controller.signal,
    release: () => {
      clearTimeout(timer);
      deadlines.delete(controller.signal);
    },
  };
}

function guardCredentials(value: unknown, config: AtlassianConfiguration) {
  const secrets = config.mode === "http" ? config.secrets : [];
  const seen = new WeakSet<object>();

  function inspect(value: unknown) {
    if (typeof value === "string" && secrets.some((secret) => value.includes(secret))) {
      throw new ToolBoundaryError("Tool data contains configured Atlassian credentials");
    }

    if (value && typeof value === "object" && !seen.has(value)) {
      seen.add(value);

      for (const key of Object.getOwnPropertyNames(value)) {
        inspect(key);
        inspect((value as Record<string, unknown>)[key]);
      }
    }
  }

  inspect(value);
}

function withAbort<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const onAbort = () =>
      reject(new ToolBoundaryError("Atlassian MCP operation was cancelled or timed out"));

    if (signal.aborted) {
      onAbort();
    } else {
      signal.addEventListener("abort", onAbort, { once: true });
    }

    work.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

function mcpFetch(controller: AbortController, deadlines: Set<AbortSignal>): typeof fetch {
  return (input, init) => {
    const requestSignal = input instanceof Request ? input.signal : undefined;

    return fetch(input, {
      ...init,
      signal: AbortSignal.any([
        controller.signal,
        ...deadlines,
        ...(requestSignal ? [requestSignal] : []),
        ...(init?.signal ? [init.signal] : []),
      ]),
      redirect: "error",
      credentials: "omit",
    });
  };
}

function requireMcpTool(
  discovered: McpToolList,
  name: string,
  required: boolean,
): McpToolList[number] | undefined {
  const tool = discovered.find((candidate) => candidate.metadata.mcp.serverToolName === name);

  if (tool) {
    return tool;
  }

  if (required) {
    throw new ToolBoundaryError(`Atlassian MCP is missing required tool ${name}`);
  }

  return undefined;
}

function assertCatalogEntry(
  name: string,
  tool: { name: string; execute?: unknown },
  entries: ReadonlyMap<string, RemoteRegistration>,
): void {
  if (tool.name !== name || entries.has(name) || typeof tool.execute !== "function") {
    throw new ToolBoundaryError("Atlassian MCP catalog is invalid");
  }
}

function remoteRegistration(tool: McpToolList[number]): RemoteRegistration {
  const inputSchema = convertSchemaToJsonSchema(tool.inputSchema);

  if (!inputSchema) {
    throw new ToolBoundaryError("Tool schema is unavailable");
  }

  return {
    definition: { name: tool.name, description: tool.description, inputSchema },
    handler: async (input, context) => tool.execute!(input, context),
  };
}

function buildRemoteRegistrations(discovered: McpToolList): Map<string, RemoteRegistration> {
  const entries = new Map<string, RemoteRegistration>();

  for (const [name, policy] of atlassianTools) {
    const tool = requireMcpTool(discovered, name, policy.required);

    if (!tool) {
      continue;
    }

    assertCatalogEntry(name, tool, entries);
    entries.set(name, remoteRegistration(tool));
  }

  return entries;
}

function throwOpenRemoteFailure(failure: unknown, cancelled: boolean): never {
  if (cancelled) {
    throw new ToolBoundaryError("Atlassian MCP operation was cancelled or timed out");
  }

  if (failure instanceof ToolBoundaryError) {
    throw failure;
  }

  throw new ToolBoundaryError(
    "Atlassian MCP initialization failed; start the local service with pnpm mcp:atlassian, then check Jira credentials and site access",
  );
}

async function openRemote(
  config: HttpConfig,
  controller: AbortController,
  deadlines: Set<AbortSignal>,
): Promise<RemoteCatalog> {
  const scopeFetch = mcpFetch(controller, deadlines);
  const initDeadline = armedDeadline(deadlines, MCP_TIMEOUT_MS);
  let client: MCPClient | undefined;

  const close = async () => {
    const connected = client;
    client = undefined;
    await connected?.close().catch(() => undefined);
  };

  const onAbort = () => void close();
  controller.signal.addEventListener("abort", onAbort, { once: true });

  try {
    controller.signal.throwIfAborted();
    const connecting = createMCPClient({
      transport: { type: "http", url: config.endpoint, fetch: scopeFetch },
    }).then(async (connected) => {
      client = connected;

      if (controller.signal.aborted || initDeadline.signal.aborted) {
        await close();
      }

      return connected;
    });
    const signal = AbortSignal.any([controller.signal, initDeadline.signal]);
    const connected = await withAbort(connecting, signal);
    const discovered = await withAbort(connected.tools(), signal);
    guardCredentials(discovered, config);

    return { registrations: buildRemoteRegistrations(discovered), close };
  } catch (failure) {
    const cancelled = controller.signal.aborted || initDeadline.signal.aborted;

    if (cancelled) {
      controller.abort();
    }

    await close();
    guardCredentials(failure, config);
    throwOpenRemoteFailure(failure, cancelled);
  } finally {
    initDeadline.release();
    controller.signal.removeEventListener("abort", onAbort);
  }
}

function selectDefinitions(
  catalog: RemoteCatalog | undefined,
  granted: ReadonlySet<string>,
): AtlassianCatalog {
  return new Map(
    [...(catalog?.registrations ?? [])]
      .filter(([name]) => granted.has(name))
      .map(([name, entry]) => [name, entry.definition]),
  );
}

function advertisedTools(
  definitions: ModelTool[],
  session: RemoteSession | undefined,
  catalog: RemoteCatalog | undefined,
): ModelTool[] {
  if (!session || !catalog) {
    return definitions;
  }

  return [...definitions, discoveryDefinition([...catalog.registrations.keys()])];
}

function authorizeRemoteCall(
  messages: readonly UIMessage[],
  call: ModelCall,
  config: AtlassianConfiguration,
): readonly string[] | undefined {
  if (call.name === discoveryToolName) {
    const requested = parseDiscoveryRequest(call.arguments);

    if (!requested) {
      throw new ToolBoundaryError("Invalid discover_atlassian_tools input");
    }

    if (!requested.every((name) => atlassianTools.has(name))) {
      throw new Error("Unknown tool");
    }

    return requested;
  }

  if (!atlassianTools.has(call.name)) {
    throw new Error("Unknown tool");
  }

  if (!grantedNames(messages, config).has(call.name)) {
    throw new ToolBoundaryError(
      `Tool ${call.name} is not discovered; call ${discoveryToolName} first`,
    );
  }

  return undefined;
}

async function executeLocalTool(
  local: LocalToolHandler,
  call: ModelCall,
  context: ToolExecutionContext,
  config: AtlassianConfiguration,
): Promise<unknown> {
  try {
    const output = await local(call.input, context);
    guardCredentials(output, config);

    return output;
  } catch (failure) {
    guardCredentials(failure, config);

    if (failure instanceof ToolBoundaryError) {
      throw failure;
    }

    throw new Error(failure instanceof Error ? failure.message : "Tool failed");
  }
}

function discoveryOutput(
  catalog: RemoteCatalog,
  names: readonly string[],
  config: AtlassianConfiguration,
): unknown {
  const tools = names.map((name) => {
    const entry = catalog.registrations.get(name);

    if (!entry) {
      throw new ToolBoundaryError(`Atlassian tool is unavailable: ${name}`);
    }

    return entry.definition;
  });
  const output = structuredClone({ tools });
  guardCredentials(output, config);

  return output;
}

function remoteToolInput(call: ModelCall): unknown {
  return call.name === "jira_get_issue"
    ? { ...(call.input as Record<string, unknown>), update_history: false }
    : call.input;
}

async function invokeRemote(
  catalog: RemoteCatalog,
  call: ModelCall,
  context: ToolExecutionContext,
  signal: AbortSignal,
  config: AtlassianConfiguration,
): Promise<unknown> {
  const entry = catalog.registrations.get(call.name);

  if (!entry) {
    throw new ToolBoundaryError("Unknown tool");
  }

  signal.throwIfAborted();
  const output = await entry.handler(remoteToolInput(call), { ...context, abortSignal: signal });
  signal.throwIfAborted();
  guardCredentials(output, config);

  return output;
}

function throwRemoteFailure(
  failure: unknown,
  cancelled: boolean,
  abortSignal: AbortSignal | undefined,
): never {
  if (abortSignal?.aborted) {
    throw new ToolBoundaryError("Atlassian MCP tool was cancelled");
  }

  if (failure instanceof ToolBoundaryError) {
    throw failure;
  }

  if (cancelled) {
    throw new ToolBoundaryError("Atlassian MCP operation was cancelled or timed out");
  }

  throw new ToolBoundaryError(
    "Atlassian MCP tool failed; check Jira credentials, site access, and native tool arguments",
  );
}

async function runRemoteTool(
  names: readonly string[] | undefined,
  call: ModelCall,
  context: ToolExecutionContext,
  config: HttpConfig,
  getRemote: (config: HttpConfig) => RemoteSession,
  retire: (session: RemoteSession) => Promise<void>,
): Promise<unknown> {
  const session = getRemote(config);
  const callDeadline = armedDeadline(session.deadlines, MCP_TIMEOUT_MS);
  const signal = AbortSignal.any([
    session.controller.signal,
    callDeadline.signal,
    ...(context.abortSignal ? [context.abortSignal] : []),
  ]);
  const onAbort = () => session.controller.abort();
  signal.addEventListener("abort", onAbort, { once: true });

  try {
    const catalog = await withAbort(session.catalog, signal);

    if (names) {
      return discoveryOutput(catalog, names, config);
    }

    return await invokeRemote(catalog, call, context, signal, config);
  } catch (failure) {
    const cancelled = signal.aborted;
    await retire(session);
    guardCredentials(failure, config);
    throwRemoteFailure(failure, cancelled, context.abortSignal);
  } finally {
    callDeadline.release();
    signal.removeEventListener("abort", onAbort);
  }
}

type ScopeState = {
  configuration: Promise<AtlassianConfiguration> | undefined;
  remote: RemoteSession | undefined;
  closed: boolean;
};

type HttpConfiguration = Extract<AtlassianConfiguration, { mode: "http" }>;

function assertScopeOpen(state: ScopeState): void {
  if (state.closed) {
    throw new ToolBoundaryError("Tool scope is closed");
  }
}

async function scopeConfiguration(
  state: ScopeState,
  signal: AbortSignal | undefined,
): Promise<AtlassianConfiguration> {
  const config = await (state.configuration ??= Promise.resolve().then(() =>
    readAtlassianConfiguration(process.env),
  ));
  signal?.throwIfAborted();
  assertScopeOpen(state);

  return config;
}

function scopeRemote(state: ScopeState, config: HttpConfiguration): RemoteSession {
  assertScopeOpen(state);

  if (!state.remote) {
    const controller = new AbortController();
    const deadlines = new Set<AbortSignal>();
    const session: RemoteSession = {
      controller,
      deadlines,
      catalog: openRemote(config, controller, deadlines).catch((failure: unknown) => {
        if (state.remote === session) {
          state.remote = undefined;
        }

        throw failure;
      }),
    };
    state.remote = session;
  }

  return state.remote;
}

async function retireSession(state: ScopeState, session: RemoteSession): Promise<void> {
  if (state.remote === session) {
    state.remote = undefined;
  }

  session.controller.abort();
  const catalog = await session.catalog.catch(() => undefined);
  await catalog?.close();
}

async function scopedModelTools(
  state: ScopeState,
  signal: AbortSignal | undefined,
  messages: readonly UIMessage[],
  compose: (remote: AtlassianCatalog) => ModelTool[],
): Promise<ModelTool[]> {
  const config = await scopeConfiguration(state, signal);
  const session = config.mode === "http" ? scopeRemote(state, config) : undefined;

  try {
    const catalog = await session?.catalog;
    const definitions = compose(selectDefinitions(catalog, grantedNames(messages, config)));
    const advertised = advertisedTools(definitions, session, catalog);
    guardCredentials(advertised, config);

    return structuredClone(advertised);
  } catch (failure) {
    if (session) {
      await retireSession(state, session);
    }

    guardCredentials(failure, config);
    throw new Error(failure instanceof Error ? failure.message : "Tool composition failed");
  }
}

async function scopedTool(
  state: ScopeState,
  signal: AbortSignal | undefined,
  ...[messages, call, context, local]: Parameters<AtlassianScope["executeTool"]>
): Promise<unknown> {
  const config = await scopeConfiguration(state, signal);

  if (local) {
    return executeLocalTool(local, call, context, config);
  }

  if (config.mode === "local") {
    throw new Error("Unknown tool");
  }

  const names = authorizeRemoteCall(messages, call, config);

  if (context.abortSignal?.aborted) {
    throw new ToolBoundaryError("Atlassian MCP tool was cancelled");
  }

  return runRemoteTool(
    names,
    call,
    context,
    config,
    (remoteConfig) => scopeRemote(state, remoteConfig),
    (session) => retireSession(state, session),
  );
}

export async function withAtlassianScope<T>(
  use: (scope: AtlassianScope) => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  const state: ScopeState = { configuration: undefined, remote: undefined, closed: false };
  const onAbort = () => state.remote?.controller.abort();
  signal?.addEventListener("abort", onAbort, { once: true });

  try {
    return await use({
      async guard() {
        const config = await scopeConfiguration(state, signal);

        return (value: unknown) => guardCredentials(value, config);
      },
      getModelTools: (messages, compose) => scopedModelTools(state, signal, messages, compose),
      executeTool: (...args) => scopedTool(state, signal, ...args),
    });
  } finally {
    state.closed = true;
    signal?.removeEventListener("abort", onAbort);

    if (state.remote) {
      await retireSession(state, state.remote).catch(() => undefined);
    }
  }
}
