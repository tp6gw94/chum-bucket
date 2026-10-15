import { createHash } from "node:crypto";
import { DBOS } from "@dbos-inc/dbos-sdk";
import type { StreamChunk, UIMessage } from "@tanstack/ai";
import { z } from "zod";
import {
  toolApprovalRequestedEvent,
  toolApprovalResolvedEvent,
  toolArgumentSchemas,
  type ToolApprovalRequest,
  type ToolApprovalResolution,
} from "../../shared/tool-approval";
import type { ModelCall } from "./model-turn";
import { commentApprovalPrompt } from "./prompts";
import { appendRunEventOnce } from "./run-store";
import { hasFinalApprovalDenial, isRunPending } from "./tool-approval-store";
import { readAtlassianConfiguration } from "./tools/atlassian-policy";
import { sendApprovedJiraComment } from "./tools/atlassian";
import type { RunTools } from "./tools";

const APPROVAL_TOOL = "jira_add_comment";
const APPROVAL_TTL_MS = 30 * 60_000;
const DISPATCH_TIMEOUT_MS = 90_000;

export type ApprovalRun = Readonly<{ runId: string; threadId: string; workflowId: string }>;

type Settled = { output: Record<string, unknown>; error: boolean };

type Admission =
  | { state: "requested"; request: ToolApprovalRequest }
  | { state: "denied"; status: "rejected" | "cancelled"; reason: string }
  | { state: "invalid"; error: string };

type Dispatch =
  | { state: "succeeded"; externalId: string }
  | { state: "cancelled" }
  | { state: "approved"; error: string };

const OUTCOME_MESSAGES: Record<ToolApprovalResolution, string> = {
  succeeded: "The comment was posted. Report its comment ID to the user.",
  rejected:
    "The user rejected the comment and nothing was sent. Do not propose it again unless the user asks in a new message.",
  expired: "The approval expired and nothing was sent.",
  cancelled: "The approval was cancelled and nothing was sent.",
  approved:
    "The user approved the comment, but delivery was not confirmed. Do not say it was posted and do not propose it again.",
};

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }

  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  }

  return JSON.stringify(value);
}

function uuidFromDigest(hex: string): string {
  const variant = ((parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16);

  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function userNamedIssue(messages: readonly UIMessage[], issueKey: string): boolean {
  const pattern = new RegExp(`(^|[^A-Z0-9_-])${issueKey}(?![0-9])`);

  return messages.some(
    (message) =>
      message.role === "user" &&
      message.parts.some((part) => part.type === "text" && pattern.test(part.content)),
  );
}

function jiraSite(): string | undefined {
  const config = readAtlassianConfiguration(process.env);

  return config.mode === "http" ? config.serviceEnvironment.JIRA_URL : undefined;
}

function outcome(status: ToolApprovalResolution, externalId: string | null): Settled {
  return {
    error: status !== "succeeded",
    output: {
      status,
      externalId,
      retryable: false,
      message: OUTCOME_MESSAGES[status],
    },
  };
}

async function requestApproval(
  run: ApprovalRun,
  call: ModelCall,
  context: readonly UIMessage[],
): Promise<Admission> {
  const parsed = toolArgumentSchemas.jira_add_comment.safeParse(call.input);

  if (!parsed.success) {
    return { state: "invalid", error: z.prettifyError(parsed.error).slice(0, 2000) };
  }

  const input = parsed.data;
  const site = jiraSite();

  if (!site) {
    return { state: "invalid", error: "Jira is not configured; comments cannot be proposed" };
  }

  if (!(await isRunPending(run.runId))) {
    return { state: "denied", status: "cancelled", reason: "The run is no longer active" };
  }

  if (!userNamedIssue(context, input.issue_key)) {
    return {
      state: "denied",
      status: "rejected",
      reason: `The user did not name ${input.issue_key} in this conversation`,
    };
  }

  if (await hasFinalApprovalDenial(run.runId)) {
    return {
      state: "denied",
      status: "rejected",
      reason: "A comment in this turn was already rejected, expired or cancelled",
    };
  }

  const approvalContext = {
    site,
    visibility: "jira-default" as const,
    policy: "jira-comment-v1" as const,
  };
  const expiresAt = new Date(Date.now() + APPROVAL_TTL_MS).toISOString();
  const request: ToolApprovalRequest = {
    approvalId: uuidFromDigest(sha256(`${run.workflowId}:${call.id}`)),
    threadId: run.threadId,
    runId: run.runId,
    toolCallId: call.id,
    workflowId: run.workflowId,
    topic: `tool-approval:${run.runId}:${call.id}`,
    tool: APPROVAL_TOOL,
    arguments: input,
    context: approvalContext,
    digest: sha256(
      canonicalJson({ run, call: call.id, input, context: approvalContext, expiresAt }),
    ),
    expiresAt,
  };
  await appendRunEventOnce(
    run.runId,
    `approval:${request.approvalId}:requested`,
    toolApprovalRequestedEvent(request) as StreamChunk,
  );

  return { state: "requested", request };
}

function classifyDecision(received: unknown, request: ToolApprovalRequest) {
  if (received === null) {
    return "expired";
  }

  const decision = received as Partial<Record<"approvalId" | "tool" | "digest", unknown>> & {
    approved?: unknown;
  };

  return decision.approvalId === request.approvalId &&
    decision.tool === request.tool &&
    decision.digest === request.digest &&
    decision.approved === true
    ? "approved"
    : "rejected";
}

function resolveApproval(
  request: ToolApprovalRequest,
  state: ToolApprovalResolution,
  externalId: string | null,
) {
  return appendRunEventOnce(
    request.runId,
    `approval:${request.approvalId}:${state}`,
    toolApprovalResolvedEvent({
      approvalId: request.approvalId,
      state,
      receipt: externalId ? { externalId } : null,
    }) as StreamChunk,
  );
}

async function dispatchComment(request: ToolApprovalRequest): Promise<Dispatch> {
  if (!(await isRunPending(request.runId)) || Date.now() >= Date.parse(request.expiresAt)) {
    return { state: "cancelled" };
  }

  try {
    const sent = await sendApprovedJiraComment(
      request.arguments,
      request.context.site,
      AbortSignal.timeout(DISPATCH_TIMEOUT_MS),
    );

    return { state: "succeeded", externalId: sent.externalId };
  } catch (failure) {
    return {
      state: "approved",
      error: failure instanceof Error ? failure.message.slice(0, 500) : "Delivery failed",
    };
  }
}

async function deliver(request: ToolApprovalRequest, callId: string): Promise<Settled> {
  await DBOS.runStep(() => resolveApproval(request, "approved", null), {
    name: `approval-approve:${callId}`,
  });
  const sent = await DBOS.runStep(() => dispatchComment(request), {
    name: `approval-dispatch:${callId}`,
  });

  if (sent.state === "approved") {
    return outcome("approved", null);
  }

  await DBOS.runStep(
    () => resolveApproval(request, sent.state, sent.state === "succeeded" ? sent.externalId : null),
    { name: `approval-resolve:${callId}` },
  );

  return sent.state === "succeeded"
    ? outcome("succeeded", sent.externalId)
    : outcome("cancelled", null);
}

export async function gateToolApproval(
  run: ApprovalRun,
  call: ModelCall,
  context: readonly UIMessage[],
): Promise<Settled | undefined> {
  if (call.name !== APPROVAL_TOOL) {
    return undefined;
  }

  const admission = await DBOS.runStep(() => requestApproval(run, call, context), {
    name: `approval-request:${call.id}`,
  });

  if (admission.state === "invalid") {
    return { error: true, output: { error: admission.error } };
  }

  if (admission.state === "denied") {
    return {
      error: true,
      output: { ...outcome(admission.status, null).output, reason: admission.reason },
    };
  }

  const { request } = admission;
  const received = await DBOS.recv<unknown>(request.topic, {
    deadlineEpochMS: Date.parse(request.expiresAt),
  });
  const decision = classifyDecision(received, request);

  if (decision !== "approved") {
    await DBOS.runStep(() => resolveApproval(request, decision, null), {
      name: `approval-resolve:${call.id}`,
    });

    return outcome(decision, null);
  }

  return deliver(request, call.id);
}

export function withCommentApproval(tools: RunTools): RunTools {
  return {
    async getModelTools(messages) {
      const base = await tools.getModelTools(messages);

      return { ...base, systemPrompt: [base.systemPrompt, commentApprovalPrompt].join("\n\n") };
    },
    executeTool: tools.executeTool,
  };
}
