import {
  convertSchemaToJsonSchema,
  type Tool,
  type ToolExecutionContext,
  type UIMessage,
} from "@tanstack/ai";
import type { ModelCall } from "../model-turn";
import {
  withAtlassianScope,
  type AtlassianCatalog,
  type LocalToolHandler,
  type ModelTool,
} from "./atlassian";
import { getFigma } from "./get-figma";
import { read, write, edit } from "./fs";

type Registration = Readonly<{
  definition: ModelTool;
  handler: LocalToolHandler;
}>;
type Catalog = ReadonlyMap<string, Registration>;

export type RunTools = Readonly<{
  getModelTools: (messages: readonly UIMessage[]) => Promise<ModelTool[]>;
  executeTool: (
    messages: readonly UIMessage[],
    call: ModelCall,
    context: ToolExecutionContext,
  ) => Promise<unknown>;
}>;

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
  return withAtlassianScope((scope) =>
    use({
      getModelTools: (messages) => scope.getModelTools(messages, mergeLocalDefinitions),
      executeTool: (messages, call, context) =>
        scope.executeTool(messages, call, context, localCatalog.get(call.name)?.handler),
    }),
  );
}
