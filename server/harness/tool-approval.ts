import { createHash } from "node:crypto";
import { DBOS } from "@dbos-inc/dbos-sdk";
import { EventType, type StreamChunk } from "@tanstack/ai";
import {
  jiraCommentToolName,
  toolApprovalDecisionSchema,
  toolApprovalRequestedEventName,
  toolApprovalResolvedEventName,
  toolApprovalTopic,
  type JiraCommentParams,
  type ToolApprovalRequest,
  type ToolApprovalResolution,
} from "../../shared/tool-approval";
import type { AgentOrchestration } from "./agent-loop";
import type { ModelCall } from "./model-turn";
import { recordToolApprovalEvent } from "./run-store";
import {
  guardActualIO,
  loadOperation,
  recordReceipt,
  type TestingChildInput,
} from "./testing-store";
import { jiraCommentApproval, sendApprovedJiraComment } from "./tools/atlassian";

type Handled = Extract<Awaited<ReturnType<AgentOrchestration>>, { state: "handled" }>;
type Resolution = Omit<ToolApprovalResolution, "id">;
type Opened = { state: "open"; deadline: number } | { state: "closed"; resolution: Resolution };
type Verdict = Resolution | { state: "approved" } | { state: "waiting" };
type Operation = Awaited<ReturnType<typeof loadOperation>>;

const MAX_REASON_CHARS = 500;

function approvalIdFor(child: TestingChildInput, callId: string, ordinal: number): string {
  const digest = createHash("sha256")
    .update(`${child.taskId}\0${child.attemptNonce}\0${ordinal}\0${callId}`)
    .digest("hex");

  return `approval-${digest.slice(0, 32)}`;
}

function cancelled(reason: string): Resolution {
  return { state: "cancelled", commentId: null, reason };
}

function stopReason(operation: Operation): string | undefined {
  if (operation.cancel_accepted_at) {
    return "cancel_requested";
  }

  if (operation.finished_at) {
    return "terminal";
  }

  return operation.deadline.getTime() <= Date.now() ? "deadline" : undefined;
}

function customEvent(name: string, value: unknown): StreamChunk {
  return { type: EventType.CUSTOM, name, value, timestamp: Date.now() };
}

async function openRequest(
  child: TestingChildInput,
  id: string,
  params: JiraCommentParams,
): Promise<Opened> {
  const operation = await loadOperation(child.operationId);
  const stopped = stopReason(operation);

  if (stopped) {
    return { state: "closed", resolution: cancelled(stopped) };
  }

  const request: ToolApprovalRequest = {
    id,
    workflowId: child.childWorkflowId,
    operationId: child.operationId,
    requestKey: operation.request_key,
    tool: jiraCommentToolName,
    params,
  };
  const recorded = await recordToolApprovalEvent(
    child.parentRunId,
    `${id}:requested`,
    customEvent(toolApprovalRequestedEventName, request),
  );

  return recorded
    ? { state: "open", deadline: operation.deadline.getTime() }
    : { state: "closed", resolution: cancelled("terminal") };
}

async function checkDecision(
  child: TestingChildInput,
  call: ModelCall,
  message: unknown,
): Promise<Verdict> {
  const parsed = toolApprovalDecisionSchema.safeParse(message);

  if (!parsed.success) {
    const stopped = stopReason(await loadOperation(child.operationId));

    return stopped ? cancelled(stopped) : { state: "waiting" };
  }

  if (parsed.data.decision === "reject") {
    return { state: "rejected", commentId: null, reason: parsed.data.reason ?? null };
  }

  const guard = await guardActualIO({
    taskId: child.taskId,
    attemptNonce: child.attemptNonce,
    childWorkflowId: child.childWorkflowId,
    kind: "tool",
    step: `tool:${call.id}`,
    name: jiraCommentToolName,
  });

  return guard.state === "denied" ? cancelled(guard.reason) : { state: "approved" };
}

async function postComment(
  child: TestingChildInput,
  id: string,
  params: JiraCommentParams,
): Promise<Resolution> {
  const receipt = {
    taskId: child.taskId,
    attempt: child.attemptNonce,
    slot: id,
    route: "approval",
    input: params,
  };
  const attempt = await recordReceipt({
    ...receipt,
    nativeName: `${jiraCommentToolName}:attempt`,
    output: { state: "sending" },
    bindings: {},
  });

  if (attempt.duplicate) {
    return {
      state: "failed",
      commentId: null,
      reason: "A previous send was interrupted; check the Jira issue before proposing again",
    };
  }

  let commentId: string;

  try {
    ({ commentId } = await sendApprovedJiraComment(params));
  } catch (failure) {
    const message = failure instanceof Error ? failure.message : "Comment failed";

    return { state: "failed", commentId: null, reason: message.slice(0, MAX_REASON_CHARS) };
  }

  await recordReceipt({
    ...receipt,
    nativeName: jiraCommentToolName,
    output: { commentId },
    bindings: { issueKey: params.issue_key, commentId },
  });

  return { state: "posted", commentId, reason: null };
}

async function awaitDecision(
  child: TestingChildInput,
  call: ModelCall,
  id: string,
  params: JiraCommentParams,
  deadline: number,
): Promise<Resolution> {
  for (;;) {
    const message = await DBOS.recv<unknown>(toolApprovalTopic(id), { deadlineEpochMS: deadline });
    const verdict = await DBOS.runStep(() => checkDecision(child, call, message), {
      name: `${id}:check`,
    });

    if (verdict.state === "approved") {
      return DBOS.runStep(() => postComment(child, id, params), { name: `${id}:send` });
    }

    if (verdict.state !== "waiting") {
      return verdict;
    }
  }
}

function toolOutput(params: JiraCommentParams, resolution: Resolution): Handled {
  const output = {
    state: resolution.state,
    issueKey: params.issue_key,
    ...(resolution.commentId ? { commentId: resolution.commentId } : {}),
    ...(resolution.reason ? { reason: resolution.reason } : {}),
  };

  return resolution.state === "failed"
    ? { state: "handled", output: { error: "Comment was not posted", ...output }, error: true }
    : { state: "handled", output };
}

export async function gateToolApproval(
  child: TestingChildInput,
  call: ModelCall,
  ordinal: number,
): Promise<Handled> {
  let params: JiraCommentParams;

  try {
    params = jiraCommentApproval(call.input);
  } catch (failure) {
    const message = failure instanceof Error ? failure.message : "Invalid comment";

    return { state: "handled", output: { error: message.slice(0, 2_000) }, error: true };
  }

  const id = approvalIdFor(child, call.id, ordinal);
  const opened = await DBOS.runStep(() => openRequest(child, id, params), {
    name: `${id}:request`,
  });
  const resolution =
    opened.state === "open"
      ? await awaitDecision(child, call, id, params, opened.deadline)
      : opened.resolution;
  await DBOS.runStep(
    () =>
      recordToolApprovalEvent(
        child.parentRunId,
        `${id}:resolved`,
        customEvent(toolApprovalResolvedEventName, { id, ...resolution }),
      ),
    { name: `${id}:record` },
  );

  return toolOutput(params, resolution);
}
