import { setTimeout as delay } from "node:timers/promises";
import { DBOS } from "@dbos-inc/dbos-sdk";
import type { StreamChunk } from "@tanstack/ai";
import { compactionEvent, type CompactionReason } from "../../shared/compaction-event";
import {
  runAgentLoop,
  type AgentCheckpoint,
  type AgentCompact,
  type AgentSession,
} from "./agent-loop";
import { prepareCompaction, publishCompaction, readCompactionPolicy } from "./compaction";
import { modelChatStream } from "./model-turn";
import type { ConversationState } from "./conversation";
import { withRunTools, type RunTools } from "./tools";
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

export async function acceptRun(value: RunInput): Promise<AcceptedRun> {
  const accepted = await persistRun(value);

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
        summary: { chatStream: modelChatStream, model: run.model },
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

async function finishChatRun(run: AcceptedRun, tools: RunTools) {
  const compact: AgentCompact = (input) => compactConversation(run, tools, input);
  const result = await runAgentLoop({
    session: runSession(run, tools),
    conversation: run.conversation,
    model: run.model,
    prompt: run.prompt,
    checkpoint: runCheckpoint,
    compact,
  });

  if (result.state === "limit") {
    throw new Error("Model iteration limit exceeded");
  }

  await DBOS.runStep(() => finishRun(run.runId, result.conversation), { name: "finish" });
}

async function finishCompactRun(run: AcceptedRun, tools: RunTools) {
  const result = await compactConversation(run, tools, {
    conversation: run.conversation,
    reason: "manual",
    turn: 0,
  });
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

  return withRunTools((tools) =>
    "kind" in run ? finishCompactRun(run, tools) : finishChatRun(run, tools),
  );
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
  readCompactionPolicy(process.env);
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
