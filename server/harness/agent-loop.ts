import { EventType, StreamProcessor, type StreamChunk, type UIMessage } from "@tanstack/ai";
import { shouldCompact, type CompactionResult } from "./compaction";
import { advanceConversation, type ConversationState } from "./conversation";
import {
  ContextOverflowError,
  requestModelTurn,
  snapshot,
  type ChatStream,
  type ModelCall,
} from "./model-turn";
import { createToolEvents, type ToolEventLimits } from "./tool-events";
import type { RunTools } from "./tools";

const MODEL_REQUEST_TIMEOUT_MS = 120_000;
const TOOL_REQUEST_TIMEOUT_MS = 35_000;
const MAX_TURN = 20;
const TOOL_EVENT_LIMITS: ToolEventLimits = { maxEvents: 200, maxEventBytes: 16_000 };

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

export type AgentSession = Readonly<{
  runId: string;
  emit: AgentEmit;
  chatStream: ChatStream;
  tools: RunTools;
}>;

export type AgentCheckpoint = <T>(input: {
  name: string;
  retry?: AgentRetry;
  work: () => Promise<T>;
}) => Promise<T>;

export type AgentCompact = (input: {
  conversation: ConversationState;
  trigger: "threshold" | "overflow";
  name: string;
}) => Promise<CompactionResult>;

export type AgentLoopResult = Readonly<{
  outcome: "done" | "limit";
  conversation: ConversationState;
}>;

type AgentLoopInput = {
  session: AgentSession;
  conversation: ConversationState;
  model: string;
  prompt: string;
  checkpoint: AgentCheckpoint;
  compact: AgentCompact;
};

type ModelStep =
  | { kind: "turn"; conversation: ConversationState; calls: ModelCall[] }
  | { kind: "overflow"; message: string };

type ModelTurnStep = Extract<ModelStep, { kind: "turn" }>;

async function modelStep(
  session: AgentSession,
  input: { conversation: ConversationState; model: string; prompt: string },
): Promise<ModelStep> {
  const { conversation, model, prompt } = input;
  await session.emit(session.runId, snapshot(conversation.display), conversation);
  const tools = await session.tools.getModelTools(conversation.display);

  try {
    const turn = await requestModelTurn({
      chatStream: session.chatStream,
      model,
      messages: conversation.context,
      systemPrompts: [prompt, tools.systemPrompt],
      tools: tools.definitions,
      timeoutMs: MODEL_REQUEST_TIMEOUT_MS,
      append: (event) => session.emit(session.runId, event),
    });
    const next = advanceConversation(conversation, turn.messages);
    await session.emit(session.runId, snapshot(next.display), next);

    return { kind: "turn", conversation: next, calls: turn.calls };
  } catch (error) {
    if (error instanceof ContextOverflowError) {
      return { kind: "overflow", message: error.message };
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
  const next = advanceConversation(conversation, messages);
  await session.emit(session.runId, event, next);

  return next;
}

async function executeToolStep(
  session: AgentSession,
  input: { conversation: ConversationState; call: ModelCall },
): Promise<ConversationState> {
  const { conversation, call } = input;
  await session.emit(session.runId, snapshot(conversation.display), conversation);
  const events = createToolEvents((event) => session.emit(session.runId, event), TOOL_EVENT_LIMITS);
  let output: unknown;
  let error = false;

  try {
    const context = {
      toolCallId: call.id,
      abortSignal: AbortSignal.timeout(TOOL_REQUEST_TIMEOUT_MS),
      emitCustomEvent: events.emitCustomEvent,
    };
    output = await session.tools.executeTool(conversation.display, call, context);
  } catch (failure) {
    output = { error: failure instanceof Error ? failure.message.slice(0, 2000) : "Tool failed" };
    error = true;
  }

  await events.flush();

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

function modelCheckpoint(
  input: AgentLoopInput,
  conversation: ConversationState,
  name: string,
): Promise<ModelStep> {
  const { session, model, prompt } = input;

  return input.checkpoint({
    name,
    retry: MODEL_RETRY,
    work: () => modelStep(session, { conversation, model, prompt }),
  });
}

async function requestWithRecovery(
  input: AgentLoopInput,
  conversation: ConversationState,
  turn: number,
): Promise<ModelTurnStep> {
  const first = await modelCheckpoint(input, conversation, `model:${turn}`);

  if (first.kind === "turn") {
    return first;
  }

  const compacted = await input.compact({
    conversation,
    trigger: "overflow",
    name: `compact:${turn}:overflow`,
  });

  if (compacted.status !== "done") {
    throw new ContextOverflowError(first.message);
  }

  const retry = await modelCheckpoint(input, compacted.conversation, `model:${turn}:retry`);

  if (retry.kind === "overflow") {
    throw new ContextOverflowError(retry.message);
  }

  return retry;
}

export async function runAgentLoop(input: AgentLoopInput): Promise<AgentLoopResult> {
  let conversation = input.conversation;
  let thresholdOpen = true;

  for (let turn = 0; turn < MAX_TURN; turn++) {
    if (thresholdOpen && shouldCompact(conversation.context, input.prompt)) {
      const compacted = await input.compact({
        conversation,
        trigger: "threshold",
        name: `compact:${turn}`,
      });

      if (compacted.status === "done") {
        conversation = compacted.conversation;
      } else {
        thresholdOpen = false;
      }
    }

    const result = await requestWithRecovery(input, conversation, turn);
    conversation = result.conversation;

    if (!result.calls.length) {
      return { outcome: "done", conversation };
    }

    conversation = await toolTurn(input, conversation, result.calls, turn);
  }

  return { outcome: "limit", conversation };
}
