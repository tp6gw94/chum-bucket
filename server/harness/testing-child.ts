import { setTimeout as delay } from "node:timers/promises";
import { DBOS } from "@dbos-inc/dbos-sdk";
import type { UIMessage } from "@tanstack/ai";
import type { RoleFailureCode } from "../../shared/testing";
import { jiraCommentToolName } from "../../shared/tool-approval";
import { agentRegistry, roleSystemPrompt, type MODEL } from "./agents";
import {
  runAgentLoop,
  type AgentCheckpoint,
  type AgentOrchestration,
  type AgentSession,
} from "./agent-loop";
import type { ConversationState } from "./conversation";
import type { ChatStream } from "./model-turn";
import { roleFeedbackPrompt, roleFinalTurnPrompt, roleTaskPrompt } from "./prompts";
import { wakeToolApprovals } from "./run-store";
import { gateToolApproval } from "./tool-approval";
import {
  clipIssues,
  evaluateRole,
  failureCodeFor,
  MAX_FAILURE_ISSUE_CHARS,
  MAX_FAILURE_ISSUES,
  MAX_FEEDBACK_ISSUE_CHARS,
  MAX_FEEDBACK_ISSUES,
  TESTING_WORKFLOW_VERSION,
  type Evaluation,
} from "./testing-domain";
import {
  cancellationRequested,
  claimTask,
  ensureCancelDeliveries,
  guardActualIO,
  loadOperation,
  markTaskStopped,
  openOperations,
  publishOperation,
  taskReceipts,
  type ClaimedTask,
  type DeniedReason,
  type TestingChildInput,
} from "./testing-store";
import { withRoleTools } from "./testing-tools";

export const TESTING_QUEUE = "testing-delegation";
const CANCEL_POLL_MS = 200;
const BROWSER_TOOL_TIMEOUT_MS = 150_000;
const FEEDBACK_TURNS = 2;

export type ChildResult =
  | { state: "ready"; finalText: string | null }
  | { state: "failed"; reason: RoleFailureCode; issues: string[] }
  | { state: "denied"; reason: DeniedReason };

class RoleDenied extends Error {
  constructor(readonly reason: DeniedReason) {
    super(`Denied: ${reason}`);
  }
}

const deniedFailures: Record<DeniedReason, RoleFailureCode> = {
  cancel_requested: "cancelled",
  deadline: "deadline",
  budget: "budget",
  terminal: "denied",
  nonce: "denied",
};

type StepResult<T> = { state: "ok"; value: T } | { state: "denied"; reason: DeniedReason };
type Retry = Parameters<AgentCheckpoint>[0]["retry"];

function retryDelay(retry: Retry, attempt: number): number {
  return (retry?.intervalSeconds ?? 1) * 1000 * (retry?.backoffRate ?? 2) ** (attempt - 1);
}

async function modelDenied(input: TestingChildInput, name: string, step: string) {
  if (!name.startsWith("model:")) {
    return undefined;
  }

  const guard = await guardActualIO({ ...input, kind: "model", step });

  return guard.state === "denied" ? guard : undefined;
}

async function attemptStep<T>(options: {
  input: TestingChildInput;
  name: string;
  step: string;
  retry: Retry;
  signal: AbortSignal;
  work: () => Promise<T>;
}): Promise<StepResult<T>> {
  const attempts = options.retry?.retriesAllowed ? options.retry.maxAttempts : 1;

  for (let attempt = 1; ; attempt += 1) {
    const denied = await modelDenied(options.input, options.name, options.step);

    if (denied) {
      return denied;
    }

    try {
      return { state: "ok", value: await options.work() };
    } catch (error) {
      if (options.signal.aborted || attempt >= attempts) {
        throw error;
      }

      await delay(retryDelay(options.retry, attempt));
    }
  }
}

function roleCheckpoint(
  input: TestingChildInput,
  prefix: string,
  signal: AbortSignal,
): AgentCheckpoint {
  return async ({ name, retry, work }) => {
    const step = `${prefix}${name}`;
    const result = await DBOS.runStep(
      () => attemptStep({ input, name, step, retry, signal, work }),
      {
        name: step,
      },
    );

    if (result.state === "denied") {
      throw new RoleDenied(result.reason);
    }

    return result.value;
  };
}

function chatStreamFor(model: typeof MODEL): ChatStream {
  return async (options) => {
    const { deepinfra } = await import("./provider");

    return deepinfra(model).chatStream(options);
  };
}

function userMessage(id: string, content: string): UIMessage {
  return { id, role: "user", parts: [{ type: "text", content }] };
}

function finalText(conversation: ConversationState): string | null {
  const last = conversation.display.findLast((message) => message.role === "assistant");
  const text = (last?.parts ?? [])
    .flatMap((part) => (part.type === "text" ? [part.content] : []))
    .join("")
    .trim();

  return text || null;
}

function approvalOrchestration(input: TestingChildInput): AgentOrchestration | undefined {
  if (input.role !== "atlassian") {
    return undefined;
  }

  let proposals = 0;

  return async (call) =>
    call.name === jiraCommentToolName
      ? gateToolApproval(input, call, proposals++)
      : { state: "unhandled" };
}

async function evaluateCompletion(
  input: TestingChildInput,
  task: ClaimedTask,
  conversation: ConversationState,
): Promise<Evaluation<unknown>> {
  const evaluation = evaluateRole(task.context, {
    finalText: finalText(conversation),
    receipts: await taskReceipts(input.taskId),
  });

  return evaluation.ok ? { ok: true, value: null } : evaluation;
}

async function runRole(
  input: TestingChildInput,
  task: ClaimedTask,
  signal: AbortSignal,
): Promise<ChildResult> {
  const definition = agentRegistry[input.role];
  const prompt = roleSystemPrompt(input.role, task.runtime.profile);
  const browser = input.role === "ac" || input.role === "ui";
  const finalPrompt = roleFinalTurnPrompt(input.role);
  const orchestration = approvalOrchestration(input);
  const orchestrated = orchestration ? { orchestration } : {};

  return withRoleTools({ child: input, context: task.context }, async (tools) => {
    const session: AgentSession = {
      runId: input.childWorkflowId,
      emit: async () => undefined,
      chatStream: chatStreamFor(definition.model),
      tools,
      signal,
      ...(browser ? { toolTimeoutMs: BROWSER_TOOL_TIMEOUT_MS } : {}),
    };
    const seed = userMessage(`${input.taskId}:task`, roleTaskPrompt(input.role, task.taskInput));
    const first = await runAgentLoop({
      session,
      conversation: { display: [seed], context: [seed] },
      model: definition.model,
      prompt,
      checkpoint: roleCheckpoint(input, "a:", signal),
      bounded: { maxTurn: task.runtime.limits.maxTurns - FEEDBACK_TURNS, finalPrompt },
      ...orchestrated,
    });
    const proposal = await DBOS.runStep(() => evaluateCompletion(input, task, first.conversation), {
      name: "proposal",
    });

    if (proposal.ok) {
      return { state: "ready", finalText: finalText(first.conversation) };
    }

    const feedback = userMessage(
      `${input.taskId}:feedback`,
      roleFeedbackPrompt(
        clipIssues(proposal.issues, MAX_FEEDBACK_ISSUES, MAX_FEEDBACK_ISSUE_CHARS),
      ),
    );
    const second = await runAgentLoop({
      session,
      conversation: {
        display: [...first.conversation.display, feedback],
        context: [...first.conversation.context, feedback],
      },
      model: definition.model,
      prompt,
      checkpoint: roleCheckpoint(input, "b:", signal),
      bounded: { maxTurn: FEEDBACK_TURNS, finalPrompt },
      ...orchestrated,
    });
    const retried = await DBOS.runStep(() => evaluateCompletion(input, task, second.conversation), {
      name: "proposal-2",
    });

    return retried.ok
      ? { state: "ready", finalText: finalText(second.conversation) }
      : {
          state: "failed",
          reason: failureCodeFor(input.role),
          issues: clipIssues(retried.issues, MAX_FAILURE_ISSUES, MAX_FAILURE_ISSUE_CHARS),
        };
  });
}

function watchTask(taskId: string, deadline: string, controller: AbortController) {
  const deadlineTimer = setTimeout(
    () => controller.abort("deadline"),
    Math.max(new Date(deadline).getTime() - Date.now(), 0),
  );
  const poll = setInterval(() => {
    void cancellationRequested(taskId)
      .then((requested) => {
        if (requested) {
          controller.abort("cancelled");
        }
      })
      .catch(() => undefined);
  }, CANCEL_POLL_MS);

  return () => {
    clearTimeout(deadlineTimer);
    clearInterval(poll);
  };
}

async function classifyFailure(
  input: TestingChildInput,
  message: string,
  denied?: DeniedReason,
): Promise<ChildResult> {
  const operation = await loadOperation(input.operationId);

  if (operation.cancel_accepted_at) {
    return { state: "failed", reason: "cancelled", issues: [] };
  }

  if (operation.deadline.getTime() <= Date.now()) {
    return { state: "failed", reason: "deadline", issues: [] };
  }

  if (denied) {
    return { state: "failed", reason: deniedFailures[denied], issues: [] };
  }

  return {
    state: "failed",
    reason: "child_failed",
    issues: clipIssues([message], MAX_FAILURE_ISSUES, MAX_FAILURE_ISSUE_CHARS),
  };
}

async function executeTestingChild(input: TestingChildInput): Promise<ChildResult> {
  const claim = await DBOS.runStep(() => claimTask(input), { name: "claim" });

  if (claim.state === "denied") {
    await DBOS.runStep(() => markTaskStopped(input.taskId), { name: "stopped" });

    return claim;
  }

  const controller = new AbortController();
  const stopWatching = watchTask(input.taskId, claim.task.deadline, controller);

  try {
    return await runRole(input, claim.task, controller.signal);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const denied = error instanceof RoleDenied ? error.reason : undefined;

    return await DBOS.runStep(() => classifyFailure(input, message, denied), { name: "failure" });
  } finally {
    stopWatching();
    await DBOS.runStep(() => markTaskStopped(input.taskId), { name: "stopped" });
  }
}

export const testingChildWorkflow = DBOS.registerWorkflow(executeTestingChild, {
  name: TESTING_WORKFLOW_VERSION,
});

export async function registerTestingQueue() {
  await DBOS.registerQueue(TESTING_QUEUE, { workerConcurrency: 2 });
}

export async function reconcileTestingOperations() {
  for (const operation of await openOperations()) {
    if (operation.cancelled) {
      await ensureCancelDeliveries(operation.id);
      await wakeToolApprovals(operation.id);
    }

    await publishOperation(operation.id);
  }
}
