import {
  EventType,
  StreamProcessor,
  normalizeStreamChunk,
  uiMessagesToWire,
  type StreamChunk,
  type UIMessage,
  type AdapterYieldChunk,
} from "@tanstack/ai";

export class ContextOverflowError extends Error {
  constructor() {
    super("Model context capacity exceeded");
    this.name = "ContextOverflowError";
  }
}

const TRANSIENT_STATUS = /^(?:401|403|408|429|5\d\d)$/;
const TRANSIENT_TEXT =
  /unauthorized|forbidden|invalid api key|rate.?limit|too many requests|internal server|service unavailable|gateway|network|socket|connection|fetch failed|timed?\s*out|aborterror/i;
const OVERFLOW_CODES: ReadonlySet<string> = new Set([
  "context_length_exceeded",
  "max_context_length_exceeded",
  "context_window_exceeded",
]);
const OVERFLOW_TEXT =
  /maximum context length|(?:input|prompt|requested) tokens? exceed(?:s|ed)? (?:the )?(?:model'?s? )?(?:maximum context length|context window)/i;

function errorEvidence(error: unknown): Record<string, unknown>[] {
  const evidence: Record<string, unknown>[] = [];
  let item = error;

  while (item && typeof item === "object" && evidence.length < 12) {
    const value = item as Record<string, unknown>;
    evidence.push(value);
    item = value.error ?? value.cause;
  }

  return evidence;
}

function isContextOverflow(error: unknown): boolean {
  const evidence = errorEvidence(error);
  const codes = evidence
    .flatMap((value) => [value.code, value.status, value.statusCode])
    .filter((value) => typeof value === "string" || typeof value === "number")
    .map(String);
  const messages = evidence.flatMap((value) =>
    typeof value.message === "string" ? [value.message] : [],
  );

  if (
    codes.some((code) => TRANSIENT_STATUS.test(code)) ||
    messages.some((message) => TRANSIENT_TEXT.test(message))
  ) {
    return false;
  }

  if (codes.some((code) => OVERFLOW_CODES.has(code.toLowerCase()))) {
    return true;
  }

  return (
    codes.every((code) => /^(?:400|413)$/.test(code)) &&
    messages.some((message) => OVERFLOW_TEXT.test(message))
  );
}

export function throwProviderError(error: unknown): never {
  if (isContextOverflow(error)) {
    throw new ContextOverflowError();
  }

  throw error;
}

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
    if (isContextOverflow(event)) {
      throw new ContextOverflowError();
    }

    throw new Error(event.message);
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
  try {
    for await (const yielded of stream) {
      yield* normalizeStreamChunk(yielded);
    }
  } catch (error) {
    throwProviderError(error);
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
