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
  type DesignCapture,
  type DesignReference,
  type FunctionalCheck,
  type PlanCheck,
  type StyleCheck,
  type RoleId,
  type Source,
  type TestingRequestInput,
} from "../../shared/testing";
import type { ModelCall } from "./model-turn";
import { capabilityToolNames, roleRegistry } from "./agents";
import {
  checksForRole,
  digestOf,
  type CanonicalPlan,
  type Requirements,
  type SourceCapture,
} from "./testing-domain";
import {
  discoveryToolName,
  withAtlassianScope,
  type AtlassianScope,
  type ModelTool,
} from "./tools/atlassian";
import { atlassianTools } from "./tools/atlassian-policy";
import { codeModeToolName, composeCodeModeTurn, type CodeModeTurn } from "./tools/code-mode";
import { getFigma } from "./tools/get-figma";
import {
  createUseBrowserTool,
  type BrowserFixture,
  type MockBrowserOutcome,
} from "./tools/use-browser";
import type { RunTools } from "./tools";

export type TestingNativeRoute = "direct" | "codemode";

export type TestingNativeInvocation = Readonly<{
  call: ModelCall;
  input: unknown;
  nativeName: string;
  route: TestingNativeRoute;
  context: ToolExecutionContext;
}>;

export type TestingNativeEnvelope = Readonly<{
  output: unknown;
  receiptId: string;
  outputDigest: string;
}>;

export type TestingNativeReceiptReference = Readonly<
  Pick<TestingNativeEnvelope, "receiptId" | "outputDigest">
>;

export type TestingNativeHost = Readonly<{
  invoke: (
    invocation: TestingNativeInvocation,
    work: () => Promise<unknown>,
  ) => Promise<TestingNativeEnvelope>;
  captureSource: (
    input: Readonly<{
      reference: Source;
      raw: unknown;
      nativeReceipt: TestingNativeReceiptReference;
    }>,
  ) => Promise<SourceCapture>;
  captureDesign: (
    input: Readonly<{
      reference: DesignReference;
      raw: unknown;
      nativeReceipt: TestingNativeReceiptReference;
    }>,
  ) => Promise<DesignCaptureResult>;
  restoredDesign?: DesignCaptureResult;
  browserFixture?: BrowserFixture;
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

const requiredAtlassianReadNames: readonly string[] = [...atlassianTools]
  .filter(([, policy]) => policy.required)
  .map(([name]) => name);

export function testingRoleToolNames(role: RoleId): readonly string[] {
  return roleRegistry[role].capabilities.flatMap((capability) => {
    const name = capabilityToolNames[capability];

    return name === null ? requiredAtlassianReadNames : [name];
  });
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
  output: z.unknown(),
  receiptId: z.string().trim().min(1).max(128),
  outputDigest: z.string().trim().min(1).max(128),
});

function envelopeOf(value: unknown): TestingNativeEnvelope {
  const parsed = envelopeSchema.safeParse(value);

  if (!parsed.success) {
    throw new Error("Host native receipt envelope is invalid");
  }

  const output = parsed.data.output;

  if (digestOf(output) !== parsed.data.outputDigest) {
    throw new Error("Host native receipt digest does not match its output");
  }

  return { output, receiptId: parsed.data.receiptId, outputDigest: parsed.data.outputDigest };
}

function roleRunTools(options: {
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
      definitions,
      dispatch: (call, context) => dispatchFor(messages)(call, context, "codemode"),
      guard: options.guard,
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

function sourceValue(raw: unknown, key: string): string {
  if (!raw || typeof raw !== "object") {
    return "";
  }

  const value = (raw as Record<string, unknown>)[key];

  return typeof value === "string" ? value : "";
}

function requestedJiraSource(raw: unknown, intent: TestingRequestInput): Source | null {
  const issueKey = sourceValue(raw, "issue_key");

  if (issueKey.length === 0) {
    return null;
  }

  return intent.sources.some((source) => source.kind === "jira" && source.issueKey === issueKey)
    ? { kind: "jira", issueKey }
    : null;
}

function requestedConfluenceSource(raw: unknown, intent: TestingRequestInput): Source | null {
  const pageId = sourceValue(raw, "page_id");

  if (pageId.length === 0) {
    return null;
  }

  return intent.sources.some((source) => source.kind === "confluence" && source.pageId === pageId)
    ? { kind: "confluence", pageId }
    : null;
}

function requestedSource(name: string, raw: unknown, intent: TestingRequestInput): Source | null {
  if (name === "jira_get_issue") {
    return requestedJiraSource(raw, intent);
  }

  if (name === "confluence_get_page") {
    return requestedConfluenceSource(raw, intent);
  }

  return null;
}

async function atlassianRoleTools(
  input: TestingRoleToolsInput,
  scope: AtlassianScope,
  signal?: AbortSignal,
): Promise<RoleRun> {
  const allowed = roleNativeNames("atlassian");

  return roleRunTools({
    signal,
    guard: await scope.guard(),
    definitions: async (messages) => {
      const definitions = await scope.getModelTools(messages, (catalog) =>
        [...catalog].filter(([name]) => allowed.has(name)).map(([, definition]) => definition),
      );

      return definitions
        .filter(
          (definition) => allowed.has(definition.name) || definition.name === discoveryToolName,
        )
        .map((definition) =>
          definition.name === discoveryToolName
            ? restrictedDiscovery(definition, [...allowed])
            : definition,
        );
    },
    dispatch: (messages) => async (call, context, route) => {
      if (call.name !== discoveryToolName && !allowed.has(call.name)) {
        throw new Error("Unknown tool");
      }

      const invocation = {
        call,
        input: call.input,
        nativeName: call.name,
        route,
        context,
      } as const;

      if (call.name === discoveryToolName) {
        requireRequestedDiscovery(call.input, allowed);
        const envelope = envelopeOf(
          await input.host.invoke(invocation, () =>
            scope.executeTool(messages, call, context, undefined),
          ),
        );

        return envelope.output;
      }

      const reference = requestedSource(call.name, call.input, input.intent);

      if (!reference) {
        throw new Error(`Tool ${call.name} is not authorized for the requested sources`);
      }

      const envelope = envelopeOf(
        await input.host.invoke(invocation, () =>
          scope.executeTool(messages, call, context, undefined),
        ),
      );
      const sourceCapture = await input.host.captureSource({
        reference,
        raw: envelope.output,
        nativeReceipt: { receiptId: envelope.receiptId, outputDigest: envelope.outputDigest },
      });

      return { output: envelope.output, sourceCapture };
    },
  });
}

function plannerRoleTools(signal?: AbortSignal): RoleRun {
  return roleRunTools({
    signal,
    guard: () => undefined,
    definitions: async () => [],
    dispatch: () => async (call) => {
      throw new Error(`Tool ${call.name} is not available to the planner role`);
    },
  });
}

function hostFixture(host: TestingNativeHost): BrowserFixture {
  if (!host.browserFixture) {
    throw new Error("Host browser fixture is required");
  }

  return host.browserFixture;
}

function projectFixture(fixture: BrowserFixture, checks: readonly PlanCheck[]): BrowserFixture {
  const outcomes: Record<string, MockBrowserOutcome> = {};

  for (const check of checks) {
    const outcome = fixture.outcomes[check.id];

    if (!outcome) {
      throw new Error(`Host browser fixture has no outcome for ${check.id}`);
    }

    outcomes[check.id] = outcome;
  }

  return {
    identity: fixture.identity,
    adapterVersion: fixture.adapterVersion,
    outcomes,
  };
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
  const envelope = envelopeOf(
    await host.invoke(
      { call, input: parsed, nativeName: "use_browser", route, context },
      async () => browser.execute!(parsed, context),
    ),
  );
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
  const fixture = projectFixture(hostFixture(input.host), checks);
  const browser = createUseBrowserTool({
    role: "ac",
    cases: plan.cases,
    checks,
    fixture,
    figmaProperties: null,
    designCapture: null,
  });
  const definition = definitionOf(browser);

  return roleRunTools({
    signal,
    guard: () => undefined,
    definitions: async () => [definition],
    dispatch: () => async (call, context, route) => {
      if (call.name !== "use_browser") {
        throw new Error("Unknown tool");
      }

      return browserEnvelope(input.host, browser, call, context, route);
    },
  });
}

const stubUseBrowserDefinition: ModelTool = {
  name: "use_browser",
  description:
    "Run one assigned browser check against the host-provided deterministic fixture. Pass the check ID from the canonical plan. The host fixture decides the observed result; it is never chosen by the caller.",
  inputSchema: (() => {
    const inputSchema = convertSchemaToJsonSchema(useBrowserInputSchema);

    if (!inputSchema) {
      throw new Error("Tool schema is unavailable");
    }

    return inputSchema;
  })(),
};

const figmaOutputSchema = z.looseObject({
  fileKey: z.string(),
  truncated: z.boolean().optional(),
  nodes: z.array(z.looseObject({ id: z.string(), visible: z.boolean().optional() })).optional(),
});

const FIGMA_HOSTS = new Set(["figma.com", "www.figma.com"]);

function figmaUrlTarget(target: string): { fileKey: string; nodeId: string | undefined } {
  const url = new URL(target);

  if (!FIGMA_HOSTS.has(url.hostname)) {
    throw new Error("Expected a Figma URL.");
  }

  const match = url.pathname.match(/^\/(?:file|design)\/([a-zA-Z0-9]+)(?:\/|$)/);

  if (!match) {
    throw new Error("Expected a Figma file or design URL.");
  }

  return {
    fileKey: url.pathname.match(/\/branch\/([a-zA-Z0-9]+)(?:\/|$)/)?.[1] ?? match[1]!,
    nodeId: url.searchParams.get("node-id") ?? undefined,
  };
}

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
  const fixture = projectFixture(hostFixture(input.host), checks);
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

  const figmaDefinition = definitionOf(getFigma);
  let capture: DesignCaptureResult | null = input.host.restoredDesign
    ? acceptDesignCapture(input.host.restoredDesign, checks, design)
    : null;

  const currentBrowser = (): BrowserTool => {
    if (!capture) {
      throw new Error("use_browser requires an accepted Figma capture");
    }

    return createUseBrowserTool({
      role: "ui",
      cases: plan.cases,
      checks,
      fixture,
      figmaProperties: capture.properties,
      designCapture: capture.capture,
    });
  };

  return roleRunTools({
    signal,
    guard: () => undefined,
    definitions: async () => [
      figmaDefinition,
      capture ? definitionOf(currentBrowser()) : stubUseBrowserDefinition,
    ],
    dispatch: () => async (call, context, route) => {
      if (call.name === "get_figma") {
        const parsed = getFigma.inputSchema.parse(call.input);
        const reference = requestedFigmaTarget(parsed.target, parsed.nodeId);

        if (reference.fileKey !== design.fileKey || reference.nodeId !== design.nodeId) {
          throw new Error("get_figma is restricted to the requested design");
        }

        const envelope = envelopeOf(
          await input.host.invoke(
            { call, input: parsed, nativeName: "get_figma", route, context },
            async () => getFigma.execute!(parsed, context),
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

      if (call.name === "use_browser") {
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
