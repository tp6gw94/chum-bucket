import { setTimeout as delay } from "node:timers/promises";
import { DBOS, DBOSClient } from "@dbos-inc/dbos-sdk";
import { runAgentLoop, type AgentCheckpoint, type AgentSession } from "./agent-loop";
import { ContextOverflowError } from "./model-turn";
import { prepareCompaction, publishCompaction } from "./compaction";
import type { ConversationState } from "./conversation";
import { withRunTools, type RunTools } from "./tools";
import {
  BUILD,
  MODEL,
  RunRequestError,
  assertExecution,
  beginSideDiscard,
  database,
  emit,
  finishRun,
  listPendingRuns,
  listSideChats,
  persistRun,
  purgeSideChat,
  type AcceptedRun,
  type RunInput,
} from "./run-store";

export async function acceptRun(value: RunInput): Promise<AcceptedRun> {
  const accepted = await persistRun(value);

  if (accepted.pending) {
    await ensureStarted(accepted.run);
  }

  return accepted.run;
}

function runSession(run: AcceptedRun, tools: RunTools): AgentSession {
  return {
    runId: run.runId,
    assertExecution: () => assertExecution(run),
    emit,
    chatStream: async (options) => {
      const { deepinfra } = await import("./provider");

      return deepinfra(run.model).chatStream(options);
    },
    tools,
  };
}

const runCheckpoint: AgentCheckpoint = ({ name, retry, shouldRetry, work }) =>
  retry ? DBOS.runStep(work, { name, ...retry, shouldRetry }) : DBOS.runStep(work, { name });

async function compactConversation(
  run: AcceptedRun,
  conversation: ConversationState,
  tools: RunTools,
  turn: number,
  reason: "threshold" | "overflow" | "manual",
  signal: AbortSignal,
) {
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
        tools,
        emit: (event) => emit(run.runId, event),
        reason,
        signal,
      }),
    { name: `${name}:${turn}` },
  );
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

async function finishCompactRun(
  run: AcceptedRun,
  conversation: ConversationState,
  tools: RunTools,
  signal: AbortSignal,
) {
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
}

async function finishChatRun(
  run: AcceptedRun,
  conversation: ConversationState,
  tools: RunTools,
  signal: AbortSignal,
) {
  const result = await runAgentLoop({
    session: runSession(run, tools),
    conversation,
    model: run.model,
    prompt: run.prompt,
    checkpoint: runCheckpoint,
    signal,
    compact: async ({ conversation: current, reason, turn }) =>
      (await compactConversation(run, current, tools, turn, reason, signal)).conversation,
  });

  if (result.state === "limit") {
    throw new Error("Model iteration limit exceeded");
  }

  await DBOS.runStep(() => finishRun(run.runId, result.conversation), { name: "finish" });
}

type Execution = { controller: AbortController; quiet?: Promise<void> };
const executions = new Map<string, Execution>();
const priorProcessRuns = new Set<string>();

export async function executeRun(run: AcceptedRun) {
  if (run.build !== BUILD || run.model !== MODEL) {
    throw new Error("Incompatible run build");
  }

  const signal = executions.get(run.runId)?.controller.signal ?? new AbortController().signal;
  const conversation: ConversationState = { display: run.messages, context: run.context };

  return withRunTools((tools) =>
    run.kind === "compact"
      ? finishCompactRun(run, conversation, tools, signal)
      : finishChatRun(run, conversation, tools, signal),
  );
}

const workflow = DBOS.registerWorkflow(executeRun, { name: BUILD });

export async function ensureStarted(run: AcceptedRun) {
  if (run.build !== BUILD || run.model !== MODEL) {
    throw new RunRequestError(409, "Incompatible run build");
  }

  if (executions.has(run.runId)) {
    return;
  }

  const execution: Execution = { controller: new AbortController() };
  executions.set(run.runId, execution);

  try {
    if (await DBOS.getWorkflowStatus(run.runId)) {
      executions.delete(run.runId);

      return;
    }

    const handle = await DBOS.startWorkflow(workflow, { workflowID: run.runId })(run);
    execution.quiet = handle.getResult().then(
      () => undefined,
      () => undefined,
    );
  } catch (error) {
    executions.delete(run.runId);
    throw error;
  }

  if (!run.side) {
    void execution.quiet.finally(() => executions.delete(run.runId));
  }
}

const summaries = new Map<string, Set<AbortController>>();

export async function trackSideSummary<T>(
  id: string,
  use: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const active = summaries.get(id) ?? new Set();
  summaries.set(id, active.add(controller));

  try {
    return await use(controller.signal);
  } finally {
    active.delete(controller);
  }
}

async function stopRun(runId: string) {
  const execution = executions.get(runId);
  execution?.controller.abort();
  const status = await DBOS.getWorkflowStatus(runId);

  if (status) {
    await DBOS.cancelWorkflow(runId);
  }

  if (execution?.quiet) {
    await execution.quiet;
  } else if (status && !priorProcessRuns.has(runId)) {
    throw new Error("Cannot prove the side chat workflow stopped");
  }

  if (status) {
    await DBOS.deleteWorkflow(runId);
  }

  executions.delete(runId);
  priorProcessRuns.delete(runId);
}

const discards = new Map<string, Promise<void>>();

export async function discardSideChat(id: string) {
  const runIds = await beginSideDiscard(id);
  const prior = discards.get(id);

  if (prior) {
    return prior;
  }

  const work = (async () => {
    for (const controller of summaries.get(id) ?? []) {
      controller.abort();
    }

    for (const runId of runIds) {
      await stopRun(runId);
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

async function cancelPriorProcessSides() {
  const runIds: string[] = [];

  for (const side of await listSideChats()) {
    runIds.push(...(await beginSideDiscard(side.id)));
  }

  if (!runIds.length) {
    return;
  }

  const client = await DBOSClient.create({
    systemDatabaseUrl: process.env.DATABASE_URL!,
    applicationName: "chum-bucket-chat",
  });

  try {
    for (const runId of runIds) {
      await client.cancelWorkflow(runId);
      priorProcessRuns.add(runId);
    }
  } finally {
    await client.destroy();
  }
}

async function discardSideChats(state?: "closing") {
  for (const side of await listSideChats(state)) {
    await discardSideChat(side.id);
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
    await cancelPriorProcessSides();
    await DBOS.launch();
    await discardSideChats();
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
        await discardSideChats("closing");
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
  await discardSideChats();
  await DBOS.shutdown();
  const db = await database();
  await db.$client.end();
}
