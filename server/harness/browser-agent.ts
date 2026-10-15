import { createHash } from "node:crypto";
import { join } from "node:path";
import { DBOS, Error as DBOSErrors } from "@dbos-inc/dbos-sdk";
import type { UIMessage } from "@tanstack/ai";
import { z } from "zod";
import { runAgentLoop, type AgentCheckpoint, type AgentLoopResult } from "./agent-loop";
import type { ConversationState } from "./conversation";
import { jevConfigured } from "./jev-client";
import { modelChatStream, type ModelCall } from "./model-turn";
import { browserAgentSystemPrompt } from "./prompts";
import { browserObservations, createBrowserTools } from "./tools/browser";
import { delegationInputSchema, type DelegationInput } from "./tools/delegate-task";

const BROWSER_AGENT_WORKFLOW = "browser-agent-v1";

const DEADLINE_MS = 10 * 60_000;

class DeadlineError extends Error {
  constructor() {
    super("The browser agent passed its 10 minute deadline");
  }
}

type BrowserAgentInput = Readonly<{
  childId: string;
  model: string;
  task: DelegationInput;
}>;

type BrowserAgentResult =
  | { state: "completed"; report: string; observations: unknown[] }
  | {
      state: "failed";
      reason: "turn_limit" | "deadline" | "error" | "child_failed";
      message: string;
      observations: unknown[];
    };

function conversationOf(value: unknown): ConversationState | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  if ("context" in value && "display" in value) {
    return value as ConversationState;
  }

  return "conversation" in value ? conversationOf(value.conversation) : undefined;
}

function guardedCheckpoint(
  deadline: number,
  record: (conversation: ConversationState) => void,
): AgentCheckpoint {
  return async ({ name, retry, work }) => {
    const expired = await DBOS.runStep(async () => Date.now() > deadline, {
      name: `${name}:deadline`,
    });

    if (expired) {
      throw new DeadlineError();
    }

    const result = await (retry
      ? DBOS.runStep(work, { name, ...retry })
      : DBOS.runStep(work, { name }));
    const conversation = conversationOf(result);

    if (conversation) {
      record(conversation);
    }

    return result;
  };
}

function taskMessage(task: DelegationInput): UIMessage {
  return {
    id: "browser-task",
    role: "user",
    parts: [{ type: "text", content: `browser-task:\n${JSON.stringify(task)}` }],
  };
}

function finalReport(messages: readonly UIMessage[]): string {
  const last = messages.at(-1);

  if (last?.role !== "assistant") {
    return "";
  }

  return last.parts
    .flatMap((part) => (part.type === "text" ? [part.content] : []))
    .join("")
    .trim();
}

function settle(result: AgentLoopResult): BrowserAgentResult {
  const observations = browserObservations(result.conversation.context);

  if (result.state === "limit") {
    return {
      state: "failed",
      reason: "turn_limit",
      message: "The browser agent ran out of turns before reporting",
      observations,
    };
  }

  const report = finalReport(result.conversation.context);

  return report
    ? { state: "completed", report, observations }
    : {
        state: "failed",
        reason: "error",
        message: "The browser agent gave no report",
        observations,
      };
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message.slice(0, 2000) : fallback;
}

async function executeBrowserAgent(input: BrowserAgentInput): Promise<BrowserAgentResult> {
  const deadline = await DBOS.runStep(async () => Date.now() + DEADLINE_MS, { name: "deadline" });
  const signal = AbortSignal.timeout(Math.max(0, deadline - Date.now()));
  const browser = createBrowserTools({
    targetUrl: input.task.targetUrl,
    evidenceDir: join(process.cwd(), ".data/browser-evidence", input.childId),
    executionId: input.childId,
    markerDir: join(process.cwd(), ".data/browser-executions"),
  });
  let latest: ConversationState = {
    display: [taskMessage(input.task)],
    context: [taskMessage(input.task)],
  };

  try {
    const result = await runAgentLoop({
      session: {
        runId: input.childId,
        emit: async () => undefined,
        chatStream: modelChatStream,
        tools: browser.tools,
      },
      conversation: latest,
      model: input.model,
      prompt: browserAgentSystemPrompt,
      checkpoint: guardedCheckpoint(deadline, (conversation) => {
        latest = conversation;
      }),
      signal,
    });

    return settle(result);
  } catch (error) {
    if (
      error instanceof DBOSErrors.DBOSWorkflowCancelledError ||
      error instanceof DBOSErrors.DBOSWorkflowConflictError
    ) {
      throw error;
    }

    return {
      state: "failed",
      reason: error instanceof DeadlineError || signal.aborted ? "deadline" : "error",
      message: errorMessage(error, "Browser agent failed"),
      observations: browserObservations(latest.context),
    };
  } finally {
    await browser.close();
  }
}

const browserAgentWorkflow = DBOS.registerWorkflow(executeBrowserAgent, {
  name: BROWSER_AGENT_WORKFLOW,
});

export function browserAgentId(parentRunId: string, step: string): string {
  const digest = createHash("sha256").update(`${parentRunId}\0${step}`).digest("hex");

  return `browser-${digest.slice(0, 32)}`;
}

function admitDelegation(
  input: unknown,
): { admitted: true; task: DelegationInput } | { admitted: false; error: string } {
  const parsed = delegationInputSchema.safeParse(input);

  if (!parsed.success) {
    return { admitted: false, error: z.prettifyError(parsed.error).slice(0, 2000) };
  }

  return jevConfigured()
    ? { admitted: true, task: parsed.data }
    : { admitted: false, error: "JEV_API_KEY is not configured; the browser sub-agent cannot run" };
}

export async function delegateBrowserTask(
  parentRunId: string,
  model: string,
  call: ModelCall,
  step: string,
): Promise<{ output: unknown; error: boolean }> {
  const admission = await DBOS.runStep(async () => admitDelegation(call.input), {
    name: `${step}:admit`,
  });

  if (!admission.admitted) {
    return { error: true, output: { error: admission.error } };
  }

  const childId = browserAgentId(parentRunId, step);

  try {
    const handle = await DBOS.startWorkflow(browserAgentWorkflow, { workflowID: childId })({
      childId,
      model,
      task: admission.task,
    });
    const result = await handle.getResult();

    return { error: result.state === "failed", output: { agent: "browser", childId, ...result } };
  } catch (error) {
    if (error instanceof DBOSErrors.DBOSWorkflowCancelledError) {
      throw error;
    }

    return {
      error: true,
      output: {
        agent: "browser",
        childId,
        state: "failed",
        reason: "child_failed",
        message: errorMessage(error, "The browser sub-agent workflow failed"),
        observations: [],
      },
    };
  }
}
