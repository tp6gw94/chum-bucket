import { setTimeout as delay } from "node:timers/promises";
import { DBOS } from "@dbos-inc/dbos-sdk";
import {
  EventType,
  StreamProcessor,
  convertMessagesToModelMessages,
  type StreamChunk,
  type UIMessage,
} from "@tanstack/ai";
import { resolveDebugOption } from "@tanstack/ai/adapter-internals";
import { withRunTools, type RunTools } from "./tools";
import { prepareCompaction, publishCompaction } from "./compaction";
import { advanceConversation, type ConversationState } from "./conversation";
import {
  ContextOverflowError,
  snapshot,
  streamModelTurn,
  throwProviderError,
  type ModelCall,
  type Turn,
} from "./model-turn";
import { createToolEventBuffer, drainToolEvents } from "./tool-events";
import {
  BUILD,
  MODEL,
  RunRequestError,
  database,
  persistRun,
  emit,
  finishRun,
  listPendingRuns,
  type RunInput,
  type AcceptedRun,
} from "./run-store";

const MAX_TURN = 20;

export async function acceptRun(value: RunInput): Promise<AcceptedRun> {
  const accepted = await persistRun(value);
  if (accepted.pending) {
    await ensureStarted(accepted.run);
  }
  return accepted.run;
}

async function toolStep(
  runId: string,
  conversation: ConversationState,
  call: ModelCall,
  tools: RunTools,
): Promise<ConversationState> {
  const messages = conversation.context;
  await emit(runId, snapshot(conversation.display), conversation);
  const events = createToolEventBuffer(call.id);
  let output: unknown;
  let error = false;
  try {
    const context = {
      toolCallId: call.id,
      abortSignal: AbortSignal.timeout(35_000),
      emitCustomEvent: (name: string, value: Record<string, unknown>) => events.emit(name, value),
    };
    output = await tools.executeTool(messages, call, context);
  } catch (failure) {
    output = { error: failure instanceof Error ? failure.message.slice(0, 2000) : "Tool failed" };
    error = true;
  }
  await drainToolEvents(events, (event) => emit(runId, event));
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
  await emit(runId, event, updated);
  return updated;
}

type ModelOutcome =
  | { state: "done"; conversation: ConversationState; calls: ModelCall[] }
  | { state: "overflow"; error: string };

async function modelStep(
  run: AcceptedRun,
  conversation: ConversationState,
  tools: RunTools,
): Promise<ModelOutcome> {
  await emit(run.runId, snapshot(conversation.display), conversation);
  const { deepinfra } = await import("./provider");
  const adapter = deepinfra(run.model);
  const turn = await tools.getModelTools(conversation.context);
  const options: Parameters<typeof adapter.chatStream>[0] = {
    model: run.model,
    messages: convertMessagesToModelMessages(conversation.context),
    systemPrompts: [run.prompt, turn.systemPrompt],
    tools: turn.definitions,
    logger: resolveDebugOption(false),
    request: { signal: AbortSignal.timeout(120_000) },
  };
  let result: Turn;
  try {
    let stream: ReturnType<typeof adapter.chatStream>;
    try {
      stream = adapter.chatStream(options);
    } catch (error) {
      throwProviderError(error);
    }
    result = await streamModelTurn({
      messages: conversation.context,
      protectedMessages: conversation.display,
      stream,
      append: (event) => emit(run.runId, event),
    });
  } catch (error) {
    if (error instanceof ContextOverflowError) {
      return { state: "overflow", error: error.message };
    }
    throw error;
  }
  const next = advanceConversation(conversation, result.messages);
  await emit(run.runId, snapshot(next.display), next);
  return { state: "done", conversation: next, calls: result.calls };
}

const MODEL_RETRY = {
  retriesAllowed: true,
  maxAttempts: 3,
  intervalSeconds: 1,
  backoffRate: 2,
};

async function compactConversation(
  run: AcceptedRun,
  conversation: ConversationState,
  tools: RunTools,
  turn: number,
  reason: "threshold" | "overflow",
): Promise<ConversationState> {
  const name = reason === "overflow" ? "compact-overflow" : "compact";
  const operationId = `${run.runId}/${name}/${turn}`;
  const outcome = await DBOS.runStep(
    () =>
      prepareCompaction({
        runId: run.runId,
        operationId,
        messages: conversation.context,
        prompt: run.prompt,
        model: run.model,
        tools,
        emit: (event) => emit(run.runId, event),
        reason,
      }),
    { name: `${name}:${turn}` },
  );
  if (outcome.state !== "skipped") {
    await DBOS.runStep(
      () => publishCompaction({ runId: run.runId, operationId, outcome, conversation }),
      { name: `publish-${name}:${turn}` },
    );
  }
  if (outcome.state === "done") {
    return { ...conversation, context: outcome.messages };
  }
  if (reason === "overflow") {
    throw new ContextOverflowError();
  }
  return conversation;
}

export async function executeRun(run: AcceptedRun) {
  if (run.build !== BUILD || run.model !== MODEL) {
    throw new Error("Incompatible run build");
  }
  return withRunTools(async (tools) => {
    let conversation: ConversationState = { display: run.messages, context: run.context };
    let turn = 0;
    while (turn < MAX_TURN) {
      conversation = await compactConversation(run, conversation, tools, turn, "threshold");
      let result = await DBOS.runStep(() => modelStep(run, conversation, tools), {
        name: `model:${turn}`,
        ...MODEL_RETRY,
      });
      if (result.state === "overflow") {
        await DBOS.runStep(() => emit(run.runId, snapshot(conversation.display), conversation), {
          name: `reset-model:${turn}:overflow`,
        });
        conversation = await compactConversation(run, conversation, tools, turn, "overflow");
        result = await DBOS.runStep(() => modelStep(run, conversation, tools), {
          name: `model-overflow:${turn}`,
          ...MODEL_RETRY,
        });
        if (result.state === "overflow") {
          await DBOS.runStep(() => emit(run.runId, snapshot(conversation.display), conversation), {
            name: `reset-model:${turn}:exhausted`,
          });
          throw new ContextOverflowError();
        }
      }
      conversation = result.conversation;
      if (!result.calls.length) {
        await DBOS.runStep(() => finishRun(run.runId, conversation), { name: "finish" });
        return;
      }
      for (const [index, call] of result.calls.entries()) {
        conversation = await DBOS.runStep(() => toolStep(run.runId, conversation, call, tools), {
          name: `tool:${turn}:${index}`,
        });
      }
      turn++;
    }
    throw new Error("Model iteration limit exceeded");
  });
}

const workflow = DBOS.registerWorkflow(executeRun, { name: BUILD });

async function ensureStarted(run: AcceptedRun) {
  if (run.build !== BUILD || run.model !== MODEL) {
    throw new RunRequestError(409, "Incompatible run build");
  }
  const status = await DBOS.getWorkflowStatus(run.runId);
  if (!status) {
    await DBOS.startWorkflow(workflow, { workflowID: run.runId })(run);
  }
}

export async function reconcileRuns() {
  const pending = await listPendingRuns();
  for (const run of pending) {
    if (run.accepted.build !== BUILD || run.accepted.model !== MODEL) {
      continue;
    }
    const status = await DBOS.getWorkflowStatus(run.id);
    if (!status) {
      await ensureStarted(run.accepted);
    } else if (
      ["ERROR", "CANCELLED", "MAX_RECOVERY_ATTEMPTS_EXCEEDED", "SUCCESS"].includes(status.status)
    ) {
      await finishRun(run.id, undefined, `workflow_${status.status.toLowerCase()}`);
    }
  }
}

let reconciliation: Promise<void> | undefined;
let stopReconciliation: AbortController | undefined;
export async function launchChatRuntime() {
  DBOS.setConfig({
    name: "chum-bucket-chat",
    applicationVersion: BUILD,
    systemDatabaseUrl: process.env.DATABASE_URL,
  });
  try {
    await DBOS.launch();
    await reconcileRuns();
  } catch (error) {
    await DBOS.shutdown();
    const db = await database();
    await db.$client.end();
    throw error;
  }
  stopReconciliation = new AbortController();
  const signal = stopReconciliation.signal;
  reconciliation = (async () => {
    while (!signal.aborted) {
      await delay(1000, undefined, { signal }).catch(() => undefined);
      if (signal.aborted) {
        break;
      }
      try {
        await reconcileRuns();
      } catch (error) {
        console.error("Chat reconciliation failed", error);
      }
    }
  })();
}

export async function shutdownChatRuntime() {
  stopReconciliation?.abort();
  await reconciliation;
  await DBOS.shutdown();
  const db = await database();
  await db.$client.end();
}
