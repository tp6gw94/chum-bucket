import {
  convertSchemaToJsonSchema,
  toolDefinition,
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
  type IsolateDriver,
} from "@tanstack/ai-code-mode";
import { createQuickJSIsolateDriver } from "@tanstack/ai-isolate-quickjs";
import { z } from "zod";
import type { ModelCall } from "../model-turn";
import { codeModeDescription, codeModeSystemPrompt } from "../prompts";
import { CredentialBoundaryError, ToolAuthorizationError, type ModelTool } from "./atlassian";

export const codeModeToolName = "codemode";

const discoveryToolName = "discover_atlassian_tools";
const bindingPrefix = "external_";

const codeModeInputSchema = z.strictObject({ code: z.string() });

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

export const defaultCodeModePolicy: CodeModePolicy = {
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

class CodeModePolicyError extends Error {}

export type CodeModeDispatch = (call: ModelCall, context: ToolExecutionContext) => Promise<unknown>;

export type CodeModeDependencies = Readonly<{
  definitions: readonly ModelTool[];
  dispatch: CodeModeDispatch;
  guard: (value: unknown) => void;
  policy?: CodeModePolicy;
  outputSchemas?: ReadonlyMap<string, JSONSchema>;
  driver?: IsolateDriver;
}>;

export type CodeModeResult = Readonly<{
  success: boolean;
  result?: unknown;
  logs?: string[];
  error?: Readonly<{ name?: string; message: string }>;
}>;

export type CodeModeTurn = Readonly<{
  definition: ModelTool;
  functions: readonly string[];
  systemPrompt: string;
  execute: (input: unknown, context: ToolExecutionContext) => Promise<CodeModeResult>;
}>;

type Execution = {
  parentId: string;
  controller: AbortController;
  signal: AbortSignal;
  calls: number;
  closed: boolean;
  failure: Error | undefined;
};

type HostInvoke = (name: string, input: unknown) => Promise<unknown>;

let sharedDriver: IsolateDriver | undefined;

function quickJSDriver(): IsolateDriver {
  sharedDriver ??= createQuickJSIsolateDriver();

  return sharedDriver;
}

function utf8Bytes(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

function jsonBytes(value: unknown): number {
  const text = JSON.stringify(value);

  return text === undefined ? 0 : utf8Bytes(text);
}

function isFatal(error: unknown): error is Error {
  return (
    error instanceof CodeModePolicyError ||
    error instanceof CredentialBoundaryError ||
    error instanceof ToolAuthorizationError
  );
}

function fail(execution: Execution, error: Error): Error {
  execution.failure ??= error;
  execution.closed = true;
  execution.controller.abort();

  return execution.failure;
}

function stopped(execution: Execution): Error {
  return execution.failure ?? new Error("Code Mode execution has stopped");
}

function guarded(execution: Execution, guard: (value: unknown) => void, value: unknown): void {
  try {
    guard(value);
  } catch (error) {
    throw fail(
      execution,
      error instanceof CredentialBoundaryError
        ? error
        : new CredentialBoundaryError("Code Mode data failed the credential check"),
    );
  }
}

const jsonTypes: Record<string, (value: unknown) => boolean> = {
  string: (value) => typeof value === "string",
  number: (value) => typeof value === "number",
  integer: (value) => Number.isInteger(value),
  boolean: (value) => typeof value === "boolean",
  array: (value) => Array.isArray(value),
  object: (value) => !!value && typeof value === "object" && !Array.isArray(value),
  null: (value) => value === null,
};

function typeMatches(schema: unknown, value: unknown): boolean {
  const type = (schema as { type?: unknown } | undefined)?.type;
  const types = Array.isArray(type) ? type : typeof type === "string" ? [type] : [];

  return types.length === 0 || types.some((name) => jsonTypes[name]?.(value) ?? true);
}

function fieldProblem(schema: JSONSchema, key: string, value: unknown): string | undefined {
  const properties = (schema.properties ?? {}) as Record<string, unknown>;

  if (!(key in properties)) {
    return schema.additionalProperties === false ? "is not accepted" : undefined;
  }

  return value === null || typeMatches(properties[key], value) ? undefined : "has the wrong type";
}

function checkHostInput(name: string, schema: JSONSchema, input: unknown): void {
  if (!jsonTypes.object!(input)) {
    throw new Error(`${name} expects an object input`);
  }

  const record = input as Record<string, unknown>;
  const required = Array.isArray(schema.required) ? (schema.required as string[]) : [];
  const missing = required.find((key) => !(key in record));

  if (missing) {
    throw new Error(`${name} is missing required field ${missing}`);
  }

  for (const [key, value] of Object.entries(record)) {
    const problem = fieldProblem(schema, key, value);

    if (problem) {
      throw new Error(`${name} field ${key} ${problem}`);
    }
  }
}

function consolePrelude(policy: CodeModePolicy): string {
  return `(() => {
    const native = globalThis.console;
    const sinks = { log: native.log, info: native.info, warn: native.warn, error: native.error };
    const apply = Reflect.apply;
    const charCodeAt = String.prototype.charCodeAt;
    const slice = String.prototype.slice;
    const toText = String;
    const stringify = JSON.stringify;
    const freeze = Object.freeze;
    const defineProperty = Object.defineProperty;
    const maxEntries = ${policy.maxConsoleEntries};
    const maxBytes = ${policy.maxConsoleBytes};
    const maxEntryBytes = ${policy.maxConsoleEntryBytes};
    let entries = 0;
    let bytes = 0;
    const show = (value) => {
      if (typeof value === "string") return value;
      try {
        const json = stringify(value);
        return json === undefined ? toText(value) : json;
      } catch {
        try { return toText(value); } catch { return "[unprintable]"; }
      }
    };
    const prefix = (text, budget) => {
      let size = 0;
      let index = 0;
      while (index < text.length) {
        const code = apply(charCodeAt, text, [index]);
        let width = code < 0x80 ? 1 : code < 0x800 ? 2 : 3;
        let step = 1;
        if (code >= 0xd800 && code <= 0xdbff && index + 1 < text.length) {
          const next = apply(charCodeAt, text, [index + 1]);
          if (next >= 0xdc00 && next <= 0xdfff) { width = 4; step = 2; }
        }
        if (size + width > budget) break;
        size += width;
        index += step;
      }
      return [apply(slice, text, [0, index]), size];
    };
    const write = (sink, args) => {
      if (entries >= maxEntries || bytes >= maxBytes) return;
      let text = "";
      for (let index = 0; index < args.length; index++) {
        const part = show(args[index]);
        text = index === 0 ? part : text + " " + part;
        if (text.length > maxEntryBytes) break;
      }
      const budget = maxEntryBytes < maxBytes - bytes ? maxEntryBytes : maxBytes - bytes;
      const [kept, size] = prefix(text, budget);
      entries += 1;
      bytes += size;
      apply(sink, native, [kept]);
    };
    const safe = freeze({
      log: (...args) => write(sinks.log, args),
      debug: (...args) => write(sinks.log, args),
      info: (...args) => write(sinks.info, args),
      warn: (...args) => write(sinks.warn, args),
      error: (...args) => write(sinks.error, args),
    });
    defineProperty(globalThis, "console", { value: safe, writable: false, configurable: false });
  })();`.replace(/\n\s*/g, " ");
}

function capLogs(logs: readonly string[] | undefined, policy: CodeModePolicy): string[] {
  const kept: string[] = [];
  let total = 0;

  for (const log of (logs ?? []).slice(0, policy.maxConsoleEntries)) {
    const size = utf8Bytes(log);

    if (size > policy.maxConsoleEntryBytes || total + size > policy.maxConsoleBytes) {
      break;
    }

    total += size;
    kept.push(log);
  }

  return kept;
}

function sandboxTools(
  definitions: readonly ModelTool[],
  outputSchemas: ReadonlyMap<string, JSONSchema>,
  invoke: HostInvoke,
): CodeModeTool[] {
  return definitions
    .filter((definition) => ![codeModeToolName, discoveryToolName].includes(definition.name))
    .map(
      (definition) =>
        toolDefinition({
          name: definition.name,
          description: definition.description,
          inputSchema: definition.inputSchema,
          ...(outputSchemas.has(definition.name)
            ? { outputSchema: outputSchemas.get(definition.name)! }
            : {}),
        }).server(async (input: unknown) => invoke(definition.name, input)) as CodeModeTool,
    );
}

function projectEvent(
  name: string,
  value: Record<string, unknown>,
  sourceBytes: number,
): Record<string, unknown> | undefined {
  switch (name) {
    case "code_mode:execution_started":
      return { sourceBytes };
    case "code_mode:console":
      return {
        level: value.level,
        bytes: typeof value.message === "string" ? utf8Bytes(value.message) : 0,
      };
    case "code_mode:external_call":
      return { function: value.function, inputBytes: jsonBytes(value.args) };
    case "code_mode:external_result":
      return {
        function: value.function,
        durationMs: value.duration,
        resultBytes: jsonBytes(value.result),
      };
    case "code_mode:external_error":
      return { function: value.function, durationMs: value.duration };
    case "code_mode:execution_finished":
      return {
        durationMs: value.durationMs,
        phase: value.phase,
        success: value.success,
        logCount: value.logCount,
      };
    default:
      return undefined;
  }
}

function ensureOpen(execution: Execution): void {
  if (execution.closed || execution.signal.aborted) {
    throw stopped(execution);
  }
}

function within(execution: Execution, bytes: number, limit: number, message: string): void {
  if (bytes > limit) {
    throw fail(execution, new CodeModePolicyError(message));
  }
}

function reserveCall(execution: Execution, policy: CodeModePolicy): string {
  ensureOpen(execution);
  execution.calls += 1;
  within(
    execution,
    execution.calls,
    policy.maxHostCalls,
    `Code Mode exceeded ${policy.maxHostCalls} host calls`,
  );

  return `${execution.parentId}/external/${execution.calls}`;
}

function hostFailure(execution: Execution, deps: CodeModeDependencies, error: unknown): Error {
  if (isFatal(error)) {
    return fail(execution, error);
  }

  guarded(execution, deps.guard, error);

  if (execution.closed || execution.signal.aborted) {
    return stopped(execution);
  }

  return new Error(error instanceof Error ? error.message : "Tool failed");
}

function hostInvoker(
  execution: Execution,
  deps: CodeModeDependencies,
  policy: CodeModePolicy,
  schemas: ReadonlyMap<string, JSONSchema>,
): HostInvoke {
  return async (name, input) => {
    const id = reserveCall(execution, policy);
    within(
      execution,
      jsonBytes(input),
      policy.maxHostInputBytes,
      `Host input exceeds ${policy.maxHostInputBytes} bytes`,
    );
    guarded(execution, deps.guard, input);
    checkHostInput(name, schemas.get(name)!, input);
    const output = await deps
      .dispatch(
        { id, name, arguments: JSON.stringify(input), input },
        { toolCallId: id, abortSignal: execution.signal, emitCustomEvent: () => undefined },
      )
      .catch((error: unknown) => {
        throw hostFailure(execution, deps, error);
      });
    ensureOpen(execution);
    guarded(execution, deps.guard, output);
    within(
      execution,
      jsonBytes(output),
      policy.maxHostResultBytes,
      `Host result exceeds ${policy.maxHostResultBytes} bytes`,
    );

    return output;
  };
}

function eventProjector(
  execution: Execution,
  deps: CodeModeDependencies,
  context: ToolExecutionContext,
  sourceBytes: number,
): ToolExecutionContext["emitCustomEvent"] {
  return (name, value) => {
    try {
      deps.guard(value);
    } catch {
      fail(execution, new CredentialBoundaryError("Code Mode event failed the credential check"));

      return;
    }

    const projected = projectEvent(name, value, sourceBytes);

    if (projected) {
      context.emitCustomEvent(name, projected);
    }
  };
}

function settle(
  raw: CodeModeToolResult,
  execution: Execution,
  deps: CodeModeDependencies,
  policy: CodeModePolicy,
  context: ToolExecutionContext,
): CodeModeResult {
  if (execution.failure) {
    throw execution.failure;
  }

  if (context.abortSignal?.aborted) {
    throw new Error("Code Mode execution was cancelled");
  }

  const result: CodeModeResult = raw.success
    ? { success: true, result: raw.result, logs: capLogs(raw.logs, policy) }
    : {
        success: false,
        error: { name: raw.error?.name, message: raw.error?.message ?? "Code Mode failed" },
        logs: capLogs(raw.logs, policy),
      };
  guarded(execution, deps.guard, result);

  if (jsonBytes(result) > policy.maxResultBytes) {
    throw fail(
      execution,
      new CodeModePolicyError(`Code Mode result exceeds ${policy.maxResultBytes} bytes`),
    );
  }

  return result;
}

function parseCode(input: unknown, deps: CodeModeDependencies, policy: CodeModePolicy): string {
  const parsed = codeModeInputSchema.safeParse(input);

  if (!parsed.success) {
    throw new Error("codemode expects { code: string }");
  }

  try {
    deps.guard(parsed.data.code);
  } catch {
    throw new CredentialBoundaryError("Code Mode source failed the credential check");
  }

  if (utf8Bytes(parsed.data.code) > policy.maxSourceBytes) {
    throw new CodeModePolicyError(`Code Mode source exceeds ${policy.maxSourceBytes} bytes`);
  }

  return parsed.data.code;
}

export function composeCodeModeTurn(deps: CodeModeDependencies): CodeModeTurn {
  const policy = deps.policy ?? defaultCodeModePolicy;
  const outputSchemas = deps.outputSchemas ?? new Map<string, JSONSchema>();
  const schemas = new Map(
    deps.definitions.map((definition) => [definition.name, definition.inputSchema]),
  );
  const declared = sandboxTools(deps.definitions, outputSchemas, async () => {
    throw new Error("Code Mode bindings only run inside an execution");
  });
  const bindings = toolsToBindings(declared, bindingPrefix);
  const functions = Object.keys(bindings);
  const inputSchema = convertSchemaToJsonSchema(codeModeInputSchema);

  if (!inputSchema) {
    throw new Error("Code Mode schema is unavailable");
  }

  return {
    definition: {
      name: codeModeToolName,
      description: codeModeDescription(functions),
      inputSchema,
    },
    functions,
    systemPrompt: codeModeSystemPrompt({ functions, typeDefinitions: generateTypeStubs(bindings) }),
    async execute(input, context) {
      const code = parseCode(input, deps, policy);
      const controller = new AbortController();
      const execution: Execution = {
        parentId: context.toolCallId ?? codeModeToolName,
        controller,
        signal: AbortSignal.any([
          controller.signal,
          AbortSignal.timeout(policy.timeoutMs),
          ...(context.abortSignal ? [context.abortSignal] : []),
        ]),
        calls: 0,
        closed: false,
        failure: undefined,
      };

      if (context.abortSignal?.aborted) {
        throw new Error("Code Mode execution was cancelled");
      }

      const tool = createCodeModeTool({
        driver: deps.driver ?? quickJSDriver(),
        tools: sandboxTools(
          deps.definitions,
          outputSchemas,
          hostInvoker(execution, deps, policy, schemas),
        ),
        timeout: policy.timeoutMs,
        memoryLimit: policy.memoryLimitMb,
        transpile: async (source) =>
          consolePrelude(policy) + "\n" + (await stripTypeScript(source)),
      });

      try {
        const raw = (await tool.execute!(
          { typescriptCode: code },
          {
            toolCallId: execution.parentId,
            emitCustomEvent: eventProjector(execution, deps, context, utf8Bytes(code)),
          },
        )) as CodeModeToolResult;

        return settle(raw, execution, deps, policy, context);
      } finally {
        execution.closed = true;
        controller.abort();
      }
    },
  };
}
