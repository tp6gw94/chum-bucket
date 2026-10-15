import { DBOS } from "@dbos-inc/dbos-sdk";
import { EventType, type StreamChunk } from "@tanstack/ai";
import { and, asc, eq, inArray, isNotNull, sql, type SQL } from "drizzle-orm";
import {
  TOOL_APPROVAL_REQUESTED,
  TOOL_APPROVAL_RESOLVED,
  applyToolApprovalEvent,
  approvalCancelKey,
  effectiveApprovalState,
  parseToolApprovalEvent,
  type ResolvedApprovalState,
  type ToolApproval,
  type ToolApprovalEvent,
} from "../../shared/tool-approval";
import { chatEventsTable, chatRunsTable, testingOperationsTable } from "../db/schema";
import { database } from "./run-store";

export type CommentOutcome = {
  status: ResolvedApprovalState;
  externalId: string | null;
  message: string;
};

const finalDenials: ReadonlySet<string> = new Set(["rejected", "expired", "cancelled"]);

export function approvalEvent(name: string, value: Record<string, unknown>): StreamChunk {
  return { type: EventType.CUSTOM, name, value, timestamp: Date.now() };
}

async function approvalEvents(condition: SQL | undefined): Promise<ToolApprovalEvent[]> {
  const db = await database();
  const rows = await db
    .select({ payload: chatEventsTable.payload })
    .from(chatEventsTable)
    .innerJoin(chatRunsTable, eq(chatEventsTable.run_id, chatRunsTable.id))
    .where(
      and(
        condition,
        sql`${chatEventsTable.payload}->>'type' = ${EventType.CUSTOM}`,
        sql`${chatEventsTable.payload}->>'name' in (${TOOL_APPROVAL_REQUESTED}, ${TOOL_APPROVAL_RESOLVED})`,
      ),
    )
    .orderBy(asc(chatRunsTable.created_at), asc(chatEventsTable.sequence));

  return rows.flatMap(({ payload }) => {
    const event =
      payload.type === EventType.CUSTOM
        ? parseToolApprovalEvent(payload.name, payload.value)
        : null;

    return event ? [event] : [];
  });
}

async function cancelledOperations(operationIds: readonly string[]): Promise<ReadonlySet<string>> {
  if (operationIds.length === 0) {
    return new Set();
  }

  const db = await database();
  const rows = await db
    .select({ id: testingOperationsTable.id })
    .from(testingOperationsTable)
    .where(
      and(
        inArray(testingOperationsTable.id, [...new Set(operationIds)]),
        isNotNull(testingOperationsTable.cancel_accepted_at),
      ),
    );

  return new Set(rows.map((row) => row.id));
}

async function project(events: readonly ToolApprovalEvent[]): Promise<ToolApproval[]> {
  const now = Date.now();
  const approvals = events
    .reduce<ToolApproval[]>(applyToolApprovalEvent, [])
    .map((approval) => ({ ...approval, state: effectiveApprovalState(approval, now) }));
  const cancelled = await cancelledOperations(
    approvals.filter((item) => item.state === "pending").map((item) => item.operationId),
  );

  return approvals.map((item) =>
    item.state === "pending" && cancelled.has(item.operationId)
      ? { ...item, state: "cancelled" }
      : item,
  );
}

export async function readToolApprovals(threadId: string): Promise<ToolApproval[]> {
  return project(await approvalEvents(eq(chatRunsTable.thread_id, threadId)));
}

export async function readToolApprovalRequest(approvalId: string): Promise<ToolApproval | null> {
  const events = await approvalEvents(
    sql`${chatEventsTable.payload}->'value'->>'approvalId' = ${approvalId}`,
  );
  const [approval] = await project(events);

  return approval ?? null;
}

async function runApprovals(runId: string): Promise<ToolApproval[]> {
  return project(await approvalEvents(eq(chatEventsTable.run_id, runId)));
}

export async function hasFinalApprovalDenial(runId: string, taskId: string): Promise<boolean> {
  return (await runApprovals(runId)).some(
    (item) => item.taskId === taskId && finalDenials.has(item.state),
  );
}

export async function wakePendingApprovals(operationId: string) {
  const db = await database();
  const [operation] = await db
    .select({ runId: testingOperationsTable.parent_run_id })
    .from(testingOperationsTable)
    .where(eq(testingOperationsTable.id, operationId));

  if (!operation) {
    return;
  }

  const events = await approvalEvents(eq(chatEventsTable.run_id, operation.runId));
  const pending = events
    .reduce<ToolApproval[]>(applyToolApprovalEvent, [])
    .filter((item) => item.operationId === operationId && item.state === "pending");

  for (const item of pending) {
    await DBOS.send(
      item.childWorkflowId,
      { cancel: true, approvalId: item.approvalId },
      item.topic,
      approvalCancelKey(item.approvalId),
    );
  }
}

const outcomeMessages: Record<ResolvedApprovalState, (externalId: string | null) => string> = {
  succeeded: (externalId) =>
    `The Jira comment was posted. Report the comment ID ${externalId} to the user.`,
  approved: () =>
    "The user approved the comment, but delivery was not confirmed. Do not say it was posted and do not delegate it again.",
  rejected: () =>
    "The user rejected the comment and it was not posted. Do not delegate this comment again unless the user asks again in a new message.",
  expired: () => "The approval expired and the comment was not posted.",
  cancelled: () => "The task was cancelled and the comment was not posted.",
};

export function commentOutcomeOf(
  status: ResolvedApprovalState,
  externalId: string | null,
): CommentOutcome {
  return { status, externalId, message: outcomeMessages[status](externalId) };
}

export async function readCommentOutcome(
  runId: string,
  operationId: string,
): Promise<CommentOutcome | null> {
  const approval = (await runApprovals(runId))
    .filter((item) => item.operationId === operationId)
    .at(-1);

  if (!approval) {
    return null;
  }

  const status = approval.state === "pending" ? "cancelled" : approval.state;

  return commentOutcomeOf(status, approval.receipt?.externalId ?? null);
}
