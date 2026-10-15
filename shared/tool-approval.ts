import { z } from "zod";

export const TOOL_APPROVAL_REQUESTED = "tool.approval.requested";
export const TOOL_APPROVAL_RESOLVED = "tool.approval.resolved";

export const approvalToolNames = ["jira_add_comment"] as const;

export const toolArgumentSchemas = {
  jira_add_comment: z.strictObject({
    issue_key: z.string().regex(/^[A-Z][A-Z0-9_]*-[1-9][0-9]*$/),
    body: z.string().min(1).max(32767),
  }),
} as const;

export const toolApprovalDecisionSchema = z.strictObject({
  threadId: z.uuid(),
  digest: z.string().length(64),
  tool: z.enum(approvalToolNames),
  approved: z.boolean(),
});

const approvalContextSchema = z.strictObject({
  site: z.url(),
  visibility: z.literal("jira-default"),
  policy: z.literal("jira-comment-v1"),
});

const requestedSchema = z.strictObject({
  approvalId: z.uuid(),
  threadId: z.uuid(),
  runId: z.string().min(1),
  operationId: z.string().min(1),
  taskId: z.string().min(1),
  toolCallId: z.string().min(1),
  childWorkflowId: z.string().min(1),
  topic: z.string().min(1),
  tool: z.enum(approvalToolNames),
  arguments: toolArgumentSchemas.jira_add_comment,
  presentation: z.strictObject({ title: z.string().min(1) }),
  context: approvalContextSchema,
  digest: z.string().length(64),
  expiresAt: z.iso.datetime(),
});

const resolvedStates = ["approved", "succeeded", "rejected", "expired", "cancelled"] as const;

const resolvedSchema = z.strictObject({
  approvalId: z.uuid(),
  state: z.enum(resolvedStates),
  receipt: z.strictObject({ externalId: z.string().min(1) }).nullable(),
});

export const toolApprovalListSchema = z.array(
  requestedSchema.extend({
    state: z.enum(["pending", ...resolvedStates]),
    receipt: resolvedSchema.shape.receipt,
  }),
);

export type ToolApprovalContext = z.infer<typeof approvalContextSchema>;
export type ToolApprovalRequest = z.infer<typeof requestedSchema>;
export type ToolApprovalResolution = z.infer<typeof resolvedSchema>;
export type ResolvedApprovalState = ToolApprovalResolution["state"];
export type ToolApprovalState = "pending" | ResolvedApprovalState;
export type ToolApproval = ToolApprovalRequest & {
  state: ToolApprovalState;
  receipt: ToolApprovalResolution["receipt"];
};
export type ToolApprovalEvent =
  | { kind: "requested"; request: ToolApprovalRequest }
  | { kind: "resolved"; resolution: ToolApprovalResolution };

export function parseToolApprovalEvent(name: string, value: unknown): ToolApprovalEvent | null {
  if (name === TOOL_APPROVAL_REQUESTED) {
    const parsed = requestedSchema.safeParse(value);

    return parsed.success ? { kind: "requested", request: parsed.data } : null;
  }

  if (name === TOOL_APPROVAL_RESOLVED) {
    const parsed = resolvedSchema.safeParse(value);

    return parsed.success ? { kind: "resolved", resolution: parsed.data } : null;
  }

  return null;
}

export function applyToolApprovalEvent(
  approvals: readonly ToolApproval[],
  event: ToolApprovalEvent,
): ToolApproval[] {
  if (event.kind === "requested") {
    return approvals.some((item) => item.approvalId === event.request.approvalId)
      ? [...approvals]
      : [...approvals, { ...event.request, state: "pending", receipt: null }];
  }

  const { approvalId, state, receipt } = event.resolution;

  return approvals.map((item) =>
    item.approvalId === approvalId &&
    (item.state === "pending" || (item.state === "approved" && state !== "approved"))
      ? { ...item, state, receipt }
      : item,
  );
}

export function effectiveApprovalState(approval: ToolApproval, now: number): ToolApprovalState {
  return approval.state === "pending" && now >= Date.parse(approval.expiresAt)
    ? "expired"
    : approval.state;
}

export function projectToolApprovals(
  events: readonly ToolApprovalEvent[],
  now = Date.now(),
): ToolApproval[] {
  return events
    .reduce<ToolApproval[]>(applyToolApprovalEvent, [])
    .map((approval) => ({ ...approval, state: effectiveApprovalState(approval, now) }));
}

export function approvalDecisionKey(approvalId: string): string {
  return `approval-decision:${approvalId}`;
}

export function approvalCancelKey(approvalId: string): string {
  return `approval-cancel:${approvalId}`;
}
