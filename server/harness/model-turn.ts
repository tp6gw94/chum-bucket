import {
  EventType,
  StreamProcessor,
  normalizeStreamChunk,
  uiMessagesToWire,
  type StreamChunk,
  type UIMessage,
  type AdapterYieldChunk,
} from "@tanstack/ai";

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

export class ContextOverflowError extends Error {
  override name = "ContextOverflowError";
}

const OVERFLOW_CODES = new Set([
  "context_length_exceeded",
  "max_context_length_exceeded",
  "context_window_exceeded",
]);
const OVERFLOW_MESSAGE =
  /maximum context length (?:is|of) \d+ tokens|context (?:length|window) (?:is )?exceeded/i;

function errorField(error: unknown, field: "code" | "status" | "message"): unknown {
  return typeof error === "object" && error !== null
    ? (error as Record<string, unknown>)[field]
    : undefined;
}

const TRANSIENT_STATUSES = new Set([401, 403, 408, 429]);
const LIMIT_STATUSES = new Set([400, 413]);

function hasOverflowCode(error: unknown): boolean {
  const code = errorField(error, "code");

  return typeof code === "string" && OVERFLOW_CODES.has(code);
}

function hasOverflowMessage(error: unknown): boolean {
  const message = errorField(error, "message");

  return typeof message === "string" && OVERFLOW_MESSAGE.test(message);
}

function isContextOverflow(error: unknown): boolean {
  if (hasOverflowCode(error)) {
    return true;
  }

  const code = errorField(error, "code");
  const status = Number(errorField(error, "status") ?? code);
  const transient = TRANSIENT_STATUSES.has(status) || status >= 500;
  const limitStatus = code === undefined || LIMIT_STATUSES.has(status);

  return !transient && limitStatus && hasOverflowMessage(error);
}

export function throwProviderError(error: unknown): never {
  if (isContextOverflow(error)) {
    throw new ContextOverflowError(String(errorField(error, "message") ?? "Context overflow"));
  }

  if (error instanceof Error) {
    throw error;
  }

  throw new Error(String(errorField(error, "message") ?? "Provider request failed"));
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
    throwProviderError(event);
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

  const result = await processor.process(checkedStream());
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
