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

export type ModelOutcome =
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

export type BoundedCompaction = Readonly<{
  kind: "bounded";
  maxTurn: number;
}>;

export type AgentCompaction = ChatCompaction | BoundedCompaction;

export type AgentOrchestration = (
  call: ModelCall,
) => Promise<{ state: "handled"; output: unknown; error?: boolean } | { state: "unhandled" }>;

export type AgentLoopResult =
  | { state: "done"; conversation: ConversationState }
  | { state: "limit"; conversation: ConversationState }
  | { state: "overflow"; conversation: ConversationState };

export async function modelStep(
  session: AgentSession,
  input: {
    conversation: ConversationState;
    model: string;
    prompt: string;
    signal: AbortSignal;
  },
): Promise<ModelOutcome> {
  const { conversation, model, prompt, signal } = input;
  signal.throwIfAborted();
  await session.assertExecution();
  await session.emit(session.runId, snapshot(conversation.display), conversation);
  const turn = await session.tools.getModelTools(conversation.context);
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
  const updated = advanceConversation(conversation, next, owner?.id);
  await session.emit(session.runId, event, updated);
  return updated;
}

export async function executeToolStep(
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

export async function runAgentLoop(input: {
  session: AgentSession;
  conversation: ConversationState;
  model: string;
  prompt: string;
  compaction: AgentCompaction;
  checkpoint: AgentCheckpoint;
  signal: AbortSignal;
  orchestration?: AgentOrchestration;
}): Promise<AgentLoopResult> {
  const { session, model, prompt, compaction, checkpoint, signal } = input;
  const maxTurn = compaction.kind === "bounded" ? compaction.maxTurn : MAIN_MAX_TURN;
  let conversation = input.conversation;
  let turn = 0;
  while (turn < maxTurn) {
    signal.throwIfAborted();
    await session.assertExecution();
    if (compaction.kind === "chat") {
      conversation = await compaction.compact({ conversation, reason: "threshold", turn });
    }
    let result = await checkpoint({
      name: `model:${turn}`,
      retry: MODEL_RETRY,
      shouldRetry: () => !signal.aborted,
      work: () => modelStep(session, { conversation, model, prompt, signal }),
    });
    if (result.state === "overflow") {
      if (compaction.kind === "bounded") {
        return { state: "overflow", conversation };
      }
      await checkpoint({
        name: `reset-model:${turn}:overflow`,
        work: () => session.emit(session.runId, snapshot(conversation.display), conversation),
      });
      conversation = await compaction.compact({ conversation, reason: "overflow", turn });
      result = await checkpoint({
        name: `model-overflow:${turn}`,
        retry: MODEL_RETRY,
        shouldRetry: () => !signal.aborted,
        work: () => modelStep(session, { conversation, model, prompt, signal }),
      });
      if (result.state === "overflow") {
        await checkpoint({
          name: `reset-model:${turn}:exhausted`,
          work: () => session.emit(session.runId, snapshot(conversation.display), conversation),
        });
        throw new ContextOverflowError();
      }
    }
    conversation = result.conversation;
    if (!result.calls.length) {
      return { state: "done", conversation };
    }
    for (const [index, call] of result.calls.entries()) {
      signal.throwIfAborted();
      await session.assertExecution();
      const orchestrated = input.orchestration ? await input.orchestration(call) : undefined;
      conversation = await checkpoint({
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
    turn++;
  }
  return { state: "limit", conversation };
}
