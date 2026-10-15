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
import { getFigma } from "./get-figma";
import { read, write, edit } from "./fs";

type Registration = Readonly<{
  definition: ModelTool;
  handler: LocalToolHandler;
}>;
type Catalog = ReadonlyMap<string, Registration>;
type Composition = Readonly<{
  available: CodeModeDefinition[];
  discovery: ModelTool | undefined;
}>;
type Dispatch = (call: ModelCall, context: ToolExecutionContext) => Promise<unknown>;

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

function compose(granted: AtlassianCatalog, discovery: ModelTool | undefined): Composition {
  const available: CodeModeDefinition[] = [...localCatalog.values()].map(
    (entry) => entry.definition,
  );

  for (const [name, definition] of granted) {
    if (localCatalog.has(name) || name === codeModeToolName || name === discovery?.name) {
      throw new ToolBoundaryError("Atlassian MCP catalog is invalid");
    }

    const outputSchema = atlassianOutputSchema(name);
    available.push(outputSchema ? { ...definition, outputSchema } : definition);
  }

  return { available, discovery };
}

function modelDefinition({ name, description, inputSchema }: CodeModeDefinition): ModelTool {
  return { name, description, inputSchema };
}

function dispatcher(scope: AtlassianScope, messages: readonly UIMessage[]): Dispatch {
  return (call, context) =>
    scope.executeTool(messages, call, context, localCatalog.get(call.name)?.handler);
}

async function composeTurn(
  scope: AtlassianScope,
  messages: readonly UIMessage[],
): Promise<Composition & { codeMode: CodeMode }> {
  const composition = await scope.getModelTools(messages, compose);
  const dispatch = dispatcher(scope, messages);
  const codeMode = createCodeMode({
    definitions: composition.available,
    dispatch: (name, input, context) =>
      dispatch(
        { id: context.toolCallId ?? name, name, arguments: JSON.stringify(input) ?? "null", input },
        context,
      ),
    guard: await scope.credentialGuard(),
    policy: codeModePolicy,
  });

  return { ...composition, codeMode };
}

export async function withRunTools<T>(use: (tools: RunTools) => Promise<T>): Promise<T> {
  return withAtlassianScope((scope) =>
    use({
      async getModelTools(messages) {
        const { available, discovery, codeMode } = await composeTurn(scope, messages);

        return {
          definitions: [
            ...available.map(modelDefinition),
            ...(discovery ? [discovery] : []),
            codeMode.definition,
          ],
          systemPrompt: codeMode.systemPrompt,
        };
      },
      async executeTool(messages, call, context) {
        if (call.name !== codeModeToolName) {
          return dispatcher(scope, messages)(call, context);
        }

        const { codeMode } = await composeTurn(scope, messages);

        return codeMode.execute(call.input, context);
      },
    }),
  );
}
