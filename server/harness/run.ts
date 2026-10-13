import { setTimeout as delay } from "node:timers/promises";
import { DBOS } from "@dbos-inc/dbos-sdk";
import { runAgentLoop, type AgentCheckpoint, type AgentSession } from "./agent-loop";
import { withRunTools, type RunTools } from "./tools";
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

export async function executeRun(run: AcceptedRun) {
  if (run.build !== BUILD || run.model !== MODEL) {
    throw new Error("Incompatible run build");
  }

  return withRunTools(async (tools) => {
    const result = await runAgentLoop({
      session: runSession(run, tools),
      messages: run.messages,
      model: run.model,
      prompt: run.prompt,
      checkpoint: runCheckpoint,
    });

    if (result.state === "limit") {
      throw new Error("Model iteration limit exceeded");
    }

    await DBOS.runStep(() => finishRun(run.runId, result.messages), { name: "finish" });
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
