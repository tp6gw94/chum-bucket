import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { db } from "./db";
import { threadsTable } from "./db/schema";
import { desc, eq } from "drizzle-orm";
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

export default app;
