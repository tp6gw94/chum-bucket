import {
  convertSchemaToJsonSchema,
  toolDefinition,
  type Tool,
  type ToolExecutionContext,
  type UIMessage,
} from "@tanstack/ai";
import { testingRequestInputSchema } from "../../../shared/testing";
import type { ModelCall } from "../model-turn";
import { codeModeToolName, composeCodeModeTurn } from "./code-mode";
import {
  withAtlassianScope,
  ToolBoundaryError,
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

export const RUN_TESTS_TOOL = "run_tests";
export type RunToolScope = "ordinary" | "main";

const runTests = toolDefinition({
  name: RUN_TESTS_TOOL,
  description:
    "Run supervised tests for this main conversation. Pass only the testing intent: goal, sources, criteria, target URL, and optional design or artifact references.",
  inputSchema: testingRequestInputSchema,
});

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

export async function withRunTools<T>(
  use: (tools: RunTools) => Promise<T>,
  signal?: AbortSignal,
  runScope: RunToolScope = "ordinary",
): Promise<T> {
  return withAtlassianScope(async (scope) => {
    const pending = new Set<Promise<unknown>>();
    const dispatchFor =
      (messages: readonly UIMessage[]) => (call: ModelCall, context: ToolExecutionContext) => {
        context.abortSignal?.throwIfAborted();
        signal?.throwIfAborted();
        if (call.name === RUN_TESTS_TOOL) {
          throw new ToolBoundaryError("run_tests is direct-only on the main run");
        }
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
      const bindable = definitions.filter((definition) => definition.name !== RUN_TESTS_TOOL);
      const guard = await scope.guard();
      const turn = composeCodeModeTurn({
        definitions: bindable,
        dispatch: dispatchFor(messages),
        guard,
      });
      const direct =
        runScope === "main"
          ? [
              registration(runTests, async () => {
                throw new ToolBoundaryError("run_tests cannot execute inside a tool step");
              }).definition,
            ]
          : [];
      return { definitions: [...bindable, ...direct], turn };
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
          if (call.name === RUN_TESTS_TOOL) {
            throw new ToolBoundaryError("run_tests is direct-only on the main run");
          }
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
  }, signal);
}
