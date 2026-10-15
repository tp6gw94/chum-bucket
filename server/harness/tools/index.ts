import {
  convertSchemaToJsonSchema,
  type Tool,
  type ToolExecutionContext,
  type UIMessage,
} from "@tanstack/ai";
import type { Route, ToolAccess } from "../agents";
import type { ModelCall } from "../model-turn";
import {
  discoveryDefinition,
  discoveryToolName,
  withAtlassianScope,
  type AtlassianCatalog,
  type AtlassianScope,
  type LocalToolHandler,
  type ModelTool,
} from "./atlassian";
import { atlassianOutputSchema } from "./atlassian-output";
import {
  codeModeToolName,
  createCodeMode,
  type CodeMode,
  type CodeModeDefinition,
  type CodeModePolicy,
} from "./code-mode";
import { delegateTaskTool } from "./delegate-task";
import { getFigma } from "./get-figma";
import { read, write, edit } from "./fs";

export type Registration = Readonly<{
  definition: ModelTool;
  handler: LocalToolHandler;
}>;
export type Catalog = ReadonlyMap<string, Registration>;
type Composition = Readonly<{
  direct: CodeModeDefinition[];
  discovery: ModelTool | undefined;
  codeMode: CodeMode | undefined;
}>;
type RemoteComposition = Readonly<{
  granted: AtlassianCatalog;
  discovery: ModelTool | undefined;
  advertised: readonly string[];
}>;

export type TurnTools = Readonly<{
  definitions: ModelTool[];
  systemPrompt: string;
}>;

export type RunTools = Readonly<{
  getModelTools: (messages: readonly UIMessage[]) => Promise<TurnTools>;
  executeTool: (
    messages: readonly UIMessage[],
    call: ModelCall,
    context: ToolExecutionContext,
  ) => Promise<unknown>;
}>;

export type ExternalCall = Readonly<{
  messages: readonly UIMessage[];
  call: ModelCall;
  route: Route;
  context: ToolExecutionContext;
}>;

export type ToolHooks = Readonly<{
  visible?: (name: string, messages: readonly UIMessage[]) => boolean;
  prepare?: (external: ExternalCall) => ModelCall;
  invoke?: (external: ExternalCall, run: () => Promise<unknown>) => Promise<unknown>;
}>;

const codeModePolicy: CodeModePolicy = {
  timeoutMs: 30_000,
  memoryLimitMb: 64,
  maxStackBytes: 512 * 1024,
  maxCodeLength: 20_000,
  maxToolCalls: 25,
  maxResultChars: 30_000,
  maxLogs: 50,
  maxMessageChars: 2_000,
};

const UNKNOWN_TOOL = "Unknown tool";

class ToolBoundaryError extends Error {}

export function registration(
  tool: Pick<Tool, "name" | "description" | "inputSchema">,
  handler: Registration["handler"],
): Registration {
  const inputSchema = convertSchemaToJsonSchema(tool.inputSchema);

  if (!inputSchema) {
    throw new ToolBoundaryError("Tool schema is unavailable");
  }

  return {
    definition: { name: tool.name, description: tool.description, inputSchema },
    handler,
  };
}

export function catalogOf(entries: readonly Registration[]): Catalog {
  return new Map(entries.map((entry) => [entry.definition.name, entry]));
}

const conversationCatalog: Catalog = catalogOf([
  registration(getFigma, async (input, context) =>
    getFigma.execute!(getFigma.inputSchema.parse(input), context),
  ),
  registration(read, async (input, context) => read.execute!(input, context)),
  registration(write, async (input, context) => write.execute!(input, context)),
  registration(edit, async (input, context) => edit.execute!(input, context)),
  registration(delegateTaskTool, async () => {
    throw new Error("delegate_task is orchestrated by the host");
  }),
]);

function modelDefinition({ name, description, inputSchema }: CodeModeDefinition): ModelTool {
  return { name, description, inputSchema };
}

function assertRemoteCatalog(granted: AtlassianCatalog, catalog: Catalog): void {
  for (const name of granted.keys()) {
    if (catalog.has(name) || name === codeModeToolName || name === discoveryToolName) {
      throw new ToolBoundaryError("Atlassian MCP catalog is invalid");
    }
  }
}

function remoteDefinitions(remote: RemoteComposition, access: ToolAccess): CodeModeDefinition[] {
  return [...remote.granted]
    .filter(([name]) => access.atlassianNames.includes(name))
    .map(([name, definition]) => {
      const outputSchema = atlassianOutputSchema(name);

      return outputSchema ? { ...definition, outputSchema } : definition;
    });
}

function requestedDiscovery(call: ModelCall): readonly string[] {
  const names = (call.input as { toolNames?: unknown } | null)?.toolNames;

  return Array.isArray(names) ? names.filter((name) => typeof name === "string") : [];
}

export function createAgentTools(input: {
  access: ToolAccess;
  scope: AtlassianScope;
  catalog: Catalog;
  hooks?: ToolHooks;
}): RunTools {
  const { access, scope, catalog, hooks = {} } = input;
  const usesAtlassian = access.atlassianNames.length > 0;

  async function remoteTurn(messages: readonly UIMessage[]): Promise<RemoteComposition> {
    if (!usesAtlassian) {
      return { granted: new Map(), discovery: undefined, advertised: [] };
    }

    return scope.getModelTools(messages, (granted, discovery, advertised) => {
      assertRemoteCatalog(granted, catalog);

      return { granted, discovery, advertised };
    });
  }

  async function dispatch(
    messages: readonly UIMessage[],
    call: ModelCall,
    route: Route,
    context: ToolExecutionContext,
  ): Promise<unknown> {
    if (!access.permits(call.name, route)) {
      throw new Error(UNKNOWN_TOOL);
    }

    if (
      call.name === discoveryToolName &&
      !requestedDiscovery(call).every((name) => access.atlassianNames.includes(name))
    ) {
      throw new Error(UNKNOWN_TOOL);
    }

    if (hooks.visible && !hooks.visible(call.name, messages)) {
      throw new Error(`Tool ${call.name} is not available yet`);
    }

    const external: ExternalCall = { messages, call, route, context };
    const prepared = hooks.prepare ? hooks.prepare(external) : call;
    const run = () =>
      scope.executeTool(messages, prepared, context, catalog.get(prepared.name)?.handler);

    return hooks.invoke ? hooks.invoke({ ...external, call: prepared }, run) : run();
  }

  async function composeTurn(messages: readonly UIMessage[]): Promise<Composition> {
    const remote = await remoteTurn(messages);
    const visible = (name: string) => hooks.visible?.(name, messages) ?? true;
    const available = [
      ...[...catalog.values()].map((entry) => entry.definition),
      ...remoteDefinitions(remote, access),
    ].filter((definition) => visible(definition.name));
    const discoveryNames = remote.advertised.filter((name) => access.atlassianNames.includes(name));
    const discovery =
      remote.discovery && discoveryNames.length && access.permits(discoveryToolName, "direct")
        ? discoveryDefinition(discoveryNames)
        : undefined;
    const codeMode = access.permits(codeModeToolName, "direct")
      ? createCodeMode({
          definitions: available.filter((definition) =>
            access.permits(definition.name, "codemode"),
          ),
          dispatch: (name, args, context) =>
            dispatch(
              messages,
              {
                id: context.toolCallId ?? name,
                name,
                arguments: JSON.stringify(args) ?? "null",
                input: args,
              },
              "codemode",
              context,
            ),
          guard: await scope.credentialGuard(),
          policy: codeModePolicy,
        })
      : undefined;

    return {
      direct: available.filter((definition) => access.permits(definition.name, "direct")),
      discovery,
      codeMode,
    };
  }

  return {
    async getModelTools(messages) {
      const { direct, discovery, codeMode } = await composeTurn(messages);

      return {
        definitions: [
          ...direct.map(modelDefinition),
          ...(discovery ? [discovery] : []),
          ...(codeMode ? [codeMode.definition] : []),
        ],
        systemPrompt: codeMode?.systemPrompt ?? "",
      };
    },
    async executeTool(messages, call, context) {
      if (call.name !== codeModeToolName) {
        return dispatch(messages, call, "direct", context);
      }

      if (!access.permits(codeModeToolName, "direct")) {
        throw new Error(UNKNOWN_TOOL);
      }

      const { codeMode } = await composeTurn(messages);

      return codeMode!.execute(call.input, context);
    },
  };
}

export async function withRunTools<T>(
  access: ToolAccess,
  use: (tools: RunTools) => Promise<T>,
): Promise<T> {
  return withAtlassianScope((scope) =>
    use(createAgentTools({ access, scope, catalog: conversationCatalog })),
  );
}
