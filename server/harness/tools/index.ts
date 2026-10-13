import {
  convertSchemaToJsonSchema,
  type JSONSchema,
  type SchemaInput,
  type Tool,
  type ToolExecutionContext,
  type UIMessage,
} from "@tanstack/ai";
import type { ModelCall } from "../model-turn";
import {
  withAtlassianScope,
  ToolBoundaryError,
  type AtlassianCatalog,
  type LocalToolHandler,
  type ModelTool,
} from "./atlassian";
import { atlassianOutputSchemas } from "./atlassian-output";
import { codeModeToolName, composeCodeModeTurn } from "./code-mode";
import { getFigma } from "./get-figma";
import { read, write, edit } from "./fs";

type Registration = Readonly<{
  definition: ModelTool;
  handler: LocalToolHandler;
}>;
type Catalog = ReadonlyMap<string, Registration>;

export type ModelToolTurn = Readonly<{
  definitions: ModelTool[];
  systemPrompt: string;
}>;

export type RunTools = Readonly<{
  getModelTools: (messages: readonly UIMessage[]) => Promise<ModelToolTurn>;
  executeTool: (
    messages: readonly UIMessage[],
    call: ModelCall,
    context: ToolExecutionContext,
  ) => Promise<unknown>;
}>;

function jsonSchemaOf(schema: SchemaInput | undefined): JSONSchema {
  const converted = convertSchemaToJsonSchema(schema);

  if (!converted) {
    throw new ToolBoundaryError("Tool schema is unavailable");
  }

  return converted;
}

function registration(
  tool: Pick<Tool, "name" | "description" | "inputSchema">,
  handler: Registration["handler"],
): Registration {
  return {
    definition: {
      name: tool.name,
      description: tool.description,
      inputSchema: jsonSchemaOf(tool.inputSchema),
    },
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

const outputSchemas: ReadonlyMap<string, JSONSchema> = new Map(
  [
    ...atlassianOutputSchemas,
    ...[read, write, edit].map((tool) => [tool.name, tool.outputSchema] as const),
  ].map(([name, schema]) => [name, jsonSchemaOf(schema)]),
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

export async function withRunTools<T>(use: (tools: RunTools) => Promise<T>): Promise<T> {
  return withAtlassianScope(async (scope) => {
    const pending = new Set<Promise<unknown>>();

    const dispatchFor =
      (messages: readonly UIMessage[]) => (call: ModelCall, context: ToolExecutionContext) => {
        const work = scope.executeTool(
          messages,
          call,
          context,
          localCatalog.get(call.name)?.handler,
        );
        pending.add(work);
        void work.then(
          () => pending.delete(work),
          () => pending.delete(work),
        );

        return work;
      };

    const buildTurn = async (messages: readonly UIMessage[]) => {
      const definitions = await scope.getModelTools(messages, mergeLocalDefinitions);
      const guard = await scope.guard();
      const turn = composeCodeModeTurn({
        definitions,
        dispatch: dispatchFor(messages),
        guard,
        outputSchemas,
      });

      return { definitions, turn };
    };

    try {
      return await use({
        async getModelTools(messages) {
          const { definitions, turn } = await buildTurn(messages);

          return {
            definitions: [...definitions, turn.definition],
            systemPrompt: turn.systemPrompt,
          };
        },
        async executeTool(messages, call, context) {
          if (call.name !== codeModeToolName) {
            return dispatchFor(messages)(call, context);
          }

          const { turn } = await buildTurn(messages);

          return turn.execute(call.input, context);
        },
      });
    } finally {
      await Promise.allSettled(pending);
    }
  });
}
