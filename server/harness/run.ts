import { setTimeout as delay } from "node:timers/promises";
import { DBOS, DBOSClient } from "@dbos-inc/dbos-sdk";
import type { SideAccess } from "../../shared/side-chat";
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
  PREVIOUS_BUILD,
  MODEL,
  assertExecution,
  beginSideDiscard,
  purgeSideChat,
  listDiscardableSides,
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

export async function acceptRun(value: RunInput, access?: SideAccess): Promise<AcceptedRun> {
  const accepted = await persistRun(value, access);
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
  signal: AbortSignal,
): Promise<ConversationState> {
  signal.throwIfAborted();
  const messages = conversation.context;
  await emit(runId, snapshot(conversation.display), conversation);
  const events = createToolEventBuffer(call.id);
  let output: unknown;
  let error = false;
  try {
    const context = {
      toolCallId: call.id,
      abortSignal: AbortSignal.any([signal, AbortSignal.timeout(35_000)]),
      emitCustomEvent: (name: string, value: Record<string, unknown>) => events.emit(name, value),
    };
    output = await tools.executeTool(messages, call, context);
  } catch (failure) {
    output = { error: failure instanceof Error ? failure.message.slice(0, 2000) : "Tool failed" };
    error = true;
  }
  signal.throwIfAborted();
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
  signal: AbortSignal,
): Promise<ModelOutcome> {
  signal.throwIfAborted();
  await assertExecution(run);
  await emit(run.runId, snapshot(conversation.display), conversation);
  const { deepinfra } = await import("./provider");
  const adapter = deepinfra(run.model);
  const turn = await tools.getModelTools(conversation.context);
  signal.throwIfAborted();
  await assertExecution(run);
  const options: Parameters<typeof adapter.chatStream>[0] = {
    model: run.model,
    messages: convertMessagesToModelMessages(conversation.context),
    systemPrompts: [run.prompt, turn.systemPrompt],
    tools: turn.definitions,
    logger: resolveDebugOption(false),
    request: { signal: AbortSignal.any([signal, AbortSignal.timeout(120_000)]) },
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
  signal.throwIfAborted();
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
  reason: "threshold" | "overflow" | "manual",
  signal: AbortSignal,
): Promise<{ conversation: ConversationState; state: "done" | "skipped" | "failed" }> {
  signal.throwIfAborted();
  await assertExecution(run);
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
        signal,
      }),
    { name: `${name}:${turn}` },
  );
  signal.throwIfAborted();
  const next =
    outcome.state !== "skipped" || reason === "manual"
      ? await DBOS.runStep(
          () => publishCompaction({ runId: run.runId, operationId, outcome, conversation }),
          { name: `publish-${name}:${turn}` },
        )
      : conversation;
  if (reason === "overflow" && outcome.state !== "done") {
    throw new ContextOverflowError();
  }
  return { conversation: next, state: outcome.state };
}

export async function executeRun(run: AcceptedRun) {
  if (
    ![BUILD, PREVIOUS_BUILD].includes(run.build) ||
    run.model !== MODEL ||
    (run.side && run.build !== BUILD)
  ) {
    throw new Error("Incompatible run build");
  }
  await assertExecution(run);
  const signal = executions.get(run.runId)?.controller.signal ?? new AbortController().signal;
  signal.throwIfAborted();
  return withRunTools(async (tools) => {
    let conversation: ConversationState = { display: run.messages, context: run.context };
    if (run.kind === "compact") {
      const result = await compactConversation(run, conversation, tools, 0, "manual", signal);
      await DBOS.runStep(
        () =>
          finishRun(
            run.runId,
            result.state === "failed" ? undefined : result.conversation,
            "compaction_failed",
          ),
        { name: "finish" },
      );
      return;
    }
    let turn = 0;
    while (turn < MAX_TURN) {
      signal.throwIfAborted();
      await assertExecution(run);
      conversation = (
        await compactConversation(run, conversation, tools, turn, "threshold", signal)
      ).conversation;
      let result = await DBOS.runStep(() => modelStep(run, conversation, tools, signal), {
        name: `model:${turn}`,
        ...MODEL_RETRY,
        shouldRetry: () => !signal.aborted,
      });
      if (result.state === "overflow") {
        await DBOS.runStep(() => emit(run.runId, snapshot(conversation.display), conversation), {
          name: `reset-model:${turn}:overflow`,
        });
        conversation = (
          await compactConversation(run, conversation, tools, turn, "overflow", signal)
        ).conversation;
        result = await DBOS.runStep(() => modelStep(run, conversation, tools, signal), {
          name: `model-overflow:${turn}`,
          ...MODEL_RETRY,
          shouldRetry: () => !signal.aborted,
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
        signal.throwIfAborted();
        await assertExecution(run);
        conversation = await DBOS.runStep(
          () => toolStep(run.runId, conversation, call, tools, signal),
          {
            name: `tool:${turn}:${index}`,
          },
        );
      }
      turn++;
    }
    throw new Error("Model iteration limit exceeded");
  }, signal);
}

const workflow = DBOS.registerWorkflow(executeRun, { name: BUILD });
const previousWorkflow = DBOS.registerWorkflow((run: AcceptedRun) => executeRun(run), {
  name: PREVIOUS_BUILD,
});
type Execution = { controller: AbortController; starting: Promise<void>; quiet?: Promise<void> };
const executions = new Map<string, Execution>();
const priorProcessQuiet = new Set<string>();

export async function ensureStarted(run: AcceptedRun) {
  if (![BUILD, PREVIOUS_BUILD].includes(run.build) || run.model !== MODEL) {
    throw new RunRequestError(409, "Incompatible run build");
  }
  const prior = executions.get(run.runId);
  if (prior) {
    return prior.starting;
  }
  const entry: Execution = { controller: new AbortController(), starting: Promise.resolve() };
  executions.set(run.runId, entry);
  entry.starting = (async () => {
    await assertExecution(run);
    entry.controller.signal.throwIfAborted();
    const status = await DBOS.getWorkflowStatus(run.runId);
    if (!status) {
      entry.controller.signal.throwIfAborted();
      const handle = await DBOS.startWorkflow(run.build === BUILD ? workflow : previousWorkflow, {
        workflowID: run.runId,
      })(run);
      entry.quiet = handle.getResult().then(
        () => undefined,
        () => undefined,
      );
      if (!run.side) {
        void entry.quiet.finally(() => executions.delete(run.runId));
      }
    } else if (run.side && !priorProcessQuiet.has(run.runId)) {
      throw new Error("Missing original side chat invocation handle");
    }
  })();
  try {
    await entry.starting;
  } catch (error) {
    if (!entry.quiet) {
      executions.delete(run.runId);
    }
    throw error;
  }
}

const discards = new Map<string, Promise<void>>();
const summaryExecutions = new Map<
  string,
  Set<{ controller: AbortController; quiet: Promise<unknown> }>
>();

export function trackSideSummary<T>(
  id: string,
  use: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const entries = summaryExecutions.get(id) ?? new Set();
  summaryExecutions.set(id, entries);
  const quiet = Promise.resolve().then(() => use(controller.signal));
  const entry = { controller, quiet };
  entries.add(entry);
  return quiet.finally(() => {
    entries.delete(entry);
    if (!entries.size) {
      summaryExecutions.delete(id);
    }
  });
}

export async function discardSideChat(id: string, access?: SideAccess) {
  const ids = await beginSideDiscard(id, access);
  const prior = discards.get(id);
  if (prior) {
    return prior;
  }
  const work = (async () => {
    const summaries = [...(summaryExecutions.get(id) ?? [])];
    for (const entry of summaries) {
      entry.controller.abort();
    }
    await Promise.allSettled(summaries.map((entry) => entry.quiet));
    for (const runId of ids) {
      const entry = executions.get(runId);
      entry?.controller.abort();
      await entry?.starting.catch(() => undefined);
      const status = await DBOS.getWorkflowStatus(runId);
      if (status) {
        await DBOS.cancelWorkflow(runId);
      }
      if (entry?.quiet) {
        await entry.quiet;
      } else if (status && !priorProcessQuiet.has(runId)) {
        throw new Error("Cannot prove SDK side chat workflow is quiet");
      }
      if (status || entry?.quiet) {
        await DBOS.deleteWorkflow(runId);
      }
      executions.delete(runId);
      priorProcessQuiet.delete(runId);
    }
    await purgeSideChat(id);
  })();
  discards.set(id, work);
  try {
    await work;
  } finally {
    discards.delete(id);
  }
}

async function abandonPriorProcessSides() {
  const sides = await listDiscardableSides(true);
  const ids: string[] = [];
  for (const side of sides) {
    ids.push(...(await beginSideDiscard(side.id)));
  }
  if (!ids.length) {
    return;
  }
  const client = await DBOSClient.create({
    systemDatabaseUrl: process.env.DATABASE_URL!,
    applicationName: "chum-bucket-chat",
  });
  try {
    for (const id of ids) {
      await client.cancelWorkflow(id);
      priorProcessQuiet.add(id);
    }
  } finally {
    await client.destroy();
  }
}

export async function reconcileRuns() {
  const pending = await listPendingRuns();
  for (const run of pending) {
    if (![BUILD, PREVIOUS_BUILD].includes(run.accepted.build) || run.accepted.model !== MODEL) {
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
    applicationVersion: PREVIOUS_BUILD,
    systemDatabaseUrl: process.env.DATABASE_URL,
  });
  try {
    await abandonPriorProcessSides();
    await DBOS.launch();
    for (const side of await listDiscardableSides(true)) {
      await discardSideChat(side.id);
    }
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
        for (const side of await listDiscardableSides()) {
          await discardSideChat(side.id);
        }
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
  for (const side of await listDiscardableSides(true)) {
    await discardSideChat(side.id);
  }
  await DBOS.shutdown();
  const db = await database();
  await db.$client.end();
}
