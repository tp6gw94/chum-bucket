import { EventType } from "@tanstack/ai";
import { z } from "zod";

export const toolArgumentSchemas = {
  jira_add_comment: z.strictObject({
    issue_key: z.string().regex(/^[A-Z][A-Z0-9_]*-[1-9][0-9]*$/),
    body: z.string().min(1).max(32767),
  }),
} as const;

export type ToolArguments = {
  [T in keyof typeof toolArgumentSchemas]: z.infer<(typeof toolArgumentSchemas)[T]>;
};
export type ApprovalTool = keyof ToolArguments;

export const approvalToolNames = Object.keys(toolArgumentSchemas) as [
  ApprovalTool,
  ...ApprovalTool[],
];

export const toolApprovalDecisionSchema = z.strictObject({
  threadId: z.uuid(),
  digest: z.string().length(64),
  tool: z.enum(approvalToolNames),
  approved: z.boolean(),
});
export type ToolApprovalDecision = z.infer<typeof toolApprovalDecisionSchema>;

export type Presentation = Readonly<{
  title: string;
  destination: string;
  warnings: readonly string[];
}>;

export function approvalDecisionKey(approvalId: string): string {
  return `approval-decision:${approvalId}`;
}

export function approvalCancelKey(approvalId: string): string {
  return `approval-cancel:${approvalId}`;
}

export const TOOL_APPROVAL_REQUESTED_EVENT = "tool.approval.requested";
export const TOOL_APPROVAL_RESOLVED_EVENT = "tool.approval.resolved";

const approvalStateSchema = z.enum([
  "pending",
  "approved",
  "rejected",
  "expired",
  "cancelled",
  "succeeded",
]);
export type ApprovalState = z.infer<typeof approvalStateSchema>;

const presentationSchema = z.strictObject({
  title: z.string().min(1).max(200),
  destination: z.string().min(1).max(500),
  warnings: z.array(z.string().min(1).max(500)).max(8),
});

export const toolApprovalRequestedSchema = z.strictObject({
  approvalId: z.uuid(),
  threadId: z.uuid(),
  runId: z.string().min(1),
  operationId: z.string().min(1),
  taskId: z.string().min(1),
  toolCallId: z.string().min(1),
  childWorkflowId: z.string().min(1),
  topic: z.string().min(1),
  tool: z.enum(approvalToolNames),
  arguments: z.record(z.string(), z.unknown()),
  presentation: presentationSchema,
  context: z.record(z.string(), z.unknown()),
  digest: z.string().length(64),
  expiresAt: z.iso.datetime(),
});
export type ToolApprovalRequest = z.infer<typeof toolApprovalRequestedSchema>;

const toolApprovalResolvedSchema = z.strictObject({
  approvalId: z.uuid(),
  state: z.enum(["approved", "succeeded", "rejected", "expired", "cancelled"]),
  receipt: z.strictObject({ externalId: z.string().min(1) }).nullable(),
});
export type ToolApprovalResolution = z.infer<typeof toolApprovalResolvedSchema>;

export type ToolApprovalView = Readonly<{
  approvalId: string;
  threadId: string;
  toolCallId: string;
  tool: ApprovalTool;
  arguments: Readonly<ToolArguments[ApprovalTool]>;
  presentation: Presentation;
  digest: string;
  state: ApprovalState;
  expiresAt: string;
  receipt: Readonly<{ externalId: string }> | null;
}>;

const toolApprovalViewSchema = z.strictObject({
  approvalId: z.uuid(),
  threadId: z.uuid(),
  toolCallId: z.string().min(1),
  tool: z.enum(approvalToolNames),
  arguments: z.record(z.string(), z.unknown()),
  presentation: presentationSchema,
  digest: z.string().length(64),
  state: approvalStateSchema,
  expiresAt: z.iso.datetime(),
  receipt: z.strictObject({ externalId: z.string().min(1) }).nullable(),
});

export function parseToolApprovals(payload: unknown): ToolApprovalView[] {
  const parsed = z.array(toolApprovalViewSchema).safeParse(payload);

  return parsed.success ? (parsed.data as unknown as ToolApprovalView[]) : [];
}

export type ToolApprovalEvent =
  | Readonly<{ kind: "requested"; request: ToolApprovalRequest }>
  | Readonly<{ kind: "resolved"; resolution: ToolApprovalResolution }>;

export function parseToolApprovalEvent(chunk: unknown): ToolApprovalEvent | null {
  if (!chunk || typeof chunk !== "object") {
    return null;
  }

  const event = chunk as { type?: unknown; name?: unknown; value?: unknown };

  if (event.type !== EventType.CUSTOM) {
    return null;
  }

  if (event.name === TOOL_APPROVAL_REQUESTED_EVENT) {
    const request = toolApprovalRequestedSchema.safeParse(event.value);

    return request.success ? { kind: "requested", request: request.data } : null;
  }

  if (event.name === TOOL_APPROVAL_RESOLVED_EVENT) {
    const resolution = toolApprovalResolvedSchema.safeParse(event.value);

    return resolution.success ? { kind: "resolved", resolution: resolution.data } : null;
  }

  return null;
}

function viewOf(
  request: ToolApprovalRequest,
  resolution: ToolApprovalResolution | undefined,
  lifecycle: "cancelled" | "expired" | undefined,
  now: number,
): ToolApprovalView {
  let state: ApprovalState = "pending";

  if (resolution) {
    state = resolution.state;
  } else if (lifecycle) {
    state = lifecycle;
  } else if (Date.parse(request.expiresAt) <= now) {
    state = "expired";
  }

  return {
    approvalId: request.approvalId,
    threadId: request.threadId,
    toolCallId: request.toolCallId,
    tool: request.tool,
    arguments: request.arguments as ToolApprovalView["arguments"],
    presentation: request.presentation,
    digest: request.digest,
    state,
    expiresAt: request.expiresAt,
    receipt: resolution?.receipt ?? null,
  };
}

export function projectToolApprovals(
  events: readonly unknown[],
  lifecycle: ReadonlyMap<string, "cancelled" | "expired"> = new Map(),
  now = Date.now(),
): ToolApprovalView[] {
  const order: string[] = [];
  const requests = new Map<string, ToolApprovalRequest>();
  const resolutions = new Map<string, ToolApprovalResolution>();

  for (const chunk of events) {
    const parsed = parseToolApprovalEvent(chunk);

    if (!parsed) {
      continue;
    }

    if (parsed.kind === "requested") {
      if (!requests.has(parsed.request.approvalId)) {
        requests.set(parsed.request.approvalId, parsed.request);
        order.push(parsed.request.approvalId);
      }
    } else if (requests.has(parsed.resolution.approvalId)) {
      const prior = resolutions.get(parsed.resolution.approvalId);

      if (!prior || (prior.state === "approved" && parsed.resolution.state !== "approved")) {
        resolutions.set(parsed.resolution.approvalId, parsed.resolution);
      }
    }
  }

  return order.map((id) => viewOf(requests.get(id)!, resolutions.get(id), lifecycle.get(id), now));
}

export function applyToolApprovalEvent(
  views: readonly ToolApprovalView[],
  event: ToolApprovalEvent,
  now = Date.now(),
): ToolApprovalView[] {
  if (event.kind === "requested") {
    if (views.some((view) => view.approvalId === event.request.approvalId)) {
      return [...views];
    }

    return [...views, viewOf(event.request, undefined, undefined, now)];
  }

  const index = views.findIndex((view) => view.approvalId === event.resolution.approvalId);

  if (index < 0) {
    return [...views];
  }

  const current = views[index]!;
  const allowed =
    current.state === "pending" ||
    (current.state === "approved" && event.resolution.state !== "approved");

  if (!allowed) {
    return [...views];
  }

  return views.map((view, position) =>
    position === index
      ? { ...view, state: event.resolution.state, receipt: event.resolution.receipt }
      : view,
  );
}
