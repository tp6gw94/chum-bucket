import type { UIMessage } from "@tanstack/ai";

export type ConversationState = Readonly<{
  display: UIMessage[];
  context: UIMessage[];
}>;

export type RunProjection = Readonly<{
  messages: UIMessage[];
  contextAnchor?: string;
}>;

export function isSummaryMessage(message: UIMessage | undefined): boolean {
  return message?.metadata?.fromSummary === true;
}

export function conversationFromProjection({
  messages,
  contextAnchor,
}: RunProjection): ConversationState {
  if (contextAnchor === undefined) {
    return { display: messages, context: messages };
  }

  const start = messages.findIndex((message) => message.id === contextAnchor);

  if (start < 0 || !isSummaryMessage(messages[start])) {
    throw new Error("Context anchor is missing");
  }

  return { display: messages, context: messages.slice(start) };
}

export function projectConversation({ display, context }: ConversationState): RunProjection {
  const anchor = context[0];
  const start = isSummaryMessage(anchor)
    ? display.findIndex((message) => message.id === anchor!.id)
    : 0;
  const suffix = start < 0 ? [] : display.slice(start);

  if (
    suffix.length !== context.length ||
    suffix.some((message, index) => message.id !== context[index]!.id)
  ) {
    throw new Error("Context is not a suffix of the display history");
  }

  return isSummaryMessage(anchor)
    ? { messages: display, contextAnchor: anchor!.id }
    : { messages: display };
}

export function advanceConversation(
  state: ConversationState,
  next: readonly UIMessage[],
): ConversationState {
  const known = new Set(state.context.map((message) => message.id));
  const updated = new Map(
    next.filter((message) => known.has(message.id)).map((message) => [message.id, message]),
  );
  const added = next.filter((message) => !known.has(message.id));
  const apply = (messages: UIMessage[]) => [
    ...messages.map((message) => updated.get(message.id) ?? message),
    ...added,
  ];

  return { display: apply(state.display), context: apply(state.context) };
}
