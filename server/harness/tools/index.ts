import {
  convertSchemaToJsonSchema,
  type JSONSchema,
  type Tool,
  type ToolExecutionContext,
  type UIMessage,
} from "@tanstack/ai";
import type { ModelCall } from "../model-turn";
import {
  withAtlassianScope,
  type AtlassianCatalog,
  type AtlassianScope,
  type LocalToolHandler,
  type ModelTool,
} from "./atlassian";
import { atlassianOutputSchemas } from "./atlassian-output";
import { codeModeToolName, composeCodeModeTurn, type CodeModePolicy } from "./code-mode";
import { getFigma } from "./get-figma";
import { read, write, edit } from "./fs";

type Registration = Readonly<{
  definition: ModelTool;
  handler: LocalToolHandler;
}>;
type Catalog = ReadonlyMap<string, Registration>;

export type ModelTools = Readonly<{
  definitions: ModelTool[];
  systemPrompt: string;
}>;

export type RunTools = Readonly<{
  getModelTools: (messages: readonly UIMessage[]) => Promise<ModelTools>;
  executeTool: (
    messages: readonly UIMessage[],
    call: ModelCall,
    context: ToolExecutionContext,
  ) => Promise<unknown>;
}>;

export type RunToolsOptions = Readonly<{ codeModePolicy?: CodeModePolicy }>;

class ToolBoundaryError extends Error {}

function registration(
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

const localCatalog: Catalog = new Map(
  [
    registration(getFigma, async (input, context) =>
      getFigma.execute!(getFigma.inputSchema.parse(input), context),
    ),
    registration(read, async (input, context) => read.execute!(input, context)),
    registration(write, async (input, context) => write.execute!(input, context)),
    registration(edit, async (input, context) => edit.execute!(input, context)),
  ].map((entry) => [entry.definition.name, entry]),
);

function jsonSchema(schema: Parameters<typeof convertSchemaToJsonSchema>[0]): JSONSchema {
  const converted = convertSchemaToJsonSchema(schema);

  if (!converted) {
    throw new ToolBoundaryError("Tool output schema is unavailable");
  }

  return converted;
}

const outputSchemas: ReadonlyMap<string, JSONSchema> = new Map([
  ...[read, write, edit].map((tool) => [tool.name, jsonSchema(tool.outputSchema)] as const),
  ...[...atlassianOutputSchemas].map(([name, schema]) => [name, jsonSchema(schema)] as const),
]);

function mergeLocalDefinitions(remote: AtlassianCatalog): ModelTool[] {
  const definitions = new Map([...localCatalog].map(([name, entry]) => [name, entry.definition]));

  for (const [name, definition] of remote) {
    if (definitions.has(name)) {
      throw new ToolBoundaryError("Atlassian MCP catalog is invalid");
    }

    definitions.set(name, definition);
  }

  return [...definitions.values()];
}

function trackedDispatch(
  scope: AtlassianScope,
  messages: readonly UIMessage[],
  pending: Set<Promise<unknown>>,
) {
  return (call: ModelCall, context: ToolExecutionContext) => {
    const work = scope.executeTool(messages, call, context, localCatalog.get(call.name)?.handler);
    pending.add(work);
    void work.then(
      () => pending.delete(work),
      () => pending.delete(work),
    );

    return work;
  };
}

async function codeModeTurn(
  scope: AtlassianScope,
  messages: readonly UIMessage[],
  pending: Set<Promise<unknown>>,
  options: RunToolsOptions,
) {
  const definitions = await scope.getModelTools(messages, mergeLocalDefinitions);

  return {
    definitions,
    turn: composeCodeModeTurn({
      definitions,
      dispatch: trackedDispatch(scope, messages, pending),
      guard: await scope.credentialGuard(),
      policy: options.codeModePolicy,
      outputSchemas,
    }),
  };
}

export async function withRunTools<T>(
  use: (tools: RunTools) => Promise<T>,
  options: RunToolsOptions = {},
): Promise<T> {
  return withAtlassianScope(async (scope) => {
    const pending = new Set<Promise<unknown>>();

    try {
      return await use({
        async getModelTools(messages) {
          const { definitions, turn } = await codeModeTurn(scope, messages, pending, options);

          return {
            definitions: [...definitions, turn.definition],
            systemPrompt: turn.systemPrompt,
          };
        },
        async executeTool(messages, call, context) {
          if (call.name !== codeModeToolName) {
            return trackedDispatch(scope, messages, pending)(call, context);
          }

          const { turn } = await codeModeTurn(scope, messages, pending, options);

          return turn.execute(call.input, context);
        },
      });
    } finally {
      await Promise.allSettled(pending);
    }
  });
}
