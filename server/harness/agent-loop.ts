import {
  EventType,
  StreamProcessor,
  convertMessagesToModelMessages,
  type AdapterYieldChunk,
  type StreamChunk,
  type UIMessage,
} from "@tanstack/ai";
import { resolveDebugOption } from "@tanstack/ai/adapter-internals";
import { snapshot, streamModelTurn, type ModelCall, type Turn } from "./model-turn";
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
  messages?: UIMessage[],
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
  emit: AgentEmit;
  chatStream: AgentChatStream;
  tools: RunTools;
}>;

export type AgentCheckpoint = <T>(input: {
  name: string;
  retry?: AgentRetry;
  work: () => Promise<T>;
}) => Promise<T>;

export type AgentLoopResult =
  | { state: "done"; messages: UIMessage[] }
  | { state: "limit"; messages: UIMessage[] };

type AgentLoopInput = {
  session: AgentSession;
  messages: UIMessage[];
  model: string;
  prompt: string;
  checkpoint: AgentCheckpoint;
};

async function modelStep(
  session: AgentSession,
  input: { messages: UIMessage[]; model: string; prompt: string },
): Promise<Turn> {
  const { messages, model, prompt } = input;
  await session.emit(session.runId, snapshot(messages), messages);
  const tools = await session.tools.getModelTools(messages);
  const result = await streamModelTurn({
    messages,
    stream: await session.chatStream({
      model,
      messages: convertMessagesToModelMessages(messages),
      systemPrompts: [prompt, tools.systemPrompt],
      tools: tools.definitions,
      logger: resolveDebugOption(false),
      request: { signal: AbortSignal.timeout(MODEL_REQUEST_TIMEOUT_MS) },
    }),
    append: (event) => session.emit(session.runId, event),
  });
  await session.emit(session.runId, snapshot(result.messages), result.messages);

  return result;
}

async function settleToolStep(
  session: AgentSession,
  input: { messages: UIMessage[]; call: ModelCall; output: unknown; error: boolean },
): Promise<UIMessage[]> {
  const { messages, call, output, error } = input;
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
  await session.emit(session.runId, event, next);

  return next;
}

async function executeToolStep(
  session: AgentSession,
  input: { messages: UIMessage[]; call: ModelCall },
): Promise<UIMessage[]> {
  const { messages, call } = input;
  await session.emit(session.runId, snapshot(messages), messages);
  const events = createToolEventBuffer(call.id);
  let output: unknown;
  let error = false;

  try {
    const context = {
      toolCallId: call.id,
      abortSignal: AbortSignal.timeout(TOOL_REQUEST_TIMEOUT_MS),
      emitCustomEvent: (name: string, value: Record<string, unknown>) => events.emit(name, value),
    };
    output = await session.tools.executeTool(messages, call, context);
  } catch (failure) {
    output = { error: failure instanceof Error ? failure.message.slice(0, 2000) : "Tool failed" };
    error = true;
  }

  await drainToolEvents(events, (event) => session.emit(session.runId, event));

  return settleToolStep(session, { messages, call, output, error });
}

async function toolTurn(
  input: AgentLoopInput,
  initial: UIMessage[],
  calls: readonly ModelCall[],
  turn: number,
): Promise<UIMessage[]> {
  let messages = initial;

  for (const [index, call] of calls.entries()) {
    const current = messages;
    messages = await input.checkpoint({
      name: `tool:${turn}:${index}`,
      work: () => executeToolStep(input.session, { messages: current, call }),
    });
  }

  return messages;
}

export async function runAgentLoop(input: AgentLoopInput): Promise<AgentLoopResult> {
  const { session, model, prompt } = input;
  let messages = input.messages;

  for (let turn = 0; turn < MAX_TURN; turn++) {
    const current = messages;
    const result = await input.checkpoint({
      name: `model:${turn}`,
      retry: MODEL_RETRY,
      work: () => modelStep(session, { messages: current, model, prompt }),
    });
    messages = result.messages;

    if (!result.calls.length) {
      return { state: "done", messages };
    }

    messages = await toolTurn(input, messages, result.calls, turn);
  }

  return { state: "limit", messages };
}
