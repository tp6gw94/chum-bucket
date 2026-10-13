import { convertSchemaToJsonSchema, type UIMessage, type ToolExecutionContext } from "@tanstack/ai";
import type { ModelCall } from "../../server/harness/model-turn";
import type { RunTools } from "../../server/harness/tools";
import {
  withAtlassianScope,
  ToolBoundaryError,
  type ModelTool,
  type LocalToolHandler,
} from "../../server/harness/tools/atlassian";
import { composeCodeModeTurn } from "../../server/harness/tools/code-mode";
import { read, write, edit } from "../../server/harness/tools/fs";
import { getFigma } from "../../server/harness/tools/get-figma";
import { toolOutputSchemas } from "../../server/harness/tools/output-schemas";

const locals = [getFigma, read, write, edit];
const handlers: ReadonlyMap<string, LocalToolHandler> = new Map([
  [
    "get_figma",
    async (input, execution) => getFigma.execute!(getFigma.inputSchema.parse(input), execution),
  ],
  ["read", async (input, execution) => read.execute!(input, execution)],
  ["write", async (input, execution) => write.execute!(input, execution)],
  ["edit", async (input, execution) => edit.execute!(input, execution)],
]);
const definitions: ModelTool[] = locals.map((tool) => {
  const inputSchema = convertSchemaToJsonSchema(tool.inputSchema);
  if (!inputSchema) {
    throw new ToolBoundaryError("Tool schema is unavailable");
  }
  return { name: tool.name, description: tool.description, inputSchema };
});

export async function withCatalogTools<T>(
  use: (tools: RunTools) => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  return withAtlassianScope(async (scope) => {
    const pending = new Set<Promise<unknown>>();
    const dispatch =
      (messages: readonly UIMessage[]) => (call: ModelCall, context: ToolExecutionContext) => {
        context.abortSignal?.throwIfAborted();
        signal?.throwIfAborted();
        const work = scope.executeTool(messages, call, context, handlers.get(call.name));
        pending.add(work);
        void work.then(
          () => pending.delete(work),
          () => pending.delete(work),
        );
        return work;
      };
    const build = async (messages: readonly UIMessage[]) => {
      const native = await scope.getModelTools(messages, (remote) => [
        ...definitions,
        ...remote.values(),
      ]);
      const turn = composeCodeModeTurn({
        definitions: native,
        dispatch: dispatch(messages),
        guard: await scope.guard(),
        outputSchemas: toolOutputSchemas,
      });
      return { native, turn };
    };
    try {
      return await use({
        async getModelTools(messages) {
          const { native, turn } = await build(messages);
          return { definitions: [...native, turn.definition], systemPrompt: turn.systemPrompt };
        },
        async executeTool(messages, call, context) {
          if (call.name !== "codemode") {
            return dispatch(messages)(call, context);
          }
          const { turn } = await build(messages);
          return turn.execute(call.input, context);
        },
      });
    } finally {
      await Promise.allSettled(pending);
    }
  }, signal);
}
