import {
  convertSchemaToJsonSchema,
  type JSONSchema,
  type ToolExecutionContext,
} from "@tanstack/ai";
import {
  createCodeModeTool,
  generateTypeStubs,
  stripTypeScript,
  toolsToBindings,
  type CodeModeTool,
  type CodeModeToolResult,
} from "@tanstack/ai-code-mode";
import { createQuickJSIsolateDriver } from "@tanstack/ai-isolate-quickjs";
import { z } from "zod";
import type { ModelCall } from "../model-turn";
import { codeModeDescription, codeModeSystemPrompt } from "../prompts";
import type { ModelTool } from "./atlassian";
import { ToolViolationError } from "./boundary";

export const codeModeToolName = "codemode";

export type CodeModePolicy = Readonly<{
  timeoutMs: number;
  memoryLimitMb: number;
  maxSourceBytes: number;
  maxHostCalls: number;
  maxHostInputBytes: number;
  maxHostResultBytes: number;
  maxConsoleEntries: number;
  maxConsoleBytes: number;
  maxConsoleEntryBytes: number;
  maxResultBytes: number;
}>;

const defaultCodeModePolicy: CodeModePolicy = {
  timeoutMs: 30_000,
  memoryLimitMb: 128,
  maxSourceBytes: 60_000,
  maxHostCalls: 24,
  maxHostInputBytes: 64_000,
  maxHostResultBytes: 1_000_000,
  maxConsoleEntries: 64,
  maxConsoleBytes: 16_384,
  maxConsoleEntryBytes: 2_048,
  maxResultBytes: 256_000,
};

export type CodeModeDispatch = (call: ModelCall, context: ToolExecutionContext) => Promise<unknown>;
export type CodeModeGuard = (value: unknown) => void;

export type CodeModeTurnInput = Readonly<{
  definitions: readonly ModelTool[];
  dispatch: CodeModeDispatch;
  guard: CodeModeGuard;
  policy?: Partial<CodeModePolicy>;
  outputSchemas?: ReadonlyMap<string, JSONSchema>;
  excluded?: ReadonlySet<string>;
}>;

export type CodeModeTurn = Readonly<{
  definition: ModelTool;
  systemPrompt: string;
  functions: readonly string[];
  execute: (input: unknown, context: ToolExecutionContext) => Promise<CodeModeToolResult>;
}>;

type Dependencies = Readonly<{
  dispatch: CodeModeDispatch;
  guard: CodeModeGuard;
  policy: CodeModePolicy;
}>;

type Execution = {
  parentId: string;
  signal: AbortSignal;
  calls: number;
  closed: boolean;
  violation: ToolViolationError | undefined;
};

const codeModeInputSchema = z.object({ code: z.string() }).strict();
const codeModeInputJsonSchema = convertSchemaToJsonSchema(codeModeInputSchema)!;
const driver = createQuickJSIsolateDriver();

function parseCodeModeInput(input: unknown): string {
  const parsed = codeModeInputSchema.safeParse(input);

  if (!parsed.success) {
    throw new Error("Invalid codemode input: expected { code: string }");
  }

  return parsed.data.code;
}

function utf8(text: string): number {
  return Buffer.byteLength(text);
}

function jsonBytes(value: unknown): number {
  return utf8(JSON.stringify(value) ?? "null");
}

function violate(run: Execution, message: string): never {
  const error = new ToolViolationError(message);
  run.violation ??= error;
  throw run.violation;
}

function assertOpen(run: Execution): void {
  if (run.violation) {
    throw run.violation;
  }

  if (run.closed || run.signal.aborted) {
    violate(run, "Code Mode execution is closed or cancelled");
  }
}

function recordViolation(run: Execution, failure: unknown): void {
  if (failure instanceof ToolViolationError) {
    run.violation ??= failure;
  }
}

async function invokeHost(
  deps: Dependencies,
  run: Execution,
  name: string,
  input: unknown,
): Promise<unknown> {
  assertOpen(run);
  run.calls += 1;

  if (run.calls > deps.policy.maxHostCalls) {
    violate(run, "Code Mode host call limit exceeded");
  }

  const serialized = JSON.stringify(input ?? null);

  if (utf8(serialized) > deps.policy.maxHostInputBytes) {
    violate(run, "Code Mode host input is too large");
  }

  try {
    deps.guard(input);
    const id = `${run.parentId}/external/${run.calls}`;
    const output = await deps.dispatch(
      { id, name, arguments: serialized, input },
      { toolCallId: id, abortSignal: run.signal, emitCustomEvent: () => undefined },
    );
    assertOpen(run);
    const text = JSON.stringify(output) ?? "null";

    if (utf8(text) > deps.policy.maxHostResultBytes) {
      violate(run, "Code Mode host result is too large");
    }

    deps.guard(output);

    return output;
  } catch (failure) {
    recordViolation(run, failure);

    try {
      deps.guard(failure);
    } catch (leak) {
      recordViolation(run, leak);
      throw leak;
    }

    throw failure;
  }
}

function sandboxTool(
  deps: Dependencies,
  run: Execution,
  definition: ModelTool,
  outputSchema: JSONSchema | undefined,
): CodeModeTool {
  return {
    __toolSide: "server",
    name: definition.name,
    description: definition.description,
    inputSchema: definition.inputSchema,
    ...(outputSchema ? { outputSchema } : {}),
    execute: (input: unknown) => invokeHost(deps, run, definition.name, input),
  } as CodeModeTool;
}

function consolePrelude(policy: CodeModePolicy): string {
  return `(() => {
  const natives = { log: console.log, error: console.error, warn: console.warn, info: console.info };
  const stringify = JSON.stringify;
  const toText = String;
  const map = Array.prototype.map;
  const join = Array.prototype.join;
  const charCode = String.prototype.charCodeAt;
  const slice = String.prototype.slice;
  const ceil = Math.ceil;
  const max = Math.max;
  const maxEntries = ${policy.maxConsoleEntries};
  const maxTotal = ${policy.maxConsoleBytes};
  const maxEntry = ${policy.maxConsoleEntryBytes};
  let entries = 0;
  let total = 0;
  const bytes = (text) => {
    let size = 0;
    for (let index = 0; index < text.length; index++) {
      const code = charCode.call(text, index);
      if (code < 0x80) size += 1;
      else if (code < 0x800) size += 2;
      else if (code >= 0xd800 && code <= 0xdbff) { size += 4; index++; }
      else size += 3;
    }
    return size;
  };
  const clip = (text) => {
    let out = text;
    while (bytes(out) > maxEntry) {
      out = slice.call(out, 0, max(0, out.length - ceil((bytes(out) - maxEntry) / 3)));
    }
    return out;
  };
  const render = (value) => {
    if (typeof value === "string") return value;
    try {
      const text = stringify(value);
      return text === undefined ? toText(value) : text;
    } catch (failure) {
      return toText(value);
    }
  };
  for (const level of ["log", "error", "warn", "info"]) {
    const native = natives[level];
    console[level] = (...args) => {
      if (entries >= maxEntries) return;
      const text = clip(join.call(map.call(args, render), " "));
      const size = bytes(text);
      if (total + size > maxTotal) return;
      entries += 1;
      total += size;
      native(text);
    };
  }
})();`;
}

function number(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" ? value.slice(0, 200) : undefined;
}

function fields(payload: unknown): Record<string, unknown> {
  return payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {};
}

function projectEvent(name: string, payload: unknown): Record<string, unknown> | undefined {
  const data = fields(payload);

  switch (name) {
    case "code_mode:execution_started":
      return { codeLength: number(data.codeLength) };
    case "code_mode:console":
      return { level: text(data.level), bytes: utf8(String(data.message ?? "")) };
    case "code_mode:external_call":
      return { function: text(data.function), argsBytes: jsonBytes(data.args) };
    case "code_mode:external_result":
      return {
        function: text(data.function),
        resultBytes: jsonBytes(data.result),
        durationMs: number(data.duration),
      };
    case "code_mode:external_error":
      return { function: text(data.function), durationMs: number(data.duration) };
    case "code_mode:execution_finished":
      return {
        phase: text(data.phase),
        success: data.success === true,
        durationMs: number(data.durationMs),
        logCount: number(data.logCount),
        errorName: text(fields(data.error).name),
      };
    default:
      return undefined;
  }
}

function failure(name: string, message: string): CodeModeToolResult {
  return { success: false, error: { name, message } };
}

function finalize(
  deps: Dependencies,
  run: Execution,
  result: CodeModeToolResult,
): CodeModeToolResult {
  if (run.violation) {
    return failure("CodeModeBoundaryError", run.violation.message);
  }

  const outcome: CodeModeToolResult = result.error
    ? { ...result, error: { name: result.error.name, message: result.error.message } }
    : result;

  try {
    deps.guard(outcome);
  } catch {
    return failure("CodeModeBoundaryError", "Code Mode result contains configured credentials");
  }

  if (jsonBytes(outcome) > deps.policy.maxResultBytes) {
    return failure("CodeModeResultTooLarge", "Code Mode result exceeds the size limit");
  }

  return outcome;
}

type Sandbox = (run: Execution) => CodeModeTool[];

function createEmitter(deps: Dependencies, run: Execution, context: ToolExecutionContext) {
  return (name: string, payload?: Record<string, unknown>) => {
    try {
      deps.guard(payload);
      const projected = projectEvent(name, payload);

      if (projected) {
        context.emitCustomEvent(name, projected);
      }
    } catch (leak) {
      recordViolation(run, leak);
    }
  };
}

function createExecution(policy: CodeModePolicy, context: ToolExecutionContext) {
  const controller = new AbortController();
  const signal = AbortSignal.any([
    controller.signal,
    AbortSignal.timeout(policy.timeoutMs),
    ...(context.abortSignal ? [context.abortSignal] : []),
  ]);
  const run: Execution = {
    parentId: context.toolCallId!,
    signal,
    calls: 0,
    closed: false,
    violation: undefined,
  };

  return { controller, run };
}

async function executeCode(
  deps: Dependencies,
  sandbox: Sandbox,
  value: unknown,
  context: ToolExecutionContext,
): Promise<CodeModeToolResult> {
  const code = parseCodeModeInput(value);

  if (!context.toolCallId) {
    throw new Error("Missing tool call ID");
  }

  try {
    deps.guard(code);
  } catch {
    return failure("CodeModeBoundaryError", "Code contains configured credentials");
  }

  const { policy } = deps;
  const { controller, run } = createExecution(policy, context);
  const tool = createCodeModeTool({
    driver,
    tools: sandbox(run),
    timeout: policy.timeoutMs,
    memoryLimit: policy.memoryLimitMb,
    onSecretParameter: "ignore",
    transpile: async (source) => {
      if (utf8(source) > policy.maxSourceBytes) {
        throw new Error("Code exceeds the source size limit");
      }

      return `${consolePrelude(policy)}\n${await stripTypeScript(source)}`;
    },
  });

  try {
    const result = (await tool.execute!(
      { typescriptCode: code },
      { ...context, emitCustomEvent: createEmitter(deps, run, context) },
    )) as CodeModeToolResult;

    return finalize(deps, run, result);
  } catch (error) {
    recordViolation(run, error);

    return finalize(
      deps,
      run,
      failure("CodeModeError", error instanceof Error ? error.message : "Code Mode failed"),
    );
  } finally {
    run.closed = true;
    controller.abort();
  }
}

const idleExecution: Execution = {
  parentId: "",
  signal: AbortSignal.abort(),
  calls: 0,
  closed: true,
  violation: undefined,
};

export function composeCodeModeTurn(input: CodeModeTurnInput): CodeModeTurn {
  const policy: CodeModePolicy = { ...defaultCodeModePolicy, ...input.policy };
  const deps: Dependencies = { dispatch: input.dispatch, guard: input.guard, policy };
  const excluded = new Set([codeModeToolName, ...(input.excluded ?? [])]);
  const definitions = input.definitions.filter((definition) => !excluded.has(definition.name));
  const schemas = input.outputSchemas ?? new Map<string, JSONSchema>();
  const sandbox: Sandbox = (run) =>
    definitions.map((definition) =>
      sandboxTool(deps, run, definition, schemas.get(definition.name)),
    );
  const bindings = toolsToBindings(sandbox(idleExecution), "external_");
  const functions = Object.keys(bindings);
  const systemPrompt = codeModeSystemPrompt({
    functions,
    typeDefinitions: generateTypeStubs(bindings),
  });
  const definition: ModelTool = {
    name: codeModeToolName,
    description: codeModeDescription(functions),
    inputSchema: codeModeInputJsonSchema,
  };
  deps.guard({ definition, systemPrompt });

  return {
    definition,
    systemPrompt,
    functions,
    execute: (value, context) => executeCode(deps, sandbox, value, context),
  };
}
