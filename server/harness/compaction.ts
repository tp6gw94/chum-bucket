import { convertMessagesToModelMessages, type UIMessage } from "@tanstack/ai";
import type { CompactionEvent, CompactionTrigger } from "../../shared/compaction-event";
import { isSummaryMessage, type ConversationState } from "./conversation";
import { requestModelTurn, type ChatStream } from "./model-turn";
import {
  compactionSystemPrompt,
  sideChatSummarySystemPrompt,
  summaryPreambles,
  summaryRequestPrompt,
} from "./prompts";

const compactionSettings = {
  contextWindow: 128_000,
  reserveTokens: 16_384,
  keepRecentTokens: 20_000,
  manualKeepRecentTokens: 0,
  toolOverheadTokens: 8_000,
  summaryPromptTokens: 2_000,
  maxPartChars: 2_000,
  summaryTimeoutMs: 120_000,
} as const;

type DoneEvent = Extract<CompactionEvent, { phase: "done" }>;
type SkippedEvent = Extract<CompactionEvent, { phase: "skipped" }>;
type FailedEvent = Extract<CompactionEvent, { phase: "failed" }>;

export type CompactionResult =
  | { status: "done"; conversation: ConversationState; event: DoneEvent }
  | { status: "skipped"; event: SkippedEvent }
  | { status: "failed"; event: FailedEvent };

type SummaryModel = Readonly<{ chatStream: ChatStream; model: string; summaryId: string }>;

export type CompactionInput = SummaryModel &
  Readonly<{
    conversation: ConversationState;
    trigger: Exclude<CompactionTrigger, "side-chat">;
    instructions?: string;
  }>;

export type SideChatSeedInput = SummaryModel &
  Readonly<{
    conversation: ConversationState;
    parentContext: UIMessage[];
  }>;

const WIDE_CHARACTER = /[\u1100-\u11ff\u2e80-\u9fff\uac00-\ud7af\uf900-\ufaff\uff00-\uffef]/gu;

export function estimateTextTokens(text: string): number {
  const wide = text.match(WIDE_CHARACTER)?.length ?? 0;

  return wide + Math.ceil((text.length - wide) / 4);
}

function estimateMessageTokens(message: UIMessage): number {
  return estimateTextTokens(JSON.stringify(convertMessagesToModelMessages([message])));
}

export function estimateContextTokens(messages: readonly UIMessage[]): number {
  return messages.reduce((total, message) => total + estimateMessageTokens(message), 0);
}

export function shouldCompact(context: readonly UIMessage[], systemPrompt: string): boolean {
  const { contextWindow, reserveTokens, toolOverheadTokens } = compactionSettings;
  const overhead = estimateTextTokens(systemPrompt) + toolOverheadTokens;

  return estimateContextTokens(context) + overhead > contextWindow - reserveTokens;
}

export function selectCut(
  context: readonly UIMessage[],
  keepRecentTokens: number,
): number | undefined {
  const start = isSummaryMessage(context[0]) ? 1 : 0;
  let kept = 0;

  for (let cut = context.length; cut > start; cut--) {
    if (kept >= keepRecentTokens) {
      return cut;
    }

    kept += estimateMessageTokens(context[cut - 1]!);
  }

  return undefined;
}

function clip(text: string): string {
  const { maxPartChars } = compactionSettings;

  return text.length > maxPartChars
    ? `${text.slice(0, maxPartChars)}…（省略 ${text.length - maxPartChars} 字元）`
    : text;
}

function messageText(message: UIMessage): string {
  return message.parts
    .filter((part) => part.type === "text")
    .map((part) => part.content)
    .join("");
}

function serializeMessage(message: UIMessage): string[] {
  const speaker =
    message.role === "user" ? "User" : message.role === "system" ? "System" : "Assistant";

  return message.parts.flatMap((part) => {
    switch (part.type) {
      case "text":
        return part.content.trim() ? [`[${speaker}]: ${part.content}`] : [];
      case "tool-call":
        return [`[Tool call ${part.name}]: ${clip(part.arguments)}`];
      case "tool-result":
        return [
          `[Tool result]: ${clip(typeof part.content === "string" ? part.content : JSON.stringify(part.content))}`,
        ];
      default:
        return [];
    }
  });
}

function fitTranscript(lines: string[], budget: number): string {
  const kept: string[] = [];
  let used = 0;

  for (const line of lines.toReversed()) {
    const cost = estimateTextTokens(line) + 1;

    if (used + cost > budget) {
      kept.push("[…較早的內容因長度限制已省略…]");
      break;
    }

    kept.push(line);
    used += cost;
  }

  return kept.toReversed().join("\n\n");
}

function summarySource(messages: readonly UIMessage[]) {
  const previous = isSummaryMessage(messages[0]) ? messageText(messages[0]!) : undefined;
  const rest = previous === undefined ? messages : messages.slice(1);
  const { contextWindow, reserveTokens, summaryPromptTokens } = compactionSettings;
  const budget =
    contextWindow -
    reserveTokens -
    summaryPromptTokens -
    (previous === undefined ? 0 : estimateTextTokens(previous));

  return {
    previousSummary: previous,
    transcript: fitTranscript(rest.flatMap(serializeMessage), Math.max(budget, 0)),
    count: rest.length,
  };
}

async function requestSummary(
  input: SummaryModel & { systemPrompt: string; prompt: string },
): Promise<string> {
  const turn = await requestModelTurn({
    chatStream: input.chatStream,
    model: input.model,
    messages: [
      {
        id: `${input.summaryId}:request`,
        role: "user",
        parts: [{ type: "text", content: input.prompt }],
      },
    ],
    systemPrompts: [input.systemPrompt],
    tools: [],
    timeoutMs: compactionSettings.summaryTimeoutMs,
    append: async () => {},
  });
  const reply = turn.messages.at(-1);
  const summary = reply?.role === "assistant" ? messageText(reply).trim() : "";

  if (!summary) {
    throw new Error("Summary model returned no text");
  }

  return summary;
}

function summaryMessage(id: string, preamble: string, summary: string): UIMessage {
  return {
    id,
    role: "user",
    parts: [{ type: "text", content: `${preamble}\n\n${summary}` }],
    metadata: { fromSummary: true },
  };
}

function rebaseContext(
  conversation: ConversationState,
  cut: number,
  summary: UIMessage,
): ConversationState {
  const kept = conversation.context.slice(cut);
  const position = kept.length
    ? conversation.display.findIndex((message) => message.id === kept[0]!.id)
    : conversation.display.length;

  if (position < 0) {
    throw new Error("Kept context is missing from the display history");
  }

  return {
    display: [
      ...conversation.display.slice(0, position),
      summary,
      ...conversation.display.slice(position),
    ],
    context: [summary, ...kept],
  };
}

function failure(error: unknown): string {
  return (error instanceof Error ? error.message : "Summary request failed").slice(0, 500);
}

export async function compactConversation(input: CompactionInput): Promise<CompactionResult> {
  const { conversation, trigger } = input;
  const tokensBefore = estimateContextTokens(conversation.context);
  const keep =
    trigger === "manual"
      ? compactionSettings.manualKeepRecentTokens
      : compactionSettings.keepRecentTokens;
  const cut = selectCut(conversation.context, keep);

  if (cut === undefined) {
    return {
      status: "skipped",
      event: { phase: "skipped", trigger, tokensBefore, reason: "nothing-to-compact" },
    };
  }

  const source = summarySource(conversation.context.slice(0, cut));

  try {
    const summary = await requestSummary({
      ...input,
      systemPrompt: compactionSystemPrompt,
      prompt: summaryRequestPrompt({
        transcript: source.transcript,
        previousSummary: source.previousSummary,
        instructions: input.instructions,
      }),
    });
    const message = summaryMessage(input.summaryId, summaryPreambles.compaction, summary);
    const next = rebaseContext(conversation, cut, message);

    return {
      status: "done",
      conversation: next,
      event: {
        phase: "done",
        trigger,
        tokensBefore,
        tokensAfter: estimateContextTokens(next.context),
        summaryMessageId: message.id,
        compactedMessages: source.count,
      },
    };
  } catch (error) {
    return {
      status: "failed",
      event: { phase: "failed", trigger, tokensBefore, error: failure(error) },
    };
  }
}

export async function seedSideChat(input: SideChatSeedInput): Promise<CompactionResult> {
  const { conversation, parentContext } = input;
  const trigger = "side-chat";
  const tokensBefore = estimateContextTokens(parentContext);
  const source = summarySource(parentContext);

  if (!source.transcript && source.previousSummary === undefined) {
    return {
      status: "skipped",
      event: { phase: "skipped", trigger, tokensBefore, reason: "nothing-to-compact" },
    };
  }

  try {
    const summary = await requestSummary({
      ...input,
      systemPrompt: sideChatSummarySystemPrompt,
      prompt: summaryRequestPrompt(source),
    });
    const message = summaryMessage(input.summaryId, summaryPreambles.sideChat, summary);
    const next = {
      display: [message, ...conversation.display],
      context: [message, ...conversation.context],
    };

    return {
      status: "done",
      conversation: next,
      event: {
        phase: "done",
        trigger,
        tokensBefore,
        tokensAfter: estimateContextTokens(next.context),
        summaryMessageId: message.id,
        compactedMessages: parentContext.length,
      },
    };
  } catch (error) {
    return {
      status: "failed",
      event: { phase: "failed", trigger, tokensBefore, error: failure(error) },
    };
  }
}
