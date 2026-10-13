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
import type { ModelTool } from "./tools/atlassian";
import { createToolEventBuffer, drainToolEvents } from "./tool-events";
import type { RunTools } from "./tools";

const MODEL_REQUEST_TIMEOUT_MS = 120_000;
const TOOL_REQUEST_TIMEOUT_MS = 35_000;
const MAX_TURN = 20;

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

export type AgentCheckpoint = <T>(input: {
  name: string;
  retry?: AgentRetry;
  shouldRetry?: () => boolean;
  work: () => Promise<T>;
}) => Promise<T>;

export type AgentCompact = (input: {
  conversation: ConversationState;
  reason: "threshold" | "overflow";
  turn: number;
}) => Promise<ConversationState>;

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
  signal: AbortSignal;
};

type ModelOutcome =
  | { state: "done"; conversation: ConversationState; calls: ModelCall[] }
  | { state: "overflow" };

async function modelStep(
  session: AgentSession,
  input: { conversation: ConversationState; model: string; prompt: string; signal: AbortSignal },
): Promise<ModelOutcome> {
  const { conversation, model, prompt, signal } = input;
  signal.throwIfAborted();
  await session.assertExecution();
  await session.emit(session.runId, snapshot(conversation.display), conversation);
  const tools = await session.tools.getModelTools(conversation.context);
  let result: Awaited<ReturnType<typeof streamModelTurn>>;

  try {
    let stream: AsyncIterable<AdapterYieldChunk>;

    try {
      stream = await session.chatStream({
        model,
        messages: convertMessagesToModelMessages(conversation.context),
        systemPrompts: [prompt, tools.systemPrompt],
        tools: tools.definitions,
        logger: resolveDebugOption(false),
        request: {
          signal: AbortSignal.any([signal, AbortSignal.timeout(MODEL_REQUEST_TIMEOUT_MS)]),
        },
      });
    } catch (error) {
      throwProviderError(error);
    }

    result = await streamModelTurn({
      messages: conversation.context,
      stream,
      append: (event) => session.emit(session.runId, event),
    });
  } catch (error) {
    if (error instanceof ContextOverflowError) {
      return { state: "overflow" };
    }

    throw error;
  }

  signal.throwIfAborted();
  const next = advanceConversation(conversation, result.messages);
  await session.emit(session.runId, snapshot(next.display), next);

  return { state: "done", conversation: next, calls: result.calls };
}

async function settleToolStep(
  session: AgentSession,
  input: { conversation: ConversationState; call: ModelCall; output: unknown; error: boolean },
): Promise<ConversationState> {
  const { conversation, call, output, error } = input;
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
  const next = JSON.parse(JSON.stringify(processor.getMessages())) as UIMessage[];
  const owner = messages.find((message) =>
    message.parts.some((part) => part.type === "tool-call" && part.id === call.id),
  );
  const settled = advanceConversation(conversation, next, owner?.id);
  await session.emit(session.runId, event, settled);

  return settled;
}

async function executeToolStep(
  session: AgentSession,
  input: { conversation: ConversationState; call: ModelCall; signal: AbortSignal },
): Promise<ConversationState> {
  const { conversation, call, signal } = input;
  signal.throwIfAborted();
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
    output = await session.tools.executeTool(conversation.context, call, context);
  } catch (failure) {
    output = { error: failure instanceof Error ? failure.message.slice(0, 2000) : "Tool failed" };
    error = true;
  }

  signal.throwIfAborted();
  await drainToolEvents(events, (event) => session.emit(session.runId, event));

  return settleToolStep(session, { conversation, call, output, error });
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
    const current = conversation;
    conversation = await input.checkpoint({
      name: `tool:${turn}:${index}`,
      work: () => executeToolStep(session, { conversation: current, call, signal }),
    });
  }

  return conversation;
}

function modelAttempt(input: AgentLoopInput, conversation: ConversationState, name: string) {
  const { session, model, prompt, signal } = input;

  return input.checkpoint({
    name,
    retry: MODEL_RETRY,
    shouldRetry: () => !signal.aborted,
    work: () => modelStep(session, { conversation, model, prompt, signal }),
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
  conversation: ConversationState,
  turn: number,
): Promise<Extract<ModelOutcome, { state: "done" }>> {
  await resetModel(input, conversation, `reset-model:${turn}:overflow`);
  const compacted = await input.compact({ conversation, reason: "overflow", turn });
  const result = await modelAttempt(input, compacted, `model-overflow:${turn}`);

  if (result.state === "overflow") {
    await resetModel(input, compacted, `reset-model:${turn}:exhausted`);
    throw new ContextOverflowError();
  }

  return result;
}

export async function runAgentLoop(input: AgentLoopInput): Promise<AgentLoopResult> {
  const { session, signal } = input;
  let conversation = input.conversation;

  for (let turn = 0; turn < MAX_TURN; turn++) {
    signal.throwIfAborted();
    await session.assertExecution();
    conversation = await input.compact({ conversation, reason: "threshold", turn });
    const attempt = await modelAttempt(input, conversation, `model:${turn}`);
    const result =
      attempt.state === "done" ? attempt : await recoverOverflow(input, conversation, turn);
    conversation = result.conversation;

    if (!result.calls.length) {
      return { state: "done", conversation };
    }

    conversation = await toolTurn(input, conversation, result.calls, turn);
  }

  return { state: "limit", conversation };
}
