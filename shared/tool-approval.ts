import { z } from "zod";

export const jiraCommentToolName = "jira_add_comment";
export const toolApprovalPath = "/api/chat/approvals";
export const toolApprovalRequestedEventName = "tool-approval.requested";
export const toolApprovalResolvedEventName = "tool-approval.resolved";

export const toolApprovalIdSchema = z.string().regex(/^approval-[0-9a-f]{32}$/);

export const jiraCommentParamsSchema = z.strictObject({
  issue_key: z
    .string()
    .trim()
    .regex(/^[A-Z][A-Z0-9_]+-\d+(?:-\d+)*$/),
  body: z.string().trim().min(1).max(30_000),
});
export type JiraCommentParams = z.infer<typeof jiraCommentParamsSchema>;

export const toolApprovalDecisionSchema = z.discriminatedUnion("decision", [
  z.strictObject({ decision: z.literal("approve") }),
  z.strictObject({
    decision: z.literal("reject"),
    reason: z.string().trim().min(1).max(1_000).optional(),
  }),
]);
export type ToolApprovalDecision = z.infer<typeof toolApprovalDecisionSchema>;

export const toolApprovalDecisionRequestSchema = z.strictObject({
  threadId: z.uuid(),
  decision: toolApprovalDecisionSchema,
});

const toolApprovalRequestSchema = z.object({
  id: toolApprovalIdSchema,
  workflowId: z.string().min(1),
  operationId: z.string().min(1),
  requestKey: z.string().min(1),
  tool: z.literal(jiraCommentToolName),
  params: jiraCommentParamsSchema,
});
export type ToolApprovalRequest = z.infer<typeof toolApprovalRequestSchema>;

const toolApprovalResolutionSchema = z.object({
  id: toolApprovalIdSchema,
  state: z.enum(["posted", "rejected", "failed", "cancelled"]),
  commentId: z.string().nullable(),
  reason: z.string().nullable(),
});
export type ToolApprovalResolution = z.infer<typeof toolApprovalResolutionSchema>;

const toolApprovalRequestedEventSchema = z.object({
  type: z.literal("CUSTOM"),
  name: z.literal(toolApprovalRequestedEventName),
  value: toolApprovalRequestSchema,
});

const toolApprovalResolvedEventSchema = z.object({
  type: z.literal("CUSTOM"),
  name: z.literal(toolApprovalResolvedEventName),
  value: toolApprovalResolutionSchema,
});

export type ToolApprovalState = "pending" | ToolApprovalResolution["state"];
export type ToolApproval = ToolApprovalRequest &
  Readonly<{ state: ToolApprovalState; commentId: string | null; reason: string | null }>;
export type ToolApprovals = Readonly<Record<string, ToolApproval>>;

export function toolApprovalTopic(id: string): string {
  return `tool-approval:${id}`;
}

export function projectToolApprovals(
  events: Iterable<unknown>,
  base: ToolApprovals = {},
): ToolApprovals {
  let approvals = base;

  for (const event of events) {
    const requested = toolApprovalRequestedEventSchema.safeParse(event);

    if (requested.success) {
      const request = requested.data.value;

      if (!approvals[request.id]) {
        approvals = {
          ...approvals,
          [request.id]: { ...request, state: "pending", commentId: null, reason: null },
        };
      }

      continue;
    }

    const resolved = toolApprovalResolvedEventSchema.safeParse(event);
    const current = resolved.success ? approvals[resolved.data.value.id] : undefined;

    if (resolved.success && current?.state === "pending") {
      approvals = { ...approvals, [current.id]: { ...current, ...resolved.data.value } };
    }
  }

  return approvals;
}
