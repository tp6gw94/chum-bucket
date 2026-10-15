import { setTimeout as delay } from "node:timers/promises";
import { DBOS } from "@dbos-inc/dbos-sdk";
import type { UIMessage } from "@tanstack/ai";
import type { CompactionTrigger } from "../../shared/compaction-event";
import { agentAccess, MODEL } from "./agents";
import {
  runAgentLoop,
  type AgentCheckpoint,
  type AgentCompact,
  type AgentOrchestration,
  type AgentSession,
} from "./agent-loop";
import {
  compactConversation,
  estimateContextTokens,
  seedSideChat,
  type CompactionResult,
} from "./compaction";
import { conversationFromProjection, type ConversationState } from "./conversation";
import type { ChatStream } from "./model-turn";
import { withRunTools, type RunTools } from "./tools";
import { delegateTaskToolName } from "./tools/delegate-task";
import { delegateTask, DelegationRejected } from "./testing-run";
import { reconcileTestingOperations, registerTestingQueue } from "./testing-child";
import {
  BUILD,
  RunRequestError,
  database,
  persistRun,
  emit,
  finishRun,
  listPendingRuns,
  recordCompaction,
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

function providerChatStream(run: AcceptedRun): ChatStream {
  return async (options) => {
    const { deepinfra } = await import("./provider");

    return deepinfra(run.model).chatStream(options);
  };
}

function runSession(run: AcceptedRun, tools: RunTools): AgentSession {
  return { runId: run.runId, emit, chatStream: providerChatStream(run), tools };
}

const runCheckpoint: AgentCheckpoint = ({ name, retry, work }) =>
  retry ? DBOS.runStep(work, { name, ...retry }) : DBOS.runStep(work, { name });

async function compactionStep(
  run: AcceptedRun,
  input: {
    name: string;
    trigger: CompactionTrigger;
    source: readonly UIMessage[];
    work: (summaryId: string) => Promise<CompactionResult>;
  },
): Promise<CompactionResult> {
  const result = await DBOS.runStep(
    async () => {
      await recordCompaction(run.runId, {
        phase: "started",
        trigger: input.trigger,
        tokensBefore: estimateContextTokens(input.source),
      });

      return input.work(`summary:${run.runId}:${input.name}`);
    },
    { name: input.name },
  );
  await DBOS.runStep(
    () =>
      recordCompaction(
        run.runId,
        result.event,
        result.status === "done" ? result.conversation : undefined,
      ),
    { name: `${input.name}:record` },
  );

  return result;
}

function runCompaction(run: AcceptedRun): AgentCompact {
  const chatStream = providerChatStream(run);

  return ({ conversation, trigger, name }) =>
    compactionStep(run, {
      name,
      trigger,
      source: conversation.context,
      work: (summaryId) =>
        compactConversation({ conversation, trigger, summaryId, model: run.model, chatStream }),
    });
}

async function executeCompactRun(run: Extract<AcceptedRun, { kind: "compact" }>) {
  const conversation = conversationFromProjection(run);
  const chatStream = providerChatStream(run);
  const result = await compactionStep(run, {
    name: "compact:manual",
    trigger: "manual",
    source: conversation.context,
    work: (summaryId) =>
      compactConversation({
        conversation,
        trigger: "manual",
        summaryId,
        model: run.model,
        chatStream,
        instructions: run.instructions,
      }),
  });

  if (result.status === "failed") {
    throw new Error(`Compaction failed: ${result.event.error}`);
  }

  const next = result.status === "done" ? result.conversation : conversation;
  await DBOS.runStep(() => finishRun(run.runId, next), { name: "finish" });
}

async function seededConversation(run: AcceptedRun): Promise<ConversationState> {
  const conversation = conversationFromProjection(run);
  const parentContext = run.parentContext;

  if (!parentContext) {
    return conversation;
  }

  const chatStream = providerChatStream(run);
  const result = await compactionStep(run, {
    name: "side-chat:seed",
    trigger: "side-chat",
    source: parentContext,
    work: (summaryId) =>
      seedSideChat({ conversation, parentContext, summaryId, model: run.model, chatStream }),
  });

  if (result.status === "failed") {
    throw new Error(`Side chat summary failed: ${result.event.error}`);
  }

  return result.status === "done" ? result.conversation : conversation;
}

function testingOrchestration(run: AcceptedRun): AgentOrchestration | undefined {
  if (run.agent !== "main") {
    return undefined;
  }

  return async (call) => {
    if (call.name !== delegateTaskToolName) {
      return { state: "unhandled" };
    }

    try {
      return { state: "handled", output: await delegateTask(run, call) };
    } catch (failure) {
      const message =
        failure instanceof Error ? failure.message.slice(0, 2_000) : "Delegation failed";
      const decisions = failure instanceof DelegationRejected ? failure.decisions : undefined;

      return {
        state: "handled",
        output: decisions ? { error: message, decisions } : { error: message },
        error: true,
      };
    }
  };
}

export async function executeRun(run: AcceptedRun) {
  if (run.build !== BUILD || run.model !== MODEL) {
    throw new Error("Incompatible run build");
  }

  if ("kind" in run) {
    return executeCompactRun(run);
  }

  const conversation = await seededConversation(run);
  const orchestration = testingOrchestration(run);

  return withRunTools(agentAccess(run.agent), async (tools) => {
    const result = await runAgentLoop({
      session: runSession(run, tools),
      conversation,
      model: run.model,
      prompt: run.prompt,
      checkpoint: runCheckpoint,
      compact: runCompaction(run),
      ...(orchestration ? { orchestration } : {}),
    });

    if (result.outcome === "limit") {
      throw new Error("Model iteration limit exceeded");
    }

    await DBOS.runStep(() => finishRun(run.runId, result.conversation), { name: "finish" });
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
    await registerTestingQueue();
    await reconcileRuns();
    await reconcileTestingOperations();
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
        await reconcileTestingOperations();
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
