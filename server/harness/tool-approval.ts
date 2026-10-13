import { createHash } from "node:crypto";
import { DBOS } from "@dbos-inc/dbos-sdk";
import { EventType, type StreamChunk } from "@tanstack/ai";
import { z } from "zod";
import {
  TOOL_APPROVAL_REQUESTED_EVENT,
  TOOL_APPROVAL_RESOLVED_EVENT,
  approvalToolNames,
  toolApprovalRequestedSchema,
  type ToolApprovalRequest,
} from "../../shared/tool-approval";
import type { ModelCall } from "./model-turn";
import {
  emit,
  guardActualIO,
  hasFinalApprovalDenial,
  readTestingExecution,
  RunRequestError,
} from "./run-store";
import { jiraCommentApproval, withAtlassianScope } from "./tools/atlassian";

export type ApprovalGateRun = Readonly<{
  parentRunId: string;
  operationId: string;
  taskId: string;
  childWorkflowId: string;
  attemptNonce: number;
  role: string;
}>;

export type ApprovalGateOutcome =
  | Readonly<{ state: "unhandled" }>
  | Readonly<{
      state: "handled";
      output: Readonly<{
        status: string;
        externalId: string | null;
        retryable: false;
        instruction: string;
      }>;
    }>;

const decisionSchema = z.strictObject({
  approvalId: z.uuid(),
  tool: z.enum(approvalToolNames),
  digest: z.string().length(64),
  approved: z.boolean(),
});

const cancelSchema = z.strictObject({ cancel: z.literal(true), approvalId: z.uuid() });

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }

  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;

    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }

  return JSON.stringify(value);
}

function eventChunk(name: string, value: Record<string, unknown>, toolCallId: string): StreamChunk {
  return {
    type: EventType.CUSTOM,
    name,
    value,
    timestamp: Date.now(),
    metadata: { tanstack: { toolCallId } },
  };
}

type ApprovalRequestResult =
  | Readonly<{ state: "requested"; request: ToolApprovalRequest }>
  | Readonly<{ state: "denied" | "cancelled" }>;

function uuidFromDigest(hex: string): string {
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

async function requestApproval(
  run: ApprovalGateRun,
  call: ModelCall,
): Promise<ApprovalRequestResult> {
  try {
    const input = jiraCommentApproval.parse(call.input);
    const execution = await readTestingExecution(run.parentRunId, run.operationId);

    if (
      execution.finished ||
      execution.cancelRequested ||
      Date.parse(execution.deadline) <= Date.now()
    ) {
      throw new RunRequestError(409, "Approval task is no longer active");
    }

    jiraCommentApproval.scope(execution.intent, input);

    if (await hasFinalApprovalDenial(run.parentRunId, run.taskId)) {
      throw new RunRequestError(409, "Approval task cannot propose again");
    }

    const context = jiraCommentApproval.context();
    const approvalId = uuidFromDigest(
      createHash("sha256").update(`${run.childWorkflowId}:${call.id}`).digest("hex"),
    );
    await withAtlassianScope(async (scope) => (await scope.guard())(input));
    const request = toolApprovalRequestedSchema.parse({
      approvalId,
      threadId: execution.threadId,
      runId: run.parentRunId,
      operationId: run.operationId,
      taskId: run.taskId,
      toolCallId: call.id,
      childWorkflowId: run.childWorkflowId,
      topic: `tool-approval:${run.taskId}:${call.id}`,
      tool: call.name,
      arguments: input,
      presentation: jiraCommentApproval.present(input, context),
      context,
      digest: createHash("sha256")
        .update(canonicalJson({ run, call: call.id, input, context, deadline: execution.deadline }))
        .digest("hex"),
      expiresAt: execution.deadline,
    });

    await emit(run.parentRunId, eventChunk(TOOL_APPROVAL_REQUESTED_EVENT, request, call.id));

    if ((await readTestingExecution(run.parentRunId, run.operationId)).cancelRequested) {
      await emit(run.parentRunId, resolutionChunk(request, "cancelled", null));

      return { state: "cancelled" };
    }

    return { state: "requested", request };
  } catch (error) {
    if (error instanceof RunRequestError) {
      return { state: "denied" };
    }

    throw error;
  }
}

function resolutionChunk(
  request: ToolApprovalRequest,
  state: "approved" | "succeeded" | "rejected" | "expired" | "cancelled",
  receipt: Readonly<{ externalId: string }> | null,
): StreamChunk {
  return eventChunk(
    TOOL_APPROVAL_RESOLVED_EVENT,
    { approvalId: request.approvalId, state, receipt },
    request.toolCallId,
  );
}

function denial(state: string): ApprovalGateOutcome {
  return {
    state: "handled",
    output: {
      status: state,
      externalId: null,
      retryable: false,
      instruction:
        "Do not propose another comment in this task. Finish reading the requested sources.",
    },
  };
}

function approvalDecision(request: ToolApprovalRequest, received: unknown) {
  const cancellation = cancelSchema.safeParse(received);

  if (cancellation.success && cancellation.data.approvalId === request.approvalId) {
    return "cancelled";
  }

  const decision = decisionSchema.safeParse(received);
  const approved =
    decision.success &&
    decision.data.approvalId === request.approvalId &&
    decision.data.tool === request.tool &&
    decision.data.digest === request.digest &&
    decision.data.approved;

  if (approved) {
    return "approved";
  }

  return received === null ? "expired" : "rejected";
}

async function dispatchApprovedTool(
  run: ApprovalGateRun,
  request: ToolApprovalRequest,
  signal: AbortSignal,
) {
  const execution = await readTestingExecution(run.parentRunId, run.operationId);

  if (
    execution.finished ||
    execution.cancelRequested ||
    Date.parse(execution.deadline) <= Date.now()
  ) {
    return { state: "cancelled" as const };
  }

  const guard = await guardActualIO({
    taskId: run.taskId,
    parentRunId: run.parentRunId,
    attemptNonce: run.attemptNonce,
    childWorkflowId: run.childWorkflowId,
    kind: "tool",
  });

  if (guard.state !== "allowed") {
    return { state: "cancelled" as const };
  }

  return {
    state: "sent" as const,
    receipt: await jiraCommentApproval.dispatch(
      jiraCommentApproval.parse(request.arguments),
      request.context,
      signal,
    ),
  };
}

export async function gateToolApproval(
  run: ApprovalGateRun,
  call: ModelCall,
  signal: AbortSignal,
): Promise<ApprovalGateOutcome> {
  if (call.name !== "jira_add_comment" || run.role !== jiraCommentApproval.role) {
    return { state: "unhandled" };
  }

  const prepared = await DBOS.runStep(() => requestApproval(run, call), {
    name: `approval-request:${call.id}`,
    retriesAllowed: false,
  });

  if (prepared.state !== "requested") {
    return denial(prepared.state);
  }

  const { request } = prepared;
  const received = await DBOS.recv<unknown>(request.topic, {
    deadlineEpochMS: Date.parse(request.expiresAt),
  });

  const decision = approvalDecision(request, received);

  if (decision !== "approved") {
    await DBOS.runStep(() => emit(run.parentRunId, resolutionChunk(request, decision, null)), {
      name: `approval-resolve:${call.id}`,
      retriesAllowed: false,
    });

    return denial(decision);
  }

  signal.throwIfAborted();

  await DBOS.runStep(() => emit(run.parentRunId, resolutionChunk(request, "approved", null)), {
    name: `approval-approve:${call.id}`,
    retriesAllowed: false,
  });

  const outcome = await DBOS.runStep(() => dispatchApprovedTool(run, request, signal), {
    name: `approval-dispatch:${call.id}`,
    retriesAllowed: false,
  });

  const state = outcome.state === "sent" ? "succeeded" : outcome.state;
  const receipt = outcome.state === "sent" ? outcome.receipt : null;

  await DBOS.runStep(() => emit(run.parentRunId, resolutionChunk(request, state, receipt)), {
    name: `approval-resolve:${call.id}`,
    retriesAllowed: false,
  });

  if (state === "cancelled") {
    return denial("cancelled");
  }

  return {
    state: "handled",
    output: {
      status: state,
      externalId: receipt?.externalId ?? null,
      retryable: false,
      instruction: "Continue reading the requested sources. Never retry a denied action.",
    },
  };
}
