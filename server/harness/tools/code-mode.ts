import {
  convertSchemaToJsonSchema,
  type JSONSchema,
  type ToolExecutionContext,
} from "@tanstack/ai";
import {
  generateTypeStubs,
  stripTypeScript,
  type ExecutionResult,
  type IsolateContext,
  type ToolBinding,
} from "@tanstack/ai-code-mode";
import { createQuickJSIsolateDriver } from "@tanstack/ai-isolate-quickjs";
import { z } from "zod";
import { codeModeSystemPrompt, codeModeToolDescription, type CodeModeFunction } from "../prompts";
import type { ModelTool } from "./atlassian";

export const codeModeToolName = "codemode";

const BINDING_PREFIX = "external_";
const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

export type CodeModeDefinition = ModelTool & Readonly<{ outputSchema?: JSONSchema }>;
export type CodeModeDispatch = (
  name: string,
  input: unknown,
  context: ToolExecutionContext,
) => Promise<unknown>;
export type CodeModeGuard = (value: unknown) => void;
export type CodeModePolicy = Readonly<{
  timeoutMs: number;
  memoryLimitMb: number;
  maxStackBytes: number;
  maxCodeLength: number;
  maxToolCalls: number;
  maxResultChars: number;
  maxLogs: number;
  maxMessageChars: number;
}>;
export type CodeModeResult = Readonly<{
  success: boolean;
  result?: unknown;
  truncated?: true;
  logs: string[];
  error?: Readonly<{ name: string; message: string }>;
}>;
export type CodeMode = Readonly<{
  definition: ModelTool;
  systemPrompt: string;
  execute: (input: unknown, context: ToolExecutionContext) => Promise<CodeModeResult>;
}>;

type Invoke = (args: unknown) => Promise<unknown>;

function inputSchema(policy: CodeModePolicy) {
  return z
    .object({
      code: z
        .string()
        .min(1)
        .max(policy.maxCodeLength)
        .describe("TypeScript program body. Top-level await and return are allowed."),
    })
    .strict();
}

function bindingName(definition: CodeModeDefinition): string {
  const name = `${BINDING_PREFIX}${definition.name}`;

  if (!IDENTIFIER.test(name)) {
    throw new Error(`Tool ${definition.name} cannot be exposed to Code Mode`);
  }

  return name;
}

function binding(definition: CodeModeDefinition, execute: Invoke): ToolBinding {
  return {
    name: bindingName(definition),
    description: definition.description,
    inputSchema: definition.inputSchema,
    outputSchema: definition.outputSchema,
    execute,
  };
}

function summary(description: string): string {
  return description.trim().split("\n")[0]!.trim();
}

function clip(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

function failureMessage(failure: unknown): string {
  return failure instanceof Error ? failure.message : "Tool failed";
}

function settleLogs(logs: readonly string[], policy: CodeModePolicy): string[] {
  const kept = logs.slice(0, policy.maxLogs).map((line) => clip(line, policy.maxMessageChars));
  const omitted = logs.length - kept.length;

  return omitted > 0 ? [...kept, `[${omitted} more log lines omitted]`] : kept;
}

function settleExecution(execution: ExecutionResult, policy: CodeModePolicy): CodeModeResult {
  const logs = settleLogs(execution.logs ?? [], policy);

  if (!execution.success) {
    return {
      success: false,
      logs,
      error: {
        name: execution.error?.name ?? "Error",
        message: clip(execution.error?.message ?? "Code execution failed", policy.maxMessageChars),
      },
    };
  }

  const result = execution.value ?? null;
  const text = JSON.stringify(result);

  return text.length > policy.maxResultChars
    ? { success: true, result: clip(text, policy.maxResultChars), truncated: true, logs }
    : { success: true, result, logs };
}

function consoleEvent(line: string) {
  const match = /^(ERROR|WARN|INFO): /.exec(line);

  return {
    level: (match?.[1]?.toLowerCase() ?? "log") as "log" | "error" | "warn" | "info",
    message: match ? line.slice(match[0].length) : line,
    timestamp: Date.now(),
  };
}

type Driver = ReturnType<typeof createQuickJSIsolateDriver>;
type Execution = Readonly<{
  context: ToolExecutionContext;
  signal: AbortSignal;
  emit: (name: string, value: Record<string, unknown>) => void;
  nextCall: () => number;
}>;

function declarationsFor(definitions: readonly CodeModeDefinition[]): string {
  const unavailable: Invoke = async () => {
    throw new Error("Code Mode binding is not active");
  };

  return generateTypeStubs(
    Object.fromEntries(
      definitions.map((definition) => [bindingName(definition), binding(definition, unavailable)]),
    ),
    { includeDescriptions: false },
  );
}

function invoker(
  execution: Execution,
  definition: CodeModeDefinition,
  dispatch: CodeModeDispatch,
  policy: CodeModePolicy,
): Invoke {
  const name = bindingName(definition);

  return async (args) => {
    const index = execution.nextCall();

    if (index > policy.maxToolCalls) {
      throw new Error(`Code Mode allows at most ${policy.maxToolCalls} tool calls`);
    }

    if (execution.signal.aborted) {
      throw new Error("Code Mode execution was cancelled");
    }

    const started = Date.now();
    execution.emit("external_call", { function: name, args, timestamp: started });

    try {
      const result = await dispatch(definition.name, args, {
        toolCallId: `${execution.context.toolCallId}:${index}`,
        abortSignal: execution.signal,
        emitCustomEvent: execution.context.emitCustomEvent,
      });
      execution.emit("external_result", { function: name, result, duration: Date.now() - started });

      return result;
    } catch (failure) {
      const message = failureMessage(failure);
      execution.emit("external_error", {
        function: name,
        error: message,
        duration: Date.now() - started,
      });
      throw new Error(message);
    }
  };
}

async function runProgram(
  code: string,
  bindings: Record<string, ToolBinding>,
  driver: Driver,
  policy: CodeModePolicy,
): Promise<CodeModeResult> {
  let isolate: IsolateContext | undefined;

  try {
    const javascript = await stripTypeScript(code);
    isolate = await driver.createContext({
      bindings,
      timeout: policy.timeoutMs,
      memoryLimit: policy.memoryLimitMb,
    });

    return settleExecution(await isolate.execute(javascript), policy);
  } catch (failure) {
    return {
      success: false,
      logs: [],
      error: {
        name: "CodeModeError",
        message: clip(failureMessage(failure), policy.maxMessageChars),
      },
    };
  } finally {
    await isolate?.dispose();
  }
}

function reportResult(execution: Execution, result: CodeModeResult, startedAt: number): void {
  for (const line of result.logs) {
    execution.emit("console", consoleEvent(line));
  }

  execution.emit("execution_finished", {
    timestamp: Date.now(),
    durationMs: Date.now() - startedAt,
    success: result.success,
    logCount: result.logs.length,
    ...(result.error ? { error: result.error } : {}),
  });
}

export function createCodeMode(input: {
  definitions: readonly CodeModeDefinition[];
  dispatch: CodeModeDispatch;
  guard: CodeModeGuard;
  policy: CodeModePolicy;
}): CodeMode {
  const { definitions, dispatch, guard, policy } = input;
  const schema = inputSchema(policy);
  const jsonSchema = convertSchemaToJsonSchema(schema);

  if (!jsonSchema) {
    throw new Error("Code Mode schema is unavailable");
  }

  const functions: CodeModeFunction[] = definitions.map((definition) => ({
    name: bindingName(definition),
    summary: summary(definition.description),
  }));
  const driver = createQuickJSIsolateDriver({
    timeout: policy.timeoutMs,
    memoryLimit: policy.memoryLimitMb,
    maxStackSize: policy.maxStackBytes,
  });

  async function execute(raw: unknown, context: ToolExecutionContext): Promise<CodeModeResult> {
    const { code } = schema.parse(raw);
    const startedAt = Date.now();
    const controller = new AbortController();
    let calls = 0;
    const execution: Execution = {
      context,
      signal: context.abortSignal
        ? AbortSignal.any([controller.signal, context.abortSignal])
        : controller.signal,
      emit: (name, value) => {
        guard(value);
        context.emitCustomEvent(`code_mode:${name}`, value);
      },
      nextCall: () => ++calls,
    };
    const bindings = Object.fromEntries(
      definitions.map((definition) => [
        bindingName(definition),
        binding(definition, invoker(execution, definition, dispatch, policy)),
      ]),
    );

    execution.emit("execution_started", { timestamp: startedAt, codeLength: code.length });
    const result = await runProgram(code, bindings, driver, policy).finally(() =>
      controller.abort(),
    );
    reportResult(execution, result, startedAt);
    guard(result);

    return result;
  }

  return {
    definition: {
      name: codeModeToolName,
      description: codeModeToolDescription(functions),
      inputSchema: jsonSchema,
    },
    systemPrompt: codeModeSystemPrompt({
      toolName: codeModeToolName,
      functions,
      declarations: declarationsFor(definitions),
    }),
    execute,
  };
}
