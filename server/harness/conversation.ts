import type { UIMessage } from "@tanstack/ai";

export type ConversationState = {
  display: UIMessage[];
  context: UIMessage[];
};

export type RunProjection = ConversationState & { version: 1; committedRevision?: number };

export function isSummary(message: UIMessage): boolean {
  const metadata = message.metadata as { fromSummary?: unknown } | undefined;

  return metadata?.fromSummary === true;
}

export function readProjection(value: unknown): RunProjection {
  if (Array.isArray(value)) {
    return { version: 1, display: value as UIMessage[], context: value as UIMessage[] };
  }

  const projection = value as Partial<RunProjection> | null;

  if (
    projection?.version !== 1 ||
    !Array.isArray(projection.display) ||
    !Array.isArray(projection.context)
  ) {
    throw new Error("Unsupported run projection");
  }

  return projection as RunProjection;
}

export function writeProjection(
  conversation: ConversationState,
  committedRevision?: number,
): RunProjection {
  return {
    version: 1,
    display: conversation.display,
    context: conversation.context,
    ...(committedRevision === undefined ? {} : { committedRevision }),
  };
}

export function advanceConversation(
  state: ConversationState,
  next: UIMessage[],
  updatedMessageId?: string,
): ConversationState {
  const previous = new Map(state.context.map((message) => [message.id, message]));
  const context = next.map((message) =>
    message.id !== updatedMessageId && previous.has(message.id)
      ? previous.get(message.id)!
      : message,
  );
  const display = [...state.display];
  const positions = new Map(display.map((message, index) => [message.id, index]));

  for (const message of context) {
    if (isSummary(message)) {
      continue;
    }

    const position = positions.get(message.id);

    if (position === undefined) {
      positions.set(message.id, display.length);
      display.push(message);
    } else if (!previous.has(message.id)) {
      throw new Error("Message ID collides with compacted history");
    } else {
      display[position] = message;
    }
  }

  return { display, context };
}
