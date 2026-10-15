import { Hono } from "hono";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { testingOperationsTable } from "./db/schema";
import { database } from "./harness/run-store";
import { cancelOperation } from "./harness/testing-store";
import { wakePendingApprovals } from "./harness/tool-approval-store";

const app = new Hono();
app.get("/:runId", async (c) => {
  const threadId = z.uuid().safeParse(c.req.query("threadId"));

  if (!threadId.success) {
    return c.json({ error: "Invalid threadId" }, 400);
  }

  const db = await database();
  const [row] = await db
    .select()
    .from(testingOperationsTable)
    .where(
      and(
        eq(testingOperationsTable.id, c.req.param("runId")),
        eq(testingOperationsTable.thread_id, threadId.data),
      ),
    );

  if (!row) {
    return c.json({ error: "Unknown delegation" }, 404);
  }

  return c.json(
    row.result ?? {
      runId: row.id,
      state: row.cancel_accepted_at ? "cancelling" : "running",
      role: row.input.intent.role,
      deadline: row.deadline.toISOString(),
    },
  );
});
app.post("/:runId/cancel", async (c) => {
  const body = z
    .strictObject({ threadId: z.uuid() })
    .safeParse(await c.req.json().catch(() => null));

  if (!body.success) {
    return c.json({ error: "Invalid cancellation request" }, 400);
  }

  const accepted = await cancelOperation(c.req.param("runId"), body.data.threadId);

  if (accepted) {
    await wakePendingApprovals(c.req.param("runId"));
  }

  return c.json({ accepted });
});
export default app;
