import {
  EventType,
  StreamProcessor,
  convertMessagesToModelMessages,
  type AdapterYieldChunk,
  type StreamChunk,
  type UIMessage,
} from "@tanstack/ai";
import { resolveDebugOption } from "@tanstack/ai/adapter-internals";
import { advanceConversation, type ConversationState } from "./conversation";
import { attachHandoffImage } from "./handoff-image";
import {
  ContextOverflowError,
  snapshot,
  streamModelTurn,
  throwProviderError,
  type ModelCall,
} from "./model-turn";
import { createToolEventBuffer, drainToolEvents } from "./tool-events";
import type { ModelTool } from "./tools/atlassian";
import type { RunTools } from "./tools";

const MODEL_REQUEST_TIMEOUT_MS = 120_000;
const TOOL_REQUEST_TIMEOUT_MS = 35_000;
const MAIN_MAX_TURN = 20;

const MODEL_RETRY: AgentRetry = {
  retriesAllowed: true,
  maxAttempts: 3,
  intervalSeconds: 1,
  backoffRate: 2,
};

export type AgentRetry = Readonly<{
  retriesAllowed: boolean;
  maxAttempts: number;
  intervalSeconds: number;
  backoffRate: number;
}>;

export type AgentEmit = (
  runId: string,
  event: StreamChunk,
  conversation?: ConversationState,
) => Promise<void>;

export type AgentChatStream = (options: {
  model: string;
  messages: ReturnType<typeof convertMessagesToModelMessages>;
  systemPrompts: string[];
  tools: ModelTool[];
  logger: ReturnType<typeof resolveDebugOption>;
  request: { signal: AbortSignal };
}) => Promise<AsyncIterable<AdapterYieldChunk>>;

export type AgentSession = Readonly<{
  runId: string;
  assertExecution: () => Promise<void>;
  emit: AgentEmit;
  chatStream: AgentChatStream;
  tools: RunTools;
}>;

type ModelOutcome =
  | { state: "done"; conversation: ConversationState; calls: ModelCall[] }
  | { state: "overflow"; error: string };

export type AgentCheckpoint = <T>(input: {
  name: string;
  retry?: AgentRetry;
  shouldRetry?: () => boolean;
  work: () => Promise<T>;
}) => Promise<T>;

export type ChatCompaction = Readonly<{
  kind: "chat";
  compact: (input: {
    conversation: ConversationState;
    reason: "threshold" | "overflow" | "manual";
    turn: number;
  }) => Promise<ConversationState>;
}>;

type BoundedCompaction = Readonly<{
  kind: "bounded";
  maxTurn: number;
}>;

type AgentCompaction = ChatCompaction | BoundedCompaction;

export type AgentOrchestration = (
  call: ModelCall,
) => Promise<{ state: "handled"; output: unknown; error?: boolean } | { state: "unhandled" }>;

export type AgentLoopResult =
  | { state: "done"; conversation: ConversationState }
  | { state: "limit"; conversation: ConversationState }
  | { state: "overflow"; conversation: ConversationState };

async function modelStep(
  session: AgentSession,
  input: {
    conversation: ConversationState;
    model: string;
    prompt: string;
    signal: AbortSignal;
    finalTurn?: string;
  },
): Promise<ModelOutcome> {
  const { conversation, model, prompt, signal, finalTurn } = input;
  signal.throwIfAborted();
  await session.assertExecution();
  await session.emit(session.runId, snapshot(conversation.display), conversation);
  const turn =
    finalTurn === undefined
      ? await session.tools.getModelTools(conversation.context)
      : { definitions: [], systemPrompt: finalTurn };
  signal.throwIfAborted();
  await session.assertExecution();
  const options: Parameters<AgentChatStream>[0] = {
    model,
    messages: convertMessagesToModelMessages(conversation.context),
    systemPrompts: [prompt, turn.systemPrompt],
    tools: turn.definitions,
    logger: resolveDebugOption(false),
    request: { signal: AbortSignal.any([signal, AbortSignal.timeout(MODEL_REQUEST_TIMEOUT_MS)]) },
  };
  let result: Awaited<ReturnType<typeof streamModelTurn>>;

  try {
    let stream: AsyncIterable<AdapterYieldChunk>;

    try {
      stream = await session.chatStream(options);
    } catch (error) {
      throwProviderError(error);
    }

    result = await streamModelTurn({
      messages: conversation.context,
      protectedMessages: conversation.display,
      stream,
      append: (event) => session.emit(session.runId, event),
    });
  } catch (error) {
    if (error instanceof ContextOverflowError) {
      return { state: "overflow", error: error.message };
    }

    throw error;
  }

  signal.throwIfAborted();
  const next = advanceConversation(conversation, result.messages);
  await session.emit(session.runId, snapshot(next.display), next);

  return { state: "done", conversation: next, calls: result.calls };
}

export async function settleToolStep(
  session: AgentSession,
  input: {
    conversation: ConversationState;
    call: ModelCall;
    output: unknown;
    error?: boolean;
  },
): Promise<ConversationState> {
  const { conversation, call, output, error = false } = input;
  const messages = conversation.context;
  const content = JSON.stringify(output);

  if (typeof content !== "string") {
    throw new Error("Tool output is not JSON serializable");
  }

  const event: StreamChunk = {
    type: EventType.TOOL_CALL_RESULT,
    toolCallId: call.id,
    messageId: `${call.id}/result`,
    role: "tool",
    content,
    timestamp: Date.now(),
    metadata: { tanstack: { state: error ? "output-error" : "output-available" } },
  };
  const processor = new StreamProcessor({ initialMessages: structuredClone(messages) });
  processor.processChunk(event);
  const encoded = JSON.stringify(processor.getMessages());
  const next = JSON.parse(encoded) as UIMessage[];
  const owner = messages.find((message) =>
    message.parts.some((part) => part.type === "tool-call" && part.id === call.id),
  );
  const settled = advanceConversation(conversation, next, owner?.id);
  const updated = await attachHandoffImage(settled, call, output);
  await session.emit(session.runId, event, updated);

  return updated;
}

async function executeToolStep(
  session: AgentSession,
  input: { conversation: ConversationState; call: ModelCall; signal: AbortSignal },
): Promise<ConversationState> {
  const { conversation, call, signal } = input;
  signal.throwIfAborted();
  const messages = conversation.context;
  await session.emit(session.runId, snapshot(conversation.display), conversation);
  const events = createToolEventBuffer(call.id);
  let output: unknown;
  let error = false;

  try {
    const context = {
      toolCallId: call.id,
      abortSignal: AbortSignal.any([signal, AbortSignal.timeout(TOOL_REQUEST_TIMEOUT_MS)]),
      emitCustomEvent: (name: string, value: Record<string, unknown>) => events.emit(name, value),
    };
    output = await session.tools.executeTool(messages, call, context);
  } catch (failure) {
    output = { error: failure instanceof Error ? failure.message.slice(0, 2000) : "Tool failed" };
    error = true;
  }

  signal.throwIfAborted();
  await drainToolEvents(events, (event) => session.emit(session.runId, event));

  return settleToolStep(session, { conversation, call, output, error });
}

type AgentLoopInput = {
  session: AgentSession;
  conversation: ConversationState;
  model: string;
  prompt: string;
  compaction: AgentCompaction;
  checkpoint: AgentCheckpoint;
  signal: AbortSignal;
  orchestration?: AgentOrchestration;
  finalTurn?: string;
};

type CompletedModel = Extract<ModelOutcome, { state: "done" }>;

function modelAttempt(
  input: AgentLoopInput,
  conversation: ConversationState,
  name: string,
  finalTurn?: string,
) {
  const { session, model, prompt, signal } = input;

  return input.checkpoint({
    name,
    retry: MODEL_RETRY,
    shouldRetry: () => !signal.aborted,
    work: () => modelStep(session, { conversation, model, prompt, signal, finalTurn }),
  });
}

function resetModel(input: AgentLoopInput, conversation: ConversationState, name: string) {
  const { session } = input;

  return input.checkpoint({
    name,
    work: () => session.emit(session.runId, snapshot(conversation.display), conversation),
  });
}

async function recoverOverflow(
  input: AgentLoopInput,
  compaction: ChatCompaction,
  conversation: ConversationState,
  turn: number,
): Promise<CompletedModel> {
  await resetModel(input, conversation, `reset-model:${turn}:overflow`);
  const compacted = await compaction.compact({ conversation, reason: "overflow", turn });
  const result = await modelAttempt(input, compacted, `model-overflow:${turn}`);

  if (result.state === "overflow") {
    await resetModel(input, compacted, `reset-model:${turn}:exhausted`);
    throw new ContextOverflowError();
  }

  return result;
}

async function toolTurn(
  input: AgentLoopInput,
  initial: ConversationState,
  calls: readonly ModelCall[],
  turn: number,
): Promise<ConversationState> {
  const { session, signal } = input;
  let conversation = initial;

  for (const [index, call] of calls.entries()) {
    signal.throwIfAborted();
    await session.assertExecution();
    const orchestrated = input.orchestration ? await input.orchestration(call) : undefined;
    conversation = await input.checkpoint({
      name: `tool:${turn}:${index}`,
      work: () =>
        orchestrated?.state === "handled"
          ? settleToolStep(session, {
              conversation,
              call,
              output: orchestrated.output,
              error: orchestrated.error ?? false,
            })
          : executeToolStep(session, { conversation, call, signal }),
    });
  }

  return conversation;
}

async function completedModel(
  input: AgentLoopInput,
  attempt: ModelOutcome,
  conversation: ConversationState,
  turn: number,
): Promise<CompletedModel | null> {
  if (attempt.state === "done") {
    return attempt;
  }

  return input.compaction.kind === "bounded"
    ? null
    : recoverOverflow(input, input.compaction, conversation, turn);
}

export async function runAgentLoop(input: AgentLoopInput): Promise<AgentLoopResult> {
  const { session, compaction, signal } = input;
  const maxTurn = compaction.kind === "bounded" ? compaction.maxTurn : MAIN_MAX_TURN;
  let conversation = input.conversation;

  for (let turn = 0; turn < maxTurn; turn++) {
    signal.throwIfAborted();
    await session.assertExecution();

    if (compaction.kind === "chat") {
      conversation = await compaction.compact({ conversation, reason: "threshold", turn });
    }

    const reserved = turn === maxTurn - 1 ? input.finalTurn : undefined;
    const attempt = await modelAttempt(input, conversation, `model:${turn}`, reserved);
    const result = await completedModel(input, attempt, conversation, turn);

    if (!result) {
      return { state: "overflow", conversation };
    }

    conversation = result.conversation;

    if (!result.calls.length || reserved !== undefined) {
      return { state: "done", conversation };
    }

    conversation = await toolTurn(input, conversation, result.calls, turn);
  }

  return { state: "limit", conversation };
}
