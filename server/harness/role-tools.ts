import type { ToolExecutionContext, UIMessage } from "@tanstack/ai";
import { allowsTool } from "./agents";
import type { ModelCall } from "./model-turn";
import { codeModeToolName, composeCodeModeTurn, type CodeModeTurn } from "./tools/code-mode";
import { toolOutputSchemas } from "./tools/output-schemas";
import type { ModelToolShape as ModelTool } from "./tools/atlassian-policy";
import type { RunTools } from "./tools";
import type { RoleId } from "../../shared/testing";

export type RoleRun = Readonly<{
  tools: RunTools;
  quiet: () => Promise<void>;
}>;

export type NativeRoute = "direct" | "codemode";

type NativeDispatch = (
  call: ModelCall,
  context: ToolExecutionContext,
  route: NativeRoute,
) => Promise<unknown>;

export function roleRunTools(options: {
  role: RoleId;
  definitions: (messages: readonly UIMessage[]) => Promise<readonly ModelTool[]>;
  dispatch: (messages: readonly UIMessage[]) => NativeDispatch;
  guard: (value: unknown) => void;
  signal?: AbortSignal;
}): RoleRun {
  const pending = new Set<Promise<unknown>>();
  const contextFor = (context: ToolExecutionContext): ToolExecutionContext =>
    options.signal
      ? {
          ...context,
          abortSignal: context.abortSignal
            ? AbortSignal.any([context.abortSignal, options.signal])
            : options.signal,
        }
      : context;

  const dispatchFor =
    (messages: readonly UIMessage[]) =>
    (call: ModelCall, context: ToolExecutionContext, route: NativeRoute) => {
      context.abortSignal?.throwIfAborted();
      options.signal?.throwIfAborted();

      if (!allowsTool(options.role, call.name, route)) {
        throw new Error("Unknown tool");
      }

      const work = options.dispatch(messages)(call, contextFor(context), route);
      pending.add(work);
      void work.then(
        () => pending.delete(work),
        () => pending.delete(work),
      );

      return work;
    };

  const buildTurn = async (
    messages: readonly UIMessage[],
    definitions: readonly ModelTool[],
  ): Promise<CodeModeTurn> =>
    composeCodeModeTurn({
      definitions: definitions.filter((definition) =>
        allowsTool(options.role, definition.name, "codemode"),
      ),
      dispatch: (call, context) => dispatchFor(messages)(call, context, "codemode"),
      guard: options.guard,
      outputSchemas: toolOutputSchemas,
    });

  return {
    quiet: async () => {
      await Promise.allSettled(pending);
    },
    tools: {
      async getModelTools(messages) {
        const definitions = await options.definitions(messages);
        const turn = await buildTurn(messages, definitions);

        return { definitions: [...definitions, turn.definition], systemPrompt: turn.systemPrompt };
      },
      async executeTool(messages, call, context) {
        if (call.name === codeModeToolName) {
          const definitions = await options.definitions(messages);
          const turn = await buildTurn(messages, definitions);

          return turn.execute(call.input, contextFor(context));
        }

        return dispatchFor(messages)(call, context, "direct");
      },
    },
  };
}

export function plannerRoleTools(signal?: AbortSignal): RoleRun {
  return roleRunTools({
    role: "planner",
    signal,
    guard: () => undefined,
    definitions: async () => [],
    dispatch: () => async (call) => {
      throw new Error(`Tool ${call.name} is not available to the planner role`);
    },
  });
}
