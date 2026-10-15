import { setTimeout as delay } from "node:timers/promises";
import { DBOS, DBOSClient } from "@dbos-inc/dbos-sdk";
import type { StreamChunk } from "@tanstack/ai";
import { compactionEvent, type CompactionReason } from "../../shared/compaction-event";
import {
  runAgentLoop,
  type AgentCheckpoint,
  type AgentCompact,
  type AgentOrchestration,
  type AgentSession,
} from "./agent-loop";
import { delegateBrowserTask } from "./browser-agent";
import { prepareCompaction, publishCompaction, readCompactionPolicy } from "./compaction";
import { modelChatStream } from "./model-turn";
import type { ConversationState } from "./conversation";
import { withRunTools, type RunTools } from "./tools";
import { DELEGATE_TASK_TOOL, withDelegation } from "./tools/delegate-task";
import {
  BUILD,
  MODEL,
  RunRequestError,
  checkpointCompaction,
  database,
  persistRun,
  emit,
  finishRun,
  listPendingRuns,
  type RunInput,
  type AcceptedRun,
} from "./run-store";
import {
  assertSideChatOpen,
  cancelSideChatSummary,
  deleteSideChat,
  listSideChatIds,
  markAllSideChatsClosing,
  markSideChatClosing,
  sideChatAdmission,
  sideChatRunIds,
} from "./side-chat-store";

const executing = new Map<string, { controller: AbortController; done: Promise<unknown> }>();

export async function acceptRun(value: RunInput): Promise<AcceptedRun> {
  const accepted = await persistRun(value, sideChatAdmission);

  if (accepted.pending) {
    await ensureStarted(accepted.run);
  }

  return accepted.run;
}

function runSession(run: AcceptedRun, tools: RunTools): AgentSession {
  return { runId: run.runId, emit, chatStream: modelChatStream, tools };
}

const runCheckpoint: AgentCheckpoint = ({ name, retry, work }) =>
  retry ? DBOS.runStep(work, { name, ...retry }) : DBOS.runStep(work, { name });

async function compactConversation(
  run: AcceptedRun,
  tools: RunTools,
  input: { conversation: ConversationState; reason: CompactionReason; turn: number },
  signal: AbortSignal,
) {
  const prefix = input.reason === "overflow" ? "compact-overflow" : "compact";
  const operationId = `${run.runId}/${prefix}/${input.turn}`;
  const outcome = await DBOS.runStep(
    () =>
      prepareCompaction({
        runId: run.runId,
        operationId,
        reason: input.reason,
        messages: input.conversation.context,
        prompt: run.prompt,
        policy: readCompactionPolicy(process.env),
        tools,
        summary: { chatStream: modelChatStream, model: run.model, signal },
        started: () =>
          emit(
            run.runId,
            compactionEvent({
              runId: run.runId,
              operationId,
              state: "started",
              reason: input.reason,
            }) as StreamChunk,
          ),
      }),
    { name: `${prefix}:${input.turn}` },
  );

  if (outcome.state === "skipped" && input.reason !== "manual") {
    return { state: outcome.state, conversation: input.conversation };
  }

  const conversation = await DBOS.runStep(
    () =>
      publishCompaction({
        runId: run.runId,
        operationId,
        reason: input.reason,
        outcome,
        conversation: input.conversation,
        checkpoint: checkpointCompaction,
      }),
    { name: `publish-${prefix}:${input.turn}` },
  );

  return { state: outcome.state, conversation };
}

function executionGuard(run: AcceptedRun) {
  return run.sideChat ? () => assertSideChatOpen(run.threadId) : undefined;
}

async function finishChatRun(run: AcceptedRun, baseTools: RunTools, signal: AbortSignal) {
  const tools = run.sideChat ? baseTools : withDelegation(baseTools);
  const compact: AgentCompact = (input) => compactConversation(run, tools, input, signal);
  const assertExecution = executionGuard(run);
  const orchestrate: AgentOrchestration | undefined = run.sideChat
    ? undefined
    : async (call, step) =>
        call.name === DELEGATE_TASK_TOOL
          ? delegateBrowserTask(run.runId, run.model, call, step)
          : undefined;
  const result = await runAgentLoop({
    session: runSession(run, tools),
    conversation: run.conversation,
    model: run.model,
    prompt: run.prompt,
    checkpoint: runCheckpoint,
    compact,
    orchestrate,
    signal,
    assertExecution,
  });

  if (result.state === "limit") {
    throw new Error("Model iteration limit exceeded");
  }

  await assertExecution?.();
  await DBOS.runStep(() => finishRun(run.runId, result.conversation), { name: "finish" });
}

async function finishCompactRun(run: AcceptedRun, tools: RunTools, signal: AbortSignal) {
  const result = await compactConversation(
    run,
    tools,
    { conversation: run.conversation, reason: "manual", turn: 0 },
    signal,
  );
  await DBOS.runStep(
    () =>
      result.state === "failed"
        ? finishRun(run.runId, undefined, "compaction_failed")
        : finishRun(run.runId, result.conversation),
    { name: "finish" },
  );
}

export async function executeRun(run: AcceptedRun) {
  if (run.build !== BUILD || run.model !== MODEL) {
    throw new Error("Incompatible run build");
  }

  const controller = new AbortController();
  const done = withRunTools((tools) =>
    "kind" in run
      ? finishCompactRun(run, tools, controller.signal)
      : finishChatRun(run, tools, controller.signal),
  );
  executing.set(run.runId, { controller, done });

  try {
    return await done;
  } finally {
    executing.delete(run.runId);
  }
}

async function stopRun(runId: string) {
  const active = executing.get(runId);
  active?.controller.abort();
  await DBOS.cancelWorkflow(runId).catch(() => undefined);
  await active?.done.catch(() => undefined);
}

export async function discardSideChat(id: string) {
  await markSideChatClosing(id);
  cancelSideChatSummary(id);

  for (const runId of await sideChatRunIds([id])) {
    await stopRun(runId);
  }

  await deleteSideChat(id);
}

async function cancelBeforeLaunch() {
  const runIds = await sideChatRunIds(await markAllSideChatsClosing());

  if (runIds.length === 0) {
    return;
  }

  const client = await DBOSClient.create({ systemDatabaseUrl: process.env.DATABASE_URL! });

  try {
    for (const runId of runIds) {
      await client.cancelWorkflow(runId).catch(() => undefined);
    }
  } finally {
    await client.destroy();
  }
}

async function closeAllSideChats(phase: "before-launch" | "after-launch" | "shutdown") {
  if (phase === "before-launch") {
    await cancelBeforeLaunch();

    return;
  }

  for (const id of await listSideChatIds()) {
    await discardSideChat(id);
  }
}

const workflow = DBOS.registerWorkflow(executeRun, { name: BUILD });

export async function ensureStarted(run: AcceptedRun) {
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
  readCompactionPolicy(process.env);
  DBOS.setConfig({
    name: "chum-bucket-chat",
    applicationVersion: BUILD,
    systemDatabaseUrl: process.env.DATABASE_URL,
  });

  try {
    await closeAllSideChats("before-launch");
    await DBOS.launch();
    await closeAllSideChats("after-launch");
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
  await closeAllSideChats("shutdown").catch((error: unknown) => {
    console.error("Side chat cleanup failed", error);
  });
  await DBOS.shutdown();
  const db = await database();
  await db.$client.end();
}
