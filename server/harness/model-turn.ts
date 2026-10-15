import {
  EventType,
  StreamProcessor,
  convertMessagesToModelMessages,
  normalizeStreamChunk,
  uiMessagesToWire,
  type JSONSchema,
  type StreamChunk,
  type UIMessage,
  type AdapterYieldChunk,
} from "@tanstack/ai";
import { resolveDebugOption } from "@tanstack/ai/adapter-internals";

export type ModelCall = { id: string; name: string; arguments: string; input: unknown };
export type Turn = {
  messages: UIMessage[];
  calls: ModelCall[];
};
type ModelStream = {
  messages: UIMessage[];
  stream: AsyncIterable<AdapterYieldChunk>;
  append: (event: StreamChunk) => Promise<void>;
};
type ModelToolDefinition = Readonly<{ name: string; description: string; inputSchema: JSONSchema }>;

export type ChatStream = (options: {
  model: string;
  messages: ReturnType<typeof convertMessagesToModelMessages>;
  systemPrompts: string[];
  tools: ModelToolDefinition[];
  logger: ReturnType<typeof resolveDebugOption>;
  request: { signal: AbortSignal };
}) => Promise<AsyncIterable<AdapterYieldChunk>>;

export type ModelRequest = Readonly<{
  chatStream: ChatStream;
  model: string;
  messages: UIMessage[];
  systemPrompts: string[];
  tools: ModelToolDefinition[];
  timeoutMs: number;
  signal?: AbortSignal;
  append: (event: StreamChunk) => Promise<void>;
}>;

export class ContextOverflowError extends Error {
  override name = "ContextOverflowError";
}

const CONTEXT_OVERFLOW_CODES = new Set(["context_length_exceeded", "413"]);
const CONTEXT_OVERFLOW_PATTERN =
  /context[ _-]?length|context window|maximum context|prompt is too long|input is too long|too many tokens|exceeds? the model's maximum/i;

function isContextOverflow(message: string, code: unknown): boolean {
  return (
    (typeof code === "string" && CONTEXT_OVERFLOW_CODES.has(code)) ||
    CONTEXT_OVERFLOW_PATTERN.test(message)
  );
}

function providerFailure(message: string, code: unknown): Error {
  return isContextOverflow(message, code) ? new ContextOverflowError(message) : new Error(message);
}

function toContextOverflow(error: unknown): unknown {
  if (!(error instanceof Error) || error instanceof ContextOverflowError) {
    return error;
  }

  const { code, status } = error as Error & { code?: unknown; status?: unknown };

  return isContextOverflow(
    error.message,
    code ?? (status === undefined ? undefined : String(status)),
  )
    ? new ContextOverflowError(error.message, { cause: error })
    : error;
}

export function snapshot(messages: UIMessage[]): StreamChunk {
  return { type: EventType.MESSAGES_SNAPSHOT, messages: uiMessagesToWire(messages) };
}

function assertObjectToolArguments(argumentsText: string): void {
  const parsed: unknown = JSON.parse(argumentsText);

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Invalid tool arguments");
  }
}

function assertTurnToolsComplete(processor: StreamProcessor): void {
  if (
    [...processor.getState().toolCalls.values()].some((call) => call.state !== "input-complete")
  ) {
    throw new Error("Incomplete model turn");
  }
}

function validateToolEvent(event: StreamChunk, processor: StreamProcessor): void {
  if (event.type === "TOOL_CALL_RESULT") {
    throw new Error("Provider tool results are not supported");
  }

  if (event.type === "TOOL_CALL_START" && processor.getState().toolCalls.has(event.toolCallId)) {
    throw new Error("Duplicate tool call");
  }

  if (event.type !== "TOOL_CALL_ARGS" && event.type !== "TOOL_CALL_END") {
    return;
  }

  const call = processor.getState().toolCalls.get(event.toolCallId);

  if (!call || call.state === "input-complete") {
    throw new Error("Invalid tool lifecycle");
  }

  if (event.type === "TOOL_CALL_END") {
    assertObjectToolArguments(call.arguments);
  }
}

function assertLiveEvent(event: StreamChunk, processor: StreamProcessor, finished: boolean): void {
  if (event.type === "RUN_ERROR") {
    throw providerFailure(event.message, event.code);
  }

  if (finished) {
    throw new Error("Provider emitted content after completion");
  }

  validateToolEvent(event, processor);
}

type EventFlow = Readonly<{ persist: boolean; emit: boolean; terminal: boolean }>;

const RUN_EVENT_FLOW = {
  RUN_STARTED: { persist: false, emit: false, terminal: false },
  RUN_FINISHED: { persist: false, emit: true, terminal: true },
} as const satisfies Record<"RUN_STARTED" | "RUN_FINISHED", EventFlow>;

const DEFAULT_EVENT_FLOW: EventFlow = { persist: true, emit: true, terminal: false };

function eventFlow(type: StreamChunk["type"]): EventFlow {
  return type === "RUN_STARTED" || type === "RUN_FINISHED"
    ? RUN_EVENT_FLOW[type]
    : DEFAULT_EVENT_FLOW;
}

async function* normalizedEvents(
  stream: AsyncIterable<AdapterYieldChunk>,
): AsyncGenerator<StreamChunk> {
  for await (const yielded of stream) {
    yield* normalizeStreamChunk(yielded);
  }
}

function assertTurnComplete(finished: boolean): void {
  if (!finished) {
    throw new Error("Incomplete model turn");
  }
}

export async function streamModelTurn(input: ModelStream): Promise<Turn> {
  const processor = new StreamProcessor({ initialMessages: structuredClone(input.messages) });

  async function* checkedStream(): AsyncGenerator<StreamChunk> {
    let finished = false;

    for await (const event of normalizedEvents(input.stream)) {
      assertLiveEvent(event, processor, finished);
      const flow = eventFlow(event.type);

      if (flow.terminal) {
        assertTurnToolsComplete(processor);
        finished = true;
      }

      if (flow.persist) {
        await input.append(event);
      }

      if (flow.emit) {
        yield event;
      }
    }

    assertTurnComplete(finished);
  }

  const result = await processor.process(checkedStream()).catch((error: unknown) => {
    throw toContextOverflow(error);
  });
  const state = processor.getState();
  const output: Turn = {
    messages: processor.getMessages(),
    calls: (result.toolCalls ?? []).map((call) => ({
      id: call.id,
      name: call.function.name,
      arguments: call.function.arguments,
      input: state.toolCalls.get(call.id)!.parsedArguments,
    })),
  };

  return JSON.parse(JSON.stringify(output)) as Turn;
}

export async function requestModelTurn(input: ModelRequest): Promise<Turn> {
  const stream = await input
    .chatStream({
      model: input.model,
      messages: convertMessagesToModelMessages(input.messages),
      systemPrompts: input.systemPrompts,
      tools: input.tools,
      logger: resolveDebugOption(false),
      request: {
        signal: input.signal
          ? AbortSignal.any([input.signal, AbortSignal.timeout(input.timeoutMs)])
          : AbortSignal.timeout(input.timeoutMs),
      },
    })
    .catch((error: unknown) => {
      throw toContextOverflow(error);
    });

  return streamModelTurn({ messages: input.messages, stream, append: input.append });
}
