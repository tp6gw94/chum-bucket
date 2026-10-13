import {
  convertSchemaToJsonSchema,
  parseWithStandardSchema,
  type Tool,
  type ToolExecutionContext,
  type UIMessage,
} from "@tanstack/ai";
import { agentRegistry, allowsTool } from "../agents";
import type { ModelCall } from "../model-turn";
import {
  withAtlassianScope,
  ToolBoundaryError,
  type LocalToolHandler,
  type ModelTool,
} from "./atlassian";
import { codeModeToolName, composeCodeModeTurn } from "./code-mode";
import { toolOutputSchemas } from "./output-schemas";
import { DELEGATE_TASK_TOOL } from "./delegate-task";

export { DELEGATE_TASK_TOOL };

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

function modelDefinition(tool: Pick<Tool, "name" | "description" | "inputSchema">): ModelTool {
  const inputSchema = convertSchemaToJsonSchema(tool.inputSchema);

  if (!inputSchema) {
    throw new ToolBoundaryError("Tool schema is unavailable");
  }

  return { name: tool.name, description: tool.description, inputSchema };
}

function localHandler(tool: Tool): LocalToolHandler {
  return async (input, context) =>
    tool.execute!(parseWithStandardSchema(tool.inputSchema, input), context);
}

export async function withRunTools<T>(
  use: (tools: RunTools) => Promise<T>,
  signal?: AbortSignal,
  runScope: "main" | "side" = "main",
): Promise<T> {
  return withAtlassianScope(async (scope) => {
    const pending = new Set<Promise<unknown>>();

    const dispatchFor =
      (messages: readonly UIMessage[]) => (call: ModelCall, context: ToolExecutionContext) => {
        context.abortSignal?.throwIfAborted();
        signal?.throwIfAborted();

        if (call.name === "run_tests") {
          throw new ToolBoundaryError("run_tests is retired; use delegate_task");
        }

        if (call.name === DELEGATE_TASK_TOOL) {
          throw new ToolBoundaryError("delegate_task is direct-only on the main run");
        }

        if (!allowsTool("main", call.name, "direct")) {
          throw new ToolBoundaryError("Unknown tool");
        }

        const tool = agentRegistry.main.tools.find((reference) => reference.name === call.name);
        const work = scope.executeTool(
          messages,
          call,
          context,
          tool?.execute ? localHandler(tool) : undefined,
        );
        pending.add(work);
        void work.then(
          () => pending.delete(work),
          () => pending.delete(work),
        );

        return work;
      };

    const buildTurn = async (messages: readonly UIMessage[]) => {
      const definitions = agentRegistry.main.tools.map(modelDefinition);
      const bindable = definitions.filter((definition) =>
        allowsTool("main", definition.name, "codemode"),
      );
      const advertised = definitions.filter(
        (definition) =>
          allowsTool("main", definition.name, "codemode") ||
          (runScope === "main" && allowsTool("main", definition.name, "direct")),
      );
      const guard = await scope.guard();
      const turn = composeCodeModeTurn({
        definitions: bindable,
        dispatch: dispatchFor(messages),
        guard,
        outputSchemas: toolOutputSchemas,
      });

      return { definitions: advertised, turn };
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
          if (call.name === DELEGATE_TASK_TOOL) {
            throw new ToolBoundaryError("delegate_task is direct-only on the main run");
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
