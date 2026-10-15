import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { projectToolApprovals, type ToolApproval } from "../../shared/tool-approval";
import { chatEventsTable, chatRunsTable } from "../db/schema";
import { database } from "./run-store";

const approvalEventNames = ["tool.approval.requested", "tool.approval.resolved"];
const finalDenials = new Set(["rejected", "expired", "cancelled"]);

async function approvalEvents(runId: string): Promise<unknown[]> {
  const db = await database();
  const rows = await db
    .select({ payload: chatEventsTable.payload })
    .from(chatEventsTable)
    .where(
      and(
        eq(chatEventsTable.run_id, runId),
        inArray(sql<string>`${chatEventsTable.payload} ->> 'name'`, approvalEventNames),
      ),
    )
    .orderBy(asc(chatEventsTable.sequence));

  return rows.map((row) => row.payload);
}

export async function isRunPending(runId: string): Promise<boolean> {
  const db = await database();
  const [run] = await db
    .select({ state: chatRunsTable.state })
    .from(chatRunsTable)
    .where(eq(chatRunsTable.id, runId));

  return run?.state === "pending";
}

export async function readRunApprovals(runId: string): Promise<readonly ToolApproval[]> {
  const [events, pending] = await Promise.all([approvalEvents(runId), isRunPending(runId)]);

  return projectToolApprovals(events, Date.now()).map((approval) =>
    approval.state === "pending" && !pending ? { ...approval, state: "cancelled" } : approval,
  );
}

export async function hasFinalApprovalDenial(runId: string): Promise<boolean> {
  const approvals = await readRunApprovals(runId);

  return approvals.some((approval) => finalDenials.has(approval.state));
}

export async function findToolApproval(approvalId: string): Promise<ToolApproval | undefined> {
  const db = await database();
  const [row] = await db
    .select({ runId: chatEventsTable.run_id })
    .from(chatEventsTable)
    .where(
      and(
        sql`${chatEventsTable.payload} ->> 'name' = 'tool.approval.requested'`,
        sql`${chatEventsTable.payload} -> 'value' ->> 'approvalId' = ${approvalId}`,
      ),
    );

  if (!row) {
    return undefined;
  }

  return (await readRunApprovals(row.runId)).find(
    (candidate) => candidate.request.approvalId === approvalId,
  );
}
