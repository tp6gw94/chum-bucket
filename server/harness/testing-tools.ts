import {
  convertSchemaToJsonSchema,
  type JSONSchema,
  type Tool,
  type ToolExecutionContext,
  type UIMessage,
} from "@tanstack/ai";
import { z } from "zod";
import {
  browserOutputSchema,
  designCaptureSchema,
  useBrowserInputSchema,
  type BrowserHandoff,
  type DesignCapture,
  type DesignReference,
  type FunctionalCheck,
  type PlanCheck,
  type StyleCheck,
  type RoleId,
  type TestingRequestInput,
} from "../../shared/testing";
import type { ModelCall } from "./model-turn";
import { toolArgumentSchemas } from "../../shared/tool-approval";
import { allowsTool, roleRegistry, toolNamesFor } from "./agents";
import {
  checksForRole,
  digestOf,
  sameSource,
  type CanonicalPlan,
  type Requirements,
} from "./testing-domain";
import {
  discoveryToolName,
  withAtlassianScope,
  type AtlassianScope,
  type ModelTool,
} from "./tools/atlassian";
import {
  figmaUrlTarget,
  readSource,
  withIssueFields,
  withPageMetadata,
  withRemoteLinks,
} from "./source-links";
import { codeModeToolName, composeCodeModeTurn, type CodeModeTurn } from "./tools/code-mode";
import { toolOutputSchemas } from "./tools/output-schemas";
import { createUseBrowserTool, type BrowserAdapter } from "./tools/use-browser";
import type { RunTools } from "./tools";

export type TestingNativeRoute = "direct" | "codemode";

export type TestingNativeInvocation = Readonly<{
  call: ModelCall;
  input: unknown;
  nativeName: string;
  route: TestingNativeRoute;
  context: ToolExecutionContext;
}>;

export type TestingNativeReceipt = Readonly<{
  kind: "receipted";
  output: unknown;
  receiptId: string;
  outputDigest: string;
}>;

export type TestingNativeEnvelope =
  | TestingNativeReceipt
  | Readonly<{ kind: "ephemeral"; output: BrowserHandoff }>;

export type TestingNativeReceiptReference = Readonly<
  Pick<TestingNativeReceipt, "receiptId" | "outputDigest">
>;

export type TestingNativeHost = Readonly<{
  invoke: (
    invocation: TestingNativeInvocation,
    work: () => Promise<unknown>,
  ) => Promise<TestingNativeEnvelope>;
  captureDesign: (
    input: Readonly<{
      reference: DesignReference;
      raw: unknown;
      nativeReceipt: TestingNativeReceiptReference;
    }>,
  ) => Promise<DesignCaptureResult>;
  restoredDesign?: DesignCaptureResult;
  browserFixture?: BrowserAdapter;
}>;

export type DesignCaptureResult = Readonly<{
  properties: Readonly<Record<string, string>>;
  capture: DesignCapture;
}>;

export type TestingRoleToolsInput = Readonly<{
  role: RoleId;
  intent: TestingRequestInput;
  requirements: Requirements | null;
  plan: CanonicalPlan | null;
  host: TestingNativeHost;
}>;

type RoleRun = Readonly<{
  tools: RunTools;
  quiet: () => Promise<void>;
}>;

type NativeDispatch = (
  call: ModelCall,
  context: ToolExecutionContext,
  route: TestingNativeRoute,
) => Promise<unknown>;

type BrowserTool = ReturnType<typeof createUseBrowserTool>;

export function testingRoleToolNames(role: RoleId): readonly string[] {
  return toolNamesFor(role);
}

function roleNativeNames(role: RoleId): ReadonlySet<string> {
  return new Set(testingRoleToolNames(role));
}

function definitionOf(tool: Pick<Tool, "name" | "description" | "inputSchema">): ModelTool {
  const inputSchema = convertSchemaToJsonSchema(tool.inputSchema);

  if (!inputSchema) {
    throw new Error("Tool schema is unavailable");
  }

  return { name: tool.name, description: tool.description, inputSchema };
}

const envelopeSchema = z.strictObject({
  kind: z.literal("receipted"),
  output: z.unknown(),
  receiptId: z.string().trim().min(1).max(128),
  outputDigest: z.string().trim().min(1).max(128),
});

function envelopeOf(value: unknown): TestingNativeReceipt {
  const parsed = envelopeSchema.safeParse(value);

  if (!parsed.success) {
    throw new Error("Host native receipt envelope is invalid");
  }

  const output = parsed.data.output;

  if (digestOf(output) !== parsed.data.outputDigest) {
    throw new Error("Host native receipt digest does not match its output");
  }

  return {
    kind: "receipted",
    output,
    receiptId: parsed.data.receiptId,
    outputDigest: parsed.data.outputDigest,
  };
}

function roleRunTools(options: {
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
    (call: ModelCall, context: ToolExecutionContext, route: TestingNativeRoute) => {
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

function restrictedDiscovery(definition: ModelTool, names: readonly string[]): ModelTool {
  return {
    ...definition,
    inputSchema: {
      type: "object",
      properties: {
        toolNames: {
          type: "array",
          items: { type: "string", enum: [...names] },
          minItems: 1,
        },
      },
      required: ["toolNames"],
      additionalProperties: false,
    } as JSONSchema,
  };
}

function requireRequestedDiscovery(input: unknown, allowed: ReadonlySet<string>): void {
  const names =
    input && typeof input === "object" ? (input as { toolNames?: unknown }).toolNames : undefined;

  if (
    !Array.isArray(names) ||
    names.length === 0 ||
    names.some((name) => typeof name !== "string" || !allowed.has(name))
  ) {
    throw new Error("discover_atlassian_tools is restricted to required read-only tools");
  }
}

const HOST_READ_INPUTS: Readonly<Record<string, (input: unknown) => unknown>> = {
  jira_get_issue: (input) => withRemoteLinks(withIssueFields(input)),
  confluence_get_page: withPageMetadata,
};

function authorizedRead(name: string, raw: unknown, intent: TestingRequestInput): boolean {
  const reference = readSource(name, raw);

  return reference !== null && intent.sources.some((source) => sameSource(source, reference));
}

async function atlassianRoleTools(
  input: TestingRoleToolsInput,
  scope: AtlassianScope,
  signal?: AbortSignal,
): Promise<RoleRun> {
  const allowed = roleNativeNames("atlassian");
  const composeAtlassianTools = roleRegistry.atlassian.tools[0];

  return roleRunTools({
    role: "atlassian",
    signal,
    guard: await scope.guard(),
    definitions: async (messages) => {
      const definitions = await scope.getModelTools(messages, (catalog) => [
        ...composeAtlassianTools.create(catalog),
      ]);

      return definitions
        .filter(
          (definition) => allowed.has(definition.name) || definition.name === discoveryToolName,
        )
        .map((definition) =>
          definition.name === discoveryToolName
            ? restrictedDiscovery(definition, [...allowed])
            : definition.name === "jira_add_comment"
              ? {
                  ...definition,
                  description:
                    "Propose this exact Jira comment for human approval. Never sends before approval. Rejection is final for this task. Continue reading the requested sources; the host assembles the requirements artifact.",
                  inputSchema: convertSchemaToJsonSchema(toolArgumentSchemas.jira_add_comment)!,
                }
              : definition,
        );
    },
    dispatch: (messages) => async (call, context, route) => {
      if (call.name !== discoveryToolName && !allowed.has(call.name)) {
        throw new Error("Unknown tool");
      }

      if (call.name === "jira_add_comment") {
        throw new Error("Jira comments require durable orchestration approval");
      }

      if (call.name === discoveryToolName) {
        requireRequestedDiscovery(call.input, allowed);
      } else if (!authorizedRead(call.name, call.input, input.intent)) {
        throw new Error(`Tool ${call.name} is not authorized for the requested sources`);
      }

      const hostInput = HOST_READ_INPUTS[call.name];
      const hostCall = hostInput ? { ...call, input: hostInput(call.input) } : call;
      const envelope = envelopeOf(
        await input.host.invoke(
          { call: hostCall, input: hostCall.input, nativeName: call.name, route, context },
          () => scope.executeTool(messages, hostCall, context, undefined),
        ),
      );

      return envelope.output;
    },
  });
}

function plannerRoleTools(signal?: AbortSignal): RoleRun {
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

function hostFixture(host: TestingNativeHost): BrowserAdapter {
  if (!host.browserFixture) {
    throw new Error("Host browser fixture is required");
  }

  return host.browserFixture;
}

function browserChecks(plan: CanonicalPlan, kind: "functional"): readonly FunctionalCheck[];
function browserChecks(plan: CanonicalPlan, kind: "style"): readonly StyleCheck[];

function browserChecks(plan: CanonicalPlan, kind: PlanCheck["kind"]): readonly PlanCheck[] {
  const checks =
    kind === "functional" ? checksForRole(plan.cases, "ac") : checksForRole(plan.cases, "ui");

  if (checks.length === 0) {
    throw new Error(`No ${kind} checks are assigned to the browser role`);
  }

  return checks;
}

async function browserEnvelope(
  host: TestingNativeHost,
  browser: BrowserTool,
  call: ModelCall,
  context: ToolExecutionContext,
  route: TestingNativeRoute,
): Promise<unknown> {
  const parsed = useBrowserInputSchema.parse(call.input);
  const result = await host.invoke(
    { call, input: parsed, nativeName: call.name, route, context },
    async () => browser.execute!(parsed, context),
  );

  if (result.kind === "ephemeral") {
    return result.output;
  }

  const envelope = envelopeOf(result);
  const output = browserOutputSchema.parse(envelope.output);

  if (output.checkId !== parsed.checkId) {
    throw new Error("Host browser output does not match the requested check");
  }

  return {
    ...output,
    receiptId: envelope.receiptId,
    outputDigest: envelope.outputDigest,
  };
}

function acRoleTools(input: TestingRoleToolsInput, signal?: AbortSignal): RoleRun {
  if (!input.plan) {
    throw new Error("AC role requires a canonical plan");
  }

  const plan = input.plan;
  const checks = browserChecks(plan, "functional");
  const fixture = hostFixture(input.host);
  const browser = createUseBrowserTool(
    {
      role: "ac",
      cases: plan.cases,
      checks,
      fixture,
      figmaProperties: null,
      designCapture: null,
    },
    roleRegistry.ac.tools[0],
  );
  const definition = definitionOf(browser);

  return roleRunTools({
    role: "ac",
    signal,
    guard: () => undefined,
    definitions: async () => [definition],
    dispatch: () => async (call, context, route) => {
      if (call.name !== browser.name) {
        throw new Error("Unknown tool");
      }

      return browserEnvelope(input.host, browser, call, context, route);
    },
  });
}

function pendingBrowserDefinition(tool: Tool): ModelTool {
  return {
    ...definitionOf(tool),
    description:
      "Verify one assigned canonical check using the live browser adapter after capturing the requested Figma design. Supply checkId, and resolution only to answer the pending handoff of a selection_required or fill_value_required result; the host owns actions, targets and observations.",
  };
}

const figmaOutputSchema = z.looseObject({
  fileKey: z.string(),
  truncated: z.boolean().optional(),
  nodes: z.array(z.looseObject({ id: z.string(), visible: z.boolean().optional() })).optional(),
});

export function requestedFigmaTarget(target: string, nodeId: string | undefined): DesignReference {
  const trimmed = target.trim();
  const parsed = /^https?:\/\//i.test(trimmed)
    ? figmaUrlTarget(trimmed)
    : { fileKey: trimmed, nodeId: undefined as string | undefined };
  const node = (nodeId ?? parsed.nodeId)?.replace(/-/g, ":");

  if (!/^[a-zA-Z0-9]+$/.test(parsed.fileKey)) {
    throw new Error("Invalid Figma file key.");
  }

  if (!node || !/^\d+:\d+$/.test(node)) {
    throw new Error("Invalid Figma node ID.");
  }

  return { fileKey: parsed.fileKey, nodeId: node };
}

function requireCapturedFigmaRoot(output: unknown, reference: DesignReference): void {
  const parsed = figmaOutputSchema.safeParse(output);

  if (!parsed.success || parsed.data.truncated === true) {
    throw new Error("Figma output is truncated or incomplete");
  }

  const [root] = parsed.data.nodes ?? [];

  if (
    parsed.data.fileKey !== reference.fileKey ||
    !root ||
    root.visible === false ||
    root.id !== reference.nodeId
  ) {
    throw new Error("Figma output does not contain the requested root node");
  }
}

const designCaptureResultSchema = z.strictObject({
  properties: z.record(z.string(), z.string()),
  capture: designCaptureSchema,
});

function acceptDesignCapture(
  result: unknown,
  checks: readonly PlanCheck[],
  design: DesignReference,
): DesignCaptureResult {
  const parsed = designCaptureResultSchema.safeParse(result);

  if (!parsed.success) {
    throw new Error("Host design capture is invalid");
  }

  const { properties, capture } = parsed.data;

  if (capture.reference.fileKey !== design.fileKey || capture.reference.nodeId !== design.nodeId) {
    throw new Error("Host design capture references the wrong design");
  }

  if (capture.propertiesDigest !== digestOf(properties)) {
    throw new Error("Host design capture digest does not match the normalized properties");
  }

  for (const check of checks) {
    if (check.kind === "style" && properties[check.property] === undefined) {
      throw new Error(`Host design capture is missing property ${check.property}`);
    }
  }

  return { properties, capture };
}

function uiRoleTools(input: TestingRoleToolsInput, signal?: AbortSignal): RoleRun {
  if (!input.plan) {
    throw new Error("UI role requires a canonical plan");
  }

  const plan = input.plan;
  const checks = browserChecks(plan, "style");
  const fixture = hostFixture(input.host);
  const design = input.intent.design;

  if (!design) {
    throw new Error("UI role requires a requested design");
  }

  if (
    !plan.design ||
    plan.design.fileKey !== design.fileKey ||
    plan.design.nodeId !== design.nodeId
  ) {
    throw new Error("Canonical plan design does not match the requested design");
  }

  const [browserReference, figmaReference] = roleRegistry.ui.tools;
  const figmaDefinition = definitionOf(figmaReference);
  let capture: DesignCaptureResult | null = input.host.restoredDesign
    ? acceptDesignCapture(input.host.restoredDesign, checks, design)
    : null;

  const currentBrowser = (): BrowserTool => {
    if (!capture) {
      throw new Error("verify_ui requires an accepted Figma capture");
    }

    return createUseBrowserTool(
      {
        role: "ui",
        cases: plan.cases,
        checks,
        fixture,
        figmaProperties: capture.properties,
        designCapture: capture.capture,
      },
      browserReference,
    );
  };

  return roleRunTools({
    role: "ui",
    signal,
    guard: () => undefined,
    definitions: async () => [
      figmaDefinition,
      capture ? definitionOf(currentBrowser()) : pendingBrowserDefinition(browserReference),
    ],
    dispatch: () => async (call, context, route) => {
      if (call.name === figmaReference.name) {
        const parsed = figmaReference.inputSchema.parse(call.input);
        const reference = requestedFigmaTarget(parsed.target, parsed.nodeId);

        if (reference.fileKey !== design.fileKey || reference.nodeId !== design.nodeId) {
          throw new Error("get_figma is restricted to the requested design");
        }

        const envelope = envelopeOf(
          await input.host.invoke(
            { call, input: parsed, nativeName: "get_figma", route, context },
            async () => figmaReference.execute!(parsed, context),
          ),
        );
        requireCapturedFigmaRoot(envelope.output, reference);
        const result = await input.host.captureDesign({
          reference,
          raw: envelope.output,
          nativeReceipt: { receiptId: envelope.receiptId, outputDigest: envelope.outputDigest },
        });
        capture = acceptDesignCapture(result, checks, design);

        return envelope.output;
      }

      if (call.name === browserReference.name) {
        const browser = currentBrowser();

        return browserEnvelope(input.host, browser, call, context, route);
      }

      throw new Error("Unknown tool");
    },
  });
}

export async function withTestingRoleTools<T>(
  input: TestingRoleToolsInput,
  use: (tools: RunTools) => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  signal?.throwIfAborted();

  if (input.role === "atlassian") {
    return withAtlassianScope(async (scope) => {
      const run = await atlassianRoleTools(input, scope, signal);

      try {
        return await use(run.tools);
      } finally {
        await run.quiet();
      }
    }, signal);
  }

  const run =
    input.role === "planner"
      ? plannerRoleTools(signal)
      : input.role === "ac"
        ? acRoleTools(input, signal)
        : uiRoleTools(input, signal);

  try {
    return await use(run.tools);
  } finally {
    await run.quiet();
  }
}
