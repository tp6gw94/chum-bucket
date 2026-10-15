import { convertSchemaToJsonSchema } from "@tanstack/ai";
import {
  browserAdapterVersion,
  browserFixture,
  verifyInputSchema,
  type Design,
} from "../../shared/testing";
import { jiraCommentParamsSchema, jiraCommentToolName } from "../../shared/tool-approval";
import { agentAccess } from "./agents";
import {
  guardActualIO,
  recordReceipt,
  taskReceipts,
  type TestingChildInput,
} from "./testing-store";
import {
  authorizedRead,
  designCaptureOf,
  figmaLinkOf,
  type DesignCapture,
  type RoleContext,
} from "./testing-domain";
import {
  catalogOf,
  createAgentTools,
  registration,
  type ExternalCall,
  type Registration,
  type RunTools,
  type ToolHooks,
} from "./tools";
import { discoveryToolName, withAtlassianScope } from "./tools/atlassian";
import { getFigma } from "./tools/get-figma";
import {
  createBrowserVerifier,
  verifyAcTool,
  verifyUiTool,
  type BrowserVerifier,
} from "./tools/use-browser";

const DESIGN_CAPTURE = "design_capture";
const ATLASSIAN_READS = new Set(["jira_get_issue", "confluence_get_page"]);
const JIRA_COMMENT_DESCRIPTION =
  "Propose a Jira comment for the user to approve. Nothing is posted until the user approves it; the result reports whether it was posted, rejected, failed, or cancelled.";
const jiraCommentInputSchema = convertSchemaToJsonSchema(jiraCommentParamsSchema);

export type RoleStore = Readonly<{
  guard: typeof guardActualIO;
  recordReceipt: typeof recordReceipt;
  receipts: typeof taskReceipts;
}>;

const defaultStore: RoleStore = { guard: guardActualIO, recordReceipt, receipts: taskReceipts };

export type RoleRuntime = Readonly<{
  child: TestingChildInput;
  context: RoleContext;
  store?: RoleStore;
}>;

function storeOf(runtime: RoleRuntime): RoleStore {
  return runtime.store ?? defaultStore;
}

type RoleState = {
  capture: DesignCapture | undefined;
  verifier: BrowserVerifier | undefined;
  readonly nested: Map<string, number>;
};

function designOf(context: RoleContext): Design | null {
  return context.role === "ui" ? context.plan.design : null;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

async function initialCapture(runtime: RoleRuntime): Promise<DesignCapture | undefined> {
  const receipts = await storeOf(runtime).receipts(runtime.child.taskId);

  return receipts.findLast((receipt) => receipt.nativeName === DESIGN_CAPTURE)?.output as
    | DesignCapture
    | undefined;
}

const proposalOverrides = {
  description: JIRA_COMMENT_DESCRIPTION,
  ...(jiraCommentInputSchema ? { inputSchema: jiraCommentInputSchema } : {}),
};

function proposalDefinition<T extends { name: string }>(definition: T): T {
  return definition.name === jiraCommentToolName
    ? { ...definition, ...proposalOverrides }
    : definition;
}

function proposalDiscovery(output: unknown): unknown {
  const discovered = record(output);

  if (!Array.isArray(discovered?.tools)) {
    return output;
  }

  return {
    ...discovered,
    tools: discovered.tools.map((tool: unknown) =>
      record(tool)?.name === jiraCommentToolName ? { ...record(tool), ...proposalOverrides } : tool,
    ),
  };
}

function figmaRegistration(context: RoleContext): Registration {
  return registration(getFigma, async (input, toolContext) => {
    const parsed = getFigma.inputSchema.parse(input);
    const design = designOf(context);
    const link = figmaLinkOf(parsed.target);
    const fileKey = link?.fileKey ?? parsed.target.trim();
    const nodeId = (parsed.nodeId ?? link?.nodeId)?.replace(/-/g, ":");

    if (!design || fileKey !== design.fileKey || nodeId !== design.nodeId) {
      throw new Error("get_figma is limited to task.design.fileKey and task.design.nodeId");
    }

    return getFigma.execute!({ ...parsed, target: fileKey, nodeId }, toolContext);
  });
}

function verifyRegistration(role: "ac" | "ui", state: RoleState): Registration {
  const tool = role === "ac" ? verifyAcTool : verifyUiTool;

  return registration(tool, async (input, toolContext) => {
    if (!state.verifier) {
      throw new Error(`${tool.name} is unavailable`);
    }

    return state.verifier.verify(verifyInputSchema.parse(input), toolContext.abortSignal);
  });
}

function roleCatalog(runtime: RoleRuntime, state: RoleState) {
  switch (runtime.context.role) {
    case "ac":
      return catalogOf([verifyRegistration("ac", state)]);
    case "ui":
      return catalogOf([figmaRegistration(runtime.context), verifyRegistration("ui", state)]);
    default:
      return catalogOf([]);
  }
}

function slotFor(runtime: RoleRuntime, state: RoleState, external: ExternalCall): string {
  const base = `${runtime.child.taskId}-io-${external.context.toolCallId ?? external.call.id}`;

  if (external.route === "direct") {
    return base;
  }

  const index = state.nested.get(base) ?? 0;
  state.nested.set(base, index + 1);

  return `${base}-n${index}`;
}

function bindingsFor(runtime: RoleRuntime, external: ExternalCall): Record<string, string> {
  const { name, input } = external.call;

  if (runtime.context.role === "atlassian" && ATLASSIAN_READS.has(name)) {
    return { source: authorizedRead(name, input, runtime.context.intent) };
  }

  if (name === getFigma.name) {
    const design = designOf(runtime.context);

    return design ? { fileKey: design.fileKey, nodeId: design.nodeId } : {};
  }

  return {};
}

async function receiptOf(
  runtime: RoleRuntime,
  slot: string,
  external: ExternalCall,
  output: unknown,
  bindings: Record<string, string>,
) {
  return storeOf(runtime).recordReceipt({
    taskId: runtime.child.taskId,
    attempt: runtime.child.attemptNonce,
    slot,
    nativeName: external.call.name,
    route: external.route,
    input: external.call.input,
    output,
    bindings,
  });
}

async function recordVerify(
  runtime: RoleRuntime,
  slot: string,
  external: ExternalCall,
  output: unknown,
) {
  const step = record(output);

  if (step?.state !== "finished") {
    return output;
  }

  const finished = { checkId: step.checkId, evidence: step.evidence };
  const receipt = await receiptOf(runtime, slot, external, finished, {
    checkId: String(step.checkId),
    fixture: `${browserFixture.id}@${browserFixture.version}`,
    adapter: browserAdapterVersion,
  });

  return { ...finished, receiptId: receipt.receiptId, outputDigest: receipt.outputDigest };
}

async function recordFigma(
  runtime: RoleRuntime,
  state: RoleState,
  slot: string,
  external: ExternalCall,
  output: unknown,
) {
  await receiptOf(runtime, slot, external, output, bindingsFor(runtime, external));
  const design = designOf(runtime.context);
  const capture = design ? designCaptureOf(output, design) : undefined;

  if (!capture) {
    return output;
  }

  await receiptOf(
    runtime,
    slot,
    { ...external, call: { ...external.call, name: DESIGN_CAPTURE } },
    capture,
    {
      fileKey: capture.fileKey,
      nodeId: capture.nodeId,
    },
  );
  state.capture = capture;

  return output;
}

async function recordOutput(
  runtime: RoleRuntime,
  state: RoleState,
  external: ExternalCall,
  output: unknown,
) {
  const name = external.call.name;

  if (name === discoveryToolName) {
    return proposalDiscovery(output);
  }

  const slot = slotFor(runtime, state, external);

  if (name === verifyAcTool.name || name === verifyUiTool.name) {
    return recordVerify(runtime, slot, external, output);
  }

  if (name === getFigma.name) {
    return recordFigma(runtime, state, slot, external, output);
  }

  await receiptOf(runtime, slot, external, output, bindingsFor(runtime, external));

  return output;
}

async function guard(runtime: RoleRuntime, kind: "tool" | "nested", step: string, name: string) {
  const result = await storeOf(runtime).guard({
    taskId: runtime.child.taskId,
    attemptNonce: runtime.child.attemptNonce,
    childWorkflowId: runtime.child.childWorkflowId,
    kind,
    step,
    name,
  });

  if (result.state === "denied") {
    throw new Error(`Denied: ${result.reason}`);
  }
}

function roleHooks(runtime: RoleRuntime, state: RoleState): ToolHooks {
  const role = runtime.context.role;

  return {
    visible: (name) => role !== "ui" || name !== verifyUiTool.name || state.capture !== undefined,
    prepare: (external) => {
      if (external.call.name === jiraCommentToolName) {
        throw new Error(
          `${jiraCommentToolName} is posted only after user approval and cannot run directly`,
        );
      }

      if (role === "atlassian" && ATLASSIAN_READS.has(external.call.name)) {
        bindingsFor(runtime, external);
      }

      return external.call;
    },
    invoke: async (external, run) => {
      if (external.route === "codemode") {
        await guard(
          runtime,
          "nested",
          `nested:${external.context.toolCallId ?? external.call.id}`,
          external.call.name,
        );
      }

      return recordOutput(runtime, state, external, await run());
    },
  };
}

function guarded(runtime: RoleRuntime, tools: RunTools): RunTools {
  return {
    async getModelTools(messages) {
      const turn = await tools.getModelTools(messages);

      return { ...turn, definitions: turn.definitions.map(proposalDefinition) };
    },
    async executeTool(messages, call, context) {
      await guard(runtime, "tool", `tool:${call.id}`, call.name);

      return tools.executeTool(messages, call, context);
    },
  };
}

function browserVerifier(runtime: RoleRuntime, state: RoleState): BrowserVerifier | undefined {
  const context = runtime.context;

  if (context.role !== "ac" && context.role !== "ui") {
    return undefined;
  }

  return createBrowserVerifier({
    role: context.role,
    taskId: runtime.child.taskId,
    plan: context.plan,
    targetUrl: context.targetUrl,
    capture: async () => state.capture,
  });
}

export async function withRoleTools<T>(
  runtime: RoleRuntime,
  use: (tools: RunTools) => Promise<T>,
): Promise<T> {
  const state: RoleState = {
    capture: runtime.context.role === "ui" ? await initialCapture(runtime) : undefined,
    verifier: undefined,
    nested: new Map(),
  };
  state.verifier = browserVerifier(runtime, state);

  try {
    return await withAtlassianScope((scope) =>
      use(
        guarded(
          runtime,
          createAgentTools({
            access: agentAccess(runtime.child.role),
            scope,
            catalog: roleCatalog(runtime, state),
            hooks: roleHooks(runtime, state),
          }),
        ),
      ),
    );
  } finally {
    state.verifier?.dispose();
  }
}
