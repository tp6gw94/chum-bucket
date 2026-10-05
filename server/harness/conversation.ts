import type { UIMessage } from "@tanstack/ai";

export type ConversationState = {
  display: UIMessage[];
  context: UIMessage[];
};

export type RunProjection = ConversationState & { version: 1 };

export function readProjection(value: RunProjection | UIMessage[]): ConversationState {
  if (Array.isArray(value)) {
    return { display: value, context: value };
  }
  if (
    !value ||
    value.version !== 1 ||
    !Array.isArray(value.display) ||
    !Array.isArray(value.context)
  ) {
    throw new Error("Unsupported conversation projection");
  }
  return value;
}

export function projectConversation(state: ConversationState): RunProjection {
  return { version: 1, display: state.display, context: state.context };
}

export function advanceConversation(
  state: ConversationState,
  next: UIMessage[],
  updatedMessageId?: string,
): ConversationState {
  const previous = new Map(state.context.map((message) => [message.id, message]));
  const context = next.map((message) =>
    message.id === updatedMessageId ? message : (previous.get(message.id) ?? message),
  );
  const displayIds = new Set(state.display.map((message) => message.id));
  const updates = new Map<string, UIMessage>();
  for (const message of context) {
    if (!previous.has(message.id) && displayIds.has(message.id)) {
      throw new Error("Generated message collides with archived history");
    }
    if (message.metadata?.fromSummary !== true) {
      updates.set(message.id, message);
    }
  }
  return {
    display: [
      ...state.display.map((message) => updates.get(message.id) ?? message),
      ...context.filter((message) => !displayIds.has(message.id) && updates.has(message.id)),
    ],
    context,
  };
}
