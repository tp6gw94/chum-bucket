import type { UIMessage } from "@tanstack/ai";

export type ConversationState = {
  display: UIMessage[];
  context: UIMessage[];
};

export type RunProjection = ConversationState & { version: 1; committedRevision?: number };

export function isSummaryMessage(message: UIMessage): boolean {
  return (message.metadata as { fromSummary?: unknown } | undefined)?.fromSummary === true;
}

function sameConversation(messages: UIMessage[]): ConversationState {
  return { display: messages, context: messages };
}

export function readProjection(value: unknown): RunProjection {
  if (Array.isArray(value)) {
    return { version: 1, ...sameConversation(value as UIMessage[]) };
  }

  const projection = value as Partial<RunProjection> | null;

  if (
    !projection ||
    projection.version !== 1 ||
    !Array.isArray(projection.display) ||
    !Array.isArray(projection.context)
  ) {
    throw new Error("Unsupported run projection");
  }

  return projection as RunProjection;
}

export function toProjection(state: ConversationState, committedRevision?: number): RunProjection {
  return {
    version: 1,
    display: state.display,
    context: state.context,
    ...(committedRevision === undefined ? {} : { committedRevision }),
  };
}

export function messageWithToolCall(messages: readonly UIMessage[], toolCallId: string) {
  return messages.find((message) =>
    message.parts.some((part) => part.type === "tool-call" && part.id === toolCallId),
  )?.id;
}

function nextContext(
  previous: Map<string, UIMessage>,
  next: readonly UIMessage[],
  updatedMessageId: string | undefined,
): UIMessage[] {
  return next.map((message) =>
    previous.has(message.id) && message.id !== updatedMessageId
      ? previous.get(message.id)!
      : message,
  );
}

export function advanceConversation(
  state: ConversationState,
  next: readonly UIMessage[],
  updatedMessageId?: string,
): ConversationState {
  const previous = new Map(state.context.map((message) => [message.id, message]));
  const context = nextContext(previous, next, updatedMessageId);
  const display = [...state.display];
  const positions = new Map(display.map((message, index) => [message.id, index]));

  for (const message of context) {
    if (isSummaryMessage(message)) {
      continue;
    }

    const position = positions.get(message.id);

    if (position === undefined) {
      positions.set(message.id, display.length);
      display.push(message);
    } else if (!previous.has(message.id)) {
      throw new Error(`Message ${message.id} collides with compacted history`);
    } else {
      display[position] = message;
    }
  }

  return { display, context };
}
