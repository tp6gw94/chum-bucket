import {
  EventType,
  convertMessagesToModelMessages,
  normalizeStreamChunk,
  type AdapterYieldChunk,
  type StreamChunk,
  type UIMessage,
} from "@tanstack/ai";
import { resolveDebugOption } from "@tanstack/ai/adapter-internals";
import { compactionEvent } from "../../shared/compaction-event";
import { summaryModelTasks, type SummaryPurpose } from "./agents";
import { summaryPreamble } from "./prompts";
import { streamModelTurn } from "./model-turn";
import { checkpointCompaction } from "./run-store";
import type { ConversationState } from "./conversation";
import type { RunTools } from "./tools";
import type { ModelTool } from "./tools/atlassian";

export const COMPACT_TOKEN_THRESHOLD = 48_000;
export type CompactionPolicy = Readonly<{
  triggerTokens: number;
  keepRecentTokens: number;
}>;

const DEFAULT_COMPACTION_POLICY: CompactionPolicy = {
  triggerTokens: COMPACT_TOKEN_THRESHOLD,
  keepRecentTokens: 20_000,
};
const ESTIMATED_BYTES_PER_TOKEN = 3;
const ESTIMATED_FRAMING_TOKENS = 2_048;
const SUMMARY_TIMEOUT_MS = 30_000;
const SUMMARY_MAX_TOKENS = 2_000;
const SUMMARY_MAX_CHARS = 8_000;
const COMPLETE_TOOL_CALL_STATES = new Set(["complete", "error"]);

export type CompactionPlan = Readonly<{
  previousSummary: string | null;
  transcript: UIMessage[];
  tail: UIMessage[];
}>;

export type CompactionOutcome =
  | { state: "skipped" }
  | { state: "done"; messages: UIMessage[]; summary: UIMessage }
  | { state: "failed" };

export type CompactionEmit = (event: StreamChunk, messages?: UIMessage[]) => Promise<void>;

export function estimateInputTokens(input: {
  messages: readonly UIMessage[];
  systemPrompts: readonly string[];
  definitions: readonly ModelTool[];
}): number {
  const bytes =
    byteLength(convertMessagesToModelMessages([...input.messages])) +
    byteLength(input.systemPrompts) +
    byteLength(input.definitions);

  return Math.ceil(bytes / ESTIMATED_BYTES_PER_TOKEN) + ESTIMATED_FRAMING_TOKENS;
}

function byteLength(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value));
}

function isSummary(message: UIMessage): boolean {
  return message.metadata?.fromSummary === true;
}

function safeToolBoundaries(messages: readonly UIMessage[]): boolean[] | null {
  const cycles = new Map<string, { start: number; end: number | null }>();
  const results = new Set<string>();
  const valid = messages.every((message, index) =>
    message.parts.every((part) => {
      if (part.type === "tool-call") {
        if (cycles.has(part.id) || !COMPLETE_TOOL_CALL_STATES.has(part.state)) {
          return false;
        }

        cycles.set(part.id, { start: index, end: part.output === undefined ? null : index });
      } else if (part.type === "tool-result") {
        const cycle = cycles.get(part.toolCallId);

        if (!cycle || results.has(part.toolCallId) || !COMPLETE_TOOL_CALL_STATES.has(part.state)) {
          return false;
        }

        results.add(part.toolCallId);
        cycle.end = index;
      }

      return true;
    }),
  );

  if (!valid) {
    return null;
  }

  const crossings = Array<number>(messages.length + 1).fill(0);

  for (const { start, end } of cycles.values()) {
    if (end === null) {
      return null;
    }

    crossings[start + 1]!++;
    crossings[end + 1]!--;
  }

  let open = 0;

  return crossings.map((change) => {
    open += change;

    return open === 0;
  });
}

function validatePolicy(policy: CompactionPolicy): void {
  if (
    ![policy.triggerTokens, policy.keepRecentTokens].every(
      (value) => Number.isSafeInteger(value) && value > 0,
    )
  ) {
    throw new Error("Invalid compaction policy");
  }
}

export function planCompaction(
  messages: readonly UIMessage[],
  policy: CompactionPolicy = DEFAULT_COMPACTION_POLICY,
): CompactionPlan | null {
  validatePolicy(policy);
  const first = messages[0];
  const summary = first && isSummary(first) ? first : undefined;
  const raw = summary ? messages.slice(1) : [...messages];

  if (raw.some(isSummary)) {
    return null;
  }

  if (summary && summary.parts.some((part) => part.type !== "text")) {
    return null;
  }

  const previous =
    summary?.parts.flatMap((part) => (part.type === "text" ? [part.content] : [])).join("") ?? null;
  const previousSummary = previous?.startsWith(`${summaryPreamble}\n\n`)
    ? previous.slice(summaryPreamble.length + 2)
    : previous;
  const cut = retainedBoundary(raw, policy.keepRecentTokens, summary !== undefined);

  return cut === undefined
    ? null
    : { previousSummary, transcript: raw.slice(0, cut), tail: raw.slice(cut) };
}

function suffixByteLengths(raw: readonly UIMessage[]): number[] {
  const suffixBytes = Array<number>(raw.length + 1).fill(2);

  for (let index = raw.length - 1; index >= 0; index--) {
    const converted = convertMessagesToModelMessages([raw[index]!]);
    const remainingBytes = suffixBytes[index + 1]!;
    suffixBytes[index] =
      remainingBytes +
      (converted.length ? byteLength(converted) - 2 + (remainingBytes > 2 ? 1 : 0) : 0);
  }

  return suffixBytes;
}

function retainedBoundary(
  raw: readonly UIMessage[],
  keepRecentTokens: number,
  hasSummary: boolean,
): number | undefined {
  const safe = safeToolBoundaries(raw);

  if (safe === null) {
    return undefined;
  }

  const suffixBytes = suffixByteLengths(raw);
  const budgetBytes = keepRecentTokens * ESTIMATED_BYTES_PER_TOKEN;
  const newestUser = raw.findLastIndex((message) => message.role === "user");
  const spanStart = Math.max(newestUser, hasSummary ? 0 : -1);
  const oversizedLatestSpan = spanStart >= 0 && suffixBytes[spanStart]! > budgetBytes;
  const fits = (index: number) => suffixBytes[index]! <= budgetBytes;
  const candidates = raw.flatMap((_, index) => (index > 0 && safe[index] ? [index] : []));
  const userCuts = candidates.filter((index) => raw[index]!.role === "user");
  const fittingUser = userCuts.find(fits);

  if (fittingUser !== undefined) {
    return fittingUser;
  }

  const assistantCut = oversizedLatestSpan
    ? candidates.find(
        (index) => raw[index]!.role === "assistant" && index > spanStart && fits(index),
      )
    : undefined;

  return assistantCut ?? userCuts.at(-1);
}

export async function prepareCompaction(input: {
  runId: string;
  operationId: string;
  messages: UIMessage[];
  prompt: string;
  tools: RunTools;
  emit: CompactionEmit;
  policy?: CompactionPolicy;
  reason?: "threshold" | "overflow" | "manual";
  signal?: AbortSignal;
}): Promise<CompactionOutcome> {
  input.signal?.throwIfAborted();
  const { messages, prompt, tools } = input;
  const policy = input.policy ?? DEFAULT_COMPACTION_POLICY;
  validatePolicy(policy);
  let toolTurn: Awaited<ReturnType<RunTools["getModelTools"]>>;

  try {
    toolTurn = await tools.getModelTools(messages);
  } catch {
    return { state: "failed" };
  }

  const before = estimateInputTokens({
    messages,
    systemPrompts: [prompt, toolTurn.systemPrompt],
    definitions: toolTurn.definitions,
  });

  if ((input.reason ?? "threshold") === "threshold" && before <= policy.triggerTokens) {
    return { state: "skipped" };
  }

  const plan = planCompaction(messages, policy);

  if (plan === null) {
    return { state: "skipped" };
  }

  await input.emit(
    compactionEvent({ runId: input.runId, operationId: input.operationId, state: "started" }),
  );

  try {
    const summary = await summarizeTranscript(plan, "compaction", input.signal);
    input.signal?.throwIfAborted();
    const next = [summaryMessage(input.operationId, summary), ...plan.tail];
    const nextTurn = await tools.getModelTools(next);
    const after = estimateInputTokens({
      messages: next,
      systemPrompts: [prompt, nextTurn.systemPrompt],
      definitions: nextTurn.definitions,
    });

    return after < before
      ? {
          state: "done",
          messages: next,
          summary: { ...next[0]!, parts: [{ type: "text", content: summary }] },
        }
      : { state: "failed" };
  } catch {
    input.signal?.throwIfAborted();

    return { state: "failed" };
  }
}

export async function publishCompaction(input: {
  runId: string;
  operationId: string;
  outcome: CompactionOutcome;
  conversation: ConversationState;
}): Promise<ConversationState> {
  const { outcome, conversation } = input;

  if (
    outcome.state === "done" &&
    [...conversation.display, ...conversation.context].some(
      (message) => message.id === outcome.summary.id,
    )
  ) {
    throw new Error("Summary ID collides with conversation history");
  }

  const next =
    outcome.state === "done"
      ? {
          display: [...conversation.display, outcome.summary],
          context: outcome.messages,
        }
      : conversation;
  await checkpointCompaction(input.runId, input.operationId, next, outcome.state);

  return next;
}

function summaryMessage(operationId: string, summary: string): UIMessage {
  return {
    id: `summary:${operationId}`,
    role: "user",
    parts: [{ type: "text", content: `${summaryPreamble}\n\n${summary}` }],
    metadata: { fromSummary: true },
  };
}

export async function summarizeTranscript(
  plan: Pick<CompactionPlan, "previousSummary" | "transcript">,
  purpose: SummaryPurpose,
  signal?: AbortSignal,
): Promise<string> {
  signal?.throwIfAborted();
  const task = summaryModelTasks[purpose];
  const { deepinfra } = await import("./provider");
  const adapter = deepinfra(task.model);
  const stream = adapter.chatStream({
    model: task.model,
    messages: [
      {
        role: "user",
        content: JSON.stringify({
          previousSummary: plan.previousSummary,
          transcript: convertMessagesToModelMessages(plan.transcript),
        }),
      },
    ],
    systemPrompts: [task.systemPrompt],
    tools: [],
    logger: resolveDebugOption(false),
    modelOptions: { max_tokens: SUMMARY_MAX_TOKENS },
    request: {
      signal: AbortSignal.any([
        AbortSignal.timeout(SUMMARY_TIMEOUT_MS),
        ...(signal ? [signal] : []),
      ]),
    },
  });
  let finishReason: string | null | undefined;

  async function* observed(): AsyncGenerator<AdapterYieldChunk> {
    for await (const chunk of stream) {
      signal?.throwIfAborted();

      for (const event of normalizeStreamChunk(chunk)) {
        if (event.type === EventType.RUN_FINISHED) {
          const reason = event.finishReason ?? event.metadata?.tanstack?.finishReason;
          finishReason = typeof reason === "string" ? reason : undefined;
        }
      }

      yield chunk;
    }
  }

  const result = await streamModelTurn({
    messages: [],
    stream: observed(),
    append: async (_event: StreamChunk) => {},
  });
  signal?.throwIfAborted();

  if (finishReason !== undefined && finishReason !== "stop") {
    throw new Error("Summary did not complete normally");
  }

  if (result.calls.length > 0) {
    throw new Error("Summary requested tools");
  }

  const text = result.messages
    .flatMap((message) => message.parts)
    .flatMap((part) => (part.type === "text" ? [part.content] : []))
    .join("")
    .trim();

  if (text === "") {
    throw new Error("Summary is empty");
  }

  if (/<\/?ds_safety\b/i.test(text) || /^(?:safe|unsafe)[.!]?$/i.test(text)) {
    throw new Error("Summary contains safety classification");
  }

  if (text.length > SUMMARY_MAX_CHARS) {
    throw new Error("Summary is too long");
  }

  return text;
}
