import { convertSchemaToJsonSchema, type ToolExecutionContext, type UIMessage } from "@tanstack/ai";
import type { Evidence, Receipt, Role, RoleTask } from "../../shared/testing";
import { approvalToolNames, toolArgumentSchemas } from "../../shared/tool-approval";
import { toolNamesFor } from "./agents";
import { agentTools } from "./tool-policy";
import { digestOf } from "./testing-domain";
import { designValues, scopedFigmaCall } from "./testing-figma";
import type { ModelCall } from "./model-turn";
import { withRunTools, type RunTools } from "./tools";
import { APPROVAL_REQUIRED, type ModelTool } from "./tools/atlassian";
import { getFigma } from "./tools/get-figma";
import { browserVerifier, verifyAc, verifyUi } from "./tools/verify-browser";

export type RoleToolState = { receipts: Receipt[] };
type RoleToolsInput = {
  role: Role;
  taskId: string;
  task: RoleTask;
  state: RoleToolState;
  guard: (kind: "tool" | "nested", step: string) => Promise<void>;
  append: (receipt: Receipt) => Promise<void>;
};

function authorizedRead(call: ModelCall, task: RoleTask): ModelCall {
  const input = call.input as Record<string, unknown>;
  const allowed = task.sources.some((source) =>
    source.kind === "jira"
      ? call.name === "jira_get_issue" && input.issue_key === source.issueKey
      : call.name === "confluence_get_page" && input.page_id === source.pageId,
  );

  if (!allowed) {
    throw new Error("Source is outside delegated scope");
  }

  const next =
    call.name === "jira_get_issue"
      ? { issue_key: input.issue_key, fields: "summary,description", include: "remote_links" }
      : { page_id: input.page_id, include_metadata: true };

  return { ...call, input: next, arguments: JSON.stringify(next) };
}

const approvalTools: ReadonlySet<string> = new Set(approvalToolNames);

function discoverableNames(): string[] {
  return toolNamesFor("atlassian").filter((name) => !approvalTools.has(name));
}

const commentProposal: ModelTool = {
  name: "jira_add_comment",
  description:
    "Propose this exact Jira comment for user approval. Nothing is posted before approval. After a rejection this task cannot propose another comment.",
  inputSchema: convertSchemaToJsonSchema(toolArgumentSchemas.jira_add_comment)!,
};

function atlassianCall(call: ModelCall, task: RoleTask) {
  if (approvalTools.has(call.name)) {
    throw new Error(APPROVAL_REQUIRED);
  }

  if (call.name !== "discover_atlassian_tools") {
    return authorizedRead(call, task);
  }

  const names = (call.input as { toolNames?: unknown }).toolNames;

  if (!Array.isArray(names) || !names.every((name) => discoverableNames().includes(name))) {
    throw new Error("Discovery is outside delegated scope");
  }

  return call;
}

async function atlassianDefinitions(
  remote: RunTools,
  messages: readonly UIMessage[],
): Promise<ModelTool[]> {
  const allowed = new Set(discoverableNames());

  const definitions = (await remote.getModelTools(messages))
    .filter((tool) => allowed.has(tool.name) || tool.name === "discover_atlassian_tools")
    .map((tool) =>
      tool.name !== "discover_atlassian_tools"
        ? tool
        : {
            ...tool,
            inputSchema: {
              type: "object",
              properties: {
                toolNames: {
                  type: "array",
                  items: { type: "string", enum: [...allowed] },
                  minItems: 1,
                },
              },
              required: ["toolNames"],
              additionalProperties: false,
            },
          },
    );

  return [...definitions, commentProposal];
}

function recordFor(
  input: RoleToolsInput,
  call: ModelCall,
  output: unknown,
  route: Receipt["route"],
): Receipt {
  return {
    id: `${input.taskId}:${call.id}`,
    taskId: input.taskId,
    name: call.name,
    route,
    input: call.input,
    output,
    outputDigest: digestOf(output),
    capturedAt: new Date().toISOString(),
    ...(call.name.startsWith("verify_")
      ? { checkId: (call.input as { checkId: string }).checkId }
      : {}),
  };
}

function roleVerifier(input: RoleToolsInput, save: (receipt: Receipt) => Promise<void>) {
  const { role, taskId, task, state } = input;

  if (role !== "ac" && role !== "ui") {
    return undefined;
  }

  return browserVerifier(taskId, role, task, {
    load: (caseId) =>
      state.receipts.find((entry) => entry.id === `${taskId}:case:${caseId}`)?.output as
        | Evidence[]
        | undefined,
    save: async (caseId, output) =>
      save({
        id: `${taskId}:case:${caseId}`,
        taskId,
        name: "browser_case",
        route: "direct",
        input: { caseId },
        output,
        outputDigest: digestOf(output),
        capturedAt: new Date().toISOString(),
      }),
  });
}

function nativeRoleTools(input: RoleToolsInput, remote?: RunTools): RunTools {
  const { role, task, state } = input;

  const save = async (receipt: Receipt) => {
    await input.append(receipt);

    if (!state.receipts.some((item) => item.id === receipt.id)) {
      state.receipts.push(receipt);
    }
  };

  const capture = () => {
    const receipt = state.receipts.find((entry) => entry.name === "get_figma");

    return receipt ? designValues(receipt.output, task) : null;
  };

  const verifier = roleVerifier(input, save);

  const invoke = async (
    messages: readonly UIMessage[],
    call: ModelCall,
    context: ToolExecutionContext,
  ) => {
    if (role === "atlassian") {
      const actual = atlassianCall(call, task);

      return { actual, output: await remote!.executeTool(messages, actual, context) };
    }

    if (call.name === "get_figma") {
      const actual = scopedFigmaCall(call, task);
      const output = await getFigma.execute!(getFigma.inputSchema.parse(actual.input), context);

      if (!designValues(output, task)) {
        throw new Error("Figma capture is missing the scoped node");
      }

      return { actual, output };
    }

    const design = capture();

    if (!verifier || (role === "ui" && !design)) {
      throw new Error("Capture the assigned Figma node first");
    }

    return {
      actual: call,
      output: await verifier(
        call.input,
        context.abortSignal ?? AbortSignal.timeout(90_000),
        design ?? {},
      ),
    };
  };

  return {
    async getModelTools(messages) {
      if (role === "atlassian") {
        return atlassianDefinitions(remote!, messages);
      }

      const available =
        role === "ui"
          ? [getFigma, ...(capture() ? [verifyUi] : [])]
          : role === "ac"
            ? [verifyAc]
            : [];

      return available.map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: convertSchemaToJsonSchema(tool.inputSchema)!,
      }));
    },
    async executeTool(messages, call, context, route = "direct") {
      const actual =
        role === "atlassian"
          ? atlassianCall(call, task)
          : call.name === "get_figma"
            ? scopedFigmaCall(call, task)
            : call;
      const receipt = state.receipts.find((entry) => entry.id === `${input.taskId}:${call.id}`);

      if (receipt) {
        if (receipt.name !== actual.name || digestOf(receipt.input) !== digestOf(actual.input)) {
          throw new Error("Receipt replay input conflict");
        }

        return receipt.output;
      }

      await input.guard(route === "codemode" ? "nested" : "tool", call.id);
      const invoked = await invoke(messages, actual, context);
      await save(recordFor(input, invoked.actual, invoked.output, route));

      return invoked.output;
    },
  };
}

export async function withRoleTools<T>(
  input: RoleToolsInput,
  use: (tools: RunTools) => Promise<T>,
): Promise<T> {
  const scoped = (remote?: RunTools) => use(agentTools(input.role, nativeRoleTools(input, remote)));

  return input.role === "atlassian" ? withRunTools((remote) => scoped(remote)) : scoped();
}
