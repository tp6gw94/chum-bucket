import {
  EventType,
  StreamProcessor,
  convertMessagesToModelMessages,
  type AdapterYieldChunk,
  type StreamChunk,
  type UIMessage,
} from "@tanstack/ai";
import { resolveDebugOption } from "@tanstack/ai/adapter-internals";
import type { CompactionState } from "../../shared/compaction-event";
import { advanceConversation, messageWithToolCall, type ConversationState } from "./conversation";
import {
  ContextOverflowError,
  snapshot,
  streamModelTurn,
  throwProviderError,
  type ModelCall,
} from "./model-turn";
import { createToolEventBuffer, persistToolEvents } from "./tool-events";
import type { ModelTool } from "./tools/atlassian";
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
  modelOptions?: Record<string, unknown>;
  logger: ReturnType<typeof resolveDebugOption>;
  request: { signal: AbortSignal };
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

export type AgentCompact = (input: {
  conversation: ConversationState;
  reason: "threshold" | "overflow";
  turn: number;
}) => Promise<{ state: CompactionState; conversation: ConversationState }>;

export type AgentLoopResult =
  | { state: "done"; conversation: ConversationState }
  | { state: "limit"; conversation: ConversationState };

type AgentLoopInput = {
  session: AgentSession;
  conversation: ConversationState;
  model: string;
  prompt: string;
  checkpoint: AgentCheckpoint;
  compact?: AgentCompact;
};

type ModelStepResult =
  | { state: "turn"; conversation: ConversationState; calls: ModelCall[] }
  | { state: "overflow" };

async function modelStream(
  session: AgentSession,
  input: { context: UIMessage[]; model: string; prompt: string },
) {
  const { definitions, systemPrompt } = await session.tools.getModelTools(input.context);

  try {
    return await session.chatStream({
      model: input.model,
      messages: convertMessagesToModelMessages(input.context),
      systemPrompts: [input.prompt, systemPrompt],
      tools: definitions,
      logger: resolveDebugOption(false),
      request: { signal: AbortSignal.timeout(MODEL_REQUEST_TIMEOUT_MS) },
    });
  } catch (error) {
    throwProviderError(error);
  }
}

async function modelStep(
  session: AgentSession,
  input: { conversation: ConversationState; model: string; prompt: string },
): Promise<ModelStepResult> {
  const { conversation } = input;
  await session.emit(session.runId, snapshot(conversation.display), conversation);

  try {
    const result = await streamModelTurn({
      messages: conversation.context,
      stream: await modelStream(session, { ...input, context: conversation.context }),
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

async function settleToolStep(
  session: AgentSession,
  input: { conversation: ConversationState; call: ModelCall; output: unknown; error: boolean },
): Promise<ConversationState> {
  const { conversation, call, output, error } = input;
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
  const processor = new StreamProcessor({
    initialMessages: structuredClone(conversation.context),
  });
  processor.processChunk(event);
  const messages = JSON.parse(JSON.stringify(processor.getMessages())) as UIMessage[];
  const next = advanceConversation(conversation, messages, messageWithToolCall(messages, call.id));
  await session.emit(session.runId, event, next);

  return next;
}

async function executeToolStep(
  session: AgentSession,
  input: { conversation: ConversationState; call: ModelCall },
): Promise<ConversationState> {
  const { conversation, call } = input;
  await session.emit(session.runId, snapshot(conversation.display), conversation);
  const events = createToolEventBuffer(call.id);
  let output: unknown;
  let error = false;

  try {
    const context = {
      toolCallId: call.id,
      abortSignal: AbortSignal.timeout(TOOL_REQUEST_TIMEOUT_MS),
      emitCustomEvent: events.emit,
    };
    output = await session.tools.executeTool(conversation.context, call, context);
  } catch (failure) {
    output = { error: failure instanceof Error ? failure.message.slice(0, 2000) : "Tool failed" };
    error = true;
  }

  await persistToolEvents(events.close(), (event) => session.emit(session.runId, event));

  return settleToolStep(session, { conversation, call, output, error });
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
  return input.checkpoint({
    name,
    work: async () => {
      await input.session.emit(input.session.runId, snapshot(conversation.display), conversation);

      return null;
    },
  });
}

function requestModel(input: AgentLoopInput, conversation: ConversationState, name: string) {
  return input.checkpoint({
    name,
    retry: MODEL_RETRY,
    work: () =>
      modelStep(input.session, {
        conversation,
        model: input.model,
        prompt: input.prompt,
      }),
  });
}

async function recoverOverflow(
  input: AgentLoopInput,
  conversation: ConversationState,
  turn: number,
): Promise<Extract<ModelStepResult, { state: "turn" }>> {
  await resetModel(input, conversation, `reset-model:${turn}:overflow`);
  const compacted = await input.compact?.({ conversation, reason: "overflow", turn });

  if (compacted?.state !== "done") {
    throw new ContextOverflowError("Context window exceeded and compaction did not help");
  }

  const retried = await requestModel(input, compacted.conversation, `model-overflow:${turn}`);

  if (retried.state === "overflow") {
    await resetModel(input, compacted.conversation, `reset-model:${turn}:exhausted`);
    throw new ContextOverflowError("Context window exceeded after compaction");
  }

  return retried;
}

async function compactBeforeModel(
  input: AgentLoopInput,
  conversation: ConversationState,
  turn: number,
): Promise<ConversationState> {
  if (!input.compact) {
    return conversation;
  }

  return (await input.compact({ conversation, reason: "threshold", turn })).conversation;
}

export async function runAgentLoop(input: AgentLoopInput): Promise<AgentLoopResult> {
  let conversation = input.conversation;

  for (let turn = 0; turn < MAX_TURN; turn++) {
    conversation = await compactBeforeModel(input, conversation, turn);
    const first = await requestModel(input, conversation, `model:${turn}`);
    const result =
      first.state === "overflow" ? await recoverOverflow(input, conversation, turn) : first;
    conversation = result.conversation;

    if (!result.calls.length) {
      return { state: "done", conversation };
    }

    conversation = await toolTurn(input, conversation, result.calls, turn);
  }

  return { state: "limit", conversation };
}
