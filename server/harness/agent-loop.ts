import {
  EventType,
  StreamProcessor,
  convertMessagesToModelMessages,
  type AdapterYieldChunk,
  type StreamChunk,
  type UIMessage,
} from "@tanstack/ai";
import { resolveDebugOption } from "@tanstack/ai/adapter-internals";
import {
  ContextOverflowError,
  snapshot,
  streamModelTurn,
  throwProviderError,
  type ModelCall,
} from "./model-turn";
import { advanceConversation, type ConversationState } from "./conversation";
import type { ModelTool } from "./tools/atlassian";
import type { RunTools } from "./tools";

const MODEL_REQUEST_TIMEOUT_MS = 120_000;
const TOOL_REQUEST_TIMEOUT_MS = 35_000;
const MAX_TURN = 20;
const MAX_TOOL_EVENTS = 64;

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
  modelOptions?: { max_tokens: number };
}) => Promise<AsyncIterable<AdapterYieldChunk>>;

export type AgentSession = Readonly<{
  runId: string;
  emit: AgentEmit;
  chatStream: AgentChatStream;
  tools: RunTools;
}>;

export type AgentCheckpoint = <T>(input: {
  name: string;
  retry?: AgentRetry;
  work: () => Promise<T>;
}) => Promise<T>;

export type CompactionReason = "threshold" | "overflow" | "manual";

export type AgentCompact = (input: {
  conversation: ConversationState;
  reason: CompactionReason;
  turn: number;
}) => Promise<{ state: "done" | "skipped" | "failed"; conversation: ConversationState }>;

export type AgentLoopResult =
  | { state: "done"; conversation: ConversationState }
  | { state: "limit"; conversation: ConversationState };

type AgentLoopInput = {
  session: AgentSession;
  conversation: ConversationState;
  model: string;
  prompt: string;
  checkpoint: AgentCheckpoint;
  compact: AgentCompact;
};

type ModelStepResult =
  | { state: "turn"; conversation: ConversationState; calls: ModelCall[] }
  | { state: "overflow" };

async function openModelStream(
  session: AgentSession,
  options: Parameters<AgentChatStream>[0],
): Promise<AsyncIterable<AdapterYieldChunk>> {
  try {
    return await session.chatStream(options);
  } catch (error) {
    throwProviderError(error);
  }
}

async function modelStep(
  session: AgentSession,
  input: { conversation: ConversationState; model: string; prompt: string },
): Promise<ModelStepResult> {
  const { conversation, model, prompt } = input;
  const { context } = conversation;
  await session.emit(session.runId, snapshot(conversation.display), conversation);
  const definitions = await session.tools.getModelTools(context);

  try {
    const result = await streamModelTurn({
      messages: context,
      stream: await openModelStream(session, {
        model,
        messages: convertMessagesToModelMessages(context),
        systemPrompts: [prompt],
        tools: definitions,
        logger: resolveDebugOption(false),
        request: { signal: AbortSignal.timeout(MODEL_REQUEST_TIMEOUT_MS) },
      }),
      append: (event) => session.emit(session.runId, event),
    });
    const next = advanceConversation(conversation, result.messages);
    await session.emit(session.runId, snapshot(next.display), next);

    return { state: "turn", conversation: next, calls: result.calls };
  } catch (error) {
    if (error instanceof ContextOverflowError) {
      return { state: "overflow" };
    }

    throw error;
  }
}

function messageWithCall(messages: readonly UIMessage[], callId: string): string | undefined {
  return messages.find((message) =>
    message.parts.some((part) => part.type === "tool-call" && part.id === callId),
  )?.id;
}

async function settleToolStep(
  session: AgentSession,
  input: {
    conversation: ConversationState;
    call: ModelCall;
    output: unknown;
    error: boolean;
    events: readonly StreamChunk[];
  },
): Promise<ConversationState> {
  const { conversation, call, output, error, events } = input;
  const content = JSON.stringify(output);

  if (typeof content !== "string") {
    throw new Error("Tool output is not JSON serializable");
  }

  for (const event of events) {
    await session.emit(session.runId, event);
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
  const processor = new StreamProcessor({
    initialMessages: structuredClone(conversation.context),
  });
  processor.processChunk(event);
  const settled = JSON.parse(JSON.stringify(processor.getMessages())) as UIMessage[];
  const next = advanceConversation(
    conversation,
    settled,
    messageWithCall(conversation.context, call.id),
  );
  await session.emit(session.runId, event, next);

  return next;
}

async function executeToolStep(
  session: AgentSession,
  input: { conversation: ConversationState; call: ModelCall },
): Promise<ConversationState> {
  const { conversation, call } = input;
  const messages = conversation.context;
  await session.emit(session.runId, snapshot(conversation.display), conversation);
  const events: StreamChunk[] = [];
  let output: unknown;
  let error = false;

  try {
    const context = {
      toolCallId: call.id,
      abortSignal: AbortSignal.timeout(TOOL_REQUEST_TIMEOUT_MS),
      emitCustomEvent: (name: string, value: Record<string, unknown>) => {
        if (events.length < MAX_TOOL_EVENTS) {
          events.push({
            type: EventType.CUSTOM,
            name,
            value: JSON.parse(JSON.stringify({ ...value, toolCallId: call.id })),
            timestamp: Date.now(),
          });
        }
      },
    };
    output = await session.tools.executeTool(messages, call, context);
  } catch (failure) {
    output = { error: failure instanceof Error ? failure.message.slice(0, 2000) : "Tool failed" };
    error = true;
  }

  return settleToolStep(session, { conversation, call, output, error, events });
}

async function toolTurn(
  input: AgentLoopInput,
  initial: ConversationState,
  calls: readonly ModelCall[],
  turn: number,
): Promise<ConversationState> {
  let conversation = initial;

  for (const [index, call] of calls.entries()) {
    const current = conversation;
    conversation = await input.checkpoint({
      name: `tool:${turn}:${index}`,
      work: () => executeToolStep(input.session, { conversation: current, call }),
    });
  }

  return conversation;
}

function resetModel(input: AgentLoopInput, conversation: ConversationState, name: string) {
  const { session } = input;

  return input.checkpoint({
    name,
    work: () => session.emit(session.runId, snapshot(conversation.display), conversation),
  });
}

async function retryOverflow(
  input: AgentLoopInput,
  conversation: ConversationState,
  turn: number,
): Promise<Extract<ModelStepResult, { state: "turn" }>> {
  const { session, model, prompt } = input;
  await resetModel(input, conversation, `reset-model:${turn}:overflow`);
  const compacted = await input.compact({ conversation, reason: "overflow", turn });

  if (compacted.state !== "done") {
    throw new ContextOverflowError("Context overflow could not be compacted");
  }

  const result = await input.checkpoint({
    name: `model-overflow:${turn}`,
    retry: MODEL_RETRY,
    work: () => modelStep(session, { conversation: compacted.conversation, model, prompt }),
  });

  if (result.state === "overflow") {
    await resetModel(input, compacted.conversation, `reset-model:${turn}:exhausted`);
    throw new ContextOverflowError("Context overflow persisted after compaction");
  }

  return result;
}

export async function runAgentLoop(input: AgentLoopInput): Promise<AgentLoopResult> {
  const { session, model, prompt } = input;
  let conversation = input.conversation;

  for (let turn = 0; turn < MAX_TURN; turn++) {
    ({ conversation } = await input.compact({ conversation, reason: "threshold", turn }));
    const current = conversation;
    const attempt = await input.checkpoint({
      name: `model:${turn}`,
      retry: MODEL_RETRY,
      work: () => modelStep(session, { conversation: current, model, prompt }),
    });
    const result =
      attempt.state === "overflow" ? await retryOverflow(input, current, turn) : attempt;
    conversation = result.conversation;

    if (!result.calls.length) {
      return { state: "done", conversation };
    }

    conversation = await toolTurn(input, conversation, result.calls, turn);
  }

  return { state: "limit", conversation };
}
