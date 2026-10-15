import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { db } from "./db";
import { chatEventsTable, chatRunsTable, threadsTable } from "./db/schema";
import { desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";

const app = new Hono();
app.use(
  "*",
  bodyLimit({ maxSize: 128_000, onError: (c) => c.json({ error: "Request too large" }, 413) }),
);

const createThreadBody = z.strictObject({});

app.post("/", async (c) => {
  const payload = createThreadBody.safeParse(await c.req.json().catch(() => null));

  if (!payload.success) {
    return c.json({ error: "An empty object is required" }, 400);
  }

  const [thread] = await db
    .insert(threadsTable)
    .values({ title: "新對話", messages: [] })
    .returning();

  return c.json({
    id: thread.id,
    title: thread.title,
    messages: thread.messages,
    updatedAt: thread.updated_at,
    revision: thread.revision,
  });
});

app.get("/", async (c) => {
  const threads = await db
    .select({ id: threadsTable.id, title: threadsTable.title })
    .from(threadsTable)
    .orderBy(desc(threadsTable.updated_at), desc(threadsTable.id))
    .limit(100);

  return c.json(threads);
});

app.get("/:threadId", async (c) => {
  const threadId = c.req.param("threadId");

  if (!z.uuid().safeParse(threadId).success) {
    return c.json({ error: "Invalid thread id" }, 400);
  }

  const [thread] = await db
    .select({
      id: threadsTable.id,
      messages: threadsTable.messages,
      revision: threadsTable.revision,
    })
    .from(threadsTable)
    .where(eq(threadsTable.id, threadId));

  return thread ? c.json(thread) : c.notFound();
});

app.delete("/:threadId", async (c) => {
  const threadId = c.req.param("threadId");

  if (!z.uuid().safeParse(threadId).success) {
    return c.json({ error: "Invalid thread id" }, 400);
  }

  const outcome = await db.transaction(async (tx) => {
    const [thread] = await tx
      .select({ activeRunId: threadsTable.active_run_id })
      .from(threadsTable)
      .where(eq(threadsTable.id, threadId))
      .for("update");

    if (!thread) {
      return "missing";
    }

    if (thread.activeRunId) {
      return "busy";
    }

    const runs = tx
      .select({ id: chatRunsTable.id })
      .from(chatRunsTable)
      .where(eq(chatRunsTable.thread_id, threadId));
    await tx.delete(chatEventsTable).where(inArray(chatEventsTable.run_id, runs));
    await tx.delete(chatRunsTable).where(eq(chatRunsTable.thread_id, threadId));
    await tx
      .update(threadsTable)
      .set({ parent_thread_id: null })
      .where(eq(threadsTable.parent_thread_id, threadId));
    await tx.delete(threadsTable).where(eq(threadsTable.id, threadId));

    return "deleted";
  });

  if (outcome === "missing") {
    return c.notFound();
  }

  if (outcome === "busy") {
    return c.json({ error: "Thread has an active run" }, 409);
  }

  return c.body(null, 204);
});

export default app;
