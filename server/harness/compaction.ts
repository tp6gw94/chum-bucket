import {
  EventType,
  convertMessagesToModelMessages,
  normalizeStreamChunk,
  type AdapterYieldChunk,
  type StreamChunk,
  type UIMessage,
} from "@tanstack/ai";
import { resolveDebugOption } from "@tanstack/ai/adapter-internals";
import { COMPACTION_EVENT, type CompactionState } from "../../shared/compaction-event";
import type {
  AgentChatStream,
  AgentCheckpoint,
  AgentCompact,
  AgentSession,
  CompactionReason,
} from "./agent-loop";
import { isSummary, type ConversationState } from "./conversation";
import { compactionSystemPrompt, summaryPreamble } from "./prompts";
import type { ModelTool } from "./tools/atlassian";

export type CompactionPolicy = Readonly<{
  triggerTokens: number;
  keepRecentTokens: number;
}>;

export type CompactionPlan = {
  previousSummary: string | null;
  transcript: UIMessage[];
  tail: UIMessage[];
};

export type CompactionOutcome =
  | { state: "skipped" }
  | { state: "failed"; reason: string }
  | { state: "done"; summary: UIMessage; context: UIMessage[]; before: number; after: number };

const SUMMARY_MAX_TOKENS = 2_000;
const SUMMARY_TIMEOUT_MS = 30_000;
const SUMMARY_MAX_CHARS = 8_000;
const SAFETY_LABEL = /^(?:safe|unsafe)(?:\s+S\d+(?:\s*,\s*S\d+)*)?$/i;
const SUMMARY_PREFIX = `${summaryPreamble}\n\n`;
const encoder = new TextEncoder();

export const COMPACTION_POLICY: CompactionPolicy = {
  triggerTokens: 48_000,
  keepRecentTokens: 20_000,
};

function jsonBytes(value: unknown): number {
  return encoder.encode(JSON.stringify(value)).length;
}

function messageTokens(messages: UIMessage[]): number {
  return Math.ceil(jsonBytes(convertMessagesToModelMessages(messages)) / 3);
}

export function estimateInputTokens(input: {
  messages: UIMessage[];
  systemPrompts: string[];
  definitions: ModelTool[];
}): number {
  const total =
    jsonBytes(convertMessagesToModelMessages(input.messages)) +
    jsonBytes(input.systemPrompts) +
    jsonBytes(input.definitions);

  return Math.ceil(total / 3) + 2_048;
}

function summaryText(message: UIMessage): string | null {
  const texts = message.parts.map((part) => (part.type === "text" ? part.content : null));

  if (texts.some((text) => text === null)) {
    return null;
  }

  const text = texts.join("");

  return text.startsWith(SUMMARY_PREFIX) ? text.slice(SUMMARY_PREFIX.length) : text;
}

type ToolPairs = { open: Set<string>; settled: Set<string> };

function trackToolPart(part: UIMessage["parts"][number], pairs: ToolPairs): boolean {
  if (part.type === "tool-call") {
    const finished = part.state === "complete" || part.state === "error";

    if (!finished || pairs.open.has(part.id) || pairs.settled.has(part.id)) {
      return false;
    }

    pairs.open.add(part.id);
  } else if (part.type === "tool-result") {
    if (!pairs.open.delete(part.toolCallId)) {
      return false;
    }

    pairs.settled.add(part.toolCallId);
  }

  return true;
}

function safeBoundaries(messages: UIMessage[]): boolean[] | null {
  const pairs: ToolPairs = { open: new Set(), settled: new Set() };
  const safe: boolean[] = [];

  for (const message of messages) {
    safe.push(pairs.open.size === 0);

    if (!message.parts.every((part) => trackToolPart(part, pairs))) {
      return null;
    }
  }

  return pairs.open.size === 0 ? safe : null;
}

function chooseSplit(body: UIMessage[], safe: boolean[], keepRecentTokens: number) {
  const suffix = Array<number>(body.length + 1).fill(0);

  for (let index = body.length - 1; index >= 0; index--) {
    suffix[index] = suffix[index + 1]! + messageTokens([body[index]!]);
  }

  const fits = (index: number) => suffix[index]! <= keepRecentTokens;
  const candidates = body.map((_, index) => index).filter((index) => index > 0 && safe[index]);
  const users = candidates.filter((index) => body[index]!.role === "user");
  const lastUser = body.findLastIndex((message) => message.role === "user");
  const earliestUser = users.find(fits);

  if (earliestUser !== undefined) {
    return earliestUser;
  }

  if (!fits(Math.max(lastUser, 0))) {
    const assistant = candidates.find(
      (index) => index > lastUser && body[index]!.role === "assistant" && fits(index),
    );

    if (assistant !== undefined) {
      return assistant;
    }
  }

  return users.at(-1);
}

export function planCompaction(
  messages: UIMessage[],
  policy: CompactionPolicy,
): CompactionPlan | null {
  const [first] = messages;
  const hasSummary = first !== undefined && isSummary(first);
  const body = hasSummary ? messages.slice(1) : messages;

  if (body.some(isSummary)) {
    return null;
  }

  const previousSummary = hasSummary ? summaryText(first) : null;

  if (hasSummary && previousSummary === null) {
    return null;
  }

  const safe = safeBoundaries(body);

  if (!safe) {
    return null;
  }

  const split = chooseSplit(body, safe, policy.keepRecentTokens);

  if (split === undefined) {
    return null;
  }

  return { previousSummary, transcript: body.slice(0, split), tail: body.slice(split) };
}

type SummaryRead = { text: string; finishReason?: string | null };

function readSummaryEvent(event: StreamChunk, read: SummaryRead): void {
  if (event.type === "TEXT_MESSAGE_CONTENT") {
    read.text += event.delta;
  } else if (event.type === "TOOL_CALL_START") {
    throw new Error("Summary requested a tool call");
  } else if (event.type === "RUN_ERROR") {
    throw new Error(event.message);
  } else if (event.type === "RUN_FINISHED") {
    const metadata = event.metadata as { tanstack?: { finishReason?: string } } | undefined;
    read.finishReason = metadata?.tanstack?.finishReason ?? event.finishReason;
  }
}

async function readSummaryStream(stream: AsyncIterable<AdapterYieldChunk>): Promise<SummaryRead> {
  const read: SummaryRead = { text: "" };

  for await (const yielded of stream) {
    for (const event of normalizeStreamChunk(yielded)) {
      readSummaryEvent(event, read);
    }
  }

  return read;
}

async function summarizeTranscript(input: {
  chatStream: AgentChatStream;
  model: string;
  plan: CompactionPlan;
  signal?: AbortSignal;
}): Promise<string> {
  const { plan } = input;
  const timeout = AbortSignal.timeout(SUMMARY_TIMEOUT_MS);
  const stream = await input.chatStream({
    model: input.model,
    messages: [
      {
        role: "user",
        content: JSON.stringify({
          previousSummary: plan.previousSummary,
          transcript: convertMessagesToModelMessages(plan.transcript),
        }),
      },
    ],
    systemPrompts: [compactionSystemPrompt],
    tools: [],
    logger: resolveDebugOption(false),
    request: { signal: input.signal ? AbortSignal.any([timeout, input.signal]) : timeout },
    modelOptions: { max_tokens: SUMMARY_MAX_TOKENS },
  });
  const { text, finishReason } = await readSummaryStream(stream);
  const summary = text.trim();

  if (finishReason !== "stop") {
    throw new Error(`Summary finished with ${finishReason ?? "no finish reason"}`);
  }

  if (!summary || summary.length > SUMMARY_MAX_CHARS || SAFETY_LABEL.test(summary)) {
    throw new Error("Summary is unusable");
  }

  return summary;
}

export function compactionEvent(
  runId: string,
  operationId: string,
  state: CompactionState,
): StreamChunk {
  return {
    type: EventType.CUSTOM,
    name: COMPACTION_EVENT,
    value: { runId, operationId, state },
    timestamp: Date.now(),
  };
}

type PrepareInput = {
  session: AgentSession;
  operationId: string;
  reason: CompactionReason;
  conversation: ConversationState;
  policy: CompactionPolicy;
  model: string;
  prompt: string;
  signal?: AbortSignal;
};

export async function prepareCompaction(input: PrepareInput): Promise<CompactionOutcome> {
  const { session, operationId, policy } = input;
  const estimate = async (messages: UIMessage[]) =>
    estimateInputTokens({
      messages,
      systemPrompts: [input.prompt],
      definitions: await session.tools.getModelTools(messages),
    });
  const messages = input.conversation.context;
  const before = await estimate(messages);

  if (input.reason === "threshold" && before <= policy.triggerTokens) {
    return { state: "skipped" };
  }

  const plan = planCompaction(messages, policy);

  if (!plan) {
    return { state: "skipped" };
  }

  await session.emit(session.runId, compactionEvent(session.runId, operationId, "started"));

  try {
    const text = await summarizeTranscript({
      chatStream: session.chatStream,
      model: input.model,
      plan,
      signal: input.signal,
    });
    const summary: UIMessage = {
      id: `summary:${operationId}`,
      role: "user",
      parts: [{ type: "text", content: `${SUMMARY_PREFIX}${text}` }],
      metadata: { fromSummary: true },
    };
    const context = [summary, ...plan.tail];
    const after = await estimate(context);

    if (after >= before) {
      return { state: "failed", reason: "Summary did not shrink the context" };
    }

    return { state: "done", summary, context, before, after };
  } catch (error) {
    if (input.signal?.aborted) {
      throw error;
    }

    return { state: "failed", reason: error instanceof Error ? error.message : "Summary failed" };
  }
}

export function applyCompaction(
  conversation: ConversationState,
  outcome: CompactionOutcome,
): ConversationState {
  return outcome.state === "done"
    ? { display: [...conversation.display, outcome.summary], context: outcome.context }
    : conversation;
}

export type CompactionPublish = (input: {
  operationId: string;
  outcome: CompactionOutcome;
  conversation: ConversationState;
}) => Promise<ConversationState>;

export function compactor(input: {
  session: AgentSession;
  model: string;
  prompt: string;
  policy: CompactionPolicy;
  checkpoint: AgentCheckpoint;
  publish: CompactionPublish;
  signal?: AbortSignal;
}): AgentCompact {
  return async ({ conversation, reason, turn }) => {
    const label = reason === "overflow" ? "compact-overflow" : "compact";
    const operationId = `${input.session.runId}/${label}/${turn}`;
    const outcome = await input.checkpoint({
      name: `${label}:${turn}`,
      work: () =>
        prepareCompaction({
          session: input.session,
          operationId,
          reason,
          conversation,
          policy: input.policy,
          model: input.model,
          prompt: input.prompt,
          signal: input.signal,
        }),
    });

    if (outcome.state === "skipped" && reason === "threshold") {
      return { state: "skipped", conversation };
    }

    const next = await input.checkpoint({
      name: `publish-${label}:${turn}`,
      work: () => input.publish({ operationId, outcome, conversation }),
    });

    return { state: outcome.state, conversation: next };
  };
}
