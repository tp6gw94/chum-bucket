import {
  convertMessagesToModelMessages,
  normalizeStreamChunk,
  type StreamChunk,
  type UIMessage,
} from "@tanstack/ai";
import { resolveDebugOption } from "@tanstack/ai/adapter-internals";
import type { CompactionReason, CompactionState } from "../../shared/compaction-event";
import type { AgentChatStream } from "./agent-loop";
import { isSummaryMessage, type ConversationState } from "./conversation";
import { throwProviderError } from "./model-turn";
import { compactionSystemPrompt, sideSummarySystemPrompt, summaryPreamble } from "./prompts";
import type { ModelTool } from "./tools/atlassian";
import type { RunTools } from "./tools";

export type CompactionPolicy = Readonly<{
  triggerTokens: number;
  keepRecentTokens: number;
}>;

const defaultCompactionPolicy: CompactionPolicy = {
  triggerTokens: 48_000,
  keepRecentTokens: 20_000,
};

const REQUEST_OVERHEAD_TOKENS = 2_048;
const BYTES_PER_TOKEN = 3;
const SUMMARY_MAX_TOKENS = 2_000;
const SUMMARY_TIMEOUT_MS = 30_000;
const SUMMARY_MAX_CHARS = 8_000;
const SAFETY_LABEL = /^(?:safe|unsafe)(?:\s*\n?\s*S\d+(?:\s*,\s*S\d+)*)?$/i;

function positiveInteger(name: string, value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") {
    return fallback;
  }

  const parsed = Number(value);

  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive safe integer`);
  }

  return parsed;
}

export function readCompactionPolicy(
  env: Readonly<Record<string, string | undefined>>,
): CompactionPolicy {
  const policy = {
    triggerTokens: positiveInteger(
      "COMPACT_TRIGGER_TOKENS",
      env.COMPACT_TRIGGER_TOKENS,
      defaultCompactionPolicy.triggerTokens,
    ),
    keepRecentTokens: positiveInteger(
      "COMPACT_KEEP_RECENT_TOKENS",
      env.COMPACT_KEEP_RECENT_TOKENS,
      defaultCompactionPolicy.keepRecentTokens,
    ),
  };

  if (policy.keepRecentTokens >= policy.triggerTokens) {
    throw new Error("COMPACT_KEEP_RECENT_TOKENS must be smaller than COMPACT_TRIGGER_TOKENS");
  }

  return policy;
}

function jsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value) ?? "", "utf8");
}

function messageTokens(messages: readonly UIMessage[]): number {
  return Math.ceil(jsonBytes(convertMessagesToModelMessages([...messages])) / BYTES_PER_TOKEN);
}

export function estimateInputTokens(input: {
  messages: readonly UIMessage[];
  systemPrompts: readonly string[];
  definitions: readonly ModelTool[];
}): number {
  const bytes =
    jsonBytes(convertMessagesToModelMessages([...input.messages])) +
    jsonBytes(input.systemPrompts) +
    jsonBytes(input.definitions);

  return Math.ceil(bytes / BYTES_PER_TOKEN) + REQUEST_OVERHEAD_TOKENS;
}

export type CompactionPlan = Readonly<{
  previousSummary: string | null;
  transcript: UIMessage[];
  tail: UIMessage[];
}>;

function summaryText(message: UIMessage): string | null {
  if (!message.parts.every((part) => part.type === "text")) {
    return null;
  }

  const text = message.parts.map((part) => (part.type === "text" ? part.content : "")).join("");

  return text.startsWith(summaryPreamble) ? text.slice(summaryPreamble.length).trim() : text.trim();
}

type ToolSpan = { call: number; result: number | undefined };

function recordCall(spans: Map<string, ToolSpan>, id: string, state: string, index: number) {
  if (spans.has(id) || (state !== "complete" && state !== "error")) {
    return false;
  }

  spans.set(id, { call: index, result: undefined });

  return true;
}

function recordResult(spans: Map<string, ToolSpan>, id: string, index: number) {
  const span = spans.get(id);

  if (!span || span.result !== undefined) {
    return false;
  }

  span.result = index;

  return true;
}

function toolSpans(messages: readonly UIMessage[]): ToolSpan[] | null {
  const spans = new Map<string, ToolSpan>();

  for (const [index, message] of messages.entries()) {
    for (const part of message.parts) {
      const valid =
        part.type === "tool-call"
          ? recordCall(spans, part.id, part.state, index)
          : part.type === "tool-result"
            ? recordResult(spans, part.toolCallId, index)
            : true;

      if (!valid) {
        return null;
      }
    }
  }

  return [...spans.values()].every((span) => span.result !== undefined)
    ? [...spans.values()]
    : null;
}

function safeCuts(messages: readonly UIMessage[], spans: readonly ToolSpan[]): number[] {
  const cuts: number[] = [];

  for (let index = 1; index < messages.length; index++) {
    if (spans.every((span) => !(span.call < index && index <= span.result!))) {
      cuts.push(index);
    }
  }

  return cuts;
}

function chooseCut(
  messages: readonly UIMessage[],
  cuts: readonly number[],
  keepRecentTokens: number,
): number | undefined {
  const fits = (index: number) => messageTokens(messages.slice(index)) <= keepRecentTokens;
  const userCuts = cuts.filter((index) => messages[index]!.role === "user");
  const earliestUser = userCuts.find(fits);

  if (earliestUser !== undefined) {
    return earliestUser;
  }

  const lastUser = messages.findLastIndex((message) => message.role === "user");

  if (lastUser >= 0 && !fits(lastUser + 1)) {
    const assistant = cuts.find(
      (index) => index > lastUser && messages[index]!.role === "assistant" && fits(index),
    );

    if (assistant !== undefined) {
      return assistant;
    }
  }

  return userCuts.at(-1);
}

export function planCompaction(
  messages: readonly UIMessage[],
  policy: CompactionPolicy,
): CompactionPlan | null {
  const hasSummary = messages.length > 0 && isSummaryMessage(messages[0]!);
  const previousSummary = hasSummary ? summaryText(messages[0]!) : null;

  if (hasSummary && previousSummary === null) {
    return null;
  }

  const rest = hasSummary ? messages.slice(1) : [...messages];

  if (rest.some(isSummaryMessage)) {
    return null;
  }

  const spans = toolSpans(rest);

  if (!spans) {
    return null;
  }

  const cut = chooseCut(rest, safeCuts(rest, spans), policy.keepRecentTokens);

  if (cut === undefined || cut <= 0) {
    return null;
  }

  return { previousSummary, transcript: rest.slice(0, cut), tail: rest.slice(cut) };
}

export type SummaryPurpose = "compaction" | "side-summary";

export type SummaryInput = Readonly<{
  previousSummary: string | null;
  transcript: readonly UIMessage[] | readonly string[];
}>;

export type SummaryDependencies = Readonly<{
  chatStream: AgentChatStream;
  model: string;
  signal?: AbortSignal;
}>;

function transcriptPayload(transcript: SummaryInput["transcript"]) {
  return transcript.every((entry) => typeof entry === "string")
    ? transcript
    : convertMessagesToModelMessages([...(transcript as UIMessage[])]);
}

type SummaryRead = { text: string; finishReason: string | undefined };

function readSummaryEvent(event: StreamChunk, read: SummaryRead): void {
  if (event.type === "RUN_ERROR") {
    throwProviderError(event);
  }

  if (event.type === "TOOL_CALL_START") {
    throw new Error("Summary request returned a tool call");
  }

  if (event.type === "TEXT_MESSAGE_CONTENT") {
    read.text += event.delta;
  }

  if (event.type === "RUN_FINISHED") {
    const tanstack = (event.metadata as { tanstack?: { finishReason?: string } } | undefined)
      ?.tanstack;
    read.finishReason = event.finishReason ?? tanstack?.finishReason;
  }
}

function checkedSummary(read: SummaryRead): string {
  const text = read.text.trim();

  if (read.finishReason !== "stop") {
    throw new Error(`Summary finished with ${read.finishReason ?? "no finish reason"}`);
  }

  if (!text) {
    throw new Error("Summary is empty");
  }

  if (text.length > SUMMARY_MAX_CHARS) {
    throw new Error("Summary is too long");
  }

  if (SAFETY_LABEL.test(text)) {
    throw new Error("Summary is a safety label");
  }

  return text;
}

export async function summarizeTranscript(
  input: SummaryInput,
  purpose: SummaryPurpose,
  deps: SummaryDependencies,
): Promise<string> {
  const signal = AbortSignal.any([
    AbortSignal.timeout(SUMMARY_TIMEOUT_MS),
    ...(deps.signal ? [deps.signal] : []),
  ]);
  const stream = await deps.chatStream({
    model: deps.model,
    messages: [
      {
        role: "user",
        content: JSON.stringify({
          previousSummary: input.previousSummary,
          transcript: transcriptPayload(input.transcript),
        }),
      },
    ],
    systemPrompts: [purpose === "compaction" ? compactionSystemPrompt : sideSummarySystemPrompt],
    tools: [],
    modelOptions: { max_tokens: SUMMARY_MAX_TOKENS },
    logger: resolveDebugOption(false),
    request: { signal },
  });
  const read: SummaryRead = { text: "", finishReason: undefined };

  for await (const yielded of stream) {
    for (const event of normalizeStreamChunk(yielded)) {
      readSummaryEvent(event, read);
    }
  }

  return checkedSummary(read);
}

export type CompactionOutcome =
  | Readonly<{ state: "skipped" }>
  | Readonly<{ state: "failed"; error: string }>
  | Readonly<{
      state: "done";
      summary: UIMessage;
      messages: UIMessage[];
      before: number;
      after: number;
    }>;

export type PrepareCompactionInput = Readonly<{
  runId: string;
  operationId: string;
  reason: CompactionReason;
  messages: UIMessage[];
  prompt: string;
  policy: CompactionPolicy;
  tools: RunTools;
  summary: SummaryDependencies;
  started: () => Promise<void>;
}>;

async function estimateRequest(tools: RunTools, prompt: string, messages: UIMessage[]) {
  const { definitions, systemPrompt } = await tools.getModelTools(messages);

  return estimateInputTokens({ messages, systemPrompts: [prompt, systemPrompt], definitions });
}

export function summaryMessage(operationId: string, summary: string): UIMessage {
  return {
    id: `summary:${operationId}`,
    role: "user",
    parts: [{ type: "text", content: `${summaryPreamble}\n\n${summary}` }],
    metadata: { fromSummary: true },
  };
}

export async function prepareCompaction(input: PrepareCompactionInput): Promise<CompactionOutcome> {
  const before = await estimateRequest(input.tools, input.prompt, input.messages);

  if (input.reason === "threshold" && before <= input.policy.triggerTokens) {
    return { state: "skipped" };
  }

  const plan = planCompaction(input.messages, input.policy);

  if (!plan) {
    return { state: "skipped" };
  }

  await input.started();
  let summary: string;

  try {
    summary = await summarizeTranscript(plan, "compaction", input.summary);
  } catch (error) {
    if (input.summary.signal?.aborted) {
      throw error;
    }

    return { state: "failed", error: error instanceof Error ? error.message : "Summary failed" };
  }

  const message = summaryMessage(input.operationId, summary);
  const messages = [message, ...plan.tail];
  const after = await estimateRequest(input.tools, input.prompt, messages);

  return after < before
    ? { state: "done", summary: message, messages, before, after }
    : { state: "failed", error: "Summary did not reduce the context" };
}

export type CompactionCheckpoint = (
  runId: string,
  operationId: string,
  conversation: ConversationState,
  state: CompactionState,
  reason: CompactionReason,
) => Promise<void>;

export async function publishCompaction(input: {
  runId: string;
  operationId: string;
  reason: CompactionReason;
  outcome: CompactionOutcome;
  conversation: ConversationState;
  checkpoint: CompactionCheckpoint;
}): Promise<ConversationState> {
  const { outcome, conversation } = input;
  const next =
    outcome.state === "done"
      ? { display: [...conversation.display, outcome.summary], context: outcome.messages }
      : conversation;
  await input.checkpoint(input.runId, input.operationId, next, outcome.state, input.reason);

  return next;
}
