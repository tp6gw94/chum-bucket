import { setTimeout as delay } from "node:timers/promises";
import { DBOS } from "@dbos-inc/dbos-sdk";
import { runAgentLoop, type AgentCheckpoint, type AgentSession } from "./agent-loop";
import {
  applyCompaction,
  compactor,
  COMPACTION_POLICY,
  type CompactionPublish,
} from "./compaction";
import type { ConversationState } from "./conversation";
import { withRunTools, type RunTools } from "./tools";
import {
  BUILD,
  MODEL,
  RunRequestError,
  database,
  persistRun,
  emit,
  finishRun,
  checkpointCompaction,
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
  return {
    runId: run.runId,
    emit,
    chatStream: async (options) => {
      const { deepinfra } = await import("./provider");

      return deepinfra(run.model).chatStream(options);
    },
    tools,
  };
}

const runCheckpoint: AgentCheckpoint = ({ name, retry, work }) =>
  retry ? DBOS.runStep(work, { name, ...retry }) : DBOS.runStep(work, { name });

function publishCompaction(runId: string): CompactionPublish {
  return async ({ operationId, outcome, conversation }) => {
    const next = applyCompaction(conversation, outcome);
    await checkpointCompaction(runId, operationId, next, outcome.state);

    return next;
  };
}

function runCompactor(run: AcceptedRun, session: AgentSession) {
  return compactor({
    session,
    model: run.model,
    prompt: run.prompt,
    policy: COMPACTION_POLICY,
    checkpoint: runCheckpoint,
    publish: publishCompaction(run.runId),
  });
}

async function finishCompactRun(
  run: AcceptedRun,
  session: AgentSession,
  conversation: ConversationState,
) {
  const result = await runCompactor(run, session)({ conversation, reason: "manual", turn: 0 });

  await DBOS.runStep(
    () =>
      result.state === "failed"
        ? finishRun(run.runId, undefined, "compaction_failed")
        : finishRun(run.runId, result.conversation),
    { name: "finish" },
  );
}

async function finishChatRun(
  run: AcceptedRun,
  session: AgentSession,
  conversation: ConversationState,
) {
  const result = await runAgentLoop({
    session,
    conversation,
    model: run.model,
    prompt: run.prompt,
    checkpoint: runCheckpoint,
    compact: runCompactor(run, session),
  });

  if (result.state === "limit") {
    throw new Error("Model iteration limit exceeded");
  }

  await DBOS.runStep(() => finishRun(run.runId, result.conversation), { name: "finish" });
}

export async function executeRun(run: AcceptedRun) {
  if (run.build !== BUILD || run.model !== MODEL) {
    throw new Error("Incompatible run build");
  }

  return withRunTools(async (tools) => {
    const session = runSession(run, tools);
    const conversation = { display: run.messages, context: run.context };

    if ("kind" in run) {
      await finishCompactRun(run, session, conversation);
    } else {
      await finishChatRun(run, session, conversation);
    }
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
