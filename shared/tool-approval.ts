import { z } from "zod";

export const toolArgumentSchemas = {
  jira_add_comment: z.strictObject({
    issue_key: z.string().regex(/^[A-Z][A-Z0-9_]*-[1-9][0-9]*$/),
    body: z.string().min(1).max(32767),
  }),
} as const;

const approvalToolNames = ["jira_add_comment"] as const;

export const toolApprovalDecisionSchema = z.strictObject({
  threadId: z.uuid(),
  digest: z.string().length(64),
  tool: z.enum(approvalToolNames),
  approved: z.boolean(),
});
export type ToolApprovalDecision = z.infer<typeof toolApprovalDecisionSchema>;

const resolvedStates = ["approved", "succeeded", "rejected", "expired", "cancelled"] as const;
export type ToolApprovalResolution = (typeof resolvedStates)[number];
export type ToolApprovalState = "pending" | ToolApprovalResolution;

const requestedEventName = "tool.approval.requested";
const resolvedEventName = "tool.approval.resolved";

const requestedValueSchema = z.strictObject({
  approvalId: z.uuid(),
  threadId: z.uuid(),
  runId: z.string().min(1),
  toolCallId: z.string().min(1),
  workflowId: z.string().min(1),
  topic: z.string().min(1),
  tool: z.enum(approvalToolNames),
  arguments: toolArgumentSchemas.jira_add_comment,
  context: z.strictObject({
    site: z.string().min(1),
    visibility: z.literal("jira-default"),
    policy: z.literal("jira-comment-v1"),
  }),
  digest: z.string().length(64),
  expiresAt: z.iso.datetime(),
});
export type ToolApprovalRequest = z.infer<typeof requestedValueSchema>;

const resolvedValueSchema = z.strictObject({
  approvalId: z.uuid(),
  state: z.enum(resolvedStates),
  receipt: z.strictObject({ externalId: z.string().min(1) }).nullable(),
});
type ToolApprovalResolved = z.infer<typeof resolvedValueSchema>;

const toolApprovalEventSchema = z.discriminatedUnion("name", [
  z.object({
    type: z.literal("CUSTOM"),
    name: z.literal(requestedEventName),
    value: requestedValueSchema,
  }),
  z.object({
    type: z.literal("CUSTOM"),
    name: z.literal(resolvedEventName),
    value: resolvedValueSchema,
  }),
]);
type ToolApprovalEvent = z.infer<typeof toolApprovalEventSchema>;

const toolApprovalListSchema = z.array(
  z.object({
    request: requestedValueSchema,
    state: z.enum(["pending", ...resolvedStates]),
    receipt: resolvedValueSchema.shape.receipt,
  }),
);

export type ToolApproval = Readonly<{
  request: ToolApprovalRequest;
  state: ToolApprovalState;
  receipt: ToolApprovalResolved["receipt"];
}>;

export function parseToolApprovals(value: unknown): readonly ToolApproval[] {
  const parsed = toolApprovalListSchema.safeParse(value);

  return parsed.success ? parsed.data : [];
}

export function toolApprovalRequestedEvent(value: ToolApprovalRequest) {
  return {
    type: "CUSTOM" as const,
    name: requestedEventName,
    value: requestedValueSchema.parse(value),
    timestamp: Date.now(),
  };
}

export function toolApprovalResolvedEvent(value: ToolApprovalResolved) {
  return {
    type: "CUSTOM" as const,
    name: resolvedEventName,
    value: resolvedValueSchema.parse(value),
    timestamp: Date.now(),
  };
}

export function parseToolApprovalEvent(event: unknown): ToolApprovalEvent | null {
  const parsed = toolApprovalEventSchema.safeParse(event);

  return parsed.success ? parsed.data : null;
}

function resolve(current: ToolApproval, resolved: ToolApprovalResolved): ToolApproval {
  const replaceable =
    current.state === "pending" || (current.state === "approved" && resolved.state !== "approved");

  return replaceable ? { ...current, state: resolved.state, receipt: resolved.receipt } : current;
}

export function applyToolApprovalEvent(
  approvals: readonly ToolApproval[],
  event: unknown,
): readonly ToolApproval[] {
  const parsed = parseToolApprovalEvent(event);

  if (!parsed) {
    return approvals;
  }

  const index = approvals.findIndex(
    (approval) => approval.request.approvalId === parsed.value.approvalId,
  );

  if (parsed.name === requestedEventName) {
    return index === -1
      ? [...approvals, { request: parsed.value, state: "pending", receipt: null }]
      : approvals;
  }

  if (index === -1) {
    return approvals;
  }

  return approvals.map((approval, position) =>
    position === index ? resolve(approval, parsed.value) : approval,
  );
}

function effectiveApprovalState(approval: ToolApproval, now: number): ToolApprovalState {
  return approval.state === "pending" && now >= Date.parse(approval.request.expiresAt)
    ? "expired"
    : approval.state;
}

export function projectToolApprovals(
  events: readonly unknown[],
  now: number,
): readonly ToolApproval[] {
  return events
    .reduce<readonly ToolApproval[]>(applyToolApprovalEvent, [])
    .map((approval) => ({ ...approval, state: effectiveApprovalState(approval, now) }));
}
