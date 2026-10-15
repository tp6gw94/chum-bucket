import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { createSideChatSchema } from "../shared/side-chat";
import { closeSideChat, createSideChat, listSideChats, RunRequestError } from "./harness/run-store";

const app = new Hono();
app.use(
  "*",
  bodyLimit({ maxSize: 16_000, onError: (c) => c.json({ error: "Request too large" }, 413) }),
);

function threadIdOf(value: string | undefined): string {
  const parsed = z.uuid().safeParse(value);

  if (!parsed.success) {
    throw new RunRequestError(400, "Invalid thread ID");
  }

  return parsed.data;
}

app.onError((error, c) => {
  if (error instanceof RunRequestError) {
    return c.json({ error: error.message }, error.status);
  }

  console.error("Side chat request failed", error);

  return c.json({ error: "Side chat service unavailable" }, 503);
});

app.post("/", async (c) => {
  const body = createSideChatSchema.safeParse(await c.req.json().catch(() => null));

  if (!body.success) {
    throw new RunRequestError(400, "A parent thread ID is required");
  }

  return c.json(await createSideChat(body.data.parentThreadId));
});

app.get("/", async (c) => c.json(await listSideChats(threadIdOf(c.req.query("parentThreadId")))));

app.delete("/:sideChatId", async (c) => {
  await closeSideChat(threadIdOf(c.req.param("sideChatId")));

  return c.body(null, 204);
});

export default app;
