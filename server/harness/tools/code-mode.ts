import {
  convertSchemaToJsonSchema,
  parseWithStandardSchema,
  type ToolExecutionContext,
} from "@tanstack/ai";
import {
  createCodeMode,
  generateTypeStubs,
  stripTypeScript,
  toolsToBindings,
  type CodeModeTool,
  type IsolateDriver,
  type ToolBinding,
} from "@tanstack/ai-code-mode";
import { createQuickJSIsolateDriver } from "@tanstack/ai-isolate-quickjs";
import { z } from "zod";
import type { ModelCall } from "../model-turn";
import { discoveryToolName, ToolBoundaryError, type ModelTool } from "./atlassian";

export const codeModeToolName = "codemode";

const codeModeInputSchema = z
  .object({
    code: z
      .string()
      .describe(
        "TypeScript code to execute in the sandbox. Use external_* functions to call available APIs. Return a value to pass results back.",
      ),
  })
  .strict();

export class CodeModeBoundaryError extends Error {}

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

function codeModeDescription(bindings: Record<string, ToolBinding>): string {
  return `Execute TypeScript in a secure sandbox. Pass the program as JSON \`{"code": "<typescript>"}\`. The code can call these async external functions: ${Object.keys(bindings).join(", ")}. All external_* calls must be awaited. Return a value to pass results back. Use console.log() for debugging.`;
}

function codeModeSystemPrompt(bindings: Record<string, ToolBinding>): string {
  const catalog = Object.entries(bindings)
    .map(([name, binding]) => `- \`${name}(input)\`: ${binding.description}`)
    .join("\n");
  return `## Code Execution Tool

Call \`${codeModeToolName}\` with JSON \`{ "code": "<typescript>" }\`. The \`code\` field runs in a sandboxed environment.

Inside the code, these async functions are available:

${catalog}

### Type Definitions

\`\`\`typescript
${generateTypeStubs(bindings)}
\`\`\`

### Notes

- All \`external_*\` calls are async and must be awaited.
- Return a value to pass results back.
- \`console.log()\` output is captured.
- The sandbox is isolated with no network or filesystem access.
- Each execution is independent.`;
}

function consolePolicy(policy: CodeModePolicy): string {
  return `(() => {
  const maxEntries = ${policy.maxConsoleEntries};
  const maxBytes = ${policy.maxConsoleBytes};
  const maxEntry = ${policy.maxConsoleEntryBytes};
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
})();`;
}

function encoded(value: unknown): string {
  const text = JSON.stringify(value);
  return text === undefined ? "" : text;
}

function byteLength(value: unknown): number {
  return Buffer.byteLength(encoded(value));
}

type ProjectedEvent = Readonly<{ name: string; value: Record<string, unknown> }>;

function projectEvent(name: string, payload: Record<string, unknown>): ProjectedEvent | undefined {
  switch (name) {
    case "code_mode:execution_started":
      return { name, value: { codeLength: payload.codeLength ?? 0 } };
    case "code_mode:console":
      return {
        name,
        value: {
          level: payload.level ?? "log",
          byteLength: typeof payload.message === "string" ? payload.message.length : 0,
        },
      };
    case "code_mode:external_call":
      return {
        name,
        value: { function: payload.function ?? "", argumentBytes: byteLength(payload.args) },
      };
    case "code_mode:external_result":
      return {
        name,
        value: {
          function: payload.function ?? "",
          duration: payload.duration ?? 0,
          resultBytes: byteLength(payload.result),
        },
      };
    case "code_mode:external_error":
      return {
        name,
        value: { function: payload.function ?? "", duration: payload.duration ?? 0 },
      };
    case "code_mode:execution_finished":
      return {
        name,
        value: {
          phase: payload.phase ?? "",
          success: payload.success === true,
          durationMs: payload.durationMs ?? 0,
          logCount: payload.logCount ?? 0,
        },
      };
    default:
      return undefined;
  }
}

export function composeCodeModeTurn(input: {
  definitions: readonly ModelTool[];
  dispatch: Dispatch;
  guard: Guard;
  policy?: Partial<CodeModePolicy>;
}): CodeModeTurn {
  const policy: CodeModePolicy = { ...defaultPolicy, ...input.policy };
  const state = {
    parentCallId: codeModeToolName,
    signal: undefined as AbortSignal | undefined,
    controller: undefined as AbortController | undefined,
    calls: 0,
    closed: false,
    fatal: false,
    fatalMessage: "",
  };
  const stopped = () =>
    new CodeModeBoundaryError(state.fatalMessage || "codemode stopped after a boundary failure");
  const stop = (message: string) => {
    state.fatal = true;
    state.closed = true;
    state.fatalMessage ||= message;
    state.controller?.abort();
    return new CodeModeBoundaryError(message);
  };
  const guarded = (value: unknown) => {
    try {
      input.guard(value);
    } catch (failure) {
      throw stop(failure instanceof Error ? failure.message : "codemode boundary check failed");
    }
  };
  const adapter = (definition: ModelTool): CodeModeTool => ({
    __toolSide: "server",
    name: definition.name,
    description: definition.description,
    inputSchema: definition.inputSchema,
    execute: async (value: unknown) => {
      if (state.fatal) {
        throw stopped();
      }
      if (state.closed) {
        throw new CodeModeBoundaryError("codemode is no longer accepting tool calls");
      }
      if (state.signal?.aborted) {
        throw stop("codemode was cancelled");
      }
      if (state.calls >= policy.maxHostCalls) {
        throw stop(`codemode exceeded ${policy.maxHostCalls} tool calls`);
      }
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new CodeModeBoundaryError("codemode tool input must be an object");
      }
      state.calls += 1;
      guarded(value);
      const parsed = value;
      const argumentsText = encoded(parsed);
      if (Buffer.byteLength(argumentsText) > policy.maxHostInputBytes) {
        throw stop("codemode tool input is too large");
      }
      const childId = `${state.parentCallId}/external/${state.calls}`;
      let output: unknown;
      try {
        output = await input.dispatch(
          { id: childId, name: definition.name, arguments: argumentsText, input: parsed },
          {
            toolCallId: childId,
            abortSignal: state.signal,
            emitCustomEvent: () => {
              throw new Error("Tool custom events are not supported");
            },
          },
        );
      } catch (failure) {
        if (state.signal?.aborted) {
          throw stop("codemode was cancelled");
        }
        if (failure instanceof ToolBoundaryError) {
          throw stop(failure.message);
        }
        throw failure;
      }
      if (state.signal?.aborted) {
        throw stop("codemode was cancelled");
      }
      if (state.fatal) {
        throw stopped();
      }
      if (state.closed) {
        throw new CodeModeBoundaryError("codemode is no longer accepting tool calls");
      }
      guarded(output);
      if (byteLength(output) > policy.maxHostResultBytes) {
        throw stop("codemode tool result is too large");
      }
      return output;
    },
  });
  const sandboxTools = input.definitions
    .filter(
      (definition) => definition.name !== codeModeToolName && definition.name !== discoveryToolName,
    )
    .map(adapter);
  const composed = createCodeMode({
    driver: quickjsDriver,
    tools: sandboxTools,
    timeout: policy.timeoutMs,
    memoryLimit: policy.memoryLimitMb,
    onSecretParameter: "ignore",
    transpile: async (code: string) => {
      if (Buffer.byteLength(code, "utf8") > policy.maxSourceBytes) {
        throw stop(`codemode source exceeds ${policy.maxSourceBytes} bytes`);
      }
      guarded(code);
      return stripTypeScript(`${consolePolicy(policy)}\n${code}`);
    },
  });
  const bindings = toolsToBindings(sandboxTools, "external_");
  const systemPrompt = codeModeSystemPrompt(bindings);
  guarded(systemPrompt);
  const inputSchema = convertSchemaToJsonSchema(codeModeInputSchema);
  if (!inputSchema) {
    throw new Error("Codemode tool schema is unavailable");
  }
  return {
    definition: {
      name: codeModeToolName,
      description: codeModeDescription(bindings),
      inputSchema,
    },
    systemPrompt,
    async execute(value: unknown, context: ToolExecutionContext) {
      if (context.abortSignal?.aborted) {
        throw stop("codemode was cancelled");
      }
      state.parentCallId = context.toolCallId || codeModeToolName;
      state.controller = new AbortController();
      state.signal = AbortSignal.any([
        AbortSignal.timeout(policy.timeoutMs),
        ...(context.abortSignal ? [context.abortSignal] : []),
        state.controller.signal,
      ]);
      state.calls = 0;
      state.closed = false;
      state.fatal = false;
      state.fatalMessage = "";
      const controller = state.controller;
      const emit = context.emitCustomEvent;
      let request: { typescriptCode: string };
      try {
        guarded(value);
        const parsed = parseWithStandardSchema<{ code: string }>(codeModeInputSchema, value);
        request = { typescriptCode: parsed.code };
        parseWithStandardSchema<{ typescriptCode: string }>(composed.tool.inputSchema, request);
      } catch (failure) {
        controller.abort();
        const message = failure instanceof Error ? failure.message : "codemode input is invalid";
        guarded(message);
        throw stop(message);
      }
      try {
        const result = await composed.tool.execute!(request, {
          ...context,
          emitCustomEvent: (name: string, payload: Record<string, unknown>, options) => {
            if (name === "code_mode:execution_finished") {
              state.closed = true;
              controller.abort();
              guarded(payload);
              const projected = projectEvent(name, payload);
              if (projected) {
                emit(projected.name, projected.value, options);
              }
              return;
            }
            if (state.closed) {
              return;
            }
            try {
              guarded(payload);
              const projected = projectEvent(name, payload);
              if (projected) {
                emit(projected.name, projected.value, options);
              }
            } catch (failure) {
              state.fatal = true;
              state.closed = true;
              controller.abort();
              throw failure;
            }
          },
        });
        if (state.fatal) {
          throw stopped();
        }
        guarded(result);
        if (byteLength(result) > policy.maxResultBytes) {
          throw stop("codemode result is too large");
        }
        const logs = (result as { logs?: unknown }).logs;
        if (Array.isArray(logs) && logs.length > policy.maxConsoleEntries) {
          throw stop("codemode console output exceeded its bound");
        }
        return result;
      } finally {
        state.closed = true;
        controller.abort();
      }
    },
  };
}
