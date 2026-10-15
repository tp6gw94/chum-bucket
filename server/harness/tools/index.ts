import {
  convertSchemaToJsonSchema,
  type JSONSchema,
  type Tool,
  type ToolExecutionContext,
  type UIMessage,
} from "@tanstack/ai";
import type { ModelCall } from "../model-turn";
import {
  discoveryToolName,
  withAtlassianScope,
  type AtlassianCatalog,
  type LocalToolHandler,
  type ModelTool,
} from "./atlassian";
import { atlassianOutputSchemas } from "./atlassian-output";
import { ToolBoundaryError } from "./boundary";
import { codeModeToolName, composeCodeModeTurn } from "./code-mode";
import { getFigma } from "./get-figma";
import { read, write, edit } from "./fs";

type Registration = Readonly<{
  definition: ModelTool;
  handler: LocalToolHandler;
}>;
type Catalog = ReadonlyMap<string, Registration>;

export type ModelToolset = Readonly<{ definitions: ModelTool[]; systemPrompt: string }>;

export type RunTools = Readonly<{
  getModelTools: (messages: readonly UIMessage[]) => Promise<ModelToolset>;
  executeTool: (
    messages: readonly UIMessage[],
    call: ModelCall,
    context: ToolExecutionContext,
  ) => Promise<unknown>;
}>;

const localOutputSchemas = new Map<string, JSONSchema>();

function registration(
  tool: Pick<Tool, "name" | "description" | "inputSchema" | "outputSchema">,
  handler: Registration["handler"],
): Registration {
  const inputSchema = convertSchemaToJsonSchema(tool.inputSchema);

  if (!inputSchema) {
    throw new ToolBoundaryError("Tool schema is unavailable");
  }

  const outputSchema = tool.outputSchema ? convertSchemaToJsonSchema(tool.outputSchema) : undefined;

  if (outputSchema) {
    localOutputSchemas.set(tool.name, outputSchema);
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

const outputSchemas: ReadonlyMap<string, JSONSchema> = new Map([
  ...localOutputSchemas,
  ...atlassianOutputSchemas,
]);

export async function withRunTools<T>(use: (tools: RunTools) => Promise<T>): Promise<T> {
  return withAtlassianScope(async (scope) => {
    const pending = new Set<Promise<unknown>>();

    const dispatcher =
      (messages: readonly UIMessage[]) =>
      (call: ModelCall, context: ToolExecutionContext): Promise<unknown> => {
        const work = scope.executeTool(
          messages,
          call,
          context,
          localCatalog.get(call.name)?.handler,
        );
        const settle = () => pending.delete(work);
        pending.add(work);
        work.then(settle, settle);

        return work;
      };

    const codeModeTurn = async (messages: readonly UIMessage[], advertised: ModelTool[]) =>
      composeCodeModeTurn({
        definitions: advertised,
        dispatch: dispatcher(messages),
        guard: await scope.createGuard(),
        outputSchemas,
        excluded: new Set([discoveryToolName]),
      });

    try {
      return await use({
        async getModelTools(messages) {
          const advertised = await scope.getModelTools(messages, mergeLocalDefinitions);
          const turn = await codeModeTurn(messages, advertised);

          return {
            definitions: [...advertised, turn.definition],
            systemPrompt: turn.systemPrompt,
          };
        },
        async executeTool(messages, call, context) {
          if (call.name !== codeModeToolName) {
            return dispatcher(messages)(call, context);
          }

          const advertised = await scope.getModelTools(messages, mergeLocalDefinitions);
          const turn = await codeModeTurn(messages, advertised);

          return turn.execute(call.input, context);
        },
      });
    } finally {
      await Promise.allSettled(pending);
    }
  });
}
