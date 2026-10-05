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

function isContextOverflow(error: unknown): boolean {
  const evidence: Record<string, unknown>[] = [];
  const pending = [error];
  const seen = new Set<unknown>();
  while (pending.length && evidence.length < 12) {
    const item = pending.shift();
    if (!item || typeof item !== "object" || seen.has(item)) {
      continue;
    }
    seen.add(item);
    const value = item as Record<string, unknown>;
    evidence.push(value);
    pending.push(value.error, value.cause, value.rawEvent);
  }
  const codes = evidence
    .flatMap((value) => [value.code, value.status, value.statusCode])
    .filter((value) => typeof value === "string" || typeof value === "number")
    .map(String);
  const messages = evidence.flatMap((value) =>
    typeof value.message === "string" ? [value.message] : [],
  );
  const names = evidence.flatMap((value) => (typeof value.name === "string" ? [value.name] : []));
  if (
    codes.some(
      (code) =>
        /^(?:401|403|408|429|5\d\d)$/.test(code) ||
        /auth|permission|rate|quota|timeout|timedout|econn|enet|enotfound|eai_again|socket|server|transport/i.test(
          code,
        ),
    ) ||
    [...messages, ...names].some((value) =>
      /unauthorized|authentication|authorization|forbidden|invalid api key|permission denied|rate.?limit|too many requests|quota exceeded|internal server|service unavailable|gateway|network|socket|connection|fetch failed|timed?\s*out|aborterror/i.test(
        value,
      ),
    )
  ) {
    return false;
  }
  if (
    codes.some((code) =>
      [
        "context_length_exceeded",
        "max_context_length_exceeded",
        "context_window_exceeded",
      ].includes(code.toLowerCase()),
    )
  ) {
    return true;
  }
  if (codes.some((code) => !/^(?:400|413)$/.test(code))) {
    return false;
  }
  return messages.some((message) => {
    const lengths =
      /maximum context length (?:is|of) (\d[\d,]*) tokens[\s\S]*?(?:you requested|resulted in) (\d[\d,]*) tokens/i.exec(
        message,
      );
    if (lengths) {
      return Number(lengths[2]!.replaceAll(",", "")) > Number(lengths[1]!.replaceAll(",", ""));
    }
    return /(?:input|prompt|requested) tokens? (?:exceed|exceeds|exceeded) (?:the )?(?:model'?s? )?(?:maximum context length|context window)/i.test(
      message,
    );
  });
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
  protectedMessages?: UIMessage[];
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
  const iterator = stream[Symbol.asyncIterator]();
  let complete = false;
  let failed = false;
  try {
    while (true) {
      let next: IteratorResult<AdapterYieldChunk>;
      try {
        next = await iterator.next();
      } catch (error) {
        throwProviderError(error);
      }
      if (next.done) {
        complete = true;
        return;
      }
      yield* normalizeStreamChunk(next.value);
    }
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    if (!complete) {
      await Promise.resolve()
        .then(() => iterator.return?.())
        .catch((error: unknown) => {
          if (!failed) {
            throw error;
          }
        });
    }
  }
}

function assertTurnComplete(finished: boolean): void {
  if (!finished) {
    throw new Error("Incomplete model turn");
  }
}

type ProviderReferences = { messageId?: unknown; parentMessageId?: unknown; toolCallId?: unknown };

function nestedProviderReferences(event: StreamChunk): ProviderReferences {
  if (event.type === EventType.CUSTOM && event.value && typeof event.value === "object") {
    return event.value as ProviderReferences;
  }
  if (event.type === EventType.REASONING_ENCRYPTED_VALUE && event.subtype === "tool-call") {
    return { toolCallId: event.entityId };
  }
  return {};
}

function assertProviderHistory(
  event: StreamChunk & ProviderReferences,
  messageIds: ReadonlySet<string>,
  toolIds: ReadonlySet<string>,
): void {
  const nested = nestedProviderReferences(event);
  const messageCollision = [event.messageId, event.parentMessageId, nested.messageId].some(
    (id) => typeof id === "string" && messageIds.has(id),
  );
  const toolCollision = [event.toolCallId, nested.toolCallId].some(
    (id) => typeof id === "string" && toolIds.has(id),
  );
  if (event.type === EventType.MESSAGES_SNAPSHOT || messageCollision || toolCollision) {
    throw new Error("Provider event collides with conversation history");
  }
}

export async function streamModelTurn(input: ModelStream): Promise<Turn> {
  const processor = new StreamProcessor({ initialMessages: structuredClone(input.messages) });
  const history = [...input.messages, ...(input.protectedMessages ?? [])];
  const messageIds = new Set(history.map((message) => message.id));
  const toolIds = new Set(
    history.flatMap((message) =>
      message.parts.flatMap((part) =>
        part.type === "tool-call"
          ? [part.id]
          : part.type === "tool-result"
            ? [part.toolCallId]
            : [],
      ),
    ),
  );
  async function* checkedStream(): AsyncGenerator<StreamChunk> {
    let finished = false;
    for await (const event of normalizedEvents(input.stream)) {
      assertProviderHistory(event, messageIds, toolIds);
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
