import { createHash } from "node:crypto";
import { DBOS } from "@dbos-inc/dbos-sdk";
import { eq } from "drizzle-orm";
import type { Role } from "../../shared/testing";
import {
  TOOL_APPROVAL_REQUESTED,
  TOOL_APPROVAL_RESOLVED,
  toolArgumentSchemas,
  type ResolvedApprovalState,
  type ToolApprovalContext,
  type ToolApprovalRequest,
  type ToolApprovalResolution,
} from "../../shared/tool-approval";
import { testingOperationsTable } from "../db/schema";
import type { AgentOrchestration } from "./agent-loop";
import type { ModelCall } from "./model-turn";
import { appendKeyedEvent, database } from "./run-store";
import { digestOf } from "./testing-domain";
import { approvalEvent, hasFinalApprovalDenial } from "./tool-approval-store";
import { jiraCommentApproval } from "./tools/atlassian";
import { readAtlassianConfiguration } from "./tools/atlassian-policy";

export type ApprovalRun = Readonly<{
  parentRunId: string;
  threadId: string;
  operationId: string;
  taskId: string;
  childWorkflowId: string;
  role: Role;
}>;

type GateOptions = Readonly<{
  signal: AbortSignal;
  guard: (step: string) => Promise<void>;
}>;
type OrchestrationResult = Awaited<ReturnType<AgentOrchestration>>;
type CommentInput = ReturnType<typeof toolArgumentSchemas.jira_add_comment.parse>;
type Proposal =
  | { kind: "request"; request: ToolApprovalRequest }
  | { kind: "denied"; status: "denied" | "cancelled" | "expired"; reason: string };
type Dispatched = {
  state: Extract<ResolvedApprovalState, "succeeded" | "cancelled">;
  receipt: ToolApprovalResolution["receipt"];
};

const DENIAL_INSTRUCTION =
  "Do not propose another comment in this task. Finish reading the requested sources.";

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function uuidFromDigest(hex: string): string {
  const variant = ((Number.parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16);

  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function handled(output: unknown, error = false): OrchestrationResult {
  return { state: "handled", output, error };
}

function toolResult(status: string, externalId: string | null, instruction: string) {
  return { status, externalId, retryable: false, instruction };
}

async function readOperation(operationId: string) {
  const db = await database();
  const [operation] = await db
    .select()
    .from(testingOperationsTable)
    .where(eq(testingOperationsTable.id, operationId));

  return operation;
}

function operationClosed(
  operation: Awaited<ReturnType<typeof readOperation>>,
): "cancelled" | "expired" | null {
  if (!operation || operation.finished_at || operation.cancel_accepted_at) {
    return "cancelled";
  }

  return operation.deadline.getTime() <= Date.now() ? "expired" : null;
}

function approvalContext(): ToolApprovalContext | null {
  const config = readAtlassianConfiguration(process.env);

  return config.mode === "http"
    ? {
        site: config.serviceEnvironment.JIRA_URL!,
        visibility: "jira-default",
        policy: "jira-comment-v1",
      }
    : null;
}

async function requestApproval(
  run: ApprovalRun,
  callId: string,
  input: CommentInput,
): Promise<Proposal> {
  const operation = await readOperation(run.operationId);
  const closed = operationClosed(operation);

  if (closed) {
    return { kind: "denied", status: closed, reason: "The delegated task is no longer active" };
  }

  if (
    !operation!.input.task.sources.some(
      (source) => source.kind === "jira" && source.issueKey === input.issue_key,
    )
  ) {
    return { kind: "denied", status: "denied", reason: "Issue is outside delegated sources" };
  }

  if (await hasFinalApprovalDenial(run.parentRunId, run.taskId)) {
    return {
      kind: "denied",
      status: "denied",
      reason: "A comment in this task was already rejected, expired, or cancelled",
    };
  }

  const context = approvalContext();

  if (!context) {
    return { kind: "denied", status: "denied", reason: "Jira is not configured" };
  }

  const deadline = operation!.deadline.toISOString();
  const request: ToolApprovalRequest = {
    approvalId: uuidFromDigest(sha256(`${run.childWorkflowId}:${callId}`)),
    threadId: run.threadId,
    runId: run.parentRunId,
    operationId: run.operationId,
    taskId: run.taskId,
    toolCallId: callId,
    childWorkflowId: run.childWorkflowId,
    topic: `tool-approval:${run.taskId}:${callId}`,
    tool: "jira_add_comment",
    arguments: input,
    presentation: { title: `Jira 留言核准 · ${input.issue_key}` },
    context,
    digest: digestOf({ run, call: callId, input, context, deadline }),
    expiresAt: deadline,
  };
  await appendKeyedEvent(
    run.parentRunId,
    `approval:requested:${request.approvalId}`,
    approvalEvent(TOOL_APPROVAL_REQUESTED, request),
  );

  return { kind: "request", request };
}

function decisionOf(request: ToolApprovalRequest, received: unknown) {
  if (received === null) {
    return "expired";
  }

  const value = (typeof received === "object" ? received : {}) as Record<string, unknown>;

  if (value.cancel === true && value.approvalId === request.approvalId) {
    return "cancelled";
  }

  return value.approvalId === request.approvalId &&
    value.tool === request.tool &&
    value.digest === request.digest &&
    value.approved === true
    ? "approved"
    : "rejected";
}

async function resolveApproval(
  request: ToolApprovalRequest,
  state: ResolvedApprovalState,
  receipt: ToolApprovalResolution["receipt"],
) {
  const resolution: ToolApprovalResolution = { approvalId: request.approvalId, state, receipt };
  await appendKeyedEvent(
    request.runId,
    `approval:resolved:${request.approvalId}:${state}`,
    approvalEvent(TOOL_APPROVAL_RESOLVED, resolution),
  );
}

async function dispatchApproval(
  request: ToolApprovalRequest,
  options: GateOptions,
): Promise<Dispatched> {
  if (operationClosed(await readOperation(request.operationId))) {
    return { state: "cancelled", receipt: null };
  }

  await options.guard(`approval:${request.toolCallId}`);
  const receipt = await jiraCommentApproval.dispatch(
    request.arguments,
    request.context.site,
    options.signal,
  );

  return { state: "succeeded", receipt };
}

async function awaitDecision(
  call: ModelCall,
  request: ToolApprovalRequest,
  options: GateOptions,
): Promise<OrchestrationResult> {
  const received = await DBOS.recv<unknown>(request.topic, {
    deadlineEpochMS: Date.parse(request.expiresAt),
  });
  const decision = decisionOf(request, received);

  if (decision !== "approved") {
    await DBOS.runStep(() => resolveApproval(request, decision, null), {
      name: `approval-resolve:${call.id}`,
    });

    return handled(toolResult(decision, null, DENIAL_INSTRUCTION));
  }

  await DBOS.runStep(() => resolveApproval(request, "approved", null), {
    name: `approval-approve:${call.id}`,
  });
  let dispatched: Dispatched;

  try {
    dispatched = await DBOS.runStep(() => dispatchApproval(request, options), {
      name: `approval-dispatch:${call.id}`,
      retriesAllowed: false,
    });
  } catch {
    return handled(
      toolResult(
        "approved",
        null,
        "The user approved this comment, but delivery was not confirmed. Do not propose it again. Finish reading the requested sources.",
      ),
      true,
    );
  }

  await DBOS.runStep(() => resolveApproval(request, dispatched.state, dispatched.receipt), {
    name: `approval-resolve:${call.id}`,
  });

  return dispatched.state === "succeeded"
    ? handled(
        toolResult(
          "succeeded",
          dispatched.receipt!.externalId,
          "The comment was posted. Finish reading the requested sources.",
        ),
      )
    : handled(toolResult("cancelled", null, DENIAL_INSTRUCTION));
}

export async function gateToolApproval(
  run: ApprovalRun,
  call: ModelCall,
  options: GateOptions,
): Promise<OrchestrationResult> {
  if (call.name !== "jira_add_comment" || run.role !== "atlassian") {
    return { state: "unhandled" };
  }

  const input = toolArgumentSchemas.jira_add_comment.safeParse(call.input);

  if (!input.success) {
    return handled({ error: "jira_add_comment accepts only issue_key and a non-empty body" }, true);
  }

  const proposal = await DBOS.runStep(() => requestApproval(run, call.id, input.data), {
    name: `approval-request:${call.id}`,
    retriesAllowed: false,
  });

  if (proposal.kind === "denied") {
    return handled({
      ...toolResult(proposal.status, null, DENIAL_INSTRUCTION),
      reason: proposal.reason,
    });
  }

  return awaitDecision(call, proposal.request, options);
}
