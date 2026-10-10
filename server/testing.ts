import { Hono } from "hono";
import { z } from "zod";
import { testingRequestSchema } from "../shared/testing";
import { cancel, problem, read, request } from "./harness/testing-service";

const app = new Hono();

app.onError((error, c) => {
  const failure = problem(error);
  if (failure) {
    if (failure.status === 400 && failure.decisions) {
      return c.json({ error: failure.message, decisions: failure.decisions }, 400);
    }
    return c.json({ error: failure.message }, failure.status);
  }
  console.error("Testing request failed", error);
  return c.json({ error: "測試服務暫時無法使用" }, 503);
});

app.post("/", async (c) => {
  const parsed = testingRequestSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ error: "Invalid testing request" }, 400);
  }
  return c.json(await request(parsed.data));
});

app.post("/:runId/cancel", async (c) => {
  const body = z
    .strictObject({ threadId: z.string() })
    .safeParse(await c.req.json().catch(() => null));
  if (!body.success) {
    return c.json({ error: "Invalid testing cancellation" }, 400);
  }
  return c.json(await cancel(body.data.threadId, c.req.param("runId")));
});

app.get("/:runId", async (c) => {
  const threadId = c.req.query("threadId");
  if (!threadId) {
    return c.json({ error: "Invalid testing read" }, 400);
  }
  return c.json(await read(threadId, c.req.param("runId")));
});

export default app;
