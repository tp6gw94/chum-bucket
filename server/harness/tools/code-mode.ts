import type { ToolExecutionContext, UIMessage } from "@tanstack/ai";
import {
  generateTypeStubs,
  stripTypeScript,
  type ExecutionResult,
  type IsolateDriver,
  type ToolBinding,
} from "@tanstack/ai-code-mode";
import { createQuickJSIsolateDriver } from "@tanstack/ai-isolate-quickjs";
import { z } from "zod";
import type { ModelCall } from "../model-turn";
import type { ModelTool } from "./atlassian";
import type { RunTools } from ".";

export const codeModeToolName = "execute_typescript";

export type CodeModeLimits = Readonly<{
  timeoutMs: number;
  memoryMb: number;
  maxToolCalls: number;
  maxCodeChars: number;
  maxResultChars: number;
  maxLogs: number;
  maxLogChars: number;
}>;

export const codeModeLimits: CodeModeLimits = {
  timeoutMs: 20_000,
  memoryMb: 32,
  maxToolCalls: 16,
  maxCodeChars: 20_000,
  maxResultChars: 16_000,
  maxLogs: 40,
  maxLogChars: 500,
};

export type CodeModeOptions = Readonly<{
  sandboxed: ReadonlySet<string>;
  limits?: CodeModeLimits;
  driver?: IsolateDriver;
}>;

export type CodeModeResult = {
  success: boolean;
  result?: unknown;
  error?: { name: string; message: string };
  logs: string[];
  toolCalls: number;
};

type Invoke = (tool: ModelTool, input: unknown) => Promise<unknown>;

const quickjs = createQuickJSIsolateDriver();
const ERROR_CHARS = 1000;

function sandboxTools(definitions: readonly ModelTool[], sandboxed: ReadonlySet<string>) {
  return definitions.filter((tool) => sandboxed.has(tool.name));
}

function bindingsFor(tools: readonly ModelTool[], invoke: Invoke): Record<string, ToolBinding> {
  return Object.fromEntries(
    tools.map((tool) => [
      `external_${tool.name}`,
      {
        name: `external_${tool.name}`,
        description: tool.description,
        inputSchema: tool.inputSchema as Record<string, unknown>,
        execute: (input: unknown) => invoke(tool, input),
      },
    ]),
  );
}

const advertiseOnly: Invoke = async () => {
  throw new Error("Code Mode bindings are not executable outside execute_typescript");
};

function describe(tools: readonly ModelTool[], limits: CodeModeLimits): string {
  return [
    "Run a TypeScript program in an isolated QuickJS sandbox that orchestrates this turn's read-only tools as async external_* functions.",
    "Use it when a task needs several tool calls, loops, filtering, or aggregation: only the returned value and console output come back, so return a compact summary instead of raw tool output.",
    "",
    "```typescript",
    generateTypeStubs(bindingsFor(tools, advertiseOnly)),
    "```",
    "",
    `- Top-level await and return are supported. Return a JSON-serializable value of at most ${limits.maxResultChars} characters once serialized.`,
    `- Each run allows ${limits.maxToolCalls} external_* calls, ${limits.timeoutMs / 1000}s, and ${limits.memoryMb} MB; console output keeps the first ${limits.maxLogs} lines.`,
    "- Every run starts in a fresh sandbox without network, file system, timers, modules, or host globals.",
    "- Tools with side effects are not available here; call them directly. Tools that need discovery appear here on the turn after they are discovered.",
  ].join("\n");
}

function definition(tools: readonly ModelTool[], limits: CodeModeLimits): ModelTool {
  return {
    name: codeModeToolName,
    description: describe(tools, limits),
    inputSchema: {
      type: "object",
      properties: {
        typescriptCode: {
          type: "string",
          description: "TypeScript program body. Await external_* calls and return the result.",
        },
      },
      required: ["typescriptCode"],
      additionalProperties: false,
    },
  };
}

function consolePrelude(limits: CodeModeLimits): string {
  return `(() => { const limit = ${limits.maxLogs}; const width = ${limits.maxLogChars}; let count = 0; const text = (value) => { if (typeof value === "string") return value; try { const json = JSON.stringify(value); return json === undefined ? String(value) : json; } catch { return String(value); } }; for (const level of ["log", "info", "warn", "error"]) { const write = console[level]; console[level] = (...values) => { count += 1; if (count <= limit) write(values.map(text).join(" ").slice(0, width)); else if (count === limit + 1) write("[console output truncated]"); }; } })();\n`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function failureMessage(failure: unknown): string {
  return (failure instanceof Error ? failure.message : String(failure)).slice(0, ERROR_CHARS);
}

function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(new Error("Code Mode execution was cancelled"));

    if (signal.aborted) {
      onAbort();

      return;
    }

    signal.addEventListener("abort", onAbort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

function cancellation(signal: AbortSignal): Promise<ExecutionResult> {
  return new Promise((resolve) => {
    const cancelled = () =>
      resolve({
        success: false,
        error: { name: "AbortError", message: "Code Mode execution was cancelled" },
      });

    if (signal.aborted) {
      cancelled();
    } else {
      signal.addEventListener("abort", cancelled, { once: true });
    }
  });
}

function failed(name: string, message: string, logs: string[], toolCalls: number) {
  return {
    success: false,
    error: { name, message: message.slice(0, ERROR_CHARS) },
    logs,
    toolCalls,
  };
}

function settle(
  outcome: ExecutionResult,
  toolCalls: number,
  limits: CodeModeLimits,
): CodeModeResult {
  const logs = outcome.logs ?? [];

  if (!outcome.success) {
    const error = outcome.error ?? { name: "Error", message: "Code execution failed" };

    return failed(error.name, error.message, logs, toolCalls);
  }

  const size = JSON.stringify(outcome.value)?.length ?? 0;

  if (size > limits.maxResultChars) {
    return failed(
      "ResultTooLarge",
      `Returned value is ${size} characters; return a summary of at most ${limits.maxResultChars}`,
      logs,
      toolCalls,
    );
  }

  return { success: true, result: outcome.value, logs, toolCalls };
}

function parseCode(input: unknown, limits: CodeModeLimits): string {
  const parsed = z
    .object({ typescriptCode: z.string().trim().min(1).max(limits.maxCodeChars) })
    .strict()
    .safeParse(input);

  if (!parsed.success) {
    throw new Error(
      `execute_typescript requires typescriptCode of 1 to ${limits.maxCodeChars} characters`,
    );
  }

  return parsed.data.typescriptCode;
}

type Execution = Readonly<{
  base: RunTools;
  messages: readonly UIMessage[];
  call: ModelCall;
  context: ToolExecutionContext;
  options: CodeModeOptions;
}>;

function dispatcher(execution: Execution, signal: AbortSignal, limits: CodeModeLimits) {
  const { base, messages, call, context } = execution;
  const emit = context.emitCustomEvent;
  let calls = 0;

  const invoke: Invoke = async (tool, input) => {
    signal.throwIfAborted();
    const sequence = ++calls;
    const name = `external_${tool.name}`;

    if (sequence > limits.maxToolCalls) {
      throw new Error(`external_* call limit of ${limits.maxToolCalls} exceeded`);
    }

    if (!isRecord(input)) {
      throw new Error(`${name} expects one object argument`);
    }

    const id = `${call.id}:${sequence}`;
    const startedAt = Date.now();
    emit("code_mode:external_call", { function: name, sequence });

    try {
      const output = await abortable(
        base.executeTool(
          messages,
          { id, name: tool.name, arguments: JSON.stringify(input), input },
          { toolCallId: id, abortSignal: signal, emitCustomEvent: emit },
        ),
        signal,
      );
      emit("code_mode:external_result", {
        function: name,
        sequence,
        durationMs: Date.now() - startedAt,
      });

      return output;
    } catch (failure) {
      emit("code_mode:external_error", {
        function: name,
        sequence,
        durationMs: Date.now() - startedAt,
        error: failureMessage(failure).slice(0, 200),
      });
      throw failure;
    }
  };

  return { invoke, count: () => Math.min(calls, limits.maxToolCalls) };
}

async function transpile(
  code: string,
  limits: CodeModeLimits,
): Promise<{ code: string } | { error: NonNullable<CodeModeResult["error"]> }> {
  try {
    return { code: consolePrelude(limits) + (await stripTypeScript(code)) };
  } catch (failure) {
    return { error: { name: "TypeScriptError", message: failureMessage(failure) } };
  }
}

async function runIsolate(
  execution: Execution,
  code: string,
  tools: readonly ModelTool[],
  limits: CodeModeLimits,
): Promise<CodeModeResult> {
  const { context, options } = execution;
  const controller = new AbortController();
  const signal = AbortSignal.any([
    controller.signal,
    ...(context.abortSignal ? [context.abortSignal] : []),
  ]);
  const { invoke, count } = dispatcher(execution, signal, limits);
  const driver = options.driver ?? quickjs;
  const isolate = await driver.createContext({
    bindings: bindingsFor(tools, invoke),
    timeout: limits.timeoutMs,
    memoryLimit: limits.memoryMb,
  });

  try {
    const outcome = await Promise.race([isolate.execute(code), cancellation(signal)]);

    return settle(outcome, count(), limits);
  } finally {
    controller.abort();
    await isolate.dispose();
  }
}

async function runCode(execution: Execution): Promise<CodeModeResult> {
  const { base, messages, call, context, options } = execution;
  const limits = options.limits ?? codeModeLimits;
  const source = parseCode(call.input, limits);
  const tools = sandboxTools(await base.getModelTools(messages), options.sandboxed);
  const startedAt = Date.now();
  const program = await transpile(source, limits);
  const result =
    "code" in program
      ? await runIsolate(execution, program.code, tools, limits)
      : failed(program.error.name, program.error.message, [], 0);
  context.emitCustomEvent("code_mode:execution_finished", {
    success: result.success,
    durationMs: Date.now() - startedAt,
    toolCalls: result.toolCalls,
    ...(result.error ? { error: result.error.name } : {}),
  });

  return result;
}

export function withCodeMode(base: RunTools, options: CodeModeOptions): RunTools {
  const limits = options.limits ?? codeModeLimits;

  return {
    async getModelTools(messages) {
      const definitions = await base.getModelTools(messages);
      const tools = sandboxTools(definitions, options.sandboxed);

      return tools.length ? [...definitions, definition(tools, limits)] : definitions;
    },
    executeTool(messages, call, context) {
      return call.name === codeModeToolName
        ? runCode({ base, messages, call, context, options })
        : base.executeTool(messages, call, context);
    },
  };
}
