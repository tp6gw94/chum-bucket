import {
  convertSchemaToJsonSchema,
  parseWithStandardSchema,
  type JSONSchema,
  type ToolExecutionContext,
} from "@tanstack/ai";
import {
  createCodeMode,
  generateTypeStubs,
  stripTypeScript,
  toolsToBindings,
  type CodeModeTool,
  type IsolateDriver,
} from "@tanstack/ai-code-mode";
import { createQuickJSIsolateDriver } from "@tanstack/ai-isolate-quickjs";
import { z } from "zod";
import { codeModeDescription, codeModeSystemPrompt } from "../prompts";
import type { ModelCall } from "../model-turn";
import { discoveryToolName, ToolBoundaryError, type ModelTool } from "./atlassian";

export const codeModeToolName = "codemode";

const codeModeInputSchema = z
  .object({
    code: z
      .string()
      .describe("TypeScript code to execute in the sandbox. Return a value to pass results back."),
  })
  .strict();

class CodeModeBoundaryError extends Error {}

export type CodeModePolicy = Readonly<{
  timeoutMs: number;
  memoryLimitMb: number;
  maxSourceBytes: number;
  maxHostInputBytes: number;
  maxHostCalls: number;
  maxHostResultBytes: number;
  maxConsoleEntries: number;
  maxConsoleBytes: number;
  maxConsoleEntryBytes: number;
  maxResultBytes: number;
}>;

export type CodeModeTurn = Readonly<{
  definition: ModelTool;
  systemPrompt: string;
  execute: (input: unknown, context: ToolExecutionContext) => Promise<unknown>;
}>;

type Guard = (value: unknown) => void;
type Dispatch = (call: ModelCall, context: ToolExecutionContext) => Promise<unknown>;

const defaultPolicy: CodeModePolicy = {
  timeoutMs: 30_000,
  memoryLimitMb: 128,
  maxSourceBytes: 60_000,
  maxHostInputBytes: 64_000,
  maxHostCalls: 24,
  maxHostResultBytes: 1_000_000,
  maxConsoleEntries: 64,
  maxConsoleBytes: 16_384,
  maxConsoleEntryBytes: 2048,
  maxResultBytes: 256_000,
};

const quickjsDriver: IsolateDriver = createQuickJSIsolateDriver();

const consoleRuntime = `(maxEntries, maxBytes, maxEntry) => {
  const seen = { entries: 0, bytes: 0 };
  const defineProperty = Object.defineProperty;
  const stringify = JSON.stringify;
  const stringCtor = String;
  const charAt = Function.prototype.call.bind(String.prototype.charCodeAt);
  const part = Function.prototype.call.bind(String.prototype.slice);
  const render = (value) => {
    if (typeof value === "string") return value;
    try {
      const encodedText = stringify(value);
      return typeof encodedText === "string" ? encodedText : stringCtor(value);
    } catch (failure) {
      try {
        return stringCtor(value);
      } catch (unprintable) {
        return "[unprintable]";
      }
    }
  };
  const fit = (text, budget) => {
    let bytes = 0;
    let index = 0;
    const length = text.length;
    while (index < length) {
      const code = charAt(text, index);
      let size = code < 0x80 ? 1 : code < 0x800 ? 2 : 3;
      if (code >= 0xd800 && code <= 0xdbff && index + 1 < length) {
        const next = charAt(text, index + 1);
        if (next >= 0xdc00 && next <= 0xdfff) size = 4;
      }
      if (bytes + size > budget) break;
      bytes += size;
      index += size === 4 ? 2 : 1;
    }
    return {
      text: index === length ? text : part(text, 0, index),
      bytes,
      truncated: index < length
    };
  };
  const publish = (host, prefix, args) => {
    if (seen.entries >= maxEntries) return;
    const remaining = maxBytes - seen.bytes - prefix.length;
    if (remaining <= 0) return;
    let budget = maxEntry - prefix.length;
    if (budget > remaining) budget = remaining;
    if (budget <= 0) return;
    let content = "";
    let bytes = 0;
    for (let index = 0; index < args.length; index += 1) {
      const separator = index > 0 ? 1 : 0;
      if (bytes + separator > budget) break;
      const chunk = fit(render(args[index]), budget - bytes - separator);
      if (separator) {
        content += " ";
        bytes += 1;
      }
      content += chunk.text;
      bytes += chunk.bytes;
      if (chunk.truncated) break;
    }
    seen.entries += 1;
    seen.bytes += prefix.length + bytes;
    host(content);
  };
  const install = (name, host, prefix) => {
    defineProperty(console, name, {
      value: (...args) => publish(host, prefix, args),
      writable: false,
      configurable: false,
      enumerable: true
    });
  };
  install("log", console.log, "");
  install("error", console.error, "ERROR: ");
  install("warn", console.warn, "WARN: ");
  install("info", console.info, "INFO: ");
  defineProperty(globalThis, "console", {
    value: console,
    writable: false,
    configurable: false
  });
}`;

function consolePolicy(policy: CodeModePolicy): string {
  return `(${consoleRuntime})(${policy.maxConsoleEntries}, ${policy.maxConsoleBytes}, ${policy.maxConsoleEntryBytes});`;
}

function encoded(value: unknown): string {
  const text = JSON.stringify(value);

  return text === undefined ? "" : text;
}

function byteLength(value: unknown): number {
  return Buffer.byteLength(encoded(value));
}

type ProjectedEvent = Readonly<{ name: string; value: Record<string, unknown> }>;
type EventProjector = (payload: Record<string, unknown>) => Record<string, unknown>;

const eventProjectors = new Map<string, EventProjector>([
  ["code_mode:execution_started", (payload) => ({ codeLength: payload.codeLength ?? 0 })],
  [
    "code_mode:console",
    (payload) => ({
      level: payload.level ?? "log",
      byteLength: typeof payload.message === "string" ? Buffer.byteLength(payload.message) : 0,
    }),
  ],
  [
    "code_mode:external_call",
    (payload) => ({ function: payload.function ?? "", argumentBytes: byteLength(payload.args) }),
  ],
  [
    "code_mode:external_result",
    (payload) => ({
      function: payload.function ?? "",
      duration: payload.duration ?? 0,
      resultBytes: byteLength(payload.result),
    }),
  ],
  [
    "code_mode:external_error",
    (payload) => ({ function: payload.function ?? "", duration: payload.duration ?? 0 }),
  ],
  [
    "code_mode:execution_finished",
    (payload) => ({
      phase: payload.phase ?? "",
      success: payload.success === true,
      durationMs: payload.durationMs ?? 0,
      logCount: payload.logCount ?? 0,
    }),
  ],
]);

function projectEvent(name: string, payload: Record<string, unknown>): ProjectedEvent | undefined {
  const projector = eventProjectors.get(name);

  if (!projector) {
    return undefined;
  }

  return { name, value: projector(payload) };
}

function assertObjectInput(value: unknown): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new CodeModeBoundaryError("codemode tool input must be an object");
  }
}

type CodeModeState = {
  parentCallId: string;
  signal: AbortSignal | undefined;
  controller: AbortController | undefined;
  calls: number;
  closed: boolean;
  fatal: boolean;
  fatalMessage: string;
};

type CodeModeBoundary = Readonly<{
  state: CodeModeState;
  policy: CodeModePolicy;
  guard: Guard;
}>;

type CustomEmit = ToolExecutionContext["emitCustomEvent"];
type EmitOptions = Parameters<CustomEmit>[2];
type ComposedCodeMode = ReturnType<typeof createCodeMode>;
type CodeModeRequest = { typescriptCode: string };

function stopped(state: CodeModeState): CodeModeBoundaryError {
  return new CodeModeBoundaryError(
    state.fatalMessage || "codemode stopped after a boundary failure",
  );
}

function stop(state: CodeModeState, message: string): CodeModeBoundaryError {
  state.fatal = true;
  state.closed = true;
  state.fatalMessage ||= message;
  state.controller?.abort();

  return new CodeModeBoundaryError(message);
}

function guarded(boundary: CodeModeBoundary, value: unknown): void {
  try {
    boundary.guard(value);
  } catch (failure) {
    throw stop(
      boundary.state,
      failure instanceof Error ? failure.message : "codemode boundary check failed",
    );
  }
}

function assertNotClosed(state: CodeModeState): void {
  if (state.fatal) {
    throw stopped(state);
  }

  if (state.closed) {
    throw new CodeModeBoundaryError("codemode is no longer accepting tool calls");
  }
}

function assertNotCancelled(state: CodeModeState): void {
  if (state.signal?.aborted) {
    throw stop(state, "codemode was cancelled");
  }
}

function rethrowHostFailure(state: CodeModeState, failure: unknown): never {
  assertNotCancelled(state);

  if (failure instanceof ToolBoundaryError) {
    throw stop(state, failure.message);
  }

  throw failure;
}

function boundHostResult(boundary: CodeModeBoundary, output: unknown): unknown {
  assertNotCancelled(boundary.state);
  assertNotClosed(boundary.state);
  guarded(boundary, output);

  if (byteLength(output) > boundary.policy.maxHostResultBytes) {
    throw stop(boundary.state, "codemode tool result is too large");
  }

  return output;
}

function boundSandboxResult(boundary: CodeModeBoundary, result: unknown): unknown {
  const { policy, state } = boundary;
  guarded(boundary, result);

  if (byteLength(result) > policy.maxResultBytes) {
    throw stop(state, "codemode result is too large");
  }

  const logs = (result as { logs?: unknown }).logs;

  if (Array.isArray(logs) && logs.length > policy.maxConsoleEntries) {
    throw stop(state, "codemode console output exceeded its bound");
  }

  return result;
}

function emitProjected(
  boundary: CodeModeBoundary,
  emit: CustomEmit,
  name: string,
  payload: Record<string, unknown>,
  options?: EmitOptions,
): void {
  guarded(boundary, payload);
  const projected = projectEvent(name, payload);

  if (projected) {
    emit(projected.name, projected.value, options);
  }
}

function onSandboxEvent(
  boundary: CodeModeBoundary,
  emit: CustomEmit,
  controller: AbortController,
  name: string,
  payload: Record<string, unknown>,
  options?: EmitOptions,
): void {
  const { state } = boundary;

  if (name === "code_mode:execution_finished") {
    state.closed = true;
    controller.abort();
    emitProjected(boundary, emit, name, payload, options);

    return;
  }

  if (state.closed) {
    return;
  }

  try {
    emitProjected(boundary, emit, name, payload, options);
  } catch (failure) {
    state.fatal = true;
    state.closed = true;
    controller.abort();
    throw failure;
  }
}

function admitHostCall(boundary: CodeModeBoundary, value: unknown): string {
  const { policy, state } = boundary;
  assertNotClosed(state);
  assertNotCancelled(state);

  if (state.calls >= policy.maxHostCalls) {
    throw stop(state, `codemode exceeded ${policy.maxHostCalls} tool calls`);
  }

  assertObjectInput(value);
  state.calls += 1;
  guarded(boundary, value);
  const argumentsText = encoded(value);

  if (Buffer.byteLength(argumentsText) > policy.maxHostInputBytes) {
    throw stop(state, "codemode tool input is too large");
  }

  return argumentsText;
}

function sandboxTool(
  boundary: CodeModeBoundary,
  dispatch: Dispatch,
  definition: ModelTool,
  outputSchema: JSONSchema | undefined,
): CodeModeTool {
  return {
    __toolSide: "server",
    name: definition.name,
    description: definition.description,
    inputSchema: definition.inputSchema,
    ...(outputSchema ? { outputSchema } : {}),
    execute: async (value: unknown) => {
      const argumentsText = admitHostCall(boundary, value);
      const { state } = boundary;
      const childId = `${state.parentCallId}/external/${state.calls}`;
      let output: unknown;

      try {
        output = await dispatch(
          { id: childId, name: definition.name, arguments: argumentsText, input: value },
          {
            toolCallId: childId,
            abortSignal: state.signal,
            emitCustomEvent: () => {
              throw new Error("Tool custom events are not supported");
            },
          },
        );
      } catch (failure) {
        rethrowHostFailure(state, failure);
      }

      return boundHostResult(boundary, output);
    },
  };
}

async function transpileSource(boundary: CodeModeBoundary, code: string): Promise<string> {
  const { policy } = boundary;

  if (Buffer.byteLength(code, "utf8") > policy.maxSourceBytes) {
    throw stop(boundary.state, `codemode source exceeds ${policy.maxSourceBytes} bytes`);
  }

  guarded(boundary, code);

  return stripTypeScript(`${consolePolicy(policy)}\n${code}`);
}

function beginExecution(
  boundary: CodeModeBoundary,
  context: ToolExecutionContext,
): AbortController {
  const { state, policy } = boundary;

  if (context.abortSignal?.aborted) {
    throw stop(state, "codemode was cancelled");
  }

  const controller = new AbortController();
  state.parentCallId = context.toolCallId || codeModeToolName;
  state.controller = controller;
  state.signal = AbortSignal.any([
    AbortSignal.timeout(policy.timeoutMs),
    ...(context.abortSignal ? [context.abortSignal] : []),
    controller.signal,
  ]);
  state.calls = 0;
  state.closed = false;
  state.fatal = false;
  state.fatalMessage = "";

  return controller;
}

function parseRequest(
  boundary: CodeModeBoundary,
  composed: ComposedCodeMode,
  controller: AbortController,
  value: unknown,
): CodeModeRequest {
  try {
    guarded(boundary, value);
    const parsed = parseWithStandardSchema<{ code: string }>(codeModeInputSchema, value);
    const request = { typescriptCode: parsed.code };
    parseWithStandardSchema<CodeModeRequest>(composed.tool.inputSchema, request);

    return request;
  } catch (failure) {
    controller.abort();
    const message = failure instanceof Error ? failure.message : "codemode input is invalid";
    guarded(boundary, message);
    throw stop(boundary.state, message);
  }
}

function runSandbox(
  boundary: CodeModeBoundary,
  composed: ComposedCodeMode,
  request: CodeModeRequest,
  context: ToolExecutionContext,
  controller: AbortController,
): Promise<unknown> {
  const emit = context.emitCustomEvent;

  return composed.tool.execute!(request, {
    ...context,
    emitCustomEvent: (name, payload, options) => {
      onSandboxEvent(boundary, emit, controller, name, payload, options);
    },
  });
}

async function executeTurn(
  boundary: CodeModeBoundary,
  composed: ComposedCodeMode,
  value: unknown,
  context: ToolExecutionContext,
): Promise<unknown> {
  const { state } = boundary;
  const controller = beginExecution(boundary, context);
  const request = parseRequest(boundary, composed, controller, value);

  try {
    const result = await runSandbox(boundary, composed, request, context, controller);

    if (state.fatal) {
      throw stopped(state);
    }

    if (context.abortSignal?.aborted) {
      throw stop(state, "codemode was cancelled");
    }

    return boundSandboxResult(boundary, result);
  } finally {
    state.closed = true;
    controller.abort();
  }
}

export function composeCodeModeTurn(input: {
  definitions: readonly ModelTool[];
  dispatch: Dispatch;
  guard: Guard;
  outputSchemas?: ReadonlyMap<string, JSONSchema>;
  policy?: Partial<CodeModePolicy>;
}): CodeModeTurn {
  const policy: CodeModePolicy = { ...defaultPolicy, ...input.policy };
  const boundary: CodeModeBoundary = {
    state: {
      parentCallId: codeModeToolName,
      signal: undefined,
      controller: undefined,
      calls: 0,
      closed: false,
      fatal: false,
      fatalMessage: "",
    },
    policy,
    guard: input.guard,
  };
  const sandboxTools = input.definitions
    .filter(
      (definition) => definition.name !== codeModeToolName && definition.name !== discoveryToolName,
    )
    .map((definition) =>
      sandboxTool(boundary, input.dispatch, definition, input.outputSchemas?.get(definition.name)),
    );
  const composed = createCodeMode({
    driver: quickjsDriver,
    tools: sandboxTools,
    timeout: policy.timeoutMs,
    memoryLimit: policy.memoryLimitMb,
    onSecretParameter: "ignore",
    transpile: (code: string) => transpileSource(boundary, code),
  });
  const bindings = toolsToBindings(sandboxTools, "external_");
  const entries = Object.entries(bindings);
  const systemPrompt = codeModeSystemPrompt({
    functions: entries.map(([name, binding]) => ({ name, description: binding.description })),
    typeDefinitions: generateTypeStubs(bindings),
  });
  guarded(boundary, systemPrompt);
  const inputSchema = convertSchemaToJsonSchema(codeModeInputSchema);

  if (!inputSchema) {
    throw new Error("Codemode tool schema is unavailable");
  }

  return {
    definition: {
      name: codeModeToolName,
      description: codeModeDescription(Object.keys(bindings)),
      inputSchema,
    },
    systemPrompt,
    execute: (value: unknown, context: ToolExecutionContext) =>
      executeTurn(boundary, composed, value, context),
  };
}
