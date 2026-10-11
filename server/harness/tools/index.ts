import {
  convertSchemaToJsonSchema,
  toolDefinition,
  type Tool,
  type ToolExecutionContext,
  type UIMessage,
} from "@tanstack/ai";
import { delegationInputSchema } from "../../../shared/testing";
import { allowsTool } from "../agents";
import type { ModelCall } from "../model-turn";
import { codeModeToolName, composeCodeModeTurn } from "./code-mode";
import {
  withAtlassianScope,
  ToolBoundaryError,
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

export const DELEGATE_TASK_TOOL = "delegate_task";

const delegateTaskTool = toolDefinition({
  name: DELEGATE_TASK_TOOL,
  description:
    "Delegate exactly one durable task. Choose atlassian to capture requirements, planner with an explicit requirementsRef to plan without a URL, or ac/ui with an explicit planRef and targetUrl for mock-only checks. Returns validated results and immutable artifact references. Never launches prerequisites. Jira issue keys identify sources, not criterion selection. For the whole PROJ-123 issue use sources:[{kind:'jira',issueKey:'PROJ-123'}], criteria:{kind:'all'}. Use selected only for explicit criterion keys such as AC-2 and AC-5, preserving that exact subset.",
  inputSchema: delegationInputSchema,
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

const delegateTaskDirect = registration(delegateTaskTool, async () => {
  throw new ToolBoundaryError("delegate_task cannot execute inside a tool step");
}).definition;

function composeLocalDefinitions(): ModelTool[] {
  const modelDefinitions: ModelTool[] = [];

  for (const [name, entry] of localCatalog) {
    if (allowsTool("main", name, "direct")) {
      modelDefinitions.push(entry.definition);
    }
  }

  return modelDefinitions;
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
      const definitions = composeLocalDefinitions();
      const bindable = definitions.filter(
        (definition) =>
          definition.name !== DELEGATE_TASK_TOOL &&
          (allowsTool("main", definition.name, "direct") ||
            allowsTool("main", definition.name, "codemode")),
      );
      const guard = await scope.guard();
      const turn = composeCodeModeTurn({
        definitions: bindable,
        dispatch: dispatchFor(messages),
        guard,
      });
      const direct =
        runScope === "main" && allowsTool("main", DELEGATE_TASK_TOOL, "direct")
          ? [delegateTaskDirect]
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
